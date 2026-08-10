/**
 * WATCHBOARD CORE + SHELL PANELS — the app half of the watcher surface.
 *
 * Core: the availability union (0096 unapplied ≠ empty), enrichment fail-soft (a thrown series
 * read costs sparklines, never rows), threshold alerting. Panels: rendered-HTML assertions in the
 * policy-tape-render.test.tsx idiom — no dollars, no raw tokens, masked echo only, and the
 * compliance footer present (it is the contract, not decoration).
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { getQualifyWatchboardCore, type QualifyWatchboardDeps } from '../lib/qualify/watchers';
import { WatchersPanel } from '../components/qualify/shell/watchers-panel';
import { RecentSearches } from '../components/qualify/shell/recent-searches';
import type { QualifyWatcherRow } from '../../src/collections/qualifyWatchers';

const TOKEN = 'e'.repeat(64);

function deps(over: Partial<QualifyWatchboardDeps> = {}): QualifyWatchboardDeps {
  return {
    requirePrincipal: async () => ({ ok: true, userId: 'u-1' }),
    loadWatchers: async () => [trendRow()],
    loadRecent: async () => [],
    ...over,
  };
}

function trendRow(over: Partial<QualifyWatcherRow> = {}): QualifyWatcherRow {
  return {
    id: '7',
    kind: 'trend',
    payer_label: 'AETNA',
    subject_token: TOKEN,
    display_echo: null,
    threshold_pts: 3,
    created_at: '2026-08-01',
    ...over,
  };
}

// ── The availability union ──────────────────────────────────────────────────────────────────────
test('a null loader (0096 unapplied) reads available:false — session-only, not an error', async () => {
  const board = await getQualifyWatchboardCore(deps({ loadWatchers: async () => null }));
  assert.equal(board.available, false);
  assert.deepEqual(board.trend, []);
});

test('empty rows with the relations PRESENT read available:true — a different claim entirely', async () => {
  const board = await getQualifyWatchboardCore(deps({ loadWatchers: async () => [], loadRecent: async () => [] }));
  assert.equal(board.available, true);
});

// ── Enrichment fail-soft + alerting ─────────────────────────────────────────────────────────────
test('a thrown series read costs the sparkline, never the row', async () => {
  const board = await getQualifyWatchboardCore(
    deps({
      loadSeries: async () => {
        throw new Error('boom');
      },
    }),
  );
  assert.equal(board.trend.length, 1);
  assert.deepEqual(board.trend[0]!.points, []);
});

test('alerting fires on |delta| >= threshold, in both directions', async () => {
  const mk = (ratings: number[]) =>
    getQualifyWatchboardCore(
      deps({
        loadSeries: async () =>
          ratings.map((rating, i) => ({
            member_id_prefix_bidx: TOKEN,
            primary_payer: 'AETNA',
            as_of_date: `2026-05-0${i + 1}`,
            rating,
          })),
      }),
    );
  assert.equal((await mk([50, 54])).trend[0]!.alerting, true); // +4 over ±3
  assert.equal((await mk([50, 46])).trend[0]!.alerting, true); // −4
  assert.equal((await mk([50, 52])).trend[0]!.alerting, false); // +2
});

test('the pg-bigint string id survives as a string — no Number() coercion anywhere', async () => {
  const board = await getQualifyWatchboardCore(deps());
  assert.equal(board.trend[0]!.id, '7');
});

// ── Rendered panels ─────────────────────────────────────────────────────────────────────────────
test('WatchersPanel renders no raw token, carries the compliance footer, masks the patient echo', () => {
  const html = renderToStaticMarkup(
    <WatchersPanel
      available={true}
      trend={[
        {
          id: '7',
          kind: 'trend',
          payer: 'AETNA',
          prefix: 'GGS',
          thresholdPts: 3,
          since: '2026-08-01',
          points: [40, 52],
          ratingNow: 52,
          deltaPts: 12,
          alerting: true,
        },
      ]}
      patient={[
        {
          id: '9',
          kind: 'patient',
          echo: 'GGS •••• 8841',
          planContext: 'Anthem PPO',
          since: '2026-08-02',
        },
      ]}
      onDelete={() => {}}
    />,
  );
  assert.doesNotMatch(html, new RegExp(TOKEN));
  assert.doesNotMatch(html, /\$\d/);
  assert.match(html, /GGS •••• 8841/);
  assert.match(html, /the raw member ID is never stored/);
  assert.match(html, /MOVED PAST YOUR THRESHOLD/);
  // delete affordances are labelled for AT
  assert.match(html, /aria-label="Stop watching AETNA"/);
});

test('session-only mode says so instead of silently pretending durability', () => {
  const html = renderToStaticMarkup(
    <WatchersPanel
      available={false}
      trend={[
        {
          id: '',
          kind: 'trend',
          payer: 'AETNA',
          prefix: null,
          thresholdPts: 3,
          since: 'today',
          points: [],
          ratingNow: null,
          deltaPts: null,
          alerting: false,
          sessionOnly: true,
        },
      ]}
      patient={[]}
      onDelete={() => {}}
    />,
  );
  assert.match(html, /this session only/);
  assert.match(html, /0096/);
});

test('RecentSearches: re-run only where an echo exists, and the facet line stays non-PHI-shaped', () => {
  const html = renderToStaticMarkup(
    <RecentSearches
      items={[
        { id: '1', payer: 'AETNA', prefixEcho: 'GGS', planClass: 'PPO', searchedAt: '2026-08-10T14:22:00Z' },
        { id: '2', payer: 'CIGNA', prefixEcho: null, planClass: null, searchedAt: '2026-08-10T13:00:00Z' },
      ]}
      available={true}
      onRerun={() => {}}
      onClear={() => {}}
    />,
  );
  // Counts the visible button, not the substring: the accessible name now also starts with
  // "Re-run" (WCAG "label in name"), so a raw substring count would double per eligible row.
  const reruns = html.match(/>↻ Re-run</g) ?? [];
  assert.equal(reruns.length, 1, 'the echo-less row must not offer a re-run it cannot perform');
  assert.match(html, /NON-PHI FACETS ONLY/);
  assert.match(html, /clear history/);
});

test('RecentSearches: two rows with echoes produce two DISTINCT Re-run accessible names', () => {
  const html = renderToStaticMarkup(
    <RecentSearches
      items={[
        { id: '1', payer: 'AETNA', prefixEcho: 'GGS', planClass: 'PPO', searchedAt: '2026-08-10T14:22:00Z' },
        { id: '2', payer: 'CIGNA', prefixEcho: 'ABC', planClass: 'EPO', searchedAt: '2026-08-10T13:00:00Z' },
      ]}
      available={true}
      onRerun={() => {}}
      onClear={() => {}}
    />,
  );
  const labels = [...html.matchAll(/aria-label="(Re-run search[^"]*)"/g)].map((m) => m[1]);
  assert.equal(labels.length, 2, 'both rows have an echo and must each carry a labelled Re-run control');
  assert.notEqual(labels[0], labels[1], 'identical accessible names is the confirmed defect (every row announced as just "Re-run")');
  assert.match(labels[0]!, /AETNA/);
  assert.match(labels[0]!, /GGS/);
  assert.match(labels[1]!, /CIGNA/);
  assert.match(labels[1]!, /ABC/);
  // the visible glyph+text is unchanged — only the accessible name gained context
  assert.match(html, />↻ Re-run</);
});

test("RecentSearches' section label renders as an <h2>, not a dangling <span>", () => {
  const html = renderToStaticMarkup(
    <RecentSearches items={[]} available={true} onRerun={() => {}} onClear={() => {}} />,
  );
  assert.match(html, /<h2[^>]*>Recent searches<\/h2>/);
});

test("WatchersPanel's section label renders as an <h2>, so the panel's own <h3>s no longer dangle", () => {
  const html = renderToStaticMarkup(
    <WatchersPanel available={true} trend={[]} patient={[]} onDelete={() => {}} />,
  );
  assert.match(html, /<h2[^>]*>Watchers<\/h2>/);
  // the Trendwatchers / Patient watchers <h3>s are untouched by this fix
  assert.match(html, /<h3[^>]*>Trendwatchers/);
});
