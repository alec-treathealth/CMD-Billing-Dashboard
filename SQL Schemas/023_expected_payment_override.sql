-- =============================================================================
-- Migration 023: staging.expected_payment_override — hand-keyed upcoming-payment
--   forecast rows synced FROM the "Upcoming Payments" Google Sheet.
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- DB: dbpabchpvipipkzkogta
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Rollback: 023_expected_payment_override_rollback.sql
--
-- 023 was the next free Veris number at authoring time: `SQL Schemas/` tops out at 022
-- (022_era_835_ingest_run.sql + its rollback), and CLAUDE.md's migration table states
-- "Veris ML (staging, ref, core) → next number 023". CONFIRM AGAINST THE LIVE DB BEFORE
-- APPLYING (`SELECT ... FROM information_schema.tables WHERE table_schema='staging'`) —
-- 022's header documents that the number was verified three ways for exactly this reason.
--
-- WHY: the Overview tile "ERA-Confirmed Upcoming Payers" can only ever show money that has
--   already arrived as an 835 remittance advice. Ops separately maintains a hand-keyed
--   forward forecast in the "Upcoming Payments" Google Sheet — payments they know are
--   coming (payer confirmed by phone, check in the mail, EFT scheduled) that have no 835
--   yet and therefore CANNOT appear in staging.era_835_payment. Today that forecast is
--   invisible to the app, so the tile systematically understates the next few days.
--
--   This table is the landing zone for that forecast. Same sheet-is-the-editing-surface,
--   app-never-writes-back posture as claims.billing_code_decision (src/billingAudit/
--   decisionSync.ts, Alec's locked ruling 2026-07-13).
--
-- SEMANTICS ARE ADDITIVE-ONLY (Alec, 2026-08-03). A row here is an ADDITIONAL expected
--   payment shown ALONGSIDE the ERA rows — it never suppresses, replaces, or reconciles
--   against a staging.era_835_payment row. There is deliberately NO supersedes/suppress
--   column and NO join to era_835_payment: reconciliation (what happens when a forecast
--   row's money finally lands as an 835) is a SEPARATE, LATER piece of work that Alec has
--   queued. Until it exists, a forecast row whose 835 has landed is DOUBLE-COUNTED if the
--   operator leaves it in the sheet. That is a known, accepted, documented consequence of
--   additive-only — the mitigation is operational (delete the row from the sheet), and the
--   UI must label these rows as forecast, never blend them into the ERA-confirmed total.
--   Do NOT "fix" this by inventing suppression semantics here without re-opening the call.
--
-- WHAT THIS IS NOT: NO schema change to staging.era_835_payment or era_835_adjustment, and
--   no change to staging.era_835_ingest_run. One new table, additive, empty on create.
--   §8 asserts the two ERA tables' column counts are unchanged (18 and 42).
--
-- PHI DISCIPLINE — THE LOAD-BEARING PART OF THIS MIGRATION.
--   The source sheet's `Client` column CONTAINS PHI: patient first name + last initial on
--   4 of its 9 current rows (the other 5 carry the literal batch sentinel `Multiple`).
--   staging.era_835_payment carries no patient columns at all, and src/veris/
--   era835Upcoming.ts declares the whole tile "Non-PHI throughout". Landing a patient name
--   here would silently promote that tile into PHI scope.
--
--   SO THIS TABLE HAS NO PATIENT COLUMN AT ALL. The parser reads the `Client` cell, derives
--   the boolean `is_patient_specific` (false for the `Multiple` sentinel, true otherwise),
--   and DISCARDS the string — it is never stored, never logged, never returned from the
--   sync, and never reaches an LLM prompt. A boolean "this forecast is for one patient
--   rather than a batch" is not PHI: it identifies no one.
--
--   Everything that IS stored is non-PHI billing configuration: facility code, payer
--   label, an expected date, a method label, a dollar amount, and sheet provenance.
--
--   ⚠️ DO NOT ADD a patient_name, client_name, member_id, or claim_number column to this
--   table. If a future surface genuinely needs the patient identity behind a forecast row,
--   that is a new PHI-classified table with its own encryption + blind-index treatment
--   (see 021's member_id_enc / member_id_bidx pattern) — not a column here.
--
-- OWNERSHIP: born owned by claims_admin via SET ROLE (§2), matching 013–022. Table-level
--   GRANTs run as postgres OUTSIDE the SET ROLE block, mirroring 013 §7 / 019 / 022 §6 —
--   the proven-applied grant path in this cluster.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before
--   CREATE POLICY; roles created only-if-absent (never DROP ROLE); REVOKE/GRANT reapplied
--   unconditionally. Re-running is a no-op on an already-applied cluster.
--
-- DEPENDENCY: 001 (staging schema + claims_reader), 013 (cmd_rollup_writer's staging
--   privileges), 014 (core.business_entity — the FK target). Additive and empty on create,
--   so applying AHEAD of the cron deploy is harmless (an un-deployed cron never writes).
--
--   ⚠️ THE CRON THAT WRITES THIS TABLE MUST NOT DEPLOY BEFORE THIS MIGRATION APPLIES.
--   Merging SQL in a PR does NOT apply it (the 0056 incident). The sync is fail-soft, so a
--   too-early deploy degrades to a logged non-fatal error rather than a broken cron — but
--   do not rely on that; apply first.
-- =============================================================================

-- 1. Roles (privilege-only; reuse existing roles, created only-if-absent). -----
--    Runs as postgres: CREATE ROLE needs CREATEROLE, which claims_admin lacks.
--    NO NEW ROLE. cmd_rollup_writer is reused deliberately — it is already the staging
--    plane's least-privilege cron writer (013, 022) and already holds staging USAGE, so
--    this migration adds no new principal to the cluster's privilege surface.
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

-- =============================================================================
-- 3. staging.expected_payment_override — ONE ROW PER SHEET FORECAST ROW
-- =============================================================================
-- Grain: one row per (tenant, sheet row) in the current parse of the override tab.
--
-- REPLACE-PER-SYNC, NOT UPSERT-PER-ROW. The sheet is hand-keyed and has NO stable row
-- identity: an operator inserts a row in the middle, drags rows to reorder, deletes a row
-- that paid. Any natural key we could invent (facility+payer+date+amount) collides the
-- moment two identical forecasts exist, and a source_row_num key silently rewrites the
-- wrong forecast after a single row insertion. So each sync DELETEs the tenant's rows and
-- INSERTs the current parse inside ONE withTenant transaction — the table always mirrors
-- exactly what the sheet says now, and idempotency is structural rather than a key we hope
-- is unique. This is why the writer needs DELETE (see §6) and why this table is NOT
-- append-only like 022's.
CREATE TABLE IF NOT EXISTS staging.expected_payment_override (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_entity_id    uuid        NOT NULL
                          REFERENCES core.business_entity(id) ON DELETE RESTRICT,

  -- What the forecast is ------------------------------------------------------
  -- Resolved to a CANONICAL facility_code by the parser's alias table, never the raw
  -- sheet label: the sheet writes TMHWA / "TMH WA" / DLMH where the roster says
  -- TREAT_WA / DMH. A row whose label does not resolve is REJECTED by the sync and
  -- reported as unmapped — it never lands here mis-attributed or under a made-up code.
  facility_code         text        NOT NULL CHECK (char_length(facility_code) BETWEEN 1 AND 64),

  -- The sheet's `Insurance` cell, trimmed but otherwise VERBATIM (e.g. 'BCBS', 'UHC',
  -- 'Regence', 'BCBS AR'). Deliberately NOT resolved against claims.payer_alias: this is
  -- an operator's shorthand for display next to their own forecast, and forcing it through
  -- alias resolution would drop rows whose shorthand has no alias row. Payer names are
  -- non-PHI.
  payer_label           text        NOT NULL CHECK (char_length(payer_label) BETWEEN 1 AND 200),

  -- The date the operator expects the money. ISO date, parsed strictly from the sheet's
  -- MM/DD/YYYY. NOT NULL: a forecast with no date cannot be placed on the tile's timeline,
  -- so the sync rejects it at parse rather than landing an unplaceable row.
  expected_date         date        NOT NULL,

  -- The sheet's own closed set, NOT an X12 BPR04 code. staging.era_835_payment.
  -- payment_method holds VERBATIM BPR04 ('ACH','CHK','NON','FWT','BOP'); mapping 'EFT'
  -- onto 'ACH' here would assert an X12 provenance this hand-keyed row does not have, and
  -- would make a forecast row indistinguishable from a real remit in a naive query.
  -- Two different vocabularies, kept apart on purpose. Translate at the UI edge.
  method_label          text        NOT NULL CHECK (method_label IN ('EFT', 'Check')),

  -- numeric(12,2), never float (migration convention). Parsed to exact integer cents by
  -- the sheet parser and handed over as fixed-2 text — never through parseFloat.
  -- CHECK > 0: every current sheet row is a positive expected receipt and the workbook
  -- contains no negatives anywhere. A negative "expected payment" would be a takeback,
  -- which is a different concept needing its own design — reject it loudly instead.
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),

  -- THE PHI-DROPPED FLAG. See the PHI DISCIPLINE block in this file's header.
  -- false  = the sheet's `Client` cell was the batch sentinel `Multiple`
  -- true   = the cell named an individual (THE NAME IS NOT STORED — parser discards it)
  is_patient_specific   boolean     NOT NULL,

  -- Provenance ----------------------------------------------------------------
  -- 1-based sheet row this forecast came from. TRACEABILITY ONLY — never a key (see the
  -- replace-per-sync note above). Lets an operator asking "where did this row come from"
  -- be answered without storing any cell content.
  source_row_num        int         NOT NULL CHECK (source_row_num > 1),

  -- sha-256 over the fetched grid. Equal hash across every row ⇒ the sheet is unchanged
  -- and the sync short-circuits to a no-op with zero writes (decisionSync's proven
  -- discipline). Also the "which parse produced this row" stamp.
  sheet_sync_hash       text        NOT NULL CHECK (char_length(sheet_sync_hash) = 64),

  synced_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE staging.expected_payment_override IS
$t$Hand-keyed UPCOMING-PAYMENT FORECAST rows synced read-only FROM the "Upcoming Payments" Google Sheet, for the Overview "ERA-Confirmed Upcoming Payers" tile. Money ops KNOWS is coming but that has no 835 yet, so it cannot exist in staging.era_835_payment.

ADDITIVE-ONLY (Alec, 2026-08-03): these rows display ALONGSIDE ERA rows and never suppress or replace one. There is no supersedes column and no join to era_835_payment by design — ERA reconciliation is separate, later work. Consequence: a forecast row left in the sheet after its 835 lands IS double-counted. The UI must present these as FORECAST, never fold them into the ERA-confirmed total.

NON-PHI BY CONSTRUCTION. The source sheet''s `Client` column holds patient names; this table HAS NO PATIENT COLUMN. The parser derives is_patient_specific and discards the string — never stored, never logged, never sent to an LLM. Do not add a patient/member/claim column here; that would be a new PHI-classified table (see 021''s enc + blind-index pattern).

REPLACE-PER-SYNC: each run DELETEs the tenant''s rows and INSERTs the current parse in one withTenant transaction. The sheet has no stable row identity, so structural replacement is the idempotency mechanism — not a natural key. This table is therefore NOT append-only, unlike staging.era_835_ingest_run.

The sheet stays the ONLY editing surface. The app never writes back (the OAuth grant is spreadsheets.readonly).$t$;

COMMENT ON COLUMN staging.expected_payment_override.facility_code IS
  'CANONICAL facility_code (BXR short code, e.g. TREAT_WA / DMH / PCMH), resolved from the sheet''s free-text label by the parser''s alias table. The sheet and the roster DISAGREE on spelling — sheet TMHWA and "TMH WA" both mean TREAT_WA; sheet DLMH means DMH; sheet "Telehealth MH" means TELEHEALTH_MH. Rows whose label resolves to nothing are REJECTED by the sync and listed in its unmapped_facilities output rather than landing under a guessed code. As of 2026-08-03 the sheet label "Teen Mental Health" resolves to NOTHING and is deliberately absent from the alias table — it needs a business ruling (it may be Indigo''s MY TEEN MENTAL HEALTH, 10034230, which is a DIFFERENT TENANT and must not be silently folded into BXR).';

COMMENT ON COLUMN staging.expected_payment_override.method_label IS
  'The sheet''s own closed set: EFT or Check. NOT an X12 BPR04 code. staging.era_835_payment.payment_method stores verbatim BPR04 (ACH/CHK/NON/FWT/BOP); collapsing EFT onto ACH here would claim an X12 provenance a hand-keyed forecast does not have and would make forecast rows indistinguishable from real remits in a naive union. Keep the vocabularies separate; translate for display at the UI edge.';

COMMENT ON COLUMN staging.expected_payment_override.is_patient_specific IS
  'THE PHI BOUNDARY. false when the sheet''s `Client` cell was the literal batch sentinel `Multiple`; true when it named an individual patient. THE NAME ITSELF IS NEVER STORED — the parser reads the cell, sets this boolean, and discards the string. A boolean identifies no one, so this column is not PHI and the tile stays non-PHI. Do not "enrich" this into a name column.';

COMMENT ON COLUMN staging.expected_payment_override.amount IS
  'Expected receipt in dollars, numeric(12,2) — never float. Parsed to exact integer cents from the sheet''s currency text (both workbook formats: "$35,000.00" with no space and "$ 19,832.60" with one) and handed to the DB as fixed-2 text. CHECK > 0 on purpose: the workbook contains no negatives, and a negative expected payment is a takeback — a different concept that must fail loudly rather than land here. Current sheet values are round thousands, which is itself the signal that this feed is hand-keyed and not machine-derived.';

COMMENT ON COLUMN staging.expected_payment_override.source_row_num IS
  '1-based row number in the override tab this forecast was parsed from. TRACEABILITY ONLY — explicitly NOT an idempotency key: the sheet is hand-edited, so inserting one row shifts every row number below it and a row-number key would rewrite the wrong forecast. CHECK > 1 because row 1 is the header.';

COMMENT ON COLUMN staging.expected_payment_override.sheet_sync_hash IS
  'sha-256 (64 hex chars) over the fetched override grid. When every existing row for the tenant already carries the current hash, the sync is a NO-OP with zero writes — the same cheap change-detection decisionSync uses. Also identifies which parse produced a given row.';

-- 4. Index --------------------------------------------------------------------
-- Composite index LEADS WITH business_entity_id (the 018 index-leadership rule): every
-- read runs under RLS with business_entity_id = <GUC>, and the tile's only query is
-- "this tenant's forecast rows from today forward, in date order" — the exact shape
-- staging.era_835_payment's (business_entity_id, payment_date) index serves for the ERA
-- half of the same tile. Keeps the forward-window scan sargable instead of a seq scan +
-- sort on every Overview render.
CREATE INDEX IF NOT EXISTS expected_payment_override_upcoming_idx
  ON staging.expected_payment_override (business_entity_id, expected_date);

-- 5. RLS ----------------------------------------------------------------------
-- Tenant isolation by the app.business_entity_id GUC, matching 013 and 022 exactly. The
-- writer is cmd_rollup_writer, a NON-OWNER least-privilege role, so RLS genuinely binds on
-- the write path and needs explicit policies.
--
-- UNLIKE 022 this writer DOES need SELECT and DELETE policies: replace-per-sync deletes
-- the tenant's prior rows, and the no-op hash check reads them back. A DELETE policy's
-- USING clause is what stops a writer transaction running under tenant A from deleting
-- tenant B's forecast — which, on a full-replace write path, is the single most damaging
-- thing a GUC mistake could do here. Both are scoped to the GUC, not granted broadly.
--
-- No FORCE ROW LEVEL SECURITY: 017's active guard fails the whole staging plane if any
-- staging table has it (claims_admin owner-path access must keep owner bypass).
ALTER TABLE staging.expected_payment_override ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expected_payment_override_reader_isolation
  ON staging.expected_payment_override;
CREATE POLICY expected_payment_override_reader_isolation ON staging.expected_payment_override
  FOR SELECT TO claims_reader
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS expected_payment_override_writer_select
  ON staging.expected_payment_override;
CREATE POLICY expected_payment_override_writer_select ON staging.expected_payment_override
  FOR SELECT TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS expected_payment_override_writer_insert
  ON staging.expected_payment_override;
CREATE POLICY expected_payment_override_writer_insert ON staging.expected_payment_override
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS expected_payment_override_writer_delete
  ON staging.expected_payment_override;
CREATE POLICY expected_payment_override_writer_delete ON staging.expected_payment_override
  FOR DELETE TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

RESET ROLE;

-- 6. Grants -------------------------------------------------------------------
-- Run as postgres, OUTSIDE the SET ROLE block — mirroring 013 §7 / 019 / 022 §6.
-- Strip default/public grants, then grant precisely.
--
-- NO ROLE GETS UPDATE. Replace-per-sync only ever DELETEs then INSERTs, so an UPDATE
-- privilege would be unused surface on a table the app can otherwise not mutate in place.
-- DELETE is granted (unlike 022's append-only posture) because full replacement IS the
-- idempotency mechanism — see §3. The identity PK is GENERATED ALWAYS, so INSERT needs no
-- sequence privilege (013 §7).
GRANT USAGE ON SCHEMA staging TO cmd_rollup_writer;   -- already held; kept self-contained
GRANT USAGE ON SCHEMA staging TO claims_reader;

REVOKE ALL ON staging.expected_payment_override
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON staging.expected_payment_override TO claims_reader;
GRANT SELECT, INSERT, DELETE ON staging.expected_payment_override TO cmd_rollup_writer;

-- 7. Verification (run manually after apply) ----------------------------------
-- -- exists, owned by claims_admin, RLS on, FORCE off:
-- SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='staging' AND c.relname='expected_payment_override';
--   -- expect 1 row, owner=claims_admin, relrowsecurity=t, relforcerowsecurity=f
--
-- SELECT count(*) FROM staging.expected_payment_override;                 -- expect 0 fresh
--
-- -- THE PHI ASSERTION. Every identity-shaped column name, EXCLUDING the known-good
-- -- boolean flag. This must return ZERO rows, now and forever:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_override'
--    AND column_name ~* 'patient|client|member|subscriber|claim_number|dob|ssn|name'
--    AND column_name <> 'is_patient_specific';
--   -- expect 0 rows. ANY row is a PHI defect — stop and revert.
--
-- -- and the one permitted match is still a BOOLEAN, not a string smuggling a name:
-- SELECT data_type FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_override'
--    AND column_name='is_patient_specific';
--   -- expect exactly: boolean
--
-- -- tenancy FK onto core.business_entity (016 parity):
-- SELECT conname, confrelid::regclass AS parent, convalidated FROM pg_constraint
--  WHERE contype='f' AND conrelid='staging.expected_payment_override'::regclass;
--   -- expect one FK → core.business_entity, convalidated=t
--
-- SELECT policyname, cmd, (qual IS NOT NULL) AS has_using, (with_check IS NOT NULL) AS has_with_check
--   FROM pg_policies WHERE schemaname='staging' AND tablename='expected_payment_override'
--   ORDER BY 1;
--   -- expect exactly 4 rows: reader SELECT (using), writer SELECT (using),
--   -- writer INSERT (with_check), writer DELETE (using).
--
-- -- privileges: reader SELECT; writer SELECT/INSERT/DELETE; nothing else to anyone:
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='staging' AND table_name='expected_payment_override' ORDER BY 1,2;
--   -- expect claims_admin (owner) + claims_reader/SELECT
--   -- + cmd_rollup_writer/{SELECT,INSERT,DELETE} only.
--   -- ANY row granting UPDATE is a defect — this table is replace-only, never mutated.
--
-- -- the method_label CHECK admits exactly the sheet's two values (NOT BPR04 codes):
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='staging.expected_payment_override'::regclass AND contype='c'
--    AND conname LIKE '%method_label%';
--   -- expect CHECK (method_label = ANY (ARRAY['EFT','Check']))
--
-- -- the index leads with the tenant column (018 rule):
-- SELECT indexdef FROM pg_indexes
--  WHERE schemaname='staging' AND indexname='expected_payment_override_upcoming_idx';
--   -- expect (business_entity_id, expected_date)
--
-- 8. THE POINT OF FLAGGING IT: the ERA tables are UNCHANGED by this migration. ---
-- SELECT table_name, count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name IN ('era_835_payment','era_835_adjustment')
--  GROUP BY 1 ORDER BY 1;
--   -- expect era_835_adjustment = 42, era_835_payment = 18  (per 022 §7)
--
-- -- after the cron deploys, the first real sync should look like:
-- SELECT facility_code, payer_label, expected_date, method_label, amount,
--        is_patient_specific, source_row_num, synced_at
--   FROM staging.expected_payment_override ORDER BY expected_date, facility_code;
--   -- expect one row per non-blank data row of the override tab, all dates >= today-ish,
--   -- amounts positive, and NO patient names anywhere in the output.
-- =============================================================================
