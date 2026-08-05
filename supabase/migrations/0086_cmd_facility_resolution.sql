-- 0086 — collections.cmd_facility_resolution: the deterministic attribution engine over every
--        'No Facility' charge, at charge grain, with method provenance and a refresh function.
--
-- WHY: MEASURED live 2026-08-04 (BXR, af504ab6-…, charge grain): 11,414 'No Facility' charges /
--   $29,081,575.38 charged / $8,209,249.45 insurance-paid. Indigo: zero sentinel rows across
--   497,378 charges. This matview resolves EVERY sentinel charge to exactly one method — or says
--   plainly that it cannot. Nothing is guessed: every method below is an exact-key equality
--   chain, and a charge with no deterministic evidence lands in 'unresolved' with a reason code.
--
-- PHASE-0 LEVER MEASUREMENTS (2026-08-04, each independently re-derived by an adversarial second
--   implementation before inclusion; the target is the $20,953,468.22 / 265-member / 8,167-charge
--   residual that member inference cannot reach):
--     · collections.cmd_charge_census — key member_id_bidx (charge_id is structurally impossible:
--       the rollup grain has no charge_id column). MEASURED ZERO: exactly 1 of 265 residual
--       members has any census row, and that row is itself 'No Facility'. NOT a method here.
--     · collections.cmd_facility_aliases / facilities — NO row-level key exists (label→code maps
--       only). $0 as a lever; used below ONLY to canonicalize labels into facility_code.
--     · staging.era_835_adjustment — key member_id_bidx (facility_code populated, never null).
--       MEASURED ZERO: all 82 rollup-matching ERA members are already facility-named. NOT a
--       method here; revisit only if ERA history is ever backfilled over the legacy period.
--     · vob.indigo_vob — key member_id_bidx. 217/265 residual members reached (82%); the STRICT
--       DETERMINISTIC SUBSET that ships as the 'vob' method below: 47 members / 1,704 charges /
--       $2,999,620.00 charged / $1,014,423.39 paid (all → CAMH today). See VOB METHOD.
--
-- METHODS, IN PRECEDENCE ORDER (first match wins — the CASE encodes this):
--   manual           a current row in collections.facility_assignments (0085) for the charge key.
--                    Human ruling with audit trail; outranks everything.
--   named            per-row pull provenance: every cmd_explorer_rows line in the charge's 0059
--                    group carries the same non-null pull_facility_code (0084). Populated only by
--                    cron rows written after the Phase-2 deploy; conflicting codes fall through
--                    (reason 'provenance_conflict' if nothing else resolves).
--   member_inference the member's non-sentinel rollup rows name EXACTLY ONE distinct facility
--                    label (the 0083 resolver generalized). MEASURED: 114 members / 3,102
--                    charges / $7,472,871.90.
--   vob              the strict VOB chain — see VOB METHOD below.
--   tie_break        the member's non-sentinel rollup rows name 2+ facilities; the MOST RECENT
--                    named row wins, ordered by (charge_date DESC, payment_received DESC NULLS
--                    LAST, id DESC). Deterministic given the data — never arbitrary row order;
--                    the trailing id term breaks exact date ties. MEASURED population: 9 members
--                    / 145 charges / $655,235.26 minus whatever 'vob' claims first.
--   unresolved       none of the above. facility_alias is NULL and unresolved_reason says why:
--                    'provenance_conflict' > 'vob_tied' > 'vob_unmapped' > 'no_evidence'.
--
-- VOB METHOD — every link is an exact equality, and every link is REQUIRED:
--   1. member_id_bidx equality into vob.indigo_vob (the shared-key HMAC blind index, 0036 —
--      verified compatible across planes in Phase 0);
--   2. ALL of the member's non-empty VOB facility labels agree (count(distinct)=1) — the
--      latest-wins tie-break of vob.member_benefits_current is deliberately NOT used: its
--      zero-tie property is by construction, not data agreement;
--   3. the agreed label maps to a facility_code by EXACT (case-insensitive) equality — via
--      collections.cmd_facility_aliases.facility_text or collections.facilities.facility_name.
--      NO fuzzy matching: 'Tennessee BH' does not map and stays unresolved until a human adds
--      the alias row ('Treat MH' can NEVER auto-map — five TREAT_* facilities);
--   4. the mapped code is in the BXR roster (the 15 mnemonics of src/collections/cmdCustomers.ts,
--      snapshotted below). This is the CROSS-BOOK GUARD: Phase 0 found residual BXR members whose
--      VOBs sit at INDIGO facilities (e.g. 'Opus Health' → 10021573) — a BXR charge can never
--      belong to an Indigo office, so those 24 members are excluded, not attributed.
--   Adding a ratified alias row (e.g. 'Tennessee BH' → TBH) GROWS this method on the next
--   refresh with no migration — the mapping is data, not code.
--
-- GRAIN: one row per 'No Facility' charge in collections.cmd_explorer_charge_rollup, keyed by
--   that matview's id (unique here and there). The composite 0059 group key is ALSO projected —
--   it, not id, is the durable assignment key (rollup id is the latest snapshot's line id and
--   can shift when new snapshots arrive; the composite cannot).
--
-- REFRESH — WIRED AT BIRTH (the 0083 lesson: no consumer may read a matview whose refresh isn't
--   wired; this migration wires it BEFORE the UI exists):
--   · collections.refresh_facility_resolution() below (SECURITY DEFINER). Called (a) by the app
--     write path immediately after every save_facility_assignments() commit, and (b) hourly from
--     src/collections/refreshChargeRollup.ts AFTER the rollup refresh, as its own statement.
--   · It is deliberately NOT added to collections.refresh_cmd_explorer_charge_rollup(): that
--     function's statements share ONE transaction, so a failure here would roll back the
--     PRODUCTION rollup refresh (transaction-coupling entry, veris-data-notes.md 2026-08-05).
--     This function stays byte-identical to its live 0080 body.
--   · REFRESH ... CONCURRENTLY inside a definer function is the live, hourly-proven 0080 pattern.
--
-- TENANCY: a matview cannot carry RLS (sql-migrations.md). business_entity_id is a projected
--   column and EVERY reader must filter it explicitly (the app path goes through
--   viewEntityScope → assertEntityScope). Indigo currently contributes zero rows.
--
-- PHI DISCIPLINE: projects member_id_bidx — the keyed-HMAC blind index, a non-reversible token
--   claims_reader can already SELECT on the source rollup (0036/0037); no new exposure class.
--   The UI derives a short display token from it and NEVER shows a raw identifier. No ciphertext,
--   no plaintext identifiers, no patient names. Facility labels/codes are non-PHI.
-- OWNERSHIP: matview + refresh function owned by postgres, mirroring the 0080/0083 matview
--   family (NOT the SET ROLE claims_admin table form).
-- IDEMPOTENT: drop-and-recreate of the matview, IF NOT EXISTS on indexes, CREATE OR REPLACE on
--   the function, grants reapplied unconditionally. Re-running converges; the definition is a
--   pure function of its inputs.
-- DEPENDENCY: 0084 (pull_facility_code column — the 'named' CTE reads it), 0085
--   (facility_assignments — the 'manual' CTE reads it), 0050/0059 (the rollup), 0036 (bidx),
--   vob.indigo_vob (read at refresh time as the matview owner; no app-role grant on vob needed).
--   APPLY ORDER: 0084 → 0085 → 0086.
--   All three CAN be applied via apply_migration in one sitting: the matview is created WITH
--   DATA on a fresh relation, so its indexes below are plain CREATE (no CONCURRENTLY needed —
--   nothing can be reading a relation that did not exist). Only index builds on LIVE relations
--   need the 0081 execute_sql/autocommit path; none here does.
-- Rollback: 0086_cmd_facility_resolution_rollback.sql

