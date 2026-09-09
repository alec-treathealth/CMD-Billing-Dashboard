# AR Management Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Claims Desk tab into an **AR Management** tab: a live, claim-grain aged-AR queue for every BXR facility, fed nightly by the CMD **V2 customer data snapshot** (`GET /v2/customer/{c}/snapshot`), with CMD follow-up notes, denial reasoning (CAS codes + clearinghouse/payer status history), in-app notes and work dispositions, and a super-admin notification bell for every note/status change.

**Architecture:** A new `claims.ar_*` plane (migration 0109) written nightly by `claims_audit_writer` from the per-customer snapshot ZIP (19 BXR accounts respond; the account-level snapshot for 475729 is 404 / not configured, and the billing umbrella 10030472 is 401). Pure mappers in `src/billingAudit/` derive CMD's display status (`CLAIM AT <payer>` etc.) from the snapshot tables and aggregate charges to claims. Reads run as `claims_reader` through Server Actions in `app/lib/ar/`; human writes (notes, dispositions, notification cursor) go through `claims_admin`-owned SECURITY DEFINER functions. The UI replaces the inert Flag Queue with an **AR Queue** tab (default) alongside the existing IP/OP Audit and Billable Days tabs, plus a header bell.

**Tech Stack:** TypeScript (root `src/` library + Next.js 15 App Router `app/`), node-postgres, libsodium (PHI at rest), keyed-HMAC blind indexes, `node:test` (hermetic), Tailwind + shadcn primitives, lucide icons.

## Global Constraints

- Every row is PHI except code/amount aggregates — patient name / DOB / member id are libsodium ciphertext; free-text notes are libsodium ciphertext; no PHI in logs, URLs, browser storage, `summary_stats`, LLM prompts, or test fixtures (synthetic only).
- Parameterized queries only; explicit column allowlists; no `SELECT *`; table/column names are fixed literals.
- Reads as `claims_reader`; ingest writes as `claims_audit_writer` (GUC-scoped RLS via `withTenant`); human writes only via SECURITY DEFINER functions owned by `claims_admin` with `EXECUTE` to `claims_reader`; never the service-role key.
- Product-plane migration number is **0109** (live ledger max = `0108_cmd_charge_rollup_entity_charge_date`, verified 2026-09-09; no 0109 in any worktree or ref). Re-verify against `supabase_migrations.schema_migrations` immediately before apply. Sibling `_rollback.sql` required. `set role claims_admin` (claims plane).
- Tests: `node:test` only, hermetic, `.test.ts` under root `test/`, `.test.tsx` directly under `app/test/`.
- Route and internal names stay `/billing-audit` and `billing-audit` (rule file); only the display label changes to **AR Management**.
- Cron routes: thin GET-only adapters, `CRON_SECRET` constant-time Bearer, `maxDuration = 300`, no new env vars (uses `CMD_API_USERNAME` / `CMD_API_PASSWORD` / `CLAIMS_AUDIT_WRITER_DATABASE_URL` / `LIBSODIUM_KEY` / `INDEX_HMAC_KEY`).
- Age bands (from DOS = `B_CHARGE.FROMDATE`, "Charge Fromdate Age"): `0–30`, `31–60`, `61–90`, `91–120`, `4–6 mo` (121–180), `6–9 mo` (181–270), `9 mo–1 yr` (271–365), `1–2 yr` (366–730), `2 yr+` (731+).
- Verification gate before any commit: `npm test`, `npm run typecheck`, `cd app && npm test`, `cd app && npm run typecheck`, `cd app && npm run build`.
- No `Co-Authored-By` trailer.

---

## Recon results this plan is built on (measured 2026-09-09)

