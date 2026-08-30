/**
 * Kipu Billing Report import layer — hermetic tests.
 *
 * Two populations of tests:
 *  1. Unit tests over inline synthetic CSV text exercising every parser quirk the
 *     real export exhibits (BOM, 3-space header, quoted embedded newlines, telehealth
 *     attestations, multi-segment auth cells, header-signature file detection).
 *  2. An end-to-end pass over test/fixtures/kipu-billing-report — a PHI-free fixture
 *     DERIVED from the real 2026-08-21 export (see the fixture README): identities
 *     pseudonymized, every date shifted −364 days, structure preserved. The counts
 *     asserted here are the real export's counts, verified against the manual
 *     harness (scripts/test-kipu-report-import.mjs) on 2026-08-20.
 *
 * No DB, no network, no PHI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  parseCsv,
  stripAttestation,
  usDate,
  usDateTime,
  parseAuths,
  capFromFreq,
  classifyRows,
  assembleBundle,
  buildFromCsv,
  zoneFor,
  tzMismatch,
  minsFromMidnight,
  NO_LOC,
} from '../src/kipu/billingReport.js';
import {
  DEFAULT_RULES,
  LOC_CONFIG_BASE,
  isBillableReportFile,
  isMissedService,
  isBillableDocumentation,
  withRules,
} from '../src/kipu/assumptions.js';
import { locationFor } from '../src/kipu/locations.js';

const BOM = '﻿';
const ATTEST_LOC = ' - All encounters occur via real-time, interactive audio and video communication.';
const ATTEST_EVAL = ': The encounter occurred via real-time, interactive audio and video communication.';

const SESSIONS_HEADER =
  'Full Name,Admission Date,Discharge Date,Current UR Loc,Payment Method,Insurance 1   Insurance Company,Session,Topic,Provider,Started,Ended,Duration,Attended,Absent,Authorizations,Status,Completed At,Session Id,Template Id';
const EVALS_HEADER =
  'Full Name,Admission Date,Discharge Date,Current UR Loc,Payment Method,Insurance 1   Insurance Company,Evaluation,Signed By,Started,Ended,Duration,Authorizations,Status,Completed At,Evaluation Id,Template Id';
const PATIENT_HEADER =
  'Full Name,Admission Date,Discharge Date,Current UR Loc,Payment Method,Insurance 1   Insurance Company';

const q = (s: string): string => '"' + s.replace(/"/g, '""') + '"';

const AUTH_IOP = 'A-100, Start: 08/03/2026, End: 08/31/2026, Freq: 3 Day (M/W/F), LOC: MH IOP 3 Adult' + ATTEST_LOC;
const AUTH_OP = 'A-200, Start: 08/03/2026, End: 08/31/2026, Freq: , LOC: MH OP 2 Adult' + ATTEST_LOC;

function sessionRow(opts: {
  name?: string;
  loc?: string;
  session?: string;
  topic?: string;
  started?: string;
  ended?: string;
  duration?: string;
  auth?: string;
  status?: string;
}): string {
  const {
    name = 'Pat One',
    loc = 'MH IOP 3 Adult' + ATTEST_LOC,
    session = 'Telehealth MH TX Group Sessions' + ATTEST_EVAL,
    topic = 'Process Group',
    started = '08/10/2026 08:00 AM',
    ended = '08/10/2026 09:30 AM',
    duration = '1.5',
    auth = AUTH_IOP,
    status = 'Complete',
  } = opts;
  return [
    name, '08/01/2026', '', q(loc), 'Insurance', 'Acme Health', q(session), q(topic), 'Prov A',
    started, ended, duration, '10', '5', q(auth), status, '08/11/2026 09:00 AM', 'S1', 'T1',
  ].join(',');
}

function evalRow(opts: {
  name?: string;
  evaluation?: string;
  started?: string;
  ended?: string;
  duration?: string;
  auth?: string;
  status?: string;
}): string {
  const {
    name = 'Pat One',
    evaluation = 'New Progress Note' + ATTEST_EVAL,
    started = '08/11/2026 01:00 PM',
    ended = '08/11/2026 02:00 PM',
    duration = '1.0',
    auth = AUTH_IOP,
    status = 'Complete',
  } = opts;
  return [
    name, '08/01/2026', '', q('MH IOP 3 Adult' + ATTEST_LOC), 'Insurance', 'Acme Health',
    q(evaluation), 'Prov B', started, ended, duration, q(auth), status, '08/11/2026 03:00 PM', 'E1', 'T2',
  ].join(',');
}

const csv = (header: string, ...rows: string[]): string => BOM + [header, ...rows].join('\n') + '\n';

/* ------------------------------- parseCsv ------------------------------- */

