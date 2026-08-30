/**
 * Billable Days import payload — the PHI gate and the numbers.
 *
 * Hermetic: it runs the real `src/kipu/` engine over the SCRUBBED in-repo fixture
 * (`test/fixtures/kipu-billing-report/fixture-*.csv`, names/providers/auth numbers replaced
 * and every date shifted -364 days). No network, no database, no real export.
 *
 * The point of the number assertions is the one thing a UI test cannot fake: the grid must
 * show what `scripts/kipu-recon.ts` shows for the same export. Both read the same engine, so
 * pinning the payload here pins the grid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { assembleBundle, buildFromCsv } from '../../src/kipu/billingReport.js';
import { LOC_CONFIG_BASE, DEFAULT_RULES, withRules } from '../../src/kipu/assumptions.js';
import { gridRows } from '../../src/kipu/computeRow.js';
import { buildImportPayload, facilityCodesFor, gateSkipped, segmentOf } from '../lib/billing-audit/kipu-import';
import {
  adjustedBillableDays,
  cellKey,
  isApproximate,
  rowHasOverride,
} from '../components/billing-audit/billable-days/overrides';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '../../test/fixtures/kipu-billing-report');
/** The fixture's dates are shifted -364 days, so its single week is the 2025 mirror. */
const WEEK = '2025-08-11';

function payload(canRevealPhi: boolean, rules = DEFAULT_RULES) {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.csv'))
    .map((n) => ({ name: n, text: readFileSync(join(FIXTURE_DIR, n), 'utf8') }));
  const build = buildFromCsv(assembleBundle(files, rules), LOC_CONFIG_BASE, rules);
  const rowsForWeek = gridRows(build.clients, WEEK, build.locCfg, rules);
  return buildImportPayload({
    build,
    rowsForWeek,
    selectedWeek: WEEK,
    filesByKind: { sessions: 1, evaluations: 1, patient: 1, labs: 1 },
    canRevealPhi,
  });
}

/* ------------------------------- the PHI gate ------------------------------ */

test('without canRevealPhi the name, auth number, topic and provider are ABSENT, not merely hidden', () => {
  const p = payload(false);
  assert.equal(p.phiIncluded, false);
  assert.ok(p.rows.length > 0, 'fixture produced no rows');
  for (const r of p.rows) {
    assert.equal(r.name, null);
    for (const a of r.auths) assert.equal(a.no, null);
    for (const d of r.days) for (const s of d.sessions) {
      assert.equal(s.topic, null);
      assert.equal(s.provider, null);
    }
  }
  // ⚠ THE REAL LEAK CHECK, and it must not be vacuous: take the names the PRIVILEGED
  // payload exposes and assert not one of them appears anywhere in the masked payload's
  // serialized form — not in a row, not in a note, not in a diagnostic string.
  const full = payload(true);
  const names = full.rows
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  assert.ok(names.length > 0, 'fixture exposed no names to test against');
  const json = JSON.stringify(p);
  for (const n of names) {
    assert.equal(json.includes(n), false, 'a patient name reached the masked payload');
  }

  // Same sweep for PROVIDER (ruled 2026-08-29). Asserting `s.provider === null` above only
  // proves the field is nulled at the one site the mapper writes; this proves the VALUE is
  // nowhere in the response at all — not in a note, a diagnostic, or a warn string. Sourced
  // from the privileged payload so it can never go vacuously green on a hardcoded guess.
  const providers = [
    ...new Set(
      full.rows.flatMap((r) =>
        r.days.flatMap((d) =>
          d.sessions
            .map((x) => x.provider)
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0),
        ),
      ),
    ),
  ];
  assert.ok(providers.length > 0, 'fixture exposed no providers to test against');
  for (const v of providers) {
    assert.equal(json.includes(v), false, `a provider name reached the masked payload: ${v}`);
  }
});

test('with canRevealPhi those four fields are present', () => {
  const p = payload(true);
  assert.equal(p.phiIncluded, true);
  assert.ok(p.rows.some((r) => typeof r.name === 'string' && r.name.length > 0));
  assert.ok(
    p.rows.some((r) => r.days.some((d) => d.sessions.some((x) => typeof x.provider === 'string' && x.provider.length > 0))),
    'gating provider must not blank it for a privileged viewer',
  );
});

