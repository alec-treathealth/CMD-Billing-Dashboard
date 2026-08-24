# Recon — Weekly Billable Days as a Claims Desk subtab: what Kipu ingest it needs

**Date:** 2026-08-20 · **Author:** recon session, no code changed · **Status:** read-only findings + 4 blockers for Alec

Scope: the uploaded `tmhweeklybillablegridv3.html` mock, rendered as a 4th subtab of Claims Desk
(`/billing-audit`). What Kipu v4 endpoints feed it, what Kipu cannot feed, and how it lands in this repo.

Epistemic key: **[V]** = verified this session by reading the file/spec/live DB · **[U]** = unverified,
needs a live call or Alec's answer.

---

## 1. Verdict

The grid is buildable and **Kipu carries more of it than the mock assumes** — including the
per-level-of-care billing config the mock hardcodes as `LOC_CONFIG`. Three things stand between here
and a build, and only one is technical:

1. **The one Kipu instance we can prove access to is residential, not OP/IOP.** The grid is an
   IOP/OP artifact. This is blocker #1 and it is a data-availability question, not a code question.
2. **`app_id` (= `recipient_id`) is absent from the repo's env.** Required on ~every Kipu call and part
   of the signed URI. `KIPU_ACCESS_ID` and `KIPU_SECRET_KEY` are present.
3. **Per-session hours and per-eval billability are N+1 detail fetches**, not list fields. That shapes
   the ingest (template allowlist + census-bounded fan-out), and it is the only real engineering cost.

There is **no Kipu code in this repo today** [V] — `grep -ril kipu` over `src/` + `app/` returns only
`skipUnder` false positives. But there **is** a live Kipu poller in a *different* Supabase project
(§5), which is prior art worth reading before writing a signer.

---

## 2. The data contract the mock actually needs

Read out of the mock's own rules engine (`computeRow`, `LOC_CONFIG`, `pendingItems`) [V]:

| # | Field | Grain | Used for |
|---|---|---|---|
| 1 | session date, start, end, hours | session | the 7 day cells, `Hrs` column |
| 2 | session kind — group / therapy / BPS | session | `G` / `T` / `BPS` chips |
| 3 | attendance (`present`) | session × client | `counted` filter — non-attended never counts |
| 4 | billable flag (evals only) | session | assumption A2 — evals count only when `billable===true` |
| 5 | topic/title + provider name | session | drawer detail |
| 6 | level of care | client | `LOC_CONFIG` lookup → track, cap days, min hours |
| 7 | cap days + min hours per LOC | LOC config | `keep` / `over` split → `I` vs `N/B` |
| 8 | auth number, start, end, frequency | client × auth | auth pill, `oow`, `daysPast`, retro-auth queue |
| 9 | payer | client | column + pending queue |
| 10 | admit / discharge date | client | `adm`/`d/c` meta, `D/C` chip |
| 11 | MRN | client | search + drawer |
| 12 | facility / location | client | facility switcher, tenant scope |

Plus three **app-owned mutable** states the mock keeps in memory and Kipu will never hold:
`overrides{cid:date}` (code + hours override), `writeoffs{cid:week}`, `billed{cid:week}` (who/when).
Those are our tables, with an audit trail — they are billing decisions, not EMR facts.

---

## 3. Kipu endpoint map

All paths are `/api`-prefixed; `Accept: application/vnd.kipusystems+json; version=4`. Field lists below
are read from the v4 spec dump [V], not from memory.

### 3.1 Groups — one call covers fields 1,2,3,5 and more

`GET /api/group_sessions` — params: `app_id*`, `session_start_date`, `session_end_date`, `location_id`,
`group_leader_id`, `group_session_topic`, `billable`, `session_type_id`, `treatment_episode_id`, `page`, `per`.

Returns per session: `session_start_time`, `session_end_time` (`$datetime`), `group_session_title`,
`group_session_topic`, `group_leader_full_name`, `status`, `billable` (bool), `billing_codes {HCode, CCode,
RCode, Custom}`, `selected_billing_code`, `place_of_service`, `ancillary`, `billable_claim_format`,
`location_id`, and **`episodes[] { episode_id, present, note, session_start_time }`**.