test('parseCsv strips the BOM and collapses header whitespace to single spaces', () => {
  const rows = parseCsv(csv(PATIENT_HEADER, 'Pat One,08/01/2026,,MH OP 2 Adult,Insurance,Acme'));
  assert.equal(rows.length, 1);
  const first = rows[0];
  assert.ok(first);
  // The literal header carries THREE spaces; the parsed key must carry one.
  assert.equal(first['Insurance 1 Insurance Company'], 'Acme');
  assert.equal(first['Full Name'], 'Pat One');
});

test('parseCsv keeps embedded newlines and commas inside quoted fields as data', () => {
  const cell = 'line one, with comma\nline two';
  const rows = parseCsv(BOM + 'A,B\n' + q(cell) + ',x\n');
  const first = rows[0];
  assert.ok(first);
  assert.equal(first['A'], cell);
  assert.equal(first['B'], 'x');
});

test('parseCsv unescapes doubled quotes and drops all-blank rows', () => {
  const rows = parseCsv('A,B\n"say ""hi""",y\n,\n');
  assert.equal(rows.length, 1);
  const first = rows[0];
  assert.ok(first);
  assert.equal(first['A'], 'say "hi"');
});

/* ----------------------------- normalisers ------------------------------ */

test('stripAttestation removes the LOC-form attestation suffix', () => {
  assert.equal(stripAttestation('MH IOP 3 Adult' + ATTEST_LOC), 'MH IOP 3 Adult');
});

test('stripAttestation removes the evaluation-form attestation suffix', () => {
  assert.equal(stripAttestation('New Progress Note' + ATTEST_EVAL), 'New Progress Note');
});

test('stripAttestation removes "- import" markers and trailing dashes', () => {
  assert.equal(stripAttestation('*LOCUS Assessment ' + ATTEST_EVAL + ' - import'), '*LOCUS Assessment');
  assert.equal(stripAttestation('New Progress Note' + ATTEST_EVAL + ' -'), 'New Progress Note');
  assert.equal(stripAttestation('Plain Name'), 'Plain Name');
});

test('usDate parses MM/DD/YYYY and rejects everything else', () => {
  assert.equal(usDate('08/17/2026'), '2026-08-17');
  assert.equal(usDate('8/3/2026'), '2026-08-03');
  assert.equal(usDate('2026-08-17'), null);
  assert.equal(usDate(''), null);
});

test('usDateTime parses a US wall-clock timestamp and rejects a bare date', () => {
  assert.deepEqual(usDateTime('08/17/2026 06:00 PM'), { date: '2026-08-17', time: '06:00 PM' });
  assert.equal(usDateTime('08/17/2026'), null);
  assert.equal(usDateTime(''), null);
});

test('parseAuths splits newline-separated segments and strips the LOC attestation', () => {
  const auths = parseAuths(AUTH_IOP + '\n' + AUTH_OP);
  assert.equal(auths.length, 2);
  const a = auths[0];
  const b = auths[1];
  assert.ok(a && b);
  assert.equal(a.no, 'A-100');
  assert.equal(a.start, '2026-08-03');
  assert.equal(a.end, '2026-08-31');
  assert.equal(a.freq, '3 Day (M/W/F)');
  assert.equal(a.loc, 'MH IOP 3 Adult');
  assert.equal(b.freq, '');
  assert.equal(b.loc, 'MH OP 2 Adult');
});

test('parseAuths keeps the "No Auth Required" literal and drops malformed lines', () => {
  const auths = parseAuths(
    'No Auth Required, Start: 08/10/2026, End: 10/05/2026, Freq: , LOC: MH OP 3 Adult\nnot an auth line',
  );
  assert.equal(auths.length, 1);
  const a = auths[0];
  assert.ok(a);
  assert.equal(a.no, 'No Auth Required');
});

test('capFromFreq reads the leading day count and returns null when unparseable', () => {
  assert.equal(capFromFreq('3 Day (M/W/F)'), 3);
  assert.equal(capFromFreq('2 Day'), 2);
  assert.equal(capFromFreq(''), null);
  assert.equal(capFromFreq('Weekly'), null);
});

