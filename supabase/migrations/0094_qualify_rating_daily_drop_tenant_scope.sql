-- 0094 — drop the constant `tenant_scope` column from collections.qualify_policy_rating_daily
--
-- WHY: MEASURED after 0093's first backfill (2026-08-09, 214,407 rows over 180 days).
--   `tenant_scope` is a `text not null default 'cross-tenant-bxr-indigo'` that is IDENTICAL in
--   every row — the cron's only caller pins `entityIds: [BXR, INDIGO]` (app/lib/server.ts's
--   handleQualifyRatingHistory), so the value is a property of the TABLE, not of a row. It cost a
--   measured **5,025 kB** across the backfill (`sum(pg_column_size(tenant_scope))`) and would cost
--   ~10 MB/year to restate a constant on every row.
--
--   The invariant it recorded is NOT lost — it moves to a COMMENT ON TABLE, which is where a
--   table-wide fact belongs and where `\d+` will show it. If the population ever becomes variable
--   (a per-tenant rating, a single-tenant read), re-add it AS A REAL COLUMN then, with values that
--   actually differ; a column whose every row agrees is documentation paying rent as storage.
--
-- PHI DISCIPLINE: none. Drops a non-PHI constant label; touches no token, no identifier, no
--   amount. No row is deleted and no rating changes.
--
-- OWNERSHIP: postgres (collections plane — NO `set role claims_admin` here; it downgrades the
--   applying role and fails 42501, the 0084/0085 lesson).
--
-- IDEMPOTENT: `drop column if exists` + `comment on` is repeatable; re-running is a no-op.
--
-- DEPENDENCY: 0093 (creates the table). NO CODE CHANGE REQUIRED — verified 2026-08-09 that
--   `tenant_scope` appears nowhere in src/ or app/: buildRatingDailyUpsert's explicit column list
--   omits it entirely and relied on the DEFAULT, so the insert keeps working untouched.
--
-- SIZE: reclaims ~5 MB of the current 70 MB immediately on the rewrite, ~10 MB/yr thereafter.
--   `drop column` only marks the attribute dropped — existing row versions keep the bytes until
--   they are rewritten, so section 3 does a VACUUM FULL to realise it now while the table is
--   small. See the APPLY DISCIPLINE note below: that statement is NOT part of this transaction.
--
-- Rollback: 0094_qualify_rating_daily_drop_tenant_scope_rollback.sql

-- 1. Drop the constant ------------------------------------------------------------------------
alter table collections.qualify_policy_rating_daily drop column if exists tenant_scope;

-- 2. The invariant, recorded where a table-wide fact belongs -----------------------------------
comment on table collections.qualify_policy_rating_daily is
  'Daily policy-rating snapshots, one row per (member_id_prefix_bidx, primary_payer) pair per '
  'as_of_date. POPULATION IS ALWAYS THE PINNED CROSS-TENANT BOOK [BXR, Indigo] — Qualify reads '
  'both tenants by design (see src/collections/qualifyQuery.ts''s cross-tenant exception), so the '
  'scope is an invariant of this table rather than a per-row fact. It was a constant text column '
  'until 0094 dropped it. Written nightly by /api/cron/qualify-rating-history; as_of is always the '
  'newest CLOSED date (yesterday), never today. Ratings are the same five-factor policy rating the '
  'interactive surface shows; a NULL rating is honest suppression (sample floor / no money '
  'evidence), never 0.';

comment on column collections.qualify_policy_rating_daily.rating is
  'Patient-weighted policy rating 0-100, or NULL when suppressed. NULL is not 0 — "we cannot say" '
  'and "they pay nothing" are opposite claims. 90.7% of rows are NULL at the 3-member floor '
  '(measured 2026-08-09): a member-ID prefix is usually one person, not a population.';

-- 3. Reclaim the bytes (RUN SEPARATELY — see APPLY DISCIPLINE) ----------------------------------
-- VACUUM FULL cannot run inside a transaction block, so it is NOT in this file's transactional
-- body. Run it as its own autocommit statement after applying sections 1-2:
--
--   vacuum (full, analyze) collections.qualify_policy_rating_daily;
--
-- It takes an ACCESS EXCLUSIVE lock. Safe here because the only writer is a nightly cron and the
-- only reader is the tape (which degrades to an empty lane, not an error). At 70 MB this is
-- seconds. Skip it and the column's bytes simply linger until rows are naturally rewritten —
-- correctness is unaffected either way.

-- 4. Verification (run manually after apply) ----------------------------------------------------
--   select count(*) from information_schema.columns
--     where table_schema='collections' and table_name='qualify_policy_rating_daily'
--       and column_name='tenant_scope';                                          -- expect 0
--   select count(*) from collections.qualify_policy_rating_daily;                -- unchanged: 214407
--   select pg_size_pretty(pg_total_relation_size('collections.qualify_policy_rating_daily'));
--   select obj_description('collections.qualify_policy_rating_daily'::regclass); -- the invariant
