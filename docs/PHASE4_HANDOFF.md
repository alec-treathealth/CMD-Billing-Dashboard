# Session Handoff — Phase 4: the Anthropic search-agent layer (NL → query function)

> Read `docs/CLAUDE.md` in full first, then this handoff in full, BEFORE writing
> any code. Standing rules apply: PHI never in logs / LLM prompts / `summary_stats`;
> parameterized queries only; secrets from `.env`
> (`export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)`); `node:test` only,
> no new test-runner deps; `DROP POLICY IF EXISTS` before `CREATE POLICY`;
> `IF NOT EXISTS` on tables/indexes; never `DROP ROLE` (CREATE-if-absent +
> unconditional REVOKE/GRANT). **Never add a `Co-Authored-By` trailer to commits.**

## ⛔ USER-SIDE GATING ITEMS (resolve/confirm at the TOP, before building)

1. **Anthropic API key** — Phase 4 introduces the LLM agent. The key must come
   from `.env` (e.g. `ANTHROPIC_API_KEY=`), never hardcoded/logged. Confirm the
   key is provisioned and add the var to `.env.example`. **This is the only hard
   blocker to starting Phase 4.**
2. **`RESULTS_API_SECRET`** — required in `.env` before the dev harness
   (`src/server.ts`) will start (it throws if missing). Not needed for the agent
   layer itself, but needed to exercise the end-to-end PHI fetch.
3. **PHI-boundary decision for the agent (design gate, needs user sign-off
   before coding):** the agent may see ONLY `summary_stats` + `query_id`; it must
   NEVER receive raw SQL or PHI rows. Confirm the tool-result shape handed back to
   the model is the non-PHI `summary_stats` only, and that the UI (not the agent)
   calls the results route with the `query_id`.
4. **Model choice** — use the latest Claude model per the `claude-api` skill /
   `docs/CLAUDE.md` env notes; do NOT hardcode an old model id from memory. Pull
   the current model id from the claude-api reference at build time.

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

## Verified current state (all committed on `main`)

- **Phase 1 ingest:** COMPLETE — 320,116 claims (2024–2026); `claims.claims` /
  `claims.claims_raw` in the `claims` schema. (`dbcheck`: claims=320116,
  claims_raw=320117.)
- **Phase 2 (schema/RLS + query function library):** COMPLETE — migrations
  `0003`/`0004`; `claims_reader` (SELECT on `claims.claims` only) + `claims_admin`;
  `claims.log_query` / `claims.get_query_log` SECURITY DEFINER. Five vetted query
  functions behind the `NoPhi<S>` type chokepoint + the `finalize()` audit gate.
- **Phase 3 (PHI results route):** COMPLETE — commits `e4ffc85` (route) and
  `e51e429` (SSL). Details below.
- **Suite: 58 pass, 0 fail. `tsc --noEmit` clean.**

Run tests: `npm test` · Typecheck: `npm run typecheck` · DB smoke: `npm run dbcheck`

### Phase 3 — what shipped (do NOT rebuild)

- **Column allowlists** (`src/queries/columns.ts` + a `COLUMNS` const on each of
  the 5 function files; `getColumns()` throws on unknown names). All start with
  `id`. distribution / payer_gap_analysis are non-identity; search_claims includes
  patient identifiers; client_history is the fullest; readmission_candidates
  projects each allowlisted column per pair side (`a_`/`b_`) with computed
  `confidence`/`gap_days`/`a_id`/`b_id` attached outside the allowlist.
- **Results route** (`src/routes/results.ts`, `fetchResults`): re-executes the
  original parameterized query from `query_log.arguments`, projecting ONLY
  allowlisted columns (never `SELECT *`), as `claims_reader`. PHI never cached —
  re-run on each fetch. Audit line is counts-only:
  `{ timestamp, query_id, function_name, row_count, created_by }`. Missing/expired
  handles fail-closed to empty.
- **client_history identity verification** (migration `0005_verify_identity.sql`,
  **APPLIED LIVE** 2026-06-11 — do not re-apply): patient terms are never stored,
  so the caller re-supplies them via `input.identity`; the route recomputes the
  hash through `src/queries/identity.ts` (the SINGLE source of truth) and verifies
  it server-side via `claims.verify_identity(uuid, text)` (SECURITY DEFINER, owner
  `claims_admin`, EXECUTE to `claims_reader`) — which compares without widening
  `get_query_log` and returns false on missing/expired/non-match. Rows served only
  on `true`; absent/wrong identity fail-closed to empty. Verified live as
  `claims_reader` (match→true, wrong→false, missing→false).
