-- =============================================================================
-- Migration 024: staging.expected_payment_manual — SUPER-ADMIN edits to the
--   upcoming-payment forecast, in a table the sheet sync can never touch.
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Rollback: 024_expected_payment_manual_rollback.sql
--
-- 024 is the next free Veris number: `SQL Schemas/` tops out at 023
-- (023_expected_payment_override.sql + rollback). CONFIRM AGAINST THE LIVE DB BEFORE
-- APPLYING — 023 is authored but MAY NOT BE APPLIED YET, so check both:
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema='staging' AND table_name LIKE 'expected_payment%';
--
-- WHY THIS IS A SECOND TABLE AND NOT COLUMNS ON 023. 023 is REPLACE-PER-SYNC: every run of
--   /api/cron/upcoming-overrides DELETEs the tenant's rows and re-inserts the sheet's current
--   parse, because the hand-edited sheet has no stable row identity. Anything a super admin
--   wrote into that table would therefore be destroyed within the hour. Scoping the sync's
--   DELETE to a source column was the alternative and was rejected (Alec, 2026-08-03): it
--   puts a machine-replaced row and a hand-authored row in one table under one policy set,
--   where a single bug in the DELETE predicate silently eats operator edits. Two tables, two
--   owners, no shared failure mode. The cron does not have DELETE on THIS table at all —
--   §6 grants it nothing, which is the structural guarantee.
--
-- THE THREE KINDS. One row shape, discriminated by `kind`. (facility_code, payer_label,
--   expected_date) is BOTH the match key and the payload in all three cases:
--     'add'       a forecast neither feed knows about. Matches no sheet row; amount required.
--     'correct'   the sheet row identified by the match key is wrong; amount replaces it.
--     'suppress'  hide the sheet row identified by the match key. amount MUST be null.
--
--   RESOLUTION IS THE APP'S JOB, NOT A VIEW'S. The match key is content, not identity, so an
--   operator editing the sheet's date makes a 'correct'/'suppress' stop matching. That is
--   unavoidable (see 023 §3) and is handled by SURFACING it: the resolver marks an unmatched
--   correct/suppress STALE and the UI shows it as such. A stale 'correct' is NOT promoted to
--   an 'add' — a correction is a statement ABOUT a sheet row, and without the row it asserts
--   nothing. Do not "helpfully" resurrect it.
--
-- SUPPRESSION IS NOT RECONCILIATION. 'suppress' with reason 'landed' is a HUMAN saying the
--   money arrived. Nothing in this migration matches a forecast to an 835 automatically:
--   payer_label ('BCBS') and era_835_payment.payer_name ('BLUE CROSS OF CALIFORNIA (CA)') do
--   not join reliably, and a wrong automatic match silently deletes money from a forecast.
--   The app SUGGESTS matches and a super admin confirms (Alec, 2026-08-03). 023's
--   additive-only ruling therefore still holds: nothing is ever hidden without a named actor.
--
-- PHI DISCIPLINE. Same posture as 023 and for the same reason: this feeds a tile declared
--   "Non-PHI throughout". NO PATIENT COLUMN, and deliberately NO FREE-TEXT NOTE COLUMN — a
--   note field on a payments row is an open invitation to type "check for Marcus W", which
--   would silently promote the tile into PHI scope through a column nobody classified. The
--   structured `suppress_reason` enum carries the only explanation the UI needs.
--   ⚠️ DO NOT ADD a note/comment/patient/member/claim column here. If an explanation genuinely
--   needs prose, that is a PHI-classified table with 021's encryption + blind-index treatment.
--
-- WHO WROTE IT. created_by / updated_by are auth user UUIDs (claims.app_user.id), so every
--   row names a real actor. Authorization (super_admin only) is enforced in
--   app/lib/actions.ts, and every mutation ALSO writes a claims.access_audit row — the same
--   two-layer posture as upsert_app_user (0025/0055). The DB functions below are the narrow
--   write surface; they do not decide policy.
--
-- OWNERSHIP: born owned by claims_admin via SET ROLE (§2), matching 013–023. Table-level
--   GRANTs and the function GRANTs run as postgres OUTSIDE the SET ROLE block.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE
--   POLICY; CREATE OR REPLACE FUNCTION; roles created only-if-absent (never DROP ROLE);
--   REVOKE/GRANT reapplied unconditionally.
--
-- DEPENDENCY: 001 (staging + claims_reader), 014 (core.business_entity), 023 (the sheet feed
--   this corrects — NOT a FK, the two tables are deliberately unjoined; see THE THREE KINDS).
--   Additive and empty on create.
-- =============================================================================

-- 1. Roles (privilege-only; created only-if-absent). ---------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_reader') THEN
    CREATE ROLE claims_reader NOLOGIN;
  END IF;
