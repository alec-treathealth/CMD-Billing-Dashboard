/**
 * I9 — keyboard + assistive-technology acceptance criteria for the v3 STAGED flow, plus the honesty
 * and PHI invariants the flow exists for (docs/qualify-v3-search-pattern.md).
 *
 * These are ACCEPTANCE CRITERIA, not polish, tested the way this repo tests markup:
 * `renderToStaticMarkup` plus role/name/heading assertions. Each corresponds to a measured defect in
 * the v2 surface (§3g) or to the 2026-08-06 staged-flow directive ("one question per screen").
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ResolutionStages,
  NO_ANSWER_FILTERS,
  SKIP_CARRIER_MAX,
  isRefetching,
  scopeKeyOf,
  tickerIsLive,
  areaChipsWithActive,
  UNRESOLVABLE_COPY,
  deriveStage,
  liveSentenceFor,
  orderedCandidates,
  payerGroupsOf,
  type FlowStage,
  type ResolutionStagesProps,
} from '../components/qualify/v3/resolution-flow';
import { deriveNotices, panelProvenance } from '../lib/qualify/resolution';
import type { PanelEvidence, PanelId, QualifyResolution } from '../lib/qualify/resolution';
import type { QualifyFacility, QualifySnapshot } from '../lib/qualify/contract';
import { trailingWindow } from '../lib/qualify/contract';
import { HeatingUpCards, HeatingUpSkeleton } from '../components/qualify/shared/heating-ticker';
import { AREA_ALL, AREA_OTHER, areaKeyFor, facilitiesInArea } from '../components/qualify/m/area-chips';
import { TRENDS } from './helpers/qualifyTrends';

const PANELS: readonly PanelId[] = ['kpis', 'ranking', 'policy', 'ladder', 'trend', 'ai'];

function fixture(over: Partial<QualifyResolution> = {}): QualifyResolution {
  const evidence = Object.fromEntries(
    PANELS.map((p) => [
      p,
      // `subset` is left EMPTY here on purpose, mirroring resolutionService §7 (:386-404) which mints
      // it from `panelProvenance` a few lines later. A hand-written subset is how the disclosure bug
      // shipped — see the mint below.
      p === 'kpis'
        ? { scope: 'book_wide', members: null, lines: null, belowFloor: false, subset: '' }
        : { scope: 'resolution', members: 42, lines: 1358, belowFloor: false, subset: '' },
    ]),
  ) as Record<PanelId, PanelEvidence>;
  const base: QualifyResolution = {
    handle: { kind: 'prefix', readAs: 'read as a 3-character member-ID prefix', echo: 'XDP' },
    group: {
      canonicalPayerId: 'pi_aetna',
      payerDisplayName: 'Aetna',
      payerRelationship: 'same_payer',
      administratorId: null,
      administratorName: null,
      resolutionBasis: 'vob_payer_id',
      employerKey: 'emp_1',
      employerLabel: 'SOUTHWEST AIRLINES CO',
      funding: 'Self-Funded',
      planType: 'PPO',
      policyType: 'PPO',
      network: null,
      groupOnFile: true,
      memberCount: 61,
      vobFreshAsOf: '2026-07-20',
      vobStale: false,
      claimsPayerLabels: ['AETNA US HEALTHCARE'],
      claimEvidence: {
        distinctMembers: 42,
        lines: 1358,
        distinctFacilities: 28,
        distinctPatients: 42,
        sampleTier: 'ok',
        hasReliableAllowed: true,
      },
    },
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        {
          canonicalPayerId: 'pi_cigna',
          payerDisplayName: 'Cigna',
          employerLabel: null,
          funding: null,
          planType: 'POS',
          memberCount: 4,
          hasClaimEvidence: false,
        },
        {
          canonicalPayerId: 'pi_aetna',
          payerDisplayName: 'Aetna',
          employerLabel: 'ACME CO',
          funding: 'Fully Insured',
          planType: null,
          memberCount: 2,
          hasClaimEvidence: true,
        },
      ],
    },
    window: {
      from: '2026-07-06',
      to: '2026-08-05',
      kind: 'trailing',
      chosenBy: 'user',
      ladder: {
        rungs: [
          { days: 30, label: '30 days', members: 2, lines: 40 },
          { days: 90, label: '90 days', members: 12, lines: 380 },
        ],
        proposedDays: 90,
        rationale: '90 days is the narrowest window with at least 3 members of history (12).',
      },
      frozen: false,
    },
    predicateId: 'p_deadbeef',
    evidence,
    // Placeholder only — the real mint happens below, after `over` is merged, so an overridden group
    // gets the provenance IT would really produce.
    provenance: Object.fromEntries(PANELS.map((p) => [p, ''])) as Record<PanelId, string>,
    unmapped: false,
    policyOnFile: true,
    notices: [],
    ...over,
  };
  // Provenance is MINTED from the real `panelProvenance`, never hand-written. This fixture used to
  // carry `subset: 'Aetna · 42 members'` — no employer — while production interpolates
  // `group.employerLabel` (resolution.ts:310), so the disclosure's provenance <dl> rendered
  // "AETNA · FRESNO UNIFIED SCHOOL DISTRICT · 57 members · 1,994 charge lines" live while the skip
  // test's `!html.includes('SOUTHWEST AIRLINES CO')` assertion sailed through against a string that
  // could not contain it. The fixture gap, not the assertion, is what let the bug ship: a fixture
  // that diverges from its mint function tests nothing about the mint. Mirrors resolutionService §7
  // (:383-408) exactly, including writing the same line back into `evidence[p].subset`.
  const mintedEvidence = Object.fromEntries(
    PANELS.map((p) => [p, { ...base.evidence[p], subset: panelProvenance(p, base.evidence[p], base.group) }]),
  ) as Record<PanelId, PanelEvidence>;
  const minted = Object.fromEntries(PANELS.map((p) => [p, mintedEvidence[p].subset])) as Record<PanelId, string>;
  // Notices are DERIVED, never hand-written — a hand-written set can contradict the candidates in a
  // way the real service cannot, failing tests for fixture reasons rather than flow defects.
  return {
    ...base,
    evidence: over.evidence ?? mintedEvidence,
    provenance: over.provenance ?? minted,
    notices: over.notices ?? deriveNotices(base.group, base.candidates, '2026-08-05'),
  };
}

/** A sole-candidate resolution — skips straight to the answer stage. */
const soleCandidate = () =>
  fixture({ candidates: { total: 1, chosenIndex: 0, wasAmbiguous: false, chosenBy: 'sole_candidate', rejected: [] } });

const noop = (): void => {};
const noopAction = (_form: FormData): void => {};

function props(stage: FlowStage, r: QualifyResolution | null, over: Partial<ResolutionStagesProps> = {}): ResolutionStagesProps {
  return {
    stage,
    resolution: r,
    reason: r ? null : 'empty',
    echo: r?.handle.echo ?? '',
    denied: null,
    pending: false,
    payerPick: null,
    planFilter: '',
    identifyAction: noopAction,
    planAction: noopAction,
    onPickPayer: noop,
    onPlanFilter: noop,
    onAskAi: noop,
    onChange: noop,
    onSkip: noop,
    ticker: null,
    answer: r
      ? {
          snapshot: null,
          snapshotError: null,
          aiPanel: null,
          pending: false,
          scopeSource: 'pick',
          payerOverride: null,
          onPayerOverride: noop,
          windowDays: null,
          onWindowDays: noop,
          refetching: false,
          staleAfterError: false,
          onRetry: noop,
          candidates: r ? orderedCandidates(r) : [],
          filters: NO_ANSWER_FILTERS,
          onToggleFilter: noop,
          onClearFilters: noop,
          employerQuery: '',
          onEmployerQuery: noop,
          employerNarrowTooMany: null,
          area: AREA_ALL,
          onSelectArea: noop,
        }
      : null,
    ...over,
  };
}

/** The answer-stage props helper, for overriding scope/window fields per test. */
function answerProps(over: Partial<NonNullable<ResolutionStagesProps['answer']>> = {}): NonNullable<ResolutionStagesProps['answer']> {
  return {
    snapshot: null,
    snapshotError: null,
    aiPanel: null,
    pending: false,
    scopeSource: 'pick',
    payerOverride: null,
    onPayerOverride: noop,
    windowDays: null,
    onWindowDays: noop,
    refetching: false,
    staleAfterError: false,
    onRetry: noop,
    candidates: [],
    filters: NO_ANSWER_FILTERS,
    onToggleFilter: noop,
    onClearFilters: noop,
    employerQuery: '',
    onEmployerQuery: noop,
    employerNarrowTooMany: null,
    area: AREA_ALL,
    onSelectArea: noop,
    ...over,
  };
}

const render = (p: ResolutionStagesProps) => renderToStaticMarkup(<ResolutionStages {...p} />);

// ── The stage machine ────────────────────────────────────────────────────────────────────────────

test('deriveStage: one question per screen, skips only what is genuinely unambiguous', () => {
  assert.equal(deriveStage({ resolution: null, payerPick: null, picked: false }), 'identify');
  // Two carriers behind the prefix → the payer question comes first.
  assert.equal(deriveStage({ resolution: fixture(), payerPick: null, picked: false }), 'payer');
  // Carrier picked → the plan question.
  assert.equal(deriveStage({ resolution: fixture(), payerPick: 'Aetna', picked: false }), 'plan');
  // Plan picked → the answer.
  assert.equal(deriveStage({ resolution: fixture(), payerPick: 'Aetna', picked: true }), 'answer');
  // A sole candidate skips every question — and the answer stage SAYS so via deriveNotices.
  assert.equal(deriveStage({ resolution: soleCandidate(), payerPick: null, picked: false }), 'answer');
});

test('deriveStage: a single carrier with many plans skips the payer stage, not the plan stage', () => {
  const r = fixture({
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'ACME CO', funding: null, planType: null, memberCount: 9, hasClaimEvidence: true },
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'GLOBEX', funding: null, planType: null, memberCount: 3, hasClaimEvidence: false },
      ],
    },
  });
  assert.equal(payerGroupsOf(r).length, 1, 'one carrier');
  assert.equal(deriveStage({ resolution: r, payerPick: null, picked: false }), 'plan');
});

