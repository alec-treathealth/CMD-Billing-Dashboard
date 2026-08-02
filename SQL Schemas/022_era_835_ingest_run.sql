-- =============================================================================
-- Migration 022: staging.era_835_ingest_run — per-run 835 ingest observability
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- DB: dbpabchpvipipkzkogta
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Rollback: 022_era_835_ingest_run_rollback.sql
--
-- 022 was unclaimed, verified three ways (2026-08-02): origin/main + the working tree
-- incl. untracked files (`SQL Schemas/` tops out at 021); docs/veris-data-notes.md
-- ("021 is now TAKEN + APPLIED … next free Veris number: 022"); and the LIVE database —
-- staging.era_835_ingest_run does not exist, and 021 IS genuinely applied there
-- (member_id_enc, member_id_bidx, and era_835_member_id_bidx_idx all present).
--
-- WHY: the 2026-08-02 05:00 UTC production run parsed 112 remits and INSERTED 39. The
--   other 73 were swallowed by ON CONFLICT DO NOTHING and recorded NOWHERE — 65% of
--   parsed remits took a completely silent path. Run stats today live only in the HTTP
--   response body (which Vercel's cron runner discards) and in console.log (which is gone
--   from `vercel logs` by morning). A silent no-op MUST become queryable after the fact.
--   Same durable-observability fix, and the same fail-soft posture, as
--   supabase/migrations/0053 did for claims.audit_ingest_run on the product plane.
--
--   It also finally makes 013's documented duplicate-remit detector USABLE. 013's header
--   states the signal: "a re-pull of an already-ingested date MUST report
--   payments_inserted = 0", and payments_inserted > 0 for an already-ingested date is the
--   fingerprint-instability signature. Until now there was no record of yesterday's run
--   to compare against.
--
-- WHAT THIS IS NOT: NO schema change to staging.era_835_payment or
--   staging.era_835_adjustment. One new table, additive, empty on create. §7 asserts the
--   two ERA tables' column counts are unchanged (18 and 42, verified live 2026-08-02).
--
-- PHI DISCIPLINE: counts, ISO dates, the writer ROLE NAME, X12-free failure CODES, and
--   error MESSAGES only. NEVER an EDI segment, never a patient identifier, never a cell
--   value, never a payer or facility row. error_detail and pulls_failed_by_code are the
--   two free-form columns and both are message/code-only by contract (the ingest already
--   logs under exactly this discipline: src/ingest/era_ingest.ts logs customer id +
--   facility code + err.message, never content).
--
--   DELIBERATELY UNLIKE 0053: there is NO per_customer jsonb array here. On this feed a
--   per-customer breakdown would be a per-facility remittance-activity array, which is a
--   materially richer disclosure than the product plane's row counts. The run-wide and
--   per-tenant counters answer the operational question without it. Do not add one.
--
-- OWNERSHIP: born owned by claims_admin via SET ROLE (§2), matching 013-021. Table-level
--   GRANTs run as postgres OUTSIDE the SET ROLE block, mirroring 013 §7 / 019 — the
--   proven-applied grant path in this cluster.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before
--   CREATE POLICY; roles created only-if-absent (never DROP ROLE); REVOKE/GRANT reapplied
--   unconditionally. Re-running is a no-op on an already-applied cluster.
--
-- DEPENDENCY: 001 (staging schema + claims_reader), 013 (cmd_rollup_writer's staging
--   privileges + the two tables this run row summarises), 014 (core.business_entity — the
--   FK target). Additive and empty on create, so applying AHEAD of the cron-write deploy
--   is harmless (an un-deployed cron simply never inserts).
--
--   ⚠️ THE CODE THAT WRITES THIS TABLE MUST NOT DEPLOY BEFORE THIS MIGRATION APPLIES.
--   Merging SQL in a PR does NOT apply it (the 0056 incident). The write is fail-soft in
--   the handler, so a too-early deploy degrades to a logged non-fatal error rather than a
--   broken cron — but do not rely on that; apply first.
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

