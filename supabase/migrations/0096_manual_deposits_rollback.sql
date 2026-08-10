-- =============================================================================
-- ROLLBACK for 0096 — removes manual deposits and restores the 0014 view shape.
--
-- ⚠️ THIS ROLLBACK REMOVES MONEY FROM THE DASHBOARD, and that is not a side effect — it is the
-- whole point. Every live `source_tag = 'manual'` row is money a super admin asserted is in
-- hand. After this runs, none of it counts in MTD, YTD, All Facilities or the Master chart,
-- because the view stops having a branch that can carry it AND the CHECK stops the rows being
-- legal at all.
--
-- MEASURE THE LOSS FIRST. Run this and write the numbers down:
--   SELECT business_entity_id, count(*), sum(gross_amount)
--     FROM collections.daily_collections
--    WHERE source_tag = 'manual' AND removed_at IS NULL
--    GROUP BY 1;
--
-- §1 DELETES those rows, because the restored CHECK constraint cannot be added while they
-- exist. There is no way to keep them and roll back the constraint — the two are mutually
-- exclusive. If the data matters, export it before running this:
--   \copy (SELECT * FROM collections.daily_collections WHERE source_tag='manual')
--      TO 'manual_deposits_backup.csv' CSV HEADER
--
-- ROLL THE APP BACK FIRST, OR TOGETHER. app/lib/server.ts calls
-- collections.add_manual_deposit and collections.remove_manual_deposit; both are dropped in §4,
-- so a deployed build will 500 on the Add and Remove controls. The readers are safe either way
-- — they project explicit columns and never referenced source_tag/id from the view.
--
-- ⚠️ NO `SET ROLE claims_admin`. Same reason as the forward migration: `collections` relations
-- are owned by postgres, and a SET ROLE here fails with 42501.
-- =============================================================================

-- 1. Remove the rows the restored CHECK cannot hold. ---------------------------
-- Irreversible. See the header — export first if the data matters.
DELETE FROM collections.daily_collections WHERE source_tag = 'manual';

-- 2. Restore the 0014 view shape (six columns, no manual branch). --------------
-- CREATE OR REPLACE cannot DROP columns, so this is a genuine DROP + CREATE. Verified
-- 2026-08-10 that no other view or matview depends on it; §5 reinstates the grants, which the
-- DROP destroys.
DROP VIEW IF EXISTS collections.daily_collections_resolved;
CREATE VIEW collections.daily_collections_resolved AS
  SELECT ranked.facility_code,
         ranked.payment_date,
         ranked.checks_amount,
         ranked.eft_amount,
         ranked.gross_amount,
         ranked.business_entity_id
    FROM ( SELECT dc.facility_code, dc.payment_date, dc.checks_amount, dc.eft_amount,
                  dc.gross_amount, dc.business_entity_id,
                  row_number() OVER (
                    PARTITION BY dc.business_entity_id, dc.facility_code, dc.payment_date
                    ORDER BY dc.gross_amount DESC,
                             CASE WHEN dc.source_tag = 'deposit_sheet' THEN 0 ELSE 1 END,
                             dc.id) AS rn
             FROM collections.daily_collections dc
            WHERE dc.facility_code IS NOT NULL) ranked
   WHERE ranked.rn = 1
  UNION ALL
  SELECT dc.facility_code, dc.payment_date, dc.checks_amount, dc.eft_amount,
         dc.gross_amount, dc.business_entity_id
    FROM collections.daily_collections dc
   WHERE dc.facility_code IS NULL;

-- 3. Restore the 0022-era writer policies (tenant predicate only). -------------
DROP POLICY IF EXISTS cmd_daily_writer_delete ON collections.daily_collections;
CREATE POLICY cmd_daily_writer_delete ON collections.daily_collections
  FOR DELETE TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS cmd_daily_writer_insert ON collections.daily_collections;
CREATE POLICY cmd_daily_writer_insert ON collections.daily_collections
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- 4. Drop 0096's functions, index, constraints and columns. --------------------
DROP FUNCTION IF EXISTS collections.add_manual_deposit(uuid, text, date, text, numeric, uuid);
DROP FUNCTION IF EXISTS collections.remove_manual_deposit(uuid, bigint, uuid);

DROP INDEX IF EXISTS collections.daily_collections_manual_live_idx;

ALTER TABLE collections.daily_collections
  DROP CONSTRAINT IF EXISTS daily_collections_manual_only_lifecycle_ck;
ALTER TABLE collections.daily_collections
  DROP CONSTRAINT IF EXISTS daily_collections_removal_shape_ck;

ALTER TABLE collections.daily_collections DROP COLUMN IF EXISTS created_by;
ALTER TABLE collections.daily_collections DROP COLUMN IF EXISTS removed_at;
ALTER TABLE collections.daily_collections DROP COLUMN IF EXISTS removed_by;

-- Restore the three-value CHECK. Safe only because §1 removed every 'manual' row.
ALTER TABLE collections.daily_collections
  DROP CONSTRAINT IF EXISTS daily_collections_source_tag_ck;
ALTER TABLE collections.daily_collections
  ADD CONSTRAINT daily_collections_source_tag_ck
  CHECK (source_tag IN ('workbook', 'deposit_sheet', 'cmd'));

-- 5. Reinstate the view grants the DROP in §2 destroyed. -----------------------
REVOKE ALL ON collections.daily_collections_resolved
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON collections.daily_collections_resolved TO claims_reader;
GRANT SELECT ON collections.daily_collections_resolved TO claims_admin;

-- 6. Verification (run manually after rollback) --------------------------------
-- SELECT count(*) FROM collections.daily_collections WHERE source_tag='manual'; -- expect 0
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='collections' AND table_name='daily_collections_resolved';  -- expect 6
-- SELECT has_table_privilege('claims_reader','collections.daily_collections_resolved','SELECT');
--   -- expect true; if false the app's every collections read is dead
-- =============================================================================