That `episodes[].present` is the attendance flag the grid's `counted` filter needs, and the route is
**date-ranged by session date and filterable by location** — so one paged call per location per week
rebuilds the whole group half of the grid. **No per-episode fan-out for groups.** The global route
carries no patient names (episode ids only), which is the PHI-cheap shape we want.

> ⚠ Nuance worth recording: `references/incremental-sync.md` correctly says group sessions have **no
> `updated_at` filter** — there is no cheap "what changed". But a *weekly* grid windows on session
> date, which this route supports natively. Change detection and window rebuild are different problems;
> for this surface, rebuild-the-window is the right pattern and it is cheap.

The episode-scoped variant (`/api/episodes/{episode_id}/group_sessions`, requires `patient_master_id`)
flattens to `episode_present` / `episode_first_name` / `episode_last_name` — only needed for a drill.

### 3.2 Individual therapy, BPS, psych consults — the expensive half

`GET /api/patient_evaluations` (params `app_id*`, `evaluation_id`, `completed_only`,
`current_census_only`, `start_date`, `end_date`, `evaluation_content` ∈ {standard, notes, treatment_plan},
`patient_process_id`, `include_stranded`, `treatment_episode_id`) returns **only**:
`id, name, status, casefile_id, evaluation_id, patient_process_id, created_at, created_by, updated_at,
updated_by, evaluation_content`.

**No hours. No start/end time. No billable flag.** Those live one level down:

`GET /api/patient_evaluations/{id}?include_settings=true` returns on the header:
`billable` (bool), `evaluation_type`, `billing_codes`, `place_of_service`, `billable_claim_format`,
`ancillary`, `rendering_provider`, `locked` — and in `patient_evaluation_items[]`:
**`start_time`, `end_time`, `duration`, `timestamp`** per form field.

Consequences for design:
- Service time is a **form field**, not a header attribute. Which item carries it is template-specific
  → the ingest needs a per-template field map, discovered once and stored. [U] per instance.
- The list route can't pre-filter on `billable`, but it **can** filter by `evaluation_id` (template).
  So: pull `GET /api/evaluations` once (returns `id, name, enabled, patient_process_id`), build a
  **billable-template allowlist**, and fetch detail only for evals whose `evaluation_id` is on it.
  That converts an unbounded N+1 into a bounded one.
- `current_census_only=true` and the date window bound it further.

### 3.3 Authorizations — one route delivers the whole auth panel

`GET /api/utilization_reviews/latest` (`app_id*`, `start_date*`, `end_date*`, `page`, `per`) returns per UR:
`start_date`, `end_date`, `number_of_days`, **`frequency`**, `level_of_care`, `lcd`, `authorization_date`,
**`authorization_number`**, `next_review`, `insurance`, `comment`, `status`, `next_care_level`,
`next_care_level_date` — plus `episode { casefile_id, first/middle/last name, dob, admission_date,
discharge_date, mr_number }`.

