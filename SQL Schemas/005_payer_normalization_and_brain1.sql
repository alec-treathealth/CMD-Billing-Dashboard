-- Migration 005: payer normalization + Brain 1 feature schema
-- Deployed: 2026-06-21
-- DB: dbpabchpvipipkzkogta
-- Safe to re-run (all CREATE IF NOT EXISTS + ON CONFLICT DO UPDATE)
--
-- SCOPE NOTE — this migration is SCHEMA + payer_alias SEED only. It intentionally
-- does NOT include the two data-population (build) steps that are run operationally:
--   (a) Backfill of claim_line.canonical_primary/current_payer_name/_family from
--       ref.payer_alias  (UPDATE ... FROM ref.payer_alias).
--   (b) Build of staging.brain1_features  (INSERT ... SELECT from claim_line +
--       payment_residual + payer_dim, one row per charge_debit_id).
-- After a fresh deploy of this file, the 4 canonical columns on claim_line are NULL
-- and staging.brain1_features is empty until those builders run. See the project
-- builder scripts / 003-style runners for (a) and (b).
--
-- Roles: tables owned by claims_admin (writer; owner bypasses RLS for builds),
--        claims_reader granted SELECT. Deploy DDL as a role that can SET ROLE /
--        owns schema CREATE on ref + staging (see migration 001 notes).

-- =============================================================================
-- 1. ref.payer_alias  — canonical payer-name normalization map (global, non-PHI)
--    Not tenant-scoped (payer names are universal), mirrors ref.remittance_code.
--    Join key: exact match on raw payer string (names are trimmed + uppercase at
--    ingest). Unmapped raw names leave canonical columns NULL = "unknown payer".
-- =============================================================================
CREATE TABLE IF NOT EXISTS ref.payer_alias (
  raw_name        text PRIMARY KEY  CHECK (char_length(raw_name) <= 200),
  canonical_name  text NOT NULL     CHECK (char_length(canonical_name) <= 200),
  payer_family    text NOT NULL
    CHECK (payer_family IN (
      'BCBS','ANTHEM','UNITED','CIGNA','AETNA','OPTUM',
      'MAGELLAN','HUMANA','TRICARE','MEDICAID','MEDICARE',
      'COMMERCIAL','OTHER'
    )),
  created_at      timestamptz NOT NULL DEFAULT now(),
  ingested_by     text NOT NULL DEFAULT 'payer_alias_seed'
                    CHECK (char_length(ingested_by) <= 100)
);

ALTER TABLE ref.payer_alias OWNER TO claims_admin;
GRANT SELECT ON ref.payer_alias TO claims_reader;