-- 1. The matview ---------------------------------------------------------------
drop materialized view if exists collections.cmd_facility_resolution;

create materialized view collections.cmd_facility_resolution as
with sentinel as (
  -- Every 'No Facility' charge, both tenants, at rollup (charge) grain.
  select id, business_entity_id, member_id_bidx, charge_date, payment_received,
         cpt_code, revenue_code,
         coalesce(cpt_code, '')     as cpt_key,
         coalesce(revenue_code, '') as revenue_key,
         charge_amount, insurance_payments, primary_payer, ingested_at
  from collections.cmd_explorer_charge_rollup
  where facility = 'No Facility'
),
label_map as (
  -- Label → canonical facility_code, exact case-insensitive equality only. Alias table first
  -- (the curated mapping), facilities.facility_name second (measured 2026-08-04: the three
  -- member-inference labels missing from the alias table all match facility_name exactly, so
  -- member-inference canonicalization is total today). Each side is pre-aggregated to ONE row
  -- per upper(label), and an AMBIGUOUS mapping (one label, 2+ codes) maps to NULL rather than
  -- picking a side — so this CTE can never fan out a joined charge row, and never guesses.
  select labels.label,
         case
           when am.n = 1                 then am.code
           when am.u is null and nm.n = 1 then nm.code
         end as facility_code
  from (
    select facility as label from collections.cmd_explorer_charge_rollup
     where facility is not null and facility <> 'No Facility'
    union
    select facility from vob.indigo_vob where facility is not null and facility <> ''
  ) labels
  left join (
    select upper(facility_text) as u, min(facility_code) as code,
           count(distinct facility_code) as n
    from collections.cmd_facility_aliases group by 1
  ) am on am.u = upper(labels.label)
  left join (
    select upper(facility_name) as u, min(facility_code) as code,
           count(distinct facility_code) as n
    from collections.facilities group by 1
  ) nm on nm.u = upper(labels.label)
),
cur_assign as (
  -- manual: the current (non-superseded) human assignment per charge key (0085).
  select business_entity_id, member_id_bidx, charge_date, cpt_key, revenue_key, charge_amount,
         facility_code, id as assignment_id
  from collections.facility_assignments
  where superseded_at is null and facility_label = 'No Facility'
),
prov as (
  -- named: pull provenance per 0059 charge group, from the line table (0084 column).
  -- agree_code is non-null only when every provenance-bearing line in the group names the same
  -- code AND that code exists in collections.facilities (vocabulary guard).
  select p.business_entity_id, p.member_id_bidx, p.charge_date, p.cpt_key, p.revenue_key,
         p.charge_amount,
         case when p.lo = p.hi and f.facility_code is not null then p.lo end as agree_code,
         (p.lo <> p.hi) as conflict
  from (
    select business_entity_id, member_id_bidx, charge_date,
           coalesce(cpt_code, '')     as cpt_key,
           coalesce(revenue_code, '') as revenue_key,
           charge_amount,
           min(pull_facility_code) as lo, max(pull_facility_code) as hi
    from collections.cmd_explorer_rows
    where facility = 'No Facility' and pull_facility_code is not null
    group by 1, 2, 3, 4, 5, 6
  ) p
  left join collections.facilities f on f.facility_code = p.lo
),
member_ev as (
  -- member_inference / tie_break evidence: the member's non-sentinel rollup rows.
  select business_entity_id, member_id_bidx,
         count(distinct facility)::int as named_count,
         min(facility) as single_label -- meaningful only when named_count = 1
  from collections.cmd_explorer_charge_rollup
  where facility <> 'No Facility'
  group by 1, 2
),
recent_ev as (
  -- tie_break pick: the facility of the member's MOST RECENT non-sentinel row. Deterministic:
  -- (charge_date DESC, payment_received DESC NULLS LAST, id DESC) — the id term breaks exact
  -- date ties; it is the 0059 latest-snapshot line id, unique across the rollup.
  select distinct on (business_entity_id, member_id_bidx)
         business_entity_id, member_id_bidx, facility as recent_label
  from collections.cmd_explorer_charge_rollup
  where facility <> 'No Facility'
  order by business_entity_id, member_id_bidx,
           charge_date desc, payment_received desc nulls last, id desc
),
vob_ev as (
  -- vob: strict chain per member (see VOB METHOD in the header).
  -- Agreement is over non-empty labels; rows with a blank/NULL facility carry no evidence
  -- either way (they name nothing) and do not veto agreement.
  select v.member_id_bidx,
         min(v.facility)                as vob_label,
         (count(distinct v.facility) = 1) as vob_agrees
  from vob.indigo_vob v
  where v.facility is not null and v.facility <> ''
  group by v.member_id_bidx
),
vob_mapped as (
  select e.member_id_bidx, e.vob_label, e.vob_agrees,
         case
           when e.vob_agrees
                and lm.facility_code = any (array[
                  -- BXR roster snapshot (src/collections/cmdCustomers.ts, 15 mnemonics).
                  -- The cross-book guard: a BXR charge is never attributed to a non-BXR code.
                  'CAMH','DMH','KWC','LAMH','LSMH','NASH','PCMH','TBH','FRCA',
                  'TELEHEALTH_MH','TREAT_CA','TREAT_NV','TREAT_TN','TREAT_TX','TREAT_WA'])
             then lm.facility_code
         end as vob_code
  from vob_ev e
  left join label_map lm on lm.label = e.vob_label
)
select
  s.id,
  s.business_entity_id,
  s.member_id_bidx,
  s.charge_date,
  s.payment_received,
  s.cpt_code,
  s.revenue_code,
  s.cpt_key,
  s.revenue_key,
  s.charge_amount,
  s.insurance_payments,
  s.primary_payer,
  case when s.ingested_at < timestamptz '2026-06-30 00:00:00+00' then 'seed' else 'cron' end
    as source_era,
  -- method: first match wins (precedence: manual > named > member_inference > vob > tie_break)
  case
    when a.assignment_id is not null            then 'manual'
    when p.agree_code   is not null             then 'named'
    when me.named_count = 1                     then 'member_inference'
    when vm.vob_code    is not null             then 'vob'
    when me.named_count >= 2                    then 'tie_break'
    else 'unresolved'
  end as method,
  case
    when a.assignment_id is not null            then a.facility_code
    when p.agree_code   is not null             then p.agree_code
    when me.named_count = 1                     then lm1.facility_code
    when vm.vob_code    is not null             then vm.vob_code
    when me.named_count >= 2                    then lmr.facility_code
  end as facility_code,
  case
    when a.assignment_id is not null            then fa.facility_name
    when p.agree_code   is not null             then fp.facility_name
    when me.named_count = 1                     then me.single_label
    when vm.vob_code    is not null             then fv.facility_name
    when me.named_count >= 2                    then re.recent_label
  end as facility_label,
  -- the spec'd single answer column: canonical code when known, else the raw label.
  -- NULL if and only if method = 'unresolved'.
  case
    when a.assignment_id is not null            then a.facility_code
    when p.agree_code   is not null             then p.agree_code
    when me.named_count = 1                     then coalesce(lm1.facility_code, me.single_label)
    when vm.vob_code    is not null             then vm.vob_code
    when me.named_count >= 2                    then coalesce(lmr.facility_code, re.recent_label)
  end as facility_alias,
  case
    when a.assignment_id is not null or p.agree_code is not null
         or me.named_count >= 1 or vm.vob_code is not null then null
    when p.conflict                             then 'provenance_conflict'
    when vm.vob_agrees is not null and not vm.vob_agrees then 'vob_tied'
    when vm.vob_agrees and vm.vob_code is null  then 'vob_unmapped'
    else 'no_evidence'
  end as unresolved_reason,
  a.assignment_id
