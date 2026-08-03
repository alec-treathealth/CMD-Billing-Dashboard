/**
 * RECONCILE the CMD "what landed in the bank" report against collections.daily_collections.
 * READ-ONLY. WRITES NOTHING. Opens only the claims_reader pool.
 *
 * WHY: report 10050915 is not a second source of truth to ingest — it is the same CMD data
 * presented as what actually reflects in the bank, so its job is to VERIFY that the deposits the
 * hourly explorer cron wrote are right. This script is that verification: it pulls the report,
 * aggregates it through the EXACT function the cron uses (aggregateDailyDeposits), and diffs the
 * result against what is already stored. A non-empty delta means the dashboard and the bank
 * disagree for that facility-day.
 *
 * Filters (saved under report 10050915, both BXR):
 *   10148489 — "this month"   (default)
 *   10148490 — "last month"
 *
 * PHI DISCIPLINE (CLAUDE.md): the report is per-charge-line and PHI-bearing — the live export
 * carries Patient Full Name, Payment Patient ID and Claim ID. Nothing patient-level is read,
 * printed, or stored here: aggregateDailyDeposits collapses to facility x date x check/eft/gross
 * IN-PROCESS, and only those aggregates are printed. Do not add row-level output.
 *
 * RUN (repo root):
 *   node --env-file=.env --import tsx scripts/reconcile-cmd-deposits.ts [filterId] [customerId...]
 *
 * CMD allows ONE running report at a time per partner, and the hourly crons hold that slot at
 * :00/:15/:30/:35. Run this between those minutes — probing across a :15 census on 2026-08-02
 * cost 13 BXR census fetches.
 */
import { cmdReportRows, type CmdApiConfig, type CmdReportRow } from '../src/collections/cmdPayer.js';
import { aggregateDailyDeposits, splitFacilityLabel } from '../src/collections/cmdExplorer.js';
import { BXR_CUSTOMERS } from '../src/collections/cmdCustomers.js';
import { makeClient } from '../src/collections/db.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';

const REPORT_ID = process.env.RECONCILE_REPORT_ID?.trim() || '10050915';
const DEFAULT_FILTER = '10148489'; // "this month"

function auth(): CmdApiConfig['auth'] {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  if (token) return { kind: 'token', token };
  if (username && password) return { kind: 'basic', username, password };
  throw new Error('CMD API credentials not configured (CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD)');
}

function cfgFor(customerId: string, filterId: string): CmdApiConfig {
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId,
    reportId: REPORT_ID,
    filterId,
    auth: auth(),
    // A clean single-customer pull is 11-42s. Four probes on 2026-08-02/03 appeared to take >14
    // minutes, but that was contention from concurrent manual runs queued against CMD's
    // one-report-at-a-time partner slot — not this report. The generous budget below is kept
    // anyway because a script can afford to wait; the scheduled sibling
    // (/api/cron/reconcile-deposits) uses a tighter one to fit inside maxDuration.
    pollIntervalMs: Number(process.env.RECONCILE_POLL_INTERVAL_MS) || 10_000,
    maxPollAttempts: Number(process.env.RECONCILE_POLL_ATTEMPTS) || 90,
    emptyGraceAttempts: 4,
  };
}

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** facility_code -> payment_date -> gross. */
type ByFacilityDate = Map<string, Map<string, number>>;

function addGross(acc: ByFacilityDate, facility: string, date: string, gross: number): void {
  let byDate = acc.get(facility);
  if (byDate === undefined) {
    byDate = new Map();
    acc.set(facility, byDate);
  }
  byDate.set(date, (byDate.get(date) ?? 0) + gross);
}