/* --------------------------- file classification ------------------------ */

test('classifyRows detects each file kind by header signature, never by filename', () => {
  assert.equal(classifyRows(parseCsv(csv(SESSIONS_HEADER, sessionRow({})))), 'sessions');
  assert.equal(classifyRows(parseCsv(csv(EVALS_HEADER, evalRow({})))), 'evaluations');
  assert.equal(classifyRows(parseCsv(csv(PATIENT_HEADER, 'Pat One,08/01/2026,,MH OP 2 Adult,Insurance,Acme'))), 'patient');
  assert.equal(classifyRows(parseCsv('Full Name,Specimen,Vendor\nPat One,x,y\n')), 'labs');
  assert.equal(classifyRows([]), 'empty');
  assert.equal(classifyRows(parseCsv('X,Y\n1,2\n')), 'unknown');
});

/* ------------------------------ timezone map ---------------------------- */

test('zoneFor maps facility labels by state name or word-bounded abbreviation', () => {
  assert.equal(zoneFor('Telehealth MH TX')?.label, 'Central');
  assert.equal(zoneFor('Treat Mental Health California LLC')?.label, 'Pacific');
  assert.equal(zoneFor('Some Unmapped Facility'), null);
});

test('tzMismatch reports Kipu-declared zones that disagree with the state, with a delta', () => {
  const hit = tzMismatch('Treat Mental Health Colorado');
  assert.ok(hit);
  assert.equal(hit.ours, 'Mountain');
  assert.equal(hit.deltaH, 2);
  assert.equal(tzMismatch('Telehealth MH TX'), null);
});

test('minsFromMidnight measures distance to the nearest midnight on either side', () => {
  assert.equal(minsFromMidnight('12:00 AM'), 0);
  assert.equal(minsFromMidnight('11:30 PM'), 30);
  assert.equal(minsFromMidnight('10:00 AM'), 600);
  assert.equal(minsFromMidnight('bogus'), null);
});

/* ------------------------------ A9 guard -------------------------------- */

test('A9: isBillableReportFile requires the -Billable- variant marker', () => {
  assert.equal(isBillableReportFile('54-billing-report-billing-Billable-AUG_21_2026_0128-Sessions.csv'), true);
  assert.equal(isBillableReportFile('54-billing-report-Scheduled-AUG_21_2026-Sessions.csv'), false);
});

test('A9: assembleBundle classifies by header signature and warns loudly on a non-Billable filename', () => {
  // Filename says labs; headers say sessions. Headers must win.
  const bundle = assembleBundle([{ name: 'export-Labs.csv', text: csv(SESSIONS_HEADER, sessionRow({})) }]);
  assert.equal(bundle.sessions.length, 1);
  assert.equal(bundle.labs.length, 0);
  assert.equal(bundle.variantWarnings.length, 1);
  const warning = bundle.variantWarnings[0];
  assert.ok(warning);
  assert.match(warning, /A9/);
  assert.match(warning, /-Billable-/);
  // Qodo finding 9: the FILENAME must not appear. It is user-supplied text from a
  // PHI-bearing export, and this warning is published to the browser verbatim.
  assert.equal(warning.includes('export-Labs.csv'), false, 'the raw filename leaked into the A9 warning');
  assert.equal(warning.includes('export-Labs'), false);
  // It is identified positionally instead, with the CONTENT-detected kind.
  assert.match(warning, /file 1 of 1/);
  assert.match(warning, /detected kind: sessions/);
});

test('A9: a filename carrying patient-looking text never reaches the warning', () => {
  const bundle = assembleBundle([
    { name: 'Jane-Q-Patient-MRN-88213-export.csv', text: csv(SESSIONS_HEADER, sessionRow({})) },
  ]);
  const warning = bundle.variantWarnings[0];
  assert.ok(warning);
  for (const leak of ['Jane', 'Patient', 'MRN', '88213', '.csv']) {
    assert.equal(warning.includes(leak), false, `"${leak}" leaked from the filename into the A9 warning`);
  }
});

