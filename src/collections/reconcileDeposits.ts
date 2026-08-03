/**
 * DEPOSIT RECONCILIATION — CMD's "what reflects in the bank" report vs collections.daily_collections.
 *
 * WHY THIS IS A CHECK AND NOT A FEED. Report 10050915 is not a second source to ingest; it is the
 * same CMD data presented as what actually landed in the bank. Its job is to VERIFY the deposits
 * the hourly explorer cron already wrote. So this module reads both sides and reports the delta —
 * it opens no writer, and there is no precedence question to resolve against daily_collections.
 *
 * IT USES THE CRON'S OWN AGGREGATION. The caller passes rows straight through
 * aggregateDailyDeposits, the exact function cmdExplorerCron uses to build the stored rows. A
 * reported delta therefore cannot be an artefact of this path doing different arithmetic; it is a
 * genuine disagreement between two CMD reports.
 *
 * PARTIAL RESULTS ARE SAFE HERE, unlike the payer rollup. Nothing is written, so a customer that
 * fails or is cut off by the budget guard costs coverage, not correctness. What is NOT safe is
 * letting that look clean: an unreached customer contributes $0.00 on the report side and would
 * otherwise render as a large fake shortfall. Every unreached customer is therefore counted,
 * named, and excluded from the mismatch list entirely — see `incomplete`.
 *
 * MATERIALITY. A live run on 2026-08-03 found 234 of 258 facility-days matching to the cent, ~16
 * differing by under $50 in both directions, and one real $20,074.77 overstatement. Alerting on
 * "any mismatch" would therefore be noise from day one, so callers get a materiality threshold and
 * the alert-worthy verdict is computed here rather than left to the route.
 *
 * PHI (CLAUDE.md): the report is per-charge-line and carries Patient Full Name, Payment Patient ID
 * and Claim ID. None is read or emitted. aggregateDailyDeposits collapses to
 * facility × date × check/eft/gross before anything is compared, and the returned stats carry only
 * facility codes, dates and money. Never add a row-level field to ReconcileStats.
 */
import { aggregateDailyDeposits } from './cmdExplorer.js';
import type { CmdReportRow } from './cmdPayer.js';

/** One CMD customer account to reconcile (== one facility). */
export interface ReconcileTarget {
  customerId: string;
  facilityCode: string;
}

/** One facility-day where the report and the stored dailies disagree. Non-PHI. */
export interface ReconcileMismatch {
  facility_code: string;
  /** ISO 'YYYY-MM-DD'. */
  payment_date: string;
  report_gross: number;
  stored_gross: number;
  /** report - stored. Negative means the dashboard shows MORE than the bank. */
  delta: number;
}

/** One facility-day of stored deposits, as read back from daily_collections. */
export interface StoredGrossRow {
  facility_code: string;
  payment_date: string;
  gross: number;
}

export interface ReconcileDeps {
  customers: ReadonlyArray<ReconcileTarget>;
  /** Pull the live bank-view report for ONE customer. */
  fetchRows: (customerId: string) => Promise<CmdReportRow[]>;
  /** Read stored gross per facility-day over [from, to] inclusive, for the reconciled tenant. */
  readStoredGross: (from: string, to: string) => Promise<StoredGrossRow[]>;
  /** Monotonic clock for the budget guard (injectable for tests). Default Date.now. */
  now?: () => number;
  /** Stop LAUNCHING new customers past this wall-clock budget. Default 210s. */
  budgetMs?: number;
  /** A facility-day differing by at least this many dollars is MATERIAL. Default $100. */
  materialUsd?: number;
  /** |total delta| at or above this is alert-worthy even with no single material day. Default $1000. */
  totalUsd?: number;
}

/** Non-PHI summary — safe to log and to return to the (authed) caller. */
export interface ReconcileStats {
  customers_total: number;
  customers_reconciled: number;
  customers_failed: number;
  customers_skipped_budget: number;
  /** PHI-safe labels for customers that could not be pulled (customer id + facility code only). */
  unreached: string[];
  /** True when any customer was missed — the totals below cover only what was reached. */
  incomplete: boolean;
  rows_fetched: number;
  /** Deposit window the report actually covered, or null when it returned nothing dated. */
  window_from: string | null;
  window_to: string | null;
  facility_days_matched: number;
  facility_days_mismatched: number;
  /** Mismatches at or above the materiality threshold, worst (largest |delta|) first. */
  material_mismatches: ReconcileMismatch[];
  report_total: number;
  stored_total: number;
  /** report_total - stored_total. Negative means the dashboard shows MORE than the bank. */
  delta_total: number;
  /** The headline: something needs a human. */
  alert: boolean;
}

const DEFAULT_BUDGET_MS = 210_000;
const DEFAULT_MATERIAL_USD = 100;
const DEFAULT_TOTAL_USD = 1_000;
/** Both sides are fixed-2 numerics, so anything above a cent is a real difference. */
const CENT = 0.01;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type ByFacilityDate = Map<string, Map<string, number>>;

function addGross(acc: ByFacilityDate, facility: string, date: string, gross: number): void {
  let byDate = acc.get(facility);
  if (byDate === undefined) {
    byDate = new Map();
    acc.set(facility, byDate);
  }
  byDate.set(date, (byDate.get(date) ?? 0) + gross);
}

