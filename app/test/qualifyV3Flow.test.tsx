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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AreaLine,
  ResolutionStages,
  NO_ANSWER_FILTERS,
  SKIP_CARRIER_MAX,
  employerNarrowFor,
  facetsOf,
  filterCandidates,
  isRefetching,
  scopeKeyOf,
  skipOffered,
  tickerIsLive,
  areaChipsWithActive,
  bookIsOnScreen,
  bookLeadsAnswer,
  gridNarrowEmptyCopy,
  rebuiltAtSentence,
  windowMoveNotice,
  NO_FACILITY_NARROW,
  UNRESOLVABLE_COPY,
  answerableCarriers,
  carrierResolutionFor,
  deriveStage,
  liveSentenceFor,
  orderedCandidates,
  payerGroupsOf,
  railStates,
  scopeSourceOf,
  soleAnswerableCarrier,
  type AnswerFilters,
  type FlowStage,
  type OrderedCandidate,
  type ResolutionStagesProps,
} from '../components/qualify/v3/resolution-flow';
import {
  INITIAL_SHELL_STATE,
  shellReducer,
  type ShellAction,
} from '../components/qualify/v3/flow-state';
import { revealScopeFor } from '../components/qualify/shell/shell-session';
// The band washes the verdict card paints, measured against the facet pills that now sit on it.
import { IQ_BAND_WASH } from '../components/qualify/tokens';
import { deriveNotices, panelProvenance } from '../lib/qualify/resolution';
import type { PanelEvidence, PanelId, QualifyResolution } from '../lib/qualify/resolution';
import type { QualifyFacility, QualifySnapshot } from '../lib/qualify/contract';
import { QUALIFY_NO_FACILITY, trailingWindow } from '../lib/qualify/contract';
import type { QualifyFacilityNarrowOption } from '../lib/qualify/facilityVariants';
import { HeatingUpCards, HeatingUpSkeleton } from '../components/qualify/shared/heating-ticker';
import { AREA_ALL, AREA_OTHER, areaKeyFor, facilitiesInArea } from '../components/qualify/m/area-chips';
import { TRENDS } from './helpers/qualifyTrends';

const PANELS: readonly PanelId[] = ['kpis', 'ranking', 'policy', 'ladder', 'trend', 'ai'];

/** React escapes `'` to `&#x27;` in a text node, so copy carrying one must be asserted as it renders
 *  rather than as it is authored. The alternative — a typographic apostrophe — is used nowhere in
 *  this surface's copy, and inventing one here to dodge an escape would be a style fork. */
const esc = (s: string): string => s.replace(/'/g, '&#x27;');

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
          // ⚠ `true`, AND IT WAS `false` UNTIL 2026-08-11 — the flip preserves this fixture's MEANING
          // rather than changing it. `deriveStage` now counts ANSWERABLE carriers, so with Cigna at
          // `false` this fixture had exactly one answerable cluster (Aetna) and would AUTO-RESOLVE:
          // eleven `props('payer', …)` renders and three `deriveStage` assertions that exist to
          // exercise "several carriers, so ask the question" would instead have been silently
          // re-baselined onto the auto-resolve path, deleting the coverage they were written for.
          // `fixture()` means "a genuinely ambiguous carrier question" everywhere it is used, so it
          // now carries two answerable carriers and keeps meaning that. The dead-end shapes get their
          // own fixtures below — `deadEndCarriers()` and `noAnswerableCarriers()`.
          hasClaimEvidence: true,
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

/**
 * THE DEFECT SHAPE, AS MEASURED (Alec's report, 2026-08-11). Three carrier clusters behind one token,
 * and only ONE of them can answer anything: Aetna carries real history, while "AETNA /CAMH" and
 * "SADDLEBACK" are 1-member / 1-plan / no-history fragments. Before the answerable-aware predicate
 * this rendered a full three-tile carrier question whose only rational answer was to skip it.
 *
 * ⚠ "AETNA /CAMH" MUST NOT CLUSTER WITH "Aetna", or this fixture would be a 2-cluster one and prove
 * nothing. `clusterCarriers` merges on text similarity but the CROSSWALK OUTRANKS IT — two
 * confirmed-but-DIFFERENT `canonicalPayerId`s never merge (payerGroupsOf's own note) — so the
 * distinct `pi_camh` id is what keeps them apart. The assertion in the auto-resolve tests re-checks
 * the cluster count for exactly that reason: a fixture that quietly collapsed to two clusters would
 * still "pass" the stage assertion for the wrong reason.
 */
const deadEndCarriers = () =>
  fixture({
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        {
          canonicalPayerId: 'pi_camh',
          payerDisplayName: 'AETNA /CAMH',
          employerLabel: null,
          funding: null,
          planType: null,
          memberCount: 1,
          hasClaimEvidence: false,
        },
        {
          canonicalPayerId: 'pi_saddleback',
          payerDisplayName: 'SADDLEBACK',
          employerLabel: null,
          funding: null,
          planType: null,
          memberCount: 1,
          hasClaimEvidence: false,
        },
      ],
    },
  });

/**
 * NOTHING behind this token can answer — the chosen group has no history either. Distinct from
 * `deadEndCarriers()` and deliberately NOT folded into it: "one obvious answer" and "no answer at
 * all" are different states, and the whole point of the 2026-08-11 change is that the flow must not
 * collapse them. Here `deriveStage` keeps asking the carrier question, because there is no cluster to
 * resolve TO and machine-setting `skipped` would fake an operator act.
 */
const noAnswerableCarriers = () =>
  fixture({
    group: { ...fixture().group, claimEvidence: { ...fixture().group.claimEvidence, lines: 0 } },
    candidates: {
      total: 3,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        {
          canonicalPayerId: 'pi_camh',
          payerDisplayName: 'AETNA /CAMH',
          employerLabel: null,
          funding: null,
          planType: null,
          memberCount: 1,
          hasClaimEvidence: false,
        },
        {
          canonicalPayerId: 'pi_saddleback',
          payerDisplayName: 'SADDLEBACK',
          employerLabel: null,
          funding: null,
          planType: null,
          memberCount: 1,
          hasClaimEvidence: false,
        },
      ],
    },
  });

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
          skipped: false,
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
          employerNarrowTooMany: null,
          area: AREA_ALL,
          onSelectArea: noop,
          // S4: EMPTY by default, which is the pre-vocabulary state a real mount also passes through
          // (the options are a mount-once fail-soft fetch). An empty vocabulary renders no control at
          // all, so every case in this file that does not opt in is byte-identical to before S4.
          facilityOptions: [],
          facilityNarrow: NO_FACILITY_NARROW,
          onToggleFacility: noop,
          narrowExpanded: false,
          onToggleNarrow: noop,
          // S5: idle, fresh-unknown, no window move — the state every pre-S5 case was implicitly in,
          // so nothing in this file changes render unless it opts in by name.
          refreshing: false,
          dataRebuiltAt: null,
          windowMove: null,
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
    skipped: false,
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
    employerNarrowTooMany: null,
    area: AREA_ALL,
    onSelectArea: noop,
    // S4: see the note in `props()` — an empty vocabulary means no facility control, so tests about
    // it opt in by name exactly as the ones about the card's CONTROLS do.
    facilityOptions: [],
    facilityNarrow: NO_FACILITY_NARROW,
    onToggleFacility: noop,
    // CLOSED, because that is `INITIAL_SHELL_STATE.narrowExpanded` and therefore what an operator
    // meets on every path except a Skip. Deliberately NOT mirrored off `skipped` here: a helper that
    // quietly opened the card would leave every "the toggles are live" assertion below silently
    // dependent on a default nobody wrote down. Tests about the CONTROLS opt in by name.
    narrowExpanded: false,
    onToggleNarrow: noop,
    // S5: see the note in `props()` — idle and freshness-unknown is the default, and tests about the
    // refresh control or the rebuild time opt in by name.
    refreshing: false,
    dataRebuiltAt: null,
    windowMove: null,
    ...over,
  };
}

const render = (p: ResolutionStagesProps) => renderToStaticMarkup(<ResolutionStages {...p} />);

/**
 * THE CONTROL CARD'S OWN MARKUP, BOUNDED AT ITS CLOSING TAG — and the reason this exists is the whole
 * point of the assertions that use it.
 *
 * ⚠ EVERY INVENTORY ASSERTION IN THIS FILE USED TO READ
 * `html.slice(html.indexOf('data-v3-inventory'))`, WHICH RUNS TO THE END OF THE DOCUMENT. That is not
 * a card-scoped slice; it is "the card AND EVERYTHING AFTER IT", which on this stage means the AREA
 * row, the hero rating, the whole scorecard grid and the AI panel. So an assertion reading "the
 * inventory lists Billed under" was satisfied by a Billed-under row rendered ANYWHERE below the card,
 * and the `>= 5 data-v3-facet` reveal count was satisfied by hooks belonging to other regions.
 * Measured at e4fea0f: the unbounded slice found SEVEN `data-v3-facet`, only six of them the card's.
 * A collapse that moved rows out of the card — or wrapped them in a closed `<details>`, which
 * serializes its children into the SSR string — kept every one of those assertions GREEN while the
 * operator could see none of it. This file already names that failure mode: "A guard that cannot fail
 * is worse than no guard, because it reads as coverage" (the negative at the end of the headline
 * test). Bounding is what makes the collapse below testable at all.
 *
 * Walks tag depth from the opening tag, so it returns the element's real outerHTML and nothing else.
 * Tag-name-agnostic on purpose: the card is a `<section>` today and was a `<div>` yesterday, and a
 * helper that hard-coded either would silently mis-bound on the next change.
 */
function outerHtmlFrom(html: string, from: number): string {
  assert.ok(from >= 0, 'no opening tag found before the marker');
  const tag = html.slice(from, from + 40).match(/^<([a-zA-Z][a-zA-Z0-9-]*)/)?.[1];
  assert.ok(tag !== undefined, 'could not read the element tag name');
  const region = html.slice(from);
  let depth = 0;
  for (const m of region.matchAll(new RegExp(`<${tag}(?=[\\s/>])|</${tag}>`, 'g'))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return region.slice(0, (m.index ?? 0) + m[0].length);
  }
  return assert.fail(`unbalanced <${tag}> in this render`);
}

function inventoryRegion(html: string): string {
  const attr = html.indexOf('data-v3-inventory');
  assert.ok(attr >= 0, 'no [data-v3-inventory] element in this render — a region check would be vacuous');
  return outerHtmlFrom(html, html.lastIndexOf('<', attr));
}

/** The same bounding discipline one level down: the `<div>` ROW that contains `marker`. Written for
 *  the billed-under row, whose old hand-rolled slice ran between two strings that the NARROW SEARCH
 *  card then reordered — the row's caption moved into the card summary ABOVE it, so the slice
 *  silently inverted and produced an empty string. A bound derived from the markup's own structure
 *  cannot invert like that. */
function rowAround(html: string, marker: string): string {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `\`${marker}\` is not in this render — the row check would be vacuous`);
  return outerHtmlFrom(html, html.lastIndexOf('<div', at));
}

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

// ── THE ANSWERABLE-CARRIER PREDICATE (2026-08-11) ─────────────────────────────────────────────────
//
// The defect, measured live: `deriveStage` counted CLUSTERS, so a token carrying one real carrier plus
// two 1-member/1-plan/no-history fragments ("AETNA /CAMH", "SADDLEBACK") put up a full three-tile
// carrier question. The operator's only rational move was to skip it, and the reported session shows
// exactly that — straight through to "All carriers · All plans, 4/4". A question whose extra options
// cannot produce an answer is a click the surface charges for nothing.
//
// The fix must clear a HIGHER bar than "stop asking", and these tests are that bar: an auto-resolve
// the operator cannot see is worse than a pointless question, because a narrowing nobody announced is
// one nobody can overrule.

test('answerableCarriers counts history, and nothing else — no member floor, no alias lookup', () => {
  const groups = payerGroupsOf(deadEndCarriers());
  assert.equal(groups.length, 3, 'three distinct clusters — the crosswalk keeps /CAMH off Aetna');
  assert.deepEqual(
    answerableCarriers(groups).map((g) => g.payer),
    ['Aetna'],
    'only the cluster with claim history can answer',
  );
  // ⚠ THE ONE-MEMBER CLUSTER IS THE POINT. 58.8% of prefixes are a single member, so a memberCount
  // floor would have blinded the majority persona. A 1-member cluster WITH history is answerable.
  const oneMemberWithHistory = fixture({
    candidates: {
      total: 2,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        { canonicalPayerId: 'pi_cigna', payerDisplayName: 'Cigna', employerLabel: null, funding: null, planType: null, memberCount: 1, hasClaimEvidence: true },
      ],
    },
  });
  assert.equal(
    answerableCarriers(payerGroupsOf(oneMemberWithHistory)).length,
    2,
    'a single member with history is answerable — the floor is history, not population',
  );
});

test('deriveStage: exactly one answerable carrier AUTO-RESOLVES past the question it cannot ask', () => {
  const r = deadEndCarriers();
  assert.equal(payerGroupsOf(r).length, 3, 'three carriers exist…');
  assert.equal(answerableCarriers(payerGroupsOf(r)).length, 1, '…and exactly one can answer');
  assert.equal(
    deriveStage({ resolution: r, payerPick: null, picked: false }),
    'plan',
    'the carrier question is not asked when only one carrier could have answered it',
  );
  assert.deepEqual(soleAnswerableCarrier(payerGroupsOf(r))?.payer, 'Aetna');
});

test('deriveStage: ZERO answerable carriers still ASK — a dead end is not an obvious answer', () => {
  const r = noAnswerableCarriers();
  assert.equal(answerableCarriers(payerGroupsOf(r)).length, 0);
  assert.equal(
    deriveStage({ resolution: r, payerPick: null, picked: false }),
    'payer',
    'there is no carrier to resolve TO, so the question stays open',
  );
  assert.equal(
    soleAnswerableCarrier(payerGroupsOf(r)),
    null,
    'nothing to auto-resolve to — and null is what stops the shell composing a pick',
  );
});

test('deriveStage: two answerable carriers keep the question, unchanged in shape', () => {
  // `fixture()` is the ambiguous case (Aetna + Cigna, both with history) — the shape ~11 payer-stage
  // renders in this file depend on. If this flips, those were re-baselined rather than preserved.
  const groups = payerGroupsOf(fixture());
  assert.equal(groups.length, 2, 'two carriers');
  assert.equal(answerableCarriers(groups).length, 2, 'both answerable — a real question');
  assert.equal(deriveStage({ resolution: fixture(), payerPick: null, picked: false }), 'payer');
});

test('an auto-resolve NEVER writes payerPick — only the operator can, via payer_picked', () => {
  /* DESIGN A, RATIFIED: the reducer is untouched and the shell composes `payerPick ?? sole?.payer` at
   * the read sites. This is the reducer half of that guarantee, and it is asserted as a SWEEP rather
   * than as one action because the property that matters is universal: `payerPick` means "the OPERATOR
   * chose this carrier", and every surface reading it — the checklist's `done`, the receipt's decision
   * entry, `scopeSourceOf`'s 'user'/'pick'/'dominant' — is entitled to believe that. A later
   * convenience effect dispatching one of these to "apply" an auto-resolve is exactly the regression
   * this pins, and a single-action test would not have caught it. */
  const groups = payerGroupsOf(deadEndCarriers());
  assert.equal(soleAnswerableCarrier(groups)?.payer, 'Aetna', 'the machine has a resolution to apply…');

  const everyActionButThePick: ShellAction[] = [
    { type: 'search_submitted' },
    { type: 'skipped' },
    { type: 'plan_submitted' },
    { type: 'went_back', target: 'identify' },
    { type: 'went_back', target: 'payer' },
    { type: 'plan_filter_changed', value: 'ACME' },
    { type: 'filter_toggled', facet: 'funding', value: 'Self-Funded' },
    { type: 'filters_cleared' },
    { type: 'retry_requested' },
    { type: 'snapshot_requested' },
    { type: 'snapshot_failed' },
    { type: 'ai_armed' },
    { type: 'ai_disarmed' },
    { type: 'payer_override_changed', label: 'AETNA US HEALTHCARE' },
    { type: 'window_days_changed', days: 90 },
    { type: 'area_selected', key: 'CA' },
    { type: 'facility_narrow_toggled', value: 'f1' },
    { type: 'narrow_toggled' },
  ];
  for (const action of everyActionButThePick) {
    const next = shellReducer(INITIAL_SHELL_STATE, action);
    assert.equal(next.payerPick, null, `${action.type} wrote payerPick — only the operator's pick may`);
  }

  // ⚠ AND `skipped` STAYS FALSE ON ITS OWN. The zero-answerable branch must not reach for the skip
  // flag to get off the carrier stage: that flag is the operator's declared act (it sends
  // `payerScope: 'all'` on the wire), so machine-setting it would fake a decision.
  assert.equal(shellReducer(INITIAL_SHELL_STATE, { type: 'search_submitted' }).skipped, false);

  // The operator's own pick of the SAME carrier is a different state, and must stay distinguishable
  // from the resolution above — that difference is what `carrierAutoResolved` carries to the screen.
  assert.equal(shellReducer(INITIAL_SHELL_STATE, { type: 'payer_picked', payer: 'Aetna' }).payerPick, 'Aetna');
});

// ── THE OVERRIDE PATH: reopening the question must UNRESOLVE it (Qodo on PR #204) ─────────────────
//
// The defect the stage parameter exists to prevent. `stage` is `backTo ?? derived`, and the new
// "Pick a carrier" revisit dispatches `went_back{target:'payer'}` — which clears the reducer's
// `payerPick` and sets `backTo`, leaving `payerGroups` untouched. The shell computed the auto-resolve
// from `payerPick`/`payerGroups` alone, ~120 lines above where `stage` was computed, so on the
// override path the carrier question was back on screen while the derivation still reported a
// resolved carrier — and that value went downstream as `payerPick`. The operator pressed
// "Pick a carrier" and the surface answered it for them again.
test('reopening the carrier question withdraws the auto-resolve — no derived pick, no flag', () => {
  const groups = payerGroupsOf(deadEndCarriers());

  // The plan stage: the resolution is real and stated.
  const onPlan = carrierResolutionFor({ stage: 'plan', payerPick: null, skipped: false, payerGroups: groups });
  assert.deepEqual(onPlan, { effectivePick: 'Aetna', autoResolved: true });

  // ⚠ THE FIX. `went_back{target:'payer'}` → payerPick=null, backTo='payer' → stage='payer'. The
  // question is open, so NOTHING may claim a carrier: no pick to send downstream as payerPick (the
  // receipt would record a decision), and no flag (the banner would explain a screen that is not up).
  const reopened = carrierResolutionFor({ stage: 'payer', payerPick: null, skipped: false, payerGroups: groups });
  assert.deepEqual(
    reopened,
    { effectivePick: null, autoResolved: false },
    'the carrier stage is the question being open — it cannot also be answered',
  );

  // And the reducer really does produce that state, so the case above is reachable and not theoretical.
  const back = shellReducer(
    { ...INITIAL_SHELL_STATE, payerPick: 'Aetna' },
    { type: 'went_back', target: 'payer' },
  );
  assert.equal(back.payerPick, null, 'went_back to payer clears the operator pick');
  assert.equal(back.backTo, 'payer', 'and pins the stage to the carrier question');
  assert.deepEqual(
    carrierResolutionFor({ stage: back.backTo, payerPick: back.payerPick, skipped: back.skipped, payerGroups: groups }),
    { effectivePick: null, autoResolved: false },
  );
});

test('carrierResolutionFor: the operator pick always wins and is never called auto-resolved', () => {
  const groups = payerGroupsOf(deadEndCarriers());
  for (const stage of ['identify', 'payer', 'plan', 'answer'] as const) {
    assert.deepEqual(
      carrierResolutionFor({ stage, payerPick: 'SADDLEBACK', skipped: false, payerGroups: groups }),
      { effectivePick: 'SADDLEBACK', autoResolved: false },
      `stage=${stage}: an explicit pick is the operator's, even for a no-history carrier`,
    );
  }
});

test('carrierResolutionFor: a carrier scope is in force only on plan and answer', () => {
  const groups = payerGroupsOf(deadEndCarriers());
  const at = (stage: FlowStage) => carrierResolutionFor({ stage, payerPick: null, skipped: false, payerGroups: groups });
  // `identify` has not reached the question; `payer` IS the question.
  assert.deepEqual(at('identify'), { effectivePick: null, autoResolved: false });
  assert.deepEqual(at('payer'), { effectivePick: null, autoResolved: false });
  assert.deepEqual(at('plan'), { effectivePick: 'Aetna', autoResolved: true });
  assert.deepEqual(at('answer'), { effectivePick: 'Aetna', autoResolved: true });
});

test('carrierResolutionFor: a skip is never overwritten by an auto-resolve', () => {
  // A skip put `payerScope: 'all'` on the wire. Resolving to one carrier would contradict the request
  // the operator actually made, and `skipped` un-sets only by a plan pick or a step back.
  const groups = payerGroupsOf(deadEndCarriers());
  assert.deepEqual(
    carrierResolutionFor({ stage: 'answer', payerPick: null, skipped: true, payerGroups: groups }),
    { effectivePick: null, autoResolved: false },
  );
});

test('carrierResolutionFor: a sole carrier is not an auto-resolve — nothing was eliminated', () => {
  // One cluster means the question was never askable; the existing sole-carrier copy owns that case,
  // and claiming "resolved for you — the others have no history" would name others that do not exist.
  const soleCarrier = fixture({
    candidates: {
      total: 2,
      chosenIndex: 0,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        { canonicalPayerId: 'pi_aetna', payerDisplayName: 'Aetna', employerLabel: 'ACME CO', funding: null, planType: null, memberCount: 9, hasClaimEvidence: true },
      ],
    },
  });
  const groups = payerGroupsOf(soleCarrier);
  assert.equal(groups.length, 1, 'one cluster');
  assert.deepEqual(
    carrierResolutionFor({ stage: 'plan', payerPick: null, skipped: false, payerGroups: groups }),
    { effectivePick: null, autoResolved: false },
  );
});

test('the auto-resolve STATES itself on the plan stage, names the window, and offers the way back', () => {
  const html = render(
    props('plan', deadEndCarriers(), { payerPick: 'Aetna', carrierAutoResolved: true }),
  );
  assert.match(html, /Resolved to Aetna/, 'the resolution is named — not silently applied');
  assert.match(html, /other 2 carriers/, 'it says how many were eliminated');
  // ⚠ THE WINDOW IS LOAD-BEARING COPY. `hasClaimEvidence` is the resolve window's evidence (365 days
  // by default), so a bare "no claim history" would assert something about all time that the data
  // cannot support — and would read as "these carriers are wrong" rather than "these carriers are
  // quiet". Asserted as the PHRASE, so deleting the window qualifier fails here.
  assert.match(
    html,
    /no claim history in the last 12 months/,
    'the 12-month basis must be stated, never a bare "no claim history"',
  );
  assert.doesNotMatch(html, /no claim history ever/i, 'and never an all-time claim');
  assert.match(html, /pick a different one/i, 'the ruling is overridable, and says so');
});

test('an operator who PICKS the only answerable carrier is not told it was resolved for them', () => {
  // The two states render the same label, so the screen must take the claim from the flag rather than
  // inferring it — otherwise "Resolved to Aetna for you" appears over a choice the operator made.
  const html = render(
    props('plan', deadEndCarriers(), { payerPick: 'Aetna', carrierAutoResolved: false }),
  );
  assert.doesNotMatch(html, /Resolved to Aetna/, 'the operator chose this — nothing was resolved for them');
  assert.match(html, /under Aetna/, 'the plan stage still scopes to their pick');
});

test('a dead-end SET is named once, about the set — not left to N identical tile warnings', () => {
  const html = render(props('payer', noAnswerableCarriers()));
  assert.match(html, /None of these 3 carriers has/, 'the set-level claim, which no tile can make');
  assert.match(html, /claim history in the last 12 months/, 'window-scoped here too');
  assert.match(html, /nothing behind it/, 'and says what that means for a ranking');
  // The question is still on screen: a carrier pick still scopes the plan stage, and that is the
  // operator's call. What must NOT happen is the flow deciding for them.
  assert.match(html, /Which carrier is on the card\?/, 'the question stays askable');
});

test('the sr-only channel carries the same two claims as the screen', () => {
  // ⚠ THIS IS WHERE AN UNFIXED CLAIM SURVIVES A BROWSER PASS — liveSentenceFor's own header says so.
  const auto = liveSentenceFor('plan', deadEndCarriers(), null, {
    carrierAutoResolved: true,
    carrierAutoResolvedLabel: 'Aetna',
  });
  assert.match(auto, /resolved to Aetna for you/i, 'the carrier is NAMED, not described as "one carrier"');
  assert.match(auto, /no claim history in the last 12 months/, 'same window wording as the visible banner');

  const dead = liveSentenceFor('payer', noAnswerableCarriers(), null, {});
  assert.match(dead, /None of them has claim history in the last 12 months/, 'the dead-end set is announced');

  // Omitting the pair leaves every existing announcement byte-identical.
  assert.equal(
    liveSentenceFor('plan', fixture(), null, {}),
    liveSentenceFor('plan', fixture(), null, { carrierAutoResolved: false }),
  );
});

test('the stepper and the checklist call an auto-resolved carrier SKIPPED, never done', () => {
  // "done" claims the operator answered a question they were never shown. `railStates` had its own
  // `groups.length <= 1` predicate, which is a different question from the one deriveStage now asks —
  // so without following it here, the rail would have ticked the carrier step as answered.
  const groups = payerGroupsOf(deadEndCarriers());
  const states = railStates('plan', deadEndCarriers(), groups);
  const payerIdx = 1; // identify · payer · plan · answer
  assert.equal(states[payerIdx], 'skipped', 'the carrier step was never asked — it cannot be "done"');

  // And a genuine two-answerable question, answered, IS done — the fix must not over-reach.
  const answered = railStates('plan', fixture(), payerGroupsOf(fixture()));
  assert.equal(answered[payerIdx], 'done');
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
  const ticker = <div data-testid="ticker-slot">Facility Momentum</div>;
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
    assert.match(html, /Facility Momentum/, `${stage}: the ticker rendered — otherwise the inert check below is vacuous`);
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
    // ⚠ THE SCOPE IS A REQUEST INPUT, so it is a request IDENTITY input (2026-08-07). Without it, a
    // plain skip (payerLabel null, all-payers) and an un-skip whose plan resolves to no bridge label
    // (payerLabel null, payer-scoped) share a key: the effect never re-runs, and a payer-scoped
    // answer keeps rendering under an all-payers caption — or the reverse.
    { ...base, payerLabel: null, allPayers: true },
  ]) {
    assert.notEqual(scopeKeyOf(changed), key, `a real change must move the key: ${JSON.stringify(changed)}`);
    assert.equal(isRefetching(true, key, scopeKeyOf(changed)), true, 'and that IS a refetch');
  }

  // Same payer label, different SCOPE — the pair the new dimension exists to separate.
  assert.notEqual(
    scopeKeyOf({ ...base, payerLabel: null, allPayers: true }),
    scopeKeyOf({ ...base, payerLabel: null }),
    'all-payers and "no bridge label" are different requests and must not share a key',
  );
  // Omitting it is identical to false, so every pre-existing key is unchanged.
  assert.equal(scopeKeyOf({ ...base, allPayers: false }), key, 'the added dimension is inert when off');

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

/** Six carriers behind one prefix — the NON-obvious carrier set the suppression ruling is about.
 *  Extracted for S6, which pins the same ruling through the hoisted control. */
function crowdedCarriers(): QualifyResolution {
  return fixture({
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
}

test('Skip is withheld on the carrier stage when the carrier choice is NOT obvious', () => {
  // AS RATIFIED 2026-08-06, left readable rather than rewritten: "with a dozen carriers behind a
  // prefix, skipping resolves the ranking to whichever payer happens to dominate the claims —
  // arbitrary, not general, and indistinguishable from the answer screen."
  //
  // ⚠ THAT PREMISE DIED ON 2026-08-07 AND THE RULING DID NOT — see the constant's own header in
  // resolution-flow.tsx. A Skip has ranked ALL payers since the reversal (`payerScope: 'all'`), so
  // "whichever payer happens to dominate" describes behaviour this branch no longer has. The
  // BEHAVIOUR under test is unchanged and deliberately preserved through S6's hoist; what changed is
  // the reason it is defensible, which is now the blend rather than the arbitrary pick.
  const many = crowdedCarriers();
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
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), skipped: true, scopeSource: 'dominant' }) }),
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

