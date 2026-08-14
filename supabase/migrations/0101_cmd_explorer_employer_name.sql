-- 0101 — employer_name on collections.cmd_explorer_rows (primary-insurance employer dimension)
--
-- ⚠ NUMBER IS PROVISIONAL: re-derive from supabase_migrations.schema_migrations + every worktree's
--   untracked .sql IMMEDIATELY before apply (the 0096 collision rule). CLAUDE.md said next = 0101
--   as of 2026-08-12; this file was authored 2026-08-14 without live-ledger access.
--
-- WHY: the Collections explorer needs a searchable employer, sourced from CMD itself — the VOB
--   source was ruled a false source of truth for this surface and removed (PR #225). The owner
--   added 'Primary Ins Emp Name' to the live explorer report layout on 2026-08-14 (same report id,
--   SAME filter ids — the hourly cron keeps its filter), so new rows carry it at ingest. Historical
--   rows are stamped by the one-shot backfill CLI (src/collections/cmdEmployerBackfill.ts, report
--   10050915 / filter 10148786 — that filter is SINGLE-USE, backfill only, per the owner).
--
-- PHI DISCIPLINE: employer_name is stored PLAINTEXT as a plan-level dimension, the same posture as
--   primary_payer and the (ratified, PR #14/#15) VOB employer columns. NOTE the known tension:
--   app/lib/phi.ts lists employer_name as a maskable PHI column for the CLAIMS-plane results table.
--   The collections treatment follows the owner's standing ruling (searchable dimension); the
--   claims-plane classification is a separate open item, deliberately not resolved here.
-- OWNERSHIP: collections plane — owner postgres; NO `SET ROLE claims_admin` (it 42501s here, see
--   .claude/rules/sql-migrations.md).
-- IDEMPOTENT: IF NOT EXISTS; re-running converges.
-- DEPENDENCY: none (the column is nullable; ingest code that WRITES it must deploy only after this
--   is applied — the INSERT names the column, so the hourly cron 42703s on an unapplied schema).
-- Rollback: 0101_cmd_explorer_employer_name_rollback.sql

-- 1. The column ---------------------------------------------------------------
alter table collections.cmd_explorer_rows
  add column if not exists employer_name text;

comment on column collections.cmd_explorer_rows.employer_name is
  'Primary-insurance employer (CMD ''Primary Ins Emp Name''). Plan-level dimension, plaintext, '
  'NOT in row_fingerprint. Reflects the patient''s employer AS OF ingest/backfill — a patient who '
  'changes jobs is NOT retroactively restated (approximation accepted by the owner 2026-08-14).';

-- 2. Grants -------------------------------------------------------------------
-- cmd_rollup_writer INSERTs new rows (table-level INSERT already covers the new column) and the
-- reader's table-level SELECT covers it too — no new table grants are required. The one addition:
-- the one-shot backfill runs AS THE OWNER (postgres) per the 0066 runbook, so no UPDATE grant is
-- minted for any app role — least privilege holds (no app-path UPDATE exists for this table).

-- 3. No index here ------------------------------------------------------------
-- The search executes against the CHARGE ROLLUP (0102 adds the trigram GIN there). The base table
-- serves only id-joins / blind-index equality / backfill CLIs (verified in 0081's header) — an
-- index here would be write amplification serving zero queries.

-- 4. Verification (run manually after apply) -----------------------------------
-- select column_name, data_type, is_nullable from information_schema.columns
--  where table_schema = 'collections' and table_name = 'cmd_explorer_rows'
--    and column_name = 'employer_name';                       -- text, YES
-- select has_table_privilege('cmd_rollup_writer', 'collections.cmd_explorer_rows', 'INSERT'); -- t
-- select has_table_privilege('claims_reader',    'collections.cmd_explorer_rows', 'SELECT'); -- t