// F3a. deriveStage and liveSentenceFor used to ALWAYS self-derive payerGroupsOf, so the stage the
// flow picked and the carriers the rail counted were two independent derivations that merely
// happened to agree. The shell now threads its ONE memoized set into both. This pins the property
// that makes that safe: supplying the memo can never change the answer — and, just as important,
// that the supplied value is actually REACHED rather than discarded by the ?? fallback.
test('F3a: threading the memoized payerGroups cannot change what deriveStage or liveSentenceFor say', () => {
  const multi = fixture(); // two carriers → the payer question
  const sole = fixture({
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'ACME CO', funding: null, planType: null, memberCount: 9, hasClaimEvidence: true },
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'GLOBEX', funding: null, planType: null, memberCount: 3, hasClaimEvidence: false },
      ],
    },
  });

  for (const [label, r] of [['two carriers', multi], ['one carrier', sole]] as const) {
    for (const payerPick of [null, 'Aetna']) {
      for (const picked of [false, true]) {
        const base = { resolution: r, payerPick, picked };
        assert.equal(
          deriveStage({ ...base, payerGroups: payerGroupsOf(r) }),
          deriveStage(base),
          `deriveStage disagreed with itself (${label}, payerPick=${payerPick}, picked=${picked})`,
        );
      }
    }
    assert.equal(
      liveSentenceFor('payer', r, null, { payerGroups: payerGroupsOf(r) }),
      liveSentenceFor('payer', r, null),
      `liveSentenceFor disagreed with itself (${label})`,
    );
  }

  // NEGATIVE CONTROL — without this, every assertion above would still pass if the ?? fallback
  // always won and the supplied set were ignored. A deliberately wrong set MUST move the answer.
  assert.equal(deriveStage({ resolution: multi, payerPick: null, picked: false }), 'payer');
  assert.equal(
    deriveStage({ resolution: multi, payerPick: null, picked: false, payerGroups: payerGroupsOf(sole) }),
    'plan',
    'a supplied one-carrier set must be USED, not discarded in favour of a self-derive',
  );
  assert.match(
    liveSentenceFor('payer', sole, null, { payerGroups: payerGroupsOf(multi) }),
    /^2 carriers match/,
    'liveSentenceFor must count the SUPPLIED set, not re-derive from the resolution',
  );
});

// OVERTURNED 2026-08-07 (Alec, product directive: "I don't like the tickers on the post-click
// search page. Need them on all the pages."). This test previously read "the IDENTIFY stage only",
// then (same day, location restore) "IDENTIFY and ANSWER — never the two stages that ask a
// question", under the 2026-08-06 rule "it must not compete with the question being asked". Alec is
// the ratifier of that rule and has now overturned it FOR THE TICKER SPECIFICALLY: PAYER and PLAN no
// longer exclude it. The competition argument is not being relitigated here — his directive
// supersedes it outright, and if it needs correcting that is a product call for him, not a technical
// one. REWRITTEN, not deleted, so the reversal stays on record instead of vanishing from history.
test('the trend ticker persists across ALL FOUR stages (2026-08-07 directive overturns IDENTIFY+ANSWER-only)', () => {
  const ticker = <div data-testid="ticker-slot">Facilities Heating Up</div>;
  const cases: Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]> = [
    ['identify', null, {}],
    ['payer', fixture(), {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
    ['answer', fixture(), {}],
  ];
  const byStage: Record<string, string> = {};
  for (const [stage, r, over] of cases) {
    const html = render(props(stage, r, { ...over, ticker }));
    assert.match(html, /data-testid="ticker-slot"/, `the ${stage} stage must not lose the ticker`);
    byStage[stage] = html;
    // OUTSIDE the animated stage subtree on every one of the four — the shell's GSAP targets
    // `[data-v3-stage]` only. This is also what makes ONE PERSISTENT MOUNT possible rather than a
    // per-stage remount: `ResolutionStages` renders `props.ticker` from a single unconditional call
    // site (resolution-flow.tsx), so a stage swap cannot unmount it — a remount would reset the
    // marquee's scroll position on every stage change, which defeats the whole point of "on all the
    // pages".
    assert.ok(
      html.indexOf('ticker-slot') < html.indexOf('data-v3-stage'),
      `${stage}: the ticker must precede the animated subtree, so the tween never touches it`,
    );
  }

  // ── Armed vs. inert, end to end, per stage — spec item 2: this rule is UNCHANGED by the reversal
  // above. `tickerIsLive` still says live only on ANSWER with a snapshot on screen; PAYER and PLAN
  // now show the strip, but as ORIENTATION, not a control — a click there still has no honest
  // target. Rendered through the REAL `<HeatingUpCards>`, with `readOnly` computed exactly the way
  // the shell wires it (resolution-flow-client.tsx `readOnly={!tickerLive}`), so this proves the
  // wiring end to end rather than only the pure predicate (which has its own dedicated test below).
  const rungThrough = (stage: FlowStage, r: QualifyResolution | null, hasSnapshot: boolean, over: Partial<ResolutionStagesProps> = {}) => {
    const live = tickerIsLive(stage, hasSnapshot);
    const real = <HeatingUpCards trends={TRENDS} window={trailingWindow(60)} readOnly={!live} openAs="area" onOpen={noop} />;
    return render(props(stage, r, { ...over, ticker: real }));
  };

  for (const [stage, r, over] of [
    ['identify', null, {}],
    ['payer', fixture(), {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
  ] as Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]>) {
    const html = rungThrough(stage, r, false, over);
    assert.match(html, /Facilities Heating Up/, `${stage}: the ticker rendered — otherwise the inert check below is vacuous`);
    assert.ok(!html.includes('Narrow the ranked list'), `${stage}: an inert ticker must not promise a narrow`);
    assert.match(html, /trend for orientation/, `${stage}: an inert card says what it is instead of promising a filter`);
  }

  const answerLoading = rungThrough('answer', fixture(), false, {});
  assert.match(answerLoading, /trend for orientation/, 'answer stage still loading: nothing to narrow yet, so still inert');

  const answerArmed = rungThrough('answer', fixture(), true, { answer: answerProps({ snapshot: snapshotFixture() }) });
  assert.ok(!answerArmed.includes('trend for orientation'), 'answer + snapshot: a real control, not orientation');
  assert.match(answerArmed, /title="Narrow the ranked list to/, 'answer + snapshot: a card names its narrow');
});

// ── The Skip escape hatch + the answer-stage filter lines (general search) ──────────────────────

test('Skip is offered on BOTH narrowing stages and jumps straight to the answer', () => {
  for (const [stage, over] of [
    ['payer', {}],
    ['plan', { payerPick: 'Aetna' }],
  ] as Array<[FlowStage, Partial<ResolutionStagesProps>]>) {
    const html = render(props(stage, fixture(), over));
    assert.match(html, /Skip/, `${stage} offers Skip`);
    assert.match(
      html,
      /aria-label="Skip the (carrier|plan) step and search across all plans for this member"/,
      `${stage}'s Skip says what it does`,
    );
  }
  // The stage machine honours it, and it is NOT the same input as a plan pick.
  assert.equal(deriveStage({ resolution: fixture(), payerPick: null, picked: false, skipped: true }), 'answer');
  assert.equal(deriveStage({ resolution: fixture(), payerPick: null, picked: false, skipped: false }), 'payer');
});

// ── The refetch flag cannot get stuck (Qodo, PR #126) ───────────────────────────────────────────

test('a NO-OP scope click cannot flip the refetch flag — the stuck-headline bug', () => {
  // The flag was set true by four handlers and cleared in ONE place: the fetch effect's resolve. Any
  // click that did not move an effect dependency left it stuck true forever, and because the
  // stale-sentence rule suppresses the hero numeral, verdict, basis and scope captions while
  // refetching, the answer stage lost its headline permanently. Deriving the flag from
  // requested-vs-rendered makes that unrepresentable: a no-op click cannot change the key.
  const base = { payerLabel: 'AETNA', windowDays: 90, funding: [] as string[], employers: null };
  const key = scopeKeyOf(base);
  assert.equal(scopeKeyOf(base), key, 'the key is stable for identical inputs');
  assert.equal(isRefetching(true, key, key), false, 'rendered scope == requested scope ⇒ not refetching');

  // Each of the four reachable no-op clicks leaves the key untouched.
  assert.equal(scopeKeyOf({ ...base, windowDays: 90 }), key, 'clicking the already-selected window');
  assert.equal(scopeKeyOf({ ...base, funding: [] }), key, 'clearing already-empty filters');
  assert.equal(scopeKeyOf({ ...base, employers: null }), key, 'a filter that yields no employer narrow');
  assert.equal(
    scopeKeyOf({ payerLabel: 'AETNA', windowDays: 90, funding: [], employers: null }),
    key,
    'clicking the active billed-under chip when the override is already null',
  );

  // A REAL change moves the key, so the dim + beam engage.
  for (const changed of [
    { ...base, windowDays: 365 },
    { ...base, payerLabel: 'AETNA US HEALTHCARE' },
    { ...base, payerLabel: null },
    { ...base, funding: ['Self-Funded'] },
    { ...base, employers: ['TESLA'] },
  ]) {
    assert.notEqual(scopeKeyOf(changed), key, `a real change must move the key: ${JSON.stringify(changed)}`);
    assert.equal(isRefetching(true, key, scopeKeyOf(changed)), true, 'and that IS a refetch');
  }

  // Order within a facet is not a change — the key sorts, so chip order cannot cause a phantom fetch.
  assert.equal(
    scopeKeyOf({ ...base, funding: ['Fully Insured', 'Self-Funded'] }),
    scopeKeyOf({ ...base, funding: ['Self-Funded', 'Fully Insured'] }),
  );

  // A FIRST load is never a refetch: no snapshot on screen ⇒ skeleton, not the dim treatment.
  assert.equal(isRefetching(false, null, key), false, 'first load');
  // Nothing on screen is never a refetch — it is a first load, whatever the stamp says. (This used
  // to be justified as "a failed fetch cleared the snapshot"; since F2 a failed fetch KEEPS its
  // snapshot, so that rationale is gone even though the pure-function truth is unchanged.)
  assert.equal(isRefetching(false, 'stale', key), false, 'no content on screen is never a refetch');
  assert.equal(isRefetching(true, null, key), false, 'content present but nothing stamped yet');
});

test('Skip is withheld on the carrier stage when the carrier choice is NOT obvious', () => {
  // With a dozen carriers behind a prefix, skipping resolves the ranking to whichever payer happens
  // to dominate the claims — arbitrary, not general, and indistinguishable from the answer screen.
  const many = fixture({
    candidates: {
      total: 6,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: ['Cigna', 'UMR', 'GEHA', 'Magellan', 'Optum'].map((payerDisplayName, i) => ({
        canonicalPayerId: `pi_${i}`,
        payerDisplayName,
        employerLabel: null,
        funding: null,
        planType: null,
        memberCount: 5 - i,
        hasClaimEvidence: true,
      })),
    },
  });
  assert.ok(payerGroupsOf(many).length >= SKIP_CARRIER_MAX, 'fixture has a non-obvious carrier set');
  const crowded = render(props('payer', many));
  assert.ok(!crowded.includes('search all plans'), 'no Skip offered when the carrier is a real question');
  // Two carriers is the obvious case — Skip returns.
  const obvious = render(props('payer', fixture()));
  assert.equal(payerGroupsOf(fixture()).length, 2);
  assert.match(obvious, /search all plans/, 'Skip is offered when the choice is nearly obvious');
  // The PLAN stage always offers it — by then the population is one carrier's plans.
  assert.match(render(props('plan', many, { payerPick: 'Aetna' })), /search all plans/);
});

test('a skipped search decides nothing past the identifier — the receipt must not claim a plan', () => {
  // r.group is still the PRE-SELECTED candidate (the largest employer). Rendering its employer as a
  // "PLAN" entry claimed a decision the user explicitly declined to make, while the ranking beneath
  // was payer-wide.
  const html = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'skipped' }) }),
  );
  // Scoped to the RECEIPT nav — the step rail also carries a "Plan" label, correctly marked skipped.
  const receipt = html.slice(html.indexOf('aria-label="Your search so far"'), html.indexOf('</nav>'));
  assert.ok(!receipt.includes('>Plan<'), 'no PLAN receipt entry after a skip');
  assert.match(receipt, />Scope</, 'the receipt states the SCOPE instead');
  assert.match(html, /All plans · AETNA US HEALTHCARE/, 'named by the payer the ranking actually used');
  assert.match(html, /Pick a plan/, 'and offers the way back into the funnel');
  // The identity line names the payer, not an unchosen employer's policy.
  assert.match(html, /all plans — no plan chosen/);
  assert.ok(!html.includes('SOUTHWEST AIRLINES CO'), 'the pre-selected employer is never presented as resolved');
  // And the notice that reads "you are seeing the one you selected" is suppressed.
  assert.ok(!html.includes('You are seeing the one you selected'), 'no selection claim after a skip');
});

