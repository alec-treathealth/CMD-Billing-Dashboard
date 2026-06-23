-- Migration 012: Brain 3 claim signatures + appeal evidence
-- DB: dbpabchpvipipkzkogta | Deployed + verified 2026-06-23.
-- Charge grain (business_entity_id, charge_debit_id); claim_line_id FK -> staging.claim_line.id
-- (spec said claim_line(claim_line_id) but the real PK is id). Signature cols are coded/PHI-free.
CREATE TABLE IF NOT EXISTS staging.claim_signatures (
  business_entity_id            uuid NOT NULL,
  charge_debit_id               text NOT NULL CHECK (char_length(charge_debit_id) <= 50),
  claim_line_id                 bigint REFERENCES staging.claim_line(id) ON DELETE CASCADE,
  canonical_primary_payer_name  text NOT NULL,
  payer_family                  text,
  cpt_code                      text,
  tob_raw                       text,
  claim_facility_id             text,
  outcome_class                 int,   -- 0 CLEAN | 1 PARTIAL/ALLOWED_GAP | 2 BALANCE_DUE_INSURANCE | 3 MATH_GAP
  residual_type                 text,
  charge_amount_bucket          text,  -- '$0-500' | '$500-2k' | '$2k-10k' | '$10k+'
  dense_embedding               extensions.halfvec(1024),
  sparse_weights                jsonb,
  fts_vector                    tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(canonical_primary_payer_name,'') || ' ' ||
      coalesce(payer_family,'')                 || ' ' ||
      coalesce(cpt_code,'')                      || ' ' ||
      coalesce(tob_raw,'')                       || ' ' ||
      coalesce(residual_type,''))
  ) STORED,
  embedded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_entity_id, charge_debit_id)
);
ALTER TABLE staging.claim_signatures OWNER TO claims_admin;
ALTER TABLE staging.claim_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_signatures_isolation ON staging.claim_signatures;
CREATE POLICY claim_signatures_isolation ON staging.claim_signatures
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);
GRANT SELECT ON staging.claim_signatures TO claims_reader;
CREATE INDEX IF NOT EXISTS idx_claim_sig_hnsw ON staging.claim_signatures
  USING hnsw (dense_embedding extensions.halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_claim_sig_fts ON staging.claim_signatures USING gin (fts_vector);
CREATE INDEX IF NOT EXISTS idx_claim_sig_prefilter
  ON staging.claim_signatures (canonical_primary_payer_name, cpt_code, outcome_class);

CREATE TABLE IF NOT EXISTS staging.appeal_evidence (
  evidence_id        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_entity_id uuid NOT NULL,
  query_claim_id     text,
  match_claim_id     text,
  rrf_score          numeric(8,6),
  vector_rank        int,
  fts_rank           int,
  match_outcome      text,
  match_payment_amt  numeric(12,2),
  retrieved_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE staging.appeal_evidence OWNER TO claims_admin;
ALTER TABLE staging.appeal_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appeal_evidence_isolation ON staging.appeal_evidence;
CREATE POLICY appeal_evidence_isolation ON staging.appeal_evidence
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);
GRANT SELECT ON staging.appeal_evidence TO claims_reader;
CREATE INDEX IF NOT EXISTS idx_appeal_evidence_query
  ON staging.appeal_evidence (business_entity_id, query_claim_id);