-- 0033: collections WRITER RLS enforcement flip (migration C of A→B→C).
--
-- ══════════════════════════════════════════════════════════════════════════════════════
-- MIGRATION C — the enforcement flip. A (0030) added columns + tenant-leading indexes;
-- B (0031 + writer code, commit 0f688d2) made every writer run inside withTenant
-- (transaction-local set_config('app.business_entity_id', <tenant>, true)) with explicit
-- per-tenant stamping and tenant-scoped DELETEs, and was verified with a REAL green BXR cron.
-- C (this file) makes the writer RLS policies ENFORCE that GUC: a writer can only INSERT/see/
-- DELETE rows whose business_entity_id equals the tenant it declared. Defense-in-depth beneath
-- the app-layer stamping — a mis-stamp or a forgotten scope can no longer cross tenants.
--
-- SCOPE — WRITER POLICIES ONLY (the least-privilege cron role cmd_rollup_writer). This migration
-- does NOT touch:
--   • claims_reader SELECT policies — they STAY permissive (USING true). The dashboard readers do
--     app-layer WHERE scoping (0032 + reader entityIds, commit 6f8a4e5) and run as claims_reader
--     WITHOUT setting the GUC; a GUC-scoped reader policy would make every dashboard read return
--     zero rows. Reads are isolated in the app; writes are isolated here.
--   • claims_admin ALL policies — the privileged admin/owner + frozen workbook CLI path stays
--     permissive by design (break-glass; BXR-only in practice).
-- The post-flip DO block asserts the reader policies are still permissive, so C can never silently
-- break reads.
--
-- WHY THIS BITES (verified 2026-07-07): the cron writes via CMD_ROLLUP_WRITER_DATABASE_URL as
-- cmd_rollup_writer_login (canlogin, bypassrls=FALSE, owns none of the 3 tables), a MEMBER of
-- cmd_rollup_writer — so the TO cmd_rollup_writer policies apply to it and RLS is enforced (no
-- owner-bypass, no BYPASSRLS). RLS is enabled (not forced) on all 3 tables; forcing is unnecessary
-- because the enforced role is never the owner. postgres/claims_admin (owners/BYPASSRLS) remain
-- unscoped intentionally (see SCOPE).
--
-- GUC EXPRESSION: the canonical form already proven across ~12 staging.*/core.* isolation policies:
--   business_entity_id = current_setting('app.business_entity_id')::uuid
-- 1-arg current_setting → if the GUC is unset the policy RAISES (fail-closed and loud): a write
-- outside withTenant cannot slip through unscoped. Every writer path sets it (withTenant), so BXR
-- writes (GUC=BXR, row stamped BXR) pass; a future Indigo write that forgot to stamp (row defaults
-- BXR while GUC=Indigo) is REJECTED — exactly the guard we want before Indigo load.
--
-- OWNERSHIP: cmd_explorer_rows + daily_collections are postgres-owned (policy DDL runs as the apply
-- role directly). cmd_payer_facility_monthly is claims_admin-owned, so its policy DDL runs under
-- SET ROLE claims_admin (the proven 0030 pattern) with RESET ROLE after.
--
-- IDEMPOTENT: each policy is DROP ... IF EXISTS then CREATE (re-runnable; the whole migration is one
-- transaction, so there is no window where a policy is missing). Comments/asserts re-run cleanly.
--
-- ROLLBACK: supabase/rollbacks/0033_collections_writer_rls_enforcement_rollback.sql (guarded —
-- refuses to loosen the writer back to permissive once any non-BXR row exists, which would remove
-- multi-tenant write protection on live multi-tenant data).
--
-- POST-APPLY (operational, required before "done" — NOT in this file): run a REAL BXR cron and
-- confirm green (0 non-BXR, no 42501/RLS error); then a negative probe (INSERT with a mismatched
-- GUC must be rejected). See the commented verification at the foot.
--
-- Depends on: 0030 (columns), 0031 (tenant-leading keys + writer SELECT grant on cpfm), and the
-- B-era writer code being LIVE (writers set the GUC) — all shipped in 0f688d2.
-- ══════════════════════════════════════════════════════════════════════════════════════

-- Pre-flight (informational NOTICE; never blocks — C is policy-only and composition-agnostic).
do $$
declare
  n_foreign integer;
