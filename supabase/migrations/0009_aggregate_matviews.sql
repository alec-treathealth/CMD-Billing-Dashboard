-- 0009: Non-PHI aggregate materialized views for the dashboard (Workstream 1c).
--
-- The dashboard's two heaviest reads are arg-free full-table GROUP BYs over
-- claims.claims (~320k rows), recomputed on every cold load:
--   * payer gap / payer overview  (group by payer_name)
--   * claim distributions, count  (group by facility_name / payer_name /
--                                  hcpcs_code / revenue_code / source_year)
-- This migration pre-aggregates BOTH into materialized views so the dashboard
-- reads a tiny pre-summed table instead of scanning claims.claims. The agent and
-- PHI-reveal paths are NOT affected: they still run live against claims.claims
-- (filtered queries can't be served from a fully pre-aggregated rollup, and the
-- results route re-derives PHI rows from claims.claims as before).
--
-- PHI: every column here is a non-PHI AGGREGATE over allowlisted DIMENSION columns
-- (facility_name, payer_name, hcpcs_code, revenue_code, source_year) plus money
-- sums / counts. None of the seven PHI columns (patient_name/first/last,
-- member_id_raw/norm, group_number, employer_name) and no row-level claim data is
-- present. Materialized views do not support RLS; access is controlled by GRANT —
-- claims_reader gets SELECT on these non-PHI rollups only.
--
-- Ownership: set to claims_admin so the existing ingest role (which already holds
-- the admin connection) can REFRESH MATERIALIZED VIEW CONCURRENTLY at the end of a
-- load. The unique indexes below make CONCURRENTLY possible (no read lock on the
-- dashboard during refresh). Idempotent: IF NOT EXISTS throughout.

-- 1. Payer gap / payer overview --------------------------------------------
-- Mirrors src/queries/payer_gap_analysis.ts payerGapSql('') (no filter).
create materialized view if not exists claims.mv_payer_gap as
  select
    payer_name,
    count(*)::bigint                                              as claim_count,
    coalesce(sum(charge_amount), 0)                              as total_charge,
    coalesce(sum(allowed_amount), 0)                             as total_allowed,
    coalesce(sum(paid_amount), 0)                                as total_paid,
    avg(collection_rate)                                         as avg_collection_rate,
    coalesce(sum(charge_amount - coalesce(allowed_amount, 0)), 0) as total_write_down,
    coalesce(sum(charge_amount - coalesce(paid_amount, 0)), 0)   as total_collection_gap
  from claims.claims
  group by payer_name
  with data;

-- 2. Claim distributions (count metric only) -------------------------------
-- One row per (dimension field, value). `field` is a fixed dimension-name label,
-- never caller text; `value` is the grouped dimension value cast to text.
create materialized view if not exists claims.mv_distribution_count as
      select 'facility_name'::text as field, facility_name::text as value, count(*)::bigint as metric_value
        from claims.claims group by facility_name
  union all
      select 'payer_name'::text,   payer_name::text,   count(*)::bigint from claims.claims group by payer_name
  union all
      select 'hcpcs_code'::text,   hcpcs_code::text,   count(*)::bigint from claims.claims group by hcpcs_code
  union all
      select 'revenue_code'::text, revenue_code::text, count(*)::bigint from claims.claims group by revenue_code
  union all
      select 'source_year'::text,  source_year::text,  count(*)::bigint from claims.claims group by source_year
  with data;

-- 3. Unique indexes (required for REFRESH ... CONCURRENTLY) -----------------
-- payer_name is NOT NULL in the source, so a plain unique index is complete.
create unique index if not exists mv_payer_gap_payer
  on claims.mv_payer_gap (payer_name);

-- value is nullable (hcpcs_code / revenue_code may be NULL); coalesce keeps the
-- unique key non-null and total. Exactly one NULL-value bucket exists per field.
create unique index if not exists mv_distribution_count_key
  on claims.mv_distribution_count (field, (coalesce(value, ''::text)));

-- 4. Grants ----------------------------------------------------------------
-- Reader: SELECT on the non-PHI rollups only (no new access to claims_raw / PHI).
grant select on claims.mv_payer_gap          to claims_reader;
grant select on claims.mv_distribution_count to claims_reader;

-- 5. Refresh helper (SECURITY DEFINER) ------------------------------------
-- The migration role cannot transfer matview ownership to claims_admin, so
-- instead a fixed SECURITY DEFINER function runs the two REFRESH statements
-- as the function owner (postgres / superuser). No dynamic SQL; no arguments;
-- fixed object names only. CONCURRENTLY requires the unique indexes above.
-- Execute is granted only to claims_admin (the ingest role); no other role
-- can trigger a refresh. Function exposes no PHI or row-level data.
create or replace function claims.refresh_aggregate_matviews()
  returns void
  language plpgsql
  security definer
  set search_path = claims, pg_temp
as $$
begin
  refresh materialized view concurrently claims.mv_payer_gap;
  refresh materialized view concurrently claims.mv_distribution_count;
end;
$$;

-- Revoke default public execute, then grant only to ingest role.
revoke execute on function claims.refresh_aggregate_matviews() from public;
grant  execute on function claims.refresh_aggregate_matviews() to   claims_admin;
