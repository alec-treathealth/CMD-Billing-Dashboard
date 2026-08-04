/**
 * SCOPE HONESTY — the rule this file defends: nothing on the Qualify screen may describe a population
 * other than the one it appears to describe, silently. These are the regressions that produced the
 * 2026-08-04 report — 27 ranked facilities showing $148,638 allowed next to "No charge lines match
 * these filters" and "$0 billed", with nothing on screen saying they were three different populations.
 *
 * Also covers the PHI boundary of the "On file" row (no employer, no group number, no dollars) and the
 * KPI flanks, which exist so a tile can never average a set it does not also bracket.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  deriveScopeNotice,
  deriveFacilitySpread,
  deriveOnFileTags,
  type DeriveScopeNoticeInput,
} from '../lib/qualify/scopeNotice';
import { ScopeNotice } from '../components/qualify/scope-notice';
import { BookKpiTiles } from '../components/qualify/overview';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';
import { QUALIFY_TENANT_SCOPE } from '../lib/qualify/contract';
import type { QualifyBookKpis, QualifyFacility } from '../lib/qualify/contract';

const BASE: DeriveScopeNoticeInput = {
  rankedCount: 27,
  composedCount: 0,
  identifierSearched: true,
  rankingPayerLabel: 'AETNA',
  windowLabel: '30d',
};

function fac(name: string, pct: number | null): QualifyFacility {
  return {
    ...QUALIFY_FACILITY_V2_NULLS,
    rank: 1,
    name,
    facilityKey: name.toLowerCase(),
    city: null,
    state: null,
    pctAllowedOfBilled: pct,
    rating: pct,
    streakSignal: null,
    billedAmount: null,
    allowedAmount: null,
    lineCount: 10,
    distinctPatients: 5,
    confirmedClaims: 10,
    estimateClaims: 0,
    unknownClaims: 0,
    careSetting: null,
    entity: 'BXR',
  };
}

// ── The reported bug ─────────────────────────────────────────────────────────────────────────────

test('THE REPORTED BUG: prefix → payer-wide ranking with zero matching lines is called out, by name', () => {
  const n = deriveScopeNotice(BASE);
  assert.ok(n, 'a notice must exist — this is the contradiction case');
  assert.equal(n.tone, 'warn');
  // It must say WHOSE history this is not, and name the payer, in the headline the rep reads first.
  assert.match(n.headline, /27 facilities/);
  assert.match(n.headline, /AETNA-wide/);
  assert.match(n.headline, /not this client's history/);
  // And it must tell them what to do instead of leaving them with a contradiction.
  assert.match(n.detail, /no charge lines in the 30d window/);
  assert.match(n.detail, /ask a biller/i);
});

test('no-identifier contradiction blames the FILTERS, not the client — a different fix for the rep', () => {
  const n = deriveScopeNotice({ ...BASE, identifierSearched: false });
  assert.ok(n);
  assert.equal(n.tone, 'warn');
  assert.match(n.headline, /27 facilities ranked, but no charge lines match your filters/);
  assert.match(n.detail, /facility, employer, funding, setting/);
  assert.ok(!/client/i.test(n.headline), 'must not imply a client when none was searched');
});

test('singular grammar at one facility', () => {
  const n = deriveScopeNotice({ ...BASE, rankedCount: 1, identifierSearched: false });
  assert.match(n?.headline ?? '', /1 facility ranked/);
});

test('a payer we cannot name degrades to "this payer", never to "null"', () => {
  const n = deriveScopeNotice({ ...BASE, rankingPayerLabel: null });
  assert.ok(n);
  assert.ok(!/null|undefined/.test(n.headline + n.detail));
  assert.match(n.headline, /this payer-wide/);
});

// ── Silence is also a requirement ───────────────────────────────────────────────────────────────

test('SILENT while the count is in flight — a warning that flashes per keystroke trains people to ignore it', () => {
  assert.equal(deriveScopeNotice({ ...BASE, composedCount: null }), null);
});

test('SILENT with an empty ranking — there is nothing on screen to misread', () => {
  assert.equal(deriveScopeNotice({ ...BASE, rankedCount: 0 }), null);
});

test('SILENT when no identifier was searched and rows DO match — the screen is self-consistent', () => {
  assert.equal(deriveScopeNotice({ ...BASE, composedCount: 412, identifierSearched: false }), null);
});

test('both populations non-empty + identifier → one quiet INFO, because they are still not the same set', () => {
  const n = deriveScopeNotice({ ...BASE, composedCount: 412 });
  assert.ok(n);
  assert.equal(n.tone, 'info');
  assert.match(n.headline, /Ranking is AETNA-wide; the rows below are this client's own claims/);
  assert.match(n.detail, /payer behaviour, not this policy's track record/);
});

// ── Render ───────────────────────────────────────────────────────────────────────────────────────

test('the notice renders as an ALERT when warning, a note when informational, and nothing when null', () => {
  const warn = renderToStaticMarkup(<ScopeNotice notice={deriveScopeNotice(BASE)} />);
  assert.match(warn, /role="alert"/);
  assert.match(warn, /data-tone="warn"/);
  assert.match(warn, /AETNA-wide/);
  const info = renderToStaticMarkup(<ScopeNotice notice={deriveScopeNotice({ ...BASE, composedCount: 412 })} />);
  assert.match(info, /data-tone="info"/);
  assert.ok(!/role="alert"/.test(info), 'an FYI must not shout like a failure');
  assert.equal(renderToStaticMarkup(<ScopeNotice notice={null} />), '');
});

// ── KPI flanks ──────────────────────────────────────────────────────────────────────────────────

test('flanks name the facilities that SET the range, rounded, worst and best', () => {
  const s = deriveFacilitySpread([fac('ALPHA', 62.4), fac('BETA', 29.6), fac('GAMMA', 44)]);
  assert.deepEqual(s, {
    worst: { label: 'Worst', value: 30, who: 'BETA' },
    best: { label: 'Best', value: 62, who: 'ALPHA' },
  });
});

test('flanks refuse a fake range: unrated facilities excluded, <2 scored, or a flat set → null', () => {
  assert.equal(deriveFacilitySpread([]), null);
  assert.equal(deriveFacilitySpread([fac('ALPHA', 62)]), null);
  assert.equal(deriveFacilitySpread([fac('ALPHA', 62), fac('BETA', null)]), null, 'null pct is not a 0%');
  assert.equal(deriveFacilitySpread([fac('ALPHA', 55), fac('BETA', 55)]), null, 'flat is not a spread');
});

test('the KPI allowed tile RENDERS the flanks — and only that tile, and never on a thin sample', () => {
  const kpis: QualifyBookKpis = {
    pctAllowedOfBilled: 44,
    pctPaidOfAllowed: 71,
    pctPaidOfBilled: 31,
    distinctPatients: 40,
    windowStart: '2026-07-05',
    windowEnd: '2026-08-04',
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
  const spread = deriveFacilitySpread([fac('ALPHA', 62), fac('BETA', 30)]);
  const html = renderToStaticMarkup(<BookKpiTiles kpis={kpis} locActive={false} spread={spread} />);
  assert.match(html, /Worst/);
  assert.match(html, /Best/);
  assert.match(html, /ALPHA/);
  assert.match(html, /BETA/);
  // Exactly one tile carries them — the allowed tile the ranking is built from.
  assert.equal((html.match(/Worst/g) ?? []).length, 1);
  // A sample too thin to show a confident headline must not show confident flanks either.
  const thin = renderToStaticMarkup(
    <BookKpiTiles kpis={{ ...kpis, distinctPatients: 1 }} locActive={false} spread={spread} />,
  );
  assert.ok(!/Worst/.test(thin), 'insufficient sample suppresses the flanks with the number');
  // No spread supplied → tiles render unchanged (the landing case).
  assert.ok(!/Worst/.test(renderToStaticMarkup(<BookKpiTiles kpis={kpis} locActive={false} />)));
});

// ── On-file tags + their PHI boundary ───────────────────────────────────────────────────────────

const POLICY = {
  carrier: 'AETNA',
  funding: 'Self-Funded',
  policyType: 'PPO',
  planType: 'OPEN ACCESS',
  network: null,
};

test('on-file tags carry the five plan-level facts, in order, network in the mono face', () => {
  const tags = deriveOnFileTags(POLICY);
  assert.deepEqual(tags.map((t) => t.label), ['Payer', 'Funding', 'Policy', 'Plan', 'Network']);
  assert.equal(tags[0]?.value, 'AETNA');
  assert.equal(tags[4]?.mono, true);
});

test('a null field says "not on file" — because "network unknown" and "in network" are different answers', () => {
  const tags = deriveOnFileTags(POLICY);
  const network = tags.find((t) => t.label === 'Network');
  assert.equal(network?.value, 'not on file');
  assert.equal(network?.missing, true);
  // Blank-but-present is treated as missing too, not rendered as an empty chip.
  assert.equal(deriveOnFileTags({ ...POLICY, funding: '   ' }).find((t) => t.label === 'Funding')?.missing, true);
});

test('PHI BOUNDARY: no employer, no group number, no dollar figure can appear in the tag row', () => {
  // The input type has no field for any of them; this pins the rendered output too, so a future
  // widening of the input cannot leak into the bar unnoticed.
  const json = JSON.stringify(deriveOnFileTags(POLICY));
  for (const forbidden of ['employer', 'group', '$', 'deductible', 'oop']) {
    assert.ok(!json.toLowerCase().includes(forbidden), `${forbidden} must never reach the on-file row`);
  }
});

test('no policy on file → no tag row at all, not five empty chips', () => {
  assert.deepEqual(deriveOnFileTags(null), []);
});