/** The "How this was resolved" disclosure, sliced. Deliberately scoped: the employer label and the
 *  member counts also reach the filter chips and the identity line, so a whole-document `includes`
 *  answers a different question than the one these assertions are asking. No <details> nests inside
 *  it, so the first closing tag after the summary is its own. */
function disclosureOf(html: string): string {
  const start = html.indexOf('How this was resolved');
  assert.ok(start >= 0, 'the disclosure is on screen');
  const end = html.indexOf('</details>', start);
  assert.ok(end > start, 'the disclosure closes');
  return html.slice(start, end);
}

// Alec, live, 2026-08-07: after "Skip — search all plans" the disclosure still captioned the panels
// "AETNA · FRESNO UNIFIED SCHOOL DISTRICT · 57 members · 1,994 charge lines" — the DECLINED
// candidate's employer cohort. `r.provenance` is minted at resolve time and a Skip never re-resolves
// (resolutionService.ts:383-408 vs resolution-flow-client.tsx:132-143). The data was already
// identifier-wide; only these captions lied. Extends 7c86709, which fixed the receipt, the identity
// line and the live sentence but reached the disclosure only for one notice kind.
test('the resolution disclosure describes the rows on screen after a skip, and is untouched without one', () => {
  const r = fixture();
  const employer = r.group.employerLabel;
  assert.equal(employer, 'SOUTHWEST AIRLINES CO', 'the fixture still carries an employer to leak');

  // ── The regression pin. A NON-skipped answer keeps every resolve-time caption BYTE-IDENTICAL,
  // straight from the server mint — this fix may not move the resolved path by one character.
  const resolved = disclosureOf(
    render(props('answer', r, { answer: answerProps({ snapshot: snapshotFixture() }) })),
  );
  for (const panel of ['ranking', 'policy', 'ai', 'kpis'] as const) {
    assert.ok(
      resolved.includes(`<dd class="text-sm text-ink900">${r.provenance[panel]}</dd>`),
      `the ${panel} caption is the server mint verbatim: ${r.provenance[panel]}`,
    );
  }
  assert.ok(resolved.includes(`${r.group.payerDisplayName} · ${employer} · 42 members · 1,358 charge lines`),
    'and that mint really does carry the employer and counts — otherwise this test proves nothing');
  assert.match(resolved, /panels showing the same value are about the same rows/, 'the same-rows contract stands');
  assert.match(resolved, /In-network status is not captured on this VOB/, 'group-scoped notices stand');

  // ── The fix. A SKIPPED answer captions the same three panels with the identifier-wide truth.
  const skipped = disclosureOf(
    render(props('answer', r, { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'skipped' }) })),
  );
  assert.ok(!skipped.includes(employer!), 'the declined plan\'s employer never captions a panel');
  assert.ok(!skipped.includes('42 members'), 'nor its member count');
  assert.ok(!skipped.includes('1,358 charge lines'), 'nor its charge-line count');
  // Honesty is what IS true, not the absence of what is false (7c86709): each row still says something.
  assert.match(skipped, /whole footprint under AETNA US HEALTHCARE/, 'the ranking names the scope it used');
  assert.match(skipped, /no single policy backs this screen/, 'the policy row states there is no policy');
  assert.match(skipped, /grounded in the ranking on screen/, 'the AI row states what it was fed');
  // The KPI caption is scope 'book_wide' by construction and makes no plan claim — verbatim, always.
  assert.ok(skipped.includes('<dd class="text-sm text-ink900">book-wide, not this client</dd>'),
    'the ratified KPI wording survives a skip byte-for-byte');
  // The predicate: RE-CAPTIONED, not deleted. It names a resolution the panels are not about.
  assert.match(skipped, /p_deadbeef<\/span> identifies the plan that was resolved\s+before you skipped/);
  assert.ok(!/panels showing the same value are about/.test(skipped), 'the same-rows claim is false after a skip');
  // The PLAN-level notices go; the member-level one is a separate case, pinned in its own test below.
  assert.ok(!skipped.includes('In-network status is not captured on this VOB'), 'the declined VOB note is gone');
  assert.match(skipped, /No plan was chosen, so the notes about one plan/, 'and their absence is explained');
});

// FINDING 1 (r2). `scopeSource` is derived from payerOverride/pickLabel/skipped and knows nothing
// about the answer-stage filter chips (resolution-flow-client.tsx:222-224), but the fetch effect
// folds active filters into a real `market` payload (client :278-294). So Skip → one Funding chip
// left v1's caption asserting "this identifier's whole footprint" over a funding-narrowed snapshot,
// contradicting the "Ranking over N of M plans" line a few rows up.
test('a skipped search that is then FILTERED says so — "whole footprint" is a claim about the fetch', () => {
  const r = fixture();
  const disclosure = (over: Partial<NonNullable<ResolutionStagesProps['answer']>>) =>
    disclosureOf(
      render(
        props('answer', r, {
          answer: answerProps({
            snapshot: snapshotFixture(),
            scopeSource: 'skipped',
            candidates: orderedCandidates(r),
            ...over,
          }),
        }),
      ),
    );

  // No filters: the r1 strings, unchanged.
  const wide = disclosure({});
  assert.match(wide, /whole footprint under AETNA US HEALTHCARE/, 'unfiltered, the skip caption is untouched');
  assert.ok(!wide.includes('narrowed by your filter selections'), 'and claims no narrow');

  // A funding chip goes straight into the market — the ranking is NOT the whole footprint.
  const narrowed = disclosure({ filters: { planTypes: [], funding: ['Self-Funded'], employers: [] } });
  assert.ok(!narrowed.includes('whole footprint'), 'a narrowed fetch may not be captioned as the whole footprint');
  assert.match(narrowed, /all plans — no plan chosen, then narrowed by your filter selections under AETNA US HEALTHCARE/);
  assert.match(narrowed, /grounded in the ranking on screen — all plans, no plan chosen, narrowed by your filter selections/);

  // ...and the precision that a bare `filtersActive` check would get wrong: selecting EVERY employer
  // in the universe is not a narrow (employerNarrowFor :325 returns null), nothing extra reaches the
  // request, so the whole-footprint wording is the true one even though filters are active.
  const notANarrow = disclosure({
    filters: { planTypes: [], funding: [], employers: ['SOUTHWEST AIRLINES CO', 'ACME CO'] },
  });
  assert.match(notANarrow, /whole footprint under AETNA US HEALTHCARE/, 'a filter that narrows nothing narrows nothing');
  assert.ok(!notANarrow.includes('narrowed by your filter selections'), 'claiming otherwise would be the same defect inverted');
});

// FINDING 2 (r2). v1 asserted every deriveNotices kind was group-scoped and suppressed all of them.
// `no_policy_on_file` is MEMBER-level ("No verification of benefits on file for this member") and
// survives a skip on the path this bug came from.
test('a skipped search keeps the MEMBER-level no-VOB notice and suppresses the plan-level ones', () => {
  const r = fixture();
  const skipRender = (res: QualifyResolution) =>
    disclosureOf(
      render(props('answer', res, { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'skipped' }) })),
    );

  // VOB-backed: every notice on this resolution really is about the plan that was declined.
  const vobBacked = skipRender(r);
  assert.ok(!vobBacked.includes('In-network status is not captured on this VOB'), 'the plan-level VOB note goes');
  assert.ok(!vobBacked.includes('You are seeing the one you selected'), 'so does the selection claim');
  assert.match(vobBacked, /Pick a plan from the receipt to see them/, 'a VOB-bearing identifier is shown the way back to them');

  // claims_only at chosenIndex 0. resolutionService §3 pushes every VOB row before any claims-only
  // row (:243-302, nothing sorts afterwards), so this PROVES the identifier has no VOB row at all —
  // the notice is then a statement about the member, not about a plan.
  const noVobGroup = {
    ...r.group,
    resolutionBasis: 'claims_only' as const,
    employerLabel: null,
    funding: null,
    planType: null,
    vobFreshAsOf: null,
  };
  const noVob = skipRender(fixture({ group: noVobGroup }));
  assert.match(noVob, /No verification of benefits on file for this member/, 'the member-level truth survives the skip');
  assert.ok(!noVob.includes('Pick a plan from the receipt to see them'),
    'and the copy stops promising notes that no plan behind this identifier can carry');

  // The chosenIndex-0 gate is exactly what the VOB-first ordering proves. A pick-then-skip (receipt
  // Change → plan → Skip, which never clears state.resolution) can leave a claims-only group chosen
  // out of a VOB-BEARING set, where the member-level claim would be false. Unprovable, so unstated.
  const unprovable = skipRender(fixture({ group: noVobGroup, candidates: { ...r.candidates, chosenIndex: 1 } }));
  assert.ok(!unprovable.includes('No verification of benefits on file'), 'an unprovable member-level claim is not made');
});