That single route covers fields 8, 9, 10, 11 and the LOC label. `frequency` is exactly the mock's
`"3 Day (M/W/F)"` string [V in spec; U in this instance's data].

⚠ It ranges on **`updated_at`**, so it returns *recently touched* auths only. A grid that looks back
4 weeks needs either a **one-time full seed** or a per-episode `GET /api/episodes/{episode_id}/ur`
(requires `patient_master_id`) pass over the census. Plan for both: seed once, then poll the range.

### 3.4 Level-of-care config — Kipu already owns what the mock hardcodes

`GET /api/care_levels` returns per level: `care_level_id`, `care_level_name`,
**`days_of_the_week {sun…sat}`**, **`billable`**, `consider_as`, **`hours`**, `place_of_service`,
`selected_billing_code {HCode, CCode, RCode, Custom}`, `claim_format`, `type_of_bill`,
`occurrence_code`, `occurrence_span_code`, `value_code`, `locations[]`.

This is the mock's `LOC_CONFIG` — `capDays` ≈ `days_of_the_week`, `minHours` = `hours`, and the billing
code per level comes free. **It also answers the mock's own open question** (`⚠ UNRESOLVED: MH OP 4
Adult — OP level, or IOP-4 by another name?`): `consider_as` + `hours` + `days_of_the_week` on the live
instance decide it. Do not ship a hand-maintained LOC map until this route has been read [U].

### 3.5 Supporting routes

| Need | Route | Notes |
|---|---|---|
| census / roster, admit+discharge+LOC+location+insurance | `GET /api/episodes/census` | `phi_level*` required; `location_id`, `start_date`/`end_date`, `exclude_preadmission` |
| change detection (tier 1) | `GET /api/episodes/latest` | `updated_at` range; **takes no `phi_level`** |
| payer | `GET /api/insurances/latest` | spec documents it at `version=3` — [U], test |
| facility list | `GET /api/locations` | maps `location_id` → facility |
| provider names | `GET /api/providers`, `GET /api/users` | for the drawer |
| individual-session times where no eval exists | `GET /api/scheduler/appointments` | `start_date*`, `end_date`, `location_ids`, `patient_appointment_status_ids`, `include_group_sessions`; returns `from`/`to`, per-patient `patient_appointment_status`, `group_session_details` — **no billable flag** |

### 3.6 Mechanics that constrain the design

- **No webhooks. None.** Kipu is GET/POST/PATCH only; every "webhook" is a poll-to-event bridge we own.
- `start_date`/`end_date` are **calendar-day granularity** everywhere. Always overlap the window
  (`[yesterday, today]`), dedupe by content hash, advance the cursor only after the last page succeeds.
- Signing: `APIAuth {access_id}:{signature}`; the signed `request_uri` must be byte-identical to what is
  sent (param reordering ⇒ 401, never retryable). `Date` is a forbidden header in browsers/some runtimes →
  `X-Auth-Date`. 403 = the credential owner's EMR permissions. 410 = endpoint disabled for the instance.
- No documented rate limit (Kipu's stated position, not a guarantee); no public sandbox.

---

## 4. What Kipu will not give us

| Gap | Consequence |
|---|---|
| Per-eval hours/billable are detail-only | bounded N+1 via template allowlist (§3.2) |
| `duration` is a **string** | parse + validate; don't trust format |
| No `updated_at` on group sessions | window-rebuild instead of change-detect (fine here) |
| UR `latest` is `updated_at`-ranged | needs a one-time full seed for history |
| The billing decision layer | `overrides` / `writeoffs` / `billed` are ours, with an audit trail |
| Cap/over-cap arbitration (`N/B`) | our rules engine; Kipu gives inputs, not the verdict |
| `place_of_service` / claim format per session | present, but reconciling them to CMD charge lines is a **separate** piece of work — name it, don't fold it in |

---

## 5. Prior art: there is already a live Kipu poller (different project)

Supabase project **`cmh-kipu-dashboard`** (`aywsbldivmrlxpxiveac`, us-west-1) [V, queried this session]:

- `clients` (1 row) — `slug='cmh'`, `name='California Mental Health'`, `kipu_subdomain='cmh12327'`,
  and a **`kipu_app_id` column** (the value the repo's env is missing).
- `patients` 78 · `utilization_reviews` 220 · `evaluations` 15,382 · `kipu_users` 153 ·
  `kipu_eval_answers` 136 · `sync_log` **10,441 runs**.
- Last successful run **2026-08-20, 1:30 pm PST** — this is live, not abandoned.
- `sync_log.sync_type` ∈ {`full` 8,679 runs, `monday` 1,620, `consent_forms` 69, `users` 68,
  `eval_answers` 5}. Table shapes already carry `raw_data jsonb` + `synced_at` + a run log with
  `records_fetched/inserted/updated` and `date_range_start/end` — i.e. the cursor/outbox pattern.
- **No `group_sessions` table anywhere in it.** Groups are the net-new ingest.

Two things follow. First, the signing scheme is **proven working** against a real instance with real
credentials — read that implementation before writing a new signer. Second, and this is blocker #1:

> ⚠ **That instance is residential.** `patients.level_of_care` is `'UR LOC: MH RTC'` (63 of 78 rows;
> the rest blank) and `location_name` is only `'Lesley Lane'` / `'San Martin'` [V]. The grid is an
> **IOP/OP** surface for *Treat California — Costa Mesa*, *Treat Washington*, *Treat Texas — Dallas*.
> Whatever Kipu instance holds those OP programs is **not** the one we have verified access to.

Corroborating detail: the mock's eval names are real Kipu template names — `PNS Psychiatric Consultation
& Follow Up` appears verbatim in that instance's `evaluations` (264 rows) — so the mock was built off a
real Kipu report. Which instance produced it is the question to answer first.

---

## 6. How it lands in this repo

### 6.1 The UI is the easy part

`Claims Desk` is `/billing-audit` (route and internal names unchanged; display label set 2026-07-15) [V,
`app/lib/nav-model.ts:42-49`]. Its workbench already hosts **subtabs as in-page state, one route, no
sub-navigation** — `type AuditTab = 'ip' | 'op' | 'flags'` with a roving-tabindex `role="tablist"`
[V, `app/components/billing-audit/workbench.tsx:24-56`]. Adding `'billable'` is: one `TABS` entry, one
`tabRefs` key, one panel component. Arrow-key nav and the a11y wiring come free.

The mock's palette **is** TreatHealthOS — `teal900 #0E3A3A`, `teal700 #135E5A`, `teal500 #1C8B82`,
`coral600 #E2674F`, `ground #FBF8F4`, `ink900 #1B2B2A`, `line #E4E9E6` all match
`docs/archive/design-system.md` and `app/app/globals.css` exactly [V]. Only the page chrome differs
(the mock draws a Treat MH staff top bar; inside our shell that comes off). Port to shadcn primitives,
keep the grid.

Route already carries what this surface needs: `dashboardAccess()` gating, `?view=` tenant clamp,
`canRevealPhi`, and the maintenance interstitial (`CLAIMS_AUDIT_MAINTENANCE`) that currently hides the
whole surface from everyone but `alec@treathealth.ai` — which is a convenient place to build it.

### 6.2 Tenancy: this fits the existing scope, it does not need a new tenant

`src/collections/cmdCustomers.ts` already carries the Treat facilities, all under **BXR** [V]:

```
10030101 TREAT_CA  TREAT MENTAL HEALTH CALIFORNIA (OP)
10034671 TREAT_NV  TREAT MENTAL HEALTH NEVADA (OP)
10029905 TREAT_TN  TREAT MENTAL HEALTH TENNESSEE (OP)
10029722 TREAT_TX  TREAT MENTAL HEALTH TEXAS (OP)
10031212 TREAT_WA  TREAT MENTAL HEALTH WASHINGTON (OP)
```

So the join is **Kipu `location_id` → `facility_code` → CMD customer**, and the surface stays
`business_entity_id = BXR`, matching "Billing Audit is PHI + tenant-scoped (BXR-only)" [V,
`app/lib/views.ts` / nav-model comment]. A `kipu_location_map` table (location_id, facility_code,
business_entity_id) is the missing link — small, explicit, no inference. Note `TREAT_FRCA` is
`source_group_code` **lineage only, never a facility_code** [V, `.claude/rules/collections-crons.md`],
and TREAT COLORADO (10035974) is *not* in the roster — flag if the Kipu instance includes it.

### 6.3 Ingest shape (copy the collections pattern, don't invent one)

Follow `.claude/rules/collections-crons.md` + `sql-migrations.md`:

- **Cron route template** verbatim from `app/app/api/cron/qualify-census/route.ts` [V]: `Bearer
  CRON_SECRET`, GET only, `runtime='nodejs'`, `dynamic='force-dynamic'`, `maxDuration`, a writer-only
  pool from `CMD_ROLLUP_WRITER_DATABASE_URL`, fail-soft with a durable run-log row.
- **Schedule outside `:41–:59`** (the CMD quiet window — CMD-API-scoped as practiced, but the
  conservative reading has been ruled on twice; pick a clear minute like `:05`/`:25`).
- **Writer role** `cmd_rollup_writer`, never service-role, never `claims_admin` on the app path. And
  the lesson this repo paid for three times: **a GRANT is half the gate** — RLS-enabled tables need the
  matching policy, and an `INSERT … ON CONFLICT` with a conflict target **requires SELECT** on the
  conflict columns. Verify privileges by *running the statement as the real role*, not with
  `has_table_privilege` as `postgres` (`rolbypassrls` makes that blind).
- **Migrations:** product plane `supabase/migrations/` — next number **0107** per CLAUDE.md, but
  re-derive from `supabase_migrations.schema_migrations` **live** plus untracked `.sql` in every
  worktree before claiming it (0096 collided exactly this way). `collections` objects are owned by
  **`postgres`, not `claims_admin`** — no `SET ROLE` there.
- **PHI:** every row is PHI. Patient name / MRN / DOB → libsodium at rest (`phiCrypto.ts`), searchable
  fields → keyed-HMAC blind index (`blindIndex.ts`), never in a URL, a log, an LLM prompt, or
  `query_log`. Store `casefile_id` as the stable external key (`^[0-9]+:UUID$`) — prefer it over
  positional ids. Reads as `claims_reader` through `entityScope.ts`.
- **Tables** (sketch, not a schema): `kipu_sync_cursor`, `kipu_group_session` + `kipu_session_attendance`,
  `kipu_patient_eval` (+ template allowlist and field map), `kipu_utilization_review`,
  `kipu_care_level`, `kipu_location_map`, and the three decision tables
  (`billable_day_override`, `billable_week_writeoff`, `billable_week_billed`) with actor + timestamp.
- **Tests** hermetic `node:test` only; the gate is all five commands, floors ≥1439 root / ≥831 app.

### 6.4 Rules engine placement

The mock's `computeRow` is real business logic with eight named assumptions (A1–A8) baked into it —
over-cap tie-break, evals-gated-on-billable, BPS stacks free, IOP never emits bare G/T, D/C stacks.
That belongs in `src/` as a pure, unit-tested function over ingested rows (the repo's shape:
`src/collections/*` computes, `app/lib/*` transports). **Each assumption needs Alec's ratification
before it ships** — A5 and A7 already changed once between mock versions, and A1/A8 decide what gets
billed.

---

## 7. Blockers — in order, each needs an answer before code

1. **Which Kipu instance(s) hold the OP/IOP programs?** The only instance we can prove access to
   (`cmh12327`) is residential. Are Treat CA-OP / WA / TX separate Kipu instances, separate locations
   inside one instance, or not in Kipu at all? Everything downstream depends on this.
2. **`KIPU_APP_ID` / `recipient_id`.** Not in the repo's `.env`, `.env.local`, or `.env.example` [V —
   grepped keys only, values never read]. It exists per-client in the `cmh-kipu-dashboard` DB. Needed
   per instance, and it must also land in Vercel env [U — I did not inspect Vercel env].