-- =============================================================================
-- 2. ref.payer_alias seed — 262 raw names -> 143 canonical payers, 12 families.
--    100% coverage of distinct primary_payer_name + current_payer_name observed
--    in the 16-customer CMD_BATCH ingest (business_entity_id = BXR/Treat Health).
--    Re-runnable via ON CONFLICT DO UPDATE.
--
--    Judgment calls baked in (confirmed with data owner):
--      * SUREST / UMR / Golden Rule -> UNITED; Meritain -> AETNA (subsidiaries).
--      * TENNESSEE BLUECARE -> MEDICAID (TennCare managed care, not commercial Blues).
--      * UHC Medicare Advantage -> UNITED (administering payer drives behavior).
--      * Carelon/Beacon variants -> one CARELON BEHAVIORAL HEALTH (COMMERCIAL).
--      * Kaiser -> COMMERCIAL; workers-comp / self-pay / "No Insurance" -> OTHER.
--      * BUECARD PROGRAM OF SC = typo of BLUECARD -> BCBS SOUTH CAROLINA.
-- =============================================================================
INSERT INTO ref.payer_alias (raw_name, canonical_name, payer_family) VALUES
  -- ---- BCBS (109) ----
  ('BCBS AL','BCBS ALABAMA','BCBS'),
  ('BCBS AR','BCBS ARKANSAS','BCBS'),
  ('BCBS OF AR','BCBS ARKANSAS','BCBS'),
  ('BCBS AZ','BCBS ARIZONA','BCBS'),
  ('BCBS OF AZ','BCBS ARIZONA','BCBS'),
  ('BCBS CA','BCBS CALIFORNIA','BCBS'),
  ('BCBS CT - TX','BCBS CONNECTICUT','BCBS'),
  ('BCBS OF CT','BCBS CONNECTICUT','BCBS'),
  ('BCBS GA','BCBS GEORGIA','BCBS'),
  ('BCBS IL','BCBS ILLINOIS','BCBS'),
  ('BCBS IL - SECONDARY ONLY','BCBS ILLINOIS','BCBS'),
  ('BCBS IL-PRIMARY','BCBS ILLINOIS','BCBS'),
  ('BCBS OF IL','BCBS ILLINOIS','BCBS'),
  ('BCBS IN','BCBS INDIANA','BCBS'),
  ('BCBS KY','BCBS KENTUCKY','BCBS'),
  ('BCBS LA','BCBS LOUISIANA','BCBS'),
  ('BCBS OF LA','BCBS LOUISIANA','BCBS'),
  ('BCBS MA','BCBS MASSACHUSETTS','BCBS'),
  ('BCBS OF MA','BCBS MASSACHUSETTS','BCBS'),
  ('BCBS OF MA - SECONDARY','BCBS MASSACHUSETTS','BCBS'),
  ('BCBS MD','BCBS MARYLAND','BCBS'),
  ('BCBS MI','BCBS MICHIGAN','BCBS'),
  ('BCBS OF MI','BCBS MICHIGAN','BCBS'),
  ('BCBS MN','BCBS MINNESOTA','BCBS'),
  ('BCBS OF MN','BCBS MINNESOTA','BCBS'),
  ('BCBS MO','BCBS MISSOURI','BCBS'),
  ('BCBS OF MO','BCBS MISSOURI','BCBS'),
  ('BCBS MS','BCBS MISSISSIPPI','BCBS'),
  ('BCBS NC','BCBS NORTH CAROLINA','BCBS'),
  ('BCBS NORTH CAROLINA','BCBS NORTH CAROLINA','BCBS'),
  ('BCBS OF NC','BCBS NORTH CAROLINA','BCBS'),
  ('BCBS NE','BCBS NEBRASKA','BCBS'),
  ('BCBS NH','BCBS NEW HAMPSHIRE','BCBS'),
  ('BCBS NM','BCBS NEW MEXICO','BCBS'),
  ('BCBS OF NM','BCBS NEW MEXICO','BCBS'),
  ('BCBS NV','BCBS NEVADA','BCBS'),
  ('BCBS OF AK','BCBS ALASKA','BCBS'),
  ('BCBS OF HI','BCBS HAWAII','BCBS'),
  ('BCBS OF MT','BCBS MONTANA','BCBS'),
  ('BCBS OK','BCBS OKLAHOMA','BCBS'),
  ('BCBS OF OK','BCBS OKLAHOMA','BCBS'),
  ('BCBS SC','BCBS SOUTH CAROLINA','BCBS'),
  ('BCBS OF SC','BCBS SOUTH CAROLINA','BCBS'),
  ('BCBS TX','BCBS TEXAS','BCBS'),
  ('BCBS OF TX','BCBS TEXAS','BCBS'),
  ('BCBS OF TEXAS','BCBS TEXAS','BCBS'),
  ('BCBS TN','BCBS TENNESSEE','BCBS'),
  ('BCBS OF TN','BCBS TENNESSEE','BCBS'),
  ('BCBS VA','BCBS VIRGINIA','BCBS'),
  ('BCBS OF VA','BCBS VIRGINIA','BCBS'),
  ('BCBS OH','BCBS OHIO','BCBS'),
  ('BCBS PA','BCBS PENNSYLVANIA','BCBS'),
  ('BCBS WA','BCBS WASHINGTON','BCBS'),
  ('BCBS FEDERAL','BCBS FEDERAL','BCBS'),
  ('FEDERAL BCBS','BCBS FEDERAL','BCBS'),
  ('FEP CLAIMS','BCBS FEDERAL','BCBS'),
  ('TENNESSEE BLUE CROSS BLUE SHIELD','BCBS TENNESSEE','BCBS'),
  ('BS OF CA','BLUE SHIELD CALIFORNIA','BCBS'),
  ('CALIFORNIA BLUE SHIELD','BLUE SHIELD CALIFORNIA','BCBS'),
  ('BLUE SHIELD CA','BLUE SHIELD CALIFORNIA','BCBS'),
  ('BLUE SHIELD OF CA','BLUE SHIELD CALIFORNIA','BCBS'),
  ('BLUESHIELD OF CA','BLUE SHIELD CALIFORNIA','BCBS'),
  ('BLUE CROSS AND BLUE SHIELD OF TEXAS','BCBS TEXAS','BCBS'),
  ('BLUE CARD PROGRAM','BCBS BLUECARD','BCBS'),
  ('BLUE CARD MN PROGRAM','BCBS MINNESOTA','BCBS'),
  ('BLUE CARD OF MT','BCBS MONTANA','BCBS'),
  ('BLUE CARD PROGRAM IL','BCBS ILLINOIS','BCBS'),
  ('BLUE CARD PROGRAM OF MA','BCBS MASSACHUSETTS','BCBS'),
  ('BLUE CARD PROGRAM OF NJ','BCBS NEW JERSEY','BCBS'),
  ('BLUE CARD PROGRAM TX','BCBS TEXAS','BCBS'),
  ('BLUECARD PROGRAM OF DE','BCBS DELAWARE','BCBS'),
  ('BLUECARD PROGRAM OF MA','BCBS MASSACHUSETTS','BCBS'),
  ('BLUECARD PROGRAM OF MD','BCBS MARYLAND','BCBS'),
  ('BLUECARD PROGRAM OF MN','BCBS MINNESOTA','BCBS'),
  ('BLUECARD PROGRAM OF NC','BCBS NORTH CAROLINA','BCBS'),
  ('BLUECARD PROGRAM OF NJ','BCBS NEW JERSEY','BCBS'),
  ('BLUECARD PROGRAM OF NM','BCBS NEW MEXICO','BCBS'),
  ('BLUECARD PROGRAM OF PA','BCBS PENNSYLVANIA','BCBS'),
  ('BLUECARD PROGRAM OF SC','BCBS SOUTH CAROLINA','BCBS'),
  ('BLUECARD PROGRAM OF TX','BCBS TEXAS','BCBS'),
  ('BLUECARD PROGRAM OF WA - SECONDARY','BCBS WASHINGTON','BCBS'),
  ('CAPITAL BCBS PA','CAPITAL BLUE CROSS PENNSYLVANIA','BCBS'),
  ('CAREFIRST BCBS','CAREFIRST BCBS','BCBS'),
  ('CAREFIRST BCBS MD','CAREFIRST MARYLAND','BCBS'),
  ('HIGHMARK BCBS','HIGHMARK BCBS','BCBS'),
  ('HIGHMARK BCBS DE','HIGHMARK DELAWARE','BCBS'),
  ('HIGHMARK BCBS OF DE','HIGHMARK DELAWARE','BCBS'),
  ('HIGHMARK BCBS OF PA','HIGHMARK PENNSYLVANIA','BCBS'),
  ('HIGHMARK BCBS PA','HIGHMARK PENNSYLVANIA','BCBS'),
  ('HORIZON BCBS NJ','HORIZON NEW JERSEY','BCBS'),
  ('HORIZON BCBS OF NJ','HORIZON NEW JERSEY','BCBS'),
  ('INDEPENDENCE BC OF PA','INDEPENDENCE PENNSYLVANIA','BCBS'),
  ('INDEPENDENCE BCBS OF PA','INDEPENDENCE PENNSYLVANIA','BCBS'),
  ('PREMERA BCBS','PREMERA BCBS','BCBS'),
  ('PREMERA BCBS WA','PREMERA WASHINGTON','BCBS'),
  ('PREMERA BLUE CROSS WA DIRECT','PREMERA WASHINGTON','BCBS'),
  ('PREMERA BLUE CROSS WA DIRECT-SECONDARY','PREMERA WASHINGTON','BCBS'),
  ('BCBS PREMERA','PREMERA BCBS','BCBS'),
  ('REGENCE BCBS OF OR','REGENCE OREGON','BCBS'),
  ('REGENCE BCBS OR','REGENCE OREGON','BCBS'),
  ('REGENCE BCBS WA','REGENCE WASHINGTON','BCBS'),
  ('REGENCE BLUE SHIELD OF WA','REGENCE WASHINGTON','BCBS'),
  ('REGENCE BLUE SHIELD WA','REGENCE WASHINGTON','BCBS'),
  ('REGENCE WA','REGENCE WASHINGTON','BCBS'),
  ('WASHINGTON BLUE SHIELD REGENCE','REGENCE WASHINGTON','BCBS'),
  ('REGENCE GROUP ADMINISTRATORS','REGENCE GROUP ADMINISTRATORS','BCBS'),
  ('WELLMARK BCBS','WELLMARK IOWA','BCBS'),
  ('WELLMARK BCBS OF IA','WELLMARK IOWA','BCBS'),
  ('BUECARD PROGRAM OF SC','BCBS SOUTH CAROLINA','BCBS'),
  -- ---- ANTHEM (39) ----
  ('ANTHEM BC CT','ANTHEM CONNECTICUT','ANTHEM'),
  ('ANTHEM BC OF CA','ANTHEM CALIFORNIA','ANTHEM'),
  ('ANTHEM BC OF GA','ANTHEM GEORGIA','ANTHEM'),
  ('ANTHEM BC OF KY','ANTHEM KENTUCKY','ANTHEM'),
  ('ANTHEM BC OF OH','ANTHEM OHIO','ANTHEM'),
  ('ANTHEM BC OH-SECONDARY','ANTHEM OHIO','ANTHEM'),
  ('ANTHEM BCBC OF IN','ANTHEM INDIANA','ANTHEM'),
  ('ANTHEM BCBCS IN','ANTHEM INDIANA','ANTHEM'),
  ('ANTHEM BCBCS KY','ANTHEM KENTUCKY','ANTHEM'),
  ('ANTHEM BCBCS VA','ANTHEM VIRGINIA','ANTHEM'),
  ('ANTHEM BCBS','ANTHEM BCBS','ANTHEM'),
  ('ANTHEM BCBS CA','ANTHEM CALIFORNIA','ANTHEM'),
  ('ANTHEM BCBS CO','ANTHEM COLORADO','ANTHEM'),
  ('ANTHEM BCBS CT','ANTHEM CONNECTICUT','ANTHEM'),
  ('ANTHEM BCBS GA','ANTHEM GEORGIA','ANTHEM'),
  ('ANTHEM BCBS IN','ANTHEM INDIANA','ANTHEM'),
  ('ANTHEM BCBS KY','ANTHEM KENTUCKY','ANTHEM'),
  ('ANTHEM BCBS MO','ANTHEM MISSOURI','ANTHEM'),
  ('ANTHEM BCBS NH','ANTHEM NEW HAMPSHIRE','ANTHEM'),
  ('ANTHEM BCBS NV','ANTHEM NEVADA','ANTHEM'),
  ('ANTHEM BCBS OF CA','ANTHEM CALIFORNIA','ANTHEM'),
  ('ANTHEM BCBS OF CAL','ANTHEM CALIFORNIA','ANTHEM'),
  ('ANTHEM BCBS OF CO','ANTHEM COLORADO','ANTHEM'),
  ('ANTHEM BCBS OF GA','ANTHEM GEORGIA','ANTHEM'),
  ('ANTHEM BCBS OF IN','ANTHEM INDIANA','ANTHEM'),
  ('ANTHEM BCBS OF KY','ANTHEM KENTUCKY','ANTHEM'),
  ('ANTHEM BCBS OF MO','ANTHEM MISSOURI','ANTHEM'),
  ('ANTHEM BCBS OF OH','ANTHEM OHIO','ANTHEM'),
  ('ANTHEM BCBS OF VA','ANTHEM VIRGINIA','ANTHEM'),
  ('ANTHEM BCBS OF WI','ANTHEM WISCONSIN','ANTHEM'),
  ('ANTHEM BCBS OH','ANTHEM OHIO','ANTHEM'),
  ('ANTHEM BCBS VA','ANTHEM VIRGINIA','ANTHEM'),
  ('ANTHEM BCBS WI','ANTHEM WISCONSIN','ANTHEM'),
  ('ANTHEM BLUE CROSS CALIFORNIA','ANTHEM CALIFORNIA','ANTHEM'),
  ('ANTHEM BLUE CROSS CALIFORNIA - SECONDARY','ANTHEM CALIFORNIA','ANTHEM'),
  ('ANTHEM BLUE CROSS IN','ANTHEM INDIANA','ANTHEM'),
  ('ANTHEM KENTUCKY BCBS','ANTHEM KENTUCKY','ANTHEM'),
  ('BRMS (ANTHEM BC CA)','ANTHEM CALIFORNIA','ANTHEM'),
  ('WELLPOINT','ANTHEM BCBS','ANTHEM'),
  -- ---- UNITED (15) ----
  ('UNITED HEALTHCARE','UNITED HEALTHCARE','UNITED'),
  ('UNITED HEALTHCARE - SECONDARY','UNITED HEALTHCARE','UNITED'),
  ('UNITED HEALTHCARE-SECONDARY','UNITED HEALTHCARE','UNITED'),
  ('UNITED HEALTHCARE SHARED SERVICES','UNITED HEALTHCARE','UNITED'),
  ('UNITED HEALTHCARE SHARED SERVICESGEHA','UNITED HEALTHCARE','UNITED'),
  ('UNITEDHEALTHCARE STUDENT RESOURCES','UNITED HEALTHCARE','UNITED'),
  ('UHC GOLDEN RULE','UNITED HEALTHCARE','UNITED'),
  ('GOLDEN RULE INSURANCE','UNITED HEALTHCARE','UNITED'),
  ('UHSS','UNITED HEALTHCARE','UNITED'),
  ('UHC MEDICARE ADVANTAGE','UNITED HEALTHCARE MEDICARE ADVANTAGE','UNITED'),
  ('UMR','UMR','UNITED'),
  ('UMR FKA UMR WAUSAU','UMR','UNITED'),
  ('SUREST','SUREST','UNITED'),
  ('SUREST HEALTH PLAN','SUREST','UNITED'),
  ('SUREST HEALTH PLAN - BIND','SUREST','UNITED'),
  -- ---- CIGNA (4) ----
  ('CIGNA','CIGNA','CIGNA'),
  ('CIGNA - SECONDARY','CIGNA','CIGNA'),
  ('CIGNA GLOBAL','CIGNA','CIGNA'),
  ('CIGNA INTERNATIONAL','CIGNA','CIGNA'),
  -- ---- AETNA (4) ----
  ('AETNA','AETNA','AETNA'),
  ('AETNA - SECONDARY','AETNA','AETNA'),
  ('AETNA US HEALTHCARE','AETNA','AETNA'),
  ('MERITAIN HEALTH','MERITAIN HEALTH','AETNA'),
  -- ---- OPTUM (6) ----
  ('OPTUM','OPTUM','OPTUM'),
  ('OPTUM BEHAVIORAL HEALTH','OPTUM','OPTUM'),
  ('OPTUM BH','OPTUM','OPTUM'),
  ('OPTUM-SECONDARY','OPTUM','OPTUM'),
  ('OPTUMHEALTH BEHAVIORAL SOLUTIONS','OPTUM','OPTUM'),
  ('OSCAR/OPTUM BH','OPTUM','OPTUM'),
  -- ---- MAGELLAN (1) ----
  ('MAGELLAN BEHAVIORAL HEALTH','MAGELLAN BEHAVIORAL HEALTH','MAGELLAN'),
  -- ---- TRICARE (1) ----
  ('TRIWEST REGION 4 CCN CLAIMS AFTER DOS 6.8.2021','TRIWEST','TRICARE'),
  -- ---- MEDICARE (2) ----
  ('MEDICARE','MEDICARE','MEDICARE'),
  ('MEDICARE PART A','MEDICARE','MEDICARE'),
  -- ---- MEDICAID (1) ----
  ('TENNESSEE BLUECARE','TENNESSEE BLUECARE','MEDICAID'),
  -- ---- OTHER (8) ----
  ('No Insurance','NO INSURANCE','OTHER'),
  ('SELF PAY','SELF PAY','OTHER'),
  ('CITY OF SEATTLE-ATTN: CLAIMS DEPT','CITY OF SEATTLE','OTHER'),
  ('WASHINGTON DEPT OF L&I','WASHINGTON L&I','OTHER'),
  ('WCF INSURANCE','WCF INSURANCE','OTHER'),
  ('STATE COMPENSATION INSURANCE FUND','STATE COMPENSATION INSURANCE FUND','OTHER'),
  ('SEDGWICK','SEDGWICK','OTHER'),
  ('GENEX SERVICES','GENEX SERVICES','OTHER'),
  -- ---- COMMERCIAL (72) ----
  ('ADVENTIST HEALTH SYSTEM','ADVENTIST HEALTH SYSTEM','COMMERCIAL'),
  ('ALLEGIANCE','ALLEGIANCE','COMMERCIAL'),
  ('ALLIED BENEFITS SYSTEMS INC.','ALLIED BENEFITS SYSTEMS','COMMERCIAL'),
  ('ALLIED HEALTH BENEFITS','ALLIED HEALTH BENEFITS','COMMERCIAL'),
  ('AMBETTER FL','AMBETTER FLORIDA','COMMERCIAL'),
  ('AMBETTER OF TENNESSEE','AMBETTER TENNESSEE','COMMERCIAL'),
  ('ASSURED BENEFITS ADMINISTRATORS','ASSURED BENEFITS ADMINISTRATORS','COMMERCIAL'),
  ('AUXIANT','AUXIANT','COMMERCIAL'),
  ('BAYLOR SCOTT & WHITE','BAYLOR SCOTT & WHITE','COMMERCIAL'),
  ('BAYLOR SCOTT & WHITE HEALTH PLAN-PRIMARY','BAYLOR SCOTT & WHITE','COMMERCIAL'),
  ('BEACON HEALTH OPTIONS FKA VALUE OPTIONS','BEACON HEALTH OPTIONS','COMMERCIAL'),
  ('BEACON HEALTH STRATEGIES','BEACON HEALTH STRATEGIES','COMMERCIAL'),
  ('BEHAVIORAL HEALTH SYSTEMS','BEHAVIORAL HEALTH SYSTEMS','COMMERCIAL'),
  ('BENEFIT ADMINISTRATIVE SYSTEMS LLC','BENEFIT ADMINISTRATIVE SYSTEMS','COMMERCIAL'),
  ('BOON CHAPMAN ADMINSTRATORS INC','BOON CHAPMAN ADMINISTRATORS','COMMERCIAL'),
  ('CARELON','CARELON BEHAVIORAL HEALTH','COMMERCIAL'),
  ('CARELON BEACON','CARELON BEHAVIORAL HEALTH','COMMERCIAL'),
  ('CARELON BEHAVIORAL HEALTH','CARELON BEHAVIORAL HEALTH','COMMERCIAL'),
  ('CARELON BEHAVIORAL HEALTH (BEACON HEALTH)','CARELON BEHAVIORAL HEALTH','COMMERCIAL'),
  ('CARELON-BEACON','CARELON BEHAVIORAL HEALTH','COMMERCIAL'),
  ('CHRISTUS HEALTH PLAN TEXAS','CHRISTUS HEALTH PLAN TEXAS','COMMERCIAL'),
  ('COMPSYCH','COMPSYCH','COMMERCIAL'),
  ('CURATIVE','CURATIVE','COMMERCIAL'),
  ('DETEGO HEALTH','DETEGO HEALTH','COMMERCIAL'),
  ('EBMS','EBMS','COMMERCIAL'),
  ('EMBLEM HEALTH','EMBLEM HEALTH','COMMERCIAL'),
  ('FIRST CHOICE HEALTH NETWORK','FIRST CHOICE HEALTH NETWORK','COMMERCIAL'),
  ('FOUNDATION FOR MEDICAL CARE - TULARE AND KING CO.','FOUNDATION FOR MEDICAL CARE','COMMERCIAL'),
  ('GEHA','GEHA','COMMERCIAL'),
  ('GEHA CLAIMS DEPARTMENT','GEHA','COMMERCIAL'),
  ('HALCYON BEHAVIORAL HEALTH','HALCYON BEHAVIORAL HEALTH','COMMERCIAL'),
  ('HARMONY HEALTHCARE','HARMONY HEALTHCARE','COMMERCIAL'),
  ('HAWAII WESTERN MANGEMENT GROUP','HAWAII WESTERN MANAGEMENT GROUP','COMMERCIAL'),
  ('HEALTH NET OF CALIFORNIA AND OREGON CLAIMS DOS AFTER 6.15.21','HEALTH NET CALIFORNIA','COMMERCIAL'),
  ('HEALTH PARTNERS','HEALTH PARTNERS','COMMERCIAL'),
  ('HEALTH PLAN OF NV','HEALTH PLAN OF NEVADA','COMMERCIAL'),
  ('HEALTH PLANS INC.','HEALTH PLANS INC','COMMERCIAL'),
  ('HEALTHCARE HIGHWAYS HEALTH PLAN','HEALTHCARE HIGHWAYS','COMMERCIAL'),
  ('HEALTHCARE MANAGEMENT ADMINISTRATOR','HEALTHCARE MANAGEMENT ADMINISTRATORS','COMMERCIAL'),
  ('HEALTHNET OF CALIFORNIA','HEALTH NET CALIFORNIA','COMMERCIAL'),
  ('HEALTHSCOPE BENEFITS','HEALTHSCOPE BENEFITS','COMMERCIAL'),
  ('IBEW NECA SOUTHWESTERN HEALTH & BENEFIT FUND','IBEW NECA SOUTHWESTERN HEALTH & BENEFIT FUND','COMMERCIAL'),
  ('IMAGINE 360','IMAGINE360','COMMERCIAL'),
  ('IMAGINE360 ADMINISTRATORS','IMAGINE360','COMMERCIAL'),
  ('INDEPENDENCE ADMINISTRATORS','INDEPENDENCE ADMINISTRATORS','COMMERCIAL'),
  ('INDEPENDENCE ADMINISTRORS PA','INDEPENDENCE ADMINISTRATORS','COMMERCIAL'),
  ('KAISER FOUNDATION HEALTH PLAN OF WASHINGTON','KAISER WASHINGTON','COMMERCIAL'),
  ('KAISER HEALTH PLAN OF WA','KAISER WASHINGTON','COMMERCIAL'),
  ('KAISER PERMANENTE','KAISER PERMANENTE','COMMERCIAL'),
  ('LEMONADE INSURANCE','LEMONADE INSURANCE','COMMERCIAL'),
  ('LUCENT HEALTH','LUCENT HEALTH','COMMERCIAL'),
  ('MEDICA','MEDICA','COMMERCIAL'),
  ('MEDICA BEHAVIORAL HEALTH','MEDICA','COMMERCIAL'),
  ('MEDICAL MUTUAL OF OHIO','MEDICAL MUTUAL OF OHIO','COMMERCIAL'),
  ('MHSA','MHSA','COMMERCIAL'),
  ('MODA HEALTH','MODA HEALTH','COMMERCIAL'),
  ('NIPPON LIFE INSURANCE','NIPPON LIFE INSURANCE','COMMERCIAL'),
  ('PERSONIFY HEALTH','PERSONIFY HEALTH','COMMERCIAL'),
  ('PHCS','PHCS','COMMERCIAL'),
  ('PINNACLE','PINNACLE','COMMERCIAL'),
  ('PRAIRIE STATES ENTERPRISES','PRAIRIE STATES ENTERPRISES','COMMERCIAL'),
  ('PRIORITY HEALTH OF MICHIGAN','PRIORITY HEALTH MICHIGAN','COMMERCIAL'),
  ('SANA BENEFITS','SANA BENEFITS','COMMERCIAL'),
  ('SENDORA HEALTH PLANS','SENDORA HEALTH PLANS','COMMERCIAL'),
  ('SENTARA FAMILY PLAN','SENTARA FAMILY PLAN','COMMERCIAL'),
  ('SOUTHWEST SERVICE ADMINISTRATORS INC.','SOUTHWEST SERVICE ADMINISTRATORS','COMMERCIAL'),
  ('TRUSTMARK','TRUSTMARK','COMMERCIAL'),
  ('TUFTS ASSOCIATED HEALTH PLANS','TUFTS HEALTH PLAN','COMMERCIAL'),
  ('VALLEY HEALTH PLAN COMMERCIAL','VALLEY HEALTH PLAN','COMMERCIAL'),
  ('WESTERN GROWERS','WESTERN GROWERS','COMMERCIAL'),
  ('WESTERN GROWERS ASSURANCE TRUST','WESTERN GROWERS','COMMERCIAL'),
  ('WESTERN GROWERS INSURANCE COMPANY','WESTERN GROWERS','COMMERCIAL')