- **Dev harness** (`src/server.ts`): Express `GET /results/:query_id`, constant-
  time Bearer auth from `RESULTS_API_SECRET`. DEV ONLY — production transport is
  this Phase/Phase "frontend" (Next.js on Vercel). `express` advisories are a
  known dev-only exposure (CLAUDE.md Phase 2+ notes).
- **SSL verify-full** (`src/ssl.ts` `verifyFullSsl()`): all pg pools (db.ts admin,
  executor.ts reader, server.ts via makeReaderPool) verify the Supabase Root 2021
  CA at `secrets/supabase-ca.crt` (gitignored, valid to 2031) AND the hostname.
  Negative control confirmed (bogus CA → `SELF_SIGNED_CERT_IN_CHAIN`).

## The five query functions (all in `src/queries/`)

| Function | identity_hash | Re-executable from stored args alone? |
|----------|---------------|----------------------------------------|
| `distribution` | null | yes |
| `payer_gap_analysis` | null | yes |
| `search_claims` | null | yes |
| `client_history` | **SHA-256** | NO — needs re-supplied identity + verify |
| `readmission_candidates` | null | yes (gap_days + filter stored) |

Each returns `{ summary_stats, query_id }`; `summary_stats` is PHI-free by type
(`NoPhi<S>`). The agent maps a natural-language question to ONE of these + its
args; it sees only the returned `summary_stats` (+ `query_id`), never rows.

## Task: Phase 4 — the Anthropic tool-calling search agent

Build the layer that turns a natural-language question into a query-function call.
Outline (confirm shape with the user at a fresh gate before building):

1. **Tool definitions** — one Anthropic tool per query function, whose input
   schema mirrors that function's args type (`DistributionArgs`, `PayerGapArgs`,
   `SearchClaimsArgs`, `ClientHistoryArgs`, `ReadmissionCandidatesArgs`). The
   schemas are the closed allowlist the model picks from — it never writes SQL.
2. **Dispatch** — validate the model's tool input at the boundary (reuse the
   existing per-function validators / `validateClaimFilter`), call the function as
   `claims_reader`, return the non-PHI `summary_stats` (+ `query_id`) as the tool
   result. NEVER return rows to the model.
3. **client_history is special** — its tool input includes PHI (patient_last,
   member). That PHI may be passed to the QUERY (bound params) but must NOT be
   echoed back into the model transcript beyond what's necessary, and never logged.
   Decide with the user how the agent surfaces "found N claims, query_id=…" without
   re-stating identity. The UI (not the agent) fetches PHI via the results route.
4. **Transport** — likely the Next.js app (the "frontend" phase) is where the
   agent + results route become externally reachable. Decide whether Phase 4 is
   the agent-as-library (tested with a fake Anthropic client, like the query
   fixtures) first, then the Next.js wiring second.

Open design questions for the user:
- Agent-as-library with a faked model client (testable, no live API in tests)
  first — yes? (Mirrors the query-fixture pattern: no live DB/LLM in `npm test`.)
- Multi-tool / multi-turn loop vs single tool call per question?
- How `summary_stats` is rendered back to the user, and where the `query_id` →
  results-route fetch is triggered (UI action, authenticated).

## Do not regress

- PHI never in `query_log`, logs, `summary_stats`, or any LLM prompt/transcript.
- `identity.ts` is the single source of truth for the hash — reuse, never copy.
- Parameterized queries only; column names are fixed literals, values are `$n`.
- Supavisor transaction pooler: `pool.query(sql, params)`, no named prepared stmts.
- All DB access as `claims_reader` on the query/agent path (never service role).
- Verify-full TLS stays on (`src/ssl.ts`); don't reintroduce `rejectUnauthorized:false`.
- Run `npm test` (expect 58+ pass) and `npm run typecheck` before any commit;
  show results and hold before live migrations / commits / outward-facing actions.

> NOTE FROM THE PHASE 3 SESSION: the "STOP AT AN OPTIMAL CONTEXT WINDOW" block
> above was AUTHORED in this session — no prior verbatim copy existed in the repo
> when the self-replicating rule was first invoked. If you (the user) have a
> canonical wording, replace it once and it will self-replicate from there.
