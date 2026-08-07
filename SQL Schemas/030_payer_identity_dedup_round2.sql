-- 030 — canonical payer dedup, round 2: five duplicate identities absorbed
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- `ref.payer_identity` mints one row per real-world billing entity, but the ids were generated from
-- display strings, so the same payer acquired several. 027 absorbed 11 such pairs. The five below
-- survived that pass because 027's detection compared display names after punctuation-squashing
-- only — a method that cannot see that "MERITAIN" and "Meritain Health" are one company, or that
-- "BLUE SHIELD CALIFORNIA" and "BLUE SHIELD OF CALIFORNIA" differ by a noise word.
--
-- Found by `scripts/audit-payer-identity-duplicates.ts`: five passes (the display layer's own
-- `sameCarrier`, punctuation-squash, token-set equality, singular-folded tokens, generic-only
-- subset), each pair cross-checked against its HMO/commercial mix from the VOB's `plan_type` column.
--
--   survivor                            absorbed                     VOBs      why it is one payer
--   ----------------------------------- ---------------------------- --------- --------------------
--   pi_anthem_california                pi_anthem_blue_cross_ca      6250+107  sameCarrier; HMO 8%/0%
--   pi_meritain_health                  pi_meritain                   110+11   subset, generic extra
--   pi_anthem_connecticut               pi_anthem_bcbs_of_ct           82+11   sameCarrier
--   pi_moda_health                      pi_moda                        32+1    subset, generic extra
--   pi_cba_administrators               pi_cba_administrator            5+1    singular/plural
--
-- Survivor is the higher-volume id in every case, matching 027's convention.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- TWO PAIRS THE AUDIT PROPOSED AND A HUMAN REFUSED — do not "finish the job" by adding them
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- BLUE SHIELD CALIFORNIA / BLUE SHIELD OF CALIFORNIA (1,560 + 1,288 VOBs). The audit rated this
--   MERGE_CANDIDATE and it is the largest pair in the queue. Alec ruled it an ENTITY REVIEW on
--   2026-08-07: Blue Shield of California and Blue Shield of California Life & Health Insurance
--   Company are separate legal entities under one brand, the same shape as GuideWell's Florida Blue
--   / Health Options split. ⚠ NOTE WHAT THIS SAYS ABOUT THE HEURISTIC: their HMO shares AGREE
--   (15% / 19%), so the plan_type test did NOT flag it. That test caught Health Net and would have
--   missed this. Product mix is a useful signal, not a sufficient one — dual-entity licensee
--   knowledge is doing the work, and no amount of tuning replaces it.
--
-- HEALTH NET / HEALTHNET (352 + 100 VOBs). Audit rated SPLIT_RISK; ruling upheld. HMO shares 55% and
--   51% — a near-even split is the signature of an HMO company and a life-insurance company under one
--   brand. Strongest `split_by_product` case in the book; it is 031's first seeded example.
--
-- THE HEALTH PLAN / HEALTH PLANS INC (6 + 3 VOBs) is LOW_CONFIDENCE and also excluded: the only
--   shared vocabulary is the generic token HEALTH. Different companies (WV vs MA).
--
-- Section 0 asserts none of the five below appears in `ref.payer_identity_never_merge`, so a future
-- ruling there blocks this migration rather than being silently overridden.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ THE 029 INTERACTION — WHY THIS MIGRATION DROPS AND RE-ADDS THE CONSTRAINT
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 029 added `payer_alias_map_confirmation_attributed`: a row with `needs_review = false` must carry
-- `reviewed_by` AND `reviewed_at`. It is NOT VALID (the 695 legacy confirmed rows were exempted) but
-- it IS enforced on UPDATE, deliberately, so a legacy-shaped confirmation cannot be laundered
-- through an edit.
--
-- ALL FOURTEEN alias rows this migration repoints belong to that legacy population — eleven are
-- confirmed with NULL attribution. Measured 2026-08-07:
--
--     pi_anthem_bcbs_of_ct 2/2 · pi_anthem_blue_cross_ca 2/5 · pi_cba_administrator 2/2
--     pi_meritain 3/3 · pi_moda 2/2          (confirmed_unattributed / alias_rows)
--
-- So a bare `update ... set canonical_payer_id = <survivor>` fails 23514 on every one. That is 029
-- working as designed, not a bug to route around.
--
-- THE OPTION THIS FILE REJECTS: set `reviewed_by = 'alec@treathealth.ai (030 merge)'` on those rows.
-- It is the smaller diff and it was the first draft. It is wrong. `reviewed_by` on an alias row means
-- "who confirmed this alias→payer mapping". Alec confirmed the MERGE, not the mapping — so the field
-- would carry a claim that is not quite true, which is precisely the fabricated provenance 029's
-- ratification forbade. A `review_note` disclaimer does not repair a field that lies. It would also
-- permanently degrade the boundary invariant to 684 of 695 rows for the sake of one migration's
-- convenience.
--
-- ALSO REJECTED: a BEFORE UPDATE trigger firing only on a proposal→confirmed TRANSITION. That is the
-- technically precise form of the invariant and it would need no exemption here. It loses to a
-- standing repo rule — "don't hide behavior in implicit triggers; make audit explicit and
-- reviewable" — and 029 is twelve hours old and already ratified. Not the moment to redesign it.
--
-- WHAT THIS FILE DOES INSTEAD. Sections 2 and 6 drop the constraint and re-add it, inside this
-- transaction, so no other session ever observes it missing. Re-adding is cheap: it goes back
-- NOT VALID, so there is no table scan and the 695 exemptions survive untouched. Nothing anywhere
-- gains a fabricated attribution; all 695 boundary markers stay exactly as 029 left them.
--
-- ⚠ AND THE HOLE IS SELF-POLICING, WHICH IS THE WHOLE POINT. Section 0 snapshots the confirmation
-- state; section 7 asserts it is byte-identical afterwards and RAISES — rolling back everything — if
-- it is not. So this establishes a narrow precedent, not a general one:
--
--     a migration may drop this gate ONLY IF it proves, in the same transaction, that it
--     confirmed nothing and un-confirmed nothing while the gate was down.
--
-- Any future migration copying this pattern inherits that proof obligation. If you find yourself
-- deleting section 7 to make your migration pass, you are the case the gate exists for.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- BLAST RADIUS — verified 2026-08-07, it is small
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- `canonical_payer_id` exists in exactly two columns cluster-wide: `ref.payer_identity` and
-- `ref.payer_alias_map`. No rollup, no matview, no view, and no `collections.*` table stores it — the
-- resolver joins live. A merge is therefore contained to the ref plane and needs no backfill. Also
-- verified that none of the five absorbed ids is referenced by `payer_identity.administers_for` or by
-- either column of `payer_identity_never_merge`.
--
-- PHI DISCIPLINE: none. Payer names and mapping metadata only. Same posture as 025-029.
-- OWNERSHIP: ref.* is claims_admin-owned, so `SET ROLE claims_admin` — the opposite of the
--   collections plane. Nothing here reads collections.* or vob.*.
-- IDEMPOTENT: every statement is driven off the absorbed id still existing in `ref.payer_identity`.
--   On a second run the identities are gone, so updates and the log insert match zero rows, and
--   section 7's assertion still holds.
--
-- Rollback: 030_payer_identity_dedup_round2_rollback.sql — read its header, a merge is only
--   partially reversible.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 0. Guards, and the snapshot section 7 checks against
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  ruled   text;
  missing text;
