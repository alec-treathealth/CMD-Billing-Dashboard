-- 027 ROLLBACK — restore the 11 absorbed payer identities and drop the two new tables.
--
-- WHY: reverses SQL Schemas/027_payer_identity_dedup.sql as far as it is reversible. Read the
--   DATA LOSS section before running: "as far as it is reversible" is doing real work in that
--   sentence.
--
-- PHI DISCIPLINE: unchanged. Both dropped tables hold NON-PHI public payer reference data.
--
-- OWNERSHIP: runs as `claims_admin`, the owner of every object touched, matching the forward file.
--
-- IDEMPOTENT: `IF EXISTS` on the drops, `ON CONFLICT DO NOTHING` on the identity restore. Re-running
--   after a completed rollback is a no-op.
--
-- ⚠⚠ DATA LOSS — THE ALIAS REPOINT IS NOT REVERSIBLE. READ THIS BEFORE RUNNING.
--
--   The forward migration UPDATEs `ref.payer_alias_map.canonical_payer_id` from absorbed → survivor.
--   That update is destructive: after it, an alias row pointing at `pi_anthem_california` is
--   indistinguishable from one that ALWAYS pointed there. `payer_identity_merge_log` records how
--   MANY rows moved per absorbed id, but not WHICH ones — so this rollback can recreate the empty
--   identity shells and cannot put the aliases back.
--
--   Section 3 therefore restores the 11 identity rows with ZERO aliases attached. The crosswalk's
--   behaviour after that is NOT the pre-027 behaviour: it is the post-027 mapping with 11 orphan
--   identities re-added. If the aliases matter, capture them BEFORE rolling back:
--
--     \copy (select vocabulary, alias_norm, canonical_payer_id, relationship, provenance,
--                   confidence, needs_review, review_note, reviewed_by, reviewed_at
--              from ref.payer_alias_map
--             where canonical_payer_id in (select survivor_id from ref.payer_identity_merge_log
--                                           where migration_no = '027'))
--        to 'payer_alias_map_pre_027_rollback.csv' csv header
--
--   ...and re-split them by hand. There is no query that can do it for you, which is the honest
--   reason a merge is a reviewed decision and not an automated one.
--
--   The SIX never-merge rulings are also destroyed by the DROP. They are human adjudications and
--   cannot be rebuilt from data — export them first if any review has happened since:
--
--     \copy (select id_low, id_high, reason, ruled_by, ruled_at
--              from ref.payer_identity_never_merge) to 'never_merge_backup.csv' csv header
--
-- DEPENDENCY / ORDERING — the drop goes LAST, and that is forced, not stylistic:
--   restore the absorbed identities (2) → restore the pre-027 display names (3) → drop the two new
--   tables (4). `payer_identity_merge_log` is the ONLY record of which ids were absorbed, so it must
--   still exist when section 2 reads it. Dropping first would erase the instructions for the restore.
--   A partial run therefore leaves the tables present and the identities back — a recoverable
--   half-state — rather than the tables gone and the identities unrecoverable.
--
-- APP SAFETY: safe while no shipped code reads these tables. Once D2's resolution service reads the
--   crosswalk, this rollback re-introduces duplicate candidates for one payer — the exact defect 027
--   exists to remove — so revert the code first.

set role claims_admin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Capture what we are about to lose, into a NOTICE, so the operator sees it in the apply output
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  n_log integer := 0;
  n_nm  integer := 0;
begin
  if to_regclass('ref.payer_identity_merge_log') is not null then
    select count(*) into n_log from ref.payer_identity_merge_log where migration_no = '027';
  end if;
  if to_regclass('ref.payer_identity_never_merge') is not null then
    select count(*) into n_nm from ref.payer_identity_never_merge;
  end if;
  raise notice '027 rollback: about to drop % never-merge ruling(s) and % merge-log row(s). Alias repointing is NOT reversible.',
    n_nm, n_log;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Restore the absorbed identities FIRST, while the merge log still exists to name them
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The log is the only record of what was absorbed, so this must precede the drop. entity_kind is
-- restored as 'unclassified' rather than guessed: the forward migration did not record the absorbed
-- rows' entity_kind, and inventing 'insurer' would fabricate a classification a human never made.

