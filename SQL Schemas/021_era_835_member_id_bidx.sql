-- =============================================================================
-- Veris migration 021 — staging.era_835_adjustment.member_id_bidx (searchable PHI)
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- DB: dbpabchpvipipkzkogta
-- Rollback: 021_era_835_member_id_bidx_rollback.sql
--
-- WHY A NEW MIGRATION AND NOT AN EDIT TO 013: 013 was APPLIED LIVE 2026-07-31. The
--   ledger records the rule that followed — any further change to these tables is a NEW
--   migration at the next free Veris number, never an in-place edit to an applied file.
--
-- WHY NOW (the window this closes): 013 deferred member_id_bidx deliberately because the
--   normalization was undecided (see the deferral note on era_835_adjustment.member_id_enc).
--   That decision is now made (below), and staging.era_835_adjustment is still EMPTY with
--   its ingest cron built but UNSCHEDULED. So this is a pure ALTER ADD COLUMN with NO
--   BACKFILL. The moment the cron writes rows it becomes an HMAC backfill over PHI
--   ciphertext (the pattern src/collections/cmdBlindIndexBackfill.ts + migration 0037
--   exist to service). Landing it now avoids that entirely.
--
-- WHAT A BLIND INDEX IS (verbatim posture from 0036, the established pattern): member_id
--   stays encrypted at rest (libsodium, member_id_enc) and is NEVER searchable in
--   plaintext. To let PHI-entitled users look rows up by member ID, we store a KEYED HMAC
--   of the NORMALIZED value alongside the ciphertext. Search = HMAC(term) equality-matched
--   against this column; the plaintext is never decrypted at query time.
--   * Key separation: INDEX_HMAC_KEY, distinct from LIBSODIUM_KEY. A leak of one must not
--     compromise the other. HMAC is one-way + keyed, so a DB-only attacker can neither
--     reverse the token nor brute-force the low-entropy identifier without the key.
--   * The TOKEN is NOT PHI (keyed one-way digest) and is safe to store, index and audit.
--     The INPUT is PHI and is handled as such by the ingest.
--   * Equality leakage (equal values share a token) is the accepted, standard trade-off.
--   Value shape: lowercase hex, HMAC-SHA256, 64 chars. NULL when member_id is absent.
--
-- ⚠️ NORMALIZATION — THE ACTUAL HAZARD THIS MIGRATION EXISTS TO GET RIGHT.
--   TWO functions named normalizeMemberId exist with DIFFERENT semantics:
--     src/collections/normalize.ts  → strips ALL internal whitespace + ALL leading hyphens
--     src/normalize.ts             → KEEPS internal whitespace, strips ONE leading hyphen
--   'AB 123' becomes 'AB123' under the first and 'AB 123' under the second.
--   Every LIVE member_id_bidx token in this database is minted by
--   src/collections/blindIndex.ts, which imports the COLLECTIONS one. So the 835 ingest
--   MUST route through blindIndex.ts and must NEVER re-implement the HMAC: a token built
--   over the other normalization is a valid-looking 64-hex string that silently never
--   matches — a zero-row join with no error and no diagnostic signal.
--   Enforced in code by a PIN TEST asserting the 835 path and the collections path emit
--   BYTE-IDENTICAL tokens for whitespace- and hyphen-bearing inputs (test/era835.test.ts).
--
-- GRANTS: NONE, resolved from 0036 rather than decided fresh. 0036 (the add-columns
--   migration) contains ZERO grant statements — a new column inherits the table's existing
--   table-level grants, so claims_reader's table-level SELECT and cmd_rollup_writer's
--   table-level INSERT both cover member_id_bidx automatically. 0037 DID grant
--   UPDATE(bidx…) to claims_reader, but ONLY to let a one-shot backfill write those columns
--   on pre-0036 rows; there are no pre-existing rows here, so that grant is deliberately
--   NOT reproduced and 013's append-only posture (no role gets UPDATE/DELETE) is preserved.
--   cmd_rollup_writer's COLUMN-level SELECT stays (row_fingerprint) ONLY — it exists solely
--   for the ON CONFLICT arbiter and the writer never reads this token back. Adding
--   member_id_bidx there would widen the writer's read surface for no reason. RLS is
--   unchanged: the existing per-table policies are row-scoped and column-agnostic.
--
-- INDEX: (business_entity_id, member_id_bidx) — composite, tenant-LEADING per the 018
--   index-leadership rule, because every read of this table runs under RLS with
--   business_entity_id = <GUC>. This deliberately DIFFERS from 0036's single-column
--   bidx index: collections.cmd_explorer_rows has RLS qual = true (tenant scoping is
--   applied in the app layer via a bound predicate), so a leading tenant column would buy
--   nothing there. Here it is load-bearing.
--   Table is EMPTY, so a plain CREATE INDEX is correct — no CONCURRENTLY, which means this
--   file is safe inside apply_migration's transaction. Do NOT add CONCURRENTLY to this
--   file: it would fail inside a transaction and must go through execute_sql instead.
--
-- OWNERSHIP: SET ROLE claims_admin, matching 013-020.
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- DEPENDENCY: 013 (the table). No data migration; nothing to reconcile.
-- =============================================================================