begin
  -- (a) A never_merge ruling OUTRANKS this migration. Fail loudly rather than override a human.
  select string_agg(nm.id_low || ' / ' || nm.id_high, ', ')
    into ruled
    from ref.payer_identity_never_merge nm
    join (values
      ('pi_anthem_california', 'pi_anthem_blue_cross_ca'),
      ('pi_meritain_health',   'pi_meritain'),
      ('pi_anthem_connecticut','pi_anthem_bcbs_of_ct'),
      ('pi_moda_health',       'pi_moda'),
      ('pi_cba_administrators','pi_cba_administrator')
    ) as p(survivor, absorbed)
      on (nm.id_low = least(p.survivor, p.absorbed) and nm.id_high = greatest(p.survivor, p.absorbed));
  if ruled is not null then
    raise exception '030 section 0: a human ruled these pairs must NEVER merge: %', ruled;
  end if;

  -- (b) Every survivor must exist. An already-absent absorbed id is fine (idempotent re-run).
  select string_agg(s, ', ') into missing
    from (values ('pi_anthem_california'), ('pi_meritain_health'), ('pi_anthem_connecticut'),
                 ('pi_moda_health'), ('pi_cba_administrators')) as v(s)
   where not exists (select 1 from ref.payer_identity pi where pi.canonical_payer_id = v.s);
  if missing is not null then
    raise exception '030 section 0: survivor identity missing, refusing to repoint into nothing: %', missing;
  end if;
end $$;

