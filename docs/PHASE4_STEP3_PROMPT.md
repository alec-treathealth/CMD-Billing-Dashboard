# Session Prompt — Phase 4 Step 3: live integration (real Anthropic API + real DB)

> Read `docs/CLAUDE.md` in full first, then this prompt in full, BEFORE running
> anything. Standing rules apply: PHI never in logs / LLM prompts / `summary_stats`;
> parameterized queries only; secrets from `.env`
> (`export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)`); `node:test` only,
> no new test-runner deps; all DB access as `claims_reader` on the query/agent
> path; verify-full TLS stays on. **Never add a `Co-Authored-By` trailer to
> commits.** Show results and hold before live/outward-facing actions (deploys,
> commits, anything that leaves the machine).

## ⛔ USER-SIDE GATING ITEMS (resolve/confirm at the TOP, before running anything)

1. **CA bundling for the Vercel deploy — HARD BLOCKER.** All pg pools connect
   verify-full and read the Supabase Root 2021 CA from `secrets/supabase-ca.crt`
   via `src/ssl.ts` (`fileURLToPath(new URL('../secrets/supabase-ca.crt', import.meta.url))`).
   `secrets/` is **gitignored**, so the cert is NOT in the repo and will NOT be in
   the Vercel build/runtime — the claims_reader pool will fail to connect in
   production. This must be resolved **before** any live deploy/integration run.
   The cert is the **public** Supabase Root 2021 CA (not a secret), so the options:
   - **(a, recommended) Commit it to a non-ignored path** (e.g. `certs/supabase-ca.crt`)
     and update `src/ssl.ts` to resolve there. Simplest; the CA is public and
     valid to 2031. Keeps a single read path for local + Vercel.
   - **(b) Vercel env var** `SUPABASE_CA_PEM` (full PEM, or base64) read in
     `src/ssl.ts` with a file fallback for local dev. No repo cert; one more env
     var to manage per environment.
   - **(c) Build artifact** that materializes the cert into the deployment.
   Pick one with the user, implement it, and confirm the reader pool connects from
   a Vercel preview before the end-to-end run. Until this is decided, Step 3 is
   blocked.
2. **Vercel environment variables provisioned** (preview + production):
   `ANTHROPIC_API_KEY`, `RESULTS_API_SECRET`, `CLAIMS_READER_DATABASE_URL`, and
   whichever CA mechanism item 1 selects. None hardcoded; none logged. Confirm the
   reader URL points at the Supavisor **transaction** pooler (port 6543; unnamed
   prepared statements only — `pool.query(sql, params)`).
3. **Model id** — the agent defaults to `claude-opus-4-8` (override via
   `ANTHROPIC_MODEL`). Confirm the key's org has access to that model; do NOT
   hardcode an older id. Pull the current id from the `claude-api` skill if in
   doubt.
4. **Live-call cost / data acknowledgement** — Step 3 makes real Anthropic calls
   and real DB reads against the 320,116-row PHI dataset. Confirm the user wants
   live calls now (a small, bounded probe set, not a sweep), and that the test
   questions used do not embed real patient identifiers in anything logged.

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

- **Phases 1–3:** COMPLETE (ingest 320,116 claims; schema/RLS + least-privilege
  roles; five vetted query functions; PHI results route with column allowlists +
  identity verification; verify-full TLS).
- **Phase 4 Step 1 (commit `3343e82`):** agent library `src/agent/` — `runAgentTurn`
  maps NL → one query function via Anthropic tool-calling; faked client in tests.
- **Phase 4 Step 2 (commit `b9adcbb`):** Next.js 15 app under `app/` (TS, Tailwind,
  shadcn); `POST /api/agent` (non-PHI) + `POST /api/results` (PHI, claims_reader,
  identity re-verify, non-POST→405); `@anthropic-ai/sdk` added; Express harness
  (`src/server.ts`) retired; shared Bearer auth `src/bearerAuth.ts`.
- **Suite: 82 pass, 0 fail. `tsc --noEmit` clean.**

Run tests: `npm test` · Typecheck: `npm run typecheck` · DB smoke: `npm run dbcheck`
App: `cd app && npm install && npm run dev` (needs the env vars above + the CA).

## Task: Phase 4 Step 3 — live integration

After the gates above are cleared, validate the wired stack against the real
Anthropic API and the real DB. Suggested order (confirm shape with the user first):

1. **Local live probe of the agent layer** — with `.env` loaded, run `runAgentTurn`
   (a tiny script or one-off harness — do NOT add a live call to `npm test`) over a
   small set of NL questions covering each of the five tools. Assert: the model
   picks the expected tool, dispatch executes as `claims_reader`, the returned
   `summary_stats` is sane, and **no PHI** appears in the agent response or the
   audit line. For `client_history`, confirm the identity terms never appear in the
   transcript/audit/`query_log.arguments` — only as bound params.
2. **Local live probe of the results route** — feed a `query_id` from step 1 to
   `fetchResults` (or `POST /api/results` via the running app) and confirm
   allowlisted PHI columns come back; for `client_history`, confirm re-supplied
   identity gates the rows (match→rows, wrong/missing→empty).
3. **Vercel preview deploy** — deploy `app/` to a preview, with the CA mechanism
   (gate 1) in place and env vars set. Smoke-test both routes over HTTPS with the
   Bearer token. Confirm the reader pool connects verify-full from Vercel (negative
   control: a bogus CA should fail closed).
4. **Keep `npm test` hermetic** — all 82 fixture tests stay green and free of live
   LLM/DB. Any live probe is a separate, manually-run script, not part of the suite.

## Do not regress

- PHI never in `query_log`, logs, `summary_stats`, or any LLM prompt/transcript.
- `identity.ts` is the single source of truth for the hash — reuse, never copy.
- Parameterized queries only; column names fixed literals, values `$n`.
- All DB access as `claims_reader` on the query/agent path (never service role).
- Verify-full TLS stays on (`src/ssl.ts`); don't reintroduce `rejectUnauthorized:false`.
- The agent sees only `summary_stats` + `query_id`; the UI (not the agent) fetches
  PHI via the results route.
- Run `npm test` (expect 82+ pass) and `npm run typecheck` before any commit; show
  results and hold before live deploys / commits / outward-facing actions.
