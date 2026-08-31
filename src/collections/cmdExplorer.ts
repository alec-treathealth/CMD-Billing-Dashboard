/**
 * CMD "Collections Explorer" report mapping (Derek's 14-column batch export).
 *
 * Maps the CMD batch-report CSV rows (parsed by cmdPayer.ts) into the 14-column
 * explorer shape, SPLIT into a non-PHI projection (safe to cache + ship to the
 * browser) and a PHI projection (Patient Full Name / Member ID / Group Number),
 * which is NEVER cached at rest and is surfaced only via the audited per-row reveal.
 *
 * Each row carries a content fingerprint `rowId` = SHA-256 over ALL 14 field values
 * (incl. PHI). The hash is a one-way token (this project already treats SHA-256 of
 * patient terms as a non-PHI binding token — see queries/identity.ts), so it is safe
 * to store in the non-PHI cache. Because the hash includes the PHI, a rowId matches
 * EXACTLY one row's content: the reveal path can fail closed to "unavailable" but can
 * never surface a different patient's identifiers.
 *
 * Pure + env-free (composition-root pattern): no network, no secrets, never logs cell
 * values. The live fetch/poll/unzip lives in cmdPayer.ts; this only maps parsed rows.
 */
import { createHash } from 'node:crypto';
import { toAmount, type CmdReportRow } from './cmdPayer.js';
import { normalizeDate } from './normalize.js';

/** Verified CMD report CSV headers. One alias each for resilience to label edits. */
/** Exported so a test can assert BXR_REPORT_COLUMNS still satisfies every field the mapper
 *  reads — the two lists can otherwise drift apart silently. Not part of the runtime API. */
