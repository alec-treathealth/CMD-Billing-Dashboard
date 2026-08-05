-- 0083 — collections.cmd_charge_int_facility: facility attribution for CMD's interest-payment
--        lines (cpt_code INT / INTRST), which CMD emits with facility = 'No Facility'.
--
-- WHY: CMD posts interest as its own charge line carrying NO office. MEASURED live 2026-08-05
--   (BXR, af504ab6-…, all-time, charge grain): 141 charges — 129 'INT' + 12 'INTRST' —
--   $9,652.10 charged / $8,972.80 insurance-paid, and 141/141 are 'No Facility' with ZERO
--   counter-examples (also zero on the posting-grain base table, 145 postings). Real dollars that
--   never reach an office, so they vanish from every per-facility cut. This migration attributes
--   them by patient, with provenance, WITHOUT mutating ingest output.
--
--   ⚠ 'INT' AND 'INTRST' ARE BOTH LIVE SPELLINGS. A bare `cpt_code = 'INT'` equality silently
--   misses 12 charges / $972.25. The predicate is `upper(coalesce(cpt_code,'')) in ('INT','INTRST')`.
--   A full sweep of every non-5-digit CPT code in both tenants found no third spelling.
--
-- RESOLVER (fail-loud; never guesses):
--   1. Join on member_id_bidx ONLY — the keyed-HMAC blind index (0036). NOT patient name:
--      patient_name_bidx is 0.47% populated (the 0067 backfill never ran) and CMD stores
--      "LAST, FIRST" while the 835 path parses "LAST FIRST", so the match rate is ~0%.
--   2. If every facility-bearing charge for that patient names ONE facility -> attribute to it
--      ('int_resolved').
--   3. Else, tiebreak on payment_received: if the patient's facility-bearing charges sharing the
--      interest row's EXACT payment_received date name one facility -> attribute
--      ('int_resolved_by_date'). Measured: this resolves 16 of the 17 member-ambiguous rows, and
--      an independent formulation (facility at the latest payment_received <= the interest row's)
--      picks the SAME facility on all 16 with zero conflicts — that agreement is the evidence for
--      the rule, not a heuristic.
--   4. Else NULL ('int_unresolved'). Ambiguous and no-match rows are NOT guessed at by row count,
--      recency, or dollar weight.
--   facility_resolved is NULL — never the 'No Facility' literal — for 'int_unresolved', because
--   that literal is already overloaded by the 11,273-charge legacy bucket (see OPEN below).
--
-- MEASURED SPLIT (BXR, 2026-08-05, reproduced identically by two independent implementations):
--   int_resolved         121 charges  $7,283.62 charged / $7,184.19 paid  across 9 facilities
--   int_resolved_by_date  16 charges  $1,497.92 charged /   $918.05 paid  across 3 facilities
--   int_unresolved         4 charges    $870.56 charged /   $870.56 paid
--                          (1 genuinely tied on both rules at $862.34; 3 with no facility-bearing
--                           charge at all — those 3 patients have 186 charges between them and
--                           EVERY one is 'No Facility', i.e. they are trapped in the legacy bucket)
--   137 attributed / 4 not. Sums to $9,652.10 — the full population, nothing dropped.
--
-- INDIGO IS NOT AFFECTED: zero INT/INTRST charges and zero 'No Facility' charges across all
--   422,971 Indigo charges. This migration is tenant-agnostic but resolves nothing there today.
--
-- WHY AN ADJACENT MATVIEW, NOT COLUMNS ON cmd_explorer_charge_rollup — measured, not preferred:
--   Adding facility_resolved/facility_source to the rollup requires DROP + CREATE (matviews cannot
--   ALTER ... ADD COLUMN). Scratch-built against prod data 2026-08-05, both forms verified to
--   produce byte-identical attribution on all 141 rows:
--     · in-rollup: CREATE ... WITH DATA 78.2s + 11 index rebuilds 17.7s + ANALYZE 1.3s
--       = ~97s of ACCESS EXCLUSIVE (readers on Collections/Qualify BLOCK, and Vercel functions
--       time out inside that window). Back-to-back on identical data, the 0059 definition built in
--       60.7s vs 78.2s for the same definition plus the resolver windows: +17.5s (+29%) PERMANENT
--       refresh cost, projecting the hourly :45 REFRESH ... CONCURRENTLY from its measured
--       73.6-102.4s band to ~102s typical and ~132s worst-case against a 180s route maxDuration.
--     · this adjacent matview: 2.02s build, no rollup outage, no index exposure, ~+2s refresh.
--   The rollup's 11 live indexes (0059's six + 0070's 64MB covering index + 0081's four trigram
--   GINs, ~137MB total) are ALSO a correctness hazard on any DROP: 0081's own header warns "any
--   migration that drops/recreates the rollup matview silently loses these four indexes". Not
--   dropping the rollup sidesteps that entirely.
--
-- REFRESH IS DEFERRED, DELIBERATELY — this matview is created WITH DATA and is wired into NO
--   refresh path. It is a point-in-time snapshot as of apply.
--   Refresh cadence is a CONSUMER concern, and this object has no consumer (D1, Alec 2026-08-05:
--   nothing repoints this session). An unread matview going stale is inert. All 141 source rows
--   were ingested on a single day, 2026-06-29, and five weeks of hourly pulls have added none —
--   so there is no drift to chase today either.
--   Wiring refresh now would cost one of: (a) rewriting collections.refresh_cmd_explorer_charge_-
--   rollup(), the SECURITY DEFINER function the production hourly rollup refresh depends on, or
--   (b) a new refresh function + app code in refreshChargeRollup.ts + test churn. Both to keep an
--   object fresh that nothing queries. Neither is worth it now.
--   ⚠ REFRESH WIRING IS A HARD PRECONDITION OF THE CONSUMER-REPOINT SESSION, not of this one.
--   That session will know what reads this and how fresh it must be, and it should follow the
--   resolution of the OPEN question below on whether CMD still posts interest at all — which
--   determines whether this object can ever grow.
--   Drift detection until then is one query:
--     select (select count(*) from collections.cmd_explorer_charge_rollup
--              where upper(coalesce(cpt_code,'')) in ('INT','INTRST')) as source_rows,
--            (select count(*) from collections.cmd_charge_int_facility) as snapshot_rows;
--     -- equal = no drift. Unequal = the snapshot is stale; rebuild before anything reads it.
--   ⚠ Before ANY future migration adds a REFRESH statement to
--   collections.refresh_cmd_explorer_charge_rollup(), read the transaction-coupling entry in
--   docs/veris-data-notes.md (2026-08-05): all statements in that function share ONE transaction,
--   so a later sibling's failure rolls back an earlier sibling's SUCCEEDED refresh. Measured.
--
-- GRAIN + JOIN KEY: one row per INT/INTRST charge in collections.cmd_explorer_charge_rollup,
--   keyed by that matview's `id` (the latest snapshot's real cmd_explorer_rows id, per 0050).
--   Consumers LEFT JOIN on id; a row's ABSENCE means facility_source = 'raw' (the value CMD gave
--   us, unmodified). Nothing reads this at landing — per Alec's D1 ruling 2026-08-05, no consumer
--   repoints in this session, so this migration has NO observable behavior change.
--
-- NOT IN SCOPE — collections.cmd_explorer_rows.facility is NEVER mutated. That table is ingest
--   output (append-only, ON CONFLICT row_fingerprint); an in-place overwrite is clobbered on the
--   next pull. This migration only reads.
--
-- OPEN, deliberately unfixed here: the other 11,273 'No Facility' charges / ~$29.07M (mostly
--   2023-2024 clinical CPTs). Different defect, different fix. See docs/veris-data-notes.md.
--
-- PHI DISCIPLINE: projects id (a bigint), business_entity_id (a tenant uuid), and two non-PHI
--   facility/provenance strings. NO ciphertext, NO blind-index tokens, no member identifier of any
--   kind — member_id_bidx is used only inside the definition's correlated lookups and is
--   deliberately NOT stored. Strictly less identifying than the rollup it derives from.
-- OWNERSHIP: postgres, mirroring collections.cmd_explorer_charge_rollup and
--   collections.cmd_explorer_filter_options (both verified relowner=postgres 2026-08-05). This is
--   the deliberate live posture for this matview family, per 0080's header — not the SET ROLE
--   claims_admin form used for tables.
-- IDEMPOTENT: drop-and-recreate of the matview, IF NOT EXISTS on the index, grants reapplied
--   unconditionally. Re-running converges. The definition is a pure function of the rollup, so a
--   rebuild is bit-identical given identical input. No function is created or replaced.
-- DEPENDENCY: 0050/0059 (collections.cmd_explorer_charge_rollup must exist and be populated),
--   0036 (member_id_bidx). NOT dependent on 0080 — this migration does not touch the refresh
--   function that 0080 owns.
-- Rollback: 0083_cmd_charge_int_facility_rollback.sql

