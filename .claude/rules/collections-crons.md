---
paths:
  - "src/collections/**"
  - "app/app/api/cron/**"
  - "app/vercel.json"
  - ".github/workflows/**"
---

# Collections domain and the CMD crons

**This is the production-critical ingest path.** Do not modify a cron route,
schedule, Vercel env var, writer grant, or a `collections.*` table it writes
unless the session is explicitly scoped to that work. After any push that
deploys, verify the next scheduled run logs success before proposing more work.

## The CMD API shape

The CMD (CollaborateMD) Web API scopes data **by customer** — one customer is
one facility — so every cron loops a roster and polls **sequentially** (CMD
allows one report at a time per partner). Each cron carries a wall-clock guard;
unfinished customers are picked up next run, which is safe because every writer
is idempotent. `maxDuration = 300` (needs Vercel Pro+).

Rosters live in `src/collections/cmdCustomers.ts`: **BXR = 15 active**,
**Indigo = 29 active** (32 in the file; 3 retired — MADISON and MISSOURI BH
2026-08-02, RESTORED HOPE 2026-08-06). Prose counts rot fast — this file said
32, CLAUDE.md said 30, and code comments say 36/37; count `INDIGO_CUSTOMERS`.

**`customers 0/15 (… fresh-skipped 15)` in a census cron log is HEALTHY.** The
census crons run hourly but re-pull a customer only once its data crosses the
staleness threshold (`isCustomerFresh` in `cmdCensusCron.ts`), so most runs
process nobody and the log line leads with `0/15`. Read the `fresh-skipped` and
`failed` fields — and `collections.etl_run` — before calling it an outage.
(Exactly this misread triggered a 2026-08-21 investigation; the explorer and
census were both healthy throughout.)

## Report and filter ids

⚠ Never trust prose for the live ids — not even this file's (until 2026-08-21
it named `10091971`/`10147530` as live, a pairing that died 2026-07-31). The
live pair is the env var when set, else the code fallback in `app/lib/server.ts`.

Since **2026-08-15** the BXR explorer pair is set by **sensitive** Vercel env
vars (`CMD_EXPLORER_REPORT_ID` / `CMD_EXPLORER_FILTER_ID`) whose values cannot
be read back — `vercel env pull` prints `[SENSITIVE]` even on the latest CLI.
Verify which report is live from the DATA, not the env: the employer-bearing
report (10094775 family) shows up as fresh `cmd_explorer_rows` carrying
`employer_name` (2026-08-21: 660 of 662 new BXR rows), which the old 10093959
projection cannot produce. `bxrExpectedColumnsFor()` keys the header contract
off the same env var, so report and column contract move together.

Code fallbacks, used only when the env var is unset or empty:

- BXR explorer — report `10093959` / filter `10148478` (`cmdExplorerConfigFor`)
- Indigo explorer — report `10092391` / filter `10148487`
  (`CMD_INDIGO_REPORT_ID` / `CMD_INDIGO_FILTER_ID`, `cmdIndigoConfigFor`)
- The census crons run SEPARATE, env-REQUIRED pairs with **no fallback**:
  `CMD_BXR_CENSUS_REPORT_ID` / `CMD_BXR_CENSUS_FILTER_ID` and
  `CMD_INDIGO_CENSUS_FILTER_ID`.

Filter `10147499` appears in `src/collections/cmdExplorer.ts` comments and in the
manual `cmdDailyBackfill.ts` CLI — it is **not** what the live cron runs.

**`10148862` and `10148863` are CANDIDATE filters that no code path uses.**
`10148862` is the intended one-shot *backfill* window (Alec's note: the only way
the ~$16.3M gap closes) and appears in this repo solely as a usage example at
`scripts/probe-cmd-filter.ts:4`; `10148863` is a candidate *census* filter and
appears **nowhere in the repo at all**. Neither is a live pairing, so do not cite
either as one.