export const HEADERS = {
  charge_from_date: ['Charge From Date'],
  payment_received: ['Payment Received'],
  cpt_code: ['Charge CPT Code', 'CPT Code'],
  // ⚠ 10094775 ALIASES (2026-08-15) — EVERY ONE IS APPENDED LAST, AND THE ORDER IS LOAD-BEARING.
  //
  // pick() returns the FIRST candidate present. During the cutover BOTH reports are in play: the
  // live 10093959 and the replacement 10094775. Several of 10093959's columns coexist with their
  // 10094775 counterpart ON THE SAME REPORT — it pins BOTH 'Charge Insurance Payments' AND
  // 'Insurance Paid Amount', and BOTH 'Charge Total Adjustments w/ Transfers' AND 'Insurance
  // Adjustment Amount'. Put a new alias FIRST and the OLD report would silently start reading the
  // other column, changing values inside the LOCKED fingerprint on a report nobody edited.
  // Appended last, each new label is reached ONLY when no canonical candidate is present — so one
  // code path maps both reports correctly and the two can be swapped by env var alone.
  //
  // RULED BY ALEC 2026-08-15: on 10094775 these carry the same data as the canonical labels below,
  // relabelled by CMD's report builder. That ruling is recorded rather than independently measured
  // — the repo's ALIAS PROVENANCE bar (compare VALUES on a Charge-ID join, as the 437/437 and 85/85
  // checks did) has NOT been met for the two money aliases. It is the owner's call; the residual
  // risk is bounded and stated at the cutover checklist.
  revenue_code: ['Revenue Code', 'Charge Rev Code'],
  // 'Facility Name/ID' is the bank/deposit report's label. Its cells carry BOTH parts —
  // 'CALIFORNIA MENTAL HEALTH LLC (10272858)' — and splitFacilityLabel strips the id so only the
  // name is ever stored or displayed. Listed second so a report emitting the bare 'Facility Name'
  // is unaffected (pick() returns the first candidate present).
  facility: ['Facility Name', 'Facility Name/ID'],
  patient_name: ['Patient Full Name'], //               PHI
  member_id_raw: ['Claim Primary Member ID', 'Current Payer Member ID'], //         PHI
  group_number: ['Primary Group Number', 'Primary Group #', 'Current Payer Group #'], // PHI
  charge_amount: ['Charge/Debit Amount', 'Charge Amount'],
  allowed_amount: ['Payment Allowed Amount'],
  // ⚠ 'Insurance Paid Amount' IS LAST FOR A REASON — see the ordering block above. The live
  // 10093959 carries BOTH labels, and its canonical one is 'Charge Insurance Payments' (the
  // charge-cumulative running total the rollup takes a MAX of, never a SUM). Reordering these two
  // would repoint a fingerprint field on the report currently in production.
  insurance_payments: ['Charge Insurance Payments', 'Insurance Paid Amount'],
  // 'w/o Transfers' NO LONGER EXISTS in CMD (owner-confirmed 2026-08-01) — the report builder
  // now offers only 'w/ Transfers'. Kept first anyway so any surviving export of the old shape
  // still maps; the live 10093959 report supplies the 'w/' form. MEASURED equivalent, not
  // assumed: on an exact Charge-ID join over CAMH, 'w/ Transfers' reproduced the value the old
  // 'w/o Transfers' column had written on 85 of 85 charges (0 mismatches).
  // ⚠⚠ 'Insurance Adjustment Amount' IS LISTED HERE DESPITE BEING EXPLICITLY REJECTED BELOW.
  // Read both before touching this line — they are not a contradiction once scoped to a report:
  //   · MEASURED 2026-08-01 on report 10093959, where BOTH labels coexist: 'Insurance Adjustment
  //     Amount' reproduced the real total-adjustments value on only 15 of 85 charges (it is
  //     INSURANCE-only, not total). On THAT report it is the wrong column, and because it is
  //     listed LAST it is still never selected there — 'w/ Transfers' is found first.
  //   · RULED BY ALEC 2026-08-15 for report 10094775, which carries NO 'Charge Total Adjustments'
  //     column at all: on that report this label is the total-adjustments field, relabelled.
  // So the alias is reachable ONLY on a report that has no canonical candidate — exactly the
  // report the ruling covers. The 15/85 rejection below stays accurate for 10093959 and is
  // deliberately NOT deleted.
  // NOT INDEPENDENTLY MEASURED on 10094775: the ALIAS PROVENANCE bar (compare values on a
  // Charge-ID join) has not been run for this label on the new report. This field is INSIDE the
  // locked fingerprint, so if the ruling is wrong the cost is a one-time re-insert of the rolling
  // window. The cutover checklist carries the query to detect that.
  adjustments: [
    'Charge Total Adjustments w/o Transfers',
    'Charge Total Adjustments w/ Transfers',
    'Insurance Adjustment Amount',
  ],
  patient_balance_due: ['Charge Balance Due Pat'],
  // ⚠ 'Charge Current Payer Name' IS LAST, and here that ordering is load-bearing in the strictest
  // sense in this file: primary_payer is fingerprint field 13 of 14 (cmdExplorerSeed.ts). Appended
  // last, the alias is reached ONLY when neither canonical label is present — and BOTH explorer
  // reports (10093959 and 10094775) project 'Payer Name', so no existing explorer row's dedup key
  // can move and the book is not re-inserted. Put it first and every fingerprint in the table
  // changes.
  //
  // It exists for the BXR CENSUS report 10093963, which was relabelled the same way the explorer
  // report was and whose aliases nobody added: measured 2026-08-17, 10,327 of BXR's 15,200
  // cmd_charge_census rows (67.9%) carried NULL payer AND NULL status, every one first seen on or
  // after 08-02. Indigo was 0.0% — its report (10092391) kept the old labels, which is what makes
  // the tenant split diagnostic rather than coincidental.
  primary_payer: ['Charge Primary Payer Name', 'Payer Name', 'Charge Current Payer Name'],
  // Feed-1 dimension columns (Qualify v2, artifact ②a) — non-PHI. Present on the 21-col report
  // for BOTH tenants (Step-0 header proof, 2026-07-21). claim_status_category is NOT here — it is
  // DERIVED from claim_status_raw in mapRow (cmdExplorerSeed.ts), not picked from a CSV column.
  // ⚠ 'Claim ID' IS LAST, AND THE CENSUS IS THE REASON. Report 10094775 projects NO charge-grain
  // id at all — only 'Claim ID' — so without this the explorer stores charge_id NULL on every row
  // it ingests (measured 2026-08-17: unresolved against the live 25-column set). RULED BY ALEC
  // 2026-08-17: map it; a claim identifier is more useful here than nothing, and it is what the AR
  // notes feed joins on.
  //
  // THE GRAIN CAVEAT IS REAL AND STAYS TRUE: a claim contains many charges, so on 10094775 this
  // column holds a CLAIM id and several charge lines share one value. Do not treat
  // cmd_explorer_rows.charge_id as a per-charge key on that report. It is safe here because
  // charge_id is NOT one of the locked 14 fingerprint inputs (cmdExplorerSeed.ts) and nothing on
  // the explorer READ path consumes it — it is provenance.
  //
  // The ordering is what keeps it safe for the CENSUS, whose UNIQUE grain is
  // (business_entity_id, charge_id): a claim-grain id there would COLLAPSE every charge of a claim
  // into one row and silently shrink the openCount denominator. The census report (10093963)
  // projects 'Payment Charge ID', which is found FIRST, so it never reaches this candidate.
  // cmdCensus.test.ts pins exactly that.
  charge_id: ['Charge ID', 'Payment Charge ID', 'Claim ID'],
  // 'Payment Entered' is 10094775's label for the CLAIM-ENTRY date — RULED BY ALEC 2026-08-16,
  // and it occupies the exact slot 'Charge Entered Date' held before that edit. Appended LAST per
  // the ordering invariant above. Safe regardless: charge_entered_date is NOT one of the locked 14
  // row_fingerprint inputs (cmdExplorerSeed.mapRow), so this alias cannot move any existing row's
  // dedup key — unlike the money and date columns above, where a repoint would re-insert the book.
  charge_entered_date: ['Charge Entered Date', 'Payment Entered'],
  // 'Charge To Date' is ABSENT from report 10093959 by design: it duplicated 'Charge From Date'
  // on every row this plane ever stored (2,579 of 2,579 with both populated, 0 exceptions), and
  // nothing on the collections plane reads charge_to_date — the readers are all billing_audit_row,
  // a different table. New rows carry NULL here. Not in the fingerprint, so no dedup impact.
  charge_to_date: ['Charge To Date'],
  // 'Charge Status' is the BXR census report's label for the same field (10093963, relabelled ~08-02
  // — see the primary_payer note above). Appended last by the same discipline, though the stakes
  // are lower here: claim_status_raw is explicitly NOT a fingerprint input, so no ordering could
  // move a dedup key. It DOES drive claim_status_category, which mapRow derives from it — and that
  // is the Qualify openCount DENOMINATOR, which is why two weeks of nulls mattered.
  claim_status_raw: ['Claim Status', 'Charge Status'],
  // Plan sponsor / group employer (migration 0101). CMD's label is 'Primary Ins Emp Name' — NOT
  // 'Employer Name'; verified by live probe 2026-08-15 on BOTH tenants' reports. "Emp" here is
  // EMPLOYER (the insurance plan's sponsor), not EMPLOYEE: the subscriber's own name is
  // 'Patient Full Name', a separate column that coexists with this one on the same report.
  // That distinction is the whole basis of the non-PHI ruling — do not re-map this to a person.
  //
  // Present on Indigo's 10092391 (added 2026-08-15, 23rd column) and on BXR's 10094775.
  // 'Employer Name' is listed as a second candidate ONLY because CMD's report builder offers that
  // label elsewhere; pick() returns the first present, so a report carrying either still maps.
  employer_name: ['Primary Ins Emp Name', 'Employer Name'],
} as const;
// ---------------------------------------------------------------------------
// ALIAS PROVENANCE (2026-08-01). CMD report 10091971 was lost; 10093959 replaced it with some
// columns renamed. Each alias above was accepted ONLY after comparing the new column's VALUES
// against what the old column had already written to collections.cmd_explorer_rows, joined on
// Charge ID (itself verified identical first). Byte-equal on every compared charge:
//   'Payer Name'        == 'Charge Primary Payer Name'              437/437
//   'Payment Charge ID' == 'Charge ID'                              211/211
//   'Primary Group #'   == 'Primary Group Number'   (blind index)   433/433
//   'Charge Total Adjustments w/ Transfers' == 'w/o Transfers'       85/85
// Two candidates were REJECTED on the same evidence: the report still carries 'Patient Total
// Balance' (0/85 vs patient_balance_due — patient-wide total, not the per-charge portion) and
// 'Insurance Adjustment Amount' (15/85 vs adjustments — insurance only, not total).
//
// ⚠ SCOPE OF THAT REJECTION NARROWED 2026-08-15 — it is about REPORT 10093959, not about the
// labels in the abstract. 'Patient Total Balance' remains unlisted and must stay that way.
// 'Insurance Adjustment Amount' is now listed as the LAST adjustments candidate, reachable only on
// a report carrying no 'Charge Total Adjustments' column (i.e. 10094775, where Alec ruled it IS the
// total). On 10093959 both labels coexist, 'w/ Transfers' is found first, and this rejection still
// governs — the 15/85 number is not superseded. See the ordering block at the top of HEADERS.
// WHY THIS BAR: five of these fields are inside the LOCKED 14-field fingerprint
// (cmdExplorerSeed.mapRow). Aliasing a same-named-but-different-valued column changes the dedup
// key, ON CONFLICT stops firing, and the cron re-inserts every posting hourly. Never add an alias
// here from a label match alone — compare values first.
//
// ⚠ SCOPE CAVEAT on 'Payment Charge ID' (measured 2026-08-01, report 10093963/filter 10148483,
// customer 10027973). The 211/211 equivalence above could only have been measured on charges that
// HAVE a payment — the sole population where both labels are populated. 'Payment Charge ID' is
// PAYMENT-scoped: on an all-payment-states export it is BLANK for every charge with no posting yet.
// Measured on a 1,215-row census pull: 288 rows blank, and they were exactly the 282 CLAIM AT
// INSURANCE + 6 ON HOLD rows (927/927 populated on PAID / BALANCE DUE PATIENT / NEEDS RENEGOTIATING /
// PENDING+APPROVED FOR HIGHER PAYMENT). So the alias is sound for the payment-anchored EXPLORER and
// UNSAFE as the sole key for the CENSUS, whose only hard required field is charge_id — those rows are
// dropped 'charge_id: missing', silently shrinking the openCount denominator by the un-adjudicated
// claims it exists to hold. Any all-payment-states report MUST project plain 'Charge ID'.
// ---------------------------------------------------------------------------

