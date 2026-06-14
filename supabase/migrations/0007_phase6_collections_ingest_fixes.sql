-- 0007: Phase 6 collections ingest fixes (discovered during the Step 3 dry-run).
--
-- (1) daily_collections is NOT 1:1 with collections_raw. The group daily tabs use a
--     WIDE layout: one source sheet row carries several facility column-blocks
--     (TMH CA | TMH TN | TMH TX | TMH WA, plus vertically-stacked FRCA / TMH NV /
--     Telehealth MH sections), so one raw row expands to MANY facility rows. The
--     0006 refinement `unique (collections_raw_id)` (constraint
--     daily_collections_collections_raw_id_key, verified live) is therefore wrong
--     for daily and must be dropped. Idempotency for daily is preserved by the
--     existing bucket index collections_daily_bucket
--     (facility_code, source_group_code, payment_date) NULLS NOT DISTINCT — the
--     loader inserts ON CONFLICT on that bucket. The 1:1 unique stays correct on
--     payment_lines / negotiation_worklist / rollup_snapshots (each 1 row → 1 raw).
--
-- (2) TELEHEALTH_MH is a REAL facility that appears in the Treat+FRCA workbook (a
--     "Telehealth MH" detail/daily section) but was not in the 0006 seed. Add it.
--     Group codes TREAT_FRCA / LSMH_DMH remain workbook source_group_code lineage
--     only — they are NOT facilities and are deliberately absent here.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS; INSERT ... ON CONFLICT DO UPDATE. Safe to
-- re-run. No RLS / grant / ownership changes — privilege posture is unchanged.

-- (1) Remove the incorrect 1:1 unique on daily_collections.collections_raw_id.
alter table collections.daily_collections
  drop constraint if exists daily_collections_collections_raw_id_key;

-- (2) Seed the missing real facility (refreshes name/account on re-run; leaves notes).
insert into collections.facilities (facility_code, facility_name, account_number)
values ('TELEHEALTH_MH', 'Telehealth MH', '10034666')
on conflict (facility_code) do update set
  facility_name  = excluded.facility_name,
  account_number = excluded.account_number;