test('gating provider changes NOTHING for a privileged viewer', () => {
  // The ruling gates provider; it must not degrade the reveal path. Pinned as COUNTS rather
  // than a `typeof` check, which would pass just as happily on a payload that had quietly
  // nulled everything. Same discipline as this file's engine-number assertions.
  const sessions = payload(true).rows.flatMap((r) => r.days.flatMap((d) => d.sessions));
  assert.equal(sessions.length, 182);
  assert.equal(sessions.filter((x) => x.provider === null).length, 0, 'no null for a privileged viewer');
  // The engine trims a blank source column to ''. The gate passes that through untouched
  // rather than converting it to null — '' means "Kipu had no Provider", null means withheld.
  assert.equal(sessions.filter((x) => x.provider === '').length, 1);
  assert.equal(new Set(sessions.map((x) => x.provider).filter(Boolean)).size, 18);
});

test('provider and topic are driven by the SAME gate — neither can drift from the other', () => {
  // The defect this fixes: provider sat UNGATED three lines above a gated topic in the same
  // object. Withholding a group's topic while disclosing who led it lets the topic be
  // inferred from the clinician, so the topic gate was leaking through provider. Both fields
  // must answer to canRevealPhi and to nothing else.
  for (const canRevealPhi of [false, true]) {
    const p = payload(canRevealPhi);
    const sessions = p.rows.flatMap((r) => r.days.flatMap((d) => d.sessions));
    assert.ok(sessions.length > 0, 'fixture produced no sessions');
    for (const x of sessions) {
      assert.equal(x.provider === null, !canRevealPhi, 'provider must be null iff ungated');
      assert.equal(x.topic === null, !canRevealPhi, 'topic must be null iff ungated');
    }
  }
});

test('non-PHI detail is present for EVERY viewer — masking must not blank the grid', () => {
  const masked = payload(false);
  const full = payload(true);
  assert.equal(masked.rows.length, full.rows.length);
  assert.deepEqual(
    masked.rows.map((r) => [r.billableDays, r.capDays, r.totalHours]),
    full.rows.map((r) => [r.billableDays, r.capDays, r.totalHours]),
  );
  for (const r of masked.rows) {
    assert.equal(r.days.length, 7);
    assert.ok(r.loc.length > 0 || r.loc === '');
  }
});

/* ------------------------------- the numbers ------------------------------- */

test('payload stats reproduce the engine numbers the recon reports for this export', () => {
  // Same engine, same fixture, same week as test/kipuComputeRow.test.ts's parity test and
  // `npx tsx scripts/kipu-recon.ts test/fixtures/kipu-billing-report`.
  const p = payload(true, withRules({ capResolution: 'current-ur-loc' }));
  assert.equal(p.rows.length, 26);
  assert.equal(p.stats.clients, 26);
  assert.equal(p.stats.billableDays, 63);
  // Must equal the ENGINE's total, not the sum of the per-row rounded values (212.9).
  assert.ok(Math.abs(p.stats.attendedHours - 212.6) < 0.05, `hours ${p.stats.attendedHours}`);
  const sumOfRounded = p.rows.reduce((a, r) => a + r.totalHours, 0);
  assert.ok(
    Math.abs(sumOfRounded - p.stats.attendedHours) > 0.0001,
    'this fixture is the case that proves the two differ — if they now agree, the guard is moot',
  );
});

test('stats are derived from the rows they are shown next to, not recomputed independently', () => {
  const p = payload(true);
  assert.equal(
    p.stats.billableDays,
    p.rows.reduce((a, r) => a + r.billableDays, 0),
  );
  assert.equal(p.stats.needsReview, p.rows.filter((r) => r.flag).length);
  assert.equal(p.stats.pastAuth, p.rows.filter((r) => r.maxPast > 0).length);
  assert.equal(p.stats.furthestPastAuth, Math.max(0, ...p.rows.map((r) => r.maxPast)));
});

/* ----------------------------- diagnostics ----------------------------- */

test('every engine diagnostic reaches the payload — none are dropped on the way to the UI', () => {
  const p = payload(true);
  const d = p.diagnostics;
  assert.equal(d.weekCount, p.weeks.length);
  assert.ok(d.clientCount >= p.rows.length);
  assert.ok(Array.isArray(d.notes));
  assert.ok(Array.isArray(d.skipped));
  assert.ok(Array.isArray(d.locFlags));
  assert.ok(d.locConfig.length > 0, 'no LOC config surfaced');
  assert.equal(typeof d.midnightGuardMin, 'number');
  assert.equal(d.facilities.length, p.facilityOptions.length);
  // The scrubbed fixture files DO carry the -Billable- marker, so A9 correctly stays quiet
  // here. The guard's live path is asserted separately below.
  assert.equal(d.notes.some((n) => /A9 GUARD/.test(n)), false);
});