// FINDING 3 (r2). The key safety decision — skipUnder reads snap.resolved.payerName and NEVER
// scopePayer's g.payerDisplayName fallback — had no coverage, because every other assertion renders
// with a snapshot in hand. This is the window where the fallback would fire.
test('before the snapshot lands, a skipped caption names NO payer rather than the declined one', () => {
  const loading = disclosureOf(
    render(props('answer', fixture(), { answer: answerProps({ snapshot: null, scopeSource: 'skipped' }) })),
  );
  assert.ok(!loading.includes('Aetna'), 'the declined candidate\'s carrier never reaches the caption');
  assert.match(loading, /whole footprint/, 'the caption degrades to the scope-less form');
  assert.ok(!loading.includes(' under '), 'naming nobody beats naming a payer we cannot stand behind');
});

test('a skipped search says it was skipped — never "we could not narrow"', () => {
  const skipped = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'skipped' }) }),
  );
  assert.match(skipped, /You skipped the plan questions, so this is a general search/);
  assert.ok(!skipped.includes('could not be scoped to'), 'declining to narrow is not a failure to narrow');
  // And the two claims stay distinct: a genuine bridge failure keeps its own wording.
  const dominant = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'dominant' }) }),
  );
  assert.match(dominant, /could not be scoped to/);
  assert.ok(!dominant.includes('You skipped the plan questions'), 'a failure to narrow is not a skip');
});

test('the filter lines are visible controls, multiselect, and state what they did to the ranking', () => {
  const r = fixture();
  const html = render(
    props('answer', r, {
      answer: answerProps({
        snapshot: snapshotFixture(),
        candidates: orderedCandidates(r),
        filters: { planTypes: ['PPO'], funding: [], employers: [] },
      }),
    }),
  );
  // Facets derived from the candidate universe, each an aria-pressed toggle (not a dropdown).
  assert.match(html, />Plan type</);
  assert.match(html, />Funding</);
  assert.match(html, /aria-pressed="true"[^>]*>PPO/, 'the active facet reads pressed');
  assert.match(html, / · on/, 'and carries a WORD, not just a hue');
  // The employer control is a real dropdown pill, stating its reach in its own summary.
  assert.match(html, />Employers</);
  assert.match(html, /Searched over 2|Narrowed to \d+ of 2/);
  // What the filter did to the ranking is STATED, with a way out.
  assert.match(html, /Ranking over \d+ of \d+ plans/);
  assert.match(html, /Clear filters/);
});

test('an employer narrow too large to send says the ranking is NOT employer-narrowed', () => {
  // sanitizeMarket SLICES employers at 200; sending more would rank over a subset while the screen
  // implied the whole set. The caption has to admit it instead.
  const r = fixture();
  const html = render(
    props('answer', r, {
      answer: answerProps({
        snapshot: snapshotFixture(),
        candidates: orderedCandidates(r),
        filters: { planTypes: ['PPO'], funding: [], employers: [] },
        employerNarrowTooMany: 311,
      }),
    }),
  );
  assert.match(html, /too many employers \(311\) to narrow the ranking by employer, so it is not/);
});

test('the step rail names every step, and a SKIPPED step says so — it never reads as done', () => {
  // A sole candidate skips both questions; the rail must not imply the user answered them.
  const sole = render(props('answer', soleCandidate()));
  assert.match(sole, /Identify/);
  assert.match(sole, /Carrier/);
  assert.match(sole, /Plan/);
  assert.match(sole, /Answer/);
  assert.equal((sole.match(/— skipped/g) ?? []).length, 2, 'Carrier AND Plan read as skipped');
  // A real multi-plan pick reaches the answer with both questions ANSWERED — nothing skipped.
  const picked = render(props('answer', fixture()));
  assert.equal((picked.match(/— skipped/g) ?? []).length, 0, 'answered questions are done, not skipped');
  assert.ok((picked.match(/— done/g) ?? []).length >= 3, 'the walked stages read as done');
  // The rail is decorative navigation: no buttons, and no second live region.
  const railChunk = sole.slice(sole.indexOf('data-v3-rail'), sole.indexOf('aria-live'));
  assert.ok(!/<button/.test(railChunk), 'rail segments are not controls — the receipt is the revisit affordance');
});

test('exactly one stage section renders at a time', () => {
  const stages: Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]> = [
    ['identify', null, {}],
    ['payer', fixture(), {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
    ['answer', fixture(), {}],
  ];
  for (const [stage, r, over] of stages) {
    const html = render(props(stage, r, over));
    const sections = ['qualify-s-identify', 'qualify-s-payer', 'qualify-s-plan', 'qualify-s-answer'].filter((id) =>
      html.includes(`id="${id}"`),
    );
    assert.deepEqual(sections, [`qualify-s-${stage}`], `stage ${stage} renders only its own section`);
  }
});

// ── Landmark + heading structure ─────────────────────────────────────────────────────────────────

test('I9: the flow is a named landmark and the active stage is a <section> whose <h2> is the question', () => {
  for (const [stage, r, over, question] of [
    ['identify', null, {}, 'Who are we looking at?'],
    ['payer', fixture(), {}, 'Which carrier is on the card?'],
    ['plan', fixture(), { payerPick: 'Aetna' }, 'Which plan is it?'],
    ['answer', fixture(), {}, 'Does this payer pay us — and where?'],
  ] as Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>, string]>) {
    const html = render(props(stage, r, over));
    assert.match(html, /role="region"/, 'the flow is a landmark');
    assert.match(html, /aria-labelledby="qualify-v3-flow-heading"/, 'and it is NAMED');
    assert.match(html, /<h1 id="qualify-v3-flow-heading"/, 'the name resolves to a real heading');
    assert.ok(html.includes(`id="qualify-s-${stage}"`), `${stage} section rendered`);
    assert.ok(html.includes(`aria-labelledby="qualify-s-${stage}-heading"`), `${stage} labelled by its heading`);
    assert.ok(html.includes(question), `${stage}'s h2 IS the question`);
  }
});

// ── The single live region ───────────────────────────────────────────────────────────────────────

test('I9: exactly ONE aria-live region, announcing the stage as a full sentence', () => {
  const payerHtml = render(props('payer', fixture()));
  assert.equal((payerHtml.match(/aria-live=/g) ?? []).length, 1, 'one live region on the payer stage');
  assert.match(payerHtml, /2 carriers match what you typed\. Pick the one on the card\./);

  const planHtml = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  assert.equal((planHtml.match(/aria-live=/g) ?? []).length, 1, 'one live region on the plan stage');
  assert.match(planHtml, /3 plans match\. Pick one, or ask the AI about one\./);

  const answerHtml = render(props('answer', fixture()));
  assert.equal((answerHtml.match(/aria-live=/g) ?? []).length, 1, 'one live region on the answer stage');
  assert.match(answerHtml, /aria-live="polite"/, 'polite, not assertive');
  assert.match(answerHtml, /Resolved: Aetna · SOUTHWEST AIRLINES CO · Self-Funded\./, 'a full sentence');
  assert.match(answerHtml, /3 plans matched; this one is selected\./, 'states a choice was made');
});

test('I9: the live region states the reason when nothing resolved', () => {
  for (const reason of ['empty', 'prefix_too_short', 'no_match'] as const) {
    const html = render(props('identify', null, { reason }));
    assert.ok(html.includes(UNRESOLVABLE_COPY[reason]), `${reason} is announced verbatim`);
  }
  const texts = new Set(Object.values(UNRESOLVABLE_COPY));
  assert.equal(texts.size, 3, 'the three unresolved states must not share copy');
});

// ── Text size floor ─────────────────────────────────────────────────────────────────────────────