/**
 * The EXACT column-name set BXR's live report (10093959) projects, verified by probing all 15
 * customer accounts on 2026-08-01. This is the cron path's header contract — see
 * cmdExplorerCron's expectedColumns.
 *
 * WHY A CONTRACT AT ALL: pick() is tolerant by design, and mapRow only rejects a row on
 * charge_from_date / facility / charge_amount / patient_name / member_id. So a report whose OTHER
 * columns were renamed still executes cleanly and maps "successfully" — with those fields NULL.
 * That is not merely bad data: replaceCmdDailyForFacility does a per-facility DELETE+INSERT every
 * run, so the cron would delete good deposit rows and write nulls over them, hourly, silently.
 * The 2026-07-31 incident was the LOUD version of this (the report was deleted outright, the cron
 * failed INVALID CRITERIA, the feed froze and was fully recoverable). Report deletion was human
 * error, so it will recur; recreating a report yields a NEW id and can yield a NEW projection
 * (10091971 -> 10093959 did exactly that, and happened to come back correct). This set is what
 * makes the next recreation safe.
 *
 * SET, NOT ORDER. CMD reorders columns freely — 'Charge Entered Date' arrived in a different
 * position than it left. Only the name set is the contract.
 *
 * Includes columns the mapper does NOT read (Payment Patient ID, Payment Entered, Insurance
 * Adjustment Amount, Patient Total Balance, Insurance Paid Amount): set-equality means an
 * unexpected column is a mismatch, so every column CMD actually sends has to be listed here even
 * when nothing consumes it. Adding a column to the report REQUIRES updating this list.
 */
