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

---

## S2 — Tenancy foundation & isolation test (2026-07-02)

### Live-state verified (S2, read-only; `claims_reader` + GUC, verify-full TLS)

- **`core` schema does NOT exist** (only `collections`/`staging`/`ref`) → 014 creates it.
- **Every tenant-scoped `business_entity_id` column is `uuid NOT NULL`** — all 9
  `staging.*` tables + `collections.cmd_explorer_rows` (default `'af504ab6…'::uuid`,
  the recorded 0028 drift). **No `ref.*` table has `business_entity_id`** (ref is
  global). ⟹ **`core.business_entity.id` MUST be `uuid PK`**, seeded verbatim (no
  `gen_random_uuid()` default). `pgcrypto`/`uuid-ossp`/`vector` present.
- **The staging tenancy layer is already 90% built** (migrations 001/005/010/011/012):
  every staging table already has `business_entity_id uuid NOT NULL` + RLS enabled +
  (mostly) tenant-leading indexes. **The real gaps: (a) NO FK to `core.business_entity`
  (zero FKs reference core, zero FKs on any staging beid); (b) all 9 RLS policies are
  `cmd=ALL`, `USING`-only, NO `WITH CHECK`.** So the master plan's "add business_entity_id
  + backfill + NOT NULL" is a no-op; S2's staging work is FK + WITH CHECK + index-leadership.
- **Master plan table list was incomplete** — it omitted `staging.payer_dim` and
  `staging.era_adjustment` (both tenant-scoped; S2 includes all 9).
- **Tenant data is BXR-only** (RLS-scoped counts): claim_line 150,900 · payment_residual
  57,486 · payer_dim 286 · era_adjustment 65,615 · brain1_features 64,346;
  brain1_scores/brain2_alerts/claim_signatures/appeal_evidence = 0. Indigo = 0 everywhere.
  ⟹ FK ADD is safe once BXR is seeded (016 still carries an owner-run orphan pre-flight guard).
- **12 ungated `ref.*` tables** (RLS disabled): the master plan's six
  (`payer_alias, payers, plans, service_codes, diagnosis_codes, denial_codes`) PLUS
  `carc_code, rarc_code, cms_pfs_rate, nppes_provider, carc_embeddings, rarc_embeddings`
  (from committed 009/011). Only `ref.remittance_code` is gated. **None are tenant-scoped**
  (global X12/CMS/NPPES/payer data) → remediation = enable RLS + `FOR SELECT USING(true)`,
  never a tenancy column.
- **§17 DRIFT — 5 undocumented ref tables** (`payers`, `plans`, `service_codes`,
  `diagnosis_codes`, `denial_codes`): owner=`postgres`, ~empty, in **no committed
  migration** (same provenance pattern as the 0028 column). Columns are simple
  reference/dimension data (no `business_entity_id`). **Record-and-leave** (no drop);
  015 reassigns them to `claims_admin` + gates them. `veris-runbook.md` §50 already
  flagged these six as RLS-disabled and left them "decide separately" — S2 decides.
- **Apply path = `apply_migration` (postgres/superuser level)** (per veris-runbook.md).
  ⟹ `ALTER TABLE … OWNER TO claims_admin` on the 5 postgres-owned drift tables WILL
  succeed. 015's header records this postgres-apply exception deliberately.
- **GUC drift**: `veris_agent.ts:62` + `hybrid_search.ts:45` use `set_config(…, false)`
  (SESSION-scoped) on dedicated short-lived connections — safe today, fragile on the
  Supavisor pool. veris-runbook.md §96 states the intended standard is transaction-local
  `set_config(…, true)`. S2's `withTenant` restores that standard.

### S2 gate rulings (Alec, verbatim intent, 2026-07-02)

