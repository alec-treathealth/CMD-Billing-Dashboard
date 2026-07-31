-- =============================================================================
-- Migration 013: staging.era_835_payment + staging.era_835_adjustment
--                835 ERA landed at BOTH its native grains
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- DB: dbpabchpvipipkzkogta
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Rollback: 013_era_835_adjustment_rollback.sql
--
-- Safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before
-- CREATE POLICY; roles created only-if-absent (never DROP ROLE); REVOKE/GRANT
-- reapplied unconditionally. §0 carries an ACTIVE shape guard (see below).
--
-- =============================================================================
-- WHY TWO TABLES (the 2026-07-30 grain audit — do not collapse them back)
-- =============================================================================
-- An 835 carries TWO grains that cannot share one row:
--
--   PAYMENT grain  — the BPR/TRN envelope. EXACTLY ONE per ST/SE transaction set.
--                    BPR02 is the amount of money that actually moves.
--   ADJUSTMENT grain — the CAS triplets. MANY per remit (dozens to hundreds for a
--                    multi-claim OON behavioral-health remit).
--
-- The first draft of this migration stored ONLY the adjustment grain, with all
-- seven envelope fields denormalized onto every triplet row. That shape has two
-- independent, money-critical defects:
--
--   1. INFLATION — sum(payment_amount) over the adjustment table multiplies each
--      remit's BPR02 by its triplet count. Measured shape: 10-100x, and the factor
--      VARIES per remit, so no constant or ratio corrects it. This is the same
--      class of bug as the posting-grain-vs-charge-grain error on
--      collections.cmd_explorer_rows (which produced 197-1927% paid figures and
--      was fixed by max()-per-charge in cmd_explorer_charge_rollup) — but worse,
--      because the multiplier here is far larger.
--
--   2. TRUNCATION — adjustment rows are emitted ONLY from inside pushAdj()
--      (src/ingest/era_ingest.ts). A remit whose claims all adjudicated clean has
--      ZERO CAS triplets, therefore ZERO rows, therefore its BPR02 NEVER LANDS AT
--      ALL. Clean-paid remits carry the most money. test/era835.test.ts already
--      documents the parser side of this ("Claim B fully paid, no CAS").
--
-- Defect 1 alone might have been survivable with a per-remit DISTINCT ON. Defect 2
-- is not: no dedup key can recover a row that was never inserted. And no sound
-- dedup key existed anyway — row_fingerprint is per-triplet BY CONSTRUCTION (it
-- hashes adjustment_index + carc_code + amount specifically to keep byte-identical
-- triplets distinct); TRN02 is payer-scoped, not global; and
-- (payer + BPR16 + BPR02) collides on per-NPI payment splits and reissued checks.
--
-- So the payment envelope gets its own table at its own grain, written
-- UNCONDITIONALLY per parsed transaction — before and independent of whether any
-- CAS triplet survives mapping. staging.era_835_payment is the ONLY authoritative
-- source of remitted dollars. staging.era_835_adjustment FKs to it and
-- DELIBERATELY HAS NO payment_amount COLUMN: the wrong sum is now unwritable
-- rather than merely discouraged.
--
-- =============================================================================
-- WHY NOT staging.era_adjustment
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
-- So this migration LANDS the 835 at its own native grains, additively, and keeps a
-- NULLABLE reconciliation link (claim_line_id / patient_control_number) to be
-- resolved to the CMD charge ledger ASYNCHRONOUSLY — the standard RCM pattern:
-- stage the remittance as received, match to charges later. Column names mirror
-- staging.era_adjustment (carc_code / carc_type) so a future reconciled UNION /
-- Brain-2 upgrade is natural. Wiring this into mv_payer_drift is deliberately OUT
-- OF SCOPE here (payer_dim.participates_in_era stays the switch for that).
--
-- =============================================================================
-- COMPLIANCE (root CLAUDE.md standing rules, mirrors 019 + 001)
-- =============================================================================
--   HIPAA:  patient_name_enc / member_id_enc are libsodium secretbox ciphertext
--           (nonce‖ciphertext bytea), encrypted IN-PROCESS before INSERT by
--           src/collections/phiCrypto.ts. LIBSODIUM_KEY never lives in the DB, so a
--           DB-only compromise (incl. a leaked claims_reader credential) cannot
--           recover patient identifiers. The patient_control_number / payer claim
--           control number are BUSINESS claim identifiers (like claim_line.claim_id),
--           not patient identifiers — stored plaintext for reconciliation, matching
--           the existing convention.
--           staging.era_835_payment holds NO PHI AT ALL: the BPR/TRN/N1*PR envelope
--           is payer-and-money only. It therefore needs no ciphertext columns and no
--           audited-reveal path. Keep it that way — never add a patient column here.
--   SOC 2:  created/ingest audit columns on both tables.
--   RLS:    enabled on both; claims_reader row isolation by business_entity_id GUC
--           (app.business_entity_id), matching every other staging.* table.
--   OWASP:  no dynamic SQL in the ETL; all writes parameterized; every text column
--           is length-bounded (CHECK); money is numeric(12,2), never float;
--           timestamps timestamptz.
--   PostgREST: the `staging` schema MUST stay OFF Supabase's exposed-schemas list
--           (same posture as the rest of staging/claims). PHI-bearing even encrypted.
--
-- OWNERSHIP: objects are born owned by claims_admin via SET ROLE (§2), matching
--   014-020 and required by 017's FORCE-RLS/owner-bypass posture. The FIRST DRAFT OF
--   THIS FILE OMITTED `SET ROLE claims_admin` — it was the only Veris migration that
--   did, and it would have created both tables owned by `postgres`, leaving them
--   outside the ownership census every later staging migration assumes. Fixed here.
--   Schema-level and table-level GRANTs run as postgres OUTSIDE the SET ROLE block,
--   mirroring 019 exactly (the proven-applied grant path in this cluster).
--
-- TENANCY: both tables carry business_entity_id uuid NOT NULL with an FK to
--   core.business_entity(id) ON DELETE RESTRICT. 016 added that FK to the 9 live
--   staging tables and explicitly EXCLUDED these ("013's era_835 table is NOT
--   live"), on the understanding that 013 would carry its own FK when it landed.
--   This is that FK. Composite indexes lead with business_entity_id per 018.
--
-- Idempotency of the INGEST: ON CONFLICT (row_fingerprint) DO NOTHING on both
-- tables, over two DIFFERENT fingerprints at two different grains (see the
-- era_835_payment.row_fingerprint comment for the payment field set and why
-- era_source_file is deliberately excluded from it).
--
-- =============================================================================
-- ⚠️ READ-PATH CONTRACT — binds every query that sums money from this migration
-- =============================================================================
-- era_835_payment.payment_amount is NULLABLE (a malformed/out-of-range BPR02 must
-- still land the remit — see defect 2). sum() SILENTLY SKIPS NULLs, so such a remit
-- contributes $0 to any aggregate and the surface above it understates while looking
-- authoritative. The ingest counter (payments_amount_out_of_range) is in the INGEST
-- path; a dashboard tile cannot see it.
--
--   ANY query summing payment_amount MUST also return, over the SAME window and
--   filters, count(*) FILTER (WHERE payment_amount IS NULL) — and the UI MUST show
--   that count when it is > 0. A sum presented without it is a floor, not a total.
--
-- payment_amount_raw holds the original figure for any such row, so "unquantified"
-- never means "unknowable". Restated on the payment_amount / payment_amount_raw column
-- comments (where a query author will actually be looking) and mirrored in
-- docs/veris-data-notes.md.
--
-- =============================================================================
-- ⚠️ FINGERPRINT STABILITY ASSUMPTIONS — what the remit key rests on
-- =============================================================================
-- The remit fingerprint's ONE job is to be IDENTICAL for the same logical remit across
-- re-pulls. Two of its eight inputs buy disambiguation at the cost of an assumption
-- about the source feed. Both are recorded here because if the assumption breaks the
-- symptom is the INFLATION defect returning — the same class of back door already
-- closed by excluding era_source_file.
--
-- (1) era_control_number (ST02) IS INCLUDED. Why: without it, two ST/SE transaction
--     sets co-located in ONE interchange that happen to share payer + TRN02 + TRN03 +
--     amount + date are indistinguishable, so the second collapses into the first and
--     its money is lost. ST02 is the only field that separates them. That need is real,
--     not hypothetical — a payer splitting one day's payment across sequential
--     transaction sets produces exactly this shape.
--
-- (2) payment_amount_raw IS INCLUDED (BPR02 verbatim). Why: see its column comment —
--     the parsed numeric goes NULL for every unrepresentable BPR02, which collapsed
--     three genuinely different remits into one digest.
--
-- THE ASSUMPTION BOTH REST ON — one assumption, not two:
--     CMD re-serves a given date's 835 content BYTE-STABLY across re-pulls: the same
--     transaction sets, in the same order, with the same ST02 assignment, and the same
--     literal BPR02 text.
--
-- WHY EACH IS FRAGILE IN THE SAME WAY:
--     ST02 is a per-interchange SEQUENCE number that resets per file (see the
--     era_control_number note on era_835_adjustment below). If CMD ever regenerates a
--     date's 835 with a different COUNT or ORDERING of transaction sets, the same remit
--     is re-serialized under a different ST02.
--     payment_amount_raw is literal text: '100.00' and '100.0' are the same money and
--     different bytes.
--     Either way → new digest → a SECOND payment row for a remit already stored →
--     BPR02 COUNTED TWICE.
--
-- OBSERVABLE SYMPTOM + DETECTION SIGNAL:
--     Duplicate payment rows for one remit (same payer/trace/date, two ids), i.e.
--     double-counted BPR02. The signal is in the ingest stats and it is cheap:
--       a re-pull of an already-ingested date MUST report payments_inserted = 0.
--     A re-pull that should have been a total no-op but reports payments_inserted > 0
--     means this assumption has broken. Do not dismiss it as "new data" — for an
--     already-ingested date it is the duplicate-remit signature. Confirm with:
--       SELECT check_eft_trace_number, payment_date, count(*), count(DISTINCT id)
--         FROM staging.era_835_payment
--        GROUP BY 1,2 HAVING count(*) > 1;      -- expect zero rows, always
--
-- WHY WE ACCEPT IT ANYWAY (the deliberate posture, consistent with the rest of this
-- file): of the two failure modes, TRUNCATION is the one no downstream query can ever
-- repair — a remit that never landed is gone. Duplication is detectable (the query
-- above), attributable, and correctable at the read path. So where the two trade off,
-- this migration errs toward retaining a row. Excluding ST02 would trade a detectable
-- duplicate for a silent loss; that is the wrong direction.
--
-- RECONCILING THIS WITH THE era_control_number NOTE ON era_835_adjustment (§4 below):
-- they are NOT in conflict, and both claims are true of the same field:
--     * ST02 is USELESS as a GROUP BY / analytic dimension — it resets per file, so it
--       names nothing durable. That is why keeping it on the adjustment table is
--       harmless (nobody can be misled into grouping remits by it) and why it was NOT
--       treated like check_eft_trace_number, which IS a stable payer-issued identifier
--       and therefore an attractor for the wrong query.
--     * ST02 is USEFUL as a fingerprint DISAMBIGUATOR — precisely because it is
--       positional, it distinguishes two otherwise-identical transaction sets WITHIN
--       one interchange, which is the only place it needs to hold.
-- "Not a durable business identifier" and "a valid local tie-breaker" are the same
-- property viewed from two distances. One coherent position, stated in both places.
--
-- KNOWN, NOT AN OVERSIGHT: payment_amount (field 5) is now REDUNDANT in the
-- fingerprint — it is a pure function of payment_amount_raw (parse + round, or NULL).
-- It contributes no discriminating power that field 6 does not already carry. It is
-- KEPT deliberately: it is harmless, it makes the hashed tuple self-describing next to
-- the stored column, and removing it would be a fingerprint change requiring a full
-- re-ingest for zero benefit. Do not "clean it up" later thinking it was missed.
--
-- =============================================================================

-- DEPENDENCY: 001 (staging schema + claims_reader), 006 (era_adjustment credit
-- grain — column-name parity only), 014 (core.business_entity — the FK target),
-- and 0013 (cmd_rollup_writer role). Append-only on both tables: no UPDATE/DELETE
-- grants to any role.
-- =============================================================================

-- 1. Roles (privilege-only; reuse existing roles, created only-if-absent). -----
--    Runs as postgres: CREATE ROLE needs CREATEROLE, which claims_admin lacks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_reader') THEN
    CREATE ROLE claims_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmd_rollup_writer') THEN
    CREATE ROLE cmd_rollup_writer NOLOGIN;
  END IF;
END $$;

-- 2. Objects are born owned by claims_admin. ----------------------------------
SET ROLE claims_admin;

-- 0. ACTIVE SHAPE GUARD (a comment is not a guard — cf. 016 §1) ---------------
-- This file is idempotent via CREATE TABLE IF NOT EXISTS. That is a TRAP if an
-- earlier draft's era_835_adjustment (the one WITH payment_amount and WITHOUT
-- payment_id) is already present: IF NOT EXISTS would silently skip, leaving the
-- inflating column in place and the FK absent, and the migration would report
-- success. Verified 2026-07-30 that neither table exists live, so this guard should
-- never fire — it exists so that a partial/stale apply FAILS LOUDLY instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'staging' AND table_name = 'era_835_adjustment'
       AND column_name = 'payment_amount'
  ) THEN
    RAISE EXCEPTION
      '013 shape guard: staging.era_835_adjustment already exists with the OLD payment_amount column (pre-grain-audit shape). CREATE TABLE IF NOT EXISTS would silently leave the inflating column in place. Drop the stale table (it is unapplied/empty by record) or migrate it deliberately before re-running 013.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'staging' AND table_name = 'era_835_adjustment'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'staging' AND table_name = 'era_835_adjustment'
       AND column_name = 'payment_id'
  ) THEN
    RAISE EXCEPTION
      '013 shape guard: staging.era_835_adjustment exists but has no payment_id column — a pre-grain-audit table. Resolve deliberately before re-running 013.';
  END IF;
