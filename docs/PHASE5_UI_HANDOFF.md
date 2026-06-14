# Session Handoff — Phase 5: the search UI (on `/api/agent` + `/api/results`)

> Read `docs/CLAUDE.md` in full first, then this handoff in full, BEFORE writing
> any code. Standing rules apply: PHI never in logs / LLM prompts / `summary_stats`;
> parameterized queries only; secrets from `.env`
> (`export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)`); `node:test` only,
> no new test-runner deps; all DB access as `claims_reader` on the query/agent
> path; verify-full TLS stays on. **Never add a `Co-Authored-By` trailer to
> commits.** Show results and hold before live/outward-facing actions (deploys,
> commits, anything that leaves the machine).

## ⛔ USER-SIDE GATING ITEMS (resolve/confirm at the TOP, before building)

1. **Browser auth model — HARD DESIGN BLOCKER, decide before any client code.**
   Both routes today gate on `Authorization: Bearer <RESULTS_API_SECRET>` — a
   single shared server secret. That secret **must never reach the browser.**
   `/api/results` returns raw PHI, so a real user-facing UI cannot just hold the
   bearer token in client JS. Pick one before building:
   - **(a) Server-only data access (recommended).** The page stays a React Server
     Component / server action (or a thin BFF route) that calls `handleAgent` /
     `handleResults` **server-side**; the browser talks to *your* page, never
     directly to `/api/agent` or `/api/results` with the secret. The existing
     `lib/server.ts` composition root already runs server-side — reuse it directly
     instead of going back out over HTTP.
   - **(b) Real session auth in front of the routes.** Add user login (e.g.
     Supabase Auth / NextAuth) and a per-session check in the route handlers,
     keeping `RESULTS_API_SECRET` as a server-to-server fallback only. Larger lift.
   Do NOT embed `RESULTS_API_SECRET` in `NEXT_PUBLIC_*`, client fetch calls, or
   any bundle. Confirm (a) vs (b) with the user first — it shapes every component.

2. **Who may view PHI (the results panel).** `/api/results` returns patient
   identifiers for `search_claims`, `client_history`, and `readmission_candidates`
   (see column allowlists below). Confirm: is this UI for an authorized internal
   billing audience only? Should PHI columns be masked/behind-a-click by default?
   Is there an access-logging expectation beyond the existing audit line
   (`{ timestamp, query_id, function_name, row_count, created_by }`)? Get the
   `created_by` value the UI should pass (via the `x-created-by` header) so the
   audit trail names the real principal, not the `agent-api`/`results-api` default.

3. **`client_history` identity re-supply UX.** `client_history` summary comes back
   from `/api/agent` with **no rows fetchable** unless the UI re-supplies the
   patient identity (`{ identity: { patient_last, member_id_norm? } }`) to
   `/api/results`. The agent never echoes identity back. Decide how the UI
   collects/holds those terms for the results fetch (a form the user re-enters,
   or carry-forward from what they typed) — and remember those terms are **PHI**:
   POST body only, never a query string, never logged, never localStorage.

4. **Design system / scope.** shadcn/ui is already initialized (`app/components.json`,
   slate base, CSS vars) but **no components are installed yet** and Tailwind is
   wired. Confirm: how polished should this be (functional internal tool vs.
   designed product)? Any existing brand/design reference to match? This decides
   how much component scaffolding to pull in.

## ⏸ STOP AT AN OPTIMAL CONTEXT WINDOW  (carry this block forward VERBATIM)

When the working context grows large, or you reach a natural completion boundary
(a gate passed, tests green, a commit landed), STOP and write a fresh handoff
rather than pushing new scope into a saturated context. Before stopping:
  1. Ensure the working tree is committed, or the pending diff is clearly described.
  2. Run the verification commands and record the actual results
     (`X/Y` tests, `tsc` state, any live probe output).
  3. Surface any USER-SIDE GATING ITEMS at the TOP of the new handoff.
  4. Re-paste THIS block verbatim into the new handoff (the self-replicating rule).
A handoff written early at a clean boundary beats one written late under a full
context. Prefer gates: show results and hold before irreversible or outward-facing
actions (live migrations, commits, anything that leaves the machine).

## Verified current state (all committed on `main`, deployed to Vercel)

