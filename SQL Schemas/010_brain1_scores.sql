-- Migration 010: Brain 1 prediction outputs (staging.brain1_scores)
-- DB: dbpabchpvipipkzkogta | Deployed + verified 2026-06-23.
-- Charge grain (business_entity_id, charge_debit_id) — matches staging.brain1_features.
CREATE TABLE IF NOT EXISTS staging.brain1_scores (
  business_entity_id   uuid NOT NULL,
  charge_debit_id      text NOT NULL CHECK (char_length(charge_debit_id) <= 50),
  scored_at            timestamptz NOT NULL DEFAULT now(),
  model_version        text NOT NULL CHECK (char_length(model_version) <= 50),
  p_paid               numeric(6,4) CHECK (p_paid    BETWEEN 0 AND 1),
  p_denied             numeric(6,4) CHECK (p_denied  BETWEEN 0 AND 1),
  p_partial            numeric(6,4) CHECK (p_partial BETWEEN 0 AND 1),
  expected_days_to_pay numeric(6,1) CHECK (expected_days_to_pay >= 0),
  shap_top_feature     text,        -- feature NAME only — never a PHI value
  shap_top_value       numeric(8,4),
  counterfactual_hint  text,        -- DiCE plain-language, no PHI
  PRIMARY KEY (business_entity_id, charge_debit_id, model_version)
);
ALTER TABLE staging.brain1_scores OWNER TO claims_admin;
ALTER TABLE staging.brain1_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brain1_scores_isolation ON staging.brain1_scores;
CREATE POLICY brain1_scores_isolation ON staging.brain1_scores
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);
GRANT SELECT ON staging.brain1_scores TO claims_reader;
CREATE INDEX IF NOT EXISTS idx_brain1_scores_risk
  ON staging.brain1_scores (business_entity_id, p_denied DESC);