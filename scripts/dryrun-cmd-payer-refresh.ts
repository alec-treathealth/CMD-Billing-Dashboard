/**
 * DRY RUN for /api/cron/refresh-cmd-payer — read-only. WRITES NOTHING.
 *
 * WHY: collections.cmd_payer_facility_monthly (backs the Master BXR Chart "By Payer")
 * was last ingested 2026-06-25 and has NO July rows. The refresh route exists but was
 * never added to app/vercel.json (commit c7732cb, "dormant"). Before scheduling it,
 * two things must be proven, because refreshCmdPayerRollup -> writeRollup is a
 * DELETE-then-INSERT per month and the window walks backward from now():
 *
 *   1. The report/filter pair still works. cmdApiConfig() defaults to report 10091828 /
 *      filter 10147241, unexercised since 2026-06-25. Several CMD pairings have gone
 *      INVALID CRITERIA (see CLAUDE.md "Known stale comments"). A dead pair means the
 *      cron would DELETE June and write nothing.
 *   2. The saved FILTER's date window actually covers July and August. Per
 *      CmdApiConfig: "The filter defines the report's date window." If that window ends
 *      in June, enabling the cron destroys good data to write zero rows.
 *
 * This script performs steps 1-3 of the production path (fetch -> aggregate -> filter to
 * window) and then STOPS, diffing the in-process aggregate against what is already in
 * the DB. It never imports writeRollup.
 *
 * PHI DISCIPLINE (CLAUDE.md): the live report rows are per-charge-line and PHI-bearing.
 * They are aggregated to PAYER x FACILITY x MONTH IN-PROCESS by aggregateRollup and only
 * month-level, non-PHI aggregates are ever printed. No row, no patient field, and no
 * per-patient amount is logged. Do not add row-level output to this script.
 *
 * DB access is READ-ONLY via CLAIMS_READER_DATABASE_URL. It never opens the writer pool.
 *
 * RUN (from the repo root, with .env loaded):
 *   node --env-file=.env --import tsx scripts/dryrun-cmd-payer-refresh.ts
 *
 * Optional: pass a month to highlight (defaults to the previous calendar month):
 *   node --env-file=.env --import tsx scripts/dryrun-cmd-payer-refresh.ts 2026-07
 */
import {
  cmdReportRows,
  collectRowsAcrossCustomers,
  type CmdApiConfig,
  type CmdReportRow,
} from '../src/collections/cmdPayer.js';
import { BXR_CUSTOMERS } from '../src/collections/cmdCustomers.js';
import { aggregateRollup, type RollupTuple } from '../src/collections/cmdPayerIngest.js';
import { windowMonths, DEFAULT_WINDOW_SIZE } from '../src/collections/cmdPayerRefresh.js';
import { makeClient } from '../src/collections/db.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';

/**
 * Mirrors the private cmdApiConfig() in app/lib/server.ts (~L1585). Duplicated rather
 * than imported because importing app/lib/server.ts from a root script drags in the
 * Next.js server runtime. If the defaults there change, change them here too.
 */
function cmdApiConfig(): CmdApiConfig {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdApiConfig['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else {
    throw new Error(
      'CMD API credentials not configured (set CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD)',
    );
  }
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId: process.env.CMD_CUSTOMER_ID?.trim() || '10027973',
    reportId: process.env.CMD_REPORT_ID?.trim() || '10093971',
    filterId: process.env.CMD_FILTER_ID?.trim() || '10148488',
    auth,
    pollIntervalMs: Number(process.env.CMD_POLL_INTERVAL_MS) || 4_000,
  };
}

interface MonthAgg {
  key: string;
  rows: number;
  charge: number;
  allowed: number;
  paid: number;
  payers: Set<string>;
  facilities: Set<string>;
}

const monthKey = (y: number, m: number): string => `${y}-${String(m).padStart(2, '0')}`;

function aggregateByMonth(tuples: RollupTuple[]): Map<string, MonthAgg> {
  const out = new Map<string, MonthAgg>();
  for (const t of tuples) {
    const key = monthKey(t.service_year, t.service_month);
    let a = out.get(key);
    if (!a) {
      a = { key, rows: 0, charge: 0, allowed: 0, paid: 0, payers: new Set(), facilities: new Set() };
      out.set(key, a);
    }
    a.rows += 1;
    a.charge += Number(t.total_charge ?? 0);
    a.allowed += Number(t.total_allowed ?? 0);
    a.paid += Number(t.total_paid ?? 0);
    a.payers.add(t.payer_name);
    a.facilities.add(t.facility_name);
  }
  return out;
}

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const pct = (live: number, db: number): string => {
  if (db === 0) return live === 0 ? '  =' : ' NEW';
  const d = ((live - db) / db) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
};

