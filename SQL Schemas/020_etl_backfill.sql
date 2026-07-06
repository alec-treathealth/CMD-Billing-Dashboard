-- Migration 020 (VERIS sequence, SQL Schemas/): etl_backfill
-- Master-plan alias: "0012_etl_backfill" (S1 notes: the plan's 0012 takes the
-- next free Veris number; 012 is live and taken, §18 said next = 020).
-- DB: dbpabchpvipipkzkogta. Apply via apply_migration (postgres, SET-capable
-- claims_admin membership — the standing apply-path model, veris-data-notes S2).
-- Rollback: 020_etl_backfill_rollback.sql (audit-table driven — see below).
--
-- =============================================================================
-- WHAT THIS IS
-- =============================================================================
-- Additive, idempotent seed/reconciliation of staging.brain1_features from the
-- S1-ratified labeled population:
--
--   staging.claim_line cl JOIN staging.payment_residual pr
--     ON pr.claim_line_id = cl.id            -- verified 57,486/57,486, 0 orphans
--    AND pr.business_entity_id = cl.business_entity_id
--
-- RATIFIED CONTRACT (Alec, 2026-07-06 — recorded in veris-data-notes S3):
-- staging.brain1_features is the FULL FEATURE SURFACE, not the labeled-training
-- subset. Un-adjudicated rows (outcome='PENDING', residual_type NULL,
-- label_is_terminal=false) are valid state awaiting a residual-derived label.
-- This migration is therefore UPSERT-ONLY:
--   - no DELETE / TRUNCATE anywhere in this file or its rollback's happy path;
--   - PENDING rows are never touched (they are not in the INNER JOIN source);
--   - the upsert can never write outcome='PENDING' (the CASE below maps only
--     the four terminal residual types) — labeling is structurally monotonic;
--   - post-adjudication (label-side) values can never land on a PENDING row.
--
-- LABEL SEMANTICS — reconstructed EMPIRICALLY against live state (2026-07-06),
-- 0 mismatches on all 57,486 labeled rows for every expression below (the
-- original build SQL was lost with a prior container; built_at shows one build,
-- 2026-06-22):
--   outcome:            CLEAN→PAID · ALLOWED_GAP→PARTIAL · MATH_GAP→PARTIAL ·
--                       BALANCE_DUE_INSURANCE→DENIED  (label_is_terminal=true)
--   days_to_pay:        payment_received_date - charge_from_date, NULL when
--                       negative (105 such rows live; CHECK days_to_pay>=0).
--                       NOTE: payment_received_date, NOT primary_payment_date —
--                       the master plan's assumption is superseded by evidence.
--   was_underpayment:   residual_type IN ('ALLOWED_GAP','BALANCE_DUE_INSURANCE')
--   net_underpayment_amt: ALLOWED_GAP→pr.allowed_gap ·
--                       BALANCE_DUE_INSURANCE→pr.balance_due_insurance · else 0
--   allowed_amount:     pr.allowed_amount
-- Feature columns copy 1:1 from claim_line (all verified 0-mismatch), except:
--   payer_type ← cl.current_payer_type;
--   network_status / participates_in_era ← staging.payer_dim via cl.payer_dim_id;
--   diagnosis_pointer_count ← cardinality(string_to_array(diagnosis_pointer_list));
--   dos ← charge_from_date (+ EXTRACT year/month/dow);
--   billed_amount ← charge_amount.
--
-- ON CONFLICT target: the EXISTING unique key (business_entity_id,
-- charge_debit_id) — §17's documented grain (Option A ruling, Alec 2026-07-06).
-- No new constraint is created here. On conflict, ONLY label-side columns
-- (+ claim_line_id anchor + built_*) update, and only when actually different
-- (IS DISTINCT FROM guard) — re-runs are true no-ops. Feature columns on
-- existing rows are never rewritten.
--
-- TENANCY: no hardcoded tenant UUID — the source join carries
-- business_entity_id for every tenant present (Indigo contributes 0 rows
-- today). apply_migration has no session GUC; writes run as claims_admin
-- (owner, RLS-bypass by ownership) via SET ROLE — the standing ingest posture.
--
-- PHI: structurally enforced — the INSERT column list simply never includes a
-- PHI column, and a guard below RAISEs if brain1_features ever grows one.
-- claim_line's PHI columns (*_enc bytea) are never referenced.
--
-- EXPECTED EFFECT TODAY (verified pre-apply): 0 inserts, 0 updates — live
-- state already matches the ratified mapping exactly. The value of this
-- artifact is the canonical, committed, idempotent reconciliation path the
-- future ingest cron re-runs after each batch.
--
-- ROLLBACK HONESTY: staging.etl_backfill_020_undo captures, at apply time, the
-- prior label state of every row this migration UPDATEs and the key of every
-- row it INSERTs. The rollback restores exactly that pre-apply state (deletes
-- 020's inserts — never a pre-existing PENDING row — and restores prior labels
-- on 020's updates). It does NOT cover later loader runs (forward-only
-- reconciliation; their changes are not audited here) — that limit is stated
-- rather than papered over.
-- =============================================================================

SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- Guard 1: the Option-A upsert target must exist exactly as ruled.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'staging.brain1_features'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (business_entity_id, charge_debit_id)'
  ) THEN
    RAISE EXCEPTION '020 aborted: unique (business_entity_id, charge_debit_id) missing on staging.brain1_features — the Option-A ON CONFLICT target';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Guard 2: PHI denylist is structural — brain1_features must carry no PHI
-- column, ever. (patient_last/patient_first/member_id/dob are the absolute
-- four; the wider list catches the known PHI-bearing names.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE offender text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO offender
  FROM information_schema.columns
  WHERE table_schema = 'staging' AND table_name = 'brain1_features'
    AND (column_name IN ('patient_last','patient_first','member_id','dob',
                         'patient_name','patient_id','group_number')
         OR column_name LIKE '%\_enc');
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION '020 aborted: PHI column(s) present on staging.brain1_features: %', offender;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Undo audit table (rollback target). Tenant-scoped like every staging table:
-- FK to core.business_entity (016 discipline), RLS USING + WITH CHECK on the
-- GUC (017 discipline). claims_admin owner only — no reader grant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging.etl_backfill_020_undo (
  business_entity_id       uuid NOT NULL
    REFERENCES core.business_entity(id) ON DELETE RESTRICT,
  charge_debit_id          text NOT NULL,
  action                   text NOT NULL CHECK (action IN ('INSERT','UPDATE')),
  prior_claim_line_id      bigint,
  prior_outcome            text,
  prior_days_to_pay        integer,
  prior_was_underpayment   boolean,
  prior_net_underpayment_amt numeric(12,2),
  prior_allowed_amount     numeric(12,2),
  prior_residual_type      text,
  prior_label_is_terminal  boolean,
  prior_built_at           timestamptz,
  prior_built_by           text,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_entity_id, charge_debit_id)
);