SET ROLE claims_admin;

-- 1. The blind-index column ---------------------------------------------------
ALTER TABLE staging.era_835_adjustment
  ADD COLUMN IF NOT EXISTS member_id_bidx text;

COMMENT ON COLUMN staging.era_835_adjustment.member_id_bidx IS
$bx$Keyed-HMAC blind index over the NORMALIZED member id (Loop 2100 NM1*IL) — lowercase
hex, HMAC-SHA256, 64 chars; NULL when the 835 carried no member id. Lets PHI-entitled
users look a remit up by member ID without decrypting member_id_enc: search computes the
same HMAC over the typed term and equality-matches it. Uses INDEX_HMAC_KEY, which MUST
stay distinct from LIBSODIUM_KEY (key separation — a leak of one must not compromise the
other). The TOKEN is not PHI; the INPUT is.

⚠️ NORMALIZATION IS LOAD-BEARING. Tokens MUST be minted via src/collections/blindIndex.ts
(memberIdBlindIndex / blindIndexesForRowSafe), which normalizes through
src/collections/normalize.ts — strips ALL internal whitespace and ALL leading hyphens.
src/normalize.ts exports a DIFFERENT same-named normalizeMemberId (keeps internal
whitespace, strips one leading hyphen): 'AB 123' → 'AB123' vs 'AB 123'. A token built over
the wrong one is a valid-looking 64-hex string that NEVER matches the collections-side
bidx — a zero-row join with no error. Never re-implement the HMAC; a pin test in
test/era835.test.ts asserts byte-identical tokens across both call paths.

Populated at ingest from the plaintext held before encryption (src/ingest/era_ingest.ts,
ingest-SAFE: a missing INDEX_HMAC_KEY yields NULL rather than failing the money-path
ingest — rows are simply not member-searchable until the key is set and a backfill runs).$bx$;

-- 2. Index (tenant-leading per 018) -------------------------------------------
CREATE INDEX IF NOT EXISTS era_835_member_id_bidx_idx
  ON staging.era_835_adjustment (business_entity_id, member_id_bidx);

RESET ROLE;

-- 3. Verification (run manually after apply) -----------------------------------
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='era_835_adjustment'
--    AND column_name='member_id_bidx';            -- expect text / YES
--
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname='staging' AND indexname='era_835_member_id_bidx_idx';
--   -- expect (business_entity_id, member_id_bidx), business_entity_id FIRST
--
-- -- grants unchanged from 013 (inheritance, not new statements):
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='staging' AND table_name='era_835_adjustment'
--    AND grantee NOT IN ('claims_admin','postgres') ORDER BY 1,2;
--   -- expect exactly claims_reader/SELECT + cmd_rollup_writer/INSERT
--
-- SELECT column_name, privilege_type FROM information_schema.column_privileges
--  WHERE table_schema='staging' AND table_name='era_835_adjustment'
--    AND grantee='cmd_rollup_writer' AND privilege_type='SELECT';
--   -- expect row_fingerprint ONLY (member_id_bidx must NOT appear)
--
-- SELECT count(*) FROM staging.era_835_adjustment;          -- expect 0 (no backfill)
-- SELECT pg_get_userbyid(relowner) FROM pg_class
--  WHERE oid='staging.era_835_adjustment'::regclass;        -- expect claims_admin
-- =============================================================================
