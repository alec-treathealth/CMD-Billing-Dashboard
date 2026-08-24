/**
 * PROBE a CMD report/filter pairing across a roster, and report AGGREGATES.
 *
 *   CMD_REPORT_ID=10094775 CMD_FILTER_ID=10148862 PROBE_ROSTER=bxr \
 *     npx tsx scripts/probe-cmd-filter.ts
 *
 * WHY THIS EXISTS (and why cmdProbe.ts was not enough): `npm run probe:cmd` prints STRUCTURE only —
 * headers, zip entries and row counts for ONE customer. That answers "is the pairing alive"; it
 * cannot answer "does this filter return the same DATA as the one it replaces", which needs money
 * totals and a date span across the whole roster. Each CMD customer IS a facility, so a per-customer
 * breakdown is a per-facility breakdown, which is the shape the app and the Master BXR spreadsheet
 * are both compared in.
 *
 * PHI SAFETY: prints column NAMES, row COUNTS, DATE bounds and SUMS only. It never prints a field
 * value, so no name, member id or group number is emitted. Rows are held in memory to aggregate and
 * are discarded. Credentials come from env and are never printed.
 *
 * ⚠ CMD RUNS ONE REPORT AT A TIME PER PARTNER. Run this INSIDE the :41-:59 window that is reserved
 * for live probe work, never near :00/:15/:22/:30/:35/:45/:55 — a probe during a scheduled pull
 * costs that cron its fetches (it cost 13 BXR census fetches on 2026-08-02).
 *
 * Env: CMD_API_USERNAME + CMD_API_PASSWORD (or CMD_API_TOKEN); CMD_REPORT_ID; CMD_FILTER_ID.
 * Optional: PROBE_ROSTER=bxr|indigo (default bxr), PROBE_LIMIT=<n customers>, CMD_API_BASE_URL.
 */
import { readFileSync } from 'node:fs';
import { cmdReportRows, type CmdApiConfig, type CmdReportRow } from '../src/collections/cmdPayer.js';
import { BXR_CUSTOMERS, INDIGO_CUSTOMERS, type CmdCustomer } from '../src/collections/cmdCustomers.js';

function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function authFromEnv(): CmdApiConfig['auth'] {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  if (token) return { kind: 'token', token };
  if (username && password) return { kind: 'basic', username, password };
  throw new Error('CMD credentials not set (CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD).');
}

/** Money columns worth totalling, by the label the CMD report uses. Missing ones are skipped. */
const MONEY_COLUMNS = [
  'Charge Amount',
  'Payment Allowed Amount',
  'Insurance Paid Amount',
  'Insurance Adjustment Amount',
  'Charge Balance Due Pat',
  'EFT Payment',
  'Check Payment',
] as const;

/** Date columns worth bounding. */
const DATE_COLUMNS = ['Payment Received', 'Charge From Date', 'Payment Entered'] as const;

/**
 * CMD emits dates as `MM/DD/YYYY`, which does NOT sort chronologically as a string.
 *
 * ⚠ THIS COST A WRONG CONCLUSION ON 2026-08-18. The first version of this script compared the raw
 * strings, so it reported CAMH's Payment Received span as `01/01/2024..12/31/2025` and I read that
 * as "this filter returns 2024-2025 and no 2026 at all" — an alarming claim about production that
 * was pure artefact: lexicographic order sorts by MONTH first, so the "min" is whatever row falls on
 * Jan 1 of any year and the "max" is whatever falls on Dec 31 of any year. The tell was LAMH
 * reporting `Charge From Date 01/01/2026..12/31/2025`, a span that runs backwards.
 *
 * Normalise to ISO before comparing, and report a YEAR HISTOGRAM as well — a span cannot show a gap
 * in the middle, which is the shape that actually matters when asking whether a filter covers a
 * period. Returns null for anything not MM/DD/YYYY so a stray value is ignored rather than skewing
 * the bounds.
 */
function isoDate(raw: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  return m === null ? null : `${m[3]}-${m[1]}-${m[2]}`;
}

