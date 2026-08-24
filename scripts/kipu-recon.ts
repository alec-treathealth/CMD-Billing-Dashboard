/**
 * Run the EXTRACTED Kipu engine (`src/kipu/`) over a real Billing Report export and print
 * the grid totals plus the SQL for the warehouse side of the reconciliation.
 *
 *   npx tsx scripts/kipu-recon.ts <exportDir> [<exportDir> ...]
 *   npx tsx scripts/kipu-recon.ts test/fixtures/kipu-billing-report   # self-check
 *
 * WHY THIS EXISTS. `scripts/test-kipu-report-import.mjs` runs the MOCK's KIPU-IMPORT-CORE
 * block out of `docs/mockups/weekly-billable-days-v4.html` — it proves the mock, not the
 * shipped engine. Nothing ran `src/kipu/` against a real export except an ad-hoc session
 * that left no artifact, so every reconciliation attempt started by re-improvising the
 * glue. This is that glue, committed.
 *
 * ⚠ PHI: an export is PHI-bearing and must stay OUTSIDE the repo. This script prints
 * COUNTS, SUMS, week ids, facility labels, LOC labels and flag text only — never a patient
 * name, MRN, auth number or session topic. Keep it that way: the reconciliation needs
 * numbers, and a name in a terminal is a name in a scrollback.
 *
 * NOT part of the five-command gate — it reads exports that live outside the repo. The
 * fixture path above is the one input that IS in the repo, which is what makes this
 * verifiable: it must print 25 rows / 62 billable days / 204.4 hours / 12 flagged, the
 * browser-verified numbers for the real 2026-08-10 week (the fixture is that export,
 * scrubbed and date-shifted −364d, so its week id reads 2025-08-11).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assembleBundle, buildFromCsv } from '../src/kipu/billingReport.js';
import { LOC_CONFIG_BASE, withRules } from '../src/kipu/assumptions.js';
import { gridRows } from '../src/kipu/computeRow.js';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: npx tsx scripts/kipu-recon.ts <exportDir> [<exportDir> ...]');
  process.exit(2);
}

/** A1 of the comparison: the warehouse counts distinct (patient, charge_date) for the week. */
function warehouseSql(weekStart: string): string {
  const weekEnd = new Date(Date.UTC(
    Number(weekStart.slice(0, 4)), Number(weekStart.slice(5, 7)) - 1, Number(weekStart.slice(8, 10)) + 6,
  )).toISOString().slice(0, 10);
  return [
    '-- warehouse side; set the facility once attribution is ratified (see note below)',
    "select count(distinct patient_name_bidx)              as distinct_patients,",
    '       count(distinct charge_date)                    as charge_days,',
    '       count(distinct (patient_name_bidx, charge_date)) as patient_days,',
    '       count(*)                                       as charge_lines,',
    '       round(100.0*count(patient_name_bidx)/count(*), 2) as pct_name_bidx',
    '  from collections.cmd_explorer_rows',
    " where pull_facility_code = 'TREAT_TX'",
    `   and charge_date between '${weekStart}' and '${weekEnd}';`,
  ].join('\n');
}

let exitCode = 0;