- **Phases 1–3:** COMPLETE (ingest 320,116 claims; schema/RLS + least-privilege
  roles; five vetted query functions; PHI results route with column allowlists +
  identity verification; verify-full TLS).
- **Phase 4 (agent + transport):** COMPLETE. `src/agent/` maps NL → one query
  function via Anthropic tool-calling; Next.js 15 App Router app under `app/` with
  `POST /api/agent` (non-PHI) + `POST /api/results` (PHI); shared Bearer auth.
- **Phase 4 Step 3 (live integration):** COMPLETE and **deployed to production**.
  - Commit `c394e6b` — `fix(ssl): make CA_PATH lazy; add SUPABASE_CA_PEM env var`.
  - Vercel project `cmd-billing-dashboard` (team `bloomhouse-marketings-projects`),
    app root linked at `app/`, install command bundles repo root (`app/vercel.json`).
  - Env vars set on Vercel (production+preview+development): `ANTHROPIC_API_KEY`,
    `CLAIMS_READER_DATABASE_URL`, `RESULTS_API_SECRET`, `SUPABASE_CA_PEM`.
    `SUPABASE_CA_PEM` is the public Supabase Root CA (not a secret) — `src/ssl.ts`
    reads it first, falling back to the committed `certs/supabase-ca.crt` locally.
  - **Live smoke test passed** at https://cmd-billing-dashboard.vercel.app :
    `/api/agent` (distribution Q) → 200, correct tool, PHI-free summary;
    `/api/results` (that query_id) → 200, 163,847 rows, allowlisted columns only;
    TLS verify-full proven (wrong CA → `self-signed certificate in certificate chain`).
  - `RESULTS_API_SECRET` was newly generated this session and added to local `.env`.
- **Suite: 82 pass, 0 fail. `tsc --noEmit` clean.** Last verified 2026-06-13.

Run tests: `npm test` · Typecheck: `npm run typecheck` (root) · App typecheck:
`cd app && npm run typecheck` · App dev: `cd app && npm install && npm run dev`
(needs the env vars above + the CA; reads root `.env`).

## The two API contracts the UI builds on

Both are `POST` only (any other verb → 405 with `Allow: POST`). Both require
`Authorization: Bearer <RESULTS_API_SECRET>` **today** (see gate 1 — the browser
must not hold this). Optional `x-created-by` header sets the audit principal.

### `POST /api/agent`  (non-PHI)
- Request body: `{ "question": string }` (non-empty). Empty/missing → 400.
- 200 response: `{ tool_name, query_id, summary_stats }`.
  - `tool_name`: one of `distribution | payer_gap_analysis | search_claims |
    client_history | readmission_candidates`.
  - `query_id`: opaque UUID handle to pass to `/api/results`.
  - `summary_stats`: **PHI-free by type** — shape depends on `tool_name`:
    - `distribution`: `{ field, metric, buckets: [{ value, metric_value, pct_of_total }] }`
    - `payer_gap_analysis`: `{ rows_analyzed, by_payer: [...] }`
    - `search_claims`: `{ rows_matched, total_charge, total_allowed, total_paid,
      avg_collection_rate, rate_anomaly_count, date_from, date_to,
      distinct_facilities, distinct_payers }`
    - `client_history`: `{ rows_matched, match_threshold, by_source_year:
      [{ source_year, claim_count, distinct_facilities, distinct_payers,
      total_charge, total_paid, avg_collection_rate, date_from, date_to }] }`
    - `readmission_candidates`: `{ candidate_pairs, by_confidence, facilities[], payers[] }`
- Errors: 401 unauthorized, 400 bad_request, 500 `agent_failed` (generic — never
  echoes the underlying error, which could name a tool/column).

### `POST /api/results`  (PHI — this is the row fetch)
- Request body: `{ "query_id": string, "identity"?: { "patient_last": string,
  "member_id_norm"?: string }, "created_by"? }`. `identity` is **required for
  `client_history`** (re-verified server-side before any row is served) and
  ignored for the other four.
