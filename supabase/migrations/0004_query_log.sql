-- 0004: claims.query_log — non-PHI audit/handle table for the Phase 2 query lib.
--
-- Each vetted query function records ONE row here: the function name, the
-- sanitized arguments (non-PHI values + presence flags for identity fields), and
-- the already-computed non-PHI summary_stats. The opaque `id` (uuid) is the
-- query_id handed back to the caller; the Phase 3 results route looks the row up
-- and RE-EXECUTES the original parameterized query to produce the PHI result set
-- (PHI is never cached here).
--
-- Decision 2: client_history is filtered on patient identity, which is PHI and
-- must NOT sit at rest. So query_log stores only non-PHI args + presence flags,
-- plus `identity_hash` = SHA-256(lower(patient_last) || '|' || coalesce(member_id_norm,'')
-- || '|' || query_id). The results route recomputes this from the re-supplied
-- identity terms and verifies it matches before executing — binding a query_id to
-- one identity so a caller cannot swap in different patient terms. The hash is
-- irreversible (non-PHI); a CHECK enforces it is exactly 64 hex chars so nothing
-- else can ever be written there.
--
-- Access: claims_admin reads + writes query_log; claims_reader gets NO access to
-- it (the reader role is for claims.claims data only). RLS on, admin-only policy,
-- mirroring the claims tables. gen_random_uuid() is core in PG13+ (no extension).

create table if not exists claims.query_log (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '1 hour',
  created_by    text  not null,           -- user/session identifier, never PHI
  function_name text  not null,           -- which vetted function produced this row
  arguments     jsonb not null,           -- typed args, sanitized (no PHI values)
  summary_stats jsonb not null,           -- the non-PHI summary already computed
  identity_hash text,                     -- client_history only; null otherwise

  constraint query_log_function_name_ck check (
    function_name in (
      'distribution', 'payer_gap_analysis', 'search_claims',
      'client_history', 'readmission_candidates'
    )
  ),
  constraint query_log_created_by_ck check (length(created_by) between 1 and 200),
  -- identity_hash, when present, is EXACTLY a SHA-256 hex digest — never PHI.
  constraint query_log_identity_hash_ck check (
    identity_hash is null or identity_hash ~ '^[0-9a-f]{64}$'
  )
);

-- Cleanup/expiry lookups.
create index if not exists query_log_expires_at on claims.query_log (expires_at);

-- Access control: strip any default/public grants, then grant ONLY claims_admin.
revoke all on claims.query_log from public, anon, authenticated, service_role, claims_reader;
grant select, insert, delete on claims.query_log to claims_admin;  -- read, write, expire

-- RLS (consistent with claims.claims / claims.claims_raw).
alter table claims.query_log enable row level security;

drop policy if exists query_log_admin_all on claims.query_log;
create policy query_log_admin_all on claims.query_log
  for all to claims_admin using (true) with check (true);

-- Supabase's `postgres` role is NOT a superuser; to set a function's OWNER to
-- claims_admin (below) it must be a member of claims_admin. Grant that membership
-- transiently and revoke it at the end of this migration, so the role graph is
-- unchanged afterward. apply_migration runs in one transaction, so this is atomic.
grant claims_admin to postgres;

-- ---------------------------------------------------------------------------
-- Write/read path under least privilege (Decision: Option B).
--
-- The query library runs as claims_reader, which has NO table rights on
-- query_log. It records and re-reads rows ONLY through these two SECURITY
-- DEFINER functions, which execute as their OWNER (claims_admin). search_path is
-- pinned to `claims, pg_catalog` so a caller-controlled path cannot hijack the
-- definer body, and every object reference inside is schema-qualified anyway.
-- Each function is a single fixed operation — no dynamic SQL, no escalation
-- surface.
--
-- The CALLER supplies the row id (a client-generated uuid) = query_id, so that
-- client_history can bind identity_hash to the query_id BEFORE the insert
-- (identity_hash INCLUDES query_id per Decision 2 — see the header; the raw
-- identity terms are hashed in-process and never passed here). A PK collision
-- raises unique_violation, so a caller cannot overwrite an existing row.
-- log_query re-validates the table's constraints explicitly and RAISEs
-- check_violation on any breach, so the caller gets a clean error rather than a
-- silent bad write (the table CHECKs remain as defense in depth). p_identity_hash
-- is OPTIONAL; when present it must be a 64-char lowercase hex SHA-256 digest.
-- ---------------------------------------------------------------------------

create or replace function claims.log_query(
  p_id            uuid,
  p_created_by    text,
  p_function_name text,
  p_arguments     jsonb,
  p_summary_stats jsonb,
  p_identity_hash text default null
) returns uuid
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  -- Same constraints as the table, enforced up front for clean caller errors.
  if p_function_name not in (
       'distribution', 'payer_gap_analysis', 'search_claims',
       'client_history', 'readmission_candidates') then
    raise exception 'log_query: invalid function_name %', p_function_name
      using errcode = 'check_violation';
  end if;
  if p_created_by is null or length(p_created_by) not between 1 and 200 then
    raise exception 'log_query: created_by must be 1..200 chars'
      using errcode = 'check_violation';
  end if;
  if p_identity_hash is not null and p_identity_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'log_query: identity_hash must be a 64-char lowercase hex SHA-256 digest'
      using errcode = 'check_violation';
  end if;

  insert into claims.query_log
    (id, created_by, function_name, arguments, summary_stats, identity_hash)
  values
    (p_id, p_created_by, p_function_name, p_arguments, p_summary_stats, p_identity_hash);

  return p_id;
end;
$$;

alter function claims.log_query(uuid, text, text, jsonb, jsonb, text) owner to claims_admin;
revoke execute on function claims.log_query(uuid, text, text, jsonb, jsonb, text) from public;
grant  execute on function claims.log_query(uuid, text, text, jsonb, jsonb, text) to claims_reader;

-- Point lookup for the Phase 3 results route. Returns the stored row so the route
-- can re-execute the original parameterized query — but ONLY if not expired (no
-- rows when expires_at < now()), and WITHOUT identity_hash: the route verifies
-- identity from terms the caller re-supplies, so the stored hash never leaves the
-- database. The table holds no PHI; these columns are all non-PHI.
--
-- Fail-closed guard (defense in depth): a client_history row with a NULL
-- identity_hash returns no rows (same as expired), so the route can never serve
-- PHI it has nothing to verify against. The table CHECK + log_query make a null
-- hash on a client_history row impossible in practice; this is the belt to that
-- suspenders.
create or replace function claims.get_query_log(p_id uuid)
returns table(
  id            uuid,
  created_at    timestamptz,
  expires_at    timestamptz,
  created_by    text,
  function_name text,
  arguments     jsonb,
  summary_stats jsonb
)
language sql
security definer
set search_path = claims, pg_catalog
as $$
  select id, created_at, expires_at, created_by, function_name, arguments, summary_stats
  from claims.query_log
  where id = p_id
    and expires_at >= now()
    and (function_name <> 'client_history' or identity_hash is not null);
$$;

alter function claims.get_query_log(uuid) owner to claims_admin;
revoke execute on function claims.get_query_log(uuid) from public;
grant  execute on function claims.get_query_log(uuid) to claims_reader;

-- Drop the transient membership granted above; the functions are now owned by
-- claims_admin and postgres no longer needs it.
revoke claims_admin from postgres;