for (const dir of dirs) {
  let files;
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
  } catch (err) {
    console.error(`\n${dir}: cannot read — ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
    continue;
  }

  console.log(`\n═══ ${basename(dir)} — ${files.length} csv file(s)`);
  if (files.length === 0) {
    console.error('  no CSVs here; point at the directory the export was unzipped into');
    exitCode = 1;
    continue;
  }

  const bundle = assembleBundle(files);
  console.log(
    `  parsed: sessions ${bundle.sessions.length}, evaluations ${bundle.evaluations.length}, ` +
      `patient ${bundle.patient.length}, labs ${bundle.labs.length}`,
  );
  for (const w of bundle.variantWarnings) console.log(`  ⚠ A9 ${w}`);

  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  console.log(`  clients ${b.clients.length}, facilities ${JSON.stringify(b.facilities)}`);
  console.log(`  weeks ${JSON.stringify(b.weeks.map((w) => w.id))}`);
  for (const f of b.locFlags) console.log(`  ⚠ LOC ${f}`);
  for (const n of b.notes) console.log(`  note ${n}`);
  for (const s of b.skipped) console.log(`  skipped ${s}`);
  for (const t of b.tzFlags) {
    console.log(`  ⚠ tz ${t.facility}: export declares ${t.declared}, roster says ${t.ours} (Δ${t.deltaH}h)`);
  }
  if (b.tzUnknown.length) console.log(`  ⚠ tz unmapped ${JSON.stringify(b.tzUnknown)}`);

  for (const week of b.weeks) {
    // Both A13 modes: 'current-ur-loc' reproduces the browser mock; per-day is the DEFAULT
    // and the ruled semantics. Printing both makes a divergence visible instead of implicit.
    const modes = [
      ['per-day (default, ruled)', gridRows(b.clients, week.id, b.locCfg)],
      ['current-ur-loc (mock parity)', gridRows(b.clients, week.id, b.locCfg, withRules({ capResolution: 'current-ur-loc' }))],
    ] as const;

    console.log(`\n  ── week ${week.id}`);
    for (const [label, rows] of modes) {
      const days = rows.reduce((a, x) => a + x.row.billableDays, 0);
      const hours = rows.reduce((a, x) => a + x.row.total, 0);
      const flagged = rows.filter((x) => x.row.flag).length;
      console.log(
        `    ${label.padEnd(28)} rows ${String(rows.length).padStart(3)} · ` +
          `billableDays ${String(days).padStart(3)} · hours ${hours.toFixed(1).padStart(6)} · flagged ${flagged}`,
      );
    }
    const [, perDay] = modes[0];
    const [, parity] = modes[1];
    const dPerDay = perDay.reduce((a, x) => a + x.row.billableDays, 0);
    const dParity = parity.reduce((a, x) => a + x.row.billableDays, 0);
    console.log(
      dPerDay === dParity
        ? '    A13: the two modes AGREE on this export — the per-day ruling changes nothing here'
        : `    ⚠ A13: modes DIVERGE by ${dPerDay - dParity} billable day(s) — a multi-LOC week is in play`,
    );

    // Guard the emitted SQL rather than letting a zero-row result read as a real variance.
    // Two ways this week can be un-comparable, and both return rows=0 or a silent undercount:
    // the fixture's dates are shifted −364d so they hit no warehouse data at all, and any week
    // before ~2026-07 predates patient_name_bidx being populated at ingest.
    if (week.id < '2026-07-01') {
      console.log(
        `\n    ⚠ week ${week.id} is NOT warehouse-comparable — skipping the SQL.\n` +
          '      Before ~2026-07 patient_name_bidx is mostly NULL, so the comparison would\n' +
          '      undercount silently. If this is the committed fixture, that is expected: its\n' +
          '      dates are shifted −364d, so it can verify the ENGINE but never the warehouse.',
      );
    } else {
      console.log('\n' + warehouseSql(week.id).split('\n').map((l) => '    ' + l).join('\n'));
    }
  }
}

console.log(
  '\n  ⚠ ATTRIBUTION IS NOT RATIFIED. The SQL above assumes the Kipu location "Telehealth MH TX"\n' +
    '    bills under CMD customer TREAT_TX (10029722). Evidence (measured 2026-08-24): weekly\n' +
    '    distinct patients ran 30/30/27/30 for TREAT_TX against an export of 25-27 clients, while\n' +
    '    TELEHEALTH_MH ran 14/12/10/11 and TREAT_TN 14/14/13/13. That is population-size evidence,\n' +
    "    NOT identity proof — confirm patient-level via member/name blind-index tokens before\n" +
    '    trusting a variance, and change the facility in the SQL if the ruling lands elsewhere.\n' +
    '  ⚠ Run the recon on JULY 2026 OR LATER. patient_name_bidx is populated at ingest only from\n' +
    '    ~July (Aug 100%, Jul 94.7%, Jun 48.6%, May 25.1%, Apr 18.2%; 7.74% over the whole table,\n' +
    '    because migration 0066\'s backfill grant has been inert since June). Earlier weeks would\n' +
    '    silently undercount rather than error.',
);

process.exit(exitCode);
