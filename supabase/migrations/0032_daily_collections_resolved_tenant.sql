-- 0032: expose + tenant-partition collections.daily_collections_resolved (READ-PATH tenancy).
--
-- ══════════════════════════════════════════════════════════════════════════════════════
-- READ-PATH companion to the A→B→C collections-tenancy sequence (0030 = A columns, 0031 =
-- tenant-leading keys). This is NOT the writer-enforcement flip (migration C). It teaches the
-- resolved-view READERS to be tenant-scopable: the aggregate collections readers
-- (collectionsMonthlySummary / collectionsDaily / collectionsKpis in src/collections/*.ts) all
-- read this view, which until now projected NO business_entity_id — so the app could not
-- WHERE-scope them by tenant (review finding #1, the Indigo READ-gate). This migration:
--   1. APPENDS business_entity_id as the trailing view column (both UNION-ALL branches), and
--   2. folds business_entity_id INTO the dedup partition so per-tenant rows never collide.
-- The app-layer WHERE scoping (Artifact B) lands AFTER this and depends on the new column.
--
-- APPEND-ONLY / CREATE OR REPLACE VIEW SAFETY: Postgres CREATE OR REPLACE VIEW may only ADD new
-- columns to the END of the select list — it rejects any rename/reorder/retype/drop of an
-- existing column. This migration ONLY appends business_entity_id after gross_amount and leaves
-- facility_code, payment_date, checks_amount, eft_amount, gross_amount byte-identical in name,
-- type, and position, so CREATE OR REPLACE VIEW is legal (no DROP+CREATE needed). The dedup
-- partition-by change lives INSIDE the window function (query body), not the output column list,
-- so it does not affect the view interface. Verified against the live 0015 column order.
--
-- NO CONSUMER BREAKS: the only readers are src/collections/summary.ts + daily.ts, both with
-- EXPLICIT column lists (never SELECT *) and a `select max(payment_date)` anchor CTE — an
-- appended trailing column is invisible to all of them. No dependent view/matview exists (grep:
-- daily_collections_resolved has no SQL dependents beyond 0014/0015/0022). The 3 SQL-assert
-- fixtures pin the BUILDER strings, not the view shape; they change with Artifact B.
--
-- DEDUP PARTITION FOLD: the deduped (facility_code IS NOT NULL) branch changes its window
-- partition from (facility_code, payment_date) to (business_entity_id, facility_code,
-- payment_date). The ORDER BY (gross desc, deposit_sheet tiebreak, id) is UNCHANGED. The
-- NULL-facility branch is NOT deduped (it keeps every row, as before) and simply projects
-- business_entity_id straight from the base row — each such lineage row already carries its own
-- tenant, so a downstream tenant WHERE filters it correctly.
--
-- ALL-BXR NO-OP PROOF (informational NOTICE, not a hard gate): today every daily_collections row
-- is BXR (single business_entity_id), so partitioning by (beid, facility, date) yields groups
-- IDENTICAL to (facility, date) — the resolved row set is byte-for-byte unchanged by this
-- migration; only the new trailing column appears. The guard below RAISES NOTICE with the beid
-- distribution to RECORD that at apply time. It intentionally does NOT raise an exception: unlike
-- 0030 (which backfilled DATA and had to prove the stamp), this is a pure view redefinition that
-- is CORRECT for any tenant composition and MUST stay re-appliable after Indigo lands (at which
-- point a non-BXR count here is expected and the partition fold becomes load-bearing). Apply path
-- = postgres/BYPASSRLS, so the count is definitive.
--
-- OWNERSHIP: daily_collections_resolved is postgres-owned (0014/0015 created it with plain CREATE
-- OR REPLACE VIEW under the apply role — no SET ROLE), so this plain CREATE OR REPLACE VIEW runs
-- as the apply role with no role switch (contrast 0030's claims_admin-owned cpfm). Verify once at
-- apply: select viewowner from pg_views where viewname='daily_collections_resolved'.
--
-- Idempotent: CREATE OR REPLACE VIEW is idempotent by construction; REVOKE/GRANT reapplied
-- unconditionally. Guarded rollback:
-- supabase/rollbacks/0032_daily_collections_resolved_tenant_rollback.sql (refuses to revert to
-- the tenant-blind partition once any non-BXR row exists — that would silently commingle/dedup
-- across tenants).
--
-- Depends on: 0015 (the max-gross resolved view), 0030 (business_entity_id on daily_collections).
-- ══════════════════════════════════════════════════════════════════════════════════════

-- 1. All-BXR no-op proof (informational NOTICE; never blocks — see header) -----------------
do $$
declare
  n_total   integer;
  n_foreign integer;
begin
  select count(*),
         count(*) filter (where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
    into n_total, n_foreign
  from collections.daily_collections;

  if n_foreign = 0 then
    raise notice '0032: all-BXR confirmed (% row(s), 0 non-BXR) — partition fold is a proven no-op on current data', n_total;
  else
    raise notice '0032: % non-BXR row(s) of % present — partition fold is now LOAD-BEARING (expected post-Indigo); view redefinition remains correct', n_foreign, n_total;
  end if;
end $$;

-- 2. Redefine the view: append business_entity_id (trailing) + fold it into the dedup partition.
create or replace view collections.daily_collections_resolved
  with (security_invoker = true) as
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount, business_entity_id
  from (
    select
      facility_code, payment_date, checks_amount, eft_amount, gross_amount, business_entity_id,
      row_number() over (
        partition by business_entity_id, facility_code, payment_date        -- tenant-scoped dedup
        order by
          gross_amount desc,                                          -- most-complete record wins
          case when source_tag = 'deposit_sheet' then 0 else 1 end,   -- equal -> prefer the live Sheet
          id                                                          -- deterministic tiebreak
      ) as rn
    from collections.daily_collections
    where facility_code is not null
  ) ranked
  where rn = 1
  union all
  -- NULL-facility (group-code-only lineage) rows are not deduped: keep all; tenant carried through.
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount, business_entity_id
  from collections.daily_collections
  where facility_code is null;

-- 3. Reapply least-privilege grants (idempotent; identical to 0014/0015) -------------------
revoke all on collections.daily_collections_resolved from public, anon, authenticated, service_role;
grant select on collections.daily_collections_resolved to claims_reader;
grant select on collections.daily_collections_resolved to claims_admin;

-- 4. Verification (run manually after apply) ----------------------------------------------
-- -- 4a. Column list ends with the appended tenant column, existing columns unmoved:
-- select string_agg(attname, ', ' order by attnum) from pg_attribute
--   where attrelid = 'collections.daily_collections_resolved'::regclass
--     and attnum > 0 and not attisdropped;
--   → facility_code, payment_date, checks_amount, eft_amount, gross_amount, business_entity_id
-- -- 4b. Row set UNCHANGED (all-BXR today): resolved count matches the pre-0032 count.
-- select count(*) from collections.daily_collections_resolved;
-- select business_entity_id, count(*) from collections.daily_collections_resolved group by 1;
--   → one group: af504ab6-3dcd-4aa4-a93c-27bc58de4088 (BXR) = full resolved count.
-- -- 4c. Ownership = apply role (no SET ROLE was needed):
-- select viewowner from pg_views where schemaname='collections' and viewname='daily_collections_resolved';
--   → postgres.
