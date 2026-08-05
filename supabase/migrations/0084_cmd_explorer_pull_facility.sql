-- 0084 — collections.cmd_explorer_rows.pull_facility_code: per-row facility provenance for
--        the CMD explorer ingest (the forward fix for the 'No Facility' bucket).
--
-- WHY: the CMD Web API scopes every pull by CUSTOMER (one customer == one facility), so at write
--   time the cron KNOWS which facility's account a row came from — cmdExplorerCron.ts holds
--   `facilityCode` for the whole per-customer loop — and then discards it: the explorer write
--   stores only the report's own "Facility Name" CELL. When CMD emits a line with the cell set to
--   the literal 'No Facility' (interest lines, and a residual trickle: 1 charge / $1,200 landed
--   2026-07 via the cron), the row arrives with no recoverable owner. MEASURED (2026-08-04, BXR,
--   af504ab6-…): 11,414 'No Facility' charges / $29,081,575.38 at charge grain, of which
--   $20,953,468.22 across 265 members is unattributable from cmd_explorer_rows content alone —
--   because provenance was dropped at write time. This column stops the class going forward.
--
-- WHAT: one nullable text column. The cron write path (src/collections/cmdExplorerSeed.ts
--   insertRows, fed by cmdExplorerCron.ts) stamps it with the roster facilityCode
--   (src/collections/cmdCustomers.ts — BXR mnemonics like 'CAMH', Indigo CMD ids like '10026460';
--   both vocabularies are PKs in collections.facilities). It is PROVENANCE, not content:
--   - NOT part of the LOCKED 14-field row_fingerprint (same ruling as business_entity_id, 0028):
--     the dedup key must stay stable across re-pulls, and a re-pull is the same content regardless
--     of which account happened to return it first.
--   - NULL forever on all seed-era rows ('Derek Automation.csv' was a single combined export with
--     no per-customer provenance — nothing can backfill it honestly) and on all cron rows written
--     before the code deploy. ON CONFLICT (row_fingerprint) DO NOTHING means an already-present
--     row is never restamped: provenance is FIRST-SEEN, like ingested_at.
--   - Read by exactly one consumer: the 0086 resolution matview's 'named' method, which requires
--     ALL provenance values in a charge group to agree before attributing.
--
-- NO INDEX: written once per row, read only by the 0086 matview refresh, which scans the
--   facility='No Facility' slice in one pass. An index would cost every hourly insert and serve
--   one internal refresh per hour.
--
-- GRANTS/RLS: unchanged. cmd_rollup_writer holds table-level INSERT (verified live 2026-08-04 —
--   not column-scoped, so the new column is writable with no grant change); claims_reader's
--   SELECT policy and the writer's GUC-checked INSERT policy are untouched.
--
-- PHI DISCIPLINE: the value is a facility/office code from our own roster — non-PHI. No
--   ciphertext, no blind index, no patient data.
-- OWNERSHIP: postgres. ⚠ MEASURED 2026-08-05, not assumed — every live collections relation
--   (cmd_explorer_rows, facilities, cmd_facility_aliases, the rollup, cmd_charge_int_facility) is
--   `relowner = postgres`, matching 0083's header. An earlier cut of this file wrapped the ALTER in
--   `SET ROLE claims_admin` per the generic rule in .claude/rules/sql-migrations.md; that rule
--   describes the `claims` schema, and here it DOWNGRADES postgres to a non-owner and fails with
--   42501 "must be owner of table cmd_explorer_rows". No SET ROLE in this plane.
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; COMMENT is CREATE OR REPLACE semantics by nature.
-- DEPENDENCY: 0019 (the table). Nothing depends on this until 0086 (matview) and the Phase-2 code
--   deploy that starts stamping it. Applying this column BEFORE the code deploys is safe (inserts
--   simply leave it NULL); deploying the code before the column 500s the cron INSERT — apply
--   order is 0084 -> deploy.
-- Rollback: 0084_cmd_explorer_pull_facility_rollback.sql

-- 1. Column ------------------------------------------------------------------
-- No SET ROLE: apply_migration runs as postgres, which OWNS this table (see OWNERSHIP above).
alter table collections.cmd_explorer_rows
  add column if not exists pull_facility_code text;

comment on column collections.cmd_explorer_rows.pull_facility_code is
  'Roster facilityCode of the CMD customer pull that FIRST inserted this row (cmdCustomers.ts). '
  'Provenance, not report content: never in row_fingerprint, never restamped on re-pull. NULL on '
  'all seed-era rows and all cron rows written before the 0084-era code deploy. Read by the '
  '0086 cmd_facility_resolution ''named'' method.';

-- 2. Verification (run manually after apply) ----------------------------------
-- Column exists, is nullable text, and is all-NULL until the code deploy:
--   select count(*) as total, count(pull_facility_code) as stamped
--     from collections.cmd_explorer_rows;                  -- stamped = 0 before deploy
-- Fingerprint unaffected (must equal the pre-apply count — no re-insert storm on the next cron):
--   select count(*) from collections.cmd_explorer_rows;
-- First stamped rows after the deploy (expect roster codes only):
--   select pull_facility_code, count(*) from collections.cmd_explorer_rows
--    where pull_facility_code is not null group by 1 order by 2 desc;
