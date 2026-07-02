# Veris data notes — persistent tribal knowledge

Created by **S1 (Ground truth & ADR ratification, 2026-07-02)**. Every session
appends what it learned the hard way — join keys, field quirks, timings, live-DB
facts, ratified decisions (the §8.5.3 tribal-knowledge rule in docs/00-GUIDE.md).
Append under a dated session heading; never rewrite history — correct earlier
entries with a dated correction line, the way CLAUDE.md §17 corrected CO-45.

---

## S1 — Ground truth (2026-07-02)

### Repo & environment topology (confirmed by Alec)

- **Everything lives in this one repo** (`alec-treathealth/CMD-Billing-Dashboard`).
  There is no separate Veris repo. Veris assets: `SQL Schemas/` (migrations
  000–013 + `brain2_drift_query.sql` + `ops/`), `src/brain1/`
  (`feature_engineering.py`, `train.py`, `score_writer.py`), `src/brain2/`
  (`embed_carc.py`, `bocpd.py`), `src/brain3/` (`claim_embedder.py`,
  `hybrid_search.ts`), `src/agent/veris_agent.ts`, `src/public_data/`
  (CARC/RARC, CMS PFS, NPPES loaders), and the untracked 835 WIP
  (`src/ingest/era835Parser.ts`, `src/ingest/era_ingest.ts`,
  `test/era835.test.ts`, `SQL Schemas/013_era_835_adjustment.sql`).
- **ONE Supabase project only: `dbpabchpvipipkzkogta`** (`.env.example` labels it
  "project: cmd-billing-dashboard"). The Dashboard (`claims.*`, `collections.*`,
  VOB's `vob`/`rag`/`audit` + its 5 `ref.*` tables) and Veris (`staging.*` + the
  ML `ref.*` tables) share the cluster, **separated by schema + RLS only**, with
  a shared `claims_admin`/`claims_reader` role pair and a shared `ref` namespace.
  Isolation between the two products is logical, not physical.
- Pooler-host drift (non-blocking cleanup, ratified): `CMD_ROLLUP_WRITER_DATABASE_URL`
  uses `aws-0-us-west-1.pooler.supabase.com`; the other three DB URLs use
  `aws-1-…`. Same project; normalize someday.
- **There is no root CLAUDE.md and no separate Veris CLAUDE.md** — the canonical
  context file is `docs/CLAUDE.md`, and the S1 ADR lives there (§18). We are not
  creating a Veris-side CLAUDE.md (ratified).
- Veris migrations `009–012` were **deployed + verified live 2026-06-23**
  (docs/veris-runbook.md). `013_era_835_adjustment.sql` is untracked; its
  live-deployment state was **not** verified in S1 — verify before S8 assumes it.

### Migration numbering convention (RATIFIED)

- Dashboard migrations = `supabase/migrations/00NN_*`. Veris migrations =
  `SQL Schemas/0NN_*`. **Never the same directory; every future migration states
  which sequence it belongs to.** (The sequences collide numerically — e.g. both
  have an 0008: `0008_fix_collections_collection_rate` vs `008_brain2_drift_mv` —
  but never operationally.)
- Plan-name → actual-number mapping: the master plan's **`0013_rls_remediation`
  was never written** — 013 is now taken by `era_835_adjustment`, so **RLS
  remediation becomes `014` when S2 writes it**; the plan's **`0012_etl_backfill`**
  likewise takes the next free number when S3 writes it. **New Veris migrations
  start at 014.**

### Known schema corrections (build spec vs. reality — carry these forever)

1. `staging.claim_line` PK is **`id`**, not `claim_line_id`.
2. Service date is **`charge_from_date`**; there is **no `submission_date`**
   (procedure code is `cpt_code`, not `primary_cpt_code`; type-of-bill is
   `tob_raw` + decomposed `tob_*`).
3. **`claim_facility_id` is a CMD internal 8-digit id (e.g. `10272308`), NOT an
   NPI.** No facility→NPI crosswalk exists in the data; `nppes_loader.ts` is a
   no-op until a real NPI source is wired in.
4. **`outcome_class` is derived from `payment_residual.residual_type`**
   (0 CLEAN / 1 PARTIAL/ALLOWED_GAP / 2 BALANCE_DUE_INSURANCE / 3 MATH_GAP);
   `brain1_features.outcome` is text (`PAID/DENIED/PARTIAL/PENDING`).

