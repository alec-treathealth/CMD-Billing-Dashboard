-- 0077 ROLLBACK — coding decision registry.
--
-- Drops the two tables and the schema. The `coding_editor` ROLE is deliberately NOT dropped
-- (standing rule: never DROP ROLE — a role referenced by any other object or grant elsewhere would
-- make the rollback destructive beyond its own migration); its grants disappear with the objects.
-- Re-running 0077 after this rollback recreates everything and finds the role already present.
--
-- DATA LOSS WARNING: this destroys the registry contents AND the audit trail. The seed importer can
-- re-load the matrix, but any in-app edits made after the seed exist only here. Export first:
--   copy (select * from coding.code_decision) to stdout with csv header;
--   copy (select * from coding.code_decision_audit) to stdout with csv header;

drop table if exists coding.code_decision_audit;
drop table if exists coding.code_decision;
drop schema if exists coding;

-- Verification (run manually after rollback):
-- select count(*) from pg_namespace where nspname = 'coding';           -- expect 0
-- select rolname from pg_roles where rolname = 'coding_editor';        -- still present, by design
