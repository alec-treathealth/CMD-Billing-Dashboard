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
  UNRESOLVABLE_COPY,
  deriveStage,
  orderedCandidates,
  payerGroupsOf,
  type FlowStage,
  type ResolutionStagesProps,
} from '../components/qualify/v3/resolution-flow';
import { deriveNotices } from '../lib/qualify/resolution';
import type { PanelEvidence, PanelId, QualifyResolution } from '../lib/qualify/resolution';
import type { QualifyFacility, QualifySnapshot } from '../lib/qualify/contract';

const PANELS: readonly PanelId[] = ['kpis', 'ranking', 'policy', 'ladder', 'trend', 'ai'];

function fixture(over: Partial<QualifyResolution> = {}): QualifyResolution {
  const evidence = Object.fromEntries(
    PANELS.map((p) => [
      p,
      p === 'kpis'
        ? { scope: 'book_wide', members: null, lines: null, belowFloor: false, subset: 'book-wide, not this client' }
        : { scope: 'resolution', members: 42, lines: 1358, belowFloor: false, subset: 'Aetna · 42 members' },
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
    provenance: Object.fromEntries(PANELS.map((p) => [p, evidence[p].subset])) as Record<PanelId, string>,
    unmapped: false,
    policyOnFile: true,
    notices: [],
    ...over,
  };
  // Notices are DERIVED, never hand-written — a hand-written set can contradict the candidates in a
  // way the real service cannot, failing tests for fixture reasons rather than flow defects.
  return { ...base, notices: over.notices ?? deriveNotices(base.group, base.candidates, '2026-08-05') };
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

test('the trend ticker rides the IDENTIFY stage only — it must not compete with the question', () => {
  const ticker = <div data-testid="ticker-slot">Facilities Heating Up</div>;
  const on = render(props('identify', null, { ticker }));
  assert.match(on, /data-testid="ticker-slot"/, 'the landing is not left empty');
  for (const [stage, r, over] of [
    ['payer', fixture(), {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
    ['answer', fixture(), {}],
  ] as Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]>) {
    const html = render(props(stage, r, { ...over, ticker }));
    assert.ok(!html.includes('ticker-slot'), `the ticker must not render on the ${stage} stage`);
  }
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

test('I9: no meaning-bearing text below 12px anywhere in the flow', () => {
  for (const [stage, r, over] of [
    ['identify', null, {}],
    ['payer', fixture(), {}],
    ['plan', fixture(), { payerPick: 'Aetna' }],
    ['answer', fixture(), {}],
  ] as Array<[FlowStage, QualifyResolution | null, Partial<ResolutionStagesProps>]>) {
    const html = render(props(stage, r, over));
    for (const tooSmall of ['text-[8.5px]', 'text-[9px]', 'text-[9.5px]', 'text-[10px]', 'text-[10.5px]', 'text-[11px]', 'text-[11.5px]']) {
      assert.ok(!html.includes(tooSmall), `sub-12px class on ${stage}: ${tooSmall}`);
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
  // The auto-window decision is DISCLOSED, with the override one expander away.
  assert.match(html, /Showing trailing 90 days — needed this far back to reach a reliable sample\./);
  assert.match(html, /Change the window/);
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
