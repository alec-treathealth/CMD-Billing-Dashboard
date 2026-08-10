/**
 * WATCHBOARD CORE + SHELL PANELS — the app half of the watcher surface.
 *
 * Core: the availability union (relations-absent ≠ empty), enrichment fail-soft (a thrown series
 * read costs sparklines, never rows), threshold alerting. Panels: rendered-HTML assertions in the
 * policy-tape-render.test.tsx idiom — no dollars, no raw tokens, masked echo only, and the
 * compliance footer present (it is the contract, not decoration).
 *
 * ── THE FOUR-STATE COPY CONTRACT (2026-08-10) ───────────────────────────────────────────────────
 * The panels used to take a BOOLEAN `available`, which the shell fed `board?.available ?? false`.
 * That mapped NOT-LOADED-YET onto RELATIONS-ABSENT, so for the entire mount-fetch window — every
 * `/qualify` load, the shell being default-ON — both panels told the operator that history was
 * "session-only until migration 0097 applies". 0097 has been applied live since 2026-08-10, so that
 * was a false sentence naming an internal migration at an admissions rep. This file PINNED it
 * (`assert.match(html, /0097/)`), which is the worst version of the failure: the test was holding
 * the defect in place. The contract asserted below is the replacement — a four-state `status`, a
 * silent `loading`, and NO migration number anywhere an operator can read.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { getQualifyWatchboardCore, type QualifyWatchboardDeps } from '../lib/qualify/watchers';
import { WatchersPanel } from '../components/qualify/shell/watchers-panel';
import { RecentSearches } from '../components/qualify/shell/recent-searches';
import {
  deriveBoardStatus,
  type QualifyBoardStatus,
} from '../components/qualify/shell/shell-session';
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
test('a null loader (relations absent) reads available:false — session-only, not an error', async () => {
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
      status="durable"
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

// ── The four-state status contract ──────────────────────────────────────────────────────────────
//
// ONE watcher, deliberately NOT flagged `sessionOnly`: the panel's per-item badge is a fact about
// the ITEM and would supply the words "session only" on its own, masking whether the BOARD-level
// banner fired. What these tests are about is the banner, so the fixture must not speak for it.
const ONE_TREND = [
  {
    id: '7',
    kind: 'trend' as const,
    payer: 'AETNA',
    prefix: null,
    thresholdPts: 3,
    since: 'today',
    points: [],
    ratingNow: null,
    deltaPts: null,
    alerting: false,
  },
];

test('deriveBoardStatus keeps the four states four — loading is NOT absent', () => {
  // THE DEFECT, in one line: `board?.available ?? false` answered `false` for null, and `false`
  // rendered the absent-state sentence. Null is a fourth answer, not a falsy third.
  assert.equal(deriveBoardStatus(null), 'loading');
  assert.equal(deriveBoardStatus('failed'), 'failed');
  assert.equal(deriveBoardStatus({ available: true }), 'durable');
  assert.equal(deriveBoardStatus({ available: false }), 'absent');
});

test('the pre-fetch window makes NO claim about storage in either panel', () => {
  const panels = [
    renderToStaticMarkup(
      <WatchersPanel status="loading" trend={ONE_TREND} patient={[]} onDelete={() => {}} />,
    ),
    renderToStaticMarkup(
      <RecentSearches items={[]} status="loading" onRerun={() => {}} onClear={() => {}} />,
    ),
  ];
  for (const html of panels) {
    // Not "history is session-only", not "durable storage arrives", not "unavailable". The fetch
    // has not answered; the honest thing to render is nothing about persistence at all.
    assert.doesNotMatch(html, /session only|session-only/i, 'loading must not claim non-durability');
    assert.doesNotMatch(html, /unavailable|could not be read/i, 'nor claim a fault it has not seen');
  }
});

test('NO panel state names a migration to the operator — the number belongs in the code', () => {
  const every: string[] = [];
  for (const status of ['loading', 'durable', 'absent', 'failed'] as QualifyBoardStatus[]) {
    every.push(
      renderToStaticMarkup(
        <WatchersPanel status={status} trend={ONE_TREND} patient={[]} onDelete={() => {}} />,
      ),
      renderToStaticMarkup(
        <RecentSearches items={[]} status={status} onRerun={() => {}} onClear={() => {}} />,
      ),
    );
  }
  for (const html of every) {
    // This is the assertion that replaced `assert.match(html, /0097/)`. An admissions rep cannot
    // act on a migration number, and 0097 IS APPLIED — the old copy was false as well as opaque.
    assert.doesNotMatch(html, /migration/i, 'no operator-facing copy may name a migration');
    assert.doesNotMatch(html, /\b0\d{3}\b/, 'nor a migration number by its digits (0097 and its neighbours)');
  }
});

test('the ABSENT state is fault-framed and actionable, not a promise about provisioning', () => {
  const html = renderToStaticMarkup(
    <WatchersPanel status="absent" trend={ONE_TREND} patient={[]} onDelete={() => {}} />,
  );
  assert.match(html, /this session only/, 'the rep still learns these do not survive a refresh');
  assert.match(html, /unavailable/, 'stated as a fault…');
  assert.match(html, /tell an admin/i, '…with the one action a rep can actually take');
  // The old copy promised the feature was coming. It is here; saying otherwise is a lie now.
  assert.doesNotMatch(html, /arrives|applies|not applied|coming soon/i);
});

test('the absent banner stays out of the way when there is nothing at risk', () => {
  const empty = renderToStaticMarkup(
    <WatchersPanel status="absent" trend={[]} patient={[]} onDelete={() => {}} />,
  );
  assert.doesNotMatch(empty, /this session only/, 'no watchers means nothing to warn about');
});

test('RecentSearches distinguishes absent from a failed read, and durable from both', () => {
  const render = (status: QualifyBoardStatus) =>
    renderToStaticMarkup(<RecentSearches items={[]} status={status} onRerun={() => {}} onClear={() => {}} />);

  const durable = render('durable');
  assert.match(durable, /No searches yet\./);
  assert.doesNotMatch(durable, /unavailable|could not be read/i, 'the working case explains nothing');

  const absent = render('absent');
  assert.match(absent, /Saved history is unavailable/);
  assert.match(absent, /tell an admin/i);

  const failed = render('failed');
  assert.match(failed, /could not be read just now/);
  // 'failed' and 'absent' are different claims — the 0089 costume rule. They must not share copy.
  assert.notEqual(absent, failed);
});

test('RecentSearches: re-run only where an echo exists, and the facet line stays non-PHI-shaped', () => {
  const html = renderToStaticMarkup(
    <RecentSearches
      items={[
        { id: '1', payer: 'AETNA', prefixEcho: 'GGS', planClass: 'PPO', searchedAt: '2026-08-10T14:22:00Z' },
        { id: '2', payer: 'CIGNA', prefixEcho: null, planClass: null, searchedAt: '2026-08-10T13:00:00Z' },
      ]}
      status="durable"
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
      status="durable"
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
    <RecentSearches items={[]} status="durable" onRerun={() => {}} onClear={() => {}} />,
  );
  assert.match(html, /<h2[^>]*>Recent searches<\/h2>/);
});

test("WatchersPanel's section label renders as an <h2>, so the panel's own <h3>s no longer dangle", () => {
  const html = renderToStaticMarkup(
    <WatchersPanel status="durable" trend={[]} patient={[]} onDelete={() => {}} />,
  );
  assert.match(html, /<h2[^>]*>Watchers<\/h2>/);
  // the Trendwatchers / Patient watchers <h3>s are untouched by this fix
  assert.match(html, /<h3[^>]*>Trendwatchers/);
});
