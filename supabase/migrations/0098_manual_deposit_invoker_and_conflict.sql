-- 0098 — restore security_invoker on daily_collections_resolved, and make add_manual_deposit
--        survive a same-day collision instead of raising 23505.
--
-- WHY
--   Two defects found reviewing 0096 (applied live 2026-08-10). Both are live in production right
--   now; neither is caught by any test, because both are properties of the DATABASE rather than of
--   the code that calls it.
--
--   (1) SECURITY_INVOKER WAS SILENTLY STRIPPED. 0096 §3 redefined
--       collections.daily_collections_resolved with `CREATE OR REPLACE VIEW … AS` and no WITH
--       clause. PostgreSQL's DefineVirtualRelation appends an AT_ReplaceRelOptions subcommand whose
--       option list is exactly what the statement supplied, and ATExecSetRelOptions treats that list
--       as COMPLETE — so an absent WITH clause does not "leave the options alone", it RESETS them.
--       Verified by execution on a throwaway instance: reloptions went {security_invoker=true} →
--       NULL across a plain CREATE OR REPLACE. 0014, 0015 and 0032 every one of them set the option
--       explicitly; 0096 dropped it by omission.
--
--       Confirmed live: `select reloptions from pg_class where oid =
--       'collections.daily_collections_resolved'::regclass` returns NULL. The view is owned by
--       postgres, which has rolbypassrls, so it runs with DEFINER semantics — base-table RLS on
--       collections.daily_collections does not apply to anything read through it.
--
--       ⚠ SCOPE THIS HONESTLY: NO ROLE CAN OBSERVE A DIFFERENCE TODAY, and an earlier draft of this
--       header overstated it in two ways that were checked and found false.
--         · It claimed Supabase advisor lint 0010 (security_definer_view) flags the view. It does
--           not — measured, the only security lint on this project is function_search_path_mutable
--           on collections.facility_assignments_guard. Lint 0010 only considers views in
--           PostgREST-exposed schemas, and `collections` is not one.
--         · It claimed cmd_rollup_writer's GUC-scoped 0033 policy stops reaching view readers.
--           Measured: has_table_privilege('cmd_rollup_writer',
--           'collections.daily_collections_resolved','select') is FALSE — that role cannot read the
--           view at all, so the escalation path does not exist.
--       The only role that reads the view is claims_reader, whose policy is
--       `collections_reader_select_daily USING (true)` — so invoker vs definer changes not one row.
--
--       WHAT IS ACTUALLY BROKEN, THEN: a guarantee 0014, 0015 and 0032 each set on purpose is now
--       silently absent. 0014's header states it plainly — "security_invoker so the base-table RLS
--       applies as the querying role (claims_reader), exactly as a direct table read would." Today
--       that costs nothing. It costs everything on the day someone narrows claims_reader's policy to
--       a tenant predicate, or grants cmd_rollup_writer SELECT on the view: they will believe RLS is
--       carrying the read path, it will not be, and NOTHING will say so — not a test, not a lint,
--       not an advisor. This is a latent defense-in-depth regression, not a live data leak, and it
--       is worth one ALTER because restoring a deliberately-set property is cheaper than
--       rediscovering its absence from a tenancy incident.
--
--   (2) add_manual_deposit COULD NOT SURVIVE A COLLISION. 0031 created
--         create unique index collections_daily_bucket on collections.daily_collections
--           (business_entity_id, facility_code, source_group_code, payment_date, source_tag)
--           nulls not distinct
--       and 0096's INSERT writes source_group_code = NULL with source_tag = 'manual', so NULLS NOT
--       DISTINCT collapses the key to (tenant, facility, day). With no ON CONFLICT clause:
--         · a genuine second deposit on one facility-day raised 23505, which addManualDeposit
--           caught into `write_failed` and the UI rendered as "That may not have been saved" — an
--           unrecoverable dead end for the exact case 0096's own header refuses to lose ("SWALLOWS a
--           genuine second payment on the same day, invisibly");
--         · and worse, PERMANENTLY: remove_manual_deposit is a soft delete and removed_at is not in
--           the index, so a tombstone occupies its key forever. Record a typo, remove it, re-record
--           the correct amount → 23505 with no path back, for that facility-day, for good.
--       0096 shipped 033's soft-delete shape without 033's corresponding revive-on-conflict. Only
--       ONE manual row exists in production, which is why neither path was ever exercised.
--
-- WHAT THE CONFLICT ARM DOES — REVIVE A TOMBSTONE, REFUSE A LIVE ROW OUT LOUD
--     · EXISTING ROW IS A TOMBSTONE → amounts are REPLACED, removal cleared, `created_by` moves to
--       the new actor (a revived row is a new decision by whoever re-recorded it). This is 033's
--       REVIVE and it is what unblocks the permanent lockout.
--     · EXISTING ROW IS LIVE → the insert is REFUSED with SQLSTATE DP001 and a message naming the
--       row already there. It does NOT sum.
--
--   ⚠ AN EARLIER DRAFT SUMMED ON THE LIVE ARM. IT WAS WRONG, AND THE REASON IS WORTH KEEPING.
--   The conflict key is (business_entity_id, facility_code, source_group_code, payment_date,
--   source_tag) — with source_group_code NULL and source_tag 'manual' that is just
--   (tenant, facility, day). There is NO deposit id, NO amount and NO idempotency token in it, and
--   the client payload (facilityCode, paymentDate, method, amount) carries none either. So a
--   resubmit of the same deposit is byte-identical to a genuine second deposit — the database
--   cannot tell them apart, and neither can this function.
--
--   Under a summing arm, a double-submit silently becomes double the money. That is not a remote
--   risk here: the UI does not refresh MTD after a successful write (the collections loaders key on
--   [view]/[scope] and ignore the write), so "I recorded it, nothing moved, I'll record it again" is
--   the EXPECTED operator behaviour, and the client's only guard is `disabled={busy}` — React state
--   applied on re-render, which a fast double-click or a retried request can outrun. Trading a loud
--   23505 for a silent doubling would have made this migration a downgrade on the failure mode that
--   actually matters. Ratified by Alec, 2026-08-10.
--
--   The genuine two-checks-in-one-day case is therefore an explicit operator action — remove the
--   row and record the combined amount — rather than an inference the database makes on their
--   behalf. Nothing is lost, which is what 0096's header demands; it just is not silent.
--
--   ⚠ THE DO UPDATE ARM CAN NEVER TOUCH A NON-MANUAL ROW, and that is structural rather than
--   defensive. `source_tag` is part of the conflict key and this INSERT always supplies 'manual',
--   so the only row it can ever conflict with is another manual row. A cmd / workbook /
--   deposit_sheet row for the same facility-day has a different key and is untouched — which is
--   what keeps this migration off the hourly crons' data.
--
--   The `WHERE dc.removed_at IS NOT NULL` on the DO UPDATE is what makes the two arms different,
--   and it is the ONE case where a silently-skipped upsert is wanted: the skip is the signal that a
--   LIVE row was in the way, and the IF below turns it into the DP001 exception. Do not remove the
--   IF — without it the function returns NULL to a caller that reads it as a successful write.
--
-- PHI DISCIPLINE
--   No PHI. collections.daily_collections holds facility codes, dates and dollar totals — no
--   member, no claim, no identifier. Nothing here is logged.
--
-- OWNERSHIP
--   ⚠ NO `SET ROLE claims_admin` — deliberately, and this is the `collections` plane's own rule
--   (CLAUDE.md): objects here are owned by postgres, and a SET ROLE would DOWNGRADE the applying
--   role from owner to non-owner and fail with 42501. Both statements below require ownership:
--   ALTER VIEW … SET (…) must run as the view's owner, and CREATE OR REPLACE FUNCTION preserves the
--   existing owner (postgres) only when run as it. Apply as postgres via apply_migration.
--
-- IDEMPOTENT
--   Yes. ALTER VIEW … SET is idempotent by definition; CREATE OR REPLACE FUNCTION replaces the body
--   in place, keeping the 0096 grants (REVOKE ALL FROM public / GRANT EXECUTE TO claims_reader) and
--   the owner intact — a DROP + CREATE would not, which is why this is a replace.
--
-- DEPENDENCY
--   0031 (collections_daily_bucket), 0032 (the view's security_invoker posture), 0096 (the function
--   and the view's current shape). Pure transactional DDL — no CONCURRENTLY, no VACUUM — so this
--   runs inside apply_migration's transaction, unlike 0081/0092.
--
-- Rollback: supabase/migrations/0098_manual_deposit_invoker_and_conflict_rollback.sql
--   ⚠ The rollback restores 0096's behaviour, which means it RE-INTRODUCES both defects. It exists
--   for completeness, not because reverting is ever the right move here.

-- 1. Restore the invoker posture on the resolved view -------------------------------------------
--
-- ALTER VIEW … SET rather than another CREATE OR REPLACE VIEW: the view's DEFINITION is correct as
-- 0096 left it (the additive third branch is right and is in production), and only the reloption
-- was lost. Re-stating the whole SELECT to fix one option would put a second full copy of that
-- definition in the repo and invite the two to drift.
ALTER VIEW collections.daily_collections_resolved SET (security_invoker = true);

-- 2. Make the manual-deposit insert survive its own unique index ---------------------------------
--
-- Body is 0096's, unchanged above the INSERT — same validation, same messages, same gross =
-- checks + eft derivation. The ON CONFLICT arm and the v_id assertion are the whole diff.
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
  v_live_id    bigint;
  v_live_gross numeric;
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
  -- splits the bar on it), so it is computed here rather than passed in and trusted. It holds
  -- across BOTH conflict arms: summing adds the same value to each side, and reviving replaces
  -- all three together.
  INSERT INTO collections.daily_collections AS dc (
    collections_raw_id, facility_code, source_group_code, payment_date,
    checks_amount, eft_amount, gross_amount, source_tag, business_entity_id, created_by
  ) VALUES (
    NULL, p_facility_code, NULL, p_payment_date,
    CASE WHEN p_method = 'Check' THEN p_amount ELSE 0 END,
    CASE WHEN p_method = 'EFT'   THEN p_amount ELSE 0 END,
    p_amount, 'manual', p_business_entity_id, p_actor
  )
  ON CONFLICT (business_entity_id, facility_code, source_group_code, payment_date, source_tag)
  DO UPDATE SET
    -- TOMBSTONE ONLY (see the WHERE): replace the withdrawn amounts outright rather than adding to
    -- them — adding would resurrect money an operator deliberately took back.
    checks_amount = EXCLUDED.checks_amount,
    eft_amount    = EXCLUDED.eft_amount,
    gross_amount  = EXCLUDED.gross_amount,
    created_by    = EXCLUDED.created_by,
    -- Both, together: daily_collections_removal_shape_ck asserts
    -- (removed_at IS NULL) = (removed_by IS NULL), so clearing one alone violates it.
    removed_at    = NULL,
    removed_by    = NULL
  WHERE dc.removed_at IS NOT NULL
  RETURNING dc.id INTO v_id;

  -- v_id NULL means the DO UPDATE's WHERE rejected the row, i.e. a LIVE manual deposit already
  -- holds this facility-day. Refuse, and say which row — "that may not have been saved" is what
  -- the bare 23505 produced, and it told the operator nothing they could act on.
  IF v_id IS NULL THEN
    SELECT d.id, d.gross_amount INTO v_live_id, v_live_gross
      FROM collections.daily_collections d
     WHERE d.business_entity_id = p_business_entity_id
       AND d.facility_code      = p_facility_code
       AND d.source_group_code  IS NULL
       AND d.payment_date       = p_payment_date
       AND d.source_tag         = 'manual'
       AND d.removed_at         IS NULL;
    -- DP001 is a user-defined SQLSTATE (no standard class starts 'DP'), chosen so the Server Action
    -- can MAP this case instead of string-matching a message that will be reworded. It is the one
    -- signal separating "already recorded" from a genuine write failure.
    RAISE EXCEPTION
      'add_manual_deposit: a manual deposit already exists for % on % (id %, gross %)',
      p_facility_code, p_payment_date, v_live_id, v_live_gross
      USING ERRCODE = 'DP001',
            HINT    = 'Remove that row and record the combined amount, or use the correct date.';
  END IF;

  RETURN v_id;
