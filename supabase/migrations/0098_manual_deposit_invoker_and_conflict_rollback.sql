-- ROLLBACK for 0098 — restore 0096's view posture and 0096's add_manual_deposit body.
--
-- ⚠ THIS RE-INTRODUCES BOTH DEFECTS 0098 FIXED, DELIBERATELY AND BY DEFINITION. A rollback's job is
-- to return the database to the prior state, and the prior state is the broken one. Read this
-- before running it:
--
--   · §1 turns collections.daily_collections_resolved back into a DEFINER view. Base-table RLS
--     stops applying to view readers. No role can observe a difference today (claims_reader's
--     policy is USING (true), and cmd_rollup_writer has no SELECT on the view at all) — which is
--     precisely why nothing will tell you it happened.
--   · §2 restores the bare INSERT, so a second manual deposit on one facility-day raises 23505
--     again, AND a soft-removed row locks its facility-day permanently with no path back.
--
-- The only honest reason to run this is that 0098 itself broke something. If the goal is instead to
-- stop the new DP001 refusal, do NOT roll back the view with it — run §2 alone.
--
-- OWNERSHIP: no `SET ROLE` — the collections plane is postgres-owned and a SET ROLE would downgrade
-- the applying role to non-owner and fail 42501 on both statements. Apply as postgres.
-- IDEMPOTENT: yes; both statements are unconditional replacements.

-- 1. Back to a definer view (0096's state) ------------------------------------------------------
ALTER VIEW collections.daily_collections_resolved RESET (security_invoker);

-- 2. Back to the bare INSERT (0096's body, verbatim) --------------------------------------------
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
  IF NOT EXISTS (SELECT 1 FROM core.business_entity b WHERE b.id = p_business_entity_id) THEN
    RAISE EXCEPTION 'add_manual_deposit: unknown business_entity_id';
  END IF;

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

-- 3. Verification (run manually after apply) ----------------------------------------------------
--
-- a. The view is a definer view again (0096's state). Expect NULL:
--      select reloptions from pg_class
--       where oid = 'collections.daily_collections_resolved'::regclass;
--
-- b. The function no longer refuses a live collision with DP001 — it raises 23505 instead.
--    In a transaction you then ROLL BACK, against a facility-day that already has a live manual row:
--      select collections.add_manual_deposit(:beid,'NASH','2026-08-07','EFT',1,:actor);
--    Expect: ERROR duplicate key value violates unique constraint "collections_daily_bucket"
--
-- c. Grants and owner survived the CREATE OR REPLACE. Expect postgres / true / false:
--      select pg_get_userbyid(proowner) as owner,
--             has_function_privilege('claims_reader',  oid, 'execute') as reader_exec,
--             has_function_privilege('cmd_rollup_writer', oid, 'execute') as writer_exec
--        from pg_proc
--       where oid = 'collections.add_manual_deposit(uuid,text,date,text,numeric,uuid)'::regprocedure;
--
-- d. The app still returns `deposit_exists` for SQLSTATE DP001, which this function no longer
--    raises. That mapping becomes dead but is HARMLESS — a 23505 falls to `write_failed` exactly as
--    it did before 0098. Leave the app code alone unless you are reverting that commit too.