// Alec, live in a browser, 2026-08-07. "Skip — search all plans", then ONE press on a BILLED UNDER
// chip, and the whole surface re-presented the plan he had just declined as though he had picked it:
// a "CARRIER … · PLAN <sponsor>" receipt, the identity line with that plan's full policy bits, and
// the resolve-time notices about it. (The live sponsor name is not repeated here — an employer label
// tied to a member lookup is PHI-adjacent. The fixture's stand-in is what gets asserted.)
//
// The cause is a COLLAPSE, not an ordering mistake. `scopeSource` answered two independent questions
// with one enum — "who chose the payer label" (user / the pick's claims label / the dominant default)
// and "was a plan chosen at all" — and every skip guard in the presentation read the second off the
// first. A chip press legitimately makes the first answer 'user'; nothing about it touches the
// second. Re-ordering the ternary would only move the lie onto whichever claim lost the tie, so the
// two claims are two values now: `skipped` rides as its own prop, straight from the reducer field
// that pins the answer stage.
test('a billed-under re-scope AFTER a skip is still a skip — it must not re-present the declined plan', () => {
  const r = fixture();
  // The exact sequence, through the real reducer: Skip, then one chip.
  const flow = ([{ type: 'skipped' }, { type: 'payer_override_changed', label: 'AETNA' }] as ShellAction[]).reduce(
    shellReducer,
    INITIAL_SHELL_STATE,
  );
  assert.equal(flow.skipped, true, 'the reducer knows a chip press is not a plan pick (invariants g/h)');
  assert.equal(flow.payerOverride, 'AETNA', 'and the chip really did land');

  // The shell's payer-scope provenance, from that state (resolution-flow-client.tsx). 'user' is
  // CORRECT and stays correct — the label on the ranking IS the one the operator chose. What must
  // not follow from it is any claim about a plan.
  const scopeSource = scopeSourceOf({ payerOverride: flow.payerOverride, pickLabel: null });
  assert.equal(scopeSource, 'user');

  // payerScope 'payer': an HONOURED chip beats the skip's all-payers request in the core (one scope
  // claim, decided in one place), so this snapshot really is single-label — which is why the banner
  // below takes the re-scoped arm rather than the all-payers one.
  const snap = {
    ...snapshotFixture(),
    resolved: { payerName: 'AETNA', payerScope: 'payer' },
    payerOverridden: true,
  } as QualifySnapshot;
  const html = render(
    props('answer', r, {
      answer: answerProps({ snapshot: snap, skipped: flow.skipped, scopeSource, payerOverride: flow.payerOverride }),
    }),
  );

  const receipt = html.slice(html.indexOf('aria-label="Your search so far"'), html.indexOf('</nav>'));
  assert.match(receipt, />Scope</, 'the receipt still records a SCOPE — the only thing that was decided');
  assert.ok(!receipt.includes('>Plan<'), 'and no PLAN entry, because no plan was chosen');
  assert.ok(!receipt.includes('>Carrier<'), 'nor a CARRIER entry — the carrier question was skipped too');
  // Honesty is stating what IS true (7c86709), and "no plan chosen, re-scoped to a label you picked"
  // is a real, nameable state. Name it rather than merely dropping the false half.
  assert.match(html, /All plans · AETNA — your re-scope/, 'the Scope entry names the re-scope as the operator\'s own');
  assert.match(html, /all plans — no plan chosen/, 'the identity line still says no plan was chosen');
  assert.ok(!html.includes('SOUTHWEST AIRLINES CO'), 'the declined plan sponsor appears NOWHERE in the markup');
  assert.ok(!html.includes('Self-Funded · PPO'), 'nor the declined plan\'s policy bits');
  assert.ok(!html.includes('In-network status is not captured on this VOB'), 'nor its resolve-time notices');
  assert.match(html, /No plan was chosen, so the notes about one plan/, 'their absence is explained, not silent');
  assert.match(html, /identifies the plan that was resolved\s+before you skipped/, 'the predicate keeps its skip caption');
  // The skip banner is the sentence that vanished on the first chip press. Since 2026-08-07 it takes
  // the RE-SCOPED arm here, because the chip really did narrow the ranking to one label — the
  // all-payers wording would be the mirror-image overclaim.
  assert.match(html, /You skipped the plan questions, but the ranking is scoped to AETNA/);
  assert.ok(!html.includes('could not be scoped to'), 'declining to narrow is still not a failure to narrow');
  // ...and the A11Y half of the same masquerade, which is not visible in a screenshot: the single
  // aria-live region runs through `liveSentenceFor`, whose skip arm was gated on the same collapsed
  // enum. A screen-reader user was told "Resolved: <carrier> · <sponsor> · <funding>" about a plan
  // they had declined — the one surface where the lie could not be spotted by looking.
  const liveFrom = html.indexOf('aria-live="polite"');
  const live = html.slice(liveFrom, html.indexOf('</p>', liveFrom));
  assert.match(live, /You skipped the plan questions\. Showing a general search across all plans under AETNA\./);
  assert.ok(!live.includes('Resolved:'), 'nothing was resolved past the identifier, so nothing is announced as resolved');

  // THE DEFECT WAS INDISTINGUISHABILITY: a genuine pick plus one chip rendered byte-identically to
  // this. Pin that they now differ, and that the picked path still presents its plan — otherwise the
  // assertions above would pass against a screen that never shows a plan at all.
  const picked = render(
    props('answer', r, {
      answer: answerProps({ snapshot: snap, skipped: false, scopeSource: 'user', payerOverride: 'AETNA' }),
    }),
  );
  assert.ok(picked.includes('SOUTHWEST AIRLINES CO'), 'a genuine pick DOES present its plan');
  assert.notEqual(html, picked, 'skip-then-re-scope and pick-then-re-scope are different states and render differently');
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
    render(props('answer', r, { answer: answerProps({ snapshot: snapshotFixture(), skipped: true, scopeSource: 'dominant' }) })),
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
            skipped: true,
            scopeSource: 'dominant',
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
  const narrowed = disclosure({ filters: { funding: ['Self-Funded'], employers: [] } });
  assert.ok(!narrowed.includes('whole footprint'), 'a narrowed fetch may not be captioned as the whole footprint');
  assert.match(narrowed, /all plans — no plan chosen, then narrowed by your filter selections under AETNA US HEALTHCARE/);
  assert.match(narrowed, /grounded in the ranking on screen — all plans, no plan chosen, narrowed by your filter selections/);

  // ...and the precision that a bare `filtersActive` check would get wrong: selecting EVERY employer
  // in the universe is not a narrow (employerNarrowFor :325 returns null), nothing extra reaches the
  // request, so the whole-footprint wording is the true one even though filters are active.
  const notANarrow = disclosure({
    filters: { funding: [], employers: ['SOUTHWEST AIRLINES CO', 'ACME CO'] },
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
      render(props('answer', res, { answer: answerProps({ snapshot: snapshotFixture(), skipped: true, scopeSource: 'dominant' }) })),
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
    render(props('answer', fixture(), { answer: answerProps({ snapshot: null, skipped: true, scopeSource: 'dominant' }) })),
  );
  assert.ok(!loading.includes('Aetna'), 'the declined candidate\'s carrier never reaches the caption');
  assert.match(loading, /whole footprint/, 'the caption degrades to the scope-less form');
  assert.ok(!loading.includes(' under '), 'naming nobody beats naming a payer we cannot stand behind');
});

test('a skipped search says it was skipped — never "we could not narrow"', () => {
  // A PLAIN skip is identifier-wide since 2026-08-07 (payerScope 'all'), so the banner promises the
  // whole footprint and can now keep that promise. The snapshot fixture is payer-scoped by default,
  // so this states the scope it means rather than inheriting one.
  const allSnap = {
    ...snapshotFixture(),
    resolved: { ...snapshotFixture().resolved, payerName: null, payerScope: 'all' },
  } as QualifySnapshot;
  const skipped = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: allSnap, skipped: true, scopeSource: 'dominant' }) }),
  );
  assert.match(skipped, /You skipped the plan questions, so this is a general search/);
  assert.match(skipped, /across all \d+ payers they bill under/, 'and the promise names the whole footprint');
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
        filters: { funding: ['Self-Funded'], employers: [] },
        // OPEN: this test is about the CONTROLS, and since the NARROW SEARCH card landed those live
        // behind the disclosure. "Visible" now means "visible once the card is open, all in one
        // surface, none behind a second dropdown" — the employer type-ahead is still the exception.
        narrowExpanded: true,
      }),
    }),
  );
  // SHORT LIST → COUNTED CHIPS, LONG LIST → TYPE-AHEAD (Alec's hybrid ruling, 2026-08-07). Funding is
  // the short one, so it stays an aria-pressed toggle row with its option counts on the chips.
  assert.match(html, />Funding</);
  assert.match(html, /aria-pressed="true"[^>]*>Self-Funded/, 'the active facet reads pressed');
  assert.match(html, / · on/, 'and carries a WORD, not just a hue');
  // The employer control is the SHARED type-ahead (MultiSelectTagPicker), the same primitive the
  // Collections explorer and the v2 Qualify tab render — not a second employer control.
  assert.match(html, /aria-label="Employers"/);
  assert.match(html, /placeholder="Type to find an employer…"/, 'and it invites typing, not scanning');
  // The reach rides the shared ON/OFF badge (2026-08-07), so the employer facet reads in the same
  // vocabulary as every other row of the inventory.
  assert.match(html, /Off · all 2|On · \d+ of 2/);
  // What the filter did to the ranking is STATED, with a way out.
  assert.match(html, /Ranking over \d+ of \d+ plans/);
  assert.match(html, /Clear filters/);
});

test('a selected employer is a REMOVABLE TAG on the type-ahead, and the vocabulary is not a chip wall', () => {
  // THE POINT OF THE CONVERSION. The row this replaces rendered up to 40 employer chips inline, all
  // pressed or unpressed, with a bespoke text box above them — on Alec's 186-plan search that is a
  // wall, not a control. The picker shows the SELECTION as removable tags and holds the vocabulary in
  // a dropdown that is closed until focus, so the resting markup carries the narrow and nothing else.
  const r = fixture();
  const html = render(
    props('answer', r, {
      answer: answerProps({
        snapshot: snapshotFixture(),
        candidates: orderedCandidates(r),
        filters: { funding: [], employers: ['ACME CO'] },
        narrowExpanded: true,
      }),
    }),
  );
  const inv = inventoryRegion(html);
  assert.match(inv, /aria-label="Remove ACME CO"/, 'the picked employer is a tag you can take off');
  // ⚠ THE BADGE IS ON THE STRIP, NOT THE PICKER, SINCE 2026-08-12 — the strip is permanent now, so
  // a badge on the picker's own label row printed the same reading twice within 200px.
  assert.match(inv, />Employers<\/span><span class="[^"]*">On · 1 of 2</, 'and the strip counts it');
  // NEGATIVE: the OTHER employer in the universe is not on screen at rest. A chip wall would have it.
  assert.ok(!inv.includes('SOUTHWEST AIRLINES CO'), 'the unpicked vocabulary lives in the dropdown, not the row');
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
        filters: { funding: ['Self-Funded'], employers: [] },
        employerNarrowTooMany: 311,
      }),
    }),
  );
  assert.match(html, /too many employers \(311\) to narrow the ranking by employer, so it is not/);
});

// ── PLAN TYPE IS NOT A FILTER (Alec, 2026-08-07) ─────────────────────────────────────────────────
//
// ⚠ THE REMOVAL WAS NOT COSMETIC, WHICH IS WHY IT GETS A TEST RATHER THAN A DELETED LINE. A plan-type
// chip LOOKED like a pure client-side narrow: `planTypes` is absent from `scopeKeyOf`, so no plan
// type was ever a segment of the request identity. But `filterCandidates` feeds `employerNarrowFor`
// (resolution-flow-client.tsx:271-273), and THAT result — `{ employers }` — IS a scope-key segment
// and IS sent as `market.employers`. So a plan-type press could silently re-run the whole facility
// ranking narrowed to the employers that happen to hold plans of that type, with nothing on screen
// saying a word about employers. Measured distribution on one real search: POS 257 · PPO 30 · EPO 27
// · HMO 9 · ASO 1 · OAP 1 — POS (79%) returns "not a proper subset", so it changes nothing at all,
// while ASO collapses the ranking to a single employer. Same control, opposite force, no disclosure.
//
// THE CLAIM PINNED HERE, in the brief's words: after the removal, `employerNarrowFor`'s `filtered`
// argument is reachable ONLY from funding and from explicit employer selection.
test('a plan type cannot influence the employer narrow — funding and employers are the only channels left', () => {
  const cand = (over: Partial<OrderedCandidate>): OrderedCandidate => ({
    index: 0,
    chosen: false,
    canonicalPayerId: 'pi_x',
    payerDisplayName: 'X MUTUAL',
    employerLabel: null,
    funding: null,
    planType: null,
    memberCount: 1,
    hasClaimEvidence: true,
    ...over,
  });
  // PLAN TYPE PERFECTLY CORRELATED WITH EMPLOYER — the worst case, deliberately. If a plan-type value
  // could still select rows, every one of these selections would resolve to a proper subset of the
  // employer universe, which is precisely the shape `employerNarrowFor` decides to SEND.
  const universe: OrderedCandidate[] = [
    cand({ index: 0, employerLabel: 'ALPHA CO', funding: 'Self-Funded', planType: 'ASO' }),
    cand({ index: 1, employerLabel: 'BETA CO', funding: 'Self-Funded', planType: 'POS' }),
    cand({ index: 2, employerLabel: 'GAMMA CO', funding: 'Fully Insured', planType: 'POS' }),
  ];

  // (1) THE VOCABULARY. `facetsOf` is what the card builds its rows from; a `planTypes` key here is a
  //     plan-type control on screen, whatever the row happens to be called.
  assert.deepEqual(Object.keys(facetsOf(universe)).sort(), ['employers', 'funding'], 'no plan-type facet is offered');
  // (2) THE CHANNEL. `AnswerFilters` is the ONLY way the card reaches `filterCandidates`, so its key
  //     set is the exhaustive list of what a control can express.
  assert.deepEqual(Object.keys(NO_ANSWER_FILTERS).sort(), ['employers', 'funding'], 'no plan-type field to fill in');
  // (3) THE BEHAVIOUR — the half that still fails if someone re-adds the arm while (1) and (2) stay
  //     quiet. Smuggle a plan-type selection past the type system, exactly as a restored arm would
  //     produce it, and prove `filterCandidates` cannot see it.
  const smuggled = { funding: [], employers: [], planTypes: ['ASO'] } as unknown as AnswerFilters;
  assert.equal(filterCandidates(universe, smuggled).length, 3, 'a plan-type selection selects nothing');
  assert.equal(
    employerNarrowFor(universe, filterCandidates(universe, smuggled)),
    null,
    'so it resolves to no employer narrow — nothing about it can reach market.employers',
  );

  // POSITIVE CONTROL. Without it, (3) would pass just as happily against a `filterCandidates` that
  // had stopped filtering altogether — a narrow nobody can express is not the goal, only a plan-type
  // narrow nobody can express.
  const byFunding = filterCandidates(universe, { funding: ['Fully Insured'], employers: [] });
  assert.deepEqual(employerNarrowFor(universe, byFunding), { employers: ['GAMMA CO'] }, 'funding still narrows');
  const byEmployer = filterCandidates(universe, { funding: [], employers: ['ALPHA CO'] });
  assert.deepEqual(employerNarrowFor(universe, byEmployer), { employers: ['ALPHA CO'] }, 'and so does an explicit pick');
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
    ['identify + real ticker', 'identify', null, { ticker }, /Facility Momentum/],
    ['identify + ticker skeleton', 'identify', null, { ticker: <HeatingUpSkeleton /> }, /Loading trends/],
    // The 2026-08-07 directive put the (inert) strip on PAYER and PLAN too — markup this sweep never
    // saw before, because every case above it either predates the reversal or is the landing. Same
    // readOnly ticker as the identify case; different surrounding stage markup underneath it.
    ['payer + inert ticker', 'payer', fixture(), { ticker }, /Facility Momentum/],
    ['plan + inert ticker', 'plan', fixture(), { payerPick: 'Aetna', ticker }, /Facility Momentum/],
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
    // S4: the FACILITY narrow's own markup — the shared type-ahead's label row, its ON badge, its
    // selected tag, and the composed narrowing sentence. The picker was already inside the card for
    // employers, but never on THIS surface (outside the card, light-on-light) and never carrying a
    // selected tag, which is the markup a floor sweep has to see.
    [
      'answer + facility narrow active',
      'answer',
      fixture(),
      {
        answer: answerProps({
          snapshot: threeStateSnapshot(),
          facilityOptions: FACILITY_OPTIONS,
          facilityNarrow: ['NASH'],
        }),
      },
      /at NASHVILLE MENTAL HEALTH/,
    ],
    // THE SCOPE CARD, BOTH POSITIONS (2026-08-07; re-pointed at the verdict card 2026-08-12). Two
    // rows, not one: collapsed and expanded render DIFFERENT markup — the tag strip and the
    // footnotes on one side, the chip rows and the employer disclosure on the other — so a single
    // case would leave half the card outside the floor.
    // ⚠ IT WAS A DARK `.q-subject` SURFACE UNTIL 2026-08-12, and the labels were the blessed eyebrow
    // at that dark palette. The verdict card is `bg-surface`, so those labels are `text-ink400` now
    // — but the eyebrow SIZE is unchanged and is exactly the treatment this 12px floor polices, so
    // the case earns its place at the new address for the same reason it did at the old one.
    [
      'answer + verdict card collapsed',
      'answer',
      fixture(),
      { answer: answerProps({ snapshot: allPayersSnapshot(), skipped: true, scopeSource: 'dominant', candidates: orderedCandidates(fixture()) }) },
      /Refresh the ranking/,
    ],
    [
      'answer + verdict card expanded',
      'answer',
      fixture(),
      {
        answer: answerProps({
          snapshot: allPayersSnapshot(),
          skipped: true,
          scopeSource: 'dominant',
          candidates: orderedCandidates(fixture()),
          narrowExpanded: true,
        }),
      },
      /Hide filters/,
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
      /Facility Momentum/,
    ],
  ];

  for (const [label, stage, r, over, mustRender] of cases) {
    const html = render(props(stage, r, over));
    // POSITIVE CONTROL — prove this case rendered the markup it claims to be sweeping.
    assert.match(html, mustRender, `${label}: rendered nothing to scan — the floor check would be vacuous`);
    /* A regex sweep, not a literal blocklist: the old list enumerated seven exact strings, so
     * text-[8px] or text-[11.75px] would have passed silently.
     *
     * ⚠ REM IS SWEPT TOO NOW, AND ITS COVERAGE IS HONEST RATHER THAN ASSERTED (final review,
     * 2026-08-08). The sweep was px-only, so `text-[0.6rem]` — 9.6px at the default root size, and a
     * perfectly ordinary way to write a Tailwind arbitrary size — walked straight through a guard
     * whose whole purpose is the 12px floor. Converted at 16px/rem, which is the root size this app
     * never overrides (`app/app/globals.css` sets no `html { font-size }`); a future override would
     * make this arm optimistic and is the one assumption to re-check.
     *
     * ⚠ AND THE GAP THAT REMAINS, NAMED. There is no rem-denominated arbitrary text class anywhere in
     * app/components/qualify today, so the rem arm has NO positive control — it is a tripwire for the
     * next author, not a covered path. `em`, `pt` and clamp() are still unswept. */
    for (const m of html.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
      const px = m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
      assert.ok(px >= 12, `sub-12px class on ${label}: text-[${m[1]}${m[2]}] (= ${px}px)`);
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
    const base = { snapshot: snapshotFixture(), windowDays, snapshotError: 'failed', staleAfterError: true } as const;
    const failed = render(props('answer', fixture(), { answer: answerProps(base) }));
    assert.ok(
      !failed.includes('Showing trailing'),
      `after a failed refetch the sentence must not contradict the banner (windowDays=${windowDays})`,
    );
    // ⚠ TWO CLAIMS, TWO RENDERS, BECAUSE THE CARD SPLIT THEM. This was one assertion —
    // `assert.match(failed, />Window</, 'the Window control line stays — it is the escape route')` —
    // and once the controls moved behind the disclosure it re-targeted itself onto the COLLAPSED
    // SUMMARY BADGE's label while keeping a message about the control row. Probed on this exact
    // render: `>Window<` true, the window chips false, the fields well false. It passed; the thing it
    // named was not in the document. That is precisely the shape `inventoryRegion` exists to remove,
    // so it is split rather than merely opted in.
    //
    // COLLAPSED — the card still STATES the window. A real guarantee in its own right: a failed
    // refetch suppresses the ladder SENTENCE (above) and must not also blank the inventory.
    assert.match(
      inventoryRegion(failed),
      />Window<\/span><span class="[^"]*">On · /,
      `the card still states the window's state after a failure (windowDays=${windowDays})`,
    );
    // ...AND SO DOES BILLED UNDER, which is the half a first draft of the 2026-08-12 card got wrong.
    // It suppressed the tag on the whole `stale` union (`refetching || staleAfterError ||
    // refreshing`), invoking rule 2654416 — "a claim about the set being REPLACED". On a FAILED
    // refetch nothing is being replaced: the previous ranking is still drawn, the banner says so,
    // and the billed-under CHIP row below is still lit for that same label. Blanking the tag
    // contradicted both, and only the Window arm above was guarded, so nothing caught it.
    assert.match(
      inventoryRegion(failed),
      />Billed under<\/span><span class="[^"]*">On · AETNA US HEALTHCARE</,
      `a failed refetch still shows the label the ranking on screen is scoped to (windowDays=${windowDays})`,
    );
    // NEGATIVE CONTROL — a genuine in-flight re-scope DOES suppress it, which is the asymmetry the
    // card closed on purpose. Without this the assertion above would be satisfied by no gate at all.
    const inFlight = render(
      props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), windowDays, refetching: true }) }),
    );
    assert.ok(
      !inventoryRegion(inFlight).includes('>Billed under</span>'),
      `an in-flight re-scope withholds the label of the set being replaced (windowDays=${windowDays})`,
    );

    // EXPANDED — and the CHIPS are the escape route. Changing the window is how an operator gets out
    // of a failed refetch, so they must survive it live, with the current one still reading pressed.
    const open = render(props('answer', fixture(), { answer: answerProps({ ...base, narrowExpanded: true }) }));
    assert.match(
      open,
      windowDays === null ? /aria-pressed="true"[^>]*>Automatic · selected/ : /aria-pressed="true"[^>]*>365 days · selected/,
      `the Window control line stays — it is the escape route (windowDays=${windowDays})`,
    );
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
    // ⚠ STATED, NOT OMITTED (S3). The core sets this on EVERY row of every list, and a fixture that
    // leaves it absent is the S2-D6 defect again: `undefined` is not `null`, so a render guard
    // written as `=== null` would fall through under test while working in production — or, as here,
    // the reverse. `null` is the invariant on the member's own footprint; the book fixtures override.
    memberHistory: null,
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
    // ⚠ `payerScope` IS PART OF THE SCOPE CLAIM, NOT DECORATION, and this fixture omitted it until
    // S2 (2026-08-08). The core sets it on every path and `scopedPayerOf` REFUSES a payerName whose
    // scope does not agree — so a fixture without it reads as "not payer-scoped", and any consumer
    // that goes through that guard silently renders nothing here while working in production. Same
    // class as the provenance gap this file documents above: a fixture that diverges from the mint
    // tests nothing about the mint.
    resolved: { payerName: 'AETNA US HEALTHCARE', payerScope: 'payer' },
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
  // OPEN: the window CHIPS are controls, and controls live behind the NARROW SEARCH disclosure. The
  // window SENTENCE below is not — it is a statement, so the card states it in either position.
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), narrowExpanded: true }) }));
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

// ── CENSUS ON THE DEFAULT SURFACE (S1, 2026-08-08) ───────────────────────────────────────────────
//
// v3 is what everyone actually sees (`qualifyV3FlowEnabled()` in app/app/qualify/page.tsx), and it
// rendered NO census at all: no bed chip, no UR date, no length-of-stay. #163's "a FULL house says
// so" fix landed on the v2 FacilityPanel, which is behind QUALIFY_V3_FLOW=off. So the most
// actionable fact the card can carry — do not route a patient here — was invisible on the shipped
// surface while quietly moving the rating through the authFit factor.
//
// These pin the three states on the v3 card, and the honesty rule that comes with the new sort:
// a card the ranking SANK must SAY why on its own markup.

const bedCard = (over: Partial<QualifyFacility>) =>
  render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: { ...snapshotFixture(), facilities: [facility(over)] } as unknown as QualifySnapshot,
      }),
    }),
  );

test('v3 card — open beds render as OCCUPANCY, with the denominator', () => {
  const html = bedCard({ openBeds: 3, bedCapacity: 12, bedState: 'open' });
  assert.match(html, /3 of 12 beds open/);
});

test('v3 card — no licensed count falls back to the bare count, never an invented denominator', () => {
  const html = bedCard({ openBeds: 3, bedCapacity: null, bedState: 'open' });
  /* ⚠ BOUND TO THE VISIBLE TEXT NODE, NOT TO THE STRING ANYWHERE (final review, 2026-08-08). The
   * chip's `title` is "3 open beds on the latest census sync — licensed bed count not on file…", so a
   * bare /3 open beds/ was satisfied by the TOOLTIP alone: delete the visible label and this test
   * stayed green while the card showed nothing. The claim-vs-control pattern this file already applies
   * to the facility picker and the book's own count — a claim must be asserted where a reader sees it. */
  assert.match(html, />3 open beds<\/span>/, 'the VISIBLE label, not the title attribute');
  // ...and the tooltip still carries its own longer reading. This is a claim about WHERE, not silence.
  assert.match(html, /title="3 open beds on the latest census sync/);
  assert.ok(!/\d+ of \d+ beds/.test(html), 'no denominator is implied');
});

test('v3 card — a FULL house says so, in #163’s ratified words, and STAYS ON SCREEN', () => {
  const html = bedCard({ openBeds: 0, bedCapacity: 12, bedState: 'full', name: 'FULL HOUSE' });
  assert.match(html, /Full · 0 of 12/, 'the #163 copy, unchanged');
  // CENSUS SORTS, IT NEVER FILTERS. The card is still rendered, still named, still rated, and its
  // explanation is still openable — greying is a visual weight, never a removal.
  assert.match(html, /FULL HOUSE/);
  assert.match(html, /aria-label="rating 62 out of 100"/);
  assert.match(html, /Why this score/);
  // It SAYS why it is sunk. Hue alone never carries a claim on this surface (house rule), and a
  // greyed row with no sentence is exactly a claim carried by hue alone.
  assert.match(html, /ranked below every facility that can admit today/);
  // Nothing about the sink removes it from the accessibility tree or freezes its controls.
  assert.ok(!/aria-hidden="true"[^>]*>[^<]*FULL HOUSE/.test(html), 'not hidden from assistive tech');
  assert.ok(!html.includes('visibility:hidden') && !html.includes('visibility: hidden'));
  assert.ok(!/<summary[^>]+(disabled|inert)/.test(html), 'the disclosure stays interactive');
});

test('v3 card — an OUTPATIENT facility claims nothing about beds, and is not greyed', () => {
  // The pre-#163 error class, which a new consumer reintroduces for free: every outpatient row
  // carries a written open_beds = 0. Eleven of twenty-three facilities are outpatient.
  const html = bedCard({ openBeds: 0, bedCapacity: null, bedState: 'not_applicable' });
  assert.ok(!html.includes('Full'), 'no bed facility, no bed claim');
  assert.ok(!/\d+ open bed/.test(html), 'and no count either');
  assert.ok(!html.includes('ranked below every facility'), 'and no sink sentence — it was not sunk');
});

test('v3 card — no census row stays silent, and is not read as full', () => {
  const html = bedCard({ openBeds: null, bedCapacity: 12, bedState: 'unknown' });
  assert.ok(!html.includes('Full'), 'unknown is not full');
  assert.ok(!/\d+ of 12 beds/.test(html), 'and no occupancy is invented from the capacity alone');
});

test('v3 card — a scheduled UR is shown, because authorization may change under the rep', () => {
  const html = bedCard({ nextUrDate: '2026-08-20' });
  assert.match(html, /UR 2026-08-20/);
});

test('v3 card — AUTH HEADROOM: the authorized days nobody is using, and the overrun, both plain', () => {
  // Measured live 2026-08-08: NASH 22.6 authorized vs 16.8 actual, LSMH 21.1 vs 12.6 — 6-8
  // authorized days routinely unused, and nothing on any surface said so.
  const spare = bedCard({ avgAuthDays: 22.6, avgLosDays: 16.8, authHeadroomDays: 5.8 });
  assert.match(spare, /~6d auth headroom/);
  // The same fact read the other way must not be silently dropped: an overrun is the half that
  // costs money, and the card that shows only the flattering direction is not a KPI.
  const over = bedCard({ avgAuthDays: 36.35, avgLosDays: 40.1, authHeadroomDays: -3.8 });
  assert.match(over, /~4d over auth/);
  // Below the sample floor the server ships null, and the card must then say NOTHING rather than
  // render a zero — "we withheld this" and "there is no headroom" are different statements.
  const withheld = bedCard({ avgAuthDays: null, avgLosDays: null, authHeadroomDays: null });
  assert.ok(!withheld.includes('auth headroom') && !withheld.includes('over auth'));
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
  // A chip WAS sent and the core rejected it. The old discriminator (`scopeSource !== 'dominant'`)
  // swept this into the picked-plan wording; nothing was picked, a label was.
  const rejectedChip = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'user', payerOverride: 'NOT A REAL LABEL' }) }));
  assert.match(rejectedChip, /That label could not be applied — showing the largest by volume\./);
  assert.ok(!rejectedChip.includes('the picked plan'), 'a rejected chip is not a rejected plan pick');
});

// The caption's discriminator was `payerOverridden ? … : scopeSource !== 'dominant' ? …`, so a SKIP
// — which sends nothing and picks nothing — fell into the arm written for a REJECTED PLAN PICK:
// "Could not scope to the picked plan". No plan was ever picked. The two missing arms, added here.
// Copy describes the ranking AS IT BEHAVES TODAY: a single dominant billed-under label. Widening
// that to the identifier's whole footprint is a separate change and must not be pre-announced.
test('the billed-under caption has its own arms for a SKIP — nothing was picked, so nothing was rejected', () => {
  const skipNoOverride = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), skipped: true, scopeSource: 'dominant' }) }),
  );
  assert.ok(
    skipNoOverride.includes(esc("No plan chosen — showing this identifier's largest label by volume; pick another to re-scope.")),
    'the skip gets its own arm, worded for the ranking as it behaves today: one dominant label',
  );
  assert.ok(!skipNoOverride.includes('Could not scope to the picked plan'), 'the user picked nothing to fail to scope to');
  assert.ok(!skipNoOverride.includes('Largest by volume — pick another to re-scope.'), 'and the dominant arm omits that no plan was chosen');

  // Skip, then a billed-under chip that WAS honoured — Alec's live state. Two true facts, one line.
  const overridden = { ...snapshotFixture(), payerOverridden: true } as QualifySnapshot;
  const skipThenChip = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: overridden, skipped: true, scopeSource: 'user', payerOverride: 'AETNA US HEALTHCARE' }),
    }),
  );
  assert.match(skipThenChip, /No plan chosen — this label is your own re-scope\./);
  assert.ok(!skipThenChip.includes('Scoped to the plan you picked.'), 'no plan was picked');
  assert.ok(!/>Your selection\./.test(skipThenChip), 'and "Your selection." alone would imply one was');
});

// ── IDENTIFIER-WIDE SKIP (Alec, 2026-08-07): the whole footprint, the blend disclosure, and the
// ON/OFF inventory the Skip now lands on. ────────────────────────────────────────────────────────

/** The snapshot a plain Skip produces since the reversal: no single label, every label ranked. */
function allPayersSnapshot(over: Partial<QualifySnapshot> = {}): QualifySnapshot {
  const base = snapshotFixture();
  return {
    ...base,
    resolved: { ...base.resolved, payerName: null, payerScope: 'all' },
    ...over,
  } as unknown as QualifySnapshot;
}

test('all-payers: NO billed-under chip is active, and the caption says the ranking is un-narrowed', () => {
  const html = render(
    props('answer', fixture(), {
      // OPEN: the chips are controls. (The caption this test also asserts is a STATEMENT and now
      // renders in the card summary either way.)
      answer: answerProps({ snapshot: allPayersSnapshot(), skipped: true, scopeSource: 'dominant', narrowExpanded: true }),
    }),
  );
  // The Collections model: empty selection means NO restriction, and no chip pretends otherwise.
  // Sliced to the BILLED UNDER row: since #164 the Area row uses the same " · showing" word, and its
  // "All" chip is legitimately active (All is a chip there, not an absence — an explicit way back).
  // ⚠ BOUNDED BY THE ROW'S OWN TAG. This used to slice from '>Billed under<' to 'No label selected',
  // i.e. between two strings whose ORDER was an accident of layout — and the NARROW SEARCH card moved
  // the caption into the summary ABOVE the row, inverting the slice into an empty string. An empty
  // slice passes every `!includes(...)` below it, so this guard would have gone quietly vacuous.
  // ⚠ THE STRIP GOT THERE FIRST (2026-08-12). `>Billed under<` now appears TWICE — once as the
  // verdict card's permanent tag and once as the fields row's label — and `rowAround` takes the
  // first. The tag carries no chips, so the slice went vacuous. Anchored on the CHIP row's own
  // marker instead, which only the fields well has.
  const billedUnder = rowAround(html, 'charge lines under this label');
  assert.ok(billedUnder.includes('AETNA'), 'the slice really is the billed-under row');
  assert.ok(!billedUnder.includes(' · showing'), 'no billed-under chip claims to be the scope');
  assert.ok(!/aria-pressed="true"[^>]*>AETNA/.test(html), 'and none reads pressed');
  assert.match(html, /No label selected — ranking across all of them\. Pick one to un-blend\./);
  // The single-label captions are all FALSE here and must not appear.
  assert.ok(!html.includes('largest label by volume'), 'nothing was defaulted to');
  assert.ok(!html.includes('Could not scope'), 'nothing failed');
  // And the facet badge names the un-narrowed state in the same vocabulary as every other row.
  assert.match(html, /Off · all 2 labels/);
});

