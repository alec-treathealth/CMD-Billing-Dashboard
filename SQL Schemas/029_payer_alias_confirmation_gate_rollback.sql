-- 029 ROLLBACK — undo the confirmation-attribution gate on ref.payer_alias_map
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS UNDOES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Drops the `payer_alias_map_confirmation_attributed` CHECK.
-- 2. Restores `needs_review`'s column default to `false`.
-- 3. Clears the STRUCTURALLY AMBIGUOUS review notes 029 §3 wrote.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ RESTORING THE DEFAULT RESTORES A KNOWN HAZARD — read before running
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Section 2 puts `needs_review` back to `DEFAULT false`, which means an INSERT that omits the column
-- once again lands CONFIRMED — i.e. silently becomes payer identity with no human ruling. That is the
-- exact trap 029 was written to close. It is restored here only because a rollback must return the
-- schema to its prior state rather than keep the parts it likes. If you are rolling back for an
-- unrelated reason, consider keeping section 2's default and dropping only the constraint.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ DATA LOSS — bounded, but real
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Section 3 sets `review_note = null` on the ten aliases 029 annotated. If a reviewer has since
-- edited one of those notes, that edit is destroyed. The predicate below only clears notes that still
-- start with the exact marker 029 wrote, so a reviewer's replacement text survives — but a reviewer
-- who APPENDED to the marker will lose their addition. Export first if that is possible:
--
--   \copy (select vocabulary, alias_norm, review_note from ref.payer_alias_map
--           where review_note like 'STRUCTURALLY AMBIGUOUS%')
--     to 'payer_alias_029_notes_backup.csv' csv header
--
-- No alias row is deleted and no mapping changes. `needs_review` values are NOT touched — rolling
-- back the gate does not un-confirm anything.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- OWNERSHIP / IDEMPOTENT
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Runs as claims_admin, matching 029 and the ref plane. Every statement is IF EXISTS or predicate-
-- narrowed, so a second run is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

-- 1. Drop the gate.
alter table ref.payer_alias_map
  drop constraint if exists payer_alias_map_confirmation_attributed;

-- 2. Restore the prior (unsafe) default — see the warning above.
alter table ref.payer_alias_map alter column needs_review set default false;

-- 3. Clear only the notes 029 authored, identified by the marker it wrote.
update ref.payer_alias_map
   set review_note = null
 where vocabulary = 'vob_insurance_co'
   and review_note like 'STRUCTURALLY AMBIGUOUS%';

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Verification (run manually after rollback)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- select count(*) from pg_constraint
--  where conrelid='ref.payer_alias_map'::regclass and conname='payer_alias_map_confirmation_attributed';
-- -- expect: 0
--
-- select column_default from information_schema.columns
--  where table_schema='ref' and table_name='payer_alias_map' and column_name='needs_review';
-- -- expect: false
--
-- select count(*) from ref.payer_alias_map where review_note like 'STRUCTURALLY AMBIGUOUS%';
-- -- expect: 0
--
-- select needs_review, count(*) from ref.payer_alias_map group by 1 order by 1;
-- -- expect: false | 695     true | 990    (unchanged — the rollback un-confirms nothing)