export const BXR_REPORT_COLUMNS = [
  'Payment Patient ID',
  'Payment Charge ID',
  'Charge Entered Date',
  'Payment Entered',
  'Charge From Date',
  'Payment Received',
  'Charge CPT Code',
  'Revenue Code',
  'Patient Full Name',
  'Payer Name',
  'Claim Primary Member ID',
  'Primary Group #',
  'Charge/Debit Amount',
  'Payment Allowed Amount',
  'Insurance Adjustment Amount',
  'Patient Total Balance',
  'Check Payment',
  'Charge Total Adjustments w/ Transfers',
  'EFT Payment',
  'Insurance Paid Amount',
  'Charge Insurance Payments',
  'Charge Balance Due Pat',
  'Facility Name',
  'Claim Status',
] as const;

/**
 * The column set of the REPLACEMENT BXR report 10094775 — 25 columns, verified by live probe
 * against customer 10027973 on 2026-08-15 (410 rows).
 *
 * Differs from 10093959 above by more than the added employer column: CMD's builder relabelled
 * six fields, and the aliases that absorb those relabels are appended LAST in HEADERS so this set
 * and the legacy one map correctly through one code path. See the ordering block in HEADERS.
 *
 *   Charge/Debit Amount        → Charge Amount
 *   Revenue Code               → Charge Rev Code
 *   Claim Primary Member ID    → Current Payer Member ID
 *   Primary Group #            → Current Payer Group #
 *   Charge Insurance Payments  → Insurance Paid Amount            (ruled equivalent, unmeasured)
 *   Charge Total Adjustments   → Insurance Adjustment Amount      (ruled equivalent, unmeasured)
 *   (new)                      → Primary Ins Emp Name             (the employer)
 *
 * 'Payment Entered' and 'Other Ref #' are NOT here — both were dropped from the report by its
 * owner. 'Payment Charge ID' is likewise gone; 'Charge ID' is the surviving label and HEADERS
 * already accepted both.
 */
export const BXR_REPORT_COLUMNS_10094775 = [
  'Payment Entered',
  'Charge From Date',
  'Payment Received',
  'Charge CPT Code',
  'Charge Rev Code',
  'Claim Primary Member ID',
  'Primary Group #',
  'Patient Full Name',
  'Facility Name',
  'Payer Name',
  'Charge Amount',
  'Payment Allowed Amount',
  'Allowed %',
  'Insurance Paid Amount',
  'Paid % of Allowed',
  'Charge Balance Due Pat',
  'Insurance Adjustment Amount',
  'Payment Check #',
  'Payment Username',
  'EFT Payment',
  'Check Payment',
  'Primary Ins Emp Name',
  'Charge/Debit Entered User',
  'Claim ID',
  'Claim Status',
] as const;