test('A9 positional identification stays correct across several files', () => {
  const bundle = assembleBundle([
    { name: 'a-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({})) },
    { name: 'secret-name.csv', text: csv(EVALS_HEADER, evalRow({})) },
  ]);
  assert.equal(bundle.variantWarnings.length, 1, 'only the non-Billable file warns');
  assert.match(bundle.variantWarnings[0]!, /file 2 of 2/);
  assert.match(bundle.variantWarnings[0]!, /detected kind: evaluations/);
  assert.equal(bundle.variantWarnings[0]!.includes('secret-name'), false);
});

test('A9: no warning for -Billable- filenames, and the guard is switchable off', () => {
  const ok = assembleBundle([{ name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({})) }]);
  assert.equal(ok.variantWarnings.length, 0);
  const off = assembleBundle(
    [{ name: 'anything.csv', text: csv(SESSIONS_HEADER, sessionRow({})) }],
    withRules({ requireBillableVariant: false }),
  );
  assert.equal(off.variantWarnings.length, 0);
});

test('A9: variant warnings surface in buildFromCsv notes', () => {
  const bundle = assembleBundle([{ name: 'plain.csv', text: csv(SESSIONS_HEADER, sessionRow({})) }]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  assert.ok(b.notes.some((n) => /A9/.test(n)));
});

/* ------------------------- A10 — PROVISIONAL ----------------------------- */

test('A10: a non-Complete session is kept but not billable, with a note naming A10', () => {
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ status: 'Ready For Review' })) },
  ]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  const c = b.clients[0];
  assert.ok(c);
  const s = c.sessions[0];
  assert.ok(s);
  assert.equal(s.billable, false);
  assert.equal(s.status, 'Ready For Review');
  assert.ok(b.notes.some((n) => /A10/.test(n) && /Ready For Review/.test(n)));
});

test('A10 is switchable: widening billableStatuses flips the same row to billable', () => {
  const rules = withRules({ billableStatuses: new Set(['Complete', 'Ready For Review']) });
  const bundle = assembleBundle(
    [{ name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ status: 'Ready For Review' })) }],
    rules,
  );
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE, rules);
  const c = b.clients[0];
  assert.ok(c);
  const s = c.sessions[0];
  assert.ok(s);
  assert.equal(s.billable, true);
  assert.equal(b.notes.filter((n) => /A10/.test(n)).length, 0);
});

test('A10: isBillableDocumentation consults the rules, not a hardcoded literal', () => {
  assert.equal(isBillableDocumentation('Complete', DEFAULT_RULES), true);
  assert.equal(isBillableDocumentation('In Use', DEFAULT_RULES), false);
  assert.equal(
    isBillableDocumentation('In Use', withRules({ billableStatuses: new Set(['Complete', 'In Use']) })),
    true,
  );
});

/* ----------------------------- A12 -------------------------------------- */