-- =============================================================================
-- 3. staging.era_835_ingest_run — ONE ROW PER TENANT PER RUN
-- =============================================================================
-- Grain: (run, tenant). runEra835Ingest loops one customer roster that may span tenants,
-- and every counter is computed inside that loop with the customer — and therefore its
-- business_entity_id — in scope. So attribution is exact, and each tenant gets its own
-- row rather than the run being skipped or blended when the roster spans tenants.
-- Today's roster is BXR-only (one row per run); the moment Indigo joins the 835 roster
-- its observability appears with no code change and nothing goes dark.
CREATE TABLE IF NOT EXISTS staging.era_835_ingest_run (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_entity_id       uuid        NOT NULL
                             REFERENCES core.business_entity(id) ON DELETE RESTRICT,

  -- Provenance -----------------------------------------------------------------
  writer_user              text        NOT NULL CHECK (char_length(writer_user) <= 100),
  status                   text        NOT NULL
                             CHECK (status IN ('ok', 'partial', 'empty', 'failed')),
  started_at               timestamptz NOT NULL,
  finished_at              timestamptz NOT NULL DEFAULT now(),

  -- The trailing lookback window actually pulled. NULLABLE: the handler probes the PHI
  -- key BEFORE computing dates, so a key failure produces a failed run with no window.
  window_start             date,
  window_end               date,

  -- Pull outcomes (the CMD transport axis) -------------------------------------
  customers_total          int         NOT NULL DEFAULT 0,
  pulls_attempted          int         NOT NULL DEFAULT 0,
  pulls_failed             int         NOT NULL DEFAULT 0,
  pulls_empty              int         NOT NULL DEFAULT 0,
  pulls_zero_files         int         NOT NULL DEFAULT 0,
  pulls_skipped_budget     int         NOT NULL DEFAULT 0,

  -- Parse + write outcomes (the data axis) -------------------------------------
  files_parsed             int         NOT NULL DEFAULT 0,
  payments_mapped          int         NOT NULL DEFAULT 0,
  payments_inserted        int         NOT NULL DEFAULT 0,
  payments_duplicate       int         NOT NULL DEFAULT 0,
  rows_inserted            int         NOT NULL DEFAULT 0,
  rows_skipped_duplicate   int         NOT NULL DEFAULT 0,

  -- Failure taxonomy + detail. CODES AND MESSAGES ONLY — never EDI, never a value. ---
  pulls_failed_by_code     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_detail             text                 CHECK (char_length(error_detail) <= 500),

  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE staging.era_835_ingest_run IS
  'ONE ROW PER TENANT PER 835 ingest run (/api/cron/era-835). The durable record of what a run actually did — written fail-soft by the handler on BOTH the success and the error path, so a run that inserted nothing is still visible AS a run. Exists because 65% of parsed remits take the ON CONFLICT DO NOTHING path and were previously recorded nowhere. NON-PHI: counts, ISO dates, the writer role name, failure codes, and error messages. Deliberately has NO per_customer array (unlike claims.audit_ingest_run) — a per-facility remittance breakdown is a richer disclosure than this surface needs. Append-only: no role holds UPDATE or DELETE.';

COMMENT ON COLUMN staging.era_835_ingest_run.status IS
$st$Per-tenant run outcome. Derivation lives in src/ingest/era_ingest.era835RunStatus:
  failed  — the handler threw (fatal 401/403, PHI-key probe failure, DB failure). Written
            for EVERY tenant in the roster, because per-tenant attribution is not
            available on that path. Counters are still REAL, not zeroed — see below.
  partial — pulls_failed + pulls_zero_files + pulls_skipped_budget > 0.
  empty   — pulls_attempted = 0, OR pulls_empty = pulls_attempted.
  ok      — otherwise.

WHY 'empty' IS ITS OWN STATE AND NOT JUST 'ok'. pulls_empty is CMD's documented "no 835
ERAs on that date" response, which is a normal quiet day — but it is ALSO the exact
signature of the credential having lost its Payment role: every pull succeeds and every
pull returns nothing. Today that case returns HTTP 200 {ok:true} and is indistinguishable
from a genuinely quiet day, which is precisely how this ingest could sit dead in
production without anyone noticing. Two CONSECUTIVE 'empty' runs across a 5-day trailing
window is not a quiet week — it is page-worthy. 013's header says the same thing from the
other side: "If [pulls_empty] equals pulls_attempted across a whole run, suspect the
credential''s Payment role or the date axis before concluding there was no business."

ZERO ATTEMPTS IS 'empty', NOT 'ok'. A run that reaches the summary having attempted
nothing — an empty roster, a roster whose every entry belongs to another tenant, a budget
guard that fired before the first pull — has proven nothing about the feed's health.
Reporting it 'ok' would be the same class of false reassurance as collapsing 'empty' into
'ok': a healthy-looking row that no one attempted to earn.

FAILED RUNS CARRY REAL COUNTERS. runEra835Ingest mutates a caller-owned stats object, so
a mid-run throw does not discard the work that already committed. A run that processed 10
of 15 customers and then died records status='failed' with the inserts it actually made.
Zeroing them would poison the duplicate detector below: the partial run's contribution
would vanish, the next 5-day re-pull would dedupe those same rows, and the whole sequence
would read healthy. Given finding 1 (the 2026-07-31 30%/42% pull-failure episodes, root
cause UNKNOWN and the throttle theory FALSIFIED), failed runs are the case we most need
honest numbers for.$st$;

COMMENT ON COLUMN staging.era_835_ingest_run.files_parsed IS
  'Count of 835 files parsed in this run — ISA-bearing entries read out of the downloaded archives. A pull that returned a real ZIP holding no ISA segment contributes 0 here and increments pulls_zero_files instead.';

COMMENT ON COLUMN staging.era_835_ingest_run.payments_duplicate IS
$pd$Remits that hit ON CONFLICT (row_fingerprint) DO NOTHING on staging.era_835_payment —
already ingested, so nothing was written. payments_mapped = payments_inserted +
payments_duplicate for any run that did not abort mid-pull.

THIS IS THE COLUMN THAT MAKES 013''s DUPLICATE-REMIT DETECTOR USABLE. 013 states the
signal: a re-pull of an already-ingested date MUST report payments_inserted = 0. With a
5-day trailing window, four of every five pulled dates are re-pulls, so the healthy steady
state is a HIGH payments_duplicate against a payments_inserted equal to genuinely new
remits only. payments_inserted staying high against a stable payments_mapped means the
remit fingerprint has destabilised (CMD re-serving a date with a different ST02 assignment
or different literal BPR02 text) and BPR02 is being DOUBLE-COUNTED. Do not dismiss it as
new data. Confirm with 013''s query:
  SELECT check_eft_trace_number, payment_date, count(*), count(DISTINCT id)
    FROM staging.era_835_payment GROUP BY 1,2 HAVING count(*) > 1;  -- expect zero rows$pd$;

COMMENT ON COLUMN staging.era_835_ingest_run.rows_skipped_duplicate IS
  'CAS triplets that hit ON CONFLICT (row_fingerprint) DO NOTHING on staging.era_835_adjustment (each insert batch contributes batch size minus its rowCount). The adjustment-grain counterpart of payments_duplicate: rows_inserted + rows_skipped_duplicate = the triplets offered to the DB.';

COMMENT ON COLUMN staging.era_835_ingest_run.pulls_failed_by_code IS
  'pulls_failed broken out by CmdEra835Error.code (''http_status'', ''unrecognized_short_text'', ''request_failed'', …), with non-CmdEra835Error failures under ''other''. CODES AND COUNTS ONLY — never a URL, never a token, never response content. Same taxonomy as the probe''s failure buckets, so cron logs, probe reports, and this table all read the same way. Exists for finding 1 (2026-07-31): the root cause of the observed 30%/42% failure episodes is UNKNOWN and the throttle theory is FALSIFIED — an undifferentiated failure counter is exactly what made those episodes undiagnosable.';

COMMENT ON COLUMN staging.era_835_ingest_run.error_detail IS
  'On status=''failed'' only: the thrown Error''s MESSAGE, truncated to 500 chars. MESSAGE TEXT ONLY — never an EDI segment, never a patient identifier, never a cell value, never a credential or URL. The ingest''s own error logs already hold to this discipline; this column persists the same string.';

COMMENT ON COLUMN staging.era_835_ingest_run.writer_user IS
  'current_user as observed INSIDE the withTenant transaction that wrote this row — i.e. what the cmd_rollup_writer connection actually authenticated as. RECORDED, NOT ASSERTED: unlike the billing-audit plane there is no identity guard on this path, and this migration does not invent one. It is evidence for a later audit, not a gate.';

COMMENT ON COLUMN staging.era_835_ingest_run.window_start IS
  'First ISO date of the trailing lookback window this run pulled (oldest-first, per the budget-guard ordering). NULL when the run died before the window was computed — the handler probes the PHI key first, deliberately, so that failure mode has no window to record.';

-- 4. Index --------------------------------------------------------------------
-- Composite index leads with business_entity_id (018 index-leadership rule): every read
-- runs under RLS with business_entity_id = <GUC>. finished_at DESC serves the only query
-- this table has — "the last N runs for this tenant".
CREATE INDEX IF NOT EXISTS era_835_ingest_run_recent_idx
  ON staging.era_835_ingest_run (business_entity_id, finished_at DESC);

-- 5. RLS ----------------------------------------------------------------------
-- Tenant isolation by the app.business_entity_id GUC, matching 013 exactly: the writer is
-- cmd_rollup_writer, a NON-OWNER least-privilege role, so RLS genuinely binds on the write
-- path and needs an explicit INSERT policy.
--
-- UNLIKE 013 there is NO writer SELECT policy and no writer SELECT grant: this table has
-- no ON CONFLICT arbiter to evaluate and the ingest never reads it back, so the writer
-- needs nothing but INSERT. That is tighter than both 013 and 0053 on purpose, not an
-- omission — do not add a writer SELECT "for symmetry".
--
-- No FORCE ROW LEVEL SECURITY: 017's active guard fails the whole staging plane if any
-- staging table has it (claims_admin owner-path access must keep owner bypass).
ALTER TABLE staging.era_835_ingest_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS era_835_ingest_run_reader_isolation ON staging.era_835_ingest_run;
CREATE POLICY era_835_ingest_run_reader_isolation ON staging.era_835_ingest_run
  FOR SELECT TO claims_reader
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid);

