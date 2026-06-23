-- Migration 008: Brain 2 payer-drift materialized view (staging.mv_payer_drift)
-- DB: dbpabchpvipipkzkogta
-- Safe to re-run (DROP MATERIALIZED VIEW IF EXISTS + CREATE).
--
-- =============================================================================
-- RECONSTRUCTION NOTICE
-- =============================================================================
-- The original brain-2 drift MV + brain2_drift_query.sql were authored in a
-- prior session whose ephemeral container was reclaimed before the work was
-- pushed (commits 974930b / f33b748 never reached origin; this clone is at
-- cdbd027). This file is REBUILT from the design description in CLAUDE.md §17,
-- grounded in the committed schema (001/005/006), NOT recovered from the lost
-- source. Treat the thresholds + window math below as a defensible first cut to
-- review against intent, not a byte-for-byte restoration.
--
-- NUMBERING: §17 calls this "007_brain2_drift_mv.sql". In THIS repo 007 is
-- already 007_claim_line_nullcredit_idempotency.sql, so the drift MV lands at
-- 008. There is no superseded 008/009 payer_drift approach in this clone to
-- collide with (that, too, lived only in the lost container).
--
-- =============================================================================
-- DESIGN (per §17 "Brain 2 (drift)")
-- =============================================================================
-- Grain: one row per (business_entity_id, canonical primary payer, CARC code).
-- Signal: per-payer / per-code adjudication-rate drift, comparing a 120-day
--   BASELINE window against a 60-day RECENT window, keyed on primary_payment_date
--   (the adjudication date, NOT date of service).
-- Anchor: windows are measured back from each tenant's OWN max(primary_payment_date)
--   ("data as-of"), NOT CURRENT_DATE. The batch dump is historical; anchoring on
--   wall-clock would empty the recent window and manufacture false DECREASING/lag
--   signals. This anchoring is a GENERAL guard against wall-clock-induced false
--   signals — NOT a CO-45 verdict. On full data CO-45 shows real INCREASING drift
--   across Anthem/BCBS/United; the earlier "structural/artifact" conclusion was
--   drawn on a partial ingest and is retracted.
-- Anchor GUARD (2026-06-23): as_of is bounded to <= CURRENT_DATE, and scoped charges
--   to <= as_of_date. Without it, a handful of future-dated primary_payment_date rows
--   (observed: 2 rows dated 2033-11-27) anchor the windows ~7yr in the future and the
--   MV materializes 0 rows. The 2 source rows are a separate data-quality fix.
-- Statuses (the 5 documented in §17): NEW_PAYER, NEW_CODE, INCREASING,
--   DECREASING, LIKELY_LAG_ARTIFACT. Non-drifting (payer,code) pairs are STABLE
--   and are NOT materialized. The alert layer (brain2_drift_query.sql) further
--   filters WHERE drift_status <> 'NEW_PAYER'.
--
-- =============================================================================
-- MULTI-TENANCY (resolves the §17 "MUST parameterize before a 2nd tenant" smell)
-- =============================================================================
-- The lost version reportedly HARD-CODED the BXR tenant UUID because a matview
-- refresh has no session GUC (current_setting('app.business_entity_id') is unset
-- at REFRESH time). This rebuild removes the hardcode entirely: the MV GROUPs BY
-- business_entity_id and computes drift for EVERY tenant present. Single-tenant
-- today, multi-tenant-ready with no code change.
--   CAVEAT: a materialized view cannot carry RLS policies, so the SELECT grant to
--   claims_reader below exposes ALL tenants' rows in the MV. That is moot at one
--   tenant. BEFORE onboarding tenant #2, gate reads behind a security_barrier
--   view that filters business_entity_id = current_setting('app.business_entity_id')
--   (or revoke claims_reader and read only via brain2_drift_query.sql, which is a
--   plain query and DOES see the GUC). Do not grant broad MV access in prod multi-tenant.
--
-- Roles: owner claims_admin (writer); claims_reader granted SELECT, mirroring the
-- other staging objects. Deploy DDL as a role that owns staging.
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS staging.mv_payer_drift;

