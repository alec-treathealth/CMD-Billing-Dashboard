-- 0013: Least-privilege writer role for the daily CMD payer rollup refresh.
--
-- WHY: the Master BXR Chart "By Payer" view reads collections.cmd_payer_facility_monthly
-- (migration 0012). A daily Vercel Cron route refreshes the trailing window of months
-- from the live CMD report so the in-progress month stays current without a manual CSV
-- re-ingest (src/collections/cmdPayerRefresh.ts, app/app/api/cron/refresh-cmd-payer).
--
-- That refresh runs INSIDE the user-facing Vercel deployment, so it MUST NOT use
-- claims_admin (docs/CLAUDE.md §2: "the service-role key and claims_admin are
-- ingest-path only"). This migration creates a dedicated role that can do exactly
-- one thing — replace rows in the rollup table — and nothing else. Least privilege:
-- if the web app were compromised, this credential cannot read PHI or touch any
-- other table.
--
-- PHI DISCIPLINE (§2): this role has NO access to any PHI-bearing table. The rollup
-- it writes is non-PHI by construction (payer/facility names, service dates, money
-- sums — all in the §8 allowlist). The refresh aggregates the PHI report rows
-- in-process and writes only this rollup.
--
-- Idempotency: role created only-if-absent (never DROP ROLE); REVOKE/GRANT reapplied
-- unconditionally; DROP POLICY IF EXISTS before CREATE POLICY. Safe to re-run.
--
-- DEPENDENCY: assumes 0012 (collections.cmd_payer_facility_monthly + its RLS) has run.
--
-- ⚠️ OPERATOR STEP (out of band — not in this migration, by design): cmd_rollup_writer
-- is a NOLOGIN privilege role, mirroring claims_reader / claims_admin. To use it, a
-- login mapping must be provisioned the SAME way the claims_admin login was (e.g. a
-- login role that inherits cmd_rollup_writer, or a password set via a secure channel —
-- NEVER in a migration), and its connection string placed in the Vercel env var
-- CMD_ROLLUP_WRITER_DATABASE_URL. No password or secret appears in this file.

-- 1. Role (privilege-only, created only-if-absent). --------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cmd_rollup_writer') then
    create role cmd_rollup_writer nologin;
  end if;
end $$;

-- 2. Grants ------------------------------------------------------------------
-- Schema usage, plus INSERT + DELETE on the rollup table ONLY. No SELECT, no
-- UPDATE, no access to any other object. writeRollup (refresh-by-month) needs only
-- DELETE (replace the month buckets) + INSERT (the fresh rows); the identity PK is
-- GENERATED ALWAYS, so no sequence privilege is required.
grant usage on schema collections to cmd_rollup_writer;
revoke all on collections.cmd_payer_facility_monthly from cmd_rollup_writer;
grant insert, delete on collections.cmd_payer_facility_monthly to cmd_rollup_writer;

-- 3. RLS ---------------------------------------------------------------------
-- The table has RLS enabled (0012). Add a policy so cmd_rollup_writer can insert
-- and delete; the GRANTs above are the real privilege boundary (no SELECT/UPDATE),
-- so a permissive `for all` policy cannot widen what the role may actually do.
drop policy if exists cmd_ppfm_writer_write on collections.cmd_payer_facility_monthly;
create policy cmd_ppfm_writer_write on collections.cmd_payer_facility_monthly
  for all to cmd_rollup_writer using (true) with check (true);
