-- 0051: claims.payer_alias seed — report payer_name → sheet carrier_text match rules.
--
-- ⚠️ DRAFT — NOT APPLIED, NOT COMMITTED until Alec's explicit go (D2 ruling: show
-- before applying). Rollback: 0051_payer_alias_seed_rollback.sql (delete-by-alias_text).
-- Renamed from 0050 (0050 claimed by another session — see veris-data-notes reservations).
--
-- PROVENANCE (D2 item 1): the applied 0049 deliberately carried NO alias seeds — its
-- header deferred them until match rules could rest on REAL report payer vocabulary
-- (the Phase-0 proposal was built from the cmd_explorer_rows PROXY vocabulary while
-- the report pull was blocked). This file is that deferred seed, now grounded in the
-- live CAMH IP vocabulary (30 distinct Claim Primary Payer Name values, 2026-07-13).
-- EVIDENCE LIMIT stated plainly: vocabulary observed for ONE facility (CAMH). Rules
-- below are seeded only where the pattern is either directly evidenced or
-- family-structural; everything needing a business ruling is EXCLUDED and enumerated.
-- The first full-roster ingest re-verifies coverage (unmatched counts in sync output).
--
-- CONSEQUENCE UNTIL APPLIED: claims.payer_alias is empty ⇒ decision resolution cannot
-- attach a billing_code_decision to any audit row ⇒ CODE_DECISION_MISMATCH and
-- STOPPED_CODE_STILL_BILLED cannot fire. (MISSING_AUTH / STALE_AT_PAYER / ON_HOLD_AGED
-- / NEEDS_RENEGOTIATING / MISSING_POA are alias-independent.)
--
-- PRECEDENCE CONVENTION — HIGHEST WINS (Alec's locked convention, 2026-07-13):
--   more specific = HIGHER number = wins.  exacts 85–90 · family patterns 40–70 ·
--   catch-all 10.  ⚠️ DELIBERATE FLIP: this session's earlier 0051 draft (and 0049's
--   header prose) described LOWEST-wins; that is SUPERSEDED. The authoritative,
--   tested contract now lives in src/billingAudit/payerAlias.ts (resolvePayerAlias):
--   candidates = alias rows whose rule matches the UPPER-CASED report payer_name;
--   the HIGHEST precedence wins; ties break on LOWEST id (deterministic). Resolution
--   is IN-PROCESS (TS) over rows fetched by the reader — match_kind 'exact' (equality),
--   'like' (SQL-LIKE semantics), 'regex' (JS RegExp over the upper-cased name). This
--   supersedes 0049's tentative "POSIX ~ / lowest-wins" wording. Test:
--   test/billingPayerAlias.test.ts (asserts CA-exact and Blue-Cards both beat the
--   catch-all, plus tie-break + catch-all-as-floor).
--
-- FACILITY SCOPING — Phase-3 open item (recorded, not solved here): payer_alias is
-- tenant-level; two facilities spell the same concept differently (CAMH "Anthem BCBS
-- CALIFORNIA" vs Treat CA "Anthem of CALIFORNIA", both matching ANTHEM BLUE CROSS
-- CALIFORNIA). The flag engine resolves per (facility, payer) — candidate carriers are
-- the FACILITY's decision carrier_texts, so a global tie never mis-routes across
-- facilities. This seed defines the match rules + ordering; facility scoping is the
-- consuming query's job (Phase 3).
--
-- NEEDS-RULING — DELIBERATELY EXCLUDED (stay unmatched until Alec rules; surfaced by
-- every sync run's unmatched_carriers):
--   'BCBS AR - Walmart plan'          plan-level discriminator unknown (group#? prefix?)
--   'BCBS - Blues' / 'BCBS - Anthems' KWC's blues-vs-anthem split needs a discriminator
--   'BCBS MA' / 'BCBS OK'             LSMH/DMH vocabulary unobserved (likely BLUECARD
--                                     PROGRAM OF MA/OK — verify at first full ingest)
--   'BCBS TX - MH (ZGP/NON-ZGP)' and 'BCBS TX - SUD (DTX/RTC)'
--                                     payer side is likely BLUECARD PROGRAM OF TX, but
--                                     MH-vs-SUD needs a payer-side discriminator ruling
--                                     (the ZGP/LOC sub-cohorts are decision-side, not
--                                     alias-side)
--   'Highmark BCBS'                   NMH/TBH vocabulary unobserved
--   'BCBS' (Treat TX/WA)              too broad to guess a family boundary unseen
--   'Anthem BCBS (ALL OTHERS)' / 'Anthem BCBS (ALL OTHER)'
--                                     per-facility "all other Anthem" buckets that
--                                     overlap both the Anthem family and the catch-all;
--                                     how they differ from 'Anthem BCBS' needs a ruling

set role claims_admin;

insert into claims.payer_alias
  (business_entity_id, alias_text, match_kind, match_value, precedence) values
  -- 90 — exacts, directly evidenced in the CAMH vocabulary (most specific)
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'Anthem BCBS CALIFORNIA', 'exact', 'ANTHEM BLUE CROSS CALIFORNIA', 90),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'Anthem of CALIFORNIA',   'exact', 'ANTHEM BLUE CROSS CALIFORNIA', 90),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'BCBS IL (Blue Card)',    'exact', 'BLUECARD PROGRAM OF IL', 90),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'BCBS TX (Blue Card)',    'exact', 'BLUECARD PROGRAM OF TX', 90),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'GEHA',                   'exact', 'GEHA', 90),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'Cigna',                  'exact', 'CIGNA', 90),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'UMR',                    'exact', 'UMR FKA UMR WAUSAU', 90),
  -- 60/50 — family rules (structural; cover the live BUECARD typo + spacing). Blue-Cards
  -- and Optum are disjoint from Anthem, so their relative order never collides; kept in-band.
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'Blue Cards',             'regex', '^(BLUE ?CARD|BUECARD)', 60),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'Optum/UHC/UMR',          'regex', '^(OPTUM|UHC|UNITED|UMR)', 60),
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'Anthem BCBS',            'regex', '^ANTHEM', 50),
  -- 10 — the blues catch-all (floor; report-payer catch-all matches surface in the
  -- Phase-3 flag engine, NOT in this sync's stats — the sync attributes SHEET carriers).
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'All other BCBS (Including Anthem)', 'regex',
   '(BCBS|BLUE CROSS|BLUE ?CARD|BUECARD|ANTHEM|HIGHMARK|HORIZON)', 10)
on conflict (business_entity_id, alias_text) do update
  set match_kind = excluded.match_kind,
      match_value = excluded.match_value,
      precedence = excluded.precedence;

reset role;
