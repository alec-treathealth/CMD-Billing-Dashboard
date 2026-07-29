-- 0073: Consolidated billing-audit feed — charge_debit_id identity + new report columns
--       + honest-empty run recording. (Dashboard sequence; claimed 2026-07-29 in the
--       veris-data-notes.md reservation ledger.)
--
-- WHY: the CMD audit feed moved to ONE report (10064394) with two complementary status
-- filters (B 10148376 YTD-unresolved + C 10148377 balance-due-patient ~90d), whose 42-col
-- projection carries the plane's FIRST true unique row key: Charge/Debit ID (digits len 9,
-- 100% fill, unique per row across all 16 data-bearing customers — recon record
-- 2026-07-29; corroborated live: staging.payment_residual 57,486/57,486 distinct).
-- Alec's ruling 2026-07-29: ingest identity = upsert on charge_debit_id, with a one-time
-- fingerprint-match backfill stamping legacy rows, then the conflict key flips.
--
-- WHAT (all idempotent-forward; safe to re-run):
--   claims.audit_row
--     + charge_debit_id text NULL         — the report row key (position 4). NULL on
--                                           legacy + OP-cron rows until backfilled/refetched.
--     + claim_date_entered date NULL      — B's window axis (Claim Date Entered >= Jan 1).
--     + claim_first_billed_date date NULL — the ONLY status-change anchor; 1.3% measured
--                                           null = entered-but-never-billed. Nullable BY DESIGN.
--     + cmd_customer_id text NULL         — ingest provenance (roster customer number),
--                                           stamped like facility_code, NOT part of the key.
--     + source_filter_id text NULL        — which status slice last asserted the row
--                                           (B 10148376 | C 10148377) — the work item's
--                                           per-row tag; NULL on legacy/OP-pair rows.
--     + UNIQUE partial index (business_entity_id, charge_debit_id)
--       WHERE charge_debit_id IS NOT NULL — tenant-leading (standing rule); the
--       consolidated ingest's ON CONFLICT arbiter.
--   claims.audit_ingest_run
--     + customers_empty integer NOT NULL DEFAULT 0 — honest SUCCESS-empty accounting
--       (recon: a raced empty night recorded status='ok'; auditIngest recording defect).
--     ~ scope CHECK widened to ('IP','OP','CONSOLIDATED') — one run now covers both
--       scopes; audit_row.audit_scope stays IP|OP (scope is TOB-derived per row).
--
-- KEY-SHAPE DECISION (senior-engineer call under Alec's delegated authority, 2026-07-29):
--   key = (business_entity_id, charge_debit_id), NOT (cmd_customer_id, charge_debit_id).
--   Evidence: recon per-row uniqueness across all 16 customers + zero duplicates across
--   57,486 payment_residual claim lines spanning every BXR facility. cmd_customer_id is
--   carried as a provenance COLUMN, and the ingest's DO UPDATE is guarded so a
--   cross-customer key collision (never observed) SKIPS + counts instead of silently
--   re-attributing a row to another facility.
--
-- ⚠ FINGERPRINT UNIQUE CONSTRAINT IS DELIBERATELY RETAINED (not dropped):
--   the healthy OP cron still upserts ON CONFLICT (business_entity_id, row_fingerprint)
--   during its 5-night soak against the consolidated feed — dropping the constraint would
--   break its arbiter and kill OP ingest. Consequence: two DISTINCT charge_debit_ids with
--   IDENTICAL stable-identity fields (same fingerprint — e.g. two byte-identical charge
--   lines on one claim) cannot both insert; the consolidated ingest QUARANTINES the second
--   (counted, labelled, never errors the batch). Measured occurrences: zero (CAMH 1,592
--   rows → 1,592 distinct fingerprints). A follow-up migration drops the unique constraint
--   (→ plain index) when the OP pair decommissions, retiring the quarantine path.
--
-- TRANSITION (the ruled backfill — runs in the INGEST, not here, because charge_debit_id
-- values come from the report): per batch, (1) UPDATE-stamp legacy rows matched on
-- (business_entity_id, row_fingerprint) that still carry charge_debit_id IS NULL, then
-- (2) upsert on the new key. The first consolidated run is the backfill; B's YTD refetch
-- also closes the IP plane's 2026-07-16 → cutover gap at current-status grain.
--
-- APPLY PATH: apply_migration as postgres; objects born owned via SET ROLE claims_admin
-- (standing posture — if SET ROLE fails 42501, re-check
-- pg_has_role('postgres','claims_admin','SET'); see the 0049/S2 ledger entries).
-- No grant work: new columns inherit claims.audit_row's existing table-level grants
-- (claims_audit_writer INSERT/UPDATE, claims_reader SELECT); RLS policies are row-level
-- and unchanged.
--
-- ROLLBACK: 0073_audit_row_consolidated_rollback.sql. NOTE: rollback DROPS the four
-- columns — backfilled charge_debit_id/date values are lost (recoverable by re-running
-- the ingest after re-apply; B is YTD-refetched nightly).

set role claims_admin;

-- claims.audit_row — the three report columns + provenance column
alter table claims.audit_row add column if not exists charge_debit_id text;
alter table claims.audit_row add column if not exists claim_date_entered date;
alter table claims.audit_row add column if not exists claim_first_billed_date date;
alter table claims.audit_row add column if not exists cmd_customer_id text;
alter table claims.audit_row add column if not exists source_filter_id text;

comment on column claims.audit_row.source_filter_id is
  'The consolidated feed status slice that last asserted this row: filter B (YTD unresolved) or C (balance-due-patient ~90d). Volatile — re-stamped on every upsert. NULL on legacy/OP-pair rows.';
comment on column claims.audit_row.charge_debit_id is
  'CMD Charge/Debit ID — the consolidated feed''s unique row key (recon 2026-07-29); same identifier space as collections.cmd_charge_census.charge_id / cmd_explorer_rows.charge_id and staging.payment_residual.charge_debit_id. NULL on legacy rows never re-sent by filter B/C and on OP-pair rows until cutover.';
comment on column claims.audit_row.claim_date_entered is
  'Report "Claim Date Entered" (42-col position 41) — filter B''s YTD window axis.';
comment on column claims.audit_row.claim_first_billed_date is
  'Report "Claim First Billed Date" (position 42) — the feed''s only status-change anchor; NULL = entered-but-never-billed (1.3% measured 2026-07-29).';
comment on column claims.audit_row.cmd_customer_id is
  'Ingest provenance: the roster CMD customer number the row was pulled under (stamped like facility_code, never parsed from the report). NOT part of the identity key; the ingest skips+counts any cross-customer charge_debit_id collision.';

-- The consolidated ingest's arbiter: tenant-leading UNIQUE over the report key.
-- Partial (charge_debit_id IS NOT NULL) so legacy/OP NULL rows never collide.
create unique index if not exists audit_row_entity_charge_debit_key
  on claims.audit_row (business_entity_id, charge_debit_id)
  where charge_debit_id is not null;

-- claims.audit_ingest_run — honest-empty counter + widened scope domain
alter table claims.audit_ingest_run add column if not exists customers_empty integer not null default 0;
comment on column claims.audit_ingest_run.customers_empty is
  'Customers whose report returned SUCCESS-empty this run (post empty-grace). A customer here whose prior-night rows were > 0 and which is not allowlisted expected-empty (WRC) marks the run status=partial — the honest-empty rule (recon 2026-07-29).';

do $$
begin
  -- Widen the run-scope domain for the consolidated feed. Constraint recreated under the
  -- SAME name; audit_row.audit_scope's IP|OP CHECK is deliberately untouched (per-row
  -- scope is TOB-derived and always IP or OP; unrecognised TOB rows are quarantined,
  -- never inserted).
  if exists (
    select 1 from pg_constraint
    where conname = 'audit_ingest_run_scope_check'
      and conrelid = 'claims.audit_ingest_run'::regclass
      and pg_get_constraintdef(oid) not like '%CONSOLIDATED%'
  ) then
    alter table claims.audit_ingest_run drop constraint audit_ingest_run_scope_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'audit_ingest_run_scope_check'
      and conrelid = 'claims.audit_ingest_run'::regclass
  ) then
    alter table claims.audit_ingest_run
      add constraint audit_ingest_run_scope_check
      check (scope = any (array['IP'::text, 'OP'::text, 'CONSOLIDATED'::text]));
  end if;
end
$$;

reset role;