| fact | value |
|---|---|
| `GET /v2/account/475729/snapshot` | **404** (account-level snapshot not configured) |
| `GET /v2/customer/{c}/snapshot` | **200 ZIP for 19 of 20 BXR customers**; 10030472 (billing umbrella) → 401 |
| ZIP contents | 30 tab-delimited `.DAT` tables + `meta/oracle-create.sql` (Oracle DDL, no comments); header row first; dates `MM/DD/YYYY`, timestamps `MM/DD/YYYY HH:MM:SS`; no embedded tabs/newlines (field counts match header on every file) |
| Sizes | 31 KB (TREAT_CO) → 6.4 MB (CAMH); ~36 MB total |
| `B_CHARGE.STATUS` | numeric FK to `B_CHARGESTATUS.STATUS`, set on only 604 of 13,001 CAMH charges — CMD's `CLAIM AT <payer>` is **derived**, not stored |
| Derivation verified | custom status text if set → else `PAID` when `BALANCE<=0` → else `BALDUETO='P'` → `BALANCE DUE PATIENT` → else `BALDUETO='I'` → `CLAIM AT <payer of latest submission activity>` (+ ` - SECONDARY` when `PAYER_PRIORITY='S'` or payer = `PAYOR2`) → else `BALANCE DUE OTHER`. Payer strings match `claims.audit_row.charge_status_raw` exactly (e.g. `CLAIM AT ANTHEM BLUE CROSS CALIFORNIA`, `CLAIM AT BLUECARD PROGRAM OF PA`, `… - SECONDARY`) |
| Custom status vocabulary (union of 20 customers) | APPROVED FOR HIGHER PAYMENT · PENDING FOR HIGHER PAYMENT · NEEDS RENEGOTIATING · NEGOTIATE WITH FIRST HEALTH DIRECT · MANAGER ESCALATION - CATHERINE/JESS · SUPERVISOR ESCALATION - TULA · MEDICAL RECORD REQUEST · OPTUM PNI MR REQUEST · MEDICARE PRIMARY · ON HOLD - CODING RESEARCH · PAID TO MEMBER · WRITE OFF · TERMED INSURANCE · TERMED · PTM · REBILLED ON NEW CLAIM · VOID REQUESTED · NEGOTIATE WITH CIGNA DIRECT |
| Notes | `B_PATNOTES` — every row carries `CLAIM`; CAMH 1,643 notes / 103 claims; `USERNAME` = staff author; `SUBMITTED` = timestamp; `TYPE` 0/2 |
| Denial reasoning | `B_REMITTANCE` — CAS at charge level: `GROUP_CODE` CO/PR/PI/OA, `CODE` (CARC / RARC when `TYPE='R'`), `AMOUNT` (signed), `DENIAL` Y/N, `PAYORLEVEL`, `RECEIVED` |
| Status history | `B_CLAIMSTATUS` — 157k rows for CAMH; `STATUS_TYPE` INFO/ERROR/WARNING; ERROR+WARNING = 3,824 (keep only those + latest per claim) |
| Open AR (balance>0, live charges) | CAMH 4,849 charges / $5.78M; 2,897 charges older than 2 years; all 19 accounts ≈ 40k charges / ≈ $52M |
| Extra AR sources | `B_CLAIM.FOLLOWUP` (CMD follow-up date; 1,379 set at CAMH), `CTRLNO1` (payer claim control #), `AUTHNO1`, `B_ACTIVITY.RSTATUS` (835 CLP02 of last submission), `ICLAIM.BILLTYPE/ADMITDATE/DISCHARGEDATE`, `INSCHECK` (check #, paydate) |

---

## File Structure

**Create (root library `src/`)**
- `src/collections/cmdSnapshot.ts` — transport: `cmdFetchSnapshot` (GET, classify zip / not_configured / unauthorized / other; PHI-safe errors).
- `src/billingAudit/arConfig.ts` — snapshot roster (19 accounts), expected-empty set, cache tag.
- `src/billingAudit/arBuckets.ts` — the 9 age bands (pure) + SQL CASE builder.
- `src/billingAudit/snapshotParse.ts` — ZIP entries → `SnapshotTables` (TSV parser, typed getters), pure.
- `src/billingAudit/arSnapshotMap.ts` — `SnapshotTables` → `ArMapped` (patients, claims, charges, remits, status events, notes) incl. status derivation, pure.
- `src/billingAudit/arSnapshotWrite.ts` — batched upserts inside `withTenant` as `claims_audit_writer`.
- `src/billingAudit/arSnapshotCron.ts` — roster loop, freshness cursor, wall-clock budget, run rows, per-customer isolation.
- `src/billingAudit/arSnapshotCli.ts` — manual CLI (`--from-dir <zips>` / live, `--commit`).
- `src/billingAudit/arQuery.ts` — parameterized query builders (queue page, summary, detail, notes, events, notifications, filter options).
- `src/billingAudit/carcDescriptions.ts` — PHI-free description map for the common CARC/RARC codes.

**Create (migration)**
- `supabase/migrations/0109_ar_management.sql` + `0109_ar_management_rollback.sql`.

**Create (app)**
- `app/lib/ar/contract.ts` — client-safe types + band labels + work-status vocabulary.
- `app/lib/ar/deps.ts` — reader executor factory (sync, server-only).
- `app/lib/ar/server.ts` — loaders + writers (definer calls), decrypt/reveal with audit.
- `app/lib/ar/actions.ts` — `'use server'` Server Actions (gate → clamp → server.ts).
- `app/lib/ar/open-claim-store.ts` — in-memory pending-open claim handoff (bell → workbench; never browser storage).
- `app/components/billing-audit/ar/ar-workbench.tsx` — client shell for the AR Queue tab.
- `app/components/billing-audit/ar/aging-strip.tsx` — hero total + 9 band tiles (filters).
- `app/components/billing-audit/ar/ar-filter-bar.tsx` — facility / payer / status / work / assignee / denial / search.
- `app/components/billing-audit/ar/ar-queue-table.tsx` — scrollport grid (keyset paging, allowlisted sort, reveal-all).
- `app/components/billing-audit/ar/ar-leaves.tsx` — pure leaves: `StatusChip`, `BandPill`, `WorkChip`, `DenialPills`, `money`, `ageLabel` (string-render testable).
- `app/components/billing-audit/ar/claim-drawer.tsx` — focus-trapped slide-over: summary, denial reasoning, charge lines, notes thread, work panel.
- `app/components/ar-notifications-bell.tsx` — header bell (super_admin), polling.
- `app/app/api/cron/ar-snapshot/route.ts` — thin cron adapter.

**Modify**
- `app/lib/nav-model.ts` — label `AR Management`.
- `app/app/billing-audit/page.tsx` — title/copy, seed the AR queue (summary + first page + options), pass role.
- `app/components/billing-audit/workbench.tsx` — tabs `ar | ip | op | billable`, default `ar`, remove `FlagQueueEmptyState`.
- `app/components/billing-audit/maintenance-notice.tsx` — copy.
- `app/app/layout.tsx` — render the bell for super_admin.
- `app/lib/server.ts` — `handleArSnapshotCron` + export `auditWriterDb` helpers needed.
- `app/vercel.json` — cron entry `5 14 * * *`.
- `.claude/rules/billing-audit.md` — label + snapshot feed section.
- `CLAUDE.md` — register this plan (read-order 11), nav bullets, cron table row, migration next-number.
- `veris-data-notes.md` — append 0109 apply record + snapshot recon.
- Tests updated: `app/test/nav-rail-render.test.tsx`, `app/test/shell-nav-model.test.tsx`, `app/test/billingAuditViewRemount.test.tsx`.

---

## Task 1: Age bands module

**Files:** Create `src/billingAudit/arBuckets.ts`; Test `test/arBuckets.test.ts`.

**Interfaces — Produces:**
```ts
export type ArBandKey = '0_30'|'31_60'|'61_90'|'91_120'|'4_6mo'|'6_9mo'|'9_12mo'|'1_2yr'|'2yr_plus';
export interface ArBand { key: ArBandKey; label: string; short: string; minDays: number; maxDays: number | null; aged: boolean; }
export const AR_BANDS: readonly ArBand[];           // ascending, contiguous, exhaustive
export function bandForAgeDays(days: number | null | undefined): ArBand | null;  // negative/NaN/null → null
export function arBandCaseSql(ageDaysExpr: string, dateExpr: string): string;    // CASE … END yielding the band key
export function isArBandKey(v: unknown): v is ArBandKey;
```
Labels: `0–30 days`, `31–60 days`, `61–90 days`, `91–120 days`, `4–6 months`, `6–9 months`, `9 months–1 year`, `1–2 years`, `Over 2 years`. `aged` is false only for `0_30`.

- [ ] Write `test/arBuckets.test.ts`: every boundary day (0,30,31,60,61,90,91,120,121,180,181,270,271,365,366,730,731,5000) maps to the expected key; null/undefined/NaN/-1 → null; bands are contiguous (`b[i].maxDays + 1 === b[i+1].minDays`) and the last is open; `arBandCaseSql` contains one `when` per band and `is null then null`.
- [ ] Run `node --import tsx --test test/arBuckets.test.ts` → FAIL (module missing).
- [ ] Implement `arBuckets.ts`.
- [ ] Run → PASS.

## Task 2: Snapshot transport

**Files:** Create `src/collections/cmdSnapshot.ts`; Test `test/cmdSnapshot.test.ts`.

**Produces:**
```ts
export interface CmdSnapshotConfig { baseUrl: string; customerId: string; auth: CmdApiConfig['auth']; fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; }
export type CmdSnapshotResult = { kind: 'zip'; bytes: Buffer } | { kind: 'not_configured' } | { kind: 'unauthorized' };
export class CmdSnapshotError extends Error { code: 'http_status'|'unrecognized_body'|'response_too_large'|'request_failed'; status?: number; }
export async function cmdFetchSnapshot(cfg: CmdSnapshotConfig): Promise<CmdSnapshotResult>;
```
Rules: 200 + ZIP magic (`0x04034b50`) → zip; 404 → not_configured; 401/403 → unauthorized; 200 non-zip → throw `unrecognized_body` (byte count + sha256 only); other status → `http_status`; abort/timeout → `request_failed`; body over `maxBytes` (default 64 MB) → `response_too_large`. Never include URL/body/credentials in errors. Basic auth built like `cmdPayer.ts`.

- [ ] Write tests with a fake `fetchImpl` for each branch (zip bytes = a minimal valid ZIP built in-test via `zlib`-free stored entry; 404; 401; 200 text; 500; thrown fetch).
- [ ] Run → FAIL. Implement. Run → PASS.

## Task 3: Snapshot ZIP → tables parser

**Files:** Create `src/billingAudit/snapshotParse.ts`; Test `test/snapshotParse.test.ts`.

**Produces:**
```ts
export type SnapshotRow = Readonly<Record<string, string>>;
export interface SnapshotTable { name: string; columns: readonly string[]; rows: readonly SnapshotRow[]; }
export interface SnapshotTables { get(name: string): SnapshotTable | null; require(name: string): SnapshotTable; names(): string[]; }
export function parseSnapshotZip(zip: Buffer): SnapshotTables;   // uses readZipEntries from cmdPayer.ts; `.DAT` only, table name = basename without `.DAT`
export function parseTsv(text: string): { columns: string[]; rows: SnapshotRow[] };  // header first line; `\r\n` tolerant; blank lines skipped; short rows padded with ''
export function cmdDate(v: string | undefined): string | null;       // 'MM/DD/YYYY[ HH:MM:SS]' → 'YYYY-MM-DD' (calendar-validated) else null
export function cmdTimestamp(v: string | undefined): string | null;  // → ISO 'YYYY-MM-DDTHH:MM:SS' (naive; CMD is US/Eastern) else null
export function cmdNumber(v: string | undefined): number | null;
export function cmdMoney(v: string | undefined): string | null;      // '####.##' decimal string, 2dp, else null
export function isCmdTrue(v: string | undefined): boolean;           // '1' | 'Y' | 'T'
```
- [ ] Tests: TSV with `\r\n`, trailing blank line, quoted-looking values kept verbatim, short row padding; date/timestamp/money parsers incl. invalid dates (`02/30/2026` → null); a two-entry ZIP built with `zlib.deflateRawSync` + hand-written local/central headers parses both tables and ignores `meta/oracle-create.sql`.
- [ ] Run → FAIL. Implement. Run → PASS.

## Task 4: Snapshot → AR rows mapper (status derivation, claim aggregation)

**Files:** Create `src/billingAudit/arSnapshotMap.ts`; Test `test/arSnapshotMap.test.ts`. Consumes Task 3 + `normalizeStatus` (`src/collections/claimStatus.ts`) + `bandForAgeDays` (Task 1).

**Produces:**
```ts
export interface ArPatientPlain { cmdPatientId: string; patientName: string; patientDob: string | null; memberId: string | null; groupNumber: string | null; primaryPayerName: string | null; }
export interface ArChargePlain { cmdChargeId: string; cmdClaimId: string; cmdPatientId: string; dosFrom: string | null; dosTo: string | null; cptCode: string | null; modifiers: string | null; revCode: string | null; units: string | null; chargeAmount: string; allowed: string | null; insPaid: string; patPaid: string; adjustments: string; balance: string; balanceDueTo: string | null; billTo: string | null; cmdStatusText: string | null; statusRaw: string; statusCategory: StatusCategory; statusPayer: string | null; firstBillDate: string | null; lastBillDate: string | null; insLastPaymentDate: string | null; enteredAt: string | null; }
export interface ArDenialSummaryItem { g: string | null; c: string; amt: string; n: number; }
export interface ArClaimPlain { cmdClaimId: string; cmdPatientId: string; claimType: string | null; claimFrequency: string | null; typeOfBill: string | null; admitDate: string | null; dischargeDate: string | null; dosFrom: string | null; dosTo: string | null; enteredAt: string | null; firstBillDate: string | null; lastBillDate: string | null; lineCount: number; openLineCount: number; totalCharges: string; insPaid: string; patPaid: string; adjustments: string; balance: string; balanceDueTo: string | null; primaryPayerName: string | null; currentPayerName: string | null; currentPayerLevel: number | null; payerType: string | null; cmdStatusText: string | null; statusRaw: string; statusCategory: StatusCategory; statusPayer: string | null; authNumber: string | null; payerClaimControlNo: string | null; cmdFollowupDate: string | null; cptCodes: string[]; revCodes: string[]; last835Status: string | null; last835Date: string | null; lastActivityDate: string | null; lastErrorCode: string | null; lastErrorMessage: string | null; lastErrorAt: string | null; lastErrorReceiver: string | null; denialSummary: ArDenialSummaryItem[]; hasDenial: boolean; cmdNoteCount: number; lastCmdNoteAt: string | null; insLastPaymentDate: string | null; }
export interface ArRemitPlain { cmdRemitId: string; cmdClaimId: string; cmdChargeId: string; kind: 'A' | 'R'; groupCode: string | null; code: string; amount: string | null; isDenial: boolean; isAdjustment: boolean; payerName: string | null; payerLevel: number | null; receivedDate: string | null; }
export interface ArStatusEventPlain { cmdStatusId: string; cmdClaimId: string; statusType: string; statusDate: string | null; statusCode: string | null; statusMessage: string | null; actionCode: string | null; actionMessage: string | null; receiverName: string | null; errFixed: string | null; }
export interface ArNotePlain { cmdNoteId: string; cmdClaimId: string; cmdPatientId: string; authorLabel: string; message: string; noteType: string | null; notedAt: string | null; }
export interface ArMapped { facilityName: string | null; snapshotAsOf: string | null; patients: ArPatientPlain[]; claims: ArClaimPlain[]; charges: ArChargePlain[]; remits: ArRemitPlain[]; statusEvents: ArStatusEventPlain[]; notes: ArNotePlain[]; skips: Record<string, number>; }
export function mapSnapshot(tables: SnapshotTables): ArMapped;
export function deriveChargeStatus(input: { customStatusText: string | null; balance: number; balanceDueTo: string | null; currentPayerName: string | null; currentPayerLevel: number | null }): { statusRaw: string; statusCategory: StatusCategory; statusPayer: string | null };
```
Rules:
- Skip charges with `DELETED` true or `TRANTYPE !== 'H'`; skip deleted claims/notes/remits/status events; skip charges whose claim is missing (count in `skips`).
- Patients: from `B_PATIENT` (`PLAST, PFIRST` → `"LAST, FIRST"`, `PBDATE`), member id from `INS_POLICIES` (PRIORITY 1, non-inactive) else `B_PATIENT.INSID1`; group from `GROUPNO1`; only patients referenced by a kept claim.
- Current payer per claim: latest `B_ACTIVITY` row (not deleted, `TRANTYPE ∈ {E,P,F}`, by `ENTERED`) → `PAYOR` name via `B_PAYOR`; level 2 when `PAYER_PRIORITY='S'` or payer id = claim `PAYOR2`; fallback claim `PAYOR1` (level 1). `primaryPayerName` = claim `PAYOR1` name.
- `deriveChargeStatus` per the verified table above; `statusCategory` via `normalizeStatus(statusRaw)`.
- Claim status = status of the open charge with the largest balance (tie → latest DOS); all-zero balance → `PAID`.
- `last835Status/Date` from latest activity with non-blank `RSTATUS`; `lastError*` from latest `B_CLAIMSTATUS` with `STATUS_TYPE ∈ {ERROR, WARNING}` (message truncated to 300 chars).
- Denial summary: remits `kind='A'` with `GROUP_CODE ∈ {CO, PI, OA}` or `DENIAL='Y'`, grouped by (group, code), sum amount, count; top 6 by |amount|; `hasDenial` = any `DENIAL='Y'` or any CO/PI adjustment on a claim with balance > 0.
- `snapshotAsOf` = max `B_CHARGE.LASTUPDATE`; `facilityName` = first `B_PRACTICE.NAME`.
- Status events kept: `ERROR`/`WARNING` rows plus the single latest row per claim.

- [ ] Write fixture builder `test/fixtures/arSnapshotFixture.ts` producing a synthetic `SnapshotTables` (2 patients, 3 claims, 6 charges, 2 payors, 1 custom status, activity rows incl. a secondary submission, 4 remits, 3 status events incl. 1 ERROR, 2 notes) — all synthetic names/ids.
- [ ] Tests: custom status wins; PAID at zero balance; `CLAIM AT <payer>`; ` - SECONDARY` suffix; `BALANCE DUE PATIENT`; `BALANCE DUE OTHER`; deleted charge skipped; claim aggregation sums + open line count + cpt/rev sets; denial summary grouping/sign; latest error picked; notes mapped with author/time; patients de-duplicated; `snapshotAsOf`.
- [ ] Run → FAIL. Implement. Run → PASS.

## Task 5: Migration 0109 (authored, then applied)

**Files:** Create `supabase/migrations/0109_ar_management.sql`, `supabase/migrations/0109_ar_management_rollback.sql`.

Header block per `.claude/rules/sql-migrations.md`. `set role claims_admin;` … `reset role;`. Tables (all `business_entity_id uuid not null references core.business_entity(id) on delete restrict` except `ar_notification_seen`), every composite index leads with `business_entity_id`:

- `claims.ar_snapshot_run` — id, business_entity_id, cmd_customer_id text, facility_code text, status text check in ('running','ok','error','empty','not_configured'), error_label text, writer_user text, started_at, finished_at, zip_bytes int, snapshot_as_of timestamptz, claims_seen int, charges_seen int, patients_upserted int, claims_upserted int, charges_upserted int, remits_upserted int, status_events_upserted int, notes_inserted int, created_at. Index `(business_entity_id, cmd_customer_id, finished_at desc)`.
- `claims.ar_patient` — id, business_entity_id, cmd_customer_id, cmd_patient_id, patient_name_enc bytea not null, patient_name_bidx text, patient_name_pfx3_bidx text, patient_dob_enc bytea, member_id_enc bytea, member_id_bidx text, primary_payer_name text, first_seen_at, last_seen_at; unique (business_entity_id, cmd_patient_id); index on bidx columns.
- `claims.ar_claim` — id, business_entity_id, cmd_customer_id, facility_code, facility_name, cmd_claim_id, cmd_patient_id, claim_type, claim_frequency, type_of_bill, admit_date date, discharge_date date, dos_from date, dos_to date, entered_at timestamptz, first_bill_date date, last_bill_date date, line_count int, open_line_count int, total_charges numeric(12,2), ins_paid numeric(12,2), pat_paid numeric(12,2), adjustments numeric(12,2), balance numeric(12,2), balance_due_to text, primary_payer_name text, current_payer_name text, current_payer_level smallint, payer_type text, cmd_status_text text, status_raw text not null, status_category text not null check (7 values), status_payer text, auth_number text, payer_claim_control_no text, cmd_followup_date date, cpt_codes text[] not null default '{}', rev_codes text[] not null default '{}', last_835_status text, last_835_date date, last_activity_date date, last_error_code text, last_error_message text, last_error_at timestamptz, last_error_receiver text, denial_summary jsonb not null default '[]', has_denial boolean not null default false, cmd_note_count int not null default 0, last_cmd_note_at timestamptz, ins_last_payment_date date, in_latest_snapshot boolean not null default true, first_seen_at, last_seen_at, last_run_id bigint; unique (business_entity_id, cmd_claim_id); indexes: `(business_entity_id, balance desc)`, `(business_entity_id, dos_from)`, `(business_entity_id, facility_code)`, `(business_entity_id, status_category)`, `(business_entity_id, current_payer_name)`, `(business_entity_id, cmd_patient_id)`.
- `claims.ar_charge` — id, business_entity_id, cmd_customer_id, cmd_charge_id, cmd_claim_id, cmd_patient_id, dos_from, dos_to, cpt_code, modifiers, rev_code, units numeric, charge_amount numeric(12,2), allowed numeric(12,2), ins_paid, pat_paid, adjustments, balance, balance_due_to, bill_to, cmd_status_text, status_raw, status_category, status_payer, first_bill_date, last_bill_date, ins_last_payment_date, entered_at, in_latest_snapshot boolean default true, first_seen_at, last_seen_at; unique (business_entity_id, cmd_charge_id); index `(business_entity_id, cmd_claim_id)`.
- `claims.ar_remit` — id, business_entity_id, cmd_remit_id, cmd_claim_id, cmd_charge_id, kind text check in ('A','R'), group_code text, code text, amount numeric(12,2), is_denial bool, is_adjustment bool, payer_name text, payer_level smallint, received_date date; unique (business_entity_id, cmd_remit_id); index `(business_entity_id, cmd_claim_id)`.
- `claims.ar_claim_status_event` — id, business_entity_id, cmd_status_id, cmd_claim_id, status_type text, status_date timestamptz, status_code text, status_message text, action_code text, action_message text, receiver_name text, err_fixed text; unique (business_entity_id, cmd_status_id); index `(business_entity_id, cmd_claim_id, status_date desc)`.
- `claims.ar_claim_note` — id, business_entity_id, cmd_customer_id text, cmd_claim_id, source text check in ('cmd','user'), cmd_note_id text, author_label text not null check (char_length between 1 and 120), author_user_id uuid, note_enc bytea not null, note_type text, noted_at timestamptz not null, created_at; partial unique index `(business_entity_id, cmd_note_id) where cmd_note_id is not null`; index `(business_entity_id, cmd_claim_id, noted_at desc)`. **No UPDATE/DELETE grant to any non-owner role.**
- `claims.ar_claim_work` — id, business_entity_id, cmd_claim_id, work_status text check in ('open','in_progress','waiting_payer','appeal','resolved','dismissed'), assignee_user_id uuid, assignee_email text, due_on date, resolution_code text check (null or length ≤ 60), updated_by_user_id uuid, updated_by_email text, updated_at, created_at; unique (business_entity_id, cmd_claim_id); index `(business_entity_id, work_status)`, `(business_entity_id, assignee_user_id)`.
- `claims.ar_claim_event` — id, business_entity_id, cmd_claim_id, event_type text check in ('note','status','assign','due','resolution'), actor_user_id uuid not null, actor_email text not null, from_value text, to_value text, detail jsonb not null default '{}', created_at; index `(business_entity_id, created_at desc)`, `(business_entity_id, cmd_claim_id, created_at desc)`.
- `claims.ar_notification_seen` — app_user_id uuid primary key references claims.app_user(user_id) on delete cascade, last_seen_at timestamptz not null default now().

Grants: `revoke all … from public, anon, authenticated, service_role, claims_audit_writer`; writer `select, insert, update` on run/patient/claim/charge/remit/status_event, `select, insert` on ar_claim_note; sequences `usage, select`; reader `select` on all ten. RLS enabled on all; reader `using (true)` select policies; writer GUC-scoped select/insert/update policies (0049 shape). Definers (claims_admin-owned, `security definer`, `set search_path = claims, pg_catalog`, EXECUTE to claims_reader, revoked from public/anon/authenticated):
- `claims.ar_add_note(p_user uuid, p_email text, p_entity uuid, p_claim text, p_note_enc bytea) returns bigint` — validates non-null, `p_claim ~ '^[0-9]{1,20}$'`, note ≤ 16 KB, inserts note (source 'user', author_label = p_email, noted_at now()) + event `note` (detail `{"len": n}`), returns note id.
- `claims.ar_set_work(p_user uuid, p_email text, p_entity uuid, p_claim text, p_status text, p_assignee_user uuid, p_assignee_email text, p_due date, p_resolution text) returns void` — validates status in the allowed set, upserts `ar_claim_work`, writes one event per changed field (`status`, `assign`, `due`, `resolution`) with from/to.
- `claims.ar_mark_notifications_seen(p_user uuid) returns void` — upsert `ar_notification_seen.last_seen_at = now()`.

Verification block (commented): `has_table_privilege` checks; `pg_has_role('postgres','claims_admin','SET')` still true; policy counts.

- [ ] Write both files; `npm run typecheck` unaffected (SQL).
- [ ] **Apply** via Supabase MCP `apply_migration` (name `0109_ar_management`) **after** `select max(version) … where name like '0109%'` returns none. (Authorised for tonight by Alec's explicit instruction: "execute the scheme … do the whole thing".)
- [ ] Verify live: `has_table_privilege('claims_audit_writer','claims.ar_claim','INSERT')` true; `has_table_privilege('claims_reader','claims.ar_claim','SELECT')` true; `has_table_privilege('claims_reader','claims.ar_claim_note','INSERT')` false; `has_function_privilege('claims_reader','claims.ar_add_note(uuid,text,uuid,text,bytea)','EXECUTE')` true; `public` execute false; RLS on all 10; policy count as designed.
- [ ] Append the apply record to `veris-data-notes.md`.

## Task 6: Writer + cron loop + CLI

**Files:** Create `src/billingAudit/arConfig.ts`, `src/billingAudit/arSnapshotWrite.ts`, `src/billingAudit/arSnapshotCron.ts`, `src/billingAudit/arSnapshotCli.ts`; Test `test/arSnapshotCron.test.ts`, `test/arSnapshotWrite.test.ts`. Add `"ingest:ar-snapshot": "tsx src/billingAudit/arSnapshotCli.ts"` to root `package.json`.

**Produces (`arConfig.ts`):**
```ts
export const AR_CACHE_TAG = 'ar-management';
export const AR_SNAPSHOT_CUSTOMERS: readonly CmdCustomerTarget[]; // 17 audit-consolidated + TREAT_CO 10035974 + HOUSTON_MH 10035976
export const AR_EXPECTED_EMPTY_CUSTOMERS: ReadonlySet<string>;    // {'10033951','10035974'} — tiny books; 'empty' is honest
export const AR_SNAPSHOT_STALENESS_MS = 20 * 3600_000;
```
**Produces (`arSnapshotWrite.ts`):**
```ts
export interface ArWriteStats { patients: number; claims: number; charges: number; remits: number; statusEvents: number; notesInserted: number; }
export async function writeArSnapshot(db: Db, mapped: ArMapped, ctx: { businessEntityId: string; cmdCustomerId: string; facilityCode: string; runId: number }): Promise<ArWriteStats>;
```
Encrypts PHI (patient trio, notes) OUTSIDE transactions (`encryptPhi`, `patientNameBlindIndexSafe`, `blindIndexesForRowSafe`); batched (500) `insert … on conflict do update` for patient/claim/charge/remit/status_event inside `withTenant`; notes: `select cmd_note_id from claims.ar_claim_note where business_entity_id=$1 and cmd_customer_id=$2 and source='cmd'` first, encrypt + insert only new ids with `on conflict (business_entity_id, cmd_note_id) where cmd_note_id is not null do nothing`; finally `update claims.ar_claim set in_latest_snapshot=false where business_entity_id=$1 and cmd_customer_id=$2 and last_run_id <> $3 and in_latest_snapshot` (same for ar_charge, keyed by last_seen_at < run start).

**Produces (`arSnapshotCron.ts`):**
```ts
export interface ArSnapshotCronDeps { customers: readonly CmdCustomerTarget[]; fetchSnapshot: (customerId: string) => Promise<CmdSnapshotResult>; writeDb: Db; writerUser: string; expectedEmptyCustomerIds: ReadonlySet<string>; revalidate?: () => void | Promise<void>; now?: () => number; budgetMs?: number; stalenessMs?: number; }
export interface ArSnapshotCronStats { customers_total: number; customers_processed: number; customers_failed: number; customers_skipped_budget: number; customers_skipped_fresh: number; customers_not_configured: number; customers_unauthorized: number; claims_upserted: number; charges_upserted: number; notes_inserted: number; per_customer: Array<{ customerId: string; facilityCode: string; outcome: string; claims: number; charges: number; notes: number; }>; }
export async function arSnapshotCron(deps: ArSnapshotCronDeps): Promise<ArSnapshotCronStats>;
```
Loop mirrors `cmdCensusCron`: freshness read (`… from claims.ar_snapshot_run where … status='ok' and finished_at > now() - $ms`), START row (`status='running'`) in its own `withTenant`, fetch (outside any transaction), parse+map, write, FINISH row (ok/empty/error/not_configured/unauthorized) with counts; per-customer try/catch with PHI-safe `error_label` (fixed tokens: `fetch_failed`, `parse_failed`, `write_failed`); wall-clock budget default 240 s; sequential.

- [ ] Tests (fake `pg.Pool` recording queries by connection, as in `test/cmdCensusCron.test.ts`): fresh-skip; stale-pull writes START/FINISH inside `withTenant` envelopes on the same connection; `not_configured` records a run row and continues; a throwing fetch closes the run row `error`/`fetch_failed`; budget exit skips remaining without run rows; `writeArSnapshot` emits one `insert into claims.ar_claim` per ≤500 rows, `on conflict (business_entity_id, cmd_claim_id) do update`, notes insert only for ids absent from the pre-read.
- [ ] Run → FAIL. Implement. Run → PASS.
- [ ] CLI: `tsx src/billingAudit/arSnapshotCli.ts [--from-dir <dir>] [--customer <id>] [--commit]` — loads `.env` like `patientDirectorySync.ts`; without `--commit` it maps and prints non-PHI counts + derived status distribution per customer; with `--commit` it runs `arSnapshotCron` against `CLAIMS_AUDIT_WRITER_DATABASE_URL` (asserting the writer identity first) using either the saved ZIPs or live CMD.
- [ ] Run the CLI dry-run over `/Users/aleclowi/CMD API Scripts/out/snapshot` (all 20 ZIPs) → print per-customer counts and the status distribution; compare `CLAIM AT` vocabulary with `claims.audit_row` (spot check 5 payer strings).
- [ ] Run `--commit --from-dir …` → verify live counts (`select count(*) from claims.ar_claim`, by facility, open balance sum), zero decrypt failures on a sample reveal.

## Task 7: Query builders

**Files:** Create `src/billingAudit/arQuery.ts`, `src/billingAudit/carcDescriptions.ts`; Test `test/arQuery.test.ts`.

**Produces:**
```ts
export const AR_PAGE_SIZE = 50;
export type ArSortColumn = 'balance'|'dos_from'|'age'|'total_charges'|'facility_code'|'current_payer_name'|'status_category'|'last_note_at'|'work_status';
export interface ArSort { column: ArSortColumn; direction: 'asc'|'desc'; }
export interface ArCursor { id: number; value: string | number | null; }
export interface ArFilter { bands?: ArBandKey[]; facilityCodes?: string[]; payerNames?: string[]; statusCategories?: string[]; workStatuses?: string[]; assigneeUserIds?: string[]; hasDenial?: boolean; minBalance?: number; includePaid?: boolean; patientNameBidx?: string[]; patientNamePrefixBidx?: string[]; memberIdBidx?: string[]; claimId?: string; }
export interface ArQueueRow { id: number; cmd_claim_id: string; cmd_patient_id: string; facility_code: string | null; facility_name: string | null; claim_type: string | null; type_of_bill: string | null; dos_from: string | null; dos_to: string | null; age_days: number | null; band: ArBandKey | null; cpt_codes: string[]; rev_codes: string[]; total_charges: string; ins_paid: string; pat_paid: string; adjustments: string; balance: string; primary_payer_name: string | null; current_payer_name: string | null; status_raw: string; status_category: string; status_payer: string | null; cmd_status_text: string | null; has_denial: boolean; denial_summary: ArDenialSummaryItem[]; last_error_code: string | null; last_835_status: string | null; cmd_followup_date: string | null; cmd_note_count: number; last_cmd_note_at: string | null; last_user_note_at: string | null; work_status: string; assignee_email: string | null; due_on: string | null; last_seen_at: string | null; in_latest_snapshot: boolean; }
export function resolveArFilter(input: unknown): ArFilter;  // bounded, allowlisted
export function resolveArSort(input: unknown): ArSort;      // default balance desc
export function resolveArCursor(input: unknown): ArCursor | null;
export function buildArQueueQuery(cursor, filter, sort, limit, entityIds, asOf): { sql: string; params: unknown[] };
export function arSortValue(row: ArQueueRow, column: ArSortColumn): string | number | null;
export function buildArSummaryQuery(filter, entityIds, asOf): { sql; params };          // per band: claims, balance; plus totals, denied count, with-note count, overdue-followup count
export function buildArFacilityOptionsQuery(entityIds): …; buildArPayerOptionsQuery(entityIds): …; buildArAssigneeOptionsQuery(): …  // app_user super_admin+admin (user_id, email)
export function buildArClaimDetailQuery(cmdClaimId, entityIds): …;  // claim + work
export function buildArChargeLinesQuery(cmdClaimId, entityIds): …;
export function buildArRemitsQuery(cmdClaimId, entityIds): …;
export function buildArStatusEventsQuery(cmdClaimId, entityIds, limit=40): …;
export function buildArNotesQuery(cmdClaimId, entityIds, limit=200): …;  // note_enc + meta (decrypt at composition root)
export function buildArEventsQuery(cmdClaimId, entityIds, limit=100): …;
export function buildArNotificationsQuery(userId, entityIds, limit=25): …;  // events newer than seen cursor, not by the user, joined to facility_code + cmd_claim_id
export function buildArNotificationCountQuery(userId, entityIds): …;
export function buildArPatientRevealQuery(cmdPatientId, entityIds): …;  // enc columns only
```
Queue predicates: `c.business_entity_id = any($1::uuid[])`, `c.in_latest_snapshot`, `c.balance > 0` unless `includePaid`, `LEFT JOIN claims.ar_claim_work w`, `LEFT JOIN claims.ar_patient p` (for bidx filters), a `lateral` for `last_user_note_at`; age = `($asOf::date - c.dos_from)`; band via `arBandCaseSql`; band filter compiled to day ranges (`dos_from` between bounds) so the index on `dos_from` is usable; keyset `(sortExpr dir nulls last, c.id dir)` with `{id,value}` cursor like `auditQuery.ts`.

- [ ] Tests: every builder emits only `$n` params (regex: no `'` literals from input), tenant predicate present, sort allowlist rejects unknown, cursor validation, band filter compiles to date bounds, `includePaid` toggles the balance predicate, summary groups by band key.
- [ ] Run → FAIL. Implement. Run → PASS.

## Task 8: App server layer + Server Actions

**Files:** Create `app/lib/ar/contract.ts`, `app/lib/ar/deps.ts`, `app/lib/ar/server.ts`, `app/lib/ar/actions.ts`, `app/lib/ar/open-claim-store.ts`.

`contract.ts`: re-export `ArQueueRow`, `ArFilter`, `ArSort`, `ArCursor`, band labels (`AR_BANDS`), `WORK_STATUSES` (value/label/tone), result unions (`ArQueueResult`, `ArSummaryResult`, `ArClaimDetailResult`, `ArNotesResult`, `ArMutationResult`, `ArNotificationsResult`, `ArRevealResult`).

`server.ts` (server-only, not `'use server'`): `loadArQueuePage`, `loadArSummary`, `loadArOptions`, `loadArClaimDetail` (claim + work + charges + remits + status events + events), `loadArNotes` (decrypt each `note_enc` in-process; returns text), `revealArPatient` (writes `access_audit` `reveal_ar_patient` with id-only detail BEFORE returning; decrypts name/dob/member), `addArNote(actor, entity, claimId, text)` (encrypt → `select claims.ar_add_note(...)`), `setArWork(...)` (`select claims.ar_set_work(...)`), `loadArNotifications`, `markArNotificationsSeen`. All use the reader executor from `deps.ts`. Cache: queue/summary/options wrapped in `unstable_cache` tag `ar-management` (revalidate 300); detail/notes/notifications uncached.

`actions.ts` (`'use server'`, async-only exports): `loadArQueue(view, cursor, filter, sort)`, `loadArSummaryAction(view, filter)`, `loadArOptionsAction(view)`, `loadArClaimDetailAction(view, claimId)`, `loadArNotesAction(view, claimId)` (gated `canRevealPhi` — notes may carry incidental PHI), `revealArPatientAction(view, cmdPatientId)` (gated + audited), `addArNoteAction(view, claimId, text)` (role admin|super_admin, text 1–4000 chars), `setArWorkAction(view, claimId, patch)` (role admin|super_admin), `searchArPatientsAction(term, view)` (gated; tokens via `patientNameBlindIndex`/`patientNamePrefixBlindIndex`/`memberIdBlindIndex`), `loadArNotificationsAction()` (super_admin only), `markArNotificationsSeenAction()` (super_admin only). Entity scope from `viewToEntityIds(clampView(resolveClaimsDeskView…))` — reuse `dashboardAccess` + `resolveClaimsDeskView` (BXR/Indigo only). Mutations call `revalidateTag('ar-management')`.

- [ ] Implement; `cd app && npm run typecheck` passes.

## Task 9: Cron route + composition + schedule

**Files:** Modify `app/lib/server.ts` (add `handleArSnapshotCron`), create `app/app/api/cron/ar-snapshot/route.ts`, modify `app/vercel.json`.

`handleArSnapshotCron(req)`: 405 → 401 (`CRON_SECRET`) → `assertAuditWriterIdentity()` → `arSnapshotCron({ customers: AR_SNAPSHOT_CUSTOMERS, fetchSnapshot: (id) => cmdFetchSnapshot({ ...cmdApiConfig() minus report ids, customerId: id }), writeDb: auditWriterDb(), writerUser, expectedEmptyCustomerIds: AR_EXPECTED_EMPTY_CUSTOMERS, revalidate: () => revalidateTag('ar-management'), stalenessMs: env override })` → 200 with stats; catch → 500 `cron_failed`.
Schedule: `{ "path": "/api/cron/ar-snapshot", "schedule": "5 14 * * *" }` (14:05 UTC — CMD builds snapshots in the morning ET; direct GET, no report-slot contention).

- [ ] Implement; add a hermetic test `test/arSnapshotHandler.test.ts` only if the handler is factored into `src/routes/` (optional); otherwise rely on the existing cron test pattern. `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/ar-snapshot` in local dev returns 200 with `customers_skipped_fresh` after the CLI load.

## Task 10: UI — AR Queue tab (frontend-design skill)

**Files:** Create the `app/components/billing-audit/ar/*` files listed in File Structure; modify `workbench.tsx`, `page.tsx`, `maintenance-notice.tsx`, `nav-model.ts`.

Design (TreatHealthOS v1 tokens, Collections grid idiom):
- **Header**: `AR Management` h1; subtitle; freshness line from `ar_snapshot_run` (snapshot as-of + facilities covered); Facility Resolution link unchanged.
- **Tabs**: `AR Queue` (default) · `IP Audit` · `OP Audit` · `Billable Days`. Roving tabindex preserved.
- **AgingStrip**: hero "Open AR" total ($ + claims), then 9 band tiles in a horizontal grid; each tile = label, `$` balance, claim count, and a thin proportional bar; `0–30` rendered muted; clicking toggles the band filter (aria-pressed); a "31+ days only" quick toggle.
- **FilterBar**: `MultiSelectTagPicker` for facility and payer (client mode), status category select, work status chips, assignee select, `Has denial` toggle, `Include paid` toggle, patient search input (visible only when `canRevealPhi`; resolves to blind-index tokens server-side), `Clear all`.
- **QueueTable**: single focusable `role="region"` scrollport, sticky `<th>`, `text-sm`, keyset `Pager`, allowlisted `SortHeaderCell`s. Columns: Patient (mask / revealed), Facility (acronym pill), Payer & status (`StatusChip` e.g. `At payer · CIGNA`), DOS (range), Codes (CPT/rev mono chips), Charged, Paid, Balance (bold), Age (`123d` + `BandPill`), Denial (`DenialPills` top 2 `CO 45`), Notes (`3 · 12d`), Work (`WorkChip`), Assignee, Follow-up (CMD `cmd_followup_date` / due_on). Row click opens the drawer; `Reveal all` toggle (gated) bulk-reveals the page via one action.
- **ClaimDrawer**: `useDialog` focus-trapped `role="dialog"` right slide-over (`w-[560px]`, `shadow-ths-lg`, `animate-ths-reveal`); sections: identity (masked → reveal), money strip (charged / paid / adjustments / balance / age), **Status & reasoning** (CMD status, current payer, last 835 status, CMD follow-up date, payer control #, auth #, latest clearinghouse error, denial CAS table with `carcDescriptions`), **Charge lines** (compact table), **Notes** (CMD-imported + in-app, newest first, author + time; textarea + `Add note`), **Work** (status select, assignee select, due date, resolution input, `Save`). Every write refreshes the row in place (`opacity-60` during refetch, never a skeleton).
- **Empty / non-BXR**: Indigo view shows an honest notice ("CMD data snapshots are not configured for the Indigo account (474623) — probed 2026-08-14 and 2026-09-09").

- [ ] Load `frontend-design:frontend-design`; implement leaves first (`ar-leaves.tsx`) with `app/test/ar-leaves-render.test.tsx` (string render: mask by default, band pill text, work chip labels, money formatting).
- [ ] Implement the workbench, strip, filter bar, table, drawer; wire into `workbench.tsx` (`key={view}` on the AR panel too).
- [ ] Update `billingAuditViewRemount.test.tsx` (three keyed panels now: AR + IP + OP), `nav-rail-render.test.tsx` and `shell-nav-model.test.tsx` (`AR Management` label).

## Task 11: Notifications bell

**Files:** Create `app/components/ar-notifications-bell.tsx`; modify `app/app/layout.tsx`.

Client component; renders only when passed `enabled` (layout computes `role === 'super_admin' && user`). Polls `loadArNotificationsAction()` on mount, on window focus, and every 60 s; shows a `Bell` icon with an unread badge (aria-live polite text "N new AR updates"); click opens a menu (`role="menu"`, Escape/outside-click close) listing up to 25 events: event verb (`Note added` / `Status → Waiting on payer` / `Assigned to …`), facility acronym, `Claim …last4`, actor, relative time; `Mark all read` → `markArNotificationsSeenAction()`; clicking an item sets `openClaimStore.set({ view: 'bxr', cmdClaimId })` and `router.push('/billing-audit?view=bxr')`; the AR workbench reads and clears the store on mount to open the drawer. Test `app/test/ar-bell-render.test.tsx` renders the pure `BellMenuItems` leaf.

## Task 12: Docs, rules, gate, PR

- [ ] `.claude/rules/billing-audit.md`: rename heading to AR Management, add "The snapshot feed" section (endpoint, roster, derivation, tables, cron, what is PHI).
- [ ] `CLAUDE.md`: register this plan (read-order 11), update nav bullets (`AR Management (Beta)`), add the cron row, update the migration next-number to **0110** with the 0109 apply note.
- [ ] `veris-data-notes.md`: append "0109 AR Management — applied …" + snapshot recon facts.
- [ ] Run the five-command gate; fix everything; re-run.
- [ ] Commit in logical chunks (no co-author trailer), push `feat/ar-management`, `gh pr create --base main` with a body: what shipped, recon, the applied migration (and why it was applied tonight), how to verify locally, open items (Indigo snapshot not configured; bulk actions; CARC descriptions table join; HOUSTON_MH/TREAT_CO inclusion for ruling).
- [ ] Leave `next dev` running on a free port and report the URL.

---

## Self-review

- Spec coverage: probe ✔ (recon table) · schema + verification vs `CLAIM AT` ✔ (Task 4/5/6) · data filtering ✔ (deleted/trantype/in_latest_snapshot/balance) · aged categories ✔ (Task 1/10) · notes ✔ · denial reasoning ✔ · resolved-unresolved oversight ✔ (paid-since-worked derived at read, work statuses) · notifications bell ✔ (Task 11) · localhost + PR ✔ (Task 12).
- Type consistency: `ArBandKey`, `ArQueueRow`, `ArFilter`, `ArMapped` names are used identically in Tasks 1/4/7/8/10.