// F4 (2026-08-06). This test was passing over markup it never rendered. `props()` defaults
// `ticker: null` and no case overrode it, so the Heating-Up strip — real content on a real rep's
// screen — was outside the sweep, and shipped FIVE sub-12px classes (one at 9px). The answer stage
// was scanned only in its skeleton state for the same reason: with `snapshot: null` the whole
// snapshot-bearing subtree (scorecard grid, filter lines, receipt) never rendered.
//
// Two structural fixes, both of which matter more than the size assertions themselves:
//   1. The case list now renders the REAL <HeatingUpCards> and <HeatingUpSkeleton> the shell ships
//      (resolution-flow-client.tsx:403-411), and an answer stage WITH a snapshot.
//   2. Each case asserts a POSITIVE CONTROL first. Without one, a refactor that stops rendering
//      `props.ticker` would make this test vacuously green again — which is exactly the failure
//      being fixed here, and a green vacuous test is worse than no test.
test('I9: no meaning-bearing text below 12px anywhere in the flow', () => {
  const ticker = <HeatingUpCards trends={TRENDS} window={trailingWindow(60)} readOnly />;
  const cases: Array<[string, FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>, RegExp]> = [
    ['identify', 'identify', null, {}, /Search/],
    ['payer', 'payer', fixture(), {}, /Aetna/],
    ['plan', 'plan', fixture(), { payerPick: 'Aetna' }, /Aetna/],
    ['answer (skeleton)', 'answer', fixture(), {}, /Ranking facilities for this plan/],
    // The two branches the shell actually mounts on the landing. `readOnly` and the 60-day window
    // mirror production exactly (TICKER_WINDOW, resolution-flow-client.tsx:60).
    ['identify + real ticker', 'identify', null, { ticker }, /Facilities Heating Up/],
    ['identify + ticker skeleton', 'identify', null, { ticker: <HeatingUpSkeleton /> }, /Loading trends/],
    // The 2026-08-07 directive put the (inert) strip on PAYER and PLAN too — markup this sweep never
    // saw before, because every case above it either predates the reversal or is the landing. Same
    // readOnly ticker as the identify case; different surrounding stage markup underneath it.
    ['payer + inert ticker', 'payer', fixture(), { ticker }, /Facilities Heating Up/],
    ['plan + inert ticker', 'plan', fixture(), { payerPick: 'Aetna', ticker }, /Facilities Heating Up/],
    // The answer stage with data — the branch the skeleton case above never reaches. Added
    // 2026-08-06 and green on arrival; it found nothing at the time, it is coverage, not a fix.
    ['answer + snapshot', 'answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture() }) }, /NASHVILLE MENTAL HEALTH/],
    // The AREA facet's own markup (2026-08-07): the chip row, its counts, and the narrowing
    // sentence. `area: 'TN'` is what puts the last two on screen at all — the unfiltered case above
    // renders neither, so without this row the floor sweep would never scan them.
    [
      'answer + area facet active',
      'answer',
      fixture(),
      { answer: answerProps({ snapshot: snapshotFixture(), area: 'TN' }) },
      /ranked facilities in this area/,
    ],
    // ...and the ANSWER-stage ticker, which is a live control there rather than the landing's inert
    // strip. Different markup (chevrons, enabled buttons), so it needs its own sweep.
    [
      'answer + live area ticker',
      'answer',
      fixture(),
      {
        answer: answerProps({ snapshot: snapshotFixture() }),
        ticker: <HeatingUpCards trends={TRENDS} window={trailingWindow(60)} openAs="area" onOpen={noop} />,
      },
      /Facilities Heating Up/,
    ],
  ];

  for (const [label, stage, r, over, mustRender] of cases) {
    const html = render(props(stage, r, over));
    // POSITIVE CONTROL — prove this case rendered the markup it claims to be sweeping.
    assert.match(html, mustRender, `${label}: rendered nothing to scan — the floor check would be vacuous`);
    // A regex sweep, not a literal blocklist: the old list enumerated seven exact strings, so
    // text-[8px] or text-[11.75px] would have passed silently. px-only, deliberately — no rem/em
    // arbitrary text sizes exist anywhere in app/components/qualify today.
    for (const m of html.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
      assert.ok(Number(m[1]) >= 12, `sub-12px class on ${label}: text-[${m[1]}px]`);
    }
  }
});

// ── Accessible names on numerals ────────────────────────────────────────────────────────────────

test('I9: every bare numeral carries an accessible name', () => {
  const payerHtml = render(props('payer', fixture()));
  assert.match(payerHtml, /aria-label="63 verified members under this carrier"/, 'carrier member total is named');
  assert.match(payerHtml, /aria-label="2 plans under this carrier"/, 'carrier plan count is named');
  const planHtml = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  assert.match(planHtml, /aria-label="61 members on this plan"/, 'plan member count is named');
});

// ── Keyboard path + native controls ─────────────────────────────────────────────────────────────

test('I9: native forms and controls — no positive tabindex anywhere', () => {
  for (const [stage, r, over] of [
    ['identify', null, {}],
    ['payer', fixture(), {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
    ['answer', fixture(), {}],
  ] as Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]>) {
    const html = render(props(stage, r, over));
    assert.ok(!/tabindex="[1-9]/.test(html), `no positive tabindex on ${stage}`);
  }
});

test('I9: the identify input is labelled and described, not placeholder-only', () => {
  const html = render(props('identify', null));
  assert.match(html, /for="qualify-term"/, 'an explicit label association');
  assert.match(html, /aria-describedby="qualify-term-help"/, 'help text is associated, not adjacent');
  assert.match(html, /id="qualify-term-help"/);
  assert.ok(!/placeholder="[^"]{20,}"/.test(html), 'no long placeholder standing in for a label');
});

test('I9: the reading of the input is stated back to the user', () => {
  const html = render(props('identify', fixture()));
  assert.match(html, /We read as a 3-character member-ID prefix\./, 'the screen says HOW it read the input');
});

// ── PHI ─────────────────────────────────────────────────────────────────────────────────────────

test('PHI: no form GETs — the typed identifier must never reach a query string', () => {
  // THE REGRESSION THIS PINS: an early flow version used `<form method="GET" action="/qualify">`,
  // which puts the identifier in browser history, the Referer header and edge logs.
  for (const [stage, r, over] of [
    ['identify', null, {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
  ] as Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]>) {
    const html = render(props(stage, r, over));
    assert.ok(!/method="get"/i.test(html), `no GET form on ${stage}`);
    for (const tag of html.match(/<form[^>]*>/g) ?? []) {
      assert.ok(!/action="[^"]*\?/.test(tag), `a form action carries a query string on ${stage}: ${tag}`);
    }
  }
});

test('PHI: the plan forms carry NO term field — the identifier lives in shell memory, not the DOM', () => {
  // The shell injects the held term into FormData at dispatch. A hidden term field would round-trip
  // a full member id through the DOM; the earlier S1/S2 forms round-tripped the EMPTY echo instead,
  // which silently re-resolved a full-id search as 'empty'. Neither is acceptable.
  const html = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  const hiddenNames = [...html.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hiddenNames.length > 0, 'the plan tiles submit their candidate index');
  for (const n of hiddenNames) {
    assert.equal(n, 'candidate', `only the candidate index may be hidden, found: ${String(n)}`);
  }
});

test('PHI: a member-id handle renders no echo — the full id never reaches the markup', () => {
  const r = fixture({ handle: { kind: 'member_id', readAs: 'read as a complete member ID (10 characters)', echo: '' } });
  const html = render(props('identify', r));
  assert.match(html, /value=""/, 'the input round-trips an empty echo rather than the id');
  // And the receipt names the READING, not the value.
  const answerHtml = render(props('answer', r));
  assert.match(answerHtml, /read as a complete member ID/, 'the receipt describes the identifier without echoing it');
});

test('PHI: no URL carries employer identity', () => {
  const html = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  assert.ok(!/[?&]employer/.test(html), 'no query string mentions an employer');
});

test('a gate denial is its own state, not an empty result', () => {
  const html = render(props('identify', null, { denied: 'Your role does not have access to Qualify.', reason: null }));
  assert.match(html, /Your role does not have access to Qualify\./);
  assert.ok(!html.includes(UNRESOLVABLE_COPY.no_match), 'a denial is not a no-match');
});

// ── The honesty requirements the staged flow exists for ─────────────────────────────────────────

test('the payer stage states how many carriers and asks the user to pick', () => {
  const html = render(props('payer', fixture()));
  assert.match(html, /2 carriers/, 'the carrier count is stated');
  assert.match(html, /Pick the one on the card in front of you\./, 'the question is a real question');
  // Both carriers are tiles, largest first.
  const aetna = html.indexOf('Aetna');
  const cigna = html.indexOf('Cigna');
  assert.ok(aetna >= 0 && cigna >= 0 && aetna < cigna, 'carriers ordered by member count, largest first');
});

test('the plan stage shows EVERY possibility under the carrier and admits the largest is a guess', () => {
  const html = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  assert.match(html, /2 plans/, 'the plan count under this carrier is stated');
  assert.match(html, /every possibility we have on file/);
  assert.match(html, /The largest is a guess, not an answer\./);
  assert.match(html, /SOUTHWEST AIRLINES CO/);
  assert.match(html, /ACME CO/);
  assert.ok(!html.includes('Cigna'), "the other carrier's plans do not bleed into this stage");
});

test('a no-evidence candidate is marked BEFORE selection', () => {
  const html = render(props('plan', fixture({
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'NO HISTORY CO', funding: null, planType: null, memberCount: 3, hasClaimEvidence: false },
        { canonicalPayerId: 'pi_cigna', payerDisplayName: 'Cigna', employerLabel: null, funding: null, planType: 'POS', memberCount: 4, hasClaimEvidence: false },
      ],
    },
  }), { payerPick: 'Aetna' }));
  assert.match(
    html,
    /No claim history — a ranking here would have nothing behind it/,
    'the zero-evidence plan is called out in the tile, not after the click',
  );
});

test('each plan tile offers exactly two actions: use it, or ask the AI about it', () => {
  const html = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  const tiles = html.split('name="candidate"').slice(1);
  assert.equal(tiles.length, 2, 'two plans under Aetna, two tiles');
  for (const t of tiles) {
    const chunk = t.slice(0, t.indexOf('</form>'));
    assert.match(chunk, /Use this plan/);
    assert.match(chunk, /Ask AI about this plan/);
  }
});

test('plan tiles render in RANK order — the list must not reshuffle when the user acts', () => {
  const r = fixture({
    candidates: {
      total: 3,
      chosenIndex: 2, // the LAST candidate is the chosen one
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'AAA FIRST', funding: null, planType: null, memberCount: 90, hasClaimEvidence: true },
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'BBB SECOND', funding: null, planType: null, memberCount: 50, hasClaimEvidence: true },
      ],
    },
  });
  assert.deepEqual(
    orderedCandidates(r).map((c) => c.index),
    [0, 1, 2],
    'the chosen candidate is reinserted at its own rank',
  );
  const html = render(props('plan', r, { payerPick: 'Aetna' }));
  const order = [...html.matchAll(/name="candidate" value="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [0, 1, 2], `plan tiles must render in rank order, got ${order.join(',')}`);
});

test('the type-to-narrow filter appears only past the threshold, and states its own coverage', () => {
  const many = fixture({
    candidates: {
      total: 10,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: Array.from({ length: 9 }, (_, i) => ({
        canonicalPayerId: 'pi_aetna',
        payerDisplayName: 'Aetna',
        employerLabel: `EMPLOYER ${i + 1}`,
        funding: null,
        planType: null,
        memberCount: 9 - i,
        hasClaimEvidence: i % 2 === 0,
      })),
    },
  });
  const html = render(props('plan', many, { payerPick: 'Aetna' }));
  assert.match(html, /Narrow by employer/, 'the filter appears for a long tail');
  assert.match(html, /Showing 10 of 10 plans\./, 'and states its coverage');
  const filtered = render(props('plan', many, { payerPick: 'Aetna', planFilter: 'EMPLOYER 3' }));
  assert.match(filtered, /Showing 1 of 10 plans\./, 'narrowing is stated, not silent');
  const none = render(props('plan', many, { payerPick: 'Aetna', planFilter: 'ZZZZ' }));
  assert.match(none, /No plan sponsor matches that text\./, 'an empty filter result is stated');
  const few = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  assert.ok(!few.includes('Narrow by employer'), 'no filter noise for a short list');
});

test('the receipt names every decision and each entry is revisitable', () => {
  const html = render(props('answer', fixture()));
  assert.match(html, /aria-label="Your search so far"/, 'the receipt is a named nav landmark');
  assert.match(html, />Search</);
  assert.match(html, />Carrier</);
  assert.match(html, />Plan</);
  assert.match(html, /SOUTHWEST AIRLINES CO/);
  assert.ok((html.match(/>Change</g) ?? []).length >= 3, 'every receipt entry carries a Change action');
});

test('a sole candidate says it was unambiguous rather than saying nothing', () => {
  const html = render(props('answer', soleCandidate()));
  assert.match(html, /Only one plan matched what you typed/);
  assert.ok(!html.includes('plans match what you typed.'), 'and does not also claim ambiguity');
});

test('notice severity carries a WORD, not just a hue', () => {
  const html = render(props('answer', fixture()));
  assert.match(html, />Caution</, 'a caution notice says Caution');
  assert.match(html, />Note</, 'an info notice says Note');
});

test('the network gap is stated, never left blank', () => {
  const html = render(props('answer', fixture()));
  assert.match(html, /Network not captured on this VOB/);
});

test('the book-wide KPI provenance is rendered verbatim, and the predicate id is shown', () => {
  const html = render(props('answer', fixture()));
  assert.match(html, /book-wide, not this client/, 'the ratified wording reaches the screen');
  assert.match(html, /KPI tiles/, 'attributed to the KPI panel');
  assert.match(html, /p_deadbeef/);
  assert.match(html, /panels showing the same\s+value are about the same rows/);
});