/**
 * Pick the header contract for whichever BXR report is configured.
 *
 * This exists so the cutover is a ONE-STEP env change instead of a coordinated deploy. The guard
 * is SET EQUALITY against a single expected set, so a hardcoded pin is only ever correct for one
 * report: pin the new set and the old report fails every pull until the env flips; pin the old and
 * the new report fails until the deploy lands. Either way there is a window where the BXR ingest
 * is frozen — on a feed the standing rules call production-critical.
 *
 * Keying the pin off the report id removes the window entirely: flipping CMD_EXPLORER_REPORT_ID
 * selects the matching contract atomically, and rolling it back restores the old one just as fast.
 *
 * UNKNOWN REPORT IDS FALL BACK TO THE LEGACY SET ON PURPOSE — never to "no guard". An unrecognised
 * id means somebody pointed the cron somewhere this code has never seen, which is exactly when the
 * projection guard is most valuable; the fallback fails loudly on the first pull rather than
 * ingesting an unverified shape.
 */
export function bxrExpectedColumnsFor(reportId: string): readonly string[] {
  return reportId.trim() === '10094775' ? BXR_REPORT_COLUMNS_10094775 : BXR_REPORT_COLUMNS;
}

/** The column names a parsed CMD report actually carries. Empty pull → empty list (the caller
 *  skips the guard: an empty pull writes nothing and deletes nothing, so there is no shape to
 *  police and nothing at risk). All rows share the CSV's header keys, so row 0 is representative. */
export function reportColumns(rows: readonly CmdReportRow[]): string[] {
  const first = rows[0];
  return first === undefined ? [] : Object.keys(first);
}

/** The 3 PHI fields surfaced only behind the audited per-row reveal. */
export interface CmdExplorerPhi {
  patient_name: string | null;
  member_id_raw: string | null;
  group_number: string | null;
}

/** Non-PHI projection of one report line — safe to cache and ship to the browser. */
export interface CmdExplorerNonPhiRow {
  /** Content fingerprint (SHA-256 over all 14 fields incl. PHI); non-reversible. */
  rowId: string;
  charge_from_date: string | null;
  payment_received: string | null;
  cpt_code: string | null;
  revenue_code: string | null;
  facility: string | null;
  charge_amount: string | null;
  allowed_amount: string | null;
  insurance_payments: string | null;
  adjustments: string | null;
  patient_balance_due: string | null;
  primary_payer: string | null;
  // Feed-1 dimension columns (②a) — the 4 PICKED raw values. claim_status_category is derived
  // downstream in mapRow (it is not a CSV column), so it lands on PlainRow, not here.
  charge_id: string | null;
  charge_entered_date: string | null;
  charge_to_date: string | null;
  claim_status_raw: string | null;
  /**
   * Plan sponsor / group employer (migration 0101) — non-PHI, same class as primary_payer.
   * DELIBERATELY OUTSIDE the LOCKED fingerprint array in cmdExplorerSeed.mapRow: adding it there
   * would change every existing row's dedup key, ON CONFLICT (row_fingerprint) would stop firing,
   * and the hourly cron would re-insert the whole 650k-row book. Same fence as charge_to_date.
   */
  employer_name: string | null;
}

/** Full row = non-PHI projection + its PHI. Held only in volatile server memory. */
export interface CmdExplorerFullRow extends CmdExplorerNonPhiRow {
  phi: CmdExplorerPhi;
}

/**
 * NON-PHI projection of one PERSISTED explorer row (collections.cmd_explorer_rows),
 * returned by the DB-backed reader. `id` is the bigserial PK — the keyset-pagination
 * cursor AND the per-row reveal key (it replaces the old SHA-256 `rowId`). The 3 PHI
 * columns are stored as ciphertext and are NEVER part of this shape; they surface only
 * via the audited reveal. Dates are ISO 'YYYY-MM-DD'; money is a fixed-2-decimal string
 * (pg numeric); `ingested_at` is ISO-8601 UTC. pct_allowed / pct_paid are the GENERATED
 * STORED payer-gap ratios (migration 0038) — pg numeric, so they arrive as a decimal string
 * (e.g. '92.34') or null when the denominator was 0/negative/null.
 */
