/**
 * KPI-TILE FLANKS — worst/best facility on each of the three headline metrics.
 *
 * Two rules are defended here, and they pull against each other on purpose:
 *
 *   1. SHOW THEM. Alec's ruling 2026-08-04: the flanks are a requested feature and they belong on ALL
 *      THREE tiles, not just the allowed one. The previous pass gated them behind a comparability test
 *      that suppressed them on the identifier-search path — the flagship path — so in practice they
 *      never appeared. This suite pins that they render on the paths a rep actually uses.
 *
 *   2. NEVER UNLABELLED, AND NEVER FABRICATED. Each flank is that tile's OWN metric; a null percentage
 *      is not a 0%; a facility whose card shows '—' cannot set a range; and the set the flanks come
 *      from is always named on screen (`flankSource`), because the ranking that produces them and the
 *      KPI query that produces the headline are not always the same population.
 *
 * Non-dollar throughout: percentages and names only, so blind and sighted roles derive the same flanks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  deriveFacilitySpread,
  deriveTileFlanks,
  NO_TILE_FLANKS,
  type QualifyTileMetric,
} from '../lib/qualify/tileFlanks';
import { BookKpiTiles } from '../components/qualify/overview';
import { derivePolicyRating } from '../lib/qualify/policyRating';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';
import { QUALIFY_TENANT_SCOPE } from '../lib/qualify/contract';
import type { QualifyBookKpis, QualifyFacility } from '../lib/qualify/contract';

/** A facility carrying all three tile metrics. `pct` is allowed-of-billed; the paid pair is explicit
 *  so a test can make one metric thin without disturbing the others. */