END $$;

-- =============================================================================
-- 3. staging.era_835_payment — THE AUTHORITATIVE MONEY TABLE
-- =============================================================================
-- Grain: ONE ROW PER ST/SE TRANSACTION SET (one 835 remittance = one BPR).
-- payment_amount (BPR02) is the ONLY place remitted dollars may be summed. It is
-- safe to sum precisely because this table has one row per remit by construction.
--
-- Written UNCONDITIONALLY per parsed transaction by src/ingest/era_ingest.ts —
-- BEFORE, and independent of, CAS triplet mapping. A remit with zero surviving
-- triplets (all claims clean-paid, or every triplet skipped for a blank CARC /
-- out-of-spec group code / out-of-range amount) still lands here in full. That
-- unconditional write IS the fix for defect 2; do not make it conditional on
-- adjustment rows existing.
--
-- NO PHI. The BPR/TRN/N1*PR envelope is payer-and-money only.
CREATE TABLE IF NOT EXISTS staging.era_835_payment (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_entity_id       uuid        NOT NULL
                             REFERENCES core.business_entity(id) ON DELETE RESTRICT,

  -- Facility / provenance (resolved from the CMD customer account pulled) --------
  facility_code            text        NOT NULL CHECK (char_length(facility_code) <= 50),
  cmd_customer_id          text        NOT NULL CHECK (char_length(cmd_customer_id) <= 50),

  -- The remittance envelope — the seven fields, at their true grain --------------
  payer_name               text                 CHECK (char_length(payer_name) <= 200),   -- N1*PR N102
  payer_id                 text                 CHECK (char_length(payer_id) <= 80),      -- N1*PR N104
  era_control_number       text                 CHECK (char_length(era_control_number) <= 50),  -- ST02
  check_eft_trace_number   text                 CHECK (char_length(check_eft_trace_number) <= 50), -- TRN02
  trace_originating_company_id text             CHECK (char_length(trace_originating_company_id) <= 50), -- TRN03
  payment_method           text                 CHECK (char_length(payment_method) <= 10),  -- BPR04 (ACH/CHK/NON…)
  payment_amount           numeric(12,2),                                                   -- BPR02 (parsed)
  payment_amount_raw       text                 CHECK (char_length(payment_amount_raw) <= 40), -- BPR02 verbatim
  payment_date             date,                                                            -- BPR16 (effective entry)

  -- Provenance + idempotency + audit --------------------------------------------
  era_source_file          text                 CHECK (char_length(era_source_file) <= 200),
  source                   text        NOT NULL DEFAULT 'cmd_835_api' CHECK (char_length(source) <= 30),
  row_fingerprint          text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  ingested_by              text        NOT NULL CHECK (char_length(ingested_by) <= 100),

  UNIQUE (row_fingerprint)
);

