/**
 * Headless test for the Kipu Billing Report importer.
 *
 * Extracts the KIPU-IMPORT-CORE block out of the mock HTML and runs it against real
 * exports, so what is tested is byte-identical to what ships. No DOM, no network.
 * PHI discipline: asserts on COUNTS and SHAPES only — never prints a patient name.
 *
 *   node scripts/test-kipu-report-import.mjs <mock.html> <exportDir> [<exportDir> ...]
 *
 * e.g. node scripts/test-kipu-report-import.mjs docs/mockups/weekly-billable-days-v4.html \
 *        ~/Downloads/Billing\ Report\ -\ *12-28am
 *
 * NOT part of the five-command verification gate — this is a manual harness against
 * real exports that live outside the repo, so it cannot run in CI. It duplicates
 * LOC_CONFIG_BASE below on purpose: the point is to prove that an UNKNOWN level of care
 * is flagged rather than silently capped, which needs a known-good base to diff against.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import assert from 'node:assert/strict';

const [htmlPath, ...dirs] = process.argv.slice(2);
const html = readFileSync(htmlPath, 'utf8');

const m = /KIPU-IMPORT-CORE:BEGIN([\s\S]*?)\/\* =+ KIPU-IMPORT-CORE:END/.exec(html);
assert.ok(m, 'KIPU-IMPORT-CORE block not found in ' + htmlPath);
const core = m[1];
const LOC_CONFIG_BASE = {
  'MH IOP 3 Adult': { track:'IOP', capDays:3, minHours:3.0 },
  'MH IOP 4 Adult': { track:'IOP', capDays:4, minHours:3.0 },
  'MH OP 4 Adult':  { track:'IOP', capDays:4, minHours:3.0, ambiguous:true },
  'MH OP 2 Adult':  { track:'OP',  capDays:2, minHours:0 },
};
const api = new Function(core.replace(/^[\s\S]*?\*\//, '') +
  '\nreturn {parseCsv, classifyRows, buildFromCsv, parseAuths, stripAttest, usDateTime, usDate};')();

let failures = 0;
for (const dir of dirs) {
  const bundle = { sessions:[], evaluations:[], patient:[], labs:[] };
  const seen = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.csv'))) {
    const rows = api.parseCsv(readFileSync(join(dir, f), 'utf8'));
    const kind = api.classifyRows(rows);
    seen.push(`${kind}:${rows.length}`);
    if (bundle[kind]) bundle[kind] = bundle[kind].concat(rows);
  }
  const b = api.buildFromCsv(bundle, LOC_CONFIG_BASE);
  const n = k => b.clients.reduce((a,c) => a + c.sessions.filter(k).length, 0);
  const label = basename(dir).slice(-12);

  console.log(`\n=== ${label}  [${seen.sort().join(' ')}]`);
  console.log(`  clients ${b.clients.length} · groups ${n(s=>s.kind==='group')} · evals ${n(s=>s.kind!=='group')}`
    + ` · bps ${n(s=>s.kind==='bps')} · non-billable ${n(s=>s.billable===false)}`);
  console.log(`  weeks ${b.weeks.length} [${b.weeks.map(w=>w.id).join(', ')}]`);
  console.log(`  facilities ${JSON.stringify(b.facilities)}`);
  console.log(`  LOCs ${JSON.stringify(Object.keys(b.locCfg))}`);
  console.log(`  caps ${JSON.stringify(Object.fromEntries(Object.entries(b.locCfg).map(([k,v])=>[k,`${v.track}/${v.capDays}d${v.ambiguous?'?':''}`])))}`);
  console.log(`  auths ${b.clients.reduce((a,c)=>a+c.auths.length,0)} · clients flagged ${b.clients.filter(c=>c.warn.length).length}`);
  console.log(`  skipped ${b.skipped.length} · notes ${b.notes.length}`);
  console.log(`  tz: mismatches ${b.tzFlags.length} · unmapped ${JSON.stringify(b.tzUnknown)}`
    + ` · within ${b.midnightGuardMin}min of midnight ${b.boundary.length}`
    + ` (billable ${b.boundary.filter(x=>x.billable).length})`);
  if (b.locFlags.length) b.locFlags.forEach(f => console.log('    ⚠ ' + f));

  // ---- invariants that must hold for every export ----
  const t = (name, fn) => { try { fn(); } catch (e) { failures++; console.log(`  ✗ ${name}: ${e.message}`); } };
  t('every client has an id and a name', () => {
    b.clients.forEach(c => { assert.ok(c.id && c.name, 'blank id/name'); });
  });
  t('every session has an ISO date and finite hours', () => {
    b.clients.forEach(c => c.sessions.forEach(s => {
      assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, 'bad date ' + s.date);
      assert.ok(Number.isFinite(s.hrs), 'bad hrs');
    }));
  });
  t('no telehealth attestation survives normalisation', () => {
    const leak = [];
    b.clients.forEach(c => {
      if (/encounter/i.test(c.loc)) leak.push('loc');
      c.sessions.forEach(s => { if (/via real-time/i.test(s.topic)) leak.push('topic'); });
      c.auths.forEach(a => { if (/via real-time/i.test(a.loc)) leak.push('auth.loc'); });
    });
    assert.equal(leak.length, 0, 'attestation leaked into: ' + [...new Set(leak)].join(','));
  });
  t('every auth has a parsed window', () => {
    b.clients.forEach(c => c.auths.forEach(a => {
      assert.match(a.start, /^\d{4}-\d{2}-\d{2}$/, 'auth.start ' + a.start);
      assert.match(a.end,   /^\d{4}-\d{2}-\d{2}$/, 'auth.end ' + a.end);
    }));
  });
  t('missed sessions and 0-hour evals are never billable (A12)', () => {
    b.clients.forEach(c => c.sessions.forEach(s => {
      if (/missed/i.test(s.topic) || s.hrs === 0) assert.equal(s.billable, false, 'billable: ' + s.topic);
    }));
  });
  t('only Complete rows are billable (A10)', () => {
    b.clients.forEach(c => c.sessions.forEach(s => {
      if (s.status && s.status !== 'Complete') assert.equal(s.billable, false, 'billable at status ' + s.status);
    }));
  });
  t('weeks are Monday-start, newest first, and cover every session date', () => {
    b.weeks.forEach(w => assert.equal(new Date(w.start + 'T00:00:00').getDay(), 1, w.start + ' is not a Monday'));
    for (let i = 1; i < b.weeks.length; i++) assert.ok(b.weeks[i-1].id > b.weeks[i].id, 'weeks not newest-first');
    const covered = new Set();
    b.weeks.forEach(w => { for (let i = 0; i < 7; i++) {
      const t2 = new Date(w.start + 'T00:00:00'); t2.setDate(t2.getDate() + i);
      covered.add(t2.toISOString().slice(0, 10)); } });
    b.clients.forEach(c => c.sessions.forEach(s => assert.ok(covered.has(s.date), 'week gap at ' + s.date)));
  });
  t('timezone: every facility maps to a zone, and mismatches are reported not corrected', () => {
    assert.equal(b.tzUnknown.length, 0, 'unmapped facility: ' + b.tzUnknown.join(','));
    b.tzFlags.forEach(f => assert.ok(f.deltaH > 0, 'a reported mismatch must carry a delta'));
  });
  t('date-boundary exposure is measured, and no BILLABLE row sits on the boundary', () => {
    const risky = b.boundary.filter(x => x.billable);
    assert.equal(risky.length, 0,
      risky.length + ' billable timestamp(s) within ' + b.midnightGuardMin + ' min of midnight');
  });
  t('no config-backed LOC is silently uncapped', () => {
    Object.entries(b.locCfg).forEach(([loc, cfg]) => {
      if (!LOC_CONFIG_BASE[loc]) assert.equal(cfg.ambiguous, true, loc + ' inferred but not flagged');
    });
  });
}
console.log(failures ? `\n${failures} FAILED` : '\nall invariants hold');
process.exit(failures ? 1 : 0);