END;
$fn$;

-- 3. Verification (run manually after apply) ----------------------------------------------------
--
-- a. The view is an invoker view again. Expect: {security_invoker=true}
--      select reloptions from pg_class
--       where oid = 'collections.daily_collections_resolved'::regclass;
--
-- b. The 0096 grants and owner survived the CREATE OR REPLACE. Expect postgres / true / false:
--      select pg_get_userbyid(proowner) as owner,
--             has_function_privilege('claims_reader',  oid, 'execute') as reader_exec,
--             has_function_privilege('cmd_rollup_writer', oid, 'execute') as writer_exec
--        from pg_proc
--       where oid = 'collections.add_manual_deposit(uuid,text,date,text,numeric,uuid)'::regprocedure;
--
-- c. THE TWO COLLISIONS, END TO END. Run in a transaction and ROLL BACK — this writes money.
--    Use a facility-day with NO existing manual row.
--      begin;
--        select collections.add_manual_deposit(:beid,'NASH','2026-08-07','Check',10000,:actor);
--
--        -- (i) LIVE COLLISION → must RAISE, SQLSTATE DP001, naming the row already there.
--        --     It must NOT return an id and must NOT change the stored amount.
--        select collections.add_manual_deposit(:beid,'NASH','2026-08-07','EFT',22000,:actor);
--        --   expected: ERROR  a manual deposit already exists for NASH on 2026-08-07 (id …, gross 10000.00)
--        --   ⚠ that error ABORTS the transaction — reconnect or use a SAVEPOINT around this call
--        --     if you want to continue to (ii) in one session.
--        -- still 10000/0/10000, untouched:
--        select checks_amount, eft_amount, gross_amount from collections.daily_collections
--         where business_entity_id = :beid and facility_code = 'NASH'
--           and payment_date = '2026-08-07' and source_tag = 'manual';
--
--        -- (ii) TOMBSTONE REVIVE → must succeed, REPLACE, and clear both removal columns.
--        select collections.remove_manual_deposit(:beid, :that_id, :actor);
--        select collections.add_manual_deposit(:beid,'NASH','2026-08-07','Check',500,:actor);
--        -- expect ONE LIVE row at 500/0/500 — not 10500, and no 23505:
--        select checks_amount, eft_amount, gross_amount, removed_at, removed_by
--          from collections.daily_collections
--         where business_entity_id = :beid and facility_code = 'NASH'
--           and payment_date = '2026-08-07' and source_tag = 'manual';
--      rollback;
--
-- d. A CMD row for the same facility-day was NOT touched by any of the above (different
--    source_tag ⇒ different key). Expect the pre-existing cmd row, unchanged:
--      select id, gross_amount, source_tag from collections.daily_collections
--       where business_entity_id = :beid and facility_code = 'NASH'
--         and payment_date = '2026-08-07' and source_tag = 'cmd';
--
-- e. The hourly crons still work. After the next :00/:30 cmd-explorer run, confirm a normal
--    deleted/inserted count in the run log — 0096 narrowed the writer policies to
--    source_tag <> 'manual' and this migration does not touch them, but the table is
--    production-critical and the check is cheap.