test('A12: a Missed Therapy Session is never billable even when Complete', () => {
  const bundle = assembleBundle([
    {
      name: 'x-Billable-Evaluations.csv',
      text: csv(EVALS_HEADER, evalRow({ evaluation: 'Missed Therapy Session', duration: '0.08' })),
    },
  ]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  const c = b.clients[0];
  assert.ok(c);
  const s = c.sessions[0];
  assert.ok(s);
  assert.equal(s.billable, false);
  assert.ok(b.notes.some((n) => /A12/.test(n)));
});

test('A12: a 0.00-hour evaluation is not billable — it is a date-only placeholder, not a service', () => {
  const bundle = assembleBundle([
    {
      name: 'x-Billable-Evaluations.csv',
      text: csv(EVALS_HEADER, evalRow({ duration: '0.0', ended: '' })),
    },
  ]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  const c = b.clients[0];
  assert.ok(c);
  const s = c.sessions[0];
  assert.ok(s);
  assert.equal(s.billable, false);
});

test('A12 predicates are individually switchable for reconciliation experiments', () => {
  assert.equal(isMissedService('Missed Follow Up Psychiatry Evaluation'), true);
  assert.equal(isMissedService('New Progress Note'), false);
  const zeroOk = withRules({ zeroHourNeverBillable: false });
  const missedOk = withRules({ missedNeverBillable: false });
  const zeroBundle = assembleBundle(
    [{ name: 'x-Billable-Evaluations.csv', text: csv(EVALS_HEADER, evalRow({ duration: '0.0', ended: '' })) }],
    zeroOk,
  );
  const zc = buildFromCsv(zeroBundle, LOC_CONFIG_BASE, zeroOk).clients[0];
  assert.ok(zc);
  assert.equal(zc.sessions[0]?.billable, true);
  const missedBundle = assembleBundle(
    [{ name: 'x-Billable-Evaluations.csv', text: csv(EVALS_HEADER, evalRow({ evaluation: 'Missed Therapy Session', duration: '0.5' })) }],
    missedOk,
  );
  const mc = buildFromCsv(missedBundle, LOC_CONFIG_BASE, missedOk).clients[0];
  assert.ok(mc);
  assert.equal(mc.sessions[0]?.billable, true);
});

/* ----------------------- client assembly details ------------------------ */

test('auth segments are unioned across rows and deduped on (no, start, end, loc)', () => {
  const bundle = assembleBundle([
    {
      name: 'x-Billable-Sessions.csv',
      text: csv(
        SESSIONS_HEADER,
        sessionRow({ auth: AUTH_IOP }),
        sessionRow({ topic: 'Second Group', started: '08/11/2026 08:00 AM', ended: '08/11/2026 09:30 AM', auth: AUTH_IOP + '\n' + AUTH_OP }),
      ),
    },
  ]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  const c = b.clients[0];
  assert.ok(c);
  assert.equal(c.auths.length, 2);
});

test('the container label is kept VERBATIM as the registry key — no stripping, no inference', () => {
  const bundle = assembleBundle([{ name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({})) }]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  // Verbatim, attestation removed but "Group Sessions" INTACT. The old code stripped that
  // suffix, which worked for exactly the three telehealth labels and mangled the other eight.
  assert.deepEqual(b.facilities, ['Telehealth MH TX Group Sessions']);
  const c = b.clients[0];
  assert.ok(c);
  assert.equal(c.facility, 'Telehealth MH TX Group Sessions');
  assert.deepEqual(c.labels, ['Telehealth MH TX Group Sessions']);
  // The label is carried on the SESSION too, which is what makes multi-label exports work.
  assert.equal(c.sessions[0]?.label, 'Telehealth MH TX Group Sessions');
  // And it resolves through the registry to the ONE telehealth CMD account.
  assert.equal(locationFor(c.facility)?.facilityCode, 'TELEHEALTH_MH');
});

test('an unmapped container label FAILS THE BUILD rather than being inferred', () => {
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ session: 'Telehealth MH AZ Group Sessions' })) },
  ]);
  assert.throws(() => buildFromCsv(bundle, LOC_CONFIG_BASE), /Unmapped Kipu session-container label/);
  // The escape hatch exists for probing a new export, and it must NOT be the default.
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE, withRules({ allowUnmappedLocations: true }));
  assert.deepEqual(b.facilities, ['Telehealth MH AZ Group Sessions']);
  assert.ok(b.notes.some((n) => /not in the location registry/.test(n)));
});

test('two labels under ONE customer are not flagged; two customers are', () => {
  // Both Texas containers → TREAT_TX. Expected shape, no warning.
  const sameCustomer = buildFromCsv(
    assembleBundle([
      {
        name: 'x-Billable-Sessions.csv',
        text: csv(
          SESSIONS_HEADER,
          sessionRow({ session: 'TX Group Session' }),
          sessionRow({ session: 'Scott & Jenny Group Session TX', started: '08/11/2026 08:00 AM', ended: '08/11/2026 09:30 AM' }),
        ),
      },
    ]),
    LOC_CONFIG_BASE,
  );
  const same = sameCustomer.clients[0];
  assert.ok(same);
  assert.equal(same.labels.length, 2);
  assert.ok(!same.warn.some((w) => /different CMD customers/.test(w)));

  // Texas + Telehealth → two customers. Must be flagged, never picked.
  const crossCustomer = buildFromCsv(
    assembleBundle([
      {
        name: 'x-Billable-Sessions.csv',
        text: csv(
          SESSIONS_HEADER,
          sessionRow({ session: 'TX Group Session' }),
          sessionRow({ session: 'Telehealth MH TX Group Sessions', started: '08/11/2026 08:00 AM', ended: '08/11/2026 09:30 AM' }),
        ),
      },
    ]),
    LOC_CONFIG_BASE,
  );
  const cross = crossCustomer.clients[0];
  assert.ok(cross);
  assert.ok(cross.warn.some((w) => /different CMD customers/.test(w)), cross.warn.join(' | '));
});