### Live-DB verified answers (S1; read-only `psql` as `claims_reader`,
verify-full TLS, GUC = BXR entity, 2026-07-02)

- **3a — join key:** `SELECT COUNT(*) FROM staging.payment_residual pr JOIN
  staging.claim_line cl ON pr.claim_line_id = cl.id` → **57,486** — exactly the
  full `payment_residual` row count (57,486), i.e. **100% join coverage, zero
  orphans**. `claim_line` = **150,900** rows (matches runbook correction #1).
- **3b — `primary_payment_date` on `payment_residual`: NO.** Its only
  date-typed column is `calculated_at timestamptz`. Full live column list:
  `id bigint · business_entity_id uuid · claim_line_id bigint ·
  charge_debit_id text · billed, primary_paid, secondary_paid,
  insurance_adjustments, patient_adjustments, patient_balance,
  balance_due_insurance, residual, allowed_amount, allowed_gap (all
  numeric(12,2)) · residual_type text · dominant_carc text ·
  dominant_carc_category text · requires_review boolean ·
  calculated_at timestamptz · ingested_by text`. Adjudication-date windowing
  (Brain 2) comes from `claim_line.primary_payment_date`, not from
  `payment_residual`.
- **3c — hardcoded UUIDs in `008_brain2_drift_mv.sql`: NONE.** The MV groups by
  `business_entity_id` across all tenants (a matview refresh has no session
  GUC). Pre-tenant-#2 mitigation is documented in the file itself (lines 48–55):
  gate MV reads behind a `security_barrier` view filtering on the GUC, or read
  via `brain2_drift_query.sql`.
- **`core.business_entity` does NOT exist live** (checked via `pg_class`,
  grant-independent) → **S2 creates it**.
- **`collections.business_entities` (the 0027 registry) does NOT exist live** —
  0027 was drafted, never applied. (docs/CLAUDE.md §7/§15 describe the draft's
  content, not live state.)
- **`collections.cmd_explorer_rows.business_entity_id` DOES exist live:**
  `uuid NOT NULL DEFAULT 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'::uuid`, all
  **139,160** rows = BXR. `daily_collections` and `cmd_payer_facility_monthly`
  do **not** have the column. The committed 0019 has no such column → the
  untracked 0028 draft (or its ADD COLUMN portion) was applied via MCP in a
  lost prior session and never committed (the §17 provenance-warning pattern).

### 0028 live column — Alec's disposition (verbatim, 2026-07-02)

> "Option A: record-and-leave. Notes entry: known live drift, uncommitted
> provenance (§17 pattern), semantically correct — all 139,160 rows genuinely
> are BXR's. Whichever later session finalizes collections' tenancy stance
> reconciles it deliberately: either commit a migration matching live state or
> schedule the DROP. No action in S1."

### Tenancy ADR inputs (ratified by Alec, 2026-07-02 — full ADR in docs/CLAUDE.md §18)

> "Veris has exactly TWO data-bearing tenants in core.business_entity:
>   (a) BXR Consulting — the entity behind the existing claims book; the master
>       plan's 'Treat Health' seed row is named BXR Consulting when S2 creates
>       the table.
>   (b) Indigo Consulting.
> Plus ONE derived surface: 'Consolidated' — a read-only aggregation showing
> BXR Consulting + Indigo Consulting added together. Consolidated is NOT a
> tenant: it gets no business_entity_id, and no row is ever tagged to it —
> every row belongs to exactly one of the two real tenants. The cross-tenant
> aggregate read path is designed in S2 (schema) and access to it in S5 (auth);
> S1 only records this."
>
> "The STANDING DECISION stands for CMD-Billing-Dashboard: no
> business_entity_id in its schema. The untracked 0027/0028 drafts stay shelved
> and uncommitted."

Canonical tenant UUIDs (src/tenants.ts, currently untracked — commit in a later
code session): BXR Consulting `af504ab6-3dcd-4aa4-a93c-27bc58de4088` · Indigo
Consulting `141d459c-f371-4229-9a92-ace198e940bb`.

**Consolidated surface — NAMED AND GATED (Alec, verbatim, 2026-07-02, ratified
after the initial S1 docs commit — supersedes the placeholder name
"Consolidated" in the quote above):**

> "- The derived read-only aggregation across both tenants is named
>   'Treat Health' — the all-accounts view: BXR Consulting + Indigo
>   Consulting combined, all 56 CMD customers.
> - Access: SUPER ADMINS ONLY. No tenant-scoped user ever sees it.
>   S5 defines the super-admin role/claim mechanics; S2's RLS design
>   must support a super-admin cross-tenant read path WITHOUT
>   weakening tenant isolation for normal sessions (explicit policy
>   clause or security-definer layer — S2's design call, shown at
>   HOLD like everything else).
> - Hard guard: 'Treat Health' is NOT a tenant and must NEVER become a
>   core.business_entity row. The master plan's 'insert rows for Treat
>   Health and Indigo' language is superseded. Any future session
>   proposing a Treat Health entity row is re-opening the ADR and must
>   stop for me.
> - Disambiguation note: 'Treat Health' (the consolidated super-admin
>   surface) is distinct from the TREAT MENTAL HEALTH * facility
>   customers inside BXR's roster — those are 8-digit customers under
>   account 475729, nothing more."

### 4a — CMD account/customer numbers (Alec, verbatim, 2026-07-02)

**Terminology correction (supersedes the master plan):**

> "The 6-digit numbers are CMD ACCOUNT numbers and are the tenant key. The
> 8-digit numbers are CMD CUSTOMER numbers — facilities/legal entities WITHIN a
> tenant's account (CMD's own API schema carries both: AccountNumber vs
> CustomerNumber on VendorCustomer). This supersedes the master plan's 'tenant
> key is the 8-digit customer number' line."