-- The snapshot. Deliberately captured live rather than hardcoded to 695/990, so this migration
-- proves what actually happened during THIS run instead of asserting a figure that can rot between
-- authoring and apply. Temp table: dropped automatically at commit.
create temp table _030_confirmation_snapshot on commit drop as
select
  count(*) filter (where not needs_review)                              as confirmed,
  count(*) filter (where needs_review)                                  as proposals,
  count(*) filter (where not needs_review and reviewed_by is null)      as confirmed_unattributed,
  count(*)                                                              as total
from ref.payer_alias_map;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Log the merge FIRST — while the absorbed identity and its aliases still exist
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Order matters and is not cosmetic. `aliases_repointed` must count the aliases ON THE ABSORBED ID,
-- matching 027's semantics ("how many moved"). Counting after section 3 would instead return the
-- survivor's total — its own pre-existing aliases plus the absorbed ones — silently inflating every
-- row in the log.

insert into ref.payer_identity_merge_log
  (absorbed_id, survivor_id, absorbed_display_name, aliases_repointed, merged_at, migration_no)
select absorbed.canonical_payer_id,
       p.survivor,
       absorbed.display_name,
       (select count(*)::int from ref.payer_alias_map m where m.canonical_payer_id = p.absorbed),
       now(),
       '030'
  from (values
    ('pi_anthem_california', 'pi_anthem_blue_cross_ca'),
    ('pi_meritain_health',   'pi_meritain'),
    ('pi_anthem_connecticut','pi_anthem_bcbs_of_ct'),
    ('pi_moda_health',       'pi_moda'),
    ('pi_cba_administrators','pi_cba_administrator')
  ) as p(survivor, absorbed)
  join ref.payer_identity absorbed on absorbed.canonical_payer_id = p.absorbed;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Drop the 029 gate — see the header. Section 6 puts it back; section 7 proves it was not abused.
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
alter table ref.payer_alias_map drop constraint payer_alias_map_confirmation_attributed;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Repoint every alias from the absorbed id to the survivor
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- `needs_review`, `reviewed_by` and `reviewed_at` are NOT in the SET list. That omission is the
-- decision: this migration changes where an alias points, never whether it is confirmed or who said
-- so. Section 7 asserts exactly that.
--
-- The note goes on every repointed row, including proposals. It is the only record of WHICH aliases
-- moved — `payer_identity_merge_log` stores a count, not a row list — so without it the rollback
-- cannot tell an absorbed alias from one the survivor already had, and the merge is irreversible.

update ref.payer_alias_map m
   set canonical_payer_id = p.survivor,
       review_note = coalesce(m.review_note || ' | ', '')
         || 'Canonical repointed ' || p.absorbed || ' -> ' || p.survivor
         || ' by migration 030 (ruling: Alec, 2026-08-07). Confirmation state unchanged.'
  from (values
    ('pi_anthem_california', 'pi_anthem_blue_cross_ca'),
    ('pi_meritain_health',   'pi_meritain'),
    ('pi_anthem_connecticut','pi_anthem_bcbs_of_ct'),
    ('pi_moda_health',       'pi_moda'),
    ('pi_cba_administrators','pi_cba_administrator')
  ) as p(survivor, absorbed)
 where m.canonical_payer_id = p.absorbed;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Repoint administers_for — defensive; measured as zero rows on 2026-08-07
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Kept because the FK would block section 5 if a TPA relationship is added to one of these ids
-- between authoring and apply. Zero rows today is not a reason to omit it.

update ref.payer_identity pi
   set administers_for = p.survivor
  from (values
    ('pi_anthem_california', 'pi_anthem_blue_cross_ca'),
    ('pi_meritain_health',   'pi_meritain'),
    ('pi_anthem_connecticut','pi_anthem_bcbs_of_ct'),
    ('pi_moda_health',       'pi_moda'),
    ('pi_cba_administrators','pi_cba_administrator')
  ) as p(survivor, absorbed)
 where pi.administers_for = p.absorbed;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Delete the absorbed identities
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Safe only because sections 3-4 cleared every FK reference. If either missed a row the FK raises
-- 23503 here and the whole transaction rolls back — the desired failure mode.

delete from ref.payer_identity
 where canonical_payer_id in ('pi_anthem_blue_cross_ca', 'pi_meritain', 'pi_anthem_bcbs_of_ct',
                              'pi_moda', 'pi_cba_administrator');

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Restore the 029 gate, byte-for-byte as 029 declared it
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- NOT VALID again: identical semantics to 029, no table scan, and the 695 legacy exemptions survive.
-- If this statement is ever edited to omit NOT VALID it will fail on those rows — which is the
-- correct outcome, because validating them would require the back-attribution 029 forbids.

