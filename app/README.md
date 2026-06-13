# Claims Search — Next.js transport (Phase 4)

Next.js 15 App Router app that exposes the claims search agent and the PHI
results route over HTTP, for Vercel deploy. It is a separate package
(monorepo-style) that imports the agent / query / results library from `../src`.
This replaces the retired Express dev harness (`src/server.ts`).

## Routes

| Route | Method | Auth | Body | Returns |
|-------|--------|------|------|---------|
| `/api/agent` | POST | `Authorization: Bearer <RESULTS_API_SECRET>` | `{ "question": string }` | `{ tool_name, query_id, summary_stats }` — **no PHI** |
| `/api/results` | POST | `Authorization: Bearer <RESULTS_API_SECRET>` | `{ "query_id": string, "identity"?: { "patient_last": string, "member_id_norm"?: string } }` | `{ rows, function_name, query_id }` — **PHI** (allowlisted columns) |

The agent never returns PHI; the UI fetches PHI rows from `/api/results` using
the `query_id` the agent returns. `client_history` requires re-supplied identity
terms in the body (POST, so they never hit a URL/query string) and is verified
server-side before any row is served.

## Environment

Reads from the repo-root `.env` (loaded by Vercel / your runtime):

- `ANTHROPIC_API_KEY` — the agent's LLM client.
- `RESULTS_API_SECRET` — shared Bearer secret for both routes.
- `CLAIMS_READER_DATABASE_URL` — least-privilege claims_reader DB role.
- `certs/supabase-ca.crt` — verify-full TLS CA, committed to the repo (public root
  CA, not a secret), so it ships in the Vercel bundle for the pg pool to connect.

## Develop

```sh
cd app
npm install          # installs Next + the runtime deps this package re-bundles from ../src
npm run dev          # http://localhost:3000
npm run typecheck
```

The library logic and the route handlers are unit-tested from the repo root
(`npm test`, fixture-level with faked Anthropic + DB) — this package is the thin
HTTP transport over them.