CREATE MATERIALIZED VIEW staging.mv_payer_drift AS
WITH params AS (
  -- Tunable knobs. Documented as a reconstruction first cut — adjust to intent.
  SELECT
    60     AS recent_days,            -- recent window length
    120    AS baseline_days,          -- baseline window length (immediately precedes recent)
    30     AS min_baseline_charges,   -- payer needs >= this many baseline charges to be assessable
    5      AS min_code_charges,       -- a code needs >= this many charges on the active side to flag
    0.05   AS min_rate_delta,         -- +/- 5 percentage-point move = material drift
    0.50   AS lag_volume_ratio        -- recent daily volume < 50% of baseline daily volume => lag-suspect
),
asof AS (
  -- Per-tenant data-recency anchor. Different tenants/dumps have different
  -- recency; each gets its own window origin.
  SELECT business_entity_id, max(primary_payment_date) AS as_of_date
  FROM staging.claim_line
  WHERE primary_payment_date IS NOT NULL
    AND primary_payment_date <= CURRENT_DATE   -- guard: future-dated outliers must not anchor the windows
  GROUP BY business_entity_id
),
scoped AS (
  -- Adjudicated charges tagged into baseline / recent, per tenant.
  SELECT
    cl.business_entity_id,
    cl.id AS claim_line_id,
    COALESCE(cl.canonical_primary_payer_name, '(UNMAPPED)') AS payer_name,
    cl.canonical_primary_payer_family                        AS payer_family,
    CASE
      WHEN cl.primary_payment_date >  a.as_of_date - p.recent_days
        THEN 'recent'
      WHEN cl.primary_payment_date <= a.as_of_date - p.recent_days
        THEN 'baseline'
    END AS win
  FROM staging.claim_line cl
  JOIN asof a USING (business_entity_id)
  CROSS JOIN params p
  WHERE cl.primary_payment_date IS NOT NULL
    AND cl.primary_payment_date <= a.as_of_date
    AND cl.primary_payment_date > a.as_of_date - (p.recent_days + p.baseline_days)
),
payer_totals AS (
  -- Denominator: distinct adjudicated charges per payer per window.
  SELECT business_entity_id, payer_name, payer_family, win,
         count(DISTINCT claim_line_id) AS total_charges
  FROM scoped
  GROUP BY business_entity_id, payer_name, payer_family, win
),
code_counts AS (
  -- Numerator: distinct charges carrying each CARC code, + signed $ (reversals
  -- preserved). era_adjustment is credit-level grain (006); collapse to charge
  -- via COUNT(DISTINCT claim_line_id).
  SELECT s.business_entity_id, s.payer_name, s.payer_family, s.win,
         ea.carc_code, ea.carc_type,
         count(DISTINCT s.claim_line_id) AS code_charges,
         sum(ea.adjustment_amount)       AS code_adj_amount
  FROM scoped s
  JOIN staging.era_adjustment ea
    ON ea.claim_line_id     = s.claim_line_id
   AND ea.business_entity_id = s.business_entity_id
  GROUP BY s.business_entity_id, s.payer_name, s.payer_family, s.win,
           ea.carc_code, ea.carc_type
),
pt AS (  -- pivot payer denominators to baseline/recent columns
  SELECT business_entity_id, payer_name, payer_family,
    COALESCE(max(total_charges) FILTER (WHERE win = 'baseline'), 0) AS base_total,
    COALESCE(max(total_charges) FILTER (WHERE win = 'recent'),   0) AS rec_total
  FROM payer_totals
  GROUP BY business_entity_id, payer_name, payer_family
),
cc AS (  -- pivot code numerators to baseline/recent columns
  SELECT business_entity_id, payer_name, payer_family, carc_code, carc_type,
    COALESCE(max(code_charges)    FILTER (WHERE win = 'baseline'), 0) AS base_code_charges,
    COALESCE(max(code_charges)    FILTER (WHERE win = 'recent'),   0) AS rec_code_charges,
    COALESCE(sum(code_adj_amount) FILTER (WHERE win = 'baseline'), 0) AS base_adj_amount,
    COALESCE(sum(code_adj_amount) FILTER (WHERE win = 'recent'),   0) AS rec_adj_amount
  FROM code_counts
  GROUP BY business_entity_id, payer_name, payer_family, carc_code, carc_type
),
classified AS (
  SELECT
    cc.business_entity_id,
    cc.payer_name,
    cc.payer_family,
    cc.carc_code,
    cc.carc_type,
    pt.base_total            AS baseline_total_charges,
    pt.rec_total             AS recent_total_charges,
    cc.base_code_charges     AS baseline_code_charges,
    cc.rec_code_charges      AS recent_code_charges,
    cc.base_adj_amount       AS baseline_adj_amount,
    cc.rec_adj_amount        AS recent_adj_amount,
    CASE WHEN pt.base_total > 0 THEN cc.base_code_charges::numeric / pt.base_total END AS baseline_rate,
    CASE WHEN pt.rec_total  > 0 THEN cc.rec_code_charges::numeric  / pt.rec_total  END AS recent_rate,
    (COALESCE(CASE WHEN pt.rec_total  > 0 THEN cc.rec_code_charges::numeric  / pt.rec_total  END, 0)
   - COALESCE(CASE WHEN pt.base_total > 0 THEN cc.base_code_charges::numeric / pt.base_total END, 0)) AS rate_delta,
    -- recent window under-populated vs baseline daily rate => changes are lag-suspect
    (pt.base_total > 0
       AND (pt.rec_total::numeric / p.recent_days)
           < p.lag_volume_ratio * (pt.base_total::numeric / p.baseline_days)) AS recent_underpopulated,
    p.min_baseline_charges, p.min_code_charges, p.min_rate_delta
  FROM cc
  JOIN pt USING (business_entity_id, payer_name, payer_family)
  CROSS JOIN params p
),
scored AS (
  SELECT c.*,
    CASE
      WHEN baseline_total_charges < min_baseline_charges
        THEN 'NEW_PAYER'
      WHEN baseline_code_charges = 0 AND recent_code_charges >= min_code_charges
        THEN 'NEW_CODE'
      WHEN recent_underpopulated AND rate_delta <= -min_rate_delta
        THEN 'LIKELY_LAG_ARTIFACT'
      WHEN rate_delta >= min_rate_delta AND recent_code_charges >= min_code_charges
        THEN 'INCREASING'
      WHEN NOT recent_underpopulated AND rate_delta <= -min_rate_delta
           AND baseline_code_charges >= min_code_charges
        THEN 'DECREASING'
      ELSE 'STABLE'
    END AS drift_status
  FROM classified c
)
SELECT
  business_entity_id,
  payer_name,
  payer_family,
  carc_code,
  carc_type,
  baseline_total_charges,
  recent_total_charges,
  baseline_code_charges,
  recent_code_charges,
  round(baseline_rate, 4) AS baseline_rate,
  round(recent_rate,   4) AS recent_rate,
  round(rate_delta,    4) AS rate_delta,
  baseline_adj_amount,
  recent_adj_amount,
  drift_status,
  now() AS computed_at