test('all-payers: the skip banner keeps the promise the copy always made', () => {
  const html = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: allPayersSnapshot(), skipped: true, scopeSource: 'dominant' }) }),
  );
  assert.match(html, /every facility this member\s+has history at,\s*across all 2 payers they bill under/);
  // The count comes from payerOptions, which fails soft to []. A fabricated "all 1 payer" under a
  // true all-payers claim is worse than no count, so the count is dropped in that state.
  const noSpread = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: allPayersSnapshot({ payerOptions: [] }), skipped: true, scopeSource: 'dominant' }),
    }),
  );
  assert.match(noSpread, /across every payer they bill under/);
  assert.ok(!/across all 1 payer/.test(noSpread), 'a lost spread must not manufacture a count');
  // The pre-2026-08-07 sentence named one label. Under an all-payers ranking that is the scope lie
  // this whole change exists to remove, so no label may be interpolated anywhere near it.
  assert.ok(!/history at under AETNA/.test(html), 'no single label is claimed as the scope');
  // The screen-reader line carries the SAME claim — that is where an unfixed one survives a browser pass.
  assert.match(html, /Showing a general search across all plans and all payers on file\./);
  // The identity line names the scope instead of rendering an empty subject from a null payerName.
  assert.match(html, /All payers on file/);
  assert.ok(!/<span class="font-semibold"><\/span>/.test(html), 'the identity line never renders an empty subject');
});

test('all-payers: the receipt records the wider scope rather than falling silent about it', () => {
  const html = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: allPayersSnapshot(), skipped: true, scopeSource: 'dominant' }) }),
  );
  const receipt = html.slice(html.indexOf('aria-label="Your search so far"'), html.indexOf('</nav>'));
  assert.match(receipt, /All plans · all payers/);
  assert.ok(!receipt.includes('your re-scope'), 'nothing was re-scoped — the default IS wide now');
});

test('THE BLEND DISCLOSURE: EVERY card under an all-payers ranking states its label count', () => {
  const blended = allPayersSnapshot({
    facilities: [
      facility({ payerCount: 3, solePayer: null }),
      facility({ rank: 2, name: 'KENTUCKY WELLNESS CENTER', facilityKey: 'KWC', payerCount: 1, solePayer: 'AETNA' }),
    ],
  } as Partial<QualifySnapshot>);
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: blended, skipped: true, scopeSource: 'dominant' }) }));
  // ⚠ Simpson's paradox on the surface admissions acts on: a facility can read green on an
  // AETNA-heavy mix while the member's OTHER label pays badly at the same place. The percentage and
  // the rating on a multi-label card are a cross-label blend and it must never pass silently.
  assert.match(html, /blended across\s*<span class="ths-num" aria-label="3 billed-under labels">\s*3\s*<\/span>\s*payers/);
  // ⚠ GATED ON THE SCOPE, NOT THE COUNT. Measured live, payerCount > 1 holds on 0 of 14 cards at 30d
  // and 1 of 28 at 365d — so a count gate would have made Alec's ruling ("each card says across N
  // payers") fire almost never, and left an all-payers card indistinguishable from a payer-scoped one
  // at the grain the operator actually reads. At one label the LABEL is the more useful sentence.
  assert.match(html, /<span class="ths-num" aria-label="1 billed-under label">\s*1\s*<\/span>\s*payer · AETNA/);
});

test('the blend disclosure says ZERO labels rather than claiming one', () => {
  // ⚠ THE ELSE-BRANCH USED TO SWALLOW THIS. `payerCount > 1 ? 'blended across N' : '1 payer'` is a
  // binary over a value with three real states, so a facility whose rows carry NO billed-under label
  // rendered as "1 payer" — a fabricated count on the exact surface the blend disclosure exists to
  // protect. Zero is reachable: count(distinct primary_payer) over an all-NULL group is 0, and
  // identifier-wide mode emits no payer predicate.
  const none = allPayersSnapshot({
    facilities: [facility({ payerCount: 0, solePayer: null })],
  } as Partial<QualifySnapshot>);
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: none, skipped: true, scopeSource: 'dominant' }) }));
  assert.match(html, /no billed-under label on these rows/);
  assert.ok(!/1 payer/.test(html), 'zero labels is not one label');
  assert.ok(!/blended across/.test(html), 'and it is not a blend either — there is nothing to blend');
});

test('the blend disclosure NAMES no label when max() would have been arbitrary', () => {
  // solePayer is null above one label by construction in the core; the card must degrade to the bare
  // count rather than inventing one, and must never print "payer · null".
  const noName = allPayersSnapshot({
    facilities: [facility({ payerCount: 1, solePayer: null })],
  } as Partial<QualifySnapshot>);
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: noName, skipped: true, scopeSource: 'dominant' }) }));
  assert.match(html, /aria-label="1 billed-under label"/);
  assert.ok(!/payer · (null|undefined)/.test(html), 'a missing label is dropped, never rendered');
});

test('the blend disclosure is ABSENT from an ordinary payer-scoped search', () => {
  // payerCount is 1 on every card of a payer-scoped ranking by construction (the query pins one
  // label), so this phrase must never appear on the ~84% of searches that never skip.
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture() }) }));
  assert.ok(!html.includes('blended across'), 'no blend caption on a single-label ranking');
});

test('THE SKIP INVENTORY: every facet states ON or OFF, and the toggles are live in the same markup', () => {
  const html = render(
    props('answer', fixture(), {
      // OPEN, which is where a Skip lands the card (flow-state.ts invariant n). This test is the
      // EXPANDED half of the card's contract — "the inventory is the CONTROLS, not a summary beside
      // them" holds here. The COLLAPSED half is the three tests below it: there the summary carries
      // the same ON/OFF vocabulary with no click, and the controls are genuinely absent.
      answer: answerProps({
        snapshot: allPayersSnapshot(),
        skipped: true,
        scopeSource: 'dominant',
        candidates: orderedCandidates(fixture()),
        narrowExpanded: true,
      }),
    }),
  );
  // ⚠ BOUNDED AT THE CARD'S CLOSING TAG (see `inventoryRegion`). The old slice ran to the end of the
  // document, so every assertion below was satisfied by markup rendered anywhere BELOW the card.
  const inv = inventoryRegion(html);
  // The headline claim, then one legible state per facet. ⚠ The window is NAMED as the standing
  // exception rather than swept into "nothing is restricting this search" — see the sentence's own
  // comment, and the one-click contradiction below.
  assert.match(inv, /Nothing narrows this search but the window\./);
  assert.match(inv, />Window<\/span><span class="[^"]*">On · automatic</, 'window is never off, and says which it is');
  assert.match(inv, />Funding<\/span><span class="[^"]*">Off · all \d+</);
  assert.match(inv, />Billed under<\/span><span class="[^"]*">Off · all 2 labels</);
  // ⚠ EMPLOYERS' BADGE RODE THE PICKER'S OWN LABEL ROW UNTIL 2026-08-12, because the collapsed
  // strip vanished when the fields opened. The strip is PERMANENT now, so every facet — employers
  // included — states itself in the SAME label-span/badge-span frame, from the same `facetReading`
  // expression. Asserted here so a strip that silently dropped a facet is a failure.
  assert.match(inv, />Employers<\/span><span class="[^"]*">Off · all \d+</, 'the strip states the employer facet');
  assert.ok(!inv.includes('Plan type'), 'plan type stopped being a switch 2026-08-07 — no row, no badge');
  // ⚠ TOGGLEABLE IN PLACE. The inventory is the CONTROLS, not a summary beside them — every row it
  // lists carries its own control in the same markup, which is what "flip any of them" requires.
  assert.match(inv, /aria-pressed="false"[^>]*>Self-Funded/, 'the funding toggles are here');
  assert.match(inv, /aria-pressed="false"[^>]*>AETNA/, 'so are the billed-under toggles');
  assert.match(inv, /aria-label="Employers"/, 'and the employer type-ahead is a live input, not a readout');
  // Marked for the stagger. Five beats inside the card: headline, window, funding, employers,
  // billed under.
  assert.ok((inv.match(/data-v3-facet/g) ?? []).length >= 5, 'the rows carry the reveal hook');
});

// ── THE NARROW SEARCH CARD (Alec, 2026-08-07) ────────────────────────────────────────────────────
// The answer stage's filter region folds into a card you click to expand. The ratified promise it
// must not break is the one in docs/qualify-v3-search-pattern.md: "at the end show which filters are
// ON and which are OFF so they can toggle them." A collapse puts the CONTROLS behind a click; it may
// not put the INVENTORY behind one. Hence the split these three tests pin: the summary states, the
// fields control.
//
// ⚠ THESE ARE THE TESTS A `<details>` COLLAPSE WOULD HAVE FAKED. A closed <details> serializes its
// children into the SSR string, so "is the row in the markup" cannot tell a visible control from a
// hidden one. Both halves below are therefore asserted against the SAME props with only
// `narrowExpanded` moved — the expanded render is the positive control that stops the collapsed
// negative from passing vacuously (e.g. because the card failed to render at all).
const narrowCase = (narrowExpanded: boolean): string =>
  render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: allPayersSnapshot(),
        skipped: true,
        scopeSource: 'dominant',
        candidates: orderedCandidates(fixture()),
        narrowExpanded,
      }),
    }),
  );

test('THE VERDICT CARD, COLLAPSED: the tag strip IS the inventory — every facet states ON or OFF with no click', () => {
  const shut = inventoryRegion(narrowCase(false));
  // The same five claims the expanded card makes, in the same vocabulary, from the same expressions.
  // A second vocabulary for the collapsed state is the drift the AREA-denominator bug shipped as.
  assert.match(shut, /Nothing narrows this search but the window\./);
  assert.match(shut, />Window<\/span><span class="[^"]*">On · automatic</, 'window is never off, and says which it is');
  assert.match(shut, />Funding<\/span><span class="[^"]*">Off · all \d+</);
  assert.match(shut, />Employers<\/span><span class="[^"]*">Off · all \d+</);
  assert.match(shut, />Billed under<\/span><span class="[^"]*">Off · all 2 labels</);
  // PLAN TYPE IS NOT A SWITCH ANY MORE (Alec, 2026-08-07), so the summary must not list one. Bounded
  // to the card on purpose: `planType` still renders on every plan tile and in the resolved identity
  // line — the TAG stayed, the FILTER went — so an unbounded negative would assert the wrong thing.
  assert.ok(!shut.includes('Plan type'), 'no plan-type facet in the inventory');
});

test('THE VERDICT CARD, COLLAPSED: the CONTROLS are genuinely gone — not hidden, not serialized', () => {
  const shut = inventoryRegion(narrowCase(false));
  const open = inventoryRegion(narrowCase(true));
  // POSITIVE CONTROL FIRST. Without these four, every negative below would pass against a card that
  // rendered nothing at all — which is exactly how a guard stops being able to fail.
  assert.match(open, /aria-pressed="false"[^>]*>Self-Funded/, 'expanded: the funding toggles are here');
  assert.match(open, /aria-pressed="false"[^>]*>AETNA/, 'expanded: so are the billed-under toggles');
  assert.match(open, /aria-pressed="false"[^>]*>90 days/, 'expanded: so are the window chips');
  assert.match(open, /aria-label="Employers"/, 'expanded: so is the employer type-ahead');
  // ...and now the negatives mean something.
  assert.ok(!/aria-pressed=/.test(shut), 'collapsed: NO toggle of any kind survives in the card');
  assert.ok(!shut.includes('aria-label="Employers"'), 'collapsed: no employer type-ahead either');
  assert.ok(!shut.includes('<details'), 'collapsed: not a <details>, whose children serialize while invisible');
  // The disclosure says what it is and what state it is in — a caret alone is not an affordance.
  assert.match(shut, /aria-expanded="false"[^>]*aria-controls="qualify-narrow-fields"/);
  assert.match(open, /aria-expanded="true"[^>]*aria-controls="qualify-narrow-fields"/);
});

test('THE VERDICT CARD: nothing clips the type-ahead dropdown', () => {
  // ⚠ A CLIP ON THE CARD IS A CLIP ON THE PICKER'S OPTION LIST, and nothing else in this file would
  // notice. MultiSelectTagPicker's dropdown is absolutely positioned (`absolute top-full max-h-64`,
  // opening downward from a row near the bottom of the card), so ANY `overflow-hidden` ancestor
  // renders its matches into a box whose bottom the operator cannot see, with nothing wrong in the
  // DOM to catch.
  //
  // ⚠ REWRITTEN 2026-08-12, AND THE REWRITE IS THE POINT. This test used to assert a two-layer
  // arrangement: the deleted NARROW SEARCH card needed `overflow-hidden` because `.q-subject::after`
  // was a coral glow positioned OUTSIDE its box (right:-40px, top:-60px), so the clip was pushed down
  // onto a paint-only `<span>` and this test pinned it there. The verdict card that replaced it has
  // no gradient, no glow and therefore NO CLIP ANYWHERE — `.q-subject` was deleted from globals.css
  // in the same change so nobody can re-introduce one by re-using the class. What survives is the
  // guard that actually protected the operator: the region the picker lives in must not clip.
  const card = inventoryRegion(narrowCase(true));
  assert.match(card, /aria-label="Employers"/, 'positive control: the picker really is inside this card');
  const cardTag = card.slice(0, card.indexOf('>') + 1);
  assert.ok(!/\boverflow-hidden\b/.test(cardTag), 'the card itself must not clip — the dropdown lives inside it');
  assert.ok(!/\boverflow-hidden\b/.test(card), 'and no wrapper inside it may either');
  assert.ok(!/\bq-subject\b/.test(card), 'the deleted gradient layer must not come back');
});

test('THE VERDICT CARD, COLLAPSED: the skip reveal still has beats to stagger', () => {
  // ⚠ `staggerDelayMs(0) === 0`, so a one-element stagger is arithmetically a no-op. A collapse that
  // unmounted the rows without re-homing the hook would leave AREA as the only `[data-v3-facet]` on
  // the whole stage and kill the reveal silently — the tween would still run, over one element, at
  // zero delay. The floor is asserted INSIDE the card precisely so AREA (which sits beside the grid)
  // cannot prop it up.
  for (const [label, expanded] of [['collapsed', false], ['expanded', true]] as const) {
    const beats = (inventoryRegion(narrowCase(expanded)).match(/data-v3-facet/g) ?? []).length;
    assert.ok(beats >= 5, `${label}: the card carries ${beats} reveal beats, and the stagger needs at least 5`);
  }
});

test('THE VERDICT CARD, COLLAPSED: it states what the search resolved to, and every facet ON or OFF', () => {
  const shut = inventoryRegion(narrowCase(false));
  // (a) WHAT THE SEARCH RESOLVED TO — plan-or-all-plans, payer, window. A reader who never clicks
  //     must still know the scope they are looking at.
  assert.match(shut, /All plans — no plan chosen/, 'the plan half of the resolved scope');
  assert.match(shut, /across all 2 billed-under labels/, 'the payer half');
  assert.match(shut, /automatic window/, 'the window half');
  // (b) THE TALLY, AND IT MUST AGREE WITH THE STRIP. Counted off the badges actually rendered rather
  //     than written down here, so a facet that stops rendering — options ran out, or a ruling drops
  //     the row — cannot leave a stale total behind it. The two concrete numbers are asserted as well,
  //     because a tally derived from an EMPTY strip would agree with it perfectly.
  const on = (shut.match(/>On · /g) ?? []).length;
  const off = (shut.match(/>Off · /g) ?? []).length;
  assert.equal(on, 1, 'window is on and never off — the honest floor for this card, not a bug');
  assert.equal(off, 3, 'funding, employers, billed under — plan type stopped being a switch 2026-08-07');
  // ⚠ THE TALLY SENTENCE WENT 2026-08-12 — four tags are countable at a glance, and the disclosure
  // that used to need "open the fields to change any of them" is 40px to their right. THE COUNTS
  // STAY ASSERTED: a strip that silently stopped rendering a facet is still the defect this guards,
  // and it is exactly the defect a tally derived from the strip could never catch.
  assert.match(shut, />Window<\/span>/, 'positive control: the scope bar rendered');
  // The card holds four of the screen's five facets — AREA's control lives beside the grid — so the
  // footnote NAMES that narrow when it is live rather than folding it into a count. See the AREA
  // test below.
  assert.ok(!shut.includes('area narrow'), 'no area narrow here, so nothing to point at');
});

test('THE VERDICT CARD, COLLAPSED: an active AREA narrow is NAMED, so the strip cannot contradict the headline', () => {
  // ⚠ THE COLLAPSED CARD IS THE ONLY THING ON SCREEN ANSWERING "IS ANYTHING NARROWING THIS SEARCH",
  // and with an area narrow it was answering incompletely. Every in-card switch off + area on gives:
  // headline "Some switches are on" (correct — `anyFacetOn` has counted area since 2026-08-07), then
  // a strip whose only On is the Window, which the headline's OTHER arm explicitly discounts
  // ("apart from the window, nothing is narrowing this search"). The numeric tally turned that soft
  // mismatch into a countable one: "1 on" while two narrows are live.
  //
  // AREA STAYS OUT OF `cardFacets` — its control is beside the grid it narrows, and "which switches
  // are on IN HERE" is a different question from "is anything narrowing this AT ALL". So the tally
  // POINTS at it rather than absorbing it, and keeps the card's own count honest.
  const r = fixture();
  const base = threeStateSnapshot();
  const allPayersThreeStates = {
    ...base,
    resolved: { ...base.resolved, payerName: null, payerScope: 'all' },
  } as unknown as QualifySnapshot;
  const withArea = (area: string) =>
    inventoryRegion(
      render(
        props('answer', r, {
          answer: answerProps({
            snapshot: allPayersThreeStates,
            skipped: true,
            scopeSource: 'dominant',
            candidates: orderedCandidates(r),
            area,
          }),
        }),
      ),
    );

  const narrowed = withArea('TN');
  assert.match(narrowed, /Some narrows are on/, 'the headline counts area — it always has');
  assert.match(narrowed, /Plus the area narrow, beside the list\./, 'and the footnote says where the other one is');

  // NEGATIVE CONTROL. Without it the clause could be unconditional, which would name a narrow that
  // is not on — the mirror image of the bug being fixed.
  const wide = withArea(AREA_ALL);
  assert.ok(!wide.includes('area narrow'), 'no area narrow, no clause');
  assert.match(wide, /Nothing narrows this search/, 'and the headline agrees that nothing is on');
});

// The AREA facet is the one whose control does NOT live on the control card (#164 put it beside the
// grid it narrows, and that placement is right — everything on the card re-issues the ranking request
// and area does not). "Where the control sits" and "is this facet restricting what I see" are
// different questions, and the inventory answers the second.
test('THE SKIP INVENTORY covers AREA too, even though its control lives beside the grid', () => {
  const r = fixture();
  // ⚠ THE SNAPSHOT MUST BE ALL-PAYERS, or this test cannot see what it is testing: under a
  // payer-scoped ranking `payerFacetOn` is already true, so the headline says "some switches are on"
  // for a reason that has nothing to do with area, and removing `areaActive` from `anyFacetOn` would
  // leave the assertion green. The one-click contradiction only exists in the state a Skip produces.
  const allPayersThreeStates = {
    ...threeStateSnapshot(),
    resolved: { ...threeStateSnapshot().resolved, payerName: null, payerScope: 'all' },
  } as unknown as QualifySnapshot;
  const withArea = (area: string) =>
    render(
      props('answer', r, {
        answer: answerProps({
          snapshot: allPayersThreeStates,
          skipped: true,
          scopeSource: 'dominant',
          candidates: orderedCandidates(r),
          area,
        }),
      }),
    );
  const wide = withArea(AREA_ALL);
  // `data-v3-facet` is emitted BEFORE the aria-label on the same element, so slice from the opening
  // <div, not from the label.
  const areaRow = wide.slice(wide.lastIndexOf('<div', wide.indexOf('aria-label="Filter the ranked list by area"')));
  assert.match(areaRow.slice(0, 400), /data-v3-facet/, 'it carries the reveal hook so the stagger includes it');
  assert.match(areaRow.slice(0, 600), /Off · all \d+/, 'and states its OFF state in the same vocabulary as every other facet');

  // ⚠ ONE CLICK, AND THE OLD HEADLINE WAS FALSE. With area narrowed, filters empty and the ranking
  // all-payers, `anyFacetOn` was false — so the sentence claimed nothing was narrowing the search
  // directly above a LIT Area chip. The exact contradiction `payerFacetOn` was added to prevent, on
  // the one facet Alec named by name.
  const narrowed = withArea('TN');
  // The headline lives INSIDE the card, so it is asserted inside the card — unbounded, this passed on
  // a headline rendered anywhere on the page.
  assert.match(inventoryRegion(narrowed), /Some narrows are on — anything marked Off is unrestricted\./);
  assert.ok(!narrowed.includes('Nothing narrows this search'), 'an active area IS a filter that is on');
  assert.match(narrowed.slice(narrowed.indexOf('aria-label="Filter the ranked list by area"')), /On · 1 of \d+/);
});

// ── The AREA badge's denominator ─────────────────────────────────────────────────────────────────
// It used to read `chips.length - 1` — "everything except the All chip" — an assumption about a list
// whose composition belongs to the area module. Rendered directly here rather than through the stage
// because ONLY a synthetic chip list can discriminate the two implementations: through a real
// snapshot, `areaChipsWithActive` always emits exactly one All chip, so subtraction and filtering
// agree and a test built on it would pass against either. This is the reason the component is
// exported.
test('the AREA badge counts area chips, and does not assume the list shape', () => {
  const renderArea = (chips: readonly { key: string; label: string }[], active: string) =>
    renderToStaticMarkup(
      <AreaLine chips={chips as never} active={active} counts={new Map()} shown={1} onSelect={() => {}} />,
    );

  // A list with NO All chip: subtraction under-counts by one, filtering is right. If this ever goes
  // green against `chips.length - 1` again, the assumption is back.
  assert.match(renderArea([{ key: 'TN', label: 'TN' }, { key: 'AZ', label: 'AZ' }], AREA_ALL), /Off · all 2/);
  // The ordinary shape, where the two implementations agree — kept so the fix cannot regress the
  // common case while satisfying the synthetic one.
  assert.match(
    renderArea([{ key: AREA_ALL, label: 'All' }, { key: 'TN', label: 'TN' }, { key: 'AZ', label: 'AZ' }], AREA_ALL),
    /Off · all 2/,
  );
  // The gate at the call site admits `chips.length === 2` through its `|| areaActive` arm, so
  // "On · 1 of 1" is reachable. It is odd-looking but TRUE — there is one area and you are on it —
  // and the old `Math.max(1, …)` floor would have printed the same thing while hiding a real zero.
  assert.match(renderArea([{ key: AREA_ALL, label: 'All' }, { key: 'TN', label: 'TN' }], 'TN'), /On · 1 of 1/);
});

test('the AREA badge agrees with the real chip builder end-to-end', () => {
  // Integration half: the denominator the stage renders is the number of non-All chips
  // `areaChipsWithActive` actually produced for that facility set.
  const facilities = threeStateSnapshot().facilities;
  const expected = areaChipsWithActive(facilities, AREA_ALL).filter((c) => c.key !== AREA_ALL).length;
  assert.equal(expected, 3, 'AZ + TN + Other for this fixture');
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: threeStateSnapshot(), skipped: true, scopeSource: 'dominant' }),
    }),
  );
  assert.ok(html.includes(`Off · all ${expected}`), 'the badge states the real option count');
});

test('the inventory headline flips once ANY facet is on — including the billed-under scope alone', () => {
  // ⚠ `answerFiltersActive` covers three of the six facets. Reusing it here would print "every switch
  // is off" beside a lit BILLED UNDER chip, which is the claim this sentence exists to make true.
  const scoped = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), skipped: true, scopeSource: 'dominant' }) }),
  );
  assert.match(inventoryRegion(scoped), /Some narrows are on — anything marked Off is unrestricted\./);
  // ⚠ THIS NEGATIVE USED TO NAME 'Every switch is off', WHICH THE I4 FIX DELETED FROM THE SOURCE —
  // so it passed no matter what the component did. A guard that cannot fail is worse than no guard,
  // because it reads as coverage. Re-pointed at the string the component would ACTUALLY emit if
  // `anyFacetOn` regressed, which is the other arm of the same ternary.
  assert.ok(!scoped.includes('Nothing narrows this search'), 'a payer-scoped ranking is a switch that is on');
});

test('with ONE label on file the billed-under scope is not counted as a switch that is on', () => {
  // The chip row does not render below 2 options, so calling the scope "on" would point the operator
  // at a control they cannot see, to widen a search that is already as wide as it can be — with one
  // label, that label IS the whole footprint.
  const one = {
    ...snapshotFixture(),
    payerOptions: [{ payer: 'AETNA', lines: 3690, patients: 122, lastPayment: '2026-08-02' }],
  } as QualifySnapshot;
  const html = render(props('answer', fixture(), { answer: answerProps({ snapshot: one, skipped: true, scopeSource: 'dominant' }) }));
  // Whole-document negative on purpose — "Billed under" must appear NOWHERE, card or not.
  assert.ok(!html.includes('Billed under'), 'the chip row self-hides at one option');
  assert.match(inventoryRegion(html), /Nothing narrows this search but the window/);
  assert.ok(!html.includes('Some narrows are on'));
});

test('the inventory sentence is a SKIP affordance — it does not intrude on a resolved plan pick', () => {
  const picked = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'pick', candidates: orderedCandidates(fixture()) }),
    }),
  );
  assert.ok(!picked.includes('Nothing narrows this search'), 'no inventory headline outside a skip');
  assert.ok(!picked.includes('Some narrows are on'));
  // The per-facet badges DO stay — they are honest on every path, and a second vocabulary for the
  // picked path would be exactly the kind of drift this file keeps out. ⚠ BOUNDED: unbounded, the
  // AREA badge below the card satisfied this on its own, so the assertion said nothing about the card.
  assert.match(inventoryRegion(picked), /Off · all \d+/);
});

test('THE NARROW SEARCH CARD: the scope line attributes the label to the RANKING, not to the picked plan', () => {
  // ⚠ ADJACENCY, NOT FALSEHOOD. On the pick-rejected path the collapsed card renders its scope line
  // directly above the billed-under caption, and "The plan you picked · under AETNA US HEALTHCARE"
  // invited a reader to take that label as the picked plan's — one line above a caption saying the
  // pick could NOT be scoped. Both sentences were true; adjacent, they misread. The verb attaches the
  // label to the RANKING, and the caption below keeps sole ownership of HOW the label was chosen —
  // re-deriving that four-way claim up here is how two sentences about one fact start to drift.
  const card = inventoryRegion(
    render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), scopeSource: 'pick' }) })),
  );
  assert.match(card, /The plan you picked · ranked under AETNA US HEALTHCARE/);
  assert.match(card, /Could not scope to the picked plan — showing the largest by volume\./);
  assert.ok(!/picked · under /.test(card), 'the bare "· under X" reading is the one that misled');
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
          // MERGE INTEGRATION (#164 × #165). This read `scopeSource: 'skipped'` when #164 wrote it.
          // #165 split that one enum in two — `scopeSource` now answers only "who chose the payer
          // label", and the skip itself is its own prop, precisely because one billed-under chip
          // press falsified the second. So the skip state is the PAIR below. `'dominant'` rather
          // than the fixture default `'pick'`: a skip forces `pickLabel` to null
          // (resolution-flow-client.tsx), so `scopeSourceOf` cannot return 'pick' beside a skip —
          // the default would put this fixture in a state the app is unable to produce.
          skipped: true,
          scopeSource: 'dominant',
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
  const funded = disclosureOf(skipped({ filters: { funding: ['Self-Funded'], employers: [] } }));
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
            // Same #164 × #165 split as the guard above — see the note there.
            skipped: true,
            scopeSource: 'dominant',
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
  const both = skipped({ area: 'TN', filters: { funding: ['Self-Funded'], employers: [] } });
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


// ── S2 (2026-08-08) — THE PREFACE AND THE PAYER'S BOOK ───────────────────────────────────────────
//
// Measured the same day: 58.8% of member-ID prefixes resolve to exactly ONE member carrying 1.14
// facilities of history, and 85.7% can never reach the 10-patient confidence floor at any window.
// So the majority of searches were being answered with a "ranking" of one row, presented in the same
// words as a ranking over a real population. The engine now says which world it is in BEFORE it
// claims anything, and — for the person case — puts the payer's whole book on screen beside the
// member's own footprint, because that is the list that answers "does this policy pay, anywhere".
//
// S2 renders the book SECONDARY. The prominence flip is S3 and is deliberately not built here.

