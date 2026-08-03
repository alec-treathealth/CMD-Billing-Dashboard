# Veris data notes — persistent tribal knowledge

Created by **S1 (Ground truth & ADR ratification, 2026-07-02)**. Every session
appends what it learned the hard way — join keys, field quirks, timings, live-DB
facts, ratified decisions (the §8.5.3 tribal-knowledge rule in `docs/Fable Build Doc E2E/00-GUIDE.md`).
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
  (docs/veris-runbook.md). `013_era_835_adjustment.sql` is **TRACKED on origin/main**
  (commit `380d566`; grain-split amendment `3671844`) — the previous "is untracked"
  note here was stale, corrected 2026-07-30. **APPLIED LIVE 2026-07-31** via
  `apply_migration` after the grain-split amendment + two same-day comment fixes
  (procedure_code accuracy, member_id_bidx deferral record) — full post-apply
  verification green; see the 835 grain-split entry below. The 2026-07-30 "unapplied /
  freely editable" state is superseded: 013 is now live DDL, and any further change to
  these tables is a NEW migration (next free Veris number), not an edit to 013.

### 835 ERA grain split — migration 013 amended 2026-07-30 (UNAPPLIED, review hold)

A read-only grain audit found 013-as-authored stored the 835 at **adjustment grain only**,
with all seven BPR/TRN envelope fields denormalized onto every CAS triplet row. Two
independent money-critical defects:

1. **INFLATION** — `sum(payment_amount)` multiplied each remit's BPR02 by its triplet
   count: **10-100x, and variable per remit**, so not correctable by any constant. Same
   class as the posting-vs-charge grain error on `cmd_explorer_rows`, but a much larger
   multiplier.
2. **TRUNCATION** — adjustment rows are emitted only from inside `pushAdj()`, so a remit
   whose claims all adjudicated **clean-paid has zero triplets and its BPR02 never landed
   at all**. Clean-paid remits carry the most money.

No dedup key fixes defect 2, and none existed for defect 1 either: `row_fingerprint` is
per-triplet *by construction*, TRN02 is payer-scoped not global (and TRN03, the X12 field
that qualifies it, was never parsed), and `(payer + BPR16 + BPR02)` collides on per-NPI
payment splits and reissued checks.

**Resolution — two tables in the one migration.** `staging.era_835_payment` (one row per
ST/SE set) is now the **only** authoritative source of remitted dollars;
`staging.era_835_adjustment` FKs to it via `payment_id NOT NULL` and **has no
`payment_amount` column at all** — the wrong sum is unwritable rather than discouraged.
`check_eft_trace_number` also moved (stable payer-issued remit id = an attractor for the
wrong `GROUP BY`); `era_control_number` (ST02) was **deliberately retained** on the
adjustment table because it is a per-interchange sequence number that resets per file, so
it cannot identify a remit or mislead a grouping, and it names the source transaction set
for debugging without dereferencing the FK. The payment row is written **unconditionally
per parsed transaction**, before and independent of triplet mapping.

> ### ⚠️ READ-PATH CONTRACT — `era_835_payment.payment_amount` is NULLABLE
>
> A malformed/out-of-range BPR02 still lands the remit (dropping it is defect 2), so
> `payment_amount` can be NULL. **`sum()` silently skips NULLs**, so such a remit
> contributes **$0** to any aggregate and the tile above it understates while looking
> authoritative. The ingest counter `payments_amount_out_of_range` is in the *ingest*
> path — a dashboard query cannot see it.
>
> **Any query summing `payment_amount` MUST also return, over the same window and
> filters, `count(*) FILTER (WHERE payment_amount IS NULL)`, and the UI MUST surface that
> count when it is > 0.** A sum shown without it is a floor, not a total.
>
> ```sql
> SELECT sum(payment_amount)                            AS remitted,
>        count(*) FILTER (WHERE payment_amount IS NULL) AS unquantified_remits
>   FROM staging.era_835_payment WHERE ...;
> ```
>
> `payment_amount_raw` holds the original figure, so "unquantified" never means
> "unknowable".

**Fingerprint correctness fix (same pass).** The remit fingerprint hashes 8 fields and
coalesces NULLs to an explicit `'\x00absent'` token, never `''`. Hashing only the nullable
numeric amount meant `BPR02=99999999999.99`, `BPR02=88888888888.88` and BPR02-absent all
produced **one digest** (verified) — two of the three were silently discarded by
`ON CONFLICT DO NOTHING` while the insert reported success. An absent-token alone would
**not** have fixed it (all three would share the token), so `payment_amount_raw` (BPR02
verbatim) is also a fingerprint input. `era_source_file` is deliberately **excluded**: it
is a download-time name (`${cid}_${date}` for raw payloads), so hashing it would make a
re-pull of the same remit insert twice.

**⚠️ Fingerprint stability assumption (standing watch item).** Two of the eight remit-key
inputs — `era_control_number` (ST02) and `payment_amount_raw` — assume **CMD re-serves a
date's 835 byte-stably**: same transaction sets, same order, same ST02 assignment, same
literal BPR02 text. ST02 is a per-interchange sequence number that resets per file, and
`payment_amount_raw` is literal text (`'100.00'` vs `'100.0'` is the same money, different
bytes). If that assumption breaks, the same remit hashes differently, inserts a **second
payment row, and BPR02 is double-counted** — inflation returning by the same route
excluding `era_source_file` closed.

> **Detection signal:** a re-pull of an already-ingested date **MUST** report
> `payments_inserted = 0`. Anything above zero there is the duplicate-remit signature,
> **not** new data. Confirm with:
> ```sql
> SELECT check_eft_trace_number, payment_date, count(*)
>   FROM staging.era_835_payment GROUP BY 1,2 HAVING count(*) > 1;  -- expect zero rows
> ```

Accepted deliberately: duplication is detectable, attributable and correctable at the read
path, whereas truncation is not — so where they trade off, 013 errs toward retaining a
row. ST02 being *useless as a `GROUP BY` dimension* (why keeping it on the adjustment
table is harmless) and *useful as a fingerprint disambiguator* (separating two otherwise
identical transaction sets inside one interchange) are the same property at two distances,
not a contradiction. Also known and deliberate: `payment_amount` is now redundant in the
fingerprint (a pure function of `payment_amount_raw`) — kept because removing it would
force a full re-ingest for no gain.

Also fixed while amending: 013 was the **only** Veris migration missing `SET ROLE
claims_admin` (both tables would have been born owned by `postgres`); it had **no paired
`_rollback.sql`**; and it lacked the `core.business_entity` FK that 016 added to the 9 live
staging tables while explicitly excluding these two. Parser now captures TRN03.

**State (upd. 2026-07-31): APPLIED LIVE.** Timeline: committed `3671844` + pushed
2026-07-30 (deploy runtime-inert, build green); comment-only amendments 2026-07-31
(procedure_code comment corrected to "bare code component, raw-SVC01 fallback" — the
parser splits the composite; and a member_id_bidx **deferral record** added near
member_id_enc: deferred deliberately, blocker = `src/normalize.ts` vs
`src/collections/normalize.ts` export same-named `normalizeMemberId` with DIFFERENT
semantics (whitespace/hyphen handling), live bidx tokens are minted via
`src/collections/blindIndex.ts` which imports the COLLECTIONS one — route any future
835 bidx through blindIndex.ts + a byte-match pin test, never a re-implemented HMAC);
then **applied 2026-07-31 via `apply_migration`** (executable statements + persisted
COMMENT ONs verbatim; inline `--` narrative elided — zero DDL effect; repo file is
canonical). Post-apply verification ALL GREEN: 2 tables owned by `claims_admin`, RLS
on / FORCE off; `payment_amount`/`check_eft_trace_number` **absent** on adjustment (0)
and `payment_amount`+`payment_amount_raw`+`trace_originating_company_id` present on
payment (3); `payment_id` NOT NULL; 4 FKs validated (both →`core.business_entity`,
adjustment→payment, adjustment→`claim_line`); 6 policies (reader SELECT + writer
INSERT/WITH CHECK + writer SELECT per table); 15 indexes; grants exact (reader SELECT,
writer INSERT + column-SELECT on `id`/`row_fingerprint` only — never the PHI
ciphertext; anon/authenticated/service_role/PUBLIC = 0); both counts 0. Ingest cron
does NOT exist yet — first live quiet-day and re-pull-idempotency proofs come with it.

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
`SQL Schemas/020_etl_backfill.sql` + `020_etl_backfill_rollback.sql`. ~~Next Veris
number: **021**.~~ **021 is now TAKEN + APPLIED** (`021_era_835_member_id_bidx`, see
below). ~~Next free Veris number: **022**.~~ **022 is now TAKEN**
(`022_era_835_ingest_run`, see below) — **next free Veris number: 023.**
Checked before claiming 021 (2026-07-31):
origin/main high-water 020, all local branches (`git ls-tree` scan for
`SQL Schemas/021*` → nothing), all 4 worktrees, untracked files in the main checkout,
and this ledger. Note the numbered reservation table at ~:1144 is **dashboard-sequence
only**; Veris numbering is tracked here.

### 021 — `staging.era_835_adjustment.member_id_bidx` APPLIED LIVE (2026-07-31)

Closes the deferral 013 recorded. **Landed while the window was open**: the table is
EMPTY and its ingest cron is built but UNSCHEDULED, so this was a pure `ALTER ADD COLUMN`
with **no backfill**. The moment the cron writes rows it would have become an HMAC
backfill over PHI ciphertext (the 0037 / `cmdBlindIndexBackfill.ts` pattern).

**The normalization hazard — resolved, and the resolution is now enforced by test.** Two
functions named `normalizeMemberId` exist with different semantics:
`src/collections/normalize.ts` strips ALL internal whitespace + ALL leading hyphens;
`src/normalize.ts` keeps internal whitespace and strips ONE leading hyphen (`'AB 123'` →
`AB123` vs `AB 123`). Every live `member_id_bidx` token is minted by
`src/collections/blindIndex.ts`, which imports the **collections** one. The 835 ingest
routes through `era835MemberIdBidx()` → `blindIndexesForRowSafe` → `blindIndex.ts`, never
a re-implemented HMAC. Ingest-**safe** on purpose: a missing `INDEX_HMAC_KEY` yields NULL
rather than failing the money-path ingest (contrast `LIBSODIUM_KEY`, which throws —
storing PHI is not optional).

> **PIN TEST, mutation-verified.** `test/era835.test.ts` asserts the 835 token is
> byte-identical to `memberIdBlindIndex()` for whitespace- and hyphen-bearing inputs,
> plus an **anti-vacuity guard** (the two normalizers genuinely diverge on the fixtures)
> and a **discriminator** (a token over the wrong normalization does NOT match). Proven
> to have teeth: deliberately swapping in the wrong normalizer + a hand-rolled HMAC
> **fails 7 tests**, including both byte-match pins. Restored → 28/28 green.

**Grants: NONE, resolved from precedent rather than fresh judgement.** 0036 (the
add-columns migration) contains **zero** grant statements — a new column inherits the
table's table-level grants. Verified post-apply: `claims_reader` can SELECT the new
column and `cmd_rollup_writer` can INSERT it, both via inheritance, with **no new
statements**. 0037's `GRANT UPDATE(bidx…)` existed only to let a one-shot backfill write
pre-0036 rows; no pre-existing rows here, so it is deliberately not reproduced and 013's
append-only posture holds (`any_UPDATE_grant` = 0). `cmd_rollup_writer`'s COLUMN-level
SELECT stays **`row_fingerprint` only** — it exists for the ON CONFLICT arbiter and the
writer never reads the token back.

**Index deviates from 0036 deliberately**: `(business_entity_id, member_id_bidx)`,
tenant-LEADING per the 018 rule, because this table's RLS is GUC-based. 0036's
single-column bidx index is right for `cmd_explorer_rows`, whose RLS qual is `true`
(tenant scoping applied in the app layer), where a leading tenant column buys nothing.

