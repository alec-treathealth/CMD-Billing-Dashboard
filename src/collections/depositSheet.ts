/**
 * Parser for the consolidated 2026 deposit Sheet (the re-sourced "By Location"
 * daily series). The Sheet has monthly IP/OP tabs; each tab tiles facility blocks
 * (date | Checks | EFT | Gross) labelled with the canonical acronyms, in one or
 * more vertically-stacked bands. Verified invariant: gross = checks + EFT.
 *
 * This is non-PHI (Shape A): facility/date/checks/eft/gross only — no patient data.
 * It reuses the §6 normalization primitives (normalizeDate / normalizeMoney 'daily')
 * and the failed-coercion report sink; it NEVER silently drops a row. Every emitted
 * row carries a REAL facility_code (resolved from DEPOSIT_LABEL_TO_FACILITY — never
 * auto-created), source_group_code = NULL (§7 lineage lock untouched), and
 * source_tag = 'deposit_sheet'. Unresolved block labels are counted and reported,
 * not invented as facilities.
 *
 * Pure logic apart from writing coercion failures to the (gitignored) report — so
 * it is unit-testable with a fake sink and synthetic tabs (no Google, no DB).
 */
import { DEPOSIT_LABEL_TO_FACILITY } from './config.js';
import { normalizeDate, normalizeMoney } from './normalize.js';
import type { FailSink } from './report.js';
import type { Tab } from './shapes.js';
import type { DailyRow, RawRecord } from './types.js';

const lc = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
const rowBlank = (r: string[]): boolean => r.every((c) => (c ?? '').trim() === '');
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

/** A daily row plus its raw lineage key (source_tab + 1-based source row number). */
export interface DepositDailyItem {
  source_tab: string;
  source_row_num: number;
  row: DailyRow;
}

export interface DepositParseResult {
  raws: RawRecord[];
  daily: DepositDailyItem[];
  /** Distinct facility_codes resolved (for the dry-run report). */
  facilities: Set<string>;
  /** 'YYYY-MM' months observed, for the dry-run report. */
  months: Set<string>;
  /** Block labels that did not resolve to a real facility_code (label -> count). */
  unresolved: Map<string, number>;
  /** Date rows where gross != checks + eft (soft check; reported, not dropped). */
  grossMismatches: number;
}

function emptyResult(): DepositParseResult {
  return { raws: [], daily: [], facilities: new Set(), months: new Set(), unresolved: new Map(), grossMismatches: 0 };
}

/** Sub-header rows: a row containing both 'checks' and 'gross' (one per band). */
function bandHeaderRows(rows: string[][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const set = new Set((rows[i] ?? []).map(lc));
    if (set.has('checks') && set.has('gross')) out.push(i);
  }
  return out;
}

/**
 * Parse one deposit-Sheet tab. Tabs without a Checks/Gross sub-header (e.g. a notes
 * tab) yield nothing. Each band's data runs from its sub-header to the row before
 * the next band's label row (matches the legacy daily parser's bounding), so band 1
 * never swallows band 2's date rows (the bands reuse the same columns).
 */
