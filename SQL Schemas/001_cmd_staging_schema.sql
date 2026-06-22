-- =============================================================================
-- CMD STAGING SCHEMA — Artifact #1
-- Gate-review: show before applying. Nothing touches main until confirmed.
--
-- Tables:
--   ref.remittance_code      — CARC/RARC codebook (seed for Brain 2 embeddings)
--   staging.payer_dim        — Payer master (stable IDs, contract flags)
--   staging.claim_line       — One row per charge/credit pair (deduped via credit_id)
--   staging.era_adjustment   — Long-format CARC/RARC per charge (unpivoted from CSV)
--   staging.payment_residual — Gap-miner output: claims where math doesn't close
--
-- Compliance:
--   HIPAA:  PHI columns (patient_id_enc, member_id_enc, group_number_enc) are
--           app-layer encrypted (libsodium) before INSERT. Never in features,
--           never in embeddings, never in logs.
--   SOC 2:  All tables carry created_at + ingested_by audit columns.
--   RLS:    Enabled on all tables. claims_reader role enforces business_entity_id
--           row isolation. No superuser app connections.
--   OWASP:  No dynamic SQL. All ETL uses parameterized statements.
--
-- Supabase quirks:
--   Port 6543 transaction pooler — no named prepared statements in ETL.
--   Money stored as numeric(12,2), never float.
--   All timestamps as timestamptz.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ref;
CREATE SCHEMA IF NOT EXISTS staging;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- claims_reader: SELECT only on staging + ref, scoped by RLS policy.
-- Never granted INSERT/UPDATE/DELETE; never superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'claims_reader') THEN
    CREATE ROLE claims_reader NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. ref.remittance_code
--    Brain 2 seed corpus. 98 CARC/RARC codes from your codebook export.
--    embedding column populated by the auto-embed pipeline (pgmq → Edge Fn).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.remittance_code (
  code                  text        NOT NULL,
  code_type             text        NOT NULL,  -- 'CARC' | 'RARC'
  description           text        NOT NULL  CHECK (char_length(description) <= 1000),
  -- Reconciliation category (human-reviewed, seeded from codebook analysis)
  category              text        NOT NULL  CHECK (category IN (
                          'CONTRACTUAL_EXPECTED',   -- CO-45, 97, 131 etc — legitimate write-off
                          'PATIENT_RESPONSIBILITY', -- 1=deductible, 2=coins, 3=copay
                          'DENIAL_OR_MISS',         -- 29=timely, 50=med-nec, 197=auth — gap targets
                          'NEEDS_INFO',             -- 226,227,252 — recoverable with attachment
                          'INFO_ACTIONABLE',        -- RARCs: missing/invalid X — appeal content
                          'INFO',                   -- Informational RARCs
                          'OTHER_REVIEW'            -- Ambiguous — needs human sign-off
                        )),
  is_miss_candidate     boolean     NOT NULL DEFAULT false,  -- true = feeds gap miner
  needs_human_review    boolean     NOT NULL DEFAULT false,  -- COB, dup-claim ambiguous codes
  is_inactive           boolean     NOT NULL DEFAULT false,
  -- Brain 2: populated by embed pipeline, halfvec for 16-bit storage efficiency
  -- Uncomment after pgvector extension confirmed on your Supabase project:
  -- embedding            halfvec(1536),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- SOC 2 audit column (matches staging tables + the 000 seed INSERT).
  ingested_by           text        NOT NULL DEFAULT 'seed_script' CHECK (char_length(ingested_by) <= 100),
  PRIMARY KEY (code, code_type)
);

COMMENT ON TABLE ref.remittance_code IS
  'CARC/RARC codebook. Brain 2 seed corpus. Embedding column populated by pgmq→Edge Function pipeline.';
COMMENT ON COLUMN ref.remittance_code.is_miss_candidate IS
  'True = this code on a charge flags a potential underpayment for gap miner.';