from sentinel s
left join cur_assign a
  on  a.business_entity_id = s.business_entity_id
  and a.member_id_bidx     = s.member_id_bidx
  and a.charge_date        = s.charge_date
  and a.cpt_key            = s.cpt_key
  and a.revenue_key        = s.revenue_key
  and a.charge_amount      = s.charge_amount
left join prov p
  on  p.business_entity_id = s.business_entity_id
  and p.member_id_bidx     = s.member_id_bidx
  and p.charge_date        = s.charge_date
  and p.cpt_key            = s.cpt_key
  and p.revenue_key        = s.revenue_key
  and p.charge_amount      = s.charge_amount
left join member_ev me
  on  me.business_entity_id = s.business_entity_id
  and me.member_id_bidx     = s.member_id_bidx
left join recent_ev re
  on  re.business_entity_id = s.business_entity_id
  and re.member_id_bidx     = s.member_id_bidx
left join vob_mapped vm
  on  vm.member_id_bidx = s.member_id_bidx
left join label_map lm1 on lm1.label = me.single_label
left join label_map lmr on lmr.label = re.recent_label
left join collections.facilities fa on fa.facility_code = a.facility_code
left join collections.facilities fp on fp.facility_code = p.agree_code
left join collections.facilities fv on fv.facility_code = vm.vob_code
with data;