export interface CmdExplorerRow {
  id: number;
  charge_date: string;
  payment_received: string | null;
  cpt_code: string;
  revenue_code: string | null;
  facility: string;
  charge_amount: string;
  allowed_amount: string | null;
  insurance_payments: string | null;
  adjustments: string | null;
  patient_balance_due: string | null;
  primary_payer: string | null;
  pct_allowed: string | null;
  pct_paid: string | null;
  ingested_at: string;
  /**
   * Plan sponsor / group employer (migration 0101) — the PLAN-LEVEL attribute, in the same class
   * as primary_payer. NOT the employee/subscriber name, and NOT VOB-derived: this is the
   * collections-native value that arrives on the CMD report itself, deliberately independent of
   * vob.member_benefits_latest.employer_norm (which serves Qualify's market filter and nothing
   * here). Ruled non-PHI for display + search 2026-08-14; still fenced out of summary_stats and
   * every model prompt by the PhiKey union.
   *
   * Sourced differently by query: the grid reads the 0059 rollup and LEFT JOINs the base table on
   * `id` for this one column (the rollup has no employer and deliberately never will — see
   * migration 0101's grain note), while CMD_EXPLORER_SELECT reads it straight off the base table.
   * Null for any row the one-shot backfill did not match and that predates the new CMD reports.
   */
  employer_name: string | null;
  /**
   * FACILITY ATTRIBUTION for a charge whose raw CMD `facility` cell is the 'No Facility'
   * placeholder — `collections.cmd_facility_resolution.facility_alias` (migration 0086), LEFT
   * JOINed on `id`. Non-null ONLY for placeholder charges that 0086 could attribute; null for every
   * normal charge (0086 covers placeholders only) AND for a placeholder it could not resolve.
   *
   * ⚠ THIS DOES NOT REPLACE `facility`, AND MUST NOT. `facility` stays the raw value CMD sent, so
   * the two are readable against each other; the UI shows this one as primary text with the raw one
   * reachable behind it. Anything that needs "what CMD actually said" — an export, a reconciliation
   * against the report, the audited reveal — reads `facility`, unchanged.
   */
  facility_resolved: string | null;
  /**
   * Which 0086 method produced `facility_resolved` — one of RESOLUTION_METHODS. Null exactly when
   * `facility_resolved` is null.
   *
   * ⚠ SHIPPED TOGETHER OR NOT AT ALL. An attributed facility rendered without its method is a
   * conclusion presented as a fact: `member_inference` and `tie_break` are things we DERIVED from
   * other rows about the same member, and they must never read like a value CMD supplied. Pass this
   * through `resolutionClassOf()` (facilityResolutionQuery.ts) for the exact/inferred split rather
   * than testing method strings at a call site.
   */
  facility_method: string | null;
}

/** Trim; empty string → null (so blanks render as an em dash, not ''). */
function norm(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Case-insensitive read across candidate header names. */
function pick(row: CmdReportRow, candidates: readonly string[]): string | null {
  for (const c of candidates) if (c in row) return norm(row[c]);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const c of candidates) {
    const v = lower[c.toLowerCase()];
    if (v !== undefined) return norm(v);
  }
  return null;
}

/** Map parsed CSV rows to the explorer shape (non-PHI + PHI + content rowId). */
/**
 * Split a CMD facility label into its display name and its trailing parenthesised id.
 *
 *   'CALIFORNIA MENTAL HEALTH LLC (10272858)' -> { name: 'CALIFORNIA MENTAL HEALTH LLC',
 *                                                  id: '10272858' }
 *   'CAMH'                                    -> { name: 'CAMH', id: null }
 *
 * WHY: the bank/deposit report projects 'Facility Name/ID' rather than a bare name, and the id is
 * what tells two same-named facilities apart — CMD returns 'CALIFORNIA MENTAL HEALTH LLC' under
 * BOTH 10272858 and 10272308. The UI must show the name only, so the id is stripped here at the
 * mapping boundary rather than in every renderer.
 *
 * ⚠ THAT ID IS NOT A CMD CUSTOMER ID. Verified 2026-08-03: neither 10272858 nor 10272308 exists in
 * collections.facilities, and both sit under a single customer, whereas roster customer ids are of
 * the 10027973 form. So it CANNOT be compared against the loop's customerId to validate that a
 * pull returned the right account — that check would reject every row. It is a CMD-internal
 * facility/location id: useful for disambiguating same-named facilities, and nothing more, until
 * someone establishes a mapping from it to facility_code.
 *
 * Only a trailing all-digit '(...)' group is treated as an id, so a facility whose NAME contains
 * parentheses keeps them.
 */
export function splitFacilityLabel(raw: string | null): { name: string | null; id: string | null } {
  // `string | null`, NOT `string | undefined` — pick() in this module returns null for an absent
  // column. An earlier cut guarded only on undefined, so a facility-less row hit null.trim(), threw
  // inside mapReportRows, and cmdExplorerCron counted the whole customer failed; five cron tests
  // went red with no mention of facilities in any of them. Absent stays null so mapRow can still
  // report 'facility: missing'.
  if (raw === null) return { name: null, id: null };
  const m = raw.trim().match(/^(.*?)\s*\((\d+)\)$/);
  if (m === null) return { name: raw, id: null };
  return { name: m[1]!.trim(), id: m[2]! };
}

