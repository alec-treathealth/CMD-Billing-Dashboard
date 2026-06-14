# Session Handoff — Phase 5.2: dashboard + quick questions (and what's next)

> Read `docs/CLAUDE.md` in full first, then this handoff, BEFORE writing any code.
> Standing rules apply: PHI never in logs / LLM prompts / `summary_stats` / URLs /
> browser storage; parameterized queries only; secrets from `.env`
> (`export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)`); `node:test` only,
> no new test-runner deps; all DB access as `claims_reader`; verify-full TLS stays
> on. **Never add a `Co-Authored-By` trailer.** Show results and HOLD before
> live/outward-facing actions (commits, pushes, deploys). The browser must use
> **Server Actions only** — never ship `RESULTS_API_SECRET` to the client.

## ⛔ OPEN GATING ITEMS (resolve/confirm at the TOP, before building)

1. **Readmission performance — query-layer blocker, do NOT expose in UI until fixed.**
   `readmission_candidates` routes correctly from natural language, but the
   full-population self-join **times out (>90s → 500)**, and is still >90s even when
   date-scoped to a single quarter with a 30-day gap. The "Readmission candidates"
   quick-question button was therefore **intentionally omitted** (see the NOTE in
   `app/components/quick-questions.tsx`). A real fix is query-layer work and is
   **stop-and-explain gated** (CLAUDE.md: don't add/alter SQL tools without asking):
   candidate approaches — (a) an index supporting the pair self-join
   (`READMISSION_PAIR_JOIN` in `src/queries/readmission_candidates.ts`), (b) make a
   facility (or tight date window) **mandatory** so the scan is bounded, and/or
   (c) a `statement_timeout` + a friendly "narrow your search" UI error. Decide the
   approach with the user before touching the query layer; only then wire the button.

2. **Vercel Deployment Protection scope — the ONLY access gate in front of PHI.**
   There is no app-level login; `app/app/page.tsx` renders the PHI search console to
   anyone who can reach the URL. Confirm **Settings → Deployment Protection** is On and
   **scoped to Production** (Standard Protection defaults to preview-only — production
   must be explicitly included). Sanity check: load the production alias in an
   incognito window with no Vercel session — it should bounce to a Vercel auth page,
   not the console. Until confirmed, treat the URL as unprotected; don't share it.

3. **`SUPABASE_CA_PEM` is set on Vercel PRODUCTION only.** Preview/Development
   deployments (and local dev) lack it, so they hit a bug in `src/ssl.ts`: in the
   webpacked bundle `new URL('../certs/supabase-ca.crt', import.meta.url)` resolves
   to a `/_next/static/media/...crt` path and `fileURLToPath` throws `ERR_INVALID_URL`
   → every `/api/*` and dashboard/server-action DB call 500s. Workarounds: set
   `SUPABASE_CA_PEM` on Preview/Dev too, OR (cleaner, optional) fix `src/ssl.ts`'s
   file-fallback for the bundled case. **Local dev MUST export it first:**
   `export SUPABASE_CA_PEM="$(cat certs/supabase-ca.crt)"` (it's a public root CA, not
   a secret) before `cd app && npm run dev`.

4. **Manual browser pass still required before trusting UI behaviors.** This agent
   environment has **no browser driver** — DOM/Network/click/refresh checks can't be
   automated here. A human must verify at the running app: dashboard widgets render;
   quick buttons populate/auto-run; PHI masked by default + per-row reveal + refresh
   clears reveal; DevTools Network shows ONLY Next Server Action POSTs to `/`
   (no `/api/agent`/`/api/results`, no secret anywhere).

5. **Unrelated dangling edit.** `docs/PHASE5_UI_HANDOFF.md` has an uncommitted −14-line
   change (removes a "STOP AT OPTIMAL CONTEXT WINDOW" block) that predates this work and
   was deliberately left out of every commit. Decide whether to keep/commit/discard it.

## Verified current state (committed + pushed on `main`)

- **Phase 5 (search UI):** commit `a09d6e8` — protected claims search console, server-only
  BFF (Server Actions), PHI masked/per-row reveal, client_history identity re-entry.
  Deployed to production via Git auto-deploy.
- **Phase 5.2 (this session):** commit `037f43c` — quick-question buttons + default non-PHI
  dashboard. Pushed `a09d6e8..037f43c` to `origin/main` (Git auto-deploy to production
  expected; confirm the deployment went READY and that gate 2 protection holds).
- **Tests/types/build:** `npm test` → **82 pass / 0 fail**; root `tsc --noEmit` clean;
  `cd app && npm run typecheck` clean; `cd app && npm run build` succeeds.
- **Live routing smoke (counts only, no PHI), 2026-06-14:** Payer claim volume →
  `distribution` (327 buckets); Payer collection gaps & Charges/allowed/paid →
  `payer_gap_analysis` (320,116 analyzed); High unpaid 2025 → `search_claims` (163,847);
  Patient history "Smith" → `client_history` (1,988); dashboard distribution fields
  (year=3, hcpcs=52, revenue=13) all returned in 1.5–2.3s. Readmission → times out (gate 1).
- **Security checks:** client bundle free of `RESULTS_API_SECRET` (value + literal) and of
  `/api/agent`/`/api/results` references (outside the routes' own chunks); no client
  `fetch()` to those routes — browser uses Server Actions only.

Run tests: `npm test` · Root typecheck: `npm run typecheck` · App typecheck/build:
`cd app && npm run typecheck && npm run build` · App dev: export `SUPABASE_CA_PEM`
(gate 3) then `cd app && npm install && npm run dev` (reads root `.env`).

## What Phase 5.2 added (where things live)

- **`app/components/quick-questions.tsx`** — 5 buttons grouped by audience
  (Admissions / Billing / Owner-operator). Each item is `{ label, question, autoRun }`.
  Auto-run buttons call the agent immediately; the **Patient claim history** button is
  **populate-only** (`autoRun: false`) — it fills the prompt with
  `"show the claim history for the patient whose last name is "` and focuses the input so
  the user types the last name (client_history needs a real name; rows still go through
  the identity re-entry flow). Readmission button omitted (gate 1).
- **`app/components/search-console.tsx`** — refactored to a reusable `runQuestion(q)`;
  the form and quick buttons both call it. Holds an `inputRef` for the populate-only flow.
- **`app/components/dashboard.tsx`** — default dashboard, **non-PHI aggregate-only**, auto-
  loads on mount. Widgets: Payer overview (total claims + per-payer volume/charged/allowed/
  paid/avg-rate/collection-gap), Claims by year, Top HCPCS codes, Top revenue codes. Each
  widget owns its loading/error state via the `useWidget` hook; a failure shows a generic
  "Unable to load this metric" and does NOT break the rest of the page. The dashboard NEVER
  calls `fetchRows` — no PHI is reachable on this path.
- **`app/lib/server.ts`** — added `dashboardPayerGap()` and `dashboardDistribution(field,
  metric)`: they call the vetted query functions DIRECTLY (no LLM, deterministic) on the
  `claims_reader` executor with `createdBy: 'phase5-dashboard'`, and return ONLY
  `summary_stats` (the `query_id` is dropped — non-PHI by construction).
- **`app/lib/actions.ts`** — `'use server'` dashboard actions: `loadPayerGap`,
  `loadClaimsByYear`, `loadTopHcpcs`, `loadTopRevenue`. **Arg-free** (hardcoded queries →
  zero client-injection surface); each returns `DashboardResult<T> = { ok:true; data } |
  { ok:false }` (failure collapses generically). Existing `runSearch` / `fetchRows`
  unchanged.
- **`app/app/page.tsx`** — renders `<SearchConsole />` then `<Dashboard />`; footer still
  states the Vercel-Deployment-Protection / internal-tool assumption.

## Contracts the next session builds on

- **Server Actions are the only browser data path.** `runSearch(question)` →
  `{ ok, tool_name, query_id, summary_stats }` (non-PHI). `fetchRows(query_id, identity?)`
  → `{ ok, function_name, rows }` (PHI; rows normalized to plain JSON-safe scalars in
  `toPlainRows`). Dashboard actions return non-PHI summaries only. None of these expose the
  bearer secret to the client; they delegate to `app/lib/server.ts` in-process.
- **Five agent tools** (unchanged): `distribution`, `payer_gap_analysis`, `search_claims`,
  `client_history`, `readmission_candidates`. `summary_stats` shapes are in
  `src/queries/types.ts`; results column allowlists in `src/queries/columns.ts`.

## Do not regress

- PHI never in `query_log`, logs, `summary_stats`, any LLM prompt, any URL, or browser
  storage. Dashboard + agent summary paths are non-PHI by construction; PHI only via
  `fetchRows` (allowlisted columns, masked in UI, identity re-verified for client_history).
- `RESULTS_API_SECRET` stays server-side (no `NEXT_PUBLIC_`, no client fetch). Verify after
  any change: client bundle has no secret and no `/api/*` references; browser Network shows
  only Server Action POSTs.
- Dashboard must stay aggregate-only and must NOT call `fetchRows` or render PHI columns.
- All DB access as `claims_reader`; verify-full TLS stays on (`src/ssl.ts`); never
  `rejectUnauthorized: false`.
- Keep `npm test` hermetic (no live LLM/DB). Run `npm test` + both typechecks + app build
  before any commit; show results and HOLD before push/deploy.

## Suggested next tasks (not yet built)

1. Resolve gate 1 (readmission perf) with the user, then add the Readmission button.
2. Confirm gate 2 (production Deployment Protection) before wider sharing.
3. Optional: fix `src/ssl.ts` bundled file-fallback (gate 3) or set `SUPABASE_CA_PEM` on
   Preview/Dev so preview deployments work.
4. Optional polish: charts for dashboard widgets; date-range / facility filters on the
   search; per-user auth to replace the fixed `phase5-ui` / `phase5-dashboard` audit
   principals (gate 2/3 from the Phase 5 handoff).