begin
  select
    (select count(*) from collections.cmd_explorer_rows          where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
  + (select count(*) from collections.daily_collections          where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
  + (select count(*) from collections.cmd_payer_facility_monthly where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
    into n_foreign;
  if n_foreign = 0 then
    raise notice '0033: all-BXR confirmed (0 non-BXR across the 3 tables) — enforcing the writer GUC before any Indigo write';
  else
    raise notice '0033: % non-BXR row(s) present — enforcement now actively protects live multi-tenant writes', n_foreign;
  end if;
end $$;

-- 1. cmd_explorer_rows (postgres-owned) — append-only writer: INSERT WITH CHECK + SELECT USING. ----
drop policy if exists cmd_explorer_writer_insert on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_insert on collections.cmd_explorer_rows
  for insert to cmd_rollup_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_explorer_writer_select on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_select on collections.cmd_explorer_rows
  for select to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- 2. daily_collections (postgres-owned) — INSERT WITH CHECK + DELETE USING + SELECT USING. --------
drop policy if exists cmd_daily_writer_insert on collections.daily_collections;
create policy cmd_daily_writer_insert on collections.daily_collections
  for insert to cmd_rollup_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_daily_writer_delete on collections.daily_collections;
create policy cmd_daily_writer_delete on collections.daily_collections
  for delete to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_daily_writer_select on collections.daily_collections;
create policy cmd_daily_writer_select on collections.daily_collections
  for select to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- 3. cmd_payer_facility_monthly (claims_admin-owned) — writer ALL: USING + WITH CHECK. ------------
set role claims_admin;

drop policy if exists cmd_ppfm_writer_write on collections.cmd_payer_facility_monthly;
create policy cmd_ppfm_writer_write on collections.cmd_payer_facility_monthly
  for all to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

reset role;

-- 4. Safety assertion: reads MUST remain permissive; writer policies MUST be GUC-scoped. -----------
do $$
declare
  bad_reader integer;
  bad_writer integer;
begin
  -- Any claims_reader SELECT policy that is NOT permissive (USING true) would blank the dashboard.
  select count(*) into bad_reader
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'collections'
    and c.relname in ('cmd_explorer_rows','daily_collections','cmd_payer_facility_monthly')
    and 'claims_reader' = any (select r.rolname from pg_roles r where r.oid = any(pol.polroles))
    and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') <> 'true';
  if bad_reader > 0 then
    raise exception '0033 FAILED: % claims_reader policy(ies) are no longer permissive — reads would break', bad_reader;
  end if;

  -- Every cmd_rollup_writer policy must now reference the tenant GUC.
  select count(*) into bad_writer
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'collections'
    and c.relname in ('cmd_explorer_rows','daily_collections','cmd_payer_facility_monthly')
    and 'cmd_rollup_writer' = any (select r.rolname from pg_roles r where r.oid = any(pol.polroles))
    and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
        not like '%app.business_entity_id%';
  if bad_writer > 0 then
    raise exception '0033 FAILED: % cmd_rollup_writer policy(ies) are not GUC-scoped', bad_writer;
  end if;

  raise notice '0033: enforcement flip OK — writer policies GUC-scoped, reader policies still permissive';
end $$;

-- 5. Verification (run manually AFTER apply) -----------------------------------------------------
-- 5a. Policy census — writer policies GUC-scoped, reader/admin still permissive:
--   select c.relname, pol.polname,
--          (select array_agg(r.rolname) from pg_roles r where r.oid = any(pol.polroles)) as roles,
--          pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
--          pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
--   from pg_policy pol join pg_class c on c.oid=pol.polrelid join pg_namespace n on n.oid=c.relnamespace
--   where n.nspname='collections' and c.relname in ('cmd_explorer_rows','daily_collections','cmd_payer_facility_monthly')
--   order by c.relname, pol.polname;
-- 5b. REAL BXR cron run must be green (0 non-BXR, no 42501/RLS error) — this is the required sign-off.
-- 5c. Negative probe (proves enforcement): as cmd_rollup_writer_login, inside a txn,
--       select set_config('app.business_entity_id','141d459c-f371-4229-9a92-ace198e940bb',true);  -- Indigo GUC
--       insert into collections.cmd_explorer_rows (... , business_entity_id) values (... , 'af504ab6-...');  -- BXR row
--     → must FAIL with a row-level security WITH CHECK violation (GUC=Indigo, row=BXR). Roll back.