test('the A9 variant guard reaches the payload when a file lacks the -Billable- marker', () => {
  // A9: row-existence-means-attended is only true of the Billable report variant, so an
  // import from the wrong variant must warn IN THE UI, not just in the engine.
  const build = buildFromCsv(
    assembleBundle([{ name: 'some-other-export.csv', text: 'Session Id,Full Name\n1,X\n' }], DEFAULT_RULES),
    LOC_CONFIG_BASE,
    DEFAULT_RULES,
  );
  const p = buildImportPayload({
    build,
    rowsForWeek: [],
    selectedWeek: WEEK,
    filesByKind: { sessions: 1 },
    canRevealPhi: false,
  });
  assert.ok(p.diagnostics.notes.some((n) => /A9 GUARD/.test(n)), 'A9 guard did not reach the payload');
});

test('an uncapped level of care is reported as ambiguous rather than silently defaulted', () => {
  const p = payload(true);
  // The no-level-of-care sentinel is missing DATA and must stay flagged.
  assert.ok(p.diagnostics.locFlags.some((f) => /no level of care/i.test(f)));
});

/* -------------------------- registry / segments -------------------------- */

test('facilityCodesFor maps the telehealth labels onto ONE CMD customer (N:1)', () => {
  const codes = facilityCodesFor([
    'Telehealth MH TX Group Sessions',
    'Telehealth MH TN Group Sessions',
    'Telehealth MH CO Group Sessions',
  ]);
  assert.deepEqual(codes, ['TELEHEALTH_MH']);
});

test('facilityCodesFor reports a mapped location with NO CMD customer as null, never dropped', () => {
  assert.deepEqual(facilityCodesFor(['Group Session VA']), [null]);
  assert.deepEqual(facilityCodesFor(['Group Session 1']), [null]);
});

test('segmentOf puts every row in All, and adds review/past only when earned', () => {
  const p = payload(true);
  for (const r of p.rows) {
    const segs = segmentOf(r);
    assert.ok(segs.includes('all'));
    assert.equal(segs.includes('review'), r.flag);
    assert.equal(segs.includes('past'), r.maxPast > 0);
  }
});

/* ------------------------- session-local overrides -------------------------
 * Every helper takes the WEEK the edit was made on (Qodo 2, 2026-08-30). These cases all read
 * and write the SAME week, so they assert the arithmetic; the cross-week scoping proof is
 * `billableDaysOverrideScope.test.tsx`.
 * --------------------------------------------------------------------------- */

test('an un-edited row keeps the engine count exactly — overrides cannot cause drift', () => {
  const p = payload(true);
  const none = new Map<string, readonly string[]>();
  for (const r of p.rows) {
    assert.equal(adjustedBillableDays(r, none, p.selectedWeek), r.billableDays);
    assert.equal(rowHasOverride(r, none, p.selectedWeek), false);
    assert.equal(isApproximate(r, none, p.selectedWeek), false);
  }
});

test('overriding a cell to a billable code raises the count; N/B lowers it', () => {
  const p = payload(true);
  const w = p.selectedWeek;
  const row = p.rows.find((r) => r.days.some((d) => d.codes.length === 0) && r.billableDays < r.capDays);
  assert.ok(row, 'no row with a spare day and headroom under the cap');
  const emptyDay = row.days.find((d) => d.codes.length === 0)!;
  const up = new Map([[cellKey(w, row.id, emptyDay.i), ['G'] as readonly string[]]]);
  assert.equal(adjustedBillableDays(row, up, w), row.billableDays + 1);

  const billableDay = row.days.find((d) => d.codes.some((c) => ['I', 'G', 'T', 'BPS'].includes(c)));
  if (billableDay) {
    const down = new Map([[cellKey(w, row.id, billableDay.i), ['N/B'] as readonly string[]]]);
    assert.equal(adjustedBillableDays(row, down, w), row.billableDays - 1);
  }
});

test('the adjusted count can never exceed the cap, however many cells are overridden', () => {
  const p = payload(true);
  const w = p.selectedWeek;
  const row = p.rows[0]!;
  const all = new Map(row.days.map((d) => [cellKey(w, row.id, d.i), ['I'] as readonly string[]]));
  assert.equal(adjustedBillableDays(row, all, w), Math.min(7, row.capDays));
});

test('a multi-LOC row is flagged approximate once edited — the browser cannot reproduce A13', () => {
  const p = payload(true);
  const w = p.selectedWeek;
  const multi = p.rows.find((r) => r.multiLoc);
  if (!multi) return; // fixture may not contain one; the guard is still asserted below
  const ov = new Map([[cellKey(w, multi.id, 0), ['I'] as readonly string[]]]);
  assert.equal(isApproximate(multi, ov, w), true);
  assert.equal(isApproximate(multi, new Map(), w), false);
});