test('MRN has no source in the export and stays blank — never faked', () => {
  const bundle = assembleBundle([{ name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({})) }]);
  const c = buildFromCsv(bundle, LOC_CONFIG_BASE).clients[0];
  assert.ok(c);
  assert.equal(c.mrn, '');
});

test('a patient with no Current UR Loc falls back to the NO_LOC sentinel and is warned', () => {
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc: '' })) },
  ]);
  const c = buildFromCsv(bundle, LOC_CONFIG_BASE).clients[0];
  assert.ok(c);
  assert.equal(c.loc, NO_LOC);
  assert.ok(c.warn.some((w) => /No Current UR Loc/.test(w)));
});

test('A13: auths spanning two levels of care put a warning naming A13 on the client', () => {
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ auth: AUTH_IOP + '\n' + AUTH_OP })) },
  ]);
  const c = buildFromCsv(bundle, LOC_CONFIG_BASE).clients[0];
  assert.ok(c);
  assert.ok(c.warn.some((w) => /A13/.test(w) && /2 levels of care/.test(w)));
});

/* ------------------- A11 — config first, Freq fallback ------------------- */

test('A11: a hand-kept config entry wins over a conflicting auth Freq', () => {
  // Auth says 3 days; config says 4 for this LOC. Config is the owned source.
  const auth = 'A-1, Start: 08/03/2026, End: 08/31/2026, Freq: 3 Day (M/W/F), LOC: MH IOP 4 Adult' + ATTEST_LOC;
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc: 'MH IOP 4 Adult' + ATTEST_LOC, auth })) },
  ]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  assert.equal(b.locCfg['MH IOP 4 Adult']?.capDays, 4);
  assert.equal(b.locCfg['MH IOP 4 Adult']?.ambiguous, undefined);
});

test('A11: with no config entry the cap derives from the auth Freq and is flagged ambiguous', () => {
  const auth = 'A-1, Start: 08/03/2026, End: 08/31/2026, Freq: 5 Day (M-F), LOC: MH PHP Adult';
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc: 'MH PHP Adult', auth })) },
  ]);
  const b = buildFromCsv(bundle, {});
  assert.equal(b.locCfg['MH PHP Adult']?.capDays, 5);
  assert.equal(b.locCfg['MH PHP Adult']?.ambiguous, true);
  assert.ok(b.locFlags.some((f) => /taken from the authorisation Freq/.test(f)));
});

test('A11: neither config nor Freq leaves the LOC uncapped, ambiguous, and loudly flagged', () => {
  const auth = 'A-1, Start: 08/03/2026, End: 08/31/2026, Freq: , LOC: MH OP 5 Adult';
  const bundle = assembleBundle([
    { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc: 'MH OP 5 Adult', auth })) },
  ]);
  const b = buildFromCsv(bundle, {});
  assert.equal(b.locCfg['MH OP 5 Adult']?.capDays, 7);
  assert.equal(b.locCfg['MH OP 5 Adult']?.ambiguous, true);
  assert.ok(b.locFlags.some((f) => /left UNCAPPED/.test(f)));
});

test('weeks are Monday-start, newest first, covering every session date', () => {
  const bundle = assembleBundle([
    {
      name: 'x-Billable-Sessions.csv',
      text: csv(
        SESSIONS_HEADER,
        sessionRow({ started: '08/10/2026 08:00 AM', ended: '08/10/2026 09:30 AM' }),
        sessionRow({ topic: 'Older', started: '07/29/2026 08:00 AM', ended: '07/29/2026 09:30 AM' }),
      ),
    },
  ]);
  const b = buildFromCsv(bundle, LOC_CONFIG_BASE);
  assert.deepEqual(
    b.weeks.map((w) => w.id),
    ['2026-08-10', '2026-08-03', '2026-07-27'],
  );
  const first = b.weeks[0];
  assert.ok(first);
  assert.match(first.label, /Aug 10/);
});

/* --------------------- fixture end-to-end (real shape) ------------------- */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/kipu-billing-report/', import.meta.url));

function loadFixture() {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.csv'))
    .map((name) => ({ name, text: readFileSync(join(FIXTURE_DIR, name), 'utf8') }));
  return assembleBundle(files);
}