function amount(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const cleaned = raw.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

interface Agg {
  rows: number;
  money: Map<string, number>;
  dateMin: Map<string, string>;
  dateMax: Map<string, string>;
  /** Payment Received rows per `YYYY-MM`. A span cannot show a hole; this can. */
  byMonth: Map<string, number>;
}

function aggregate(rows: readonly CmdReportRow[]): Agg {
  const agg: Agg = {
    rows: rows.length,
    money: new Map(),
    dateMin: new Map(),
    dateMax: new Map(),
    byMonth: new Map(),
  };
  for (const row of rows) {
    for (const col of MONEY_COLUMNS) {
      if (!(col in row)) continue;
      agg.money.set(col, (agg.money.get(col) ?? 0) + amount(row[col]));
    }
    for (const col of DATE_COLUMNS) {
      const raw = row[col]?.trim();
      if (!raw) continue;
      const v = isoDate(raw);
      if (v === null) continue;
      const lo = agg.dateMin.get(col);
      const hi = agg.dateMax.get(col);
      if (lo === undefined || v < lo) agg.dateMin.set(col, v);
      if (hi === undefined || v > hi) agg.dateMax.set(col, v);
      if (col === 'Payment Received') {
        const ym = v.slice(0, 7);
        agg.byMonth.set(ym, (agg.byMonth.get(ym) ?? 0) + 1);
      }
    }
  }
  return agg;
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const reportId = process.env.CMD_REPORT_ID?.trim();
  const filterId = process.env.CMD_FILTER_ID?.trim();
  if (!reportId || !filterId) throw new Error('Set CMD_REPORT_ID and CMD_FILTER_ID.');

  const rosterName = (process.env.PROBE_ROSTER?.trim() || 'bxr').toLowerCase();
  let roster: readonly CmdCustomer[] = rosterName === 'indigo' ? INDIGO_CUSTOMERS : BXR_CUSTOMERS;
  const only = process.env.PROBE_FACILITIES?.trim();
  if (only) {
    const wanted = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
    roster = roster.filter((c) => wanted.has(c.facilityCode));
  }
  const limit = Number(process.env.PROBE_LIMIT ?? '0');
  if (Number.isFinite(limit) && limit > 0) roster = roster.slice(0, limit);

  const auth = authFromEnv();
  const baseUrl = process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com';

  console.log(`probe report ${reportId} / filter ${filterId} over ${roster.length} ${rosterName} customers`);
  console.log('(structure + aggregates only — no field values are printed)\n');

  let headersPrinted = false;
  const totals = new Map<string, number>();
  let totalRows = 0;
  let failed = 0;
  const empty: string[] = [];

  for (const target of roster) {
    const cfg: CmdApiConfig = {
      baseUrl,
      customerId: target.customerId,
      reportId,
      filterId,
      auth,
    };
    try {
      const rows = await cmdReportRows(cfg);
      const agg = aggregate(rows);
      totalRows += agg.rows;
      if (agg.rows === 0) {
        empty.push(target.facilityCode);
        console.log(`  ${target.facilityCode.padEnd(16)} ${String(agg.rows).padStart(7)} rows`);
        continue;
      }
      if (!headersPrinted) {
        const cols = Object.keys(rows[0]!);
        console.log(`COLUMNS (${cols.length}): ${cols.join(' | ')}\n`);
        headersPrinted = true;
      }
      const span = DATE_COLUMNS.map((c) =>
        agg.dateMin.has(c) ? `${c} ${agg.dateMin.get(c)}..${agg.dateMax.get(c)}` : null,
      )
        .filter((x): x is string => x !== null)
        .join('  ');
      const charge = agg.money.get('Charge Amount') ?? 0;
      const paid = agg.money.get('Insurance Paid Amount') ?? 0;
      console.log(
        `  ${target.facilityCode.padEnd(16)} ${String(agg.rows).padStart(7)} rows  ` +
          `charge ${money(charge).padStart(14)}  ins-paid ${money(paid).padStart(14)}   ${span}`,
      );
      const months = [...agg.byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
      console.log(`      payment-received months: ${months.map(([m, n]) => `${m}:${n}`).join(' ')}`);
      for (const [k, v] of agg.money) totals.set(k, (totals.get(k) ?? 0) + v);
    } catch (err) {
      failed += 1;
      console.log(`  ${target.facilityCode.padEnd(16)}   FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nTOTAL rows ${totalRows.toLocaleString()}   customers ${roster.length - failed}/${roster.length}`);
  if (empty.length > 0) console.log(`EMPTY customers (${empty.length}): ${empty.join(', ')}`);
  for (const col of MONEY_COLUMNS) {
    if (totals.has(col)) console.log(`  ${col.padEnd(30)} ${money(totals.get(col)!).padStart(16)}`);
  }
}

main().catch((err) => {
  console.error('probe failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