ON CONFLICT (raw_name) DO UPDATE
  SET canonical_name = EXCLUDED.canonical_name,
      payer_family   = EXCLUDED.payer_family;

-- =============================================================================
-- 3. staging.claim_line ALTER
--    (a) Four denormalized canonical-payer columns (populated by the backfill
--        UPDATE — see SCOPE NOTE; NULL until that runs).
--    (b) Redefinition of the is_training_eligible generated column.
--        OLD: tob_frequency IN (1,3,7)  -- WRONG: NULL TOB (professional/CMS-1500
--             claims, ~95.7% of rows) -> NULL -> excluded; threw away all
--             professional claims, collapsing the trainable set ~22x.
--        NEW: COALESCE(tob_frequency,1) NOT IN (2,8)  -- exclude only void (8)
--             and interim-first (2); professional + final institutional eligible.
--        Re-run-safe: DROP IF EXISTS then ADD (always ends in the correct def).
-- =============================================================================
ALTER TABLE staging.claim_line
  ADD COLUMN IF NOT EXISTS canonical_primary_payer_name   text CHECK (char_length(canonical_primary_payer_name) <= 200),
  ADD COLUMN IF NOT EXISTS canonical_primary_payer_family text CHECK (char_length(canonical_primary_payer_family) <= 20),
  ADD COLUMN IF NOT EXISTS canonical_current_payer_name   text CHECK (char_length(canonical_current_payer_name) <= 200),
  ADD COLUMN IF NOT EXISTS canonical_current_payer_family text CHECK (char_length(canonical_current_payer_family) <= 20);

