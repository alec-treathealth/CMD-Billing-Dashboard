-- Rollback for 0094 — restores the constant `tenant_scope` column.
--
-- Restores the column WITH its default, so every existing row is backfilled to
-- 'cross-tenant-bxr-indigo' — which is lossless, because that is the only value the column ever
-- held (0093 shipped it as `not null default 'cross-tenant-bxr-indigo'` and no writer ever set it
-- to anything else; buildRatingDailyUpsert's column list omits it entirely).
--
-- ⚠ COST: adding a NOT NULL column with a non-volatile default is metadata-only in PG 11+, so the
-- ADD itself is fast — but the ~5 MB it represents comes back as rows are rewritten, and a
-- VACUUM FULL run under 0094 will have already compacted the table. This is a genuine undo, not a
-- free one.
--
-- Idempotent: IF NOT EXISTS. Plain transactional DDL — safe under apply_migration.

alter table collections.qualify_policy_rating_daily
  add column if not exists tenant_scope text not null default 'cross-tenant-bxr-indigo';

-- Drop the comments 0094 added (restores the pre-0094 state of no table/column comment).
comment on table collections.qualify_policy_rating_daily is null;
comment on column collections.qualify_policy_rating_daily.rating is null;
