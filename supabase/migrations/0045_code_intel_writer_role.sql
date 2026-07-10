-- 0045: Least-privilege writer role for the quarterly CMS HCPCS sync job.
--
-- WHY: the CMS HCPCS sync (src/jobs/cmsHcpcsSync, app/app/api/cron/cms-hcpcs-sync)
-- runs INSIDE the user-facing Vercel deployment. Per docs/CLAUDE.md §2, that path
-- MUST NOT use claims_admin or the service-role key (ingest-path only). This
-- migration mirrors 0013 (cmd_rollup_writer): a dedicated NOLOGIN role that can do
-- EXACTLY what the sync needs — read the current HCPCS snapshot, upsert HCPCS
-- ref_codes, and insert pending change events — and nothing else. If the web app
-- were compromised, this credential cannot read PHI or touch any other schema.
--
-- PHI DISCIPLINE: code_intel is non-PHI by construction (0043). This role has no
-- access to claims / collections or any PHI-bearing object.
--
-- WHAT THE SYNC NEEDS (least privilege):
--   * ref_code            — SELECT (read prior snapshot for the diff),
--                           INSERT + UPDATE (upsert code + CMS provenance columns).
--   * policy_change_event — INSERT only (flags are created; humans review them via
--                           the app as claims_reader — the writer never updates
--                           review_status). SELECT is NOT granted; idempotency is
--                           enforced by the partial unique index (0043) via
--                           ON CONFLICT DO NOTHING, which needs no SELECT.
-- No DELETE anywhere. No access to billing_policy* (the sync flags; humans apply).
-- ref_code ids are gen_random_uuid() defaults (not sequences), so no sequence grant.
--
-- Idempotency: role created only-if-absent (never DROP ROLE); REVOKE/GRANT
-- reapplied unconditionally; DROP POLICY IF EXISTS before CREATE POLICY. Safe to re-run.
--
-- ⚠️ NOT APPLIED YET — review-only until AUDIT.md sign-off. Rollback: 0045_*.
--
-- DEPENDENCY: assumes 0043 (code_intel schema, tables, RLS enabled).
--
-- ⚠️ OPERATOR STEP (out of band — NOT in this migration, by design): code_intel_writer
-- is NOLOGIN, mirroring claims_admin / cmd_rollup_writer. To use it, provision a login
-- mapping the SAME way (a login role that inherits code_intel_writer, or a password set
-- via a secure channel — NEVER in a migration) and place its connection string in the
-- Vercel env var CODE_INTEL_WRITER_DATABASE_URL. No password/secret appears in this file.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'code_intel_writer') then
    create role code_intel_writer nologin;
  end if;
end $$;

grant usage on schema code_intel to code_intel_writer;

-- ref_code: read prior snapshot + upsert.
revoke all on code_intel.ref_code from code_intel_writer;
grant select, insert, update on code_intel.ref_code to code_intel_writer;

-- policy_change_event: insert flags only.
revoke all on code_intel.policy_change_event from code_intel_writer;
grant insert on code_intel.policy_change_event to code_intel_writer;

-- RLS policies. The GRANTs above are the real boundary (no DELETE, no SELECT on
-- events, nothing outside these two tables); the policies simply let the permitted
-- verbs through under RLS.
drop policy if exists ref_code_writer_write on code_intel.ref_code;
create policy ref_code_writer_write on code_intel.ref_code
  for all to code_intel_writer using (true) with check (true);

drop policy if exists pce_writer_insert on code_intel.policy_change_event;
create policy pce_writer_insert on code_intel.policy_change_event
  for insert to code_intel_writer with check (true);
