# CMD Billing Dashboard

Internal, PHI-aware web app over out-of-network behavioral-health billing data
(BXR Consulting + Indigo Consulting, sourced from CollaborateMD "CMD"). Two
Postgres planes in one Supabase cluster: the `claims`/`collections` product
plane, and the `staging`/`ref`/`core` Veris ML plane.

**Every row is PHI.** The compliance layer (SOC 2 / HIPAA / OWASP) is ON for
this whole repo. The invariants below are not preferences.

## Standing rules — do not regress

- **PHI never** reaches logs, LLM prompts/transcripts, `summary_stats`, a URL or
  query string, browser storage (`localStorage`/cookies), or `query_log`.
- **Parameterized queries only.** Table/column/GUC names are fixed string
  literals; only values are `$n` bound params. Never `SELECT *` — project
  explicit allowlisted columns.
- **Reads run as `claims_reader`; writes as the narrow writer role**
  (`cmd_rollup_writer` for collections crons). Never the Supabase service-role
  key and never `claims_admin` on the app path. One deliberate exception:
  `inviteUser` in `app/lib/admin-actions.ts` (server-only, never the browser).
- **Verify-full TLS stays on** (`src/ssl.ts`). Never reintroduce
  `rejectUnauthorized: false`. Never put `sslmode` in a DB URL — it silently
  drops the CA.
- **Supavisor transaction pooler (port 6543) forbids named prepared
  statements** — use `pool.query(sql, params)` only.
- **Secrets from env only.** No `NEXT_PUBLIC_*` for anything server-side. The
  browser's only data path is Next Server Actions.
- **Tests stay hermetic** — `node:test` only, no new test-runner deps, no live
  LLM/DB in `npm test`. `src/liveProbe.ts` is the separate manual live probe.
- **Never add a `Co-Authored-By` trailer** to a commit or PR.
- **Gate outward-facing actions.** Show results and HOLD before applying a
  migration, committing, pushing, or deploying. Don't add or alter SQL query
  tools without asking.
- **The hourly collections crons are production-critical.** Don't touch their
  routes, schedules, Vercel env, writer grants, or the `collections.*` tables
  they write unless the session is explicitly scoped to that work. After any
  push that deploys, verify the next scheduled run logs success.

## Verification gate

Run all four before any commit. This is the bar for "verified" — not typecheck
alone, and especially not when a shared helper changed.

```bash
npm test                          # root hermetic suite — 697 pass / 0 fail
npm run typecheck                 # root tsc (strict: noUncheckedIndexedAccess)
cd app && npm test                # app suite — 127 pass / 0 fail
cd app && npm run typecheck        # app tsc
cd app && npm run build            # catches bundler-only failures tsc cannot
```

Root `tsc` is stricter than app `tsc` — a test can be green in `app/` while root
`tsc` is red. Run both. `next build` is the only thing that catches webpack
failures (see `.claude/rules/nextjs-app.md`).

## Repo layout

Monorepo-style **two packages**: the root package is the ingest + query/agent
library (`src/`); `app/` is the Next.js 15 transport + UI, which imports the
library from `../src` and is the Vercel app root.

Two **separate** migration planes — never mix the directories:

| Plane | Directory | Next number |
|---|---|---|
| Product (`claims`, `collections`) | `supabase/migrations/00NN_*.sql` | **0072** |
| Veris ML (`staging`, `ref`, `core`) | `SQL Schemas/0NN_*.sql` | **023** |

Merging a migration in a PR does **not** apply it to prod. Code that depends on
it 500s until `apply_migration` runs.

## Live surfaces

Top nav: Overview · Collections · Claims Audit (Beta) · Qualify (Beta) · Code
Reference · Ask.

- `/dashboard` (Overview) and `/dashboard/collections` — the primary product.
- `/billing-audit` (labelled "Claims Audit") and `/qualify` + `/qualify/m` — both
  currently behind a **refactor notice shown to everyone except
  `alec@treathealth.ai`**. Kill switches: `CLAIMS_AUDIT_MAINTENANCE` /
  `QUALIFY_MAINTENANCE` = `0`/`false`/`off`.
- `/claims` and `/claims/[claimId]` — **taken down 2026-07-15**, now a
  `redirect('/')` stub. The implementation is in git history, not deleted. The
  name "Claims" is reserved for Veris S10.
- 10 Vercel crons in `app/vercel.json` (collections explorer + census per tenant,
  rollup refresh, VOB sync, CMS HCPCS sync, billing-audit IP/OP, code
  decisions). VOB sync is scheduled by Vercel but *runs* as a GitHub Action
  (`.github/workflows/vob-sync.yml`) — it won't show output in the Vercel cron UI.

## Where the detail lives

Path-scoped rules in `.claude/rules/` load automatically when you touch the
matching files. Read the one for the area you're changing:

| Area | Rule |
|---|---|
| `src/queries/`, `src/agent/`, `src/routes/` | `query-library.md` — the PHI boundary + locked semantics |
| `supabase/migrations/`, `SQL Schemas/` | `sql-migrations.md` — idempotency, ownership, rollback |
| `src/collections/`, `app/app/api/cron/` | `collections-crons.md` — CMD ingest, filters, fingerprints |
| `app/` | `nextjs-app.md` — Server Actions, RBAC, PHI in the UI, build traps |
| `src/veris/`, `src/tenants.ts`, `app/lib/views.ts` | `tenancy.md` — `business_entity_id`, GUC, fail-closed scope |
| `app/lib/qualify/`, `app/components/qualify/` | `qualify.md` |
| `src/billingAudit/`, `app/lib/billing-audit/` | `billing-audit.md` |

Longer-form references (not auto-loaded — read on demand):

- `docs/veris-data-notes.md` — the live tribal-knowledge ledger, updated
  per-apply. **When it conflicts with anything here, it wins.** Surface the
  conflict in your output; never silently pick a side.
- `docs/design-system.md` — the TreatHealthOS visual system.
- `docs/CMD AR Automation — Build Doc v2.md` — the current AR build plan.
- `docs/archive/CLAUDE-2026-07-06.md` — the previous 914-line context file,
  frozen. Historical only; it is stale in ≥6 places and superseded by this file
  plus the rules above.

## Known stale comments — do not propagate

These are wrong in the code today. Fix opportunistically; never copy them.

- `app/lib/server.ts` and `app/app/api/cron/indigo-explorer/route.ts` say 36–37
  Indigo customers. The roster is **32** (`src/collections/cmdCustomers.ts`).
- `src/collections/cmdExplorer.ts` references CMD filter `10147499`. The live
  cron default is **`10147530`** (`app/lib/server.ts`). `10147499` survives only
  in the manual `cmdDailyBackfill.ts` CLI.
- `src/collections/cmdExplorer.ts` says the row fingerprint hashes 14 fields — it
  hashes 18.
- `supabase/migrations/0067_*` looks applicable but is **stale**: as authored it
  drops 0068's covering index and 0069's MAINTAIN grant. Leave it alone.
- The agent still defaults to model `claude-opus-4-8` (`src/agent/agent.ts`).
  Flag before relying on it for new AI work.

<!-- Ground truth re-verified against HEAD 0b69ce0 on 2026-07-28: test counts,
     cron list, roster sizes, migration numbers, and route status all run live. -->