/** Round to cents so float addition cannot manufacture a sub-cent "mismatch". */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export async function reconcileDeposits(deps: ReconcileDeps): Promise<ReconcileStats> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const materialUsd = deps.materialUsd ?? DEFAULT_MATERIAL_USD;
  const totalUsd = deps.totalUsd ?? DEFAULT_TOTAL_USD;
  const started = now();

  const live: ByFacilityDate = new Map();
  /** Only facilities actually pulled may be compared — see the `incomplete` note above. */
  const reached = new Set<string>();
  const unreached: string[] = [];
  let rowsFetched = 0;
  let failed = 0;
  let skippedBudget = 0;

  for (const target of deps.customers) {
    if (now() - started > budgetMs) {
      skippedBudget += 1;
      unreached.push(`${target.customerId} (${target.facilityCode}): budget`);
      continue;
    }
    let rows: CmdReportRow[];
    try {
      rows = await deps.fetchRows(target.customerId);
    } catch (err) {
      failed += 1;
      unreached.push(`${target.customerId} (${target.facilityCode}): fetch_failed`);
      // Message to the server log only — never to the caller, never PHI.
      console.error(
        `reconcile-deposits: customer ${target.customerId} (${target.facilityCode}) fetch failed: ${errMessage(err)}`,
      );
      continue;
    }
    reached.add(target.facilityCode);
    rowsFetched += rows.length;
    for (const d of aggregateDailyDeposits(rows, target.facilityCode)) {
      addGross(live, target.facilityCode, d.payment_date, Number(d.gross_amount));
    }
  }

  const dates = [...new Set([...live.values()].flatMap((m) => [...m.keys()]))].sort();
  const windowFrom = dates[0] ?? null;
  const windowTo = dates[dates.length - 1] ?? null;

  const stats: ReconcileStats = {
    customers_total: deps.customers.length,
    customers_reconciled: reached.size,
    customers_failed: failed,
    customers_skipped_budget: skippedBudget,
    unreached,
    incomplete: unreached.length > 0,
    rows_fetched: rowsFetched,
    window_from: windowFrom,
    window_to: windowTo,
    facility_days_matched: 0,
    facility_days_mismatched: 0,
    material_mismatches: [],
    report_total: 0,
    stored_total: 0,
    delta_total: 0,
    alert: false,
  };

  // Nothing dated came back. With no window there is nothing to read back or compare — and an
  // empty report is normal early in a month, so it is not by itself an alert. It IS an alert if
  // customers were unreached, because then "empty" may only mean "we never asked".
  if (windowFrom === null || windowTo === null) {
    stats.alert = stats.incomplete;
    return stats;
  }

  const storedRows = await deps.readStoredGross(windowFrom, windowTo);
  const stored: ByFacilityDate = new Map();
  for (const r of storedRows) {
    // Facilities we could not pull are excluded outright: comparing them would report their whole
    // stored total as a shortfall that does not exist.
    if (!reached.has(r.facility_code)) continue;
    addGross(stored, r.facility_code, r.payment_date, r.gross);
  }

  const mismatches: ReconcileMismatch[] = [];
  for (const facility of new Set([...live.keys(), ...stored.keys()])) {
    const l = live.get(facility) ?? new Map<string, number>();
    const s = stored.get(facility) ?? new Map<string, number>();
    for (const date of new Set([...l.keys(), ...s.keys()])) {
      const reportGross = round2(l.get(date) ?? 0);
      const storedGross = round2(s.get(date) ?? 0);
      stats.report_total = round2(stats.report_total + reportGross);
      stats.stored_total = round2(stats.stored_total + storedGross);
      const delta = round2(reportGross - storedGross);
      if (Math.abs(delta) < CENT) {
        stats.facility_days_matched += 1;
        continue;
      }
      stats.facility_days_mismatched += 1;
      mismatches.push({
        facility_code: facility,
        payment_date: date,
        report_gross: reportGross,
        stored_gross: storedGross,
        delta,
      });
    }
  }

  stats.delta_total = round2(stats.report_total - stats.stored_total);
  stats.material_mismatches = mismatches
    .filter((m) => Math.abs(m.delta) >= materialUsd)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  stats.alert =
    stats.material_mismatches.length > 0 || Math.abs(stats.delta_total) >= totalUsd || stats.incomplete;

  return stats;
}

/** One-line, non-PHI summary for the cron log. */
export function formatReconcileLog(stats: ReconcileStats): string {
  const money = (n: number) => n.toFixed(2);
  return (
    `reconcile-deposits: customers ${stats.customers_reconciled}/${stats.customers_total} ` +
    `(failed ${stats.customers_failed}, budget-skipped ${stats.customers_skipped_budget}` +
    `${stats.incomplete ? ', INCOMPLETE' : ''}); ` +
    `window ${stats.window_from ?? '-'}..${stats.window_to ?? '-'}, fetched ${stats.rows_fetched}; ` +
    `facility-days matched ${stats.facility_days_matched}, mismatched ${stats.facility_days_mismatched} ` +
    `(material ${stats.material_mismatches.length}); ` +
    `report ${money(stats.report_total)}, stored ${money(stats.stored_total)}, ` +
    `delta ${money(stats.delta_total)}`
  );
}