alter table ref.payer_alias_map
  add constraint payer_alias_map_confirmation_attributed
  check (needs_review or (reviewed_by is not null and reviewed_at is not null))
  not valid;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. PROVE the gate was not abused while it was down
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- This is the price of section 2 and it is not optional. Any drift rolls the whole migration back.

do $$
declare
  before_row record;
  now_confirmed    bigint;
  now_proposals    bigint;
  now_unattributed bigint;
  now_total        bigint;
begin
  select * into before_row from _030_confirmation_snapshot;

  select count(*) filter (where not needs_review),
         count(*) filter (where needs_review),
         count(*) filter (where not needs_review and reviewed_by is null),
         count(*)
    into now_confirmed, now_proposals, now_unattributed, now_total
    from ref.payer_alias_map;

  if now_confirmed <> before_row.confirmed then
    raise exception '030 section 7: confirmed-row count changed while the 029 gate was down (% -> %). Rolling back.',
      before_row.confirmed, now_confirmed;
  end if;
  if now_proposals <> before_row.proposals then
    raise exception '030 section 7: proposal-row count changed (% -> %). Rolling back.',
      before_row.proposals, now_proposals;
  end if;
  -- The load-bearing one: not a single legacy exemption may have gained a fabricated attribution.
  if now_unattributed <> before_row.confirmed_unattributed then
    raise exception '030 section 7: confirmed-but-unattributed count changed (% -> %). Something wrote an attribution. Rolling back.',
      before_row.confirmed_unattributed, now_unattributed;
  end if;
  if now_total <> before_row.total then
    raise exception '030 section 7: alias row count changed (% -> %). A merge repoints, never deletes. Rolling back.',
      before_row.total, now_total;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'ref.payer_alias_map'::regclass
       and conname  = 'payer_alias_map_confirmation_attributed'
       and not convalidated
  ) then
    raise exception '030 section 7: the 029 gate is not back in place as NOT VALID. Rolling back.';
  end if;
end $$;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. Verification (run manually after apply)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- (a) The five absorbed identities are gone; the five survivors remain.
-- select count(*) from ref.payer_identity
--  where canonical_payer_id in ('pi_anthem_blue_cross_ca','pi_meritain','pi_anthem_bcbs_of_ct',
--                               'pi_moda','pi_cba_administrator');                        -- expect: 0
-- select count(*) from ref.payer_identity
--  where canonical_payer_id in ('pi_anthem_california','pi_meritain_health','pi_anthem_connecticut',
--                               'pi_moda_health','pi_cba_administrators');                 -- expect: 5
--
-- (b) No orphaned alias — every alias with a canonical points at a live identity.
-- select count(*) from ref.payer_alias_map m
--   left join ref.payer_identity pi on pi.canonical_payer_id = m.canonical_payer_id
--  where m.canonical_payer_id is not null and pi.canonical_payer_id is null;               -- expect: 0
--
-- (c) THE BOUNDARY IS INTACT — this is the check that matters most.
-- select count(*) from ref.payer_alias_map;                                                -- expect: 1685
-- select count(*) filter (where not needs_review) as confirmed,
--        count(*) filter (where needs_review)     as proposals,
--        count(*) filter (where not needs_review and reviewed_by is null) as unattributed
--   from ref.payer_alias_map;
-- -- expect: 695 | 990 | 695   — all 695 markers preserved, nothing back-attributed
--
-- (d) Fourteen aliases carry the repoint marker, and the gate is back NOT VALID.
-- select count(*) from ref.payer_alias_map where review_note like '%Canonical repointed%';  -- expect: 14
-- select convalidated from pg_constraint
--  where conrelid='ref.payer_alias_map'::regclass
--    and conname='payer_alias_map_confirmation_attributed';                                 -- expect: f
--
-- (e) The gate still bites after being restored. Must ERROR 23514:
-- set role claims_admin;
--   update ref.payer_alias_map set needs_review = false
--    where vocabulary='vob_insurance_co' and alias_norm='UHC';
-- reset role;
--
-- (f) Five merge-log rows for 030, alongside 027's eleven.
-- select migration_no, count(*) from ref.payer_identity_merge_log group by 1 order by 1;
-- -- expect: 027 | 11     030 | 5
--
-- (g) Re-run the audit: the five pairs leave MERGE_CANDIDATE; Health Net stays SPLIT_RISK and
--     Blue Shield CA stays MERGE_CANDIDATE (deliberately unmerged, see the header).
-- --   node --env-file=.env --import tsx scripts/audit-payer-identity-duplicates.ts