/** A snapshot carrying both S2 fields. `facilities` stays the MEMBER ranking — never repurposed. */
function bookSnapshot(over: Partial<QualifySnapshot> = {}): QualifySnapshot {
  return {
    ...snapshotFixture(),
    memberCount: 1,
    facilities: [facility({ rank: 1, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH' })],
    bookFacilities: [
      facility({ rank: 1, name: 'SUMMIT RIDGE RECOVERY', facilityKey: 'SUMMIT', payerCount: 1, solePayer: 'AETNA US HEALTHCARE' }),
      facility({ rank: 2, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', city: 'Phoenix', state: 'AZ', payerCount: 1, solePayer: 'AETNA US HEALTHCARE' }),
      facility({ rank: 3, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH', payerCount: 1, solePayer: 'AETNA US HEALTHCARE' }),
    ],
    ...over,
  } as unknown as QualifySnapshot;
}

/**
 * THE SAME SNAPSHOT IN THE MODE THAT DOES **NOT** FLIP (S3, 2026-08-08).
 *
 * `bookSnapshot()` carries `memberCount: 1`, and S3 made that the BOOK-LED case: the payer's book
 * becomes the answer's own ranked grid and the member's footprint survives as annotations on it. So
 * every S2 assertion about the book as a *secondary section below the member ranking* now describes
 * the 2-9 bucket, not the 1-member one. Those tests are re-aimed onto this helper rather than
 * deleted — each still pins a real, reachable render; it is the MODE that moved, not the claim.
 */
const secondaryBookSnapshot = (over: Partial<QualifySnapshot> = {}): QualifySnapshot =>
  bookSnapshot({ memberCount: 4, ...over } as Partial<QualifySnapshot>);

const answerHtml = (snap: QualifySnapshot, over: Partial<NonNullable<ResolutionStagesProps['answer']>> = {}) =>
  render(props('answer', fixture(), { answer: answerProps({ snapshot: snap, ...over }) }));

/** The book section's OWN markup, bounded at its closing tag — the same discipline as
 *  `inventoryRegion`, and for the same reason: an unbounded slice lets a claim rendered ANYWHERE
 *  below satisfy an assertion about what the book section says. */
function bookRegion(html: string): string {
  const attr = html.indexOf('data-v3-book');
  assert.ok(attr >= 0, 'no [data-v3-book] element in this render — a region check would be vacuous');
  return outerHtmlFrom(html, html.lastIndexOf('<', attr));
}

test('S2 preface — ONE member, and EVERY number states the basis it was counted on', () => {
  const html = answerHtml(bookSnapshot());
  // The 58.8% case. It does NOT call one row a ranking, and it does not hide it either.
  //
  // ⚠ TWO NUMBERS, TWO WINDOWS, BOTH NAMED (fix round 1, I1). `memberCount` is ALWAYS the 365-day
  // rung — deliberately, so the classifier cannot move when a Range chip is pressed — while the
  // facility count is the CHOSEN window. Joined by a bare em-dash those made one mixed-basis claim,
  // and the contradiction was reachable rather than theoretical: see the 30-day test below.
  assert.match(html, /One member has a paid claim behind this search in the last 12 months/);
  assert.match(html, /1 facility of history in the window shown\./);
});

test('S2 preface — a 30-day window on a member paid 200 days ago no longer contradicts itself', () => {
  // THE EXACT DEFECT I1 NAMES. Pre-fix this rendered "One member matches this search — 0 facilities
  // of history." beside an empty grid: the member half true at 365d, the facility half true at 30d,
  // and the sentence false at both. Now each clause carries its own window and the pair is coherent —
  // paid within the year, nothing inside the window on screen.
  const html = answerHtml(bookSnapshot({ facilities: [] } as Partial<QualifySnapshot>), { windowDays: 30 });
  assert.match(html, /One member has a paid claim behind this search in the last 12 months/);
  assert.match(html, /0 facilities of history in the window shown\./);
});

test('S2 preface — the 2-9 bucket names no absent control, and the 10+ bucket names a population', () => {
  const few = answerHtml(bookSnapshot({ memberCount: 4 }));
  // A member-by-member pick stays descoped: raw member ids can never render, so picking one needs a
  // server-side per-response ordinal enumeration plus a pick-by-ordinal predicate.
  assert.match(few, /4 members have a paid claim behind this prefix in the last 12 months\./);
  /* ⚠ RE-AIMED BY THE FINAL FIX ROUND (2026-08-08). "Continue to search across all of them" named the
   * SKIP — a control that does not exist on the ANSWER stage, the only stage this sentence renders on,
   * and the same sentence is announced by `liveSentenceFor`'s skipped arm over the identify screen.
   * The replacement names no control and no position. FF-m8 pins the whole string. */
  assert.match(few, /This search covers all of them — refine the prefix to narrow it to one\./);
  const many = answerHtml(bookSnapshot({ memberCount: 31 }));
  assert.match(many, /A population — 31 members have a paid claim behind this prefix in the last 12 months\./);
});

test('S2 preface — an UNAVAILABLE count says nothing new, and a ZERO count does not claim an empty person', () => {
  // null = the rungs loader is absent or failed soft. The screen must be exactly as it was.
  const unknown = answerHtml(bookSnapshot({ memberCount: null }));
  assert.ok(!unknown.includes('a paid claim behind this'), 'no preface at all');
  assert.ok(!unknown.includes('member') || !unknown.includes('in the last 12 months'));
  // 0 = the count RAN and nobody with claims is behind the token. Still no preface: the provenance
  // banner already owns that story, and "0 members match" is a sentence nobody needs.
  const none = answerHtml(bookSnapshot({ memberCount: 0 }));
  assert.ok(!none.includes('a paid claim behind this'));
  // ⚠ AND THE RECEIPT IS SILENT ON BOTH, THROUGH THE SAME GATE. The chip prints the COUNT rather
  // than the sentence, but WHETHER it prints is `memberBucketOf` — not a second null/zero ternary
  // that could drift from the one the preface uses. Both nothings, asserted.
  for (const count of [null, 0]) {
    const receipt = outerHtmlFrom(
      answerHtml(bookSnapshot({ memberCount: count } as Partial<QualifySnapshot>)),
      answerHtml(bookSnapshot({ memberCount: count } as Partial<QualifySnapshot>)).indexOf('<nav aria-label="Your search so far"'),
    );
    assert.ok(!receipt.includes('member'), `the receipt says nothing for memberCount=${String(count)}`);
  }
});

test('S2 preface — SUPPRESSED IN FLIGHT (rule 2654416), like every other categorical claim', () => {
  // It is a statement about the data, so while a re-scope is in flight it must not describe the set
  // being replaced. The dim + beam treatment is the marker; this sentence waits.
  const inFlight = answerHtml(bookSnapshot(), { refetching: true });
  assert.ok(!inFlight.includes('a paid claim behind this search'), 'a claim about a superseded scope');
  const failed = answerHtml(bookSnapshot(), { staleAfterError: true });
  assert.ok(!failed.includes('a paid claim behind this search'));
});

test('S2 preface — it is NOT a role="status": the sr-only live region already announces it', () => {
  // The one string on this surface that would otherwise be announced TWICE — once by its own status
  // role and once by the flow's single live region, which carries the same sentence through
  // `liveSentenceFor`. The team already ruled against overlapping status sentences for exactly this
  // (two `role="status"` lines for one area click). The visible line is text; the announcement is
  // the live region's job, and it is the only one that can sequence with the rest of the flow.
  const html = answerHtml(bookSnapshot());
  const at = html.indexOf('One member has a paid claim behind this search');
  assert.ok(at >= 0, 'the preface is on screen — the check below would be vacuous otherwise');
  const para = outerHtmlFrom(html, html.lastIndexOf('<p', at));
  assert.ok(!para.includes('role="status"'), 'no second announcer for a sentence the live region owns');
  // The live region still carries it — this is a claim about DUPLICATION, not about silence.
  assert.ok(html.includes('aria-live="polite"'));
});

test('S2 preface — the RECEIPT carries the same count, on the entry that is actually revisitable', () => {
  const html = answerHtml(bookSnapshot({ memberCount: 4 }));
  // The receipt is a record of DECISIONS and every entry is revisitable. A member count is not a
  // decision, so it does not become an entry of its own — it qualifies the SEARCH entry, which is
  // the decision it is about and the one carrying "Change".
  const receipt = outerHtmlFrom(html, html.indexOf('<nav aria-label="Your search so far"'));
  assert.match(receipt, /XDP/, 'the slice really is the receipt');
  assert.match(receipt, /4 members/);
});

test('S2 preface — the ARIA channel announces the SAME claim, and never a second facility count', () => {
  const r = fixture();
  // ⚠ THE aria SENTENCE ALREADY CARRIED A FACILITY COUNT — `claimEvidence.distinctFacilities`, which
  // is rendered NOWHERE on screen. The ONE-member preface names a facility count of its own, so
  // announcing both would read out two different numbers for one question. It replaces the clause.
  const spoken = liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1 });
  assert.match(spoken, /One member has a paid claim behind this search in the last 12 months/);
  assert.match(spoken, /1 facility of history in the window shown\./);
  assert.ok(!spoken.includes('28 facilities with history'), 'the invisible resolution count steps aside');
  // Unknown → byte-identical to what shipped before S2.
  assert.equal(
    liveSentenceFor('answer', r, null, {}),
    liveSentenceFor('answer', r, null, { memberCount: null, memberFacilityCount: 0 }),
  );
  assert.match(liveSentenceFor('answer', r, null, {}), /28 facilities with history\./);
  // A skipped search announces it too — that arm is the identifier-wide one, and it is where an
  // unfixed claim survives a browser pass.
  const skipSpoken = liveSentenceFor('answer', r, null, {
    skipped: true,
    scopeAllPayers: true,
    memberCount: 31,
    memberFacilityCount: 9,
  });
  assert.match(skipSpoken, /A population — 31 members have a paid claim behind this prefix in the last 12 months\./);
  assert.match(skipSpoken, /You skipped the plan questions/, 'and it keeps the claim it already made');
});

test('S2 preface — the 2-9 and 10+ arms KEEP the resolution facility count, because they name none', () => {
  // ⚠ THE REPLACEMENT RULE IS "ONLY WHEN THE PREFACE CARRIES A COUNT OF ITS OWN", not "whenever a
  // preface exists" (fix round 1, M6). The one-member arm names a facility count and would collide;
  // the 2-9 and 10+ arms name none, so replacing would leave a screen-reader user hearing NO
  // facility count at all while the grid visibly has one — silence where the sighted read has a
  // number. There is nothing to collide with, so the pre-existing clause stands untouched.
  const r = fixture();
  for (const memberCount of [4, 31]) {
    const spoken = liveSentenceFor('answer', r, null, { memberCount, memberFacilityCount: 3 });
    assert.match(spoken, /in the last 12 months/, 'the classification is announced');
    assert.match(spoken, /28 facilities with history\./, 'and the facility count is NOT dropped');
  }
});

test('S2 book — a clearly-labelled SECOND section, named for the payer, with its own basis', () => {
  // RE-AIMED BY S3: the SECONDARY placement is the 2-9 bucket's render. At one member the book is
  // the answer's own grid — pinned separately below.
  const book = bookRegion(answerHtml(secondaryBookSnapshot()));
  assert.match(book, /Where AETNA US HEALTHCARE pays — across the whole book/);
  /* THE COUNT, IN BOTH CHANNELS, NAMED SEPARATELY. A bare /3 facilities/ was satisfied by the
   * aria-label ALONE — proven by mutation — so it could not tell "the section states its size" from
   * "the section has an accessible name and shows nothing". Both are required, because a numeral
   * needs its accessible name and the sighted reader needs the word beside it. */
  assert.match(book, /aria-label="3 facilities in this payer&#x27;s book"/, 'the numeral has an accessible name');
  assert.match(book, />3<\/span> facilities/, 'and the visible text says it too');
  // ⚠ ITS OWN BASIS LABEL. The member ranking's claims describe the member; this list does not, and a
  // section that borrowed them would be the scope lie this whole surface is built against.
  assert.match(book, /not this member/i);
  // Rendered through the SAME ScoreCard, so S1's census chips, greying and rating words come free.
  assert.match(book, /SUMMIT RIDGE RECOVERY/);
  assert.match(book, /PHOENIX RENEWAL/);
});

test('S2 book — the MEMBER ranking is untouched: its heading, its cards and its counts still describe the member', () => {
  // RE-AIMED BY S3, and the re-aim is the point: this is the claim the 1-member flip DELIBERATELY
  // stops making. In every OTHER bucket the member ranking still leads and the book sits below it.
  const html = answerHtml(secondaryBookSnapshot());
  assert.match(html, />Facilities, ranked</, 'the member ranking keeps its heading');
  // The member grid holds exactly the member's own facility — the book did not leak into it.
  const memberSection = outerHtmlFrom(html, html.lastIndexOf('<section', html.indexOf('qualify-scorecard-heading')));
  assert.ok(memberSection.includes('NASHVILLE MENTAL HEALTH'));
  assert.ok(!memberSection.includes('SUMMIT RIDGE RECOVERY'), 'the book list is NOT the ranked grid');
});

test('S2 book — a book card carries NO payer-scope disclosure at all: there is exactly one payer', () => {
  // The blend disclosure is SCOPE-gated (`allPayers`), not count-gated, and the book is payer-scoped
  // by construction — `bookFacilities` is null on the only ranking that spans several labels. So the
  // right degrade is silence, not "1 payer · AETNA" on every card: at one label the count is a fact
  // nobody asked for, printed beside a heading that already names the payer.
  const book = bookRegion(answerHtml(secondaryBookSnapshot()));
  assert.ok(!book.includes('blended across'), 'nothing is blended — one label by the equality that built it');
  // ⚠ THE SECOND HALF IS WHAT MAKES THIS MUTATION-DETECTABLE. Passing the member ranking's
  // `allPayers` through instead of `false` would not print "blended across" (payerCount is 1) — it
  // would print the one-payer arm, and a test asserting only the blend string would sail past it.
  assert.ok(!book.includes('billed-under label'), 'and no per-card payer count either');
  // Positive control on the same render: the member ranking beside it is equally silent, so the
  // absence above is a property of the SCOPE and not of a fixture that forgot to set payerCount.
  assert.ok(!answerHtml(secondaryBookSnapshot()).includes('blended across'));
  // And in the BOOK-LED mode, where the same cards are the answer's own grid, still silent.
  assert.ok(!answerHtml(bookSnapshot()).includes('blended across'));
});

test('S2 book — ABSENT on the identifier-wide Skip, where no single payer has a book', () => {
  // `buildFacilityRankingQuery` throws on (null payer, no market, no token) and the all-payers whole
  // book is a 206-713ms scan that spills to disk — an hourly cache's job, never a per-search load.
  // The section must not render an empty shell claiming a list that was never fetched.
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: allPayersSnapshot({ memberCount: 31, bookFacilities: null } as Partial<QualifySnapshot>),
        skipped: true,
        scopeSource: 'dominant',
      }),
    }),
  );
  assert.ok(!html.includes('across the whole book'), 'no book heading');
  assert.ok(!html.includes('data-v3-book'), 'and no section at all');
  // The preface still lands — the classifier is independent of whether a book could be loaded.
  assert.match(html, /A population — 31 members have a paid claim behind this prefix in the last 12 months\./);
});

test('S2 book — the AI grounding caption stops saying "the ranking on screen" once TWO rankings are', () => {
  // The payload is `snap.facilities.slice(0,10)` — the MEMBER ranking. With a second ranking on
  // screen, "the ranking on screen" no longer identifies which one the model read. Same standard the
  // area narrow already forced: say what backs the answer instead of letting the screen relabel it.
  // RE-AIMED BY S3: "the whole-book list BELOW" is the secondary placement, i.e. the 2-9 bucket. The
  // book-led arm ("not the book ranked above") is pinned in the S3 block.
  const withBook = disclosureOf(
    render(
      props('answer', fixture(), {
        answer: answerProps({ snapshot: secondaryBookSnapshot(), skipped: true, scopeSource: 'dominant' }),
      }),
    ),
  );
  assert.ok(!withBook.includes('grounded in the ranking on screen'), 'ambiguous the moment a book is beside it');
  assert.match(withBook, /grounded in this member&#x27;s ranking, not the whole-book list/);
  // WITHOUT a book the string is byte-identical to what shipped — the S1 test above freezes it.
  const noBook = disclosureOf(
    render(
      props('answer', fixture(), {
        answer: answerProps({
          snapshot: { ...bookSnapshot(), bookFacilities: null } as unknown as QualifySnapshot,
          skipped: true,
          scopeSource: 'dominant',
        }),
      }),
    ),
  );
  assert.match(noBook, /grounded in the ranking on screen/);
});


// ── FIX ROUND 1/5 — the cap, and the one predicate behind "is a book on screen" ──────────────────

/** A book of nine, so the truncating branch actually renders. Every S2 fixture had THREE against a
 *  cap of eight, which meant the slice, the cap sentence and its total had never once been executed
 *  under test — mutation-proven: replacing the sentence with garbage and the total with a wrong
 *  number left the suite fully green. A real payer's book is 48 facilities, so this is the COMMON
 *  path, not an edge. */
function bigBookSnapshot(over: Partial<QualifySnapshot> = {}): QualifySnapshot {
  return {
    // RE-AIMED BY S3: the cap belongs to the SECONDARY section. A book-LED answer is not capped at
    // all (see the S3 block) — a cap on the list that IS the answer would be a silent filter.
    ...secondaryBookSnapshot(),
    bookFacilities: Array.from({ length: 9 }, (_, i) =>
      facility({ rank: i + 1, name: `BOOK FACILITY ${i + 1}`, facilityKey: `BF${i + 1}`, payerCount: 1 }),
    ),
    ...over,
  } as unknown as QualifySnapshot;
}

test('S2 book — the CAP renders, states the REAL total, and names what a cap costs', () => {
  const book = bookRegion(answerHtml(bigBookSnapshot()));
  // The exact sentence, with the true denominator — not "of 8", and not a count re-derived from the
  // sliced array, which is how a truncation notice comes to describe itself instead of the set.
  assert.match(book, /Showing the 8 best-ranked of 9\./);
  /* ⚠ AND WHY THAT MATTERS HERE SPECIFICALLY: availability leads the sort (S1), so the rows a cap
   * removes skew toward the FULL ones. A cap that hid them silently would turn "census sorts, it
   * never filters" into a filter by omission.
   *
   * ⚠ THE SECOND CLAUSE IS A COUNT, NOT A PREDICTION (final review, 2026-08-08). It used to say the
   * full houses "will be in the part not shown", which is false whenever a full house is inside the
   * cap and misleading whenever the cap is filled by open ones. This fixture's nine facilities carry
   * no `bedState` at all, so the honest count here is ZERO — and the sentence says zero rather than
   * predicting. Both non-trivial states are pinned by FF-I2. */
  assert.match(book, /0 of the 1 not shown have no open beds\./);
  assert.ok(!book.includes('sorts to the end'), 'the prediction is gone');
  // The slice is real: eight cards, not nine, not three.
  assert.equal(book.split('data-v3-tile').length - 1, 8, 'exactly QUALIFY_BOOK_PREVIEW cards render');
  assert.ok(book.includes('BOOK FACILITY 8'));
  assert.ok(!book.includes('BOOK FACILITY 9'), 'the ninth is cut — and the sentence above says so');
  // The section's own count still names the WHOLE book, not the slice.
  assert.match(book, />9<\/span> facilities/);
});

test('S2 book — AT the cap there is no truncation notice, because nothing is truncated', () => {
  // The off-by-one that a 9-row fixture alone cannot catch: `> QUALIFY_BOOK_PREVIEW`, not `>=`.
  const book = bookRegion(
    answerHtml(
      bigBookSnapshot({
        bookFacilities: Array.from({ length: 8 }, (_, i) =>
          facility({ rank: i + 1, name: `BOOK FACILITY ${i + 1}`, facilityKey: `BF${i + 1}`, payerCount: 1 }),
        ),
      } as Partial<QualifySnapshot>),
    ),
  );
  assert.equal(book.split('data-v3-tile').length - 1, 8);
  assert.ok(!book.includes('best-ranked of'), 'no notice when the whole book is on screen');
});

test('S2 book — an EMPTY book says so in words rather than rendering a headed void', () => {
  // Reachable: the payer-wide floor drops every facility below QUALIFY_MIN_LINES, so a payer with
  // nothing but thin rows in the window has a real, empty book. A heading and a count of zero with
  // no sentence would read as a section that failed to load.
  // RE-AIMED BY S3 for consistency with its siblings; the empty book ALSO cannot lead (S3 pins that
  // separately), so this render would be the secondary section at any member count.
  const book = bookRegion(answerHtml(secondaryBookSnapshot({ bookFacilities: [] } as Partial<QualifySnapshot>)));
  assert.match(book, /No facility in AETNA US HEALTHCARE&#x27;s book clears the volume floor in the window shown\./);
  assert.equal(book.split('data-v3-tile').length - 1, 0, 'no cards');
  assert.ok(!book.includes('best-ranked of'), 'and no truncation notice over an empty list');
});

test('S2 book — ONE predicate decides whether a book is on screen, and both consumers read it', () => {
  /* Two derivations shipped in S2: the shell asked `snapshot.bookFacilities !== null` to caption the
   * AI panel, while the stage rendered the section on `bookFacilities !== null && bookPayer !== null`.
   * They agree today and disagree the moment either moves — and S3 changes this render condition BY
   * DESIGN. So the predicate is one exported function, and this pins that it answers the harder case
   * (a book with no nameable payer scope) the way the RENDER does, not the way the caption did. */
  assert.equal(bookIsOnScreen(bookSnapshot()), true);
  assert.equal(bookIsOnScreen(null), false, 'no snapshot, no book');
  assert.equal(bookIsOnScreen({ ...bookSnapshot(), bookFacilities: null } as unknown as QualifySnapshot), false);
  // ⚠ ABSENT IS NOT PRESENT-AND-NULL, and `undefined !== null` is TRUE. A pre-S2 payload (or any
  // fixture predating the field) would otherwise answer "yes" and send the section into
  // `bookFacilities!.length` on nothing — which is precisely what happened when this predicate was
  // first extracted with a bare `!== null`, breaking 40 unrelated renders at once.
  assert.equal(bookIsOnScreen(snapshotFixture()), false, 'a payload without the field has no book');
  // An empty book IS on screen — the section renders with its heading and its empty sentence.
  assert.equal(bookIsOnScreen({ ...bookSnapshot(), bookFacilities: [] } as unknown as QualifySnapshot), true);
  // The case the two derivations disagreed on: rows present, but the scope names no single payer, so
  // the section cannot render a heading and does not render at all. `scopedPayerOf` is the judge.
  const unnameable = {
    ...bookSnapshot(),
    resolved: { payerName: null, payerScope: 'all' },
  } as unknown as QualifySnapshot;
  assert.equal(bookIsOnScreen(unnameable), false, 'a book nobody can name is not a book on screen');
  // And the render agrees with the predicate — the whole point of unifying them.
  assert.ok(!answerHtml(unnameable).includes('data-v3-book'));
});


// ── S3 (2026-08-08) — THE INVERSION: the book LEADS, the member's history ANNOTATES ──────────────
//
// Alec's ruling, delegated and decided: **the book ranks, member history annotates.** For the 58.8%
// of searches that resolve to ONE member carrying 1.14 facilities, a "ranking" of their own history
// is not thin — it is MALFORMED, because a ranking is a comparative claim and there is nothing to
// compare. So at one member the payer's whole book becomes the answer's own ranked grid, and the
// member's footprint survives on it as a mark and a weak tiebreak.
//
// EVERY OTHER BUCKET IS UNCHANGED. 2-9, 10+, an unavailable count, a zero count, the identifier-wide
// Skip (no book exists) and an EMPTY book all keep the member-led render with S2's secondary
// section. Each is pinned below, because a flip that fired one bucket wider than its evidence would
// be the same overclaim in the opposite direction.

/** The book-led fixture: one member, a book of three, and the member's own facility annotated on it.
 *  `NASH` is deliberately rank 2 in the book — so an assertion about the annotation cannot be
 *  satisfied by the first card, and the flip cannot be faked by rendering the member list. */
function ledSnapshot(over: Partial<QualifySnapshot> = {}): QualifySnapshot {
  return bookSnapshot({
    bookFacilities: [
      facility({ rank: 1, name: 'SUMMIT RIDGE RECOVERY', facilityKey: 'SUMMIT', payerCount: 1 }),
      facility({
        rank: 2,
        name: 'NASHVILLE MENTAL HEALTH',
        facilityKey: 'NASH',
        payerCount: 1,
        memberHistory: { lineCount: 210, distinctPatients: 1 },
      }),
      facility({ rank: 3, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', city: 'Phoenix', state: 'AZ', payerCount: 1 }),
    ],
    ...over,
  } as Partial<QualifySnapshot>);
}

test('S3 — bookLeadsAnswer: ONE member, a NON-EMPTY book, and a payer the heading can name', () => {
  assert.equal(bookLeadsAnswer(ledSnapshot()), true);
  // The buckets that keep the member-led answer. 2-9 and 10+ have a real ranking of their own; an
  // unavailable count must never be guessed into one; and zero has no member to annotate with.
  for (const memberCount of [0, 2, 4, 9, 10, 31, null]) {
    assert.equal(
      bookLeadsAnswer(ledSnapshot({ memberCount } as Partial<QualifySnapshot>)),
      false,
      `memberCount=${String(memberCount)} does not flip`,
    );
  }
  // ⚠ AN EMPTY BOOK CANNOT LEAD. `bookIsOnScreen` is TRUE for an empty book (the section renders its
  // own "nothing cleared the floor" sentence, which is a state and not an absence) — but leading
  // with an empty list would put a void where the answer goes and HIDE the member's own facilities
  // behind it. Where the book has nothing, the member's footprint, however thin, is the only
  // evidence on the surface and it keeps the grid.
  assert.equal(bookLeadsAnswer(ledSnapshot({ bookFacilities: [] } as Partial<QualifySnapshot>)), false);
  // No book at all (the identifier-wide Skip), no snapshot, and a book nobody can name.
  assert.equal(bookLeadsAnswer(ledSnapshot({ bookFacilities: null } as Partial<QualifySnapshot>)), false);
  assert.equal(bookLeadsAnswer(null), false);
  assert.equal(
    bookLeadsAnswer({ ...ledSnapshot(), resolved: { payerName: null, payerScope: 'all' } } as unknown as QualifySnapshot),
    false,
  );
  // And it is BUILT ON `bookIsOnScreen`, not a second copy of it: the absent-field coercion that
  // broke 40 renders when the predicate was first extracted must not come back through this door.
  assert.equal(bookLeadsAnswer(snapshotFixture()), false, 'a payload without the field has no book to lead');
});

test('S3 flip — the BOOK is the answer’s own ranked grid, and the member list is no longer a second one', () => {
  const html = answerHtml(ledSnapshot());
  const grid = outerHtmlFrom(html, html.lastIndexOf('<section', html.indexOf('qualify-scorecard-heading')));
  // The heading NAMES whose book this is — it does not inherit "Facilities, ranked", which after the
  // flip would describe the payer's book in words minted for the member's footprint.
  assert.match(grid, /Where AETNA US HEALTHCARE pays — the whole book/);
  assert.ok(!grid.includes('>Facilities, ranked<'), 'the member-led heading is gone in this mode');
  // All three book cards are the answer.
  for (const name of ['SUMMIT RIDGE RECOVERY', 'NASHVILLE MENTAL HEALTH', 'PHOENIX RENEWAL']) {
    assert.ok(grid.includes(name), `${name} is in the ranked grid`);
  }
  assert.equal(grid.split('data-v3-tile').length - 1, 3, 'three cards, not six — the member list is not a second grid');
  // And there is exactly ONE book section on the page: the secondary one must not render beneath the
  // grid that already IS the book.
  assert.equal(html.split('data-v3-book').length - 1, 1);
  assert.ok(!html.includes('across the whole book'), 'S2’s secondary heading is absent in this mode');
  // The basis is stated on the list itself, in its own words, and it says what the annotation means.
  // The floor clause is not decoration — see FF-I4: without it this sentence contradicts the "below
  // the volume floor" line the same screen renders a few rows down.
  assert.match(grid, /every facility AETNA US HEALTHCARE paid at above the volume floor in the window shown/);
  assert.match(grid, /not just this member/i);
});

test('S3 flip — the HERO is derived from the list that LEADS, and its basis SAYS which list that is', () => {
  // `derivePolicyRating` ran over `snap.facilities` at HEAD. In book-led mode the honest basis for
  // "should I take this policy" is the BOOK — the list on screen — and a bar averaging a hidden list
  // is the reconciled-by-construction invariant broken in the one place it exists to hold.
  const html = answerHtml(
    ledSnapshot({
      // The member's own facility rates 62; the book rates 30 across two rated rows. If the hero
      // still read `facilities` it would print 62 over a grid of 30s.
      facilities: [facility({ ratingV2: 62, iqBand: '50', distinctPatients: 14 })],
      bookFacilities: [
        facility({ rank: 1, name: 'SUMMIT RIDGE RECOVERY', facilityKey: 'SUMMIT', ratingV2: 30, iqBand: '30', distinctPatients: 10 }),
        facility({ rank: 2, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', ratingV2: 30, iqBand: '30', distinctPatients: 10 }),
      ],
    } as Partial<QualifySnapshot>),
  );
  assert.match(html, /aria-label="policy rating 30 out of 100"/);
  assert.ok(!html.includes('policy rating 62 out of 100'), 'the member-scoped hero is not what leads');
  // THE CAPTION NAMES THE POPULATION. "patient-weighted across 2 rated facilities" is true of both
  // lists and therefore identifies neither.
  assert.match(html, /patient-weighted across 2 rated facilities in AETNA US HEALTHCARE&#x27;s whole book/);
});

test('S3 annotation — the facility the member has been to is MARKED; the others are not', () => {
  const html = answerHtml(ledSnapshot());
  assert.match(html, /Seen here before — 210 claim lines/);
  // ONE mark, not three. A mark on every card would say nothing; a mark on the wrong card is worse.
  assert.equal(html.split('Seen here before').length - 1, 1);
  // The 2-9 bucket annotates too — the join is a fact about the data, not about the flip — but it
  // must not say "seen here before" about a set of four different people.
  const few = answerHtml(ledSnapshot({ memberCount: 4 } as Partial<QualifySnapshot>));
  assert.ok(!few.includes('Seen here before'), 'four members are not "here before"');
  assert.match(few, /This search has 210 claim lines here/);
});

test('S3 — a member facility the BOOK’S FLOOR dropped is NAMED, never silently lost', () => {
  /* THE HOLE THE FLIP OPENS, CLOSED. The member ranking is floorless and the book applies
   * QUALIFY_MIN_LINES, so a facility the member billed 1-2 lines at exists in `facilities` and NOT in
   * `bookFacilities` — and since the member grid stops rendering, its annotation has nothing to ride
   * on. "Its information survives as annotations" is only true if that case is stated. */
  const html = answerHtml(
    ledSnapshot({
      facilities: [
        facility({ rank: 1, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH' }),
        facility({ rank: 2, name: 'TINY CLINIC', facilityKey: 'TINY', lineCount: 2, distinctPatients: 1 }),
      ],
    } as Partial<QualifySnapshot>),
  );
  assert.match(html, /TINY CLINIC/, 'the facility is named on screen');
  assert.match(html, /below the volume floor/i, 'and the reason is stated, not implied');
  // The one that IS in the book is not double-reported — it is marked on its card instead.
  const sentence = html.slice(html.indexOf('TINY CLINIC') - 400, html.indexOf('TINY CLINIC') + 400);
  assert.ok(!sentence.includes('NASHVILLE MENTAL HEALTH'), 'only the missing ones are named here');
  // With nothing missing the sentence does not render at all.
  assert.ok(!answerHtml(ledSnapshot()).includes('below the volume floor'));
});

test('S3 — a book-LED answer is NOT capped: a cap on the list that IS the answer is a silent filter', () => {
  // S2 capped the SECONDARY section at QUALIFY_BOOK_PREVIEW = 8 with the cap stated, because a
  // secondary section that pushes the answer off screen has stopped being secondary. When the book
  // LEADS that argument inverts: availability leads the sort, so a cap systematically removes the
  // full houses — turning "census sorts, it never filters" into a filter by omission on the primary
  // grid. The whole book is <=48 facilities, which is a real DOM cost and the accepted one; the AREA
  // facet beside the grid is the narrow.
  const nine = ledSnapshot({
    bookFacilities: Array.from({ length: 9 }, (_, i) =>
      facility({ rank: i + 1, name: `BOOK FACILITY ${i + 1}`, facilityKey: `BF${i + 1}`, payerCount: 1 }),
    ),
  } as Partial<QualifySnapshot>);
  const html = answerHtml(nine);
  assert.equal(html.split('data-v3-tile').length - 1, 9, 'all nine render');
  assert.ok(html.includes('BOOK FACILITY 9'));
  assert.ok(!html.includes('best-ranked of'), 'and no truncation notice, because nothing is truncated');
});

test('S3 — the modes that do NOT flip keep the member-led render, each for its own reason', () => {
  // 2-9 and 10+: a real population with a real ranking of its own. The book stays SECONDARY.
  for (const memberCount of [4, 31]) {
    const html = answerHtml(ledSnapshot({ memberCount } as Partial<QualifySnapshot>));
    assert.match(html, />Facilities, ranked</, `memberCount=${memberCount} keeps the member heading`);
    assert.match(html, /across the whole book/, 'and the book is the secondary section');
    assert.equal(html.split('data-v3-book').length - 1, 1, 'exactly one book section, below');
  }
  // An unavailable count must never be GUESSED into a flip: `null` is "we could not classify".
  const unknown = answerHtml(ledSnapshot({ memberCount: null } as Partial<QualifySnapshot>));
  assert.match(unknown, />Facilities, ranked</);
  // Zero: the count ran and nobody is behind the token, so there is no history to annotate with.
  assert.match(answerHtml(ledSnapshot({ memberCount: 0 } as Partial<QualifySnapshot>)), />Facilities, ranked</);
  // The identifier-wide Skip has no book at all — the hard boundary S2 pinned, unchanged.
  const skip = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: allPayersSnapshot({ memberCount: 1, bookFacilities: null } as Partial<QualifySnapshot>),
        skipped: true,
        scopeSource: 'dominant',
      }),
    }),
  );
  assert.match(skip, />Facilities, ranked</, 'one member and no book still ranks the member’s footprint');
  assert.ok(!skip.includes('data-v3-book'));
});

test('S3 — every claim surface follows the flip: the scope sentence, the skip banner, the empty state', () => {
  const led = answerHtml(ledSnapshot(), { narrowExpanded: true });
  // The resolved-scope sentence still names the label (the book IS payer-scoped) and now names the
  // POPULATION too, because "ranked under AETNA" is true of both lists and identifies neither.
  assert.match(led, /ranked under AETNA US HEALTHCARE — the whole book, not this member&#x27;s history/);
  // The skip banner's payer-scoped arm claimed "every facility this member has history at under that
  // one label" — flatly false of a book-led grid.
  const skipped = answerHtml(ledSnapshot(), { skipped: true, scopeSource: 'dominant' });
  assert.ok(
    !skipped.includes('every facility this member has history at under that one label'),
    'the member-footprint promise cannot survive a book-led grid',
  );
  assert.match(skipped, /the ranking is AETNA US HEALTHCARE&#x27;s whole book/);
  // An empty grid in book-led mode is the BOOK's emptiness, and says so in the book's own words.
  const emptyBook = answerHtml(
    ledSnapshot({ bookFacilities: [], facilities: [] } as Partial<QualifySnapshot>),
  );
  assert.ok(!emptyBook.includes('Where AETNA US HEALTHCARE pays — the whole book'), 'an empty book cannot lead');
});

test('S3 — the AI captions say what backs the answer now that the book is ABOVE, not below', () => {
  // The payload is still `snap.facilities.slice(0,10)` — the MEMBER-scoped list, unchanged schema.
  // That makes S2's caption ("not the whole-book list below") false by position and the pre-S2 one
  // ("the ranking on screen") false by identity: the ranking on screen is the one the model has
  // never seen. Same standard, third time: say what backs the answer.
  const led = disclosureOf(
    render(
      props('answer', fixture(), {
        answer: answerProps({ snapshot: ledSnapshot(), skipped: true, scopeSource: 'dominant' }),
      }),
    ),
  );
  assert.ok(!led.includes('grounded in the ranking on screen'));
  assert.ok(!led.includes('not the whole-book list below'), 'the book is not below any more');
  assert.match(led, /grounded in this member&#x27;s own history, not the book ranked above/);
});

test('S3 M8 — the trace panel names BOTH rankings and which one leads', () => {
  // "Facility ranking" (singular) and, on a Skip, "this identifier's whole footprint": true of the
  // member list, false of the book, and after the flip false of the screen.
  const led = disclosureOf(answerHtml(ledSnapshot()));
  assert.match(led, />Facility rankings</, 'plural — there are two');
  assert.match(led, /AETNA US HEALTHCARE&#x27;s whole book leads/);
  assert.match(led, /this member&#x27;s own history/, 'and the second one is named, not dropped');
  // The KPI tiles' provenance line is the ratified "book-wide, not this client" — a distinction that
  // stops distinguishing anything once the ranking above it is also book-wide. It says so.
  assert.match(led, /book-wide, not this client/, 'the ratified wording is untouched');
  assert.match(led, /so is the ranking above/);
  // Unchanged in every non-flip mode: singular, and the pre-S3 strings byte for byte.
  const few = disclosureOf(answerHtml(ledSnapshot({ memberCount: 4 } as Partial<QualifySnapshot>)));
  assert.match(few, />Facility ranking</);
  assert.ok(!few.includes('Facility rankings'));
  assert.ok(!few.includes('so is the ranking above'));
});

test('S3 — the ARIA channel carries the basis too, or the spoken answer describes a list nobody drew', () => {
  const r = fixture();
  const spoken = liveSentenceFor('answer', r, null, {
    memberCount: 1,
    memberFacilityCount: 1,
    bookLedPayer: 'AETNA US HEALTHCARE',
  });
  assert.match(spoken, /One member has a paid claim behind this search/, 'the preface is unchanged');
  assert.match(spoken, /the ranking below is AETNA US HEALTHCARE's whole book, not this member's own history/i);
  // THE ANNOTATION IS ANNOUNCED TOO. Naming the basis without naming the mark would tell a
  // screen-reader user the member's history had been REPLACED, when it has been moved onto the rows.
  assert.match(spoken, /the facilities they have been to are marked on it/i);
  /* ⚠ THIS PAIR PINS THE NULL/OMITTED EQUIVALENCE, NOT BYTE-IDENTITY WITH S2 — the comment here
   * used to claim the latter and pointed at an assertion that cannot show it. Byte-identity is
   * already frozen by the S2 exact-string tests above (`liveSentenceFor(..., {})` vs the pre-S2
   * sentence). What this adds is that an EXPLICIT `bookLedPayer: null` and an omitted one are the
   * same announcement, so a caller that computes the payer and gets null cannot drift from one that
   * never computed it. */
  assert.equal(
    liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1 }),
    liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1, bookLedPayer: null }),
  );
  assert.ok(
    !liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1 }).includes('whole book'),
    'and neither of them says anything about a book',
  );
  // And the skipped arm carries it as well — a Skip plus one billed-under chip IS a book-led screen,
  // and the sr-only line is where an unfixed scope claim survives a browser pass.
  const skipSpoken = liveSentenceFor('answer', r, null, {
    skipped: true,
    memberCount: 1,
    memberFacilityCount: 1,
    bookLedPayer: 'AETNA US HEALTHCARE',
  });
  assert.match(skipSpoken, /You skipped the plan questions/);
  assert.match(skipSpoken, /whole book/);
});


// ── S3 FIX ROUND 1 (2026-08-08) — the 13th claim surface, and the marker that would have found it ─

test('S3 C1 — the SCOPE-HONESTY banner follows the flip, in BOTH arms', () => {
  /* THE ONE THE INDEX HID. This banner renders in the coral ALARM treatment with `role="status"`,
   * directly above the grid, and its gate (`!stale && !skipped && scopeSource === 'dominant' &&
   * resolved && candidates.total > 1`) never excluded `bookLeads`. So on the 58.8% path it claimed
   * "the ranking below is this identifier's history under {payer}" over a grid showing that payer's
   * WHOLE BOOK — the S2-I1 / PR #92 mixed-claim class, in the loudest voice on the surface.
   *
   * It is NOT suppressed: its subject (the pick could not be bridged to a claims label) is still
   * true and still worth alarming about. Only the half that describes the LIST re-bases. */
  const probe = (over: Partial<QualifyResolution> = {}) =>
    render(
      props('answer', fixture(over), {
        answer: answerProps({ snapshot: ledSnapshot(), skipped: false, scopeSource: 'dominant' }),
      }),
    );

  // ARM 1 — the picked plan has no claims of its own (`claimEvidence.lines === 0`).
  const noHistory = probe({
    group: { ...fixture().group, claimEvidence: { ...fixture().group.claimEvidence, lines: 0 } },
  } as Partial<QualifyResolution>);
  assert.match(noHistory, /Where AETNA US HEALTHCARE pays — the whole book/, 'the probe really is book-led');
  assert.ok(
    !noHistory.includes("the ranking below is this identifier&#x27;s history under"),
    'the member-footprint claim cannot survive a book-led grid',
  );
  assert.match(noHistory, /This plan has no claims history of its own/, 'the alarm still fires — only its list-half moved');
  assert.match(noHistory, /the ranking below is AETNA US HEALTHCARE&#x27;s whole book, not evidence about Aetna/);

  // ARM 2 — the pick could not be scoped, and the ranking is the dominant label's book.
  const notScoped = probe();
  assert.ok(!notScoped.includes('it shows this identifier&#x27;s history under'), 'same lie, second arm');
  assert.match(notScoped, /The ranking below could not be scoped to Aetna/, 'the alarm still fires');
  assert.match(
    notScoped,
    /it shows AETNA US HEALTHCARE&#x27;s whole book, this identifier&#x27;s largest label by volume, not evidence about Aetna/,
  );

  // ⚠ AND THE PRE-S3 STRINGS ARE UNTOUCHED IN EVERY MODE THAT DOES NOT FLIP. Both arms are frozen
  // by tests above this block; this asserts the re-base is gated, not global.
  const few = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: ledSnapshot({ memberCount: 4 } as Partial<QualifySnapshot>),
        skipped: false,
        scopeSource: 'dominant',
      }),
    }),
  );
  assert.match(few, /it shows this identifier&#x27;s history under AETNA US HEALTHCARE, its largest payer by volume\./);
});