-- 1. The matview --------------------------------------------------------------
-- Small by construction (141 rows today). The correlated span lookups run per INT charge and ride
-- cmd_charge_rollup_member (member_id_bidx); the driving scan is the INT/INTRST predicate over the
-- rollup. Measured end-to-end: 2.02s.
drop materialized view if exists collections.cmd_charge_int_facility;

create materialized view collections.cmd_charge_int_facility as
with int_rows as (
  select id, business_entity_id, member_id_bidx, payment_received
  from collections.cmd_explorer_charge_rollup
  where upper(coalesce(cpt_code, '')) in ('INT', 'INTRST')
),
spans as (
  -- min/max over the patient's facility-bearing charges. lo = hi (and non-null) means EXACTLY one
  -- distinct facility; lo <> hi means ambiguous; both null means no facility-bearing charge at all.
  -- min/max ignore NULLs, and nullif() turns the 'No Facility' placeholder into one — so the
  -- interest row's own placeholder, and every legacy-bucket row, are excluded from the evidence.
  select i.id, i.business_entity_id, i.payment_received,
    (select min(nullif(r.facility, 'No Facility')) from collections.cmd_explorer_charge_rollup r
       where r.business_entity_id = i.business_entity_id and r.member_id_bidx = i.member_id_bidx) as mem_lo,
    (select max(nullif(r.facility, 'No Facility')) from collections.cmd_explorer_charge_rollup r
       where r.business_entity_id = i.business_entity_id and r.member_id_bidx = i.member_id_bidx) as mem_hi,
    -- Tiebreaker scope: the same patient, the same EXACT payment_received date.
    (select min(nullif(r.facility, 'No Facility')) from collections.cmd_explorer_charge_rollup r
       where r.business_entity_id = i.business_entity_id and r.member_id_bidx = i.member_id_bidx
         and r.payment_received = i.payment_received) as day_lo,
    (select max(nullif(r.facility, 'No Facility')) from collections.cmd_explorer_charge_rollup r
       where r.business_entity_id = i.business_entity_id and r.member_id_bidx = i.member_id_bidx
         and r.payment_received = i.payment_received) as day_hi
  from int_rows i
)
select
  id,
  business_entity_id,
  case
    when mem_lo is not null and mem_lo = mem_hi                                    then mem_lo
    when payment_received is not null and day_lo is not null and day_lo = day_hi   then day_lo
  end as facility_resolved,
  case
    when mem_lo is not null and mem_lo = mem_hi                                    then 'int_resolved'
    when payment_received is not null and day_lo is not null and day_lo = day_hi   then 'int_resolved_by_date'
    else 'int_unresolved'
  end as facility_source