-- Index for Brain 2 nearest-neighbor (add after embedding column uncommented)
-- CREATE INDEX CONCURRENTLY ON ref.remittance_code
--   USING hnsw (embedding halfvec_cosine_ops)
--   WITH (m = 16, ef_construction = 64);

ALTER TABLE ref.remittance_code ENABLE ROW LEVEL SECURITY;
-- remittance_code is a shared reference table — all authenticated reads permitted.
-- No business_entity_id scoping needed; codes are universal (X12 standard).
CREATE POLICY remittance_code_read_all ON ref.remittance_code FOR SELECT USING (true);

GRANT SELECT ON ref.remittance_code TO claims_reader;

-- ---------------------------------------------------------------------------
-- 2. staging.payer_dim
--    Payer master. Stable keys: clearinghouse_payer_id + cmd_payer_id.
--    Collapses BLUECARD PROGRAM OF MA/TX/MN/PA/MD fragmentation via ch_payer_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging.payer_dim (
  id                        bigserial   PRIMARY KEY,
  business_entity_id        uuid        NOT NULL,  -- tenant isolation key

  -- Stable identifiers (prefer clearinghouse_payer_id for joins — names drift)
  cmd_payer_id              text        NOT NULL  CHECK (char_length(cmd_payer_id) <= 50),
  clearinghouse_payer_id    text                  CHECK (char_length(clearinghouse_payer_id) <= 50),
  payer_name                text        NOT NULL  CHECK (char_length(payer_name) <= 200),
  payer_name_with_id        text                  CHECK (char_length(payer_name_with_id) <= 250),
  payer_plan_name           text                  CHECK (char_length(payer_plan_name) <= 200),

  -- Classification (Brain 1 features)
  payer_type                text                  CHECK (char_length(payer_type) <= 100),
  -- e.g. 'Commercial Insurance Company' | 'Blue Cross Blue Shield' | 'Self Pay'
  network_status            text                  CHECK (char_length(network_status) <= 50),
  process_mode              text                  CHECK (char_length(process_mode) <= 200),
  default_billing_status    text                  CHECK (char_length(default_billing_status) <= 100),

  -- ERA/eligibility capability flags (ERA=No means CARC data may be incomplete)
  participates_in_era       boolean,
  participates_in_elig      boolean,
  requires_inst_agreement   boolean,
  requires_prof_agreement   boolean,
  accepts_secondary_elec    boolean,

  -- Audit
  created_at                timestamptz NOT NULL DEFAULT now(),
  ingested_by               text        NOT NULL  CHECK (char_length(ingested_by) <= 100),

  UNIQUE (business_entity_id, cmd_payer_id)
);

ALTER TABLE staging.payer_dim ENABLE ROW LEVEL SECURITY;

CREATE POLICY payer_dim_isolation ON staging.payer_dim
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

GRANT SELECT ON staging.payer_dim TO claims_reader;

COMMENT ON COLUMN staging.payer_dim.clearinghouse_payer_id IS
  'Stable cross-system ID. Use this for payer joins — payer_name strings drift across time.';
COMMENT ON COLUMN staging.payer_dim.participates_in_era IS
  'False for all current payers — means CARC/RARC data comes from manual EOB entry, not direct 835. Affects Brain 2 signal quality.';

