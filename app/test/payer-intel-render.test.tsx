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
import { PayerIntelCensusPanel } from '../components/payer-intel/census-panel';
import { PayerIntelSavedSearches } from '../components/payer-intel/saved-searches';
import {
  PayerIntelChargeLines,
  PayerIntelGridTable,
  PayerIntelHero,
  PayerIntelPctBand,
  PayerIntelPlacementTable,
  PayerIntelTopGroups,
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

test('rails source: BOTH rails run the marquee machine (the 2026-08-17 "make them move" ruling)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'components', 'payer-intel', 'idle-rails.tsx'), 'utf8');
  assert.match(src, /useMarquee/);
  assert.match(src, /q-marquee/);
  assert.match(src, /data-dup/); // the duplicate-set contract (reduced-motion CSS hides it)
  assert.match(src, /isOverflowing &&/);
});

test('gainers rail: static render shows ONE set (effects never run, so no duplicate leaks in)', () => {
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
  // The duplicate set only mounts after useMarquee MEASURES overflow — hermetic renders see one
  // copy of each policy, which is also what AT must see (the dup is aria-hidden when it exists).
  assert.doesNotMatch(html, /data-dup/);
  assert.doesNotMatch(html, /\$/); // non-dollar by construction
});

test('census panel: outpatient rows never render beds or "full", and sit behind a disclosure', () => {
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
  const html = renderToStaticMarkup(<PayerIntelCensusPanel rows={rows} syncedAt="2026-08-17T16:40:00Z" />);
  // The residential board at capacity reads as a pill, and the summary counts it.
  assert.match(html, /Full/);
  assert.match(html, /1 residential/);
  assert.match(html, /0 open beds/);
  // The OP caseload rides the disclosure (collapsed => `hidden`), labelled by count, and reports
  // its ACTIVE census — never an open-bed number and never "Full" (the 0078 sentinel contract).
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1 outpatient caseloads/);
  assert.match(html, /51 active/);
  assert.doesNotMatch(html, /51 open/);
  // The panel stamps Pacific time.
  assert.match(html, /live ·/);
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
    facilities: [],
    employerNames: [],
    funding: ['Self-Funded'],
    groupNumberMasked: '•••• 4217',
    cpt: null,
    revenue: null,
    windowDays: 90,
  },
  resolved: true,
  totals: { lineCount: 558, distinctMembers: 96, billed: null },
  yieldPct: { pct_collected: 32.4, pct_allowed: 41.2, pct_paid: 78.6 },
  rating: { value: 45, band: '30', deltaPts: 4, asOf: '2026-08-16', subject: 'pair' },
  byPayer: [{ label: 'AETNA', count: 500, charge: null }],
  byFacility: [{ label: 'LONESTAR MENTAL HEALTH LLC', count: 61, charge: null }],
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
  window: { from: '2026-05-20', to: '2026-08-18', days: 90 },
  viewerHasAmountsCapability: false,
};

test('hero (blind): ON FILE chips render with dismiss + Clear all; the masked group echo only', () => {
  const html = renderToStaticMarkup(
    <PayerIntelHero
      result={RESULT}
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
  // The "how far back" disclosure is required chrome (2026-08-17 review, item 3).
  assert.match(html, /payments received 2026-05-20 → 2026-08-18 · past 90 days/);
});

test('drill groups (blind): rows are BUTTONS with counts and no dollars', () => {
  const html = renderToStaticMarkup(
    <PayerIntelTopGroups
      byPayer={RESULT.byPayer}
      byFacility={RESULT.byFacility}
      onDrillPayer={() => {}}
      onDrillFacility={() => {}}
    />,
  );
  assert.match(html, /Narrow this search to payer AETNA/);
  assert.match(html, /Narrow this search to facility LONESTAR MENTAL HEALTH LLC/);
  assert.doesNotMatch(html, /\$\d/);
});

test('grid table (blind): dollar cells render em dashes; ratios and labels survive; load-more shows', () => {
  const html = renderToStaticMarkup(
    <PayerIntelGridTable
      page={{
        rows: [
          {
            id: 15,
            chargeDate: '2026-07-21',
            paymentReceived: '2026-08-18',
            cpt: 'H0035',
            revenue: '0913',
            payer: 'AETNA',
            facility: 'LONESTAR MENTAL HEALTH LLC',
            employerName: null,
            chargeAmount: null,
            allowedAmount: null,
            insurancePayments: null,
            patientBalanceDue: null,
            pctAllowed: '20.06',
            pctPaid: '86.45',
          },
        ],
        nextCursor: { id: 15, value: '2026-08-18' },
      }}
      loading={false}
      onLoadMore={() => {}}
    />,
  );
  assert.match(html, /20\.1%/);
  assert.match(html, /LONESTAR MENTAL HEALTH LLC/);
  assert.match(html, /Load more charge lines/);
  assert.doesNotMatch(html, /\$\d/);
});

test('grid table: a failed load says so and offers Retry — never a spinner, never "will load"', () => {
  // The 2026-08-17 "charge lines will not load" report: `page===null` printed "Loading charge
  // lines…" whenever `loading` was true and "will load with the search" otherwise, so a request
  // that came back refusing (or never came back at all) was indistinguishable from a slow one and
  // there was nothing to click. Failed must beat BOTH pending messages.
  const html = renderToStaticMarkup(
    <PayerIntelGridTable page={null} loading={false} failed onRetry={() => {}} onLoadMore={() => {}} />,
  );
  assert.match(html, /could not be loaded/);
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /Loading charge lines/);
  assert.doesNotMatch(html, /will load with the search/);
  // The pending state is unchanged and still distinct.
  const pending = renderToStaticMarkup(
    <PayerIntelGridTable page={null} loading failed={false} onLoadMore={() => {}} />,
  );
  assert.match(pending, /Loading charge lines/);
  assert.doesNotMatch(pending, /Retry/);
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
  assert.match(html, /90d thru 2026-08-18/); // trailing-column as-of stamp
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
  // The marquee lives in idle-rails.tsx (its own test above) — the orchestrator never CALLS it
  // (the name may appear in prose describing exactly this split).
  assert.doesNotMatch(src, /useMarquee[<(]/);
  // The a11y contract from the 2026-08-17 review: a polite live region + focus to the result.
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /resultHeadingRef\.current\?\.focus\(\)/);
  // The URL sync writes ONLY through the contract codec (allowlist: payer/prefix/fac/funding) —
  // no employer or group value may be interpolated into a URL here.
  assert.match(src, /encodePayerIntelUrl/);
  assert.doesNotMatch(src, /groupNumber[^\n]*history\.replaceState/);
});

