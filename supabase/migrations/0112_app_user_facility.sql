-- 0112 — claims.app_user_facility: per-user FACILITY entitlement for the `user` seat.
--
-- WHY: `claims.app_user` has carried a `user` role since 0025, but as of 2026-09-10 NO user row has
--   ever existed (measured live: 16 super_admin, 2 admin, 0 user, 0 admissions_seat). The seat was
--   undefined in practice. Alec ruled it into shape on 2026-09-10:
--     R1 — facility scope bites on the Overview aggregates + the Collections grid. NOT Claims Desk.
--     R2 — the BXR 'No Facility' bucket ($29,081,575.38 / 11,451 charges, 15.67% of BXR rollup rows;
--          Indigo has ZERO) is HIDDEN from a scoped user, but charges the 0086 resolution engine
--          attributes to a granted facility DO count.
--     R3 — tenant FIRST, then that tenant's facilities. No cross-tenant user; the one-entity
--          app_user_role_entity_ck stands and is NOT touched here.
--     R4 — a grant is an explicit SNAPSHOT. A newly onboarded facility is NOT auto-granted.
--     R5 — a `user` CAN reveal PHI. The facility grant is the whole restriction.
--
--   Because zero `user` rows exist, the read path can fail closed from day one without breaking
--   anyone: no grants ⟺ no data. That is a freedom this table will never have again.
--
-- GRAIN: one row per (user, facility_code) that the user MAY see. Absence is denial. There is no
--   "all facilities" row and deliberately no such flag — R4 makes the grant a snapshot, so "all"
--   is spelled as N explicit rows and a facility added later is simply not among them.
--
-- ⚠ NO FOREIGN KEY TO collections.facilities, AND THAT IS NOT LAZINESS. It is a cross-SCHEMA,
--   cross-OWNER reference: this table is claims_admin-owned, collections.facilities is
--   postgres-owned (measured 2026-08-05; see 0083/0085 headers). 0085 set the precedent for exactly
--   this shape — validate the code inside the write function against the roster, rather than take a
--   REFERENCES privilege across an ownership boundary. The app_user FK IS real: it is same-schema,
--   same-owner, and ON DELETE CASCADE is what stops a deleted user's grants outliving them.
--
-- TENANT COHERENCE IS ENFORCED HERE, IN THE DATABASE — not only app-side (Alec, 2026-09-10).
--   The first cut left it to facilityBelongsToEntity in the Server Action, on the grounds that
--   collections.facilities carries no business_entity_id. That reasoning was right about the ROSTER
--   and wrong about the DATABASE: the mapping is derivable from the fact tables, and a PHI boundary
--   whose sole enforcement is one app-side helper is not a boundary.
--
--   MEASURED 2026-09-10, live:
--     · facility_code -> business_entity_id is a FUNCTION. Across all six tables carrying both
--       columns (claims.audit_row, claims.ar_claim, claims.billing_code_decision,
--       collections.daily_collections{,_resolved}, collections.facility_assignments) there are
--       ZERO codes mapping to more than one tenant.
--     · 46 of the 48 roster codes are derivable, 0 ambiguous.
--     · The 2 that are NOT derivable are 10036020 MADISON RECOVERY CENTER and 10036030 MISSOURI
--       BEHAVIORAL HEALTH — Indigo, retired 2026-08-02, dimension row and ZERO data rows.
--
--   WHY THAT GAP IS CLOSED RATHER THAN MERELY SMALL: a grant can only leak data if the granted code
--   HAS data in another tenant. If it has data, it appears in a fact table. If it appears in a fact
--   table, the check below rejects the mismatch. The two unresolvable codes are unresolvable
--   PRECISELY BECAUSE they have nothing to leak, and the gap self-closes the moment either gains a
--   row. The check is therefore complete with respect to the risk, not merely to today's data.
--
--   The app-side facilityBelongsToEntity check REMAINS, and is now the fast path with a better
--   error message rather than the only path. Defence in depth, in that order.
--
-- ⚠ RESIDUAL, AND A DETECTION QUERY FOR IT. A code with no data anywhere can still be granted to
--   the wrong tenant (it leaks nothing today, but it would the day it gains rows in the OTHER
--   tenant). Run this on a schedule; it returns one row per incoherent grant and should be empty:
--
--     select f.app_user_id, u.email, u.entity as grantee_tenant, f.facility_code,
--            d.business_entity_id as facility_actually_in
--     from claims.app_user_facility f
--     join claims.app_user u on u.user_id = f.app_user_id
--     join lateral (
--       select business_entity_id from collections.daily_collections_resolved where facility_code = f.facility_code
--       union select business_entity_id from claims.audit_row  where facility_code = f.facility_code
--       union select business_entity_id from claims.ar_claim   where facility_code = f.facility_code
--     ) d on true
--     where d.business_entity_id <> case u.entity
--             when 'bxr'    then 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'::uuid
--             when 'indigo' then '141d459c-f371-4229-9a92-ace198e940bb'::uuid end;
--
-- ⚠ AND A SECOND SCHEDULED ASSERTION, FOR DRIFT RATHER THAN DATA (Alec, 2026-09-11). The
--   pre-flight below closes APPLY time; it does nothing about someone revoking one of these grants
--   six months from now, at which point the tenant check starts raising
--   `42501: permission denied` and provisioning breaks in production. Same defect, drift-time.
--   This returns one row per MISSING grant and should be empty:
--
--     select obj from (values
--       ('collections.daily_collections_resolved'), ('claims.audit_row'), ('claims.ar_claim')
--     ) as t(obj)
--     where not has_table_privilege('claims_admin', obj, 'SELECT');
--
--   The failure direction is safe (the definer REFUSES the grant rather than skipping the tenant
--   check), so this is a availability alarm, not a breach alarm — but the one code path that
--   provisions PHI access should not be allowed to rot silently.
--
-- PHI: none. A staff uuid and a facility code — the same non-PHI reference vocabulary the facility
--   dropdown already renders. Nothing here is patient data.
--
-- OWNERSHIP: claims_admin, via `set role claims_admin` / `reset role` — the CURRENT convention
--   (0049/0052/0053/0055/0097), NOT the older `grant/revoke claims_admin to postgres` dance, whose
--   trailing revoke strips the cluster-level standing grant and 42501s every later claims migration.
--   0097's header records that trap after nearly shipping it; this file does not repeat it.
--
-- ACCESS MODEL (0046/0097 verbatim):
--   · Reads  — claims_reader SELECTs directly, app-layer scoped `where app_user_id = <uid>`.
--   · Writes — NO direct DML for any app role; claims_reader EXECUTEs the definer below.
--
-- IDEMPOTENT: create table/index IF NOT EXISTS; CREATE OR REPLACE function; policies dropped and
--   recreated; grants re-applied unconditionally. Re-running converges.
-- DEPENDENCY: 0025 (claims.app_user). collections.facilities must exist (0006) for the definer's
--   validation to resolve — it is read at CALL time, not at create time.
-- Rollback: 0112_app_user_facility_rollback.sql