- 200 response: `{ rows: PhiRow[], function_name, query_id }`.
  - `function_name` is `null` when the handle is missing/expired → `rows: []`
    (fail-closed). For `client_history`, a wrong/absent identity also → `rows: []`.
  - `PhiRow` columns are the per-function allowlist (NEVER `SELECT *`):
    - `distribution` / `payer_gap_analysis` (no patient identity): `id,
      facility_name, payer_name, source_year, date_of_service, hcpcs_code,
      revenue_code, charge_amount, allowed_amount, paid_amount, adjustment,
      balance_due_pt, collection_rate`
    - `search_claims` (**PHI**): the above **plus** `patient_name, patient_last,
      patient_first, member_id_raw, member_id_norm`
    - `client_history` (**PHI**): adds `patient_name, patient_last, patient_first,
      member_id_raw, member_id_norm, group_number, employer_name` (+ facility/
      payer/date/amount columns)
    - `readmission_candidates` (**PHI, paired rows**): allowlist columns appear
      **twice** prefixed `a_`/`b_` (the two sides of a candidate pair), plus
      computed fields `confidence`, `gap_days`, `a_id`, `b_id` (these four are NOT
      bare allowlist columns — don't expect an unprefixed `id`).
- Errors: 401, 400 bad_request (missing query_id), 405 non-POST, 500 `results_failed`.

## Task: Phase 5 — the search UI

Build the natural-language claims search experience on top of the two routes.
Suggested shape (confirm with the user after gate 1/4 are settled):

1. **Search input** → calls the agent path (server-side per gate 1) with the
   question. Show which tool was chosen and render the appropriate non-PHI
   `summary_stats` view (a chart/table per `tool_name` — the five shapes differ).
2. **"Show underlying rows"** → calls the results path with the `query_id` to
   fetch PHI rows, rendered in a table using the function's allowlisted columns.
   Gate PHI display per gate 2. For `readmission_candidates`, render paired
   `a_`/`b_` rows with `confidence`/`gap_days`.
3. **`client_history` flow** → collect the patient identity terms (gate 3) and
   send them in the results POST body; handle the fail-closed empty result with a
   clear "no match / identity not verified" state (don't imply the patient doesn't
   exist — it may be a non-match on the supplied terms).
4. **Loading / error / empty states** for both calls; a 500 shows a generic
   message (the API intentionally never returns detail).

## Where things live (for the UI work)

- `app/app/page.tsx` — current placeholder landing page (replace/extend).
- `app/app/layout.tsx` — root layout + metadata.
- `app/app/api/agent/route.ts`, `app/app/api/results/route.ts` — thin HTTP adapters
  (`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`). They call →
- `app/lib/server.ts` — **composition root**: builds the claims_reader executor,
  the Anthropic client, reads `RESULTS_API_SECRET`. Reuse `handleAgent` /
  `handleResults` here directly for server-side data access (gate 1 option a).
- `src/routes/agentHandler.ts`, `src/routes/resultsHandler.ts` — transport-agnostic
  handlers (auth + validation + the PHI boundary). The response/request types above
  are exported from here and `src/routes/results.ts`.
- `app/components.json` — shadcn/ui config (slate, CSS vars, `@/components`,
  `@/lib/utils`). `cd app && npx shadcn@latest add <component>` to install.
- `app/lib/utils.ts` — `cn()` helper. `app/tailwind.config.ts`, `app/app/globals.css`.

## Do not regress

- PHI never in `query_log`, logs, `summary_stats`, any LLM prompt/transcript, any
  URL/query string, or browser storage. The agent path is non-PHI by construction.
- **`RESULTS_API_SECRET` is a server secret** — never shipped to the browser
  (no `NEXT_PUBLIC_`, no client fetch with the token). See gate 1.
- Parameterized queries only; the results route projects only allowlisted columns.
- All DB access as `claims_reader` (never service role). Verify-full TLS stays on
  (`src/ssl.ts`); don't reintroduce `rejectUnauthorized: false`.
- The agent sees only `summary_stats` + `query_id`; the UI fetches PHI via the
  results route. Keep the two-shape split intact.
- `client_history` rows require re-supplied identity, verified server-side;
  preserve the fail-closed-to-empty behavior.
- Run `npm test` (expect 82 pass) and both typechecks before any commit; show
  results and hold before live deploys / commits / outward-facing actions.
- Keep `npm test` hermetic — no live LLM/DB in the suite. `src/liveProbe.ts` is the
  separate, manually-run live probe (not imported by tests).
