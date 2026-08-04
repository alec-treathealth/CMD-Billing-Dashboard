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
  flanksAreComparable,
  type DeriveScopeNoticeInput,
} from '../lib/qualify/scopeNotice';
import { ScopeNotice } from '../components/qualify/scope-notice';
import { BookKpiTiles } from '../components/qualify/overview';
import { derivePolicyRating } from '../lib/qualify/policyRating';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';
import { QUALIFY_TENANT_SCOPE } from '../lib/qualify/contract';
import type { QualifyBookKpis, QualifyFacility } from '../lib/qualify/contract';

const BASE: DeriveScopeNoticeInput = {
  rankedCount: 27,
  composedCount: 0,
  identifierSearched: true,
  rankingScope: { kind: 'payer', label: 'AETNA' },
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
  const n = deriveScopeNotice({ ...BASE, rankingScope: { kind: 'payer', label: null } });
  assert.ok(n);
  assert.ok(!/null|undefined/.test(n.headline + n.detail));
  assert.match(n.headline, /this payer-wide/);
});

// ── A COMPARABLE ranking is an estimate, and must never be called "payer-wide" ──────────────────
//
// Qodo review 2026-08-04 caught this: on comparable_employer / comparable_funding provenance the
// ranking is a peer COHORT assembled from similar plans, not the payer's own claims. Labelling that
// "AETNA-wide" asserts direct evidence we do not have — the one thing the honesty rules on this
// surface forbid outright.

test('an employer cohort is called an ESTIMATE, never payer-wide', () => {
  const n = deriveScopeNotice({ ...BASE, rankingScope: { kind: 'employer_cohort' } });
  assert.ok(n);
  assert.match(n.headline, /ESTIMATE from employers like this one/);
  assert.ok(!/-wide/.test(n.headline), 'must not claim payer-wide evidence');
  assert.match(n.detail, /cohort estimate, not this policy/);
});

test('a funding cohort says so distinctly — the two comparable paths are different claims', () => {
  const emp = deriveScopeNotice({ ...BASE, rankingScope: { kind: 'employer_cohort' } });
  const fund = deriveScopeNotice({ ...BASE, rankingScope: { kind: 'funding_cohort' } });
  assert.match(fund?.headline ?? '', /ESTIMATE from plans funded like this one/);
  assert.notEqual(emp?.headline, fund?.headline, 'employer and funding cohorts must not share copy');
});

