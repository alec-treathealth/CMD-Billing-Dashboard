# CMD Billing Dashboard

An internal, PHI-aware web application over three years of out-of-network
behavioral-health billing data (BXR / Treat Health / CMD). Two pillars:

1. **Natural-language claims search** — ask a question in plain English; an
   Anthropic tool-calling agent maps it to one of a small set of vetted,
   parameterized query functions and renders the result. The agent never writes
   SQL and never sees patient rows.
2. **Non-PHI analytics dashboard** — aggregate-only views over claims and
   collections (payer overview, distributions, daily/monthly collections,
   charts), a paginated Claims Explorer with audited per-row PHI reveal, and a
   static behavioral-health code reference.

**This dataset is PHI** (patient names, member IDs, payers, amounts). The
compliance layer is on for the whole project (SOC 2 / HIPAA / OWASP). PHI never
enters logs, LLM prompts, URLs, or browser storage; queries are parameterized and
run as a least-privilege reader role; TLS is verify-full.

Live scale: **320,116 claims (2024–2026)** plus a collections domain (~58k raw
rows). Deployed to Vercel.

> **Read [`docs/CLAUDE.md`](docs/CLAUDE.md) before working on this project** — it
> is the single source of truth (architecture, PHI boundary, schema, query
> library, API contracts, phase history, known issues). The TreatHealthOS visual
> system is in [`docs/design-system.md`](docs/design-system.md).

## Architecture at a glance

```
Google Sheets ──ingest──> claims_raw (verbatim) ──transform──> claims (typed)
NL question ─> agent (Anthropic) ─> ONE vetted query fn ─> summary_stats + query_id
UI ──(query_id [+ re-supplied identity])──> results route ─> PHI rows
        (Next Server Action, server-side)   (re-runs query, never caches PHI)
```

Every query function returns a non-PHI `summary_stats` (the agent may see it) plus
an opaque `query_id`. PHI rows live only behind the results route, which re-runs
the parameterized query and projects allowlisted columns only. `client_history`
inputs are PHI: bound params only, re-supplied and verified server-side, never
stored or logged.

## Repo layout

This is a monorepo-style two-package repo:

- **`src/`** — root library: claims ingest, the query function library
  (`src/queries/`), the Anthropic agent (`src/agent/`), the PHI results route and
  transport-agnostic handlers (`src/routes/`), and the collections domain
  (`src/collections/`).
- **`app/`** — Next.js 15 App Router app (TS, Tailwind, shadcn/ui, recharts) that
  imports the library from `../src` and is the production transport + UI on Vercel.
- **`supabase/migrations/`** — `0001`–`0011` (claims schema, RLS + roles,
  collections, materialized aggregates, VOB foundation).
- **`certs/supabase-ca.crt`** — public Supabase Root CA for verify-full TLS.
- **`docs/`** — `CLAUDE.md` (project source of truth) + `design-system.md`.

## Tech stack

Node ≥20, TypeScript (ESM), `tsx`. Supabase Postgres via `node-postgres`.
Anthropic SDK (default model `claude-opus-4-8`). Next.js 15 / React 18 / Tailwind
/ shadcn/ui / recharts on Vercel. `zod` for validation. `node:test` for the
hermetic test suite.

## Setup

```bash
npm install
cp .env.example .env    # fill in DB URLs, ANTHROPIC_API_KEY, secrets — NEVER commit .env
```

See `.env.example` for the full annotated environment (least-privilege DB roles,
Bearer/revalidate secrets, Anthropic key, TLS CA). Google Sheets auth is OAuth
installed-app: place the client at `secrets/oauth-client.json` (first run does a
one-time browser consent). Load env on macOS/zsh before running scripts:

```bash
export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)
```

## Run

```bash
# root library
npm run ingest      # load the 3 Google Sheets -> claims_raw + claims (idempotent)
npm run dbcheck     # DB smoke (counts only)
npm test            # hermetic suite — 171 pass, 0 fail
npm run typecheck   # tsc --noEmit (clean)

# app
export SUPABASE_CA_PEM="$(cat certs/supabase-ca.crt)"   # required locally
cd app && npm install && npm run dev                     # http://localhost:3000
cd app && npm run typecheck && npm run build
```

## Verification & conventions

- `npm test` → 171 pass / 0 fail; both typechecks clean; `app` build succeeds.
- Tests are hermetic (faked Anthropic + DB) — no live LLM/DB in the suite.
  `src/liveProbe.ts` is the separate, manually-run live probe.
- Run the suite and both typechecks before any commit; hold before push/deploy.
- The standing PHI/compliance invariants and the "do not regress" list are in
  [`docs/CLAUDE.md`](docs/CLAUDE.md) §2 — follow them exactly.
</content>