ALTER TABLE staging.claim_line DROP COLUMN IF EXISTS is_training_eligible;
ALTER TABLE staging.claim_line
  ADD COLUMN is_training_eligible boolean
    GENERATED ALWAYS AS (COALESCE(tob_frequency, 1) NOT IN (2, 8)) STORED;

-- =============================================================================
-- 4. staging.brain1_features — one row per charge_debit_id. Leakage firewall:
--    FEATURES are submission-time-knowable only; LABELS are post-adjudication.
--    Built by INSERT ... SELECT (see SCOPE NOTE); empty until that runs.
--      outcome:   PENDING (no 003 residual) | DENIED (v1 proxy = residual_type
--                 'BALANCE_DUE_INSURANCE', upgrades to CARC signal w/ Brain 2/835)
--                 | PARTIAL (ALLOWED_GAP or MATH_GAP) | PAID (CLEAN).
--      days_to_pay: DOS (charge_from_date) -> payment_received_date; populated
--                 ONLY for PAID/PARTIAL. NULL for DENIED/PENDING by design:
--                 regression target trains on PAID/PARTIAL; DENIED are
--                 classification-only examples.
-- =============================================================================
CREATE TABLE IF NOT EXISTS staging.brain1_features (
  id                              bigserial PRIMARY KEY,
  business_entity_id              uuid NOT NULL,

  -- IDENTITY
  charge_debit_id                 text NOT NULL CHECK (char_length(charge_debit_id) <= 50),
  claim_line_id                   bigint REFERENCES staging.claim_line(id) ON DELETE CASCADE,
  claim_facility_id               text CHECK (char_length(claim_facility_id) <= 50),

  -- LABELS (post-adjudication; NEVER use as model inputs)
  outcome                         text NOT NULL
                                    CHECK (outcome IN ('PAID','DENIED','PARTIAL','PENDING')),
  days_to_pay                     integer CHECK (days_to_pay >= 0),
  was_underpayment                boolean NOT NULL DEFAULT false,
  net_underpayment_amt            numeric(12,2),
  allowed_amount                  numeric(12,2),   -- label side (CMD populates post-response)
  residual_type                   text
                                    CHECK (residual_type IN ('ALLOWED_GAP','BALANCE_DUE_INSURANCE','MATH_GAP','CLEAN')),
  label_is_terminal               boolean NOT NULL,

  -- FEATURES: PAYER
  canonical_primary_payer_name    text CHECK (char_length(canonical_primary_payer_name) <= 200),
  canonical_primary_payer_family  text CHECK (char_length(canonical_primary_payer_family) <= 20),
  payer_type                      text CHECK (char_length(payer_type) <= 100),
  network_status                  text CHECK (char_length(network_status) <= 50),
  participates_in_era             boolean,

  -- FEATURES: CLAIM / CODING
  cpt_code                        text CHECK (char_length(cpt_code) <= 10),
  rev_code                        text CHECK (char_length(rev_code) <= 10),
  tos_code                        text CHECK (char_length(tos_code) <= 10),
  units                           numeric(8,2),
  diagnosis_pointer_count         smallint,
  tob_facility_type               smallint,
  tob_care_setting                smallint,
  tob_frequency                   smallint,
  claim_type                      text CHECK (char_length(claim_type) <= 50),
  claim_frequency                 text CHECK (char_length(claim_frequency) <= 50),

  -- FEATURES: FINANCIAL (submission-time only)
  billed_amount                   numeric(12,2),

  -- FEATURES: TEMPORAL (derived from DOS only)
  dos                             date,
  dos_year                        smallint,
  dos_month                       smallint,
  dos_dow                         smallint,
  insurance_billing_lag           smallint,

  -- FEATURES: PROVIDER / FACILITY
  claim_rendering_provider        text CHECK (char_length(claim_rendering_provider) <= 50),
  charge_rendering_provider       text CHECK (char_length(charge_rendering_provider) <= 50),

  -- META / AUDIT
  is_training_eligible            boolean,
  built_at                        timestamptz NOT NULL DEFAULT now(),
  built_by                        text NOT NULL DEFAULT 'brain1_feature_builder'
                                    CHECK (char_length(built_by) <= 100),

  UNIQUE (business_entity_id, charge_debit_id)
);

ALTER TABLE staging.brain1_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS brain1_features_isolation ON staging.brain1_features;
CREATE POLICY brain1_features_isolation ON staging.brain1_features
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

ALTER TABLE staging.brain1_features OWNER TO claims_admin;
GRANT SELECT ON staging.brain1_features TO claims_reader;

CREATE INDEX IF NOT EXISTS idx_brain1_outcome      ON staging.brain1_features (business_entity_id, outcome);
CREATE INDEX IF NOT EXISTS idx_brain1_payer_family ON staging.brain1_features (canonical_primary_payer_family);
CREATE INDEX IF NOT EXISTS idx_brain1_payer_name   ON staging.brain1_features (canonical_primary_payer_name);
CREATE INDEX IF NOT EXISTS idx_brain1_cpt          ON staging.brain1_features (cpt_code);
CREATE INDEX IF NOT EXISTS idx_brain1_dos          ON staging.brain1_features (dos);
CREATE INDEX IF NOT EXISTS idx_brain1_trainset     ON staging.brain1_features (business_entity_id)
  WHERE is_training_eligible AND label_is_terminal;
