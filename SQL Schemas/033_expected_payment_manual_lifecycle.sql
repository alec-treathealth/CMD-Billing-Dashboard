-- =============================================================================
-- Migration 033: staging.expected_payment_manual — SOFT DELETE + RECONCILIATION
--   STATUS. Removal stops being a hard DELETE, and a manual 'add' gains a place
--   to record that an 835 has since covered it.
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Rollback: 033_expected_payment_manual_lifecycle_rollback.sql
--
-- 033 IS THE NEXT FREE VERIS NUMBER, re-derived 2026-08-10 rather than trusted:
--   `SQL Schemas/` on origin/main tops out at 032_intel_writer_select_grant, and all 17
--   live worktrees were scanned (max 032, no 033 authored anywhere).
--   `.claude/rules/sql-migrations.md` still says "next = 032" — it is STALE, because 032
--   landed on main after it was written. CONFIRM AGAINST THE LIVE DB BEFORE APPLYING:
--     SELECT column_name FROM information_schema.columns
--      WHERE table_schema='staging' AND table_name='expected_payment_manual'
--        AND column_name IN ('status','removed_at','removed_by');   -- expect 0 rows pre-apply
--
-- WHY: two gaps in 024, both of which cost information that an operator needs.
--
--   1. REMOVAL WAS A HARD DELETE. `staging.delete_expected_payment_manual` runs a real
--      DELETE, so the record that a super admin ever made a money decision — and then
--      changed their mind — is destroyed. The claims.access_audit row survives, but it
--      names an id that no longer resolves to anything, which makes the audit trail
--      unreadable at exactly the moment somebody is asking "who took that $32,000 off the
--      tile?". A soft delete keeps the row, its author, and its removal author.
--
--   2. AN 'add' COULD NOT RECORD THAT IT HAD LANDED. 024 gave matched_era_key ONLY to a
--      'suppress' with reason 'landed' (its kind-shape CHECK forbids the column on every
--      other kind). So the one row class that represents money an operator typed in
--      themselves — the 'add' — had nowhere to record the 835 that later covered it. The
--      only available move was to file a SECOND row (a suppress at the same key), which
--      is why the live data holds exactly that pair today (ids 8 and 18, KWC / BCBS TN /
--      2026-08-05). That works, but it splits one payment's history across two rows and
--      makes "is this reconciled?" a join rather than a column.
--
-- WHAT THIS DOES NOT DO — read this before extending it.
--
--   NO AUTOMATIC CONFIRMATION. 024's ruling stands verbatim: payer_label ('BCBS') and
--   era_835_payment.payer_name ('BLUE CROSS OF CALIFORNIA (CA)') do not join reliably, so
--   nothing here matches a forecast to an 835 by itself. The 'needs_review' status exists
--   precisely so a LOW-CONFIDENCE match can be recorded WITHOUT asserting it is true —
--   `src/veris/upcomingForecast.ts` already computes 'high'/'medium' and never 'confirmed'.
--   A row only reaches 'matched' when a named super admin says so.
--
--   NO ROW IN collections.daily_collections. It is tempting to make a manual expected
--   payment appear on the Master BXR Chart by writing it into the deposits table with a
--   new source_tag. DO NOT. `collections.daily_collections_resolved` is MAX-GROSS-WINS,
--   not SUM — row_number() over (partition by entity, facility, payment_date order by
--   gross_amount desc) ... where rn = 1. A manual row at a facility-day would therefore
--   either be silently discarded or REPLACE the real CMD deposit figure. The chart reads
--   the forecast live from THIS table as a separate, separately-labelled series instead.
--
-- THE UNIQUE INDEX IS DELIBERATELY LEFT FULL, NOT MADE PARTIAL. 024's
--   expected_payment_manual_decision_uidx covers every row including soft-removed ones, so
--   re-adding a key that was removed UPDATEs the tombstone rather than inserting beside it.
--   §3's upsert clears removed_at/removed_by/status on conflict, which turns that into a
--   clean REVIVE. A partial index (WHERE removed_at IS NULL) would instead allow an
--   unbounded pile of tombstones at one key, and "one decision per kind + match key" — the
--   invariant that stops the resolved amount depending on scan order — would be gone.
--
-- PHI DISCIPLINE. Unchanged from 024 and re-asserted in §6: no patient column, and
--   deliberately NO FREE-TEXT NOTE COLUMN. `status` is a closed enum and removed_by is a
--   uuid; neither can carry prose. ⚠️ DO NOT add a removal_reason TEXT column here — that
--   is the realistic way "check for Marcus W" gets typed into a non-PHI table.
--
-- OWNERSHIP: staging is the claims_admin plane, so objects are altered under SET ROLE
--   claims_admin (§2), matching 013–024. Function GRANTs run as postgres OUTSIDE that
--   block. ⚠️ This is the OPPOSITE of the `collections` plane, where every relation is
--   relowner=postgres and a SET ROLE claims_admin DOWNGRADES the applying role — see
--   CLAUDE.md. Do not copy this block into a collections migration.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; constraints dropped-if-exists before create;
--   CREATE OR REPLACE FUNCTION; REVOKE/GRANT reapplied unconditionally. Re-running is safe.
--
-- DEPENDENCY: 024 (the table and both functions this alters). Additive — every existing
--   row backfills to status='expected', removed_at NULL, which is exactly what they are.
-- =============================================================================