COMMENT ON TABLE staging.era_835_payment IS
  '835 remittance envelope, ONE ROW PER ST/SE TRANSACTION SET (one BPR). THE AUTHORITATIVE SOURCE OF REMITTED DOLLARS — payment_amount (BPR02) is safe to sum here and ONLY here. Written unconditionally per parsed transaction, so a clean-paid remit with zero CAS adjustments still lands. Contains NO PHI. staging.era_835_adjustment FKs to this table and has no payment_amount column by design.';

COMMENT ON COLUMN staging.era_835_payment.payment_amount IS
$pa$BPR02 — the money that actually moves for this remit. numeric(12,2). SAFE TO SUM:
one row per remit by construction. NULLABLE on purpose: a malformed/out-of-numeric-range
BPR02 must still land the remit (a NOT NULL here would reintroduce the truncation defect
this table exists to fix). The ingest counts such rows (payments_amount_out_of_range) and
payment_amount_raw preserves the original figure.

⚠️ READ-PATH CONTRACT — this is not an ingest concern, it binds whoever writes the query.
sum() SKIPS NULLs, so a remit whose BPR02 could not be parsed contributes $0 to any
aggregate SILENTLY, and the tile above it looks authoritative while understating.
payments_amount_out_of_range lives in the ingest stats; the read path cannot see it.

  THEREFORE: any query that sums payment_amount MUST also surface, for the SAME window
  and filters, count(*) FILTER (WHERE payment_amount IS NULL). If that count is > 0 the
  UI must show it — a badge, a footnote, a warning row; not nothing.

  SELECT sum(payment_amount)                                   AS remitted,
         count(*) FILTER (WHERE payment_amount IS NULL)        AS unquantified_remits
    FROM staging.era_835_payment
   WHERE ...;   -- unquantified_remits > 0 ⇒ `remitted` is a FLOOR, not a total