⚠ **A 0-rows result from probing a candidate filter is NOT a production
incident.** The open note "census filter 10148863 returns 0 rows for LSMH +
NASH" describes a filter production does not run. Measured against
`collections.cmd_census_run` on 2026-08-24, the live BXR census pulled **LSMH
(10031977) and NASH (10030911) successfully every day for 10 days** — 1,434→1,568
and 2,633→2,925 `rows_seen`, `status='ok'`, zero failures, alongside all 13 other
BXR accounts. So that finding is a **pre-cutover defect in the replacement
filter**, and cutting over to `10148863` would BREAK two healthy facilities.
Fix its criteria in CMD before it is ever wired, and re-probe the whole roster.

The filter **must** window on *payment-received* date, not charge date. A
charge-date filter drops 2026 payments on pre-2026 charges and undercounts
collections by roughly $6.9M.

## Writers

- Charge lines → `collections.cmd_explorer_rows`, append-only
  `ON CONFLICT (row_fingerprint)`. The fingerprint hashes **18** fields (a
  comment saying 14 is stale).
- Check + EFT aggregated by payment-received date → `collections.daily_collections`
  via `replaceCmdDailyForFacility` — a **per-facility** DELETE + INSERT, so a
  partial run never wipes another facility's data.
- All of it writes as the least-privilege `cmd_rollup_writer` role.

`daily_collections_resolved` (max-gross-wins) sits over the raw dailies and is
unchanged by any of this — only writers changed.

## The frozen legacy ingest

`src/collections/ingest.ts` (Google-Sheet workbooks → `payment_lines` /
`negotiation_worklist` / `rollup_snapshots` + `source_tag='workbook'` dailies) is
a **frozen manual CLI**: unscheduled, not aliased in `package.json`, dry-run
unless `--commit`. Its existing 2026 rows are deliberately retained.

**Never re-run the workbook ingest for a period CMD covers** — max-gross-wins
would let a stale legacy import override the authoritative CMD figures. Treat it
as a historical backfill tool only.

## PHI handling in this layer

- Three identifiers are libsodium-encrypted at rest (`phiCrypto.ts`). They are
  never features, never logged, never in an error message.
- Searchable PHI goes through **keyed-HMAC blind indexes** (`blindIndex.ts`,
  `INDEX_HMAC_KEY`). That key **must** stay distinct from `LIBSODIUM_KEY` — a
  leak of one must not compromise the other. The HMAC token is not PHI; the
  *input* is.
- Reads are tenant-scoped through `entityScope.ts`. `assertEntityScope()` throws
  on an empty or malformed scope rather than reading — an empty scope must never
  silently return every tenant's rows.
- `collections_raw` is PHI-bearing and admin-only. `claims_reader` has no SELECT
  on it. Read-side features use the typed tables.

## Lineage rule (locked)

`TREAT_FRCA` and `LSMH_DMH` are `source_group_code` **lineage only** — never a
`facility_code`.

## TLS

Never put `sslmode` in a DB URL; it silently drops the CA and defeats
verify-full. `src/ssl.ts` resolves the CA through a fallback ladder
(`SUPABASE_CA_PEM` → `SUPABASE_CA_PATH` → `cwd()/certs/supabase-ca.crt` →
`import.meta.url`-relative). The bundle is the public Supabase Root **plus
Intermediate** 2021 CAs — a root-only PEM does not anchor the Supavisor chain.

## VOB sync is a GitHub Action

`/api/cron/vob-sync` is scheduled by Vercel, but the work runs in
`.github/workflows/vob-sync.yml` via `workflow_dispatch`. There is deliberately
**no `schedule:` trigger** there — adding one double-fires. Output will not
appear in the Vercel cron UI. Health lives in `vob.sync_state`.

In CI (no CA file) the sync script transparently downgrades to `sslmode=require`.
To keep full verification, set `SUPABASE_CA_PATH`.
