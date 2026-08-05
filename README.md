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

> **Read [`CLAUDE.md`](CLAUDE.md) before working on this project** — the standing
> rules, the verification gate, and an index of where everything lives. Deeper
> per-area detail lives in [`.claude/rules/`](.claude/rules/) and loads
> automatically when you touch the matching files. The live tribal-knowledge
> ledger is [`veris-data-notes.md`](veris-data-notes.md) (it wins on
> conflicts); the visual system is
> [`docs/design-system.md`](docs/design-system.md).

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
- **`supabase/migrations/`** — the product plane (`claims`, `collections`):
  schema, RLS + roles, collections, materialized aggregates, VOB. Through `0071`.
- **`SQL Schemas/`** — the separate Veris ML plane (`staging`, `ref`, `core`).
  Through `020`. Never mix the two directories.
- **`certs/supabase-ca.crt`** — public Supabase Root CA for verify-full TLS.
- **`.claude/rules/`** — path-scoped engineering rules Claude Code loads on demand.
- **`veris-data-notes.md`** (repo root) — the live tribal-knowledge ledger.
- **`docs/`** — `design-system.md`, build docs, and `archive/` (frozen
  historical context).

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
npm test            # hermetic suite — 697 pass, 0 fail
npm run typecheck   # tsc --noEmit (clean)

# app
export SUPABASE_CA_PEM="$(cat certs/supabase-ca.crt)"   # required locally
cd app && npm install && npm run dev                     # http://localhost:3000
cd app && npm test && npm run typecheck && npm run build
```

Local `app` dev also needs `app/.env.local` (`INDEX_HMAC_KEY` + the DB URLs) —
`next dev` does not read the repo-root `.env`.

## Verification & conventions

- Full gate before any commit: `npm test` (697/0), `npm run typecheck`,
  `cd app && npm test` (127/0), `cd app && npm run typecheck`, `cd app && npm run build`.
- Root `tsc` is stricter than app `tsc` (`noUncheckedIndexedAccess`) — a change
  can be green in `app/` and red at the root. Run both.
- `next build` is the only step that catches bundler-only failures.
- Tests are hermetic, no live LLM/DB in the suite.
  `src/liveProbe.ts` is the separate, manually-run live probe.
- Hold before any push, deploy, or migration apply.
- The standing PHI/compliance invariants and the "do not regress" list are in
  [`CLAUDE.md`](CLAUDE.md) — follow them exactly.
</content>