-- ---------------------------------------------------------------------------
-- 3. staging.claim_line
--    One row per charge/credit pair.
--    Dedup key: (charge_debit_id, credit_id) — confirmed unique in BATCH_TEST_7.
--    PHI columns: app-layer encrypted before INSERT, never queried as features.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging.claim_line (
  id                        bigserial   PRIMARY KEY,
  business_entity_id        uuid        NOT NULL,

  -- Natural keys from CMD
  charge_debit_id           text        NOT NULL  CHECK (char_length(charge_debit_id) <= 50),
  credit_id                 text                  CHECK (char_length(credit_id) <= 50),
  claim_id                  text        NOT NULL  CHECK (char_length(claim_id) <= 50),

  -- PHI — app-layer libsodium encrypted before INSERT
  -- Values are opaque bytea; never used as features or embedding inputs
  patient_id_enc            bytea,      -- Charge Patient ID (encrypted)
  patient_name_enc          bytea,      -- First + Last concatenated (encrypted)
  member_id_enc             bytea,      -- Current Payer Member ID (encrypted)
  group_number_enc          bytea,      -- Current Payer Group # (encrypted)

  -- Claim-level identifiers
  claim_facility_id         text                  CHECK (char_length(claim_facility_id) <= 50),
  claim_rendering_provider  text                  CHECK (char_length(claim_rendering_provider) <= 50),
  charge_rendering_provider text                  CHECK (char_length(charge_rendering_provider) <= 50),

  -- Type of Bill decomposition (Brain 1 features — parsed from TOB at ingest)
  -- TOB raw string e.g. '861', '893'. Stored for audit; decomposed below.
  tob_raw                   text                  CHECK (char_length(tob_raw) <= 4),
  -- Digit 1-2: Facility type — single digit in CMD 3-char display
  -- 1=Hospital, 8=Psychiatric/Substance Abuse
  tob_facility_type         smallint              CHECK (tob_facility_type IN (1, 8)),
  -- Digit 3: Care setting (1=Inpatient, 3=Outpatient, 6=Residential RTC, 9=PHP/Day)
  tob_care_setting          smallint              CHECK (tob_care_setting IN (1, 3, 6, 9)),
  -- Digit 4: Claim frequency (1=admit-discharge, 2=first-interim, 3=continuing,
  --          7=replacement, 8=void) — CRITICAL for training filter
  tob_frequency             smallint              CHECK (tob_frequency IN (1, 2, 3, 7, 8)),
  -- Derived training flag: use for Brain 1 training set filter
  -- true = include in training (final/complete bill, not void, adjudicated)
  is_training_eligible      boolean     GENERATED ALWAYS AS (
    tob_frequency IN (1, 3, 7)   -- exclude void (8) and in-flight interim-first (2)
  ) STORED,

  -- Service dates
  charge_from_date          date,
  charge_to_date            date,
  claim_from_date           date,

  -- Payment dates
  primary_payment_date      date,
  secondary_payment_date    date,
  payment_received_date     date,
  payment_entered_date      date,

  -- Procedure / service coding (Brain 1 features — codes only, no free text PHI)
  cpt_code                  text                  CHECK (char_length(cpt_code) <= 10),
  rev_code                  text                  CHECK (char_length(rev_code) <= 10),
  rev_code_description      text                  CHECK (char_length(rev_code_description) <= 200),
  tos_code                  text                  CHECK (char_length(tos_code) <= 10),
  tos_description           text                  CHECK (char_length(tos_description) <= 100),
  pos_description           text                  CHECK (char_length(pos_description) <= 100),
  diagnosis_pointer_list    text                  CHECK (char_length(diagnosis_pointer_list) <= 200),
  units                     numeric(8,2),
  fee_schedule_applied      text                  CHECK (char_length(fee_schedule_applied) <= 200),

  -- Payer FK + denormalized name for query convenience
  payer_dim_id              bigint      REFERENCES staging.payer_dim(id) ON DELETE RESTRICT,
  current_payer_name        text                  CHECK (char_length(current_payer_name) <= 200),
  current_payer_id          text                  CHECK (char_length(current_payer_id) <= 50),
  current_payer_type        text                  CHECK (char_length(current_payer_type) <= 100),
  current_payer_priority    text                  CHECK (char_length(current_payer_priority) <= 50),
  primary_payer_name        text                  CHECK (char_length(primary_payer_name) <= 200),
  secondary_payer_name      text                  CHECK (char_length(secondary_payer_name) <= 200),
  tertiary_payer_name       text                  CHECK (char_length(tertiary_payer_name) <= 200),
  current_payer_contract    text                  CHECK (char_length(current_payer_contract) <= 200),

  -- Money columns — numeric(12,2), never float
  charge_amount             numeric(12,2),
  charge_primary_paid       numeric(12,2),
  charge_secondary_paid     numeric(12,2),
  insurance_paid_amount     numeric(12,2),
  charge_insurance_adj      numeric(12,2),
  charge_patient_adj        numeric(12,2),
  charge_balance_due_pat    numeric(12,2),
  charge_balance_due_ins    numeric(12,2),
  charge_net_amount         numeric(12,2),
  charge_balance_at_coll    numeric(12,2),
  current_payer_contract_amt numeric(12,2),
  -- Payer allowed amount — most important gap-miner input.
  -- Populated from Indigo (Payment Allowed Amount Sum, 100% filled)
  -- or CMD batch Follow Up Allowed Amt (currently 0% filled).
  -- When allowed > paid: candidate underpayment. See payment_residual.allowed_gap.
  allowed_amount            numeric(12,2),

  -- Pre-computed lag metrics (days) — Brain 1 labels
  insurance_payment_lag     smallint,   -- days service → insurance payment
  insurance_billing_lag     smallint,   -- days service → first bill sent
  total_time_to_payment     smallint,   -- end-to-end cycle time

  -- Status
  claim_status              text                  CHECK (char_length(claim_status) <= 200),
  claim_type                text                  CHECK (char_length(claim_type) <= 50),
  claim_frequency           text                  CHECK (char_length(claim_frequency) <= 50),  -- CMD values e.g. "7 - Replacement of Prior Claim" (30 chars)
  charge_incomplete         boolean,
  auth_exception            text                  CHECK (char_length(auth_exception) <= 200),

  -- Credit / payment event metadata
  acct_credit_type          text                  CHECK (char_length(acct_credit_type) <= 50),
  eft_payment               text                  CHECK (char_length(eft_payment) <= 100),

  -- Ingest metadata
  source_type               text        NOT NULL  CHECK (source_type IN (
                              'CMD_BATCH',     -- BATCH_TEST_* format (charge/credit grain)
                              'INDIGO_CLAIMS', -- Indigo_Claims_Past_Year format (episode grain)
                              'CLEARINGHOUSE'  -- future: 835 direct from Stedi
                            )),
  source_report_date        date        NOT NULL,   -- the CMD report run date
  source_file_name          text        NOT NULL  CHECK (char_length(source_file_name) <= 200),
  created_at                timestamptz NOT NULL DEFAULT now(),
  ingested_by               text        NOT NULL  CHECK (char_length(ingested_by) <= 100),

  UNIQUE (business_entity_id, charge_debit_id, credit_id)
);

