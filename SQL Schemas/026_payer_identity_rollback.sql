-- 026 ROLLBACK — drop ref.payer_alias_map + ref.payer_identity
--
-- WHY: reverses SQL Schemas/026_payer_identity.sql in full.
--
-- PHI DISCIPLINE: unchanged — both tables hold NON-PHI public payer reference data only. Dropping them
--   removes no PHI and no audit trail.
--
-- OWNERSHIP: runs as `claims_admin` (the owner of both tables) via SET ROLE, matching the forward file.
--
-- IDEMPOTENT: `DROP ... IF EXISTS` on both tables and (defensively) on both policies. Re-running after a
--   completed rollback is a no-op. Policies and indexes are dropped implicitly with their table; the
--   explicit DROP POLICY statements only matter if a partial forward apply left a table without its
--   companion, which the single-transaction apply path makes impossible but costs nothing to cover.
--
-- DEPENDENCY / ORDERING: `payer_alias_map` FKs to `payer_identity`, so it MUST drop first. The
--   self-referencing FK on `payer_identity.administers_for` drops with the table and needs no special
--   handling.
--
-- ⚠ DATA LOSS — read before running. Dropping these tables destroys every HUMAN REVIEW DECISION
--   recorded in `ref.payer_alias_map` (`canonical_payer_id`, `relationship`, `needs_review`,
--   `review_note`, `reviewed_by`, `reviewed_at`). The forward migration can rebuild the machine-derived
--   rows — the ref.payer_alias seed, the exact matches, the payer_id hints, the trigram proposals — but
--   it CANNOT rebuild a reviewer's accept/reject calls. If any review has happened, export it first:
--
--     \copy (select vocabulary, alias_norm, canonical_payer_id, relationship, provenance, confidence,
--                   needs_review, review_note, reviewed_by, reviewed_at
--              from ref.payer_alias_map
--             where reviewed_at is not null or provenance = 'human')
--        to 'payer_alias_map_reviewed_backup.csv' csv header
--
--   `ref.payer_alias` (the 262-row source seed) is NOT touched by this rollback and is unaffected.
--
-- APP SAFETY: safe to run with no application-ordering constraint AS LONG AS no shipped code reads
--   these tables yet. P0 is data-only by design (no UI, no query-library change), so at P0 that holds.
--   Once D2's resolution service reads the crosswalk, this rollback becomes app-breaking and the code
--   must be reverted first.

set role claims_admin;

-- Child first: payer_alias_map FKs to payer_identity.
drop policy if exists payer_alias_map_read_all on ref.payer_alias_map;
drop table  if exists ref.payer_alias_map;

drop policy if exists payer_identity_read_all on ref.payer_identity;
drop table  if exists ref.payer_identity;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Verification (run manually after rollback)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- -- Both tables gone:
-- select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='ref' and c.relname in ('payer_identity','payer_alias_map');           -- 0
-- -- No orphaned policies or indexes left behind:
-- select count(*) from pg_policies
--  where schemaname='ref' and tablename in ('payer_identity','payer_alias_map');          -- 0
-- select count(*) from pg_indexes
--  where schemaname='ref' and tablename in ('payer_identity','payer_alias_map');          -- 0
-- -- The source seed is untouched:
-- select count(*) from ref.payer_alias;                                                   -- 262
-- -- ref's other tables are unaffected (015's posture intact):
-- select count(*) from pg_tables where schemaname='ref';                                  -- unchanged
