-- 038 ROLLBACK — drop ref.code_description.
--
-- ⚠ READ BEFORE RUNNING. The seed is reproducible from 038 (re-apply restores all 85 rows), but a
-- REVIEW is not: any row where a human has set needs_review = false / reviewed_by / reviewed_at, or
-- edited a label, exists nowhere else. If the check below returns rows, EXPORT THEM FIRST:
--
--   select * from ref.code_description
--    where not needs_review or reviewed_by is not null or created_at <> (select min(created_at) from ref.code_description);
--
-- ⚠ ONCE A WRITER EXISTS (follow-up: "review workflow / writer for ref.code_description"), DROP TABLE
-- DESTROYS HUMAN REVIEW RULINGS — every reviewed_by / reviewed_at / cleared needs_review / edited label
-- that a reviewer set. The comment above is a warning, not a safeguard: it does not execute and cannot
-- stop the drop. Today the risk is theoretical because nothing writes; whoever runs this later must
-- treat the export step as mandatory, not advisory.
--
-- Nothing else depends on this table: no FK points at it, no view or function reads it, and the
-- app's reader degrades to "no description" when the relation is absent.
--
-- Apply as: postgres → set role claims_admin (the same path 038 used; claims_admin owns the table).

set role claims_admin;

drop policy if exists code_description_read_all on ref.code_description;
drop table if exists ref.code_description;

reset role;

-- Verification (run manually after rollback):
-- select to_regclass('ref.code_description');   -- expect: NULL
-- select pg_has_role('postgres','claims_admin','SET');   -- expect: t (untouched)