from spans
with data;

-- 2. Unique key ---------------------------------------------------------------
-- Enforces one row per charge (the grain claim), and is the standing PRECONDITION for the
-- REFRESH ... CONCURRENTLY that the consumer-repoint session will wire up. Built now so that
-- session does not also have to add an index.
create unique index if not exists cmd_charge_int_facility_id
  on collections.cmd_charge_int_facility (id);

-- 3. Grants — least privilege, mirroring the sibling matviews ------------------
-- claims_reader gets SELECT: it is the role every app read runs as, so a future consumer needs it.
-- cmd_rollup_writer gets SELECT + MAINTAIN purely as FORWARD-COMPATIBILITY for the deferred refresh
-- wiring (it is the role the :45 route runs as, and MAINTAIN covers the VACUUM (ANALYZE) pattern of
-- 0069/0080). Neither grant is exercised at this landing — nothing reads this matview and nothing
-- refreshes it. Granting now keeps the consumer-repoint session to one concern.
-- src/collections/refreshChargeRollup.ts is deliberately NOT changed: no app code in this session.
revoke all on collections.cmd_charge_int_facility from public, anon, authenticated, service_role;
grant select on collections.cmd_charge_int_facility to claims_reader;
grant select, maintain on collections.cmd_charge_int_facility to cmd_rollup_writer;

