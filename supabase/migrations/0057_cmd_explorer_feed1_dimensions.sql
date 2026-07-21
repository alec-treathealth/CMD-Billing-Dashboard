-- 0057: Feed-1 DIMENSION columns on collections.cmd_explorer_rows (Qualify v2 feed series, artifact ① of 3).
--
-- WHY: the Qualify v2 feed series introduces a CMD 21-column export (up from today's 17-col live pull).
-- This migration adds the four genuinely-new charge DIMENSION columns to the existing append-only
-- payment-EVENT table so the ingest mapper (artifact ②) can persist them. The columns are INERT until
-- ② maps them — that is intentional; ① is DDL-only. No mapper, fingerprint, cron, or rollup change here.
--
-- APPEND-ONLY POSTURE PRESERVED (deliberate — do NOT "fix"): cmd_explorer_rows stays append-only
-- (0019 grain: one row per content SNAPSHOT; ON CONFLICT (row_fingerprint) DO NOTHING; NO UPDATE grant;
-- 0033 GUC-scoped writer). This migration adds ONLY nullable columns + one partial index. It does NOT:
--   • add charge_id to row_fingerprint — the fingerprint is the LOCKED 14-field TS hash
--     (src/collections/cmdExplorerSeed.ts EXPECTED_HEADERS + fingerprint order). Widening it is
--     artifact ②-or-never; explicitly FENCED here.
--   • make charge_id a UNIQUE or upsert key on this table — charge_id here is an INERT JOIN DIMENSION
--     ONLY: the join key to collections.cmd_charge_census (0058). The census owns the upsert grain.
--   • add any grant (no UPDATE, no DELETE) — the no-UPDATE posture is a deliberate property.
--
-- COLUMN NOTES (all NULLABLE, no defaults, no backfill — inert until ②):
--   charge_id             — CMD's stable per-charge id (21-col export col 1). The census join key.
--                           NULL on every existing row and on any future pull that omits it.
--   charge_entered_date   — CMD "Charge Entered Date" (a daysToPay lag source for artifact ③).
--   charge_to_date        — CMD "Charge To Date" (the second daysToPay lag source).
--   claim_status_raw      — CMD "Claim Status" verbatim (e.g. 'PAID', 'CLAIM AT <payer>', 'BALANCE DUE
--                           PATIENT', ...). Non-PHI workflow label.
--   claim_status_category — the NORMALIZED category, populated at ingest in ② via the SINGLE TS taxonomy
--                           (normalizeStatus, src/billingAudit/auditRowMap.ts). The allowed values live
--                           in TS, NOT here — deliberately NO SQL CHECK enumerates them (one source of
--                           truth; a SQL enum would drift from the TS vocabulary as CMD adds statuses).
--
-- RLS / GRANTS: UNCHANGED. The cmd_explorer_rows policies (0019 reader USING(true); 0033 writer
-- GUC-scoped INSERT/SELECT) are ROW-level (no column list in polqual/polwithcheck), and the grants
-- (0019: table-level SELECT to claims_reader, INSERT to cmd_rollup_writer — no column list) are
-- TABLE-level, so both AUTOMATICALLY cover columns added later. This is VERIFIED, not assumed — the
-- build verification plan probes it (a claims_reader SELECT of the new columns + the writer INSERT path).
-- No grant is added or altered here.
--
-- INDEX: a PARTIAL btree on charge_id WHERE charge_id IS NOT NULL — the census join key. Partial
-- because charge_id is NULL on all existing rows (and stays NULL until ② maps it), so the index covers
-- only real values and never carries the historical-null backlog.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; CREATE INDEX IF NOT EXISTS. Safe to re-run. Additive-nullable
-- ADD COLUMN is metadata-only in PG11+ (no table rewrite; only a brief catalog ACCESS EXCLUSIVE lock).
-- No backfill.
-- DEPENDENCY: 0019 (table), 0028/0030 (business_entity_id), 0036 (blind indexes) — all unaffected.
-- Rollback: 0057_cmd_explorer_feed1_dimensions_rollback.sql.

alter table collections.cmd_explorer_rows
  add column if not exists charge_id             text,
  add column if not exists charge_entered_date   date,
  add column if not exists charge_to_date        date,
  add column if not exists claim_status_raw      text,
  add column if not exists claim_status_category text;

-- The collections.cmd_charge_census (0058) join key. Partial: charge_id is NULL on every pre-② row.
create index if not exists cmd_explorer_charge_id_idx
  on collections.cmd_explorer_rows (charge_id)
  where charge_id is not null;