test('fixture: the four files classify by signature and carry no A9 warning', () => {
  const bundle = loadFixture();
  assert.equal(bundle.sessions.length, 122);
  assert.equal(bundle.evaluations.length, 61);
  assert.equal(bundle.patient.length, 27);
  assert.equal(bundle.labs.length, 0);
  assert.equal(bundle.variantWarnings.length, 0);
});

test('fixture: buildFromCsv reproduces the real export shape (harness-verified counts)', () => {
  const b = buildFromCsv(loadFixture(), LOC_CONFIG_BASE);
  assert.equal(b.clients.length, 27);
  const n = (k: (s: { kind: string; billable: boolean }) => boolean) =>
    b.clients.reduce((a, c) => a + c.sessions.filter(k).length, 0);
  assert.equal(n((s) => s.kind === 'group'), 122);
  assert.equal(n((s) => s.kind !== 'group'), 61);
  assert.equal(n((s) => s.kind === 'bps'), 1);
  assert.equal(n((s) => s.billable === false), 31);
  assert.deepEqual(b.weeks.map((w) => w.id), ['2025-08-11']); // real 2026-08-10, −364d
  assert.deepEqual(b.facilities, ['Telehealth MH TX Group Sessions']);
  assert.equal(b.skipped.length, 0);
  assert.equal(
    b.clients.reduce((a, c) => a + c.auths.length, 0),
    26,
  );
  assert.equal(b.clients.filter((c) => c.warn.length > 0).length, 3);
});

test('fixture: LOC config synthesis — the OP ladder is configured, only a MISSING LOC is uncapped', () => {
  // ⚠ THIS TEST ASSERTED 'OP/7?' FOR MH OP 3 AND MH OP 5 UNTIL 2026-08-27. Those two had no
  // config entry and no parseable auth Freq, so they fell back to uncapped-and-flagged
  // rather than being guessed. Alec ruled the OP ladder (OP-N = N billable days on the OP
  // track), so they are now real config and the fallback no longer fires for them.
  //
  // What SHOULD still fall back is a client with no level of care in the export at all:
  // that is missing DATA, not a missing rule, and no ruling can supply it.
  const b = buildFromCsv(loadFixture(), LOC_CONFIG_BASE);
  const cap = (loc: string) => {
    const e = b.locCfg[loc];
    assert.ok(e, 'missing locCfg for ' + loc);
    return `${e.track}/${e.capDays}${e.ambiguous ? '?' : ''}`;
  };
  assert.equal(cap('MH IOP 3 Adult'), 'IOP/3');
  assert.equal(cap('MH IOP 4 Adult'), 'IOP/4');
  assert.equal(cap('MH OP 5 Adult'), 'OP/5');
  assert.equal(cap('MH OP 3 Adult'), 'OP/3');
  assert.equal(cap(NO_LOC), 'OP/7?');
  // Exactly one uncapped LOC now, and it is the no-level-of-care sentinel.
  const uncapped = b.locFlags.filter((f) => /UNCAPPED|uncapped/.test(f));
  assert.equal(uncapped.length, 1);
  assert.match(uncapped[0]!, /no level of care/i);
});

test('fixture: harness invariants hold — attestations stripped, auth windows parsed, tz mapped', () => {
  const b = buildFromCsv(loadFixture(), LOC_CONFIG_BASE);
  for (const c of b.clients) {
    assert.ok(c.id && c.name);
    assert.ok(!/encounter/i.test(c.loc));
    for (const s of c.sessions) {
      assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isFinite(s.hrs));
      assert.ok(!/via real-time/i.test(s.topic));
      if (isMissedService(s.topic) || s.hrs === 0) assert.equal(s.billable, false);
      if (s.status && s.status !== 'Complete') assert.equal(s.billable, false);
    }
    for (const a of c.auths) {
      assert.match(a.start, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(a.end, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(!/via real-time/i.test(a.loc));
    }
  }
  assert.equal(b.tzUnknown.length, 0);
  assert.equal(b.tzFlags.length, 0);
  assert.equal(b.boundary.length, 1);
  assert.equal(b.boundary.filter((x) => x.billable).length, 0);
});

/* ══════════ THE ANTI-DERIVATION GUARD (ruled 2026-08-29) ══════════════════════════════
 * MH IOP 1/2/3 are enumerated, never parsed. A level that merely LOOKS like the pattern
 * must not be absorbed by it: `MH IOP 9 Adult` has to land in the ambiguous fallback and
 * be flagged by name, so a human confirms the cap instead of a regex inventing one.
 * ════════════════════════════════════════════════════════════════════════════════════ */

test('a level that LOOKS like MH IOP N is NOT given a cap parsed from its digit', () => {
  assert.equal(LOC_CONFIG_BASE['MH IOP 9 Adult'], undefined, 'precondition: 9 is unmapped');
  const b = buildFromCsv(
    assembleBundle([
      { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc: 'MH IOP 9 Adult' })) },
    ]),
    LOC_CONFIG_BASE,
  );
  const e = b.locCfg['MH IOP 9 Adult'];
  assert.ok(e, 'the level must still be synthesised, not dropped');
  // THE ASSERTION THAT MATTERS: the trailing 9 must not have become a cap of 9.
  assert.notEqual(e.capDays, 9, 'a digit parser leaked in — the ruling is enumerate, not derive');
  assert.equal(e.ambiguous, true, 'an unmapped level must be marked ambiguous');
  assert.equal(e.capDays, 7, 'with no parseable auth Freq it falls back to uncapped');
});