`src/tenants.ts`'s `475729` (BXR) / `474623` (Indigo) are therefore **CONFIRMED
as account numbers**, not malformed customer numbers.

**BXR Consulting — CMD account 475729 — 20 customers:**

| Customer # | Name |
|---|---|
| 10030472 | BILLING SERVICE ACCOUNT |
| 10027973 | CA MENTAL HEALTH |
| 10033950 | DALLAS MENTAL HEALTH LLC |
| 10032340 | FIRST RESPONDERS OF CALIFORNIA LLC |
| 10035976 | HOUSTON MENTAL HEALTH |
| 10034908 | KENTUCKY WELLNESS CENTER |
| 10031977 | LONESTAR MENTAL HEALTH LLC |
| 10033690 | LOS ANGELES MENTAL HEALTH |
| 10030911 | NASHVILLE MENTAL HEALTH LLC |
| 10030471 | PACIFIC COAST MENTAL HEALTH LLC |
| 10035166 | TEEN MENTAL HEALTH TEXAS |
| 10034666 | TELEHEALTH MH |
| 10029105 | TENNESSEE BEHAVIORAL HEALTH |
| 10030101 | TREAT MENTAL HEALTH CALIFORNIA |
| 10035974 | TREAT MENTAL HEALTH COLORADO |
| 10034671 | TREAT MENTAL HEALTH NEVADA |
| 10029905 | TREAT MENTAL HEALTH TENNESSEE |
| 10029722 | TREAT MENTAL HEALTH TEXAS |
| 10031212 | TREAT MENTAL HEALTH WASHINGTON LLC |
| 10033951 | WELLNESS RECOVERY CENTER LLC |

**Indigo Consulting — CMD account 474623 — 36 customers:**

