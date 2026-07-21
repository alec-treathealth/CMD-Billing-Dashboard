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

---

## S3 — brain1_features backfill (migration 020) & ratified feature-surface contract (2026-07-06)

### RATIFIED (Alec, 2026-07-06): staging.brain1_features is the FULL FEATURE SURFACE

`staging.brain1_features` is NOT the labeled-training subset. Un-adjudicated rows
(`outcome='PENDING'`, `residual_type IS NULL`, `label_is_terminal=false`) are valid
state — present as features, awaiting a residual-derived label as claims adjudicate.
Backfills/reconciliations are therefore ADDITIVE/UPSERT-ONLY, never delete-and-replace;
labeling is monotonic (a labeled row never flips back to PENDING); post-adjudication
values never land on a PENDING row. The training subset is selected downstream
(live schema already agrees: partial index `idx_brain1_trainset … WHERE
(is_training_eligible AND label_is_terminal)`). Prior to this entry the contract was
unwritten (docs silent; schema implied it) — do not re-litigate.

### 64,346 vs 57,486 — forensic classification (read-only, BYPASSRLS path, 2026-07-06)

Exact accounting, zero residual: 57,486 rows in the S1-ratified INNER JOIN population
(pr.claim_line_id = cl.id) + 6,860 rows with NO matching payment_residual + 0 non-BXR +
0 NULL claim_line_id = 64,346. All 6,860 extras are uniformly `PENDING/NULL/false`
(6,857 training-eligible / 3 not). Zero duplicate claim_line_ids; zero population rows
missing from the table. The S2 recorded figure 64,346 is CORRECT as table state — it
never claimed to be the join population count.

### Upsert key ruling (Option A, Alec 2026-07-06)

The backfill/cron upsert target is the EXISTING `UNIQUE (business_entity_id,
charge_debit_id)` — §17's documented grain. There is NO unique constraint on
(business_entity_id, claim_line_id) (plain index + FK only; uniqueness there is
empirical, not enforced) and none is added. No prerequisite migration needed.

### Label mapping — reconstructed EMPIRICALLY, 0 mismatches on all 57,486 (2026-07-06)

Original build SQL lost with a prior container (single build, built_at 2026-06-22).
Verified-exact semantics, now canonical in `SQL Schemas/020_etl_backfill.sql` +
`src/veris/etl_backfill.ts`:
- `outcome`: CLEAN→PAID · ALLOWED_GAP→PARTIAL · MATH_GAP→PARTIAL ·
  BALANCE_DUE_INSURANCE→DENIED (all `label_is_terminal=true`); no residual → PENDING.
- **`days_to_pay` = `payment_received_date - charge_from_date`, NULL when negative
  (105 such rows live; CHECK days_to_pay>=0). SUPERSEDES the master plan's
  `primary_payment_date` assumption — payment_received_date is the source.**
- `was_underpayment` = `residual_type IN ('ALLOWED_GAP','BALANCE_DUE_INSURANCE')`.
- `net_underpayment_amt` = allowed_gap (ALLOWED_GAP) · balance_due_insurance
  (BALANCE_DUE_INSURANCE) · else 0. `allowed_amount` = pr.allowed_amount.
- Features copy 1:1 from claim_line except: payer_type←current_payer_type;
  network_status/participates_in_era←payer_dim via cl.payer_dim_id;
  diagnosis_pointer_count←cardinality(string_to_array(diagnosis_pointer_list,','));
  dos←charge_from_date (+EXTRACT y/m/dow); billed_amount←charge_amount. All 26
  derivations verified 0-mismatch before authoring.

### Migration numbering note

The master plan's "0012_etl_backfill" landed as **020** (S1 mapping rule: 0012 takes
the next free Veris number; 012 was taken/live). Artifacts:
`SQL Schemas/020_etl_backfill.sql` + `020_etl_backfill_rollback.sql`. Next Veris
number: **021**.

### 020 — APPLIED + LOADER RUN + CONSERVATION GATE GREEN (2026-07-06)

Applied via apply_migration (first attempt, guards passed). Apply-time DML: **0
inserted / 0 label-updated** — live state already matched the ratified mapping exactly
(expected-vs-actual: exact). `staging.etl_backfill_020_undo` created (claims_admin
owner, RLS USING+WITH CHECK, FK→core.business_entity), 0 undo rows. Loader
`etl_backfill.ts --tenant=bxr --commit`: source 57,486, 0/0, **all 8 conservation
gates PASS** (G1 completeness 0/57,486 · G2 label correctness 0 · G3 monotonic
stateless+stateful 0 · G4 pending-clean + pending-preserved 0 · G5 no-dupes 0 ·
G6 Indigo zero). Expected-vs-actual regime is CONSERVATION, not count-equality
(table is legitimately a superset: 57,486 labeled ⊂ 64,346 surface; 1% stop-tolerance
applies ONLY to G1/G2 labeled-population drift). Post-ETL isolation probe fresh,
own-socket: **29 PASS / 0 FAIL / 1 declared SKIP**. Suite 269/269 (incl. 7 new
hermetic PHI-firewall tests, test/etlBackfill.test.ts); root typecheck clean; app
typecheck red ONLY on the parallel session's known `<Analytics/>` line. NOT
committed/pushed (separate gate). Rollback honesty: the undo table covers 020's
apply-time DML only; loader runs are forward-only reconciliation.

### 0008 / mv_payer_drift — ALREADY LIVE (corrects CLAUDE.md §17 "not yet deployed")

`staging.mv_payer_drift` EXISTS live: owner claims_admin, populated, 114 rows,
computed_at 2026-06-23 (same day 009–012 deployed), all 3 indexes incl.
`uq_mv_payer_drift`, live params CTE verbatim-identical to the file
(60/120/30/5/0.05/0.50). Status dist: NEW_PAYER 41 · LIKELY_LAG_ARTIFACT 27 ·
INCREASING 21 · DECREASING 15 · NEW_CODE 10. §17's "not yet deployed to the DB" is
STALE — the S2 pre-flight note ("9 tables + the mv_payer_drift matview") was right.
File review found NO hardcoded UUIDs (re-verified against the artifact). The
re-apply-for-provenance + CONCURRENTLY refresh remains **GATED — Alec's explicit
separate go required** (his ruling 2026-07-06: "hold on 0008 keep it gated").

### Watch items (S3)

- **0008 index-grain tripwire:** `uq_mv_payer_drift` omits `payer_family` while the
  MV GROUPs BY it. If one payer_name ever maps to two families via ref.payer_alias,
  REFRESH CONCURRENTLY breaks. Today family is functionally dependent on name —
  treat a failure there as a data-quality signal, not an index bug.
- **isolationProbe env coupling:** the probe requires `CLAIMS_ADMIN_DATABASE_URL`
  present in-env even for its reader-context run (`hybrid_search.ts:48` checks both
  URLs) — export BOTH or it dies after the Indigo registry assertions with
  "Missing CLAIMS_*_DATABASE_URL".