test('the answer stage without a snapshot is an honest loading state, and an error is not an empty result', () => {
  const loading = render(props('answer', fixture()));
  assert.match(loading, /Ranking facilities for this plan…/);
  const failed = render(props('answer', fixture(), { answer: answerProps({ snapshotError: 'failed' }) }));
  assert.match(failed, /The facility ranking could not be loaded\./);
  assert.match(failed, /The plan resolution above still stands/);
  // A FIRST-load failure has nothing to preserve, so it stays the plain error state: no grid to
  // keep, nothing to dim, and no Retry control (the refresh banner owns that affordance).
  assert.ok(!failed.includes('Try again'), 'a first-load failure has nothing to retry into');
  assert.ok(!failed.includes('opacity-60'), 'nothing on screen to dim');
  assert.ok(!failed.includes('NASHVILLE MENTAL HEALTH'), 'no grid without a snapshot');
});

/** The answer hero's wordless placeholder (the `h-14` ghost that replaces the numeral/verdict while
 *  the content on screen is stale), or null. Scoped deliberately: the step rail's current-stage dot
 *  also carries `animate-pulse`, so a bare html.includes('animate-pulse') answers a different
 *  question than the one these tests are asking. */
function heroGhostOf(html: string): string | null {
  return html.match(/class="h-14[^"]*"/)?.[0] ?? null;
}

// F2. A failed RE-SCOPE used to null the snapshot, so one failed chip click threw away a perfectly
// good answer and replaced the whole stage with a paragraph. Worse, it was unrecoverable: the fetch
// effect keys on scopeKey, which a same-chip re-click does not move, so "try again" — which the copy
// literally said — could not be done. The answer stage stayed dead until the user re-searched.
test('F2: a failed refetch KEEPS the last answer on screen, dimmed, with the error appended', () => {
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: snapshotFixture(),
        snapshotError: 'failed',
        staleAfterError: true,
        refetching: false,
      }),
    }),
  );
  // The answer survives — this is the whole point.
  assert.match(html, /NASHVILLE MENTAL HEALTH/, 'the scorecard must survive a failed refetch');
  assert.match(html, /could not be refreshed/, 'and the failure must still be stated');
  assert.match(html, /Nothing was lost/);
  assert.match(html, /opacity-60/, 'stale content is dimmed, exactly like an in-flight re-scope');
  // …but WITHOUT claiming progress. A stopped fetch that animates a progress marker is the
  // stuck-flag lie 7a40728/bef4c57 fixed, re-introduced through a different door.
  assert.ok(!html.includes('q-refetch-beam'), 'a stopped fetch must not animate a progress beam');
  // Scoped to the HERO placeholder specifically — the step rail's current-stage dot also pulses,
  // legitimately, and says nothing about the fetch.
  assert.ok(heroGhostOf(html) !== null, 'the hero placeholder should still hold the footprint');
  assert.ok(
    !(heroGhostOf(html) ?? '').includes('animate-pulse'),
    'nor a pulsing hero placeholder — motion is a progress claim',
  );
  assert.ok(
    !html.includes('Ranking facilities for this plan…'),
    'a failed refetch is not a first load and must not render the skeleton',
  );
});

test('F2: the failed refetch offers a REAL retry control, not just the words "try again"', () => {
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), snapshotError: 'failed', staleAfterError: true }),
    }),
  );
  const banner = html.slice(html.indexOf('could not be refreshed'));
  assert.match(
    banner,
    /<button type="button"[^>]*>Try again<\/button>/,
    'retry must be a native <button type="button"> — not a link, not a span with a handler',
  );
});

test('F2: an in-flight refetch still claims progress; only a FAILED one goes quiet', () => {
  const inFlight = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), refetching: true, staleAfterError: false }),
    }),
  );
  // The pre-existing treatment is untouched: dim + beam + pulse while genuinely fetching.
  assert.match(inFlight, /opacity-60/);
  assert.match(inFlight, /q-refetch-beam/, 'a running fetch DOES animate its progress beam');
  assert.ok(
    (heroGhostOf(inFlight) ?? '').includes('animate-pulse'),
    'and its hero placeholder DOES pulse — this is the treatment F2 must not have broken',
  );
  assert.ok(!inFlight.includes('could not be refreshed'), 'and says nothing about failure');
});

// The window sentence has two populations with different honesty properties, and the fix is
// GRANULAR to match. The manual variant ("— your selection") states the user's own action — a fact,
// allowed to speak immediately during an in-flight refetch (the standing RULE 2654416 ruling, pinned
// below in its own test). The AUTO variants read the RENDERED snapshot's LADDER — a data claim
// about the set being replaced — so they wait like every other categorical sentence. And after a
// FAILED refetch the whole sentence waits regardless of variant: there is no beam, the duration is
// unbounded post-F2, and the failure banner ("it still shows the scope you were on before") would be
// directly contradicted by "Showing trailing 365 days" printed beside it.
test('the window sentence: ladder variants wait while stale; nothing speaks over the failure banner', () => {
  // Non-stale, both variants render:
  const manual = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), windowDays: 365 }) }));
  assert.match(manual, /Showing trailing 365 days — your selection\./);
  const auto = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture() }) }));
  assert.match(auto, /needed this far back to reach a reliable sample\./);

  // In-flight + AUTO: the sentence reads the stale snapshot's ladder — it waits.
  const autoInFlight = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), refetching: true }) }),
  );
  assert.ok(!autoInFlight.includes('Showing trailing'), 'the ladder sentence is a data claim — it waits in flight');

  // Failed refetch: BOTH variants wait — the failure banner owns the description of what is shown.
  for (const windowDays of [365, null] as const) {
    const failed = render(
      props('answer', fixture(), {
        answer: answerProps({ snapshot: snapshotFixture(), windowDays, snapshotError: 'failed', staleAfterError: true }),
      }),
    );
    assert.ok(
      !failed.includes('Showing trailing'),
      `after a failed refetch the sentence must not contradict the banner (windowDays=${windowDays})`,
    );
    assert.match(failed, />Window</, 'the Window control line stays — it is the escape route');
  }
});

test('going back to the search step announces the STAGE, not the stale result', () => {
  const html = render(props('identify', fixture()));
  assert.match(html, /Back at the search step\. Searching again replaces the current result\./);
  assert.ok(!html.includes('Resolved: Aetna'), 'the live region must not describe a screen no longer shown');
});

test('a stale carrier pick with zero plans is stated plainly, not rendered as an empty grid', () => {
  const html = render(props('plan', fixture(), { payerPick: 'CARRIER THAT VANISHED' }));
  assert.match(html, /No plans are on file under CARRIER THAT VANISHED in this result\./);
  assert.ok(!html.includes('Use this plan'), 'no tiles under a vanished carrier');
  assert.ok(!html.includes('Clear the filter'), 'and no filter copy presuming a filter caused it');
});

// ── The answer stage with a snapshot ─────────────────────────────────────────────────────────────

/** Only the fields StageAnswer and derivePolicyRating actually read — cast per-object, markup tests. */
function facility(over: Partial<QualifyFacility>): QualifyFacility {
  return {
    rank: 1,
    name: 'NASHVILLE MENTAL HEALTH',
    facilityKey: 'NASH',
    city: 'Nashville',
    state: 'TN',
    ratingV2: 62,
    iqBand: '50', // the real QualifyIqBand vocabulary — renders as "Solid · 50%+"
    distinctPatients: 14,
    lineCount: 210,
    careSetting: 'IP',
    factors: [
      { key: 'claims', label: 'Claims reliability', weight: 25, score: 70, available: true, direction: 'pos', detail: '62% of billed allowed across 210 lines.' },
      { key: 'authFit', label: 'Auth fit', weight: 10, score: 40, available: false, direction: 'neutral', detail: 'No completed-stay data yet.' },
    ],
    ...over,
  } as unknown as QualifyFacility;
}

function snapshotFixture(): QualifySnapshot {
  return {
    resolved: { payerName: 'AETNA US HEALTHCARE' },
    facilities: [
      facility({}),
      facility({ rank: 2, name: 'KENTUCKY WELLNESS CENTER', facilityKey: 'KWC', city: null, state: null, ratingV2: null, iqBand: null, distinctPatients: 2, lineCount: 9 }),
    ],
    ladder: { rungs: [], chosenDays: 90, sufficient: true },
    payerOptions: [
      { payer: 'AETNA US HEALTHCARE', lines: 856, patients: 31, lastPayment: '2026-08-01' },
      { payer: 'AETNA', lines: 3690, patients: 122, lastPayment: '2026-08-02' },
    ],
    payerOverridden: false,
  } as unknown as QualifySnapshot;
}

test('the answer stage: window disclosed in one line, hero named, unrated card is honest restraint', () => {
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture() }) }));
  // The auto-window decision is DISCLOSED, and the override is now a VISIBLE line rather than a
  // dropdown (2026-08-06: the window buttons sit on screen beside the other control lines).
  assert.match(html, /Showing trailing 90 days — needed this far back to reach a reliable sample\./);
  assert.ok(!html.includes('Change the window'), 'the window override is no longer behind a disclosure');
  assert.match(html, />Window</, 'it is a labelled control line');
  assert.match(html, /Automatic · selected/, 'with the current choice stated as a word');
  // The hero numeral carries an accessible name.
  assert.match(html, /aria-label="policy rating \d+ out of 100"/);
  // Ranked cards: the rated one shows its number + band word; the thin one shows restraint, no colour.
  assert.match(html, /aria-label="rating 62 out of 100"/);
  assert.match(html, /Solid/);
  assert.match(html, /Not enough data to rate — 2 patients in window/);
  // Each card explains itself behind ONE disclosure, with direction as a WORD.
  assert.match(html, /Why this score/);
  assert.match(html, />Helps</);
  assert.match(html, />No data</);
  // The claims-side scope chips render; the caption matrix has its own test below.
  assert.match(html, /Billed under/);
});

// ── Scope honesty (review Critical 1): the ranking's payer scope is a CLAIM and must be labelled ──

test('the billed-under caption distinguishes "you picked", "your plan implies", "we defaulted", and a REJECTED override', () => {
  const overridden = { ...snapshotFixture(), payerOverridden: true } as QualifySnapshot;
  // A user chip click, honoured.
  const user = render(props('answer', fixture(), { answer: answerProps({ snapshot: overridden, scopeSource: 'user', payerOverride: 'AETNA US HEALTHCARE' }) }));
  assert.match(user, /Your selection\./);
  // The plan pick's own claims label, honoured.
  const pick = render(props('answer', fixture(), { answer: answerProps({ snapshot: overridden, scopeSource: 'pick' }) }));
  assert.match(pick, /Scoped to the plan you picked\./);
  // An override was SENT but the core rejected it — this must never render as honoured.
  const rejected = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'pick' }) }));
  assert.match(rejected, /Could not scope to the picked plan — showing the largest by volume\./);
  assert.ok(!/Scoped to the plan you picked\./.test(rejected), 'a rejected override is not a scoping');
  // Nothing was sent at all.
  const dominant = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'dominant' }) }));
  assert.match(dominant, /Largest by volume — pick another to re-scope\./);
});

