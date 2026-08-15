-- 0101_cmd_explorer_employer_name.sql
-- Adds the collections-native Employer Name dimension to collections.cmd_explorer_rows.
--
-- ⚠ APPLY AS AUTOCOMMIT STATEMENTS (execute_sql), NOT apply_migration.
--    Section 2 runs CREATE INDEX CONCURRENTLY, which cannot run inside a transaction block.
--    Same discipline as 0070 / 0081 / 0092. Run section 1, then section 2, then section 3.
--
-- OWNERSHIP: the collections plane is owned by `postgres`, NOT claims_admin. Do NOT add
-- `set role claims_admin` here — it downgrades the applying role to non-owner and fails
-- 42501 (0084/0085 both hit this). Apply as `postgres`.
--
-- GRANTS — verified live 2026-08-15 against information_schema.table_privileges:
--   · READ + INSERT need NOTHING added. claims_reader holds SELECT and cmd_rollup_writer holds
--     INSERT at the TABLE level (not column-scoped), so both automatically cover a new column.
--     Do NOT add a per-column SELECT or INSERT grant — that would convert the table-level model
--     to a column one and every FUTURE column would then silently need its own grant.
--   · UPDATE DOES need a grant, and section 4 adds a deliberately COLUMN-SCOPED one. Measured:
--     the ONLY role with UPDATE on this table is `postgres`. claims_admin has NO privileges on
--     it at all (it is a collections-plane table, owned by postgres — see the ownership note
--     above), so the usual admin path does not work here.
--     The one-shot employer backfill must UPDATE existing rows: the hourly cron is
--     ON CONFLICT (row_fingerprint) DO NOTHING and therefore can only ever populate employer on
--     NEWLY INSERTED rows, leaving all 650,696 pre-existing rows (622,489 of them CSV-backfilled)
--     permanently null without it.
--     Column-scoping is the point — `update (employer_name)` lets the writer set THIS column and
--     nothing else, so a compromised or buggy backfill cannot rewrite a dollar amount, a date, or
--     an encrypted identifier. A bare table-level `grant update` would hand it the whole row.
--
-- PHI POSTURE (RULED BY ALEC 2026-08-14 — do not soften without a new ruling):
--   employer_name here is the PLAN SPONSOR (e.g. 'BOEING'), a plan/group-level attribute in
--   the same class as collections.primary_payer — NOT the employee/subscriber name. It is
--   ruled NON-PHI for display and search (so it renders in the clear and is legal in a search
--   term), while REMAINING in the src/queries/types.ts `PhiKey` union so the compile-time
--   NoPhi<T> guard still makes it impossible for employer_name to become a summary_stats key
--   or reach a model prompt. That asymmetry is the whole point: searchable, never inferred on.
--   This resolves a live contradiction — app/lib/phi.ts classified it PHI while
--   supabase/migrations/0061_vob_employer.sql ruled the opposite for the VOB plane.
--
-- GRAIN NOTE — WHY THIS IS NOT ON THE ROLLUP:
--   collections.cmd_explorer_charge_rollup (matview, 165 MB heap + 313 MB indexes as measured
--   2026-08-15) groups by (business_entity_id, member_id_bidx, member_id_prefix_bidx,
--   charge_date, cpt_code, revenue_key, facility, charge_amount). employer_name is NOT in that
--   grain. Adding it to the GROUP BY would SPLIT a charge into two rows whenever employer
--   varies across a charge's postings — reintroducing exactly the snapshot-grain double-count
--   that 0050/0059 exist to fix. And adding it as an aggregate would still require DROP +
--   CREATE MATERIALIZED VIEW, destroying all 313 MB of indexes including 0092's token-scoped
--   covering indexes (Qualify's 17.5ms index-only path). The read layer instead joins this
--   base table on `id` — sound because the rollup's `id` IS the latest snapshot's real
--   cmd_explorer_rows.id. Cost is ~50 primary-key lookups per grid page.
--
-- FINGERPRINT FENCE: employer_name is DELIBERATELY ABSENT from row_fingerprint (the LOCKED
--   14-element array in src/collections/cmdExplorerSeed.ts mapRow). Adding it would change
--   every existing row's dedup key, ON CONFLICT (row_fingerprint) would stop firing, and the
--   hourly cron would re-insert the entire 650,696-row book. Same fence as charge_to_date and
--   the ②a Feed-1 columns. The column is populated on INSERT of NEW rows and by the one-shot
--   fingerprint-matched backfill; the cron is ON CONFLICT DO NOTHING and never updates.
--
-- ROLLBACK: 0101_cmd_explorer_employer_name_rollback.sql

-- ---------------------------------------------------------------------------
-- SECTION 1 — the column (transactional, metadata-only)
-- ---------------------------------------------------------------------------
-- A nullable text column with no default is a catalog-only change in PG11+: NO table rewrite,
-- so all 650,696 rows (622,489 of them CSV-backfilled and irreplaceable) are untouched.
alter table collections.cmd_explorer_rows
  add column if not exists employer_name text;

comment on column collections.cmd_explorer_rows.employer_name is
  'Plan sponsor / group employer from the CMD report (e.g. BOEING). Plan-level attribute in the '
  'same class as primary_payer — NOT the employee/subscriber name. Ruled non-PHI for display and '
  'search 2026-08-14 while remaining in the PhiKey union (never summary_stats, never an LLM '
  'prompt). NOT part of row_fingerprint — see the fingerprint fence in the migration header.';

-- ---------------------------------------------------------------------------
-- SECTION 2 — the search index (AUTOCOMMIT ONLY — CONCURRENTLY)
-- ---------------------------------------------------------------------------
-- The Collections employer search is a leading-wildcard `ilike '%term%'`, which no btree can
-- serve — it needs trigram GIN. This migration does not create the extension.
--
-- ⚠ THE OPERATOR CLASS IS SCHEMA-QUALIFIED `claims.gin_trgm_ops` ON PURPOSE. pg_trgm does NOT
--   live in public here — migration 0003 deliberately relocated it into the `claims` schema so
--   claims_reader could use similarity()/% without a public grant. Verified live 2026-08-15:
--   ALL 12 trigram indexes in this database (claims.*, collections.*, vob.*, ref.*, rag.*)
--   spell it `claims.gin_trgm_ops`. A bare `gin_trgm_ops` resolves only if `claims` happens to
--   be on the applying role's search_path — do not write the bare form.
--
-- BUILT NOW, WHILE THE COLUMN IS 100% NULL — deliberately. GIN indexes store nothing for NULL,
-- so this build is near-instant and near-zero bytes today, and grows incrementally as the
-- backfill lands. Building it AFTER a 650k-row backfill would be dramatically more expensive.
--
-- ⚠ SIZE IS UNMEASURED AND MUST BE MEASURED AT APPLY. Do not trust an estimate here: 0092's
-- rollback header estimated "10-15 MB combined" for two indexes that cost 169 MB — a 12x miss —
-- because it priced the keys and not the widest text column. Record the real number in
-- veris-data-notes.md after the backfill completes, not after this migration.
create index concurrently if not exists idx_cmd_explorer_rows_employer_trgm
  on collections.cmd_explorer_rows using gin (employer_name claims.gin_trgm_ops);

-- PARTIAL index for the segment toggle (All / Employer / Individual) and the coverage probe.
-- The trigram index above serves substring MATCHING; it does not serve `is not null`, which is what
-- the Employer segment and the "do we have any employer data yet?" check actually ask.
--
-- Partial, not full: it indexes only rows that HAVE an employer, so it stays proportional to real
-- coverage rather than to the 650,696-row table — near-zero today, and never larger than the
-- populated subset. It is also what makes the NEGATIVE coverage answer fast: without it, "no
-- employer data yet" costs a full scan that finds nothing, which is exactly the state the probe
-- exists to detect and the one the UI hits on every page load before the backfill lands.
--
-- The Individual segment is the complement and is deliberately NOT indexed: it selects most of the
-- table while coverage is low, so a scan is the correct plan and an index would be ignored anyway.
create index concurrently if not exists idx_cmd_explorer_rows_has_employer
  on collections.cmd_explorer_rows (business_entity_id)
  where employer_name is not null and employer_name <> '';

-- ---------------------------------------------------------------------------
-- SECTION 3 — column-scoped UPDATE for the backfill (transactional)
-- ---------------------------------------------------------------------------
-- Least privilege by construction: this grant names ONE column. The writer gains the ability to
-- set employer_name and gains nothing else — it still cannot UPDATE charge_amount, payment_received,
-- row_fingerprint, or any of the three libsodium-encrypted PHI columns.
--
-- ⚠ THE FINGERPRINT IS DELIBERATELY NOT IN THIS GRANT. The backfill matches rows BY row_fingerprint
-- and must never be able to rewrite one — a writable dedup key would let a bad run silently detach
-- rows from the cron's ON CONFLICT idempotency and re-duplicate the whole book on the next pull.
grant update (employer_name) on collections.cmd_explorer_rows to cmd_rollup_writer;

-- ---------------------------------------------------------------------------
-- SECTION 4 — plan refresh
-- ---------------------------------------------------------------------------
-- ANALYZE only (no VACUUM FULL, no rewrite): the planner needs stats on the new column before
-- the semi-join selectivity estimate for the employer search is meaningful.
analyze collections.cmd_explorer_rows;
