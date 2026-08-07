-- 030 ROLLBACK — restore the five absorbed payer identities
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ A MERGE IS ONLY PARTIALLY REVERSIBLE. READ ALL OF THIS BEFORE RUNNING.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 030 deleted five rows from `ref.payer_identity`. This file recreates them and repoints their
-- aliases back. What it CAN restore exactly:
--
--   · `canonical_payer_id` — hardcoded below, they were deterministic ids.
--   · `display_name`       — recovered from `ref.payer_identity_merge_log.absorbed_display_name`.
--   · which aliases moved  — recovered from the marker 030 wrote into `review_note` on every
--                            repointed row. This is why 030 notes ALL fourteen rows and not just
--                            the eleven that needed attribution.
--
-- What it CANNOT restore, because 030 did not preserve it:
--
--   · `payer_family`, `entity_kind`, `administers_for`, `is_active`, `notes`, `created_at` on the
--     five deleted identity rows. The merge log stores only the display name. They are recreated
--     with `entity_kind = 'unclassified'` and a note saying so.
--
-- If those fields matter, restore from a backup instead of running this. This file is the
-- structural undo, not a point-in-time restore.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- THERE IS NO ATTRIBUTION TO UNWIND — BUT THE 029 GATE STILL HAS TO COME DOWN. HERE IS WHY.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 030 changed no row's `needs_review`, `reviewed_by` or `reviewed_at` — its section 7 asserts that in
-- the same transaction — so all 695 legacy boundary markers are intact and there is no fabricated
-- attribution to strip.
--
-- ⚠ That does NOT mean this rollback can run with the gate up. A CHECK constraint is evaluated
-- against the NEW row, not against what changed. Eleven of the fourteen rows below are confirmed with
-- NULL attribution, so `needs_review or (reviewed_by is not null and reviewed_at is not null)` is
-- false for them no matter which column an UPDATE touches. Repointing `canonical_payer_id` back
-- fails 23514 exactly as the forward migration's would have.
--
-- So this file mirrors 030: drop the constraint (section 2), repoint (section 3), re-add it NOT VALID
-- (section 5), and PROVE in section 6 that confirmation state is unchanged. Same narrow precedent,
-- same proof obligation. Do not delete section 6 to make a failing rollback pass.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- OWNERSHIP / IDEMPOTENT
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Runs as claims_admin. Every statement is IF EXISTS / ON CONFLICT / predicate-narrowed, so a second
-- run is a no-op. Section 1 must precede section 2 or the FK on `canonical_payer_id` rejects the
-- repoint.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

-- 0. Snapshot the confirmation state, for section 6's proof.
create temp table _030_rollback_snapshot on commit drop as
select
  count(*) filter (where not needs_review)                         as confirmed,
  count(*) filter (where needs_review)                             as proposals,
  count(*) filter (where not needs_review and reviewed_by is null) as confirmed_unattributed,
  count(*)                                                         as total
from ref.payer_alias_map;

-- 1. Recreate the absorbed identities, taking display_name from the merge log.
insert into ref.payer_identity
  (canonical_payer_id, display_name, payer_family, entity_kind, administers_for, is_active, notes)
select l.absorbed_id,
       l.absorbed_display_name,
       null,
       'unclassified',
       null,
       true,
       'Recreated by the 030 rollback. payer_family/entity_kind/notes were NOT preserved by the '
       || 'merge and are placeholders — reclassify before relying on them.'
  from ref.payer_identity_merge_log l
 where l.migration_no = '030'
on conflict (canonical_payer_id) do nothing;

-- 2. Drop the 029 gate — see the header. Section 5 restores it; section 6 proves it was not abused.
alter table ref.payer_alias_map drop constraint if exists payer_alias_map_confirmation_attributed;

-- 3. Repoint the aliases back, identified by the marker 030 wrote.
update ref.payer_alias_map m
   set canonical_payer_id = l.absorbed_id,
       review_note = nullif(
         btrim(replace(
           m.review_note,
           -- Must match what 030 §3 writes EXACTLY, trailing sentence included, or replace() leaves
           -- ' Confirmation state unchanged.' dangling in the note.
           'Canonical repointed ' || l.absorbed_id || ' -> ' || l.survivor_id
             || ' by migration 030 (ruling: Alec, 2026-08-07). Confirmation state unchanged.',
           'Merge ' || l.absorbed_id || ' -> ' || l.survivor_id || ' was ROLLED BACK.')),
         '')
  from ref.payer_identity_merge_log l
 where l.migration_no = '030'
   and m.canonical_payer_id = l.survivor_id
   and m.review_note like '%Canonical repointed ' || l.absorbed_id || ' -> ' || l.survivor_id || '%';

-- 4. Drop the 030 log rows last — sections 1 and 3 both read them.
delete from ref.payer_identity_merge_log where migration_no = '030';

-- 5. Restore the 029 gate, byte-for-byte as 029 declared it.
alter table ref.payer_alias_map
  add constraint payer_alias_map_confirmation_attributed
  check (needs_review or (reviewed_by is not null and reviewed_at is not null))
  not valid;

-- 6. PROVE the gate was not abused while it was down. Any drift rolls the rollback back.
do $$
declare
  b record;
  c bigint; p bigint; u bigint; t bigint;
begin
  select * into b from _030_rollback_snapshot;
  select count(*) filter (where not needs_review),
         count(*) filter (where needs_review),
         count(*) filter (where not needs_review and reviewed_by is null),
         count(*)
    into c, p, u, t from ref.payer_alias_map;

  if c <> b.confirmed or p <> b.proposals then
    raise exception '030 rollback section 6: confirmation counts changed (confirmed %->%, proposals %->%). Rolling back.',
      b.confirmed, c, b.proposals, p;
  end if;
  if u <> b.confirmed_unattributed then
    raise exception '030 rollback section 6: confirmed-but-unattributed changed (%->%). Something wrote an attribution. Rolling back.',
      b.confirmed_unattributed, u;
  end if;
  if t <> b.total then
    raise exception '030 rollback section 6: alias row count changed (%->%). Rolling back.', b.total, t;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'ref.payer_alias_map'::regclass
       and conname  = 'payer_alias_map_confirmation_attributed'
       and not convalidated
  ) then
    raise exception '030 rollback section 6: the 029 gate is not back in place as NOT VALID. Rolling back.';
  end if;
end $$;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Verification (run manually after rollback)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- select count(*) from ref.payer_identity
--  where canonical_payer_id in ('pi_anthem_blue_cross_ca','pi_meritain','pi_anthem_bcbs_of_ct',
--                               'pi_moda','pi_cba_administrator');                        -- expect: 5
--
-- select count(*) from ref.payer_alias_map where review_note like '%Canonical repointed%'; -- expect: 0
-- select count(*) from ref.payer_alias_map where review_note like '%was ROLLED BACK%';     -- expect: 14
-- select count(*) from ref.payer_identity_merge_log where migration_no = '030';            -- expect: 0
-- select count(*) from ref.payer_alias_map;                                                -- expect: 1685
--
-- The eleven attributed rows KEEP their reviewed_by — see the header. This is intentional:
-- select count(*) from ref.payer_alias_map
--  where reviewed_by = 'alec@treathealth.ai (030 identity merge, 2026-08-07)';             -- expect: 11