test('the unmapped level is FLAGGED BY NAME — it fails loudly rather than silently', () => {
  const b = buildFromCsv(
    assembleBundle([
      { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc: 'MH IOP 9 Adult' })) },
    ]),
    LOC_CONFIG_BASE,
  );
  const named = b.locFlags.filter((f) => f.includes('MH IOP 9 Adult'));
  assert.equal(named.length, 1, 'exactly one flag naming the unmapped level');
  assert.match(named[0]!, /no config entry/i);
});

test('the four ENUMERATED IOP levels produce no ambiguity flag — only unmapped ones do', () => {
  for (const loc of ['MH IOP 1 Adult', 'MH IOP 2 Adult', 'MH IOP 3 Adult', 'MH IOP 4 Adult']) {
    const b = buildFromCsv(
      assembleBundle([{ name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc })) }]),
      LOC_CONFIG_BASE,
    );
    assert.equal(b.locCfg[loc]?.ambiguous, undefined, `${loc} should be a clean enumerated entry`);
    assert.equal(b.locFlags.filter((f) => f.includes(loc)).length, 0, `${loc} should raise no flag`);
  }
});

test('MH OP N is not reachable from the IOP rule — an OP level keeps OP semantics', () => {
  // Guards constraint 2 at the synthesis layer as well as the config layer.
  for (const n of [1, 2, 3, 4, 5]) {
    const loc = `MH OP ${n} Adult`;
    const b = buildFromCsv(
      assembleBundle([{ name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ loc })) }]),
      LOC_CONFIG_BASE,
    );
    const e = b.locCfg[loc];
    assert.ok(e, `${loc} missing`);
    assert.equal(e.track, 'OP');
    assert.equal(e.minHours, 0);
    assert.equal(e.capDays, n);
  }
});


/* ══════════ QODO FINDING 6 — skipped rows carry source text as STRUCTURE ══════════════
 * The parser keeps the detail (it is server-side and the recon needs it); splitting reason
 * from detail is what lets the payload drop one and keep the other.
 * ════════════════════════════════════════════════════════════════════════════════════ */

test('a skipped row records reason + kind + detail separately, not as one baked string', () => {
  const b = buildFromCsv(
    assembleBundle([
      {
        name: 'x-Billable-Sessions.csv',
        text: csv(SESSIONS_HEADER, sessionRow({ topic: 'Trauma Processing Group', started: 'not-a-date' })),
      },
    ]),
    LOC_CONFIG_BASE,
  );
  assert.equal(b.skipped.length, 1);
  const row = b.skipped[0]!;
  assert.equal(row.reason, 'unparseable-started');
  assert.equal(row.kind, 'group-session');
  assert.equal(row.detail, 'Trauma Processing Group');
});

test('a row skipped for no Full Name carries NO detail — there is no source text to keep', () => {
  const b = buildFromCsv(
    assembleBundle([
      { name: 'x-Billable-Sessions.csv', text: csv(SESSIONS_HEADER, sessionRow({ name: '', topic: 'Trauma Processing Group' })) },
    ]),
    LOC_CONFIG_BASE,
  );
  assert.equal(b.skipped.length, 1);
  assert.equal(b.skipped[0]!.reason, 'no-full-name');
  assert.equal(b.skipped[0]!.detail, null);
});
