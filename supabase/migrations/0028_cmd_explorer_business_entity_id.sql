-- 0028: business_entity_id on collections.cmd_explorer_rows — dashboard tenant scoping.
--
-- WHY: onboarding Indigo Billing means the PHI-bearing Collections Explorer table
-- (cmd_explorer_rows) must be per-tenant so the dashboard readers — the grid, the
-- facility filter, and the audited PHI reveal — can scope to the signed-in user's
-- entitled entity (BXR/Indigo), derived server-side from the RBAC-clamped view
-- (app/lib/views.ts viewToEntityIds + app/lib/rbac.ts). Without this column every
-- reader saw every tenant's rows, so an Indigo user could reveal BXR patient
-- identifiers (and vice versa) the moment Indigo data enters the table.
--
-- SCOPE: this migration is the SCHEMA half for the EXPLORER table ONLY. The
-- aggregate collections readers (daily_collections / cmd_payer_facility_monthly,
-- served by the shared src/collections/* library) are scoped in a separate,
-- coordinated step alongside the in-flight multi-tenant ingest work. Those tables
-- hold no Indigo data today (the collections cron is BXR-only — CLAUDE.md §7/§15
-- guardrail), so deferring them commingles nothing.
--
-- BACKFILL: DEFAULT is the BXR business_entity_id. In PG11+ an ADD COLUMN with a
-- NON-VOLATILE constant default is a metadata-only operation (no table rewrite) and
-- stamps every existing row with that default atomically — so all current rows
-- become BXR-owned without a separate UPDATE, instantly, even at ~139k rows. NEW
-- rows also default to BXR: both the daily cron and the historical seed INSERT via a
-- fixed explicit column list (src/collections/cmdExplorerSeed.ts INSERT_COLS, reused
-- by cmdExplorerCron.ts) that does NOT name business_entity_id, so the default
-- applies with NO ingest code change. When the parallel work lands Indigo ingest it
-- sets this column EXPLICITLY (overriding the default) per source customer.
--
-- row_fingerprint is deliberately UNCHANGED: it is a SHA-256 over the 14 CMD field
-- values only (src/collections/cmdExplorerSeed.ts), NOT business_entity_id. Folding
-- the tenant in would recompute every fingerprint and cause the next idempotent cron
-- to RE-INSERT all ~139k rows. Tenant facility codes are disjoint, so the fingerprint
-- needs no tenant component for correctness — this is intentional, not an omission.
--
-- NOT DONE HERE (coordinated follow-ups, documented in the tenancy guardrail):
--   • tenant-scoped RLS + a writer app.business_entity_id GUC (the staging.* pattern).
--     Today isolation is enforced at the APP READER layer (WHERE business_entity_id =
--     ANY(<entitled ids>)); RLS is defense-in-depth to add with the GUC-aware ingest.
--   • a composite index (business_entity_id, payment_received). Skipped now: the column
--     is single-valued (all BXR) until Indigo lands, so an index would be pure write
--     overhead the planner won't use. Add it when a second tenant's rows exist.
--   • business_entity_id on daily_collections / cmd_payer_facility_monthly (aggregate readers).
--
-- No FK to collections.business_entities (migration 0027, the tenant registry): that
-- registry is uncommitted/unapplied and this change must stand alone; the UUID is a
-- fixed constant (same value seeded in 0027 and app/lib/views.ts BXR_ENTITY_ID) — a
-- soft reference, mirroring the staging.* tables which also carry a bare
-- business_entity_id with no FK.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; comment reapplied unconditionally. Safe to
-- re-run. No grant/RLS/policy changes — claims_reader's existing table-level SELECT
-- (migration 0019) automatically covers the new column.
--
-- DEPENDENCY: assumes 0019 (collections.cmd_explorer_rows) has run.

alter table collections.cmd_explorer_rows
  add column if not exists business_entity_id uuid not null
    default 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';  -- BXR Consulting LLC (CMD #475729)

comment on column collections.cmd_explorer_rows.business_entity_id is
  'Tenant owner (BXR/Indigo). DEFAULT BXR so the BXR-only cron + seed (explicit INSERT_COLS, no beid) auto-tag BXR with no ingest change; Indigo ingest sets it explicitly. Dashboard explorer readers filter by this per the RBAC-clamped view. NOT part of row_fingerprint (facility codes are tenant-disjoint). Soft ref to collections.business_entities (no FK).';

-- Verification (run after apply):
--   select business_entity_id, count(*) from collections.cmd_explorer_rows group by 1;
--     expect exactly one group: af504ab6-… (BXR) = the full existing row count.