/**
 * THE SWEEP ITSELF — extracted so it can be run against a FIXTURE of known evaders as well as against
 * the real file, which is the only way a scan can be trusted at all.
 *
 * ⚠ IT USED TO BE `/<[a-zA-Z]+ role="status"/` — THE ATTRIBUTE ONLY IN FIRST POSITION (final review,
 * 2026-08-08). `<p data-x role="status">` escaped it entirely, and so did every multi-line tag whose
 * `role` sits on its own line. A guard whose STATED PURPOSE is "the next claim surface cannot hide"
 * had a one-token hiding place in it — the same shape as the hand-maintained index it replaced.
 *
 * Two exclusions keep prose out, and they are separate rules because the prose in this file takes two
 * forms: BACKTICKED mentions inside block comments (stripped), and bare mentions on comment lines
 * (`*`, `//`, `/*`). Either alone lets the other class through.
 */
function statusAttrLines(lines: readonly string[]): number[] {
  const isProse = (l: string) => /^\s*(\*|\/\/|\/\*)/.test(l);
  const deBacktick = (l: string) => l.replace(/`[^`]*`/g, '');
  return lines
    .map((l, i) => (!isProse(l) && /\brole="status"/.test(deBacktick(l)) ? i : -1))
    .filter((i) => i >= 0);
}

/** NEGATIVE CONTROLS FOR THE SWEEP. Lines 0/1/4 must be found; 5/6/7 must not. Line 1 is the exact
 *  attribute-ordered evader the old regex missed, so this fixture fails against the old scan. */
const MARKER_SWEEP_FIXTURE = [
  /* 0 */ '      <p role="status" className="x">first attribute — the only form the old scan caught</p>',
  /* 1 */ '      <p data-v3-book role="status">attribute-ordered evader — invisible to the old scan</p>',
  /* 2 */ '      <p',
  /* 3 */ '        data-x',
  /* 4 */ '        role="status"',
  /* 5 */ '      >a multi-line tag, whose attribute line is the one that counts</p>',
  /* 6 */ '   * a block comment mentioning `role="status"` as backticked prose',
  /* 7 */ '  // role="status" named in a line comment, unbackticked',
].join('\n');

test('S3 C1 — EVERY role="status" in the flow carries a book-led marker, so the next one cannot hide', () => {
  /* ⚠ THIS TEST EXISTS BECAUSE A HAND-MAINTAINED INDEX HID A DEFECT. The flip's comment block used
   * to ENUMERATE the surfaces that follow it and the ones that do not — and both the author and the
   * reviewer checked the list instead of the file, so the scope-honesty banner (never on the list)
   * shipped claiming the member's ranking over the book's grid.
   *
   * The index is now a GREP INSTRUCTION rather than a list: every claim surface carries
   * `[BOOK-LED SURFACE]` or `[BOOK-LED EXEMPT: reason]` in its own comment, at the site, where it
   * cannot rot separately from the code it describes.
   *
   * ⚠ WHAT THIS TEST CAN AND CANNOT ENFORCE, said plainly. `role="status"` is a MECHANICAL proxy for
   * "claim surface", not a definition of one: it is the loudest class (C1 was one) and the only one a
   * regex can find. Several real claim surfaces are NOT status roles — `resolvedScopeSentence`, the
   * `billedUnderCaption` table, the trace panel's rows, the hero's basis. Those carry markers too, so
   * `grep -n 'BOOK-LED' app/components/qualify/v3/resolution-flow.tsx` still enumerates the whole
   * set; what the test enforces is that the LOUD class cannot grow a new member silently. */
  const src = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow.tsx', import.meta.url)),
    'utf8',
  );
  const lines = src.split('\n');
  assert.deepEqual(
    statusAttrLines(MARKER_SWEEP_FIXTURE.split('\n')),
    [0, 1, 4],
    'the sweep itself is checked against the evaders BEFORE it is trusted against the file',
  );
  const statusLines = statusAttrLines(lines);
  assert.ok(statusLines.length >= 12, `expected the known status surfaces, found ${statusLines.length}`);

  const MARKER = /\[BOOK-LED (SURFACE\]|EXEMPT: [^\]]+\])/;
  const unmarked = statusLines.filter((i) => !lines.slice(Math.max(0, i - 30), i + 1).some((l) => MARKER.test(l)));
  assert.deepEqual(
    unmarked.map((i) => `${i + 1}: ${lines[i]!.trim().slice(0, 80)}`),
    [],
    'a role="status" claim surface with no [BOOK-LED …] marker within 30 lines above it',
  );

  // Every marker is one of the TWO valid forms — a typo'd token is invisible to grep, which is the
  // whole mechanism. And there is at least one per status surface, so a marker cannot be shared.
  const markers = lines.filter((l) => l.includes('[BOOK-LED'));
  for (const m of markers) assert.match(m, MARKER, `malformed marker: ${m.trim()}`);
  assert.ok(markers.length >= statusLines.length, 'markers cannot be reused across surfaces');
  // The index no longer enumerates — it points at the token. An enumerated list is what rotted.
  assert.match(src, /grep for `BOOK-LED`/, 'the index must instruct, not enumerate');
});

test('S3 M1 — the sr-only book clause is STAGE-GATED: no "ranking below" where there is no ranking', () => {
  // A held skipped answer plus a step back to the search box: the skipped arm returns BEFORE the
  // stage checks, so the clause was announced over the identify screen — "the ranking below is
  // AETNA's whole book" with no ranking below it at all. The `say()` comment asserted a guarantee
  // ("called from exactly the two ANSWER-shaped arms") that the code did not hold.
  const r = fixture();
  const opts = { skipped: true, memberCount: 1, memberFacilityCount: 1, bookLedPayer: 'AETNA US HEALTHCARE' } as const;
  assert.match(liveSentenceFor('answer', r, null, opts), /whole book/, 'the answer stage still says it');
  for (const stage of ['identify', 'payer', 'plan'] as const) {
    assert.ok(
      !liveSentenceFor(stage, r, null, opts).includes('whole book'),
      `stage=${stage} announces a ranking that is not on screen`,
    );
  }
});


// ── S4 — THE FACILITY NARROW, BESIDE THE GRID (2026-08-08) ───────────────────────────────────────
//
// WHAT THESE PIN. The v2 tab's Facility type-ahead was a casualty of the v3 cutover, and it comes
// back as a DISPLAY narrow over rows the ranking already returned — not as a fetch narrow. The
// measured reason is the whole feature: 86.9% of members bill at exactly ONE facility in 365 days,
// so a facility narrow on a member search empties the screen ~87% of the time, and only a display
// narrow still holds the un-narrowed list needed to say WHERE they did bill. A fetch narrow could
// say "no history at NASHVILLE" and nothing more.
//
// Placement is BESIDE the grid with AREA, never on the NARROW SEARCH card: everything on that card
// re-issues the ranking request, and this does not.

/** The picker vocabulary, at the grain the real loader returns: `value`/`variants` are RAW rollup
 *  facility text (== QualifyFacility.facilityKey) and `display` is the label. The placeholder is
 *  included ON PURPOSE — the offerable-set assertion below is what removes it. */
const FACILITY_OPTIONS: QualifyFacilityNarrowOption[] = [
  { value: 'NASH', display: 'NASHVILLE MENTAL HEALTH', variants: ['NASH'], careSetting: 'IP' },
  { value: 'PHX', display: 'PHOENIX RENEWAL', variants: ['PHX'], careSetting: 'OP' },
  { value: 'KWC', display: 'KENTUCKY WELLNESS CENTER', variants: ['KWC'], careSetting: null },
  { value: 'SUMMIT', display: 'SUMMIT RIDGE RECOVERY', variants: ['SUMMIT'], careSetting: null },
  { value: 'UNL', display: 'UNLISTED BH', variants: ['UNL'], careSetting: null },
  { value: QUALIFY_NO_FACILITY, display: 'No Facility', variants: [QUALIFY_NO_FACILITY], careSetting: null },
];

const withFacility = (
  snap: QualifySnapshot,
  over: Partial<NonNullable<ResolutionStagesProps['answer']>> = {},
) => answerHtml(snap, { facilityOptions: FACILITY_OPTIONS, ...over });

/** ⚠ BOUND ROW ASSERTIONS TO THE GRID, because the PICKER ECHOES ITS OWN SELECTION. A selected
 *  facility renders as a tag carrying that facility's display name, so an unbounded
 *  `!html.includes('PHOENIX RENEWAL')` is satisfied-or-defeated by the control rather than by the
 *  list it narrows — the `inventoryRegion` lesson, one region over. */
const gridRegion = (html: string): string =>
  outerHtmlFrom(html, html.lastIndexOf('<section', html.indexOf('qualify-scorecard-heading')));

test('S4 — the facility type-ahead renders BESIDE the grid, and NEVER inside the verdict card', () => {
  const html = withFacility(threeStateSnapshot(), { candidates: orderedCandidates(fixture()) });
  // POSITIVE CONTROL: the grid rendered, so the negative below is about a real screen.
  assert.match(html, /NASHVILLE MENTAL HEALTH/, 'the scorecard rendered — otherwise this test is vacuous');
  assert.match(html, /aria-label="Facility"/, 'the shared type-ahead is on screen');
  // ⚠ THE PLACEMENT RULING, MECHANISED. Everything on the control card re-issues the ranking request
  // and this does not, so a facility field inside the card would break the card's own honesty rule —
  // the same rule that kept AREA out of it.
  assert.ok(
    !inventoryRegion(html).includes('aria-label="Facility"'),
    'the facility control must not live on the card that claims every switch re-issues the request',
  );
  // It is a beat of the skip reveal and states ON/OFF in the same vocabulary as every other facet.
  const row = outerHtmlFrom(html, html.lastIndexOf('<div data-v3-facet', html.indexOf('aria-label="Facility"')));
  assert.match(row, /Off · all 5/, 'five offerable facilities, and it says so while off');
  assert.match(row.slice(0, 60), /data-v3-facet/, 'it carries the reveal hook so the stagger includes it');
  // AND THE CARD'S OWN STRIP IS UNMOVED. Facility is not a card facet, so `cardFacets` must not grow
  // — the hardcoded `off === 3` assertion above stays about the CARD's facets and is untouched by S4.
  // (The tally SENTENCE it used to read went 2026-08-12; the facet count it was standing in for is
  // asserted directly.)
  const strip = inventoryRegion(html);
  assert.equal((strip.match(/tracking-wide text-ink400">(Window|Funding|Employers|Billed under)</g) ?? []).length, 4,
    'four card facets on the strip, and facility is not one');
});

test('S4 — “No Facility” is never OFFERABLE: you cannot send someone to a placeholder', () => {
  // The row keeps its rank everywhere (dropping it would hide $29,081,575.38 of charges) — it is only
  // un-offerable, because picking it asks whether a patient can be admitted to a bucket.
  const html = withFacility(threeStateSnapshot());
  assert.match(html, /aria-label="Facility"/, 'positive control: the picker rendered at all');
  assert.match(html, /Off · all 5/, 'six options in, five offered — the placeholder is the one removed');
  assert.ok(!html.includes('Off · all 6'), 'the placeholder was not counted into the denominator');
});

test('S4 — the narrow hides what it excludes, states its reach, and composes with AREA as AND', () => {
  const one = gridRegion(withFacility(threeStateSnapshot(), { facilityNarrow: ['NASH'] }));
  assert.equal(one.split('data-v3-tile').length - 1, 1, 'one card, not three — the picker echoes the name too');
  assert.match(one, /NASHVILLE MENTAL HEALTH/, 'the picked facility stays');
  assert.ok(!one.includes('PHOENIX RENEWAL'), 'the others are hidden');
  assert.ok(!one.includes('UNLISTED BH'));
  assert.match(one, /at NASHVILLE MENTAL HEALTH\. The ranking itself was not re-run/, 'it names its own reach');
  assert.match(one, /the rating above still covers all 3/, 'and refuses to claim the hero moved with it');
  assert.match(one, /On · 1 of 5/, 'the facet badge counts the picks');

  // MULTI-SELECT: the picker is multi by nature and the narrow is a union within the facet.
  const two = gridRegion(withFacility(threeStateSnapshot(), { facilityNarrow: ['NASH', 'PHX'] }));
  assert.equal(two.split('data-v3-tile').length - 1, 2, 'two cards');
  assert.match(two, /NASHVILLE MENTAL HEALTH/);
  assert.match(two, /PHOENIX RENEWAL/);
  assert.ok(!two.includes('UNLISTED BH'));
  assert.match(two, /at the 2 facilities you picked/, 'more than one pick is counted, not enumerated');

  // AND ACROSS THE TWO GRID NARROWS. NASH is in TN; asking for PHX inside TN is empty by
  // construction, and BOTH reaches are named so the operator can see which one to undo.
  const both = gridRegion(withFacility(threeStateSnapshot(), { facilityNarrow: ['NASH'], area: 'TN' }));
  assert.match(both, /in this area, at NASHVILLE MENTAL HEALTH/, 'both narrows named, in one sentence');
  const conflict = gridRegion(withFacility(threeStateSnapshot(), { facilityNarrow: ['PHX'], area: 'TN' }));
  assert.match(conflict, />Facilities, ranked</, 'positive control: the grid region really was found');
  assert.ok(!conflict.includes('data-v3-tile'), 'AND, not OR — an AZ facility does not survive a TN area');
  // ...AND THE BLAME IS COMPUTED RATHER THAN GUESSED. The facility narrow on its own still has a row
  // (PHX), so the AREA is what emptied the grid and the area sentence is the honest diagnosis. Blame
  // the facility narrow here and the operator clears the wrong control.
  assert.match(conflict, /No ranked facility is in this area\./);
  assert.ok(!conflict.includes('No history at'), 'the facility narrow did not empty this one');
});

test('S4 — a GRID narrow may not move the headline number, exactly as the area may not', () => {
  // ⚠ THE RATINGS MUST DIFFER OR THIS TEST CANNOT FAIL. `threeStateSnapshot()` gives every row the
  // fixture's uniform ratingV2 of 62, so a hero re-derived from the NARROWED list prints the same
  // number and the guard reads as coverage while proving nothing — measured, not assumed: mutating
  // `answerFacilities` to apply the narrow left this green against the uniform fixture. Spread them
  // and the patient-weighted mean genuinely moves with the set it is taken over.
  const spread = {
    ...threeStateSnapshot(),
    facilities: [
      facility({ rank: 1, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH', state: 'TN', ratingV2: 90, distinctPatients: 40 }),
      facility({ rank: 2, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', city: 'Phoenix', state: 'AZ', ratingV2: 20, distinctPatients: 40 }),
      facility({ rank: 3, name: 'UNLISTED BH', facilityKey: 'UNL', city: null, state: null, ratingV2: 20, distinctPatients: 40 }),
    ],
  } as unknown as QualifySnapshot;
  const heroOf = (h: string) => /aria-label="policy rating (\d+) out of 100"/.exec(h)?.[1] ?? null;
  const wide = withFacility(spread);
  const narrowed = withFacility(spread, { facilityNarrow: ['NASH'] });
  assert.ok(heroOf(wide) !== null, 'the unfiltered hero rendered a number');
  assert.notEqual(heroOf(wide), '90', 'the whole-set hero is not the NASH-only one — the fixture can tell them apart');
  assert.equal(heroOf(narrowed), heroOf(wide), 'the rating covers the whole ranking, narrow or not');
  // And the sentence beside it says so, rather than leaving the reader to infer the hero's reach.
  assert.match(gridRegion(narrowed), /the rating above still covers all 3/);
});

test('S4 empty, MEMBER-LED — “No history at X — this member billed at A and B.”', () => {
  // ⚠ THIS SENTENCE IS THE FEATURE. It is the one a fetch narrow could not say, because the
  // un-narrowed list would not be in hand — and at 86.9% single-facility members it is the COMMON
  // render, not an edge case.
  const html = gridRegion(withFacility(threeStateSnapshot(), { facilityNarrow: ['KWC'] }));
  // ⚠ "IN THE WINDOW SHOWN" WAS ADDED IN FIX ROUND 1 (basis discipline): this arm and the floor arm
  // shipped with no window clause while the other two had one, which is a mixed-basis screen by
  // omission. The ruling's own clause — "no history at X — this member billed at A and B" — is intact.
  assert.match(
    html,
    /No history at KENTUCKY WELLNESS CENTER in the window shown — this member billed at NASHVILLE MENTAL HEALTH, PHOENIX RENEWAL and UNLISTED BH\./,
  );
  assert.match(html, /Clear the facility above to see all 3 facilities\./, 'a narrow with no way back is a trap');
  // The OTHER two emptinesses must not co-render: this is neither "nothing ranked at all" nor "no
  // ranked facility is in this area", and two role="status" sentences for one click is the overlap
  // review Finding 2 removed for the area.
  assert.ok(!html.includes('No facility has claims history under this scope'));
  assert.ok(!html.includes('No ranked facility is in this area'));
  assert.ok(!html.includes('facilities shown'), 'and the "Showing 0 of N" framing is suppressed');
});

test('S4 empty, BOOK-LED — it names where the BOOK does have rows, and the member’s own facilities', () => {
  const html = withFacility(ledSnapshot(), { facilityNarrow: ['KWC'] });
  assert.match(html, /Where AETNA US HEALTHCARE pays — the whole book/, 'positive control: the book leads');
  assert.match(html, /AETNA US HEALTHCARE&#x27;s book has no rows at KENTUCKY WELLNESS CENTER in the window shown\./);
  // The recovery clause is now the SHARED one (fix round 1, I1) — it names the count that clearing
  // THIS control actually yields, which with no area narrow on is the whole leading list.
  assert.match(html, /Clear the facility above to see all 3 facilities\./);
  assert.match(html, /This member billed at NASHVILLE MENTAL HEALTH\./, 'the member’s own history is still named');
});

test('S4 empty, BOOK-LED — a facility the member HAS billed at is never called “no history”', () => {
  // THE LIE THIS ARM EXISTS TO PREVENT. The member ranking is floorless and the book applies
  // QUALIFY_MIN_LINES, so a facility the member billed 1-2 lines at is in `facilities` and NOT in
  // `bookFacilities`. Narrowing to it empties the book-led grid — and "no history there" would be
  // flatly false about the one fact on the screen that decides an admission.
  const thinBook = ledSnapshot({
    bookFacilities: [
      facility({ rank: 1, name: 'SUMMIT RIDGE RECOVERY', facilityKey: 'SUMMIT', payerCount: 1 }),
      facility({ rank: 2, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', city: 'Phoenix', state: 'AZ', payerCount: 1 }),
    ],
  } as Partial<QualifySnapshot>);
  const html = withFacility(thinBook, { facilityNarrow: ['NASH'] });
  assert.match(html, /This member HAS billed at NASHVILLE MENTAL HEALTH/, 'the fact that decides the admission');
  assert.match(html, /below it/, 'and the volume floor is named as the only possible cause');
  assert.ok(!html.includes('has no rows at NASHVILLE MENTAL HEALTH'), 'the other arm’s claim would be false here');
  assert.ok(!html.includes('No history at NASHVILLE MENTAL HEALTH'), 'and so would the member-led one');
});

test('S4 — gridNarrowEmptyCopy: every arm is a DIFFERENT claim, and none borrows another’s', () => {
  const base = {
    picked: ['NASH'],
    pickedWithHistory: [] as string[],
    bookPayer: 'AETNA',
    rankedTotal: 3,
    areaActive: false,
    facilityActive: true,
    afterClearingFacility: 3,
    afterClearingArea: 3,
    blame: 'facility' as const,
  };
  const memberLed = gridNarrowEmptyCopy({ ...base, bookLeads: false, elsewhere: ['A', 'B'] });
  const memberLedBare = gridNarrowEmptyCopy({ ...base, bookLeads: false, elsewhere: [] });
  const bookLed = gridNarrowEmptyCopy({ ...base, bookLeads: true, elsewhere: ['A'] });
  const bookLedFloor = gridNarrowEmptyCopy({ ...base, bookLeads: true, pickedWithHistory: ['NASH'], elsewhere: [] });
  const areaBlamed = gridNarrowEmptyCopy({
    ...base,
    blame: 'area',
    areaActive: true,
    facilityActive: false,
    bookLeads: false,
    elsewhere: [],
  });
  assert.equal(new Set([memberLed, memberLedBare, bookLed, bookLedFloor, areaBlamed]).size, 5, 'five distinct sentences');
  assert.match(memberLed, /No history at NASH in the window shown — this member billed at A and B\./);
  // ⚠ NOTHING BUT THE PLACEHOLDER LEFT. `facilitiesElsewhere` strips `No Facility`, so `elsewhere` can
  // be empty with rows still on the ranking — and "this member billed at " with nothing after it would
  // be the fabricated-place claim in its most literal form.
  assert.ok(!memberLedBare.includes('billed at'), 'no place is named when there is no place to name');
  assert.match(memberLedBare, /no facility on them/);
  assert.match(bookLed, /AETNA's book has no rows at NASH in the window shown/);
  assert.match(bookLedFloor, /This member HAS billed at NASH/);
  // BASIS DISCIPLINE (S2): every arm names the window it counted over — arms 1 and 3 carried no
  // window clause at all while 2 and 4 did, which is a mixed-basis screen by omission.
  for (const [label, arm] of Object.entries({ memberLed, memberLedBare, bookLed, bookLedFloor })) {
    assert.match(arm, /in the window shown/, `${label} must name its window`);
  }
  // An unnameable book still gets an honest subject rather than "null's book".
  assert.match(
    gridNarrowEmptyCopy({ ...base, bookPayer: null, bookLeads: true, elsewhere: [] }),
    /^This book has no rows at NASH/,
  );
});

test('S4/C1 — the floor arm names ONLY the picked facilities the member actually billed at', () => {
  /* ⚠ THE FABRICATION. `memberHasHistoryHere` was a boolean over the WHOLE picked set while the
   * sentence rendered EVERY picked name as its subject, so picks ['NASH','KWC'] against a footprint of
   * NASH alone asserted paid claims at a facility with zero rows. It is the fabricated-history class
   * S3 suppressed the placeholder annotation for, and it is reachable through exactly the "show me
   * these two houses" case that justified multi-select at all. */
  const partial = gridNarrowEmptyCopy({
    picked: ['NASH', 'KWC'],
    pickedWithHistory: ['NASH'],
    bookLeads: true,
    bookPayer: 'AETNA',
    rankedTotal: 3,
    elsewhere: [],
    areaActive: false,
    facilityActive: true,
    afterClearingFacility: 3,
    afterClearingArea: 3,
    blame: 'facility',
  });
  assert.match(partial, /This member HAS billed at NASH, but AETNA's book does not rank it/);
  assert.ok(!partial.includes('HAS billed at NASH and KWC'), 'KWC has zero rows — it may not ride the claim');
  // ...and the pick with NO history is still accounted for rather than silently dropped.
  assert.match(partial, /AETNA's book has no rows at KWC at all\./);

  // BOTH picks with history ⇒ plural pronoun. "does not rank it" over two facilities is the same
  // sentence being wrong in the other direction.
  const both = gridNarrowEmptyCopy({
    picked: ['NASH', 'KWC'],
    pickedWithHistory: ['NASH', 'KWC'],
    bookLeads: true,
    bookPayer: 'AETNA',
    rankedTotal: 3,
    elsewhere: [],
    areaActive: false,
    facilityActive: true,
    afterClearingFacility: 3,
    afterClearingArea: 3,
    blame: 'facility',
  });
  assert.match(both, /HAS billed at NASH and KWC, but AETNA's book does not rank them/);
  assert.ok(!both.includes('no rows at'), 'nothing is left over to disclaim');
});

test('S4/I1 — the recovery clause promises the count that CLEARING THAT CONTROL actually yields', () => {
  /* ⚠ BOTH ARMS PROMISED THE UN-NARROWED TOTAL WHILE INSTRUCTING ONE CLICK. With `facility=['PHX']`
   * and `area='TN'`, "The 3 facilities … choose All above to see them" resolves to ONE row, because
   * the facility narrow is still on. That is the PRE-S4 area sentence, so S4 made an existing
   * role="status" line false — a truth regression, not just a new claim being loose. */
  const areaBlamed = (over: Record<string, unknown>) =>
    gridNarrowEmptyCopy({
      blame: 'area',
      picked: ['PHX'],
      pickedWithHistory: [],
      bookLeads: false,
      bookPayer: null,
      elsewhere: [],
      rankedTotal: 3,
      areaActive: true,
      facilityActive: true,
      afterClearingFacility: 0,
      afterClearingArea: 1,
      ...over,
    } as Parameters<typeof gridNarrowEmptyCopy>[0]);

  // (a) AREA alone — byte-identical to what shipped before S4, because it was true then.
  assert.match(
    areaBlamed({ facilityActive: false, afterClearingArea: 3 }),
    /No ranked facility is in this area\. The 3 facilities behind this answer are still there — choose All above to see them\./,
  );
  // (b) BOTH live: naming one control means naming the count that control delivers, and the other way
  //     back must be named too or the "all 3" is unreachable in one click.
  const both = areaBlamed({});
  assert.match(both, /Choose All above to see the 1 facility you picked/, 'the honest one-click count');
  assert.match(both, /clear the facility too to see all 3/, 'and the way back to everything');
  assert.ok(!/still there — choose All above to see them/.test(both), 'the false single-click promise is gone');

  // (c) THE BOTH-EMPTY ROW. Each narrow is independently empty, so clearing either one alone still
  //     shows nothing — "see all 3" would clear to ZERO. It must say clear BOTH.
  const dead = gridNarrowEmptyCopy({
    blame: 'facility',
    picked: ['KWC'],
    pickedWithHistory: [],
    bookLeads: false,
    bookPayer: null,
    elsewhere: ['A'],
    rankedTotal: 3,
    areaActive: true,
    facilityActive: true,
    afterClearingFacility: 0,
    afterClearingArea: 0,
  });
  assert.match(dead, /neither has rows of its own/, 'it says why one click is not enough');
  assert.match(dead, /clear the area and the facility above to see all 3 facilities/);
  assert.ok(!/Clear the facility above to see all 3\./.test(dead), 'the one-click promise would clear to zero');

  // (d) FACILITY blamed with the area live and rows behind it — one click is enough, and says so.
  const oneClick = gridNarrowEmptyCopy({
    blame: 'facility',
    picked: ['KWC'],
    pickedWithHistory: [],
    bookLeads: false,
    bookPayer: null,
    elsewhere: ['A'],
    rankedTotal: 3,
    areaActive: true,
    facilityActive: true,
    afterClearingFacility: 1,
    afterClearingArea: 0,
  });
  assert.match(oneClick, /Clear the facility above to see the 1 facility in this area/);
  assert.match(oneClick, /clear the area too to see all 3/);
});

test('S4/M — "The 1 facilities" is fixed in the SHARED derivation, so all four sentences get it', () => {
  const one = (over: Record<string, unknown>) =>
    gridNarrowEmptyCopy({
      blame: 'area',
      picked: ['PHX'],
      pickedWithHistory: [],
      bookLeads: false,
      bookPayer: null,
      elsewhere: [],
      rankedTotal: 1,
      areaActive: true,
      facilityActive: false,
      afterClearingFacility: 1,
      afterClearingArea: 1,
      ...over,
    } as Parameters<typeof gridNarrowEmptyCopy>[0]);
  assert.match(one({}), /The 1 facility behind this answer is still there/, 'the PRE-S4 string had this bug');
  assert.ok(!one({}).includes('1 facilities'));
  const fac = one({ blame: 'facility', areaActive: false, facilityActive: true, elsewhere: ['A'] });
  assert.match(fac, /see all 1 facility\./);
  assert.ok(!fac.includes('1 facilities'));
});

test('S4/I2 — a lit area chip over an EMPTY grid says "selected", never "showing"', () => {
  /* ⚠ PRE-S4 A LIT CHIP COULD NEVER SIT OVER AN EMPTY GRID: the area was the only narrow, so a lit
   * chip meant rows. With a facility narrow composed on top, "All · 2 · showing" renders above zero
   * cards. The word must stay (I9: selection carries a WORD, never hue alone) but it must be a TRUE
   * word — the chip IS selected; it is not showing anything. */
  const chips = [{ key: AREA_ALL, label: 'All' }, { key: 'TN', label: 'TN' }];
  const renderArea = (shown: number) =>
    renderToStaticMarkup(
      <AreaLine chips={chips as never} active={AREA_ALL} counts={new Map([[AREA_ALL, 2]])} shown={shown} onSelect={() => {}} />,
    );
  assert.match(renderArea(2), / · showing/, 'rows on screen: the shipped word, unchanged');
  const empty = renderArea(0);
  assert.ok(!empty.includes(' · showing'), 'nothing is showing, so nothing may say it is');
  assert.match(empty, / · selected/, 'but the selection still carries a WORD, not hue alone (I9)');
  assert.match(empty, /aria-pressed="true"/, 'and the pressed state is unchanged');
});

test('S4/I2 — end to end: the facility narrow empties the grid and the area chip stops claiming to show', () => {
  const html = withFacility(threeStateSnapshot(), { area: 'TN', facilityNarrow: ['KWC'] });
  const grid = gridRegion(html);
  assert.ok(!grid.includes('data-v3-tile'), 'positive control: the grid really is empty');
  assert.ok(!grid.includes(' · showing'), 'no chip may claim to be showing rows over an empty grid');
  assert.match(grid, /TN<span[^>]*>[^<]*<\/span> · selected/, 'the lit chip says what is true instead');
});

test('S4/I3 — the floor case says the fact ONCE: “Not in this book” yields to the empty state', () => {
  /* ⚠ VERBATIM DUPLICATION ON THE EXACT SCREEN THE ARM EXISTS FOR. S3's "Not in this book: NASH. This
   * member has history there, but it is below the volume floor…" and S4's floor arm state the identical
   * fact ~340 characters apart. The S3 line is not deleted — it still speaks for facilities the empty
   * state is NOT about — it is subtracted. */
  const thinBook = ledSnapshot({
    bookFacilities: [
      facility({ rank: 1, name: 'SUMMIT RIDGE RECOVERY', facilityKey: 'SUMMIT', payerCount: 1 }),
      facility({ rank: 2, name: 'PHOENIX RENEWAL', facilityKey: 'PHX', city: 'Phoenix', state: 'AZ', payerCount: 1 }),
    ],
    facilities: [
      facility({ rank: 1, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH' }),
      facility({ rank: 2, name: 'KENTUCKY WELLNESS CENTER', facilityKey: 'KWC' }),
    ],
  } as Partial<QualifySnapshot>);
  // POSITIVE CONTROL: un-narrowed, BOTH member facilities are named by the S3 line.
  const wide = gridRegion(withFacility(thinBook));
  assert.match(wide, /Not in this book:/);
  assert.match(wide, /NASHVILLE MENTAL HEALTH · KENTUCKY WELLNESS CENTER/);

  // Narrowed to NASH: the empty state now says the NASH fact, so the S3 line must not repeat it —
  // and must still carry KWC, which the empty state is silent about.
  const narrowed = gridRegion(withFacility(thinBook, { facilityNarrow: ['NASH'] }));
  assert.match(narrowed, /This member HAS billed at NASHVILLE MENTAL HEALTH/, 'the empty state speaks');
  // ⚠ BOUND TO THE S3 LINE, not the whole region: the picker echoes the selection back inside its own
  // tag (and again in the tag's "Remove …" label), so a document-wide occurrence count answers a
  // question about the CONTROL rather than about the two sentences.
  // Bounded on the <p>, not the nearest <div> — `rowAround` walks back to a div and lands inside the
  // picker's own chip box, which is markup about the CONTROL rather than about either sentence.
  const notInBook = outerHtmlFrom(narrowed, narrowed.lastIndexOf('<p', narrowed.indexOf('Not in this book')));
  assert.match(notInBook, /KENTUCKY WELLNESS CENTER/, 'KWC is not lost — the empty state is silent about it');
  assert.ok(
    !notInBook.includes('NASHVILLE MENTAL HEALTH'),
    'the facility is named by the sentence that is about it, and only there',
  );

  // Narrowed to BOTH: the empty state covers the whole set, so the S3 line has nothing left to say.
  const all = gridRegion(withFacility(thinBook, { facilityNarrow: ['NASH', 'KWC'] }));
  assert.match(all, /HAS billed at NASHVILLE MENTAL HEALTH and KENTUCKY WELLNESS CENTER/);
  assert.ok(!all.includes('Not in this book'), 'nothing left for it to add');
});

test('S4/M — a lost vocabulary never renders "On · 1 of 0"', () => {
  // REACHABLE: a failed options reload leaves the selection behind, and `showFacilityLine` keeps the
  // control on screen precisely so the narrow stays clearable. `facetReading(selected, 0)` would then
  // print a denominator of zero under a numerator of one. GUARDED, not merely commented.
  const html = answerHtml(threeStateSnapshot(), { facilityOptions: [], facilityNarrow: ['NASH'] });
  assert.match(html, /aria-label="Facility"/, 'positive control: the control is still on screen, still clearable');
  assert.ok(!html.includes('of 0'), 'no denominator of zero');
  assert.match(html, /1 picked · list unavailable/, 'it says what it knows and nothing else');
});

test('S4/M — the facility picker searches the RAW CMD spellings, not just the acronym label', () => {
  // The wiring half of the picker fix; `pickerMatches` itself is unit-tested in
  // app/test/multiSelectTagPicker.test.tsx. `display` is NOT recomposed — label parity with the score
  // cards is why display_acronym exists — so the raw spellings ride as `searchText`.
  const src = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow.tsx', import.meta.url)),
    'utf8',
  );
  const line = src.split('\n').find((l) => l.includes('searchText:'));
  assert.ok(line !== undefined, 'the facility picker must opt in to searchText');
  assert.match(line!, /variants/, 'every raw CMD spelling');
  assert.match(line!, /o\.value/, 'and the canonical value');
});

test('S4 — the SECONDARY book section is NOT narrowed, matching what AREA does there today', () => {
  // DECIDED AND STATED. The area narrow does not reach the secondary section either — it renders
  // `bookFacilities.slice(0, QUALIFY_BOOK_PREVIEW)` straight — and the reason is that the section is
  // an ANSWER TO A DIFFERENT QUESTION ("does this policy pay anywhere"), whose value is precisely
  // that it is not scoped to what the operator is currently looking at. Narrowing it would make the
  // "N facilities — every facility {payer} paid at" sentence above it false.
  const html = withFacility(secondaryBookSnapshot(), { facilityNarrow: ['NASH'], area: 'TN' });
  const book = bookRegion(html);
  for (const name of ['SUMMIT RIDGE RECOVERY', 'PHOENIX RENEWAL', 'NASHVILLE MENTAL HEALTH']) {
    assert.ok(book.includes(name), `${name} survives in the secondary book — the grid narrows, the book does not`);
  }
  assert.match(book, /3<\/span> facilities/, 'and its own count still describes the whole book');
});

test('S4 — the inventory counts the facility narrow: one pick can never read “nothing is narrowing”', () => {
  // The AREA precedent exactly (2026-08-07). `anyFacetOn` is what stops the card's headline saying
  // "nothing is narrowing this search" beside a lit control that is narrowing it.
  const base = threeStateSnapshot();
  const allPayersThreeStates = {
    ...base,
    resolved: { ...base.resolved, payerName: null, payerScope: 'all' },
  } as unknown as QualifySnapshot;
  const wide = withFacility(allPayersThreeStates, { skipped: true, scopeSource: 'dominant' });
  assert.match(inventoryRegion(wide), /Nothing narrows this search but the window/, 'positive control');
  const narrowed = withFacility(allPayersThreeStates, {
    skipped: true,
    scopeSource: 'dominant',
    facilityNarrow: ['NASH'],
  });
  assert.match(inventoryRegion(narrowed), /Some narrows are on — anything marked Off is unrestricted\./);
  assert.ok(!inventoryRegion(narrowed).includes('Nothing narrows this search'), 'an active facility IS a filter that is on');
});

test('S4 — the footnote names BOTH beside-the-grid narrows, or one, or neither', () => {
  // The card holds FOUR of the screen's six facets. "Of these" scopes its count to the card; the
  // clause points at whichever of the two outside narrows is live. Enumerated rather than counted,
  // because "plus 2 narrows" makes an operator hunt for the second one.
  const base = threeStateSnapshot();
  const allPayersThreeStates = {
    ...base,
    resolved: { ...base.resolved, payerName: null, payerScope: 'all' },
  } as unknown as QualifySnapshot;
  const tally = (over: Partial<NonNullable<ResolutionStagesProps['answer']>>) =>
    inventoryRegion(
      withFacility(allPayersThreeStates, {
        skipped: true,
        scopeSource: 'dominant',
        // The card only HOLDS four facets when it has a candidate universe to derive funding and
        // employers from — without it the tally is honest but says "2", and this test is about the
        // clause beside the tally rather than about an empty card.
        candidates: orderedCandidates(fixture()),
        ...over,
      }),
    );

  assert.match(tally({ area: 'TN' }), /Plus the area narrow, beside the list\./);
  assert.match(tally({ facilityNarrow: ['NASH'] }), /Plus the facility narrow, beside the list\./);
  assert.match(tally({ area: 'TN', facilityNarrow: ['NASH'] }), /Plus the area and facility narrows, beside the list\./);
  // NEGATIVE CONTROL: without it the clause could be unconditional, naming narrows that are off.
  const none = tally({});
  assert.ok(!none.includes('area narrow'), 'no area narrow, no clause');
  assert.ok(!none.includes('facility narrow'), 'no facility narrow, no clause');
  assert.match(none, />Window<\/span>/, 'positive control: the strip rendered, so the negatives above mean something');
});

test('S4 HONESTY GUARD — the facility narrow reaches nothing that describes the FETCH', () => {
  // flow-state invariant (m), asserted from the render side: `rankingNarrowed` keys on
  // filters.funding and the employer narrow, and the facility selection is a sibling of `filters`,
  // never a member. Fold it into AnswerFilters and this goes red.
  const r = fixture();
  const html = render(
    props('answer', r, {
      answer: answerProps({
        snapshot: threeStateSnapshot(),
        skipped: true,
        candidates: orderedCandidates(r),
        facilityOptions: FACILITY_OPTIONS,
        facilityNarrow: ['NASH'],
      }),
    }),
  );
  assert.match(html, /aria-label="Facility"/, 'positive control: the narrow really is on screen');
  assert.ok(!html.includes('narrowed by your filter selections'), 'the request was not narrowed and must not claim it was');
  assert.ok(!html.includes('Ranking over'), 'no plan-count caption implying the ranking was re-scoped');
});

test('S4 STRUCTURAL — the facility selection never reaches scopeKeyOf or the snapshot request', () => {
  /* ⚠ THE ONE THING A RENDER TEST CANNOT SEE. `resolution-flow-client.tsx` reaches the `'use server'`
   * chain, so nothing hermetic can import it — the S3 review measured that INVERTING a ternary there
   * shipped app 557/0 with a clean build. The wiring that decides whether this narrow is a DISPLAY
   * narrow or a FETCH narrow lives in exactly that unimportable file, so it is scanned instead. */
  const src = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url)),
    'utf8',
  );
  /** The argument text of a call, walked by paren depth from the marker. */
  const callArgs = (marker: string): string => {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `\`${marker}\` is not in the client — this scan would be vacuous`);
    let depth = 0;
    for (let i = at + marker.length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
    }
    return assert.fail(`unbalanced call at ${marker}`);
  };
  // POSITIVE CONTROLS first: both calls really were found and really carry their known arguments.
  const scope = callArgs('scopeKeyOf(');
  assert.match(scope, /payerLabel/, 'the scope key really is the one built from the request inputs');
  const request = callArgs('getQualifySnapshot(');
  assert.match(request, /query: term/, 'the snapshot request really is the one carrying the term');
  // ...and now the negatives mean something.
  assert.ok(!/facilit/i.test(scope), 'a facility in the scope key would make this a fetch narrow');
  assert.ok(!/facilit/i.test(request), 'and a facility on the wire would throw away the empty state');
  // The vocabulary fetch is the ticker's shape — mount-once and fail-soft — never folded into the
  // snapshot effect, whose deps are the request identity and nothing else.
  assert.match(src, /loadQualifyFacilityOptions/, 'the vocabulary is loaded by the shell');
});

