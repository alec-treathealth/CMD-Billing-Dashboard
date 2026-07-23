-- 0060_vob_indigo_rollback.sql   — DRAFT. Reverses 0060_vob_indigo.sql.
-- Apply as `postgres`. Order matters: drop the view before the table.
--
-- IMPORTANT: do NOT drop schema `vob` — it pre-existed 0060 and holds an unrelated
-- scaffold (vob.benefit_checks / benefit_check_services / claim_line_features). 0060 only
-- ADDED objects into it; rollback removes only those.

drop view  if exists vob.member_benefits_current;

-- policies + indexes drop with the table; explicit drops are harmless if run first.
drop policy if exists vob_indigo_rw on vob.indigo_vob;
drop policy if exists vob_indigo_ro on vob.indigo_vob;

drop table if exists vob.indigo_vob;

-- Grants on dropped objects vanish with them. The schema-level `grant usage on schema vob`
-- to the app roles is left in place (harmless; vob schema remains in use by the scaffold).