ALTER TABLE staging.etl_backfill_020_undo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS etl_backfill_020_undo_tenant ON staging.etl_backfill_020_undo;
CREATE POLICY etl_backfill_020_undo_tenant ON staging.etl_backfill_020_undo
  FOR ALL
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid)
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- ---------------------------------------------------------------------------
-- Materialize the source mapping ONCE (temp table dies with the apply session).
-- Column expressions are the empirically verified mapping — see header.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE etl020_src AS
SELECT
  cl.business_entity_id,
  cl.charge_debit_id,
  cl.id                                   AS claim_line_id,
  cl.claim_facility_id,
  CASE pr.residual_type
    WHEN 'CLEAN'                 THEN 'PAID'
    WHEN 'ALLOWED_GAP'           THEN 'PARTIAL'
    WHEN 'MATH_GAP'              THEN 'PARTIAL'
    WHEN 'BALANCE_DUE_INSURANCE' THEN 'DENIED'
  END                                     AS outcome,
  CASE WHEN cl.payment_received_date >= cl.charge_from_date
       THEN cl.payment_received_date - cl.charge_from_date
  END                                     AS days_to_pay,
  pr.residual_type IN ('ALLOWED_GAP','BALANCE_DUE_INSURANCE')
                                          AS was_underpayment,
  CASE pr.residual_type
    WHEN 'ALLOWED_GAP'           THEN pr.allowed_gap
    WHEN 'BALANCE_DUE_INSURANCE' THEN pr.balance_due_insurance
    ELSE 0
  END                                     AS net_underpayment_amt,
  pr.allowed_amount,
  pr.residual_type,
  true                                    AS label_is_terminal,
  cl.canonical_primary_payer_name,
  cl.canonical_primary_payer_family,
  cl.current_payer_type                   AS payer_type,
  pd.network_status,
  pd.participates_in_era,
  cl.cpt_code,
  cl.rev_code,
  cl.tos_code,
  cl.units,
  CASE WHEN cl.diagnosis_pointer_list IS NULL OR btrim(cl.diagnosis_pointer_list) = ''
       THEN 0
       ELSE cardinality(string_to_array(cl.diagnosis_pointer_list, ','))
  END                                     AS diagnosis_pointer_count,
  cl.tob_facility_type,
  cl.tob_care_setting,
  cl.tob_frequency,
  cl.claim_type,
  cl.claim_frequency,
  cl.charge_amount                        AS billed_amount,
  cl.charge_from_date                     AS dos,
  EXTRACT(year  FROM cl.charge_from_date)::smallint AS dos_year,
  EXTRACT(month FROM cl.charge_from_date)::smallint AS dos_month,
  EXTRACT(dow   FROM cl.charge_from_date)::smallint AS dos_dow,
  cl.insurance_billing_lag,
  cl.claim_rendering_provider,
  cl.charge_rendering_provider,
  cl.is_training_eligible
FROM staging.claim_line cl
JOIN staging.payment_residual pr
  ON pr.claim_line_id = cl.id
 AND pr.business_entity_id = cl.business_entity_id
LEFT JOIN staging.payer_dim pd
  ON pd.id = cl.payer_dim_id
 AND pd.business_entity_id = cl.business_entity_id;

-- ---------------------------------------------------------------------------
-- Undo capture BEFORE the upsert. ON CONFLICT DO NOTHING preserves the
-- EARLIEST prior state across re-runs (rollback = pre-first-apply state).
-- ---------------------------------------------------------------------------
INSERT INTO staging.etl_backfill_020_undo
  (business_entity_id, charge_debit_id, action,
   prior_claim_line_id, prior_outcome, prior_days_to_pay, prior_was_underpayment,
   prior_net_underpayment_amt, prior_allowed_amount, prior_residual_type,
   prior_label_is_terminal, prior_built_at, prior_built_by)
SELECT bf.business_entity_id, bf.charge_debit_id, 'UPDATE',
       bf.claim_line_id, bf.outcome, bf.days_to_pay, bf.was_underpayment,
       bf.net_underpayment_amt, bf.allowed_amount, bf.residual_type,
       bf.label_is_terminal, bf.built_at, bf.built_by
FROM staging.brain1_features bf
JOIN etl020_src s
  ON s.business_entity_id = bf.business_entity_id
 AND s.charge_debit_id    = bf.charge_debit_id
WHERE (bf.outcome, bf.days_to_pay, bf.was_underpayment, bf.net_underpayment_amt,
       bf.allowed_amount, bf.residual_type, bf.label_is_terminal, bf.claim_line_id)
      IS DISTINCT FROM
      (s.outcome, s.days_to_pay, s.was_underpayment, s.net_underpayment_amt,
       s.allowed_amount, s.residual_type, s.label_is_terminal, s.claim_line_id)
ON CONFLICT (business_entity_id, charge_debit_id) DO NOTHING;

INSERT INTO staging.etl_backfill_020_undo (business_entity_id, charge_debit_id, action)
SELECT s.business_entity_id, s.charge_debit_id, 'INSERT'
FROM etl020_src s
LEFT JOIN staging.brain1_features bf
  ON bf.business_entity_id = s.business_entity_id
 AND bf.charge_debit_id    = s.charge_debit_id