- **.env hygiene (still Alec's):** lines 15/22/24 are unquoted and break naive
  `source`; the stale `VERIS_POSTGRES_DATABASE_URL` line persists. Extract single
  vars with grep until cleaned.

### 0008 — RE-APPLIED FOR PROVENANCE + CONCURRENT REFRESH VERIFIED (2026-07-06)

Re-applied via apply_migration, byte-identical to `SQL Schemas/008_brain2_drift_mv.sql`
at `fef840b` (pre-apply diff working-tree-vs-commit: clean; last file change 8fa6f19,
the reviewed version). Live state is now provably BYTE-DERIVED from the committed
artifact, not merely consistent with a lost-container apply. No deployed reader
touches the MV (zero `mv_payer_drift` refs in app-reachable code) — no disruption
window. `REFRESH MATERIALIZED VIEW CONCURRENTLY` ran clean as claims_admin (~1s,
separate autocommit statement — cannot run inside the apply txn). Post-refresh:
**114 rows, distribution IDENTICAL to baseline** (NEW_PAYER 41 · LIKELY_LAG_ARTIFACT
27 · INCREASING 21 · DECREASING 15 · NEW_CODE 10 — expected: staging source unchanged
since the 2026-06-23 batch), all 3 indexes intact incl. `uq_mv_payer_drift`, owner
claims_admin, ACL = owner + claims_reader SELECT. Verified against the JUST-APPLIED
live definition (pg_matviews, not the file): zero hardcoded UUIDs; era_adjustment
join carries `AND ea.business_entity_id = s.business_entity_id` (tenant-safe).
Isolation probe fresh pre-apply: 29/0/1. **Index-grain tripwire STILL LIVE:**
`uq_mv_payer_drift` omits `payer_family` while the MV groups by it — payer_family is
functionally dependent on payer_name today; if ref.payer_alias ever maps one name to
two families, REFRESH CONCURRENTLY breaks (treat as a data-quality signal).

### Ref-table loaders — CARC/RARC + CMS PFS loaded; NPPES deferred (2026-07-06)

**Step-0 diagnosis of the "98":** the 98 rows are `ref.remittance_code` — the
migration-000 SEED codebook (45 CARC + 53 RARC, all `ingested_by='seed_script'`,
reconciliation categories) — NOT a partial load of `ref.rarc_code` (which was 0).
The loader's remittance leg is additive-only (`ON CONFLICT DO NOTHING`); the seed
can never be overwritten. Only 25 distinct CARCs appear in `staging.era_adjustment`
and ALL 25 were already in the seed (gap=0).

**CARC/RARC source (PROVISIONAL, ruled by Alec 2026-07-06):** CMS **MREP 4.6
`Codes.ini`** (official CMS distribution zip, cms.gov `.../downloads/
medicareremiteasyprint46.zip`; file date 2026-02-04, X12 vintage 11/1/25) →
converted to `data/ref/{carc,rarc}.tsv` with provenance headers. Supersede with a
licensed X12 export when available. **Rejected first candidate:** the MassHealth
CARC/RARC XLSX (the loader header's named mirror) is a MassHealth EOB *crosswalk*
subset — only 89 CARC / 193 RARC and it covered just 13/25 of our observed CARCs
(missing 1/2/3/35/44/100/102/200/242/243/279/B11). mass.gov also hard-403s all
non-browser fetches (Wayback got the file). Coverage check on the CMS source:
**25/25 observed CARCs covered.** Loaded: `ref.carc_code` 0→**455** (110
deactivated w/ stop_date) · `ref.rarc_code` 0→**1,192** (190 INFORMATIONAL) ·
`ref.remittance_code` 98→**98** (preserved) · era_adjustment→carc_code join
orphans = 0.

**CMS PFS CY2026:** the pfs.data.cms.gov datastore's per-year payment data is the
"**Indicators for 2026**" dataset (dataset id `7c7df311-5315-4f38-b9ed-fd62f8bebe11`,
public domain, modified 2026-07-01). **Vintage field-shape mismatch** vs the
loader's candidates: code column is `hcpc` (not `hcpcs`), NO locality column
(national file → pseudo-locality '00'), and no dollar fields — price = `full_*_total`
RVUs × `conv_fact` (CY2026 CFs: 33.4009 non-APM / 33.5675 APM). Loader edited
accordingly (+ dedup before upsert: datastore returns duplicate rows; multi-VALUES
ON CONFLICT would fail "cannot affect row a second time"); `CMS_PFS_HCPCS_FIELD=hcpc`
+ `CMS_PFS_QUERY_URL=…/api/1/datastore/query/7c7df311-…/0` exported in-shell only
(.env untouched). Loaded: `ref.cms_pfs_rate` 0→**52** (year 2026, 52/52 BH codes,
fetched 74 → deduped 52). Sanity: 90837 nfac **$167.84**, 90791 $173.35, 99213
$95.19. ⚠️ H-codes (H0001–H0050) are `proc_stat='I'` — NOT PFS-payable, loaded
with $0.00 rates: the fee-schedule anchor exists ONLY for PFS-payable codes
(psychotherapy CPTs + E/M); Brain-1 must not treat $0.00 as a real rate.

**nppes_loader: DEFERRED, known no-op, untouched** (`ref.nppes_provider` = 0) —
deliberate skip per S1 correction #3 (no facility→NPI crosswalk exists).

Post-write gates: isolation probe fresh 29/0/1 (pre-write AND post-write runs);
suite 269/269; root typecheck clean; app typecheck red only on the parallel
`<Analytics/>` line. Working tree (shown, NOT committed): `cms_pfs_loader.ts`
vintage edits, new `data/ref/*.tsv`, this note.

---

## S5/S6 (compressed, resequenced) — auth extension + Indigo staging load (2026-07-06)

Resequenced by Alec's explicit, informed call (**Option 3**, 2026-07-06): load Indigo's
real data into the Veris plane + extend auth + verify isolation THIS session; the Indigo
RENDER surface is a separate, later, deliberate decision — NOT decided under time
pressure, and NOT the CMD dashboard (see "render conflict" below). This note is the
write-down the session ritual (§8.5.3) requires BEFORE any code/load ran.

### PG-B / S7 gate item 5 — written BAA/DPA + tenancy artifact (Alec, verbatim, 2026-07-06)

The "in writing" artifact S7's gate looks for. Do NOT treat a chat statement as
sufficient on its own — THIS dated entry is the artifact:

- **Indigo is covered under the master BAA/DPA shared with BXR Consulting** — confirmed by
  Alec on 2026-07-06.
- **Indigo has confirmed acceptance of shared-Postgres RLS tenancy** (not a dedicated
  instance) — confirmed by Alec on 2026-07-06.

These satisfy the two written-confirmation conditions PG-B and S7 gate item 5 require
before real Indigo data lands in `staging.*`. The pooled de-identified cross-tenant
TRAINING clause is a SEPARATE clause (S1 4d recorded it signed); it does not gate this
session because brains stay OFF for Indigo.

### Resequencing — ACCURATE record (corrects this session's prompt framing)

- **S4 (Python ML runtime / brain TRAINING) is deliberately DEFERRED** — not built this
  session; resumes separately.
- **S3 (ETL + reference data) already LANDED — do NOT record it as "deferred."** The
  prompt said "defer S3 and S4"; that is stale. Migration 020 (brain1_features backfill)
  applied + 8/8 conservation gates green; ref loaders done (`ref.carc_code` 455,
  `ref.rarc_code` 1,192, `ref.cms_pfs_rate` 52; NPPES a deliberate no-op). See the S3
  sections above. Only S4 is genuinely un-built.
- **S5/S6 (compressed) are being run NOW, ahead of the plan's S3→S4→S5→S6 order.** S6 is
  compressed to a STATIC-FILE load (the Indigo Seed Data CMD batch-dump CSVs → the staging
  ETL), NOT the live CMD Web API per-tenant job — the API path stays OUT of scope.
- **Brains 1/2/3 stay OFF for Indigo** regardless of sequencing (true in every version of
  the plan). This note exists so a future session/hire does not mistake the skip-ahead
  for a mistake.

### Render conflict — SURFACED AND HELD (Option 3; Alec, 2026-07-06)

> **SUPERSEDED same day (2026-07-06) — see "ADR REOPENED: collections tenancy" below.** Alec
> subsequently made the opposite call, with full deliberation: reopen 0027/0028 and render Indigo
> on the collections/overview plane. This "held" reasoning is retained for the decision trail —
> why it was held first, then consciously reopened.

The session prompt asked to make `/dashboard?view=indigo` render Indigo's data. That
CONFLICTS with the S1 ADR (docs/CLAUDE.md §18; §7/§15 guardrails): CMD-Billing-Dashboard
stays single-tenant, no `business_entity_id` in its schema, 0027/0028 shelved. Live
mechanics that make the conflict concrete (verified read-only 2026-07-06):
- `/dashboard` reads `claims.*` / `collections.*`, NEVER `staging.*`; `viewToEntityIds()`
  is carried but not consumed by any committed reader.
- Of the 3 collections dashboard tables, only `cmd_explorer_rows` has `business_entity_id`
  (all BXR; Indigo=0); `daily_collections` and `cmd_payer_facility_monthly` have NO
  tenancy column. Rendering Indigo on `/dashboard` would require building the shelved
  0027/0028 + an Indigo COLLECTIONS ingest (the BXR-only guardrailed cron) → reopens ADR.
- The static Indigo CSVs are the CMD **Explorer** export (report 10091971 shape: 14 explorer
  columns + Check/EFT/Charge Patient Payments) — i.e. `collections.cmd_explorer_rows` shape.
  **CORRECTION (2026-07-06, in place per Alec):** an earlier draft of this bullet claimed the
  CSVs were "shaped for `staging.*` (SQL Schemas/004 batch-dump ETL)" — WRONG. `004` is a 10-col
  *episode* ETL (a third, different shape); the batch-dump is richer still. The file matches
  NEITHER — its true home is the collections plane, which is exactly why the ADR was reopened
  (see "ADR REOPENED: collections tenancy" below).

**Ruling (Alec, Option 3):** do NOT render on `/dashboard` this session; do NOT reopen the
ADR. Load lands in `staging.*` (Veris plane); the Indigo render surface is deferred to its
own deliberate decision. Uncommitted collections-tenancy exploration in the working tree
(views.ts `INDIGO_ENTITY_ID` flip + server.ts/actions.ts reader scoping + 2 components) is
**Alec's earlier exploration, NOT a decision to reopen 0027/0028** — STASHED and set aside
this session (`git stash` stash@{0}; preserved, not built on, not discarded).

### Auth ruling (Alec, 2026-07-06) — EXTEND; reuse claims.app_user as-is

- **EXTEND the existing dashboard identity onto the Veris request paths; do NOT stand up a
  parallel Veris membership table.** The 3-label/2-tier model is already implemented AND
  committed: `app/lib/rbac.ts` (`super_admin` / `admin`+entity / `user`+entity, entity ∈
  {bxr, indigo}), `app/lib/access.ts` (resolves role+entity from `claims.app_user`
  (migration 0025) per request via the verified Supabase session), `app/lib/executive.ts`
  (default-deny session gate).
- **Reuse `claims.app_user` AS-IS — no new membership table, no new claims migration.**
- **`user` stays NON-PHI** (dashboard rule preserved). Tier (admin vs user) governs WHICH
  tenant's data a user sees, NOT PHI visibility within it; `canRevealPhi` remains
  admin+super_admin only. (SUPERSEDES the prompt's "admin and user identical data access"
  — Alec clarified that was about tenant scope, not PHI reveal.)
- Role/entity resolve SERVER-SIDE per request from `claims.app_user` (NOT JWT-embedded) —
  keep this; it is server-authoritative and needs no token re-issue on role change. Veris
  paths read `access.entity` → `withTenant(entityId)` GUC; `super_admin` (entity = null)
  takes the explicit `core.consolidated_summary()` (019) path, never an RLS hole.

### Prerequisite verification (read-only, 2026-07-06)

- `core.business_entity`: 2 rows — Indigo Consulting (id `141d459c-…`, acct 474623) + BXR
  Consulting (`af504ab6-…`, 475729). `core.cmd_customer`: Indigo 36 / BXR 20.
- Tenant-isolation probe (`npm run probe:isolation`): **29 PASS / 0 FAIL / 1 declared
  SKIP** — Indigo sees ZERO on all 9 staging surfaces; no-GUC read fails closed (42704);
  post-COMMIT GUC empty; `consolidated_summary()` denied to `claims_reader`.
- **`core.tenant_feature_flags` DOES NOT EXIST** (`to_regclass` → null) — S6-proper scope;
  per the prompt NOT created ad hoc this session. [OPEN: build it in a proper S6 pass;
  S7 gate item 4 cannot be checked until it exists + Indigo rows seeded all-OFF.]
- Data planes confirmed distinct: `staging.*` (Veris) Indigo=0 everywhere;
  `collections.cmd_explorer_rows` BXR=139,873 / Indigo=0.
- `.gitignore` gap: the "Indigo Seed Data" FOLDER is not explicitly ignored (its 4 CSVs
  are caught only by the blanket `*.csv`; a stray non-CSV there would NOT be). [RESOLVED
  same pass: `Indigo Seed Data/` added explicitly, mirroring `Derek Historical Report Data/`.]

---

## ADR REOPENED: collections tenancy (0027/0028 completion) — CMD-Billing-Dashboard goes multi-tenant on the collections plane (2026-07-06)

**Supersedes** the same-day "Render conflict — SURFACED AND HELD (Option 3)" entry above AND the
S1 ADR's "CMD-Billing-Dashboard stays single-tenant / 0027-0028 shelved" stance (docs/CLAUDE.md
§18/§7/§15, now annotated). Alec reopened the shelved direction DELIBERATELY, with fresh-ADR rigor
— a conscious decision, not drift or an accident. Mirrored as a §18 amendment.

### The decision (Alec, verbatim intent, 2026-07-06)

> Reopen the shelved 0027/0028 direction. The Indigo Seed Data CSV is collections-shaped
> (`cmd_explorer_rows`, not `staging.claim_line`) and belongs on the Indigo collections/overview
> page, not the Veris claims plane. Treat it with full S2-grade tenancy discipline because it
> touches the production-critical collections cron writer that is live for BXR. Claims/staging
> Veris work stops for now and its UI comes down — paused, not abandoned.

### Why (fresh-ADR-grade rationale)

- The seed file IS the CMD Explorer export (report 10091971 shape) — its natural, correct home is
  `collections.cmd_explorer_rows`, whose `row_fingerprint` append-only model already fits this
  paid-activity, heavily-duplicated (53% attribute-dupe) data. Forcing it into `staging.claim_line`
  would demand an invented grain, drop it to paid-only, and yield Indigo rows structurally poorer
  than BXR's batch-dump-derived staging. The collections plane is the right fit.
- The **fingerprint grain is CORRECT** for this data (not a shortcut): it is genuinely paid-activity
  Explorer data, not a claims batch-dump.

### Accurate committed/live state (verified read-only 2026-07-06 — corrects stale §7/§15/§18 text)

- **0027** `collections.business_entities` registry: **committed** (`77cc3be`) but **NOT applied
  live** (`to_regclass` → null). BXR/Indigo seed values match the canonical UUIDs.
- **0028** `cmd_explorer_rows.business_entity_id`: **committed AND live** — uuid NOT NULL DEFAULT
  BXR, all rows BXR (139,873), RLS enabled. `row_fingerprint` deliberately EXCLUDES
  `business_entity_id` (SHA-256 over the 14 CMD field values; relies on tenant customer-names being
  disjoint). ⟹ **Fingerprint-collision check is a MANDATORY pre-load gate** (Alec): confirm NO
  Indigo fingerprint equals an existing BXR fingerprint before any insert.
- **RLS is ENABLED (`relrowsecurity=true`) on all three** `cmd_explorer_rows` / `daily_collections`
  / `cmd_payer_facility_monthly` — but the POLICIES must be reviewed (enabling RLS ≠ tenant-scoping;
  the reader runs as `claims_reader`, no BYPASSRLS, and the dashboard works today ⟹ permissive
  policies exist; the migration reshapes them to tenant-scoped WITHOUT breaking BXR reads/writes).
- **daily_collections** (10 cols) and **cmd_payer_facility_monthly** (10 cols) have NO
  `business_entity_id` — the new migration adds it + backfill BXR + tenant RLS + composite index
  leading with the tenant column.

### Reopened workstream — gated sequence (one artifact at a time, HOLD before each)

1. **Docs (this entry + §18 amendment + §7/§15 annotations + staging-shape correction).**
2. **Stash pop + audit.** Adopt `stash@{0}` (Alec's earlier exploration: `views.ts` INDIGO flip,
   `server.ts`/`actions.ts` reader scoping, `cmd-explorer.tsx`/`collections-view.tsx`) as a DRAFT to
   review + finish — NOT trusted as-is (unreviewed, untested at prod quality). HOLD: shown before use.
3. **Migration(s)** (dashboard seq, next number ≥ 0030): `business_entity_id` + tenant-scoped RLS +
   composite index (tenant-leading) on `daily_collections` + `cmd_payer_facility_monthly`; tenant RLS
   + writer GUC on `cmd_explorer_rows` (0028 deferred these). Rollback script per migration. HOLD:
   diffs shown before running.
4. **Writer review.** How the cron writes these tables unscoped today + how scoping avoids risk to
   BXR's LIVE writes. HOLD before touching the cron writer at all — diff shown first.
5. **Isolation-test extension.** Cover `daily_collections` + `cmd_payer_facility_monthly` on the
   WRITER path (not only reader): BXR live data shows ZERO tenant-A/tenant-B exposure. HOLD: shown
   before trusted.
6. **Adapter + load.** Indigo Explorer CSV → `cmd_explorer_rows`-shaped tenancy (fingerprint grain);
   confirm no fingerprint collision with BXR first; narrow batch (HOLD) → full (HOLD).
7. **Claims/staging UI pause.** Take the live claims-facing Veris UI down (show exactly what is live
   first; HOLD before removal/flagging). **PAUSED, NOT ABANDONED.**

### Isolation-model ruling R1 + A→B→C sequencing (Alec, 2026-07-06)

- **R1 (ruled):** collections READS stay app-layer-scoped (`WHERE business_entity_id =
  ANY(<server-derived entitled ids>)` in the enumerable, now-uniform reader set — this is
  what lets Consolidated read BXR+Indigo in one query, which a single-valued GUC cannot
  express). Collections WRITES get GUC-based RLS enforcement (the Veris pattern), because
  the production-critical cron writer is where the real risk lives.
- **R4 (documented future hardening, deliberate "not now" — NOT a dropped idea):** a DB-level
  READ backstop for the collections plane: the reader sets an entitled-ids GUC (list-valued)
  inside a txn and RLS enforces `business_entity_id = ANY(<parsed list>)`. Requires wrapping
  every cached collections reader in a GUC-setting transaction — moderate reader surgery, no
  behavior change. Pick it up when hardening passes happen; the app-WHERE layer is the
  operative isolation until then. (Same deferred-seam register as viewToEntityIds pre-0028.)
- **A→B→C (ruled, strictly sequenced, never collapsed):** A = schema only (0030: columns +
  BXR backfill + in-migration guards + tenant-leading indexes; ALL policies stay permissive).
  B = writer sets the `app.business_entity_id` GUC (BXR for the live cron; Indigo for the
  adapter) — after deploy, a REAL BXR cron run must be verified green. C = the enforcement
  flip (writer policies check the GUC) — only after B is live-verified.
- **Terminology (Alec):** "Veris view" on the dashboard = the CONSOLIDATED view,
  super-admins only. It shows BXR-only numbers today simply because BXR is the only tenant
  with seeded/cron data — not a separate surface, and not the paused Veris claims plane.

### ⚠️ collections_daily_bucket / ON CONFLICT coupling (learned 2026-07-06 — do not trip this)

`daily_collections`' identity is the UNIQUE index `collections_daily_bucket (facility_code,
source_group_code, payment_date, source_tag) NULLS NOT DISTINCT`, and BOTH live insert paths
target it by column list — `src/collections/db.ts:85` (workbook CLI) and `db.ts:164` (cron's
`replaceCmdDailyForFacility`) use `on conflict (facility_code, source_group_code,
payment_date, source_tag) do nothing`. A column-list ON CONFLICT must match a unique index
EXACTLY, so **refolding that index to include `business_entity_id` in a schema-only migration
would error the very next cron run**. The fold ships WITH the writer change (B era): index
recreate + both ON CONFLICT lists move in one coordinated artifact. Same rule applies to
`cmd_payer_facility_monthly`'s `(payer_name, facility_name, service_year, service_month)`
UNIQUE key. 0030 deliberately touches neither.

### Live census backing 0030 (read-only, 2026-07-06)

- **Policies (11 total, ALL permissive today):** cmd_explorer_rows — reader SELECT
  `USING(true)`, writer INSERT `WITH CHECK(true)`, writer SELECT; daily_collections —
  reader SELECT, admin ALL, writer SELECT/INSERT/DELETE (all true); cpfm — reader SELECT,
  admin ALL, writer ALL (all true). RLS *enabled* on all three but wide-open ⟹ today the
  app-layer WHERE is the only read isolation, and C is where writer teeth arrive.
- **Owners:** daily_collections + cmd_explorer_rows = postgres; cmd_payer_facility_monthly =
  claims_admin ⟹ 0030 wraps only the cpfm DDL in `SET ROLE claims_admin` (standing grant).
- **Writer:** `cmd_rollup_writer` (no BYPASSRLS) via `CMD_ROLLUP_WRITER_DATABASE_URL`;
  INSERT lists omit business_entity_id everywhere ⟹ the BXR DEFAULT covers A/B with zero
  cron code change until B deliberately sets the GUC.
- **Fingerprint collision gate (Alec-ordered, PROVEN):** Indigo CSV → real `mapRow()`
  (Customer Name → facility, the 14th fingerprint field) = 492,727 mapped rows, 483,936
  distinct fingerprints, **0 collisions** against all 139,873 live BXR fingerprints.
  76 rows skipped (`member_id: missing` — the loader would skip identically); 8,791
  within-Indigo exact dupes collapse via ON CONFLICT DO NOTHING (expected at this grain).

### Still TRUE from the auth-wiring session (NOT superseded)

- Auth EXTEND ruling stands: reuse `claims.app_user`; `user` NON-PHI; server-side session→scope seam
  (`src/veris/tenantScope` + `app/lib/veris/tenant`). The reader scoping in the stash consumes the
  SAME RBAC entity decision (`viewToEntityIds` / `rbac.ts`) — auth + collections scoping share one
  identity, as intended.
- The Veris tenant-scope resolver + isolation-probe auth-path extension remain valid and green
  (277 hermetic tests; 39-pass probe). They serve the collections plane too.

### Claims/staging — PAUSED, NOT ABANDONED (record plainly so "UI removed" ≠ "decided against")

The Veris claims plane (`staging.*`, brains, S8–S10) is a real workstream, deliberately paused to
prioritize Indigo collections onboarding. Nothing here decides against it. brain1/2/3 stay OFF; S4
(ML runtime) remains deferred; S3 landed. "Claims UI removed" means **on hold**, not cancelled.

---

## Billing Audit S2 (Phase 1 apply) — apply-path SET grant found REVOKED (2026-07-13)

**Dated correction to the S2 "Apply-path privilege model" entry above:** the standing
`GRANT claims_admin TO postgres WITH SET TRUE` (S2, 2026-07-03, "do not revoke") was
found GONE from the live cluster at 0049 apply time. `pg_auth_members` showed exactly
ONE postgres→claims_admin row — grantor `supabase_admin`, `admin_option=true`,
`set_option=false`, `inherit_option=false`. The S2-era duplicate rows ("2 rows from
multiple grantors; harmless") were evidently collapsed by a platform-side
maintenance/upgrade pass, and the collapse kept the supabase_admin grant (no SET),
dropping the SET-capable one. Consequence: 0049's `SET ROLE claims_admin` failed 42501
and the apply rolled back whole (transactional — verified zero partial state).
Session tooling denied executing the restore grant without explicit authorization
(correct per the who-gets-which-permission gate), so it was surfaced instead of routed
around (per the standing "grant blocked by tooling → STOP" invariant).

**RESOLUTION (2026-07-13):** Alec personally ran
`grant claims_admin to postgres with set true;` in the Supabase SQL editor —
a deliberate OPERATOR STEP, not part of any migration (role-membership posture is
cluster-level, not schema state; 0049's header records the same). Verified
`pg_has_role('postgres','claims_admin','SET') = true`; 0049 then applied verbatim,
first attempt, full verification block green.

**Watch item (standing):** this grant can silently disappear on platform maintenance —
any future 42501 at `SET ROLE claims_admin` (or `consolidated_reader`) means re-check
`pg_has_role('postgres','<role>','SET')` FIRST, and the restore is postgres
self-granting within its admin_option. Same exposure applies to the 019-era
`consolidated_reader` grant.

### Dashboard-sequence migration-number RESERVATIONS (2026-07-13 — check BEFORE claiming)

Parallel sessions have collided on dashboard migration numbers twice (0049 was
nearly double-claimed; 0050 WAS double-claimed). Standing convention: before
claiming the next `supabase/migrations/00NN`, check (a) `origin/main`,
(b) every ACTIVE worktree/branch, AND (c) untracked files in every checkout —
another session's WIP claim is usually an untracked file. Current reservations:

| number | claimed by | state |
|---|---|---|
| 0024 | ANOTHER session | 0024-related WIP (per Alec, 2026-07-13 — listed in the parallel-WIP set; 0024 itself is applied on origin/main) |
| 0049 | billing-audit branch (`feat/billing-audit-plane`) | `0049_billing_audit_plane` — APPLIED live + committed on that branch |
| 0050 | collections session | `0050_cmd_explorer_charge_rollup` — LANDED on origin/main (fed5930) |
| 0051 | billing-audit branch | `0051_payer_alias_seed` — APPLIED live + merged to origin/main (PR #6, 609dff9) |
| 0052 | billing-audit facility-resolution branch (`feat/billing-audit-facility-resolution`) | `0052_audit_row_facility_code` — **APPLIED live + verified (24,507/24,507 stamped, 0 NULL); committed on-branch `2386ec8`; TEEN_MH_TX resolved (own distinct code). NOW ALSO ON origin/main** (git ls-tree origin/main confirms `0052_audit_row_facility_code.sql` present, 2026-07-21 — the "branch-only" note above is superseded). (upd. 2026-07-21) |
| 0057 | qualify-v2-feed ① session | `0057_cmd_explorer_feed1_dimensions` — DRAFTED (Gate 1 hold); NOT applied, NOT committed. Feed-1 dimension cols on cmd_explorer_rows. (claimed 2026-07-21) |
| 0058 | qualify-v2-feed ① session | `0058_cmd_charge_census` (+ `cmd_census_run`) — DRAFTED (Gate 1 hold); NOT applied, NOT committed. (claimed 2026-07-21) |

Record new claims here when made; remove rows once the file is on origin/main
(the tree then speaks for itself).

**Applied high-water mark (2026-07-17):** 0053 (`audit_ingest_run`), 0054 (`collections_rollup_refresh_run`),
0055 (`admissions_seat_role`), 0056 (`access_audit_reader`) are all **APPLIED + on origin/main** — so per the
remove-when-on-main rule they need no reservation row (the tree is authoritative). **Next free dashboard
migration = 0059** (0057 + 0058 — qualify-v2-feed ① — are now APPLIED live + on origin/main, commit
77818e4; the 0057/0058 reservation rows above are stale under the remove-when-on-main rule). Live-verified applied this session: **0055** (`claims.app_user` `app_user_role_ck`
includes `admissions_seat`; migration widened both role CHECKs + recreated `upsert_app_user`) and **0056**
(`claims.list_access_audit` exists, SECURITY DEFINER owned by `claims_admin`, EXECUTE→`claims_reader`,
public/anon/authenticated/service_role revoked). The stale 0049/0050/0051 rows above are also on
origin/main and removable under the same rule.

---

## Qualify v2 feed series — ②a LANDED (2026-07-21): canonical 21-col feed populates feed-1 dims

- **Canonical feeds now emit 21 columns and populate the feed-1 dimension columns** on
  `collections.cmd_explorer_rows` (`charge_id`, `charge_entered_date`, `charge_to_date`,
  `claim_status_raw`, `claim_status_category`). PROVED report-level 2026-07-21: BOTH tenants' CANONICAL
  filters return 21/21 (BXR report 10091971 / filter 10147530; Indigo 10092391 / 10147669), Charge ID
  first + Claim Status last. So the canonical hourly cron is the SINGLE deterministic writer — the
  resolution of ②a-recon's fingerprint-collision finding (there is NO separate parallel Feed 1).
  **Feed-1 filters 10148126 (BXR) / 10148128 (Indigo) are RETIRED UNUSED** (columns are report-level,
  not filter-level). Feed-2 census filters 10148130 / 10148129 remain reserved for ②b.
- **Fingerprint invariant proven LIVE** (the one silent-double-count risk): `fingerprintRow`'s
  14-element array is unchanged and the 5 new columns are excluded (fenced ②-or-never). A re-ingest of
  1,434 current-month postings through the new 21-col mapper inserted 0 rows (all `ON CONFLICT
  (row_fingerprint) DO NOTHING`): BXR 4150→4150, Indigo 7632→7632, 0 populated → 0 added.
- **Status taxonomy extracted to `src/collections/claimStatus.ts`** (single source of truth):
  `normalizeStatus` / `StatusCategory` / `NormalizedStatus`. `src/billingAudit/auditRowMap.ts` imports +
  RE-EXPORTS it (audit plane byte-identical, tests green); the collections mapper imports it AT SOURCE
  (no collections→billingAudit cross-plane import). No SQL enum — TS is the only taxonomy. Live sample
  categories all in-set: PAID / BALANCE_DUE_PATIENT / NEEDS_RENEGOTIATING / AT_PAYER / ON_HOLD.

### SEED-PATH NOTE — the on-disk seed corpus is STALE vs the 21-col guard (regenerate before manual re-seed)

`EXPECTED_HEADERS` (cmdExplorerSeed.ts) is now the full 21-column set, matching what CMD emits today.
But the on-disk seed corpus at `CMD_EXPLORER_SEED_DIR` (`Derek Historical Report Data/Derek Automation.csv`)
is **16 columns** (the 14 + Check Payment + EFT Payment) — it predates the 21-col report change and now
FAILS `headerDiff` (`missing [Charge ID, Charge Entered Date, Charge To Date, Charge Patient Payments,
Claim Status]`). This is CORRECT strict-guard behavior, not a bug: the seed must never partial-map an
unknown shape into PHI rows. **Before running the manual re-seed path (`npm run ingest:cmd-explorer`),
regenerate the corpus from a current 21-col export.** The live hourly cron is UNAFFECTED (tolerant
`pick()`, not the seed guard).

### A8 ORACLE — `Totals By Payer.csv` in the seed dir is NOT a dead file

The 7-column `Totals By Payer.csv` in `CMD_EXPLORER_SEED_DIR` is the **validation oracle** from the
Qualify-v2 recon (payer-grain Charge/Allowed/Insurance sums + %-allowed / %-paid). It is correctly
SKIPPED by the seed's `headerDiff` (it is not a charge-line export) — do NOT "clean it up" as a stray
file. Reconciling the charge-grain rollup summed by payer against it is the A8 recon check (a mismatch
would flag a max()-not-sum() posting-grain regression). Net-new harness; not built.

### ②b HANDOFF MARKER (Feed 2 census ingest)

Canonical feeds populate feed-1 dims **going forward only**; every row ingested BEFORE ②a deployed
carries `charge_id = NULL` permanently (fingerprint dedup + no UPDATE grant on the append-only table).
**②b recon owes: (1) the count of in-census-window postings with `charge_id IS NULL`, and (2) the
backfill-vs-ramp ruling on that number** (backfill the NULL-charge_id history into the census join, or
let it ramp as new postings arrive). Feed-2 filters: BXR 10148130, Indigo 10148129.

---

## Collections aggregate grain — `cmd_explorer_rows` is POSTING grain; aggregate ONLY over `cmd_explorer_charge_rollup` (2026-07-13)

`collections.cmd_explorer_rows` is append-only **payment-posting-snapshot grain**, NOT charge grain:
each cron re-pull inserts a new row whenever a charge's payment fields evolve (`ON CONFLICT
(row_fingerprint) DO NOTHING`), so one logical charge line carries many rows — BXR ~2.14×, 89.9% of
charges duplicated (read-only probe, W29 cohort, 2026-07-13). Summing that grain corrupted every
dollar aggregate: **BEFORE migration 0050**, BXR tenant %-paid read **197%** and cohort buckets up to
**292%**. These are PRE-FIX figures — once 0050 ships and the reads move to the rollup they are gone,
not a live problem. The verified per-field netting rules:

- **`charge_amount`** is charge-level, repeated on every snapshot → count it ONCE per logical charge,
  never `sum()` across rows.
- **`insurance_payments`** is a charge-CUMULATIVE running total → take `max()` per charge, **NEVER
  `sum()`** across posting rows. Where a charge's posting history is nondecreasing, `max()` == the
  latest value and is exactly correct. Where it is NOT (a payment then a within-history DECREASE —
  a takeback/reversal), `max()` returns the PEAK, so it can slightly OVERSTATE paid vs a
  latest-snapshot rule (only when the dip does not fully recover). **INSPECTED 2026-07-13** (read-only
  probe, per logical charge, dollars only): BXR has 17 non-monotone charges of 66,178 (0.026%), 14 of
  which leave `max` > `latest`, for $12,684.66 overstatement = **0.017% of $74.77M paid**; Indigo 299
  of 415,068 (0.072%), 241 overstating, $297,283.33 = **0.063% of $474.46M paid**. Both far under 0.1%
  of paid (rounding-scale) → **`max()` retained** (order-independent, robust). Documented remedy IF it
  ever grows material: switch this ONE field to latest-snapshot-by-`(payment_received desc, id desc)`
  — the rule already backing the rollup's other point-in-time columns. Do NOT switch on the
  non-monotone count alone; re-run the max-vs-latest dollar probe first.
- **`allowed_amount`** is per payment posting with explicit ± reversal rows → sum over DISTINCT
  `(payment_received, allowed_amount)` postings per charge (reversals net out).

Migration **0050** encapsulates all three in the materialized view
`collections.cmd_explorer_charge_rollup` (one row per logical charge, `REFRESH … CONCURRENTLY` after
each ingest). **EVERY aggregate read MUST go through the rollup** (`src/collections/cmdExplorerQuery.ts`:
search summary, combo, cohort curves, drilldown stats) — never write a new aggregate that sums
`cmd_explorer_rows` directly. The row-browsing grid and the audited PHI reveal deliberately stay on
`cmd_explorer_rows` (row grain is what they display; the rollup's `id` is the latest snapshot's row id,
so joins back still land). **Expected grain disagreement (BY DESIGN, not a bug):** the search summary
reports logical-charge counts (~66k for BXR) while the browsing grid pages posting rows (~141k for
BXR) — the two surfaces intentionally display different grains, so those two counts will not match.

---

## Billing Audit — WS1 facility resolution + Phase 4 UI (builds 1–6) complete (2026-07-15)

CC-executed on `feat/billing-audit-facility-resolution`, relayed + verified by Alec.
Phases 1–2 already merged to `main` (PR #6, `609dff9`); this entry records the
facility-resolution work + the full Phase 4 read-only UI — all branch-only
(not pushed, no PR, not deployed) as of writing.

### Phase 1–2 live baseline (on `main`, for the record)

- Migrations **0049** (audit schema) + **0051** (payer-alias seed, higher-precedence-wins)
  applied live + merged (PR #6, `609dff9`).
- **Three daily crons, all BXR-only:** `billing-audit-ip` 02:10 UTC · `billing-audit-op`
  02:20 UTC · `billing-code-decisions` 02:40 UTC (= 7:10/7:20/7:40 PM PDT).
- **Writer role `claims_audit_writer_svc`** via `CLAIMS_AUDIT_WRITER_DATABASE_URL`.
- **GOTCHA (carry forever): the Supavisor pooler host is the ONLY reachable one.**
  Writer URL uses `aws-1-us-west-1.pooler.supabase.com:6543`. The
  `db.<ref>.supabase.co` **direct host is IPv6-only and unreachable from Alec's
  network** — cost a full debugging cycle to isolate. Any new service DB URL for
  this project MUST use the `aws-1-…pooler…:6543` host, never `db.*.supabase.co`.
- **`claims.audit_row`: 24,507 BXR rows, zero cross-tenant leakage, zero non-BXR** (verified).

### WS1 — facility-scoped alias resolution (Option B, RATIFIED + applied)

- **Design (Option B):** `facility_code` is **stamped at ingest from the roster's
  authoritative code**, NOT parsed from the messy `office_name` strings (parsing
  office_name was the rejected Option A).
- **Migration 0052** (`0052_audit_row_facility_code`, dashboard sequence) **applied live**;
  backfill complete: **24,507/24,507 stamped, 0 NULL** (verified). Committed on-branch
  `2386ec8` (resolver + 0052).
- **TEEN_MH_TX ruling (customer 10035166):** resolved as **its own distinct
  `facility_code`** — deliberately **kept distinct from collections' TREAT_TX merge**.
  Billing-audit and collections diverge here on purpose; do not "reconcile" them.
- `claims.facility_alias` seeds from `collections.facilities`, used only for
  decision-matrix matching, not to gate ingest (facility set stays data-driven).

### Phase 4 UI — `/billing-audit`, RBAC-gated, READ-ONLY (builds 1–6 complete)

All six builds done + committed on-branch. Verified read-only against prod: no PHI
leakage, no page-overlap, correct scope isolation.

- **Builds 1–3** (`c3844d7` route+shell+nav; `42b98ea` filter+table+reader): RBAC-gated
  route, subtab shell, filter bar, work table with **keyset pagination**.
- **Build 4 — pivot strip** (`b4e44f9`): collapsible Office / Payer×CPT / Rev
  click-to-filter accelerators over the **same (scope, tenant, filter) slice** as the
  table. `loadAuditPivot` reader (non-PHI, cached, **top-8 capped**). Clicking a cell
  **unions** the value into the filter.
- **Build 5 — patient drill + reveal + gated search** (`b4e44f9`):
  - **Drill:** right slide-over, one patient's charge lines by `cmd_patient_id`
    (non-PHI, **masked**) — `loadAuditPatientDetail`.
  - **Reveal:** `canRevealPhi`-gated + server-audited — `revealAuditPatient` →
    `recordAccess('reveal_audit_row', { cmd_patient_id, scope })`, id-only detail,
    scoped to caller's PHI entitlement. **Mirrors `revealCmdExplorerRow` exactly.**
  - **Search:** box shown **only to reveal-entitled roles**; resolves term to **opaque
    blind-index tokens** (≤3 chars → prefix, else exact) via `searchAuditPatients`,
    gated + audited (`search_audit_phi`, **field names only**); tokens filter
    `patient_name_bidx` / `_pfx3_bidx` — **no plaintext PHI client-side**.
    **Mirrors `resolvePhiSearch` exactly.**
- **Build 6 — Flag Queue:** inert empty-state tab with a `(0)` count (Phase 3 placeholder).

**Verification:** 451/451 unit tests, typecheck clean, app build green
(`/billing-audit` = 10.6 kB). Read-only prod SQL: pivot 8/8/8, patient-detail drill
31 lines all-same-patient, PHI-leak NONE. One arg-order bug caught + fixed during the build.

**Branch state:** four commits on `feat/billing-audit-facility-resolution` —
`2386ec8` (resolver+0052) → `c3844d7` (route+shell) → `42b98ea` (filter+table+reader)
→ `b4e44f9` (pivot+drill+search). **Not pushed, no PR, not deployed.** 0052 is **already
applied to the prod DB**, so a future merge just ships the file. Working tree clean
(only pre-existing `.env.example`).

### Soak gate before Phase 3 (Alec's rule)

**3–5 clean nightly cron cycles required before Phase 3 flag-engine work starts** —
checked **manually each morning, not automated** (deliberate: new PHI-adjacent infra's
first unattended week).
- **Cycle 1 (2026-07-15, 02:10–02:21 UTC): verified CLEAN** via direct SQL — correct
  row counts, zero non-BXR, **single `source_report_id` per scope (no report-collision
  recurrence)**, zero null blind-indexes.
- **≥2 more clean cycles needed.** Pattern: group by `audit_scope, date_trunc('day',
  ingested_at)`; check row counts / timing / zero-non-BXR / single source_report_id
  per scope / zero null blind-indexes.
- Phase 3 flag engine is otherwise **unblocked** (resolver built + tested, TEEN resolved)
  — starts the moment the soak clears.

### Watch items (recorded, unconfirmed)

- **Stray 2-row OP touch 2026-07-14 08:41 UTC** — pre-dates the `vercel.json` schedule;
  probably a pre-merge manual invoke, **not confirmed**.
- **`last_fu_note` PHI classification — OPEN, higher urgency.** Currently displayed
  **as stored** in the non-PHI reader/table (per the schema's non-PHI classification).
  **If it can carry free-text PHI this is a live exposure**, and the fix is **ingest-side
  masking**, not a display change. Confirm field contents against prod before Phase 3.

### Backlog (non-blocking)

- `audit_ingest_run` observability table.
- Unify the duplicated `MultiSelectTagPicker`.
- Jess list (consolidate + send): ~19% CAMH IP payers unmatched (Aetna, Kaiser WA, Surest,
  Western Growers, Halcyon, Carelon, Self Pay) — intentional-gap vs maintenance-gap
  unconfirmed; HOUSTON_MH + TREAT_CO (BXR OP) return INVALID CRITERIA — defunct vs
  new-no-data unconfirmed; 9 needs-ruling payer-alias carriers (BCBS AR–Walmart, KWC
  Blues-vs-Anthems, BCBS MA/OK, BCBS TX MH-vs-SUD, Highmark, bare BCBS, Anthem ALL
  OTHER/S) — unmatched by design, not permanent; TEEN_MH_TX facility question
  (distinct vs typo).

---

## Qualify — Prompt 3 (desktop `/qualify` tab shipped, 2026-07-17)

**SHIPPED** (commit `485a1a3` → main, Vercel deploy GREEN). Desktop `/qualify` tab is live:
top-level route (`force-dynamic`), gated to `{super_admin, admissions_seat}` (admin/user
redirect to `/dashboard`), wired to the Prompt-2 `getQualifySnapshot` contract. Facility
color AND rank from `rating` (38/26 cutoffs in `app/lib/qualify/rating.ts`); cases inherit
their PARENT FACILITY's bucket (name-keyed map; collision-disagreement & not-found → neutral,
so no n=1 case fakes green); dollars OMITTED from the DOM (not CSS-hidden) when
`!viewerHasAmountsCapability`; role-aware nav (admissions_seat sees Qualify only); window
7/14/30/60/90 (mock's "Month" dropped — different window shape). VOB modal on
`resolved===null`, "Start VOB" inert with a `TODO(qualify-vob)` seam. Files:
`app/app/qualify/page.tsx`, `app/components/qualify/{colors,facility-panel,cases-table,
qualify-tab,vob-modal}`, `app/components/nav-links.tsx` (role-threaded from `layout.tsx`),
`app/app/globals.css` (`.q-*` paint), tests `app/test/qualify-render.test.tsx` +
`test/qualifyColors.test.ts`. Prompts 4 (mobile PWA) still pending; movers + reveal actions
exist but are NOT wired on this desktop tab (out of Prompt-3 scope).

### RESOLVED tribal knowledge — ROOT vs APP tsconfig strict-flag divergence (carry forever)

The two packages have DIFFERENT tsconfig strictness, and three "green" signals do NOT agree:
- **Root `tsconfig.json` sets `noUncheckedIndexedAccess: true`; app `tsconfig.json` does
  NOT.** So `arr[0].x` is an error under root `tsc` but fine under app `tsc`.
- **The runtime suite never type-checks.** `npm test` = `node --import tsx --test`;
  tsx/esbuild strips types, so a test with `snap.facilities[0].name` PASSES `npm test`
  while FAILING root `tsc`.
- **`next build` uses the APP tsconfig** (no flag) → also green.
- **Consequence:** a file under `test/**` can pass `npm test` AND `cd app && npm run build`
  while the standing "both typechecks clean" gate is actually RED. This is exactly how
  Prompt 2's `test/qualifyCore.test.ts` shipped with 6 latent root-`tsc` errors
  (`noUncheckedIndexedAccess` on `snap.facilities[0]/[1]`). Prompt 3 fixed them (non-null
  assertions on the known-present indices, in `485a1a3`).
- **RULE for every session:** run BOTH `npm run typecheck` (root) AND `cd app && npm run
  typecheck`. `npm test` + `next build` alone can be green over a root-`tsc`-red tree. Root
  `tsc` is the only signal enforcing `noUncheckedIndexedAccess` across `test/**` + `src/**`.

### tsx + JSX-runtime gotcha (recorded)

`tsx` maps the app tsconfig's `jsx: "preserve"` to esbuild's CLASSIC transform
(`React.createElement`), so a React render test under tsx throws **"React is not defined"**
(the app's components use the AUTOMATIC runtime and import no React — correct for `next
build`). Fix: a test-only `app/tsconfig.test.json` with `jsx: "react-jsx"`, selected via
`TSX_TSCONFIG_PATH` in the app `test` script. It does NOT affect `next build`/`tsc` (both
read `tsconfig.json`), so nothing shipped changes.

### Live verification — no browser driver, so DATA substitutes for the visual pass

This env can't authenticate a Supabase session, so the authenticated visual/pixel pass is a
HUMAN task. Verified on the live deploy + prod DB (read-only):
- `/qualify` unauth → **307 → `/login?next=%2Fqualify`** (route live + gated, not 404).
- **Rating colors read sensibly under the strict 38 cutoff** (answers "is anything green
  that shouldn't be"): 90d, 538 payer×facility cells → **14.9% green** (predicted 11–15%
  band), lowest raw pct earning green = **40.2%**, thinnest green facility = **9 lines**,
  only **3** greens at ≤10 lines (all needing pct ≳78% to clear 38). No thin-volume /
  mediocre-pct green — the dampening works on real data.
- **VOB genuine-miss path sound:** a bogus blind-index token → **0 rollup rows** (→
  `resolvePayer` null → `resolved:null` → modal), against a real population of 10,421
  members / 2,638 prefixes / 460 payers that a valid token resolves within.
- **STILL A HUMAN TASK:** pixel-fidelity vs `docs/mockups/qualify-tab-layout-proposal.html`,
  and the modal actually firing on a UI click, signed in as super_admin.

### Mobile qualify container — no async-interaction test coverage (Stage 3a follow-up, 2026-07-20)

Mobile qualify container (`qualify-mobile-app.tsx`) has no async-interaction test coverage —
app suite is `renderToStaticMarkup`-only, no jsdom/act/server-action mock. Guard decision-logic
is covered via pure predicates (`qualifyGuards.ts`, root suite); the full mount-and-drive-async
flow (payer-change closes sheet, drill-not-dropped, right-swipe deck advance) is untested.
Follow-up: add jsdom + testing-library + server-action mock as a dedicated infra task; closes
both the 3a async gap and the pre-existing right-swipe gap.

## Qualify — cases→claims rename + identifier-exact landing (Fix A) (2026-07-20)

**SHIPPED** (commits `e0ae24f` [cases→claims + identifier-exact drill] and `de9b008` [Fix A
landing] on `main`). The Recent Claims panel now filters to the SEARCHED identifier on the
facility-drill path (prefix → `member_id_prefix_bidx`, exact → `member_id_bidx`), killing the
payer-wide bleed (a `W29` search no longer returns `W27`/`W23` rows that merely share the resolved
payer), and lands on the facility where the searched member ACTUALLY is instead of the payer's
rating rank-1. Four DoD gates green at each commit (root `npm test` 549→560, app render suite,
BOTH typechecks, `next build`).

### Qualify "…Cases…" symbols now serve claim-grain `claims[]` (naming debt, deliberate)

The cases→claims work (`e0ae24f`) renamed the ROW TYPE + ARRAY FIELDS to claims
(`QualifyCase`→`QualifyClaim`, `QualifyCaseRow`→`QualifyClaimRow`, snapshot/drill `.cases`→`.claims`,
`lastDos`→`dos`, `assembleCases`→`assembleClaims`) but DELIBERATELY KEPT the feature/function/RPC/
component names:
- `getQualifyFacilityCases` (server action — renaming changes the `createServerReference` RPC id),
- `buildFacilityCasesQuery` / `loadQualifyFacilityCases`,
- `QualifyFacilityCases` / `QualifyFacilityCasesInput` / `QualifyCasesCursor`,
- the desktop `CasesTable` component + `cases-table.tsx` file.

Renaming those churns the RPC id + import graph + file names for ZERO user-facing gain. **So: any
symbol named "…Cases…" in the qualify scope now serves/renders claim-grain `claims[]`.** Not a bug —
a bounded-risk naming decision. Note **`snapshot.cases` was DELETED, not renamed** — there is no
`cases` field on `QualifySnapshot` anymore (the payer-wide, never-rendered field is gone; the
rendered panel is the facility drill).

### ⚠️ `identifierLandingFacility` + the ORDER-BY-PARITY INVARIANT (do NOT break)

Fix A (`de9b008`) added `QualifySnapshot.identifierLandingFacility` (one required field) and a
server-side landing lookup `buildIdentifierLandingFacilityQuery` (`src/collections/qualifyQuery.ts`)
that returns the facility of the searched identifier's MOST-RECENT in-window claim under the resolved
payer — so the claims panel lands where the member actually is instead of the payer's rating rank-1
facility (which frequently holds NONE of the searched member's claims → the "ranking 915, drill 0 for
the same prefix/window" report that triggered this fix).

**INVARIANT — DO NOT BREAK:** the landing lookup's `ORDER BY` MUST stay byte-identical to
`buildFacilityCasesQuery`'s (the drill's) claim ordering — currently **`charge_date desc nulls last,
id desc`**. It is DELIBERATELY **NOT `payment_received`** (the drill WINDOWS on `payment_received` but
ORDERS claims on `charge_date`; the landing query does the same). If the landing query and the drill
disagree on "most recent," the panel lands on one facility while the drill's top claim points at
another — a latent land-on-the-wrong-facility bug that NO test catches unless it specifically compares
the two orderings. **There IS such a cross-query parity test** (`test/qualifyQuery.test.ts` →
"buildIdentifierLandingFacilityQuery: ORDER BY matches the drill … not payment_received") — KEEP IT.
Do not "optimize" the landing query to `payment_received` (or any other order) without changing the
drill in lockstep, and vice-versa.

Below-floor / zero-in-window (approach ii): the core keeps the landing candidate ONLY if it is present
in the already-assembled `facilities[]` set (`app/lib/qualify/core.ts` —
`facilities.some(f => f.facilityKey === landingRaw)`), reusing the EXACT `assembleFacilities` floor
(`line_count >= QUALIFY_MIN_LINES`) with NO SQL floor duplication. A below-floor-only (or none-in-window)
identifier collapses to `null` → the honest empty state ("No in-window claims for <term> — try a wider
window"), kept DISTINCT from the `resolved===null` / VOB path. Resolve-by-payer (Heating-up chips /
on-load) sets the field `null` and keeps rank-1 selection unchanged (no identifier there → payer-wide).

### Mobile qualify honest-empty has THINNER coverage than desktop

Mobile's Fix-A honest-empty rendering + deck-lead are verified via PURE HELPERS
(`app/lib/qualify/qualifyGuards.ts`: `isIdentifierEmpty` / `identifierEmptyTerm` / `leadFacilities`,
root-unit-tested in `test/qualifyGuards.test.ts`) + the core `identifierLandingFacility === null` data
+ typecheck/build — NOT a mounted-container render test. The mobile container
(`qualify-mobile-app.tsx`) pulls the `'use server'` action graph, which the app test harness can't
mount (same documented constraint as the existing guard tests + the Stage-3a async gap above).
**Consequence:** the wiring from helper output to the correct `renderBody` branch is covered by
TYPECHECK ALONE, not by an assertion on rendered output — if that render path regresses, tests won't
catch it. **Desktop honest-empty DOES have a render test** (`app/test/qualify-render.test.tsx` →
"identifier honest-empty: … No in-window claims for <term>"). Known gap, not new — logged so the next
reader knows mobile is the thinner surface here.

---

## Collections grid — charge-grain collapse + tiered-allowed selection (BUILD X, 2026-07-21)

### Roadmap ledger — the data-trust ladder (where this work sits)

**North Star:** the PMF signal — *a biller changes pre-submission behavior in response to the risk
score* (PG-A, §3.3 assumption 1). Everything below is the ladder that has to hold before that score
is worth trusting.

**The pivot (2026-07-06 ADR amendment, recorded above).** CMD-Billing-Dashboard's COLLECTIONS plane
went multi-tenant (BXR + Indigo); the Veris CLAIMS plane (`staging.*`, brains 1/2/3) is PAUSED, S4
deferred, brains OFF. So the active work is the data-trust ladder, not the model:

1. **Trustworthy collections grain.** `cmd_explorer_rows` is posting-snapshot grain; 0050 fixed
   *aggregate* reads, and **BUILD X (this entry) fixes the *display* grain** on the Collections grid
   Derek works from.
2. **Qualify v2 census / survival.** The Feed-2 charge census (②a ramp VERIFIED firing 2026-07-21,
   charge_id populating on new postings; ②b ingest is the next build) supplies the charge-EXISTENCE
   denominator (`openCount`) a never-paid charge can't get from the payment-event log — the input the
   survival/retention view needs.
3. **Brain 1 — the ENGINE behind the score.** P(paid) / P(denied) / days-to-pay. Explicitly PARKED
   per the 2026-07-06 ADR (CLAIMS plane + brains 1–3 OFF, S4 deferred). It is what ultimately drives
   the North Star behavior change, but it does not run today.

**Brain-1 engine detail — parked design, preserved so it isn't lost (NOT active work; plumbing for
when the engine unparks):**
- *Survival head* — the time-to-event model (days-to-pay / retention), the "Phase 3 = LOC/survival"
  line on the cohort roadmap.
- *As-of CV / leakage guard* — training splits respect as-of time (time-based split, never random;
  features submission-time-knowable, labels post-adjudication kept separate). CLAUDE.md §17.
- *Census→survival dependency* — the Qualify v2 census (rung 2) is the charge-existence plumbing the
  survival curves consume; built now so the engine has clean input when it unparks, not because the
  engine is live.
- *PHI-free features* — the PHI denylist is absolute in features/embeddings (leakage firewall, §17).
- *Calibration gate* — a parked-design acceptance rule: the predictor must pass backtested
  calibration (predicted P(pay) matches realized frequency, on a time-based CV holdout) before its
  score renders for any seat. Design intent per Alec; no in-repo mechanism yet.

**Amounts gate — LIVE TODAY, not parked.** `viewerHasAmountsCapability = role !== 'admissions_seat'`
(rbac.ts; qualify/page.tsx + qualify/m/page.tsx). An `admissions_seat` sees percentages / ranks only,
never dollars — enforced server-side by DOM OMISSION (not CSS-hiding; proven in qualify render tests,
cases-table.tsx omits Billed/Allowed cells). Brain 1's expected-$ outputs INHERIT this existing gate:
a seat routing admissions sees rank + rating, never the dollar figure.

### Tiered-allowed — the reference implementation (BUILD X)

The Collections grid (`buildCmdExplorerQuery`) now COLLAPSES to charge grain instead of paging 2–8
posting snapshots per logical charge. Shape: paginate the 0050 rollup (fast, indexed), then OVERRIDE
`allowed`+`pct` per page from the base snapshots — the rollup's summed `allowed` over-states restated
charges (133.88% on the reference fixture) and is never displayed. Inline collapse over the base table
measured **~29s** unfiltered (unshippable); rollup-paginate + index-nested-loop override is **~1.07s**
unfiltered worst case, sub-second with any filter.

**Tiered `allowed` rule (per charge, over its base snapshots; target = max(insurance_payments) +
latest(patient_balance_due)):**
- a. single distinct non-zero allowed → that value.
- b. single distinct allowed == 0 WITH paid>0 → NULL ("—", the CMD phantom $0).
- c/d. restated: the snapshot allowed within $0.01 of target (latest by payment_received,id on ties).
- e. restated, none reconciles → latest POSITIVE allowed, else NULL.
- pct follows the displayed allowed via the exact 0038 formula; NULL allowed → NULL pct, never 0%.

**`allowed = paid + patient_balance` is a SELECTOR-where-it-fires, NOT the allowed identity.** The
Phase-0b probe proved it does NOT generalize: ~32k charges legitimately break it (Indigo ~7.3%, BXR
~2.7%), 85–87% off by >$100 — three real modes: (1) insurance underpays the allowed; (2) patient owes
charge−allowed so paid+balance ≈ *charge*, not allowed; (3) payment reversals inflate cumulative paid
above every stored allowed. So the identity only VALIDATES which restated snapshot to select; it never
gates/blanks a single real adjudicated value (that would hide ~20k correct alloweds — a worse
regression than the phantom). This select-and-validate rule is the **reference implementation for the
rollup rebuild's `allowed_reliable`** — the rebuild materializes it (not the current SUM), restores the
sorts dropped here, and fixes Qualify's inherited summed-allowed bug (Qualify reads the rollup directly).

### Tier-e residual (parked, known)

The reversal-heavy restated tail (~12k charges, mostly Aetna H0017/H0018) has NO reconciling snapshot;
tier-e displays the latest POSITIVE allowed as honest best-effort. Because reversals can push cumulative
paid above every stored allowed, the re-derived **pct_paid can exceed 100%** (reference: charge 786560,
paid $1,143.53 vs selected allowed $326.72 → 350%). NOT guarded (the ruling scoped tier-e pct as "the
exact 0038 formula on the best-effort allowed"). Real fix = the rollup rebuild's reversal-netting, for
BOTH this grid and Qualify. Do not paper over it with a display-only >100% clamp without re-opening the rule.

### Sorting note

`allowed_amount` / `pct_allowed` / `pct_paid` dropped from `CMD_EXPLORER_SORTABLE_COLUMNS` (and the
client `SORTABLE_KEYS` mirror): selected/derived per page, not materialized, so nothing to keyset on.
Columns stay VISIBLE, just no sort header. The rebuild restores them.