Post-apply verification green: column `text` / nullable; index
`btree (business_entity_id, member_id_bidx)`; owner `claims_admin`; RLS on; 3 policies
unchanged; row count **0**; table grants exactly `claims_reader/SELECT` +
`cmd_rollup_writer/INSERT`. Artifacts: `SQL Schemas/021_era_835_member_id_bidx.sql` +
`_rollback.sql` (rollback drops index then column; no data-loss gate — the tokens are
derived from `member_id_enc`, which it does not touch, so they are re-computable under
the same key).

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
| 0059 | rollup-rebuild session | `0059_cmd_charge_rollup_allowed_reliable` (+ rollback) — **APPLIED LIVE 2026-07-22 07:14 UTC** (ledger 20260722071405), post-apply gates green, first autonomous :45 refresh ok=true 74.9s (run 131); NOT yet committed/pushed (commit HOLD pending — remove this row once on main). (claimed 2026-07-22) |
| 0070 | qualify-latency session | `0070_cmd_charge_rollup_kpi_cov_member` (+ rollback) — **DRAFTED, NOT applied** (Alec applies; CONCURRENTLY, outside a txn). Restores the book-wide KPI index-only scan Phase 2 broke by appending `member_id_bidx` to the covering index's INCLUDE (new name `_cov_m`, supersedes 0068's `_cov`). Must be applied BEFORE 0067 (0067's swap carries `_cov_m` forward + gates on live indexes). See "0070 index fix" below. (claimed 2026-07-27) |
| 0071 | CMD AR Automation session | `0071_cmd_charge_census_aging_index` (+ rollback) — UNTRACKED WIP in the main checkout alongside `src/collections/ageBucket.ts`/`arAging.ts`. Not committed, apply state unknown to this table. (observed 2026-07-29) |
| 0072 | CMD AR Automation session (presumed — the Phase-0 Teen-MH-TX pre-req) | `0072_teen_mh_tx_facility` (+ rollback) — UNTRACKED WIP in the main checkout. Not committed, apply state unknown to this table. NOTE: CLAUDE.md's "Next number 0072" is STALE against this file. (observed 2026-07-29) |
| 0074 | consolidated-audit session (scope-source ruling) | `0074_audit_row_scope_source` (+ rollback) — CLAIMED 2026-07-29; `scope_source` provenance column (tob \| roster_fallback) + backfill 'tob' on keyed rows. Checked origin/main (high-water 0073), worktrees, untracked (0071/0072 still AR WIP). |
| 0073 | consolidated-audit build session | `0073_audit_row_consolidated` (+ rollback) — **APPLIED LIVE 2026-07-29 ~08:57 UTC** (base + a same-session `_amend_source_filter` re-run of the idempotent file adding `source_filter_id`; the on-disk file carries both). audit_row: `charge_debit_id` / `claim_date_entered` / `claim_first_billed_date` / `cmd_customer_id` / `source_filter_id` + partial UNIQUE `(business_entity_id, charge_debit_id)`; audit_ingest_run: `customers_empty` + scope CHECK widened to CONSOLIDATED. Post-apply verified (4 cols + counter + index + CHECK + fingerprint-unique retained). Remove this row once the file is on origin/main. |

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

**→ SHIPPED 2026-07-21 — see "Feed 2 charge-census ingest — SHIPPED (②b)" below; the two owes are
carried forward as the ②c standing gate.**

---

## Feed 2 charge-census ingest — SHIPPED (Qualify v2 ②b, 2026-07-21)

Feed 2 (the charge-EXISTENCE census, `collections.cmd_charge_census`) now has a live ingest.
①/0058 created the tables inert; ②b wires pull + upsert + run-log. **No migration** — 0058 is
pre-existing and already carries every column this build needs (any DDL urge = STOP).

**Shape (transport-agnostic in `src/`, composed in `app/lib/server.ts`; touches NEITHER
`cmd-explorer.tsx` nor `actions.ts`):**
- `src/collections/cmdCensus.ts` — census-OWN mapper + batched UPSERT writer (deliberately NOT
  `cmdExplorerSeed.mapRow`). Required = **charge_id + patient_name ONLY**; every other field
  blank/unparseable → NULL, row KEPT (a blank member_id is a self-pay census row — the openCount
  denominator must not drop it). PHI via the exact `encryptPhi` + `blindIndexesForRowSafe` path
  (member/group null → null ciphertext + null bidx). Upsert = `ON CONFLICT (business_entity_id,
  charge_id) DO UPDATE SET last_seen_at=now() + dims`, `RETURNING (xmax = 0) AS inserted` to split
  rows_new vs rows_refreshed. Every write inside `withTenant` (0058 writer RLS is GUC-scoped).
- `src/collections/cmdCensusCron.ts` — catch-up loop: per-customer freshness cursor + wall-clock
  budget + per-customer failure isolation + run-log lifecycle.
- Routes `app/app/api/cron/cmd-census` (BXR) + `indigo-census` (Indigo, `transformRows:
  aliasIndigoFacilityColumn`). Node runtime, force-dynamic, maxDuration 300, GET-only +
  constant-time `CRON_SECRET` Bearer (same `isAuthorized` as the explorer crons).
- `app/vercel.json`: **cmd-census `15 * * * *`, indigo-census `35 * * * *`** — off the explorer
  :00/:30 and rollup :45 to stay clear of the shared one-report-at-a-time CMD partner session.

**Config — report reuse (ruled + live-proven).** The census inherits each tenant's EXISTING
explorer report/poll/creds and swaps ONLY the saved filter: BXR report 10091971 / census filter
**10148130**; Indigo report 10092391 / census filter **10148129**. Live per-tenant first-pull
(2026-07-21, real `insertCensusRows`/`cmdCensusCron` via the `cmd_rollup_writer` pool through the
6543 pooler) fetched 1805→1009 charges (BXR/DMH) and 2311→1400 (Indigo/HEALTHY LIFE) with **0
required-field skips** → the 21-col shape is intact under both explorer reports and the census
filters ARE saved there. There is NO `CMD_*_CENSUS_REPORT_ID` — do not add one.

**⚠ DEPLOY ORDERING (hard constraint, not a flag).** The census filter id resolves with NO
fallback (`requiredCensusFilterId` throws if the env var is unset) — a pull against the wrong
filter would silently mis-populate the openCount DENOMINATOR, so a missing var must fail LOUDLY.
Consequence: **set `CMD_BXR_CENSUS_FILTER_ID=10148130` + `CMD_INDIGO_CENSUS_FILTER_ID=10148129`
in Vercel prod FIRST, THEN push.** Push before setting them and the first scheduled cron run
500s — the SAFE failure (loud, not silent-wrong-window), but still a failed run. These vars are
NOT needed in the repo.

**Freshness cursor + retry model.** Before pulling customer C, the cron reads `cmd_census_run`
for `(entity, C)` where `finished_at IS NOT NULL AND status='ok' AND started_at >= now() -
staleness` (default **24h**; override `CMD_CENSUS_STALENESS_HOURS`, "0" forces a full re-pull).
Fresh ⇒ skip, so a full BXR (15) / Indigo (32) sweep amortizes over however many hourly runs it
takes; the wall-clock budget (**210s**) stops LAUNCHING new customers near the deadline and the
rest catch up next run (idempotent, self-healing). The **`status='ok'` clause is a deliberate
strengthening** of the bare `finished_at IS NOT NULL` gate: a run killed mid-pull (finished_at
NULL) OR one that errored (status='error') is NOT fresh → it re-pulls next run instead of waiting
out 24h. Transient failures recover in 15 min; a persistently-failing customer (e.g. one without
the census filter → INVALID CRITERIA) logs exactly one clean `status='error'` run-row per
invocation (PHI-safe `error_label` = stage token `fetch_failed`/`write_failed`, never a
message/URL) and nothing noisier — verified live 2026-07-21.

**Blank-charge_id skip metric (watch this).** `census_skipped` + `skips_by_label['charge_id:
missing']` in the returned stats count charges dropped for a missing charge_id (the census's only
hard gate besides patient_name). Live first-pulls were 0. A spike = an upstream charge_id gap in
the census export and directly shrinks the openCount denominator — treat as a data-quality alarm.

**0058-comment nuance (correction).** 0058's header claims a write outside `withTenant` raises
"unrecognized configuration parameter" (1-arg `current_setting`). Live, the writer INSERT with the
GUC unset instead raised **`invalid input syntax for type uuid: ""`** — `app.business_entity_id`
resolves to an empty string when unset here, so the cast fails rather than the lookup. Either way
the write **fails closed** (verified 2026-07-21); the comment's mechanism is slightly off, the
safety property holds.

### Roadmap ledger — ②b SHIPPED
Advancing the data-trust ladder (see the BUILD X ledger below): 0050 fixed aggregate reads, BUILD
X fixed the grid display grain, **②a** ramped `charge_id` onto new payment postings, and **②b
(this entry) ships the Feed-2 census ingest** — the charge-EXISTENCE denominator a never-paid
charge can't get from the payment-event log. Feed 2 is now LIVE and self-populating hourly.
Remaining on the Qualify-v2 line: **②c** (openCount join wiring into contract-v2) and the rollup
rebuild (materialize `allowed_reliable`, still parked).

**⚠ ②c STANDING GATE (do before contract-v2 openCount ships).** openCount joins
`cmd_charge_census.charge_id` ↔ `cmd_explorer_rows.charge_id`. Every payment-event row ingested
BEFORE ②a deployed (2026-07-21 ~10:05 UTC) carries `charge_id = NULL` permanently (fingerprint
dedup + no UPDATE grant on the append-only log) and CANNOT join to the census. **②c owes: (1)
re-count the payment-event rows still carrying `charge_id IS NULL` per tenant, and (2) rule
backfill-vs-ramp on that number** before openCount goes live — else the denominator silently
under-joins the pre-②a history. (Distinct from the Feed-2 blank-charge_id skip metric above:
that's the census export's own gaps; this is the payment-event log's pre-ramp NULLs.)

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
  unconfirmed; ~~HOUSTON_MH + TREAT_CO (BXR OP) return INVALID CRITERIA — defunct vs
  new-no-data unconfirmed~~; 9 needs-ruling payer-alias carriers (BCBS AR–Walmart, KWC
  Blues-vs-Anthems, BCBS MA/OK, BCBS TX MH-vs-SUD, Highmark, bare BCBS, Anthem ALL
  OTHER/S) — unmatched by design, not permanent; TEEN_MH_TX facility question
  (distinct vs typo).

  > **CORRECTION 2026-08-01 — HOUSTON_MH + TREAT_CO are NOT a payer question and NOT
  > defunct.** Owner-confirmed (Alec): they are **not yet open** — pre-launch, no payments
  > yet. `INVALID CRITERIA` is the **expected** pre-launch response for an account the saved
  > filter was never shared under; it is not evidence of a defunct or broken account. Struck
  > from this payer-alias backlog item because it never belonged here: it is a
  > **launch-readiness** item, tracked with TREAT_VA `10036125` under "Pre-launch facilities
  > — the zero-rows launch trap" at the end of this file. The rest of this Jess-list entry
  > (payer-alias gaps, TEEN_MH_TX) is unaffected and still open.

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
  > ⚠️ **SUPERSEDED (2026-07-27).** This bullet describes the OLD volume-dampened rating
  > (shrinkage toward a prior, cutoff 38). That model was REVERTED on 2026-07-19b — the
  > shipped rating is **value-first**: `qualifyRating(pctAllowed) = clamp0to100(pctAllowed)`
  > (rating.ts), NO volume term, cutoffs **50 / 30**. There is no "dampening" in the code
  > anymore; any doc/comment saying so is stale. See the thin-slice note appended below.
- **VOB genuine-miss path sound:** a bogus blind-index token → **0 rollup rows** (→
  `resolvePayer` null → `resolved:null` → modal), against a real population of 10,421
  members / 2,638 prefixes / 460 payers that a valid token resolves within.
- **STILL A HUMAN TASK:** pixel-fidelity vs `docs/mockups/qualify-tab-layout-proposal.html`,
  and the modal actually firing on a UI click, signed in as super_admin.

### Qualify rating — value-first model + the thin-slice sample gate (hotfix 2026-07-27)

TRIBAL KNOWLEDGE — the measurement that justified the sample gate; do NOT rediscover it.

- **The rating is value-first, not dampened.** `qualifyRating(pctAllowed) = clamp0to100(pctAllowed)`
  (rating.ts, ruling 2026-07-19b). No `n`, no `K`, no prior. Cutoffs `RATING_OK_MIN=50` /
  `RATING_WARN_MIN=30`. The shrinkage model (K=50→25, cutoffs 25/40, commit `e0ca5c7`) was
  superseded by `f25743d`. Any "volume-dampened" comment/doc is stale.
- **Because volume no longer enters the score, a thin slice renders a CONFIDENT color off sampling
  noise.** Measured on prod (`cmd_explorer_charge_rollup`, 2026-07-27, cross-tenant [BXR, Indigo],
  aggregate/non-PHI):
  - **Facility × single payer @90d (545 slices): median 2 distinct patients, p25 1, p75 4;
    61.3% of rows < 3 patients, 89.2% < 10.** ~23 charge lines per patient (median 34 lines masks
    ~2 patients — why the gate keys on patients, not lines).
  - Of the **86 "Strong" (≥50%) rows, 64 (74%) rest on 1-2 patients; only 3 have ≥10.**
  - **Per PAYER (all facilities) @90d: also median 2 patients; 63.7% of payers < 3.** So the
    mobile payer-scoped KPI tiles are in the same thin regime.
  - Ticker delta (cur/prior split): only 34% of slices have ≥2 patients both sides, 13% ≥5 — the
    delta breaks before a single tile does (Phase 2 concern).
- **The fix (this hotfix):** a distinct-patient SAMPLE GATE on the facility ranking only
  (`sampleGate.ts`, `count(distinct member_id_bidx)` added to `buildFacilityRankingQuery`,
  surfaced as `QualifyFacility.distinctPatients`). Desktop `facility-panel` + mobile
  `swipe-row`/`trend-sheet`: **< 3 patients → no bucket color / no confident % (explicit
  "insufficient data"); 3-9 → rating shown, flagged thin sample; ≥ 10 → unchanged.** rating.ts is
  NOT reopened — suppression is display-only. Thresholds 3/10 (movers uses 5/10; different idiom,
  same patient-based discipline). Identifier-scoped rankings are EXEMPT (one known patient by
  construction). Mobile's payer-scoped KPI tiles fail SAFE to book-wide (`SCOPED_TILES_ENABLED=false`)
  until Phase 2 wires a patient count into `buildBookKpisQuery`.

### Qualify Phase 2 — filter-aware orientation layer, Design B ASYMMETRY (2026-07-27)

TRIBAL KNOWLEDGE — why the orientation layer scopes ASYMMETRICALLY. A future session MUST NOT
"complete" this into symmetric full-filter scoping; that silently reintroduces the ~1-patient rating.

- **Tiles + ratings scope on PAYER + FACILITY only. Employer + funding scope ONLY the match count +
  cases list, never the tiles/ratings/ticker.** Measured (prod @90d): employer is the slice-shredder —
  facility × payer × employer approaches **1 distinct patient** (1,606 slices, thinner than the already
  thin facility × payer median of 2). Per-row facts (count, cases) stay truthful at any n; a rating does
  not. Funding is ~80% populated and near-binary (Self-Funded 29,145 / Fully Insured 6,169) so it barely
  shreds on its own — but it's grouped with employer for a simple, defensible rule.
- **Structural enforcement (not call-site discipline):** `buildBookKpisQuery` takes a
  `QualifyOrientationScope = Pick<CmdExplorerFilter,'facility'|'primary_payers'|'from'|'to'>` — a type
  that CANNOT express employer/funding. Fed through the shared `cmdExplorerBaseConds`, so it emits no VOB
  market semi-join. A regression test (`qualifyQuery.test.ts`) fails loudly if `employer_norm` /
  `member_benefits_latest` / `funding =` ever appears in the tiles predicate. The ticker builder simply
  has no market param.
- **Ticker stays BOOK-WIDE-WITHIN-PAYER** (not fully compose-aware): payer-scoped at exactly one payer,
  book-wide at 0 or 2+; facility/employer/funding never scope it. Why not full: splitting single-payer
  slices cur-45d/prior-45d, only **34% have >=2 patients both sides and 13% have >=5 both** — a
  filter-aware ticker would be empty/near-empty most of the time. A `both-window >= 5 distinct patients`
  DELTA GATE (`QUALIFY_TREND_MIN_PATIENTS`) drops cards whose "improver" delta would be computed on
  noise. Consequence (deliberate): NEW facilities (no prior window) no longer appear in the ticker —
  they can't show a trustworthy delta. Sparkline is fine: surviving cards carry ~215 current-window
  lines → median 8/8 buckets populated (buckets fill on lines, not patients).
- **Suppression thresholds are the hotfix's — 3 / 10 distinct patients (`sampleGate.ts`,
  `ratingSampleTier`)** — reused verbatim by tiles + ranking on BOTH surfaces; there is exactly one gate
  idiom. Desktop refetch: one fetch per payer/facility tag toggle or window change; ZERO on
  employer/funding/PHI/typing. Ticker refetches on payer/window only (facility never touches the marquee).
- **Mobile reconciled onto Design B:** its former market-scoping of the strip is REMOVED (employer/funding
  re-run only the cases/snapshot, not the tiles); its payer-scoped tiles (hotfix-disabled) are restored
  and sample-gated identically to desktop.

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
`buildFacilityCasesQuery`'s (the drill's) claim ordering — **AXIS CHANGED 2026-07-22: now
`payment_received desc nulls last, id desc`** (was `charge_date`). The window is already
`payment_received` on every builder, so surfacing + sorting on the payment-date axis makes the list
order consistent with the window; BOTH surfaces moved in lockstep in ONE commit. Byte-identical holds
because `payment_received` is a DATE (0019, day-grain): the drill orders on its projected alias
`agg.payment_date = to_char(payment_received,'YYYY-MM-DD')` (lexical == chronological), the landing
orders on the raw column — same row order, same "most recent" claim. If the two disagree, the panel
lands on one facility while the drill's top claim points at another — a latent land-on-the-wrong-facility
bug that NO test catches unless it specifically compares the two orderings. **There IS such a
cross-query parity test** (`test/qualifyQuery.test.ts` → "buildIdentifierLandingFacilityQuery: ORDER BY
matches the drill … the payment-date axis") — KEEP IT. Do not re-point either query to a different
order (back to `charge_date`, or anything else) without changing the other in the SAME commit. NOTE:
`dos` (= `charge_date`) is STILL projected + displayed on both surfaces — it just isn't the sort key
anymore; the drill's keyset cursor also moved to `payment_date` (`QualifyCasesCursor.lastPaymentReceived`).

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

---

## Rollup rebuild 0059 — allowed_reliable materialized (APPLIED 2026-07-22)

**Migration 0059 (`0059_cmd_charge_rollup_allowed_reliable` + rollback) APPLIED LIVE 2026-07-22
07:14 UTC** — the parked "rollup rebuild" from the BUILD X ledger. The 0050 matview now carries four
NEW columns (19–22): `allowed_reliable` (X's tiered rule, materialized), `allowed_tier`
(a/b/cd/e1/e2/none), `pct_allowed`, `pct_paid` — columns 1–18 unchanged byte-for-byte;
`allowed_amount` KEEPS its netted-sum meaning (ruling: ADDITIVE; it is the e1 input, not dead).
**NO consumer reads the new columns yet** — each repoint is its own HOLD (Alec's hard line):
① `buildFacilityRankingQuery` (the rating fix — MUST filter `allowed_tier <> 'e2'`, not merely
allowed-non-null: the value-first rating's clamp0to100 would turn an unreconciled >100% into a false
"Strong" green), ② `buildFacilityCasesQuery` (per-claim allowed), ③ the grid's snaps/sel/picked
override deletion + restore the 3 dropped sorts (NOTE: e1 CHANGES displayed grid values by design —
5,412 charges show the netted sum instead of X's latest-positive), ④ cohort/`PCT_RATIO_SELECT`
readers (the pct_paid 2%/$100 floor re-ruling is DEFERRED until real allowed_reliable numbers exist —
do not fold it into a repoint).

**Tier rule as shipped** (target = max(insurance_payments)+latest(patient_balance_due)): a single
non-zero → itself · b single $0-with-paid → NULL · cd reconciling snapshot (±$0.01, latest on ties) ·
**e1 = signed-delta NETTED sum when IT reconciles target (±$0.01) — the reversal-aware upgrade over
X's latest-positive, ruled by Alec (recovers 122 BXR + 5,290 Indigo of the 11,952 tier-e tail
penny-exact)** · e2 latest-positive (else NULL) · none NULL. Live tier census: BXR a 4,134 / b 139 /
cd 56,333 / e1 122 / e2 1,272 / none 4,741; Indigo a 377,443 / cd 29,938 / e1 5,290 / e2 5,268.

**Verification (scratch + post-apply live, both all-green):** row parity EXACT vs base-grain
expectation (66,741 / 417,939); X-parity 100% on a/b/cd/e2/none (478,268 rows, IS NOT DISTINCT FROM);
all 5,412 e1 = netted & differ from X's pick; fixtures — charge 786560 (the 350% tell) → e1,
pct_paid 100.00; the 133.88% netted fixture → cd, pct_allowed 33.88; zero NULL-allowed-with-pct,
zero coerced 0%. Suite 581/581 + both tsc + next build green (0059 = no observable behavior).

**Shape lesson (carry):** the first draft computed tiers via a SECOND join of the 635k-row base
against the grain — build >120s (killed twice at the MCP session's **2-minute statement_timeout**)
and was REJECTED; the shipped single-scan shape folds tier inputs into 0050's existing grouped pass
and picks the reconciling snapshot from a per-charge ordered array (CREATE 62s). MCP gotchas: lead
long applies with `set statement_timeout` in-artifact; backends SURVIVE the HTTP timeout (poll,
don't re-fire); guard against transport retries with `pg_advisory_xact_lock` + an already-applied
check (0059 carries both, forward + rollback). Cluster is PG 17.6 now.

**⚠ GRANT INCIDENT (root-caused + fixed same session):** DROP MATERIALIZED VIEW destroys the ACL;
0059's first apply re-granted claims_reader (0050) but missed **cmd_rollup_writer's SELECT (0054)**
— the run-log's freshness read (`max(payment_received)`, refreshChargeRollup step 3) runs as the
writer, so the next cron-path refresh failed `permission denied for materialized view` (run 130;
the refresh itself had SUCCEEDED in 62s — only the freshness read broke, fail-safe). Grant restored
by hand 2026-07-22, folded into BOTH 0059 files. **Rule: any future matview DROP+CREATE must
re-grant BOTH claims_reader AND cmd_rollup_writer.**

**Refresh cost + maxDuration:** cron-path CONCURRENT refresh on the new definition = **62–75s**
(run 130's refresh leg 62s; run 131 — the first fully-autonomous :45 cycle — **ok=true, 74.9s**,
freshness 2026-07-22; a cold-cache manual smoke hit 113s). The refresh route's `maxDuration` is
bumped **120 → 180** in the same push as 0059 (Alec's ruling: operational headroom for the matview's
own refresh, not a consumer repoint — 120 left as little as ~7s under the cold-cache reading).

**②c mid-window recount (ledgered per Alec):** ~Aug/Sep, **CHARGE-grain** — count distinct logical
charges with NO charge_id-bearing snapshot row (not row-grain NULL postings) — the openCount
prerequisite for contract-v2; unrelated to 0059 (allowed_reliable never touches charge_id).

---

## 90d Explorer first-load default (2026-07-21) — landed WIP + mechanism correction

Landed the standing 90d-recency WIP (built + GO'd 2026-07-20, dirty on the tree since; committed
2026-07-21). Change: Explorer `recencyDays` defaults to **90** (was `useState(0)` = all-time) so the
first-load summary applies a `payment_received >= today−90d` predicate. All-time stays reachable
(re-click the active chip → `recencyDays=0` → unbounded; Month/Year sets its own calendar window,
mutual exclusion preserved via `setMonth(0)`). Files: `cmd-explorer.tsx` (chip option + label +
`useState(90)` default) + `actions.ts` (`CMD_RECENCY_DAYS` allowlist admits 90). Source-level
regression guard added (`app/test/cmd-recency-default.test.tsx`) — a true render test is impossible
because `cmd-explorer.tsx`'s import graph pulls `@/lib/actions → @/lib/access`, whose RSC `cache()`
crashes the `node:test` runtime.

### ⚠️ MECHANISM CORRECTION — the all-time path is NO LONGER a seq scan (X changed the grain)

The 2026-07-20 review recorded the all-time first-load as a **Seq Scan** over ~483k rows
(~148–220ms/panel warm), and the perf fix's original justification was "90d takes the index instead
of that seq scan." **That description is now stale, and the shipped commit message deliberately does
NOT repeat it** — anyone reading the old note against the new commit should not be confused by the
discrepancy. What changed: **Build X (1586f8c) collapsed the Explorer to charge grain** and the summary
reads the `collections.cmd_explorer_charge_rollup` matview, so the BXR slice is now **66,741
charge-grain rows**, not ~483k row-grain. Live EXPLAIN (prod, 2026-07-21, warm) on the CURRENT query
shape:

- **90d first-load** → `Index Scan using cmd_charge_rollup_entity_payment`, Index Cond on **BOTH**
  `business_entity_id` AND `payment_received` (12,106 rows / 9,445 buffers) → **~20ms** totals,
  **~16ms** facility group-by.
- **all-time** → **also an Index Scan** on `cmd_charge_rollup_entity_payment`, but Index Cond on the
  **leading column only** (`business_entity_id`), 66,741 rows / 57,541 buffers → **~107ms**.

So all-time is an **index-scan-on-leading-column over charge grain**, NOT a seq scan — X's collapse
shrank the table enough that the planner index-scans even unwindowed. The perf premise still holds
DECISIVELY (90d reads ~18% of the rows/buffers → ~5× faster warm, 107ms → 20ms); only the *mechanism*
changed (fewer rows scanned, not seq→index). Cold first-touch was ~5.7s pure disk I/O — irrelevant to
steady-state; warms on first hit. The failure mode Alec flagged (planner picks seq scan even with the
90d window → 90d slower) did NOT occur.

## Qualify Client-Name (Change C) activation — NOT a one-line flip (compose-bar era, 2026-07-27)

`QUALIFY_CLIENT_NAME_ENABLED` lives at **`app/lib/qualify/contract.ts:278`** (corrected — an earlier
handoff propagated `:239`, which is a doc comment, not the constant; a future session should grep the
symbol, not the line). It stays `false` until BOTH data-ops steps land: migration **0067** (adds
`patient_name_bidx` to the `cmd_explorer_charge_rollup` matview — a ~90s rebuild/outage) AND the
historical name backfill run as the table OWNER (`postgres`; `claims_reader` has no UPDATE policy).
Alec runs those on his own timeline.

**Why flipping the flag is not sufficient (the compose-bar trap).** The Qualify compose bar's live
"N charge lines match" count runs through Collections' shared `buildCmdSearchSummaryQueries` totals,
and `CmdExplorerFilter.phiIndex` has **no** `patientNameBidx` field (Collections has no name search) —
so the summary/count is structurally **name-blind**. The client-name narrow is applied ONLY in
`buildFacilityCasesQuery` (Qualify's own `opts.nameToken` extra AND) — i.e. the claims LIST is
name-aware but the COUNT is not. While the flag is off this is harmless (clientName is always empty).
**The moment the flag flips, the count and the claims list will DISAGREE** on any name-narrowed search
(count too high). So activation ALSO requires making the count name-aware — either extend the shared
filter with a Qualify-only name predicate at the summary layer, or give Qualify its own count builder
that ANDs `patient_name_bidx`. Do NOT flip the flag without that, or the surface silently lies.

**Activation QA (whenever the flag flips):** (1) a name-only search returning zero must read as "no
match," and must NOT satisfy the VOB single-payer "never billed" probe (the probe gate already excludes
any PHI narrow — keep it that way); (2) verify `SEARCH_QUALIFY_NAME`/`SEARCH_QUALIFY_FACILITY` audit
fires with field NAMES only (`fields: ['client_name']`), never the name value, on an `admissions_seat`
session specifically. Runbook: `docs/qualify-redesign-cc-prompt.md` / the redesign handoff.

---

## 0067 ops analysis — applying `patient_name_bidx` to the charge rollup (read-only, 2026-07-27)

Pre-flight for the Part-2 (client-name) activation. **Nothing here has been executed.** Migration
`0067` is authored but must NOT be applied as-is — it is STALE (see hazards below). All figures are
live-DB reads taken 2026-07-27.

### The object
`collections.cmd_explorer_charge_rollup` — a **materialized view** (`relkind='m'`), **222 MB** total
(162 MB heap + ~60 MB indexes), **~486k rows**, owner `postgres`, ACL `claims_reader=r` +
`cmd_rollup_writer=rm` (SELECT + MAINTAIN). Read by **both** Qualify (ranking, KPI tiles, ticker,
cases) **and** Collections (All-Collections grid + summary). Refreshed hourly at **:45**
(`/api/cron/refresh-charge-rollup`, `REFRESH … CONCURRENTLY` via a SECURITY-DEFINER fn, 76–113s
measured post-0059, `maxDuration=180`, **no `lock_timeout` set**). No dependent views/matviews
reference it (`pg_depend` = empty), and the refresh function references it **by name** (re-resolves
after a rename — no edit needed on a swap).

### 0067 as authored = in-place `DROP` + `CREATE … WITH DATA`
Matviews can't `ADD COLUMN`, so 0067 drops and recreates the object, then rebuilds indexes.
- **Downtime:** ~90–150s where the matview holds `ACCESS EXCLUSIVE`. Because Postgres queues new lock
  requests behind a pending `ACCESS EXCLUSIVE`, reads start stalling the instant 0067 requests the
  lock, not when it acquires it → ~1.5–2.5 min of stalled/errored Qualify + Collections reads.
- **Cron collision (the main risk):** the :45 `REFRESH … CONCURRENTLY` (`SHARE UPDATE EXCLUSIVE`)
  conflicts with 0067's `ACCESS EXCLUSIVE`, and the refresh path sets no `lock_timeout`, so nothing
  fails fast. Cron-running-when-0067-starts → outage stretches to ~4 min; 0067-running-when-:45-fires
  → the refresh blocks and may be killed at `maxDuration=180` (leaves an `ok/finished_at=NULL`
  run-log row, self-heals next hour). The advisory lock in 0067 only serializes 0067-vs-0067 retries,
  NOT the cron.
- **Needs a maintenance window:** apply in the post-:45 gap (~:48–:57) at a low-traffic hour; ideally
  pause the refresh cron for the window. There is **no concurrent path** for the initial rebuild.
- **Rollback on mid-way failure:** the `DROP`+`CREATE`+index build is one `DO` block = one
  transaction; a failure rolls back atomically, leaving the pre-0067 matview intact (no partial
  state, no manual repair). `0067_…_rollback.sql` restores the 0059 definition; since Part-2 app code
  is NOT shipping (flag stays `false`, nothing reads the column), rollback is app-safe with no
  ordering constraint.

### ⚠️ 0067 IS STALE — it silently regresses two later migrations. DO NOT apply as-is.
0067 was authored **before** 0068/0069, which both modified this same matview. Its full DROP+CREATE
recreates only "0059's six indexes + the new name index" and re-asserts only the `SELECT` grants:
1. **Drops 0068's covering index** `cmd_charge_rollup_entity_payment_cov` (confirmed live). 0068's own
   NOTE 3 says a future full rebuild "should re-create this index alongside" — 0067 does not. Result:
   the book-KPI index-only scan regresses (**the ~8.3s → ~40ms win is lost**).
2. **Drops 0069's `MAINTAIN` grant.** `GRANT MAINTAIN … TO cmd_rollup_writer` is an object ACL that
   `DROP MATERIALIZED VIEW` destroys, exactly like the `SELECT` ACL 0067 re-asserts. 0067 does NOT
   re-assert `MAINTAIN`. Result: the post-refresh `VACUUM (ANALYZE)` (`refreshChargeRollup.ts`) starts
   failing "permission denied" → degrades quietly to no-vacuum (non-fatal, only a logged warning), and
   the covering index's `Heap Fetches: 0` decays between autovacuums.

**Required 0067 amendments before it is ever applied:** (a) also create
`cmd_charge_rollup_entity_payment_cov`; (b) re-assert `GRANT MAINTAIN … TO cmd_rollup_writer`;
(c) add `set lock_timeout = '5s';` so a cron collision fails fast instead of stalling all readers.

### RECOMMENDED instead: build-alongside-and-swap (sub-second lock, no window)
Rather than the in-place rebuild, build a `_next` matview and swap by rename:
1. `create materialized view collections.cmd_explorer_charge_rollup_next as <0067 def> with data;` —
   no lock on the live object; the :45 cron keeps refreshing the live matview during the ~60–95s build
   (different object, no conflict).
2. Build **all eight** indexes on `_next` (0059's six + the 0067 name index + **0068's covering
   index**), with `_next`-suffixed names (index names are unique per schema).
3. Assert grants + ownership on `_next`: `SELECT` to `claims_reader`, `SELECT` + **`MAINTAIN`** to
   `cmd_rollup_writer`, revoke public/anon/authenticated/service_role (owner `postgres`).
4. **Pre-swap verification (in the same migration, before the rename):** diff `pg_indexes` and the
   `relacl` of `_next` vs the live matview and RAISE EXCEPTION on any missing index or grant, so a
   rename can never ship a matview that lost an index or ACL.
5. Swap in ONE transaction with `set lock_timeout='5s'`: `ALTER MATERIALIZED VIEW … RENAME` live →
   `_old`, then `_next` → canonical name. Sub-second `ACCESS EXCLUSIVE`.
6. After verifying, `DROP MATERIALIZED VIEW … _old` and rename the `_next`-suffixed indexes back to
   canonical names (cosmetic).

**Blocker check (all clear):** no dependent views (empty `pg_depend`); the refresh function refers to
the matview by name and re-resolves post-rename (plpgsql cached plan invalidates on DDL — no OID
pin); Supavisor txn pooler forbids named prepared statements so nothing holds a stale OID;
`rollup_refresh_run` is a separate table, unaffected. Costs: transient ~222 MB extra disk during the
build; the swapped-in data is a build-time snapshot (~2 min stale) until the next :45 refresh (or run
one refresh immediately after the swap). A swap landing exactly during a :45 refresh waits on that
refresh's `SHARE UPDATE EXCLUSIVE` — the `lock_timeout='5s'` makes it fail fast and retry rather than
pile readers up.

**Recommendation: use the swap.** It cuts the `ACCESS EXCLUSIVE` window from ~90–150s to sub-second,
removes the maintenance window and the cron-pause, and largely dissolves the collision risk — at the
cost of transient double disk and a slightly longer migration (index renames + the pre-swap diff).
The in-place rebuild's only advantage is simplicity, which does not justify a ~2 min production
outage on a matview two live surfaces read.

## 0070 index fix — restore the book-wide KPI index-only scan Phase 2 broke (2026-07-27)

**Migration `0070_cmd_charge_rollup_kpi_cov_member` (+ rollback). DRAFTED, NOT applied — Alec applies.**

### Cause
0068 built `cmd_charge_rollup_entity_payment_cov` as a covering index so the book-wide Qualify KPI
aggregate (`buildBookKpisQuery`) ran INDEX-ONLY (`Heap Fetches: 0`). Phase 2 (Design B tiles) added
`count(distinct member_id_bidx)` to that same query; `member_id_bidx` is neither a key nor in 0068's
INCLUDE, so the planner abandons the covering index and does a plain Index Scan + full-window heap read.

### Measured (live, entity=[BXR,Indigo], trailing-30 ≈ 14.6k rows)
| query shape | plan | buffers | exec |
|---|---|---|---|
| with `count(distinct member_id_bidx)` (today) | Index Scan `entity_payment`, **no index-only** | 10,837 | ~52 ms |
| same, minus the distinct (0068 target) | **Index Only Scan `_cov`, Heap Fetches: 0** | 122 | ~16.5 ms |

~3.2× time / ~89× buffers at 30d; scales ~linearly with the window (the Range control allows up to
12 months ≈ 10× rows → the ~8.3 s → ~40 ms class 0068 was built to prevent). Runs on **every** mount.
Scoped (payer / payer+facility) refetches read ≤2.3k rows and are cheap regardless — the regression is
book-wide-only.

### Fix
Rebuild the covering index with `member_id_bidx` appended to INCLUDE, under a new permanent name
`cmd_charge_rollup_entity_payment_cov_m` (supersedes 0068's `_cov`, which 0070 drops). `member_id_bidx`
is COUNTED, never projected — it sits in the INCLUDE payload only so the `count(distinct)` is answerable
from the index. Built CONCURRENTLY alongside the live index (no coverage gap), old one dropped after,
then `VACUUM (ANALYZE)` to re-arm the all-visible visibility map. Idempotent; must run outside a txn.

### Size cost (measured / estimated)
Live `_cov` = **29 MB** over ~486k rows (~63 B/entry). `member_id_bidx` is `text`, avg 65 B → per-entry
roughly doubles → `_cov_m` estimated **~60 MB** (delta **~+31 MB**; matview total 222 MB → ~253 MB,
+~14%). Accepted for a per-mount query.

### Deliberately NOT included
- **`patient_balance_due`** — would only make the `count(*)` totals index-only, but that query never
  runs book-wide (the compose bar always scopes it to a payer/facility, ≤5 ms). Not on any hot path.
- **A `facility` index** — every measured path uses `entity_payment` / `entity_payer_payment`;
  `facility` is always a cheap residual filter (≤2k rows removed on a payer-scoped scan). Unwarranted.

### Ordering
Apply **0070 before 0067**. 0067's build-alongside-swap carries the `_cov_m` definition forward and its
pre-swap raise-on-loss gate enumerates indexes from the LIVE object, so `_cov_m` must already be live.

## 0067 swap apply procedure — build-alongside-and-swap (2026-07-27)

**Both `0067_cmd_charge_rollup_patient_name_bidx.sql` and its rollback were rewritten from the naive
in-place DROP+CREATE into build-alongside-and-swap. DRAFTED, NOT applied — Alec applies.**

### What changed vs the original 0067 (the three regressions it silently carried)
The original in-place 0067 (a) held ~90–150s ACCESS EXCLUSIVE (production stall), (b) **dropped 0068's
covering index**, and (c) **dropped 0069's MAINTAIN grant**. The rewrite fixes all three: sub-second
swap; index set + grants **enumerated from the LIVE object** (not a hand list) so 0070's `…_cov_m` and
every 0059 index carry forward automatically; MAINTAIN re-asserted; and a **pre-swap gate that RAISES**
on any column/index/grant loss (fails the txn, live untouched). The rollback got the same treatment —
it preserves `…_cov_m`/MAINTAIN and only removes the name column + index.

### Index count — EIGHT, not nine (reconciliation)
The build prompt anticipated nine indexes. It is **eight**, because Step 3 (0070) *replaces* 0068's
`…_cov` in place (drops it, creates `…_cov_m`) rather than adding a parallel index. Post-0070+0067 live
set: 0059's six + `…_cov_m` + `cmd_charge_rollup_patient_name` = **8**. The migration never hardcodes a
count — it enumerates `pg_indexes` at apply time — so the gate is correct regardless; this note is just
to explain the arithmetic.

### Ordering (hard)
1. **0070 first** (adds `…_cov_m`). 0067 enumerates live indexes, so `…_cov_m` must be live before 0067
   builds `_next`, else you swap in the pre-0070 covering index. The gate still passes either way.
2. 0067 after **0066** (base column, verified live) and ideally after the **name backfill**
   (`cmdNameBidxBackfill.ts`) so `_next` carries historical tokens in one build.

### Apply steps
1. Apply off the cron ticks (:00/:15/:30/:35/:45) — ideally in the post-:45 gap. The build does NOT need
   the cron paused (it is a different object), but starting off-tick avoids racing the swap against :45.
2. Run the file **outside a wrapping tool that imposes its own short statement/transaction limits** —
   the single txn runs ~60–95s (the `_next` WITH DATA build). `apply_migration` is fine (it wraps in one
   txn, which is exactly what this file expects; a failure or gate RAISE rolls the whole thing back).
3. On a gate RAISE, read the message — it names the missing column/index/grant. Nothing shipped; fix and
   re-run.

### Timings, locks, disk
- `_next` build: **~60–95s** (WITH DATA over ~486k rows), no lock on the live matview.
- Swap: **sub-second** ACCESS EXCLUSIVE (two RENAMEs + DROP _old), guarded by `lock_timeout='5s'` — a
  collision with a running :45 REFRESH (SHARE UPDATE EXCLUSIVE) fails the swap fast and rolls back;
  re-run in the next gap. (No reader pile-up, unlike the original's ~2 min.)
- Transient disk: **~222 MB** while `_next` coexists with live (a second full copy) until the swap drops
  `_old`.
- Freshness: the swapped-in data is a **build-time snapshot (~2 min stale)** until the next :45 REFRESH
  (non-issue at hourly cadence). Run one REFRESH immediately after if you want it hot sooner.

### Post-apply checks
```sql
-- 23 columns incl patient_name_bidx; 8 indexes incl _cov_m + patient_name; grants incl MAINTAIN.
select count(*) from pg_attribute where attrelid='collections.cmd_explorer_charge_rollup'::regclass and attnum>0 and not attisdropped;  -- 23
select indexname from pg_indexes where schemaname='collections' and tablename='cmd_explorer_charge_rollup' order by 1;  -- 8, none named *_nxt/_next
select relacl from pg_class where oid='collections.cmd_explorer_charge_rollup'::regclass;  -- claims_reader=r, cmd_rollup_writer=rm
-- no orphan left behind:
select count(*) from pg_class where relname in ('cmd_explorer_charge_rollup_next','cmd_explorer_charge_rollup_old');  -- 0
```
Then confirm the next :45 refresh logs ok=true and the KPI index-only scan still shows `Heap Fetches: 0`.

### Aborting mid-build
Because it is one transaction, `SELECT pg_cancel_backend(<pid>)` (or Ctrl-C) during the `_next` build
rolls everything back — `_next` never persists, live is untouched. If a run is killed OUTSIDE txn control
(rare), a `_next` orphan may remain; the next apply's defensive `drop materialized view if exists …_next`
clears it, or drop it manually. Never drop `…_old` by hand unless a swap half-completed (it won't under
the single-txn design).

---

## CMD AR Automation — Phase 0 findings (2026-07-28, probe only, no code applied)

Executing the CMD AR Automation build doc v2, Phase 0. Blockers resolved by a live structure-only
probe (`npm run probe:cmd`, PHI-safe — headers + row counts, never values) plus owner decision. This
supersedes two load-bearing assumptions in the build doc's §2.2/§2.6. **Nothing applied.**

### Probe run
- Target: **report `10091971` / census filter `10148130`** (the BXR census's live pairing *at probe
  time* — then `cmdExplorerConfigFor` reportId default `10091971` +
  `requiredCensusFilterId('CMD_BXR_CENSUS_FILTER_ID')`), customer `10030911` (NASH,
  `src/collections/cmdCustomers.ts:72`).
- Result: **1 CSV entry** (`Derek Automation.csv`), **2,650 rows**, **21 columns**, ready in 2 polls (~32s).
- Caveat: probed with `CMD_EXPLORER_REPORT_ID` at its then-code-default `10091971`. If Vercel overrides
  that env in prod, the live census output could differ — confirm against Vercel env before relying on this.
- **DRIFT (2026-08-01): report `10091971` is DEAD.** It was lost in CMD on 2026-07-31; every pairing
  under it returns INVALID CRITERIA. The explorer default is now `10093959`/`10148478`
  (`cmdExplorerConfigFor`, `app/lib/server.ts:1674-1675`), and the BXR census **no longer inherits the
  explorer's report** — it requires its OWN `CMD_BXR_CENSUS_REPORT_ID` + `CMD_BXR_CENSUS_FILTER_ID`,
  both no-fallback-throw (`cmdBxrCensusConfigFor`, `app/lib/server.ts:1760-1766`). The probe's *column
  findings* below were value-matched when the replacement report was adopted (see the ALIAS PROVENANCE
  block in `src/collections/cmdExplorer.ts:59`), so §0.2/§0.3 conclusions still stand; the report/filter
  *ids* above are historical only.

### The 21 census columns (verbatim)
`Charge ID · Charge Entered Date · Charge From Date · Charge To Date · Payment Received · Charge CPT Code ·
Revenue Code · Patient Full Name · Claim Primary Member ID · Primary Group Number · Charge/Debit Amount ·
Payment Allowed Amount · Charge Insurance Payments · Charge Total Adjustments w/o Transfers ·
Charge Balance Due Pat · Charge Primary Payer Name · Facility Name · Check Payment · EFT Payment ·
Charge Patient Payments · Claim Status`

### 0.2 — `Charge Fromdate Age` is NOT on the census feed (build-doc §2.2 was wrong)
The bucketed a–h `Charge Fromdate Age` column lives on report **`10091573`** (the 187-col offline
sample in `data/cmd_batch_…`), **not** on `10091971`, which is what the census pipeline runs. The doc
conflated the two reports.
**But it doesn't matter:** the feed carries `Charge From Date`, and the census **already ingests it** as
`charge_date` — header mapping `src/collections/cmdExplorer.ts:27` (`charge_from_date: ['Charge From Date']`)
→ `src/collections/cmdCensus.ts:138` (`charge_date: toIsoDateOrNull(full.charge_from_date)`), persisted via
`INSERT_COLS` (`cmdCensus.ts:45-49`). Age is therefore derivable today from data already in the
table (`as_of::date - charge_date`), needing **no CMD-side filter change and no new bucket column to parse**.
→ Phase 1 gets cheaper: derive age-days + bucket ourselves (own closed set, exact days, live-drifting —
better for a worklist than a frozen snapshot). No mapper change, migration likely index-only.

### 0.3 — No second summary CSV; no payer-priority balances (build-doc §2.6 hope does not hold)
Single CSV entry — no summary sheet. None of `Charge Primary/Secondary/Tertiary Balance (Sum)` exist on
this feed, nor `Charge Balance Due Ins` / `Charge Balance At Collections`. Only `Charge Balance Due Pat`
(patient balance) is present, and it is **not mapped into the census today**.
→ Phase 3a's payer-priority rollup **cannot** be sourced from the census filter — it needs the separate
Sheet-2 report (its own Phase 0 probe when Phase 3 comes up). Per the doc's own instruction, **drop
`charge_balance` from `0071`** — the feed has no charge-total balance to write.

### 0.4 — Sizing
NASH alone = 2,650 rows on the **current** window; ~15 BXR customers ≈ **~40k rows**, in line with the
census's existing footprint, well inside `maxDuration=300`. **Could not** size the *widened* full-history
pull (no full-history filter id available; headers don't reveal the current window). Phase 1d's "widen the
filter" stays a CMD-side task whose row impact must be measured against the actual widened filter before enabling.

### 0.1 — Teen MH TX: OWNER DECISION = separate entity (2026-07-28)
Distinct NPI `1124973086`, own CMD account `10035166`, own profile tab + remittance address ⇒ its own legal
entity, not a typo of TREAT MENTAL HEALTH TEXAS. The `0042` alias (`TEEN MENTAL HEALTH TEXAS LLC → TREAT_TX`,
`supabase/migrations/0042_cmd_facility_aliases.sql:67`, header comment at `0042:16` "owner-confirmed typo")
is therefore **wrong** and must be repointed. Confirmed the census
stores facility as **raw free-text name** and never touches `cmd_facility_aliases` at ingest, and the BXR
loop **excludes** `10035166` — so nothing is mis-attributed *today*; the risk is latent until Teen TX is
ingested. **Phase 1 pre-req (before any widened pull):** (a) add `TEEN_MH_TX` to `collections.facilities` +
`BXR_CUSTOMERS` (account `10035166`), (b) repoint the `0042` alias off `TREAT_TX`.

### Net effect on the plan
- Phase 1 aging: **cheaper** — derive from existing `charge_date`; migration likely index-only.
- Phase 1d (widen to full history) + Phase 3a (payer-priority rollup): **blocked** on CMD-side report/filter
  work the census filter can't provide.

### Code anchors — verified 2026-08-01 against commit `15e6484`
Line numbers are as of that commit; if a cited line no longer matches, treat this whole section as
suspect and re-verify by symbol name before acting on it.

| Claim | Anchor (at `15e6484`) | Status 2026-08-01 |
|---|---|---|
| Explorer report default `10091971` | `cmdExplorerConfigFor`, `app/lib/server.ts:1674` | **DRIFTED** — now `10093959` (`10091971` lost in CMD 2026-07-31) |
| Census filter from `CMD_BXR_CENSUS_FILTER_ID` (no default) | `requiredCensusFilterId`, `app/lib/server.ts:1744-1748` | Holds |
| Census inherits the explorer's report | — | **DRIFTED** — census now requires its own `CMD_BXR_CENSUS_REPORT_ID` (`requiredCensusReportId` + `cmdBxrCensusConfigFor`, `app/lib/server.ts:1752-1766`) |
| `Charge From Date` → `charge_date` at ingest | `src/collections/cmdExplorer.ts:27` → `src/collections/cmdCensus.ts:138`, `INSERT_COLS` `cmdCensus.ts:45-49` | Holds |
| NASH = customer `10030911` | `src/collections/cmdCustomers.ts:72` | Holds |
| BXR loop excludes `10035166` (Teen TX) | `BXR_CUSTOMERS`, `src/collections/cmdCustomers.ts` (header lists `10035166` among the excluded accounts) | Holds |
| `0042` alias folds Teen TX → `TREAT_TX` | `supabase/migrations/0042_cmd_facility_aliases.sql:67` | Holds in prod; repoint drafted as migration `0072_teen_mh_tx_facility.sql` (not yet applied) |

---

## Consolidated audit report recon — measured (2026-07-29)

**Provenance:** the recon series' outputs were never persisted (process failure, confirmed by
Alec 2026-07-29); this record was assembled by Alec from the recon session transcripts and is
ruled **measured ground truth**. Measured 2026-07-28/29, customer 10027973 (CAMH) unless noted.

### Report/filter pairs

- **B: report `10064394` / filter `10148376`** — YTD, all statuses EXCEPT paid and
  balance-due-patient. Windows on Claim Date Entered >= Jan 1 (consistent with payload;
  01-15..07-28 observed).
- **C: report `10064394` / filter `10148377`** — BALANCE DUE PATIENT only, ~90d; exact date
  criterion NOT determinable from payload, CMD-side inspection required. B and C are
  **complementary status slices, not nested windows**. Split exists to avoid the extract
  timeout (ruled).
- **A: report `10051337` / filter `10147960`** — AR Aging Summary. 10 columns, NO key, NO
  date, NO dollar columns; 220 rows collapse to 25 distinct tuples; joins the audit plane at
  patient grain only (Patient ID len-8 = `audit_row.cmd_patient_id`). **Not ingestible
  idempotently.**
- **Old IP pair `10064394`/`10147816`: dead since 2026-07-17** — INVALID CRITERIA nightly
  (13 nights, all 8 IP customers, 104 failures); presumed displaced by creation of the
  1014837x filters. Being DECOMMISSIONED, not restored.
- **OP pair `10073210`/`10147817`: healthy**, untouched by the projection change (different
  report). Stays live until the consolidated feed proves 5 clean nights.

### The 42-column positional header set (B and C, identical, verified)

```
 1 Patient Full Name            22 Claim Diag 3 POA
 2 Patient Birthday             23 Claim PPS
 3 Claim Primary Member ID      24 Primary Auth #
 4 Charge/Debit ID              25 Claim Type
 5 Facility NPI                 26 Charge Primary Payer Name
 6 Facility Address 1           27 Charge Modifier 1
 7 Type of Bill                 28 Charge Modifier 3
 8 Statement Covers From Date   29 Charge Modifier 2
 9 Statement Covers To Date     30 Charge Amount
10 Charge From Date             31 Occurrence Code 1
11 Charge To Date               32 Condition Code 1
12 Charge CPT Code              33 Claim Remark 1
13 Charge Billed Revenue Code   34 Claim Remark 2
14 Charge Units                 35 Claim Remark 3
15 Charge Status                36 Charge Claim ID
16 Patient Admission Date       37 Charge Patient ID
17 Claim Principal Diag         38 Provider Full Name
18 Claim Principal Diag POA     39 Office Name
19 Claim Diag 2                 40 Claim Status
20 Claim Diag 2 POA             41 Claim Date Entered
21 Claim Diag 3                 42 Claim First Billed Date
```

Charge/Debit ID inserted at position 4 on 2026-07-29; every prior column from 4 onward
shifted +1; nothing renamed/dropped/reordered. Observed 0%-fill columns (CAMH sample):
Claim PPS, Charge Modifier 1/2/3, Occurrence Code 1, Condition Code 1, Claim Remark 1/2/3.
Note the modifier column ORDER is 1, **3**, 2 (positions 27/28/29) — positional parsing must
not assume 1/2/3.

> ⚠ **DATED CORRECTION (2026-07-30): the projection changed again — now 43 columns.**
> CMD-side edit overnight: `Claim Admit Code` INSERTED at position 19 (validated as
> present, NOT stored — 0049 deliberately dropped it) and the modifier trio MOVED from
> 27–29 to 24–26 (still 1/3/2 order); everything else order-preserved, nothing dropped.
> The header guard rejected all 16 data-bearing customers whole on the 02:40/03:10/03:40
> scheduled passes (runs `partial`, zero bad rows written — exactly its job).
>
> **RULING (Alec, 2026-07-30): the consolidated header guard is now a NAME-SET check,
> not a positional lock** — fail loud on any name added, dropped, or duplicated; ignore
> order (`resolveConsolidatedHeader`). A pure reorder is a non-event; cell reads resolve
> through the per-FILE name→index map, so a reordered file maps to identical values and
> an identical fingerprint (test-proven). Unambiguous here because this projection has
> NO duplicate names — the legacy OP report (duplicate "Charge Status") is exactly why
> the OP path STAYS positional. The 43-name canonical list in `CONSOLIDATED_HEADERS` is
> fixture/documentation order, not a contract. The report is actively tuned upstream —
> under the set guard only genuine adds/drops cost a night, and they name themselves in
> the mismatch label.

### Key & grain

- **Grain: one row per charge line.** CAMH B: 469 rows / 441 claims, one 29-line per-diem
  stay; Charge Units always 1.
- **Charge/Debit ID: digits, len 9, 100% fill, UNIQUE PER ROW across all 16 data-bearing
  customers.** Same identifier space as the census feed's "Charge ID" (C→census join 100%)
  and as `staging.payment_residual.charge_debit_id`.
- Claim Status and Charge Status are **duplicate columns** (identical 18 values; CLAIM AT
  <payer> family plus NEEDS RENEGOTIATING / APPROVED FOR HIGHER PAYMENT / PENDING FOR HIGHER
  PAYMENT / ON HOLD).
- **Claim First Billed Date is the ONLY status-change anchor; 1.3% null =
  entered-never-billed.** NO as-of timestamp exists for current status;
  time-in-current-status is NOT derivable.
- **Patient Admission Date is a real episode anchor** (precedes service window) — the
  collections plane has no admission date anywhere.

### Coverage sweep (filter 10148376, all 17 audit-roster customers, grace 4 first attempt, 2026-07-29)

| scope | facility | customer | rows | patients | claims | TOB set |
|---|---|---|---|---|---|---|
| IP | CAMH | 10027973 | 469 | 30 | 441 | 863,113,861,862,112 |
| IP | DMH | 10033950 | 532 | 37 | 429 | 863,861,862,867,868 |
| IP | KWC | 10034908 | 740 | 42 | 513 | 863,862,868,867,861 |
| IP | LSMH | 10031977 | 443 | 38 | 369 | 863,861,862,867,117,864,113,868 |
| IP | LAMH | 10033690 | 223 | 20 | 223 | 863,862,861 |
| IP | NASH | 10030911 | 842 | 57 | 596 | 863,867,117,862,861 |
| IP | PCMH | 10030471 | 268 | 17 | 235 | 863,111,113,862,112,861 |
| IP | TBH | 10029105 | 420 | 29 | 343 | 863,867,861,862,868 |
| OP | FRCA | 10032340 | 117 | 10 | 92 | 893,133,897,132 |
| OP | TELEHEALTH_MH | 10034666 | 749 | 54 | 387 | 893,892,897 |
| OP | TREAT_CA | 10030101 | 791 | 69 | 434 | 893,133,897,892,137 |
| OP | TREAT_NV | 10034671 | 980 | 50 | 517 | 893,892,133 |
| OP | TREAT_TN | 10029905 | 235 | 26 | 126 | 893,897,892 |
| OP | TREAT_TX | 10029722 | 481 | 50 | 220 | 893,137,892,763,133 |
| OP | TREAT_WA | 10031212 | 676 | 43 | 635 | 893,892,898,897 |
| OP | TEEN_MH_TX | 10035166 | 259 | 12 | 142 | 893,892 |
| OP | WRC | 10033951 | 0 | 0 | 0 | (SUCCESS-empty ×3, documented empty/defunct account) |

Totals: **8,225 rows, 584 patients, 5,202 claims.** 42 columns and unique Charge/Debit ID
confirmed in every data-bearing customer. **TEEN_MH_TX is LIVE on the audit plane despite
collections exclusion** (separate-legal-entity ruling 2026-07-28). TEEN_MH_TX and WRC are
audit-roster only — NOT in `BXR_CUSTOMERS`; audit rows there have no collections/rollup
counterpart.

### Scope derivation (measured, zero overlap)

- **Type of Bill first-two-digit prefix: {11,86}=IP, {13,89,76}=OP.** 763 (TREAT_TX, 6 rows)
  is why the PAIR is required — a second-digit rule fails on it.
- Corroboration: Charge Billed Revenue Code partitions identically — 01xx/10xx IP-only,
  09xx OP-only.
- Claim Type does NOT discriminate (Institutional appears in both). CPT does NOT
  discriminate (H2018 spans both scopes). maxLinesPerClaim > 4 ⇒ IP is sound but the
  converse fails (LAMH IP max=1) — directional only.
- NO customer returns mixed scopes — strict partition holds empirically on this window.
  **Derivation must FAIL LOUDLY (quarantine + run flag) on any unrecognised TOB prefix,
  never default.**
- One-customer==one-facility does NOT hold universally: report A showed 2 Facility
  Names/NPIs under CAMH; B shows 2 offices for TBH and TREAT_TN, 2 NPIs for
  CAMH/NASH/TELEHEALTH_MH/TREAT_CA.

### Join reachability (measured)

- `cmd_explorer_charge_rollup` has **NO charge_id column**. Only path to a rated row:
  `audit.charge_debit_id → cmd_explorer_rows.charge_id → rows.id → rollup.id`.
- `cmd_explorer_rows.charge_id` fill: **0.86% all-time / 2.48% trailing 365d.** Ramp
  healthy: 0% before 2026-07-21, 70.2% on 07-21, 100% from 07-22 (~600–1,600 rows/day).
  History permanently NULL (append-only, fingerprint dedup, no UPDATE grant) — ledger gate
  ②c, now quantified.
- B → census 69.9% (population difference, YTD vs census window); **C → census 100.0%
  (proves shared identifier space)**; B → explorer_rows 1.1% — **STRUCTURAL, not ramp**:
  B's population is unpaid claims, which have no payment postings by definition;
  C → explorer_rows 36.6% (adjudicated claims).
- **Consequence (ruled):** factor-3-style metrics are slice-level ratios permanently;
  universe = B + C + rollup, valid only on the audit-roster ∩ `BXR_CUSTOMERS` set.

### SUCCESS-empty race

- Observed once in ~19 runs of B (~5%/call, tiny sample); 0/17 on the sweep. Prior art:
  the 2026-07-02 explorer outage entry (S1 watch items above).
- **Recording defect (code-confirmed, auditIngest.ts:238,345):** a SUCCESS-empty customer
  increments `customers_processed` and touches none of the partial terms — a raced night
  records `status='ok'`. Grace values in flight: library default 4; audit path
  `CMD_AUDIT_EMPTY_GRACE||6`; the one observed race needed 10.

### Projection delta vs the dead 46-col IP_HEADERS (pre-Charge/Debit ID comparison)

+14 net-new incl. Facility NPI, Claim Status, Claim Date Entered, Claim First Billed Date;
−19 dropped incl. **Last Public FU Note (the open PHI free-text watch item — its removal is
a PHI-surface REDUCTION)**, Claim Diag 4/5/6 (+POA +descriptions), Claim Admit Code.
Positional parser: the old header set cannot read the new projection.

### Rulings on this record (Alec, 2026-07-29)

1. **Ingest identity = OPTION B**: upsert on charge_debit_id, with the ruled transition —
   one-time fingerprint-match backfill of `charge_debit_id` onto legacy rows, then flip the
   conflict key. Key shape (cmd_customer_id column vs `(business_entity_id,
   charge_debit_id)` after verifying global uniqueness) decided at the 0073 gate.
2. **Status history: current-state-only.** The append-only status-transition table is
   FUTURE WORK — recorded here, not built. (Today's `ON CONFLICT … DO UPDATE` already
   overwrites status history; option B loses only the accidental near-dupe "history" of
   stranded identity-field changes.)
3. **HOUSTON_MH / TREAT_CO: the two-run probes were never actually run.** Probes ordered
   (read-only, shapes-only) before any roster/rule-file change.

### Outstanding (recorded, does NOT gate the consolidated-ingest build)

- **Item 4 a–d — the B+C+rollup slice reconciliation** remains OWED; it gates the Qualify
  aggregate-view session, not this build.
- Future work (ledger note only, per ruling 2): append-only status-transition table if the
  desk ever needs status HISTORY rather than current state.

---

## Consolidated audit ingest — BUILT + CUTOVER (2026-07-29 overnight build session)

Alec delegated gate authority to senior-engineer discipline for this session ("no HOLDs
for me"); every gate decision below is recorded as it would have been presented.

### What shipped

- **Migration 0073 APPLIED** (see the reservation table above): the five audit_row
  columns, the `(business_entity_id, charge_debit_id)` partial-unique identity key,
  `audit_ingest_run.customers_empty`, scope CHECK widened to `CONSOLIDATED`.
- **Consolidated ingest** (`src/billingAudit/auditConsolidated.ts` + `mapConsolidatedRow`
  in `auditRowMap.ts` + `handleBillingAuditConsolidatedCron` in `app/lib/server.ts` +
  `/api/cron/billing-audit-consolidated`): per customer B (`10148376`) then C
  (`10148377`) sequentially; 42-col locked positional headers (modifier order 1/**3**/2);
  scope TOB-derived per row, unrecognised prefix → row QUARANTINED + run `partial`;
  rev-code partition logged as a consistency counter; every row stamped
  `cmd_customer_id` + `source_filter_id`.
- **Identity (ruling B, 2026-07-29):** upsert on the key; legacy NULL-key rows
  fingerprint-matched (primary recipe or the legacy-IP variant with modifier-2 blank)
  and stamped THROUGH the old fingerprint arbiter; `row_fingerprint` is WRITE-ONCE; the
  fingerprint UNIQUE constraint is retained while the OP pair soaks (it is the OP cron's
  arbiter) — a same-fingerprint-different-key row quarantines (`fingerprint_conflict`,
  measured zero) until the decommission migration relaxes it.
- **Honest run recording (item 6):** `customers_empty` counted on BOTH loops (OP too);
  a SUCCESS-empty customer that has prior rows and is not allowlisted (WRC `10033951`)
  → `customers_empty_unexpected` → run `partial`. "Prior-night rows > 0" implemented as
  "has EVER landed rows" (`facility_code` existence probe) — equivalent seed on this
  append-only current-state table, deliberately minimal. Grace untouched
  (`CMD_AUDIT_EMPTY_GRACE || 6`; the one observed race needed 10 — recorded, not tuned).
- **Nightly shape:** 3 passes (02:40 / 03:10 / 03:40 UTC — clear of the 02:20 OP cron
  on the shared one-report-at-a-time CMD partner session); each pass skips customers an
  earlier CONSOLIDATED run finished today (UTC, read from `audit_ingest_run.per_customer`);
  a pass with nothing left is a no-op that records no run row. The 17×2 sweep (~34
  report runs ≈ 9–12 min) cannot fit one 300s invocation — that is WHY multi-pass.

### OP-scope soak deferral (gate decision, recorded)

While the OP pair (`10073210`/`10147817`) soaks, the consolidated ingest FETCHES,
derives and counts OP-scope rows but does NOT write them
(`CMD_AUDIT_CONSOLIDATED_OP_WRITE`, default off). Writing would (a) near-dupe ~14k OP
rows — the two recipes necessarily fingerprint OP rows differently (units populated vs
never-hashed) so the backfill cannot match them, and (b) let two feeds co-write the same
charges, contaminating the very soak we are grading. Consequence accepted: C's OP-scope
balance-due-patient rows also defer until cutover. Fetch-side reconciliation still
proves the feed on all 17 customers nightly.

### IP cutover + the 07-16 → 07-29 gap

The dead IP pair (`10064394`/`10147816`, INVALID CRITERIA nightly since 2026-07-17) is
DECOMMISSIONED: vercel.json entry removed, route deleted, `handleBillingAuditIpCron`
removed; `audit_ingest_run` history intact. **The YTD B refetch closes the IP gap at
current-status grain on the first consolidated run** (under identity B the backfill
stamps matching legacy rows and inserts the rest — no near-dupes); the 13 dead nights'
intermediate status flips are unrecoverable (current-state-only model). Corrected
Phase-3 status: soak restarts on the CONSOLIDATED feed; the OP pair decommissions after
5 clean consolidated nights (then: drop the fingerprint UNIQUE → plain index, flip
CMD_AUDIT_CONSOLIDATED_OP_WRITE, delete OP route/config, one-time cleanup of any
OP-sourced NULL-key twin rows).

### ⚠ OPERATOR STEP REQUIRED BEFORE THE FIRST SCHEDULED RUN (02:40 UTC)

Session tooling denied `vercel env add` (correct per the permission gate) — **Alec must
set, in Vercel Production: `CMD_AUDIT_CONSOLIDATED_REPORT_ID=10064394`,
`CMD_AUDIT_CONSOLIDATED_FILTER_B_ID=10148376`, `CMD_AUDIT_CONSOLIDATED_FILTER_C_ID=10148377`**,
then redeploy (env changes are inert until a deploy). Until then the consolidated cron
500s LOUDLY at compose time (env-var-only, no fallback — the safe failure); the OP cron
is unaffected. `CMD_AUDIT_CONSOLIDATED_OP_WRITE` stays UNSET during the soak.

### Feed-population caveat (carry for every audit_row consumer)

B excludes PAID and BALANCE-DUE-PATIENT; C covers balance-due-patient (~90d). A claim
that transitions to PAID simply STOPS APPEARING — its audit_row keeps its last non-paid
status forever. audit_row is a WORKLIST, not claim-state truth for paid-ness (the
collections plane owns payments). This predates the consolidated feed but the YTD
refetch makes it systematic; do not "fix" it by inferring PAID from absence.

### First consolidated run — EXECUTED MANUALLY, RECONCILED (2026-07-29 09:39–09:45 UTC)

17/17 customers, failed 0, header-mismatch 0; **B fetched counts matched the recon sweep
with ZERO drift on all 16 data-bearing customers** (469/532/740/443/223/842/268/420/117/
749/791/980/235/481/676/259); WRC expected-empty (allowlisted, run status ok). Fetched
11,092 (IP 4,779 / OP 6,012 deferred); **inserted 960 + stamped 3,819 legacy IP rows,
identity_conflicts 0, rev_code_inconsistent 0** — DB-verified post-run: IP keyed rows =
4,779 exactly (= 960+3,819), OP keyed = 0 (deferral held), 14,539 legacy OP + 7,742
legacy IP rows untouched at NULL key (not re-sent by B/C — resolved/paid statuses fell
out of the feed population, expected). Run row recorded scope=CONSOLIDATED.

**⚠ FINDING — 301 rows quarantined, ALL blank TOB, ALL OP-side customers = PROFESSIONAL
CLAIMS (needs Alec's scope ruling).** Shapes-only probe (TREAT_TX B+C): every blank-TOB
row is `Claim Type=Professional` with NO revenue code (CPTs 90853×97, 90837×4, 90791×2
— group therapy/psychotherapy); every institutional row carries TOB+rev. Professional
1500-form claims have no Type of Bill BY DEFINITION, so TOB derivation cannot scope them
— the fail-loud quarantine worked exactly as ruled (counted, labelled, run marked
partial; rows are NOT lost — B/C refetch nightly and they ingest the moment a rule
lands). Note some professional claims DO carry a TOB (19 on TREAT_TX B) and scope fine.
**Decision owed: scope rule for TOB-less professional claims** (candidates: OP-by-claim-type,
or a professional third scope — not invented overnight). The DoD's "zero quarantined
rows on today's data" is therefore NOT met — deliberately, honestly.

**Dated correction to the recon record above:** B's `Claim Date Entered` spans back to
**2025-04-24** live (min over the ingested IP slice), not ">= Jan 1" — that observation
was CAMH-sample-only. B's real window criterion is looser than YTD-entered or varies by
customer; CMD-side inspection still owed.

### Probe results (2026-07-29, clean CMD window, CAMH positive control 469×42 green)

HOUSTON_MH `10035976` → INVALID CRITERIA · TREAT_CO `10035974` → INVALID CRITERIA ·
TREAT_VA `10036125` → INVALID CRITERIA (new customer; filter not shared CMD-side; also
absent from the 2026-07-03 `core.cmd_customer` seed). Rule file
(`.claude/rules/billing-audit.md`) updated to the ruled reality the same session.

### RULING — professional-claim scope fallback (Alec, 2026-07-29; 0074)

**The 301 quarantined blank-TOB rows are STRUCTURAL, not a data gap:** professional
claims (CMS-1500/837P) never carry Type of Bill or revenue codes — institutional
(UB-04/837I) fields. TOB derivation is INAPPLICABLE to them, not degraded.

- **Verified before implementing** (shapes-only probe, all 8 affected customers, B+C,
  16:43 UTC): **308 both-blank rows** (up from the morning's 301 — daily drift), **ZERO
  rows with TOB blank but rev present, ZERO with TOB present but rev blank**, and every
  both-blank row is `Claim Type=Professional`. No split — the rule applies cleanly.
- **Fallback rule (implemented):** TOB AND revenue code BOTH blank → scope from the
  customer's roster membership (`rosterScopeForCustomer` — AUDIT_IP vs AUDIT_OP,
  entity-level not row-level). **CPT rejected as a signal** (H2018 spans both scopes,
  recon-measured). A recognisable TOB always wins over the roster.
- **Provenance:** `audit_row.scope_source` ('tob' | 'roster_fallback', migration
  **0074 APPLIED 2026-07-29**; pre-0074 keyed rows backfilled 'tob' — all were
  TOB-derived by construction). The audit trail if a customer ever returns mixed scope.
- **Fail-loud STAYS, narrowed:** blank TOB with a revenue code PRESENT, a non-blank
  unrecognised TOB, and a both-blank row from a customer not in exactly one roster all
  still QUARANTINE. The ruling narrows the condition; it does not remove it.
- **Soak clock (stated per Alec's ask):** RESTARTS from the first night on the
  corrected logic — nothing is actually lost, because no scheduled night has run yet
  (env vars pending) and the one manual run recorded `partial` *because of* these rows,
  which was correct behavior, not an anomaly. Night 1 of 5 = the first scheduled run
  with env vars + this fix deployed.
- **Re-run PROVEN (16:50 UTC, 8 affected customers, post-0074 code):** quarantined
  **0** (was 301/308), `roster-fallback 308`, 8/8 processed, 0 failures/empties → run
  row recorded **status='ok'** (DB-verified; the 09:39 run's 'partial' stands as
  correct history). All 308 fallback rows are OP-scope → DEFERRED under the soak
  (inserted/updated 0 by design); they write at cutover. TREAT_NV +81 / TREAT_WA +75
  vs the morning sweep = intraday feed growth (matches the 16:43 probe exactly).

**Excluded-customer resolutions (Alec, same date — TWO DISTINCT CASES, do not collapse):**

- **HOUSTON_MH `10035976` + TREAT_CO `10035974`: not yet open.** Supersedes "defunct vs
  new-no-data unconfirmed" (backlog item closed — they are pre-open, NOT defunct).
  Filters will be changed once they open; re-add to the roster only after a
  rows-bearing probe at a gate, as already ruled.
- **TREAT_VA `10036125`: a DIFFERENT case — brand-new pre-launch facility, not open
  yet.** Resolution is OPERATIONAL, not diagnostic: **switch/share the filters when it
  opens, do NOT re-probe** (Alec, 2026-07-29). Nothing about this facility is unknown
  or suspect — do not read its INVALID CRITERIA as defunct-class; it simply predates
  its own launch.

### Pre-launch facilities — the zero-rows launch trap (recorded 2026-08-01, NOT built)

**LAUNCH CHECKLIST ITEM — not a code change now.** This is the failure mode that will
bite when HOUSTON_MH `10035976`, TREAT_CO `10035974`, or TREAT_VA `10036125` open.

Zero rows from these three is **CORRECT today and BROKEN the day after they open**, and
nothing in the current logs can tell those two states apart. Today they are not merely
empty — they are **not in any roster**, so they are never called at all
(`CMD_EXPLORER_CUSTOMERS` = 15, `AUDIT_CONSOLIDATED_CUSTOMERS` = 17; none of the three
appears in either). At launch someone adds them to a roster, and from that moment:

- filter never shared under the account → `INVALID CRITERIA` → `customers_failed` → **loud,
  fine**;
- filter shared but scoped wrong (wrong window, wrong report, charge-date instead of
  payment-received) → **zero rows, counted as a success, indistinguishable from the quiet
  pre-launch facility it was yesterday**.

The second case is the trap, and the cron log cannot surface it. Verified in code, not
assumed: `stats.customers_processed += 1` is the LAST statement of the per-customer `try`
(`cmdExplorerCron.ts:280`) and runs regardless of how many rows came back, so
`customers N/N` counts **customers that did not throw**, never **customers that returned
rows**. The 2026-08-01 04:00 run logged `customers 15/15 (failed 0)` on `fetched 0`. The
only aggregate signal is `fetched`, which is summed across the roster — so one silently
empty facility among fourteen productive ones moves that total by a rounding error and is
effectively invisible.

**What each facility needs at launch:** an expected-NONZERO marker, so a first run that
returns nothing fails loudly instead of reading as pre-launch quiet. The inverse pattern
already exists and is the shape to mirror — `EXPECTED_EMPTY_AUDIT_CUSTOMERS`
(`src/billingAudit/auditConfig.ts`, currently `{10033951 WRC}`) pins the facilities that
are *expected* to be empty. A facility is in exactly one of those two sets; being in
neither is what makes silence ambiguous.

Do NOT build this now — none of the three is open, and an expected-nonzero assertion
against a pre-launch account would itself fail every run. Build it as part of the launch
of whichever facility opens first.

### ⚠ Signal-misread pattern — five instances in one session (recorded 2026-08-01)

**Pattern: do not infer health from a signal that is not measuring health.** Five times
this session an artifact was read as a health signal and produced — or nearly produced —
a wrong conclusion:

1. `cmd_explorer_rows` is append-only under the daily replace — a zero-new-rows read was
   taken as a failed run, when the table measures *rows written*, not *run success*.
2. `cmd_census_run` records errors only — an empty error set was read as success, when
   the table has nothing to say about a run that never wrote.
3. A Vercel status-0 log entry was read as a hung function — it was log-ingestion lag,
   a property of the *log pipeline*, not the function.
4. A bad `awk` range and a bad index-name probe each nearly produced a wrong conclusion —
   the output faithfully measured the query as written, not the question being asked.
5. `customers N/N` counts customers that **did not throw**, never customers that
   **returned rows** — `stats.customers_processed += 1` is the last statement of the
   per-customer `try` (`cmdExplorerCron.ts:280`, `cmdCensusCron.ts:306`), proven by the
   2026-08-01 04:00 run logging `customers 15/15 (failed 0)` on `fetched 0`. Operational
   consequences under "Pre-launch facilities — the zero-rows launch trap" above.

### ⚠ CMD-QUIET-WINDOW RULE (learned the hard way this session)

Any ad-hoc CMD API work (probes, manual ingest runs) must run in the **:41–:59 window**.
The CMD partner session runs ONE report at a time and `cmdRunReport` returns an
already-running report's identifier — a probe fired during the :00/:15/:30/:35 cron
ticks can consume a production cron's results poll. Demonstrated live: this session's
first probe batch ran through the :30/:35 ticks and its CAMH positive control falsely
read SUCCESS-empty (the same control returned 469 rows in the :41–:59 window minutes
later). The 02:40/03:10/03:40 consolidated schedule respects the same constraint.

**Separate WATCH ITEM (morning): indigo-census customer `10033859` (INTO THE LIGHT)
began failing `fetch_failed` at 08:35 UTC 2026-07-29** — initially suspected as this
session's probe collision, but the 09:35 recurrence happened with NO ad-hoc CMD work
running (identical ~22s-then-fail signature), so it looks upstream/CMD-side (same class
as the recurring `10036020`/`10036030` failures). If it persists into the day, inspect
that customer's census filter CMD-side; the census cron correctly logs one clean error
row per invocation and re-pulls hourly.

## CMD 835 download — contract caveats (2026-07-30, documented contract, no live probe)

Verified the `download-835` wire contract against CMD's documentation and rewrote the
client (`src/collections/cmd835.ts`) around it. The endpoint is
`GET /v1/customer/{customer}/payment/download-835?date=YYYY-MM-DD` — **one** `date`
param (the previous `startDate`/`endDate` pair was a guess; CMD ignores unknown params,
so it silently served the wrong day). Success is `application/zip`; a day with no ERAs
is **HTTP 200** with the text body "No 835 ERA files were received on that date." — not
204, not 404. Requires the CMD **Payment** role.

Two caveats below have operational consequences beyond the client. The code comment in
`cmd835.ts` points here rather than duplicating them.

**(a) `date` is the ERA RECEIPT date at CMD, not BPR16.** It is a different axis from
the stored `payment_date`: a remit *received* on the 3rd can carry a payment date of the
1st. Consequence for scheduling — **a daily cron must re-pull a 3–5 day lookback, not
just yesterday**, because ERAs land late and a strict yesterday-only pull will
permanently miss them. Re-pulling is free: `era835Fingerprint` dedups at the row level
and `insertEra835Rows` is idempotent, so an overlapping window costs bandwidth and
nothing else. Do not "optimize" the lookback away.

**(b) The endpoint excludes deleted 835s and returns a full-day snapshot.** It reports
the *current* set of non-deleted ERAs for that date, not an append-only log. So a
re-pull of the same date can legitimately return **fewer** files than the first pull, if
someone deleted a remit at CMD in between. Because `staging.era_835_adjustment` is
append-only, rows from a since-deleted 835 stay in our table forever. This is a
**reconciliation caveat, not a bug**: our totals for a historical date can exceed what
CMD would hand back today. Anyone diffing our stored 835 rows against a fresh CMD pull
must expect our side to be a superset, and must not "fix" the gap by deleting rows.

**(c) The byte cap bounds the COMPRESSED download only — decompression is still
unbounded.** `MAX_RESPONSE_BYTES` (32 MiB, `cmd835.ts`) is enforced while streaming the
response, but `readZipEntries` then inflates without a ceiling, so a well-formed ~900 KB
ZIP that expands to several GB passes the cap and dies in memory instead of throwing.
Threat model is low — an authenticated CMD endpoint, not user-supplied upload — so this
was deliberately NOT treated as a blocker. The fix is a decompressed-bytes cap, and the
place to add it is `read835Files` / `readZipEntries` the next time either is open.

**VERIFIED LIVE 2026-07-30 08:41 UTC** (supersedes this section's original "not probed
live" note). One dry-run, read-only pull inside the :41–:59 quiet window — customer
`10030911` (NASH, BXR), date `2026-07-24`, no `--commit`, no DB connection opened:

```
pulls 1 (failed 0, empty 0, zero-file zips 0, budget-skipped 0);
files 2, claims 3, adjustments 16, remarks 16; in-set dups 0; inserted 0
```

Four things this settles at once: (1) the single `date` param is **accepted** — no 4xx;
(2) the response was **application/zip**, i.e. the documented success shape; (3) the
`{ kind: 'zip' }` branch fired and magic-byte classification held against a real body —
`readZipEntries` found 2 entries, both ISA-prefixed (`zero-file zips 0`); and (4) the CMD
user behind `CMD_API_USERNAME` **does carry the Payment role** — a 403 would have said so
explicitly. ~~The rewritten contract is verified end to end.~~

> **CORRECTION 2026-07-31 — "verified end to end" IS OVERSTATED. Do not rely on it as
> originally written.** Only the ZIP (has-files) path has been verified against live CMD.
> **The empty-day path has never been exercised successfully** — not by this pull, and not
> by either probe run since. See "CMD 835 probe — failure-mode findings (2026-07-31)"
> at the end of this file, items 3 and 4. The empty-vs-failure split built and committed in
> `c412535` is therefore only half-verified.

**Still unproven by this pull:** that CMD *honours* `date` rather than defaulting. A
single successful pull cannot distinguish "returned 2026-07-24" from "ignored the param
and returned its default day" — the old `startDate`/`endDate` bug had exactly that
signature. Closing it costs one more call: pull a date that should be empty (e.g. Sunday
`2026-07-26`) and confirm the sentinel/`empty` branch fires. That would prove the date is
honoured AND exercise the empty path live.

### RESOLVED 2026-07-31 — mechanism identified, fix applied (empty path now covered)

The correction above stands as written; this is the resolution appended to it, not a
replacement. **Do not delete the correction — the history of the wrong claim is the point.**

**Mechanism.** CMD's live no-data response is a **44-byte printable-ASCII body**,
sha256 `83b3fc6a77ef99a73263d6b1632b4e05edaf32197cc60327ef057e951728f290`, **byte-identical
across 2 customers × 4 dates** (FRCA `10032340`, TBH `10029105`, 2026-07-28..31 — 8/8 calls,
one digest). Three compounding causes:

1. **Wording drift.** `isEmptyDayBody()` matched the *documented* sentence; CMD sends
   different wording, so the matcher never fired and **every quiet day counted as a hard
   failure**. (Coincidentally the documented sentinel is *also* 44 bytes — length is not
   evidence of anything, which is one reason the fix keys on the digest.)
2. **`Content-Type` is a mislabel.** CMD serves that text body as `application/zip`. The
   header cannot be trusted; `isZip()` correctly rejects it on magic bytes.
3. **The empty path had never been exercised** — not live, and not in tests. That absence
   *was* the defect; a prose matcher nobody had ever seen fire was assumed correct.

**Fix (`src/collections/cmd835.ts`).** Three-way digest-anchored classification: ZIP magic
bytes → data; sha256 ∈ `KNOWN_EMPTY_DAY_DIGESTS` → `empty`; everything else → typed failure
carrying digest + byte length. Short printable bodies of *unidentified* shape get their own
bucket `unrecognized_short_text` (the drift queue); HTML/JSON/EDI stay in
`unrecognized_body` so a service fault can never be mistaken for a candidate no-data
message. The prose matcher survives as a **diagnostic flag only** (`markerMatched`) and
must never again decide classification.

> **Why an exact allowlist and NOT "short + printable ⇒ empty".** The heuristic trades a
> loud bug for a silent one: a genuine error served with HTTP 200 would be swallowed as a
> quiet day, making "no upcoming payments today" indistinguishable from "the feed broke" —
> on a money feed, the worst failure mode, because it looks like good news. The allowlist
> is loud on drift by construction: if CMD reworders, quiet days fail in
> `unrecognized_short_text` with the **new digest printed**, and the fix is one line here,
> not another multi-session investigation.

**Zero disclosure**, carried into production code: hashing and byte-length are the *only*
operations performed on an unrecognized body. No previews, no debug flag, no first-N-bytes
— same constraint as `scripts/probe-era-coverage.ts`, and stated in-code so it is not
"helpfully" relaxed later.

**Tests.** The empty path is now covered: allowlisted digest → `empty`; real ZIP → data
(guards the working path); **short printable body with a different digest → failure, not
`empty`** (the anti-silent-swallow test, using the documented sentinel as the fixture
precisely because it *reads* like a quiet day); digest stability; and per-bucket
shape/digest/length reporting with an assertion that the body never appears in the message.
`cmdDownload835` accepts a `knownEmptyDayDigests` **test seam** — required because the
production digest's preimage is deliberately not stored anywhere, so no hermetic test can
synthesize a matching body. It must never be set in production or wired to an env var.

**Wording NOT recovered.** A timeboxed offline attempt hashed 144,000 candidate phrasings
(4,845 of them exactly 44 bytes) against the digest with **no match**. The exact sentence
remains unknown — and does not need to be known, since classification is by digest. Anyone
retrying: the space not yet covered includes different leading words, embedded customer or
date substitution, and non-ASCII punctuation.

**Still open:** items 1, 2, 5 and 8 of the findings above are untouched by this fix — the
root cause of the two failure episodes is still UNKNOWN, the probe's `failed` counter still
has no per-status breakdown, FRCA/TBH's 4/4 failures are unexplained, and the possible 5th
CMD-facing cron is unscoped. **This fix addresses item 3/4 only.** It is also still
LATENT-only in production: no `app/` code imports the 835 ingest and no cron runs it, so
this lands *before* the ingest cron exists rather than in response to live bleeding.

## CMD 835 probe — failure-mode findings (2026-07-31, save-state, no fixes applied)

Two live probe runs of `scripts/probe-era-coverage.ts` (throwaway, untracked, read-only —
no DB writes, no schema change). Save-state only: **nothing here has been fixed.** Facts as
observed; open questions marked as open.

### 1. Throttle theory is DEAD — root cause of both failure episodes is UNKNOWN

| Run | Roster | Pacing | Failures | Outcome |
|---|---|---|---|---|
| 2026-07-30 20:41 | 47 customers | ~3.5 req/sec | **30%** (60/196) | hard 401, aborted |
| 2026-07-31 00:41 | 15 BXR | ~0.55 req/sec (6x gentler) | **42%** (25/60) | no 401, completed 60/60 |

**The failure rate went UP with six-times-gentler pacing.** This rules out rate limiting as
the explanation for either night's failures. **Do not re-introduce "throttling" as an assumed
root cause in any future prompt or comment without new evidence — it was tested and
falsified.**

### 2. BLOCKING: the probe's `failed` counter has no per-status/error-code breakdown

42% of tonight's pulls are unexplained and this is the only way to find out what they are.
This is no longer a hygiene gap. **It must be the first thing fixed next session, before any
further live run.**

### 3. SUSPECTED INSTRUMENT BUG, UNCONFIRMED — empty-day sentinel matcher

The empty-day sentinel matcher (in the `cmd835` transport — **the same code path as
production `era_ingest`**) may be misclassifying genuine no-ERA responses as failures.

Evidence: 60 pulls across 15 facilities over 4 weekdays produced **`empty-day 0`** —
implausible if the sentinel worked. **NOT YET VERIFIED.** Needs one pull against a date
confirmed to have no ERAs, cross-checked with the per-code breakdown from item 2 once it
exists.

### 4. IF ITEM 3 CONFIRMS, THIS AFFECTS PRODUCTION, NOT JUST THE PROBE

The empty-vs-failure split was built and committed in `c412535` and described in this
ledger as "verified end to end". **That claim is now overstated and has been corrected
in place** in the "CMD 835 download — contract caveats" section above. Only the ZIP
(has-files) path is verified against live CMD; the empty path has never been exercised
successfully.

**Documentation was fixed first, deliberately — the code has NOT been changed.** Fix the
claim so it stops being wrong; fix the code once diagnosed.

### 5. FRCA and TBH — 4/4 pulls failed for both, zero data across the entire run

Different in kind from the other 13 BXR facilities, which all returned at least some data.
**Do not assume this shares a root cause with the general 42% failure rate** — treat as a
possible separate structural issue (customer-ID mapping, alias resolution, deactivated
account) until the per-code breakdown shows otherwise.

Next session: check **FRCA's customer-ID mapping specifically** against the CMD roster
config. FRCA is already flagged as "classified OP, kept distinct from collections' TREAT_TX
merge" — a plausible place for an alias/ID mismatch to hide.

### 6. DO NOT compute a coverage rate from tonight's data

The saved `daily_collections` gross covers **07-21..27**. Tonight's run's BPR16 values span
**07-16..08-04** — a different, wider, not-overlapping-enough window. Any ratio between the
two would compare mismatched periods and misstate coverage. A real coverage rate requires a
re-run with matching windows, **after items 1–5 are resolved**.

### 7. The demonstrated feature value is REAL and independent of the above bugs

**$72,986.79 in upcoming ACH payments (BPR16 2026-08-03 / 08-04)** was correctly identified,
non-suppressed, with single-claim rows flagged via a claims-count column rather than hidden.
This proves the underlying approach — **BPR16-keyed, claims-count-flagged** — works once the
instrument is trustworthy. **Do not discard this result.** It is evidence the design is
right, separate from whether the failure/coverage numbers are trustworthy yet.

### 8. NEW OPEN THREAD, NOT YET SCOPED — a 5th CMD-facing cron

Any production cron that eventually pulls 835s for the Overview "upcoming payments" tile
must run in the same **:41–:59 quiet window** as the existing four CMD-facing crons
(`cmd-explorer` :00, `cmd-census` :15, `indigo-explorer` :30, `indigo-census` :35), on
`CMD_API_USERNAME`, without colliding with them. Raised explicitly by Alec — the dashboard
tile needs to work "in parallel with my other crons feeding paid claims".

This is a scheduling/design question, separate from and downstream of the coverage work.
**Do not scope this cron until the coverage rate is known AND the failure-rate mystery
(items 1–2) is resolved** — a 5th CMD-facing cron should not be designed against an
instrument that is currently misreporting its own failure modes.

### 022 — `staging.era_835_ingest_run` (per-run 835 observability) — 2026-08-02

**Next free Veris number after this: 023.** Checked before claiming 022 (2026-08-02) three
ways: origin/main + the working tree incl. untracked files (`SQL Schemas/` high-water 021);
this ledger's own "next free Veris number: 022"; and the LIVE database —
`staging.era_835_ingest_run` did not exist, and 021 is genuinely applied there
(`member_id_enc`, `member_id_bidx`, and `era_835_member_id_bidx_idx` all present).

**WHY.** The 2026-08-02 05:00 UTC manual production run of `/api/cron/era-835` parsed **112
remits and inserted 39**. The other **73 (65%)** were swallowed by `ON CONFLICT DO NOTHING`
and recorded **nowhere** — run stats lived only in the HTTP response body (discarded by
Vercel's cron runner) and `console.log` (gone from `vercel logs` by morning). A silent
no-op had to become queryable after the fact. Same durable-observability fix, and the same
fail-soft posture, as `supabase/migrations/0053` did for `claims.audit_ingest_run`.

**Grain: ONE ROW PER TENANT PER RUN.** `runEra835Ingest` loops one roster that may span
tenants and every counter is computed with `customer.businessEntityId` in scope, so
attribution is exact. The rejected alternative — skip the run row when the roster spans
tenants — is a silent observability hole: the first time Indigo joins the 835 roster, ERA
observability would stop with no signal. Today's roster is BXR-only, so one row per run.

**Shape.** Owner `claims_admin` (SET ROLE), RLS on / FORCE off, GUC-checked policies on
`app.business_entity_id`. `claims_reader` SELECT, `cmd_rollup_writer` **INSERT only** —
tighter than both 013 and 0053 on purpose: no `ON CONFLICT` arbiter and the ingest never
reads the table back, so there is no writer SELECT policy and no writer SELECT grant. PK is
`GENERATED ALWAYS`, so no sequence grant. **Append-only: no role holds UPDATE or DELETE.**
Recent-lookup index `(business_entity_id, finished_at desc)` per the 018 leadership rule.

**PHI.** Counts, ISO dates, the writer role name, failure CODES, and error MESSAGES only.
`error_detail` is bounded to 500 chars by CHECK. **Deliberately NO `per_customer` array**
(unlike `audit_ingest_run`): on this feed that would be a per-facility remittance-activity
breakdown, a materially richer disclosure than the product plane's row counts. Do not add
one.

**Two counters that did not exist anywhere in this codebase before.**
`payments_duplicate` / `rows_skipped_duplicate` count the `ON CONFLICT DO NOTHING` path at
both grains. This is what finally makes 013's documented duplicate-remit detector usable —
013 states "a re-pull of an already-ingested date MUST report `payments_inserted = 0`", and
until now there was no record of yesterday's run to compare against. With a 5-day trailing
window four of every five pulled dates are re-pulls, so the **healthy steady state is a HIGH
`payments_duplicate`** against a `payments_inserted` equal to genuinely new remits only.
`payments_inserted` staying high against a stable `payments_mapped` means the remit
fingerprint has destabilised and BPR02 is being double-counted.

**`status` vocabulary — `empty` and zero-attempts are the non-obvious ones.**
`failed` (handler threw) · `partial` (`pulls_failed + pulls_zero_files +
pulls_skipped_budget > 0`) · `empty` (`pulls_attempted = 0`, OR `pulls_empty =
pulls_attempted`) · `ok` otherwise. `empty` is a distinct state because
`pulls_empty == pulls_attempted` is BOTH a quiet day AND the exact signature of the CMD
credential having lost its Payment role — today that case returns `200 {ok:true}` and is
indistinguishable from a quiet day, which is how this ingest could sit dead in production
unnoticed. **Two consecutive `empty` runs across a 5-day window is page-worthy.**
Zero attempts is also `empty`, not `ok`: a run that attempted nothing has proven nothing
about the feed's health, and calling it `ok` is the same false reassurance.

**Failed runs carry REAL counters, not zeros.** `runEra835Ingest` now accepts an optional
caller-owned `stats` object and mutates it (still returning it, so existing callers are
untouched). Without this, a mid-run throw discarded every counter while the completed
pulls' inserts were already committed — a run that processed 10 of 15 customers and died
would record `failed, payments_inserted 0`. That poisons the duplicate detector above: the
partial run's contribution vanishes, the next 5-day re-pull dedupes those same rows, and
the whole sequence reads healthy. Given **finding 1** (the 2026-07-31 30%/42% pull-failure
episodes, root cause UNKNOWN and the throttle theory FALSIFIED), failed runs are the case
we most need honest numbers for. Note the consequence: `failed` no longer implies "nothing
happened".

**Write path.** `recordEra835IngestRun` (`src/ingest/era_ingest.ts`), called from
`handleEra835IngestCron` on BOTH the success and the error path, each wrapped fail-soft —
a summary-write failure must never fail an ingest that already succeeded (0053's posture),
and the most likely cause of landing there is 022 not being applied yet. `writer_user` is
`current_user` read inside the `withTenant` transaction: **RECORDED, NOT ASSERTED** — there
is no identity guard on this path (unlike the billing-audit writer) and 022 does not invent
one. On the error path every tenant in the seeded roster gets a `failed` row, because
per-tenant attribution is not available there.

**Verified live at apply time:** `era_835_payment` = **18** columns and
`era_835_adjustment` = **42** columns, UNCHANGED — 022 touches neither table. Those two
counts are the assertions in 022 §7 whose job is proving exactly that.

Artifacts: `SQL Schemas/022_era_835_ingest_run.sql` + `022_era_835_ingest_run_rollback.sql`.

### Product-plane migration number is NOT trustworthy right now (2026-08-02)

`CLAUDE.md` and `.claude/rules/sql-migrations.md` both say the next **product** number is
`0072`, but `supabase/migrations/0072_teen_mh_tx_facility.sql` (+ rollback) already exists
**untracked** in the main checkout, and `0071_cmd_charge_census_aging_index.sql` is untracked
too. Both docs were deliberately left at `0072` in the 022 change: bumping them to `0073`
would assert state that is not in version control, and if those files are renamed or deleted
the docs become wrong in the other direction. **Resolve by committing or deleting the
untracked `0071`/`0072` files, then set the product number to match.** Until that happens,
check the filesystem, not the doc, before claiming a product-plane number. (The Veris number
in both docs IS current: 023.)

---

## Indigo roster — 10036020 / 10036030 are HARD-FAIL, not empty-expected (2026-08-02)

**Dated correction.** Two entries in the "Separate WATCH ITEM (morning)" note above group
`10036020`/`10036030` with the `10033859` INTO THE LIGHT class as recurring census failures.
That grouping understated them, and any handoff/memory describing these two as
**"0-rows EXPECTED" is WRONG** — that phrase belongs to the valid-but-empty class (WRC
`10033951` on the audit plane, which is why `EXPECTED_EMPTY_AUDIT_CUSTOMERS` exists). These two
are the OTHER class: a hard fetch failure in which no report ever runs.

**Measured 2026-08-02 08:0x UTC, read-only via Supabase MCP (aggregate counts only, no PHI):**

| customer | total runs | ok | error | `last_ok` | first run | `error_label` |
|---|---|---|---|---|---|---|
| 10036020 MADISON RECOVERY CENTER | 270 | **0** | 270 | **NULL** | 2026-07-22 | `fetch_failed` |
| 10036030 MISSOURI BEHAVIORAL HEALTH | 270 | **0** | 270 | **NULL** | 2026-07-22 | `fetch_failed` |

`rows_seen` totals zero for both. Neither has EVER produced a row: `cmd_charge_census` = 0 rows
for both facilities, and `cmd_explorer_rows` carries **30 distinct Indigo facilities** out of the
then-32-entry roster — these two are exactly the gap. So the explorer path fails identically to
the census path; both crons have burned a CMD report slot per customer per hour since 2026-07-22.

**On the error string — a measurement limit worth carrying.** `cmd_census_run.error_label` stores
only the PHI-safe STAGE TOKEN (`fetch_failed`), never the message; that is the ②b design (see
"Freshness cursor + retry model" above) and it is correct. So **the DB cannot confirm
`INVALID CRITERIA` and never will.** That string is only observable in the Vercel runtime log, e.g.
`cmd-census cron: customer 10036020 (10036020) fetch_failed: CMD report.run returned no identifier
(status: INVALID CRITERIA)` and the matching `cmd-explorer cron: … failed:` line — both captured
live this session on deployment `dpl_EWfCeoczQTPjHctPD8vUA4UC2BE5`. Anyone re-verifying this must
read the logs, not the run table; the run table proves the failure COUNT, the log proves the KIND.

**Retraction.** `cmdCustomers.ts` annotated both as "(added 2026-07-08, in filter 10147669)". The
270-run failure record contradicts the "in filter 10147669" half — the filter is evidently not
saved under either account. The claim is retracted in the file's header block.

**Action taken:** both removed from `INDIGO_CUSTOMERS` (32 → 30) using the Mechanism-1 shape the
codebase already uses for hard `INVALID CRITERIA` accounts — omit from the array, document the
reason, the evidence, the date and the re-add condition in the header docblock (mirrors
`AUDIT_OP_CUSTOMERS`' HOUSTON_MH/TREAT_CO exclusion and Indigo's own `10025030`). Root cause stays
CMD-side and UNCONFIRMED — Jess/CMD-side confirmation still owed. Re-add only after a rows-bearing
probe, per the standing pattern.

**Why now:** this is the prerequisite to opening the alerting gate. Two customers failing every
hour for eleven days is a constant red that makes any NEW failure invisible — the eight BXR
customers that failed and self-healed on 2026-08-01 (`last_err` 00:15 → `last_ok` 00:26/00:27)
passed unnoticed in both directions. Alerting turned on over a permanently-red roster gets muted
within a week.

> ⚠ **FOLLOW-UP, deliberately NOT built here (out of this track's scope).** Removing them puts
> these two in the state "Pre-launch facilities — the zero-rows launch trap" (2026-08-01) names as
> the ambiguous one: in NEITHER an active roster NOR an expected-empty allowlist, so they are never
> called and their silence stops being a signal at all. That entry's own prescription — an
> expected-NONZERO marker, the inverse of `EXPECTED_EMPTY_AUDIT_CUSTOMERS` — is the right closure
> and applies to these two exactly as it does to HOUSTON_MH / TREAT_CO / TREAT_VA. Build it with
> whichever of them re-opens first.

---

## 022 era-835 observability — FIRST SCHEDULED RUN, and what it settles (2026-08-02)

The `50 8 * * *` cron fired at **08:50:21 UTC** and wrote the first
`staging.era_835_ingest_run` row. Verbatim (aggregate only, no PHI):

```
status ok · 08:50:21 -> 08:52:21 (2m00s) · window 2026-07-29..2026-08-02 · customers_total 15
pulls_attempted 75 · pulls_failed 0 · pulls_empty 29 · pulls_zero_files 0 · pulls_skipped_budget 0
files_parsed 112 · payments_mapped 112 · payments_inserted 0 · payments_duplicate 112
rows_inserted 0 · rows_skipped_duplicate 1204 · pulls_failed_by_code {} · writer cmd_rollup_writer_login
```

### The counters are non-degenerate, and they close 013's detector

`payments_duplicate 112` against `payments_inserted 0` is exactly the healthy steady state 022
predicted for a 5-day trailing window ("four of every five pulled dates are re-pulls"). More
importantly it **satisfies 013's duplicate-remit detector as written** — "a re-pull of an
already-ingested date MUST report `payments_inserted = 0`" — for the first time with a record to
read it from. The remit fingerprint is stable; BPR02 is not being double-counted. This also
retro-explains the 05:00 manual run (112 parsed / 39 inserted): those 39 are now in the
already-ingested set, and the 73 that "vanished" were the ON CONFLICT path, now counted.

### Finding 2 (BLOCKING) — structurally resolved, not yet exercised

`pulls_failed_by_code` exists and returned `{}`. The per-status/error-code breakdown the
2026-07-31 save-state called "the first thing fixed next session, before any further live run"
is now in the schema. It is **unexercised** — there were no failures to break down — so treat it
as built-but-unproven until a night with `pulls_failed > 0`.

### Finding 3/4 (empty-day sentinel) — STRONG live evidence the fix works

`pulls_empty 29` of 75, with `pulls_failed 0`. The 2026-07-31 probe recorded "60 pulls across 15
facilities over 4 weekdays produced **empty-day 0** — implausible if the sentinel worked", and
that implausibility was the whole basis for suspecting the matcher. Tonight the empty path fired
on 39% of pulls and nothing was misfiled as a failure. This is the **first production evidence**
that the digest-anchored classification (`KNOWN_EMPTY_DAY_DIGESTS`, the 2026-07-31 rewrite) is
live and correct. Recorded as evidence, not proof of every branch: no *unrecognised* short body
appeared, so the `unrecognized_short_text` drift bucket is still unexercised.

### Finding 5 (FRCA/TBH 4/4 failures) — did not recur, but attribution is unavailable BY DESIGN

`pulls_failed 0` means nobody failed, so FRCA and TBH did not. It does **not** confirm the
structural theory either way, and it never will from this table: 022 deliberately carries **no
`per_customer` array** (a per-facility remittance breakdown is a richer disclosure than the
product plane's row counts). Per-customer attribution for this feed lives only in the Vercel log.
Do not add a per_customer column to chase this.

### ⚠ 013's duplicate-remit detector returns 2 groups, and they are FALSE POSITIVES

013 documents the check as "expect zero rows":

```sql
select check_eft_trace_number, payment_date, count(*)
  from staging.era_835_payment group by 1,2 having count(*) > 1;   -- 013 says: expect 0
```

Live it returns **2 groups / 5 rows** (3 on 2026-07-29, 2 on 2026-07-24). They are **not**
double-counted remits. Within each group: `count(distinct row_fingerprint)` = row count,
`count(distinct payment_amount_raw)` = row count, `count(distinct era_control_number)` = row
count, one entity, no NULL traces. Different money, different transaction sets — i.e. the
**per-NPI payment split** case 013's own header predicted when it noted that
"(payer + BPR16 + BPR02) collides on per-NPI payment splits and reissued checks" and that
"TRN02 is payer-scoped not global (and TRN03 … was never parsed)".

A genuine fingerprint destabilisation would show the **same** `payment_amount_raw` twice — that
is the failure mode (same remit re-hashed, same money inserted again). Distinct amounts prove the
opposite. **So the invariant as written in 013 is overstated**: it cannot be zero while TRN02 is
unqualified by TRN03. Anyone running it will hit this. The sound version adds the amount:

```sql
select check_eft_trace_number, payment_date, payment_amount_raw, count(*)
  from staging.era_835_payment group by 1,2,3 having count(*) > 1;  -- THIS is the one to expect 0 on
```

Not fixed in code here — recorded so the next reader does not spend a session on a false alarm.

### 4C — secondary baseline for Monday (recorded, NOT chased)

`cmd_explorer_rows` max(`ingested_at`) = **2026-08-01 06:53:30Z**, total **641,549**, with **554**
rows ingested in the trailing 48h — so the table IS still taking rows, just not since Saturday
morning; the hourly `charge inserted 0 / charge skipped 0` signature is consistent with
fingerprint dedup over a quiet weekend on a stable current-month window. `daily_collections`
max(`payment_date`) = 2026-07-31 and the census max(`last_seen_at`) = 2026-08-02 00:27:18Z, both
current. Compare Monday's first runs against these four figures. **If Monday still inserts zero
charge rows, it becomes a real investigation** — per the standing signal-misread rule, note that
`cmd_explorer_rows` measures ROWS WRITTEN, not run success, so a zero there is not by itself a
failed run.

---

## 0072 — APPLIED LIVE (2026-08-02 09:27 UTC). The 186 rows moved, as predicted.

Ledger row `20260802092718 0072_teen_mh_tx_facility`. Applied via `apply_migration` (single txn,
plain DDL/DML, no `set role` — `collections.facilities` and `cmd_facility_aliases` are
postgres-owned). Post-apply verification, all green:

| check | result |
|---|---|
| facilities row | `TEEN_MH_TX \| TEEN MENTAL HEALTH TEXAS \| acct 10035166 \| care_setting OP \| acronym 'TEEN MH TX'` |
| alias repointed | `'TEEN MENTAL HEALTH TEXAS LLC'` → `TEEN_MH_TX` |
| TREAT_TX's own alias | `'TREAT MENTAL HEALTH TEXAS LLC'` → `TREAT_TX`, untouched |
| rows resolving to TEEN_MH_TX | **186** — exactly the pre-apply prediction |
| rows resolving to TREAT_TX | 16,718 |

**This was a data correction, and it landed as one.** The 186 `cmd_explorer_rows`
($581,698.32 of `charge_amount`, one-time load 2026-06-29) previously resolved to TREAT_TX
through both live read paths (`cmdExplorerQuery.ts:233`, `qualifyQuery.ts:139`) and now resolve
to TEEN_MH_TX. **TREAT_TX's Collections and Qualify figures drop by that amount and a new
TEEN_MH_TX facility appears carrying it — expect the numbers to move.** Correct per the
2026-07-28 owner ruling (separate legal entity, distinct NPI 1124973086). Rollback on file
(`0072_teen_mh_tx_facility_rollback.sql`) restores the alias to TREAT_TX; it deliberately leaves
the facilities row, because removing it can violate the alias FK.

Note `/qualify` is behind its maintenance gate for everyone except `alec@treathealth.ai`, but
**Collections is NOT gated** — the attribution change is visible to real users now.

### Reservation table: 0071 and 0072 are discharged

Both files are committed and on `origin/main` (`f538648`), so under the table's own
remove-when-on-main rule the 0071/0072 rows at ~:1331–1332 are stale. Rows left in place rather
than deleted, per this file's append-only discipline — treat this entry as their disposition.
**0072 is APPLIED. 0071 is committed but NOT applied** (index-only; must be built with
`CREATE INDEX CONCURRENTLY` outside `apply_migration` — see its header).

### Product-plane migration number — RESOLVED to 0075

The 2026-08-02 entry above ("Product-plane migration number is NOT trustworthy right now") set
the condition: "resolve by committing or deleting the untracked 0071/0072 files, then set the
product number to match." Both are now committed, so the condition is met. **Next free product
number is 0075** (0071–0074 all exist on `origin/main`; 0073/0074/0072 applied, 0071 not).

`.claude/rules/sql-migrations.md` is updated to 0075 in the same commit as this entry.
**`CLAUDE.md` still says 0072 and needs the same one-line fix** — deliberately NOT made here: a
parallel session is actively rewriting that file this morning (it added the "Canonical Context
Set" section), and editing it concurrently already caused one cross-session index collision
today. Whoever owns that file next should change the one number.

---

## 0071 index BUILT — and the AR read could not use it until arAging was fixed (2026-08-02)

`cmd_charge_census_ent_charge_date (business_entity_id, charge_date, charge_id)` built with
`CREATE INDEX CONCURRENTLY` via `execute_sql` (autocommit — it cannot run inside
`apply_migration`'s txn), then `vacuum (analyze)`. Built in the clean gap after the `:35` census
run finished at 09:35:58 (verified `still_running = 0` first). **`indisvalid = true`,
`indisready = true`, 2,392 kB** — a failed CONCURRENTLY build leaves an INVALID index that is
silently never used, so check this, not just that the name exists.

**0071 has NO ledger row and never will** — `execute_sql` does not write
`supabase_migrations.schema_migrations`. Same as 0068/0069/0070. **The ledger is not authoritative
for applied state on this plane; verify the object.**

### ⚠ THE INDEX WAS INERT FOR ITS ONLY CONSUMER — measured immediately after building

The first EXPLAIN, using the entity form the app actually emits, did **not** touch the new index:

| predicate | plan | buffers | exec |
|---|---|---|---|
| `= any(array[…]::uuid[])` | Bitmap Heap Scan on `…_entity_last_seen` + **top-N heapsort** | 2,286 | **14.95 ms** |
| `= '…'::uuid` (scalar) | **Index Scan using `…_ent_charge_date`** | 65 | **0.36 ms** |

~42× time, ~35× buffers, BXR slice = 15,026 rows, `limit 100`.

**Cause:** `= ANY(array)` is a `ScalarArrayOpExpr`. To emit `charge_date asc` from it the planner
would have to merge one index range per array element, so it declines and sorts the whole entity
slice instead — precisely the sort 0071 was authored to remove. `arAging.ts:101` emitted exactly
that form, while `arAging.ts:89` claimed the read was "Backed by 0071's … index". **The comment
was aspirational; the plan disagreed.**

**Fix:** `buildArAgingWorklistQuery` now emits `business_entity_id = $1::uuid` when `entityIds`
has exactly one element, and keeps `= any($1::uuid[])` otherwise. The **binding moves with the
predicate** — `= $1::uuid` against a bound array fails the cast outright, so `values[0]` becomes
the scalar in that branch. Cross-tenant reads keep the array form and keep paying the sort,
exactly as before 0071. AR is single-tenant (BXR) today, so the fast path is the live path.
Re-verified against prod on the real projection (all 11 columns incl. the three ciphertext PHI
columns): **Index Scan, 65 buffers, 0.358 ms.**

**Carry this pattern.** Any ordered, keyset-paginated read whose ORDER BY leads with a column
*after* `business_entity_id` in a composite index needs SCALAR entity equality to get the ordered
scan. The app-side `= any(...)` scoping idiom (R1, 2026-07-06) and index-ordered pagination are in
tension; single-tenant callers must special-case or the index silently does nothing. `distribution`
is unaffected — it is a `group by` aggregate with no ORDER BY the index could serve.

### arAging had ZERO tests before this

`src/collections/arAging.ts` shipped in `f538648` untested. `test/arAging.test.ts` adds 7 hermetic
tests, the load-bearing ones pinning the predicate/binding pair above (scalar form + scalar
binding for one entity; array form + array binding for many) so the fast path cannot silently
regress to the inert version. Also covers keyset shape (dated cursor must still admit the
null-date tail, else those rows are unreachable), facility parameterisation, and that the PHI
columns are projected as raw ciphertext with no in-query decryption.

---

## 024 — `staging.expected_payment_manual` APPLIED LIVE (2026-08-03), AHEAD of 023

**Applied out of order on purpose.** 023 (`expected_payment_override`, the Google-Sheet
forecast feed) was under concurrent revision in another session, so 024 went first. This is
safe and was verified, not assumed: 024's only two mentions of `expected_payment_override` are
a numbering note and a commented-out verification query — **no FK, no view, no trigger**. The
resolver that merges the two feeds lives in `src/veris/upcomingForecast.ts`, in the app.

That is the payoff of the two-tables decision, and it is worth remembering next time: keeping
the machine-replaced feed and the hand-authored edits in separate tables made them
independently appliable.

**State at apply:** neither table existed. 023 is STILL NOT APPLIED.

**The file numbering is no longer the apply order.** As of 2026-08-03 the Veris plane reads
023 (authored, NOT applied) · 024 (**APPLIED**) · 025 payer-policy-intel (authored in a
parallel session, NOT applied). Next free number is **026**. Anyone reasoning about this
plane from filenames alone will get the wrong answer — check the live DB.

### Verified after apply (the file's own §7 block, run live)

| Check | Result |
|---|---|
| owner / RLS / FORCE | `claims_admin` · on · off ✓ |
| PHI column scan (`patient\|client\|member\|name\|note\|comment`) | **0 rows** ✓ |
| grants | `claims_admin` (owner) + `claims_reader`/SELECT **only** ✓ |
| `cmd_rollup_writer` grants | **none** — the structural guarantee holds ✓ |
| policies | exactly 1: reader SELECT with USING ✓ |
| functions | both `SECURITY DEFINER`, `proconfig = search_path=""` ✓ |
| indexes | pkey + `decision_uidx` + `upcoming_idx` (leads with `business_entity_id`) ✓ |
| security advisors | **0 lints** — no 0011 finding ✓ |

### The constraints were EXERCISED, not just inspected

A live probe ran 8 expectations and left 0 rows behind. All held: `add` without an amount,
`suppress` carrying money, `suppress` with no reason, and an unknown tenant uuid are all
REJECTED; a well-formed `add` succeeds; re-deciding the same (kind, match key) UPDATEs in place
rather than creating a second row; a cross-tenant delete returns **false without raising**; and
a same-tenant delete is idempotent on the second call.

The unknown-tenant case matters more than it looks: these functions are `SECURITY DEFINER` and
run as the owner, so **RLS does not protect them**. The explicit
`EXISTS (SELECT 1 FROM core.business_entity …)` guard is the only thing between a typo'd uuid
and a row no reader could ever see or clean up.

### Defect found and fixed DURING the apply review

The `COMMENT ON TABLE` body is dollar-quoted (`$t$…$t$`), where `''` is **two literal
apostrophes, not an escape**. 12 of them would have landed in the live comment as
`sheet row''s amount`. Fixed before applying. The `COMMENT ON COLUMN` statements use ordinary
`'…'` quoting where `''` IS correct, and were deliberately left alone — an assertion in the fix
script checked that.

### What works now, and what still waits on 023

- **`kind='add'` is fully live** — it needs no sheet row.
- Marking a manual add landed/removed, and the suggest-then-confirm flow, work.
- `correct` / `suppress` aimed at SHEET rows resolve as **stale** (there are no sheet rows yet)
  and the UI says so. They light up when 023 applies.
- `loadUpcomingOverrides` returns `ok:false` until 023 applies; the tile degrades to the
  835-confirmed half, which is a tested path.

### ⚠️ The sheet cron is LIVE in production and erroring hourly

`e2bc1f0` merged `{"path": "/api/cron/upcoming-overrides", "schedule": "55 * * * *"}` to main,
so it has been firing at :55 since. It is NOT dangerous — the fail-soft boundary catches the
missing `Upcoming Payments Overrides` tab before any DB write is attempted, returning
`200 {ok:false, status:'parse_failed'}`. But it logs an error every hour, and this repo already
learned that **a red light that is always red is not a signal** (the dormant-customer cluster).
Close it by creating the sheet tab, or by making the missing-config path a quiet no-op.

Reasoned from the code, not observed: the Vercel MCP was disconnected during this session, so
the actual runtime output was not read.

### Correction to `fc2c8f6`'s commit message — and a concurrency hazard worth knowing

`fc2c8f6` ends with "Root typecheck is RED on `src/intel/payer_policy/{client,types}.ts` … Not
touched, not fixed, not committed here." **Both halves of that are wrong**, and the reason is
worth recording because it will happen again.

What actually happened: two agent sessions were working in the SAME working tree, which means
they also share ONE git index. I staged four files and verified it with
`git diff --cached --name-only` — accurate at that instant. Between that check and
`git commit`, the other session ran its own `git add`, staging three of its files into the
shared index. `git commit` commits **the index**, not the list you passed to your own `git add`,
so those three came along: `src/intel/payer_policy/client.ts`, `types.ts`, and
`test/payerPolicyIntel.test.ts`.

Outcome was benign — they had finished the edit, so `fc2c8f6` typechecks clean (root tsc exit 0,
root 1001/1001) and nothing is dangling. But their work is published under a commit message
about migration 024, which misattributes it.

**The fix, for any session sharing a tree:** `git commit -o <paths>` (or
`git commit -- <paths>`) commits ONLY those paths and ignores whatever else is in the index.
`git add <paths>` followed by a bare `git commit` is NOT equivalent and is unsafe here. Also
treat `git add -A <dir>` as forbidden in a shared tree — it sweeps up another session's
in-flight files by construction.

Related: one `next build` in the same window failed with a bare "Build error occurred" and passed
on an immediate re-run. That was webpack reading a file the other session saved mid-build, not a
defect. In a shared tree, a single build failure is not evidence until it reproduces.

## Upcoming Payments — OVERRIDE_TAB is "Current Updates"; the dedicated-tab plan is VOID (2026-08-03)

The plan to have ops create a flat `Upcoming Payments Overrides` tab is **void** (Alec,
2026-08-03): the workbook belongs to BXR ops (catherine@bxrconsulting.com), we have no
write access, and no such tab exists anywhere in it. Full tab list: **Current Updates**
(gid 6894062, where the Upcoming Payments block lives, starting ~row 7) plus IP/OP month
tabs January–August. The `GOOGLE_SHEETS_REFRESH_TOKEN` identity already reads the workbook
fine — the cron's `Unable to parse range` error was tab-not-found, never permissions.

The parser now reads the block IN PLACE, structurally rather than by row number:

- Header located by **exact-match scan** (`findOverrideHeader`, limit 50 rows; row 8
  today). Exact match is load-bearing — the abandoned row-3 header is ALSO six columns
  (`…, Date/Range, Auth or Claim Issue, Last Update`) and a loose finder would map
  `Amount` onto `Last Update`. Rows at/above the header are never data.
- **Interior blank rows are SKIPPED, never a terminator** — the live sheet has a gap row
  with a real $72,000 forecast BELOW it. Pinned by the live-shape fixture test.
- The **Total footer** (label in column 5, blank Facility) is classified non-data by its
  blank Facility and skipped silently. `missing_facility` left the reject union
  deliberately: the accepted trade is that a half-keyed data row missing only its
  facility drops without a reject, instead of the footer rejecting on every sync.

**KNOWN FOLLOW-UP (ruled 2026-08-03, deliberately NOT in this change):** the read path's
`expected_date >= today` cutoff (`OVERRIDE_TOTALS_SQL` / `OVERRIDE_ROWS_SQL` in
`src/veris/upcomingOverride.ts`) hides past-dated rows from the tile and its total even
though they land in the table. Past-dated sheet rows are legitimate outstanding expected
payments, so the parser keeps them; widening the read is a separate change. Until it
ships, the 05/26 $72,000 row is in `staging.expected_payment_override` but not on the
Overview tile — a correct, known intermediate state.
## 023 — `staging.expected_payment_override` APPLIED LIVE (2026-08-03), after 024

The concurrent-revision hold that made 024 go first is over: at apply time the
worktree copy of 023 was **byte-identical to `origin/main`** (sha256
`acce664…dffb` on both sides after the quoting fix below). Applied from the
committed bytes of `ab56a93` (branch `veris/023-expected-payment-override`),
not an editor buffer — `git show HEAD:"SQL Schemas/023_…"` diffed empty against
the working file first.

**Apply order is now: 024 → 023. 025 (payer-policy-intel) remains authored,
NOT applied**, owned by its in-flight session. Next free Veris number is still
**026**. This supersedes the "023 is STILL NOT APPLIED" line in 024's record
above.

### Verified after apply (the file's own §7 block, run live)

| Check | Result |
|---|---|
| owner / RLS / FORCE | `claims_admin` · on · off ✓ |
| row count fresh | 0 ✓ |
| PHI column scan (`patient\|client\|member\|subscriber\|claim_number\|dob\|ssn\|name`, excluding the boolean) | **0 rows** ✓ |
| `is_patient_specific` type | `boolean` — not a string smuggling a name ✓ |
| tenancy FK | one FK → `core.business_entity`, validated ✓ |
| policies | exactly 4: reader SELECT (USING), writer SELECT (USING), writer INSERT (WITH CHECK), writer DELETE (USING) ✓ |
| grants | `claims_admin` (owner) + `claims_reader`/SELECT + `cmd_rollup_writer`/{SELECT,INSERT,DELETE}; **no UPDATE to any non-owner role** ✓ |
| `method_label` CHECK | `= ANY (ARRAY['EFT','Check'])` — the sheet's vocabulary, not BPR04 ✓ |
| index | `(business_entity_id, expected_date)` — leads with the tenant column (018 rule) ✓ |
| ERA tables unchanged | `era_835_payment` 18 cols · `era_835_adjustment` 42 cols (022 §7 parity) ✓ |
| security advisors | `{"lints":[]}` ✓ |

### The `amount > 0` CHECK was EXERCISED, not just inspected

A `DO $probe$` block inserted a `0.00` row against a real
`core.business_entity` id, asserted `check_violation` raised (it did), and
asserted `rows_left_behind = 0` (it was — re-confirmed by a follow-up
`count(*)`). The block RAISEs loudly on either failure, so a silent pass was
not possible.

### Same defect class as 024, caught by the same review step

3 instances of `''` inside the `$t$…$t$` table comment (`sheet''s`, `021''s`,
`tenant''s`) — inside dollar-quoting that is two literal apostrophes, not an
escape. Fixed pre-apply (`ab56a93`, that one file only); the ordinary-quoted
`COMMENT ON COLUMN` strings, where `''` IS correct, were left alone. The live
comment was read back via `obj_description`/`col_description` after apply:
apostrophes landed clean in both quoting forms.

### Cron re-diagnosis recorded with the apply (matters for ordering)

`/api/cron/upcoming-overrides` was **never 500ing**: the sync fail-softs on
fetch/parse (`status:'parse_failed'`, route returns 200 `ok:false`, "keeping
last good data"). Live production logs confirmed 200s and the Sheets error
`Unable to parse range: Upcoming Payments Overrides` — which also confirms the
override tab **does not exist yet**. The DB write path, by contrast, throws
loud by design. **Consequence: 023 had to apply BEFORE the tab is created** —
tab-first would have flipped the cron from silent-soft-fail to real hourly
500s the moment parse started succeeding. With 023 now applied, creating the
tab is safe: first successful sync lands rows in one replace-per-sync
transaction, and `loadUpcomingOverrides` goes `ok:true`.

## 025 — `intel` schema APPLIED LIVE (2026-08-03), after two 42501 posture corrections

Applied via `apply_migration` (project `dbpabchpvipipkzkogta`) with explicit
authorization, same session that built the worker preflight. **The file as
originally authored could not apply**, and the corrected version is what both
the repo and prod now carry. Two live-verified privilege walls, in order:

1. `SET ROLE claims_admin; CREATE SCHEMA intel` → **42501 permission denied for
   database postgres.** `claims_admin` holds neither CREATE on the database nor
   CREATEROLE (`has_database_privilege` / `pg_roles.rolcreaterole` both false),
   which also matches `staging`/`ref`/`collections` being postgres-owned. Fix:
   sections 1–2 run as `postgres` itself, with
   `CREATE SCHEMA IF NOT EXISTS intel AUTHORIZATION claims_admin` keeping the
   schema born owned by `claims_admin`.
2. Table DDL as `claims_admin` → **42501 permission denied for schema
   extensions** on `extensions.halfvec(1024)`. `claims_admin` has NO standing
   USAGE on `extensions`, yet owns the existing halfvec tables
   (`staging.claim_signatures`, `ref.carc_embeddings`) — type/opclass ACLs are
   checked at DDL time only. Fix: the migration brackets its DDL with
   `GRANT USAGE ON SCHEMA extensions TO claims_admin` … `REVOKE`, ending at the
   verified pre-apply posture exactly (`has_schema_privilege` false after).

### Verified after apply (the file's own §8 block, run live)

- 3 tables in `intel`, all `rls_on`, all owned by `claims_admin`.
- `embedding` = `halfvec` atttypmod 1024; `embed_tsv` = stored generated tsvector.
- 12 indexes total incl. `idx_ppf_embedding_hnsw` + both GINs.
- 8 policies, zero `cmd = 'DELETE'`; `intel_writer` = INSERT+UPDATE on
  run/finding, INSERT-only on run_check, **no DELETE anywhere**
  (`has_table_privilege(... 'DELETE')` false on both).
- Zero grants to anon/authenticated/PUBLIC.
- The worker's `PREFLIGHT_SQL` (src/intel/payer_policy/preflight.ts) returns
  all-true independently.

**Still NOT green for the Sept 2 cron:** GH repo secrets `ANTHROPIC_API_KEY` /
`INTEL_WRITER_DATABASE_URL` are believed unset, and `intel_writer` is NOLOGIN
until credentials are provisioned out of band. 025 closes the schema gap only.
Next Veris number remains **026**.
