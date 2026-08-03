# Qualify v2 — Morning Runbook (2026-08-03 overnight build)

Branch **`feat/qualify-v2`** in the worktree `/Users/aleclowi/CMD-qualify-v2-worktree`
(base `staging@780f979`). Seven commits, 53 files, +6,033/−170. **Nothing outward-facing
happened overnight**: no push, no PR, no `apply_migration`, no env changes, no cron
scheduling, no `QUALIFY_MAINTENANCE` flip. Everything below is the ordered checklist to
take it live. The main tree at `~/CMD-Billing-Dashboard` was never touched (the other
session's `server.ts`/`actions.ts` work is unaffected).

## What shipped (all committed, all gates green)

| Commit | What |
|---|---|
| `048e3b0` | Data layer: rating v2 engine (5 factors 30/25/20/15/10, IQ bands 65/50/30/15/0), prefix→policy resolution + comparable cohorts + provenance, auto-window ladder (one bucketed query), coding registry (queries, seed parser, migration 0077) |
| `8267a3a` | Desktop surface: IQ scorecards + WeightBar/FactorList, policy strip (3-way network gate), window ladder cards, registry CRUD page (super_admin, three degraded states) |
| `43bc342` | Data-layer review findings 2–14 fixed + prod EXPLAIN evidence (90d comparable clamp: 17.3s → 320ms) |
| `e1ade77` | Streaming AI explainer: strict-zod firewall (zero dollar fields for every role, no employer, no identifiers), server-side blind override, audit-before-call |
| `f846541` | monday census aggregates (Phase G): migration 0078, title-based column resolution, patient names never fetched, cron route (deliberately unscheduled), manual runner |
| `6c44a06` | Mobile parity: IQ-band cards, compact policy line, comparable cohort no longer swallowed by `resolved:null` |
| `09254d6` | Surface-review findings fixed: ladder persistence, lossless supersede, AI token budget + refusal handling + stream cancellation, census Central-time `today` |

Verification gate at HEAD: root **1009/0** + tsc 0 · app **192/0** + tsc 0 · `next build` green.
(Baselines were 889/176 — counts grew, none lost.) Two review loops ran (data layer, then
UI/AI/census/mobile): 1 Critical (fixed same night) + 20 Important/Minor fixed, 2 declined
with reasoning in the commit messages.

## Step 1 — Apply the two migrations (product plane)

Via `apply_migration` (merging the PR does **not** apply them — 0056 incident class):

1. `supabase/migrations/0077_coding_decision_registry.sql` — `coding` schema,
   `code_decision` + append-only audit, `coding_editor` NOLOGIN role, RLS, column-level
   UPDATE grant (`effective_to`, `superseded_by` only).
2. `supabase/migrations/0078_qualify_facility_census.sql` — `collections.qualify_facility_census`,
   `cmd_rollup_writer` RW + readers RO.

Each file ends with a **manual verification block** — run it after applying (policy counts,
grants, zero rows). Rollbacks sit alongside (`*_rollback.sql`). Until applied, the app is
already safe: every read fail-softs on `42P01` (registry page shows "not live yet", census
factor is simply unavailable).

## Step 2 — Registry writer credentials

Out-of-band (never in a migration file):

```sql
alter role coding_editor login password '<generate>';
```

Then set `CODING_WRITER_DB_URL` (Supavisor **6543** transaction-pooler URL, user
`coding_editor`, **no `sslmode` param** — it silently drops the CA) in Vercel (all envs)
and `app/.env.local`. Until set, the registry page renders read-only with an explicit
notice — that's the designed degraded state, not a bug.

## Step 3 — Seed the coding registry

Overnight Drive reads were blocked by the permission classifier, so the seed is a
paste-driven importer instead of a Drive pull:

1. Reconcile the two drifted tabs of the coding sheet into one matrix (they disagree on a
   handful of rows; the parser will name defects it can't reconcile — e.g. the `0714/2026`
   date and `STILL PENDING` lifecycle it doesn't recognize).
2. Export/paste as TSV matching `scripts/seed/coding-decisions.template.tsv`.
3. Dry-run first (default), then:

```bash
npx tsx scripts/seed-coding-decisions.ts <matrix.tsv> --apply --actor alec@treathealth.ai
```

Transactional; aborts if the table is non-empty unless `--append`. Until seeded, the
coding factor reports "unavailable" and the rating renormalizes over the other factors —
scores are honest, just coarser.

## Step 4 — monday census (deliberately NOT scheduled)

The cron route exists (`/api/cron/qualify-census`) but is **not in `vercel.json`** — three
reasons documented in the route header: the cron-surface standing rule, the token is
Alec's personal admin key (least-privilege gap), and quiet-window placement deserves a
human look. Order of operations:

1. Provision a **read-only monday service identity**; put its token in
   `MONDAY_SECRET_API_KEY` (Vercel + local). Retire the personal key from app use.
2. Map more boards: `npx tsx scripts/run-qualify-census.ts --discover` lists the
   ~27 workspace boards; add rows to `MONDAY_CENSUS_BOARDS` in
   `src/collections/qualifyCensus.ts` (board id + facility code + family). Only Nashville
   (10030911) and Lonestar (10031977) are curated today. When onboarding a board, eyeball
   its Admit Status label vocabulary — aggregation counts exactly `Admitted` and
   `Open Bed (…)`; a board using `Active` would silently count zero (review finding #10,
   consciously not auto-detected yet).
3. Manual sync works today: `npx tsx scripts/run-qualify-census.ts` (needs
   `CMD_ROLLUP_WRITER_DATABASE_URL` + the monday token; 0078 applied first).
4. Scheduling it in `vercel.json` is a **separate, explicitly-scoped session** per the
   standing rule. Pick a `:41–:59` slot (CMD partner-slot contention notes) — though this
   cron talks to monday, not CMD, so the constraint is soft.

## Step 5 — AI explainer env

`ANTHROPIC_API_KEY` is already in Vercel (collections AI panel uses it). Optional:
`QUALIFY_AI_MODEL` pins this surface independently (falls back
`ANTHROPIC_MODEL` → `claude-opus-5`). Note the repo agent's `DEFAULT_MODEL` is still the
stale `claude-opus-4-8` — untouched, flagged in CLAUDE.md.

## Step 6 — Push, PR, deploy

```bash
cd /Users/aleclowi/CMD-qualify-v2-worktree
git push -u origin feat/qualify-v2
gh pr create --base staging --title "Qualify v2 — full-stack rebuild (rating v2, policy, ladder, registry, AI, census, mobile)"
```

`staging`, never `main`. After the eventual deploy, spot-check the next hourly
collections cron run logs per the standing rule (this branch doesn't touch them, but the
rule is cheap insurance). `QUALIFY_MAINTENANCE` flip stays a human decision after the
browser pass.

## Browser pass — what to eyeball

- Prefix search: policy strip chips, ladder cards (should **persist** after the surface
  re-windows — that was review finding #1), scorecard expansion, AI panel streaming.
- A prefix with **zero own claims** but a VOB on file: the ESTIMATED path (amber banner,
  comparable cohort, desktop + mobile).
- `admissions_seat` (or any non-amounts role): identical bands/factors, no dollars
  anywhere including the AI text (the blind-parity invariant is wire-tested, but see it).
- Registry (`/qualify/registry`): create → supersede (verify DRG/condition codes survive —
  finding #2), the three degraded states as you progress steps 1–3.
- Mobile `/qualify/m`: IQ cards, compact policy line, estimated cohort list.

## Known deviations & judgment calls (also in commit messages)

- **Phase F demoted**: TTP ships from the rollup (`charge_date`→`payment_received`), no
  `claim_line_features` backfill.
- **Phase G reshaped**: facility-grain aggregates, zero PHI at rest — the plan's
  name-hashing became name-never-fetched (pinned by a hermetic query-string test).
- **Comparable market**: `comparable:state+funding` degraded to employer→funding (no state
  column on `member_benefits_latest`).
- **Ladder is desktop-only**; mobile keeps its shipped manual window selector.
- **Phase D network extraction** (INN/OON from VOB PDFs) is cross-repo `etl/vob` work —
  three parser generations + ~10% UNRECOGNIZED rows; the UI's null path ("network not
  captured on this VOB") is the shipped truth until then.
- **Registry editing is super_admin-only** today; widening is a one-line change in
  `app/lib/qualify/principal.ts` (`requireRegistryEditorFromAccess`).
- **Declined**: db.ts `application_name` tagging (shared-pool blast radius — future
  db.ts-owned change); census unknown-label counter (vocabulary not enumerable yet);
  `dos_batch` field-level form feedback (sole-editor surface) — revisit when the billing
  team takes over the registry.
- **RAG/payer-intel factor** (the other session's pgvector pipeline): the factor array
  renormalizes over available weights by construction, so a sixth factor slots in without
  rescaling — extension point, nothing wired.