- **014 APPROVED after two amendments** (applied): (1) rollback carries an ACTIVE guard
  that queries `pg_constraint` for FKs referencing `core.business_entity` and RAISEs
  naming offenders — a comment is not a guard. (2) Seed fails LOUD on identity mismatch:
  `business_entity` conflict target is `(id)` only, same-account-different-uuid or
  same-uuid-different-account RAISEs (never silent DO UPDATE); `cmd_customer` tenant
  binding is immutable — a customer number under the wrong tenant RAISEs, only
  `customer_name` may update on a matching-tenant re-run. Implemented via temp-table +
  guard DO-blocks.
- **019 ROADMAP CORRECTION — NO `BYPASSRLS`.** BYPASSRLS ignores every RLS policy on
  every table the role can ever see (incl. future tables); a later `GRANT SELECT` would
  silently widen the cross-tenant surface with zero diff on the function. The bypass must
  be **enumerable per-table**: `consolidated_reader` is NOLOGIN, **no BYPASSRLS, no write
  grants**; on ONLY the tables `core.consolidated_summary()` reads → `GRANT SELECT` +
  explicit `CREATE POLICY … FOR SELECT TO consolidated_reader USING (true)`. Definer fn
  owned by `consolidated_reader`, `search_path` pinned `pg_catalog` first, fixed SQL,
  EXECUTE to nobody (S5 grants), aggregate-only PHI-denylisted return. `isolationProbe.ts`
  asserts `consolidated_reader` is denied / sees zero rows on any staging table NOT in the
  fn's enumerated read set.
- **CADENCE — modified write-all:** (1) amend 014 → show → apply; (2) write 015 → show →
  apply, then run the read-only ungated-ref-table count — **must be ZERO**; this closes the
  master plan's original `0013_rls_remediation` thread completely; (3) THEN write 016–019 +
  `src/veris/withTenant.ts` + `veris_agent.ts`/`hybrid_search.ts` refactors + hermetic
  tests + `isolationProbe.ts` as ONE reviewable bundle against verified live state; apply in
  order, HOLD before each apply.
- **HARD SEQUENCING GUARD:** the `withTenant` refactor must be **committed, pushed, AND
  verified running on the production deployment BEFORE 017 applies.** 017 is the moment
  session-scoped GUCs become an active cross-tenant leak vector on the transaction pooler,
  and code ships slower than SQL. If ordering gets tight, **017 waits. No exceptions.**
- **`withTenant` implementation constraints:** single-client discipline — one `pool.connect()`,
  `BEGIN` → `set_config('app.business_entity_id', $1, true)` → callback queries on that SAME
  client → `COMMIT`; `ROLLBACK`+`release` in finally. **Never `pool.query()` inside** (each
  can land on a different pooled connection, escaping the txn). GUC name is a fixed literal;
  only the value is parameterized. **No network calls inside the txn** — `veris_agent.ts` must
  never hold a txn open across an Anthropic call/tool turn; one `withTenant` per query batch,
  never per agent loop. `isolationProbe.ts` asserts that after COMMIT
  `current_setting('app.business_entity_id', true)` is empty (tests the pooler-leak class).

### APPLY-PATH PRIVILEGE NOTE (deliberate, dated 2026-07-03)

- **`apply_migration` runs as `postgres`, which on this project is NOT a superuser**
  (`rolsuper=false`). It was a MEMBER of `claims_admin` with `admin_option=true` but
  **`set_option=false`** — so under the Postgres 16 membership split it could NOT
  `SET ROLE claims_admin`, and `ALTER … OWNER TO claims_admin` / `SET ROLE` both failed
  `42501`. The first 014 apply hit this on `ALTER TABLE … OWNER TO claims_admin` and
  **rolled back whole** (apply_migration is transactional — verified `core` absent after).