test('a dominant-scoped ranking under a multi-plan pick states the mismatch in words, not chips', () => {
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'dominant' }) }));
  assert.match(html, /could not be scoped to Aetna/);
  assert.match(html, /under AETNA US HEALTHCARE, its largest payer by volume\./);
});

test('a plan with no claims history says the ranking is not evidence about it', () => {
  const noClaims = fixture();
  noClaims.group.claimEvidence = { ...noClaims.group.claimEvidence, lines: 0, distinctMembers: 0, distinctPatients: 0, distinctFacilities: 0, sampleTier: 'insufficient' };
  noClaims.group.claimsPayerLabels = [];
  const html = render(props('answer', noClaims, { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'dominant' }) }));
  assert.match(html, /This plan has no claims history of its own/);
  assert.match(html, /not evidence about Aetna/);
});

test('RULE 2654416: during a re-scope, categorical sentences wait — only dimmed numbers may speak', () => {
  // The window chip's state updates synchronously, so mid-fetch the disclosure reads the NEW window
  // while every derived read is still the OLD set. A stale NUMBER beside a visible marker (the dim +
  // beam) is honest — the marker says so. A categorical SENTENCE gets no such marker, so it waits.
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: snapshotFixture(), // the 90-day set, still on screen
        refetching: true,
        windowDays: 365, // the user's own action — a fact, allowed to speak immediately
        scopeSource: 'dominant',
      }),
    }),
  );
  // The user's action and the dimmed evidence stay:
  assert.match(html, /Showing trailing 365 days — your selection\./);
  assert.match(html, /NASHVILLE MENTAL HEALTH/, 'the scorecard grid stays rendered');
  assert.match(html, /opacity-60/, 'behind the dim marker');
  assert.match(html, /q-refetch-beam/, 'and the progress beam');
  // The sentence-bearing claims about data that has not answered yet are ABSENT:
  assert.ok(!/policy rating \d+ out of 100/.test(html), 'the hero numeral + verdict wait');
  assert.ok(!html.includes('patient-weighted across'), 'rating.basis is a DATA claim — false during a fetch (e7e8a0e)');
  assert.ok(!html.includes('Largest by volume — pick another to re-scope.'), 'the scope caption asserts one of four claims — it waits');
  assert.ok(!html.includes('could not be scoped to'), 'the dominant-scope warning waits');
  // And this is a refetch, not a first load — the skeleton must NOT appear:
  assert.ok(!html.includes('Ranking facilities for this plan…'), 'no skeleton on a refetch');
});

test('the window default is stated honestly when automatic sizing was unavailable', () => {
  const noLadder = { ...snapshotFixture(), ladder: null } as QualifySnapshot;
  const auto = render(props('answer', fixture(), { answer: answerProps({ snapshot: noLadder }) }));
  assert.match(auto, /the default window; automatic sizing is not available for this search\./);
  assert.ok(!auto.includes('your selection'), 'a default the user never chose must not be called theirs');
  const manual = render(props('answer', fixture(), { answer: answerProps({ snapshot: noLadder, windowDays: 180 }) }));
  assert.match(manual, /Showing trailing 180 days — your selection\./);
});

// ── The AREA facet — the restored location narrow (2026-08-07) ───────────────────────────────────
//
// WHAT THESE PIN. v2's desktop tab had a Facility type-ahead in its primary search row and a
// clickable Heating Up ticker; the v3 cutover dropped both, and the ratified pattern doc's
// deliberate-drops list does not mention either — a casualty, not a ruling. The restoration is a
// GRID narrow over facilities the ranking already returned. The most important assertions below are
// therefore the negative ones: that the facet reaches nothing describing what was FETCHED.

/** A facility set spanning two states plus an unmapped one, so 'Other' is always exercised. */
function threeStateSnapshot(): QualifySnapshot {
  return {
    ...snapshotFixture(),
    facilities: [
      facility({ rank: 1, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH', city: 'Nashville', state: 'TN' }),
      facility({ rank: 2, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', city: 'Phoenix', state: 'AZ' }),
      facility({ rank: 3, name: 'UNLISTED BH', facilityKey: 'UNL', city: null, state: null }),
    ],
  } as unknown as QualifySnapshot;
}

test('areaChipsWithActive: All + sorted states + Other, and an unmapped facility is NEVER dropped', () => {
  const chips = areaChipsWithActive(threeStateSnapshot().facilities, AREA_ALL);
  assert.deepEqual(chips.map((c) => c.key), [AREA_ALL, 'AZ', 'TN', AREA_OTHER], 'states alpha-sorted, Other last');
  assert.deepEqual(chips.map((c) => c.label), ['All', 'AZ', 'TN', 'Other']);

  // Every facility lands in exactly one bucket, and the buckets add up to the whole set — the
  // "never dropped" claim stated as arithmetic rather than as a comment.
  const facilities = threeStateSnapshot().facilities;
  const bucketed = chips.filter((c) => c.key !== AREA_ALL).flatMap((c) => facilitiesInArea(facilities, c.key));
  assert.equal(bucketed.length, facilities.length, 'the buckets partition the set — nothing falls out');
  assert.deepEqual(facilitiesInArea(facilities, AREA_OTHER).map((f) => f.facilityKey), ['UNL']);

  // A BOOK-WIDE ticker card can seed a state this member has no history in. The chip is appended so
  // the narrow stays visible and clearable; swallowing it would leave an unclearable empty grid.
  const seeded = areaChipsWithActive(facilities, 'OR');
  assert.deepEqual(seeded.map((c) => c.key), [AREA_ALL, 'AZ', 'TN', AREA_OTHER, 'OR']);
  const seededOther = areaChipsWithActive([facility({ state: 'TN' })], AREA_OTHER);
  assert.deepEqual(seededOther.map((c) => c.label), ['All', 'TN', 'Other'], "the appended bucket says 'Other', not the sentinel");
});

test('the area chips render on the answer stage, counted, with selection as a WORD', () => {
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: threeStateSnapshot() }) }));
  // POSITIVE CONTROL — the grid really rendered, so the assertions below are about a real screen.
  assert.match(html, /NASHVILLE MENTAL HEALTH/, 'the scorecard rendered — otherwise this test is vacuous');
  assert.match(html, /aria-label="Filter the ranked list by area"/, 'the row is a named group');
  assert.match(html, /aria-label="3 ranked facilities"/, 'All is counted');
  assert.match(html, />Other<span/, 'the unmapped bucket is offered, not hidden');
  // I9: selection carries a word, never hue alone.
  const active = render(props('answer', fixture(), { answer: answerProps({ snapshot: threeStateSnapshot(), area: 'TN' }) }));
  assert.match(active, /TN<span[^>]*>[^<]*· 1<\/span> · showing/, 'the active chip says "showing"');
  assert.match(active, /aria-pressed="true"/);
  // FINDING 3 (review r2): a THREE-facility ranking across three distinct states means every
  // per-state chip's own count IS 1 — "1 ranked facilities" was the COMMON case, not an edge case.
  // The 'All' chip above pins the plural at n=3; this pins the singular at n=1, so both branches of
  // the ternary are covered rather than just the one that happened not to expose the bug.
  assert.match(active, /aria-label="1 ranked facility"/, 'a count of one is singular, never "1 ranked facilities"');
  assert.ok(!active.includes('1 ranked facilities'), 'the buggy plural must not survive at n=1');

  // ONE bucket is not a choice: a single-state ranking shows no row at all.
  const oneState = { ...snapshotFixture(), facilities: [facility({ state: 'TN' })] } as unknown as QualifySnapshot;
  const single = render(props('answer', fixture(), { answer: answerProps({ snapshot: oneState }) }));
  // FINDING 7 (review r2): POSITIVE CONTROL. Without this, a refactor that stopped rendering the
  // scorecard entirely would still pass the negative assertion below — it too would lack the string
  // "Filter the ranked list by area", but for the wrong reason (nothing rendered at all).
  assert.match(single, /NASHVILLE MENTAL HEALTH/, 'the scorecard itself rendered — otherwise the negative assertion below is vacuous');
  assert.ok(!single.includes('Filter the ranked list by area'), 'a one-chip row is noise, not a control');
});

test('an active area narrows the GRID and says so — the hero keeps covering the whole ranking', () => {
  const wide = render(props('answer', fixture(), { answer: answerProps({ snapshot: threeStateSnapshot() }) }));
  for (const name of ['NASHVILLE MENTAL HEALTH', 'PHOENIX RENEWAL', 'UNLISTED BH']) {
    assert.ok(wide.includes(name), `${name} is on screen unfiltered`);
  }
  assert.ok(!wide.includes('ranked facilities in this area'), 'no narrow, no narrowing sentence');

  const tn = render(props('answer', fixture(), { answer: answerProps({ snapshot: threeStateSnapshot(), area: 'TN' }) }));
  assert.match(tn, /NASHVILLE MENTAL HEALTH/, 'the TN facility stays');
  assert.ok(!tn.includes('PHOENIX RENEWAL'), 'the AZ facility is hidden');
  assert.ok(!tn.includes('UNLISTED BH'), 'and so is the unmapped one');
  assert.match(tn, /ranked facilities in this area\. The ranking itself was not re-run/, 'the narrow states its own reach');
  assert.match(tn, /the rating above still covers all 3/, 'and refuses to claim the hero moved with it');
  // The hero is derived from the WHOLE set, so it must be byte-identical across the narrow.
  const heroOf = (h: string) => /aria-label="policy rating (\d+) out of 100"/.exec(h)?.[1] ?? null;
  assert.ok(heroOf(wide) !== null, 'the unfiltered hero rendered a number');
  assert.equal(heroOf(tn), heroOf(wide), 'a GRID narrow may not move the headline number');

  // The Other bucket is selectable and holds exactly the unmapped facility.
  const other = render(props('answer', fixture(), { answer: answerProps({ snapshot: threeStateSnapshot(), area: AREA_OTHER }) }));
  assert.match(other, /UNLISTED BH/);
  assert.ok(!other.includes('NASHVILLE MENTAL HEALTH'));
});

