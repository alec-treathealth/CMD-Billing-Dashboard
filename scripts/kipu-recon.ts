/**
 * Run the EXTRACTED Kipu engine (`src/kipu/`) over one or more real Billing Report exports
 * and produce a PER-CMD-CUSTOMER, PER-WEEK, DAY-GRAIN reconciliation against the warehouse.
 *
 *   npx tsx scripts/kipu-recon.ts <exportDir> [<exportDir> ...] [--weeks=YYYY-MM-DD,...]
 *   npx tsx scripts/kipu-recon.ts test/fixtures/kipu-billing-report          # engine self-check
 *   npx tsx scripts/kipu-recon.ts "test/fixtures/"*                          # whole corpus
 *
 * ⚠ PASS EVERY EXPORT THAT BILLS UNDER THE CUSTOMER YOU ARE RECONCILING. All dirs are
 * combined into ONE corpus before grouping, because the Kipu→CMD mapping is N:1: Kipu
 * splits Telehealth MH by state and CMD does not, so TELEHEALTH_MH's Kipu side is
 * Colorado + Tennessee-Telehealth + Texas-Telehealth SUMMED. Reconciling one state's
 * folder against the combined CMD account manufactures a variance that does not exist.
 *
 * ⚠ PHI: an export is PHI-bearing and must stay OUTSIDE the repo (.gitignore blanket
 * *.csv). This prints COUNTS, SUMS, week ids, container labels, state and facility codes
 * only — never a patient name, MRN, auth number or session topic.
 *
 * NOT part of the five-command gate: it reads exports that live outside the repo. The
 * fixture path above is the one in-repo input, which is what makes it verifiable — it must
 * print 25 rows / 62 billableDays / 204.4 hours / 12 flagged for its single week.
 *
 * THE WAREHOUSE SIDE IS EMITTED AS SQL, NOT QUERIED. Reads must run as claims_reader
 * through the app's own scoping; a script minting its own DB path around that is exactly
 * what `.claude/rules/collections-crons.md` forbids. Paste the SQL, or read it as the
 * specification of the comparison unit: distinct (patient_name_bidx, charge_date).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assembleBundle, buildFromCsv, isoShift } from '../src/kipu/billingReport.js';
import { LOC_CONFIG_BASE, withRules } from '../src/kipu/assumptions.js';
import { gridRows } from '../src/kipu/computeRow.js';
import { locationFor, labelsForFacility } from '../src/kipu/locations.js';

const args = process.argv.slice(2);
const weekFilter = new Set(
  args.filter((a) => a.startsWith('--weeks=')).flatMap((a) => a.slice(8).split(',').map((s) => s.trim()).filter(Boolean)),
);
const dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length === 0) {
  console.error('usage: npx tsx scripts/kipu-recon.ts <exportDir> [...] [--weeks=YYYY-MM-DD,...]');
  process.exit(2);
}

/* ------------------------------- load the corpus ------------------------------- */

// ⚠ BUILD PER FOLDER, NOT ONE COMBINED BUNDLE. An export folder is a Kipu LOCATION scope,
// and that is the only thing that can attribute an EVALUATION: the evaluations file has no
// `Session` column, so an eval-only client carries no container label at all. Attributing
// by label alone silently dropped 5 of 27 fixture clients (25 grid rows → 22, 204.4h →
// 203.4) — an undercount that looks like a real variance. The folder supplies what the row
// cannot. Aggregation across folders then happens by CMD facility code, which is what makes
// the N:1 telehealth rollup fall out correctly.
interface Built {
  dir: string;
  b: ReturnType<typeof buildFromCsv>;
  /** Distinct CMD codes among this folder's labels; `null` present = some label has no CMD customer. */
  codes: (string | null)[];
}

