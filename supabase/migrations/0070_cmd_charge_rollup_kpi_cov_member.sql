-- 0070 — Restore the book-wide Qualify KPI index-only scan that Phase 2 broke.
--
-- WHY: 0068 built cmd_charge_rollup_entity_payment_cov as a covering index so the book-wide KPI
-- aggregate (src/collections/qualifyQuery.ts buildBookKpisQuery) ran as an INDEX-ONLY scan
-- (Heap Fetches: 0). Phase 2 (commit e8a837b/9f9ea43) then added `count(distinct member_id_bidx)`
-- to that SAME query. member_id_bidx is neither a key nor in 0068's INCLUDE payload, so the planner
-- can no longer satisfy the query from the index and falls back to a plain Index Scan on
-- cmd_charge_rollup_entity_payment + a full heap read of the whole window.
--
-- MEASURED (live, 2026-07-27, entity=[BXR,Indigo], trailing-30 window ~14.6k rows):
--   • with the distinct count (today):  plain Index Scan, no index-only, 10,837 shared buffers, ~52 ms
--   • same query minus the distinct:    Index Only Scan on _cov, Heap Fetches: 0, 122 buffers, ~16.5 ms
-- The gap widens ~linearly with window size; at the 12-month window the app's Range control permits
-- (~10x rows) this is the ~8.3 s -> ~40 ms class of regression 0068 was built to prevent. The book-wide
-- KPI runs on EVERY /qualify mount, so this fix helps users on every load.
--
-- FIX: rebuild the covering index with member_id_bidx appended to the INCLUDE payload, so the Phase-2
-- distinct query is index-only again. member_id_bidx is a keyed-HMAC blind index (text, avg 65 B) — it
-- is COUNTED, never projected to any caller; it lives in the INCLUDE payload purely so the count(distinct)
-- can be answered from the index. This is NON-PHI at rest exactly as the base-table blind-index columns are.
--
-- SIZE COST (measured/estimated): the live _cov is 29 MB over ~486k rows (~63 B/entry). Appending a
-- ~65 B text token roughly doubles per-entry width -> the amended index is estimated ~60 MB (delta ~+31 MB;
-- total matview footprint 222 MB -> ~253 MB). Reviewed and accepted for a per-mount, per-load query.
--
-- patient_balance_due is deliberately NOT added: it would only make the search-summary count(*) totals
-- index-only, and that query never runs book-wide (the compose bar always scopes it to a payer/facility,
-- ~<=5 ms), so it is not on any hot path. See docs/veris-data-notes.md ("0070 index fix").
--
-- ── APPLY DISCIPLINE (READ BEFORE RUNNING) ─────────────────────────────────────────────────────────
-- CREATE/DROP INDEX CONCURRENTLY and VACUUM CANNOT run inside a transaction block. This file therefore
-- contains NO `begin`/`commit` and NO `do $$ … $$` wrapper, and MUST be applied statement-by-statement
-- OUTSIDE a transaction (e.g. psql running this file directly — NOT via a tool that wraps the file in a
-- single transaction). Contrast REFRESH MATERIALIZED VIEW CONCURRENTLY, which *can* run in a transaction;
-- these three statements cannot. Alec applies this; it is not auto-applied.
--
-- NO COVERAGE GAP: the amended index is built under a NEW name alongside the live one, and the old one is
-- dropped only after the new one exists — the planner prefers the new (structurally-covering) index the
-- instant it is valid, so book-wide KPI reads never lose the covering index mid-apply.
--
-- RE-RUNNABLE: every statement is IF [NOT] EXISTS, so a clean re-run is a no-op. CAVEAT: if a CONCURRENTLY
-- build was interrupted, it can leave an INVALID index that IF NOT EXISTS will NOT repair. Before re-running,
-- check and clear any invalid leftover:
--     select indexrelid::regclass as idx, indisvalid from pg_index
--       where indrelid = 'collections.cmd_explorer_charge_rollup'::regclass and not indisvalid;
--     -- for any row: drop index concurrently if exists collections.<that index>;
--
-- POST-APPLY VERIFICATION (expect Index Only Scan on _cov_m + Heap Fetches: 0):
--     explain (analyze, buffers)
--     select case when sum(charge_amount) > 0 then round((sum(allowed_reliable) filter (where allowed_tier <> 'e2')) / sum(charge_amount) * 100, 2)::float8 end,
--            count(distinct member_id_bidx)::int
--       from collections.cmd_explorer_charge_rollup
--      where business_entity_id = any(array['af504ab6-3dcd-4aa4-a93c-27bc58de4088','141d459c-f371-4229-9a92-ace198e940bb']::uuid[])
--        and payment_received >= (current_date - 29) and payment_received < (current_date + 1);
--
-- NOTE FOR 0067: the full-rebuild/​swap migration (0067, still gated behind the name backfill) MUST carry
-- THIS amended covering definition (cmd_charge_rollup_entity_payment_cov_m), not 0068's original _cov, and
-- its pre-swap raise-on-loss gate enumerates indexes from the LIVE object, so 0070 must be applied before
-- 0067. 0068's original _cov is SUPERSEDED by _cov_m and is dropped below.

-- 1) Build the amended covering index alongside the live one (no lock on reads, no coverage gap).
create index concurrently if not exists cmd_charge_rollup_entity_payment_cov_m
  on collections.cmd_explorer_charge_rollup (business_entity_id, payment_received)
  include (charge_amount, allowed_reliable, allowed_tier, insurance_payments, member_id_bidx);

-- 2) Drop 0068's original covering index (superseded). The planner already prefers _cov_m, so this
--    removes only the now-redundant copy — no window without a covering index.
drop index concurrently if exists collections.cmd_charge_rollup_entity_payment_cov;

-- 3) Re-establish the all-visible visibility map so the index-only scan actually elides heap fetches
--    (Heap Fetches: 0). The hourly refresh job already VACUUMs post-REFRESH (0069 MAINTAIN grant); this
--    is the one-time bootstrap for the freshly-built index.
vacuum (analyze) collections.cmd_explorer_charge_rollup;
