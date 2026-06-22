-- =============================================================================
-- RECONCILIATION QUERY — Artifact #2 (gap miner)
-- Gate-review before running against production data.
--
-- Handles two source types in staging.claim_line:
--   CMD_BATCH     — has charge_balance_due_ins, CARC codes in era_adjustment
--   INDIGO_CLAIMS — has allowed_amount, no CARC codes
--
-- Produces three residual_type classes:
--   ALLOWED_GAP           — allowed_amount > paid (Indigo source) ← $3.94M signal
--   BALANCE_DUE_INSURANCE — charge_balance_due_ins > 0 (CMD_BATCH source) ← $93K
--   MATH_GAP              — billed ≠ sum of all buckets (data integrity)
--   CLEAN                 — everything closes correctly
--
-- Run after each ingest cycle. Safe to re-run (UPSERT on charge_debit_id).
-- =============================================================================

-- Set tenant + facility context (BOTH required before running):
--   SET LOCAL "app.business_entity_id"       = '<entity-uuid>';
--   SET LOCAL "app.cmd_facility_allowlist"   = '<id1>,<id2>,...';  -- env CMD_FACILITY_ALLOWLIST; comma-joined CMD_BATCH facilities
-- Parameterized (recommended — runner injects bound params):
--   SELECT set_config('app.business_entity_id',     $1, true);
--   SELECT set_config('app.cmd_facility_allowlist', $2, true);
-- Facility scope is applied as: claim_facility_id = ANY(string_to_array(GUC, ','))
-- (replaces the former single CMD_CA_MH_FACILITY_ID GUC — now multi-facility).

-- Step 1: dominant CARC per charge (CMD_BATCH rows only — Indigo has no CARC)
WITH dominant_carc AS (
  SELECT DISTINCT ON (ea.charge_debit_id)
    ea.charge_debit_id,
    ea.carc_code              AS dominant_carc,
    ea.category               AS dominant_carc_category,
    ea.adjustment_amount      AS dominant_amount
  FROM staging.era_adjustment ea
  -- era_adjustment carries no claim_facility_id; inherit facility scope from claim_line.
  -- (era_adjustment is CMD_BATCH-only by nature — Indigo has no CARC data.)
  -- Join on the unique FK claim_line_id, NOT charge_debit_id, to avoid fan-out.
  JOIN staging.claim_line cl ON cl.id = ea.claim_line_id
  WHERE ea.business_entity_id = current_setting('app.business_entity_id')::uuid
    AND cl.claim_facility_id = ANY(string_to_array(current_setting('app.cmd_facility_allowlist'), ','))
  ORDER BY ea.charge_debit_id, ea.adjustment_amount DESC
),

