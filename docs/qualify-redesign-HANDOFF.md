# Qualify redesign — handoff (branch `feat/qualify-redesign`)

Autonomous build session, 2026-07-24. Everything below is committed + pushed to
`feat/qualify-redesign` and is **green**: root `npm test` 647, app `npm test` 114, root + app
`tsc` clean, `next build` clean. Adversarial 5-lens review run; all 8 confirmed findings fixed.

## What shipped (per the approved comp `docs/mockups/qualify-redesign-mockup.html`)

- **Phase 0** — shared design tokens (`app/components/qualify/tokens.ts`), 3-tier elevation
  (`shadow-ths-sm/ths/ths-lg`), sparkline draw-in + KPI/subject gradients (`globals.css`), motion docs.
- **Overview server layer** (no migration) — `buildBookKpisQuery` (book-wide %-allowed / %-paid-of-allowed
  / %-paid-of-billed, in-plane, percentages-only), `buildFacilityTrendQuery` (per-facility rating trend +
  Δpts + 8-bucket sparkline + dominant payer), `getQualifyOverviewCore` (the on-load HYBRID), facility
  `entity` label (BXR/Indigo/Mixed).
- **Month/Year windows** — `QualifyWindow` union (trailing 30/60/90 **+ calendar month/year**; 180 dropped);
  calendar Δ = previous equivalent period; serialize/parse for the URL param (fail-closed).
- **Desktop + mobile shells** — tabbed autosearch finder (no resolve button), window control, Facilities
  Heating Up sparkline cards, KPI tiles, subject hero, Changes A (defined "n"), B (global persistent reveal
  for super_admin/admin, audited per scope), D (one LOC lens), E (facility drilldown + pin + "× All
  facilities"), F (allowlist-enforced shareable URL state), G (mobile Payer › Facility › Claim breadcrumb).
- **Ratings vocabulary** — `Strong / Watch / Weak` (was Typical); "thin sample" copy; cutoffs unchanged (50/30).

## ⚠️ Deferred / gated (needs a human — do these to finish Change C)

**Client Name search is BUILT but GATED OFF** (`QUALIFY_CLIENT_NAME_ENABLED = false` in
`app/lib/qualify/contract.ts`). The tab is hidden so nothing reads a column that isn't live yet. To enable:

1. **Run the historical name backfill AS THE TABLE OWNER.** Migration `0066` (adds `patient_name_bidx`
   to `collections.cmd_explorer_rows` + index + a column grant) is **already applied to prod** and is inert
   (nothing reads it yet). But `claims_reader` **cannot** write it — verified 2026-07-24: the table owner is
   `postgres` (BYPASSRLS; `force_rls=false`), there is **no** `claims_reader` UPDATE *policy* in prod (0037's
   policy was never applied here — the member/group bidx backfill ran as the owner). So:
   ```
   # point the backfill at a POSTGRES (owner) connection, then:
   BLIND_INDEX_DB_URL=<postgres owner url> LIBSODIUM_KEY=… INDEX_HMAC_KEY=… \
     npx tsx src/collections/cmdNameBidxBackfill.ts            # dry run
   BLIND_INDEX_DB_URL=<postgres owner url> … \
     npx tsx src/collections/cmdNameBidxBackfill.ts --commit   # ~636,954 rows
   ```
   (Alternative, reviewed but not prod's posture: apply 0037's reader UPDATE policy, then run as
   `claims_reader`. The autonomous session did NOT do this — a Supabase DDL guardrail declined the live
   policy change, correctly leaving it for you.)
2. **Apply migration `0067`** (`supabase/migrations/0067_cmd_charge_rollup_patient_name_bidx.sql`) — a
   DROP+CREATE matview rebuild carrying `patient_name_bidx` (~60–95s **outage** of `/qualify` + collections
   aggregates). **Apply OFF the cron ticks** (avoid :00/:15/:30/:35/:45 UTC), crons idle. Idempotent
   (advisory lock + no-op check). Verified rollback file included. Do this AFTER the backfill so the
   `CREATE ... WITH DATA` captures all tokens in one pass.
3. **Verify** the :45 refresh cron logs success on its next run (the 0059 lesson: DROP destroys the ACL —
   0067 re-asserts the `claims_reader` + `cmd_rollup_writer` SELECT grants, so it should be clean).
4. **Flip `QUALIFY_CLIENT_NAME_ENABLED = true`**, redeploy. The tab appears; a name resolves its dominant
   payer (exact normalized-name blind index), captioned "may match multiple patients"; audited via
   `SEARCH_QUALIFY_NAME` (field name only — the raw name is never logged/URL'd).

## Other notes

- **Perf to watch:** `buildFacilityTrendQuery` (book-wide variant) runs live on the rollup for the first
  time on `/qualify` load. It's a bounded grouped scan over the in-window slice (indexed on
  `business_entity_id, payment_received`) and degrades gracefully (a failure/slowness → empty Heating-Up
  cards, never a broken page), but eyeball the overview strip's latency on first prod load.
- **KPI tile-3 definition:** the mockup's "% collected of billed" and "% paid by payer" can't both be
  distinct from the rollup's columns (patient payments ≈ $0), so the tiles ship as **% allowed of billed /
  % paid of allowed / % paid of billed** — three distinct, RCM-meaningful ratios. Rename if you prefer.
- **Facility "payer board" tab** (old Data Flag #3 inverse view) — de-scoped per ruling; not shipped.
