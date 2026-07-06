-- =============================================================================
-- ROLLBACK for Veris migration 018 — restore the 005/012 index shapes and drop
-- claim_signatures.model_version.
-- Apply via apply_migration (as postgres). Reverse-order teardown:
-- 019 → **018** → 017 → 016 → 015 → 014.
--
-- ⚠️ model_version DROP is destructive IF rows have been written since 018
--    (provenance is lost). The table was empty at 018 apply time; check before
--    running: SELECT count(*) FROM staging.claim_signatures;
-- =============================================================================

SET ROLE claims_admin;

DROP INDEX IF EXISTS staging.idx_brain1_cpt;
CREATE INDEX IF NOT EXISTS idx_brain1_cpt
  ON staging.brain1_features (cpt_code);

DROP INDEX IF EXISTS staging.idx_brain1_dos;
CREATE INDEX IF NOT EXISTS idx_brain1_dos
  ON staging.brain1_features (dos);

DROP INDEX IF EXISTS staging.idx_brain1_payer_family;
CREATE INDEX IF NOT EXISTS idx_brain1_payer_family
  ON staging.brain1_features (canonical_primary_payer_family);

DROP INDEX IF EXISTS staging.idx_brain1_payer_name;
CREATE INDEX IF NOT EXISTS idx_brain1_payer_name
  ON staging.brain1_features (canonical_primary_payer_name);

DROP INDEX IF EXISTS staging.idx_claim_sig_prefilter;
CREATE INDEX IF NOT EXISTS idx_claim_sig_prefilter
  ON staging.claim_signatures (canonical_primary_payer_name, cpt_code, outcome_class);

ALTER TABLE staging.claim_signatures DROP COLUMN IF EXISTS model_version;

RESET ROLE;