-- 2. Indexes ---------------------------------------------------------------------
-- Unique id first: the REFRESH ... CONCURRENTLY precondition. Plain CREATE is correct here —
-- the relation was created two statements ago; nothing can be reading it (see header).
create unique index if not exists cmd_facility_resolution_id
  on collections.cmd_facility_resolution (id);
create index if not exists cmd_facility_resolution_entity_method
  on collections.cmd_facility_resolution (business_entity_id, method, charge_date);
create index if not exists cmd_facility_resolution_member
  on collections.cmd_facility_resolution (business_entity_id, member_id_bidx);

-- 3. Refresh function --------------------------------------------------------------
-- Its OWN function, deliberately NOT a statement inside refresh_cmd_explorer_charge_rollup()
-- (transaction coupling — see header). 0080-pattern definer; owner postgres owns the matview.
create or replace function collections.refresh_facility_resolution()
returns void
language plpgsql
security definer
set search_path = collections, pg_catalog
as $$
begin
  refresh materialized view concurrently collections.cmd_facility_resolution;
end;
$$;

revoke all on function collections.refresh_facility_resolution() from public;
-- cmd_rollup_writer: the hourly :45 cadence (refreshChargeRollup.ts, after the rollup refresh).
-- claims_reader: the app write path, immediately after save_facility_assignments() returns.
grant execute on function collections.refresh_facility_resolution() to cmd_rollup_writer;
grant execute on function collections.refresh_facility_resolution() to claims_reader;