Use payment_amount_raw to investigate any such row. Mirrored in docs/veris-data-notes.md.$pa$;

COMMENT ON COLUMN staging.era_835_payment.payment_amount_raw IS
$par$BPR02 EXACTLY as it appeared in the EDI (trimmed), or NULL when the element was
absent/blank. Two jobs, both load-bearing:

  1. RECOVERY — when BPR02 is outside numeric(12,2) it cannot be stored as a number, and
     without this column the figure would be gone. It is the only record of what the
     payer actually sent, and what the read-path contract above tells you to inspect.

  2. IDENTITY — it is a remit fingerprint input. Hashing only the nullable numeric meant
     BPR02=99999999999.99, BPR02=88888888888.88 and BPR02-absent all produced ONE digest
     (verified 2026-07-30), so two of those three remits were silently discarded by
     ON CONFLICT DO NOTHING while the insert reported success. Note an ABSENT-token alone
     would NOT have fixed that — all three would have shared the token; the distinguishing
     bytes have to survive, which is what this column does.

Text, never numeric — the whole point is holding values numeric(12,2) rejects.$par$;

COMMENT ON COLUMN staging.era_835_payment.trace_originating_company_id IS
  'TRN03 — the payer''s originating company identifier. This is the field X12 provides to QUALIFY TRN02, which is unique only per payer and not globally. Part of row_fingerprint for exactly that reason. Added at authoring time deliberately: adding it after data lands would require a full re-ingest to backfill, because it is a fingerprint input.';