WHERE bf.charge_debit_id IS NULL
ON CONFLICT (business_entity_id, charge_debit_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The upsert. Fixed column list (the structural PHI allowlist). On conflict:
-- label-side columns + claim_line_id anchor + built_* only, and only when
-- different. Never writes PENDING; never deletes; never touches feature
-- columns on an existing row.
-- ---------------------------------------------------------------------------
INSERT INTO staging.brain1_features
  (business_entity_id, charge_debit_id, claim_line_id, claim_facility_id,
   outcome, days_to_pay, was_underpayment, net_underpayment_amt, allowed_amount,
   residual_type, label_is_terminal,
   canonical_primary_payer_name, canonical_primary_payer_family, payer_type,
   network_status, participates_in_era,
   cpt_code, rev_code, tos_code, units, diagnosis_pointer_count,
   tob_facility_type, tob_care_setting, tob_frequency, claim_type, claim_frequency,
   billed_amount, dos, dos_year, dos_month, dos_dow, insurance_billing_lag,
   claim_rendering_provider, charge_rendering_provider, is_training_eligible,
   built_at, built_by)
SELECT
  s.business_entity_id, s.charge_debit_id, s.claim_line_id, s.claim_facility_id,
  s.outcome, s.days_to_pay, s.was_underpayment, s.net_underpayment_amt, s.allowed_amount,
  s.residual_type, s.label_is_terminal,
  s.canonical_primary_payer_name, s.canonical_primary_payer_family, s.payer_type,
  s.network_status, s.participates_in_era,
  s.cpt_code, s.rev_code, s.tos_code, s.units, s.diagnosis_pointer_count,
  s.tob_facility_type, s.tob_care_setting, s.tob_frequency, s.claim_type, s.claim_frequency,
  s.billed_amount, s.dos, s.dos_year, s.dos_month, s.dos_dow, s.insurance_billing_lag,
  s.claim_rendering_provider, s.charge_rendering_provider, s.is_training_eligible,
  now(), 'etl_backfill_020'
FROM etl020_src s
ON CONFLICT (business_entity_id, charge_debit_id) DO UPDATE SET
  outcome              = EXCLUDED.outcome,
  days_to_pay          = EXCLUDED.days_to_pay,
  was_underpayment     = EXCLUDED.was_underpayment,
  net_underpayment_amt = EXCLUDED.net_underpayment_amt,
  allowed_amount       = EXCLUDED.allowed_amount,
  residual_type        = EXCLUDED.residual_type,
  label_is_terminal    = EXCLUDED.label_is_terminal,
  claim_line_id        = EXCLUDED.claim_line_id,
  built_at             = EXCLUDED.built_at,
  built_by             = EXCLUDED.built_by
WHERE (brain1_features.outcome, brain1_features.days_to_pay,
       brain1_features.was_underpayment, brain1_features.net_underpayment_amt,
       brain1_features.allowed_amount, brain1_features.residual_type,
       brain1_features.label_is_terminal, brain1_features.claim_line_id)
      IS DISTINCT FROM
      (EXCLUDED.outcome, EXCLUDED.days_to_pay,
       EXCLUDED.was_underpayment, EXCLUDED.net_underpayment_amt,
       EXCLUDED.allowed_amount, EXCLUDED.residual_type,
       EXCLUDED.label_is_terminal, EXCLUDED.claim_line_id);

-- ---------------------------------------------------------------------------
-- Report (counts only — never row data).
-- ---------------------------------------------------------------------------
DO $$
DECLARE n_ins bigint; n_upd bigint; n_src bigint;
BEGIN
  SELECT count(*) INTO n_src FROM etl020_src;
  SELECT count(*) FILTER (WHERE action = 'INSERT'),
         count(*) FILTER (WHERE action = 'UPDATE')
    INTO n_ins, n_upd
  FROM staging.etl_backfill_020_undo;
  RAISE NOTICE 'etl_backfill_020: source rows %, inserted %, label-updated % (cumulative across re-runs)', n_src, n_ins, n_upd;
END $$;

DROP TABLE etl020_src;

RESET ROLE;