-- 4. Grants -----------------------------------------------------------------------
revoke all on collections.cmd_facility_resolution from public, anon, authenticated, service_role;
grant select on collections.cmd_facility_resolution to claims_reader;
grant select, maintain on collections.cmd_facility_resolution to cmd_rollup_writer;

-- 5. Verification (run manually after apply) ----------------------------------------
-- INVARIANT 1 — dollar conservation to the cent, and full coverage (both tenants):
--   select (select count(*)  from collections.cmd_facility_resolution)      as res_rows,
--          (select count(*)  from collections.cmd_explorer_charge_rollup
--            where facility='No Facility')                                  as bucket_rows,
--          (select sum(charge_amount) from collections.cmd_facility_resolution)
--        - (select sum(charge_amount) from collections.cmd_explorer_charge_rollup
--            where facility='No Facility')                                  as dollar_delta;
--   -- res_rows = bucket_rows, dollar_delta = 0.00
-- INVARIANT 2 — every sentinel charge appears exactly once:
--   select count(*) from (select id from collections.cmd_facility_resolution
--                          group by id having count(*) > 1) d;              -- 0
--   select count(*) from collections.cmd_explorer_charge_rollup r
--    where r.facility='No Facility'
--      and not exists (select 1 from collections.cmd_facility_resolution f
--                       where f.id = r.id);                                 -- 0
-- INVARIANT 3 — no conflicting/invalid method states:
--   select count(*) filter (where method='unresolved' and facility_alias is not null)
--        , count(*) filter (where method<>'unresolved' and facility_alias is null)
--        , count(*) filter (where method='unresolved' and unresolved_reason is null)
--        , count(*) filter (where method<>'unresolved' and unresolved_reason is not null)
--        , count(*) filter (where method not in ('manual','named','member_inference',
--                                                'vob','tie_break','unresolved'))
--        , count(*) filter (where facility_alias = 'No Facility')
--     from collections.cmd_facility_resolution;                             -- all six 0
-- INVARIANT 4 — the expected method split at apply time (assignments empty, provenance all-NULL).
--   DRY-RUN VERIFIED 2026-08-04: this exact definition (with the manual and named inputs stubbed
--   empty, equivalent to apply-time state) was executed as a plain query against the live
--   database, and invariants 1-3 all held (delta 0.00, dup 0, missing 0, zero-checks 0):
--   select method, count(*), round(sum(charge_amount),2), round(sum(insurance_payments),2)
--     from collections.cmd_facility_resolution group by 1 order by 1;
--   -- manual                0
--   -- named                 0
--   -- member_inference  3,102 / $7,472,871.90  / $2,279,882.24 paid  (10 facilities)
--   -- vob               1,704 / $2,999,620.00  / $1,014,423.39 paid  (1 facility: CAMH)
--   -- tie_break           145 / $655,235.26    / $299,366.02  paid   (4 facilities;
--   --                        none of the 9 explorer-tied members passed the strict VOB chain)
--   -- unresolved        6,463 / $17,953,848.22 / $4,615,577.80 paid
--   -- TOTAL            11,414 / $29,081,575.38 — conserved to the cent.
--   Figures move only if the underlying data has (rollup refresh, new aliases, new VOB rows).
-- Refresh function round trip (as cmd_rollup_writer):
--   select collections.refresh_facility_resolution();
-- Shared rollup refresh function untouched (must still hash to its 0080 body):
--   select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='collections' and p.proname='refresh_cmd_explorer_charge_rollup';