- **Fix (Alec-approved, STANDING — do not revoke):** `GRANT claims_admin TO postgres
  WITH SET TRUE;` (within postgres's existing `admin_option`). Verified
  `pg_has_role('postgres','claims_admin','SET') = true`. **This is the intended apply
  posture**: apply path = `postgres` with SET-capable membership in `claims_admin`; new
  objects are **born owned** via `SET ROLE claims_admin` at the top of each migration +
  `RESET ROLE` at the end (cleaner than post-hoc ALTER OWNER, and doesn't skip
  already-existing objects the way IF NOT EXISTS would). Revoking reintroduces this exact
  failure — leave it. (`pg_auth_members` shows 2 postgres→claims_admin rows from
  multiple grantors; harmless.)
- **015 is mixed-mode:** the 5 postgres-owned drift tables' `ALTER … OWNER TO
  claims_admin` run AS postgres (only the current owner can transfer; the grant makes the
  transfer target valid); all NEW objects/policies follow the born-owned `SET ROLE` pattern.

### OWNERSHIP CENSUS (read-only, 2026-07-03) — for 016–018 (ALTER requires ownership)

- **`staging.*` — all 9 owned by `claims_admin`** (appeal_evidence, brain1_features,
  brain1_scores, brain2_alerts, claim_line, claim_signatures, era_adjustment, payer_dim,
  payment_residual). 016/017/018 ALTER them via `SET ROLE claims_admin`. No surprise.
- **`ref.*`**: `claims_admin` owns 8 (carc_code, carc_embeddings, cms_pfs_rate,
  nppes_provider, payer_alias, rarc_code, rarc_embeddings, remittance_code);
  **`postgres` owns 5** (denial_codes, diagnosis_codes, payers, plans, service_codes) —
  the §17 drift tables 015 reassigns.
- **`core.*`** (new): business_entity + cmd_customer owned by claims_admin.

### 015 pre-apply preflight (2026-07-05) — writer inventory, ACL snapshot, apply probe

- **§2 no-dynamic-SQL scope (ratified):** that rule governs the app/query/ETL path
  (parameterized runtime queries), NOT fixed-list migration DDL. 015's `DO`-loop over a
  hardcoded table array using `format(%I)` is allowed — no external input.
- **CORRECTION to the S2 "5 drift tables" entry above:** `ref.payers/plans/service_codes/
  diagnosis_codes/denial_codes` are **NOT lost-container drift** — they are the **VOB
  FOUNDATION** tables created by `supabase/migrations/0010_vob_ai_foundation.sql`
  (CLAUDE.md §12; runbook §50/§63). They are owner=postgres only because 0010 (unlike
  009/011) never ran `ALTER OWNER`. The earlier "undocumented / no committed migration"
  characterization was from not having read 0010 (a dashboard-sequence file) at that point.
- **ref.* writer inventory (BLOCKING check — GREEN):** all code writers to the 12 tables
  connect as **`claims_admin`** (`CLAIMS_ADMIN_DATABASE_URL`): loaders
  `carc_rarc_refresh.ts` (carc_code/rarc_code), `cms_pfs_loader.ts` (cms_pfs_rate),
  `nppes_loader.ts` (nppes_provider), `embed_carc.py` (carc/rarc_embeddings + carc_code
  update), and the 005 seed (payer_alias). The 5 VOB tables have **zero** writers in code
  (§12 groundwork). Post-015, claims_admin OWNS all 12 → bypasses RLS → every writer
  survives. **No writer on claims_reader or any non-owner role; no lockout.**
- **write-activity (pg_stat_user_tables):** only `payer_alias` has writes (262 ins = seed);
  the other 11 are empty (0 ins/upd/del) — matches "deployed empty" (runbook) + VOB groundwork.
- **ACL snapshot (rollback restore target):** 7 claims_admin tables =
  `claims_admin=arwdDxtm` (owner) + `claims_reader=r`. 5 VOB tables = `postgres=arwdDxtm`
  (owner) + `claims_reader=r` + **`claims_admin=arw`** (INSERT/SELECT/UPDATE, from 0010).
  ⟹ 015 rollback FIXED: it must NOT revoke the 5's claims_reader SELECT (pre-dates 015);
  rollback returns owner→postgres and re-asserts the 0010 grants. All 12 RLS=false pre-015.
- **apply-path probe (reversible):** `SET ROLE claims_admin; COMMENT ON TABLE
  ref.payer_alias IS '…'; RESET ROLE` succeeded as postgres, then restored to NULL. Proves
  apply_migration (postgres + SET-capable claims_admin membership) can touch `ref.*` — the
  same mechanism 015 §2 uses. No execute_sql fallback needed.
- **anon/authenticated/service_role/PUBLIC:** 0010 revoked all on schema `ref`; 015's
  read-all `USING(true)` does not widen exposure (those roles hold no table privilege).

### 015 — APPLIED + VERIFIED (2026-07-05)

`SQL Schemas/015_ref_rls_remediation.sql` applied via apply_migration. Post-apply:
**ungated ref tables = 0** (closes the master plan's `0013_rls_remediation` thread
completely); all **5 VOB tables now owner=claims_admin**; **13** `*_read_all` policies in
`ref` (12 from 015 + the pre-existing `remittance_code_read_all` from 001);
`claims_reader` SELECT true on all 12; anon/authenticated **cannot** read (0010 schema
revoke holds). Rollback re-asserts 0010 grants (does not revoke). Every ref.* writer is
claims_admin (owner → RLS-bypass) — no lockout.

### S2 bundle pre-flight (2026-07-05, read-only as claims_reader + GUC, verify-full TLS)

Grounds the 016–019 + withTenant bundle (authored this date, NOT yet applied):

- **016 orphan pre-flight — GREEN on all 9 staging tables:** (a) every table has
  `business_entity_id`; (b) NULL count = 0 **by validated constraint** (catalog
  `attnotnull = t` on all 9 — definitive, grant-independent); (c) distinct values ⊆
  the two ratified UUIDs, corroborated: BXR-GUC counts EXACTLY equal
  `pg_stat_user_tables.n_live_tup` on every populated table (claim_line 150,900 ·
  era_adjustment 65,615 · payment_residual 57,486 · brain1_features 64,346 ·
  payer_dim 286; the other 4 are 0) and Indigo-GUC counts are 0 everywhere. The
  definitive cross-tenant gate is 016's in-migration owner-run guard (RAISEs on any
  NULL or out-of-registry value before ADD CONSTRAINT).
- **017 guard — GREEN:** `relforcerowsecurity = f` on all 9 staging + both core
  tables (claims_admin owner-bypass ingest survives WITH CHECK); 017 also
  re-asserts this with an active in-migration guard. All 9 live policies confirmed
  `ALL`/USING-only, `TO public`, exact same GUC predicate.
- **018 index census:** non-tenant-leading btrees = idx_brain1_cpt / _dos /
  _payer_family / _payer_name + idx_claim_sig_prefilter (fixed in 018, same names,
  tenant-leading). DELIBERATELY untouched: the three single-column `claim_line_id`
  FK-support indexes (era_adjustment / payment_residual / brain1_features) — FK
  cascade/RESTRICT probes have no tenant qual; pkeys/UNIQUEs (identity); HNSW/GIN
  (method can't lead with a btree column). `claim_signatures.model_version` absent
  live → 018 adds it NOT NULL (table has 0 rows) + companion `claim_embedder.py`
  patch stamps MODEL_NAME.
- **`postgres` has `rolbypassrls = true`** (Supabase default; `claims_admin`/
  `claims_reader` = false). Apply-path reads see ALL rows — that's what makes
  in-migration guards definitive. `consolidated_reader` (019) is created NOLOGIN
  **NOBYPASSRLS** with an ALTER ROLE re-assert on every re-run.
- **019 enumerated read set (ratification target at HOLD — this list IS the policy
  list):** `core.business_entity`, `staging.claim_line`, `staging.payment_residual`.
  Nothing else. `GRANT consolidated_reader TO postgres WITH SET TRUE` is the 019
  apply-path mirror of the standing claims_admin grant (postgres already bypasses
  RLS — widens nothing; needed for ALTER FUNCTION OWNER + SET ROLE verification).
- **013's era_835 table is NOT live** (staging has exactly the 9 tables + the
  mv_payer_drift matview) — 016 scope confirmed; S8 concern unchanged.
- **Working-tree flag:** `cd app && npm run typecheck` is RED on a PRE-EXISTING
  uncommitted parallel-session edit — `<Analytics />` in `app/app/layout.tsx:98`
  with no import (root package.json gained `@vercel/analytics`). Not S2 code. Root
  typecheck clean; suite 262/262 green (incl. 7 new withTenant tests). Resolve or
  hand back to the owning session BEFORE the withTenant push (both-typechecks gate).

### S2 gate rulings at 016 release (Alec, 2026-07-05)

- **019 combined-row label = `'CONSOLIDATED (ALL TENANTS)'`, never "Treat Health".**
  §18 forbids Treat Health existing as a data-path entity string; five BXR facility
  customers are named `TREAT MENTAL HEALTH *` and a result-set string would
  pattern-match them. The surface is branded "Treat Health" at the UI layer (S10)
  only — never in a result set. Rationale also recorded in 019's header.
- **layout.tsx `<Analytics />` (parallel-session WIP): do NOT fix, do NOT wait.**
  At the withTenant commit HOLD: `git stash` the uncommitted parallel edits → both
  typechecks must be green against the clean state → surgical `git add` of exactly
  the withTenant files → commit → `origin/main..HEAD` check → push → `git stash pop`
  to restore the WIP untouched. If the pop conflicts, STOP and show Alec. The
  Analytics import remains the owning session's to gate.
- **017's landing gate is the probe:** apply 017 → `npm run probe:isolation` green →
  only then is 017 landed and 019 released. If the probe reds, 017's rollback is the
  immediate default unless the failure is provably probe-side; show Alec either way
  before touching anything else.

### Apply-path privilege model (consolidated entry — supersedes scattered notes)

`postgres` — the `apply_migration`/`execute_sql` role — is a NON-superuser with
`rolbypassrls = true` (Supabase default) and holds **SET-capable membership in every
object-owning role**:

| owning role | grant | purpose |
|---|---|---|
| `claims_admin` | `GRANT claims_admin TO postgres WITH SET TRUE` (S2, 2026-07-03) | born-owned objects via `SET ROLE`; ownership transfers |
| `consolidated_reader` | `GRANT consolidated_reader TO postgres WITH SET TRUE` (019, approved 2026-07-05) | `ALTER FUNCTION OWNER`; idempotent re-runs; `SET ROLE` verification |

Both grants are STANDING — revoking either re-breaks the apply path (42501).
**Future object-owning roles follow the same pattern deliberately.** BYPASSRLS on
postgres is also what makes in-migration data guards (016 orphan guard) definitive.

### Live user-access pre-flight before 017 (2026-07-05 — VERIFIED, per Alec's order)

Question: tenant-scoped user access controls are live today (RBAC, migration 0025) —
does ANY live user path read `staging.*` or set/depend on `app.business_entity_id`?

**Answer: NO — verified, not carried.** Enumerated against DEPLOYED `origin/main`
and the working tree:
- `staging.*` in app-reachable code (`app/`, `src/queries`, `src/routes`,
  `src/collections`, `src/agent` minus veris_agent): **prose comments only**
  (`app/lib/views.ts` lines 92/98; `cmdCustomers.ts` comments in the working tree).
- `app.business_entity_id` set/read in app-reachable code: **comment only**
  (`views.ts:91`). The only code that sets/reads the GUC is Veris-side CLI/ETL —
  `veris_agent.ts`, `hybrid_search.ts`, `brain1/2/3` Python, the `SQL Schemas/`
  ETL scripts — none deployed as routes.
- RBAC entity users read `claims.*`/`collections.*` through Server Actions;
  `viewToEntityIds()` is consumed by dashboard components as plain id arrays
  (carried-but-not-consumed for filtering; no GUC, no staging).

⟹ 017's WITH CHECK change touches zero live user traffic. Its only runtime writers
are owner-path (claims_admin, RLS-bypassed). PROCEED ruling satisfied.

### Stash-protocol dry-run finding (2026-07-05, before the withTenant commit HOLD)

Dry-run of the ruled stash protocol (stash parallel WIP → gates → pop; pop was
clean): root+app typecheck and 1 test go RED on the clean tree — but every failure
is in the **untracked 835 WIP** (`src/ingest/era_ingest.ts`, `test/era835.test.ts`),
which depends on the PARALLEL-SESSION `cmdCustomers.ts` edit (`businessEntityId` on
`CmdCustomer`) that the stash removes. Zero failures in the withTenant set. The
untracked 835 files are invisible to git and won't ship with the commit — so the
honest push gate is the PUSHED TREE (origin/main + exactly the commit set),
verified in a temporary git worktree; the stash is then needed only around the
`git add`/commit itself. Shown to Alec at the withTenant commit HOLD.

### 019 — APPLIED + LANDED (2026-07-06; S2 landing gate GREEN)

Applied via apply_migration on the **third attempt** — two transactional whole-rollbacks,
both root-caused and fixed in the artifact: (1) 0A000, expression ORDER BY directly on a
UNION → subquery wrap, semantics unchanged; (2) 42501 "permission denied for schema core"
at `ALTER FUNCTION … OWNER TO consolidated_reader` — the NEW owner needs CREATE on the
schema → transient `GRANT CREATE ON SCHEMA core` around the owner transfer, revoked
same-transaction (end state USAGE-only, verified `core_create=false`).

**Apply-time block (all live-verified):** consolidated_reader = NOLOGIN / NOBYPASSRLS;
fn = SECURITY DEFINER, `search_path=pg_catalog`, owner consolidated_reader, ACL
owner-only (`{consolidated_reader=X/consolidated_reader}`); positive aggregates: BXR
150,900 lines / $625,933,638.28 billed / $187,278,601.18 primary paid / 25,989 open
residuals; Indigo all-zero; combined row `CONSOLIDATED (ALL TENANTS)` (beid NULL) = sums;
outside-set denial 42501; claims_reader EXECUTE denied 42501.

**Landing gate (2026-07-06):** shell probe **29 PASS / 0 FAIL** (former SKIP #1 —
consolidated fn assertions — converted to PASS in-probe). Former SKIP #2 (positive
consolidated branch) converted via the **management-API leg** (execute_sql as postgres →
SET ROLE consolidated_reader; OAuth, zero password handling — Alec-approved "option 1",
2026-07-06): 3-row positive result matching the shell probe's BXR counts run minutes
apart, outside-set denial 42501. Distinction recorded: those two assertions passed via an
equivalent credentialed path, not the probe's own socket; the probe's env-gated branch
stays dormant until a real credential exists (option 2, `veris_probe` SCRAM role, is the
durable follow-up if scheduled probes are wanted).

**§2 cron guard post-redeploy:** run at 07:00:26 UTC 2026-07-06 on the new deployment
(dpl_CBs4Wh2bRBAMUjyvaSh7d8RQEg8C) → 200, customers 15/15, failed 0.

**Secrets facts (learned the hard way):** ALL Supabase-integration + sensitive Vercel
vars are WRITE-ONLY (env pull returns empty — old CLI 54.17.2 returns empty for
everything; use vercel@latest). `VERIS_POSTGRES_DATABASE_URL` exists in Vercel
(Production+Preview, sensitive) but its value is UNVALIDATED (write-only) and the local
`.env` copy FAILED auth (wrong password or URL-encoding) — ⚠️ the `.env` line is stale
and should be corrected or removed; the working landing path needs neither.

### ⚠️ S2 CODE IS COMMITTED NOWHERE (2026-07-06 — top S3 blocker)

Fresh-fetch verified: `origin/main` = `e8c503f`; every prod deployment builds it. The
ENTIRE S2 bundle — src/veris/ (withTenant, probe), src/tenants.ts, the
veris_agent/hybrid_search refactors, claim_embedder patch, SQL Schemas 014–019 +
rollbacks, these notes, the CLAUDE.md §17/§18 patch — exists ONLY in this working tree.
The 017 hard guard's commit+push leg was therefore NOT satisfied when 017 applied (the
prod-verify that actually happened was the probe running local code against the prod DB;
the deployed app touches neither staging.* nor the GUC, so no live exposure — but the
container-loss risk (§17 lesson) is MAXIMAL until the surgical commit lands). The
commit set is staged-by-list (worktree-verified: both typechecks clean, 251/251 on
exactly that tree); push awaits Alec's HOLD release.

### 017 — APPLIED + LANDED (2026-07-05; landing gate = isolation probe, GREEN)

Applied via apply_migration after the hard sequencing guard was satisfied
(withTenant committed + pushed + prod-verified: cron green + live BXR probe read).
Pre-deploy live re-verification: request path = `claims_reader` (rolbypassrls=f,
SELECT-only on all 9, zero non-owner write grants anywhere in staging);
`service_role` has BYPASSRLS but ZERO reach (no USAGE on staging/core — proven);
apply-path model unchanged. Structural verify: 9 policies, USING + WITH CHECK
present and IDENTICAL (`qual = with_check` = t × 9), cmd=ALL, names unchanged.
**Landing gate: `npx tsx src/veris/isolationProbe.ts` = 27 PASS / 0 FAIL** — no-GUC
fails closed (42704), BXR sees exactly its counts + 20 customers, Indigo sees ZERO
on all 9 surfaces + 36 customers, Indigo ANN empty, post-COMMIT GUC empty. 2 SKIPs,
both declared pre-run and both pre-019: consolidated_summary absent (function not
deployed) and the consolidated-positive branch env-gated off (no
VERIS_POSTGRES_DATABASE_URL) — covered by 019's apply-time verification block.
**Honesty note:** 017 has no behavioral delta today (no non-owner write privilege
exists; FOR ALL USING-only already implicitly gated writes) — it is a posture
migration: explicit WITH CHECK survives policy reshapes and pre-arms the S6 writer
role. First behavioral exercise arrives with S6. 019 is RELEASED by this gate per
Alec's 016-release ruling (separate HOLD still applies).

### 016 — APPLIED + VERIFIED (2026-07-05)

`SQL Schemas/016_staging_fk_tenancy.sql` applied via apply_migration (in-migration
orphan guard passed: zero NULLs, zero out-of-registry values, owner-run/BYPASSRLS —
definitive). Post-apply verify (claims_reader, catalog): **exactly 9 FKs** from
staging.* onto `core.business_entity(id)`, **all `convalidated = t`**, all
`ON DELETE RESTRICT`, named `<table>_business_entity_id_fkey`. A phantom-tenant
UUID can no longer enter any staging table. Rollback on file
(`016_staging_fk_tenancy_rollback.sql`, drops the 9 FKs only).

### 014 — APPLIED + VERIFIED (2026-07-03, born-owned)

`SQL Schemas/014_core_business_entity.sql` applied via apply_migration. Four-point
verify: entities=2, customers=56 (BXR 20 / Indigo 36), 0 rows outside the two ratified
UUIDs; both core tables owner=claims_admin, RLS enabled; policies `ALL` with USING +
WITH CHECK; grants = claims_admin (owner) + claims_reader SELECT, nothing to
anon/authenticated/PUBLIC. `core.cmd_customer` FK → `core.business_entity` ON DELETE
RESTRICT. Rollback carries an active pg_constraint guard; seed carries fail-loud identity
guards (temp-table + RAISE).