async function main(): Promise<void> {
  const highlight = process.argv[2]?.trim() || (() => {
    const n = new Date();
    const y = n.getUTCFullYear();
    const m = n.getUTCMonth(); // 0-11 => previous month in 1-12 terms
    return m === 0 ? monthKey(y - 1, 12) : monthKey(y, m);
  })();

  const readerUrl = process.env.CLAIMS_READER_DATABASE_URL;
  if (!readerUrl) throw new Error('CLAIMS_READER_DATABASE_URL not set');

  const cfg = cmdApiConfig();
  console.log('=== DRY RUN: cmd-payer rollup refresh — READ ONLY, WRITES NOTHING ===');
  console.log(
    `report=${cfg.reportId} filter=${cfg.filterId} customer=${cfg.customerId} ` +
      `auth=${cfg.auth.kind} base=${cfg.baseUrl}`,
  );
  console.log(`highlight month: ${highlight}`);
  console.log('');

  // ---- STEP 1: does the report/filter pair still resolve at all? -------------------
  let rows: CmdReportRow[];
  const t0 = Date.now();
  const customerIds = BXR_CUSTOMERS.map((c) => c.customerId);
  console.log(`pulling the WHOLE BOOK — ${customerIds.length} BXR customer accounts, sequential`);
  try {
    // Mirrors the production path exactly (handleCmdPayerRefresh): one pull per account,
    // all-or-nothing. A single-account pull understates the book ~10x and must never be
    // what this gate measures.
    rows = await collectRowsAcrossCustomers(customerIds, (customerId) =>
      cmdReportRows({ ...cfg, customerId }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL step 1 — the CMD report/filter pair did not return rows.`);
    console.error(`  ${msg}`);
    console.error('');
    console.error('If this says INVALID CRITERIA, the 10091828/10147241 pairing is DEAD like');
    console.error('the explorer pairings documented in CLAUDE.md. DO NOT schedule the cron:');
    console.error('writeRollup would DELETE the existing months and insert nothing.');
    console.error('Fix: rebuild the saved report/filter in CMD, then set CMD_REPORT_ID /');
    console.error('CMD_FILTER_ID and re-run this dry run.');
    process.exitCode = 1;
    return;
  }
  console.log(`step 1 OK — fetched ${rows.length} report rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- STEP 2: aggregate IN-PROCESS. PHI stops here. -------------------------------
  const { tuples, stats } = aggregateRollup(rows);
  console.log(
    `step 2 OK — aggregated to ${tuples.length} payer x facility x month tuples ` +
      `(rows_total=${stats.rows_total} aggregated=${stats.rows_aggregated} ` +
      `skipped_no_date=${stats.rows_skipped_no_date} payers=${stats.distinct_payers} ` +
      `facilities=${stats.distinct_facilities})`,
  );

  const liveByMonth = aggregateByMonth(tuples);
  const liveMonths = [...liveByMonth.keys()].sort();
  console.log('');
  console.log(`--- what date window does the FILTER actually cover? ---`);
  if (liveMonths.length === 0) {
    console.log('  NO MONTHS AT ALL. The report returned rows but none aggregated.');
  } else {
    console.log(`  live report spans ${liveMonths[0]} .. ${liveMonths[liveMonths.length - 1]}`);
    console.log(`  months present: ${liveMonths.join(', ')}`);
  }

  // ---- STEP 3: what the production window WOULD touch ------------------------------
  const wnd = windowMonths(new Date(), DEFAULT_WINDOW_SIZE).map((m) => monthKey(m.year, m.month));
  console.log('');
  console.log(`--- what the cron WOULD rewrite today (windowSize=${DEFAULT_WINDOW_SIZE}) ---`);
  console.log(`  ${wnd.join(', ')}`);
  const wouldDeleteNothingInto = wnd.filter((m) => !liveByMonth.has(m));
  if (wouldDeleteNothingInto.length) {
    console.log(
      `  !! DANGER: ${wouldDeleteNothingInto.join(', ')} in the window but ABSENT from the ` +
        `live report.\n     writeRollup would DELETE those months and insert nothing.`,
    );
  }

  // ---- Compare live aggregate vs what is already in the DB -------------------------
  const db = makeClient(readerUrl);
  try {
    const dbRes = await db.query<{
      service_year: number;
      service_month: number;
      rows: string;
      charge: string;
      allowed: string;
      paid: string;
      payers: string;
      facilities: string;
      last_ingested: string | null;
    }>(
      'select service_year, service_month, count(*)::text as rows, ' +
        'coalesce(sum(total_charge),0)::text as charge, ' +
        'coalesce(sum(total_allowed),0)::text as allowed, ' +
        'coalesce(sum(total_paid),0)::text as paid, ' +
        'count(distinct payer_name)::text as payers, ' +
        'count(distinct facility_name)::text as facilities, ' +
        'max(ingested_at)::text as last_ingested ' +
        'from collections.cmd_payer_facility_monthly ' +
        'where business_entity_id = $1 ' +
        'group by service_year, service_month',
      [BXR_ENTITY_ID],
    );

    const dbByMonth = new Map(
      dbRes.rows.map((r) => [
        monthKey(r.service_year, r.service_month),
        {
          rows: Number(r.rows),
          charge: Number(r.charge),
          allowed: Number(r.allowed),
          paid: Number(r.paid),
          payers: Number(r.payers),
          facilities: Number(r.facilities),
          last_ingested: r.last_ingested,
        },
      ]),
    );

    const allMonths = [...new Set([...liveByMonth.keys(), ...dbByMonth.keys()])].sort().reverse();
    console.log('');
    console.log('--- LIVE (would write) vs DB (current) — BXR tenant, charges ---');
    console.log('month     inWnd  liveRows  dbRows   liveCharge      dbCharge       delta');
    for (const m of allMonths.slice(0, 15)) {
      const L = liveByMonth.get(m);
      const D = dbByMonth.get(m);
      const inWnd = wnd.includes(m) ? ' YES ' : '  -  ';
      console.log(
        `${m}  ${inWnd}  ${String(L?.rows ?? 0).padStart(8)}  ${String(D?.rows ?? 0).padStart(6)}  ` +
          `${usd(L?.charge ?? 0).padStart(13)}  ${usd(D?.charge ?? 0).padStart(13)}  ` +
          `${pct(L?.charge ?? 0, D?.charge ?? 0).padStart(7)}`,
      );
    }

    // ---- Verdict on the highlighted month ------------------------------------------
    const L = liveByMonth.get(highlight);
    const D = dbByMonth.get(highlight);
    console.log('');
    console.log(`--- VERDICT for ${highlight} ---`);
    if (!L && !D) {
      console.log(`  ${highlight} is absent from BOTH the live report and the DB.`);
      console.log('  The saved filter does not reach this month. Widen the CMD filter window');
      console.log('  before scheduling, or the gap will never fill.');
    } else if (L && !D) {
      console.log(`  GAP FILL: live has ${L.rows} rollup rows / ${usd(L.charge)} charges;`);
      console.log(`  the DB has NOTHING. Scheduling the cron would populate ${highlight} cleanly`);
      console.log('  with no data destroyed (the DELETE removes zero rows).');
      console.log(`  payers=${L.payers.size} facilities=${L.facilities.size}`);
    } else if (L && D) {
      const dCharge = Math.abs(L.charge - D.charge) / (D.charge || 1);
      console.log(`  live: ${L.rows} rows / ${usd(L.charge)}   db: ${D.rows} rows / ${usd(D.charge)}`);
      console.log(`  db last ingested: ${D.last_ingested ?? 'unknown'}`);
      if (dCharge <= 0.02) {
        console.log('  RECONCILES (within 2%). The live batch pull agrees with the CSV ingest,');
        console.log('  so the dormancy was an unfinished task, not a data problem. Safe to schedule.');
      } else {
        console.log(`  DIVERGES by ${(dCharge * 100).toFixed(1)}%. Do NOT schedule yet — investigate`);
        console.log('  whether the batch pull and the CSV export use different filters or scopes.');
        console.log('  This may be exactly why the route was left dormant.');
      }
    } else {
      console.log(`  DB has ${D?.rows} rows but the live report has none for ${highlight}.`);
      console.log('  Scheduling the cron would DESTROY this month if it is inside the window.');
    }

    console.log('');
    console.log('Nothing was written. To enable, add to app/vercel.json crons:');
    console.log('  { "path": "/api/cron/refresh-cmd-payer", "schedule": "5 10 * * *" }');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[dryrun-cmd-payer] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