3. **Read `GET /api/care_levels` on the real instance before writing any LOC config.** It likely
   *replaces* `LOC_CONFIG` and settles the `MH OP 4 Adult` ambiguity the mock flags itself.
4. **Ratify A1–A8** (§6.4), and decide the billable-eval template allowlist. Both are billing policy,
   not engineering choices.

Secondary, resolvable in-flight: whether `/api/group_sessions` and `/api/care_levels` are enabled for
the instance (410 risk), the timezone semantics of Kipu's date windows, and whether
`/insurances/latest` really needs `version=3`.

---

## 8. What I did not verify

- **No Kipu API call was made.** Every field list here is from the v4 spec dump; none of it is
  confirmed against a live response.
- Whether the credentials in `.env` are valid, or which instance they belong to.
- Vercel env contents.
- Anything about how the mock's synthetic clients map to real patients (they are fabricated — the file
  says so).
- Reconciling Kipu-derived billable days against CMD charge lines. Adjacent, real, and **out of scope**
  for this recon — it is its own piece of work.

---

## Sources

Read this session: `tmhweeklybillablegridv3.html` (uploaded mock) · `CLAUDE.md` ·
`.claude/rules/collections-crons.md` · `app/lib/nav-model.ts` · `app/app/billing-audit/page.tsx` ·
`app/components/billing-audit/workbench.tsx` · `src/tenants.ts` · `src/collections/cmdCustomers.ts` ·
`app/app/api/cron/qualify-census/route.ts` · `docs/archive/design-system.md` · `app/app/globals.css` ·
kipu-api skill (`references/endpoints.md`, `references/incremental-sync.md`,
`references/kipu_openapi_dump.txt`) · live Supabase `dbpabchpvipipkzkogta` and `aywsbldivmrlxpxiveac`
(read-only metadata + aggregate queries; no PHI rows read).