-- 1. Roles (privilege-only; created only-if-absent). ---------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_reader') THEN
    CREATE ROLE claims_reader NOLOGIN;
  END IF;
END $$;

-- 2. Objects are altered as their owner. ---------------------------------------
SET ROLE claims_admin;

-- =============================================================================
-- 3. Columns
-- =============================================================================

-- The reconciliation lifecycle of a manual 'add'.
--   'expected'     nobody has claimed this money arrived. The default, and the only legal
--                  status for a 'correct' or a 'suppress' (see the coherence CHECK below).
--   'needs_review' an 835 LOOKS like it covers this, but the evidence was not conclusive.
--                  Rendered, and flagged, so a human resolves it. NEVER set automatically
--                  to 'matched' — see WHAT THIS DOES NOT DO in the header.
--   'matched'      a named super admin confirmed the 835 covers it. The row stops counting
--                  as expected money so one payment is never rendered twice.
ALTER TABLE staging.expected_payment_manual
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'expected';

-- Soft delete. Both columns move together or not at all (CHECK below).
ALTER TABLE staging.expected_payment_manual
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE staging.expected_payment_manual
  ADD COLUMN IF NOT EXISTS removed_by uuid;

ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_status_ck;
ALTER TABLE staging.expected_payment_manual
  ADD CONSTRAINT expected_payment_manual_status_ck
  CHECK (status IN ('expected', 'needs_review', 'matched'));

-- A tombstone must name its author, and an author implies a tombstone. Half a removal is
-- a row the UI cannot classify: removed_at with no actor is an unattributable deletion of
-- money, which is the one thing the audit posture exists to prevent.
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_removal_shape_ck;
ALTER TABLE staging.expected_payment_manual
  ADD CONSTRAINT expected_payment_manual_removal_shape_ck
  CHECK ((removed_at IS NULL) = (removed_by IS NULL));

-- =============================================================================
-- 4. The kind-shape constraint, WIDENED for 'add' only
-- =============================================================================
-- 024 forbade matched_era_key on every kind except a 'landed' suppress. That is the gap
-- described in WHY §2. This re-states the whole constraint (a CHECK cannot be amended in
-- place) changing exactly one clause: an 'add' MAY now carry matched_era_key.
--
-- 'correct' is deliberately NOT widened. A correction is a statement about a SHEET row's
-- amount, not a payment in its own right — reconciling it would mean claiming an 835
-- covers a number rather than a deposit. If the underlying sheet row lands, the suppress
-- path is what records it, exactly as 024 designed.
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_kind_shape_ck;
ALTER TABLE staging.expected_payment_manual
  ADD CONSTRAINT expected_payment_manual_kind_shape_ck CHECK (
    (kind = 'add'      AND amount IS NOT NULL AND method_label IS NOT NULL
                       AND suppress_reason IS NULL)
    OR
    (kind = 'correct'  AND amount IS NOT NULL
                       AND suppress_reason IS NULL AND matched_era_key IS NULL)
    OR
    (kind = 'suppress' AND amount IS NULL AND method_label IS NULL
                       AND suppress_reason IS NOT NULL
                       AND (suppress_reason = 'landed' OR matched_era_key IS NULL))
  );

-- STATUS COHERENCE. A non-'expected' status is a claim ABOUT AN 835, so it may only exist
-- where an 835 is named, and only on the kind that represents money in its own right.
-- Without this, 'matched' could be set on a suppress (meaningless — a suppress is already
-- a removal) or with no era key at all (a reconciliation claim citing no evidence).
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_status_shape_ck;
ALTER TABLE staging.expected_payment_manual
  ADD CONSTRAINT expected_payment_manual_status_shape_ck
  CHECK (status = 'expected' OR (kind = 'add' AND matched_era_key IS NOT NULL));

-- Read index for the tile's live path: the resolver wants one tenant's LIVE rows, and
-- every removed row it has to fetch and discard is wasted I/O that grows without bound as
-- tombstones accumulate. Partial on removed_at IS NULL for that reason. Leads with
-- business_entity_id per the 018 rule.
CREATE INDEX IF NOT EXISTS expected_payment_manual_live_idx
  ON staging.expected_payment_manual (business_entity_id, expected_date)
  WHERE removed_at IS NULL;