set role claims_admin;

-- 0. PRE-FLIGHT: the definer's cross-owner read privileges ------------------------------------
-- ⚠ FOUND BY THE BRANCH RUN, 2026-09-10 — this migration has an UNDECLARED DEPENDENCY and it used
-- to fail at CALL time instead of APPLY time. The definer is claims_admin-owned and a SECURITY
-- DEFINER runs as its owner, so it needs SELECT on three objects claims_admin does NOT own:
-- collections.daily_collections_resolved, claims.audit_row, claims.ar_claim. On production all
-- three are already granted (verified live 2026-09-10). On a database where any is missing, the
-- migration applied "successfully" and then every provisioning call raised
-- `42501: permission denied for view daily_collections_resolved` — observed exactly that way on the
-- branch, on 8 of 11 matrix cases, before this block existed.
--
-- Failing at apply time turns a confusing runtime 42501 into a legible refusal naming the missing
-- grant. It is an ASSERTION, not a grant: claims_admin cannot grant itself privileges on
-- postgres-owned objects, and a migration that quietly widened privileges to make itself work would
-- be the wrong fix.
--
-- The direction of failure is safe either way — a definer that cannot read the fact tables REFUSES
-- the grant rather than skipping the tenant check — but "safe and baffling" is not good enough for
-- the one code path that provisions PHI access.
do $$
declare missing text;
begin
  select string_agg(t, ', ') into missing from (
    select 'collections.daily_collections_resolved' as t
     where not has_table_privilege('claims_admin','collections.daily_collections_resolved','SELECT')
    union all
    select 'claims.audit_row' where not has_table_privilege('claims_admin','claims.audit_row','SELECT')
    union all
    select 'claims.ar_claim'  where not has_table_privilege('claims_admin','claims.ar_claim','SELECT')
  ) m;
  if missing is not null then
    raise exception
      '0112 pre-flight: claims_admin lacks SELECT on % — the tenant-coherence check in set_app_user_facilities would 42501 at call time. Grant it as an OPERATOR step (the objects are postgres-owned), then re-apply.', missing;
  end if;