-- Step 2: compute residual per adjudicated charge (both source types)
reconciled AS (
  SELECT DISTINCT ON (cl.charge_debit_id)
    cl.id                                           AS claim_line_id,
    cl.charge_debit_id,
    cl.business_entity_id,
    cl.source_type,

    -- Money buckets
    COALESCE(cl.charge_amount,          0)          AS billed,
    COALESCE(cl.charge_primary_paid,    0)          AS primary_paid,
    COALESCE(cl.charge_secondary_paid,  0)          AS secondary_paid,
    COALESCE(cl.charge_insurance_adj,   0)          AS insurance_adjustments,
    COALESCE(cl.charge_patient_adj,     0)          AS patient_adjustments,
    COALESCE(cl.charge_balance_due_pat, 0)          AS patient_balance,
    COALESCE(cl.charge_balance_due_ins, 0)          AS balance_due_insurance,
    cl.allowed_amount,

    -- Allowed gap (Indigo source): allowed - paid
    CASE
      WHEN cl.allowed_amount IS NOT NULL
        AND cl.allowed_amount > COALESCE(cl.charge_primary_paid, 0)
                              + COALESCE(cl.charge_secondary_paid, 0) + 0.01
      THEN cl.allowed_amount
           - COALESCE(cl.charge_primary_paid,  0)
           - COALESCE(cl.charge_secondary_paid, 0)
      ELSE 0
    END                                             AS allowed_gap,

    -- CMD_BATCH residual
    COALESCE(cl.charge_amount,          0)
    - COALESCE(cl.charge_primary_paid,  0)
    - COALESCE(cl.charge_secondary_paid,0)
    - COALESCE(cl.charge_insurance_adj, 0)
    - COALESCE(cl.charge_patient_adj,   0)
    - COALESCE(cl.charge_balance_due_pat,0)
    - COALESCE(cl.charge_balance_due_ins,0)         AS residual,

    dc.dominant_carc,
    dc.dominant_carc_category,
    cl.claim_status,
    cl.cpt_code,
    cl.rev_code,
    cl.charge_from_date

  FROM staging.claim_line cl
  LEFT JOIN dominant_carc dc ON dc.charge_debit_id = cl.charge_debit_id
  WHERE cl.business_entity_id = current_setting('app.business_entity_id')::uuid
    -- Facility scope: CMD_BATCH restricted to in-scope facility (CA-MH);
    -- Indigo rows have NULL claim_facility_id and are left untouched.
    AND (
      cl.source_type != 'CMD_BATCH'
      OR cl.claim_facility_id = ANY(string_to_array(current_setting('app.cmd_facility_allowlist'), ','))
    )
    -- CMD_BATCH: exclude in-flight and voided
    AND (
      cl.source_type != 'CMD_BATCH'
      OR (
        cl.claim_status NOT LIKE 'CLAIM AT%'
        AND cl.claim_status NOT IN ('ON HOLD', '')
        AND COALESCE(cl.tob_frequency, 1) NOT IN (2, 8)
      )
    )
    -- Indigo: exclude zero-value rows and explicit reversals
    -- TODO: retires when 004_indigo_etl_ingest.ts is removed
    -- (no rows will carry source_type='INDIGO_CLAIMS' after native
    --  Indigo re-pull lands as CMD_BATCH)
    AND (
      cl.source_type != 'INDIGO_CLAIMS'
      OR COALESCE(cl.charge_primary_paid, 0) >= 0
    )
  -- Grain collapse: claim_line is keyed (charge_debit_id, credit_id), so a
  -- charge with multiple credit rows emits multiple rows here. Without this,
  -- INSERT ... ON CONFLICT (business_entity_id, charge_debit_id) tries to
  -- affect the same conflict row twice in one statement → SQLSTATE 21000.
  -- DISTINCT ON keeps one row per charge; the money columns (charge_amount,
  -- charge_primary_paid, allowed_amount, charge_balance_due_pat) are
  -- charge-level constants, so collapsing is correct — do NOT SUM them.
  -- Tiebreak: lowest credit_id, NULLS LAST so charges with no credit row are
  -- still kept (current_payer_priority dropped — 95.83% NULL, non-deterministic).
  ORDER BY cl.charge_debit_id, cl.credit_id NULLS LAST
)

-- Step 3: classify and upsert into payment_residual
INSERT INTO staging.payment_residual (
  business_entity_id,
  claim_line_id,
  charge_debit_id,
  billed,
  primary_paid,
  secondary_paid,
  insurance_adjustments,
  patient_adjustments,
  patient_balance,
  balance_due_insurance,
  allowed_amount,
  residual_type,
  dominant_carc,
  dominant_carc_category,
  requires_review,
  ingested_by
)
SELECT
  business_entity_id,
  claim_line_id,
  charge_debit_id,
  billed,
  primary_paid,
  secondary_paid,
  insurance_adjustments,
  patient_adjustments,
  patient_balance,
  balance_due_insurance,
  allowed_amount,

  CASE
    -- Indigo: allowed > paid is the primary signal
    -- NOTE: silently stops firing when allowed_amount IS NULL
    -- (expected — awaiting Brain 2 / 835 integration decision)
    WHEN allowed_gap > 0.01
      THEN 'ALLOWED_GAP'
    -- CMD_BATCH: outstanding insurance balance
    -- Effectively CMD_BATCH-only — Indigo rows carry no balance_due_insurance.
    -- TODO: this CMD/Indigo split collapses when 004_indigo_etl_ingest.ts is
    -- removed and Indigo is re-pulled as CMD_BATCH (same retirement as above).
    WHEN balance_due_insurance > 0
      THEN 'BALANCE_DUE_INSURANCE'
    -- Either source: unexplained math
    WHEN ABS(residual) > 0.01
      THEN 'MATH_GAP'
    ELSE 'CLEAN'
  END                                     AS residual_type,

  dominant_carc,
  dominant_carc_category,

  CASE
    WHEN allowed_gap > 0.01
      AND cpt_code IN ('H0018','H0017','H0006','T2048') THEN true  -- high-value BH codes
    WHEN balance_due_insurance > 0
      AND dominant_carc_category IN ('DENIAL_OR_MISS','NEEDS_INFO','OTHER_REVIEW') THEN true
    WHEN ABS(residual) > 0.01 THEN true
    ELSE false
  END                                     AS requires_review,

  'reconciliation_query'                  AS ingested_by