// ── S5 — THE REFRESH CONTROL, THE ONE HONEST FRESHNESS SOURCE, AND THE WINDOW THAT MOVES SILENTLY ─
//
// WHAT THESE PIN. Until S5 the only re-run affordance on this surface was the "Try again" button
// INSIDE the `refreshFailed` banner: refresh existed only as failure recovery, on a screen whose
// underlying crons write hourly. Promoting it to a standing control is a render change — the handler
// (`retry_requested` → `retryNonce` → the fetch effect's dep array) was already general — but it
// brings three problems the banner never had, and each has its own block below:
//
//   1 · IT LOOKS DEAD. All three progress signals derive from `loadedKey !== scopeKey`, which a
//       same-scope refresh cannot move; `showSkeleton` needs a null snapshot. So the refresh needs
//       its own in-flight signal, rendered as the design system's RE-SCOPE idiom (dim + beam), never
//       as a skeleton — a standing control that blanks the answer every press is worse than none.
//   2 · IT INVITES "IS THIS EVEN NEW?". Answered from `collections.rollup_refresh_run` — the one
//       source that means what it says. `max(ingested_at)` is first-seen (42h stale on a healthy
//       weekend) and `rollup_max_payment_date` reads FIVE DAYS INTO THE FUTURE. Both are pinned out
//       in test/rollupFreshnessQuery.test.ts, at the SQL, where they are reachable.
//   3 · IT CAN MOVE THE WINDOW WITHOUT SAYING SO. See the window-move block.

test('S5: the rebuilt-at line names the ROLLUP REBUILD, in a named timezone, and never a bare HH:MM', () => {
  // 2026-08-08T23:45:37Z is 16:45 in America/Los_Angeles — the :45 rollup rebuild, ~86s after start.
  const s = rebuiltAtSentence('2026-08-08T23:45:37Z');
  assert.match(s, /Ranking data rebuilt/, 'it names WHAT was rebuilt — the index, never the CMD pull');
  assert.match(s, /Aug 8 at 4:45 PM PDT/, 'a DATE, a time and a NAMED zone');
  /* ⚠ A BARE HH:MM IS THE BANNED FORM. This team spans timezones and the app anchors civil days to
   * America/Los_Angeles; "rebuilt at 4:45" is a different claim to each reader. The zone abbreviation
   * is what makes it one claim, and the date is what stops a stalled cron from reading as "today". */
  assert.ok(/PDT|PST/.test(s), 'the zone is named, not implied');
  // The lag bound is the DEFENSIBLE one, derived from the schedule: BXR pulls at :00 and the rebuild
  // runs at :45, so worst case is 1h45m before CMD's own posting lag. Never a single-number claim.
  assert.match(s, /up to about 2 hours/);
  assert.ok(!s.includes('data through'), 'that phrasing belongs to rollup_max_payment_date, which reads into the future');

  // FAIL-SOFT: the freshness read must never block or fake the ranking. Unknown says unknown.
  const unknown = rebuiltAtSentence(null);
  assert.match(unknown, /freshness unknown/i);
  assert.ok(!/\d/.test(unknown), 'an unreadable log must not produce a number of any kind');
  // A malformed timestamp is the same answer, not a crash and not an Invalid Date on screen.
  assert.equal(rebuiltAtSentence('not-a-timestamp'), unknown);
});

test('S5: the refresh control stands ON the verdict card, in BOTH positions, as a plain button', () => {
  for (const narrowExpanded of [false, true]) {
    const html = render(
      props('answer', fixture(), {
        answer: answerProps({ snapshot: snapshotFixture(), narrowExpanded, dataRebuiltAt: '2026-08-08T23:45:37Z' }),
      }),
    );
    // BOUNDED to the card (the S1/S2 lesson: an unbounded slice runs to the end of the document and
    // would be satisfied by the banner's "Try again" or by anything else below).
    const card = inventoryRegion(html);
    assert.match(card, /Refresh the ranking/, `expanded=${narrowExpanded}: the control is on the card`);
    /* ⚠ THE CARD'S OWN RULE IS WHY IT BELONGS HERE: everything on the control card re-issues the
     * ranking request, and this does exactly that — which is also why the two GRID narrows (area,
     * facility) are deliberately outside it. */
    assert.match(card, /Ranking data rebuilt/, 'and the basis line beside it');
    /* ⚠ type="button" IS LOAD-BEARING, NOT STYLE. A submit inside a form would reach `planAction`
     * and re-run `resolveCoverageAction`, which writes sixteen reducer fields and drops the operator
     * back to the payer stage — the thing this control must never do. */
    // Walk back to the button's own opening tag rather than guessing a slice width — the control's
    // attributes grew in the fix round and a fixed-width lookback silently stopped reaching them.
    const labelAt = card.indexOf('Refresh the ranking');
    const btn = card.slice(card.lastIndexOf('<button', labelAt), labelAt);
    assert.match(btn, /type="button"/, `expanded=${narrowExpanded}: never a submit`);
  }
});

test('S5: while refreshing the card says so, the control is disabled, and the answer DIMS rather than blanking', () => {
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), refreshing: true, dataRebuiltAt: '2026-08-08T23:45:37Z' }),
    }),
  );
  const card = inventoryRegion(html);
  assert.match(card, /Refreshing the ranking/, 'the label states the state — the press must visibly take');
  assert.match(card, /aria-busy="true"/, 'and the spoken channel learns it too');
  /* ⚠ `aria-disabled`, NEVER THE `disabled` ATTRIBUTE (M3). The real attribute makes the element
   * unfocusable the instant it lands — so the control the operator is STANDING ON stops being
   * focusable mid-press and focus falls to <body>, which is the exact regression the stage's focus
   * effect exists to prevent one layer up. It is also not reliably announced. The refusal moved into
   * `makeRetryHandler`, where it is a behaviour rather than a browser side effect, and this
   * assertion is the static half: the state is exposed, and focus is not taken away. */
  assert.match(card, /aria-disabled="true"/, 'the state is EXPOSED to AT');
  assert.ok(!/\sdisabled=""/.test(card), 'and never as the focus-stealing attribute');
  // The design system's re-scope idiom, and NOT a skeleton: a standing control that blanks the
  // answer on every press makes each refresh feel like a page rebuild.
  assert.match(html, /opacity-60/, 'dimmed — what is on screen is about to be replaced');
  assert.match(html, /q-refetch-beam/, 'with the progress beam, because a request really is running');
  assert.ok(!html.includes('Ranking facilities for this plan…'), 'never the first-load skeleton');
  assert.ok(!/policy rating \d+ out of 100/.test(html), 'and the categorical claims wait, as on any re-scope (RULE 2654416)');

  // NEGATIVE CONTROL: idle, the control is live and nothing claims progress.
  const idle = inventoryRegion(
    render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture() }) })),
  );
  assert.match(idle, /Refresh the ranking/);
  assert.ok(!idle.includes('aria-busy="true"'), 'nothing is in flight');
  assert.ok(!idle.includes('aria-disabled="true"'), 'and the control is pressable');
});

test('S5: freshness fails SOFT — an unreadable run-log leaves the ranking untouched and says "unknown"', () => {
  const html = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), dataRebuiltAt: null }) }),
  );
  assert.match(inventoryRegion(html), /freshness unknown/i);
  assert.match(html, /NASHVILLE MENTAL HEALTH/, 'the ranking is entirely unaffected — it is a separate read');
});

test('S5: windowMoveNotice states the direction, the two windows and the FLOOR that moved them', () => {
  const wider = windowMoveNotice({ from: 30, to: 90 });
  assert.match(wider, /widened from 30 to 90 days/);
  assert.match(wider, /10-patient/, 'the floor is NAMED — copy basis discipline: say what it was measured against');
  assert.match(wider, /this ranking spans 90 days/, 'and which of the two numbers describes the list on screen');

  const narrower = windowMoveNotice({ from: 90, to: 30 });
  assert.match(narrower, /narrowed from 90 to 30 days/);
  assert.match(narrower, /this ranking spans 30 days/);

  /* ⚠ THE NOTICE NEVER AUTO-DISMISSES, so its copy may not be anchored to a MOMENT (M4). It
   * survives every grid-narrow toggle by design — `windowMove` clears only on the next resolve, a
   * new refresh, or a navigation — so an operator can sit with it on screen for minutes, and "than
   * it did a moment ago" quietly stops being true while the sentence keeps asserting it. Fixed in
   * COPY rather than with dismissal machinery: it names the REFRESH (a durable event) and states
   * the span as a fact about the list in front of them. */
  for (const s of [wider, narrower]) {
    assert.ok(!/a moment ago/.test(s), 'no claim anchored to a moment that has passed');
    assert.match(s, /on the last refresh/, 'it names the event, not the moment');
  }
  // Both directions are genuinely reachable: new rows crossing the floor NARROW it, rows ageing out
  // (or an America/Los_Angeles civil-day roll) WIDEN it.
  assert.notEqual(wider, narrower);
});

test('S5: a window that moved under an unchanged scope key is ANNOUNCED — and an unchanged one is not', () => {
  /* ⚠ THE SILENT SCOPE CHANGE. `scopeKeyOf` serializes the automatic case as the literal 'auto',
   * so a refresh that re-runs the ladder onto another rung leaves loadedKey === scopeKey: every
   * staleness flag reads "nothing changed" while `windowSentence` quietly renders a different
   * number and the facet badge still says "On · automatic". */
  const moved = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), windowMove: { from: 30, to: 90 } }),
    }),
  );
  // BOUNDED TO THE CARD, because the flow's sr-only region carries the same sentence and sits FIRST
  // in the document — an unbounded search finds the SPOKEN copy and would pass with nothing drawn.
  const card = inventoryRegion(moved);
  assert.match(card, /widened from 30 to 90 days/, 'the visible notice, on the card');
  const noticeAt = card.indexOf('widened from 30 to 90 days');
  assert.match(card.slice(Math.max(0, noticeAt - 400), noticeAt), /role="status"/, 'and it is announced, not just drawn');
  assert.match(moved, /aria-live="polite"[^>]*>[^<]*widened from 30 to 90 days/, 'and the live region carries it too');

  /* ⚠ THE NEGATIVE CONTROL, and it is the assertion that keeps the notice worth reading. Most
   * refreshes return the same rung; one that announced anyway would be noise, and noise is how the
   * real one gets ignored. */
  const still = render(
    props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture(), windowMove: null }) }),
  );
  // ⚠ "automatic window" ALONE WOULD BE A VACUOUS NEGATIVE: `resolvedScopeSentence` already ends
  // "· automatic window" on every auto search. The notice's own phrasing is what must be absent.
  assert.match(still, /automatic window/, 'positive control: the resolved-scope line really does say it');
  assert.ok(!still.includes('on the last refresh'), 'a refresh whose ladder did not move says nothing');

  /* A MANUAL window cannot produce this notice and must not render one even if a stale move survived
   * into the render: "the automatic window widened" over a screen reading "trailing 180 days — your
   * selection" would be two contradictory sentences about the same control. */
  const manual = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), windowDays: 180, windowMove: { from: 30, to: 90 } }),
    }),
  );
  assert.ok(!manual.includes('widened from 30 to 90 days'), 'the notice is about the AUTOMATIC window only');
  assert.match(manual, /Showing trailing 180 days — your selection\./, 'positive control: the manual sentence really is on screen');

  // And it waits during a re-fetch like every other categorical sentence (RULE 2654416).
  const inFlight = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), refetching: true, windowMove: { from: 30, to: 90 } }),
    }),
  );
  assert.ok(!inFlight.includes('widened from 30 to 90 days'), 'a claim about the set being replaced waits');
});

test('S5: the SPOKEN channel carries the same window-move sentence, word for word, and is stage-gated', () => {
  /* One expression, two channels. The sr-only region carries no dim and no beam, so a screen-reader
   * user has no other signal that the window moved — and a second wording here is how the seen and
   * the spoken claim drift, which is the failure `liveSentenceFor`'s own header warns about. */
  const r = fixture();
  const move = { from: 30, to: 90 } as const;
  const spoken = liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1, windowMoved: move });
  assert.ok(spoken.includes(windowMoveNotice(move)), 'byte-identical to the visible notice');
  // Omitting it is byte-identical to the pre-S5 announcement.
  assert.equal(
    liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1 }),
    liveSentenceFor('answer', r, null, { memberCount: 1, memberFacilityCount: 1, windowMoved: null }),
  );
  // STAGE-GATED, the S3-M1 lesson: "the ranking below now covers a longer period" said over the
  // search box describes a list that is not there.
  for (const stage of ['identify', 'payer', 'plan'] as const) {
    assert.ok(
      !liveSentenceFor(stage, r, null, { skipped: true, memberCount: 1, memberFacilityCount: 1, windowMoved: move }).includes('on the last refresh'),
      `stage=${stage} announces a window change for a ranking that is not on screen`,
    );
  }
  // The skipped arm returns before every stage check, so it needs the clause explicitly.
  assert.ok(
    liveSentenceFor('answer', r, null, { skipped: true, memberCount: 1, memberFacilityCount: 1, windowMoved: move }).includes('on the last refresh'),
    'a skipped answer stage is still an answer stage',
  );
});

