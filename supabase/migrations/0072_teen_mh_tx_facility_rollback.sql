-- 0072 ROLLBACK — restore the pre-0072 alias merge (TEEN MENTAL HEALTH TEXAS LLC → TREAT_TX).
--
-- Reverses the alias repoint in 0072 §3. This is the meaningful, safe revert.
--
-- The TEEN_MH_TX facilities row is DELIBERATELY LEFT IN PLACE: (a) it is a harmless reference row, and
-- (b) cmd_facility_aliases.facility_code has a FK to facilities.facility_code, so deleting the facility
-- while any alias/other row still points at TEEN_MH_TX would raise a FK violation. Only remove the
-- facility row if you are certain nothing references it (the billing-audit plane and 0052 do NOT FK to
-- collections.facilities, but confirm cmd_facility_aliases first) — the guarded block below does that.
--
-- OWNERSHIP: postgres-owned tables → plain DML, no `set role`. IDEMPOTENT: keyed on literals.

-- 1. Alias back to TREAT_TX (the 0042 state).
update collections.cmd_facility_aliases
   set facility_code = 'TREAT_TX'
 where facility_text = 'TEEN MENTAL HEALTH TEXAS LLC';

-- 2. Optional: drop the facility row ONLY if nothing in cmd_facility_aliases still references it.
--    (Left commented — enable deliberately. The DELETE is guarded so it no-ops rather than FK-erroring.)
-- delete from collections.facilities f
--  where f.facility_code = 'TEEN_MH_TX'
--    and not exists (select 1 from collections.cmd_facility_aliases a where a.facility_code = f.facility_code);
