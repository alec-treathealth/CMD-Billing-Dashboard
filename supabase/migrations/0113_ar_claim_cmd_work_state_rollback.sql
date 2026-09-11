-- 0113 ROLLBACK — drops the snapshot-derived work state from claims.ar_claim.
--
-- Safe to run: the column is derived, never authored by a human, and nothing else references it.
-- Every value in it is reproducible from the next snapshot run, so dropping it loses no fact that
-- CMD does not still hold. The HUMAN dispositions in claims.ar_claim_work are a different table
-- and are NOT touched here.
--
-- After this runs, the five non-`open` work-status chips return zero rows again — that is the
-- pre-0113 behaviour, not a new defect.
--
-- OWNERSHIP: claims_admin. IDEMPOTENT: if exists.

set role claims_admin;

drop index if exists claims.ar_claim_cmd_work_state_idx;

alter table claims.ar_claim
  drop constraint if exists ar_claim_cmd_work_state_check;

alter table claims.ar_claim
  drop column if exists cmd_work_state;

reset role;