async function main(): Promise<void> {
  const [filterArg, ...customerArgs] = process.argv.slice(2);
  const filterId = filterArg?.trim() || DEFAULT_FILTER;
  const roster =
    customerArgs.length > 0
      ? BXR_CUSTOMERS.filter((c) => customerArgs.includes(c.customerId))
      : BXR_CUSTOMERS;
  if (roster.length === 0) throw new Error('no matching BXR customers for the ids given');

  const readerUrl = process.env.CLAIMS_READER_DATABASE_URL;
  if (!readerUrl) throw new Error('CLAIMS_READER_DATABASE_URL not set');

  console.log('=== RECONCILE CMD deposits vs collections.daily_collections — READ ONLY ===');
  console.log(`report=${REPORT_ID} filter=${filterId} customers=${roster.length}`);
  console.log('');

  const live: ByFacilityDate = new Map();
  /** Facilities this run actually pulled — the only ones eligible for comparison. */
  const reachedFacilities = new Set<string>();
  const facilityLabels = new Map<string, string>();
  let rowsFetched = 0;
  const failures: string[] = [];

  for (const c of roster) {
    const t0 = Date.now();
    let rows: CmdReportRow[];
    try {
      rows = await cmdReportRows(cfgFor(c.customerId, filterId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${c.customerId} (${c.facilityCode}): ${msg}`);
      console.log(`  ${c.facilityCode.padEnd(14)} ERROR — ${msg}`);
      continue;
    }
    rowsFetched += rows.length;
    reachedFacilities.add(c.facilityCode);
    // Record the report's own facility label (name only — the id is stripped) for the header.
    for (const r of rows) {
      const label = splitFacilityLabel(r['Facility Name/ID'] ?? r['Facility Name'] ?? null).name;
      if (label !== null && label !== undefined && label !== '') {
        facilityLabels.set(c.facilityCode, label);
        break;
      }
    }
    // EXACTLY the cron's aggregation, so a delta cannot be an artefact of different math.
    for (const d of aggregateDailyDeposits(rows, c.facilityCode)) {
      addGross(live, c.facilityCode, d.payment_date, Number(d.gross_amount));
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${c.facilityCode.padEnd(14)} ${String(rows.length).padStart(6)} rows  ${secs}s`);
  }

  console.log('');
  console.log(`fetched ${rowsFetched} rows across ${roster.length - failures.length}/${roster.length} customers`);

  const dates = [...new Set([...live.values()].flatMap((m) => [...m.keys()]))].sort();
  if (dates.length === 0) {
    console.log('The report returned no dated deposits — nothing to reconcile.');
    return;
  }
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  console.log(`report deposit window: ${from} .. ${to}`);

  const db = makeClient(readerUrl);
  try {
    const res = await db.query<{ facility_code: string; payment_date: string; gross: string }>(
      'select facility_code, to_char(payment_date, \'YYYY-MM-DD\') as payment_date, ' +
        'sum(gross_amount)::text as gross ' +
        'from collections.daily_collections ' +
        'where business_entity_id = $1 and source_tag = $2 ' +
        'and payment_date >= $3::date and payment_date <= $4::date ' +
        'group by facility_code, payment_date',
      [BXR_ENTITY_ID, 'cmd', from, to],
    );
    // ONLY facilities actually pulled may be compared. A facility that failed, or that simply was
    // not in this run's roster, contributes $0.00 on the report side — so including it would
    // report its entire stored total as a shortfall that does not exist. Running this script for a
    // single customer made every OTHER facility look like a total loss until this filter existed.
    const stored: ByFacilityDate = new Map();
    let excludedFacilities = 0;
    for (const r of res.rows) {
      if (!reachedFacilities.has(r.facility_code)) {
        excludedFacilities += 1;
        continue;
      }
      addGross(stored, r.facility_code, r.payment_date, Number(r.gross));
    }
    if (excludedFacilities > 0) {
      console.log(
        `(excluded ${excludedFacilities} stored facility-day rows for facilities this run did not pull)`,
      );
    }

    const facilities = [...new Set([...live.keys(), ...stored.keys()])].sort();
    console.log('');
    console.log('--- per facility-day, REPORT vs STORED (only non-matching rows listed) ---');
    console.log('facility        date          report          stored           delta');

    let matched = 0;
    let mismatched = 0;
    let liveTotal = 0;
    let storedTotal = 0;
    for (const f of facilities) {
      const l = live.get(f) ?? new Map<string, number>();
      const s = stored.get(f) ?? new Map<string, number>();
      for (const d of [...new Set([...l.keys(), ...s.keys()])].sort()) {
        const lv = l.get(d) ?? 0;
        const sv = s.get(d) ?? 0;
        liveTotal += lv;
        storedTotal += sv;
        // Cent-level tolerance: both sides are fixed-2 numerics, so anything above a cent is real.
        if (Math.abs(lv - sv) < 0.01) {
          matched += 1;
          continue;
        }
        mismatched += 1;
        console.log(
          `${f.padEnd(15)} ${d}  ${usd(lv).padStart(14)}  ${usd(sv).padStart(14)}  ${usd(lv - sv).padStart(14)}`,
        );
      }
    }

    console.log('');
    console.log(`facility-days matched: ${matched}   MISMATCHED: ${mismatched}`);
    console.log(`report total ${usd(liveTotal)}   stored total ${usd(storedTotal)}   delta ${usd(liveTotal - storedTotal)}`);
    if (failures.length > 0) {
      console.log('');
      console.log(`⚠ ${failures.length} customer(s) failed to pull — the totals above are INCOMPLETE:`);
      for (const f of failures) console.log(`   ${f}`);
    }
    console.log('');
    console.log(
      mismatched === 0 && failures.length === 0
        ? 'RECONCILES — every facility-day in the report matches what the dashboard stores.'
        : 'DOES NOT RECONCILE — investigate the rows above before trusting the Overview figures.',
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[reconcile-cmd-deposits] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
