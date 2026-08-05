-- 028 — VOB-side alias population + claims-side recoveries, from the IDF-cosine scorer
--
-- WHY: 026 measured the crosswalk as ASYMMETRIC — 85.1% of claim volume confirmed against only
--   60.0% of VOB members — and named the cause: section 8d proposed claims->canonical only, with no
--   symmetric VOB->canonical stage. That is the binding constraint, because **D2 resolution enters
--   from the member's VOB row**, not from claims. 919 of 1,120 VOB carrier names had no alias row at
--   all, covering 9,217 members.
--
--   026 also measured WHY the same trigram pass must not simply be pointed the other way: it
--   produced a confidently-wrong merge on the single largest gap in the book (CIGNA HEALTH PLANS,
--   6.5% of all claim volume, -> pi_health_plans_inc at 0.565), and no threshold separates wrong
--   from correct because both sit in 0.500-0.593. The replacement is IDF-weighted token cosine plus
--   three guards, built and measured in scripts/score-payer-aliases.ts — committed alongside this
--   migration because it IS this migration's provenance.
--
-- ⚠ THIS MIGRATION MINTS ZERO CONFIRMED MAPPINGS. Every row lands `needs_review = true`. It creates
--   a REVIEW QUEUE, not a crosswalk. Nothing here resolves a payer until a human confirms it: D2
--   reads CONFIRMED aliases only (needs_review = false), so an unreviewed row in this table is
--   invisible to resolution by construction, not by convention.
--
-- WHAT THE GUARDS DID (measured post-027, 695 rows proposed out of 1,062 candidates):
--   Guard A — identity-token coverage. A candidate covering NONE of the query's non-modifier tokens
--     is matching on filler. Blocked 182 VOB + 40 claims names. EXCLUDED from this migration.
--   Guard B — modifier-only match. If every token carrying >=10% of the score is generic or
--     geographic, the match rests on words that cannot identify a payer. Flagged 90 VOB + 2 claims.
--     EXCLUDED — not a proposal worth a reviewer's time.
--   Guard C — state mismatch (NEW, this migration's addition). Both names resolve a US state and the
--     states DIFFER. This is the class Guard B structurally cannot see: the match rests on a real
--     shared identity token and the STATE is what disagrees, e.g.
--     `BLUE CROSS AND BLUE SHIELD OF HAWAII -> pi_bcbs_texas @0.711`. INCLUDED, with a mandatory
--     review_note — the identity support is real and a human resolves it at a glance, so dropping it
--     would discard signal, while shipping it silently would be the 026 defect again.
--
-- EXPECTED WRONG-RATE, STATED NOT IMPLIED: ~3.8% of surviving proposals (8 of 212 testable
--   confirmed-tier pairs resolve to a genuinely different payer with no guard objecting — bucket F).
--   Roughly 1 in 27. This is a holdout estimate from a DIFFERENT population than these rows, so it
--   is an order-of-magnitude expectation, not a measured rate for this queue. The reviewer sees the
--   same figure in the scorer's own header. **Approve nothing in bulk.**
--
-- PHI DISCIPLINE: none. Payer names are public reference data; the scorer projected only name
--   strings and aggregate counts (no member id, member token, patient name, employer, group number
--   or dollar). Same posture as 025/026/027.
--
-- OWNERSHIP: born owned by `claims_admin` via SET ROLE. No new object is created except one
--   replaced CHECK constraint.
--
-- IDEMPOTENT: the payload is applied with ON CONFLICT (vocabulary, alias_norm) DO UPDATE, so a
--   second run rewrites the same values rather than erroring or double-inserting. The provenance
--   CHECK swap is DROP IF EXISTS + ADD.
--
-- ⚠ THE CONSTRAINT CHANGE — read this, it is the one destructive-looking step. 026's
--   `payer_alias_map_provenance` CHECK does not list 'idf_cosine', so the payload cannot land
--   without extending it. Section 1 DROPs and re-ADDs the constraint with the existing six values
--   PLUS 'idf_cosine'. Nothing is removed from the allowed set; the ADD is validated against
--   existing rows immediately, so an accidental narrowing would fail the apply rather than pass and
--   let a later insert break.
--
-- ⚠ HUMAN DECISIONS ARE PROTECTED STRUCTURALLY. 42 rows are human-authored or human-reviewed. The
--   ON CONFLICT DO UPDATE carries a WHERE clause that skips any row with `provenance = 'human'` or a
--   non-null `reviewed_at`. A machine proposal can never overwrite an adjudication — and section 5
--   asserts it by comparing a pre-captured snapshot, so the claim is tested, not just written.
--
-- RELATIONSHIP DEFAULT: every row is proposed as 'same_payer'. The scorer proposes IDENTITY, not
--   relationship kind — whether a name is really a carve-out or a TPA of the canonical is a reviewer
--   judgement, and 'same_payer' + needs_review is the honest placeholder. It is NOT an assertion
--   that no carve-outs are in this batch.
--
-- DEPENDENCY: 026 (both tables) and 027 (the dedup — the scorer's candidate surfaces were read
--   POST-027, so every canonical id here is a survivor; section 3 asserts no absorbed id appears).
--
-- Rollback: 028_payer_alias_idf_population_rollback.sql
--
-- PAYLOAD PROVENANCE: generated by
--   node --env-file=.env --import tsx scripts/score-payer-aliases.ts --fold-plurals --emit-sql
--   Guard A on · Guard B floor 0.10 · Guard C on · observed-token plural folding ON.
--   49 claims-side recoveries + 646 VOB-side proposals = 695 rows, 67 carrying a review_note.

set role claims_admin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Extend the provenance CHECK so 'idf_cosine' is expressible
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- A new provenance is a new KIND of evidence and deserves its own value rather than being smuggled in
-- as 'trigram_proposal'. Reusing the trigram label would make the two indistinguishable in review,
-- and they have different failure modes — that distinction is the entire reason this pass exists.

alter table ref.payer_alias_map drop constraint if exists payer_alias_map_provenance;
alter table ref.payer_alias_map add constraint payer_alias_map_provenance
  check (provenance in ('payer_alias_seed','exact_match','vob_payer_id',
                        'trigram_proposal','no_candidate','human','idf_cosine'));

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Snapshot the human decisions, so section 5 can PROVE none were touched
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

create temporary table _028_human_before as
select vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review,
       review_note, reviewed_by, reviewed_at
  from ref.payer_alias_map
 where provenance = 'human' or reviewed_at is not null;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. The payload
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

create temporary table _028_payload (
  vocabulary   text not null,
  alias_norm   text not null,
  canonical_id text not null,
  confidence   numeric(4,3) not null,
  review_note  text,
  primary key (vocabulary, alias_norm)
) on commit drop;

insert into _028_payload (vocabulary, alias_norm, canonical_id, confidence, review_note) values
  ('claims_primary_payer', 'TRIWEST VA CCN CLAIMS', 'pi_triwest', 0.505, null),
  ('claims_primary_payer', 'BLUE CROSS FEDERAL MEMBER', 'pi_bcbs_federal', 0.519, null),
  ('claims_primary_payer', 'HEALTHNET FAMILY PLAN', 'pi_healthnet', 0.624, null),
  ('claims_primary_payer', 'AETNA ASA-GEHA', 'pi_geha', 0.576, null),
  ('claims_primary_payer', 'MEDICA HEALTH PLAN SOLUTIONS', 'pi_medica', 0.648, null),
  ('claims_primary_payer', 'HEALTHSMART ACCEL NETWORK', 'pi_first_health_network', 0.350, null),
  ('claims_primary_payer', 'NORIDIAN JE PART A', 'pi_medicare', 0.550, null),
  ('claims_primary_payer', 'SENTARA HEALTH', 'pi_sentara_family_plan', 0.606, null),
  ('claims_primary_payer', 'TUFTS HEALTH PUBLIC PLANS', 'pi_tufts_health_plan', 0.726, null),
  ('claims_primary_payer', 'TRUSTMARK INSURANCE COMPANY', 'pi_trustmark', 0.642, null),
  ('claims_primary_payer', 'MEDICARE SOUTHERN CALIFORNIA', 'pi_medicare', 0.641, null),
  ('claims_primary_payer', 'ADVENTIST HC', 'pi_adventist_health_system', 0.488, null),
  ('claims_primary_payer', 'UNICARE LIFE  HEALTH INSURANCE COMPANY', 'pi_unicare', 0.555, null),
  ('claims_primary_payer', 'U.S. NETWORKS AND ADMINISTRATIVE SERVICES', 'pi_benefit_administrative_systems', 0.295, null),
  ('claims_primary_payer', 'VIRGINIA BLUE CROSS BLUE SHIELD', 'pi_bcbs_tennessee', 0.673, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('claims_primary_payer', 'MEDICARE DMERC REGION A', 'pi_medicare', 0.514, null),
  ('claims_primary_payer', 'ALLIED BENEFIT SYSTEMS LLC', 'pi_allied_benefits_systems', 0.803, null),
  ('claims_primary_payer', 'NIPPON LIFE', 'pi_nippon_life_insurance', 0.869, null),
  ('claims_primary_payer', 'OPTUM HEALTH BEHAVIORAL SOLUTIONS', 'pi_optum', 0.813, null),
  ('claims_primary_payer', 'CIGNA HEALTH PLANS- SECONDARY', 'pi_cigna', 0.849, null),
  ('claims_primary_payer', 'NORTHERN CALIFORNIA MEDICARE', 'pi_medicare', 0.668, null),
  ('claims_primary_payer', 'PACIFIC SOUTHWEST ADMINISTRATORS', 'pi_southwest_service_administrators', 0.648, null),
  ('claims_primary_payer', 'UHC OF UTAH', 'pi_united_healthcare_medicare_advantage', 0.309, null),
  ('claims_primary_payer', 'PINNACLE MEDICAL GROUP', 'pi_pinnacle', 0.611, null),
  ('claims_primary_payer', 'OPTUMHEALTH BEHAVIORAL', 'pi_optum', 0.824, null),
  ('claims_primary_payer', 'KAISER FOUNDATION OF THE NORTHWEST', 'pi_kaiser_washington', 0.460, null),
  ('claims_primary_payer', 'KAWEAH DELTA MEDICARE ADVANTAGE', 'pi_kaweah_delta', 0.713, null),
  ('claims_primary_payer', 'BENEFIT ADMINISTRATIVE SYSTEMS LLC - CONNECT CARE', 'pi_benefit_administrative_systems', 0.784, null),
  ('claims_primary_payer', 'BLUE CARD PROGRAM OF IL', 'pi_bcbs_illinois', 0.977, null),
  ('claims_primary_payer', 'CAPITAL DISTRICT PHYSICIANS HEALTH PLAN-CDPHP', 'pi_capital_blue_cross_pennsylvania', 0.297, null),
  ('claims_primary_payer', 'HEALTH NET OF CALIFORNIA AND OREGON CLAIMS', 'pi_health_net_california', 0.626, null),
  ('claims_primary_payer', 'EMPLOYEE BENEFIT MANAGEMENT SERV EBMS HEALTHEWEB', 'pi_ebms', 0.433, null),
  ('claims_primary_payer', 'HEALTH NET OF CALIFORNIA - ENCOUNTERS', 'pi_health_net_california', 0.700, null),
  ('claims_primary_payer', 'HEALTHCOMP-GILSBAR INC', 'pi_healthcomp', 0.583, null),
  ('claims_primary_payer', 'BLUE SHIELD OF NATIONAL CAPITOL AREA - CAREFIRST', 'pi_carefirst_bcbs', 0.344, null),
  ('claims_primary_payer', 'LOMA LINDA UNIVERSITY ADVENTIST', 'pi_adventist_health_system', 0.364, null),
  ('claims_primary_payer', 'CASH PAY', 'pi_self_pay', 0.496, null),
  ('claims_primary_payer', 'MEDICA BEHAVIORAL HEALTH UHC', 'pi_medica', 0.867, null),
  ('claims_primary_payer', 'MIDLANDS CHOICE', 'pi_first_choice_health_network', 0.344, null),
  ('claims_primary_payer', 'TUFTS', 'pi_tufts_health_plan', 0.832, null),
  ('claims_primary_payer', 'PENNSYLVANIA INDEPENDENCE BLUE CROSS', 'pi_independence_pennsylvania', 0.851, null),
  ('claims_primary_payer', 'S AND S HEALTHCARE STRATEGIES', 'pi_beacon_health_strategies', 0.342, null),
  ('claims_primary_payer', 'WELLPOINT - AMERIGROUP', 'pi_anthem_bcbs', 0.687, null),
  ('claims_primary_payer', 'SEATTLE AREA PLUMBING  PIPEFITTERS', 'pi_city_of_seattle', 0.334, null),
  ('claims_primary_payer', '199 SEIU BENEFIT AND PENSION FUND', 'pi_ibew_neca_southwestern_health_benefit_fund', 0.226, null),
  ('claims_primary_payer', 'TRICARE - EAST REGION', 'pi_tricare_west', 0.387, null),
  ('claims_primary_payer', 'BLUECARD PROGRAM OF IL', 'pi_bcbs_pennsylvania', 0.681, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('claims_primary_payer', 'PRESBYTERIAN NEW MEXICO', 'pi_bcbs_new_mexico', 0.776, null),
  ('claims_primary_payer', 'ALLIED BENEFIT SYSTEM INC', 'pi_allied_benefits_systems', 1.000, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CALIFORNIA', 'pi_anthem_california', 0.699, null),
  ('vob_insurance_co', 'UHC', 'pi_united_healthcare_medicare_advantage', 0.510, null),
  ('vob_insurance_co', 'BCBS OF ILLINOIS', 'pi_bcbs_illinois', 0.943, null),
  ('vob_insurance_co', 'BLUESHIELD OF CALIFORNIA', 'pi_blue_shield_california', 0.687, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF INDIANA', 'pi_anthem_indiana', 0.575, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF GEORGIA', 'pi_anthem_georgia', 0.587, null),
  ('vob_insurance_co', 'ANTHEM CA', 'pi_anthem_california', 0.914, null),
  ('vob_insurance_co', 'PREMERA BCBS OF WA', 'pi_premera_washington', 0.957, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF OHIO', 'pi_anthem_ohio', 0.561, null),
  ('vob_insurance_co', 'BCBS OF TENNESSEE', 'pi_bcbs_tennessee', 0.947, null),
  ('vob_insurance_co', 'BCBS OF CA', 'pi_anthem_california', 0.906, null),
  ('vob_insurance_co', 'BCBS OF ALABAMA', 'pi_bcbs_alabama', 0.957, null),
  ('vob_insurance_co', 'BCBS OF MICHIGAN', 'pi_bcbs_michigan', 0.953, null),
  ('vob_insurance_co', 'BCBS OF OKLAHOMA', 'pi_bcbs_oklahoma', 0.955, null),
  ('vob_insurance_co', 'BCBS OF MINNESOTA', 'pi_bcbs_minnesota', 0.955, null),
  ('vob_insurance_co', 'BCBS OF MASSACHUSETTS', 'pi_bcbs_massachusetts', 0.955, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF VIRGINIA', 'pi_anthem_virginia', 0.899, null),
  ('vob_insurance_co', 'HORIZON BCBS OF NEW JERSEY', 'pi_horizon_new_jersey', 0.958, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF KENTUCKY', 'pi_anthem_kentucky', 0.962, null),
  ('vob_insurance_co', 'BCBS OF ARIZONA', 'pi_bcbs_arizona', 0.951, null),
  ('vob_insurance_co', 'PREMERA BCBS OF ALASKA', 'pi_bcbs_alaska', 0.786, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF MISSOURI', 'pi_anthem_missouri', 0.910, null),
  ('vob_insurance_co', 'BLUESHIELD CA', 'pi_blue_shield_california', 0.954, null),
  ('vob_insurance_co', 'CAREFIRST BCBS OF MARYLAND', 'pi_carefirst_bcbs', 0.651, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS OF CA', 'pi_anthem_blue_cross_ca', 0.957, null),
  ('vob_insurance_co', 'BCBS OF LOUISIANA', 'pi_bcbs_louisiana', 0.957, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CONNECTICUT', 'pi_anthem_connecticut', 0.912, null),
  ('vob_insurance_co', 'BCBS OF ARKANSAS', 'pi_bcbs_arkansas', 0.951, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF NEW YORK', 'pi_anthem_bcbs', 0.431, null),
  ('vob_insurance_co', 'ADVANTEK', 'pi_advantek_benefit_administrators', 0.722, null),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF HAWAII', 'pi_bcbs_texas', 0.711, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'CAPITAL BCBS OF PA', 'pi_capital_blue_cross_pennsylvania', 0.965, null),
  ('vob_insurance_co', 'BCBS OF IDAHO', 'pi_anthem_california', 0.246, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BCBS OF WISCONSIN', 'pi_anthem_wisconsin', 0.918, null),
  ('vob_insurance_co', 'ADVENTIST HEALTH', 'pi_adventist_health_system', 0.811, null),
  ('vob_insurance_co', 'INDEPENDENCE BCBS PA', 'pi_independence_pennsylvania', 0.962, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF NEVEDA', 'pi_anthem_bcbs', 0.497, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD COLORADO', 'pi_anthem_nevada', 0.736, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF MONTANA', 'pi_bcbs_montana', 0.953, null),
  ('vob_insurance_co', 'WELLMARK BCBS OF IOWA', 'pi_wellmark_iowa', 0.942, null),
  ('vob_insurance_co', 'BCBS OF IN', 'pi_anthem_indiana', 0.943, null),
  ('vob_insurance_co', 'BCBS OF HAWAII', 'pi_bcbs_hawaii', 0.949, null),
  ('vob_insurance_co', 'WESTERN HEALTH ADVANTAGE', 'pi_united_healthcare_medicare_advantage', 0.431, null),
  ('vob_insurance_co', 'BCBS OF KANSAS CITY', 'pi_city_of_seattle', 0.491, null),
  ('vob_insurance_co', 'BCBS OF GA', 'pi_anthem_georgia', 0.949, null),
  ('vob_insurance_co', 'BS CA', 'pi_blue_shield_california', 0.959, null),
  ('vob_insurance_co', 'REGENCE BCBS OF WA', 'pi_regence_washington', 0.952, null),
  ('vob_insurance_co', 'ANTHEM BC OF CALIFORNIA', 'pi_anthem_california', 0.685, null),
  ('vob_insurance_co', 'BCBS OF OH', 'pi_anthem_ohio', 0.941, null),
  ('vob_insurance_co', 'BCBS ILLINOIS', 'pi_bcbs_illinois', 1.000, null),
  ('vob_insurance_co', 'EXCELLUS BCBS OF NY', 'pi_empire_bcbs_ny', 0.452, null),
  ('vob_insurance_co', 'PINNACLE CLAIMS MANAGEMENT', 'pi_pinnacle', 0.596, null),
  ('vob_insurance_co', 'PRIORITY HEALTH', 'pi_priority_health_michigan', 0.742, null),
  ('vob_insurance_co', 'BCBS OF TENNESSE', 'pi_anthem_california', 0.202, null),
  ('vob_insurance_co', 'BCBS TEXAS', 'pi_bcbs_texas', 1.000, null),
  ('vob_insurance_co', 'UNITEDHEALTHCARE', 'pi_united_healthcare', 0.560, null),
  ('vob_insurance_co', 'BC OF CA', 'pi_anthem_california', 0.895, null),
  ('vob_insurance_co', 'INDEPENDENCE ADMINISTRATORS OF PA', 'pi_independence_pennsylvania', 0.828, null),
  ('vob_insurance_co', 'EMPIRE BCBS OF NEW YORK', 'pi_empire_bcbs_ny', 0.471, null),
  ('vob_insurance_co', 'AMBETTER', 'pi_ambetter_health', 0.907, null),
  ('vob_insurance_co', 'PREMERA BCBS AK', 'pi_bcbs_alaska', 0.760, null),
  ('vob_insurance_co', 'BRMS', 'pi_anthem_california', 0.689, null),
  ('vob_insurance_co', 'BCBS CT', 'pi_bcbs_connecticut', 0.947, null),
  ('vob_insurance_co', 'EMPIRE BCBS OF NY', 'pi_empire_bcbs_ny', 0.968, null),
  ('vob_insurance_co', 'BCBS OF ARKANSAS BLUE ADVANTAGE', 'pi_bcbs_arkansas', 0.682, null),
  ('vob_insurance_co', 'BCBS WI', 'pi_anthem_wisconsin', 0.907, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS', 'pi_anthem_blue_cross_ca', 0.825, null),
  ('vob_insurance_co', 'BLUECROSS BLUESHIELD OF TENNESSEE', 'pi_carefirst_maryland', 0.680, null),
  ('vob_insurance_co', 'BCBS OF RHODE ISLAND', 'pi_anthem_california', 0.149, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BCBS OF MAINE', 'pi_anthem_bcbs', 0.472, null),
  ('vob_insurance_co', 'BCBS HI', 'pi_bcbs_hawaii', 0.957, null),
  ('vob_insurance_co', 'BLUE SHIELD CALIFORNIA', 'pi_blue_shield_california', 1.000, null),
  ('vob_insurance_co', 'BCBS OF WYOMING', 'pi_anthem_california', 0.202, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'SUTTER SELECT', 'pi_select_health', 0.672, null),
  ('vob_insurance_co', 'BCBS CO', 'pi_anthem_colorado', 0.896, null),
  ('vob_insurance_co', 'BCBS OF AL', 'pi_bcbs_alabama', 0.957, null),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OF OREGON', 'pi_regence_oregon', 0.803, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF DELWARE', 'pi_highmark_bcbs', 0.558, null),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OF IDAHO', 'pi_regence_washington', 0.631, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'PREMERA BCBS OF WASHINGTON', 'pi_bcbs_washington', 0.717, null),
  ('vob_insurance_co', 'BCBS OF KANSAS', 'pi_anthem_california', 0.225, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'OSCAR HEALTH', 'pi_oscar', 0.926, null),
  ('vob_insurance_co', 'BCBS ID', 'pi_anthem_bcbs', 0.199, null),
  ('vob_insurance_co', 'BCBS OF NORTH DAKOTA', 'pi_bcbs_north_carolina', 0.502, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF NEW MEXICO', 'pi_bcbs_new_mexico', 0.972, null),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OF UTAH', 'pi_regence_washington', 0.616, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'WESTERN GROWERS ASSURED TRUST', 'pi_western_growers', 0.675, null),
  ('vob_insurance_co', 'ALLIED BENEFIT SYSTEMS', 'pi_allied_benefits_systems', 1.000, null),
  ('vob_insurance_co', 'TRICARE EAST', 'pi_tricare_west', 0.464, null),
  ('vob_insurance_co', 'REGENCE BCBS OF IDAHO', 'pi_regence_washington', 0.444, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'HARVARD PILGRIM HEALTHCARE', 'pi_harvard_pilgrim_health_care', 0.765, null),
  ('vob_insurance_co', 'UHC STUDENT RESOURCES', 'pi_united_healthcare', 0.724, null),
  ('vob_insurance_co', 'PREMERA BC OF WA', 'pi_premera_washington', 0.758, null),
  ('vob_insurance_co', 'KAISER FOUNDATION HEALTH PLAN WASHINGTON', 'pi_kaiser_washington', 0.975, null),
  ('vob_insurance_co', 'REGENCE BCBS OF OREGON', 'pi_regence_oregon', 0.918, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF COLORADO', 'pi_anthem_colorado', 0.907, null),
  ('vob_insurance_co', 'BLUE CROSS & BLUE SHIELD OF MISSISSIPPI', 'pi_bcbs_tennessee', 0.625, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'NIPPON LIFE BENEFITS', 'pi_nippon_life_insurance', 0.784, null),
  ('vob_insurance_co', 'WELLMARK BCBS IA', 'pi_wellmark_iowa', 0.972, null),
  ('vob_insurance_co', 'BCBS VIRGINIA', 'pi_bcbs_virginia', 1.000, null),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF NEBRASKA', 'pi_bcbs_texas', 0.695, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OF WASHINGTON', 'pi_regence_washington', 0.967, null),
  ('vob_insurance_co', 'KAISER PERMANENTE NORTHERN CALIFORNIA', 'pi_kaiser_permanente', 0.691, null),
  ('vob_insurance_co', 'HEALTHSCOPE', 'pi_healthscope_benefits', 0.850, null),
  ('vob_insurance_co', 'BCBS NY', 'pi_empire_bcbs_ny', 0.694, null),
  ('vob_insurance_co', 'CAREFIRST BCBS OF MD', 'pi_carefirst_maryland', 0.969, null),
  ('vob_insurance_co', 'BCBS OF CO', 'pi_anthem_colorado', 0.905, null),
  ('vob_insurance_co', 'WELLMARK BCBS OF SOUTH DAKOTA', 'pi_wellmark_iowa', 0.530, null),
  ('vob_insurance_co', 'UMR SUTTER SELECT', 'pi_select_health', 0.564, null),
  ('vob_insurance_co', 'VA TRIWEST', 'pi_triwest', 0.742, null),
  ('vob_insurance_co', 'REGENCE BC OF WA', 'pi_regence_washington', 0.783, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF NY', 'pi_empire_bcbs_ny', 0.576, null),
  ('vob_insurance_co', 'BCBS MT', 'pi_bcbs_montana', 0.957, null),
  ('vob_insurance_co', 'ANTHEM BC OF INDIANA', 'pi_anthem_california', 0.587, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'EXCELLUS BCBS NY', 'pi_empire_bcbs_ny', 0.466, null),
  ('vob_insurance_co', 'BCBS KC', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'ANTHEM BC OF OHIO', 'pi_anthem_california', 0.601, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'KAISER PERMANATE OF SOUTHERN CALIFORNIA', 'pi_kaiser_permanente_southern_california', 0.632, null),
  ('vob_insurance_co', 'ANTHEM BC', 'pi_anthem_california', 0.774, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF WEST VIRGINIA', 'pi_bcbs_virginia', 0.625, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'HIGHMARK BLUE CROSS BLUE SHIELD WEST VIRGINIA', 'pi_bcbs_tennessee', 0.545, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BC CA', 'pi_anthem_california', 0.954, null),
  ('vob_insurance_co', 'FIRST CHOICE HEALTH', 'pi_first_choice_health_network', 0.828, null),
  ('vob_insurance_co', 'UNITED HEALTH CARE', 'pi_united_healthcare', 0.519, null),
  ('vob_insurance_co', 'KAISER PERMANENTE SOUTHERN CA', 'pi_kaiser_permanente_southern_california', 0.819, null),
  ('vob_insurance_co', 'KAWEAH HEALTH', 'pi_kaweah_delta', 0.710, null),
  ('vob_insurance_co', 'BCBS TENNESSEE', 'pi_bcbs_tennessee', 1.000, null),
  ('vob_insurance_co', 'REGENCE BCBS OF UTAH', 'pi_regence_washington', 0.430, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS ND', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'REGENCE BLUESHIELD OF WA', 'pi_regence_washington', 0.726, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF PENNSYLVANIA', 'pi_highmark_pennsylvania', 0.923, null),
  ('vob_insurance_co', 'BAYLOR SCOTT & WHITE HEALTH PLAN', 'pi_baylor_scott_white', 0.937, null),
  ('vob_insurance_co', 'SHARP', 'pi_sharp_health_plan', 0.840, null),
  ('vob_insurance_co', 'ANTHEM BC OF IN', 'pi_anthem_indiana', 0.792, null),
  ('vob_insurance_co', 'HIGHMARK BCBS WV', 'pi_highmark_bcbs', 0.611, null),
  ('vob_insurance_co', 'BCBS RI', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF NORTHERN CALIFORNIA', 'pi_kaiser_permanente', 0.673, null),
  ('vob_insurance_co', 'BCBS OF MISSISSIPPI', 'pi_bcbs_mississippi', 0.955, null),
  ('vob_insurance_co', 'BLUE SHEILD CA', 'pi_blue_shield_california', 0.476, null),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF ILLINOIS', 'pi_bcbs_texas', 0.724, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'KAISER PERMANENTE WASHINGTON', 'pi_kaiser_washington', 0.805, null),
  ('vob_insurance_co', 'BOON CHAPMAN', 'pi_boon_chapman_administrators', 0.902, null),
  ('vob_insurance_co', 'KAISER PERMANENTE NORTHERN CA', 'pi_kaiser_permanente', 0.693, null),
  ('vob_insurance_co', 'PREMERA BCBS OF AK', 'pi_bcbs_alaska', 0.816, null),
  ('vob_insurance_co', 'BCBS OF ND', 'pi_anthem_california', 0.212, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE SHILED OF CALIFORNIA', 'pi_blue_cross_of_california', 0.520, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF TX', 'pi_bcbs_texas', 0.898, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD NEW HAMPSHIRE', 'pi_bcbs_new_hampshire', 0.987, null),
  ('vob_insurance_co', 'KAISER PERMANENTE NORTHWEST OF WASHINGTON', 'pi_kaiser_washington', 0.618, null),
  ('vob_insurance_co', 'BCBS OF KY', 'pi_anthem_kentucky', 0.944, null),
  ('vob_insurance_co', 'BCBS AK', 'pi_bcbs_alaska', 0.949, null),
  ('vob_insurance_co', 'BCBS KS', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'ANTHEM BC OF VA', 'pi_anthem_virginia', 0.789, null),
  ('vob_insurance_co', 'SHARP HEALTHCARE', 'pi_sharp_health_plan', 0.693, null),
  ('vob_insurance_co', 'BCBS MICHIGAN', 'pi_bcbs_michigan', 1.000, null),
  ('vob_insurance_co', 'BC CA', 'pi_anthem_california', 0.843, null),
  ('vob_insurance_co', 'BCBS OF NV', 'pi_anthem_nevada', 0.953, null),
  ('vob_insurance_co', 'REGENCE BCBS ID', 'pi_regence_washington', 0.446, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF NEBRASKA', 'pi_bcbs_nebraska', 0.955, null),
  ('vob_insurance_co', 'PINNACLE CLAIMS MANAGEMENT INC,', 'pi_pinnacle', 0.537, null),
  ('vob_insurance_co', 'INDEPENDENCE BLUE CROSS PA', 'pi_independence_pennsylvania', 0.763, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS OF WA', 'pi_premera_washington', 0.802, null),
  ('vob_insurance_co', 'BCBS ALABAMA', 'pi_bcbs_alabama', 1.000, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD VIRGINIA', 'pi_anthem_nevada', 0.747, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'FOREST COUNTY POTAWATOMI INSURANCE DEPARTMENT', 'pi_forest_county_potawatomi_insurance', 0.882, null),
  ('vob_insurance_co', 'PREMARA BCBS WA', 'pi_bcbs_washington', 0.572, null),
  ('vob_insurance_co', 'CHRISTUS HEALTH PLAN', 'pi_christus_health_plan_texas', 0.800, null),
  ('vob_insurance_co', 'BCBS OF MISSOURI', 'pi_bcbs_missouri', 0.949, null),
  ('vob_insurance_co', 'EXCELLUS BCBS OF NEW YORK', 'pi_bcbs_new_jersey', 0.356, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS WY', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF IL', 'pi_bcbs_illinois', 0.891, null),
  ('vob_insurance_co', 'BCBS MINNESOTA', 'pi_bcbs_minnesota', 1.000, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF WESTERN NEW YORK', 'pi_highmark_bcbs', 0.469, null),
  ('vob_insurance_co', 'ANTHEM BC OF CT', 'pi_anthem_connecticut', 0.967, null),
  ('vob_insurance_co', 'PREMERA BC', 'pi_premera_washington', 0.660, null),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD', 'pi_bcbs_tennessee', 0.812, null),
  ('vob_insurance_co', 'HIGHMARK BLUECROSS BLUESHIELD OF WESTERN NEW YORK', 'pi_carefirst_maryland', 0.521, null),
  ('vob_insurance_co', 'WELLMARK BCBS SD', 'pi_wellmark_iowa', 0.683, null),
  ('vob_insurance_co', 'BCBS HAWAII', 'pi_bcbs_hawaii', 1.000, null),
  ('vob_insurance_co', 'KAISER SOUTHERN CA', 'pi_kaiser_permanente_southern_california', 0.657, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS', 'pi_premera_washington', 1.000, null),
  ('vob_insurance_co', 'ALLIED BENEFIT SYSTEM', 'pi_allied_benefits_systems', 1.000, null),
  ('vob_insurance_co', 'CAPITAL BC OF PA', 'pi_capital_blue_cross_pennsylvania', 0.801, null),
  ('vob_insurance_co', 'INDEPENDANCE BCBS PA', 'pi_bcbs_pennsylvania', 0.589, null),
  ('vob_insurance_co', 'INDEPENDENCE ADMINISTRATOR OF PA', 'pi_independence_pennsylvania', 0.828, null),
  ('vob_insurance_co', 'BCBS OF MINNISOTA', 'pi_anthem_california', 0.202, null),
  ('vob_insurance_co', 'KAISER PERMANENTE WA', 'pi_kaiser_permanente', 0.806, null),
  ('vob_insurance_co', 'BCBS LOUISIANA', 'pi_bcbs_louisiana', 1.000, null),
  ('vob_insurance_co', 'PROVIDENCE HEALTH', 'pi_providence_health_plan', 0.895, null),
  ('vob_insurance_co', 'CAREFIRST BCBS MARYLAND', 'pi_carefirst_bcbs', 0.671, null),
  ('vob_insurance_co', '1199 NATIONAL BENEFIT FUND (SEUI)', 'pi_ibew_neca_southwestern_health_benefit_fund', 0.242, null),
  ('vob_insurance_co', 'BCBS MASSACHUSETTS', 'pi_bcbs_massachusetts', 1.000, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF WASHINGTON', 'pi_kaiser_washington', 0.777, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF WA', 'pi_kaiser_permanente', 0.777, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF SOUTHERN CALIFORNIA', 'pi_kaiser_permanente_southern_california', 0.975, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS  CALIFORNIA', 'pi_anthem_california', 1.000, null),
  ('vob_insurance_co', 'UMR / QUANTUM HEALTH', 'pi_umr', 0.649, null),
  ('vob_insurance_co', 'UMR ( SUTTER HEALTH )', 'pi_umr', 0.654, null),
  ('vob_insurance_co', 'BCBS OF KENTUCKY', 'pi_anthem_kentucky', 0.866, null),
  ('vob_insurance_co', 'UHC/SUREST', 'pi_surest', 0.766, null),
  ('vob_insurance_co', 'REGENCE BCBS UTAH', 'pi_regence_washington', 0.446, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUE CROSS BLUE SHIELD OF OREGON', 'pi_regence_oregon', 0.647, null),
  ('vob_insurance_co', 'FIRST CHOICE HEALTH PLAN', 'pi_first_choice_health_network', 0.765, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF DELAWARE', 'pi_highmark_delaware', 0.929, null),
  ('vob_insurance_co', 'FEP BCBS OF CA', 'pi_bcbs_federal', 0.829, null),
  ('vob_insurance_co', 'REGENCE BLUESHIELD OF OREGON', 'pi_regence_oregon', 0.771, null),
  ('vob_insurance_co', 'SIERRA HEALTH AND LIFE', 'pi_nippon_life_insurance', 0.315, null),
  ('vob_insurance_co', 'TUFTS HEALTH PLAN', 'pi_tufts_health_plan', 1.000, null),
  ('vob_insurance_co', 'KAISER FOUNDATION HEALTH PLAN WA', 'pi_kaiser_washington', 0.788, null),
  ('vob_insurance_co', 'TRIWEST VA', 'pi_triwest', 0.742, null),
  ('vob_insurance_co', 'ANTHEM BC OF VIRGINIA', 'pi_anthem_virginia', 0.789, null),
  ('vob_insurance_co', 'TRICARE', 'pi_tricare_west', 0.703, null),
  ('vob_insurance_co', 'BCBS OF CONNECTICUT', 'pi_bcbs_connecticut', 0.951, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CALIFIORNIA', 'pi_blue_shield_california', 0.470, null),
  ('vob_insurance_co', 'HIGHMARK BCBC OF PA', 'pi_highmark_pennsylvania', 0.736, null),
  ('vob_insurance_co', 'BCBS FEDERAL EMPLOYEE PROGRAM', 'pi_bcbs_federal', 0.743, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF VIRGINA', 'pi_anthem_bcbs', 0.472, null),
  ('vob_insurance_co', 'REGENCE BLUE-CROSS BLUE-SHIELD  OF IDAHO', 'pi_regence_washington', 0.617, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'HEALTHPARTNERS', 'pi_healthpartners_of_minnesota', 0.715, null),
  ('vob_insurance_co', 'AETNA (MERITAIN HEALTH)', 'pi_meritain_health', 0.808, null),
  ('vob_insurance_co', 'HIGHMARK BCBS DELAWARE', 'pi_highmark_delaware', 0.961, null),
  ('vob_insurance_co', 'BCBS OF OHIO ANTHEM', 'pi_anthem_ohio', 0.561, null),
  ('vob_insurance_co', 'BCBS OF PA', 'pi_bcbs_pennsylvania', 0.929, null),
  ('vob_insurance_co', 'BCBS OF RI', 'pi_anthem_california', 0.212, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF SOTH CAROLINA', 'pi_bcbs_north_carolina', 0.464, null),
  ('vob_insurance_co', 'BCBS OF WY', 'pi_anthem_california', 0.212, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM  CA', 'pi_anthem_california', 0.914, null),
  ('vob_insurance_co', 'INDEPENDENCE ADMINISTRATORS PA', 'pi_independence_administrators', 0.817, null),
  ('vob_insurance_co', 'INDEPENDENCE BLUE CROSS OF PA', 'pi_independence_pennsylvania', 0.805, null),
  ('vob_insurance_co', 'BCBS WELLMARK OF IA', 'pi_wellmark_iowa', 1.000, null),
  ('vob_insurance_co', 'BCBS WESTERN NY', 'pi_empire_bcbs_ny', 0.509, null),
  ('vob_insurance_co', 'BCBS WV', 'pi_anthem_bcbs', 0.185, null),
  ('vob_insurance_co', 'KAISER FOUNDATION NORTHWEST', 'pi_kaiser_washington', 0.509, null),
  ('vob_insurance_co', 'KAISER FOUNDATION WASHINGTON', 'pi_kaiser_washington', 0.865, null),
  ('vob_insurance_co', 'KAISER NORTHERN CA', 'pi_kaiser', 0.534, null),
  ('vob_insurance_co', 'KAISER OF NORTHERN CA', 'pi_kaiser', 0.515, null),
  ('vob_insurance_co', 'KAISER PERMANENTE - NORTHERN CALIFORNIA', 'pi_kaiser_permanente', 0.691, null),
  ('vob_insurance_co', 'KAISER PERMANENTE - SOUTHERN CALIFORNIA', 'pi_kaiser_permanente_southern_california', 1.000, null),
  ('vob_insurance_co', 'KAISER PERMANENTE - WASHINGTON', 'pi_kaiser_washington', 0.805, null),
  ('vob_insurance_co', 'KAISER PERMANENTE (NORTHERN CALIFORNIA)', 'pi_kaiser_permanente', 0.691, null),
  ('vob_insurance_co', 'KAISER PERMANENTE NORTHERN CALIFORNIA REGION', 'pi_kaiser_permanente', 0.594, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF NORTHERN CA', 'pi_kaiser_permanente', 0.675, null),
  ('vob_insurance_co', 'KAISER SOUTHERN CALIFORNIA', 'pi_kaiser_permanente_southern_california', 0.866, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF NC', 'pi_bcbs_north_carolina', 0.898, null),
  ('vob_insurance_co', 'AETNA DELTA HEALTH SYSTEMS', 'pi_delta_health_systems', 0.838, null),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF ARIZONA', 'pi_bcbs_tennessee', 0.637, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF ILLINOIS', 'pi_bcbs_tennessee', 0.655, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BCBS OF NV', 'pi_anthem_nevada', 0.961, null),
  ('vob_insurance_co', 'MEDICA HEALTH PLAN', 'pi_medica', 0.825, null),
  ('vob_insurance_co', 'BLUE CROSS OF IDAHO', 'pi_blue_cross_of_california', 0.537, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE SHEILD OF CA', 'pi_blue_shield_california', 0.515, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF TN', 'pi_bcbs_tennessee', 0.905, null),
  ('vob_insurance_co', 'N.A.L.C BENEFIT PLAN', 'pi_washington_l_i', 0.257, null),
  ('vob_insurance_co', 'N.A.L.C HEALTH PLAN', 'pi_washington_l_i', 0.264, null),
  ('vob_insurance_co', 'BCBS CONNECTICUT', 'pi_bcbs_connecticut', 1.000, null),
  ('vob_insurance_co', 'AETNA EBMS', 'pi_ebms', 0.796, null),
  ('vob_insurance_co', 'BLUE-SHIELD OF CALIFORNIA', 'pi_blue_shield_of_california', 1.000, null),
  ('vob_insurance_co', 'PHILADELPHIA AMERICAN LIFE INSURANCE', 'pi_nippon_life_insurance', 0.434, null),
  ('vob_insurance_co', 'PREMERA BLUE-CROSS BLUE-SHIELD OF WASHINGTON''', 'pi_premera_washington', 0.760, null),
  ('vob_insurance_co', 'CAPITAL BLUE CROSS OF PA', 'pi_capital_blue_cross_pennsylvania', 0.785, null),
  ('vob_insurance_co', 'BCBS IDAHO', 'pi_anthem_bcbs', 0.210, null),
  ('vob_insurance_co', 'CAPITAL BLUE-CROSS OF PENNSYLVANIA', 'pi_capital_blue_cross_pennsylvania', 0.976, null),
  ('vob_insurance_co', 'BCBS KANSAS CITY', 'pi_city_of_seattle', 0.452, null),
  ('vob_insurance_co', 'CAREFIRST BCBS OF VA', 'pi_bcbs_virginia', 0.772, null),
  ('vob_insurance_co', 'BCBS ME', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'REGENCE BCBS', 'pi_regence_washington', 0.722, null),
  ('vob_insurance_co', 'REGENCE BCBS OF UT', 'pi_regence_washington', 0.417, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BCBS UT', 'pi_regence_washington', 0.431, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OF OR', 'pi_regence_oregon', 0.823, null),
  ('vob_insurance_co', 'BCBS OF NE', 'pi_bcbs_nebraska', 0.955, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD INDIANA', 'pi_anthem_indiana', 0.983, null),
  ('vob_insurance_co', 'CIGNA - EAST', 'pi_cigna', 0.598, null),
  ('vob_insurance_co', 'BCBS NEVEDA', 'pi_anthem_bcbs', 0.190, null),
  ('vob_insurance_co', 'CIGNA (ALLEGIANCE)', 'pi_allegiance', 0.816, null),
  ('vob_insurance_co', 'BCBS NEW YORK', 'pi_bcbs_new_jersey', 0.459, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BC OF MO', 'pi_anthem_missouri', 0.816, null),
  ('vob_insurance_co', 'ALL SAVERS UHC', 'pi_all_savers', 0.894, null),
  ('vob_insurance_co', 'SENTARA HEALTH PLAN', 'pi_sentara_family_plan', 0.698, null),
  ('vob_insurance_co', 'CIGNA/OSCAR', 'pi_oscar', 0.808, null),
  ('vob_insurance_co', 'BCBS OF ID', 'pi_anthem_california', 0.235, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'TRICARE FOR LIFE', 'pi_tricare_west', 0.392, null),
  ('vob_insurance_co', 'TRICARE PRIME', 'pi_tricare_west', 0.458, null),
  ('vob_insurance_co', 'EMPIRE BCBS', 'pi_empire_bcbs_ny', 0.770, null),
  ('vob_insurance_co', 'BCBS OF ILLINIOS', 'pi_anthem_california', 0.202, null),
  ('vob_insurance_co', 'ANTHEM BLUE OF CALIFORNIA', 'pi_anthem_california', 0.867, null),
  ('vob_insurance_co', 'ALLEGIANCE BENEFIT PLAN MANAGEMENT', 'pi_allegiance', 0.636, null),
  ('vob_insurance_co', 'UHC GLOBAL', 'pi_cigna', 0.624, null),
  ('vob_insurance_co', 'UHC OXFORD', 'pi_united_healthcare_medicare_advantage', 0.320, null),
  ('vob_insurance_co', 'UHC SUREST', 'pi_surest', 0.766, null),
  ('vob_insurance_co', 'UHC/OPTUM', 'pi_optum', 0.772, null),
  ('vob_insurance_co', 'GEO BLUE', 'pi_bcbs_tennessee', 0.247, null),
  ('vob_insurance_co', 'GOLDEN RULE', 'pi_united_healthcare', 0.881, null),
  ('vob_insurance_co', 'BCBS OF MARYLAND', 'pi_anthem_california', 0.230, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'HEALTH NET CA', 'pi_health_net', 0.847, null),
  ('vob_insurance_co', 'HEALTH NET OF CALIFORNIA', 'pi_health_net_california', 0.962, null),
  ('vob_insurance_co', 'WELLMARK BCBS IOWA', 'pi_wellmark_iowa', 0.968, null),
  ('vob_insurance_co', 'WELLMARK BCBS OF SD', 'pi_wellmark_iowa', 0.664, null),
  ('vob_insurance_co', '1199 NATIONAL BENEFIT FUND', 'pi_ibew_neca_southwestern_health_benefit_fund', 0.291, null),
  ('vob_insurance_co', 'PROVIDENCE', 'pi_providence_health_plan', 0.832, null),
  ('vob_insurance_co', 'PROVIDENCE HEALTH PLAN (PHP)', 'pi_providence_health_plan', 0.726, null),
  ('vob_insurance_co', 'REGENCE  BCBS WA', 'pi_regence_washington', 1.000, null),
  ('vob_insurance_co', 'REGENCE BCBS CENTRAL REGION', 'pi_regence_washington', 0.363, null),
  ('vob_insurance_co', 'REGENCE BCBS OF ID', 'pi_regence_washington', 0.430, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BCBS OF WASHIGTON', 'pi_regence_washington', 0.384, null),
  ('vob_insurance_co', 'REGENCE BCBS OF WASHINGTON', 'pi_regence_washington', 0.902, null),
  ('vob_insurance_co', 'REGENCE BCBS OREGON', 'pi_regence_oregon', 0.954, null),
  ('vob_insurance_co', 'REGENCE BLUE CROSS BLUE SHIELD OF WASHINGTON', 'pi_regence_washington', 0.876, null),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD ID', 'pi_regence_washington', 0.591, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OF ID', 'pi_regence_washington', 0.616, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUE SHIELD OREGON', 'pi_regence_oregon', 0.827, null),
  ('vob_insurance_co', 'REGENCE BLUE-CROSS BLUE-SHIELD OF IDAHO', 'pi_regence_washington', 0.617, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUE-SHIELD OF WA', 'pi_regence_washington', 1.000, null),
  ('vob_insurance_co', 'REGENCE BLUESHIELD OF IDAHO', 'pi_blue_shield_california', 0.529, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE BLUESHIELD WA', 'pi_regence_washington', 0.749, null),
  ('vob_insurance_co', 'REGENCE BLUSHIELD OF WA', 'pi_regence_washington', 0.634, null),
  ('vob_insurance_co', 'REGENCE BS OF UT', 'pi_blue_shield_california', 0.540, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'REGENCE GROUP ADMINISTRATORS OF WASHINGTON ', 'pi_regence_group_administrators', 0.831, null),
  ('vob_insurance_co', 'REGENCE GROUP ADMINISTRATORS WA', 'pi_regence_group_administrators', 0.867, null),
  ('vob_insurance_co', 'SANFORD HEALTH', 'pi_sanford_health_plan', 0.895, null),
  ('vob_insurance_co', 'SANFORD HEALTH PLAN/ PHCS', 'pi_sanford_health_plan', 0.758, null),
  ('vob_insurance_co', 'SANFORD HEALTHCARE', 'pi_sanford_health_plan', 0.679, null),
  ('vob_insurance_co', 'SELF FUND HEALTH', 'pi_self_pay', 0.514, null),
  ('vob_insurance_co', 'SENTARA HEALTH PLANS', 'pi_sentara_family_plan', 0.698, null),
  ('vob_insurance_co', 'SIERRA HEALTH & LIFE', 'pi_nippon_life_insurance', 0.353, null),
  ('vob_insurance_co', 'SIERRA HEALTH & LIFE UHC', 'pi_nippon_life_insurance', 0.306, null),
  ('vob_insurance_co', 'SIGNIFICA (CIGNA)', 'pi_cigna', 0.529, null),
  ('vob_insurance_co', 'SIX DEGREES HEALTH', 'pi_90_degree_benefits', 0.404, null),
  ('vob_insurance_co', 'SSA TPA', 'pi_web_tpa', 0.452, null),
  ('vob_insurance_co', 'STANDARD LIFE AND ACCIDENT INSURANCE', 'pi_nippon_life_insurance', 0.410, null),
  ('vob_insurance_co', 'STRATEGIC LIMITED PARTNERS', 'pi_health_partners', 0.479, null),
  ('vob_insurance_co', 'SUREST/UHC', 'pi_surest', 0.766, null),
  ('vob_insurance_co', 'SUTTER SELECT / UMR', 'pi_select_health', 0.564, null),
  ('vob_insurance_co', 'TRICARE PRIME (WEST)', 'pi_tricare_west', 0.774, null),
  ('vob_insurance_co', 'TRICARE SELECT', 'pi_select_health', 0.684, null),
  ('vob_insurance_co', 'TRICARE SELECT RESERVE', 'pi_select_health', 0.506, null),
  ('vob_insurance_co', 'TRICARE WEST (SEE NOTES)', 'pi_tricare_west', 0.594, null),
  ('vob_insurance_co', 'TRICARE WEST PRIME', 'pi_tricare_west', 0.774, null),
  ('vob_insurance_co', 'TRICARE WEST REGION', 'pi_tricare_west', 0.818, null),
  ('vob_insurance_co', 'TRICARE WEST/ MHC', 'pi_tricare_west', 0.741, null),
  ('vob_insurance_co', 'TRICARE WEST/ PRIME', 'pi_tricare_west', 0.774, null),
  ('vob_insurance_co', 'TRIWEST', 'pi_triwest', 1.000, null),
  ('vob_insurance_co', 'TRIWEST (VETERAN''S AFFAIR)', 'pi_triwest', 0.453, null),
  ('vob_insurance_co', 'TRUCK DRIVERS AND HELPERS LOCAL UNION NO. 355', 'pi_no_insurance', 0.287, null),
  ('vob_insurance_co', 'TRUSTMARK SMALL BUSINESS BENEFIT', 'pi_trustmark', 0.513, null),
  ('vob_insurance_co', 'UFCW & EMPLOYERS TRUST', 'pi_ufcw', 0.605, null),
  ('vob_insurance_co', 'UFCW NATIONAL HEALTH & WELFARE FUND', 'pi_ufcw', 0.519, null),
  ('vob_insurance_co', 'UHC (EMPIRE PLAN)', 'pi_inland_empire_health_plan', 0.549, null),
  ('vob_insurance_co', 'UHC (OXFORD)', 'pi_united_healthcare_medicare_advantage', 0.320, null),
  ('vob_insurance_co', 'UHC /CCI', 'pi_united_healthcare_medicare_advantage', 0.285, null),
  ('vob_insurance_co', 'UHC OXFORD HEALTH', 'pi_united_healthcare_medicare_advantage', 0.304, null),
  ('vob_insurance_co', 'UHC SHARED SERVICES', 'pi_united_healthcare', 0.643, null),
  ('vob_insurance_co', 'UHC/ SUREST', 'pi_surest', 0.766, null),
  ('vob_insurance_co', 'UHCG (UNITED HEALTHCARE GLOBAL)', 'pi_united_healthcare', 0.592, null),
  ('vob_insurance_co', 'UMR (SUTTER SELECT)', 'pi_select_health', 0.564, null),
  ('vob_insurance_co', 'UMR SUTTER', 'pi_umr', 0.689, null),
  ('vob_insurance_co', 'UMR SUTTER HEALTH', 'pi_umr', 0.654, null),
  ('vob_insurance_co', 'UMR SUTTERSELECT', 'pi_umr', 0.587, null),
  ('vob_insurance_co', 'UMR/ QUANTUM HEALTH', 'pi_umr', 0.649, null),
  ('vob_insurance_co', 'UMR/QUANTUM HEALTH', 'pi_umr', 0.649, null),
  ('vob_insurance_co', 'UNITED AGRICULTURAL BENEFIT TRUST', 'pi_united_healthcare', 0.352, null),
  ('vob_insurance_co', 'UNITED HEALTH CARE STUDENT SERVICES', 'pi_united_healthcare', 0.451, null),
  ('vob_insurance_co', 'UNITED HEALTHCARE BH', 'pi_united_healthcare', 0.725, null),
  ('vob_insurance_co', 'UNITED HEALTHCARE SHARED SERVICES-UMR', 'pi_united_healthcare', 0.895, null),
  ('vob_insurance_co', 'UNITEDHEALTHCARE (COBRA)', 'pi_united_healthcare', 0.354, null),
  ('vob_insurance_co', 'UNITEDHEALTHCARE SHARED SERVICES', 'pi_united_healthcare', 0.605, null),
  ('vob_insurance_co', 'UNITEDHEALTHCARE STUDENT RESOURCE', 'pi_united_healthcare', 1.000, null),
  ('vob_insurance_co', 'UNITEDHEALTHCARE/UMR', 'pi_umr', 0.664, null),
  ('vob_insurance_co', 'US FAMILY HEALTH PLAN', 'pi_sentara_family_plan', 0.540, null),
  ('vob_insurance_co', 'WELL FIRST', 'pi_first_health_network', 0.420, null),
  ('vob_insurance_co', 'WELLMARK BCBS IA/SD', 'pi_wellmark_iowa', 0.785, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'WEST GROWERS ASSURANCE TRUST', 'pi_western_growers', 0.797, null),
  ('vob_insurance_co', 'WESTERN GROFERS', 'pi_western_growers', 0.385, null),
  ('vob_insurance_co', 'WESTERN GROWER''S ASSURANCE TRUST', 'pi_western_growers', 0.888, null),
  ('vob_insurance_co', 'WESTERNS GROWERS', 'pi_western_growers', 1.000, null),
  ('vob_insurance_co', '1199 SEIU BENEFITS AND PENSION FUNDS', 'pi_ibew_neca_southwestern_health_benefit_fund', 0.235, null),
  ('vob_insurance_co', '1199 SEIU FUNDS', 'pi_state_compensation_insurance_fund', 0.243, 'KNOWN LIKELY-WRONG SURVIVOR — 1199 SEIU is an unrelated union benefit fund. It only acquired a candidate at all because plural folding merged FUNDS->FUND, matching an unrelated benefit-fund canonical. Reject unless verified.'),
  ('vob_insurance_co', '1199 SEIU NATIONAL BENEFIT FUNDS', 'pi_ibew_neca_southwestern_health_benefit_fund', 0.253, null),
  ('vob_insurance_co', '1199SEIU BENEFIT AND PENSION FUNDS', 'pi_ibew_neca_southwestern_health_benefit_fund', 0.252, null),
  ('vob_insurance_co', 'ADVANTEK HEALTH', 'pi_advantek_benefit_administrators', 0.669, null),
  ('vob_insurance_co', 'ADVENTIST HEALTH BAKERSFIELD', 'pi_adventist_health_system', 0.550, null),
  ('vob_insurance_co', 'AETNA (MERITAN HEALTH)', 'pi_aetna', 0.565, null),
  ('vob_insurance_co', 'AETNA / DELTA HEALTH', 'pi_aetna', 0.643, null),
  ('vob_insurance_co', 'AETNA /CAMH', 'pi_aetna', 0.568, null),
  ('vob_insurance_co', 'AETNA INTERNATIONAL', 'pi_cigna', 0.657, null),
  ('vob_insurance_co', 'AETNA SIGNATURE ADMINISTRATERS', 'pi_aetna', 0.455, null),
  ('vob_insurance_co', 'AETNA SIGNATURE ADMINISTRATORS', 'pi_aetna', 0.536, null),
  ('vob_insurance_co', 'AETNA/ DELTA HEALTH SYSTEM', 'pi_delta_health_systems', 0.838, null),
  ('vob_insurance_co', 'AETNA/ MHC', 'pi_aetna', 0.589, null),
  ('vob_insurance_co', 'AETNA/DELTA HEALTH SYSTEMS', 'pi_delta_health_systems', 0.838, null),
  ('vob_insurance_co', 'AFL HOTEL & RESTAURANT WORKERS HEALTH AND WELFARE TRUST FUND (PSWA)', 'pi_western_growers', 0.136, null),
  ('vob_insurance_co', 'ALLIED', 'pi_allied_health_benefits', 0.751, null),
  ('vob_insurance_co', 'ALLIED BENEFIT SYSTEMS INC', 'pi_allied_benefits_systems', 1.000, null),
  ('vob_insurance_co', 'ALLIED BENEFITS', 'pi_allied_health_benefits', 0.938, null),
  ('vob_insurance_co', 'ALLIED BENEFITS SYSTEM', 'pi_allied_benefits_systems', 1.000, null),
  ('vob_insurance_co', 'ALLIED BENEFITS SYSTEMS', 'pi_allied_benefits_systems', 1.000, null),
  ('vob_insurance_co', 'AMBETTER/HEALTHNET', 'pi_healthnet', 0.735, null),
  ('vob_insurance_co', 'ANTHEM', 'pi_anthem_bcbs', 0.816, null),
  ('vob_insurance_co', 'ANTHEM BC OF  CA', 'pi_anthem_california', 1.000, null),
  ('vob_insurance_co', 'ANTHEM BC OF CA /DELTA HEALTH SYSTEMS', 'pi_delta_health_systems', 0.738, null),
  ('vob_insurance_co', 'ANTHEM BC OF CA/ ADVANTEK', 'pi_anthem_california', 0.750, null),
  ('vob_insurance_co', 'ANTHEM BC OF CA/DELTA HEALTH SYSTEMS', 'pi_delta_health_systems', 0.738, null),
  ('vob_insurance_co', 'ANTHEM BC OF COLORADO', 'pi_anthem_colorado', 0.803, null),
  ('vob_insurance_co', 'ANTHEM BC OF NY', 'pi_anthem_california', 0.621, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BCB OF CALIFORNIA', 'pi_anthem_california', 0.699, null),
  ('vob_insurance_co', 'ANTHEM BCBC OF CONNECTICUT', 'pi_anthem_connecticut', 0.746, null),
  ('vob_insurance_co', 'ANTHEM BCBC OF GEORGIA', 'pi_anthem_indiana', 0.583, null),
  ('vob_insurance_co', 'ANTHEM BCBS CALPERS', 'pi_anthem_bcbs', 0.504, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF ARIZONA', 'pi_bcbs_arizona', 0.863, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CA- CALPERS', 'pi_anthem_california', 0.666, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CAIFORNIA', 'pi_anthem_bcbs', 0.454, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CALIFORNIA (BRMS)', 'pi_anthem_california', 0.627, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CALIFORNIA / HEALTHCOMP', 'pi_healthcomp', 0.723, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF CALIFORNIA/ ACCOLADE', 'pi_anthem_california', 0.442, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF HAWAII (HMSA)', 'pi_bcbs_hawaii', 0.649, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF IDAHO', 'pi_anthem_bcbs', 0.534, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF LOUISIANA', 'pi_bcbs_louisiana', 0.879, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF MA', 'pi_bcbs_massachusetts', 0.900, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF MONTANA', 'pi_bcbs_montana', 0.868, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF NE', 'pi_bcbs_nebraska', 0.873, null),
  ('vob_insurance_co', 'ANTHEM BCBS OF NEBRASKA', 'pi_bcbs_nebraska', 0.873, null),
  ('vob_insurance_co', 'ANTHEM BCBS WISCONSIN', 'pi_anthem_wisconsin', 0.954, null),
  ('vob_insurance_co', 'ANTHEM BCS OF INDIANA', 'pi_anthem_indiana', 0.429, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROS OF CALIFORNIA', 'pi_anthem_california', 0.569, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD MISSOURI', 'pi_anthem_nevada', 0.732, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD OF COLORODO', 'pi_anthem_nevada', 0.709, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS AND BLUE SHIELD OHIO', 'pi_anthem_ohio', 0.983, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS OF CALIFONIA', 'pi_anthem_california', 0.539, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS OF CALIFORNIA/AMERIBEN', 'pi_anthem_california', 0.742, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS OF CALIFORNIA/BRMS', 'pi_anthem_california', 0.752, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS OF CALIFRONIA', 'pi_anthem_california', 0.556, null),
  ('vob_insurance_co', 'ANTHEM BLUE CROSS OF CLAIFORNIA', 'pi_anthem_california', 0.539, null),
  ('vob_insurance_co', 'ANTHEM BLUE-CROSS BLUE-SHIELD OF MISSOURI', 'pi_anthem_nevada', 0.660, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ANTHEM BLUE-CROSS OF CALIFORNIA', 'pi_anthem_california', 1.000, null),
  ('vob_insurance_co', 'ANTHEM BLUECROSS OF CALIFORNIA', 'pi_anthem_california', 0.500, null),
  ('vob_insurance_co', 'ANTHEM BS', 'pi_blue_shield_california', 0.707, null),
  ('vob_insurance_co', 'ANTHEM BS OF CA', 'pi_blue_shield_california', 0.921, null),
  ('vob_insurance_co', 'ANTHEM KY', 'pi_anthem_kentucky', 0.945, null),
  ('vob_insurance_co', 'ANTHEM NCBS OF CALIFORNIA', 'pi_anthem_california', 0.455, null),
  ('vob_insurance_co', 'ANTHEM OF CENTRAL REGION(OH,IN,KY)', 'pi_anthem_kentucky', 0.490, null),
  ('vob_insurance_co', 'APWU HEALTH PLAN/UHSS', 'pi_united_healthcare', 0.659, null),
  ('vob_insurance_co', 'ARKANSAS BLUE CROSS AND BLUE SHIELD', 'pi_bcbs_texas', 0.683, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'ATHEM BLUE CROSS OF CALIFORNIA', 'pi_blue_cross_of_california', 0.672, null),
  ('vob_insurance_co', 'BCB TX', 'pi_bcbs_texas', 1.000, null),
  ('vob_insurance_co', 'BCBS  IL', 'pi_bcbs_illinois', 1.000, null),
  ('vob_insurance_co', 'BCBS  OF IL', 'pi_bcbs_illinois', 1.000, null),
  ('vob_insurance_co', 'BCBS  OH', 'pi_anthem_ohio', 1.000, null),
  ('vob_insurance_co', 'BCBS / PINNACLE', 'pi_pinnacle', 0.934, null),
  ('vob_insurance_co', 'BCBS / SEQUOIA ONE PEO', 'pi_preferred_one', 0.376, null),
  ('vob_insurance_co', 'BCBS ANTHEM CENTRAL REGION', 'pi_anthem_bcbs', 0.426, null),
  ('vob_insurance_co', 'BCBS ARIZONA', 'pi_bcbs_arizona', 1.000, null),
  ('vob_insurance_co', 'BCBS ARKANSAS', 'pi_bcbs_arkansas', 1.000, null),
  ('vob_insurance_co', 'BCBS CA (ADVANTEK)', 'pi_anthem_california', 0.588, null),
  ('vob_insurance_co', 'BCBS CA (SCRIPPS)', 'pi_anthem_california', 0.565, null),
  ('vob_insurance_co', 'BCBS CA / CATC', 'pi_anthem_california', 0.549, null),
  ('vob_insurance_co', 'BCBS CAREFIRST ADMINISTRATORS', 'pi_carefirst_bcbs', 0.792, null),
  ('vob_insurance_co', 'BCBS CENTRAL REGION (OH, IN, KY)', 'pi_anthem_kentucky', 0.473, null),
  ('vob_insurance_co', 'BCBS CENTRAL REGION (OH,IN,KY)', 'pi_anthem_kentucky', 0.473, null),
  ('vob_insurance_co', 'BCBS CT / QUANTUM HEALTH', 'pi_bcbs_connecticut', 0.673, null),
  ('vob_insurance_co', 'BCBS DE', 'pi_highmark_delaware', 0.828, null),
  ('vob_insurance_co', 'BCBS FED', 'pi_anthem_bcbs', 0.169, null),
  ('vob_insurance_co', 'BCBS FEDERAL OF TENNESSEE', 'pi_bcbs_federal', 0.709, null),
  ('vob_insurance_co', 'BCBS HIGHMARK OF WESTERN NY', 'pi_highmark_bcbs', 0.555, null),
  ('vob_insurance_co', 'BCBS MISSISSIPPI', 'pi_bcbs_mississippi', 1.000, null),
  ('vob_insurance_co', 'BCBS MISSOURI', 'pi_bcbs_missouri', 1.000, null),
  ('vob_insurance_co', 'BCBS NEBRASKA', 'pi_bcbs_nebraska', 1.000, null),
  ('vob_insurance_co', 'BCBS NJ', 'pi_horizon_new_jersey', 0.694, null),
  ('vob_insurance_co', 'BCBS NORTH DAKOTA', 'pi_bcbs_north_carolina', 0.515, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF AK BLUE ADVANTAGE', 'pi_bcbs_alaska', 0.711, null),
  ('vob_insurance_co', 'BCBS OF ALABAMA/ QUANTUM', 'pi_bcbs_alabama', 0.757, null),
  ('vob_insurance_co', 'BCBS OF CA (CALPERS)', 'pi_anthem_california', 0.546, null),
  ('vob_insurance_co', 'BCBS OF CONNECTICUT ANTHEM', 'pi_anthem_connecticut', 0.912, null),
  ('vob_insurance_co', 'BCBS OF DELAWARE HIGHMARK', 'pi_highmark_delaware', 0.929, null),
  ('vob_insurance_co', 'BCBS OF HAWAI', 'pi_anthem_california', 0.202, null),
  ('vob_insurance_co', 'BCBS OF ILINOIS', 'pi_anthem_california', 0.202, null),
  ('vob_insurance_co', 'BCBS OF ILLINOIS / LINECO', 'pi_bcbs_illinois', 0.620, null),
  ('vob_insurance_co', 'BCBS OF ILLINOIS / QUANTUM HEALTH', 'pi_bcbs_illinois', 0.676, null),
  ('vob_insurance_co', 'BCBS OF ILLINOIS / TEAMSTER', 'pi_bcbs_illinois', 0.653, null),
  ('vob_insurance_co', 'BCBS OF ILLINOIS/QUANTUM', 'pi_bcbs_illinois', 0.705, null),
  ('vob_insurance_co', 'BCBS OF KC', 'pi_anthem_california', 0.212, null),
  ('vob_insurance_co', 'BCBS OF KS', 'pi_anthem_california', 0.212, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF MAINE', 'pi_anthem_california', 0.212, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF MASS', 'pi_anthem_california', 0.212, null),
  ('vob_insurance_co', 'BCBS OF ME', 'pi_anthem_california', 0.212, null),
  ('vob_insurance_co', 'BCBS OF MONTANA - SECONDARY', 'pi_bcbs_montana', 0.764, null),
  ('vob_insurance_co', 'BCBS OF NEVEDA', 'pi_anthem_california', 0.225, null),
  ('vob_insurance_co', 'BCBS OF NJ', 'pi_horizon_new_jersey', 0.715, null),
  ('vob_insurance_co', 'BCBS OF NY', 'pi_empire_bcbs_ny', 0.650, null),
  ('vob_insurance_co', 'BCBS OF VIRGINA', 'pi_anthem_california', 0.212, null),
  ('vob_insurance_co', 'BCBS OF VIRGINIA', 'pi_bcbs_virginia', 0.942, null),
  ('vob_insurance_co', 'BCBS OF VT', 'pi_anthem_california', 0.212, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OF WASHINGTON', 'pi_bcbs_washington', 0.930, null),
  ('vob_insurance_co', 'BCBS OF WESTERN NEW YORK', 'pi_bcbs_new_jersey', 0.377, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS OK /REVIVAL', 'pi_bcbs_oklahoma', 0.681, null),
  ('vob_insurance_co', 'BCBS REGENCE', 'pi_regence_washington', 0.722, null),
  ('vob_insurance_co', 'BCBS SD', 'pi_anthem_bcbs', 0.190, null),
  ('vob_insurance_co', 'BCBS TN OH', 'pi_bcbs_tennessee', 0.761, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BCBS UT', 'pi_anthem_bcbs', 0.190, null),
  ('vob_insurance_co', 'BCBS VT', 'pi_anthem_bcbs', 0.178, null),
  ('vob_insurance_co', 'BIND', 'pi_surest', 0.675, null),
  ('vob_insurance_co', 'BLACKHAWK CLAIMS', 'pi_bcbs_federal', 0.398, null),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD COLORADO', 'pi_bcbs_texas', 0.691, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF KANSAS CITY', 'pi_bcbs_texas', 0.610, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF MASSACHUSETTS', 'pi_bcbs_texas', 0.695, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF MINNESOTA', 'pi_bcbs_texas', 0.695, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF MONTANA', 'pi_bcbs_texas', 0.701, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS AND BLUE SHIELD OF VERMONT', 'pi_bcbs_texas', 0.665, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD FEDERAL', 'pi_bcbs_federal', 0.797, null),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF AZ', 'pi_bcbs_tennessee', 0.625, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF CA', 'pi_blue_shield_california', 0.870, null),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF GEORGIA', 'pi_anthem_georgia', 0.890, null),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF MISSISSIPPI', 'pi_bcbs_tennessee', 0.625, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS BLUE SHIELD OF MISSOURI', 'pi_bcbs_tennessee', 0.641, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUE CROSS OF CA', 'pi_anthem_blue_cross_ca', 0.845, null),
  ('vob_insurance_co', 'BLUE SHIELD  OF CA', 'pi_blue_shield_california', 1.000, null),
  ('vob_insurance_co', 'BLUE SHIELD CA (CIGNA OUTSIDE OF CA)', 'pi_blue_shield_california', 0.711, null),
  ('vob_insurance_co', 'BLUE SHIELD CA (WELLFLEET)', 'pi_blue_shield_california', 0.686, null),
  ('vob_insurance_co', 'BLUE SHIELD CA /CATC', 'pi_blue_shield_california', 0.671, null),
  ('vob_insurance_co', 'BLUE SHIELD CA /SVR', 'pi_blue_shield_california', 0.650, null),
  ('vob_insurance_co', 'BLUE SHIELD OF  CA', 'pi_blue_shield_california', 1.000, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CA (CIGNA OUTSIDE OF CA)', 'pi_blue_shield_california', 0.735, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CA / DELTA HEALTH SYSTEM', 'pi_delta_health_systems', 0.760, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CA/ DELTA HEALTH SYSTEM', 'pi_delta_health_systems', 0.760, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CA/ILWU-PMA COASTWISE', 'pi_blue_shield_california', 0.506, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CALIFORNIA/HEALTHNOW', 'pi_blue_shield_of_california', 0.673, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CALIFORNIA/ILWU-PMA COASTWISE', 'pi_blue_shield_of_california', 0.508, null),
  ('vob_insurance_co', 'BLUE SHIELD OF CALIFRONIA', 'pi_blue_shield_california', 0.487, null),
  ('vob_insurance_co', 'BLUE SHILED CA', 'pi_blue_shield_california', 0.476, null),
  ('vob_insurance_co', 'BLUE-CROSS BLUE-SHIELD OF MASSACHUSETTS', 'pi_bcbs_tennessee', 0.625, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'BLUESHIELD OF CALIFORNIA/ UNITED AGRICULTURE BENEFIT TRUST', 'pi_blue_shield_california', 0.364, null),
  ('vob_insurance_co', 'BOON-CHAPMAN', 'pi_boon_chapman_administrators', 0.902, null),
  ('vob_insurance_co', 'BS OF CA FEDERAL EMPLOYEE PROGRAM', 'pi_blue_shield_california', 0.614, null),
  ('vob_insurance_co', 'BS OF CA/ COMPASS HEALTH', 'pi_blue_shield_california', 0.694, null),
  ('vob_insurance_co', 'CA FOUNDATION FOR MEDICAL CARE', 'pi_foundation_for_medical_care', 0.940, null),
  ('vob_insurance_co', 'CAPITAL BLUE CROSS OF PENNSYLVANIA', 'pi_capital_blue_cross_pennsylvania', 0.976, null),
  ('vob_insurance_co', 'CAPITAL BLUE CROSS PA', 'pi_capital_blue_cross_pennsylvania', 0.807, null),
  ('vob_insurance_co', 'CARE FIRST BCBS OF MD', 'pi_carefirst_maryland', 0.639, null),
  ('vob_insurance_co', 'CAREFIRST  BCBS OF MARYLAND', 'pi_carefirst_bcbs', 0.651, null),
  ('vob_insurance_co', 'CAREFIRST ADMINISTRATOR OF MARYLAND', 'pi_carefirst_bcbs', 0.504, null),
  ('vob_insurance_co', 'CAREFIRST BCBS D.C.', 'pi_carefirst_bcbs', 0.502, null),
  ('vob_insurance_co', 'CAREFIRST BCBS OF NORTHERN VIRGINIA', 'pi_bcbs_virginia', 0.616, null),
  ('vob_insurance_co', 'CAREFIRST BCBS OF VIRGINIA', 'pi_bcbs_virginia', 0.727, null),
  ('vob_insurance_co', 'CAREFIRST BCBS VA', 'pi_bcbs_virginia', 0.753, null),
  ('vob_insurance_co', 'CAREFIRST BLUE CHOICE', 'pi_carefirst_bcbs', 0.574, null),
  ('vob_insurance_co', 'CAREFIRST BLUECROSS BLUESHIELD OF MD', 'pi_carefirst_maryland', 0.835, null),
  ('vob_insurance_co', 'CBA', 'pi_cba_administrators', 0.836, null),
  ('vob_insurance_co', 'CIGNA  (WEST)', 'pi_cigna_west', 1.000, null),
  ('vob_insurance_co', 'CIGNA (SEAFARERS HEALTH PLAN)', 'pi_cigna', 0.473, null),
  ('vob_insurance_co', 'CIGNA / ALLSTATE BENEFITS SELF-FUNDED (ALLIED)', 'pi_allied_health_benefits', 0.436, null),
  ('vob_insurance_co', 'CIGNA / EMI HEALTH INSURANCE', 'pi_cigna', 0.458, null),
  ('vob_insurance_co', 'CIGNA / GLOBAL HEALTH BENEFITS', 'pi_cigna_global_health', 0.890, null),
  ('vob_insurance_co', 'CIGNA / HEALTHGRAM', 'pi_cigna', 0.550, null),
  ('vob_insurance_co', 'CIGNA / OSCAR HEALTH PLAN', 'pi_oscar', 0.707, null),
  ('vob_insurance_co', 'CIGNA / SAMBA HEALTH BENEFIT PLAN', 'pi_cigna', 0.461, null),
  ('vob_insurance_co', 'CIGNA EAST', 'pi_cigna', 0.598, null),
  ('vob_insurance_co', 'CIGNA GLOBAL HEALTH INSURANCE', 'pi_cigna_global_health', 0.855, null),
  ('vob_insurance_co', 'CIGNA- EAST', 'pi_cigna', 0.598, null),
  ('vob_insurance_co', 'CIGNA- INTERNATIONAL', 'pi_cigna', 1.000, null),
  ('vob_insurance_co', 'CIGNA-EAST', 'pi_cigna', 0.598, null),
  ('vob_insurance_co', 'CIGNA/ ALLEGIANCE BENEFIT PLAN MANAGEMENT', 'pi_allegiance', 0.580, null),
  ('vob_insurance_co', 'CIGNA/ KAISER', 'pi_cigna', 0.743, null),
  ('vob_insurance_co', 'CIGNA/ TRUSTEE PLANS', 'pi_cigna', 0.491, null),
  ('vob_insurance_co', 'COASTAL ADMINISTRATIVE SERVICES', 'pi_benefit_administrative_systems', 0.401, null),
  ('vob_insurance_co', 'COASTAL TPA', 'pi_web_tpa', 0.466, null),
  ('vob_insurance_co', 'COMMUNITY CARE HEALTH/HEALTHCOMP', 'pi_healthcomp', 0.596, null),
  ('vob_insurance_co', 'DEGREES HEALTH', 'pi_90_degree_benefits', 0.579, null),
  ('vob_insurance_co', 'DELTA HEALTH AETNA FUSD', 'pi_aetna', 0.470, null),
  ('vob_insurance_co', 'EBA&M (CA)', 'pi_eba_m', 0.927, null),
  ('vob_insurance_co', 'EMPIRE NY SHIP', 'pi_empire_bcbs_ny', 0.703, null),
  ('vob_insurance_co', 'EXCELLUS BC OF NY', 'pi_anthem_california', 0.364, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'EXCELLUS BCBS OF MN', 'pi_bcbs_minnesota', 0.738, null),
  ('vob_insurance_co', 'FEP BCBS', 'pi_bcbs_federal', 1.000, null),
  ('vob_insurance_co', 'FIRST CHOICE HEALTH/KAISER', 'pi_first_choice_health_network', 0.743, null),
  ('vob_insurance_co', 'FIRST HEALTH', 'pi_first_health_network', 0.735, null),
  ('vob_insurance_co', 'FIRST HEALTH CHOICE', 'pi_first_choice_health_network', 0.828, null),
  ('vob_insurance_co', 'FOUNDATION FOR MEDICAL CARE', 'pi_foundation_for_medical_care', 1.000, null),
  ('vob_insurance_co', 'FOUNDATIONS FOR MEDICAL CARE', 'pi_foundation_for_medical_care', 1.000, null),
  ('vob_insurance_co', 'G.E.H.A.', 'pi_medicare', 0.228, null),
  ('vob_insurance_co', 'GEHA /405', 'pi_geha', 0.650, null),
  ('vob_insurance_co', 'GOVERNMENT EMPLOYEES HEALTH ASSOCIATION (GEHA)', 'pi_geha', 0.467, null),
  ('vob_insurance_co', 'HAWAII WESTERN MANAGEMENT GROUP', 'pi_hawaii_western_management_group', 1.000, null),
  ('vob_insurance_co', 'HEALTHCARE HIGHWAYS', 'pi_healthcare_highways', 1.000, null),
  ('vob_insurance_co', 'HEALTHCARE HIGHWAYS, INC.', 'pi_healthcare_highways', 0.862, null),
  ('vob_insurance_co', 'HEALTHNET CA', 'pi_healthnet', 0.834, null),
  ('vob_insurance_co', 'HERITAGE PILGRIM HEALTHCARE', 'pi_harvard_pilgrim_health_care', 0.355, null),
  ('vob_insurance_co', 'HIGHMARK BCBS NC', 'pi_bcbs_north_carolina', 0.798, null),
  ('vob_insurance_co', 'HIGHMARK BCBS NY', 'pi_highmark_bcbs', 0.702, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF  NJ', 'pi_highmark_bcbs', 0.660, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF  WEST VIRGINIA', 'pi_bcbs_virginia', 0.625, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'HIGHMARK BCBS OF DELEWARE', 'pi_highmark_bcbs', 0.558, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF MA', 'pi_bcbs_massachusetts', 0.817, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF NORTHEASTERN NEWYORK', 'pi_highmark_bcbs', 0.437, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF NY', 'pi_highmark_bcbs', 0.674, null),
  ('vob_insurance_co', 'HIGHMARK BCBS OF PENNSYLVANIA.', 'pi_highmark_pennsylvania', 0.923, null),
  ('vob_insurance_co', 'HIGHMARK BLUE CROSS BLUE SHIELD OF PA', 'pi_highmark_pennsylvania', 0.621, null),
  ('vob_insurance_co', 'HIGHMARK BLUE SHIELD', 'pi_highmark_bcbs', 0.619, null),
  ('vob_insurance_co', 'HIGHMARK BLUE SHIELD OF NY', 'pi_blue_shield_california', 0.486, 'GUARD-C state mismatch: verify the state before accepting.'),
  ('vob_insurance_co', 'HIGHMARK BLUE SHIELD OF PA', 'pi_highmark_pennsylvania', 0.783, null),
  ('vob_insurance_co', 'HMSA BCBS', 'pi_anthem_bcbs', 0.190, null),
  ('vob_insurance_co', 'HORIZON BCBS NEW JERSEY', 'pi_horizon_new_jersey', 0.977, null),
  ('vob_insurance_co', 'HORIZON BSBC NJ', 'pi_horizon_new_jersey', 0.736, null),
  ('vob_insurance_co', 'HORRIZON BCBS NJ', 'pi_horizon_new_jersey', 0.435, null),
  ('vob_insurance_co', 'IEHP (INLAND EMPIRE HEALTH PLAN)', 'pi_inland_empire_health_plan', 0.842, null),
  ('vob_insurance_co', 'IMAGINE 360/QUANTUM HEALTH', 'pi_imagine360', 0.826, null),
  ('vob_insurance_co', 'IMAGINE HEALTH', 'pi_imagine360', 0.635, null),
  ('vob_insurance_co', 'IMAGINE360', 'pi_imagine360', 1.000, null),
  ('vob_insurance_co', 'INDEPENDENCE BC PA', 'pi_independence_pennsylvania', 0.970, null),
  ('vob_insurance_co', 'INDEPENDENCE BCBS', 'pi_independence_pennsylvania', 0.737, null),
  ('vob_insurance_co', 'INDEPENDENCE BLUE CROSS', 'pi_independence_administrators', 0.572, null),
  ('vob_insurance_co', 'KAISER ADVANTAGE', 'pi_kaiser', 0.573, null),
  ('vob_insurance_co', 'KAISER FOUNDATION NW', 'pi_kaiser_washington', 0.484, null),
  ('vob_insurance_co', 'KAISER FOUNDATION OF NW', 'pi_kaiser_washington', 0.521, null),
  ('vob_insurance_co', 'KAISER FOUNDATION WA', 'pi_kaiser_washington', 0.600, null),
  ('vob_insurance_co', 'KAISER NORTHERN CALIFORNIA', 'pi_kaiser', 0.532, null),
  ('vob_insurance_co', 'KAISER PEMANENTE NORTHERN CA', 'pi_kaiser', 0.387, null),
  ('vob_insurance_co', 'KAISER PERMANENTE  WA', 'pi_kaiser_permanente', 0.806, null),
  ('vob_insurance_co', 'KAISER PERMANENTE - NORTHERN CA', 'pi_kaiser_permanente', 0.693, null),
  ('vob_insurance_co', 'KAISER PERMANENTE MID ATLANTIC', 'pi_kaiser_permanente', 0.537, null),
  ('vob_insurance_co', 'KAISER PERMANENTE NORTHWEST OF WA', 'pi_kaiser_permanente', 0.613, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF NC REGION', 'pi_kaiser_permanente', 0.611, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF NORTHERN CALIFORNIA REGION', 'pi_kaiser_permanente', 0.582, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF NOTHERN CALIFORNIA', 'pi_kaiser_permanente', 0.587, null),
  ('vob_insurance_co', 'KAISER PERMANENTE OF SOUTHERN CA', 'pi_kaiser_permanente_southern_california', 0.799, null),
  ('vob_insurance_co', 'KAISER PERMANENTE- NORTHERN CALIFORNIA', 'pi_kaiser_permanente', 0.691, null),
  ('vob_insurance_co', 'KAWEAH DELTA HEALTH', 'pi_kaweah_delta', 0.957, null),
  ('vob_insurance_co', 'L.A. CARE COVERED', 'pi_washington_l_i', 0.296, null),
  ('vob_insurance_co', 'L.A. CARE HEALTH PLAN', 'pi_washington_l_i', 0.325, null),
  ('vob_insurance_co', 'MANAGED HEALTH NET', 'pi_health_net', 0.688, null),
  ('vob_insurance_co', 'MED PARTNERS ADMINISTRATIVE SERVICES', 'pi_health_partners', 0.473, null),
  ('vob_insurance_co', 'N.A.L.C. HEALTH PLAN', 'pi_washington_l_i', 0.264, null),
  ('vob_insurance_co', 'NC STATE HEALTH PLAN FOR TEACHERS AND STATE EMPLOYEES', 'pi_prairie_states_enterprises', 0.322, null),
  ('vob_insurance_co', 'NETWORK HEALTH', 'pi_first_health_network', 0.744, null),
  ('vob_insurance_co', 'NORTHWELL DIRECT', 'pi_premera_washington', 0.424, null),
  ('vob_insurance_co', 'PEMERA BCBS WA', 'pi_bcbs_washington', 0.572, null),
  ('vob_insurance_co', 'PINNACLE CLAIMS', 'pi_pinnacle', 0.729, null),
  ('vob_insurance_co', 'PINNACLE CLAIMS MANAGEMENT INC', 'pi_pinnacle', 0.537, null),
  ('vob_insurance_co', 'PINNACLE/ ANTHEM BC', 'pi_pinnacle', 0.731, null),
  ('vob_insurance_co', 'PRAIRIE STATES', 'pi_prairie_states_enterprises', 0.776, null),
  ('vob_insurance_co', 'PREMERA BCBC OF WA', 'pi_premera_washington', 0.694, null),
  ('vob_insurance_co', 'PREMERA BCBS ALASKA', 'pi_bcbs_alaska', 0.812, null),
  ('vob_insurance_co', 'PREMERA BCBS PA', 'pi_bcbs_pennsylvania', 0.745, null),
  ('vob_insurance_co', 'PREMERA BCBS WASHINGTON', 'pi_bcbs_washington', 0.748, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS  WA', 'pi_premera_washington', 0.829, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS AND BLUE SHIELD OF ALASKA', 'pi_premera_washington', 0.669, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS AND BLUE SHIELD OF WA', 'pi_premera_washington', 0.714, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS WA', 'pi_premera_washington', 0.829, null),
  ('vob_insurance_co', 'PREMERA BLUE CROSS WASHINGTON', 'pi_premera_washington', 0.812, null);

-- Payload integrity — each of these has a plausible authoring or generation failure behind it.
do $$
declare
  bad text;
  n   integer;
begin
  -- (a) Every canonical id must exist LIVE. Generation ran post-027, so an absorbed id appearing here
  --     would mean the payload was generated against a stale surface set.
  select string_agg(distinct p.canonical_id, ', ') into bad
    from _028_payload p
   where not exists (select 1 from ref.payer_identity i where i.canonical_payer_id = p.canonical_id);
  if bad is not null then
    raise exception '028 section 3: payload references identities that do not exist live: %', bad;
  end if;

  -- (b) Explicitly: no id absorbed by 027. Redundant with (a) today and kept deliberately — it names
  --     the specific failure ("regenerate the payload") instead of a generic missing-id error.
  select string_agg(distinct p.canonical_id, ', ') into bad
    from _028_payload p
    join ref.payer_identity_merge_log l on l.absorbed_id = p.canonical_id;
  if bad is not null then
    raise exception '028 section 3: payload points at id(s) 027 ABSORBED: %. Regenerate from the scorer.', bad;
  end if;

  -- (c) alias_norm must already satisfy 026's normalization CHECK. Failing here names the cause;
  --     failing on the INSERT names only the constraint.
  select string_agg(p.alias_norm, ', ') into bad
    from _028_payload p where p.alias_norm <> upper(btrim(p.alias_norm));
  if bad is not null then
    raise exception '028 section 3: payload alias_norm not normalized: %', bad;
  end if;

  -- (d) No 'program'-kind target. 026 guard 9b enforces that a routing program is never a resolution
  --     target; the scorer excludes them, and this asserts the exclusion actually held.
  select string_agg(distinct p.canonical_id, ', ') into bad
    from _028_payload p
    join ref.payer_identity i on i.canonical_payer_id = p.canonical_id
   where i.entity_kind = 'program';
  if bad is not null then
    raise exception '028 section 3: payload targets program-kind identity(ies): %', bad;
  end if;

  select count(*) into n from _028_payload;
  raise notice '028 section 3: payload validated — % rows', n;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Apply — INSERT new, UPDATE machine rows, NEVER touch a human decision
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The WHERE on DO UPDATE is the protection. Postgres evaluates it per conflicting row and silently
-- skips the ones that fail, so a human-adjudicated alias survives this migration untouched even
-- though the payload names it.

insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, confidence,
   needs_review, review_note)
select p.vocabulary, p.alias_norm, p.canonical_id, 'same_payer', 'idf_cosine', p.confidence,
       true, p.review_note
  from _028_payload p
on conflict (vocabulary, alias_norm) do update
   set canonical_payer_id = excluded.canonical_payer_id,
       relationship       = excluded.relationship,
       provenance         = excluded.provenance,
       confidence         = excluded.confidence,
       needs_review       = true,
       review_note        = excluded.review_note
 where ref.payer_alias_map.provenance <> 'human'
   and ref.payer_alias_map.reviewed_at is null;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Post-conditions, asserted in-migration
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  n integer;
  m integer;
begin
  -- (a) Human decisions are byte-identical to the snapshot. This is the claim section 4's WHERE makes;
  --     this is the test of it.
  select count(*) into n
    from _028_human_before b
    join ref.payer_alias_map a
      on a.vocabulary = b.vocabulary and a.alias_norm = b.alias_norm
   where a.canonical_payer_id is distinct from b.canonical_payer_id
      or a.relationship       is distinct from b.relationship
      or a.provenance         is distinct from b.provenance
      or a.needs_review       is distinct from b.needs_review
      or a.review_note        is distinct from b.review_note
      or a.reviewed_by        is distinct from b.reviewed_by
      or a.reviewed_at        is distinct from b.reviewed_at;
  if n <> 0 then
    raise exception '028 section 5: % human-decided alias row(s) were MODIFIED. The DO UPDATE guard failed.', n;
  end if;
  select count(*) into n from _028_human_before;
  select count(*) into m from ref.payer_alias_map where provenance = 'human' or reviewed_at is not null;
  if n <> m then
    raise exception '028 section 5: human-decided row count changed % -> %', n, m;
  end if;

  -- (b) Nothing landed CONFIRMED. If this ever fires, the migration has minted a mapping no human
  --     approved, which is the one thing it must not do.
  select count(*) into n from ref.payer_alias_map where provenance = 'idf_cosine' and not needs_review;
  if n <> 0 then
    raise exception '028 section 5: % idf_cosine row(s) landed CONFIRMED. Every proposal must be needs_review.', n;
  end if;

  -- (c) The 026 pairing invariant still holds across the whole table.
  select count(*) into n from ref.payer_alias_map
   where (relationship in ('same_payer','carve_out','tpa','employer_self_funded') and canonical_payer_id is null)
      or (relationship in ('program_label','unmapped') and canonical_payer_id is not null);
  if n <> 0 then
    raise exception '028 section 5: % row(s) violate the relationship/canonical pairing rule', n;
  end if;

  -- (d) No alias points at an id 027 absorbed, anywhere in the table (not just the payload).
  select count(*) into n from ref.payer_alias_map a
    join ref.payer_identity_merge_log l on l.absorbed_id = a.canonical_payer_id;
  if n <> 0 then
    raise exception '028 section 5: % alias row(s) point at a 027-absorbed id', n;
  end if;

  select count(*) into n from ref.payer_alias_map where provenance = 'idf_cosine';
  select count(*) into m from ref.payer_alias_map;
  raise notice '028: % idf_cosine proposals live, % alias rows total', n, m;
end
$$;

drop table _028_human_before;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Verification (run manually after apply)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- -- Trust-tier census. Note idf_cosine is ALL needs_review by design:
-- select provenance, needs_review, count(*) from ref.payer_alias_map group by 1,2 order by 1,2;
--
-- -- Every idf_cosine row must be needs_review (expect 0):
-- select count(*) from ref.payer_alias_map where provenance='idf_cosine' and not needs_review;
--
-- -- The annotated subset the reviewer should start from:
-- select vocabulary, alias_norm, canonical_payer_id, confidence, review_note
--   from ref.payer_alias_map where provenance='idf_cosine' and review_note is not null
--  order by confidence desc;
--
-- -- Human decisions intact (expect 42):
-- select count(*) from ref.payer_alias_map where provenance='human' or reviewed_at is not null;
--
-- -- The constraint now admits idf_cosine and still admits all six originals:
-- select pg_get_constraintdef(oid) from pg_constraint where conname='payer_alias_map_provenance';
--
-- -- CONFIRMED-tier coverage, both sides — the numbers to compare against 026's 85.1% / 60.0%.
-- -- Unchanged by this migration BY DESIGN (nothing confirmed), and that is the point: coverage moves
-- -- when a human reviews, not when a machine proposes.
--
-- -- Security advisors: expect {"lints":[]}