test('an area with no ranked facility is an honest empty state, not the no-history one', () => {
  // Reachable from a Heating Up card: the ticker is BOOK-WIDE and this member may have no history
  // in that state. The two emptinesses are different claims and must not share copy.
  const empty = render(props('answer', fixture(), { answer: answerProps({ snapshot: threeStateSnapshot(), area: 'OR' }) }));
  assert.match(empty, /No ranked facility is in this area\./, 'it says which emptiness this is');
  assert.match(empty, /The 3 facilities behind this\s+answer are still there — choose All above to see them\./);
  assert.ok(
    !empty.includes('No facility has claims history under this scope'),
    'that sentence is about the payer and the window, and it would be false here',
  );
  assert.match(empty, /OR<span/, 'the chip for the empty area is still on screen, so the narrow is clearable');
  // FINDING 2 (review r2): MUTUAL ABSENCE. Before the fix, `areaActive` alone gated the "Showing 0 of
  // 3 ranked facilities in this area…" sentence, so it rendered RIGHT ALONGSIDE "No ranked facility
  // is in this area" — two overlapping `role="status"` sentences making the same claim twice, one of
  // them with a "Showing 0 of…" framing this test's OWN assertions above already prove is redundant.
  // NOT a bare `!includes('Showing')` — the Window line legitimately renders "Showing trailing N
  // days" on every render, area or not, and that sentence must stay untouched. `facilities shown` is
  // the aria-label text unique to the suppressed sentence's count span.
  assert.ok(!empty.includes('facilities shown'), 'the "Showing 0 of N" sentence must not render when the area is empty');
  assert.ok(
    !empty.includes('The ranking itself was not re-run'),
    'that is the OTHER area-active sentence\'s tail — it must not co-render with the empty-area one',
  );

  // And the genuinely-empty ranking keeps its own, different sentence.
  const noRows = { ...snapshotFixture(), facilities: [] } as unknown as QualifySnapshot;
  const none = render(props('answer', fixture(), { answer: answerProps({ snapshot: noRows }) }));
  assert.match(none, /No facility has claims history under this scope in the window shown\./);
  assert.ok(!none.includes('No ranked facility is in this area'), 'nothing was narrowed — do not blame a chip');
});

test('HONESTY GUARD: an active area does NOT flip any caption that describes the FETCH', () => {
  // flow-state.ts invariant (m). `rankingNarrowed` keys on filters.funding and the employer narrow;
  // the area facet is a sibling of `filters`, never a member, so it cannot enter. This test is what
  // makes that structural claim a checked one: fold `area` into AnswerFilters (or add
  // `|| props.area !== AREA_ALL` to rankingNarrowed) and it goes red on the first assertion.
  const r = fixture();
  const skipped = (over: Partial<NonNullable<ResolutionStagesProps['answer']>>) =>
    render(
      props('answer', r, {
        answer: answerProps({
          snapshot: threeStateSnapshot(),
          scopeSource: 'skipped',
          candidates: orderedCandidates(r),
          ...over,
        }),
      }),
    );

  const withArea = skipped({ area: 'TN' });
  const disclosure = disclosureOf(withArea);
  assert.match(disclosure, /whole footprint under AETNA US HEALTHCARE/, 'the fetch WAS the whole footprint — say so');
  assert.ok(
    !disclosure.includes('narrowed by your filter selections'),
    'a grid narrow is not a fetch narrow; claiming otherwise misdescribes the request',
  );
  // Nor may it summon the plans line, which counts CANDIDATES and would read "N of N".
  assert.ok(!withArea.includes('Ranking over'), 'the plan-count line belongs to the request-shaping filters');
  assert.ok(!withArea.includes('Clear filters'), 'and so does its Clear button — the All chip is the area\'s clear');
  // Positive control on the same fixture: a FUNDING chip DOES flip it, so the assertions above are
  // testing suppression rather than an unreachable branch.
  const funded = disclosureOf(skipped({ filters: { planTypes: [], funding: ['Self-Funded'], employers: [] } }));
  assert.match(funded, /narrowed by your filter selections/, 'a real fetch narrow still says so');
});

// FINDING 1 (review r2 — "the one that matters"). The skip disclosure's AI caption said "grounded
// in the ranking on screen" unconditionally, but `<QualifyAiPanel snapshot={snapshot}>`
// (resolution-flow-client.tsx) is handed the FULL snapshot, never `shownFacilities` — so with an
// area chip active the grid shows a subset of the ranking while the AI answers over all of it, and
// "on screen" became a claim about a ranking the AI was never actually confined to. Same standard
// as the hero rating's "the rating above still covers all 3": say what backs the answer instead of
// letting a grid-only control silently relabel it.
test('the AI provenance caption stops claiming "on screen" grounding once an area narrows the grid', () => {
  const r = fixture();
  const skipped = (over: Partial<NonNullable<ResolutionStagesProps['answer']>>) =>
    disclosureOf(
      render(
        props('answer', r, {
          answer: answerProps({
            snapshot: threeStateSnapshot(),
            scopeSource: 'skipped',
            candidates: orderedCandidates(r),
            ...over,
          }),
        }),
      ),
    );

  // No area: BYTE-IDENTICAL to the string that shipped before this fix — the no-area render may not
  // move by one character. `threeStateSnapshot()` carries `resolved.payerName`, so `skipUnder`
  // appends " under AETNA US HEALTHCARE"; the fixture-carried suffix is part of the frozen string.
  const wide = skipped({});
  assert.ok(
    wide.includes(
      '<dd class="text-sm text-ink900">grounded in the ranking on screen — all plans, no plan chosen under AETNA US HEALTHCARE</dd>',
    ),
    'without an area, "on screen" is still true and the caption must render unchanged',
  );

  // An active area: the grid is narrower than what the AI actually read, so "on screen" is now a
  // false grounding claim and must not appear at all.
  const narrowed = skipped({ area: 'TN' });
  assert.ok(
    !narrowed.includes('grounded in the ranking on screen'),
    'the AI reads the full snapshot, not the area-narrowed grid — "on screen" is false with an area active',
  );
  assert.match(
    narrowed,
    /grounded in the full ranking behind this answer, not the narrowed grid — all plans, no plan chosen/,
    'the corrected wording says what actually backs the answer instead',
  );

  // The `rankingNarrowed` arm is independent of the area arm — both must combine, not override.
  const both = skipped({ area: 'TN', filters: { planTypes: [], funding: ['Self-Funded'], employers: [] } });
  assert.match(
    both,
    /grounded in the full ranking behind this answer, not the narrowed grid — all plans, no plan chosen, narrowed by your filter selections/,
    'an area AND a filter narrow combine into one honest sentence, not two competing ones',
  );
});

// ── The re-armed ticker (v2's clickable strip, restored with a v3 meaning) ───────────────────────

test('tickerIsLive: a card is a control only when there is a ranking to narrow', () => {
  assert.equal(tickerIsLive('answer', true), true, 'answer + snapshot — the only live case');
  assert.equal(tickerIsLive('answer', false), false, 'the answer is still loading: nothing to narrow yet');
  for (const stage of ['identify', 'payer', 'plan'] as const) {
    assert.equal(tickerIsLive(stage, true), false, `${stage} has no ranked grid, so the strip is orientation`);
    assert.equal(tickerIsLive(stage, false), false);
  }
});

test('the landing ticker is INERT and the answer ticker is a real area control', () => {
  // Landing: `readOnly` renders every card as a disabled non-button. An inert card must not look
  // clickable — that is the dead-target failure the strip already refuses to ship.
  const landing = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={trailingWindow(60)} readOnly openAs="area" />);
  assert.equal((landing.match(/<button/g) ?? []).length, (landing.match(/disabled=""/g) ?? []).length,
    'every card on the landing is disabled');
  assert.match(landing, /trend for orientation/, 'and says what it is instead of promising a filter');
  assert.ok(!landing.includes('Narrow the ranked list'), 'the landing promises no narrow');

  // Answer stage: live.
  const live = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={trailingWindow(60)} openAs="area" onOpen={noop} />);
  assert.ok(!live.includes('disabled=""'), 'every card is drivable in area mode');
  assert.match(live, /title="Narrow the ranked list to AZ"/, 'a mapped card names its state');
  assert.match(live, /title="Narrow the ranked list to facilities with no mapped area"/, 'an unmapped one is honest, not dead');
  assert.ok(!live.includes('Filter to '), "v2's facility+payer promise must not survive into area mode");

  // ⚠ THE CASE THAT MAKES `openAs` EARN ITS EXISTENCE, and the one every card in TRENDS misses:
  // dominantPayer NULL. Under v2's reading that card is inert, because {facility + dominant payer}
  // is unexpressible without a payer. Under the AREA reading it is perfectly drivable — the click
  // seeds a state bucket and never looks at the payer. Without this pair the openability rule could
  // silently revert to `!!t.dominantPayer` and the whole suite would stay green (it did, on the
  // first mutation sweep of this change).
  const orphan = [{ ...TRENDS[0]!, facilityKey: 'orphan', name: 'ORPHAN FAC', dominantPayer: null }];
  const orphanArea = renderToStaticMarkup(<HeatingUpCards trends={orphan} window={trailingWindow(60)} openAs="area" onOpen={noop} />);
  assert.ok(!orphanArea.includes('disabled=""'), 'no dominant payer is no obstacle to picking an AREA');
  assert.match(orphanArea, /title="Narrow the ranked list to AZ"/, 'and it says which area');
  const orphanV2 = renderToStaticMarkup(<HeatingUpCards trends={orphan} window={trailingWindow(60)} onOpen={noop} />);
  assert.match(orphanV2, /disabled=""/, "v2's reading still refuses the dead click");
  assert.match(orphanV2, /no dominant payer to filter on this window/);

  // The v2 default is otherwise untouched.
  const v2 = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={trailingWindow(60)} onOpen={noop} />);
  assert.match(v2, /title="Filter to SUMMIT RIDGE RECOVERY \+ AETNA"/, 'the default reading is unchanged');
});

test('a ticker click seeds the area the SAME way the grid buckets it', () => {
  // The shell maps a card to a facet key with `areaKeyFor(t.state)` — the identical function
  // `facilitiesInArea` buckets by. Two mappings would eventually disagree, and the disagreement
  // shows up as a chip that selects an area containing none of the facilities it named.
  assert.equal(areaKeyFor('TN'), 'TN');
  assert.equal(areaKeyFor(null), AREA_OTHER, 'an unmapped card seeds Other, it does not seed nothing');
  assert.equal(areaKeyFor(''), AREA_OTHER, 'and neither does a blank string');
  for (const t of TRENDS) {
    const key = areaKeyFor(t.state);
    const chips = areaChipsWithActive(threeStateSnapshot().facilities, key);
    assert.ok(chips.some((c) => c.key === key), `a click on ${t.name} always lands on a chip that exists`);
  }
});