COMMENT ON COLUMN staging.expected_payment_manual.status IS
  '''expected'' = nobody has claimed the money arrived (the default, and the ONLY legal value for kind ''correct''/''suppress''). ''needs_review'' = an 835 plausibly covers this ''add'' but the evidence was not conclusive; still rendered, and flagged. ''matched'' = a named super admin CONFIRMED it; the row stops counting as expected money so one payment is never rendered twice. Never set to ''matched'' automatically — payer_label and era_835_payment.payer_name do not join reliably (024).';

COMMENT ON COLUMN staging.expected_payment_manual.removed_at IS
  'SOFT DELETE. Non-null means a super admin took this decision back. The row is kept so the claims.access_audit entry naming the removal still resolves to something readable — a hard DELETE left the audit trail pointing at an id that no longer existed. Readers MUST filter removed_at IS NULL; re-adding the same match key REVIVES this row (the unique index is deliberately full, not partial) rather than inserting beside it.';

-- =============================================================================
-- 5. The write surface — SECURITY DEFINER, owned by claims_admin
-- =============================================================================
-- SET search_path = '' on all three (Supabase advisor 0011); every identifier qualified.

-- Upsert, now lifecycle-aware. Two behaviour changes, both on the CONFLICT branch:
--   · removed_at/removed_by are CLEARED — re-adding a removed key REVIVES it. Without this
--     the upsert would return the id of a tombstone the reader filters out, and the form
--     would silently do nothing while reporting success.
--   · status resets to 'expected' and matched_era_key to the passed value. Re-asserting a
--     forecast is a statement that the money is coming; carrying a stale 'matched' across
--     that would leave a live row that the resolver refuses to count.
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
  ON CONFLICT (business_entity_id, kind, facility_code, payer_label, expected_date)
  DO UPDATE SET
    method_label    = excluded.method_label,
    amount          = excluded.amount,
    suppress_reason = excluded.suppress_reason,
    matched_era_key = excluded.matched_era_key,
    status          = 'expected',
    removed_at      = NULL,
    removed_by      = NULL,
    updated_by      = excluded.updated_by,
    updated_at      = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- SOFT delete. Replaces the hard DELETE as the app's removal path.
--
-- Returns false — not an exception — when nothing LIVE matched, so a double-click and a
-- row somebody else already removed are both success-shaped but distinguishable. The
-- `removed_at IS NULL` predicate is what makes it idempotent: re-removing a tombstone
-- changes no row and reports false, rather than overwriting the original remover's name.
CREATE OR REPLACE FUNCTION staging.remove_expected_payment_manual(
  p_business_entity_id uuid,
  p_id                 bigint,
  p_actor              uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_updated int;
BEGIN
  IF p_business_entity_id IS NULL OR p_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'remove_expected_payment_manual: tenant, id and actor are required';
  END IF;
  -- The tenant predicate is what stops an id from one tenant being removed while acting as
  -- another. The function runs as the owner, so RLS is NOT doing this for us.
  UPDATE staging.expected_payment_manual m
     SET removed_at = now(),
         removed_by = p_actor,
         updated_by = p_actor,
         updated_at = now()
   WHERE m.id = p_id
     AND m.business_entity_id = p_business_entity_id
     AND m.removed_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$fn$;

-- Record a reconciliation decision against an 835.
--
-- p_status must be 'matched' (a human confirmed) or 'needs_review' (the suggester found a
-- plausible but inconclusive candidate). 'expected' is accepted too, as the UNDO path —
-- it clears the era key and puts the row back to counting as expected money.
--
-- ⚠️ THIS FUNCTION DOES NOT DECIDE ANYTHING. It records a decision made above it. Do not
-- add matching logic here: the reason reconciliation is suggest-then-confirm is that a
-- wrong automatic match silently deletes money from a forecast (024's header).
CREATE OR REPLACE FUNCTION staging.set_expected_payment_manual_status(
  p_business_entity_id uuid,
  p_id                 bigint,
  p_status             text,
  p_matched_era_key    text,
  p_actor              uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_updated int;
BEGIN
  IF p_business_entity_id IS NULL OR p_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'set_expected_payment_manual_status: tenant, id and actor are required';
  END IF;
  IF p_status NOT IN ('expected', 'needs_review', 'matched') THEN
    RAISE EXCEPTION 'set_expected_payment_manual_status: unknown status';
  END IF;
  -- Belt and braces with expected_payment_manual_status_shape_ck: raising here names the
  -- problem, where the CHECK would only say a constraint failed.
  IF p_status <> 'expected' AND (p_matched_era_key IS NULL OR p_matched_era_key = '') THEN
    RAISE EXCEPTION 'set_expected_payment_manual_status: a non-expected status must name an 835';
  END IF;

  UPDATE staging.expected_payment_manual m
     SET status          = p_status,
         matched_era_key = CASE WHEN p_status = 'expected' THEN NULL ELSE p_matched_era_key END,
         updated_by      = p_actor,
         updated_at      = now()
   WHERE m.id = p_id
     AND m.business_entity_id = p_business_entity_id
     AND m.removed_at IS NULL
     -- Only an 'add' is reconcilable — see the status coherence CHECK in §4.
     AND m.kind = 'add';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$fn$;

RESET ROLE;

-- 6. Grants -------------------------------------------------------------------
-- Run as postgres, OUTSIDE the SET ROLE block — mirroring 024 §6.
--
-- cmd_rollup_writer STILL GETS NOTHING, and that remains the structural guarantee that the
-- hourly CMD/sheet crons cannot write, overwrite, resurrect or delete a manual row. It is
-- not a predicate anyone can get wrong; it is an absent privilege. Do not "tidy" a grant
-- onto this table.
REVOKE ALL ON FUNCTION staging.remove_expected_payment_manual(uuid, bigint, uuid)
  FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION staging.set_expected_payment_manual_status(uuid, bigint, text, text, uuid)
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION staging.remove_expected_payment_manual(uuid, bigint, uuid)
  TO claims_reader;
GRANT EXECUTE ON FUNCTION staging.set_expected_payment_manual_status(uuid, bigint, text, text, uuid)
  TO claims_reader;

-- staging.delete_expected_payment_manual (024 §5) is deliberately LEFT IN PLACE and still
-- granted. It is no longer on the app path — app/lib/server.ts calls the soft-delete above
-- — but dropping it would break any in-flight deploy still holding the old code, and it
-- remains the correct tool for a genuine hard purge run by hand. If it is ever dropped,
-- drop it in a migration of its own, after confirming no deployed build calls it.

-- 7. Verification (run manually after apply) ----------------------------------
-- -- the three new columns exist with the right defaults:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_manual'
--    AND column_name IN ('status','removed_at','removed_by') ORDER BY 1;
--   -- expect 3 rows; status NOT NULL DEFAULT 'expected'::text, both removed_* nullable.
--
-- -- every pre-existing row backfilled to the honest values:
-- SELECT status, count(*), count(removed_at) AS removed
--   FROM staging.expected_payment_manual GROUP BY 1;
--   -- expect ONLY status='expected' with removed=0 immediately after apply.
--
-- -- THE PHI ASSERTION, re-run because this migration added columns. Must return ZERO rows.
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_manual'
--    AND column_name ~* 'patient|client|member|subscriber|claim_number|dob|ssn|name|note|comment';
--   -- expect 0 rows. ANY row is a PHI defect — stop and revert.
--
-- -- THE STRUCTURAL GUARANTEE, re-run because this migration added functions:
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='staging' AND table_name='expected_payment_manual' ORDER BY 1,2;
--   -- expect claims_admin (owner) + claims_reader/SELECT ONLY.
--   -- ANY cmd_rollup_writer row is a defect — that is the role the hourly syncs write as.
--
-- -- all THREE functions are SECURITY DEFINER with a pinned search_path (advisor 0011):
-- SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='staging' AND p.proname LIKE '%expected_payment_manual%';
--   -- expect 4 rows (024's two + this migration's two), prosecdef=t, proconfig={search_path=""}
--
-- -- SOFT DELETE round trip, on the live pair (ids 8 / 18, KWC / BCBS TN / 2026-08-05):
-- -- SELECT staging.remove_expected_payment_manual('<bxr>', 8, '<actor>');   -- expect true
-- -- SELECT staging.remove_expected_payment_manual('<bxr>', 8, '<actor>');   -- expect FALSE
-- --   (idempotent: the second call must NOT overwrite the first remover's name)
-- -- SELECT id, status, removed_at, removed_by FROM staging.expected_payment_manual WHERE id=8;
-- --   -- expect removed_at set, removed_by = the FIRST actor.
--
-- -- these must ALL raise or return false:
-- -- SELECT staging.set_expected_payment_manual_status('<bxr>', 8, 'matched', NULL, '<actor>');
-- --   (a reconciliation claim citing no 835)
-- -- SELECT staging.set_expected_payment_manual_status('<bxr>', 8, 'landed', 'k', '<actor>');
-- --   (unknown status — 'landed' is a suppress_reason, not a status)
-- -- SELECT staging.set_expected_payment_manual_status('<bxr>', 18, 'matched', 'k', '<actor>');
-- --   (id 18 is a 'suppress' — expect FALSE, not an exception: only an 'add' is reconcilable)
--
-- 8. The 023 feed is UNCHANGED by this migration. -----------------------------
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_override';
--   -- expect 11 (per 023) — this migration adds no column there and no FK between them.
-- =============================================================================