| Customer # | Name |
|---|---|
| 10026460 | 405 RECOVERY |
| 10029373 | ADDICTION FREE RECOVERY SERVICES |
| 10029528 | ADOLESCENT MENTAL HEALTH |
| 10025030 | BILLING SERVICE ACCOUNT |
| 10031413 | BRITE RECOVERY |
| 10028848 | CALIFORNIA TREATMENT COLLECTIVE |
| 10028842 | COVENANT HILLS TREATMENT CENTERS |
| 10021230 | CROWN VIEW CO-OCCURRING INSTITUTE - 612335 |
| 10023916 | CROWN VIEW PSYCHIATRIC INSTITUTE |
| 10020687 | HEALTHY LIFE RECOVERY |
| 10026624 | HILLSIDE HORIZON FOR TEENS |
| 10033859 | INTO THE LIGHT |
| 10032291 | KIN WELLNESS |
| 10030095 | KNOX RECOVERY |
| 10034063 | MAPSONG PC |
| 10024431 | MENTAL HEALTH CENTER OF SAN DIEGO |
| 10030319 | MENTAL HEALTH MODESTO |
| 10034979 | MENTAL HEALTH TREATMENT AND STABILIZATION CENTER OF SACRAMENTO |
| 10034230 | MY TEEN MENTAL HEALTH |
| 10026125 | MY TIME RECOVERY, LLC |
| 10033867 | NEW ORIGINS |
| 10034901 | NEXT FRONTIER RECOVERY |
| 10035913 | NORTHERN CALIFORNIA MENTAL HEALTH |
| 10021573 | OPUS HEALTH |
| 10031652 | ORANGE COUNTY MENTAL HEALTH |
| 10032612 | POSTPARTUM MENTAL HEALTH |
| 10035467 | RESTORED HOPE RECOVERY |
| 10028595 | REVIVAL MENTAL HEALTH |
| 10026159 | SADDLEBACK RECOVERY |
| 10028219 | SHINE MENTAL HEALTH |
| 10025950 | SILICON VALLEY RECOVERY, LLC |
| 10033531 | THE EDGE TREATMENT CENTER |
| 10033708 | THE FORGE RECOVERY CENTER |
| 10029219 | THRIVE MEDICAL SPECIALISTS |
| 10034039 | TREADSTONE SERVICES PC |
| 10031547 | VISALIA RECOVERY CENTER |

**Roster notes (record-only, per Alec):** BILLING SERVICE ACCOUNT appears under
BOTH accounts (10030472 / 10025030) — likely CMD service accounts; **S6 decides
include/exclude at ingest**. "CROWN VIEW CO-OCCURRING INSTITUTE - 612335" is
verbatim, suffix included (the two CROWN VIEW entries are distinct — never merge).

**S2 design intent this ratifies (Alec, verbatim — S2 owns the DDL):**

> "core.business_entity carries cmd_account_number (unique), and a child table
> (core.cmd_customer or similar) maps the 8-digit customer numbers many-to-one
> to business_entity_id. The master plan's single cmd_customer_number text
> column is superseded. Ingest (S6) iterates customer numbers within a tenant
> account, tags every row with the tenant's business_entity_id, and persists
> the source customer_number per row for facility-level attribution."

### Cron roster coverage check (S1, read-only)

