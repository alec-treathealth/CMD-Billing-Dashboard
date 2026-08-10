-- =============================================================================
-- Migration 0096: MANUAL DEPOSITS — money an operator has in hand that
--   CollaborateMD has not posted yet, counting in MTD / YTD / All Facilities.
-- Plane: PRODUCT (`collections`). supabase/migrations/00NN_*.sql.
-- Gate-review: show before applying. Nothing touches the DB until confirmed.
-- Rollback: 0096_manual_deposits_rollback.sql
--
-- 0096 IS THE NEXT FREE PRODUCT NUMBER. 0092/0093/0094 are applied live; **0095 consumed its
--   slot without leaving a file**. `.claude/rules/sql-migrations.md` said 0095 while CLAUDE.md
--   said 0096 — CLAUDE.md was right, and both were corrected in the same change as this file.
--
-- ⚠️ OWNERSHIP: NO `SET ROLE claims_admin` ANYWHERE IN THIS FILE. Every live `collections`
--   relation is `relowner = postgres` (measured 2026-08-05), so a SET ROLE here DOWNGRADES the
--   applying role from owner to non-owner and fails with `42501: must be owner of table …`.
--   That cost two failed applies on 0084/0085. The SECURITY DEFINER functions in §4 are
--   therefore owned by **postgres** — a definer runs as its OWNER, and a claims_admin-owned
--   definer cannot write a postgres-owned table.
--
-- WHY: the "Add an expected payment" form wrote only to `staging.expected_payment_manual`, so a
--   hand-keyed payment appeared on the Future Payments tile and NOWHERE ELSE. The MTD card, the
--   All Facilities table and the Master chart all read `collections.daily_collections_resolved`,
--   which is a different plane entirely. Alec, 2026-08-10: "if it doesn't add to the actual MTD
--   total or All Facilities table it's useless."
--
--   These rows are not forecasts. A super admin keys one BECAUSE a check has physically
--   arrived and CMD has not logged it — it is a RECEIVED DEPOSIT, and the deposits table is
--   where it belongs.
--
-- =============================================================================
-- THE CENTRAL DECISION: 'manual' IS ADDITIVE, NOT A RANK PARTICIPANT.
-- =============================================================================
-- `daily_collections_resolved` is MAX-GROSS-WINS: one row survives per (business_entity_id,
-- facility_code, payment_date), ordered by gross_amount desc. That is CORRECT for the three
-- existing tags — `workbook`, `deposit_sheet` and `cmd` are three competing IMPORTS OF THE SAME
-- DEPOSITS, and picking one is deduplication.
--
-- A 'manual' row is a different epistemic class: it is money none of those sources has yet. If
-- it joined the ranking it would either be silently discarded (CMD's gross is higher) or
-- REPLACE the real CMD deposit for that facility-day (the manual amount is higher) — a $32,000
-- hand-keyed row deleting an actual collected figure from the primary financial surface.
--
-- So it does not join the ranking at all. It is a third UNION ALL branch that passes through
-- additively. Every reader (collectionsKpis / collectionsDaily / collectionsMonthlySummary /
-- the chart) sums over this view, so all four surfaces pick it up with ZERO reader changes.
--
-- ⚠️ DO NOT "SIMPLIFY" THIS BY FOLDING 'manual' BACK INTO THE row_number() BRANCH. That is the
-- one change to this file that silently destroys collected money.
--
-- =============================================================================
-- DOUBLE COUNTING IS REAL, AND IS DELIBERATELY LEFT TO A HUMAN (Alec, 2026-08-10)
-- =============================================================================
-- When CMD finally posts the deposit, the CMD row and the manual row BOTH count and MTD
-- overstates until the manual row is removed. Two alternatives were considered and rejected:
--   · auto-suppress a manual row once any CMD deposit exists for that facility-day — cannot
--     overstate, but SWALLOWS a genuine second payment on the same day, invisibly.
--   · auto-expire after N days — silently drops real money when CMD is slower than N, and
--     silently double-counts when it is faster.
-- Both trade a visible, correctable error for an invisible one. The chosen posture is to keep
-- counting, flag the row in the UI once a CMD deposit appears at the same facility + date, and
-- let a named human remove it. Same suggest-then-confirm discipline as 024's landed matching,
-- and for the same reason: a wrong automatic decision about money is worse than a slow one.
--
-- PHI DISCIPLINE: `collections.daily_collections` is non-PHI facility-day aggregates and stays
--   that way. This migration adds no patient column and NO FREE-TEXT NOTE column — a note field
--   on a payments row is how "check for Marcus W" gets typed into a non-PHI table.
--   ⚠️ DO NOT add a note/memo/reason TEXT column here.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; constraints and policies dropped-if-exists before
--   create; CREATE OR REPLACE VIEW / FUNCTION; REVOKE/GRANT reapplied unconditionally.
--
-- DEPENDENCY: 0014 (the resolved view), 0022 (writer grants), 0030–0033 (tenancy + writer RLS).
-- =============================================================================

-- 1. Allow the new tag. -------------------------------------------------------
ALTER TABLE collections.daily_collections
  DROP CONSTRAINT IF EXISTS daily_collections_source_tag_ck;
ALTER TABLE collections.daily_collections
  ADD CONSTRAINT daily_collections_source_tag_ck
  CHECK (source_tag IN ('workbook', 'deposit_sheet', 'cmd', 'manual'));

-- 2. Lifecycle + provenance columns. ------------------------------------------
-- Soft delete, for the same reason as Veris 033: a hard DELETE destroys the row the
-- claims.access_audit entry names, leaving the audit trail pointing at an id that resolves to
-- nothing — at exactly the moment somebody asks who took money off the dashboard.
ALTER TABLE collections.daily_collections
  ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE collections.daily_collections
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE collections.daily_collections
  ADD COLUMN IF NOT EXISTS removed_by uuid;

ALTER TABLE collections.daily_collections
  DROP CONSTRAINT IF EXISTS daily_collections_removal_shape_ck;
ALTER TABLE collections.daily_collections
  ADD CONSTRAINT daily_collections_removal_shape_ck
  CHECK ((removed_at IS NULL) = (removed_by IS NULL));

-- Only a manual row may ever be removed or attributed. The machine feeds are replaced
-- wholesale by their own ingest paths; a tombstone on a `cmd` row would be re-inserted on the
-- next hourly pull and would read as an operator decision that nothing honours.
ALTER TABLE collections.daily_collections
  DROP CONSTRAINT IF EXISTS daily_collections_manual_only_lifecycle_ck;
ALTER TABLE collections.daily_collections
  ADD CONSTRAINT daily_collections_manual_only_lifecycle_ck
  CHECK (source_tag = 'manual' OR (removed_at IS NULL AND created_by IS NULL));

-- Partial index for the additive branch of the view and for the "does a CMD row now cover
-- this?" prompt. Leads with business_entity_id per the 018 rule.
CREATE INDEX IF NOT EXISTS daily_collections_manual_live_idx
  ON collections.daily_collections (business_entity_id, facility_code, payment_date)
  WHERE source_tag = 'manual' AND removed_at IS NULL;

COMMENT ON COLUMN collections.daily_collections.source_tag IS
  '''cmd'' / ''workbook'' / ''deposit_sheet'' are competing IMPORTS of the same deposits and are deduplicated by max-gross-wins in daily_collections_resolved. ''manual'' is NOT — it is money a super admin has in hand that CMD has not posted yet, and it passes through that view ADDITIVELY as its own UNION ALL branch. Folding ''manual'' into the ranking would let a hand-keyed row replace a real CMD deposit.';

-- =============================================================================
-- 3. The view — manual rows pass through ADDITIVELY
-- =============================================================================
-- CREATE OR REPLACE (not DROP) because the grants must survive; the two new columns are
-- appended AFTER the existing six, in order, which is the only shape CREATE OR REPLACE allows.
-- Verified 2026-08-10: no other view or matview depends on this one.
--
-- `source_tag` and `id` are exposed so the UI can LABEL a manual row and ADDRESS it for
-- removal. Every existing reader projects explicit columns, so appending is safe.
CREATE OR REPLACE VIEW collections.daily_collections_resolved AS
  -- BRANCH 1 — dedup the competing machine imports. Unchanged except for the two exclusions.
  SELECT ranked.facility_code,
         ranked.payment_date,
         ranked.checks_amount,
         ranked.eft_amount,
         ranked.gross_amount,
         ranked.business_entity_id,
         ranked.source_tag,
         ranked.id
    FROM ( SELECT dc.facility_code, dc.payment_date, dc.checks_amount, dc.eft_amount,
                  dc.gross_amount, dc.business_entity_id, dc.source_tag, dc.id,
                  row_number() OVER (
                    PARTITION BY dc.business_entity_id, dc.facility_code, dc.payment_date
                    ORDER BY dc.gross_amount DESC,
                             CASE WHEN dc.source_tag = 'deposit_sheet' THEN 0 ELSE 1 END,
                             dc.id) AS rn
             FROM collections.daily_collections dc
            WHERE dc.facility_code IS NOT NULL
              AND dc.source_tag <> 'manual'
              AND dc.removed_at IS NULL) ranked
   WHERE ranked.rn = 1
  UNION ALL
  -- BRANCH 2 — the lineage-only passthrough (group-code rows with no facility). Unchanged.
  SELECT dc.facility_code, dc.payment_date, dc.checks_amount, dc.eft_amount,
         dc.gross_amount, dc.business_entity_id, dc.source_tag, dc.id
    FROM collections.daily_collections dc
   WHERE dc.facility_code IS NULL
     AND dc.source_tag <> 'manual'
     AND dc.removed_at IS NULL
  UNION ALL
  -- BRANCH 3 — MANUAL, ADDITIVE. Never ranked against a machine row; see the header.
  SELECT dc.facility_code, dc.payment_date, dc.checks_amount, dc.eft_amount,
         dc.gross_amount, dc.business_entity_id, dc.source_tag, dc.id
    FROM collections.daily_collections dc
   WHERE dc.source_tag = 'manual'
     AND dc.removed_at IS NULL;

COMMENT ON VIEW collections.daily_collections_resolved IS
  'Deduplicated deposits. ''cmd''/''workbook''/''deposit_sheet'' compete via max-gross-wins (one row per entity+facility+day); ''manual'' rows are ADDITIVE and pass through untouched, because they are money the machine feeds do not have yet rather than a competing import of the same deposit. Removed (tombstoned) rows are excluded. NEVER move ''manual'' into the ranking branch — it would let a hand-keyed amount replace a real CMD deposit.';

-- =============================================================================
-- 4. The narrow write surface — SECURITY DEFINER, owned by postgres
-- =============================================================================
-- The app runs as claims_reader, which has SELECT and nothing else on this table. These are the
-- only way a manual deposit is created or removed. Authorization (super_admin) is enforced in
-- app/lib/actions.ts, which also writes the claims.access_audit row — same two-layer posture as
-- staging.upsert_expected_payment_manual.
--
-- SET search_path = '' on both (Supabase advisor 0011); every identifier schema-qualified.

CREATE OR REPLACE FUNCTION collections.add_manual_deposit(
  p_business_entity_id uuid,
  p_facility_code      text,
  p_payment_date       date,
  p_method             text,     -- 'EFT' | 'Check'
  p_amount             numeric,
  p_actor              uuid
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  IF p_business_entity_id IS NULL OR p_actor IS NULL OR p_facility_code IS NULL THEN
    RAISE EXCEPTION 'add_manual_deposit: tenant, actor and facility are required';
  END IF;
  IF p_method NOT IN ('EFT', 'Check') THEN
    RAISE EXCEPTION 'add_manual_deposit: method must be EFT or Check';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'add_manual_deposit: amount must be positive';
  END IF;
  -- The definer bypasses RLS, so the tenant is validated explicitly rather than trusted.
  IF NOT EXISTS (SELECT 1 FROM core.business_entity b WHERE b.id = p_business_entity_id) THEN
    RAISE EXCEPTION 'add_manual_deposit: unknown business_entity_id';
  END IF;

  -- gross = checks + eft is an invariant the whole collections layer relies on (the chart
  -- splits the bar on it), so it is computed here rather than passed in and trusted.
  INSERT INTO collections.daily_collections (
    collections_raw_id, facility_code, source_group_code, payment_date,
    checks_amount, eft_amount, gross_amount, source_tag, business_entity_id, created_by
  ) VALUES (
    NULL, p_facility_code, NULL, p_payment_date,
    CASE WHEN p_method = 'Check' THEN p_amount ELSE 0 END,
    CASE WHEN p_method = 'EFT'   THEN p_amount ELSE 0 END,
    p_amount, 'manual', p_business_entity_id, p_actor
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- Soft delete. Returns false — not an exception — when no LIVE MANUAL row matched, so a
-- double-click and a row somebody else already removed are both success-shaped but
-- distinguishable. The `source_tag = 'manual'` predicate is what stops this being pointed at a
-- CMD row; the tenant predicate is what stops it reaching another book.
CREATE OR REPLACE FUNCTION collections.remove_manual_deposit(
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
    RAISE EXCEPTION 'remove_manual_deposit: tenant, id and actor are required';
  END IF;
  UPDATE collections.daily_collections d
     SET removed_at = now(), removed_by = p_actor
   WHERE d.id = p_id
     AND d.business_entity_id = p_business_entity_id
     AND d.source_tag = 'manual'
     AND d.removed_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$fn$;

-- =============================================================================
-- 5. THE CRON CANNOT TOUCH A MANUAL ROW — as a privilege, not a predicate
-- =============================================================================
-- Until now the only thing stopping the hourly CMD ingest from deleting a manual row was the
-- literal `source_tag = 'cmd'` in replaceCmdDailyForFacility's DELETE. That is a predicate in
-- application code, and Alec's requirement is stronger: the cron must NEVER write, overwrite or
-- delete a manual row. These policies make it structural — a bug in that predicate now hits a
-- policy instead of somebody's money.
--
-- DELETE is narrowed to non-manual rows. INSERT is narrowed the same way so the cron can never
-- fabricate one. `<> 'manual'` rather than `= 'cmd'` on purpose: the frozen workbook CLI writes
-- 'workbook' through this same role, and this migration must not break a path it is not scoped
-- to change.
DROP POLICY IF EXISTS cmd_daily_writer_delete ON collections.daily_collections;
CREATE POLICY cmd_daily_writer_delete ON collections.daily_collections
  FOR DELETE TO cmd_rollup_writer
  USING (business_entity_id = current_setting('app.business_entity_id')::uuid
         AND source_tag <> 'manual');

DROP POLICY IF EXISTS cmd_daily_writer_insert ON collections.daily_collections;
CREATE POLICY cmd_daily_writer_insert ON collections.daily_collections
  FOR INSERT TO cmd_rollup_writer
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid
              AND source_tag <> 'manual');

-- 6. Grants -------------------------------------------------------------------
REVOKE ALL ON FUNCTION collections.add_manual_deposit(uuid, text, date, text, numeric, uuid)
  FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION collections.remove_manual_deposit(uuid, bigint, uuid)
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION collections.add_manual_deposit(uuid, text, date, text, numeric, uuid)
  TO claims_reader;
GRANT EXECUTE ON FUNCTION collections.remove_manual_deposit(uuid, bigint, uuid)
  TO claims_reader;

-- cmd_rollup_writer gets EXECUTE on NEITHER. It has no business creating or removing a manual
-- deposit, and the absent privilege is the guarantee.

-- 7. Verification (run manually after apply) ----------------------------------
-- -- the tag is allowed and the lifecycle columns exist:
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='collections.daily_collections'::regclass
--    AND conname='daily_collections_source_tag_ck';   -- expect ... 'manual' ...
--
-- -- ⚠️ THE ADDITIVITY PROOF. Insert a manual row on a facility-day that ALREADY has a CMD
-- -- deposit, and confirm the view returns BOTH and the sum grows by exactly the manual amount.
-- -- Run inside a transaction and ROLL BACK.
-- BEGIN;
--   SELECT sum(gross_amount) FROM collections.daily_collections_resolved
--    WHERE business_entity_id='<bxr>' AND facility_code='NASH' AND payment_date='2026-08-07';
--   SELECT collections.add_manual_deposit('<bxr>','NASH','2026-08-07','EFT',100.00,'<actor>');
--   SELECT sum(gross_amount), count(*) FROM collections.daily_collections_resolved
--    WHERE business_entity_id='<bxr>' AND facility_code='NASH' AND payment_date='2026-08-07';
--     -- expect: sum is EXACTLY 100.00 higher, count is one MORE than before.
--     -- If the sum is unchanged, or the count is the same, 'manual' is being ranked instead of
--     -- added and the CMD figure may have been replaced — STOP AND REVERT.
-- ROLLBACK;
--
-- -- soft delete round trip (idempotent, and refuses a non-manual row):
-- -- SELECT collections.remove_manual_deposit('<bxr>', <manual id>, '<actor>');  -- true
-- -- SELECT collections.remove_manual_deposit('<bxr>', <manual id>, '<actor>');  -- FALSE
-- -- SELECT collections.remove_manual_deposit('<bxr>', <a cmd row id>, '<actor>'); -- FALSE
--
-- -- ⚠️ THE CRON GUARD CANNOT BE VERIFIED AS postgres. postgres has rolbypassrls, so it sees
-- -- and can delete everything regardless of policy — checking a per-role RLS restriction from
-- -- a role that bypasses RLS cannot detect a failure, by construction. Read the policy text:
-- SELECT policyname, pg_get_expr(polqual, polrelid) FROM pg_policy p
--   JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname='daily_collections'
--    AND policyname='cmd_daily_writer_delete';   -- expect ... AND source_tag <> 'manual'
-- -- and confirm the next hourly cmd-explorer run still logs a normal deleted/inserted count.
-- =============================================================================
