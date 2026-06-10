# CMD Billing — Phase 1: Claims Ingestion

Loads three years of out-of-network behavioral-health billing data from Google
Sheets into Supabase: every row lands verbatim in `claims_raw`, clean rows are
transformed into typed `claims`, and rows that fail coercion are written to a
gitignored report (never dropped silently).

**This is PHI.** Compliance layer is on. No PHI in logs; no secrets in code.

## Scope

Phase 1 only: the Supabase migration + the ingestion script. No agent, query
functions, readmission matching, PHI results route, or UI (see `CLAUDE.md`).

## Setup

```bash
npm install
cp .env.example .env          # fill in Supabase + Google creds (NEVER commit .env)
```

- **Supabase**: project `cmd-billing-dashboard` (`dbpabchpvipipkzkogta`). The
  service-role key is used by this loader ONLY (bypasses RLS); never ship it to
  the app/browser.
- **Google**: a service account with read-only Sheets scope. Grant its
  `client_email` Viewer access to the three "Copy of Historical Data for ..."
  sheets in the "Reports for Alec AI" folder.

## Migration

`supabase/migrations/0001_phase1_claims_schema.sql` — already applied to
`dbpabchpvipipkzkogta`. Re-applying is safe (`IF NOT EXISTS` throughout).

## Run

```bash
export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)   # macOS/zsh
npm run ingest
```

Idempotent: re-running inserts zero new rows. The failed-coercion report is
written to `reports/failed-coercion-*.jsonl` (gitignored — may contain PHI).
Logs print counts only.

## Test

```bash
npm test        # normalizer + sheet-mapping unit tests (no network/creds)
npm run typecheck
```

Fixtures in `test/fixtures.ts` encode the documented dirty patterns: 2024
`Office Name` header + blank codes + negative member id; the Vanguard
embedded-comma row; `$-1,660.05` negative money; mixed `M/D/YYYY` /
`MM/DD/YYYY` dates.
