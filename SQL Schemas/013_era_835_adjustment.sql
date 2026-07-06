-- =============================================================================
-- Migration 013: staging.era_835_adjustment — CARC/RARC sourced from real 835 ERA
-- DB: dbpabchpvipipkzkogta
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before
-- CREATE POLICY; roles created only-if-absent (never DROP ROLE); REVOKE/GRANT
-- reapplied unconditionally.
--
-- =============================================================================
-- WHY A NEW TABLE (and NOT staging.era_adjustment)
-- =============================================================================
-- staging.era_adjustment (001 + 006) is the CMD BATCH-report CARC table. It is
-- LIVE (65,615 rows) and load-bearing: staging.mv_payer_drift (008, 114 rows,
-- deployed) reads it via a hard join to staging.claim_line. That table's grain and
-- keys are CMD-INTERNAL:
--     claim_line_id  bigint  NOT NULL  REFERENCES staging.claim_line(id)
--     UNIQUE (business_entity_id, charge_debit_id, credit_id, carc_code)
-- An 835 ERA carries NONE of those keys. Its natural identifiers are the payer
-- claim control number (CLP07), the provider's patient control number (CLP01),
-- the service-line position, and the CAS group/reason codes — plus PHI (patient
-- name, subscriber/member id) and a per-code QUANTITY that era_adjustment does not
-- model. Forcing 835 rows into era_adjustment would require either (a) resolving
-- every remit to a pre-existing claim_line row and DROPPING every unmatched remit
-- (silent data loss on a money-critical feed — unacceptable RCM practice), or
-- (b) making claim_line_id nullable and bolting a second grain + PHI columns onto a
-- table the deployed drift MV depends on (regression risk to a working signal).
--
-- So this migration LANDS the 835 at its own native grain, additively, and keeps a
-- NULLABLE reconciliation link (claim_line_id / patient_control_number) to be
-- resolved to the CMD charge ledger ASYNCHRONOUSLY — the standard RCM pattern:
-- stage the remittance as received, match to charges later. Column names mirror
-- staging.era_adjustment (carc_code / carc_type) so a future reconciled UNION /
-- Brain-2 upgrade is natural. Wiring this into mv_payer_drift is deliberately OUT
-- OF SCOPE here (payer_dim.participates_in_era stays the switch for that).
--
-- =============================================================================
-- COMPLIANCE (docs/CLAUDE.md §2, mirrors 0019 + 001)
-- =============================================================================
--   HIPAA:  patient_name_enc / member_id_enc are libsodium secretbox ciphertext
--           (nonce‖ciphertext bytea), encrypted IN-PROCESS before INSERT by
--           src/collections/phiCrypto.ts. LIBSODIUM_KEY never lives in the DB, so a
--           DB-only compromise (incl. a leaked claims_reader credential) cannot
--           recover patient identifiers. The patient_control_number / payer claim
--           control number are BUSINESS claim identifiers (like claim_line.claim_id),
--           not patient identifiers — stored plaintext for reconciliation, matching
--           the existing convention.
--   SOC 2:  created/ingest audit columns (ingested_at, ingested_by).
--   RLS:    enabled; claims_reader row isolation by business_entity_id GUC
--           (app.business_entity_id), matching every other staging.* table.
--   OWASP:  no dynamic SQL in the ETL; all writes parameterized; every text column
--           is length-bounded (CHECK); money is numeric(12,2), never float;
--           timestamps timestamptz.
--   PostgREST: the `staging` schema MUST stay OFF Supabase's exposed-schemas list
--           (same posture as the rest of staging/claims). PHI-bearing even encrypted.
--
-- Idempotency of the INGEST: ON CONFLICT (row_fingerprint) DO NOTHING. The
-- fingerprint is SHA-256 over the NORMALIZED PLAINTEXT identity fields (no PHI
-- needed — the 835's natural keys are non-PHI), computed before encryption, so a
-- re-download or overlapping day inserts only genuinely new adjustment rows.
--
-- DEPENDENCY: assumes 001 (staging schema + claims_reader), 006 (era_adjustment
-- credit grain — for column-name parity only), and 0013 (cmd_rollup_writer role)
-- have run. Append-only (full-history landing): no UPDATE/DELETE grants.
-- =============================================================================

-- 1. Roles (privilege-only; reuse existing roles, created only-if-absent). -----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_reader') THEN
    CREATE ROLE claims_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmd_rollup_writer') THEN
    CREATE ROLE cmd_rollup_writer NOLOGIN;
  END IF;
END $$;

-- 2. Table --------------------------------------------------------------------
-- Grain: ONE ROW PER CAS ADJUSTMENT TRIPLET (group_code, carc_code, amount,
-- quantity) at either claim (Loop 2100) or service-line (Loop 2110) level, from a
-- single 835 ERA. Claim/line/payment context is denormalized onto each row (flat,
-- like collections.cmd_explorer_rows) so the table is directly queryable without a
-- join. facility_code is resolved from the CMD customer the 835 was pulled for
-- (one CMD customer == one facility; src/collections/cmdCustomers.ts) — never
-- name-parsed. business_entity_id is the tenant (BXR today).
CREATE TABLE IF NOT EXISTS staging.era_835_adjustment (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_entity_id       uuid        NOT NULL,

  -- Facility / provenance (resolved from the CMD customer account pulled) --------
  facility_code            text        NOT NULL CHECK (char_length(facility_code) <= 50),
  cmd_customer_id          text        NOT NULL CHECK (char_length(cmd_customer_id) <= 50),

  -- Remittance envelope (BPR / TRN / Loop 1000A payer) — non-PHI -----------------
  payer_name               text                 CHECK (char_length(payer_name) <= 200),
  payer_id                 text                 CHECK (char_length(payer_id) <= 80),
  era_control_number       text                 CHECK (char_length(era_control_number) <= 50),  -- ST02/GS06
  check_eft_trace_number   text                 CHECK (char_length(check_eft_trace_number) <= 50), -- TRN02
  payment_method           text                 CHECK (char_length(payment_method) <= 10),        -- BPR04 (ACH/CHK/NON…)
  payment_amount           numeric(12,2),                                                          -- BPR02
  payment_date             date,                                                                   -- BPR16 (effective entry)

  -- Claim level (Loop 2100 CLP) --------------------------------------------------
  patient_control_number   text                 CHECK (char_length(patient_control_number) <= 50), -- CLP01 (provider claim id; links to claim_line.claim_id later)
  payer_claim_control_number text               CHECK (char_length(payer_claim_control_number) <= 50), -- CLP07 (payer ICN/DCN)
  claim_status_code        text                 CHECK (char_length(claim_status_code) <= 5),       -- CLP02
  claim_charge_amount      numeric(12,2),                                                          -- CLP03
  claim_paid_amount        numeric(12,2),                                                          -- CLP04
  patient_responsibility_amount numeric(12,2),                                                     -- CLP05
  claim_filing_indicator   text                 CHECK (char_length(claim_filing_indicator) <= 5),  -- CLP06

  -- PHI — app-layer libsodium ciphertext (nonce‖ct); NEVER plaintext at rest -----
  patient_name_enc         bytea,      -- Loop 2100 NM1*QC (last+first)
  member_id_enc            bytea,      -- Loop 2100 NM1*IL subscriber/member id

  -- Service line (Loop 2110 SVC) — NULL for claim-level CAS ----------------------
  service_line_number      integer     NOT NULL DEFAULT 0,                                         -- 1-based within claim; 0 = claim-level CAS
  procedure_code           text                 CHECK (char_length(procedure_code) <= 50),         -- SVC01 (qualifier:code:mods)
  line_charge_amount       numeric(12,2),                                                          -- SVC02
  line_paid_amount         numeric(12,2),                                                          -- SVC03
  line_units               numeric(12,2),                                                          -- SVC05
  service_date             date,                                                                   -- DTM*472
  line_item_control_number text                 CHECK (char_length(line_item_control_number) <= 50), -- REF*6R

  -- The adjustment triplet (the grain) — CAS group/reason/amount/quantity --------
  -- 0-based ordinal of this triplet within its claim/line adjustment list. Part of the
  -- grain so two byte-identical CAS triplets on one line (rare, but valid X12) are kept
  -- as distinct rows rather than collapsed — a sum-critical feed must not lose a real dup.
  adjustment_index         integer     NOT NULL DEFAULT 0,
  cas_level                text        NOT NULL CHECK (cas_level IN ('CLAIM','LINE')),
  group_code               text        NOT NULL CHECK (group_code IN ('CO','PR','OA','PI','CR')),  -- CAS01
  carc_code                text        NOT NULL CHECK (char_length(carc_code) <= 10),              -- CARC, bare numeric ('45' not 'CO-45')
  carc_type                text        NOT NULL DEFAULT 'CARC' CHECK (carc_type IN ('CARC','RARC')),
  adjustment_amount        numeric(12,2) NOT NULL,                                                 -- CAS amount, sign preserved (reversals negative)
  adjustment_quantity      numeric(12,2),                                                          -- CAS quantity

  -- Denormalized from ref.remittance_code (fast reads; NULL until seeded) ---------
  category                 text                 CHECK (category IN (
                             'CONTRACTUAL_EXPECTED','PATIENT_RESPONSIBILITY',
                             'DENIAL_OR_MISS','NEEDS_INFO',
                             'INFO_ACTIONABLE','INFO','OTHER_REVIEW'
                           )),
  is_miss_candidate        boolean,

  -- Reconciliation link to the CMD charge ledger — resolved ASYNC, nullable ------
  claim_line_id            bigint      REFERENCES staging.claim_line(id) ON DELETE SET NULL,

  -- Provenance + idempotency + audit --------------------------------------------
  era_source_file          text                 CHECK (char_length(era_source_file) <= 200),       -- 835 filename in the pulled zip
  source                   text        NOT NULL DEFAULT 'cmd_835_api' CHECK (char_length(source) <= 30),
  row_fingerprint          text        NOT NULL,
  ingested_at              timestamptz NOT NULL DEFAULT now(),
  ingested_by              text        NOT NULL CHECK (char_length(ingested_by) <= 100),

  UNIQUE (row_fingerprint)
);

COMMENT ON TABLE staging.era_835_adjustment IS
  '835-sourced CARC/RARC adjustments, one row per CAS triplet (claim/line level). Native 835 grain (payer claim control number + line + code); NOT the CMD charge/credit grain of staging.era_adjustment. PHI (patient_name/member_id) app-layer encrypted. claim_line_id is a nullable, async-resolved reconciliation link. Idempotent on row_fingerprint.';
COMMENT ON COLUMN staging.era_835_adjustment.carc_code IS
  'CARC (or RARC) code, bare numeric e.g. ''45'' — NEVER the ''CO-45'' display form. Join ref.remittance_code ON code = carc_code AND code_type = carc_type.';
COMMENT ON COLUMN staging.era_835_adjustment.claim_line_id IS
  'Nullable FK to staging.claim_line, resolved asynchronously by matching patient_control_number → claim_line.claim_id (or charge). NULL at ingest — the 835 carries no CMD charge/credit id.';
COMMENT ON COLUMN staging.era_835_adjustment.adjustment_amount IS
  'CAS monetary amount for this code, SIGN PRESERVED (reversals/corrections are negative). Never ABS or drop — Brain 2 needs the sign.';

-- 3. Indexes ------------------------------------------------------------------
-- unique(row_fingerprint) already indexes the dedup lookup.
CREATE INDEX IF NOT EXISTS era_835_facility_payment_date
  ON staging.era_835_adjustment (business_entity_id, facility_code, payment_date);
CREATE INDEX IF NOT EXISTS era_835_payer_carc
  ON staging.era_835_adjustment (business_entity_id, payer_name, carc_code);
CREATE INDEX IF NOT EXISTS era_835_carc
  ON staging.era_835_adjustment (business_entity_id, carc_code)
  WHERE carc_type = 'CARC';
CREATE INDEX IF NOT EXISTS era_835_miss_candidate
  ON staging.era_835_adjustment (business_entity_id, carc_code)
  WHERE is_miss_candidate = true;
-- Reconciliation lookups.
CREATE INDEX IF NOT EXISTS era_835_patient_control
  ON staging.era_835_adjustment (business_entity_id, patient_control_number);
CREATE INDEX IF NOT EXISTS era_835_claim_line
  ON staging.era_835_adjustment (claim_line_id)
  WHERE claim_line_id IS NOT NULL;

-- 4. Grants -------------------------------------------------------------------
-- Strip default/public grants, then grant precisely. claims_reader gets SELECT (it
-- reads non-PHI columns for the recovery UI, and the two ciphertext columns only on
-- an audited reveal). cmd_rollup_writer gets INSERT only (the daily 835 cron write
-- path) — a minimal, deliberate extension of the existing least-privilege cron
-- writer to one new append-only staging table. No role gets UPDATE/DELETE. The
-- identity PK is GENERATED ALWAYS, so INSERT needs no sequence privilege.
--
-- ON CONFLICT arbiter: the ingest INSERTs `ON CONFLICT (row_fingerprint) DO NOTHING`
-- as cmd_rollup_writer. Postgres evaluates the arbiter, which requires the writer to
-- (a) have SELECT on the arbiter column and (b) pass a SELECT RLS policy — the exact
-- failure supabase/migrations/0021 fixed for cmd_explorer_rows. So cmd_rollup_writer
-- gets a COLUMN-LEVEL SELECT on row_fingerprint ONLY (never the PHI ciphertext columns)
-- plus a writer SELECT policy (§5).
GRANT USAGE ON SCHEMA staging TO cmd_rollup_writer;
GRANT USAGE ON SCHEMA staging TO claims_reader;  -- self-contained (001 grants table SELECT only)
REVOKE ALL ON staging.era_835_adjustment
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON staging.era_835_adjustment TO claims_reader;
GRANT INSERT ON staging.era_835_adjustment TO cmd_rollup_writer;
GRANT SELECT (row_fingerprint) ON staging.era_835_adjustment TO cmd_rollup_writer;

-- 5. RLS ----------------------------------------------------------------------
-- Tenant isolation by the app.business_entity_id GUC (set transaction-locally by
-- the ingest before writing, and by any reader), matching every staging.* table.
-- The GRANTs above are the real privilege boundary; policies satisfy RLS per role.
ALTER TABLE staging.era_835_adjustment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS era_835_reader_isolation ON staging.era_835_adjustment;
CREATE POLICY era_835_reader_isolation ON staging.era_835_adjustment
  FOR SELECT TO claims_reader
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS era_835_writer_insert ON staging.era_835_adjustment;
CREATE POLICY era_835_writer_insert ON staging.era_835_adjustment
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- Writer SELECT policy — required so the ON CONFLICT (row_fingerprint) arbiter can see
-- an existing row (paired with the column-level SELECT grant above, which limits the
-- writer to reading row_fingerprint only — never the PHI ciphertext). Mirrors 0021.
DROP POLICY IF EXISTS era_835_writer_select ON staging.era_835_adjustment;
CREATE POLICY era_835_writer_select ON staging.era_835_adjustment
  FOR SELECT TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- 6. Verification (run manually after deploy) ---------------------------------
-- SELECT count(*) FROM staging.era_835_adjustment;                         -- expect 0 fresh
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname='staging' AND tablename='era_835_adjustment';         -- reader SELECT + writer INSERT
-- \d+ staging.era_835_adjustment                                           -- columns, checks, indexes