-- 4. NO REFRESH WIRING — this migration ends here, deliberately -----------------
-- There is intentionally no CREATE OR REPLACE FUNCTION in this file.
-- collections.refresh_cmd_explorer_charge_rollup() is NOT modified, NOT re-asserted, and its
-- grants are NOT touched — it stays byte-identical to the 0080 body that is live today:
--     begin
--       refresh materialized view concurrently collections.cmd_explorer_charge_rollup;
--       refresh materialized view concurrently collections.cmd_explorer_filter_options;
--     end;
-- Rationale in the REFRESH IS DEFERRED block of the header. Post-apply verification below asserts
-- that body is unchanged, because "we did not touch it" is a claim worth proving, not asserting.

-- 5. Verification (run manually after apply) ----------------------------------
-- Expect EXACTLY this split (BXR; Indigo contributes zero rows):
--   select facility_source, count(*), round(sum(r.charge_amount),2) as charged
--     from collections.cmd_charge_int_facility f
--     join collections.cmd_explorer_charge_rollup r using (id)
--    group by 1 order by 1;
--   -- int_resolved 121 / 7283.62 · int_resolved_by_date 16 / 1497.92 · int_unresolved 4 / 870.56
--
-- Provenance invariants (all must be zero):
--   select count(*) filter (where facility_source = 'int_unresolved' and facility_resolved is not null)
--        , count(*) filter (where facility_source <> 'int_unresolved' and facility_resolved is null)
--        , count(*) filter (where facility_resolved = 'No Facility')
--        , count(*) filter (where facility_source not in
--            ('int_resolved','int_resolved_by_date','int_unresolved'))
--     from collections.cmd_charge_int_facility;
--
-- Every covered row really is an interest line, and every interest line is covered:
--   select count(*) from collections.cmd_charge_int_facility f
--     join collections.cmd_explorer_charge_rollup r using (id)
--    where upper(coalesce(r.cpt_code,'')) not in ('INT','INTRST');            -- expect 0
--   select count(*) from collections.cmd_explorer_charge_rollup r
--    where upper(coalesce(r.cpt_code,'')) in ('INT','INTRST')
--      and not exists (select 1 from collections.cmd_charge_int_facility f where f.id = r.id); -- expect 0
--
-- The rollup itself is untouched (compare to the pre-apply baseline, per tenant):
--   select business_entity_id, count(*), round(sum(charge_amount),2), round(sum(insurance_payments),2)
--     from collections.cmd_explorer_charge_rollup group by 1 order by 1;
--
-- The refresh function is BYTE-IDENTICAL to its pre-apply definition (the central claim of the
-- Option C scope — dump prosrc before and after and diff):
--   select md5(prosrc) as body_hash, prosrc from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'collections' and p.proname = 'refresh_cmd_explorer_charge_rollup';
--   -- expect EXACTLY two refresh statements (charge_rollup, filter_options) and an UNCHANGED hash.
--   -- Also confirm no new function was created:
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'collections' and p.proname like '%int_facility%';   -- expect 0
--
-- The hourly :45 run is unaffected — no refresh-path change to time, so the next run should land
-- inside the pre-apply 73.6-102.4s band with no added cost:
--   select id, duration_ms, ok, error from collections.rollup_refresh_run order by started_at desc limit 3;
--
-- DRIFT CHECK (this matview is a point-in-time snapshot; run before any consumer reads it):
--   select (select count(*) from collections.cmd_explorer_charge_rollup
--            where upper(coalesce(cpt_code,'')) in ('INT','INTRST')) as source_rows,
--          (select count(*) from collections.cmd_charge_int_facility) as snapshot_rows;
--   -- equal = no drift. Unequal = stale; rebuild (re-run this migration) before reading it.
