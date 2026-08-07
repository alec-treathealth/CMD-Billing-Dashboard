-- 031 ROLLBACK — drop the payer brand allowlist
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS UNDOES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Drops `ref.payer_brand_entity` then `ref.payer_brand`, with their policies, grants and indexes.
-- Child first: `payer_brand_entity_brand_fkey` is ON DELETE CASCADE for rows, but the TABLE still
-- depends on the parent, so dropping `payer_brand` first errors with 2BP01.
--
-- ⚠ DATA LOSS. The seed is eight brand rows and two entity rows of HUMAN CURATION — the Health Net
-- and Florida Blue dual-entity rulings, the HCSC parent_entity mapping, and the Anthem
-- historical-predecessor note. None of it is recoverable from anywhere else in the database; it does
-- not exist in `payer_alias_map` or `payer_identity`. Export before dropping if the rulings are worth
-- keeping:
--
--   \copy (select * from ref.payer_brand)        to 'payer_brand_backup.csv' csv header
--   \copy (select * from ref.payer_brand_entity) to 'payer_brand_entity_backup.csv' csv header
--
-- ⚠ CHECK FOR CALLERS FIRST. 031 shipped with nothing reading these tables, which is what made it
-- safe to drop. If any code has been wired to them since, this rollback breaks that code at runtime
-- rather than at deploy — a missing table is a 42P01 at query time, and the app's fail-soft paths
-- will turn it into an empty result rather than a visible failure. Grep before running:
--
--   grep -rn "payer_brand" src/ app/ scripts/
--
-- Nothing in `ref.payer_identity` or `ref.payer_alias_map` is touched. No canonical id, alias or
-- confirmation state changes. This rollback cannot un-resolve a payer.
--
-- OWNERSHIP / IDEMPOTENT: runs as claims_admin; every statement is IF EXISTS, so a second run is a
-- no-op. Dropping a table drops its policies and indexes with it — the explicit DROP POLICY lines are
-- there so a partial 031 (tables created, policies applied, then a later section failed) also cleans
-- up, and they are harmless when the table is already gone.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

drop policy if exists payer_brand_entity_read_all on ref.payer_brand_entity;
drop policy if exists payer_brand_read_all on ref.payer_brand;

drop table if exists ref.payer_brand_entity;
drop table if exists ref.payer_brand;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Verification (run manually after rollback)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- select count(*) from information_schema.tables
--  where table_schema='ref' and table_name in ('payer_brand','payer_brand_entity');   -- expect: 0
--
-- select count(*) from pg_policies
--  where schemaname='ref' and tablename in ('payer_brand','payer_brand_entity');      -- expect: 0
--
-- The identity plane is untouched:
-- select count(*) from ref.payer_identity;                                            -- unchanged
-- select count(*) from ref.payer_alias_map;                                           -- expect: 1685
