-- 0054: collections.rollup_refresh_run — durable, queryable run-log for the charge-rollup refresh.
--
-- WHY: collections.cmd_explorer_charge_rollup (0050 matview) was going stale silently. The only
-- record of a refresh outcome today is a console.log/console.error line (Vercel logs only — this
-- project is 403-scoped away from `vercel logs`) plus the ephemeral HTTP response body. There is
-- NO way to answer "did last night's refresh succeed?" by SELECT. This table is that record: the
-- new dedicated refresh cron (/api/cron/refresh-charge-rollup, 45 * * * *) writes ONE row per
-- attempt — a start row on entry, updated on completion — so a morning health check reads straight
-- from the DB with zero Vercel access.
--
-- NOT TENANT-SCOPED (deliberate — differs from 0053/0033): a single REFRESH MATERIALIZED VIEW
-- CONCURRENTLY rebuilds the WHOLE matview across BOTH tenants at once, so a refresh run has no one
-- business_entity_id. This table therefore carries NO business_entity_id and its writer RLS policies
-- are PERMISSIVE (using/with check true), NOT GUC-checked like the tenant-scoped collections writer
-- policies (0033). The refresh route does not run inside withTenant and sets no tenant GUC.
--
-- NON-PHI: timestamps, a duration, a boolean, a max payment DATE, a trigger label, and (on failure)
-- a DB/driver error MESSAGE only — never a cell value, never PHI. `error` holds the caught refresh
-- exception's message; the route must pass the message only, never row contents.
--
-- SIGNAL SEMANTICS (why ok/finished_at are NULLABLE): the route INSERTs a start row (ok NULL,
-- finished_at NULL), runs the refresh, then UPDATEs the same row (ok true/false, finished_at,
-- duration, error, rollup_max_payment_date). A hard platform timeout kills the function before the
-- UPDATE — leaving ok IS NULL / finished_at IS NULL. That "started but never finished" state is
-- itself the failure signal; nothing is swallowed.
--
-- WRITE PATH: /api/cron/refresh-charge-rollup as cmd_rollup_writer (via CMD_ROLLUP_WRITER_DATABASE_URL,
-- connecting as the login-member cmd_rollup_writer_login — the same role the report verified holds
-- EXECUTE on the SECURITY-DEFINER refresh function and, via the grant below, SELECT on the matview).
--
-- APPLY PATH: apply_migration runs as postgres, which OWNS the sibling collections tables
-- (cmd_explorer_rows, daily_collections) and the 0050 matview — so this table is created postgres-owned
-- directly (no SET ROLE; unlike 0053's claims.* table, which is claims_admin-owned). Additive + empty
-- on create, so applying ahead of the cron-write deploy is harmless (an un-deployed cron never inserts).
--
-- MATVIEW GRANT (additive; does NOT touch the 0050 matview DEFINITION): the route reads
-- max(payment_received) off the rollup to stamp rollup_max_payment_date, so cmd_rollup_writer needs
-- SELECT on the matview (0050 granted it to claims_reader only). Non-PHI: the matview projects no
-- ciphertext columns.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; grants reapplied unconditionally; DROP POLICY IF
-- EXISTS before CREATE POLICY. Safe to re-run.
-- Rollback: 0054_collections_rollup_refresh_run_rollback.sql (drops the table + revokes the additive
-- matview grant). 0054 was unclaimed (checked origin/main + all local branches + all worktrees +
-- untracked files; the ledger at docs/veris-data-notes.md:1146-1152 stops at 0052 and is stale —
-- 0053_audit_ingest_run is already on origin/main).

create table if not exists collections.rollup_refresh_run (
  id                       bigint generated always as identity primary key,
  started_at               timestamptz not null default now(),
  finished_at              timestamptz,                 -- NULL until the run completes (or was killed)
  duration_ms              integer,                     -- route-computed elapsed ms of the refresh
  ok                       boolean,                     -- NULL = started/unfinished, true = ok, false = caught failure
  error                    text,                        -- caught refresh error MESSAGE only (non-PHI); NULL on success
  rollup_max_payment_date  date,                        -- max(payment_received) in the rollup post-refresh (freshness proof)
  triggered_by             text not null default 'cron' check (triggered_by in ('cron', 'manual'))
);

-- Morning health check: newest attempts first.
create index if not exists rollup_refresh_run_started_idx
  on collections.rollup_refresh_run (started_at desc);

-- Grants: writer INSERT/UPDATE/SELECT (start-row then update-in-place), reader SELECT for a future
-- ops surface. No DELETE (append/update-only log). Belt-and-suspenders revoke of the exposed roles.
revoke all on collections.rollup_refresh_run
  from public, anon, authenticated, service_role, cmd_rollup_writer;
grant select, insert, update on collections.rollup_refresh_run to cmd_rollup_writer;
grant select                 on collections.rollup_refresh_run to claims_reader;

-- IDENTITY column: a non-owner writer needs USAGE on the backing sequence to insert (mirror 0053).
do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('collections.rollup_refresh_run', 'id');
  if seq is not null then
    execute format('grant usage, select on sequence %s to cmd_rollup_writer', seq);
  end if;
end $$;

-- Additive matview grant so the route can read freshness (0050 definition untouched).
grant select on collections.cmd_explorer_charge_rollup to cmd_rollup_writer;

-- RLS: enabled to match the collections posture + keep the Supabase advisor green. Policies are
-- PERMISSIVE (this is non-tenant operational metadata, not tenant data — see header). Owner
-- (postgres) bypasses RLS regardless; cmd_rollup_writer (no BYPASSRLS, non-owner) needs these.
alter table collections.rollup_refresh_run enable row level security;

drop policy if exists rollup_refresh_run_reader_select on collections.rollup_refresh_run;
create policy rollup_refresh_run_reader_select on collections.rollup_refresh_run
  for select to claims_reader using (true);

drop policy if exists rollup_refresh_run_writer_select on collections.rollup_refresh_run;
create policy rollup_refresh_run_writer_select on collections.rollup_refresh_run
  for select to cmd_rollup_writer using (true);

drop policy if exists rollup_refresh_run_writer_insert on collections.rollup_refresh_run;
create policy rollup_refresh_run_writer_insert on collections.rollup_refresh_run
  for insert to cmd_rollup_writer with check (true);

drop policy if exists rollup_refresh_run_writer_update on collections.rollup_refresh_run;
create policy rollup_refresh_run_writer_update on collections.rollup_refresh_run
  for update to cmd_rollup_writer using (true) with check (true);
