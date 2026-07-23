-- Rollback for 0063_vob_member_benefits_matview.sql. Apply as `postgres`.
-- Drops the refresh function + matview (and its indexes, dropped implicitly with the matview).
-- pg_trgm is intentionally NOT dropped — other objects may depend on it. After this, the app must be
-- repointed back to vob.member_benefits_current (revert the src/collections/cmdExplorerQuery.ts change)
-- or its market-filter/employer-options queries will error on the missing relation.

drop function if exists vob.refresh_member_benefits_latest();
drop materialized view if exists vob.member_benefits_latest;