FROM reconciled

ON CONFLICT (business_entity_id, charge_debit_id) DO UPDATE SET
  billed                  = EXCLUDED.billed,
  allowed_amount          = EXCLUDED.allowed_amount,
  balance_due_insurance   = EXCLUDED.balance_due_insurance,
  residual_type           = EXCLUDED.residual_type,
  dominant_carc           = EXCLUDED.dominant_carc,
  dominant_carc_category  = EXCLUDED.dominant_carc_category,
  requires_review         = EXCLUDED.requires_review,
  calculated_at           = now();


-- =============================================================================
-- SUMMARY — run after the upsert
-- =============================================================================
SELECT
  residual_type,
  COUNT(*)                              AS charges,
  SUM(billed)                           AS total_billed,
  SUM(COALESCE(allowed_gap, 0))         AS total_allowed_gap,
  SUM(balance_due_insurance)            AS total_bal_due_ins,
  SUM(CASE WHEN requires_review THEN 1 ELSE 0 END) AS review_queue
FROM staging.payment_residual pr
JOIN staging.claim_line cl ON cl.id = pr.claim_line_id
WHERE pr.business_entity_id = current_setting('app.business_entity_id')::uuid
  -- Source-aware facility scope: CMD_BATCH rows restricted to CA-MH; Indigo untouched.
  AND (
    cl.source_type != 'CMD_BATCH'
    OR cl.claim_facility_id = ANY(string_to_array(current_setting('app.cmd_facility_allowlist'), ','))
  )
GROUP BY residual_type
ORDER BY total_allowed_gap + total_bal_due_ins DESC;


-- =============================================================================
-- DRILL-DOWN: ALLOWED_GAP by CPT code (Indigo source — your $3.94M signal)
-- =============================================================================
SELECT
  cl.cpt_code,
  cl.rev_code,
  COUNT(*)                              AS episodes,
  SUM(pr.allowed_amount)                AS total_allowed,
  SUM(pr.primary_paid)                  AS total_paid,
  SUM(pr.allowed_amount - pr.primary_paid) AS total_gap,
  AVG(pr.allowed_amount - pr.primary_paid) AS avg_gap_per_episode,
  MIN(cl.charge_from_date)              AS earliest_dos,
  MAX(cl.charge_from_date)              AS latest_dos
FROM staging.payment_residual pr
JOIN staging.claim_line cl ON cl.id = pr.claim_line_id
WHERE pr.business_entity_id = current_setting('app.business_entity_id')::uuid
  AND pr.residual_type = 'ALLOWED_GAP'
  AND cl.source_type = 'INDIGO_CLAIMS'
GROUP BY cl.cpt_code, cl.rev_code
ORDER BY total_gap DESC;


-- =============================================================================
-- DRILL-DOWN: BALANCE_DUE_INSURANCE by payer + CARC (CMD_BATCH source)
-- =============================================================================
SELECT
  pd.payer_name,
  pd.clearinghouse_payer_id,
  pr.dominant_carc,
  pr.dominant_carc_category,
  rc.description                        AS carc_description,
  COUNT(*)                              AS charges,
  SUM(pr.balance_due_insurance)         AS total_outstanding,
  MIN(cl.charge_from_date)              AS earliest_dos,
  MAX(cl.charge_from_date)              AS latest_dos
FROM staging.payment_residual pr
JOIN staging.claim_line cl ON cl.id = pr.claim_line_id
LEFT JOIN staging.payer_dim pd ON pd.id = cl.payer_dim_id
LEFT JOIN ref.remittance_code rc ON rc.code = pr.dominant_carc
WHERE pr.business_entity_id = current_setting('app.business_entity_id')::uuid
  AND pr.residual_type = 'BALANCE_DUE_INSURANCE'
  -- Source-aware facility scope: CMD_BATCH rows restricted to CA-MH; Indigo untouched.
  AND (
    cl.source_type != 'CMD_BATCH'
    OR cl.claim_facility_id = ANY(string_to_array(current_setting('app.cmd_facility_allowlist'), ','))
  )
GROUP BY
  pd.payer_name, pd.clearinghouse_payer_id,
  pr.dominant_carc, pr.dominant_carc_category, rc.description
ORDER BY total_outstanding DESC;
