/**
 * Hermetic tests for the decision-matrix parser + sync (src/billingAudit/
 * decisionSheet.ts, decisionSync.ts). Fixtures mirror the LIVE grid shapes observed
 * 2026-07-13 (block headers, title row, HCPCS/REV placeholder, "STILL PENDING",
 * year-less stop annotations, sub-cohort carrier suffixes). Matrix text is non-PHI
 * billing configuration. No real Sheets / DB — a fake fetcher + fake pg pool.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FACILITY_LABEL_TO_CODE, parseSheetDate, parseCodesCell, parseSubCohort,
  parseRuleHints, parseStopAnnotation, parseEhTab, parseJtStops, mergeStops,
} from '../src/billingAudit/decisionSheet.js';
import { decisionSync, EH_TAB, JT_TAB, type SheetGrid } from '../src/billingAudit/decisionSync.js';

const BXR = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

const grid = (rows: string[][], startRow = 1): SheetGrid => ({
  rows: rows.map((cells, i) => ({ rowNum: startRow + i, cells })),
});

// EH fixture — mirrors the live tab: blank row, spaced-slash title row (must NOT
// parse as a block), block headers, sub-cohorts, placeholder codes, blank date, F-col note.
const EH_FIXTURE = grid([
  [],
  ['Facility / Carrier', 'Date Code Decision Finalized', 'Codes Utilizing', 'Additional Billing Rules'],
  ['KWC/CARRIER', 'DATE CODE DECISION FINALIZED', 'Codes Utilizing', 'Additonal Billng Rules'],
  ['BCBS AR - Walmart plan', '5/21/2026', 'NO HCPCS / 1001', '10-11 DOS Per Claim'],
  ['GEHA', '3/25/2026', 'HCPCS/REV', '5 DOS BULK 863 TOB'],
  ['TBH/CARRIER', 'DATE CODE DECISION FINALIZED', 'Codes Utilizing', 'Additonal Billng Rules'],
  ['BCBS TX - SUD (DTX)', '7/7/2026', 'H0017 / 0156', '2-3 DOS per claim'],
  ['BCBS TX - MH (ZGP ALPHA)', '7/7/2026', 'H0017 / 0158', '3 DOS per claim', '', 'Might be discontinued'],
  ['BCBS TX - MH (NON ZGP ALPHA)', '7/7/2026', 'H0017 / 0128', '2 DOS per claim'],
  ['CAMH/CARRIER', 'DATE CODE DECISION FINALIZED', 'Codes Utilizing', 'Additonal Billng Rules'],
  ['Anthem BCBS', '5/18/2026', 'H0017/0158', '86X TOB - Single DOS'],
  ['All other BCBS (Including Anthem)', '6/27/2025', 'H0019/0100', '2 DOS per claim, add DRG 951'],
  ['Treat WA/CARRIER', 'DATE CODE DECISION FINALIZED', 'Codes Utilizing', 'Additonal Billng Rules'],
  ['BCBS', '', 'H2018/0905', 'Thinking we might start testing this'],
]);

// JT fixture — cols K–O (offset 10): CAMH block with the live year-less stop, a
// "STILL PENDING" date row, and a stop on a carrier with no EH row.
const pad = (cells: string[]): string[] => [...Array<string>(10).fill(''), ...cells];
const JT_FIXTURE = grid([
  pad([]),
  pad(['CAMH/CARRIER', 'DATE CODE DECISION FINALIZED (Changed Billing Codes)', 'Codes Utilizing', 'Additonal Billng Rules', 'Date We Stopped Code']),
  pad(['Anthem BCBS', '5/18/2026', 'H0017/0158', '86X TOB - Single DOS', '06/21 (H0017)']),
  pad(['Cigna', 'STILL PENDING', 'H0017/0158', 'Single DOS', '']),
  pad(['Ghost Carrier', '4/1/2026', 'H0001/0100', '', '05/01 (H0001)']),
]);

// --- primitives -----------------------------------------------------------------------

test('parseSheetDate: both M/D/YYYY paddings; multi-line takes first line; junk null', () => {
  assert.equal(parseSheetDate('5/21/2026'), '2026-05-21');
  assert.equal(parseSheetDate('03/25/2026'), '2026-03-25');
  assert.equal(parseSheetDate('04/07/2026\nSingle DOS per CB as of 6/10'), '2026-04-07');
  assert.equal(parseSheetDate('STILL PENDING'), null);
  assert.equal(parseSheetDate('2/30/2026'), null);
  assert.equal(parseSheetDate(''), null);
});

test('parseCodesCell: plain, NO-HCPCS, spaced, and the HCPCS/REV placeholder', () => {
  assert.deepEqual(parseCodesCell('H0018/1001'), { hcpcs: 'H0018', rev_code: '1001', placeholder: false });
  assert.deepEqual(parseCodesCell('NO HCPCS / 1001'), { hcpcs: null, rev_code: '1001', placeholder: false });
  assert.deepEqual(parseCodesCell('NO HCPCS /0124'), { hcpcs: null, rev_code: '0124', placeholder: false });
  assert.deepEqual(parseCodesCell('H0017 / 0158'), { hcpcs: 'H0017', rev_code: '0158', placeholder: false });
  assert.deepEqual(parseCodesCell('HCPCS/REV'), { hcpcs: null, rev_code: null, placeholder: true });
});

test('parseSubCohort: ZGP / NON-ZGP alpha and DTX/RTC loc; plain carriers null', () => {
  assert.deepEqual(parseSubCohort('BCBS TX - MH (ZGP ALPHA)'), { alpha_prefix: 'ZGP', loc: null });
  assert.deepEqual(parseSubCohort('BCBS TX - MH (NON ZGP ALPHA)'), { alpha_prefix: 'NON-ZGP', loc: null });
  assert.deepEqual(parseSubCohort('BCBS TX - SUD (DTX)'), { alpha_prefix: null, loc: 'DTX' });
  assert.deepEqual(parseSubCohort('All other BCBS (Including Anthem)'), { alpha_prefix: null, loc: null });
});

test('parseRuleHints: DOS ranges, Single DOS, TOB, DRG', () => {
  assert.deepEqual(parseRuleHints('10-11 DOS Per Claim'), { dos_bundle_min: 10, dos_bundle_max: 11, tob_pattern: null, drg: null });
  assert.deepEqual(parseRuleHints('86X TOB - Single DOS'), { dos_bundle_min: 1, dos_bundle_max: 1, tob_pattern: '86X', drg: null });
  assert.deepEqual(parseRuleHints('5 DOS BULK 863 TOB'), { dos_bundle_min: 5, dos_bundle_max: 5, tob_pattern: '863', drg: null });
  assert.deepEqual(parseRuleHints('2 DOS per claim, add DRG 951'), { dos_bundle_min: 2, dos_bundle_max: 2, tob_pattern: null, drg: '951' });
  assert.deepEqual(parseRuleHints(''), { dos_bundle_min: null, dos_bundle_max: null, tob_pattern: null, drg: null });
});

test('parseStopAnnotation: year inference from finalized date; rollover; needs-ruling paths', () => {
  assert.deepEqual(parseStopAnnotation('06/21 (H0017)', '2026-05-18'), { stopped_on: '2026-06-21', stopped_code: 'H0017' });
  // Stop month before the finalized month → next year.
  assert.deepEqual(parseStopAnnotation('01/15', '2026-05-18'), { stopped_on: '2027-01-15', stopped_code: null });
  // Explicit year wins.
  assert.deepEqual(parseStopAnnotation('06/21/2026 (H0017)', null), { stopped_on: '2026-06-21', stopped_code: 'H0017' });
  assert.ok('needsRuling' in parseStopAnnotation('06/21 (H0017)', null));
  assert.ok('needsRuling' in parseStopAnnotation('soon', '2026-05-18'));
});

// --- tab parsing -----------------------------------------------------------------------

test('parseEhTab: blocks parse, title row skipped as preamble, quirks land as notes', () => {
  const { decisions, notes } = parseEhTab(EH_FIXTURE, EH_TAB);
  assert.equal(decisions.length, 8);
  // Title row (spaced slash) must NOT have become a block; it lands as one preamble note.
  assert.equal(notes.filter((n) => n.includes('before any recognized block header')).length, 1);
  const kwc = decisions.filter((d) => d.facility_code === 'KWC');
  assert.equal(kwc.length, 2);
  assert.deepEqual(
    kwc.map((d) => [d.hcpcs, d.rev_code]),
    [[null, '1001'], [null, null]], // NO-HCPCS row + HCPCS/REV placeholder (rules-only)
  );
  const zgp = decisions.find((d) => d.carrier_text.includes('(ZGP ALPHA)'));
  assert.equal(zgp?.alpha_prefix, 'ZGP');
  assert.equal(zgp?.rules_text, '3 DOS per claim — Might be discontinued'); // F-col note folded in
  const dtx = decisions.find((d) => d.loc === 'DTX');
  assert.equal(dtx?.rev_code, '0156');
  const blankDate = decisions.find((d) => d.facility_code === 'TREAT_WA');
  assert.equal(blankDate?.finalized_on, null);
  const drg = decisions.find((d) => d.drg === '951');
  assert.equal(drg?.carrier_text, 'All other BCBS (Including Anthem)');
});

test('parseJtStops: only col-O contributes; STILL PENDING row yields no stop', () => {
  const { stops, notes } = parseJtStops(JT_FIXTURE, JT_TAB);
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[0], {
    facility_code: 'CAMH', carrier_text: 'Anthem BCBS',
    stopped_on: '2026-06-21', stopped_code: 'H0017', source_row: 3,
  });
  assert.equal(stops[1]?.carrier_text, 'Ghost Carrier');
  assert.equal(notes.length, 0); // blank row 1 skips silently; block header starts at row 2 — no preamble
});

test('mergeStops: EH-canonical attach; unmatched JT stop surfaced; code targeting works', () => {
  const eh = parseEhTab(EH_FIXTURE, EH_TAB);
  const jt = parseJtStops(JT_FIXTURE, JT_TAB);
  const m = mergeStops(eh.decisions, jt.stops);
  assert.equal(m.jt_stops_applied, 1);
  assert.equal(m.jt_stops_unmatched, 1); // Ghost Carrier has no EH row
  const anthem = m.merged.find((d) => d.facility_code === 'CAMH' && d.carrier_text === 'Anthem BCBS');
  assert.equal(anthem?.stopped_on, '2026-06-21');
  assert.equal(anthem?.stopped_code, 'H0017');
  // Every other row stays active.
  assert.equal(m.merged.filter((d) => d.stopped_on !== null).length, 1);
});

test('facility label map: all 12 live labels resolve; NMH → NASH', () => {
  assert.equal(Object.keys(FACILITY_LABEL_TO_CODE).length, 12);
  assert.equal(FACILITY_LABEL_TO_CODE['NMH'], 'NASH');
  assert.equal(FACILITY_LABEL_TO_CODE['TREAT CA'], 'TREAT_CA');
});

// --- sync orchestration (fake fetcher + fake pool) ---------------------------------------

function fakeDecisionDb(existing: { same: number; total: number }): {
  db: unknown; upsertSqls: string[]; updateSqls: string[]; paramsSeen: unknown[][];
} {
  const upsertSqls: string[] = [];
  const updateSqls: string[] = [];
  const paramsSeen: unknown[][] = [];
  let guc: string | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      if (/set_config/i.test(s)) { guc = String(params?.[0] ?? ''); return { rowCount: 1, rows: [{}] }; }
      if (/current_setting/i.test(s)) return { rowCount: 1, rows: [{ v: guc }] };
      if (/count\(\*\) filter/i.test(s)) {
        return { rowCount: 1, rows: [{ same: String(existing.same), total: String(existing.total) }] };
      }
      if (/^insert into claims\.billing_code_decision/i.test(s)) {
        upsertSqls.push(s);
        paramsSeen.push(params ?? []);
        return { rowCount: (s.match(/\(\$\d+/g) ?? []).length, rows: [] };
      }
      if (/^update claims\.billing_code_decision/i.test(s)) {
        updateSqls.push(s);
        return { rowCount: 2, rows: [] };
      }
      if (/from claims\.payer_alias/i.test(s)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  return { db: { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client }, upsertSqls, updateSqls, paramsSeen };
}

const fetchFixtures = async (tab: string): Promise<SheetGrid> =>
  tab === EH_TAB ? EH_FIXTURE : JT_FIXTURE;

test('decisionSync: full run — upsert on the exact identity expression, disappearance stop, attribution lists', async () => {
  const fake = fakeDecisionDb({ same: 0, total: 5 });
  const stats = await decisionSync({
    fetchTab: fetchFixtures, writeDb: fake.db as never, businessEntityId: BXR, todayIso: '2026-07-13',
  });
  assert.equal(stats.status, 'ok');
  assert.equal(stats.eh_rows_parsed, 8);
  assert.equal(stats.jt_stops_parsed, 2);
  assert.equal(stats.jt_stops_applied, 1);
  assert.equal(stats.jt_stops_unmatched, 1);
  assert.equal(stats.upserted, 8);
  assert.equal(stats.disappeared_marked_stopped, 2);
  assert.equal(fake.upsertSqls.length, 1);
  assert.match(
    fake.upsertSqls[0]!,
    /on conflict \(business_entity_id, facility_code, carrier_text, coalesce\(alpha_prefix, ''\), coalesce\(loc, ''\), coalesce\(hcpcs, ''\), coalesce\(rev_code, ''\)\) do update set/,
  );
  assert.match(fake.updateSqls[0]!, /set stopped_on = \$3/);
  // Attribution: no aliases exist → every distinct carrier is unmatched; catch-all flagged.
  assert.equal(stats.unmatched_carriers.length, 8);
  assert.deepEqual(stats.catchall_carriers, ['All other BCBS (Including Anthem)']);
});

test('decisionSync: unchanged hash is a no-op (no upsert, no disappearance marking)', async () => {
  // First compute the hash the sync will produce, by running once against an empty table…
  const first = fakeDecisionDb({ same: 0, total: 0 });
  const run1 = await decisionSync({ fetchTab: fetchFixtures, writeDb: first.db as never, businessEntityId: BXR, todayIso: '2026-07-13' });
  assert.equal(run1.status, 'ok');
  // …then claim every row already carries it.
  const second = fakeDecisionDb({ same: 8, total: 8 });
  const run2 = await decisionSync({ fetchTab: fetchFixtures, writeDb: second.db as never, businessEntityId: BXR, todayIso: '2026-07-13' });
  assert.equal(run2.status, 'noop');
  assert.equal(second.upsertSqls.length, 0);
  assert.equal(second.updateSqls.length, 0);
});

test('decisionSync: fetch/parse failure is fail-soft — zero writes, parse_failed status', async () => {
  const fake = fakeDecisionDb({ same: 0, total: 5 });
  const stats = await decisionSync({
    fetchTab: async () => { throw new Error('tab unavailable'); },
    writeDb: fake.db as never, businessEntityId: BXR,
  });
  assert.equal(stats.status, 'parse_failed');
  assert.equal(fake.upsertSqls.length, 0);
  assert.equal(fake.updateSqls.length, 0);
  assert.ok(stats.parse_notes.some((n) => n.includes('tab unavailable')));
});

test('decisionSync: EH parsing to zero decisions refuses to sync (wipeout guard)', async () => {
  const fake = fakeDecisionDb({ same: 0, total: 5 });
  const stats = await decisionSync({
    fetchTab: async (tab) => (tab === EH_TAB ? grid([[], ['nothing here']]) : JT_FIXTURE),
    writeDb: fake.db as never, businessEntityId: BXR,
  });
  assert.equal(stats.status, 'parse_failed');
  assert.equal(fake.upsertSqls.length, 0);
  assert.ok(stats.parse_notes.some((n) => n.includes('zero decisions')));
});