ALTER TABLE staging.claim_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY claim_line_isolation ON staging.claim_line
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- Query indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claim_line_claim_id
  ON staging.claim_line (business_entity_id, claim_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claim_line_payer
  ON staging.claim_line (business_entity_id, payer_dim_id, charge_from_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claim_line_tob_freq
  ON staging.claim_line (business_entity_id, tob_facility_type, tob_frequency)
  WHERE is_training_eligible = true;
-- tob_facility_type: 1=Hospital, 8=Psych/Substance
-- tob_care_setting:  1=Inpatient, 3=Outpatient, 6=Residential RTC, 9=PHP/Day

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claim_line_status_date
  ON staging.claim_line (business_entity_id, claim_status, charge_from_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claim_line_gap_miner
  ON staging.claim_line (business_entity_id, charge_balance_due_ins)
  WHERE charge_balance_due_ins > 0;

GRANT SELECT ON staging.claim_line TO claims_reader;

COMMENT ON TABLE staging.claim_line IS
  'One row per charge/credit pair. Dedup key: (charge_debit_id, credit_id). PHI columns are app-layer encrypted; never query as features or embed.';
COMMENT ON COLUMN staging.claim_line.tob_frequency IS
  'UB-04 TOB digit 4. Training filter: include 1,3,7 (complete/continuing/corrected). Exclude 8 (void). Exclude 2 (first-interim, in-flight).';
COMMENT ON COLUMN staging.claim_line.is_training_eligible IS
  'Computed: tob_frequency IN (1,3,7). True = this row is safe to include in Brain 1 training set.';
COMMENT ON COLUMN staging.claim_line.insurance_payment_lag IS
  'Pre-computed by CMD. Days from service to insurance payment. Brain 1 days-to-pay label.';
COMMENT ON COLUMN staging.claim_line.charge_balance_due_ins IS
  'Outstanding insurance balance on adjudicated claims. Primary gap miner target ($93K in 82-day sample).';
COMMENT ON COLUMN staging.claim_line.allowed_amount IS
  'Payer allowed amount. Source: Indigo Payment Allowed Amount (Sum) or CMD Follow Up Allowed Amt. When allowed_amount > charge_primary_paid: underpayment candidate. $3.94M gap across 4,678 Indigo episodes.';
COMMENT ON COLUMN staging.claim_line.source_type IS
  'ETL source format. CMD_BATCH rows have CARC/RARC in era_adjustment. INDIGO_CLAIMS rows have allowed_amount but no CARC codes.';

-- ---------------------------------------------------------------------------
-- 4. staging.era_adjustment
--    Long-format CARC/RARC rows — one per non-zero code per charge.
--    Unpivoted from the 99 wide columns in CMD batch CSV at ingest.
--    Handles duplicate columns (code 96 and N776 appear twice in CSV).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging.era_adjustment (
  id                    bigserial   PRIMARY KEY,
  business_entity_id    uuid        NOT NULL,

  -- FK to claim_line
  claim_line_id         bigint      NOT NULL
                        REFERENCES staging.claim_line(id) ON DELETE CASCADE,
  charge_debit_id       text        NOT NULL  CHECK (char_length(charge_debit_id) <= 50),

  -- Remittance code FK
  carc_code             text        NOT NULL  CHECK (char_length(carc_code) <= 10),
  carc_type             text        NOT NULL  CHECK (carc_type IN ('CARC', 'RARC')),

  -- Dollar amount for this specific code on this charge
  adjustment_amount     numeric(12,2) NOT NULL,

  -- Denormalized from ref.remittance_code for fast query (avoids join on hot path)
  category              text                  CHECK (category IN (
                          'CONTRACTUAL_EXPECTED','PATIENT_RESPONSIBILITY',
                          'DENIAL_OR_MISS','NEEDS_INFO',
                          'INFO_ACTIONABLE','INFO','OTHER_REVIEW'
                        )),
  is_miss_candidate     boolean,

  -- Audit
  created_at            timestamptz NOT NULL DEFAULT now(),
  ingested_by           text        NOT NULL  CHECK (char_length(ingested_by) <= 100),

  -- Prevent double-ingesting the same code for the same charge
  UNIQUE (business_entity_id, charge_debit_id, carc_code)
);

ALTER TABLE staging.era_adjustment ENABLE ROW LEVEL SECURITY;

CREATE POLICY era_adjustment_isolation ON staging.era_adjustment
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_era_adj_claim_line
  ON staging.era_adjustment (claim_line_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_era_adj_miss_candidate
  ON staging.era_adjustment (business_entity_id, carc_code)
  WHERE is_miss_candidate = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_era_adj_denial
  ON staging.era_adjustment (business_entity_id, category, charge_debit_id)
  WHERE category IN ('DENIAL_OR_MISS','NEEDS_INFO');

GRANT SELECT ON staging.era_adjustment TO claims_reader;

COMMENT ON TABLE staging.era_adjustment IS
  'Long-format CARC/RARC per charge. Unpivoted from CMD CSV wide columns at ingest. One row per non-zero code per charge.';
COMMENT ON COLUMN staging.era_adjustment.carc_code IS
  'CARC or RARC code. Duplicate CSV columns (96, N776) summed on ingest — see ETL note.';

-- ---------------------------------------------------------------------------
-- 5. staging.payment_residual
--    Gap-miner output table.
--    Populated by the reconciliation query (Artifact #2).
--    Flags adjudicated charges where money doesn't close correctly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging.payment_residual (
  id                        bigserial   PRIMARY KEY,
  business_entity_id        uuid        NOT NULL,
  claim_line_id             bigint      NOT NULL
                            REFERENCES staging.claim_line(id) ON DELETE CASCADE,
  charge_debit_id           text        NOT NULL  CHECK (char_length(charge_debit_id) <= 50),

  -- The math
  billed                    numeric(12,2) NOT NULL,
  primary_paid              numeric(12,2) NOT NULL DEFAULT 0,
  secondary_paid            numeric(12,2) NOT NULL DEFAULT 0,
  insurance_adjustments     numeric(12,2) NOT NULL DEFAULT 0,
  patient_adjustments       numeric(12,2) NOT NULL DEFAULT 0,
  patient_balance           numeric(12,2) NOT NULL DEFAULT 0,
  balance_due_insurance     numeric(12,2) NOT NULL DEFAULT 0,
  -- residual = billed - sum(all above) — should be 0 for clean rows
  residual                  numeric(12,2)
                            GENERATED ALWAYS AS (
                              billed
                              - primary_paid
                              - secondary_paid
                              - insurance_adjustments
                              - patient_adjustments
                              - patient_balance
                              - balance_due_insurance
                            ) STORED,

  -- Allowed-vs-paid gap (populated when source has allowed_amount)
  -- This is the primary underpayment signal from Indigo data.
  -- allowed_gap = allowed_amount - (primary_paid + secondary_paid)
  -- Positive = payer paid less than they said they would allow.
  allowed_amount            numeric(12,2),
  allowed_gap               numeric(12,2)
                            GENERATED ALWAYS AS (
                              CASE
                                WHEN allowed_amount IS NOT NULL
                                THEN allowed_amount - primary_paid - secondary_paid
                                ELSE NULL
                              END
                            ) STORED,
  -- Classification
  residual_type             text        NOT NULL  CHECK (residual_type IN (
                              'BALANCE_DUE_INSURANCE', -- charge_balance_due_ins > 0
                              'ALLOWED_GAP',           -- allowed > paid (Indigo source)
                              'MATH_GAP',              -- residual != 0 (data integrity issue)
                              'CLEAN'                  -- residual = 0, no gap
                            )),
  -- Dominant CARC on this charge (if present) for gap categorization
  dominant_carc             text                  CHECK (char_length(dominant_carc) <= 10),
  dominant_carc_category    text,

  -- Flag for manual review queue
  requires_review           boolean     NOT NULL DEFAULT false,

  -- Audit
  calculated_at             timestamptz NOT NULL DEFAULT now(),
  ingested_by               text        NOT NULL  CHECK (char_length(ingested_by) <= 100),

  UNIQUE (business_entity_id, charge_debit_id)
);

ALTER TABLE staging.payment_residual ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_residual_isolation ON staging.payment_residual
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_residual_review
  ON staging.payment_residual (business_entity_id, residual_type, billed)
  WHERE residual_type != 'CLEAN';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_residual_allowed_gap
  ON staging.payment_residual (business_entity_id, allowed_gap)
  WHERE allowed_gap > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_residual_carc
  ON staging.payment_residual (business_entity_id, dominant_carc)
  WHERE dominant_carc IS NOT NULL;

GRANT SELECT ON staging.payment_residual TO claims_reader;

COMMENT ON TABLE staging.payment_residual IS
  'Gap miner output. BALANCE_DUE_INSURANCE rows are the primary recovery targets. MATH_GAP rows are data integrity issues. Populated by reconciliation query (Artifact #2).';
COMMENT ON COLUMN staging.payment_residual.residual IS
  'Computed: billed - all payments - all adjustments. Non-zero = data integrity issue or missing payment event.';