DROP POLICY IF EXISTS era_835_ingest_run_writer_insert ON staging.era_835_ingest_run;
CREATE POLICY era_835_ingest_run_writer_insert ON staging.era_835_ingest_run
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

RESET ROLE;

-- 6. Grants -------------------------------------------------------------------
-- Run as postgres, OUTSIDE the SET ROLE block — mirroring 013 §7 / 019.
-- Strip default/public grants, then grant precisely. APPEND-ONLY: no role gets UPDATE or
-- DELETE, so a run row can never be rewritten or quietly removed. The identity PK is
-- GENERATED ALWAYS, so INSERT needs no sequence privilege (013 §7).
GRANT USAGE ON SCHEMA staging TO cmd_rollup_writer;   -- already held; kept self-contained
GRANT USAGE ON SCHEMA staging TO claims_reader;

REVOKE ALL ON staging.era_835_ingest_run
  FROM public, anon, authenticated, service_role;
GRANT SELECT ON staging.era_835_ingest_run TO claims_reader;
GRANT INSERT ON staging.era_835_ingest_run TO cmd_rollup_writer;

-- 7. Verification (run manually after apply) ----------------------------------
-- -- exists, owned by claims_admin, RLS on, FORCE off:
-- SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='staging' AND c.relname='era_835_ingest_run';
--   -- expect 1 row, owner=claims_admin, relrowsecurity=t, relforcerowsecurity=f
--
-- -- THE POINT OF FLAGGING IT: the two ERA tables are UNCHANGED by this migration.
-- -- Both counts verified against the live DB 2026-08-02 BEFORE this migration was written.
-- SELECT table_name, count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name IN ('era_835_payment','era_835_adjustment')
--  GROUP BY 1 ORDER BY 1;
--   -- expect era_835_adjustment = 42, era_835_payment = 18   (42 includes 021's member_id_bidx)
--
-- SELECT count(*) FROM staging.era_835_ingest_run;                      -- expect 0 fresh
--
-- -- tenancy FK onto core.business_entity (016 parity):
-- SELECT conname, confrelid::regclass AS parent, convalidated FROM pg_constraint
--  WHERE contype='f' AND conrelid='staging.era_835_ingest_run'::regclass;
--   -- expect one FK → core.business_entity, convalidated=t
--
-- SELECT policyname, cmd, (qual IS NOT NULL) AS has_using, (with_check IS NOT NULL) AS has_with_check
--   FROM pg_policies WHERE schemaname='staging' AND tablename='era_835_ingest_run' ORDER BY 1;
--   -- expect exactly 2 rows: reader SELECT (using), writer INSERT (with_check).
--   -- NO writer SELECT policy — see §5.
--
-- -- privileges: reader SELECT, writer INSERT, and NOTHING else to anyone:
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='staging' AND table_name='era_835_ingest_run' ORDER BY 1,2;
--   -- expect claims_admin (owner) + claims_reader/SELECT + cmd_rollup_writer/INSERT only.
--   -- ANY row granting UPDATE or DELETE to a non-owner is a defect — this table is append-only.
--
-- -- the status CHECK admits exactly the four states era835RunStatus can produce:
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='staging.era_835_ingest_run'::regclass AND contype='c' AND conname LIKE '%status%';
--   -- expect CHECK (status = ANY (ARRAY['ok','partial','empty','failed']))
--
-- -- after the code deploys, the first real run should look like:
-- SELECT status, window_start, window_end, pulls_attempted, pulls_empty,
--        payments_mapped, payments_inserted, payments_duplicate, rows_skipped_duplicate
--   FROM staging.era_835_ingest_run ORDER BY finished_at DESC LIMIT 5;
--   -- steady state: payments_duplicate HIGH (4 of 5 windowed dates are re-pulls),
--   -- payments_inserted = genuinely new remits only. See the payments_duplicate comment.
-- =============================================================================