function fac(
  name: string,
  pct: number | null,
  paidOfAllowed: number | null = null,
  paidOfBilled: number | null = null,
): QualifyFacility {
  return {
    ...QUALIFY_FACILITY_V2_NULLS,
    rank: 1,
    name,
    facilityKey: name.toLowerCase(),
    city: null,
    state: null,
    pctAllowedOfBilled: pct,
    pctPaidOfAllowed: paidOfAllowed,
    pctPaidOfBilled: paidOfBilled,
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

const KPIS: QualifyBookKpis = {
  pctAllowedOfBilled: 44,
  pctPaidOfAllowed: 71,
  pctPaidOfBilled: 31,
  distinctPatients: 40,
  windowStart: '2026-07-05',
  windowEnd: '2026-08-04',
  tenantScope: QUALIFY_TENANT_SCOPE,
};

// ── Each tile reads its OWN metric ───────────────────────────────────────────────────────────────

test('ALL THREE metrics get their own flanks, each from that metric — never the allowed spread reused', () => {
  const set = [fac('ALPHA', 62, 90, 56), fac('BETA', 30, 40, 12), fac('GAMMA', 44, 65, 29)];
  const flanks = deriveTileFlanks(set);
  assert.deepEqual(flanks.allowed, {
    worst: { label: 'Worst', value: 30, who: 'BETA' },
    best: { label: 'Best', value: 62, who: 'ALPHA' },
  });
  assert.deepEqual(flanks.paidOfAllowed, {
    worst: { label: 'Worst', value: 40, who: 'BETA' },
    best: { label: 'Best', value: 90, who: 'ALPHA' },
  });
  assert.deepEqual(flanks.paidOfBilled, {
    worst: { label: 'Worst', value: 12, who: 'BETA' },
    best: { label: 'Best', value: 56, who: 'ALPHA' },
  });
});

test('the metrics rank INDEPENDENTLY — the best allowed facility can be the worst payer', () => {
  // This is the whole reason three separate spreads exist: a facility can carry a strong contracted
  // rate and still collect badly on it. Reusing the allowed spread on the paid tiles would have named
  // ALPHA "Best" there too, which is the opposite of the truth.
  const set = [fac('ALPHA', 80, 20, 16), fac('BETA', 40, 95, 38)];
  const flanks = deriveTileFlanks(set);
  assert.equal(flanks.allowed?.best.who, 'ALPHA');
  assert.equal(flanks.paidOfAllowed?.best.who, 'BETA');
  assert.equal(flanks.paidOfAllowed?.worst.who, 'ALPHA');
});

test('a metric with thin coverage goes null ALONE — the other tiles keep their flanks', () => {
  // Only ALPHA reports paid-of-allowed, so that tile has no range while allowed still does.
  const flanks = deriveTileFlanks([fac('ALPHA', 62, 90), fac('BETA', 30, null)]);
  assert.ok(flanks.allowed, 'allowed still has two values');
  assert.equal(flanks.paidOfAllowed, null, 'one value is not a range');
  assert.equal(flanks.paidOfBilled, null, 'no facility reports it at all');
});

// ── Refusing to fabricate a range ────────────────────────────────────────────────────────────────

test('flanks refuse a fake range: <2 scored, a null percentage, or a flat set → null', () => {
  assert.equal(deriveFacilitySpread([]), null);
  assert.equal(deriveFacilitySpread([fac('ALPHA', 62)]), null);
  assert.equal(deriveFacilitySpread([fac('ALPHA', 62), fac('BETA', null)]), null, 'null pct is not a 0%');
  assert.equal(deriveFacilitySpread([fac('ALPHA', 55), fac('BETA', 55)]), null, 'flat is not a spread');
});

test('SAMPLE GATE — a sub-floor facility cannot set the range, on any metric', () => {
  // A card below the distinct-patient floor renders '—' with NO percentage. Without this gate that
  // facility could still set "Worst", so the tile would name a facility carrying a number that appears
  // nowhere beneath it. 61% of facility×payer rows sit under the floor, and extremes are exactly where
  // that noise lives, so the Worst flank was the expected victim rather than an edge case.
  const thinButExtreme = { ...fac('THIN', 4, 3, 2), distinctPatients: 2 };
  const flanks = deriveTileFlanks([fac('ALPHA', 62, 90, 56), fac('BETA', 41, 70, 29), thinButExtreme]);
  for (const metric of ['allowed', 'paidOfAllowed', 'paidOfBilled'] as QualifyTileMetric[]) {
    assert.equal(flanks[metric]?.worst.who, 'BETA', `${metric}: the sub-floor facility set the Worst flank`);
  }
  // Two rated facilities plus any number of sub-floor ones still works; fewer than two does not.
  assert.equal(deriveFacilitySpread([fac('ALPHA', 62), thinButExtreme]), null);
});

test('values are rounded for display, and the naming is Worst/Best', () => {
  const s = deriveFacilitySpread([fac('ALPHA', 62.4), fac('BETA', 29.6), fac('GAMMA', 44)]);
  assert.deepEqual(s, {
    worst: { label: 'Worst', value: 30, who: 'BETA' },
    best: { label: 'Best', value: 62, who: 'ALPHA' },
  });
});

// ── While the ranking is loading, every derived read must go quiet ───────────────────────────────
//
// With a payer resolved but its snapshot in flight, the left column shows "Loading facility ranking…"
// and NO cards. The container passes an empty set during that window, so every derived read has to
// suppress itself off it — otherwise the tiles and the policy bar describe a population that is not on
// screen, which is the original 2026-08-04 report one layer down.

test('an empty ranked set produces no flanks and no policy claim', () => {
  assert.deepEqual(deriveTileFlanks([]), NO_TILE_FLANKS);
  const pr = derivePolicyRating([]);
  assert.equal(pr.ratedCount, 0);
  assert.equal(pr.rating, null);
  // Its basis is a claim about DATA ("no facility clears the sample floor") and would be false about a
  // network fetch — which is why the container gates on an explicit loading flag, not on this.
  assert.match(pr.basis, /sample floor/);
});

// ── Render ───────────────────────────────────────────────────────────────────────────────────────

test('EVERY tile renders its flanks — three Worst labels, not one (the ruled behaviour)', () => {
  const flanks = deriveTileFlanks([fac('ALPHA', 62, 90, 56), fac('BETA', 30, 40, 12)]);
  const html = renderToStaticMarkup(
    <BookKpiTiles kpis={KPIS} locActive={false} flanks={flanks} flankSource="across 2 ranked facilities · AETNA" />,
  );
  assert.equal((html.match(/Worst/g) ?? []).length, 3, 'all three tiles carry a range');
  assert.equal((html.match(/Best/g) ?? []).length, 3);
  // Each tile shows ITS metric's numbers, so all six endpoint values are present.
  for (const v of ['62%', '30%', '90%', '40%', '56%', '12%']) {
    assert.ok(html.includes(v), `${v} is missing — a tile is not showing its own metric`);
  }
});

test('the flank SOURCE is always printed — an unlabelled range is the defect, not the feature', () => {
  const flanks = deriveTileFlanks([fac('ALPHA', 62, 90, 56), fac('BETA', 30, 40, 12)]);
  const html = renderToStaticMarkup(
    <BookKpiTiles kpis={KPIS} locActive={false} flanks={flanks} flankSource="across 27 ranked facilities · CIGNA" />,
  );
  assert.match(html, /range across 27 ranked facilities · CIGNA/);
  // No source ⇒ no flanks at all. The tiles and the ranking can be different populations, so a range
  // that cannot say what it is a range OF must not render.
  const unlabelled = renderToStaticMarkup(<BookKpiTiles kpis={KPIS} locActive={false} flanks={flanks} />);
  assert.ok(!/Worst/.test(unlabelled), 'flanks rendered with no source named');
});

test('a sample too thin for a confident headline is too thin for confident flanks', () => {
  const flanks = deriveTileFlanks([fac('ALPHA', 62, 90, 56), fac('BETA', 30, 40, 12)]);
  const thin = renderToStaticMarkup(
    <BookKpiTiles kpis={{ ...KPIS, distinctPatients: 1 }} locActive={false} flanks={flanks} flankSource="across 2 ranked facilities" />,
  );
  assert.ok(!/Worst/.test(thin), 'insufficient sample must suppress the flanks with the number');
});

test('the landing (no flanks supplied) renders the tiles unchanged', () => {
  const html = renderToStaticMarkup(<BookKpiTiles kpis={KPIS} locActive={false} />);
  assert.ok(!/Worst/.test(html));
  assert.match(html, /% allowed of billed/);
});