test('the quiet INFO line also drops "payer behaviour" for a cohort — it is an estimate there', () => {
  const n = deriveScopeNotice({ ...BASE, composedCount: 412, rankingScope: { kind: 'funding_cohort' } });
  assert.ok(n);
  assert.equal(n.tone, 'info');
  assert.match(n.detail, /a cohort estimate, not this policy's track record/);
  assert.ok(!/payer behaviour/.test(n.detail));
});

test('no scope ever emits "null", "undefined" or an empty label', () => {
  for (const rankingScope of [
    { kind: 'payer' as const, label: null },
    { kind: 'payer' as const, label: 'AETNA' },
    { kind: 'employer_cohort' as const },
    { kind: 'funding_cohort' as const },
  ]) {
    for (const composedCount of [0, 412]) {
      const n = deriveScopeNotice({ ...BASE, rankingScope, composedCount });
      if (!n) continue;
      assert.ok(!/null|undefined/.test(n.headline + n.detail), `${rankingScope.kind} leaked a placeholder`);
    }
  }
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

// ── While the ranking is loading, every derived read must go quiet ──────────────────────────────
//
// Qodo review 2026-08-04: with a payer resolved but its snapshot still in flight, the left column
// shows "Loading facility ranking…" and NO cards. The container therefore passes an empty set during
// that window, and all three derived reads have to suppress themselves off it — otherwise the bar,
// the flanks and the notice describe a population that is not on screen, which is the original bug
// one layer down.

test('loading (empty ranked set) suppresses the notice, the flanks, and any policy claim', () => {
  assert.equal(deriveScopeNotice({ ...BASE, rankedCount: 0 }), null, 'no notice about an absent ranking');
  assert.equal(deriveFacilitySpread([]), null, 'no flanks');
  // And the policy rating must not be renderable: ratedCount 0 is what the container gates on.
  const pr = derivePolicyRating([]);
  assert.equal(pr.ratedCount, 0);
  assert.equal(pr.rating, null);
  // Its basis is a claim about DATA ("no facility clears the sample floor") and would be false about
  // a network fetch — which is why the container gates on an explicit loading flag and not on this.
  assert.match(pr.basis, /sample floor/);
});

// ── Review remediation, 2026-08-04 ──────────────────────────────────────────────────────────────

test('FLANKS OBEY THE SAMPLE GATE — a sub-floor facility cannot set the range', () => {
  // The card for a sub-floor facility renders '—' with NO percentage. Before the gate, that facility
  // could still set "Worst", so the tile named a facility carrying a number visible nowhere beneath
  // it. 61% of facility×payer rows sit under the floor, so the Worst flank was the expected victim.
  const thinButExtreme = { ...fac('THIN', 4), distinctPatients: 2 };
  const s = deriveFacilitySpread([fac('ALPHA', 62), fac('BETA', 41), thinButExtreme]);
  assert.equal(s?.worst.who, 'BETA', 'the sub-floor 4% must not become the Worst flank');
  assert.equal(s?.best.who, 'ALPHA');
  // Two rated facilities plus any number of sub-floor ones still works; fewer than two does not.
  assert.equal(deriveFacilitySpread([fac('ALPHA', 62), thinButExtreme]), null);
});

test('FLANK COMPARABILITY — flanks render only when the tiles and the ranking share a scope', () => {
  // Exactly one payer CHIP and no LOC lens is the only state where the two queries coincide.
  assert.equal(flanksAreComparable({ payerChipCount: 1, locActive: false }), true);
  // A payer DERIVED from an identifier does not count — the tiles were fetched with no payer at all,
  // so they are book-wide while the ranking is not. This was the flagship-path hole.
  assert.equal(flanksAreComparable({ payerChipCount: 0, locActive: false }), false);
  // Multiple payers: the ranking is single-payer by construction, the tiles are not.
  assert.equal(flanksAreComparable({ payerChipCount: 2, locActive: false }), false);
  // The LOC lens filters the ranking client-side but the KPI query takes no LOC argument — the tiles
  // even caption themselves "not LOC-scoped", so the headline could sit outside its own bracket.
  assert.equal(flanksAreComparable({ payerChipCount: 1, locActive: true }), false);
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

// The container narrows the flank population before calling this (Qodo review 2026-08-04): the tiles
// scope to payer + facility, the ranking is payer-wide, so unnarrowed flanks would name facilities
// outside the set the headline averages. These pin the two narrowing outcomes the container produces.
test('flanks over a FACILITY-NARROWED set describe only the selected facilities', () => {
  const ranked = [fac('ALPHA', 62), fac('BETA', 30), fac('GAMMA', 44)];
  const selected = new Set(['alpha', 'gamma']); // facilityKey values, as facilitySelection holds
  const narrowed = ranked.filter((f) => selected.has(f.facilityKey));
  const s = deriveFacilitySpread(narrowed);
  assert.equal(s?.best.who, 'ALPHA');
  assert.equal(s?.worst.who, 'GAMMA', 'BETA is outside the selection and cannot set the range');
  // Narrowing to ONE facility is not a range — the tile shows a headline with no flanks.
  assert.equal(deriveFacilitySpread(ranked.filter((f) => f.facilityKey === 'alpha')), null);
});

test('flanks are suppressed entirely when the tiles are book-wide but the ranking is not', () => {
  // The container passes [] for that case; the pure function must then produce nothing.
  assert.equal(deriveFacilitySpread([]), null);
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
