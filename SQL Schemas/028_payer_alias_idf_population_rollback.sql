-- 028 ROLLBACK — remove the IDF-cosine proposal queue and restore the pre-028 provenance CHECK.
--
-- WHY: reverses SQL Schemas/028_payer_alias_idf_population.sql.
--
-- PHI DISCIPLINE: unchanged. Payer reference data only.
--
-- OWNERSHIP: runs as `claims_admin`, the owner of `ref.payer_alias_map`.
--
-- IDEMPOTENT: the DELETE is keyed on `provenance = 'idf_cosine'` (a no-op once none remain) and the
--   constraint swap is DROP IF EXISTS + ADD. Re-running after a completed rollback does nothing.
--
-- ⚠ THIS IS THE UNUSUAL CASE: THE ROLLBACK IS *MORE* REVERSIBLE THAN THE FORWARD MIGRATION.
--   028 mints no confirmed mapping, so removing its rows removes no resolution behaviour — D2 reads
--   CONFIRMED aliases only and never saw them. What IS lost is review WORK: if a human has reviewed
--   any of these proposals since the apply, that row now carries `reviewed_at`/`reviewed_by` or
--   `provenance = 'human'`, and section 2 deliberately EXCLUDES those from the delete. The rollback
--   removes only rows still in their as-generated machine state.
--
--   Export first anyway if review is underway, because a partially-reviewed queue is easier to finish
--   than to reconstruct:
--
--     \copy (select vocabulary, alias_norm, canonical_payer_id, relationship, provenance,
--                   confidence, needs_review, review_note, reviewed_by, reviewed_at
--              from ref.payer_alias_map where provenance = 'idf_cosine')
--        to 'payer_alias_map_idf_backup.csv' csv header
--
-- ⚠ THE 108 CLAIMS-SIDE ROWS ARE NOT FULLY RESTORED, and this is the one real loss. 49 of them were
--   'no_candidate'/'unmapped'/NULL-canonical rows that 028 UPDATED in place into 'idf_cosine'
--   proposals. Deleting them would delete rows that existed BEFORE 028, so section 2 instead REVERTS
--   them to their pre-028 shape (provenance 'no_candidate', relationship 'unmapped', canonical NULL).
--   That restores the semantics exactly; it does not restore the original `created_at`, which 028
--   never changed anyway. The reason this needs saying: a naive `DELETE WHERE provenance='idf_cosine'`
--   would silently shrink the claims-side vocabulary by 49 names and nothing would complain.
--
-- DEPENDENCY / ORDERING: revert the updated claims rows (2) → delete the inserted VOB rows (3) →
--   restore the constraint LAST (4). The constraint must go last because 'idf_cosine' has to remain
--   legal while rows still carry it; narrowing it first would fail validation against those rows.
--
-- APP SAFETY: safe at any time. No shipped code reads `provenance = 'idf_cosine'`, and no confirmed
--   mapping is created or destroyed.

set role claims_admin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Report what will and will not be removed
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  n_total    integer;
  n_reviewed integer;
begin
  select count(*) into n_total from ref.payer_alias_map where provenance = 'idf_cosine';
  select count(*) into n_reviewed from ref.payer_alias_map
   where provenance = 'idf_cosine' and (reviewed_at is not null or reviewed_by is not null);
  raise notice '028 rollback: % idf_cosine row(s) present; % carry review metadata and will be KEPT.',
    n_total, n_reviewed;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Revert the claims-side rows that PRE-EXISTED 028 back to 'no_candidate'
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Identified structurally, not by a hardcoded list: a claims_primary_payer row is pre-existing if 026
-- created it, and 026 created every claims-side name. So the discriminator is the vocabulary, not the
-- name. Reverting rather than deleting is what keeps the 108-name claims vocabulary whole.

update ref.payer_alias_map
   set canonical_payer_id = null,
       relationship       = 'unmapped',
       provenance         = 'no_candidate',
       confidence         = null,
       needs_review       = true,
       review_note        = null
 where vocabulary = 'claims_primary_payer'
   and provenance = 'idf_cosine'
   and reviewed_at is null
   and reviewed_by is null;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Delete the VOB-side rows 028 INSERTED (they did not exist before)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

delete from ref.payer_alias_map
 where vocabulary = 'vob_insurance_co'
   and provenance = 'idf_cosine'
   and reviewed_at is null
   and reviewed_by is null;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Restore the pre-028 provenance CHECK — LAST, and only if no row still needs 'idf_cosine'
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Guarded rather than unconditional: if a reviewer kept some proposals (section 1's "will be KEPT"),
-- narrowing the constraint would fail validation and abort the rollback. Skipping the narrowing in
-- that case leaves a WIDER constraint than pre-028, which permits a value nothing uses — harmless,
-- and far better than a rollback that cannot complete.

do $$
declare
  n integer;
begin
  select count(*) into n from ref.payer_alias_map where provenance = 'idf_cosine';
  if n > 0 then
    raise notice '028 rollback: % row(s) still carry idf_cosine (kept by reviewer); leaving the '
                 'provenance CHECK widened. Re-run this file after those rows are resolved.', n;
    return;
  end if;
  alter table ref.payer_alias_map drop constraint if exists payer_alias_map_provenance;
  alter table ref.payer_alias_map add constraint payer_alias_map_provenance
    check (provenance in ('payer_alias_seed','exact_match','vob_payer_id',
                          'trigram_proposal','no_candidate','human'));
  raise notice '028 rollback: provenance CHECK restored to the 026 value set.';
end
$$;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Verification (run manually after rollback)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- -- No idf_cosine rows remain (expect 0, unless a reviewer deliberately kept some):
-- select count(*) from ref.payer_alias_map where provenance = 'idf_cosine';
--
-- -- The claims-side vocabulary is whole again (expect 108 no_candidate rows):
-- select count(*) from ref.payer_alias_map
--  where vocabulary = 'claims_primary_payer' and provenance = 'no_candidate';
--
-- -- VOB-side back to the 026 count (expect 201 = 55 exact + 10 human + 136 seed):
-- select count(*) from ref.payer_alias_map where vocabulary = 'vob_insurance_co';
--
-- -- Total back to 1,039:
-- select count(*) from ref.payer_alias_map;
--
-- -- Human decisions untouched throughout (expect 42):
-- select count(*) from ref.payer_alias_map where provenance = 'human' or reviewed_at is not null;
--
-- -- The pairing invariant still holds (expect 0):
-- select count(*) from ref.payer_alias_map
--  where (relationship in ('same_payer','carve_out','tpa','employer_self_funded') and canonical_payer_id is null)
--     or (relationship in ('program_label','unmapped') and canonical_payer_id is not null);
