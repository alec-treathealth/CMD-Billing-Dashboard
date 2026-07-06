-- =============================================================================
-- Veris migration 018 — staging index-leadership fixes + claim_signatures.model_version
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review artifact: S2 bundle, apply position 2 of the ratified order
-- (016 → **018** → withTenant commit+push+prod-verify → 017 → 019).
-- Structural + safe early: no policy/grant/role changes.
--
-- WHY (index leadership): every RLS-scoped staging query carries
--   business_entity_id = <GUC> — an index that does not LEAD with the tenant
--   column scans across tenants and only post-filters. Live census 2026-07-05
--   found 5 non-tenant-leading btree query indexes; recreated tenant-leading
--   below (same names, new column order).
--
--   DELIBERATELY LEFT AS-IS:
--   * idx_era_adj_claim_line / idx_payment_residual_claim_line_id /
--     idx_brain1_features_claim_line_id — FK-SUPPORT indexes: FK cascade/
--     RESTRICT lookups probe by claim_line_id ALONE (no tenant qual), so a
--     tenant-leading rewrite would force full scans on every claim_line
--     DELETE/UPDATE. Do not "fix" these.
--   * pkey / UNIQUE-constraint indexes — identity, not query paths (and the
--     tenant-scoped UNIQUEs already lead with business_entity_id).
--   * idx_claim_sig_hnsw (HNSW) + idx_claim_sig_fts (GIN) — vector/FTS methods
--     cannot lead with a btree column; tenant scoping stays in the WHERE
--     clause + RLS (hybrid_search.ts filters business_entity_id explicitly).
--
-- WHY (model_version): staging.claim_signatures rows are embeddings but carry
--   no provenance of the embedding model — ref.carc_embeddings/rarc_embeddings
--   (011) both have model_version NOT NULL. Brain 3 similarity is only valid
--   within one embedding space; re-embedding with a new model must be
--   distinguishable. The table is EMPTY live (0 rows, verified 2026-07-05), so
--   ADD COLUMN ... NOT NULL with no default is safe and forces the writer to
--   stamp it. Companion code change (same bundle): src/brain3/claim_embedder.py
--   now writes model_version = its MODEL_NAME.
--
-- LOCKS: plain CREATE INDEX (not CONCURRENTLY — we are inside the
--   apply_migration transaction). Largest table touched is brain1_features
--   (64,346 rows); build time is negligible. claim_signatures is empty.
--
-- Idempotent forward: DROP INDEX IF EXISTS + CREATE INDEX IF NOT EXISTS;
--   ADD COLUMN IF NOT EXISTS.
-- Paired rollback: 018_staging_index_leadership_rollback.sql (restores the
--   005/012 index shapes; drops model_version).
-- =============================================================================

SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- 1. brain1_features — 4 single-column query indexes -> tenant-leading.
--    (idx_brain1_outcome and idx_brain1_trainset already lead with the tenant.)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS staging.idx_brain1_cpt;
CREATE INDEX IF NOT EXISTS idx_brain1_cpt
  ON staging.brain1_features (business_entity_id, cpt_code);

DROP INDEX IF EXISTS staging.idx_brain1_dos;
CREATE INDEX IF NOT EXISTS idx_brain1_dos
  ON staging.brain1_features (business_entity_id, dos);

DROP INDEX IF EXISTS staging.idx_brain1_payer_family;
CREATE INDEX IF NOT EXISTS idx_brain1_payer_family
  ON staging.brain1_features (business_entity_id, canonical_primary_payer_family);

DROP INDEX IF EXISTS staging.idx_brain1_payer_name;
CREATE INDEX IF NOT EXISTS idx_brain1_payer_name
  ON staging.brain1_features (business_entity_id, canonical_primary_payer_name);

-- ---------------------------------------------------------------------------
-- 2. claim_signatures — hybrid-search pre-filter -> tenant-leading. The Brain 3
--    RRF query (src/brain3/hybrid_search.ts) filters
--    business_entity_id = $1 AND outcome_class = 0 AND canonical_primary_payer_name = $3.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS staging.idx_claim_sig_prefilter;
CREATE INDEX IF NOT EXISTS idx_claim_sig_prefilter
  ON staging.claim_signatures
     (business_entity_id, canonical_primary_payer_name, cpt_code, outcome_class);

-- ---------------------------------------------------------------------------
-- 3. claim_signatures.model_version — embedding-space provenance (NOT NULL on
--    an empty table; writers must stamp it from here on).
-- ---------------------------------------------------------------------------
ALTER TABLE staging.claim_signatures
  ADD COLUMN IF NOT EXISTS model_version text NOT NULL
    CHECK (char_length(model_version) <= 50);

COMMENT ON COLUMN staging.claim_signatures.model_version IS
  'Embedding model that produced dense_embedding/sparse_weights (e.g. BAAI/bge-m3). Similarity is only valid within one model_version; mirrors ref.carc_embeddings.';

RESET ROLE;

-- ---------------------------------------------------------------------------
-- First-run verification (run after apply):
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname = 'staging'
--      AND indexname IN ('idx_brain1_cpt','idx_brain1_dos','idx_brain1_payer_family',
--                        'idx_brain1_payer_name','idx_claim_sig_prefilter');
--     -- expect all 5 to lead with business_entity_id
--   SELECT attnotnull FROM pg_attribute
--    WHERE attrelid = 'staging.claim_signatures'::regclass
--      AND attname = 'model_version';              -- expect t
-- =============================================================================
