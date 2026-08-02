-- 0072 — TEEN MENTAL HEALTH TEXAS as its own facility (TEEN_MH_TX); repoint the 0042 alias off TREAT_TX.
--
-- WHY: TEEN MENTAL HEALTH TEXAS is a SEPARATE legal entity, not a typo of TREAT MENTAL HEALTH TEXAS —
-- owner-confirmed 2026-07-28 (CMD AR Automation Phase 0.1; findings in docs/veris-data-notes.md). Distinct
-- NPI (1124973086 vs TREAT_TX's 1316718554), own CMD customer account (10035166), own remittance address,
-- own Master-Facility-Profile tab. This is CONSISTENT with a prior ruling on the billing-audit plane:
-- 0052_audit_row_facility_code.sql (Alec "ruling A", 2026-07-14) already resolved
-- 'TEEN MENTAL HEALTH TEXAS LLC' → its OWN code TEEN_MH_TX, explicitly "not collections' TREAT_TX merge
-- (Jess follow-up)", and src/billingAudit/auditConfig.ts:56 carries account 10035166 as TEEN_MH_TX. This
-- migration closes that follow-up on the COLLECTIONS plane so the two planes agree.
--
-- The 0042 crosswalk currently folds 'TEEN MENTAL HEALTH TEXAS LLC' → TREAT_TX (0042:67, "owner-confirmed
-- typo"). That was the earlier (2026-07-10) understanding; it is now superseded. Any read-time join
-- through cmd_facility_aliases (Collections care_setting grouping; the forthcoming AR aging view) would
-- otherwise attribute Teen MH TX's charges to TREAT_TX. Nothing is mis-attributed TODAY (the census loop
-- excludes account 10035166 and stores facility as raw text, not via the alias — Phase 0), so this is a
-- prerequisite hardening BEFORE Teen MH TX is ever ingested by the collections/census crons, not a
-- correction of live data.
--
-- care_setting = 'OP': TEEN_MH_TX sits in the billing-audit OP roster (auditConfig.ts AUDIT_OP_CUSTOMERS,
-- alongside its sibling TREAT_TX which is OP in 0016), and the facility's profile lists IOP/OP rate lines.
-- SET, but low-confidence vs. the other seeded facts — confirm against the facility profile if it matters
-- for the Collections IP/OP grouping. NULL would drop it to the "Other" group; OP is the better default.
--
-- PHI DISCIPLINE (docs/CLAUDE.md §2): none. Facility reference labels only (code / name / account no. /
-- care setting / display acronym). No patient data, no identifiers.
--
-- OWNERSHIP: collections.facilities and collections.cmd_facility_aliases are postgres-owned (see the
-- plain, set-role-free seeds in 0006/0016/0035/0042). Apply as postgres — plain DDL/DML, no `set role`.
-- The INSERT/UPDATE run as owner and bypass RLS.
--
-- IDEMPOTENT: facilities INSERT ... ON CONFLICT (facility_code) DO UPDATE; the care_setting/acronym set
-- and the alias repoint are set-based UPDATEs keyed on a literal — re-running is a no-op.
-- DEPENDENCY: 0006 (collections.facilities + facility_code PK), 0016/0035 (care_setting col + CHECK incl.
-- 'OP'), 0042 (cmd_facility_aliases + its FK to facilities.facility_code). Ordering WITHIN this file
-- matters: the facilities row (§1) must exist before the alias repoint (§3) — the alias FK references it.
-- Rollback: 0072_teen_mh_tx_facility_rollback.sql (restores the alias → TREAT_TX; leaves the facilities
-- row in place by default — see the rollback header for why removing it can violate the alias FK).

-- ---------------------------------------------------------------------------
-- 1. The facility. facility_name mirrors TREAT_TX's curated style (no " LLC"); the CMD-export text
--    'TEEN MENTAL HEALTH TEXAS LLC' is resolved by the alias (§3), not by a name match here.
-- ---------------------------------------------------------------------------
insert into collections.facilities (facility_code, facility_name, account_number)
values ('TEEN_MH_TX', 'TEEN MENTAL HEALTH TEXAS', '10035166')
on conflict (facility_code) do update set
  facility_name  = excluded.facility_name,
  account_number = excluded.account_number;

-- ---------------------------------------------------------------------------
-- 2. Classification (care_setting + display_acronym), matching the 0016 seed shape.
-- ---------------------------------------------------------------------------
update collections.facilities
   set care_setting    = 'OP',
       display_acronym = 'TEEN MH TX'
 where facility_code = 'TEEN_MH_TX';

-- ---------------------------------------------------------------------------
-- 3. Repoint the alias: 'TEEN MENTAL HEALTH TEXAS LLC' → TEEN_MH_TX (was TREAT_TX in 0042). The TREAT_TX
--    rows (its own " LLC" text, §0042:58) are untouched.
-- ---------------------------------------------------------------------------
update collections.cmd_facility_aliases
   set facility_code = 'TEEN_MH_TX'
 where facility_text = 'TEEN MENTAL HEALTH TEXAS LLC';

-- ---------------------------------------------------------------------------
-- N. Verification (run manually after apply)
-- ---------------------------------------------------------------------------
-- Facility exists, OP, acronym set:
--   select facility_code, facility_name, account_number, care_setting, display_acronym
--     from collections.facilities where facility_code = 'TEEN_MH_TX';   -- 1 row, OP
-- Alias now points at TEEN_MH_TX and TREAT_TX's own text is unchanged:
--   select facility_text, facility_code from collections.cmd_facility_aliases
--    where facility_code in ('TEEN_MH_TX','TREAT_TX') order by facility_code, facility_text;
--   -- TEEN_MH_TX ← 'TEEN MENTAL HEALTH TEXAS LLC'
--   -- TREAT_TX   ← 'TREAT MENTAL HEALTH TEXAS LLC'