end $$;

-- 1. The entitlement table ----------------------------------------------------
create table if not exists claims.app_user_facility (
  app_user_id   uuid not null references claims.app_user (user_id) on delete cascade,
  facility_code text not null,
  created_at    timestamptz not null default now(),
  -- The super_admin who granted it. Non-PHI provenance; nullable so a future system-initiated
  -- grant is expressible without inventing a fake actor.
  created_by    uuid,
  constraint app_user_facility_code_len_ck check (char_length(facility_code) between 1 and 64),
  primary key (app_user_id, facility_code)
);
alter table claims.app_user_facility owner to claims_admin;

-- The PK already covers (app_user_id, …) for the per-user read. This index serves the OTHER
-- direction — "who can see facility X" — which is the question an access review asks.
create index if not exists app_user_facility_code_idx
  on claims.app_user_facility (facility_code);

-- 2. Grants + RLS -------------------------------------------------------------
revoke all on claims.app_user_facility from public, anon, authenticated, service_role;
grant select on claims.app_user_facility to claims_reader;

alter table claims.app_user_facility enable row level security;

drop policy if exists app_user_facility_admin_rw on claims.app_user_facility;
create policy app_user_facility_admin_rw on claims.app_user_facility
  for all to claims_admin using (true) with check (true);

-- The reader must look up ANY signed-in user's own row set, so the policy is permissive and the
-- SCOPE is the app-layer WHERE (the 0025 app_user_reader_select precedent). Without a reader policy
-- the SELECT grant above returns zero rows — a GRANT is half the gate (0089/0090).
drop policy if exists app_user_facility_reader_select on claims.app_user_facility;
create policy app_user_facility_reader_select on claims.app_user_facility
  for select to claims_reader using (true);

