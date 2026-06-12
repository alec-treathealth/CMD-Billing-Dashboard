-- 0005: claims.verify_identity — the identity-hash gate for the Phase 3 results
-- route (client_history only).
--
-- client_history binds a query_id to ONE patient identity via
--   identity_hash = SHA-256( lower(patient_last) | normalizeMemberId(member) | query_id )
-- stored in claims.query_log (see 0004 + src/queries/identity.ts). The patient
-- search terms themselves are PHI and are never stored, so the results route
-- cannot reconstruct a client_history query from query_log.arguments alone — the
-- caller must RE-SUPPLY the identity terms, and the route must verify they hash to
-- the stored value before serving any PHI.
--
-- get_query_log (0004) INTENTIONALLY withholds identity_hash, so the route has no
-- way to read it. This SECURITY DEFINER function closes that gap WITHOUT widening
-- get_query_log: the route hashes the re-supplied terms in-process and passes only
-- the resulting digest; this function compares it server-side and returns just a
-- boolean. The stored hash never leaves the database.
--
-- Fail-closed by construction: returns false (never raises) when the row is
-- missing, expired, not a client_history row, or has a NULL stored hash, or when
-- the digest does not match — so the route treats false uniformly as "do not
-- serve". `exists` yields a non-null boolean in every case.
--
-- Access mirrors 0004: owner claims_admin; EXECUTE granted to claims_reader (which
-- has no table rights on query_log); search_path pinned; no dynamic SQL. The
-- transient `grant claims_admin to postgres` lets the migration set the owner, and
-- is revoked at the end (apply_migration runs in one transaction, so this is atomic).

grant claims_admin to postgres;

create or replace function claims.verify_identity(p_id uuid, p_hash text)
returns boolean
language sql
security definer
set search_path = claims, pg_catalog
as $$
  select exists (
    select 1
    from claims.query_log
    where id = p_id
      and expires_at >= now()
      and function_name = 'client_history'
      and identity_hash is not null
      and identity_hash = p_hash
  );
$$;

alter function claims.verify_identity(uuid, text) owner to claims_admin;
revoke execute on function claims.verify_identity(uuid, text) from public;
grant  execute on function claims.verify_identity(uuid, text) to claims_reader;

revoke claims_admin from postgres;
