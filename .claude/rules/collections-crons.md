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

Rosters live in `src/collections/cmdCustomers.ts`: **BXR = 15**, **Indigo = 32**.
Code comments claiming 36 or 37 Indigo customers are stale — do not propagate.

## Report and filter ids

The live BXR explorer cron uses report `10091971` / filter **`10147530`**
(`app/lib/server.ts`), a rolling current-month window. Indigo uses report
`10092391` / filter `10147669`.

Filter `10147499` appears in `src/collections/cmdExplorer.ts` comments and in the
manual `cmdDailyBackfill.ts` CLI default — it is **not** what the live cron runs.

The filter **must** window on *payment-received* date, not charge date. A
charge-date filter drops 2026 payments on pre-2026 charges and undercounts
collections by roughly $6.9M. Report/filter/poll are tunable via `CMD_EXPLORER_*`
env vars.

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