export function mapReportRows(rows: CmdReportRow[]): CmdExplorerFullRow[] {
  return rows.map((row) => {
    const nonPhi = {
      charge_from_date: pick(row, HEADERS.charge_from_date),
      payment_received: pick(row, HEADERS.payment_received),
      cpt_code: pick(row, HEADERS.cpt_code),
      revenue_code: pick(row, HEADERS.revenue_code),
      facility: splitFacilityLabel(pick(row, HEADERS.facility)).name,
      charge_amount: pick(row, HEADERS.charge_amount),
      allowed_amount: pick(row, HEADERS.allowed_amount),
      insurance_payments: pick(row, HEADERS.insurance_payments),
      adjustments: pick(row, HEADERS.adjustments),
      patient_balance_due: pick(row, HEADERS.patient_balance_due),
      primary_payer: pick(row, HEADERS.primary_payer),
      charge_id: pick(row, HEADERS.charge_id),
      charge_entered_date: pick(row, HEADERS.charge_entered_date),
      charge_to_date: pick(row, HEADERS.charge_to_date),
      claim_status_raw: pick(row, HEADERS.claim_status_raw),
      employer_name: pick(row, HEADERS.employer_name),
    };
    const phi: CmdExplorerPhi = {
      patient_name: pick(row, HEADERS.patient_name),
      member_id_raw: pick(row, HEADERS.member_id_raw),
      group_number: pick(row, HEADERS.group_number),
    };
    const rowId = createHash('sha256').update(JSON.stringify([nonPhi, phi])).digest('hex');
    return { rowId, ...nonPhi, phi };
  });
}

/**
 * Indigo's CMD export (report 10092391) labels the facility column "Customer Name" (CMD: one
 * customer == one facility), where BXR's (10093959) uses "Facility Name". The shared mapReportRows
 * above + the LOCKED fingerprint (cmdExplorerSeed.mapRow) read facility ONLY from "Facility Name"
 * and mapRow treats it as REQUIRED — so an UNALIASED Indigo pull skips EVERY charge line
 * (charge_skipped == rows_fetched). This aliases "Customer Name" → "Facility Name" IN PLACE so both
 * the one-time seed adapter and the recurring Indigo cron feed the shared mapping an identical,
 * fingerprint-compatible facility value — WITHOUT editing mapReportRows or touching the BXR path.
 * No-op when "Facility Name" is already present (BXR, or a future API shape that already carries it).
 * Missing "Customer Name" → "" (row then skips on facility:missing rather than crashing).
 */
export function aliasIndigoFacilityColumn(rows: CmdReportRow[]): CmdReportRow[] {
  for (const row of rows) {
    if (!('Facility Name' in row)) row['Facility Name'] = row['Customer Name'] ?? '';
  }
  return rows;
}

/** Strip PHI for the cacheable / browser-bound projection. */
export function toNonPhi(rows: CmdExplorerFullRow[]): CmdExplorerNonPhiRow[] {
  return rows.map((r) => {
    const { phi, ...rest } = r;
    void phi; // intentionally omit PHI from the projection
    return rest;
  });
}

// ---------------------------------------------------------------------------
// Daily deposit aggregation — feeds the Master BXR chart (collections.daily_collections,
// source_tag='cmd'). Report 10093959 / filter 10148478 carries `Check Payment` + `EFT
// Payment` per charge line; we sum them by Payment-Received DATE for ONE facility (the
// customer being pulled). NON-PHI by construction: only the date + summed dollars leave
// here — never a patient cell. Pure + env-free, like the rest of this module.
// ---------------------------------------------------------------------------

/** Live-report headers for the two deposit columns (present under filter 10148478). */
const CHECK_KEYS = ['Check Payment'] as const;
const EFT_KEYS = ['EFT Payment'] as const;
const PAYMENT_DATE_KEYS = ['Payment Received'] as const;

/** One facility-day deposit total (non-PHI). Money are fixed-2-decimal strings (pg numeric). */
export interface CmdDailyDeposit {
  facility_code: string;
  /** ISO 'YYYY-MM-DD' (the Payment Received date). */
  payment_date: string;
  checks_amount: string;
  eft_amount: string;
  gross_amount: string;
}

/** Payment Received → ISO 'YYYY-MM-DD', or null when blank/unparseable (row is skipped). */
function paymentDateIso(raw: string | null): string | null {
  const t = (raw ?? '').trim();
  if (t === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const probe = new Date(`${t}T00:00:00Z`);
    return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === t ? t : null;
  }
  const d = normalizeDate(t); // M/D/YYYY with calendar validation
  return d.ok ? d.value : null;
}

/**
 * Sum Check + EFT payments by Payment-Received date for one facility. Rows with no/invalid
 * payment date are skipped (a deposit must land on a real banking day). Only buckets with a
 * non-zero check+eft total are emitted — a day with charge lines but no money collected adds
 * no deposit row (mirrors how the chart treated empty days, and keeps daily_collections lean).
 * Reversals (negative check/eft) are preserved. Output is sorted by date for stable inserts.
 */
