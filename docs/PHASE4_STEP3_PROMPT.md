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

1. **CA bundling for the Vercel deploy — ✅ RESOLVED (Step 3 prep).** The Supabase
   Root 2021 CA is now COMMITTED at `certs/supabase-ca.crt` (a public root cert,
   not a secret, valid to 2031) and `src/ssl.ts` resolves it there
   (`new URL('../certs/supabase-ca.crt', import.meta.url)`). It ships in the repo
   and the Vercel bundle, so both the root tooling (admin pool) and the Next app
   (reader pool) connect verify-full in production. **Still verify at deploy time:**
   that Next's file tracing actually includes `certs/supabase-ca.crt` in the
   serverless function bundle (a `new URL(..., import.meta.url)` + `readFileSync`
   can be missed by static tracing) — confirm the reader pool connects from a
   Vercel preview, and keep a wrong-CA negative control (must fail
   `SELF_SIGNED_CERT_IN_CHAIN`). If tracing drops it, add `outputFileTracingIncludes`
   in `next.config.mjs` (or fall back to a `SUPABASE_CA_PEM` env var read in ssl.ts).
2. **Vercel project + git remote — HARD BLOCKER (not yet set up).** This repo has
   **no git remote and no Vercel linkage** (no `.vercel/`, no `vercel.json`). Before
   any deploy: create/push a remote (e.g. GitHub) and create + link a Vercel
   project, with the project **root directory set to `app/`** (the Next app is a
   sub-package; the build runs from there) and a build that can reach `../src` and
   `../certs`. Decide import behavior: the app imports `../src/*` and `../certs/*`
   from outside `app/` — confirm Vercel includes the repo root in the build context
   (monorepo root vs. `app/` root directory setting), or the build/file-tracing will
   miss them. The `vercel:*` skills / Vercel MCP tools can drive this.
3. **Vercel environment variables provisioned** (preview + production):
   `ANTHROPIC_API_KEY`, `RESULTS_API_SECRET`, `CLAIMS_READER_DATABASE_URL`. None
   hardcoded; none logged. Confirm the reader URL points at the Supavisor
   **transaction** pooler (port 6543; unnamed prepared statements only —
   `pool.query(sql, params)`).
4. **Model id** — the agent defaults to `claude-opus-4-8` (override via
   `ANTHROPIC_MODEL`). Confirm the key's org has access to that model; do NOT
   hardcode an older id. Pull the current id from the `claude-api` skill if in
   doubt.
5. **Live-call cost / data acknowledgement** — Step 3 makes real Anthropic calls
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
