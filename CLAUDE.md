# CMD Billing Dashboard

Internal, PHI-aware web app over out-of-network behavioral-health billing data
(BXR Consulting + Indigo Consulting, sourced from CollaborateMD "CMD"). Two
Postgres planes in one Supabase cluster: the `claims`/`collections` product
plane, and the `staging`/`ref`/`core`/`intel` Veris ML plane.

**Every row is PHI** — except `intel.*`, which is deliberately non-PHI
(public payer/federal policy findings; see `SQL Schemas/025_*.sql`). The compliance layer (SOC 2 / HIPAA / OWASP) is ON for
this whole repo. The invariants below are not preferences.

## Canonical Context Set

This table is the only authoritative source of doc paths in this repo. If a
prompt hands you a path, treat it as a hint and defer to this table.

Enforced by `scripts/check-context-map.ts`, which runs inside root `npm test`
(`test/contextMap.test.ts`). Every path in the table must resolve on disk; every
path in the NOT-IN-REPO list must not. A `git mv` fails the gate instead of
silently rotting this section. The guard reads the working tree, not `HEAD`, so
only committed docs belong in the table — untracked ones go under
[Uncommitted — not guarded](#uncommitted--not-guarded).

| Role | Path | Read-order |
|---|---|---|
| Standing rules, verification gate, this map | `CLAUDE.md` | 1 |
| Live tribal-knowledge ledger — **wins on conflict with this file** | `veris-data-notes.md` | 2 |
| Build guide — the 13 gated Veris/Indigo sessions + order deviations | `docs/archive/00-GUIDE.md` | 3 |
| PR compliance rules — the real Qodo content (`.qodo/` is empty) | `pr_compliance_checklist.yaml` | 4 |
| Visual system — TreatHealthOS tokens and palette | `docs/archive/design-system.md` | 5 |
| Qodo required-status-check contract + rename hazard | `docs/qodo-compliance-gate.md` | 6 |
| Product orientation — what this app actually is | `README.md` | 7 |

Read-order is a cold-start sequence, not a priority ranking. Path-scoped rules in
`.claude/rules/` load automatically and are not listed here — see
[Where the detail lives](#where-the-detail-lives).

> **`docs/archive/` now holds two LIVE documents, which is a naming lie worth knowing about**
> (recorded 2026-08-05). A bulk relocation moved `docs/Fable Build Doc E2E/00-GUIDE.md` →
> `docs/archive/00-GUIDE.md` and `docs/design-system.md` → `docs/archive/design-system.md`. Both are
> still CURRENT — the design system is what `.claude/rules/nextjs-app.md` tells you to follow, and
> `00-GUIDE.md` is read-order 3. The paths above are the real ones; do not infer staleness from the
> `archive/` segment the way the [Superseded](#superseded-in-repo--do-not-treat-as-current) list
> below invites you to. `veris-data-notes.md` was swept into `archive/` by the same move and was
> **restored to the repo root**, because it is the append-target ledger this file designates as
> authoritative and the "root wins" relocation was ratified 2026-08-04 — a live ledger filed under
> `archive/` would read as frozen to every future session.

### NOT IN REPO — project-knowledge only

These live only in Alec's Claude.ai project knowledge. **Do not search for them,
do not infer their contents.** If a prompt references one, stop and ask Alec to
paste it.

- `Veris-Plan-Reconciliation-and-Next-Steps.md`

### Superseded in repo — do not treat as current

A file *does* exist at each path below, but it is a frozen snapshot. The live
version is project knowledge, not the repo copy — ask Alec to paste it rather
than reading these as current. They are guarded (they must keep resolving) so a
`git mv` surfaces here instead of rotting.

- `docs/qualify-build-series.md` — the 5-prompt Qualify build series as authored; the shipped build diverged.
- `docs/archive/fable-build-doc-e2e/01-session-ground-truth.md` — first of the 01–13 session prompts; the whole directory is the same vintage.
- `docs/archive/CLAUDE-2026-07-06.md` — previous 914-line context file. Stale in ≥6 places; superseded by this file plus `.claude/rules/`.

### Uncommitted — not guarded

These exist locally but are **untracked**, so the guard cannot assert them
without going red on a fresh clone. `git add` each and promote it.

- `CMD AR Automation — Build Doc v2.md` (repo root) — the current AR build plan.
  Promote into the table above once tracked.

`scripts/check-context-map.ts` and `test/contextMap.test.ts` were tracked on
2026-08-03, so the enforcement claim at the top of this section is now true on a
fresh clone and in CI, not only on Alec's machine.

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

Run all five before any commit. This is the bar for "verified" — not typecheck
alone, and especially not when a shared helper changed.

```bash
npm test                          # root hermetic suite — >=1284 pass / 0 fail
npm run typecheck                 # root tsc (strict: noUncheckedIndexedAccess)
cd app && npm test                # app suite — >=386 pass / 0 fail
cd app && npm run typecheck        # app tsc
cd app && npm run build            # catches bundler-only failures tsc cannot
```

Root `tsc` is stricter than app `tsc` — a test can be green in `app/` while root
`tsc` is red. Run both. `next build` is the only thing that catches webpack
failures (see `.claude/rules/nextjs-app.md`).

Those counts are a tripwire, not a target: if a suite reports fewer than the
number above, tests were lost — find out why before committing. They are written
as `>=` floors deliberately, because the suites grow and a hardcoded exact number
rots into a false tripwire within days.

**Provenance of the current floors (read before trusting them).** 1284 / 386 are
**RATIFIED counts**, not merely floors known to be reachable: measured 2026-08-06
on a **clean detached worktree** of `origin/main` @`ea3dadb` (`git worktree add
--detach origin/main`, `git status --porcelain` empty before any command ran,
`npm ci` clean at both root and `app/`, all five gate commands exit 0). That is
the exact condition the paragraph below demands, so these may be trusted as
measured rather than as a lower bound someone once hit.

They supersede 1110 / 259, which were measured 2026-08-04 on the **shared working
tree** of branch `fix/qualify-no-matches-stale` and were explicitly flagged as
not-evidence; those in turn superseded 1076 / 206 (tree of `main` @`53b49d6`).
The 1110 / 259 pair had drifted **174 root and 127 app tests low**, which had
quietly disabled the tripwire: a suite could have silently lost ~170 tests and
still "passed" the floor. If you find yourself more than a few dozen tests above
the number here, that is the same rot — re-measure and promote.

**The rule that produced these numbers, unchanged:** only counts measured on a
clean detached checkout of `origin/main` are trustworthy — a shared working tree
with other sessions' edits is not evidence. Re-measure on a clean checkout when
you next have one, and promote the number then.

## Git workflow

Open PRs against `staging`, never `main` — use `gh pr create --base staging`
explicitly. `main` is production; it only receives a PR from `staging` after
Vercel and Qodo checks pass.

## Repo layout

Monorepo-style **two packages**: the root package is the ingest + query/agent
library (`src/`); `app/` is the Next.js 15 transport + UI, which imports the
library from `../src` and is the Vercel app root.

Two **separate** migration planes — never mix the directories:

| Plane | Directory | Next number (as of 2026-08-08) |
|---|---|---|
| Product (`claims`, `collections`) | `supabase/migrations/00NN_*.sql` | **0094** |
| Veris ML (`staging`, `ref`, `core`, `intel`) | `SQL Schemas/0NN_*.sql` | **032** |

**0093 (Qualify rating history) is APPLIED LIVE 2026-08-08** via `apply_migration` — plain
transactional DDL, so the 0081/0092 autocommit discipline does NOT apply here. It creates
`collections.qualify_policy_rating_daily` + `qualify_rating_run` + `qualify_prefix_echo` and
the `record_qualify_prefix_echo` definer. Verified at apply: reader SELECT true · writer
INSERT/UPDATE true · **writer DELETE false** (least privilege, the 0091 shape) · **12 policies
across the 3 tables** · RLS enabled on all 3 · definer is `security definer`, owner `postgres`,
EXECUTE granted to `claims_reader` and revoked from `public`. Its input validation was exercised
both ways — four malformed calls wrote nothing, a well-formed call upserted, test row deleted.

⚠ **The table is applied but the CRON IS NOT DEPLOYED** — `/api/cron/qualify-rating-history`
lives on `design/qualify-smoke-shell`, and production is `main`, so the 05:10 schedule cannot
fire until that branch reaches `main` via staging. All three tables are EMPTY until then; that
is the expected state, and `getQualifyPolicyTape()` correctly reads `available:true` with zero
items (`available:false` means the RELATION is absent, which it no longer is).

0077/0078/0079 are **Qualify-owned and applied live** — never author a new
0077. 0080/0081/0082 (explorer perf) are **applied live 2026-08-04** — 0081
via autocommit `execute_sql` statements, not `apply_migration` (see its
header). **0083 is applied live** (2026-08-05 04:19:16 UTC, ledger
20260805041916). **0084/0085/0086 (Facility Resolution) are APPLIED LIVE
2026-08-05** — ledger 20260805074605 / 074855 / 074944, in that order. **0087
(qualify-census run-log) is APPLIED LIVE 2026-08-05** — verified as the writer
role, not just as `postgres`. **0088 (qualify census `los_sample`) is APPLIED
LIVE 2026-08-06**, ledger 20260806030335. **0089 (`grant select on
collections.facilities to cmd_rollup_writer`) is APPLIED LIVE 2026-08-06** —
it un-saturated the census conformance alarm, which had reported
`conformance_gap_boards: 23 of 23` on every run since onboarding because the
writer could not read the roster and the 42501 was being swallowed into an empty
map. If you add a `collections.*` read to a cron, **check the writer's grant
first** — `has_table_privilege('cmd_rollup_writer', …)` — because a fail-soft
catch will otherwise turn a permission error into permanently wrong data rather
than a visible failure. **0090 (writer SELECT policy on `collections.facilities`)
and 0091 (`collections.qualify_facility_outcomes` + both its policies) are APPLIED
LIVE** — verified 2026-08-06 by object presence, not by a ledger entry. **0092
(Qualify token-scoped covering indexes) is APPLIED LIVE 2026-08-06** via autocommit
`execute_sql`, **not** `apply_migration`: it runs `CREATE INDEX CONCURRENTLY` twice
plus `VACUUM (ANALYZE)`, none of which can run inside a transaction block (same
discipline as 0070 and 0081). It delivered what it promised — the ladder's prefix
query went 353ms / 1,455 buffers to **17.5ms with `Heap Fetches: 0`** — but it cost
**169 MB** (102 + 67) against its rollback header's estimate of "10-15 MB combined",
roughly **12x over**, because the INCLUDE payload carries `primary_payer` *text* and
the estimate priced only the HMAC token. Indexes on `cmd_explorer_charge_rollup` are
now 306 MB against a 164 MB heap. Dropping the superseded bare
`cmd_charge_rollup_prefix` / `_member` recovers only ~8 MB and does not offset this.
**Settled 2026-08-07: KEEP `primary_payer` in both payloads** — it is not only the
ladder's; `buildResolvePayerQuery`/`buildResolvePayerSpreadQuery` (every token
search, ~80.6% multi-payer prefixes) and v3's `buildClaimsOnlyCandidatesQuery` also
read it index-only off these same indexes, and live EXPLAIN shows dropping it
reproduces the pre-0092 3,561-buffer bitmap-heap path (the 676ms class) — see
veris-data-notes.md's 0092 section, "Resolution (2026-08-07)", for the full recon.
**Price an INCLUDE payload by its widest text column, not its keys.** Veris
**027 and 028 are applied live** (ledger 20260805065025 / 20260805060000, another
session). **029 (`ref.payer_alias_map` confirmation-attribution gate) is APPLIED LIVE
2026-08-07** — it flips `needs_review`'s default from `false` to `true` and adds a
`NOT VALID` CHECK requiring `reviewed_by` + `reviewed_at` on any confirmed row.
The `NOT VALID` is **permanent and deliberate**: the 695 pre-029 confirmed rows are
exempt forever, so `confirmed + reviewed_by IS NULL` is a reliable "predates the
boundary" marker, not a defect. **Never `VALIDATE` that constraint and never
back-fill those 695 with a synthetic reviewer** — see `veris-data-notes.md` § 029.
**030 (dedup round 2) and 031 (payer brand allowlist) are AUTHORED BUT NOT APPLIED**,
so the next Veris number is **032**. 030 drops and re-adds the 029 gate inside its own
transaction; that is sanctioned *only* because its final section proves confirmation
state was byte-identical throughout. Copy the proof if you copy the pattern.
⚠ **031 IS HELD ON PURPOSE — DO NOT APPLY IT TO CLEAR THE BACKLOG.** It creates
`ref.payer_brand` + `ref.payer_brand_entity` and **nothing reads either table**. 026 and
027 both refuse to mint a surface with no owner, and 031 is the same shape: its only
justification is being the FK target a later wiring change needs. Being merged into the
repo is not a decision to apply it. If that wiring is not coming, **delete 031 rather
than applying it** — an applied table with no caller is schema debt that later readers
will assume is load-bearing. The file's own header says the same thing; this note exists
because a `SQL Schemas/` listing shows 031 sitting next to genuinely-pending migrations
and gives no hint that it is deliberately parked.
Never edit 023, 024, or 025
in place — all three are applied live. Before authoring, re-derive the next number
per `.claude/rules/sql-migrations.md` (ref-derived max is a floor; cross-check
worktrees and the live applied state).

⚠ **OWNERSHIP IN THE `collections` PLANE IS `postgres`, NOT `claims_admin`.**
Measured 2026-08-05: `cmd_explorer_rows`, `facilities`, `cmd_facility_aliases`,
`cmd_explorer_charge_rollup` and `cmd_charge_int_facility` are all
`relowner = postgres`. `.claude/rules/sql-migrations.md` says migrations create
objects "born owned via `SET ROLE claims_admin`" — that describes the `claims`
schema. In `collections` a `SET ROLE claims_admin` **downgrades** the applying
role from owner to non-owner and fails with `42501: must be owner of table …`.
0084 and 0085 both hit this on first apply. Do not add `SET ROLE` to a
`collections` migration, and own SECURITY DEFINER functions there as `postgres`
(a definer runs as its OWNER — a claims_admin-owned definer cannot write a
postgres-owned table).

Veris apply state as of 2026-08-03, which is NOT the same as the file order:
**024 APPLIED LIVE · 023 APPLIED LIVE (2026-08-03, after 024) · 025 APPLIED LIVE
(2026-08-03, after two 42501 posture corrections — see the file header).** 024 went first
because 023 was under concurrent revision and 024 has no executable dependency on it — no FK,
no view, no trigger (the resolver is in `src/veris/upcomingForecast.ts`); 023 followed once
that revision settled. Do not read the numbering as an apply order. See
`veris-data-notes.md` §§ "023 …" / "024 …" / "025 …".

Merging a migration in a PR does **not** apply it to prod. Code that depends on
it 500s until `apply_migration` runs.

## Live surfaces

Top nav is built from `app/lib/nav-model.ts` — `nav-links.tsx` (bar) and
`shell/nav-rail.tsx` (rail) both read it, so the two shells cannot disagree.
The link set is role-dependent:

- `admin` / `user` / unknown — Overview · Collections · Claims Audit (Beta) · Code Reference
- `super_admin` — the above plus Qualify (Beta), between Overview and Collections
- `admissions_seat` — Qualify only (single-surface persona)

Surfaces:

- `/dashboard` (Overview) and `/dashboard/collections` — the primary product.
- `/billing-audit` (labelled "Claims Audit") and `/qualify` + `/qualify/m` — both
  currently behind a **refactor notice shown to everyone except
  `alec@treathealth.ai`**. Kill switches: `CLAIMS_AUDIT_MAINTENANCE` /
  `QUALIFY_MAINTENANCE` = `0`/`false`/`off`.
- `/claims` and `/claims/[claimId]` — **taken down 2026-07-15**, now a
  `redirect('/')` stub. The implementation is in git history, not deleted. The
  name "Claims" is reserved for Veris S10.
- `/ask` — **removed from the nav 2026-07-15** (unfinished), also a
  `redirect('/')` stub. `<SearchConsole />` and the `/api/agent` path stay in git
  history; restoring means remounting the page *and* re-adding the nav entry.

`app/vercel.json` declares **21 cron entries across 19 distinct routes**
(`billing-audit-consolidated` runs on three schedules; the previous 19/17 count
predated `facility-outcomes`, and `qualify-rating-history` is new on this branch):

| Route | Cadence |
|---|---|
| `cmd-explorer` · `indigo-explorer` | hourly, :00 / :30 |
| `cmd-census` · `indigo-census` | hourly, :15 / :35 |
| `refresh-charge-rollup` | hourly, :45 |
| `qualify-census` | hourly, :22 |
| `upcoming-overrides` | hourly, :55 |
| `facility-outcomes` | daily 04:10 |
| `qualify-rating-history` | daily 05:10 — DB-only; inert 500 until mig 0093 applies |
| `cmd-explorer-catchup` | daily 07:52 |
| `era-835` | daily 08:50 |
| `vob-sync` | daily 09:17 |
| `refresh-cmd-payer` | daily 10:50 |
| `reconcile-deposits` | daily 11:50 |
| `cms-hcpcs-sync` | quarterly, 06:00 on the 2nd of Jan/Apr/Jul/Oct |
| `payer-intel` | monthly, 07:20 on the 2nd |
| `billing-audit-op` · `billing-code-decisions` | daily 02:20 / 02:40 |
| `billing-audit-consolidated` | daily 02:40, 03:10, 03:40 |

> **The `:41–:59` reserved window is CMD-API-scoped, as practiced** (evidenced 2026-08-05 — do not
> re-fight this). The band is held for live CMD probe work, and the constraint that matters is
> *contention for CMD's one-report-at-a-time partner slot*, not the clock alone. Two crons sit inside
> it and legitimately stay:
>
> - `refresh-charge-rollup` (:45) is **DB-only**. `app/app/api/cron/refresh-charge-rollup/route.ts:32`
>   → `handleRefreshChargeRollup` (`app/lib/server.ts:745`) →
>   `handleRefreshChargeRollupRequest` (`src/routes/refreshChargeRollupHandler.ts:41`), whose sole
>   injected dependency is `refresh()` (`:33`). That runs
>   `select collections.refresh_cmd_explorer_charge_rollup()`
>   (`src/collections/refreshChargeRollup.ts:86`). Zero `fetch`, zero HTTP client, no CMD call.
> - `upcoming-overrides` (:55) makes an **external call, but to Google Sheets, not CMD** —
>   `app/lib/server.ts:1237-1249` imports `googleapis` and calls `readSheet(sheetId, tab, oauth)`.
>
> So neither contends for the CMD slot. A cron that *does* call the CMD API belongs outside
> :41–:59 — that is why `qualify-census` moved off :47 even though it talks to Monday: the rule was
> applied conservatively rather than argued down. If the band is ever redefined as wall-clock-absolute
> rather than CMD-scoped, these two need their own explicitly-scoped change; they are
> production-critical and must not be moved as a drive-by.

`/api/cron/qualify-census` was scheduled 2026-08-04 (hourly **:22**) in the
explicitly-scoped Auth/LOS session the morning runbook reserved it for, after
`MONDAY_SECRET_API_KEY` landed in Vercel. It feeds the Qualify auth-fit factor
from Monday census boards. ⚠ **The curation claim that used to live here ("only
NASH and LSMH") went stale within a day and stayed wrong until 2026-08-08.** The
curated map (`MONDAY_CENSUS_FACILITIES`, `src/collections/qualifyCensus.ts`) has
covered **23 facilities — 12 residential + 11 outpatient — since 2026-08-05**,
and `collections.qualify_facility_census` carries a live row for every one of
them (verified 2026-08-08, synced minutes earlier). Two semantics to respect
when reading that table: outpatient rows carry `bed_capacity = null` and
`open_beds = 0` because **beds do not apply** — 0 there is not "full"; and
`avg_los_days` needs a sample gate (`los_sample`) before display — tiny
outpatient samples produce 300–373-day "stays". Unmapped facilities still show
"no data yet"; the map itself is the onboarding.

VOB sync is scheduled by Vercel but *runs* as a GitHub Action
(`.github/workflows/vob-sync.yml`) — it won't show output in the Vercel cron UI.

## Agent tooling — plugins and skills

Three layers load, in increasing specificity. Don't confuse them:

1. **`superpowers` plugin** — user-scope, on Alec's machine only. Version
   **6.2.0**, installed from a local directory marketplace at
   `~/.claude/local-marketplaces/superpowers` (marketplace id `superpowers-dev`).
   Ships 14 general workflow skills (TDD, systematic-debugging, writing-plans,
   verification-before-completion, …) plus its own SessionStart hook, which
   coexists with this repo's `.claude/hooks/session-start.sh`.
2. **`.claude/rules/*.md`** — repo-scoped, path-triggered, checked in. These are
   binding for this codebase and **outrank any generic plugin skill** wherever
   the two disagree — most of all on the PHI and least-privilege rules above.
3. **This file** — the standing rules, the gate, and the context map.

The repo deliberately does **not** vendor or pin `superpowers`: it is absent from
`.claude/settings.json`, `package.json`, and `.claude/plugins/`. A fresh clone
gets the rules and the hook, not the plugin. Do not add an `enabledPlugins` entry
for it — pinning a version in a tracked settings file forces that version on
every clone, and a stale pin silently shadows a newer local install.

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

Longer-form references (not auto-loaded — read on demand). Paths for these live
in [Canonical Context Set](#canonical-context-set); that table wins:

- `veris-data-notes.md` — the live tribal-knowledge ledger, updated
  per-apply. **When it conflicts with anything here, it wins.** Surface the
  conflict in your output; never silently pick a side.
- `docs/archive/design-system.md` — the TreatHealthOS visual system.
- `CMD AR Automation — Build Doc v2.md` (repo root, **untracked**) — the current
  AR build plan. Previously mis-cited here as `docs/CMD AR Automation — Build
  Doc v2.md`, which has never existed.
- `docs/archive/CLAUDE-2026-07-06.md` — the previous 914-line context file,
  frozen. Historical only; it is stale in ≥6 places and superseded by this file
  plus the rules above.

## Known stale comments — do not propagate

These are wrong in the code today. Fix opportunistically; never copy them.

- `app/lib/server.ts` (~L1688) says 36 Indigo customers and
  `app/app/api/cron/indigo-explorer/route.ts` says 37. The roster is **30**
  (`src/collections/cmdCustomers.ts`) — 10036020 MADISON RECOVERY CENTER and
  10036030 MISSOURI BEHAVIORAL HEALTH were dropped 2026-08-02 for hard INVALID
  CRITERIA. BXR is **15**.
- CMD report/filter pairings turn over fast; trust `app/lib/server.ts`, never
  prose. Live as of 2026-08-03: BXR explorer **10093959 / 10148478**, Indigo
  explorer **10092391 / 10148487**, payer rollup **10093971 / 10148488**.
  DEAD — every pairing returns INVALID CRITERIA: **10091971 / 10147530** (lost
  2026-07-31), the older **10147499**, and **10091828 / 10147241** (the payer
  pair, confirmed dead 2026-08-02 by `scripts/dryrun-cmd-payer-refresh.ts`).
  Retired but not dead: Indigo's **10147669** (a trailing 4-week window, replaced
  2026-08-02) and **10147602**. `10147499` survives only in a comment in the
  manual `cmdDailyBackfill.ts` CLI — that CLI's default is now `10148478`.
- `collections.cmd_payer_facility_monthly` now holds **two different
  populations**, and the seam is at 2026-06. Rows for 2026-05 and earlier came
  from the 2026-06-25 manual CSV ingest of the Derek History Report. Rows from
  2026-06 forward are written by `/api/cron/refresh-cmd-payer` (scheduled
  2026-08-03, daily 10:50) from report 10093971, whose filter windows on
  **payment date**, not service date. Measured live-vs-CSV coverage by service
  month decays monotonically — 2026-06 1202%, 2026-05 155%, 2026-04 123%,
  2026-03 60%, 2026-01 18%, 2025-12 3.6%, 2025-05 0.7% — which is the signature
  of a payment-date window, not a defect. The cron's 3-month trailing window
  never reaches 2026-05 or earlier, so the CSV history is never overwritten;
  expect a definitional step at the boundary in the "By Payer" chart.
- 10:50 was chosen for that cron so it cannot contend with the hourly CMD crons
  (:00/:15/:30/:35) for CMD's one-report-at-a-time partner slot. Probing during
  a :15 census on 2026-08-02 cost 13 BXR census fetches — they self-healed the
  next hour, but do not schedule CMD work near those minutes.
- ⚠ **This entry was itself stale until 2026-08-07.** It said
  `FUTURE_PAYMENT_HORIZON_DAYS = 0` and warned against flipping it to 14. It has
  been **14 and ACTIVE since 2026-08-03**, and flipping it was correct, because
  the precondition the warning named was met in the same change: the read-time
  split now exists (`futurePaymentBound`, `src/collections/daily.ts:65`), so
  **Collections bounds at `<= today` while Overview does not**, and both still
  read one row set through `collections.daily_collections_resolved`. Ingest keeps
  near-future rows deliberately. Setting the constant back to `0` remains the
  correct kill switch if forward-dated deposits turn out to be unreliable —
  nothing else needs reverting. The authoritative note is the docblock at
  `src/collections/cmdExplorer.ts:405-413`; trust it over this file.
- `src/collections/cmdExplorer.ts` says the row fingerprint hashes 14 fields — it
  hashes **18** (15 non-PHI + 3 PHI, see `mapReportRows`).
- `supabase/migrations/0067_*` looks applicable but is **stale**: as authored it
  drops 0068's covering index and 0069's MAINTAIN grant. Leave it alone.
- The agent still defaults to model `claude-opus-4-8` (`DEFAULT_MODEL`,
  `src/agent/agent.ts`). Flag before relying on it for new AI work.

<!-- Ground truth re-verified against HEAD d0f8635 (branch staging) on 2026-08-02:
     test counts run live (root 858, app 176; both typechecks clean), cron table
     read from app/vercel.json, nav from app/lib/nav-model.ts, roster sizes from
     src/collections/cmdCustomers.ts, report/filter ids from app/lib/server.ts,
     migration numbers from both migration directories, route status from the
     page stubs, and every Canonical Context Set path re-resolved. -->