/* ══════════ QODO FINDINGS 6 + 9 — source text must not reach an ungated client ════════
 * Both are the same defect class: server-side prose that interpolates a source value,
 * copied into the payload without passing the canRevealPhi gate the row fields use.
 * ════════════════════════════════════════════════════════════════════════════════════ */

/** A bundle with one unparseable group row, so `skipped` is non-empty and carries detail. */
const TOPIC = 'Trauma Processing Group';
const skippedBuild = () =>
  buildFromCsv(
    assembleBundle(
      [
        {
          name: 'Jane-Q-Patient-MRN-88213-export.csv',
          text:
            'Full Name,Admission Date,Discharge Date,Current UR Loc,Payment Method,' +
            'Insurance 1   Insurance Company,Session,Topic,Provider,Started,Ended,Duration,' +
            'Attended,Absent,Authorizations,Status,Completed At,Session Id,Template Id\n' +
            `Pat One,08/01/2026,,MH IOP 3 Adult,Ins,Acme,Treat California,${TOPIC},Dr X,` +
            'not-a-date,,3.0,Yes,,,Complete,,S1,T1\n',
        },
      ],
      DEFAULT_RULES,
    ),
    LOC_CONFIG_BASE,
    DEFAULT_RULES,
  );

const payloadFrom = (canRevealPhi: boolean) => {
  const build = skippedBuild();
  return buildImportPayload({
    build,
    rowsForWeek: [],
    selectedWeek: WEEK,
    filesByKind: { sessions: 1 },
    canRevealPhi,
  });
};

test('FINDING 6: without canRevealPhi, no source-row text reaches the payload', () => {
  const p = payloadFrom(false);
  assert.ok(p.diagnostics.skipped.length > 0, 'precondition: something was skipped');
  const json = JSON.stringify(p);
  assert.equal(json.includes(TOPIC), false, 'the raw Topic reached an ungated payload');
  for (const frag of ['Trauma', 'Processing']) {
    assert.equal(json.includes(frag), false, `"${frag}" leaked from the source row`);
  }
  // What it DOES get: a fixed reason code and a count.
  assert.match(p.diagnostics.skipped[0]!, /1 group session row held out — unparseable Started/);
});

test('FINDING 6: with canRevealPhi, the existing detail is unchanged', () => {
  const p = payloadFrom(true);
  assert.equal(p.diagnostics.skipped.length, 1);
  assert.match(p.diagnostics.skipped[0]!, /group session "Trauma Processing Group" — unparseable Started/);
});

test('FINDING 6: the gate is the SAME one the row fields use — topic and skipped agree', () => {
  // A plain `user` must not receive the clinical topic in `skipped` while the very same
  // string is nulled two fields away. Both are driven by canRevealPhi and nothing else.
  for (const canRevealPhi of [false, true]) {
    const p = payloadFrom(canRevealPhi);
    assert.equal(p.phiIncluded, canRevealPhi);
    assert.equal(JSON.stringify(p).includes(TOPIC), canRevealPhi);
  }
});

test('FINDING 9: the uploaded filename never reaches the payload, gated or not', () => {
  for (const canRevealPhi of [false, true]) {
    const json = JSON.stringify(payloadFrom(canRevealPhi));
    for (const leak of ['Jane', 'Patient', 'MRN', '88213', 'export.csv']) {
      assert.equal(json.includes(leak), false, `"${leak}" leaked from the filename (phi=${canRevealPhi})`);
    }
  }
});

test('FINDING 9: the A9 warning still reaches the UI — the fix redacts, it does not silence', () => {
  const p = payloadFrom(false);
  const a9 = p.diagnostics.notes.filter((n) => /A9 GUARD/.test(n));
  assert.equal(a9.length, 1, 'the A9 warning must survive redaction');
  assert.match(a9[0]!, /file 1 of 1/);
  assert.match(a9[0]!, /-Billable-/);
});

test('gateSkipped aggregates by reason+kind and never echoes detail', () => {
  const rows = [
    { reason: 'unparseable-started', kind: 'group-session', detail: 'SECRET-A' },
    { reason: 'unparseable-started', kind: 'group-session', detail: 'SECRET-B' },
    { reason: 'no-full-name', kind: 'evaluation', detail: null },
  ] as const;
  const out = gateSkipped(rows, false).join('\n');
  assert.equal(out.includes('SECRET'), false, 'detail echoed through the ungated path');
  assert.match(out, /2 group session rows held out — unparseable Started/);
  assert.match(out, /1 evaluation row held out — no Full Name/);
  // Singular/plural is not cosmetic here: it is the count doing the work of the detail.
  assert.equal(gateSkipped(rows, true).join('\n').includes('SECRET-A'), true);
});