test('S5 STRUCTURAL — a refresh cannot re-enter the resolve: no formAction is reachable from its handler', () => {
  /* ⚠ THE HALF A RENDER TEST CANNOT SEE, scanned for the S4 reason: `resolution-flow-client.tsx`
   * reaches the `'use server'` chain, so nothing hermetic can import it. `resolveCoverageAction` is
   * driven by `useActionState`'s `formAction`, and re-running it writes sixteen reducer fields and
   * drops the operator back to the payer stage. So the claim is structural: `formAction` is called
   * from exactly the two places that MEAN to navigate, and the refresh handler is neither. */
  const src = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url)),
    'utf8',
  );
  const calls = [...src.matchAll(/formAction\(/g)];
  assert.equal(calls.length, 2, 'exactly two: identifyAction and planAction — a third is a new navigation path');
  // The retry/refresh handler in full, walked from its declaration to the end of the memo call.
  const at = src.indexOf('const onRetrySnapshot');
  assert.ok(at >= 0, 'the refresh handler is not in the client — this scan would be vacuous');
  const body = src.slice(at, src.indexOf(');', src.indexOf('makeRetryHandler', at)) + 2);
  assert.ok(!body.includes('formAction'), 'the refresh handler must never reach the server action');
  /* ⚠ THE GUARDS THEMSELVES ARE NO LONGER SCANNED FOR, BECAUSE THE SCAN COULD NOT FAIL (MUT-25).
   * This block used to assert `body.indexOf("termRef.current === ''") < body.indexOf('retry_requested')`
   * — and `indexOf` returns -1 for an absent needle, so DELETING the guard made it `-1 < positive`,
   * i.e. true, and the mutation ran 156/0. Both guards now live in `makeRetryHandler`, where
   * qualifyV3FlowState.test.tsx calls them; what is left here is the WIRING, which is the only part
   * a hermetic test genuinely cannot reach. */
  assert.match(body, /makeRetryHandler/, 'the shell uses the tested factory rather than an inline closure');
  assert.match(body, /termRef\.current/, 'the PHI stays in the ref and reaches the factory as a GETTER');
  assert.ok(!/getTerm:\s*\(\)\s*=>\s*''/.test(body), 'and not as a hardcoded empty that would disable the control');
  assert.match(body, /isBusy/, 'and the busy refusal is wired, not left to the DOM');
  // The freshness read is its own request, on the ticker's mount-once/fail-soft shape — never folded
  // into the snapshot call, which is audited, PHI-scoped and must not be slowed by an ops lookup.
  assert.match(src, /loadQualifyDataFreshness/, 'the shell loads the rebuild time itself');
  const request = src.slice(src.indexOf('getQualifySnapshot('), src.indexOf('getQualifySnapshot(') + 600);
  assert.ok(!/freshness|rebuilt/i.test(request), 'and it is not a segment of the ranking request');
});

test('S5 FIX — a rebuilt-at line may not describe a grid the failed refresh did not produce', () => {
  /* ⚠ THE TWO EFFECTS ARE INDEPENDENT, AND THE HEAVY ONE IS THE LIKELIER TO FAIL. The freshness read
   * is a one-row index scan on `collections.rollup_refresh_run`; the ranking is the query
   * `statement_timeout` exists for. Both fire on `retryNonce`, so this sequence is ordinary rather
   * than exotic: press refresh → freshness succeeds and ADVANCES to 5:45 PM → the snapshot fails →
   * invariant (e) deliberately retains the OLD grid. The card then reads "Ranking data rebuilt
   * 5:45 PM PDT" directly above a ranking built BEFORE that rebuild, and it says so until a retry
   * succeeds. This line is the only BASIS claim on the screen, so it is exactly the sentence an
   * operator would use to decide the numbers are current.
   *
   * ⚠ WHY IT IS CAPTIONED AND NOT GATED. A commit-time gate ("don't advance while failed") narrows
   * the window without closing it, because the race runs BOTH ways — the snapshot can fail AFTER
   * freshness has committed. A render-time caption is correct in either ordering. */
  const failedRefresh = rebuiltAtSentence('2026-08-08T23:45:37Z', { refreshFailed: true });
  assert.match(failedRefresh, /Aug 8 at 4:45 PM PDT/, 'the timestamp is still stated — it is true about the REBUILD');
  assert.match(failedRefresh, /may predate that rebuild/, 'but it no longer claims to describe the grid');
  assert.ok(!failedRefresh.includes('up to about 2 hours'), 'the CMD lag bound is the lesser caveat and would bury this one');

  // POSITIVE CONTROL — the ordinary arm is untouched, and the two are genuinely different sentences.
  const ok = rebuiltAtSentence('2026-08-08T23:45:37Z');
  assert.match(ok, /up to about 2 hours/);
  assert.ok(!ok.includes('may predate'), 'a successful refresh makes no such caveat');
  assert.notEqual(ok, failedRefresh);
  // An unreadable log needs no second caveat: "unknown" already claims nothing about anything.
  assert.equal(rebuiltAtSentence(null, { refreshFailed: true }), rebuiltAtSentence(null));

  // ...and the caveat really does reach the card, on exactly the state that produces it.
  const html = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: snapshotFixture(),
        snapshotError: 'failed', // snapshot present + error = refreshFailed
        dataRebuiltAt: '2026-08-08T23:45:37Z',
      }),
    }),
  );
  assert.match(inventoryRegion(html), /may predate that rebuild/, 'the card carries the caveat');
  assert.match(html, /could not be refreshed/, 'positive control: this really is the failed-refresh state');
  const clean = render(
    props('answer', fixture(), {
      answer: answerProps({ snapshot: snapshotFixture(), dataRebuiltAt: '2026-08-08T23:45:37Z' }),
    }),
  );
  assert.ok(!clean.includes('may predate that rebuild'), 'and a healthy screen does not');
});

test('S5 FIX — the first-ever read of rollup_refresh_run does not swallow its failure silently', () => {
  /* ⚠ THE DISCOVERABILITY HALF OF THE 0089 RULE. Correctness was never in doubt: a 42501 cannot
   * fabricate a timestamp, and the unknown arm contains no digit. But this table's SELECT policy has
   * never been exercised on the app path, and a bare `catch { return { ok: false } }` makes a
   * PERMISSION failure indistinguishable from an empty log — in the UI *and* in the server logs.
   * That is precisely how 0089 turned a swallowed 42501 into permanently wrong data rather than a
   * visible failure. The sibling loader twenty-five lines away already states the rule out loud:
   * "the swallow must stay discoverable in server logs".
   *
   * Scanned rather than executed: `actions.ts` is a `'use server'` module and nothing hermetic can
   * import it, so the assertion is that the catch is not bare and logs the non-PHI SQLSTATE. */
  const src = readFileSync(fileURLToPath(new URL('../lib/qualify/actions.ts', import.meta.url)), 'utf8');
  const at = src.indexOf('export async function loadQualifyDataFreshness');
  assert.ok(at >= 0, 'the freshness action is not in actions.ts — this scan would be vacuous');
  const body = src.slice(at, src.indexOf('\n}', at) + 2);
  assert.match(body, /catch \(err\)/, 'the error is BOUND, not discarded by a bare catch');
  assert.match(body, /console\.error/, 'and the swallow leaves a trace a human can find');
  assert.match(body, /sqlstate/i, 'naming the SQLSTATE, which is what tells 42501 from an empty log');
  /* ⚠ AND NOTHING ELSE FROM THE ERROR. `rollup_refresh_run.error` holds a caught DB message and the
   * driver's own message can carry query text; the code alone answers the question. */
  assert.ok(!/err\.message|\berr\b\s*\)/.test(body.replace(/catch \(err\)/, '')), 'the message itself never reaches a log line');
  assert.match(body, /requireQualifyPrincipal/, 'positive control: still gated like every action here');
});

// ── S6 — THE PROMINENT SKIP BENEATH THE RAIL, AND THE ASK-AI UN-SUBMIT (2026-08-08) ─────────────
//
// Alec, verbatim: "If there is the option to 'skip — search all plans' this button should be very
// visible, sparkly with movement just underneath the green timeline."
//
// The affordance leaves the stage bodies — three call sites, StagePayer gated and StagePlan twice —
// for ONE site directly beneath <StepRail>. That puts it in the CHROME (outside `[data-v3-stage]`),
// which is why it is interactive from frame zero: the shell's GSAP entrance sets `autoAlpha`, and
// `autoAlpha` means `visibility: hidden`. What the hoist must NOT change is the 2026-08-06
// suppression ruling, and it is pinned twice below — once as a predicate, once through the render.

const GLOBALS_CSS = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');
const TAILWIND_CONFIG = readFileSync(fileURLToPath(new URL('../tailwind.config.ts', import.meta.url)), 'utf8');

/** A brand token's hex, read from the config rather than transcribed — so an edit to the palette
 *  re-runs the contrast arithmetic below instead of quietly invalidating a comment about it. */
function twToken(name: string): string {
  const m = TAILWIND_CONFIG.match(new RegExp(`\\b${name}:\\s*'(#[0-9A-Fa-f]{6})'`));
  assert.ok(m?.[1] !== undefined, `no \`${name}\` token in tailwind.config.ts`);
  return m[1].toLowerCase();
}

/** WCAG 2.x relative luminance (sRGB). Written out rather than pulled in — this file takes no deps. */
function relativeLuminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `{…}` block whose opening line matches `opener`, read IN FULL by walking brace depth.
 *  A fixed-length lookahead cannot make an exhaustive claim; this can. */