const built: Built[] = [];
let readFailures = 0;
for (const dir of dirs) {
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    const csvs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
    if (csvs.length === 0) throw new Error('no CSVs — point at the unzipped export directory');
    const files = csvs.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
    const bundle = assembleBundle(files);
    for (const w of bundle.variantWarnings) console.log(`  ⚠ A9 ${basename(dir)}: ${w}`);
    // Throws on any container label absent from the registry — the gate, not a warning.
    const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
    const codes = [...new Set(b.facilities.map((l) => locationFor(l)?.facilityCode ?? null))];
    built.push({ dir, b, codes });
    console.log(
      `  loaded ${String(csvs.length).padStart(2)} csv from ${basename(dir).padEnd(22)} ` +
        `sessions ${String(b.clients.reduce((a, c) => a + c.sessions.length, 0)).padStart(5)} ` +
        `clients ${String(b.clients.length).padStart(4)} → ${codes.map((c) => c ?? '(none)').join('+')}`,
    );
  } catch (err) {
    console.error(`  ✗ ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    readFailures += 1;
  }
}
if (built.length === 0) process.exit(1);

/* ------------------------------ location summary ------------------------------ */

const totals = {
  sessions: built.reduce((a, x) => a + x.b.clients.reduce((s, c) => s + c.sessions.length, 0), 0),
  clients: built.reduce((a, x) => a + x.b.clients.length, 0),
};
console.log(`\ncorpus: ${built.length} export(s), ${totals.sessions} session+eval rows, ${totals.clients} client records`);

console.log('\n── locations (registry-resolved, no inference)');
const seenLabels = new Set<string>();
for (const { b } of built) {
  for (const label of b.facilities) {
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    const loc = locationFor(label);
    console.log(
      `  ${(loc?.facilityCode ?? '(no CMD facility yet)').padEnd(22)} ${(loc?.state ?? '??').padEnd(3)} ` +
        `${(loc?.zoneLabel ?? '?').padEnd(9)} «${label}»`,
    );
  }
}
for (const { dir, b } of built) {
  for (const t of b.tzFlags) {
    console.log(`  ⚠ tz DIFF «${t.facility}»: Kipu declares ${t.declared}, registry says ${t.ours} (Δ${t.deltaH}h)`);
  }
  if (b.tzUnknown.length) console.log(`  ⚠ tz unmapped in ${basename(dir)}: ${JSON.stringify(b.tzUnknown)}`);
}
const boundaryTotal = built.reduce((a, x) => a + x.b.boundary.length, 0);
console.log(`  midnight-adjacent sessions (±120min, reported not corrected): ${boundaryTotal}`);

/* --------------------------- attribute clients to CMD -------------------------- */

// Folder-scoped attribution. A folder whose labels all bill to ONE code gives that code to
// every client in it, evaluation-only clients included. A folder mixing codes falls back to
// per-client labels and is flagged — no folder in the current corpus does this.
const byFacility = new Map<string, { dir: string; clients: Built['b']['clients'] }[]>();
let noFacilityClients = 0;
let ambiguousClients = 0;
for (const { dir, b, codes } of built) {
  const real = codes.filter((c): c is string => c !== null);
  if (real.length === 1 && codes.length === 1) {
    const code = real[0] as string;
    const arr = byFacility.get(code) ?? [];
    arr.push({ dir, clients: b.clients });
    byFacility.set(code, arr);
    continue;
  }
  if (real.length === 0) {
    noFacilityClients += b.clients.length;
    console.log(`  ${basename(dir)}: no CMD facility for any label — EXCLUDED (${b.clients.length} clients)`);
    continue;
  }
  console.log(`  ⚠ ${basename(dir)} mixes CMD codes ${JSON.stringify(codes)} — falling back to per-client labels`);
  for (const code of real) {
    const clients = b.clients.filter((c) => {
      const cs = [...new Set(c.labels.map((l) => locationFor(l)?.facilityCode ?? null))];
      if (cs.length > 1) return false;
      return cs[0] === code;
    });
    const arr = byFacility.get(code) ?? [];
    arr.push({ dir, clients });
    byFacility.set(code, arr);
  }
  ambiguousClients += b.clients.filter(
    (c) => new Set(c.labels.map((l) => locationFor(l)?.facilityCode ?? null)).size > 1,
  ).length;
}

console.log(
  `\n── attribution: ${byFacility.size} CMD customer(s); ` +
    `${noFacilityClients} client(s) at locations with no CMD facility (excluded); ${ambiguousClients} ambiguous (excluded)`,
);

/* --------------------------------- reconcile ---------------------------------- */

const allWeeks = [...new Set(built.flatMap((x) => x.b.weeks.map((w) => w.id)))].sort();
const weeks = allWeeks.filter((w) => weekFilter.size === 0 || weekFilter.has(w));
if (weekFilter.size > 0) {
  for (const w of weekFilter) if (!weeks.includes(w)) console.log(`  ⚠ requested week ${w} has no data in this corpus`);
}

// locCfg is per-build (it is synthesised from that export's own auths), so a facility's rows
// must be computed with the locCfg of the export they came from — not a merged one.
const locCfgFor = new Map(built.map((x) => [x.dir, x.b.locCfg]));

for (const week of weeks) {
  const weekEnd = isoShift(week, 6);
  console.log(`\n═══ week ${week} … ${weekEnd}`);

  for (const code of [...byFacility.keys()].sort()) {
    const groups = byFacility.get(code) ?? [];
    const perDay = groups.flatMap((g) => gridRows(g.clients, week, locCfgFor.get(g.dir) ?? LOC_CONFIG_BASE));
    const parity = groups.flatMap((g) =>
      gridRows(g.clients, week, locCfgFor.get(g.dir) ?? LOC_CONFIG_BASE, withRules({ capResolution: 'current-ur-loc' })),
    );
    const sum = (rows: typeof perDay) => ({
      rows: rows.length,
      days: rows.reduce((a, x) => a + x.row.billableDays, 0),
      hours: rows.reduce((a, x) => a + x.row.total, 0),
      flagged: rows.filter((x) => x.row.flag).length,
    });
    const d = sum(perDay);
    const p = sum(parity);
    if (d.rows === 0 && p.rows === 0) continue;

    // A10 exposure: a week with zero non-Complete GROUP rows cannot test the group half of
    // the billable-status rule, so a matching number there is not evidence about A10.
    let nonComplete = 0;
    let groupRows = 0;
    for (const g of groups) {
      for (const c of g.clients) {
        for (const s of c.sessions) {
          if (s.kind !== 'group' || s.date < week || s.date > weekEnd) continue;
          groupRows += 1;
          if (s.status !== 'Complete') nonComplete += 1;
        }
      }
    }

    const labels = labelsForFacility(code);
    console.log(`\n  ${code}  (Kipu side summed over ${labels.length} label(s): ${labels.map((l) => `«${l}»`).join(' + ')})`);
    console.log(
      `    per-day (ruled)      patients ${String(d.rows).padStart(3)} · billableDays ${String(d.days).padStart(4)} · hours ${d.hours.toFixed(1).padStart(7)} · flagged ${d.flagged}`,
    );
    console.log(
      `    current-ur-loc       patients ${String(p.rows).padStart(3)} · billableDays ${String(p.days).padStart(4)} · hours ${p.hours.toFixed(1).padStart(7)} · flagged ${p.flagged}`,
    );
    console.log(
      d.days === p.days
        ? '    A13 diff: 0 — the two cap regimes agree for this customer-week'
        : `    ⚠ A13 diff: ${d.days - p.days} billableDay(s) — a multi-LOC week is in play`,
    );
    console.log(
      nonComplete === 0
        ? `    ⚠ A10 UNTESTED FOR GROUP SESSIONS this week: all ${groupRows} group row(s) are Complete, so a matching number here is NOT confirmation of the group billable-status rule`
        : `    A10 exercised: ${nonComplete} of ${groupRows} group row(s) are non-Complete and were held out`,
    );
    console.log('    warehouse side — paste this:');
    for (const line of [
      'select count(distinct patient_name_bidx)                as distinct_patients,',
      '       count(distinct charge_date)                      as charge_days,',
      '       count(distinct (patient_name_bidx, charge_date)) as patient_days,  -- ← compare to billableDays',
      '       count(*)                                        as charge_lines,',
      '       round(100.0*count(patient_name_bidx)/count(*),2) as pct_name_bidx',
      '  from collections.cmd_explorer_rows',
      ` where pull_facility_code = '${code}'`,
      `   and charge_date between '${week}' and '${weekEnd}';`,
    ]) console.log('      ' + line);
  }
}

console.log(
  '\n── reading the numbers\n' +
    '  · billableDays is the comparison unit, NOT patients. Patient counts move for reasons day\n' +
    '    counts do not (a mid-week admit is one patient and two days).\n' +
    "  · pct_name_bidx below 100 means the warehouse side UNDERCOUNTS: that column is populated\n" +
    '    at ingest only from ~July 2026 (Aug 100%, Jul 94.7%, Jun 48.6%, May 25.1%, Apr 18.2%),\n' +
    "    because migration 0066's backfill grant has been inert since June. Report the coverage\n" +
    '    next to any pre-July number or drop the week.\n' +
    '  · a Kipu excess is not automatically a billing gap: unbilled delivered service, an\n' +
    '    attribution error, and our own A9/A10 counting a row that should not count all produce\n' +
    '    it. Confirm attribution patient-level via blind-index tokens before naming a cause.',
);

process.exit(readFailures > 0 ? 1 : 0);