do $$
declare
  n integer := 0;
begin
  if to_regclass('ref.payer_identity_merge_log') is null then
    raise notice '027 rollback: no merge log — nothing to restore (already rolled back, or 027 never applied).';
    return;
  end if;

  insert into ref.payer_identity
    (canonical_payer_id, display_name, entity_kind, is_active, notes)
  select l.absorbed_id,
         l.absorbed_display_name,
         'unclassified',
         true,
         format('Restored by 027 rollback. Was absorbed into %s by migration 027; its %s alias row(s) '
                'were NOT restored and remain on the survivor. entity_kind reset to unclassified '
                'because 027 did not record the original.', l.survivor_id, l.aliases_repointed)
    from ref.payer_identity_merge_log l
   where l.migration_no = '027'
  on conflict (canonical_payer_id) do nothing;
  get diagnostics n = row_count;
  raise notice '027 rollback: restored % identity row(s), each with ZERO aliases attached.', n;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Restore the pre-027 display names on the 10 survivors
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The upper-case names 026 seeded. Hardcoded because the forward migration overwrote them in place
-- without recording the previous value — a deliberate simplicity trade at authoring time, paid for
-- here.

update ref.payer_identity set display_name = v.name, updated_at = now()
  from (values
    ('pi_anthem_california',  'ANTHEM CALIFORNIA'),
    ('pi_bcbs_new_hampshire', 'BCBS NEW HAMPSHIRE'),
    ('pi_anthem_nevada',      'ANTHEM NEVADA'),
    ('pi_anthem_georgia',     'ANTHEM GEORGIA'),
    ('pi_anthem_indiana',     'ANTHEM INDIANA'),
    ('pi_anthem_kentucky',    'ANTHEM KENTUCKY'),
    ('pi_anthem_ohio',        'ANTHEM OHIO'),
    ('pi_carefirst_maryland', 'CAREFIRST MARYLAND'),
    ('pi_premera_washington', 'PREMERA WASHINGTON'),
    ('pi_bcbs_federal',       'BCBS FEDERAL')
  ) as v(id, name)
 where ref.payer_identity.canonical_payer_id = v.id;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Drop the two tables LAST — the RESTRICT FKs make ordering mandatory, not stylistic
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

drop policy if exists payer_identity_never_merge_read_all on ref.payer_identity_never_merge;
drop table  if exists ref.payer_identity_never_merge;

drop policy if exists payer_identity_merge_log_read_all on ref.payer_identity_merge_log;
drop table  if exists ref.payer_identity_merge_log;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Verification (run manually after rollback)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- -- Both tables gone (expect 0):
-- select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'ref' and c.relname in ('payer_identity_never_merge','payer_identity_merge_log');
--
-- -- Identity count back to 199, and the 11 restored rows carry zero aliases (expect 11 rows, all 0):
-- select count(*) from ref.payer_identity;                                            -- 199
-- select i.canonical_payer_id,
--        (select count(*) from ref.payer_alias_map m where m.canonical_payer_id = i.canonical_payer_id) as aliases
--   from ref.payer_identity i
--  where i.notes like 'Restored by 027 rollback%' order by 1;
--
-- -- No orphaned policies/indexes:
-- select count(*) from pg_policies where schemaname = 'ref' and tablename like 'payer_identity_%merge%';
-- select count(*) from pg_indexes  where schemaname = 'ref' and tablename like 'payer_identity_%merge%';
--
-- -- 026's tables are otherwise untouched:
-- select count(*) from ref.payer_alias_map;   -- 1,039 (unchanged by rollback)
