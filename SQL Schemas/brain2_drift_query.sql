-- brain2_drift_query.sql — canonical Brain 2 drift alert read
-- DB: dbpabchpvipipkzkogta
--
-- RECONSTRUCTION NOTICE: rebuilt from CLAUDE.md §17, not recovered from the lost
-- prior-container source. Reads staging.mv_payer_drift (see 008_brain2_drift_mv.sql).
--
-- This is the ALERT LAYER. Per §17 it filters out NEW_PAYER (a brand-new / thin
-- payer has no baseline, so "drift" is undefined — not actionable as an alert).
-- The remaining statuses are the actionable set:
--   NEW_CODE             — a CARC the payer did not emit in baseline now appears
--   INCREASING           — code rate up >= min_rate_delta on a real recent sample
--   DECREASING           — code rate down >= min_rate_delta on a real baseline sample
--   LIKELY_LAG_ARTIFACT  — recent window under-populated; surfaced but de-prioritized
--                          (a general under-population guard, NOT a CO-45 verdict.
--                          On full data CO-45 shows real INCREASING drift across
--                          Anthem/BCBS/United; the earlier "structural/artifact"
--                          conclusion was drawn on a partial ingest and is retracted)
--
-- TENANCY: the MV spans all tenants (no hardcoded UUID). This query scopes to the
-- caller's tenant via the app.business_entity_id GUC, set transaction-locally per
-- the project convention. Run inside a transaction so SET LOCAL applies.

BEGIN;

-- Single-tenant today: BXR Consulting LLC. Replace when scoping another tenant,
-- or have the app set this from the session before running.
SELECT set_config('app.business_entity_id', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', true);

SELECT
  d.payer_name,
  d.payer_family,
  d.carc_code,
  d.carc_type,
  rc.description                AS carc_description,
  rc.category                   AS carc_category,
  d.drift_status,
  d.baseline_code_charges,
  d.recent_code_charges,
  d.baseline_rate,
  d.recent_rate,
  d.rate_delta,
  d.baseline_adj_amount,
  d.recent_adj_amount,
  (d.recent_adj_amount - d.baseline_adj_amount) AS adj_amount_delta
FROM staging.mv_payer_drift d
LEFT JOIN ref.remittance_code rc
  ON rc.code = d.carc_code AND rc.code_type = d.carc_type
WHERE d.business_entity_id = current_setting('app.business_entity_id')::uuid
  AND d.drift_status <> 'NEW_PAYER'          -- §17 alert filter
ORDER BY
  -- lag artifacts last; then biggest dollar / rate moves first
  (d.drift_status = 'LIKELY_LAG_ARTIFACT'),
  abs(d.recent_adj_amount - d.baseline_adj_amount) DESC,
  abs(d.rate_delta) DESC;

COMMIT;
