-- Migration 011: Brain 2 CARC/RARC embeddings + drift alerts
-- DB: dbpabchpvipipkzkogta | Deployed + verified 2026-06-23.
CREATE TABLE IF NOT EXISTS ref.carc_embeddings (
  carc_code       text PRIMARY KEY REFERENCES ref.carc_code(carc_code) ON DELETE CASCADE,
  dense_embedding extensions.halfvec(1024) NOT NULL,
  sparse_weights  jsonb,
  embedded_at     timestamptz NOT NULL DEFAULT now(),
  model_version   text NOT NULL CHECK (char_length(model_version) <= 50)
);
ALTER TABLE ref.carc_embeddings OWNER TO claims_admin;
GRANT SELECT ON ref.carc_embeddings TO claims_reader;

CREATE TABLE IF NOT EXISTS ref.rarc_embeddings (
  rarc_code       text PRIMARY KEY REFERENCES ref.rarc_code(rarc_code) ON DELETE CASCADE,
  dense_embedding extensions.halfvec(1024) NOT NULL,
  sparse_weights  jsonb,
  embedded_at     timestamptz NOT NULL DEFAULT now(),
  model_version   text NOT NULL CHECK (char_length(model_version) <= 50)
);
ALTER TABLE ref.rarc_embeddings OWNER TO claims_admin;
GRANT SELECT ON ref.rarc_embeddings TO claims_reader;

CREATE INDEX IF NOT EXISTS idx_carc_emb_hnsw ON ref.carc_embeddings
  USING hnsw (dense_embedding extensions.halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_rarc_emb_hnsw ON ref.rarc_embeddings
  USING hnsw (dense_embedding extensions.halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS staging.brain2_alerts (
  alert_id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_entity_id    uuid NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  payer_name            text NOT NULL,
  payer_family          text,
  carc_code             text,
  alert_type            text CHECK (alert_type IN ('BOCPD_CHANGEPOINT','ADWIN_ALARM','VECTOR_CLUSTER_SHIFT')),
  run_length_posterior  numeric(6,4),
  prior_rate            numeric(6,4),
  post_rate             numeric(6,4),
  similar_carc_cluster  text[],
  plain_language        text,
  acknowledged          boolean NOT NULL DEFAULT false
);
ALTER TABLE staging.brain2_alerts OWNER TO claims_admin;
ALTER TABLE staging.brain2_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brain2_alerts_isolation ON staging.brain2_alerts;
CREATE POLICY brain2_alerts_isolation ON staging.brain2_alerts
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);
GRANT SELECT ON staging.brain2_alerts TO claims_reader;
CREATE INDEX IF NOT EXISTS idx_brain2_alerts_open
  ON staging.brain2_alerts (business_entity_id, payer_name, carc_code) WHERE acknowledged = false;