export function aggregateDailyDeposits(rows: CmdReportRow[], facilityCode: string): CmdDailyDeposit[] {
  const byDate = new Map<string, { checks: number; eft: number }>();
  for (const row of rows) {
    const date = paymentDateIso(pick(row, PAYMENT_DATE_KEYS));
    if (date === null) continue;
    const checks = toAmount(pick(row, CHECK_KEYS) ?? undefined);
    const eft = toAmount(pick(row, EFT_KEYS) ?? undefined);
    const acc = byDate.get(date) ?? { checks: 0, eft: 0 };
    acc.checks += checks;
    acc.eft += eft;
    byDate.set(date, acc);
  }
  const out: CmdDailyDeposit[] = [];
  for (const [payment_date, { checks, eft }] of byDate) {
    if (checks === 0 && eft === 0) continue; // no deposit that day → no row
    out.push({
      facility_code: facilityCode,
      payment_date,
      checks_amount: checks.toFixed(2),
      eft_amount: eft.toFixed(2),
      gross_amount: (checks + eft).toFixed(2),
    });
  }
  out.sort((a, b) => (a.payment_date < b.payment_date ? -1 : a.payment_date > b.payment_date ? 1 : 0));
  return out;
}

/**
 * The number of days past `todayIso` a Payment Received date may sit and still be ingested.
 *
 * WHY A HORIZON AND NOT ZERO (changed 2026-08-02). The original guard dropped EVERY future-dated
 * row. That was written for the 12/30/2026 typo class, but it also silently discarded real money:
 * CMD carries forward-dated deposit/check dates a few business days out, and on 2026-08-02 the
 * live Indigo report held 08/03, 08/04 and 08/05 rows worth $105,171 / $23,058 / $30,598 across
 * just 3 sampled accounts. Those are genuine and the Overview page is meant to show them.
 *
 * 14 days separates the two populations cleanly: a forward-dated deposit lands within a business
 * week or two, while the typo class (a mis-keyed year or month) overshoots by months. Anything
 * past the horizon is still dropped, so max(payment_date) can move at most two weeks ahead
 * instead of into next year.
 *
 * ACTIVE AT 14 since 2026-08-03. It shipped at 0 (inert) one commit earlier, because Overview and
 * Collections read the SAME rows through collections.daily_collections_resolved and a horizon
 * alone would have put near-future money on the Collections tab. The read-time split now exists
 * — see futurePaymentBound in daily.ts — so Collections bounds at today while Overview does not,
 * and ingesting these rows is safe. Setting this back to 0 is the correct kill switch if
 * forward-dated deposits ever turn out to be unreliable; nothing else needs reverting.
 */
export const FUTURE_PAYMENT_HORIZON_DAYS = 14;

/** `isoDate` + `days`, as ISO 'YYYY-MM-DD'. UTC arithmetic so it cannot drift with server locale. */
function addDaysIso(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) return isoDate; // unparseable anchor ⇒ horizon collapses to the anchor
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Drop charge-line rows whose Payment Received date is IMPLAUSIBLY far in the future — more than
 * `horizonDays` past `todayIso` (both ISO 'YYYY-MM-DD'; ISO dates compare lexically ==
 * chronologically). Rows dated today, in the past, or inside the horizon are KEPT.
 *
 * READ-SIDE, NOT INGEST-SIDE, is where "should the Overview show tomorrow's deposit?" is now
 * decided. Ingest keeps near-future rows; the Collections surface filters to `<= today` when it
 * reads, and Overview does not. Doing it this way needs no schema change and keeps one row set
 * feeding both surfaces — see collections.daily_collections_resolved, which both read.
 *
 * Rows with a blank/unparseable payment date are KEPT: an unpaid charge line is still a valid
 * cmd_explorer_rows entry (payment_received is nullable), and aggregateDailyDeposits already
 * skips null-date rows — so keeping them is safe for BOTH downstream writes. Applied ONCE in the
 * cron before mapRow (explorer) AND aggregateDailyDeposits (daily), keeping the two consistent.
 */
export function dropFuturePaymentRows(
  rows: CmdReportRow[],
  todayIso: string,
  horizonDays: number = FUTURE_PAYMENT_HORIZON_DAYS,
): { kept: CmdReportRow[]; dropped: number } {
  // A negative horizon would silently widen the drop past "today"; clamp so the guard can only
  // ever be as strict as the original behaviour, never stricter.
  const cutoff = addDaysIso(todayIso, Math.max(0, horizonDays));
  const kept: CmdReportRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    const d = paymentDateIso(pick(row, PAYMENT_DATE_KEYS));
    if (d !== null && d > cutoff) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  return { kept, dropped };
}