function cssBlocksMatching(css: string, opener: RegExp): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(opener)) {
    let depth = 0;
    for (let i = (m.index ?? 0) + m[0].length - 1; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(css.slice(m.index ?? 0, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

/** Every rule that styles the sparkle, wherever it sits (including inside the @supports gate). */
const sparkRules = (): string[] =>
  [...GLOBALS_CSS.matchAll(/\.q-skip-spark(?:::after)?\s*\{[^}]*\}/g)].map((m) => m[0]);

/** The hoisted Skip control's own `<button>`, bounded at its closing tag. Returns null when the
 *  surface offers none — an ABSENCE this file has to be able to assert positively, because the
 *  suppression ruling is a claim about absence. */
function skipControlOf(html: string): string | null {
  const at = html.indexOf('aria-label="Skip ');
  if (at < 0) return null;
  return outerHtmlFrom(html, html.lastIndexOf('<button', at));
}

test('S6: the Skip is HOISTED — one control, beneath the rail, above the animated stage', () => {
  for (const [stage, over] of [
    ['payer', {}],
    ['plan', { payerPick: 'Aetna' }],
  ] as Array<[FlowStage, Partial<ResolutionStagesProps>]>) {
    const html = render(props(stage, fixture(), over));
    // ONE control. Three call sites used to be able to disagree with each other; on the plan stage
    // two of them rendered in mutually exclusive branches, which is a duplication a reader has to
    // hold in their head rather than one the markup shows.
    assert.equal(html.match(/aria-label="Skip /g)?.length, 1, `${stage}: exactly one Skip control`);
    // "Just underneath the green timeline", in DOM terms: after the rail, before the stage subtree.
    const rail = html.indexOf('data-v3-rail');
    const skip = html.indexOf('aria-label="Skip ');
    const stageAt = html.indexOf('data-v3-stage');
    assert.ok(rail >= 0 && stageAt >= 0, `${stage}: positive control — rail and stage both rendered`);
    assert.ok(rail < skip, `${stage}: the Skip must follow the rail`);
    assert.ok(skip < stageAt, `${stage}: ...and precede the stage subtree, or it is not hoisted at all`);
    // Still says what it does, per stage. The accessible name is the whole promise.
    assert.match(
      html,
      /aria-label="Skip the (carrier|plan) step and search across all plans for this member"/,
      `${stage}: the Skip names the step it declines`,
    );
  }
  // The two stages with nothing to skip offer nothing: identify has no question behind it yet, and
  // the answer is past every question there is.
  assert.equal(skipControlOf(render(props('identify', null))), null, 'identify has nothing to skip');
  assert.equal(
    skipControlOf(render(props('answer', fixture(), { answer: answerProps({ snapshot: snapshotFixture() }) }))),
    null,
    'the answer stage is past it',
  );
});

test('S6: the plan stage keeps its Skip even when the carrier resolves to NO plans', () => {
  // The empty-cluster arm (a stale carrier pick after a re-resolve) was one of the three call sites,
  // and it is the one whose loss would be silent: it renders an early-return <Stage> that shares no
  // markup with the ordinary plan grid. The hoist is what makes it structurally impossible to lose —
  // the control is no longer inside the branch.
  const html = render(props('plan', fixture(), { payerPick: 'NOT A CARRIER ON FILE' }));
  assert.match(html, /No plans are on file under NOT A CARRIER ON FILE/, 'positive control: the empty arm rendered');
  assert.ok(skipControlOf(html) !== null, 'a dead end must still offer the way out');
});

test('S6: the carrier-count suppression ruling SURVIVES the hoist — same gate, one control', () => {
  const two = fixture();
  const many = crowdedCarriers();
  assert.equal(payerGroupsOf(two).length, 2, 'positive control: the obvious case is below the max');
  assert.ok(payerGroupsOf(many).length >= SKIP_CARRIER_MAX, 'positive control: the crowded case is at or above it');

  // The predicate, which is the ruling written down once instead of inlined at each render site.
  assert.equal(skipOffered('payer', two), true, 'payer, nearly obvious → offered');
  assert.equal(skipOffered('payer', many), false, 'payer, a real question → SUPPRESSED (ruled 2026-08-06)');
  assert.equal(skipOffered('plan', many), true, "plan always offers it — the population is one carrier's plans");
  assert.equal(skipOffered('plan', two), true);
  assert.equal(skipOffered('identify', two), false, 'nothing has been narrowed yet');
  assert.equal(skipOffered('answer', two), false, 'the answer is past it');
  assert.equal(skipOffered('payer', null), false, 'no resolution, no footprint to search');
  // It reads the THREADED clusters when it has them — the same single derivation the rail, the
  // receipt, the stage machine and the live sentence all share. A second `payerGroupsOf` call here
  // would be a second source of truth for a rule expressed as a count.
  assert.equal(skipOffered('payer', many, payerGroupsOf(two)), true, 'the threaded groups are honoured');
  assert.equal(skipOffered('payer', two, payerGroupsOf(many)), false, 'in both directions');

  // ...and the render agrees with the predicate, which is the half a pure unit cannot prove.
  assert.equal(skipControlOf(render(props('payer', many))), null, 'no Skip on a crowded carrier stage');
  assert.ok(!render(props('payer', many)).includes('search all plans'), 'not anywhere else on it either');
  assert.ok(skipControlOf(render(props('plan', many, { payerPick: 'Aetna' }))) !== null, 'but the plan stage keeps it');
});

test('S6: the sparkle borrows the beta badge’s IDIOM and not its sizes — every declared size clears 12px', () => {
  // The floor sweep above scans `text-[Npx]` classes in rendered markup. This treatment sizes its ✦
  // in the stylesheet, where that sweep cannot see it — so it is swept HERE, at the source it lives
  // in. The badge it is modelled on runs 8px text / 7px star, which is exactly what must not travel.
  const rules = sparkRules();
  assert.equal(rules.length, 3, 'the shimmer, its ✦, and the @supports fallback — nothing else claiming the name');
  let sizes = 0;
  for (const rule of rules) {
    for (const m of rule.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      sizes += 1;
      assert.ok(Number(m[1]) >= 12, `sub-12px in the sparkle: ${m[0]}`);
    }
  }
  assert.ok(sizes >= 1, 'positive control: a size really is declared here, so the sweep is not vacuous');
  // NEGATIVE CONTROL, and the reason this test exists: the source idiom IS below the floor. If the
  // badge is ever resized, re-read this line rather than deleting it.
  assert.match(GLOBALS_CSS, /\.q-beta-badge\s*\{[^}]*font-size:\s*8px/, 'the badge is 8px — decorative, aria-hidden, in the nav');
  // The control's own label rides `text-sm` (0.9375rem = 15px in this scale), never an arbitrary size.
  const btn = skipControlOf(render(props('payer', fixture())));
  assert.ok(btn !== null && /text-sm/.test(btn), 'the label is a scale step, not a one-off');
});

test('S6: both sparkle animations collapse under the GLOBAL reduced-motion reset — verified, not assumed', () => {
  // The reset is a UNIVERSAL rule, so the only way an animation escapes it is a selector that `*`,
  // `*::before` and `*::after` do not match. Assert the reset's shape first — every motion claim in
  // this file is void if it has drifted.
  const reset = GLOBALS_CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(reset !== undefined, 'the global reduced-motion reset is gone');
  for (const sel of ['*,', '*::before,', '*::after {']) {
    assert.ok(reset.includes(sel), `the reset must cover ${sel}`);
  }
  assert.match(reset, /animation-duration:\s*0\.01ms\s*!important/, 'duration is what collapses a shimmer');
  assert.match(reset, /animation-iteration-count:\s*1\s*!important/, '...and the count is what stops an infinite one');

  // Then that BOTH animations hang off selectors it reaches: the element itself, and its ::after.
  assert.match(GLOBALS_CSS, /\.q-skip-spark\s*\{[^}]*animation:\s*q-skip-shimmer/, 'the shimmer is on the element');
  assert.match(GLOBALS_CSS, /\.q-skip-spark::after\s*\{[^}]*animation:\s*q-skip-twinkle/, 'the twinkle is on ::after');
  for (const kf of ['q-skip-shimmer', 'q-skip-twinkle']) {
    assert.match(GLOBALS_CSS, new RegExp(`@keyframes ${kf}\\b`), `${kf} has no keyframes at all`);
  }
  // And no reduced-motion block anywhere in the sheet mentions the sparkle — an opt-out of its own
  // being the one way to defeat the reset from the component side.
  //
  // ⚠ THIS SCAN USED TO BE BOUNDED TO 400 CHARACTERS AFTER THE `@media`, AND ITS COMMENT CLAIMED
  // "the only way", which the regex did not deliver: an opt-out written past the bound passed. The
  // blocks are now read in FULL by walking brace depth, so the claim and the mechanism agree. (The
  // rule count in the test above catches realistic adjacent placements; this one is exhaustive.)
  const rmBlocks = cssBlocksMatching(GLOBALS_CSS, /@media[^{]*prefers-reduced-motion[^{]*\{/g);
  assert.ok(rmBlocks.length >= 1, 'positive control: a reduced-motion block exists to be read');
  for (const block of rmBlocks) {
    assert.ok(!block.includes('q-skip-'), 'the sparkle must not carry a reduced-motion opt-out of its own');
  }
});

test('S6: every colour the shimmer sweeps clears WCAG 1.4.3 on the fill — computed, not asserted in prose', () => {
  /* ⚠ THIS TEST EXISTS BECAUSE THE FIRST VERSION OF THIS TREATMENT SHIPPED A FALSE CONTRAST CLAIM IN
   * THREE DOCUMENTS. The label is `text-sm` (15px) semibold — NOT WCAG "large text" (18.66px bold /
   * 24px), so 1.4.3 wants **4.5:1**. The original sweep carried coral400 `#f0917c`, which measures
   * 5.37:1 on teal900 and **3.26:1 on teal700** — and the fill is `from-teal900 to-teal700`, so most
   * of the label sits at or past the midpoint and the coral band crossed the loudest control on the
   * screen BELOW the floor every 2.6s. The refused stop `#ffe0d5` measured 6.08:1 on this fill: the
   * refusal reasoned about the badge's LIGHT ground and got applied to a dark one.
   *
   * The arithmetic now lives here, over the real tokens and the real declaration, so this class of
   * claim is self-verifying rather than re-argued. A gradient interpolates monotonically per channel
   * and relative luminance is monotonic in each channel, so checking the STOPS bounds the whole
   * sweep — there is no interior colour darker than the darkest stop. */
  const btn = skipControlOf(render(props('payer', fixture())));
  assert.ok(btn !== null, 'positive control: there is a control to measure');
  // The FILL, read off the control's own classes and resolved through the tailwind tokens — so a
  // token edit re-runs the arithmetic instead of silently invalidating a comment.
  const from = btn.match(/from-(teal\d+)/)?.[1];
  const to = btn.match(/to-(teal\d+)/)?.[1];
  assert.ok(from !== undefined && to !== undefined, 'the control still paints a two-token gradient fill');
  const fill = [twToken(from), twToken(to)];
  // The WORST CASE for light text is the LIGHTEST end of the fill, not the average of the two.
  const worst = fill.reduce((a, b) => (relativeLuminance(a) >= relativeLuminance(b) ? a : b));
  assert.equal(worst, twToken('teal700'), 'positive control: teal700 really is the lighter end');

  const spark = sparkRules().find((r) => r.includes('linear-gradient'));
  assert.ok(spark !== undefined, 'the shimmer declares no gradient at all');
  const stops = [...spark.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
  assert.ok(stops.length >= 3, `positive control: the sweep really has stops — found ${stops.length}`);
  for (const stop of stops) {
    const ratio = contrastRatio(stop, worst);
    assert.ok(ratio >= 4.5, `label stop ${stop} is ${ratio.toFixed(2)}:1 on ${worst} — 1.4.3 wants 4.5:1 at 15px`);
  }

  /* THE ✦ IS DECORATION, AND IS HELD TO 1.4.11's 3:1 DELIBERATELY. It is a `content` glyph on an
   * `::after`, it carries no meaning, and the button's accessible name comes from its `aria-label` —
   * so it is a graphical object, not text this rule has to read. Stated as the bar it is measured
   * against rather than left for a reader to infer, because "the star is only 3:1" is exactly the
   * finding that should land on the reasoning and not on the number. */
  const after = sparkRules().find((r) => r.includes('::after'));
  assert.ok(after !== undefined, 'the ✦ rule is gone');
  const star = after.match(/(?:^|[^-])color:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(star !== undefined, 'the ✦ declares no colour');
  const starRatio = contrastRatio(star, worst);
  assert.ok(starRatio >= 3, `the ✦ is ${starRatio.toFixed(2)}:1 on ${worst} — 1.4.11 wants 3:1 for a graphic`);

  // NEGATIVE CONTROL — the arithmetic is real. The stop that shipped and had to be replaced fails
  // this very check, so a green run is not the calculator agreeing with itself.
  assert.ok(contrastRatio('#f0917c', twToken('teal700')) < 4.5, 'the rejected coral stop still fails, as measured');
  assert.ok(contrastRatio('#ffffff', '#000000') > 20, 'and the calculator agrees with the known extreme');
});

test('the facet pill stays visible on every IQ band wash — the border is the binary, not the fill', () => {
  /* ⚠ MEASURED, NOT ASSUMED (2026-08-12). `bg-teal50` is #EAF4F2 and `IQ_BAND_WASH['50']` is #EAF4F2
   * — BYTE-IDENTICAL, 1.000:1. Until the tags moved onto the verdict card that never mattered: the
   * pills lived on a dark teal slab. On a band-washed card an ON pill on a Solid-band rating is an
   * invisible chip, which is exactly the band in the screenshot that prompted the move. The fix was
   * to make the pill a filled-teal OUTLINE against a hairline-line outline, and to take the wash off
   * the card body so only the numeral's row carries it. This test is what stops a future palette
   * change silently re-merging them. */
  // `twToken` lower-cases; `IQ_BAND_WASH` is transcribed upper. Compare as colours, not as strings.
  assert.equal(
    twToken('teal50'),
    IQ_BAND_WASH['50'].toLowerCase(),
    'the collision is real — this is the premise of the whole test, not a typo',
  );
  for (const [band, wash] of Object.entries(IQ_BAND_WASH)) {
    // The BORDER is what has to survive, because the fill provably does not.
    assert.ok(
      contrastRatio(twToken('teal500'), wash) >= 1.6,
      `ON pill border on band ${band} (${wash}) is ${contrastRatio(twToken('teal500'), wash).toFixed(2)}:1`,
    );
    assert.ok(contrastRatio(twToken('teal700'), wash) >= 4.5, `ON pill text on band ${band}`);
    assert.ok(contrastRatio(twToken('ink600'), wash) >= 4.5, `OFF pill text on band ${band}`);
  }
});

test('the verdict card wears the band wash on the HERO ROW only, never behind the tags', () => {
  // The structural half of the contrast fix above: if the wash ever climbs back onto the <section>,
  // the pills are sitting on it again and the measurement test above stops describing the screen.
  const card = inventoryRegion(narrowCase(false));
  const cardTag = card.slice(0, card.indexOf('>') + 1);
  assert.ok(!/background-color/.test(cardTag), 'the card itself must not be washed');
  assert.match(cardTag, /bg-surface/, 'positive control: it paints a plain surface instead');

  // ⚠ INSPECTING THE OPENING TAG IS NOT ENOUGH, and the first draft of this test only did that
  // (review finding, 2026-08-12). A wash on ANY wrapper between the <section> and the tags puts the
  // pills back on a tinted ground, and the opening-tag slice cannot see it. So: find where the wash
  // actually is, and prove the tags are NOT inside it.
  const heroOpen = card.indexOf('<div class="flex items-center gap-5 rounded-t-xl px-5 py-4"');
  assert.ok(heroOpen >= 0, 'the hero row is not where this test thinks it is');
  const hero = outerHtmlFrom(card, heroOpen);
  assert.match(hero, /background-color:#/, 'positive control: this fixture is on a rated band, so a wash exists');
  assert.ok(!hero.includes('>Window</span>'), 'the tag strip must not be inside the washed row');
  assert.ok(!hero.includes('Refresh the ranking'), 'nor the controls');
  // ...and NOTHING ELSE in the card carries one. `background-color` appears exactly once.
  assert.equal(
    (card.match(/background-color/g) ?? []).length,
    1,
    'exactly one washed element on this card, and the assertions above prove it is the hero row',
  );
});

test('S6: the label survives a UA without background-clip:text — transparency is behind @supports', () => {
  /* `background-clip: text` + `color: transparent` is the whole shimmer, and the failure mode is
   * total: with no support the label is transparent over the fill and the PRIMARY control on the
   * screen has no visible text at all. The accessible name survives (it is an `aria-label`), which
   * makes this exactly the class of defect that ships green and is invisible to every test that
   * reads markup. The base rule therefore paints a solid, readable colour and only the @supports
   * arm makes it transparent. */
  const base = sparkRules().find((r) => r.includes('linear-gradient'));
  assert.ok(base !== undefined, 'the base rule is gone');
  assert.ok(!/(?:^|[^-])color:\s*transparent/.test(base), 'the BASE rule must not blank the label');
  assert.ok(!/text-fill-color:\s*transparent/.test(base), 'nor blank it through -webkit-text-fill-color');
  const fallback = base.match(/(?:^|[^-])color:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(fallback !== undefined, 'the base rule declares no fallback colour');
  const btn = skipControlOf(render(props('payer', fixture())));
  const to = btn?.match(/to-(teal\d+)/)?.[1];
  assert.ok(to !== undefined);
  assert.ok(
    contrastRatio(fallback, twToken(to)) >= 4.5,
    `the fallback colour ${fallback} must itself be readable on the fill`,
  );

  // ...and the transparency really is gated, on a condition that includes the -webkit- form, because
  // that is the only one Safari has ever supported.
  const supports = GLOBALS_CSS.match(/@supports \(([^{]*)\) \{\s*\.q-skip-spark[\s\S]*?\n\}/)?.[0];
  assert.ok(supports !== undefined, 'the transparency is not behind an @supports gate at all');
  assert.match(supports, /-webkit-background-clip:\s*text/, 'the gate must accept the -webkit- form');
  assert.match(supports, /(?:^|[^-])color:\s*transparent/m, 'and it is where transparency lives');
});

test('S6: the sparkle is decoration over a LIVE control — motion narrates, it never gates input', () => {
  const btn = skipControlOf(render(props('payer', fixture())));
  assert.ok(btn !== null, 'positive control: there is a control to interrogate');
  assert.match(btn, /^<button type="button"/, 'a plain button — never a submit inside a form it does not own');
  assert.ok(!/\bdisabled\b/.test(btn), 'never disabled: there is no in-flight state that should refuse a skip');
  assert.ok(!/aria-hidden/.test(btn), 'never hidden from AT');
  assert.ok(!/tabindex/.test(btn), 'reachable in DOM order, with no tabindex games');
  assert.ok(!/pointer-events/.test(btn), 'no pointer-events games on the control');
  // `pointer-events: none` is the one thing the badge idiom carries that WOULD gate input — the badge
  // is decoration sitting on a link; this is the control itself.
  const spark = GLOBALS_CSS.match(/\.q-skip-spark\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(spark.length > 0 && !/pointer-events/.test(spark), 'nor in the class that paints it');
  // It carries no motion hook of its own, so neither the tile stagger nor the facet reveal claims it.
  assert.ok(!/data-v3-tile|data-v3-facet/.test(btn), 'no motion hook on the control');
});

test('S6: the hoist cannot break the skip reveal — the stagger keys on the reveal scope, not the button', () => {
  // The reveal selects `[data-v3-facet]` inside the REVEAL SCOPE. The Skip lives ABOVE
  // `[data-v3-stage]`, so the target set is unchanged by construction — asserted from both ends
  // rather than argued, because "by construction" is exactly the claim that rots.
  //
  // ⚠ THE SCOPE IS NO LONGER UNCONDITIONALLY `stageEl` (2026-08-10). In Smoke-shell mode the answer
  // renders in the BOARD pane, outside `[data-v3-stage]` entirely, so scoping there found no answer
  // content and neither reveal ran. `revealScopeFor` makes the choice, and it is CALLED below rather
  // than read out of the source — the source match alone is the class of assertion that survived a
  // deleted guard once already (see makeRetryHandler's header).
  const ROOT = { id: 'root' };
  const STAGE = { id: 'stage' };
  assert.equal(revealScopeFor(false, ROOT, STAGE), STAGE, 'single-column: the stage subtree, unchanged');
  assert.equal(revealScopeFor(true, ROOT, STAGE), ROOT, 'shell: the root, because the answer is in the board');
  // Under the WIDER of the two scopes the hoisted Skip is in range; what keeps it out of the stagger
  // is that it carries no `data-v3-facet` hook at all, which the test above pins directly.
  const shell = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(shell, /toArray<HTMLElement>\('\[data-v3-facet\]', revealRoot\)/, 'the reveal is scoped to the derived root');
  // BOTH reveals, not only this one: the tile stagger is the other half of the same fix, and
  // reverting just it to `stageEl` would re-break shell-mode tiles under a fully green suite.
  assert.match(shell, /toArray<HTMLElement>\('\[data-v3-tile\]', revealRoot\)/, 'and so is the tile stagger');
  assert.match(shell, /const revealRoot = revealScopeFor\(shellMode, root, stageEl\)/, 'and that root is the derivation');
  assert.match(shell, /querySelector<HTMLElement>\('\[data-v3-stage\]'\)/, 'and stageEl is that subtree');
  // The ENTRANCE must NOT take the widened scope — it animates autoAlpha (visibility: hidden), which
  // over the shell root would hide the board, the composer and the watchers on every stage change.
  assert.match(shell, /gsap\.fromTo\(\s*stageEl,/, 'the entrance stays on the stage subtree');

  const html = render(
    props('answer', fixture(), {
      answer: answerProps({
        snapshot: allPayersSnapshot(),
        skipped: true,
        scopeSource: 'dominant',
        candidates: orderedCandidates(fixture()),
        narrowExpanded: true,
      }),
    }),
  );
  const stageHtml = outerHtmlFrom(html, html.lastIndexOf('<', html.indexOf('data-v3-stage')));
  const beats = html.match(/data-v3-facet/g)?.length ?? 0;
  assert.ok(beats >= 5, `the reveal needs its beats — found ${beats}`);
  assert.equal(stageHtml.match(/data-v3-facet/g)?.length, beats, 'every beat is inside the animated subtree');
  // ...and the landing screen of a Skip offers no Skip, so the hoisted control can neither add a beat
  // nor steal one from the stagger.
  assert.equal(skipControlOf(html), null, 'the skip reveal screen carries no Skip control');
});

test('S6: the Skip precedes the question — and the live region still announces the QUESTION', () => {
  for (const stage of ['payer', 'plan'] as const) {
    const html = render(props(stage, fixture(), stage === 'plan' ? { payerPick: 'Aetna' } : {}));
    const from = html.indexOf('aria-live="polite"');
    assert.ok(from >= 0, `${stage}: positive control — the single live region rendered`);
    const live = outerHtmlFrom(html, html.lastIndexOf('<p', from));
    assert.ok(live.length > 0 && /Pick/.test(live), `${stage}: something real is announced`);
    assert.ok(!/Skip|search all plans/i.test(live), `${stage}: the Skip is not announced as if it were the question`);
    // Tab order: the Skip comes FIRST, which is the point of the hoist. The consequence is that a
    // keyboard user reaches it by shift-tab from the heading the shell focuses on a stage swap —
    // the same relationship the receipt's "Change" buttons already have, one region up.
    assert.ok(
      html.indexOf('aria-label="Skip ') < html.indexOf(`id="qualify-s-${stage}-heading"`),
      `${stage}: the Skip precedes the question`,
    );
    assert.match(
      html,
      new RegExp(`id="qualify-s-${stage}-heading"[^>]*tabindex="-1"`),
      `${stage}: the shell's focus target still exists, so a stage swap still lands on the question`,
    );
  }
});

/** Each plan tile's `<form>`, sliced at its closing tag. */
function planTileForms(): string[] {
  const html = render(props('plan', fixture(), { payerPick: 'Aetna' }));
  const tiles = html.split('name="candidate"').slice(1);
  assert.equal(tiles.length, 2, 'positive control: two plan tiles under Aetna');
  return tiles.map((t) => t.slice(0, t.indexOf('</form>')));
}

test('S6: asking the AI about a plan no longer PICKS it — the Ask control is a button, not a submit', () => {
  // It was `type="submit"` with `onClick={onAskAi}` inside `<form action={planAction}>`: one press
  // fired `ai_armed` AND `plan_submitted`, so interrogating a plan committed to it — and the receipt
  // then recorded a "PLAN <employer>" decision the operator never made.
  for (const form of planTileForms()) {
    const ask = outerHtmlFrom(form, form.lastIndexOf('<button', form.indexOf('Ask AI about this plan')));
    assert.match(ask, /^<button type="button"/, 'the Ask control must not submit the form it sits inside');
    assert.ok(!/type="submit"/.test(ask));
    // Exactly ONE submit is left in the tile — the pick path — so the form has a single, unambiguous
    // default submission and there is no second candidate for implicit submission.
    assert.equal(form.match(/type="submit"/g)?.length, 1, 'one submit per tile: Use this plan');
  }
});

test('S6: the plan tile PICK PATH is byte-unchanged — split from the un-submit deliberately', () => {
  /* ⚠ SPLIT FROM THE TEST ABOVE (fix round 1). Both guards used to live in one test, so ONE deletion
   * removed the un-submit pin AND the byte pin on the path it must not disturb — and those are the
   * two halves of the S6 claim that only mean something when they are independent. */
  for (const [i, form] of planTileForms().entries()) {
    const use = outerHtmlFrom(form, form.lastIndexOf('<button', form.indexOf('Use this plan')));
    assert.match(
      use,
      /^<button type="submit" class="rounded-lg bg-teal700 px-2\.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-teal900 disabled:opacity-60">Use this plan<\/button>$/,
      `tile ${i}: the pick path is byte-unchanged`,
    );
    assert.match(form, /^ value="\d+"\/>/, `tile ${i}: the candidate index still rides the form as a hidden field`);
  }
});

test('S6 STRUCTURAL — the plan tile is still WIRED to its server action, which no render test can see', () => {
  /* ⚠ THE HALF renderToStaticMarkup IS BLIND TO, and it is the half the pick depends on. `action` on
   * a <form> takes a FUNCTION in React 19, and a function prop emits no attribute — so deleting
   * `action={props.planAction}` renders byte-identically to keeping it, ships the whole suite green,
   * and makes "Use this plan" silently do nothing. Every byte assertion in this file covers the
   * BUTTON; nothing covered the form. Same class of scan as the S5 STRUCTURAL test above, for the
   * same reason: a binding a hermetic renderer cannot observe has to be read at the source.
   *
   * Scoped to StagePlan's own body, so a form elsewhere in this 4,000-line module cannot satisfy it. */
  const src = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow.tsx', import.meta.url)),
    'utf8',
  );
  const at = src.indexOf('export function StagePlan');
  assert.ok(at >= 0, 'StagePlan is not in this module — the scan would be vacuous');
  // COMMENTS STRIPPED FIRST. The Ask-AI fix's own comment quotes `<form action={planAction}>`, so an
  // un-stripped scan counts prose ABOUT the binding as the binding — the exact confusion between a
  // description and the thing described that this whole branch keeps finding in one form or another.
  const body = src.slice(at, src.indexOf('\n// ── Stage 4', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(body.length > 0 && body.includes('name="candidate"'), 'positive control: this really is the tile body');
  const forms = [...body.matchAll(/<form\b/g)];
  assert.equal(forms.length, 1, 'one form per tile, one tile template — a second is a second pick path');
  assert.match(
    body.slice(forms[0]!.index ?? 0, (forms[0]!.index ?? 0) + 200),
    /<form\s+action=\{props\.planAction\}/,
    'the tile form must be bound to planAction, or picking a plan does nothing at all',
  );
  // ...and the prop it binds is really the one the root threads down, not a same-named local.
  assert.match(src, /planAction=\{props\.planAction\}/, 'the root threads its own planAction into the stage');
});

test('S6: arming the AI leaves the operator on the plan stage — and a later pick still auto-asks', () => {
  const r = fixture();
  const at = (s: { payerPick: string | null; picked: boolean; skipped: boolean }): FlowStage =>
    deriveStage({ resolution: r, payerPick: s.payerPick, picked: s.picked, skipped: s.skipped });

  const armed = ([{ type: 'payer_picked', payer: 'Aetna' }, { type: 'ai_armed' }] as ShellAction[]).reduce(
    shellReducer,
    INITIAL_SHELL_STATE,
  );
  assert.equal(armed.autoAsk, true, 'the ask is armed');
  assert.equal(armed.picked, false, 'and asking about a plan is NOT picking one');
  assert.equal(at(armed), 'plan', 'so the stage does not move');

  // Invariant (l) is unchanged by this fix and is the reason the two-press flow works at all:
  // `plan_submitted` deliberately does not disarm, so the answer stage's panel auto-asks on arrival.
  const after = shellReducer(armed, { type: 'plan_submitted' });
  assert.equal(after.autoAsk, true, 'invariant (l): plan_submitted deliberately does not disarm autoAsk');
  assert.equal(at(after), 'answer');
  // The three that DO disarm, unchanged. Coerced with `?? false` rather than compared to a literal
  // absence — an undefined field would satisfy `!== true` and prove nothing.
  for (const action of [{ type: 'ai_disarmed' }, { type: 'search_submitted' }, { type: 'went_back', target: 'plan' }] as ShellAction[]) {
    assert.equal(shellReducer(armed, action).autoAsk ?? false, false, `${action.type} disarms`);
  }
});

// ── FINAL FIX ROUND (2026-08-08) — the four Importants, and the minors that carry a claim ─────────
//
// Five-lens adversarial whole-branch review, each finding survived an independent refutation pass.
// What they share: a sentence, a guard or a coercion that is TRUE ON THE PATH IT WAS WRITTEN FOR and
// false on a neighbouring one nobody re-read. That is the same class this branch has been closing
// since S2-I1, which is why these are pinned rather than fixed quietly.

test('FF-I1 — a snapshot with NO memberCount renders no population claim, and no "undefined members"', () => {
  /* THE RENDER HALF of the `undefined !== null` trap — the fourth sighting on this branch. The pure
   * classifier is pinned in the ROOT suite (`test/qualifyBookLed.test.ts`, `memberBucketOf`), where
   * the module lives and where tsc is stricter; this is the consequence on the surface, which is what
   * makes it an Important rather than a tidy-up.
   *
   * Before the `?? null` coercion an ABSENT `memberCount` classified as `'many'`, and the 10+ arm
   * interpolates the count — so a pre-S2 cached snapshot printed the literal string "undefined" as a
   * number of people, in bold, above the ranking. `delete` rather than `memberCount: undefined`,
   * because an explicitly-undefined property is not the shape a JSON round-trip produces. */
  const noCount = { ...bookSnapshot() } as { memberCount?: number | null };
  delete noCount.memberCount;
  const html = answerHtml(noCount as unknown as QualifySnapshot);
  // POSITIVE CONTROL — the answer stage really rendered, so every negative below is about a screen.
  assert.match(html, /Where AETNA US HEALTHCARE pays|Facilities, ranked/, 'the answer stage rendered');
  assert.ok(!html.includes('undefined'), 'no "undefined" reaches the markup');
  assert.ok(!html.includes('A population'), 'an absent count is not a population');
  assert.ok(!html.includes('a paid claim behind this'), 'and it makes no preface claim at all');
  // The receipt gates on the same bucket, so it is silent too rather than crashing on `.toLocaleString`.
  const receipt = outerHtmlFrom(html, html.indexOf('<nav aria-label="Your search so far"'));
  assert.ok(!receipt.includes('member'), 'the receipt chip shares the silence rule, not just the words');
});

test('FF-I2 — the secondary cap sentence is true in BOTH states, not only when tier-0 leaves room', () => {
  /* THE SENTENCE THAT WAS FALSE WHEN THE CAP FILLED. "A facility with no open beds sorts to the end,
   * so it will be in the part not shown" is a claim about WHERE the full houses are, and it holds
   * only when the book has fewer than `QUALIFY_BOOK_PREVIEW` open facilities. With >= 8 open ones the
   * full houses are beyond the cap for a DIFFERENT reason (there are simply more than eight), and
   * with a full house inside the first eight it is false outright — asserted below, on a render.
   *
   * The replacement COUNTS instead of predicting: how many of the not-shown have no open beds. That
   * is a fact about this render in every state, including zero. */
  const bookOf = (states: readonly ('full' | 'open')[]) =>
    bookRegion(
      answerHtml(
        secondaryBookSnapshot({
          bookFacilities: states.map((s, i) =>
            facility({
              rank: i + 1,
              name: `BOOK FACILITY ${i + 1}`,
              facilityKey: `BF${i + 1}`,
              payerCount: 1,
              bedState: s,
              openBeds: s === 'full' ? 0 : 3,
              bedCapacity: 12,
            }),
          ),
        } as Partial<QualifySnapshot>),
      ),
    );
  // STATE 1 — the full houses really are beyond the cap. Nine facilities, the ninth full.
  const sunkBeyond = bookOf([...Array(8).fill('open'), 'full'] as ('full' | 'open')[]);
  assert.match(sunkBeyond, /Showing the 8 best-ranked of 9\./, 'the cap still states the REAL total');
  assert.match(sunkBeyond, /1 of the 1 not shown has no open beds\./);
  // STATE 2 — a full house INSIDE the first eight, which is where the old sentence was false outright.
  const sunkInside = bookOf(['full', ...Array(8).fill('open')] as ('full' | 'open')[]);
  assert.match(sunkInside, /Full · 0 of 12/, 'positive control: a full house really did render inside the cap');
  assert.match(sunkInside, /0 of the 1 not shown have no open beds\./);
  // The prediction is GONE from both — a sentence that is true on one render and false on the next is
  // not a weaker claim, it is an untrue one.
  for (const book of [sunkBeyond, sunkInside]) {
    assert.ok(!book.includes('sorts to the end, so it will be in the part not shown'), 'the false prediction is gone');
    // ...and the fact the prediction was reaching for is still stated, in a form that survives both.
    assert.match(book, /sorts below one that can admit today/);
  }
});

test('FF-I4 — the book basis lines state the FLOOR, so they cannot contradict the floor arm beside them', () => {
  /* THREE SURFACES CLAIMED "every facility {payer} paid at" WHILE THE BOOK APPLIES QUALIFY_MIN_LINES.
   * The book load runs `assembleFacilities(..., applyFloor = true)` (core.ts) and the member load does
   * not — which is exactly why this surface already has TWO sentences that say so out loud ("below the
   * volume floor for {payer} in this window", "clears the volume floor in the window shown"). Rendered
   * beside an unqualified "every facility", those two sentences contradict the heading above them.
   *
   * COMPOSED, not per-sentence: each half was independently defensible and it is only the pair on one
   * screen that is a lie, which is precisely the shape a per-surface review misses. */

  // COMPOSITION 1 — the BOOK-LED screen, where the member's own thin facility is named as dropped.
  const led = answerHtml(
    ledSnapshot({
      facilities: [
        facility({ rank: 1, name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH' }),
        facility({ rank: 2, name: 'TINY CLINIC', facilityKey: 'TINY', lineCount: 2, distinctPatients: 1 }),
      ],
    } as Partial<QualifySnapshot>),
  );
  assert.match(led, /below the volume floor for AETNA US HEALTHCARE in this window/, 'positive control: the floor arm speaks');
  assert.match(led, /every facility AETNA US HEALTHCARE paid at above the volume floor in the window shown/);
  assert.ok(
    !led.includes('paid at in the window shown'),
    'the unqualified promise cannot stand on a screen that names a facility the floor dropped',
  );

  // COMPOSITION 2 — the SECONDARY screen with an EMPTY book: "0 facilities — every facility AETNA
  // paid at" beside "no facility clears the volume floor" was the same contradiction, inverted.
  const empty = bookRegion(answerHtml(secondaryBookSnapshot({ bookFacilities: [] } as Partial<QualifySnapshot>)));
  assert.match(empty, /clears the volume floor in the window shown/, 'positive control: the empty-book arm speaks');
  assert.match(empty, /every facility AETNA US HEALTHCARE paid at above the volume floor in this window/);
  assert.ok(!empty.includes('paid at in this window'), 'and the unqualified form is gone from the secondary section too');

  // COMPOSITION 3 — the SKIP banner's book-led arm, the third site carrying the phrase.
  const skipped = answerHtml(ledSnapshot(), { skipped: true, scopeSource: 'dominant' });
  assert.match(skipped, /every facility that label paid at above the volume floor in this window/);
  assert.ok(!skipped.includes('every facility that label paid at in this window'));
});

test('FF-m4 — the sr-only classification waits on ALL THREE stale states, exactly like the visible line', () => {
  /* THE ARIA CHANNEL MUST NEVER SAY WHAT THE VISIBLE CHANNEL SUPPRESSES. The visible preface is gated
   * on `stale` = refetching || staleAfterError || refreshing; the sr-only classification was gated on
   * the first two only, so a same-scope REFRESH left a screen-reader user hearing a classification the
   * sighted reader could not see — and hearing it with no dim and no beam to mark it as provisional. */
  const spokenOf = (html: string) => outerHtmlFrom(html, html.indexOf('<p aria-live="polite"'));
  /* ⚠ THE VISIBLE CHANNEL IS THE PAGE **MINUS** THE LIVE REGION. Both channels carry the same bytes by
   * design (one call to `memberPrefaceFor`), so an unscoped `!html.includes(...)` is satisfied — or
   * defeated — by whichever channel happens still to be speaking. Measured: it reported the VISIBLE
   * line as unsuppressed on `refreshing` when the visible line was correctly absent and the sr-only
   * one was not, i.e. it named the wrong channel as the defect. Separate them or assert nothing. */
  const visibleOf = (html: string) => html.replace(spokenOf(html), '');
  // POSITIVE CONTROL — idle, both channels carry it. Otherwise every negative below is vacuous.
  const idle = answerHtml(bookSnapshot());
  assert.match(visibleOf(idle), /One member has a paid claim behind this search/, 'the visible line is there when idle');
  assert.match(spokenOf(idle), /One member has a paid claim behind this search/, 'and so is the spoken one');
  for (const flag of ['refetching', 'staleAfterError', 'refreshing'] as const) {
    const html = answerHtml(bookSnapshot(), { [flag]: true });
    assert.ok(
      !visibleOf(html).includes('a paid claim behind this search'),
      `the visible line waits on ${flag}`,
    );
    assert.ok(
      !spokenOf(html).includes('a paid claim behind this search'),
      `and the spoken one waits on ${flag} — an aria channel outliving the seen claim is the disagreement`,
    );
  }
});

test('FF-m6 — the receipt chip’s accessible name states its BASIS, like the preface it sits beside', () => {
  /* "N members match this search" is the EXACT mixed-basis wording S2-I1 removed from the visible
   * preface: `memberCount` is the ladder's 365-day rung filtered on `payment_received`, so it means
   * "members with a PAID CLAIM in the last 12 months" and never "members who exist". The visible copy
   * was fixed and the aria-label kept the retired sentence — the one channel a browser pass cannot
   * see. One derivation, three surfaces is only true if the BASIS is shared too, not just the number. */
  const receiptOf = (snap: QualifySnapshot) => {
    const html = answerHtml(snap);
    return outerHtmlFrom(html, html.indexOf('<nav aria-label="Your search so far"'));
  };
  const few = receiptOf(bookSnapshot({ memberCount: 4 }));
  assert.match(few, /aria-label="4 members with a paid claim in the last 12 months"/);
  const one = receiptOf(bookSnapshot());
  assert.match(one, /aria-label="1 member with a paid claim in the last 12 months"/);
  for (const receipt of [few, one]) {
    assert.ok(!receipt.includes('match this search'), 'the retired mixed-basis wording is gone from the aria channel');
    /* ⚠ AND IT IS NOT THE PREFACE'S SENTENCE EITHER. The receipt is exempt from the in-flight
     * suppression (it is a trail of decisions, not a claim about the ranking), so borrowing the
     * preface's "behind this search" clause would put the suppressed words on screen during a
     * re-scope through the one surface the rule does not cover. Same basis, different sentence. */
    assert.ok(!receipt.includes('behind this search'), 'it states the basis without borrowing the suppressed sentence');
  }
  // The suppression the wording protects, asserted where it matters: mid-refetch the preface is gone
  // from BOTH channels and the receipt still carries its number.
  const inFlight = answerHtml(bookSnapshot({ memberCount: 4 }), { refetching: true });
  assert.ok(!inFlight.includes('a paid claim behind this'), 'the preface is suppressed');
  assert.match(inFlight, /aria-label="4 members with a paid claim in the last 12 months"/, 'the receipt is not');
});

test('FF-m7 — the book-led skip trace names the payer ONCE', () => {
  /* `rankingBasis` already opens with "{payer}'s whole book" and `skipUnder` appended " under
   * {payer}" behind it, so the trace row read "… AETNA US HEALTHCARE's whole book, with this
   * identifier's own history marked on it under AETNA US HEALTHCARE". Both halves true; together,
   * a sentence that reads as two different scopes. */
  const html = answerHtml(ledSnapshot(), { skipped: true, scopeSource: 'dominant' });
  const trace = html.slice(html.indexOf('no plan chosen · AETNA'));
  assert.ok(trace.length > 0, 'positive control: the book-led ranking trace really rendered');
  const row = trace.slice(0, trace.indexOf('<'));
  assert.match(row, /whole book, with this identifier&#x27;s own history marked on it/, 'the basis is unchanged');
  assert.equal(
    row.split('AETNA US HEALTHCARE').length - 1,
    1,
    `the payer is named once in the trace row, not twice: ${row}`,
  );
});

test('FF-m8 — the 2-9 preface names an action available on the stage it renders on', () => {
  /* "Continue to search across all of them" named the SKIP — a control that lives on the carrier and
   * plan stages and does not exist on the ANSWER stage, which is the only stage this sentence renders
   * on. And the same string is announced by `liveSentenceFor`'s SKIPPED arm, which returns BEFORE
   * every stage check, so it can also be heard over the identify screen. So the replacement names no
   * POSITION and no stage-local control — only the search itself, which is true anywhere. The exact
   * string is pinned in the ROOT suite beside the module; this pins that the SURFACE renders it. */
  const html = answerHtml(bookSnapshot({ memberCount: 4 }));
  assert.match(html, /This search covers all of them — refine the prefix to narrow it to one\./);
  assert.ok(!html.includes('Continue to search across all of them'), 'no Continue control exists on this stage');
});

// ── THE RECEIPT MERGE — the shell states its progress ONCE ───────────────────────────────────────
//
// #194 shipped `LaneReceipt` beside `FlowReceipt` and deferred the dedup, so shell mode listed the
// same four decisions twice: a checklist, and the chip row 40px below it. `FlowReceipt` is now gated
// off in shell mode and `LaneReceipt` carries what it carried.
//
// These two tests are a PAIR and neither is redundant. The first pins the merge; the SECOND pins that
// the single-column path was not touched — the whole safety argument for the change is that
// `showLaneReceipt` is optional, so a non-shell render passes `undefined` and keeps the shipped
// condition. Without the mirror, deleting the chip row outright would still pass the first.

test('shell mode renders exactly one receipt — the checklist, not the chip row', () => {
  const html = render(props('answer', fixture(), { showLaneReceipt: true, answer: answerProps() }));
  assert.ok(
    !html.includes('aria-label="Your search so far"'),
    'the chip row must be gone in shell mode — two receipts is the defect this closes',
  );
  assert.match(html, /data-testid="qualify-lane-receipt"/, 'and the checklist must be the one that stays');
  // The record survives the merge: the questions are still on screen, not just the chips' labels.
  assert.match(html, /who are we looking at/);
});

test('the single-column layout still renders the chip row, untouched', () => {
  // `showLaneReceipt` omitted — exactly what the non-shell path passes. This is the assertion that
  // makes the gate safe: `undefined !== true`, so the condition is the one that shipped.
  const html = render(props('answer', fixture(), { answer: answerProps() }));
  assert.match(html, /aria-label="Your search so far"/, 'the chip row is what QUALIFY_SMOKE_SHELL=off ships');
  assert.ok(!html.includes('data-testid="qualify-lane-receipt"'), 'and the checklist stays shell-only');
});

// ── THE AI PANEL'S ONE MOUNT (2026-08-12) ────────────────────────────────────────────────────────
// Source-read rather than render-asserted, and that is forced: `<QualifyAiPanel>` reaches the
// `'use server'` chain (gate → cookies → DB), so no hermetic test can render the shell that mounts
// it. The same hole is why bookPlacement.ts, aiPayload.ts, externalAsk.ts and scrollPort.ts exist as
// separate pure modules — see bookPlacement.ts's header for the regression that taught it.
test('the AI panel mounts in the RAIL in shell mode and in the STAGE in single-column — never both', () => {
  const shell = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url)),
    'utf8',
  );
  // ⚠ ONE CONSTRUCTION. `autoAskedRef` and `externalConsumedRef` are per-INSTANCE, so a second panel
  // element in this file is a second instance firing its own audited, BILLED model call per arm —
  // and the audit row is written BEFORE the stream, so cancelling one does not undo it.
  // Matched on the OPENING TAG FOLLOWED BY A NEWLINE (the multi-line JSX form), not on the bare
  // identifier: prose in this file legitimately names the component, and a count that a comment can
  // trip is a count that gets deleted the first time it cries wolf.
  // ⚠ COUNTED TWO WAYS, because either one alone is escapable (review finding, 2026-08-12): the
  // newline form misses a single-line `<QualifyAiPanel snapshot={s} … />`, and a bare identifier
  // count trips on the prose in this file's own comments. `<QualifyAiPanel` followed by whitespace
  // or `/` or `>` is a construction in every JSX formatting; subtracting the backticked comment
  // form is what keeps it honest.
  const constructions = (shell.match(/<QualifyAiPanel[\s/>]/g) ?? []).length;
  const inProse = (shell.match(/`<QualifyAiPanel>`/g) ?? []).length;
  assert.equal(constructions - inProse, 1, 'two constructions are two billed calls per arm');
  assert.match(shell, /aiPanel: shellMode \? null : aiPanelNode,/, 'the board slot is empty in shell mode');
  assert.match(shell, /\{aiPanelNode\}\n\s*<\/LaneRail>/, 'and the rail is where it renders');
  // The single-column path still fills the slot, and StageAnswer still has somewhere to put it.
  const flow = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow.tsx', import.meta.url)),
    'utf8',
  );
  assert.equal(flow.split('{props.aiPanel}').length - 1, 1, 'exactly one render site for the slot');
});

// ── THE RAIL IS THE ONE INNER SCROLLER, AND GSAP KNOWS (2026-08-12) ──────────────────────────────
// `scroll` does not bubble from an overflow div to window. A ScrollTrigger over a rail tile that
// still uses the default window scroller leaves that tile at `autoAlpha: 0` — `visibility: hidden`,
// genuinely unclickable and out of the accessibility tree — with nothing thrown and nothing logged.
// Source-read for the same reason as above: this effect needs a real layout, which jsdom has not.
test('the rail scroller is marked, and both ScrollTriggers over it are re-pointed at it', () => {
  const rail = readFileSync(
    fileURLToPath(new URL('../components/qualify/shell/lane-rail.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(rail, /data-v3-rail-scroll className="min-h-0 flex-1 overflow-y-auto/,
    'the marker must sit on the overflow div itself, not the outer box');
  // The cap is what makes that overflow live at all; without it `flex-1` resolves to content height.
  assert.match(rail, /xl:sticky xl:top-4 xl:max-h-\[calc\(100dvh-6rem\)\]/, 'sticky + capped, xl-only');
  // ⚠ EVERY STICKY/CAP CLASS MUST BE `xl:`-GUARDED. Below 1280px the grid is one column and the rail
  // PRECEDES the board in source order, so an unguarded full-height sticky rail buries it entirely.
  // Read off the root element's own class list, so an unguarded class cannot hide in a child.
  const rootClasses = rail.match(/className="(flex min-h-0 flex-col[^"]*)"/)?.[1];
  assert.ok(rootClasses !== undefined, "the rail's root className is not where this test thinks it is");
  for (const cls of rootClasses.split(/\s+/)) {
    if (/^(sticky|top-\d|max-h-)/.test(cls)) {
      assert.fail(`\`${cls}\` is unguarded — below xl it buries the board. Write it as \`xl:${cls}\`.`);
    }
  }

  const client = readFileSync(
    fileURLToPath(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(client, /querySelector<HTMLElement>\('\[data-v3-rail-scroll\]'\)/, 'the client looks the scroller up');
  assert.match(client, /railScroll\.contains\(t\)/, 'and splits the tile batch on containment');
  assert.match(client, /revealBatch\(railTiles, railScroll \?\? undefined\)/, 'the rail batch gets the rail scroller');
  assert.match(client, /revealBatch\(boardTiles, undefined\)/, 'the board batch keeps the document scroller');
  assert.match(client, /railScroll\.contains\(grid\) \? \{ scroller: railScroll \} : \{\}/,
    'and the plan-grid sticky trigger is re-pointed the same way');

  // ⚠ THE TWO GUARDS THAT STOP THIS BEING A BUG BELOW 1280px, and both are load-bearing. The cap is
  // `xl:`-gated while the marker and `overflow-y-auto` are not, so below that breakpoint the box
  // declares a scroll overflow and cannot scroll. Handing it to ScrollTrigger anyway strands every
  // tile past 88% of the rail's content height at `autoAlpha: 0` — visibility:hidden, unclickable,
  // out of the a11y tree, nothing thrown. Caught in review before it shipped; pinned so it stays.
  assert.match(client, /isLiveScrollPort\(\{/, 'marker presence is not scrollability — the client must probe');
  assert.match(client, /scrollHeight: railEl\.scrollHeight,\n\s*clientHeight: railEl\.clientHeight,/,
    'and the probe must feed it the real measurements');
  assert.ok(
    !/scroller: railScroll[\s\S]{0,40}start: 'top 88%'/.test(client),
    'an unclamped start on a rail scroller is the stranding bug',
  );
  assert.match(client, /start: 'clamp\(top 88%\)'/,
    "GSAP only clamps a start to max scroll in the opt-in `clamp(...)` form — belt-and-braces over the probe");
  // ⚠ THE SCOPE STAYS UNIFIED. Only the SCROLLER became per-pane; `revealScopeFor` is untouched, so
  // this is not a regression back to the 2026-08-10 bug where the board's tiles were never reached.
  assert.match(client, /const revealRoot = revealScopeFor\(shellMode, root, stageEl\);/);
});

// ── NO WIDE-VIEWPORT ASSUMPTION MAY APPLY AT EVERY WIDTH (2026-08-12) ────────────────────────────
// The rail is 416px ONLY at `xl`; below 1280px the shell grid is `grid-cols-1` and the rail is FULL
// WIDTH. Two separate defects came from forgetting that in one change — the ScrollTrigger scroller
// (above) and the chip grid (here) — so the rule gets its own guard rather than one more comment.
// `shellMode` is a SERVER boolean: it says WHICH SHELL, never HOW WIDE. Anything it gates that is
// really about the rail's 416px must carry an `xl:` of its own.
test('the rail-width assumptions are xl-gated — shellMode says which shell, not how wide', () => {
  const panel = readFileSync(
    fileURLToPath(new URL('../components/qualify/qualify-ai-panel.tsx', import.meta.url)),
    'utf8',
  );
  // The dense chip grid must keep the full-width breakpoints AND add the xl collapse — not replace
  // them. A bare `grid-cols-1` under `dense` stacks full-sentence chips in one ~976px column on
  // every viewport under 1280px, which is what shipped in the first draft.
  assert.match(
    panel,
    /dense\s*\n?\s*\?\s*'grid grid-cols-1 gap-2 p-3\.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1'/,
    'dense must collapse at xl only, and keep sm:/lg: for the full-width rail below it',
  );
  // The non-dense arm — the v2 tab — stays byte-identical. `dense` defaults false, so a regression
  // here silently changes a surface this change never touched.
  assert.match(panel, /:\s*'grid grid-cols-1 gap-2 p-3\.5 sm:grid-cols-2 lg:grid-cols-3'/,
    'the v2 tab keeps the three-column strip it has always had');

  // And the shared width cap on the slot chip was NOT relaxed: 208px fits a 416px rail, and
  // un-pinning it would have widened the full-width v2 tab ~2.4x. Withdrawn in review; pinned here.
  const chip = readFileSync(
    fileURLToPath(new URL('../components/qualify/slot-chip.tsx', import.meta.url)),
    'utf8',
  );
  // ⚠ READ THE CLASS LISTS, NOT THE FILE. The withdrawal is recorded in a comment that necessarily
  // names `max-w-full`, so a whole-file negative fails on the very note explaining why it must not
  // be there. Second time this exact shape bit in one change (see the panel-mount count above):
  // when a guard's needle is a word the surrounding prose legitimately uses, scope it to the code.
  const chipClasses = [...chip.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);
  assert.ok(
    chipClasses.some((c) => c.includes('max-w-[13rem]') && c.includes('truncate')),
    'the 13rem truncation cap stays',
  );
  assert.ok(
    !chipClasses.some((c) => c.includes('max-w-full')),
    'relaxing it widens the v2 tab, which this change must not touch',
  );
});
