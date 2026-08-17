/**
 * Payer Intel render contracts — renderToStaticMarkup over the PURE components (the house
 * pattern; effects never run, so anything behavioral lives in the root-suite core tests).
 *
 * The dollar assertions here are the render-level twin of test/payerIntelCore.test.ts's
 * wire-level strip: a blind session's ALREADY-NULL dollar fields must render as em dashes and
 * the markup must carry no dollar figure.
 *
 * ⚠ payer-intel-view.tsx is NOT imported — its graph reaches @/lib/actions → @/lib/access, whose
 * RSC cache() crashes node:test. It gets a SOURCE-level guard test instead (the
 * cmd-explorer-ai-panel precedent).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PayerIntelDeclinersRail, PayerIntelGainersRail } from '../components/payer-intel/idle-rails';
import { PayerIntelCensusStrip } from '../components/payer-intel/census-strip';
import { PayerIntelSavedSearches } from '../components/payer-intel/saved-searches';
import {
  PayerIntelChargeLines,
  PayerIntelHero,
  PayerIntelPctBand,
  PayerIntelPlacementTable,
} from '../components/payer-intel/result-sections';
import { PayerIntelPointerBanner } from '../components/payer-intel/pointer-banner';
import type {
  PayerIntelCensusRow,
  PayerIntelDeclinerItem,
  PayerIntelResult,
  PayerIntelSavedSearch,
} from '../lib/payer-intel/contract';

const DECLINER: PayerIntelDeclinerItem = {
  facility: 'MHC SAN DIEGO',
  facilityCode: '10024431',
  careSetting: 'IP',
  pctCurrent: 22.4,
  pctPrior: 31.8,
  deltaPts: -9.4,
  lineCount: 340,
  distinctMembers: 41,
  billedCurrent: 339000,
  declineReason: null,
};

test('decliners rail: a blind tick renders NO dollar; a capable tick renders the compact figure', () => {
  const blind = renderToStaticMarkup(
    <PayerIntelDeclinersRail items={[{ ...DECLINER, billedCurrent: null }]} windowDays={90} thresholdPts={5} />,
  );
  assert.doesNotMatch(blind, /\$/);
  assert.match(blind, /340 ln/);
  const capable = renderToStaticMarkup(
    <PayerIntelDeclinersRail items={[DECLINER]} windowDays={90} thresholdPts={5} />,
  );
  assert.match(capable, /\$339K/);
});

test('decliners rail: the spec-fixed empty state renders "nothing to chase"', () => {
  const html = renderToStaticMarkup(<PayerIntelDeclinersRail items={[]} windowDays={90} thresholdPts={5} />);
  assert.match(html, /No facility is down more than 5 pts in 90 days — nothing to chase\./);
});

test('decliners rail: movement carries words + arrow, never hue alone; no fabricated why-tag', () => {
  const html = renderToStaticMarkup(
    <PayerIntelDeclinersRail items={[DECLINER]} windowDays={90} thresholdPts={5} onSeed={() => {}} />,
  );
  assert.match(html, /▼ −9\.4/);
  assert.match(html, /down 9\.4 points/); // the accessible name on the seed button
  // No attribution service exists — no why-tag text may render.
  assert.doesNotMatch(html, /payer-mix|zero-paid ↑|seasonal/);
});

test('gainers rail: renders the tape vocabulary without any marquee duplicate set', () => {
  const html = renderToStaticMarkup(
    <PayerIntelGainersRail
      items={[
        {
          token: 'a'.repeat(64),
          tokenTail: 'abcdef',
          echo: 'W29',
          prefix: null,
          payer: 'AETNA',
          careSetting: 'OP',
          area: 'Nashville, TN',
          facilityCount: 1,
          ratingNow: 45,
          bandNow: '30',
          ratingThen: 41,
          deltaPts: 4,
          distinctMembers: 12,
          lineCount: 88,
          windowDays: 90,
        },
      ]}
      asOf="2026-08-16"
      deltaDays={90}
    />,
  );
  assert.match(html, /W29/);
  assert.match(html, /▲ \+4 pts/);
  assert.doesNotMatch(html, /data-dup/); // static strip — no marquee machinery
  assert.doesNotMatch(html, /\$/); // non-dollar by construction
});

test('census strip: outpatient rows render em dashes, never 0 beds or "full"', () => {
  const rows: PayerIntelCensusRow[] = [
    {
      facilityCode: 'TREAT_CA',
      facilityName: 'Treat MH California',
      boardFamily: 'outpatient',
      admittedCount: 51,
      openBeds: null,
      bedCapacity: null,
      pendingAdmits: null,
      occupancyPct: null,
      status: null,
      syncedAt: '2026-08-17T16:40:00Z',
    },
    {
      facilityCode: 'LSMH',
      facilityName: 'Lonestar Mental Health',
      boardFamily: 'residential',
      admittedCount: 12,
      openBeds: 0,
      bedCapacity: 12,
      pendingAdmits: null,
      occupancyPct: 100,
      status: 'full',
      syncedAt: '2026-08-17T16:40:00Z',
    },
  ];
  const html = renderToStaticMarkup(<PayerIntelCensusStrip rows={rows} syncedAt="2026-08-17T16:40:00Z" />);
  assert.match(html, /OP caseload/);
  assert.match(html, /Full/);
  assert.match(html, /Pending admits are not stored/);
  // The outpatient row's bed cells are dashes; the strip stamp is Pacific time.
  assert.match(html, /live from admissions boards ·/);
});

test('saved-search card: resolution status is meta text and degraded re-runs say so', () => {
  const saved: PayerIntelSavedSearch = {
    id: '15',
    payer: null,
    prefixEcho: null,
    planClass: null,
    entityType: 'employer',
    resolved: false,
    starred: true,
    searchedAt: '2026-08-14T18:23:00Z',
  };
  const html = renderToStaticMarkup(
    <PayerIntelSavedSearches
      starred={[saved]}
      recent={[]}
      persisted
      onToggleStar={() => {}}
      onRerun={() => {}}
      onClearHistory={() => {}}
    />,
  );
  assert.match(html, /no payer resolved/);
  assert.match(html, /re-runs without its saved facet/);
  assert.match(html, /aria-pressed="true"/);
});

const RESULT: PayerIntelResult = {
  facets: {
    payer: 'AETNA',
    prefix: 'W29',
    facilityCodes: [],
    facilityLabels: [],
    employerNames: [],
    funding: ['Self-Funded'],
    groupNumberMasked: '•••• 4217',
  },
  resolved: true,
  totals: { lineCount: 558, distinctMembers: 96, billed: null },
  yieldPct: { pct_collected: 32.4, pct_allowed: 41.2, pct_paid: 78.6 },
  rating: { value: 45, band: '30', deltaPts: 4, asOf: '2026-08-16', subject: 'pair' },
  placement: [
    {
      facility: 'Lonestar Mental Health',
      facilityCode: 'LSMH',
      careSetting: 'IP',
      lineCount: 61,
      distinctMembers: 9,
      pctCollected: 41.6,
      paidPerPatient: null,
      billed: null,
      openBeds: 0,
      bedCapacity: 12,
      pendingAdmits: null,
      censusSyncedAt: null,
      flag: 'best_yield_full',
    },
  ],
  combos: [
    { cpt: 'H0017', revenue: '0158', count: 84, charge: null, pctAllowed: 48.6, pctPaid: 70.2, pctZeroPaid: 4.8 },
  ],
  window: { from: '2026-05-20', to: '2026-08-17' },
  viewerHasAmountsCapability: false,
};

test('hero (blind): ON FILE chips render with dismiss + Clear all; the masked group echo only', () => {
  const html = renderToStaticMarkup(
    <PayerIntelHero
      result={RESULT}
      facilityNameOf={(c) => c}
      watchState="idle"
      onWatch={() => {}}
      onDismissFacet={() => {}}
      onClearAll={() => {}}
    />,
  );
  assert.match(html, /AETNA/);
  assert.match(html, /W29/);
  assert.match(html, /•••• 4217/);
  assert.match(html, /Clear all/);
  assert.match(html, /Remove Payer AETNA/); // per-chip accessible dismiss
  assert.doesNotMatch(html, /0084217/); // the raw group number never renders
});

test('placement table (blind): dollar column renders em dash while ratios and flags survive', () => {
  const html = renderToStaticMarkup(
    <PayerIntelPlacementTable
      items={RESULT.placement}
      window={RESULT.window}
      censusSyncedAt={null}
      cohortLabel="W29"
    />,
  );
  assert.match(html, /41\.6%/);
  assert.match(html, /Full/); // the best-yield-full flag pill
  assert.match(html, /90d thru 2026-08-17/); // trailing-column as-of stamp
  assert.doesNotMatch(html, /\$\d/); // no dollar figure for a blind viewer
});

test('charge lines (blind): zero-paid column renders; charged renders em dash, never $', () => {
  const html = renderToStaticMarkup(<PayerIntelChargeLines combos={RESULT.combos} totalLines={558} />);
  assert.match(html, /Zero-paid/);
  assert.match(html, /4\.8%/);
  assert.doesNotMatch(html, /\$\d/);
});

test('pct band: the three cards ride in math order with their formula pills and footnote', () => {
  const html = renderToStaticMarkup(<PayerIntelPctBand result={RESULT} />);
  const allowed = html.indexOf('% allowed of billed');
  const paid = html.indexOf('% paid by payer');
  const collected = html.indexOf('% collected of billed');
  assert.ok(allowed >= 0 && allowed < paid && paid < collected, 'cards must mirror the math order');
  assert.match(html, /allowed ÷ billed/);
  assert.match(html, /paid ÷ allowed/);
  assert.match(html, /paid ÷ billed/);
  assert.match(html, /contractual write-off/);
});

test('pointer banner: links to /payer-intel and blocks nothing', () => {
  const html = renderToStaticMarkup(<PayerIntelPointerBanner from="collections" />);
  assert.match(html, /href="\/payer-intel"/);
  assert.match(html, /Nothing here is going away/);
});

// ── Source-level guards over the orchestrator (its import graph cannot load under node:test) ─────

test('view source: reduced-motion is checked before every GSAP leg and the URL codec is allowlist-only', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'components', 'payer-intel', 'payer-intel-view.tsx'), 'utf8');
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /gsap\.context\(/);
  assert.match(src, /ctx\.revert\(\)/);
  // Controls animate opacity — an autoAlpha PROPERTY must never appear (the resolution-flow a11y
  // ruling); the word may appear in prose explaining exactly this.
  assert.doesNotMatch(src, /autoAlpha:/);
  // No marquee on this surface — the spec forbids auto-scroll rails.
  assert.doesNotMatch(src, /useMarquee/);
  // The URL sync writes ONLY through the contract codec (allowlist: payer/prefix/fac/funding) —
  // no employer or group value may be interpolated into a URL here.
  assert.match(src, /encodePayerIntelUrl/);
  assert.doesNotMatch(src, /groupNumber[^\n]*history\.replaceState/);
});

test('page source: force-dynamic is exported and searchParams parse only the non-PHI allowlist', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'app', 'payer-intel', 'page.tsx'), 'utf8');
  assert.match(src, /export const dynamic = 'force-dynamic'/);
  assert.match(src, /params\.payer/);
  assert.match(src, /params\.prefix/);
  assert.doesNotMatch(src, /params\.employer/);
  assert.doesNotMatch(src, /params\.group/);
  // admissions_seat is ADMITTED — the isQualifyOnlyRole redirect CALL must not appear (the name
  // may appear in prose explaining its absence).
  assert.doesNotMatch(src, /isQualifyOnlyRole\(/);
});