COMMENT ON COLUMN staging.era_835_payment.row_fingerprint IS
$fp$SHA-256 over REMIT-IDENTITY fields only, in this LOCKED order, joined on \x1f
(src/collections/phiCrypto.fingerprintRow — same SHA-256 + \x1f invariant as
cmd_explorer_rows). Non-PHI throughout; the 835 envelope carries no patient data.

  1 cmd_customer_id                       5 payment_amount (fixed-2 string)
  2 payer_id                              6 payment_amount_raw (BPR02 verbatim)
  3 trace_originating_company_id (TRN03)  7 payment_date (ISO)
  4 check_eft_trace_number (TRN02)        8 era_control_number (ST02)

NULL HANDLING — every nullable field above hashes as the explicit token '\x00absent',
NOT as ''. An empty string is a real possible value, so coalescing NULL to '' overloads
one digest input with two meanings AND erases information: fields that go NULL all
contribute the same zero-information token, so two rows differing only in NULL'd fields
collide and the second is silently dropped by ON CONFLICT DO NOTHING. \x00 cannot occur
in X12 element text or in a fixed-2 decimal string, so it can never be a real value.

WHY THESE EIGHT:
  * cmd_customer_id — one CMD customer == one facility. Two facilities can
    legitimately receive remits carrying the same payer trace number; without this
    they would collapse into one row and one facility''s money would vanish.
  * payer_id + TRN03 + TRN02 — TRN02 alone is payer-scoped, NOT global, which is
    precisely why it was rejected as a standalone dedup key. Qualifying it with the
    payer identifier and TRN03 makes it safe.
  * payment_amount + payment_amount_raw + payment_date — guard the case where a payer
    recycles a trace number across genuinely different payments, and keep a corrected
    reissue at a different amount/date as its own remit (append-only history) rather
    than silently deduping it away. BOTH amount columns are hashed: the numeric alone
    goes NULL for every unrepresentable BPR02, which collapsed three genuinely
    different remits into one digest (see payment_amount_raw''s comment).
  * era_control_number (ST02) — separates multiple ST/SE sets within one
    interchange that could otherwise share payer + trace + amount + date.

WHY era_source_file IS DELIBERATELY EXCLUDED — the whole point of this key:
  era_source_file is a DOWNLOAD-TIME name, not a payer-stable identifier. For a raw
  (non-ZIP) payload src/ingest/era_ingest.ts passes the fallback name `${cid}_${date}`,
  literally embedding the PULL DATE; for a ZIP it is the payer''s entry name, which
  can vary between deliveries. Including it would mean the SAME logical remit pulled
  on two different dates (a backfill re-run, a CMD re-delivery) hashes to two
  different fingerprints, inserts TWICE, and double-counts BPR02 — reintroducing the
  inflation defect through the back door. It is stored for provenance only, and under
  ON CONFLICT DO NOTHING the first writer''s value wins.

TRADEOFF, stated honestly: including amount+date errs toward RETAINING a reissued
remit as new history rather than deduping it. That is the deliberate choice — of the
two failure modes, truncation is the one no downstream query can repair. If reissues
are ever observed in practice, fix it in the READ path (pick the latest per
trace number), never by loosening this key.

DEGRADED CASE: TRN is mandatory in 005010X221A1, but real-world files violate specs.
If TRN02/TRN03 arrive blank the key degrades to (customer, payer, amount, date, ST02),
which is weaker but still reasonable. TRN02 is intentionally NOT NOT-NULL — rejecting
a non-conformant remit would be truncation again.

Changing this field set or order silently breaks dedup. Do not change it without a
deliberate full re-ingest.$fp$;

