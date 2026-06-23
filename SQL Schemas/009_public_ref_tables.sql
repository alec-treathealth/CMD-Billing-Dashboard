-- Migration 009: public reference data tables (full CARC/RARC, CMS PFS, NPPES)
-- DB: dbpabchpvipipkzkogta  | Deployed + verified 2026-06-23 (vector 0.8.0).
-- Foundation for Brain 1 (PFS anchor feature) + Brain 2/3 (CARC/RARC embeddings).
-- halfvec is schema-qualified (extensions.*) so the migration is search_path-independent.

-- ref.carc_code — full CARC list (~358). embedding populated in Phase 2 (BGE-M3).
CREATE TABLE IF NOT EXISTS ref.carc_code (
  carc_code         text PRIMARY KEY,
  short_description text NOT NULL,
  start_date        date,
  stop_date         date,                       -- deactivated codes still valid in historical 835s
  notes             text,
  embedding         extensions.halfvec(1024),
  fts_vector        tsvector GENERATED ALWAYS AS (
                      to_tsvector('english',
                        coalesce(carc_code,'') || ' ' || coalesce(short_description,''))
                    ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ingested_by       text NOT NULL DEFAULT 'public_ref_loader' CHECK (char_length(ingested_by) <= 100)
);
ALTER TABLE ref.carc_code OWNER TO claims_admin;
GRANT SELECT ON ref.carc_code TO claims_reader;

-- ref.rarc_code — full RARC list (~1,185).
CREATE TABLE IF NOT EXISTS ref.rarc_code (
  rarc_code         text PRIMARY KEY,
  rarc_type         text CHECK (rarc_type IN ('SUPPLEMENTAL','INFORMATIONAL')),
  short_description text NOT NULL,
  start_date        date,
  stop_date         date,
  embedding         extensions.halfvec(1024),
  fts_vector        tsvector GENERATED ALWAYS AS (
                      to_tsvector('english',
                        coalesce(rarc_code,'') || ' ' || coalesce(short_description,''))
                    ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ingested_by       text NOT NULL DEFAULT 'public_ref_loader' CHECK (char_length(ingested_by) <= 100)
);
ALTER TABLE ref.rarc_code OWNER TO claims_admin;
GRANT SELECT ON ref.rarc_code TO claims_reader;

-- ref.cms_pfs_rate — CMS Physician Fee Schedule for BH HCPCS. modifier defaults to ''
-- (sentinel, NOT NULL) so it can sit in the PK — mirrors the credit_id='' convention in 006.
CREATE TABLE IF NOT EXISTS ref.cms_pfs_rate (
  hcpcs_code        text NOT NULL,
  modifier          text NOT NULL DEFAULT '',
  locality          text NOT NULL,
  facility_rate     numeric(10,4),
  non_facility_rate numeric(10,4),
  rvu_work          numeric(8,4),
  rvu_pe_facility   numeric(8,4),
  rvu_mp            numeric(8,4),
  year              int  NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ingested_by       text NOT NULL DEFAULT 'cms_pfs_loader' CHECK (char_length(ingested_by) <= 100),
  PRIMARY KEY (hcpcs_code, modifier, locality, year)
);
ALTER TABLE ref.cms_pfs_rate OWNER TO claims_admin;
GRANT SELECT ON ref.cms_pfs_rate TO claims_reader;

-- ref.nppes_provider — NPI registry data for facilities in staging.claim_line.
CREATE TABLE IF NOT EXISTS ref.nppes_provider (
  npi           text PRIMARY KEY,
  entity_type   int CHECK (entity_type IN (1,2)),  -- 1=individual, 2=org
  org_name      text,
  taxonomy_code text,
  taxonomy_desc text,
  state         text,
  last_updated  date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ingested_by   text NOT NULL DEFAULT 'nppes_loader' CHECK (char_length(ingested_by) <= 100)
);
ALTER TABLE ref.nppes_provider OWNER TO claims_admin;
GRANT SELECT ON ref.nppes_provider TO claims_reader;

-- Vector (HNSW, cosine) + FTS (GIN) indexes. Empty tables -> instant build.
CREATE INDEX IF NOT EXISTS idx_carc_code_embedding ON ref.carc_code
  USING hnsw (embedding extensions.halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_rarc_code_embedding ON ref.rarc_code
  USING hnsw (embedding extensions.halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_carc_code_fts ON ref.carc_code USING gin (fts_vector);
CREATE INDEX IF NOT EXISTS idx_rarc_code_fts ON ref.rarc_code USING gin (fts_vector);

-- Filtered-scan correctness for HNSW under WHERE pre-filters (pgvector 0.8.0).
ALTER DATABASE postgres SET hnsw.iterative_scan = 'relaxed_order';