-- 3. The write path -----------------------------------------------------------
-- Replaces a user's ENTIRE grant set in one call, which is the shape the checkbox UI submits:
-- the client sends what should be true, not a diff. Delete-then-insert inside one function body is
-- atomic (a function runs in the caller's transaction), so a reader can never observe a user
-- mid-rewrite with a partial set.
--
-- Returns the number of rows granted, so the caller can audit what actually landed rather than
-- what it believed it sent.
create or replace function claims.set_app_user_facilities(
  p_user  uuid,
  p_codes text[],
  p_actor uuid default null
) returns integer
language plpgsql
security definer
set search_path = claims, collections, pg_temp
as $$
declare
  v_role      text;
  v_entity    text;
  v_entity_id uuid;
  v_foreign   text;
  v_clean   text[];
  v_unknown text;
  v_count   integer;
begin
  if p_user is null then
    raise exception 'set_app_user_facilities: p_user is required';
  end if;

  -- Normalize FIRST: strip nulls/blanks and de-duplicate, so an array of [null,'','NASH','NASH']
  -- is exactly ['NASH'] and the cap below counts real grants rather than junk.
  v_clean := (
    select coalesce(array_agg(distinct c), '{}'::text[])
    from unnest(coalesce(p_codes, '{}'::text[])) as t(c)
    where c is not null and btrim(c) <> ''
  );

  -- Bound the surface. 48 facilities exist today (measured 2026-09-10); 500 is headroom, not a
  -- target, and exists so a malformed caller cannot write an unbounded set.
  if array_length(v_clean, 1) > 500 then
    raise exception 'set_app_user_facilities: too many facilities (max 500)';
  end if;

  select role, entity into v_role, v_entity from claims.app_user where user_id = p_user;
  if v_role is null then
    raise exception 'set_app_user_facilities: no such provisioned user';
  end if;

  -- Facility grants are meaningful ONLY for the `user` seat: every other role is either
  -- whole-tenant (admin) or cross-tenant (super_admin), and the read path never consults this
  -- table for them. Refusing a non-empty grant on another role stops a silently-inert row set.
  --
  -- An EMPTY set is allowed for ANY role on purpose: it is the CLEAR path, and it must keep
  -- working when a super_admin demotes... or rather PROMOTES a user to admin, at which point their
  -- now-meaningless grants should be removable without first putting the role back.
  if array_length(v_clean, 1) > 0 and v_role <> 'user' then
    raise exception 'set_app_user_facilities: facility grants apply only to the user role (got %)', v_role;
  end if;

  -- (a) EXISTENCE — every code must be a real facility. Validated against the roster rather than an
  -- FK, for the ownership reason in the header. Names the first offender so a typo is diagnosable.
  select c into v_unknown
  from unnest(v_clean) as t(c)
  where not exists (select 1 from collections.facilities f where f.facility_code = c)
  limit 1;
  if v_unknown is not null then
    raise exception 'set_app_user_facilities: unknown facility_code %', v_unknown;
  end if;

  -- (b) TENANT COHERENCE — no granted code may hold data in a tenant OTHER than the grantee's.
  --
  -- The two entity uuids are FIXED, business-owner-confirmed constants, duplicated from
  -- src/tenants.ts / app/lib/views.ts. They are NEVER regenerated; a parity test asserts this file
  -- agrees with those two copies, so the duplication cannot drift silently.
  --
  -- `<> v_entity_id` rather than "= the other tenant" on purpose: it stays correct if a THIRD
  -- tenant is ever onboarded, whereas an explicit other-id would silently stop checking. The cost
  -- is that the (business_entity_id, facility_code) indexes cannot serve it, so this seq-scans
  -- ~115k rows across the three tables. That is knowingly accepted: provisioning is a human
  -- clicking Save a handful of times a year, not a hot path.
  v_entity_id := case v_entity
    when 'bxr'    then 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'::uuid
    when 'indigo' then '141d459c-f371-4229-9a92-ace198e940bb'::uuid
  end;
  if v_entity_id is null then
    -- A `user` always has an entity (app_user_role_entity_ck), so this is unreachable — but an
    -- unknown entity must DENY rather than skip the check.
    raise exception 'set_app_user_facilities: cannot resolve tenant for entity %', v_entity;
  end if;

  select c into v_foreign
  from unnest(v_clean) as t(c)
  where exists (
    select 1 from collections.daily_collections_resolved d
     where d.facility_code = c and d.business_entity_id <> v_entity_id
    union all
    select 1 from claims.audit_row a
     where a.facility_code = c and a.business_entity_id <> v_entity_id
    union all
    select 1 from claims.ar_claim r
     where r.facility_code = c and r.business_entity_id <> v_entity_id
  )
  limit 1;
  if v_foreign is not null then
    raise exception 'set_app_user_facilities: facility % holds data in another tenant', v_foreign;
  end if;

  delete from claims.app_user_facility where app_user_id = p_user;

  insert into claims.app_user_facility (app_user_id, facility_code, created_by)
  select p_user, c, p_actor from unnest(v_clean) as t(c);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function claims.set_app_user_facilities(uuid, text[], uuid) owner to claims_admin;
revoke all on function claims.set_app_user_facilities(uuid, text[], uuid) from public, anon, authenticated, service_role;
grant execute on function claims.set_app_user_facilities(uuid, text[], uuid) to claims_reader;

-- Role/entity changes and facility grants must be one transaction. This also preserves the
-- previous state when grant validation fails for an existing account.
create or replace function claims.provision_app_user(
  p_user uuid, p_email text, p_role text, p_entity text, p_codes text[], p_actor uuid
) returns void
language plpgsql security definer
set search_path = claims, collections, pg_temp
as $$
begin
  perform claims.upsert_app_user(p_user, p_email, p_role, p_entity);
  perform claims.set_app_user_facilities(p_user, p_codes, p_actor);
end;
$$;

alter function claims.provision_app_user(uuid, text, text, text, text[], uuid) owner to claims_admin;
revoke all on function claims.provision_app_user(uuid, text, text, text, text[], uuid) from public, anon, authenticated, service_role;
grant execute on function claims.provision_app_user(uuid, text, text, text, text[], uuid) to claims_reader;

comment on table claims.app_user_facility is
  'Per-user facility entitlement for the `user` seat (0112). Absence = denial. Tenant coherence is '
  'enforced APP-SIDE (facilityBelongsToEntity); this table validates facility existence only.';

reset role;