-- =============================================================================
-- 4. staging.era_835_adjustment — the CAS triplet grain
-- =============================================================================
-- Grain: ONE ROW PER CAS ADJUSTMENT TRIPLET (group_code, carc_code, amount,
-- quantity) at either claim (Loop 2100) or service-line (Loop 2110) level.
--
-- PAYMENT CONTEXT IS FK'D, NOT DENORMALIZED-IN-FULL. payment_id points at the one
-- authoritative envelope row. THERE IS DELIBERATELY NO payment_amount COLUMN HERE:
-- it would be denormalized onto every triplet of a remit, so sum(payment_amount)
-- would multiply that remit's money by its triplet count (10-100x, variable). By
-- omitting the column entirely the wrong query does not return a wrong number — it
-- fails to parse. That is the intent; do not re-add it "for convenience".
--
-- A FEW envelope fields ARE still denormalized here, on purpose: payment_date,
-- payer_name, payer_id, payment_method. These are low-cardinality FILTER/GROUPING
-- dimensions, and summing a date or a payer name is not a failure mode — so the
-- flat, join-free queryability the original design wanted is preserved for the
-- CARC/denial analytics this table actually serves. What is NOT preserved is the
-- ability to state a dollar total from this table. For anything money-shaped,
-- join staging.era_835_payment.
--
-- check_eft_trace_number and BPR02 both moved to payment-only. The trace number is
-- pure remit IDENTITY (high-cardinality, one value per remit), not a filter
-- dimension: the only reason to touch it is to identify a remit, and that is now
-- what the FK is for. Leaving it here would be a half-measure that keeps signalling
-- "remit-level analysis happens on this table" after the column that made such
-- analysis wrong has been removed.
--
-- WHY era_control_number (ST02) STAYS, when the trace number did not. Both are
-- per-transaction-set values, so the two look like the same category — this is the
-- distinction, recorded so it is not re-litigated from scratch later:
--
--   TRN02 is a STABLE, PAYER-ISSUED REMIT IDENTIFIER. It is exactly the column someone
--   reaches for to `GROUP BY` believing they are grouping by remit — which is how the
--   inflated per-triplet money sums would have been rediscovered. It is an attractor
--   for the wrong query, so it goes.
--
--   ST02 is NOT a business identifier at all. It is a per-interchange sequence number
--   ('0001', '0002', …) that RESETS in every file, so it cannot identify a remit on its
--   own and nobody can be misled into grouping by it. What it is good for is debugging:
--   given one adjustment row, ST02 + era_source_file names the exact transaction set in
--   the exact file that produced it, WITHOUT dereferencing the FK — which matters when
--   triaging a parse complaint against a raw 835. That is a real, narrow, non-money use,
--   so it is RETAINED DELIBERATELY, not by oversight.
--
-- ST02 is ALSO a fingerprint input on era_835_payment, where it disambiguates multiple
-- ST/SE sets in one interchange. That may read as arguing both sides — it is not. The
-- same property ("positional, resets per file, names nothing durable") is what makes it
-- useless as a GROUP BY dimension AND valid as a local tie-breaker inside one
-- interchange. The full reconciliation, plus the byte-stability assumption that
-- inclusion rests on and the re-pull signal that detects it breaking, is in the
-- FINGERPRINT STABILITY ASSUMPTIONS block in this file's header. Read that before
-- changing either decision.
--
-- facility_code is resolved from the CMD customer the 835 was pulled for (one CMD
-- customer == one facility; src/collections/cmdCustomers.ts) — never name-parsed.
-- business_entity_id is the tenant (BXR today).
CREATE TABLE IF NOT EXISTS staging.era_835_adjustment (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_entity_id       uuid        NOT NULL
                             REFERENCES core.business_entity(id) ON DELETE RESTRICT,

  -- The authoritative payment envelope. NOT NULL: an adjustment cannot exist
  -- without the remit that carried it, and the ingest writes the payment row first
  -- inside the same transaction, so there is never a legitimate orphan.
  payment_id               bigint      NOT NULL
                             REFERENCES staging.era_835_payment(id) ON DELETE RESTRICT,

  -- Facility / provenance (resolved from the CMD customer account pulled) --------
  facility_code            text        NOT NULL CHECK (char_length(facility_code) <= 50),
  cmd_customer_id          text        NOT NULL CHECK (char_length(cmd_customer_id) <= 50),

  -- Denormalized envelope FILTER context (see the table comment above) -----------
  -- NO payment_amount. NO check_eft_trace_number. Both live on era_835_payment.
  payer_name               text                 CHECK (char_length(payer_name) <= 200),
  payer_id                 text                 CHECK (char_length(payer_id) <= 80),
  era_control_number       text                 CHECK (char_length(era_control_number) <= 50),  -- ST02
  payment_method           text                 CHECK (char_length(payment_method) <= 10),      -- BPR04
  payment_date             date,                                                                -- BPR16

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
  '835-sourced CARC/RARC adjustments, one row per CAS triplet (claim/line level). Native 835 adjustment grain; NOT the CMD charge/credit grain of staging.era_adjustment. Payment context is FK''d via payment_id → staging.era_835_payment; there is DELIBERATELY NO payment_amount column here, because denormalizing BPR02 onto every triplet makes sum() overstate each remit by its triplet count (10-100x, variable). Sum money on era_835_payment only. A few low-cardinality envelope fields (payment_date, payer_name, payer_id, payment_method) remain denormalized as filter context. PHI (patient_name/member_id) app-layer encrypted. claim_line_id is a nullable, async-resolved reconciliation link. Idempotent on row_fingerprint.';
COMMENT ON COLUMN staging.era_835_adjustment.payment_id IS
  'FK → staging.era_835_payment(id), the ONE envelope row for this remit. Join here for BPR02/trace number; both were removed from this table so that a per-triplet money sum is unwritable rather than merely discouraged.';
COMMENT ON COLUMN staging.era_835_adjustment.carc_code IS
  'CARC (or RARC) code, bare numeric e.g. ''45'' — NEVER the ''CO-45'' display form. Join ref.remittance_code ON code = carc_code AND code_type = carc_type.';
COMMENT ON COLUMN staging.era_835_adjustment.claim_line_id IS
  'Nullable FK to staging.claim_line, resolved asynchronously by matching patient_control_number → claim_line.claim_id (or charge). NULL at ingest — the 835 carries no CMD charge/credit id.';
COMMENT ON COLUMN staging.era_835_adjustment.adjustment_amount IS
  'CAS monetary amount for this code, SIGN PRESERVED (reversals/corrections are negative). Never ABS or drop — Brain 2 needs the sign. This is the ADJUSTMENT amount, not the remitted amount: it is per-triplet and must never be confused with era_835_payment.payment_amount.';
COMMENT ON COLUMN staging.era_835_adjustment.row_fingerprint IS
  'SHA-256 over the NON-PHI per-TRIPLET identity fields (see src/ingest/era_ingest.era835Fingerprint for the locked 15-field order). Per-triplet BY CONSTRUCTION — it hashes adjustment_index/carc_code/amount specifically so byte-identical triplets stay distinct rows. NOT usable as a per-remit dedup key; that is what era_835_payment.row_fingerprint is for.';

-- 5. Indexes ------------------------------------------------------------------
-- Composite indexes lead with business_entity_id (018 index-leadership rule):
-- every read runs under RLS with business_entity_id = <GUC>.
-- unique(row_fingerprint) already indexes the dedup lookup on both tables.

-- era_835_payment — the money reads.
-- Upcoming payments (BPR16 in the future) per facility, and book-wide.
CREATE INDEX IF NOT EXISTS era_835_payment_facility_date
  ON staging.era_835_payment (business_entity_id, facility_code, payment_date);
CREATE INDEX IF NOT EXISTS era_835_payment_date
  ON staging.era_835_payment (business_entity_id, payment_date);
CREATE INDEX IF NOT EXISTS era_835_payment_payer
  ON staging.era_835_payment (business_entity_id, payer_name);
-- Remit lookup by trace number (the identity path that moved off the adjustment table).
CREATE INDEX IF NOT EXISTS era_835_payment_trace
  ON staging.era_835_payment (business_entity_id, check_eft_trace_number);

-- era_835_adjustment — CARC analytics + the FK join.
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
-- Triplets of one remit (the FK join direction actually used).
CREATE INDEX IF NOT EXISTS era_835_payment_id
  ON staging.era_835_adjustment (payment_id);
-- Reconciliation lookups.
CREATE INDEX IF NOT EXISTS era_835_patient_control
  ON staging.era_835_adjustment (business_entity_id, patient_control_number);
CREATE INDEX IF NOT EXISTS era_835_claim_line
  ON staging.era_835_adjustment (claim_line_id)
  WHERE claim_line_id IS NOT NULL;

-- 6. RLS ----------------------------------------------------------------------
-- Tenant isolation by the app.business_entity_id GUC (set transaction-locally by
-- the ingest before writing, and by any reader), matching every staging.* table.
-- The GRANTs in §7 are the real privilege boundary; policies satisfy RLS per role.
--
-- NOTE on the policy SHAPE vs 017. 017 recreated the 9 live staging policies as a
-- single FOR ALL <table>_isolation policy with USING + WITH CHECK, because those
-- tables' only writer is claims_admin, the OWNER, which bypasses RLS entirely.
-- These two tables are different: their writer is cmd_rollup_writer, a NON-OWNER
-- least-privilege role, so RLS genuinely binds on the write path and the role needs
-- explicit INSERT + SELECT policies (the SELECT one is required by the ON CONFLICT
-- arbiter — see §7). The reader policy keeps 017's explicit-predicate posture. This
-- is the established pattern for this ingest path, not a new one.
ALTER TABLE staging.era_835_payment    ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging.era_835_adjustment ENABLE ROW LEVEL SECURITY;

-- Neither table gets FORCE ROW LEVEL SECURITY: 017's active guard fails the whole
-- staging plane if any staging table has it, because claims_admin owner-path writes
-- (backfills, async claim_line reconciliation) must keep owner bypass.

DROP POLICY IF EXISTS era_835_payment_reader_isolation ON staging.era_835_payment;
CREATE POLICY era_835_payment_reader_isolation ON staging.era_835_payment
  FOR SELECT TO claims_reader
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS era_835_payment_writer_insert ON staging.era_835_payment;
CREATE POLICY era_835_payment_writer_insert ON staging.era_835_payment
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS era_835_payment_writer_select ON staging.era_835_payment;
CREATE POLICY era_835_payment_writer_select ON staging.era_835_payment
  FOR SELECT TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS era_835_reader_isolation ON staging.era_835_adjustment;
CREATE POLICY era_835_reader_isolation ON staging.era_835_adjustment
  FOR SELECT TO claims_reader
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS era_835_writer_insert ON staging.era_835_adjustment;
CREATE POLICY era_835_writer_insert ON staging.era_835_adjustment
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- Writer SELECT policy — required so the ON CONFLICT (row_fingerprint) arbiter can see
-- an existing row (paired with the column-level SELECT grant in §7, which limits the
-- writer to non-PHI columns only). Mirrors 0021.
DROP POLICY IF EXISTS era_835_writer_select ON staging.era_835_adjustment;
CREATE POLICY era_835_writer_select ON staging.era_835_adjustment
  FOR SELECT TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

RESET ROLE;

-- 7. Grants -------------------------------------------------------------------
-- Run as postgres, OUTSIDE the SET ROLE block — mirroring 019, the proven-applied
-- grant path in this cluster.
--
-- Strip default/public grants, then grant precisely. claims_reader gets SELECT (it
-- reads non-PHI columns for the recovery UI, and the two ciphertext columns only on
-- an audited reveal). cmd_rollup_writer gets INSERT only (the daily 835 cron write
-- path) — a minimal, deliberate extension of the existing least-privilege cron
-- writer to two new append-only staging tables. No role gets UPDATE/DELETE. The
-- identity PKs are GENERATED ALWAYS, so INSERT needs no sequence privilege.
--
-- ON CONFLICT arbiter + FK resolution: the ingest INSERTs
-- `ON CONFLICT (row_fingerprint) DO NOTHING` as cmd_rollup_writer. Postgres evaluates
-- the arbiter, which requires the writer to (a) have SELECT on the arbiter column and
-- (b) pass a SELECT RLS policy — the exact failure supabase/migrations/0021 fixed for
-- cmd_explorer_rows. On era_835_payment the writer additionally needs SELECT on `id`,
-- because a conflicting (already-present) payment row returns nothing from
-- `DO NOTHING RETURNING id`, so the ingest re-reads the id by fingerprint to attach
-- that pull's adjustment rows. Both are COLUMN-LEVEL grants — never the PHI
-- ciphertext columns on era_835_adjustment.
--
-- Deliberately NOT granting UPDATE to support an upsert-returning trick: keeping the
-- tables strictly append-only is worth the extra SELECT.
GRANT USAGE ON SCHEMA staging TO cmd_rollup_writer;
GRANT USAGE ON SCHEMA staging TO claims_reader;  -- self-contained (001 grants table SELECT only)

REVOKE ALL ON staging.era_835_payment
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON staging.era_835_payment TO claims_reader;
GRANT INSERT ON staging.era_835_payment TO cmd_rollup_writer;
GRANT SELECT (id, row_fingerprint) ON staging.era_835_payment TO cmd_rollup_writer;

REVOKE ALL ON staging.era_835_adjustment
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON staging.era_835_adjustment TO claims_reader;
GRANT INSERT ON staging.era_835_adjustment TO cmd_rollup_writer;
GRANT SELECT (row_fingerprint) ON staging.era_835_adjustment TO cmd_rollup_writer;

-- 8. Verification (run manually after apply) ----------------------------------
-- -- both tables exist, owned by claims_admin:
-- SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='staging' AND c.relname IN ('era_835_payment','era_835_adjustment');
--   -- expect 2 rows, owner=claims_admin, relrowsecurity=t, relforcerowsecurity=f
--
-- -- THE POINT OF THIS MIGRATION — payment_amount must NOT exist on the adjustment table:
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='era_835_adjustment'
--    AND column_name IN ('payment_amount','check_eft_trace_number');   -- expect 0
--
-- -- and it MUST exist on the payment table:
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='era_835_payment'
--    AND column_name IN ('payment_amount','payment_amount_raw','trace_originating_company_id');
--   -- expect 3
--
-- -- the read-path contract, as the shape every money query must follow:
-- SELECT sum(payment_amount)                            AS remitted,
--        count(*) FILTER (WHERE payment_amount IS NULL) AS unquantified_remits
--   FROM staging.era_835_payment;   -- expect 0 / 0 fresh; unquantified > 0 ⇒ show it in the UI
--
-- SELECT count(*) FROM staging.era_835_payment;                        -- expect 0 fresh
-- SELECT count(*) FROM staging.era_835_adjustment;                     -- expect 0 fresh
--
-- -- tenancy FKs onto core.business_entity (016 parity) + the payment FK:
-- SELECT conrelid::regclass AS child, conname, confrelid::regclass AS parent, convalidated
--   FROM pg_constraint
--  WHERE contype='f' AND conrelid::regclass::text LIKE 'staging.era_835%'
--  ORDER BY 1, 2;   -- expect era_835_adjustment→(core.business_entity, era_835_payment, claim_line)
--                   --        era_835_payment   →(core.business_entity)
--
-- SELECT tablename, policyname, cmd,
--        (qual IS NOT NULL) AS has_using, (with_check IS NOT NULL) AS has_with_check
--   FROM pg_policies
--  WHERE schemaname='staging' AND tablename LIKE 'era_835%' ORDER BY 1,2;
--   -- expect 6 rows: payment reader SELECT / writer INSERT / writer SELECT,
--   --                adjustment reader SELECT / writer INSERT / writer SELECT
--
-- -- negative probe (MUST fail 23502 not-null on payment_id; run as claims_admin, ROLLBACK):
-- --   BEGIN; INSERT INTO staging.era_835_adjustment
-- --     (business_entity_id, facility_code, cmd_customer_id, cas_level, group_code,
-- --      carc_code, adjustment_amount, row_fingerprint, ingested_by)
-- --   VALUES ('<bxr-uuid>','CAMH','10027973','CLAIM','CO','45',1.00,'probe','probe');
-- --   ROLLBACK;
-- =============================================================================
