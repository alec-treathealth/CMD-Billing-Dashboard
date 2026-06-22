-- One-time data repair: collapse duplicate null-credit claim_line rows to one per
-- charge (survivor = MIN(id) per (tenant, charge); repoint-before-delete).
-- Executed WET 2026-06-22 against dbpabchpvipipkzkogta, tenant af504ab6-...-58de4088.
-- NOT part of the schema replay chain. Idempotent (no-op once clean). Pooler-safe
-- (single DO block, inlined tenant literal, simple protocol). PHI-safe (counts only).
--
-- CONTEXT: the 002 null-credit idempotency bug (see migration 007) re-inserted
-- 6,842 null-credit rows on a backfill re-run. This repairs the data; 007 prevents
-- recurrence. PREREQUISITE: the child FK indexes (folded into 007) must exist first,
-- else the cascade-checked DELETE seq-scans payment_residual/brain1_features per row.
-- ORDER: cleanup (this) -> migration 007 -> 002 dedup-key change safe for future runs.
--
-- FKs era_adjustment / payment_residual / brain1_features -> claim_line.id are ALL
-- ON DELETE CASCADE, so children are REPOINTED off the delete-set BEFORE deleting.
-- Validated 2026-06-22: repoint 159 brain1 (era 0, payment_residual 0), delete 7,001,
-- claim_line 157,901 -> 150,900, child row counts unchanged. Hard-coded asserts abort
-- if the live state has drifted from that validation.

DO $$
DECLARE
  dry_run boolean := false;   -- set true to rehearse (executes then rolls back)
  v_nonsurv bigint; v_b1_repoint bigint; v_era_ref bigint; v_pr_ref bigint;
  v_cl_pre bigint; v_b1_pre bigint; v_pr_pre bigint; v_ea_pre bigint;
  v_cl_post bigint; v_b1_post bigint; v_pr_post bigint; v_ea_post bigint;
BEGIN
  SELECT count(*) INTO v_cl_pre FROM staging.claim_line   WHERE business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088';
  SELECT count(*) INTO v_b1_pre FROM staging.brain1_features;
  SELECT count(*) INTO v_pr_pre FROM staging.payment_residual;
  SELECT count(*) INTO v_ea_pre FROM staging.era_adjustment WHERE business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088';

  CREATE TEMP TABLE _surv ON COMMIT DROP AS
    SELECT charge_debit_id, min(id) AS survivor_id FROM staging.claim_line
    WHERE business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088' AND credit_id IS NULL
    GROUP BY charge_debit_id;
  CREATE TEMP TABLE _nonsurv ON COMMIT DROP AS
    SELECT cl.id, s.survivor_id FROM staging.claim_line cl JOIN _surv s USING (charge_debit_id)
    WHERE cl.business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088' AND cl.credit_id IS NULL AND cl.id <> s.survivor_id;

  SELECT count(*) INTO v_nonsurv FROM _nonsurv;
  IF v_nonsurv = 0 THEN RAISE NOTICE 'cleanup: 0 non-survivors -- already clean, no-op'; RETURN; END IF;

  SELECT count(*) INTO v_era_ref    FROM staging.era_adjustment   WHERE claim_line_id IN (SELECT id FROM _nonsurv);
  SELECT count(*) INTO v_pr_ref     FROM staging.payment_residual WHERE claim_line_id IN (SELECT id FROM _nonsurv);
  SELECT count(*) INTO v_b1_repoint FROM staging.brain1_features  WHERE claim_line_id IN (SELECT id FROM _nonsurv);

  IF v_nonsurv    <> 7001 THEN RAISE EXCEPTION 'ABORT pre: nonsurvivors=% (expected 7001)', v_nonsurv; END IF;
  IF v_era_ref    <> 0    THEN RAISE EXCEPTION 'ABORT pre: era refs delete-set=% (expected 0)', v_era_ref; END IF;
  IF v_pr_ref     <> 0    THEN RAISE EXCEPTION 'ABORT pre: payment_residual refs delete-set=% (expected 0)', v_pr_ref; END IF;
  IF v_b1_repoint <> 159  THEN RAISE EXCEPTION 'ABORT pre: brain1 repoint=% (expected 159)', v_b1_repoint; END IF;

  UPDATE staging.brain1_features b SET claim_line_id = n.survivor_id
  FROM _nonsurv n WHERE b.claim_line_id = n.id;

  DELETE FROM staging.claim_line WHERE id IN (SELECT id FROM _nonsurv);

  SELECT count(*) INTO v_cl_post FROM staging.claim_line   WHERE business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088';
  SELECT count(*) INTO v_b1_post FROM staging.brain1_features;
  SELECT count(*) INTO v_pr_post FROM staging.payment_residual;
  SELECT count(*) INTO v_ea_post FROM staging.era_adjustment WHERE business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088';

  IF v_cl_post <> 150900          THEN RAISE EXCEPTION 'ABORT post: claim_line=% (expected 150900)', v_cl_post; END IF;
  IF v_cl_post <> v_cl_pre - 7001 THEN RAISE EXCEPTION 'ABORT post: claim_line delta<>7001 (% -> %)', v_cl_pre, v_cl_post; END IF;
  IF v_b1_post <> v_b1_pre        THEN RAISE EXCEPTION 'ABORT post: brain1 changed (% -> %)', v_b1_pre, v_b1_post; END IF;
  IF v_pr_post <> v_pr_pre        THEN RAISE EXCEPTION 'ABORT post: payment_residual changed (% -> %)', v_pr_pre, v_pr_post; END IF;
  IF v_ea_post <> v_ea_pre        THEN RAISE EXCEPTION 'ABORT post: era changed (% -> %)', v_ea_pre, v_ea_post; END IF;
  PERFORM 1 FROM (SELECT charge_debit_id FROM staging.claim_line
                  WHERE business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088' AND credit_id IS NULL
                  GROUP BY charge_debit_id HAVING count(*)>1) d;
  IF FOUND THEN RAISE EXCEPTION 'ABORT post: null-credit dup groups remain'; END IF;

  IF dry_run THEN
    RAISE EXCEPTION 'DRY-RUN OK (rolled back): repoint % brain1, delete %, claim_line %->%, children unchanged (b1 %, pr %, era %)',
      v_b1_repoint, v_nonsurv, v_cl_pre, v_cl_post, v_b1_post, v_pr_post, v_ea_post;
  END IF;
  RAISE NOTICE 'CLEANUP COMMITTED: repoint % brain1, delete %, claim_line %->%', v_b1_repoint, v_nonsurv, v_cl_pre, v_cl_post;
END $$;