export function parseDepositTab(tab: Tab, fileId: string, report: FailSink): DepositParseResult {
  const out = emptyResult();
  const rows = tab.rows;
  const headers = bandHeaderRows(rows);
  if (headers.length === 0) return out;

  for (let bi = 0; bi < headers.length; bi++) {
    const h = headers[bi]!;
    const sub = rows[h];
    const labelRow = rows[h - 1];
    if (!sub || !labelRow) continue;
    const endExclusive = bi + 1 < headers.length ? headers[bi + 1]! - 1 : rows.length;

    // Each "Checks" column marks a 4-col block: date|checks|eft|gross at (c-1..c+2).
    const blocks = sub
      .map((cell, c) => (lc(cell) === 'checks' ? c : -1))
      .filter((c) => c > 0)
      .map((c) => {
        const label = (labelRow[c - 1] ?? '').trim();
        return { date: c - 1, checks: c, eft: c + 1, gross: c + 2, label };
      });

    for (let i = h + 1; i < endExclusive; i++) {
      const row = rows[i];
      if (!row || rowBlank(row)) continue;
      const rowNum = i + 1;
      let landedRaw = false;

      for (const b of blocks) {
        const dateCell = (row[b.date] ?? '').trim();
        if (dateCell === '') continue; // empty block on this row
        // A non-date in the date column is a footer/TOTALS/MTD/YTD label — skip it
        // (not a coercion failure; the date column never holds malformed dates).
        if (!DATE_RE.test(dateCell)) continue;

        // Resolve the block label to a real facility_code. An unrecognized label is
        // counted + skipped (NEVER auto-created); a known label with a bad date/money
        // is a coercion failure (reported), never silently dropped.
        const facility = DEPOSIT_LABEL_TO_FACILITY[b.label];
        if (facility === undefined) {
          out.unresolved.set(b.label || '(blank)', (out.unresolved.get(b.label || '(blank)') ?? 0) + 1);
          continue;
        }

        const date = normalizeDate(dateCell);
        if (!date.ok || date.value === null) {
          report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', column: 'payment_date', raw_value: dateCell, reason: date.ok ? 'blank date' : date.reason });
          continue;
        }
        const checks = normalizeMoney(row[b.checks] ?? '', 'daily');
        const eft = normalizeMoney(row[b.eft] ?? '', 'daily');
        const gross = normalizeMoney(row[b.gross] ?? '', 'daily');
        const bad = [['checks_amount', checks, row[b.checks]], ['eft_amount', eft, row[b.eft]], ['gross_amount', gross, row[b.gross]]] as const;
        const moneyFail = bad.find(([, r]) => !r.ok);
        if (moneyFail) {
          const [col, r, rawv] = moneyFail;
          report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', column: col, raw_value: rawv ?? '', reason: (r as { reason: string }).reason });
          continue;
        }
        const cv = (checks as { value: string }).value;
        const ev = (eft as { value: string }).value;
        const gv = (gross as { value: string }).value;
        // Soft integrity check (the Sheet's documented invariant). Reported as a
        // coercion note, never gates acceptance — the Sheet's gross is authoritative.
        if (Math.abs(Number(cv) + Number(ev) - Number(gv)) > 0.005) {
          out.grossMismatches += 1;
          report.fail({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', column: 'gross_amount', raw_value: `${row[b.checks]}|${row[b.eft]}|${row[b.gross]}`, reason: 'gross != checks + eft (kept; gross authoritative)' });
        }

        out.daily.push({
          source_tab: tab.title,
          source_row_num: rowNum,
          row: { facility_code: facility, source_group_code: null, payment_date: date.value, checks_amount: cv, eft_amount: ev, gross_amount: gv, source_tag: 'deposit_sheet' },
        });
        out.facilities.add(facility);
        out.months.add(date.value.slice(0, 7));
        landedRaw = true;
      }

      if (landedRaw) {
        out.raws.push({ source_file_id: fileId, source_tab: tab.title, source_row_num: rowNum, shape: 'daily', source_group_code: null, facility_code: null, raw: { cells: row } });
      }
    }
  }
  return out;
}

/** Parse every tab of the deposit Sheet, merging the per-tab results. */
export function parseDepositSheet(tabs: Tab[], fileId: string, report: FailSink): DepositParseResult {
  const all = emptyResult();
  for (const tab of tabs) {
    const r = parseDepositTab(tab, fileId, report);
    all.raws.push(...r.raws);
    all.daily.push(...r.daily);
    r.facilities.forEach((f) => all.facilities.add(f));
    r.months.forEach((m) => all.months.add(m));
    r.unresolved.forEach((n, k) => all.unresolved.set(k, (all.unresolved.get(k) ?? 0) + n));
    all.grossMismatches += r.grossMismatches;
  }
  return all;
}