END $$;

-- 2. Objects are born owned by claims_admin. ----------------------------------
SET ROLE claims_admin;

-- =============================================================================
-- 3. staging.expected_payment_manual
-- =============================================================================
CREATE TABLE IF NOT EXISTS staging.expected_payment_manual (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_entity_id    uuid        NOT NULL
                          REFERENCES core.business_entity(id) ON DELETE RESTRICT,

  kind                  text        NOT NULL
                          CHECK (kind IN ('add', 'correct', 'suppress')),

  -- The match key AND the payload. Canonical facility_code (same vocabulary as 023 — the
  -- app resolves the label through the SAME alias table, never a raw sheet string).
  facility_code         text        NOT NULL CHECK (char_length(facility_code) BETWEEN 1 AND 64),
  payer_label           text        NOT NULL CHECK (char_length(payer_label) BETWEEN 1 AND 200),
  expected_date         date        NOT NULL,

  -- 'EFT' | 'Check' — 023's sheet vocabulary, NOT an X12 BPR04 code. Required for 'add'
  -- (a new forecast must say how the money arrives); optional for 'correct' (null = keep
  -- the sheet's method); meaningless for 'suppress'.
  method_label          text        CHECK (method_label IN ('EFT', 'Check')),

  -- numeric(12,2), never float. Required for add/correct, MUST be null for suppress.
  amount                numeric(12,2) CHECK (amount IS NULL OR amount > 0),

  -- Why a row is hidden. Structured on purpose — see the PHI note in the header.
  --   'landed'    the money arrived; an 835 now covers it (confirmed by a human)
  --   'incorrect' the sheet row was wrong and is not coming
  --   'cancelled' the payer withdrew or rescheduled it away
  suppress_reason       text        CHECK (suppress_reason IN ('landed', 'incorrect', 'cancelled')),

  -- Provenance of a confirmed 'landed' suppression: the era_835_payment natural key the
  -- human agreed it matched, as 'date|facility|payer'. TRACEABILITY ONLY, never a join key —
  -- the ERA row it names may itself be re-ingested. Null for every other kind/reason.
  matched_era_key       text        CHECK (matched_era_key IS NULL OR char_length(matched_era_key) <= 400),

  created_by            uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- PER-KIND SHAPE, ENFORCED BY THE DB rather than by hope. An 'add' with no amount, or a
  -- 'suppress' carrying money, is a malformed statement about the forecast — the sort of row
  -- that would render as "$0.00 expected" or silently hide money while claiming to add it.
  CONSTRAINT expected_payment_manual_kind_shape_ck CHECK (
    (kind = 'add'      AND amount IS NOT NULL AND method_label IS NOT NULL
                       AND suppress_reason IS NULL AND matched_era_key IS NULL)
    OR
    (kind = 'correct'  AND amount IS NOT NULL
                       AND suppress_reason IS NULL AND matched_era_key IS NULL)
    OR
    (kind = 'suppress' AND amount IS NULL AND method_label IS NULL
                       AND suppress_reason IS NOT NULL
                       AND (suppress_reason = 'landed' OR matched_era_key IS NULL))
  )
);

-- ONE decision per (tenant, kind, match key). A second 'suppress' for the same sheet row is
-- not new information, and two 'correct' rows for one target would make the resolved amount
-- depend on scan order — a money figure that changes between page loads. Re-deciding is an
-- UPDATE through the function below, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS expected_payment_manual_decision_uidx
  ON staging.expected_payment_manual
     (business_entity_id, kind, facility_code, payer_label, expected_date);

-- Read index: leads with business_entity_id (the 018 rule), then the date the tile windows on.
CREATE INDEX IF NOT EXISTS expected_payment_manual_upcoming_idx
  ON staging.expected_payment_manual (business_entity_id, expected_date);

COMMENT ON TABLE staging.expected_payment_manual IS
$t$SUPER-ADMIN edits to the upcoming-payment forecast: add a payment neither feed knows about, correct a sheet row's amount, or suppress a sheet row that landed or was wrong.

A SEPARATE TABLE FROM 023 ON PURPOSE. 023 is replace-per-sync — the hourly cron DELETEs the tenant's rows and re-inserts the sheet parse — so a hand-authored row there would be destroyed within the hour. The cron has NO privilege on this table at all, which is the structural guarantee rather than a careful predicate.

MATCH KEY IS CONTENT, NOT IDENTITY. (facility_code, payer_label, expected_date) identifies the targeted sheet row. Editing that sheet row's date breaks the link; the resolver marks the orphan STALE and the UI shows it. A stale 'correct' is NOT promoted to an 'add' — a correction is a statement about a sheet row and asserts nothing without it.

NOT AUTOMATIC RECONCILIATION. 'suppress' with reason 'landed' is a HUMAN confirming the money arrived. payer_label and era_835_payment.payer_name do not join reliably, so the app suggests and a super admin confirms. 023's additive-only ruling holds: nothing is hidden without a named actor.

NON-PHI BY CONSTRUCTION: no patient column and NO FREE-TEXT NOTE column — a note field here would collect patient names and silently promote this tile into PHI scope. Structured suppress_reason only.$t$;

COMMENT ON COLUMN staging.expected_payment_manual.kind IS
  '''add'' = a forecast neither the 835 feed nor the sheet knows about (matches nothing by design). ''correct'' = the sheet row at this match key is wrong; amount replaces it. ''suppress'' = hide the sheet row at this match key. The per-kind column shape is DB-enforced by expected_payment_manual_kind_shape_ck.';

COMMENT ON COLUMN staging.expected_payment_manual.matched_era_key IS
  'For a ''landed'' suppression: the 835 remit key (''date|facility|payer'') the confirming human agreed this forecast matched. TRACEABILITY ONLY — deliberately a text stamp and not a FK, because era_835_payment rows are re-ingestable and a FK would either block re-ingest or cascade a human decision away.';

-- 4. RLS ----------------------------------------------------------------------
-- Reader isolation by the app.business_entity_id GUC, matching 013/022/023. There is NO
-- writer policy because there is NO writer ROLE: writes arrive only through the SECURITY
-- DEFINER functions in §5, which run as the owner (claims_admin) and enforce the tenant from
-- their argument. That is the same posture as claims.upsert_app_user (0025/0055).
--
-- No FORCE ROW LEVEL SECURITY: 017's guard fails the whole staging plane if any staging table
-- has it (claims_admin owner-path access must keep owner bypass) — and the functions in §5
-- depend on exactly that bypass.
ALTER TABLE staging.expected_payment_manual ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expected_payment_manual_reader_isolation
  ON staging.expected_payment_manual;
CREATE POLICY expected_payment_manual_reader_isolation ON staging.expected_payment_manual
  FOR SELECT TO claims_reader
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- =============================================================================
-- 5. The narrow write surface — SECURITY DEFINER, owned by claims_admin
-- =============================================================================
-- These are the ONLY way a row is created, changed or removed. They validate shape and
-- tenant; they do NOT decide policy — super-admin authorization lives in app/lib/actions.ts
-- and each call also writes a claims.access_audit row naming the actor. Two layers, matching
-- upsert_app_user: the app decides WHO may act, the DB guarantees WHAT can be written.
--
-- SET search_path = '' on both: a SECURITY DEFINER function without a pinned search_path is
-- the Supabase 0011 advisor finding and a genuine privilege-escalation vector (a caller-set
-- search_path could shadow `staging` with their own schema). Every identifier below is
-- therefore schema-qualified.

CREATE OR REPLACE FUNCTION staging.upsert_expected_payment_manual(
  p_business_entity_id uuid,
  p_kind               text,
  p_facility_code      text,
  p_payer_label        text,
  p_expected_date      date,
  p_method_label       text,
  p_amount             numeric,
  p_suppress_reason    text,
  p_matched_era_key    text,
  p_actor              uuid
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  IF p_business_entity_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'upsert_expected_payment_manual: tenant and actor are required';
  END IF;
  -- The tenant must be a real entity. Without this the function's owner-level bypass would
  -- happily land a row under a typo'd uuid that no reader could ever see or clean up.
  IF NOT EXISTS (SELECT 1 FROM core.business_entity b WHERE b.id = p_business_entity_id) THEN
    RAISE EXCEPTION 'upsert_expected_payment_manual: unknown business_entity_id';
  END IF;

  INSERT INTO staging.expected_payment_manual (
    business_entity_id, kind, facility_code, payer_label, expected_date,
    method_label, amount, suppress_reason, matched_era_key,
    created_by, updated_by
  ) VALUES (
    p_business_entity_id, p_kind, p_facility_code, p_payer_label, p_expected_date,
    p_method_label, p_amount, p_suppress_reason, p_matched_era_key,
    p_actor, p_actor
  )
  -- Re-deciding the same (kind, match key) UPDATES in place — see the unique index note.
  -- created_by/created_at deliberately survive, so the row keeps its first author.
  ON CONFLICT (business_entity_id, kind, facility_code, payer_label, expected_date)
  DO UPDATE SET
    method_label    = excluded.method_label,
    amount          = excluded.amount,
    suppress_reason = excluded.suppress_reason,
    matched_era_key = excluded.matched_era_key,
    updated_by      = excluded.updated_by,
    updated_at      = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION staging.delete_expected_payment_manual(
  p_business_entity_id uuid,
  p_id                 bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted int;
BEGIN
  IF p_business_entity_id IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'delete_expected_payment_manual: tenant and id are required';
  END IF;
  -- The tenant predicate is what stops an id from one tenant being deleted while acting as
  -- another. The function runs as the owner, so RLS is NOT doing this for us.
  DELETE FROM staging.expected_payment_manual m
   WHERE m.id = p_id AND m.business_entity_id = p_business_entity_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  -- false (not an exception) when nothing matched: the caller treats "already gone" as
  -- success-shaped but distinguishable, and a double-click must not raise.
  RETURN v_deleted > 0;
END;
$fn$;

RESET ROLE;

-- 6. Grants -------------------------------------------------------------------
-- Run as postgres, OUTSIDE the SET ROLE block — mirroring 013 §7 / 019 / 022 §6 / 023 §6.
--
-- claims_reader gets SELECT (RLS-scoped) and EXECUTE on both functions: it is the role the
-- app path runs as, exactly as it is for claims.upsert_app_user.
--
-- cmd_rollup_writer gets NOTHING. That is the whole point of the second table: the sheet
-- cron structurally cannot touch a super admin's edits. Do not "tidy" a grant onto it.
GRANT USAGE ON SCHEMA staging TO claims_reader;

REVOKE ALL ON staging.expected_payment_manual
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON staging.expected_payment_manual TO claims_reader;

REVOKE ALL ON FUNCTION staging.upsert_expected_payment_manual(
  uuid, text, text, text, date, text, numeric, text, text, uuid
) FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION staging.delete_expected_payment_manual(uuid, bigint)
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION staging.upsert_expected_payment_manual(
  uuid, text, text, text, date, text, numeric, text, text, uuid
) TO claims_reader;
GRANT EXECUTE ON FUNCTION staging.delete_expected_payment_manual(uuid, bigint)
  TO claims_reader;

-- 7. Verification (run manually after apply) ----------------------------------
-- -- exists, owned by claims_admin, RLS on, FORCE off:
-- SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='staging' AND c.relname='expected_payment_manual';
--   -- expect 1 row, owner=claims_admin, relrowsecurity=t, relforcerowsecurity=f
--
-- SELECT count(*) FROM staging.expected_payment_manual;                   -- expect 0 fresh
--
-- -- THE PHI ASSERTION. Must return ZERO rows, now and forever. Note `note`/`comment` are in
-- -- the pattern deliberately: a free-text column here is the realistic way a name gets in.
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_manual'
--    AND column_name ~* 'patient|client|member|subscriber|claim_number|dob|ssn|name|note|comment';
--   -- expect 0 rows. ANY row is a PHI defect — stop and revert.
--
-- -- THE STRUCTURAL GUARANTEE: the sheet cron cannot touch this table.
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='staging' AND table_name='expected_payment_manual' ORDER BY 1,2;
--   -- expect claims_admin (owner) + claims_reader/SELECT ONLY.
--   -- ANY cmd_rollup_writer row is a defect — that is the role the hourly sync writes as.
--
-- -- both functions are SECURITY DEFINER with a pinned search_path (advisor 0011):
-- SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='staging' AND p.proname LIKE '%expected_payment_manual';
--   -- expect 2 rows, prosecdef=t, proconfig={search_path=""}
--
-- SELECT policyname, cmd FROM pg_policies
--  WHERE schemaname='staging' AND tablename='expected_payment_manual';
--   -- expect exactly ONE row: reader SELECT. No writer policy — writes go through §5.
--
-- -- the per-kind shape constraint actually rejects malformed statements:
-- --   these four must ALL raise:
-- -- SELECT staging.upsert_expected_payment_manual('<bxr>','add','CAMH','UMR',current_date,'EFT',NULL,NULL,NULL,'<uuid>');
-- --   (add with no amount)
-- -- SELECT staging.upsert_expected_payment_manual('<bxr>','suppress','CAMH','UMR',current_date,NULL,100,'landed',NULL,'<uuid>');
-- --   (suppress carrying money)
-- -- SELECT staging.upsert_expected_payment_manual('<bxr>','suppress','CAMH','UMR',current_date,NULL,NULL,NULL,NULL,'<uuid>');
-- --   (suppress with no reason)
-- -- SELECT staging.upsert_expected_payment_manual('00000000-0000-0000-0000-000000000000','add',...);
-- --   (unknown tenant)
--
-- 8. The 023 feed is UNCHANGED by this migration. -----------------------------
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_override';
--   -- expect 11 (per 023) — this migration adds no column there and no FK between them.
-- =============================================================================