FROM scored
WHERE drift_status <> 'STABLE';   -- materialize drift rows only (NEW_PAYER kept; alert layer drops it)

-- REFRESH CONCURRENTLY requires a UNIQUE index over the full grain.
-- payer_name is COALESCE'd to '(UNMAPPED)' and carc_code/type are NOT NULL in
-- era_adjustment, so the key has no NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_payer_drift
  ON staging.mv_payer_drift (business_entity_id, payer_name, carc_code, carc_type);

-- Read-path indexes for the alert layer.
CREATE INDEX IF NOT EXISTS idx_mv_payer_drift_status
  ON staging.mv_payer_drift (business_entity_id, drift_status);
CREATE INDEX IF NOT EXISTS idx_mv_payer_drift_code
  ON staging.mv_payer_drift (business_entity_id, carc_code);

ALTER MATERIALIZED VIEW staging.mv_payer_drift OWNER TO claims_admin;
GRANT SELECT ON staging.mv_payer_drift TO claims_reader;  -- see MULTI-TENANCY caveat

COMMENT ON MATERIALIZED VIEW staging.mv_payer_drift IS
  'Brain 2 payer/CARC adjudication-rate drift. Baseline(120d) vs recent(60d) on primary_payment_date, anchored per-tenant on max(primary_payment_date). Refresh CONCURRENTLY after each ingest. Statuses: NEW_PAYER/NEW_CODE/INCREASING/DECREASING/LIKELY_LAG_ARTIFACT (STABLE not materialized). Read via brain2_drift_query.sql. Reconstructed from CLAUDE.md §17 (original source lost with prior container).';

-- =============================================================================
-- DEPLOY / REFRESH (run manually — no auto-deploy from this file)
-- =============================================================================
-- 1. First populate is immediate (CREATE ... default WITH DATA).
-- 2. Subsequent refreshes after each batch ingest:
--      REFRESH MATERIALIZED VIEW CONCURRENTLY staging.mv_payer_drift;
-- 3. Sanity after deploy (expect rows only for the BXR tenant today):
--      SELECT drift_status, count(*) FROM staging.mv_payer_drift GROUP BY 1 ORDER BY 2 DESC;