test('view source: EVERY Server Action promise chain terminates in .catch', () => {
  // The charge-lines defect in one sentence: a bare `.then()` on a Server Action leaves the UI
  // holding whatever pending state it set. `loadPayerIntelChargeRows` rejecting (stale action id
  // after a redeploy, dropped POST, function timeout) left "Loading charge lines…" on screen
  // forever with nothing in the server logs, because the rejection never reached the server.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'components', 'payer-intel', 'payer-intel-view.tsx'), 'utf8');
  const ACTIONS = [
    'getPayerIntelBoard',
    'loadPayerIntelChargeRows',
    'runPayerIntelSearch',
    'togglePayerIntelStar',
    'clearPayerIntelHistory',
    'watchPayerIntelSubject',
  ];
  for (const name of ACTIONS) {
    const at = src.indexOf(`${name}(`, src.indexOf(`  ${name},`) + 1); // skip the import list
    assert.ok(at > 0, `${name} is not called in the view`);
    // The chain has to close within its own callback — 1600 chars covers the longest one here.
    const chain = src.slice(at, at + 1600);
    assert.match(chain, /\.catch\(/, `${name}'s promise chain has no .catch — a rejection would strand the UI`);
  }
  // searchPayerIntelEmployers is awaited rather than chained; it gets a try/catch instead.
  assert.match(src, /try \{\s*\n\s*const r = await searchPayerIntelEmployers/);
  // The failed grid renders an honest state rather than an eternal spinner.
  assert.match(src, /setGridFailed\(true\)/);
});

test('facility resolution: the old collections path FORWARDS and the desk owns the entry link', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = join(here, '..', 'app');
  const moved = readFileSync(join(app, 'billing-audit', 'facility-resolution', 'page.tsx'), 'utf8');
  const stub = readFileSync(join(app, 'dashboard', 'collections', 'facility-resolution', 'page.tsx'), 'utf8');
  const desk = readFileSync(join(app, 'billing-audit', 'page.tsx'), 'utf8');
  const collections = readFileSync(join(app, 'dashboard', 'collections', 'page.tsx'), 'utf8');

  // The workbench self-redirects within its NEW path when it clamps the view.
  assert.match(moved, /redirect\(`\/billing-audit\/facility-resolution\?view=/);
  assert.doesNotMatch(moved, /redirect\(`\/dashboard\/collections\/facility-resolution/);
  // ...and keeps the admin/super_admin gate it has always had.
  assert.match(moved, /role !== 'admin' && role !== 'super_admin'/);

  // The old path is a FORWARDER — it must carry ?view= and must not load any data of its own.
  assert.match(stub, /redirect\(/);
  assert.match(stub, /\/billing-audit\/facility-resolution\?view=/);
  assert.doesNotMatch(stub, /FacilityResolutionView|loadResolutionOverview|queryResolutionQueue/);

  // The entry link lives on the desk now, still role-gated by DOM omission, and is GONE from
  // Collections (a stray second link is exactly the drift this test exists to catch).
  assert.match(desk, /href=\{`\/billing-audit\/facility-resolution\?view=\$\{view\}`\}/);
  assert.match(desk, /role === 'admin' \|\| access\.access\.role === 'super_admin'/);
  assert.doesNotMatch(collections, /href=\{`\/dashboard\/collections\/facility-resolution/);
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