The cmd-explorer cron polls **15** BXR customers (`CMD_EXPLORER_CUSTOMERS` =
`BXR_CUSTOMERS`); the confirmed BXR roster has **20**. The 5 not covered are
**deliberately excluded and documented in-file**
(`src/collections/cmdCustomers.ts`, "EXCLUDED on purpose" — empty/defunct, not
in `collections.facilities`; the saved filter isn't valid under three of them):
`10030472 BILLING SERVICE ACCOUNT · 10035976 HOUSTON MENTAL HEALTH ·
10035166 TEEN MENTAL HEALTH TEXAS · 10035974 TREAT MENTAL HEALTH COLORADO ·
10033951 WELLNESS RECOVERY CENTER LLC`. The other 15 match exactly. **No gap,
no config change needed**; if any excluded account becomes active, a dashboard
session adds its `collections.facilities` row + saved filter first (per the
file's own instructions). Note `cmdCustomers.ts` also already carries
`INDIGO_CUSTOMERS` (36, matching the confirmed roster) and `ALL_CMD_CUSTOMERS`
for the staging/835 path — the explorer cron stays pinned to BXR's 15.

### 4b — Brain-gating thresholds (Alec, verbatim)

> "YES: gating is per-tenant × per-brain, confirmed. Numeric thresholds are NOT
> set yet — record as an open thread that blocks S6 (feature flags), not S2."

### 4c — Treat/BXR ingest path (Alec, verbatim — feeds the ADR)

> "Yes, and the build is already complete: BXR's ingest runs on the CMD Web API
> path today (the cmd-explorer cron you verified this morning). No Sheets
> migration remains in this build."

Open design note for S6, recorded without answering (Alec): whether Veris's
`staging.*` ingest reuses cmd-explorer plumbing or stands up the master plan's
per-tenant job.

### 4d — Indigo BAA/DPA (Alec, verbatim)

> "Yes to both: the Indigo BAA/DPA is signed AND pooled de-identified
> cross-tenant training is covered. PG-B still re-verifies the two clauses
> separately before any real Indigo row lands."

### 4e — core.business_entity (Alec, verbatim + S1 live verification)

> "Confirmed: S2 creates core.business_entity; id is uuid PK. Seed the two
> tenant rows with the canonical UUIDs already in src/tenants.ts — BXR's UUID
> is already live as the column default across 139,160 cmd_explorer_rows, so a
> freshly minted UUID would orphan production data."

**Reconciliation constraint S2 must honor:** seed with the canonical UUIDs
above — never mint new ones. `src/tenants.ts` to be committed in a later code
session.

### ssl.ts verification record (S1 — item 2, VERIFIED end-to-end)

- Four-path ladder confirmed in `src/ssl.ts` exactly as specified:
  `SUPABASE_CA_PEM` env → `SUPABASE_CA_PATH` env → `process.cwd()/certs/
  supabase-ca.crt` → `fileURLToPath` bundled fallback; each file path tried
  independently in try/catch; throws only when exhausted; success log is
  label-only (never PEM content). `verifyFullSsl()` = `rejectUnauthorized:
  true` (typed literal) + Node default hostname check; zero
  `rejectUnauthorized: false` in project source; `sanitizeConnectionString`
  strips `sslmode`/`ssl*` params so a URL can't drop the CA. All pools in the
  repo route through the three factories that apply it. CA bundle = Supabase
  Root **+ Intermediate** 2021 CAs (2 certs).
- Provenance: all six TLS commits in `origin/main`; `src/ssl.ts` + `certs/`
  clean; local HEAD == `origin/main` == deployed prod SHA (`d3c3023` at S1
  verification time; main advanced to `05dff43` later the same day).
- Runtime: prod cron runs log `ssl: loaded CA from SUPABASE_CA_PEM env var`;
  **zero TLS errors since 2026-06-29** (pre-fix `self-signed certificate`
  errors end there). `SUPABASE_CA_PEM` set in all three Vercel envs
  (names-only check). **Not blocking any session.**
- **Future-session line item:** the `supabaseCa()` ladder has NO unit tests
  (`test/ssl.test.ts` covers only `sanitizeConnectionString`); module-level
  cache makes it awkward to test — add a reset hook + ladder tests cheaply.

### Watch items (S1, recorded per Alec — no action taken)

- **Zero-row scheduled cron run 2026-07-02 06:00 UTC:** all 15 customers
  returned "SUCCESS with no data" (normal pattern: 2/15 with data, 13 empty —
  the 13-empty pattern is EXPECTED, not a bug). TLS/DB were fine; CMD-side.
  Alec re-triggers manually — do NOT auto-retrigger. Same-day parallel
  dashboard-session record attributes it to a SUCCESS-empty poll race (fixed
  with an empty-grace check; explorer filter now **10147530**, rolling
  current-month — committed as `c6f3fe0`; note docs/CLAUDE.md §7 still says
  10147499 and needs a dashboard-session doc update). Cron cadence is now
  **HOURLY** (`0 * * * *`, commit `05dff43` — §7's "daily 06:00" prose is
  likewise stale). Verify at the next top-of-hour run.
- **`POSTGRES_*` / `SUPABASE_JWT_SECRET` / `SUPABASE_ANON_KEY` env vars synced
  onto Vercel Production 2026-07-02** (Supabase↔Vercel integration). Nothing
  reads them yet; awareness item given the "never put sslmode in DB URLs" rule
  if anything ever picks up `POSTGRES_URL`.
- `aws-0` vs `aws-1` pooler-host normalization (above) — non-blocking.

### Open threads out of S1 (carry in every handoff until closed)

1. **4b numeric thresholds** (per-tenant × per-brain) — unset; **blocks S6**
   (feature flags), not S2.
2. `src/tenants.ts` untracked — commit in a later code session (S2 or S3).
3. S6 design decision: reuse cmd-explorer plumbing for `staging.*` ingest vs.
   per-tenant job (recorded, unanswered).
4. `013_era_835_adjustment.sql` live-deployment state unverified (S8 concern).
5. `supabaseCa()` ladder unit tests (above).
