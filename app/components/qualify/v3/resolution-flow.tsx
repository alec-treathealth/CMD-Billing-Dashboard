'use client';

/**
 * Qualify v3 — the STAGED resolution flow. One question per screen.
 *
 * THE PATTERN (docs/qualify-v3-search-pattern.md, ratified 2026-08-06):
 *   1 · Identify  — who are we looking at?           one input, nothing else
 *   2 · Payer     — which carrier is on the card?    one tile per carrier, user picks
 *   3 · Plan      — which plan is it?                every policy possibility under that carrier,
 *                                                     type-to-narrow, user picks — or asks the AI
 *   4 · Answer    — does this payer pay us, where?   rating hero + ranked scorecard + AI chips;
 *                                                     every system decision disclosed in one line
 *
 * Completed stages collapse into a RECEIPT strip; each entry is revisitable. This replaces the v2
 * everything-at-once tab, whose wall of simultaneous panels is the complaint this file answers
 * ("this UI is way too saturated … resolve to a payer, the user should be able to pick an employer").
 *
 * ── A11Y IS ACCEPTANCE CRITERIA, NOT POLISH (I9 — asserted in app/test/qualifyV3Flow.test.tsx) ──
 *   · The flow is a landmark; the active stage is a <section> with an <h2> that IS the question.
 *   · ONE aria-live="polite" region announcing stage changes as full sentences.
 *   · No meaning-bearing text below 12px. Completion/selection/severity carry WORDS, not hue alone.
 *   · Bare numerals get accessible names ("312 members on this plan", "rating 45 out of 100").
 *   · Native forms and controls; tab order is DOM order; no positive tabindex.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────────────────────────
 * THE FORMS POST, THEY DO NOT GET — a GET would put the typed identifier in the query string
 * (history, Referer, edge logs). The raw term lives in the client shell's ref (JS memory, the
 * IdentityForm discipline) and is injected into FormData at dispatch — it is NEVER rendered into
 * the DOM as a hidden field, so not even the DOM round-trips a full member id. `employerLabel` is
 * display-only (employer_name is PHI in app/lib/phi.ts): never a URL, never a log, never the model
 * prompt. Everything rendered here is counts, enums, names and dates — no dollar field exists in
 * `QualifyResolution` by construction, so blind and sighted roles receive identical bytes.
 */
// useMemo only — no useEffect/useLayoutEffect and no browser API, so this module stays renderable
// by renderToStaticMarkup in the hermetic suite. The memos matter: facetsOf + filterCandidates walk
// the whole candidate universe (311 plans on a real prefix) and would otherwise re-run on every
// render of the answer stage.
// ⚠ ONE CHILD DOES CARRY EFFECTS: `MultiSelectTagPicker` (the shared employer type-ahead) runs a
// `useEffect` that touches `document` for Escape/outside-click dismissal. That is still SSR-safe —
// renderToStaticMarkup never runs effects — and the picker owns its own typed draft, which is why
// this file no longer threads an employer query prop. The rule above is about THIS module; do not
// read it as a ban on mounting a client control.
import { useMemo } from 'react';
import { Briefcase, ChevronRight, Building2 } from 'lucide-react';
import { MultiSelectTagPicker } from '../../ui/multi-select-tag-picker';
// S4 — the facility grid narrow's set operations, PURE and unit-tested next door. Nothing here
// reaches a request; see flow-state.ts invariant (m) and `FacilityNarrowLine` below.
import {
  andList,
  facilitiesElsewhere,
  facilityCount,
  facilityDisplayNames,
  facilityNarrowKeys,
  narrowByFacility,
  offerableFacilityOptions,
  picksWithRows,
  type QualifyFacilityNarrowOption,
} from '../../../lib/qualify/facilityVariants';
import type {
  CoverageGroupSummary,
  QualifyResolution,
} from '../../../lib/qualify/resolution';
import type {
  QualifyFacility,
  QualifySnapshot,
  QualifyTrailingDays,
} from '../../../lib/qualify/contract';
// "Give me THE label, or null" — refuses a name the scope contradicts, so a wider ranking can never
// be captioned with one payer's. Used by the book section's heading, which names whose book it is.
import { EMPTY_FACILITIES, scopedPayerOf } from '../../../lib/qualify/contract';
/* THE TWO BOOK PREDICATES NOW LIVE IN A PLAIN LIB MODULE and are RE-EXPORTED here (S3 fix round 1).
 * They moved because the placement they feed — and the AI caption that placement chooses — sat in
 * two `'use client'` files nothing hermetic can import, so inverting the derivation shipped a full
 * green gate. Re-exported rather than relocated-and-rewritten so every existing import of
 * `bookIsOnScreen` / `bookLeadsAnswer` from this module keeps reading the SAME functions: one
 * definition, two import paths, never two definitions. */
export { bookIsOnScreen, bookLeadsAnswer } from '../../../lib/qualify/bookPlacement';
import { bookIsOnScreen, bookLeadsAnswer } from '../../../lib/qualify/bookPlacement';
import { derivePolicyRating } from '../../../lib/qualify/policyRating';
// The ladder's own stopping threshold. The window-move notice NAMES it rather than typing "10", so
// the sentence cannot outlive the constant it describes.
import { QUALIFY_RATING_CONFIDENT_PATIENTS } from '../../../lib/qualify/sampleGate';
// The preface's ONE derivation — shared by the visible line, the receipt and the aria announcement,
// so the seen claim and the spoken claim cannot be two expressions that merely happen to agree.
import {
  memberBucketOf,
  memberHistoryChipFor,
  memberPrefaceFor,
  prefaceNamesFacilityCount,
} from '../../../lib/qualify/memberPreface';
// The scope claim's ONE home — shared with the AI panel so the two cannot phrase it differently.
import { ALL_PAYERS_LABEL } from '../../../lib/qualify/scopeLabel';
import { IQ_BAND_LABELS, IQ_BAND_VERDICTS } from '../../../lib/qualify/ratingV2';
import { clusterCarriers, type CarrierCluster } from '../../../lib/qualify/carrierCluster';
// ⚠ A DESKTOP MODULE IMPORTING FROM `m/`, ON PURPOSE. `deriveAreaChips` / `facilitiesInArea` /
// `areaKeyFor` are the only geographic filter Qualify has ever shipped (mobile, d4776af) and they
// already encode the rule that matters here: an unmapped facility buckets under 'Other' and is NEVER
// dropped. Copying them into `v3/` would give the two surfaces two chances to disagree about what a
// null state means — and the mobile file is pure, `'use client'`-safe, and imports only a type from
// `contract.ts`, so there is nothing to pay for taking it. Only the PURE helpers cross over; the
// mobile `<AreaChips>` component does not — it carries the PWA's inline-style vocabulary, and these
// chips are rendered in the desktop control idiom below.
import {
  AREA_ALL,
  AREA_OTHER,
  areaKeyFor,
  deriveAreaChips,
  facilitiesInArea,
  type AreaChip,
} from '../m/area-chips';
import { IQ_BAND_HEX, IQ_BAND_WASH, QUALIFY_PALETTE } from '../tokens';

// ── Pure derivations (exported for the shell and the tests) ─────────────────────────────────────

export type FlowStage = 'identify' | 'payer' | 'plan' | 'answer';

/** Non-PHI copy for the three states a search can fail in, kept distinct on purpose (I5). */
export const UNRESOLVABLE_COPY: Readonly<Record<'empty' | 'prefix_too_short' | 'no_match', string>> = {
  // Deliberately NOT offering a facility-name search: classifyQualifyHandle reads only
  // prefix/member-id, so promising one (as an earlier version did) sent "NASHVILLE" down the
  // member-id blind index and reported a confusing no-match (review, Important 5).
  empty: 'Enter a member ID prefix or a full member ID to begin.',
  prefix_too_short:
    'A prefix needs at least 3 characters to look up. Two characters cannot be matched — this is not the same as finding nothing.',
  no_match: 'That identifier does not match any plan we have coverage or claims for.',
};

/** One candidate with its ORIGINAL index (the value the Server Action's `candidate` field wants). */
export interface OrderedCandidate {
  index: number;
  chosen: boolean;
  canonicalPayerId: string | null;
  payerDisplayName: string;
  employerLabel: string | null;
  funding: 'Self-Funded' | 'Fully Insured' | null;
  planType: string | null;
  memberCount: number;
  hasClaimEvidence: boolean;
}

/**
 * The candidate list in RANK order. The chosen group and the rejected summaries arrive separately;
 * reinserting the chosen one at its own index restores the original ranking, so the list never
 * re-orders under the user's pick (the "searching randomness" complaint).
 */
export function orderedCandidates(r: QualifyResolution): OrderedCandidate[] {
  const chosenIdx = r.candidates.chosenIndex;
  const out: OrderedCandidate[] = r.candidates.rejected.map((s: CoverageGroupSummary, i: number) => ({
    // Inverse of `groups.filter((_, i) => i !== chosenIndex)`: rows at/past the chosen position
    // shifted up by one in the filtered array, so add it back.
    index: i + (i >= chosenIdx ? 1 : 0),
    chosen: false,
    canonicalPayerId: s.canonicalPayerId,
    payerDisplayName: s.payerDisplayName,
    employerLabel: s.employerLabel,
    funding: s.funding,
    planType: s.planType,
    memberCount: s.memberCount,
    hasClaimEvidence: s.hasClaimEvidence,
  }));
  out.push({
    index: chosenIdx,
    chosen: true,
    canonicalPayerId: r.group.canonicalPayerId,
    payerDisplayName: r.group.payerDisplayName,
    employerLabel: r.group.employerLabel,
    funding: r.group.funding,
    planType: r.group.planType,
    memberCount: r.group.memberCount,
    hasClaimEvidence: r.group.claimEvidence.lines > 0,
  });
  return out.sort((a, b) => a.index - b.index);
}

/** One carrier tile: a CLUSTER of spellings that are the same payer (carrierCluster.ts), with the
 *  exact display names folded in — the plan stage filters candidates by membership in `names`. */
export interface PayerGroup {
  payer: string;
  /** Every raw payerDisplayName folded into this tile. Membership test for the plan stage. */
  names: ReadonlySet<string>;
  /** Spellings other than the label — VOBs are hand-typed by different people, so one payer
   *  arrives spelled a dozen ways; the tile says how many it absorbed. */
  otherSpellings: string[];
  unmapped: boolean;
  memberCount: number;
  planCount: number;
  hasClaimEvidence: boolean;
}

export function payerGroupsOf(r: QualifyResolution): PayerGroup[] {
  // First fold identical display names (a payer can appear as several plan candidates)…
  interface NameGroup {
    payer: string;
    canonicalPayerId: string | null;
    members: number;
    planCount: number;
    hasClaimEvidence: boolean;
    allUnmapped: boolean;
  }
  const byName = new Map<string, NameGroup>();
  for (const c of orderedCandidates(r)) {
    const g = byName.get(c.payerDisplayName) ?? {
      payer: c.payerDisplayName,
      canonicalPayerId: null,
      members: 0,
      planCount: 0,
      hasClaimEvidence: false,
      allUnmapped: true,
    };
    g.canonicalPayerId = g.canonicalPayerId ?? c.canonicalPayerId;
    g.members += c.memberCount;
    g.planCount += 1;
    g.hasClaimEvidence = g.hasClaimEvidence || c.hasClaimEvidence;
    g.allUnmapped = g.allUnmapped && c.canonicalPayerId === null;
    byName.set(c.payerDisplayName, g);
  }
  // …then cluster the names themselves: VOBs are manually entered by different people, so the same
  // carrier arrives spelled a dozen ways ("ANTHEM BCBS OF CA", "Anthem Blue Cross of California",
  // two typos of CALIFORNIA, …). The crosswalk's ruling outranks text similarity inside
  // clusterCarriers — two confirmed-but-different payers never merge.
  const clusters: CarrierCluster<NameGroup & { name: string }>[] = clusterCarriers(
    [...byName.values()].map((g) => ({ ...g, name: g.payer })),
  );
  return clusters.map((cl) => ({
    payer: cl.label,
    names: new Set(cl.members.map((m) => m.payer)),
    otherSpellings: cl.otherSpellings,
    unmapped: cl.members.every((m) => m.allUnmapped),
    memberCount: cl.members.reduce((s, m) => s + m.members, 0),
    planCount: cl.members.reduce((s, m) => s + m.planCount, 0),
    hasClaimEvidence: cl.members.some((m) => m.hasClaimEvidence),
  }));
}

/**
 * Which stage the flow is on. PURE — the shell owns `payerPick` (client-side carrier choice) and
 * `picked` (the user submitted a plan). A sole candidate skips straight to the answer; a single
 * carrier skips the payer stage. Skipped stages are STATED on the answer stage's disclosure, never
 * silent (deriveNotices already emits `sole_candidate`).
 *
 * `skipped` is the user's OWN escape hatch (the Skip button on either narrowing stage): jump to the
 * answer without choosing a carrier or a plan, and browse the identifier's whole footprint with the
 * answer stage's filter lines instead. It is deliberately a separate input from `picked` — "I chose
 * this plan" and "I declined to choose" must never render as the same claim.
 *
 * `payerGroups` is the shell's memoized cluster set (ONE `payerGroupsOf` call per resolution, shared
 * with the rail, the receipt, both tile stages and the live sentence). Omitting it self-derives, so
 * this stays callable from a test with a resolution alone — but when the shell supplies it, the
 * stage machine and the rail are provably reading ONE value rather than two that happen to agree.
 */
export function deriveStage(args: {
  resolution: QualifyResolution | null;
  payerPick: string | null;
  picked: boolean;
  skipped?: boolean;
  /** Optional pre-computed clusters (the shell memoizes one call per resolution). */
  payerGroups?: PayerGroup[];
}): FlowStage {
  const r = args.resolution;
  if (!r) return 'identify';
  if (args.skipped) return 'answer';
  if (r.candidates.total <= 1) return 'answer';
  if (args.picked) return 'answer';
  if ((args.payerGroups ?? payerGroupsOf(r)).length > 1 && args.payerPick === null) return 'payer';
  return 'plan';
}

/**
 * WHO CHOSE THE PAYER LABEL THE RANKING IS SCOPED TO. Three values, one question — and deliberately
 * NOT a fourth value for "the user skipped the plan questions".
 *
 * ⚠ THIS ENUM ONCE CARRIED A 'skipped' MEMBER, AND THAT COLLAPSE WAS A LIVE SCOPE-LIE.
 * "Who chose the payer label" and "was a plan chosen at all" are INDEPENDENT claims, and folding
 * them into one enum forces a precedence between them that no ranking can be honest about. It
 * ranked 'user' above 'skipped', so one press on a BILLED UNDER chip after a Skip — a legitimate
 * re-scope, which really does make the label the user's own — flipped the value to 'user' and, with
 * it, every presentation guard that read skip-ness off this enum: the receipt reverted to
 * "CARRIER … · PLAN …", the identity line printed the declined plan's policy bits, and the
 * resolve-time notices about that plan came back. A genuine plan pick plus one chip press rendered
 * BYTE-IDENTICALLY, so the surface could not distinguish "picked, then re-scoped" from "declined to
 * pick, then re-scoped". Re-ordering the ternary would only move the lie onto whichever claim lost
 * the tie. `skipped` therefore travels as its OWN prop, sourced from the reducer field that pins the
 * answer stage (`flow-state.ts`, invariants g/h: only a plan pick or a step back un-skips).
 */
export type ScopeSource = 'user' | 'pick' | 'dominant';

/**
 * PURE, and exported for the same reason `deriveStage` is: the shell's derivation and the tests'
 * must be one expression, not two that happen to agree. `pickLabel` is the pick→ranking bridge the
 * shell computes (the chosen group's own claims label, suppressed after a Skip — see the shell).
 */
export function scopeSourceOf(args: { payerOverride: string | null; pickLabel: string | null }): ScopeSource {
  if (args.payerOverride !== null) return 'user';
  if (args.pickLabel !== null) return 'pick';
  return 'dominant';
}

// ── Answer-stage filters (the general-search escape hatch) ───────────────────────────────────────

/**
 * Multiselect narrows on the answer stage. Empty array = no restriction on that facet.
 *
 * ⚠ THERE IS NO `planTypes` HERE ANY MORE, AND ITS ABSENCE IS THE POINT (Alec, 2026-08-07). Removing
 * the plan-type row was not a decluttering pass: plan type reached the SERVER, indirectly, and that
 * is why nothing about it may survive in this bag. It is absent from `scopeKeyOf`, which made it look
 * like a pure client-side narrow — but `filterCandidates` feeds `employerNarrowFor`
 * (resolution-flow-client.tsx), whose `{ employers }` result IS a scope-key segment and IS sent as
 * `market.employers`. So one plan-type press could silently re-rank the facilities over just the
 * employers holding plans of that type, with nothing on screen mentioning employers. Measured on a
 * real search: POS 257 · PPO 30 · EPO 27 · HMO 9 · ASO 1 · OAP 1 — POS (79% of the mass) is not a
 * proper subset so it does nothing at all, while ASO collapses the ranking to one employer. The same
 * control, opposite force, no disclosure.
 *
 * THE TAG STAYED, THE FILTER WENT. Plan type still renders on every plan tile and in the resolved
 * identity line; it is a fact about a plan, and reading it costs nobody a re-ranked screen.
 */
export interface AnswerFilters {
  funding: string[];
  employers: string[];
}

export const NO_ANSWER_FILTERS: AnswerFilters = { funding: [], employers: [] };

/**
 * "No facility is picked" — the S4 grid narrow's empty selection, as ONE shared reference.
 *
 * It sits beside `NO_ANSWER_FILTERS` and for the identical reason: the reducer resets it at five
 * sites and the answer stage memoizes off it, so a fresh-but-equal `[]` at any of those sites would
 * invalidate the whole narrow memo chain on every navigation. `area` needs no such constant because
 * it is a string; this one does because it is an array (flow-state.ts's referential bail-out note).
 */
export const NO_FACILITY_NARROW: readonly string[] = [];

export function answerFiltersActive(f: AnswerFilters): boolean {
  return f.funding.length > 0 || f.employers.length > 0;
}

/** AND across facets, OR within one — the standard multiselect reading. */
export function filterCandidates(all: readonly OrderedCandidate[], f: AnswerFilters): OrderedCandidate[] {
  return all.filter((c) => {
    if (f.funding.length > 0 && !(c.funding !== null && f.funding.includes(c.funding))) return false;
    if (f.employers.length > 0 && !(c.employerLabel !== null && f.employers.includes(c.employerLabel))) return false;
    return true;
  });
}

// ── The AREA facet (the restored location narrow) ────────────────────────────────────────────────
//
// WHAT WAS LOST AND WHY THIS IS THE SHAPE OF THE ANSWER. v2's tab carried a Facility type-ahead in
// its primary search row and a Heating Up ticker whose cards pivoted the whole view to {facility +
// dominant payer}. The 2026-08-06 v3 cutover dropped both, and — unlike the browse-filter row, the
// KPI tiles and the always-open trace — the drop is absent from the ratified pattern doc's
// deliberate-drops list, so it was a casualty rather than a ruling. The first dark-launch v3 build
// even PROMISED "…or a facility name" in the search box; typing "NASHVILLE" was HMAC'd down the
// member-id blind index and reported a confusing no-match, and the review fix deleted the promise
// instead of building the capability.
//
// This restores the capability WITHOUT re-opening that defect: nothing here touches
// `classifyQualifyHandle`, so no free-text term can ever reach the blind index again by this route.
// The facet is a post-hoc narrow over facilities the ranking ALREADY returned — state buckets, using
// the mobile deck's own helpers, single-select exactly as the mobile chips are.
//
// ⚠ IT NARROWS THE GRID, NOT THE FETCH. See flow-state.ts invariant (m): `area` is a sibling of
// `filters`, never a member, precisely so that no request-shaping code can read it.

/**
 * The chips for the ranked set, with the ACTIVE key guaranteed present.
 *
 * `deriveAreaChips` builds its list from the facilities in hand, which is right for the mobile deck
 * where the only way to pick an area is to click one of those chips. The desktop flow has a second
 * seeder: a Heating Up card, whose trends are BOOK-WIDE and can name a state this member has no
 * history in. Left alone, that click would narrow the grid to nothing with no chip on screen to
 * un-press — an active filter the user cannot see is an unclearable one. So an active key the ranked
 * set does not contain is appended rather than swallowed, and the empty grid gets a sentence saying
 * which area it is empty for.
 */
export function areaChipsWithActive(facilities: readonly QualifyFacility[], active: string): AreaChip[] {
  const chips = deriveAreaChips(facilities);
  if (chips.some((c) => c.key === active)) return chips;
  // Same label vocabulary as the derived chips — 'Other' is a word, not the sentinel string.
  return [...chips, { key: active, label: active === AREA_OTHER ? 'Other' : active }];
}

/**
 * Is the Heating Up ticker a LIVE control, or orientation-only?
 *
 * Live exactly when an answer is on screen to narrow. On the landing there is nothing to filter —
 * v3 resolves a MEMBER, not a facility, so a landing click has no honest target, and the strip keeps
 * the `readOnly` treatment that renders every card as a disabled non-button rather than a button
 * that no-ops. Pure and exported so the shell's `readOnly` prop and its `onOpen` guard are ONE
 * decision: two of them would eventually disagree and hand back a clickable card with a dead handler.
 */
export function tickerIsLive(stage: FlowStage, hasSnapshot: boolean): boolean {
  return stage === 'answer' && hasSnapshot;
}

export interface Facet {
  value: string;
  members: number;
}

/** Distinct values per facet, member-weighted and ranked — the biggest option first, so the list
 *  reads as "what this identifier actually has" rather than an alphabet.
 *
 *  ⚠ THE KEY SET HERE IS THE CARD'S VOCABULARY. A `planTypes` key would be a plan-type control on
 *  screen whatever the row that renders it is called, so it went with the filter (see
 *  `AnswerFilters`) rather than being left behind as a tally nothing consumes. */
export function facetsOf(all: readonly OrderedCandidate[]): {
  funding: Facet[];
  employers: Facet[];
} {
  const tally = (pick: (c: OrderedCandidate) => string | null): Facet[] => {
    const m = new Map<string, number>();
    for (const c of all) {
      const v = pick(c);
      if (v === null || v === '') continue;
      m.set(v, (m.get(v) ?? 0) + c.memberCount);
    }
    return [...m.entries()]
      .map(([value, members]) => ({ value, members }))
      .sort((a, b) => b.members - a.members || a.value.localeCompare(b.value));
  };
  return {
    funding: tally((c) => c.funding),
    employers: tally((c) => c.employerLabel),
  };
}

/**
 * The `market.employers` value to send with the ranking query, or null when the narrow cannot be
 * expressed faithfully.
 *
 * ⚠ THE BOUND IS LOAD-BEARING. `sanitizeMarket` SLICES the employer array at
 * QUALIFY_EMPLOYER_SET_MAX (200) at the action boundary. Sending 311 employers would silently rank
 * over 200 of them while this screen said it searched all 311 — a narrowing the user never asked for
 * and cannot see. So: send the set only when it is a PROPER SUBSET (otherwise it is not a narrow at
 * all) and within the bound; otherwise send nothing and let the caption say the ranking is not
 * employer-narrowed.
 */
export const ANSWER_EMPLOYER_SEND_MAX = 200;

/**
 * The identity of the scope a ranking request describes — payer label × window × market narrow.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN A `refetching` BOOLEAN (Qodo, PR #126). The flag was set to true by
 * four separate handlers and cleared in ONE place: the fetch effect's resolve. So any click that did
 * not move an effect dependency left it stuck true forever — and because the stale-sentence rule
 * suppresses the hero numeral, the verdict, `rating.basis` and the scope captions while refetching,
 * the answer stage lost its headline PERMANENTLY. Every one of these was reachable:
 *   · clicking the already-selected window chip (`onWindowDays(30)` when it is already 30);
 *   · clicking "Automatic" in its DEFAULT state — the very first thing on screen;
 *   · clicking the active billed-under chip, which sends `onPayerOverride(null)` when the override
 *     is already null;
 *   · toggling a filter whose employer set is not a proper subset, or exceeds the 200 bound — both
 *     leave `market.employers` null and the market key unchanged. (The reported case was a plan-type
 *     chip; that facet was removed 2026-08-07, but funding reaches the same dead end.)
 * React bails out of a no-op setState, so the deps never changed and the effect never ran.
 *
 * Deriving the flag from "what is requested vs what is rendered" makes the stuck state
 * unrepresentable: a no-op click cannot change the key, so it cannot flip the flag. Fixing the two
 * reported handlers would have left the two filter paths broken.
 */
export function scopeKeyOf(parts: {
  payerLabel: string | null;
  windowDays: number | null;
  funding: readonly string[];
  employers: readonly string[] | null;
  /**
   * IDENTIFIER-WIDE mode (2026-08-07) — a real dimension of the request, so a real dimension of its
   * identity. Without it, un-skipping into a plan pick that resolves to the SAME dominant label
   * produces an identical key: the effect never re-runs, and a payer-scoped answer keeps rendering
   * under an all-payers caption (or the reverse). `allPayers` is the LAST segment so every existing
   * key is a strict prefix of its payer-scoped equivalent — pinned keys stay readable in a diff.
   */
  allPayers?: boolean;
}): string {
  return [
    parts.payerLabel ?? '',
    parts.windowDays === null ? 'auto' : String(parts.windowDays),
    parts.funding.slice().sort().join('|'),
    parts.employers === null ? '' : parts.employers.slice().sort().join('|'),
    parts.allPayers ? 'all' : '',
  ].join('#');
}

/**
 * THE AUTOMATIC WINDOW LANDING ON A DIFFERENT RUNG ACROSS A SAME-SCOPE RE-RUN (flow-state invariant
 * p). `from`/`to` are the LADDER's chosen days on either side — never the operator's own selection,
 * because a manual window returns no ladder at all, which makes this shape unreachable there by
 * construction rather than by a guard.
 *
 * Declared HERE rather than in `flow-state.ts` even though the reducer owns the field: that module
 * already imports from this one, and defining the shape there would close a cycle. The copy that
 * reads it (`windowMoveNotice`, below) lives beside the render, so the type does too.
 */
export interface WindowMove {
  from: QualifyTrailingDays;
  to: QualifyTrailingDays;
}

/**
 * True only when content is on screen AND it describes a scope the user has since moved off.
 * `hasSnapshot` false is a FIRST LOAD (skeleton), never a refetch — the two treatments differ.
 */
export function isRefetching(hasSnapshot: boolean, loadedKey: string | null, scopeKey: string): boolean {
  return hasSnapshot && loadedKey !== null && loadedKey !== scopeKey;
}

export function employerNarrowFor(
  universe: readonly OrderedCandidate[],
  filtered: readonly OrderedCandidate[],
): { employers: string[] } | { tooMany: number } | null {
  const allEmployers = new Set(universe.map((c) => c.employerLabel).filter((e): e is string => e !== null && e !== ''));
  const picked = [...new Set(filtered.map((c) => c.employerLabel).filter((e): e is string => e !== null && e !== ''))];
  if (picked.length === 0 || picked.length >= allEmployers.size) return null; // not a narrow
  if (picked.length > ANSWER_EMPLOYER_SEND_MAX) return { tooMany: picked.length };
  return { employers: picked };
}

/**
 * THE CLASSIFIER HALF OF `liveSentenceFor`'s OPTIONS — ALL OR NOTHING, AT THE TYPE LEVEL.
 *
 * These two travel together or not at all. `memberFacilityCount` was previously optional with a
 * `?? 0` default, which meant a caller who passed the member count and forgot the facility count
 * got a silent, confident "0 facilities of history in the window shown" announced to a screen-reader
 * user over a grid full of facilities. A runtime default cannot make that loud; a union can make it
 * impossible. Supplying neither is still fine — that is the pre-S2 announcement, unchanged.
 */
type LiveSentenceClassifier =
  | { memberCount?: undefined; memberFacilityCount?: undefined }
  | {
      /** Distinct members behind the searched token (`QualifySnapshot.memberCount`). `null` means the
       *  classifier is unavailable and the announcement is byte-identical to pre-S2. */
      memberCount: number | null;
      /** The facility count the VISIBLE preface uses — `snapshot.facilities.length`. Passed rather
       *  than read off the resolution so the spoken and the seen sentence carry ONE number. */
      memberFacilityCount: number;
    };

/** The live-region sentence for the current state — announced once, as a full sentence.
 *
 *  `opts.payerGroups` is the shell's memoized cluster set. It rides in the EXISTING opts bag rather
 *  than as a fifth positional so every current call compiles untouched; omitting it self-derives. */
export function liveSentenceFor(
  stage: FlowStage,
  resolution: QualifyResolution | null,
  reason: 'empty' | 'prefix_too_short' | 'no_match' | null,
  opts: {
    skipped?: boolean;
    scopePayer?: string | null;
    /** The ranking spans every billed-under label. Distinct from `scopePayer === null`, which is also
     *  true while the snapshot is still in flight — announce the wider scope only once it is real. */
    scopeAllPayers?: boolean;
    payerGroups?: PayerGroup[];
    /**
     * S3: the payer whose WHOLE BOOK is the ranked grid, or null/omitted when the grid is the
     * identifier's own footprint. It is a NAME rather than a boolean because the sentence has to say
     * whose book — "the ranking below is a whole book" would leave a screen-reader user knowing the
     * scope changed and not what to. Omit and the announcement is byte-identical to S2's.
     */
    bookLedPayer?: string | null;
    /**
     * S5: the AUTOMATIC window landed on a different rung across a same-scope re-run, or null/omitted
     * when it did not. The sr-only region carries no dim and no beam, so a screen-reader user has no
     * other signal at all that the period under the ranking just changed — and `scopeKeyOf` cannot
     * see the change either, so nothing else in this sentence would mention it. Omit and the
     * announcement is byte-identical to S3's.
     */
    windowMoved?: WindowMove | null;
  } & LiveSentenceClassifier = {},
): string {
  if (!resolution) return reason ? UNRESOLVABLE_COPY[reason] : '';
  /* THE PREFACE, ANNOUNCED. The visible line and this one come from the SAME pure function on the
   * SAME inputs — a second derivation is how the aria channel and the screen come to disagree, and
   * the sr-only line is exactly where that survives a browser pass. Null when the classifier is
   * unavailable, so every pre-S2 call site renders an unchanged sentence.
   *
   * `?? 0` IS UNREACHABLE, and by the TYPE rather than by hope: `LiveSentenceClassifier` makes the
   * pair all-or-nothing, so no caller can supply a count without the facility count it is joined to.
   * It stays only because TS cannot narrow the pair through the intersection above. */
  const preface = memberPrefaceFor(opts.memberCount ?? null, opts.memberFacilityCount ?? 0);
  /* ⚠ THE SPOKEN CHANNEL MUST FOLLOW THE FLIP TOO (S3). Without this the sr-only line goes on
   * describing the identifier's own ranking while the grid on screen is the payer's whole book —
   * a scope lie that no browser pass can see, which is precisely the failure mode this function's
   * header warns about. Appended to BOTH the resolved and the skipped arms, because a Skip plus one
   * billed-under chip is a book-led screen with `skipped` still true. */
  const bookClause =
    opts.bookLedPayer == null
      ? ''
      : ` The ranking below is ${opts.bookLedPayer}'s whole book, not this member's own history — the facilities they have been to are marked on it.`;
  /* ⚠ THE CLAUSE IS STAGE-GATED, AND THE COMMENT THAT USED TO STAND HERE ASSERTED A GUARANTEE THE
   * CODE DID NOT HOLD. It claimed `say` was "called from exactly the two ANSWER-shaped arms (the skip
   * lands on the answer stage)". The SKIPPED arm returns BEFORE every stage check — so a held skipped
   * answer plus one step back to the search box announced "the ranking below is {payer}'s whole book"
   * over the identify screen, with no ranking below it at all. The preface has always been safe there
   * (it is a fact about the identifier, not about a list); this clause names a list by position, so it
   * needs the stage the position refers to. */
  /* ⚠ S5's CLAUSE IS THE SAME BYTES AS THE VISIBLE NOTICE — one call to `windowMoveNotice`, not a
   * second sentence that agrees today. It is stage-gated with the book clause and for the identical
   * reason: "the ranking below covers a longer period" said over the search box names a list that is
   * not there, and the SKIPPED arm returns before every stage check, so the gate has to live here. */
  const windowClause = opts.windowMoved == null ? '' : ` ${windowMoveNotice(opts.windowMoved)}`;
  const say = (rest: string): string =>
    (preface === null ? rest : `${preface} ${rest}`) + (stage === 'answer' ? bookClause + windowClause : '');
  // A skipped search resolved NOTHING past the identifier: announcing the pre-selected candidate's
  // employer as "Resolved: …" told a screen-reader user a plan had been chosen when none was — the
  // same claim the receipt and the identity line had to stop making.
  if (opts.skipped) {
    // The screen-reader sentence carries the SAME scope claim as the visible banner, so it takes the
    // same three-way branch. "across all plans under AETNA" said aloud over an all-payers ranking is
    // the identical lie, just less visible — and the sr-only line is exactly where an unfixed claim
    // survives a browser pass.
    return say(
      'You skipped the plan questions. Showing a general search across all plans' +
        (opts.scopeAllPayers ? ' and all payers on file' : opts.scopePayer ? ` under ${opts.scopePayer}` : '') +
        '.',
    );
  }
  if (stage === 'identify') {
    // Back at the search step with a result still held — announce the STAGE, not the stale result
    // (an unchanged "Resolved: …" sentence would mean no announcement at all, and it would describe
    // a screen no longer shown).
    return 'Back at the search step. Searching again replaces the current result.';
  }
  if (stage === 'payer') {
    return `${(opts.payerGroups ?? payerGroupsOf(resolution)).length} carriers match what you typed. Pick the one on the card.`;
  }
  if (stage === 'plan') {
    return `${resolution.candidates.total} plans match. Pick one, or ask the AI about one.`;
  }
  const g = resolution.group;
  /* ⚠ THE PREFACE REPLACES THE RESOLUTION'S FACILITY COUNT ONLY WHEN IT CARRIES ONE OF ITS OWN.
   * `claimEvidence.distinctFacilities` is minted by the resolution service and is rendered NOWHERE
   * on this screen (grep: this line is its only consumer). The ONE-MEMBER preface names a facility
   * count that the operator can SEE (`snapshot.facilities.length`); the two can legitimately differ
   * (different source, different window), so announcing both would read out two numbers for one
   * question and leave a screen-reader user unable to tell which describes the grid in front of them.
   *
   * The 2-9 and 10+ prefaces name NO facility count, so there is nothing to collide with — and
   * replacing the clause there would leave the spoken channel with no facility count at all while
   * the sighted reader has a grid full of them. Silence is not parity. `prefaceNamesFacilityCount`
   * is the judge, so the rule follows the COPY: the day a 2-9 sentence grows a facility clause, the
   * predicate moves with it instead of this branch quietly becoming wrong. */
  const announcedFacilities = prefaceNamesFacilityCount(opts.memberCount ?? null)
    ? ''
    : ` ${g.claimEvidence.distinctFacilities} facilities with history.`;
  return say(
    `Resolved: ${g.payerDisplayName}` +
      (g.employerLabel ? ` · ${g.employerLabel}` : '') +
      (g.funding ? ` · ${g.funding}` : '') +
      `.${announcedFacilities}` +
      (resolution.candidates.wasAmbiguous
        ? ` ${resolution.candidates.total} plans matched; this one is selected.`
        : ' Only one plan matched.'),
  );
}

// ── Shared chrome ────────────────────────────────────────────────────────────────────────────────

/** Stage shell: a <section> whose <h2> IS the question. One question per screen. The heading takes
 *  tabIndex={-1} so the shell can move focus to it on a stage swap — clicking a tile unmounts the
 *  focused element, and without a landing target a keyboard user re-tabs from the document top. */
function Stage(props: {
  id: string;
  question: string;
  /**
   * Content that PINS with the heading (CSS sticky — the plan stage's count sentence + employer
   * filter). When set, the heading row and this block share one sticky wrapper so the question stays
   * on screen while a long tile grid scrolls beneath it. The shell's ScrollTrigger only ADDS the
   * elevation (`q-stuck`) once the grid is under it — sticky itself is pure CSS, so a reduced-motion
   * user keeps the pin and simply never sees the shadow transition.
   */
  pinned?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const headingId = `${props.id}-heading`;
  const header = (
    <>
      {/* Space Grotesk for headings (font-head) — Fraunces (font-display) is reserved for the one
          hero numeral, per the design system. */}
      <h2
        id={headingId}
        tabIndex={-1}
        className="ths-h font-head text-xl font-semibold tracking-tight text-ink900 outline-none"
      >
        {props.question}
      </h2>
      {props.pinned}
    </>
  );
  return (
    <section id={props.id} aria-labelledby={headingId} className="flex flex-col gap-4">
      {props.pinned !== undefined ? (
        <div
          data-v3-sticky
          className="sticky top-0 z-20 -mx-2 flex flex-col gap-3 rounded-b-xl bg-ground px-2 pb-3 pt-1 transition-shadow duration-150 ease-out"
        >
          {header}
        </div>
      ) : (
        header
      )}
      {props.children}
    </section>
  );
}

// ── The step rail ────────────────────────────────────────────────────────────────────────────────

export type RailState = 'pending' | 'current' | 'done' | 'skipped';

const RAIL_SEGMENTS: readonly { stage: FlowStage; label: string }[] = [
  { stage: 'identify', label: 'Identify' },
  { stage: 'payer', label: 'Carrier' },
  { stage: 'plan', label: 'Plan' },
  { stage: 'answer', label: 'Answer' },
];

/**
 * Per-segment rail state. PURE — same inputs as `deriveStage`, so the rail can never disagree with
 * the stage machine about what was skipped: a sole carrier skips the payer question, a sole
 * candidate skips both questions. A skipped segment must never render as "done" — done implies the
 * user answered a question they were never asked.
 */
export function railStates(stage: FlowStage, resolution: QualifyResolution | null, groups?: PayerGroup[]): RailState[] {
  const idx = RAIL_SEGMENTS.findIndex((s) => s.stage === stage);
  const soleCandidate = resolution !== null && resolution.candidates.total <= 1;
  const soleCarrier = resolution !== null && (groups ?? payerGroupsOf(resolution)).length <= 1;
  return RAIL_SEGMENTS.map((seg, i) => {
    if (i === idx) return 'current';
    if (i > idx) return 'pending';
    if (seg.stage === 'payer' && (soleCandidate || soleCarrier)) return 'skipped';
    if (seg.stage === 'plan' && soleCandidate) return 'skipped';
    return 'done';
  });
}

/** Colour scale per the design brief: teal50 pending → teal200 skipped → teal500 current → teal700
 *  done. Colour never carries the state alone — the dot shape differs (skipped is dashed-ring,
 *  current is solid-ring) and every segment carries its state as visually-hidden TEXT. */
const RAIL_DOT: Record<RailState, string> = {
  pending: 'bg-teal50 border border-line',
  skipped: 'bg-teal200 border border-dashed border-teal500',
  current: 'bg-teal500 ring-2 ring-teal500/30 animate-pulse',
  done: 'bg-teal700',
};

const RAIL_FILL: Record<RailState, string> = {
  pending: 'w-0',
  skipped: 'w-full bg-teal200',
  current: 'w-1/2 bg-teal500',
  done: 'w-full bg-teal700',
};

/**
 * Decorative progression, NOT a control — the receipt strip is the revisit affordance and stays.
 * Plain list semantics (role list/listitem, no buttons, no aria-live: the single live region already
 * announces the stage). The fill advances left-to-right on the panel duration via CSS transition,
 * which runs equally in reverse when the user goes back — and collapses entirely under the global
 * prefers-reduced-motion reset.
 */
export function StepRail(props: {
  stage: FlowStage;
  resolution: QualifyResolution | null;
  payerGroups?: PayerGroup[];
}): React.ReactElement {
  const states = railStates(props.stage, props.resolution, props.payerGroups);
  return (
    <ol role="list" className="flex list-none items-start gap-2 p-0" data-v3-rail>
      {RAIL_SEGMENTS.map((seg, i) => {
        const state = states[i] ?? 'pending';
        return (
          <li key={seg.stage} role="listitem" className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="flex items-center gap-2">
              <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${RAIL_DOT[state]}`} />
              <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-teal50">
                <span
                  aria-hidden
                  className={`block h-full rounded-full transition-[width] duration-200 ease-out ${RAIL_FILL[state]}`}
                />
              </span>
            </span>
            <span
              className={`truncate text-xs font-semibold ${
                state === 'current' ? 'text-teal700' : state === 'done' ? 'text-ink900' : 'text-ink400'
              }`}
            >
              {seg.label}
              {/* The state as TEXT — "skipped" must be readable, not inferable from a hue. */}
              <span className="sr-only">
                {state === 'current' ? ' — current step' : state === 'done' ? ' — done' : state === 'skipped' ? ' — skipped' : ' — not yet'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Skip is only offered on the CARRIER stage when the carrier choice is nearly obvious — fewer than
 * this many clusters. Ruled 2026-08-06: with a dozen carriers behind a prefix, "skip" resolves the
 * ranking to whichever payer happens to dominate the identifier's claims, which is ARBITRARY rather
 * than general, and the user cannot tell the difference from the answer screen. Below the threshold
 * the carrier is effectively already known, so declining to pick costs nothing. The PLAN stage always
 * offers it: by then the population is one carrier's plans, and "I don't know which plan" is the
 * common real case.
 *
 * ⚠ THE PARAGRAPH ABOVE IS LEFT AS RATIFIED, AND ITS PREMISE IS NO LONGER TRUE (recorded S6,
 * 2026-08-08). The 2026-08-07 reversal — "the Skip ranks the whole radius, not one label" — made a
 * skip an ALL-PAYERS request: `allPayers = skipped && payerOverride === null` in
 * resolution-flow-client.tsx becomes `payerScope: 'all'` on the wire, and `QualifyResolved.payerName`
 * is null. So a skip no longer "resolves the ranking to whichever payer happens to dominate"; there
 * is no dominant-payer pick left in that path to be arbitrary.
 *
 * THE RULING IS PRESERVED ANYWAY, and S6 preserved it deliberately rather than dropping it with its
 * premise, for a reason the reversal itself supplies: an all-payers ranking is dollar-weighted across
 * every label behind the rows (the reversal's own rule 2 — "a blended percentage is never a payer
 * contract rate", Simpson's paradox on the exact surface admissions staff act on). At two carriers
 * the blend is legible and the chips un-blend it in one click. At a dozen it is a blend the operator
 * cannot reason about, offered as a shortcut past the one question that would have prevented it —
 * and S6's hoist makes that offer LOUDER, which strengthens the case for the gate rather than
 * weakening it. That is a different argument from the one ratified, over the same threshold and the
 * same behaviour. It wants Alec's re-ratification; it does not want a silent drop.
 */
export const SKIP_CARRIER_MAX = 3;

/**
 * WHICH STAGES OFFER THE SKIP — the suppression ruling above, expressed once (S6, 2026-08-08).
 *
 * PURE, and deliberately the only place the rule lives now: the affordance moved from three render
 * sites inside the stage bodies to ONE beneath the step rail, and three call sites that each carried
 * their own condition were three places a rule could drift. `identify` has nothing to skip yet (no
 * resolution, no footprint) and `answer` is past every question there is.
 *
 * `groups` is the shell's memoized `payerGroupsOf` — the SAME derivation the rail, the receipt, the
 * stage machine and the live sentence read. Re-deriving here would give a count-based rule a second
 * source of truth.
 */
export function skipOffered(
  stage: FlowStage,
  resolution: QualifyResolution | null,
  groups?: PayerGroup[],
): boolean {
  if (resolution === null) return false;
  if (stage === 'plan') return true;
  if (stage !== 'payer') return false;
  return (groups ?? payerGroupsOf(resolution)).length < SKIP_CARRIER_MAX;
}

/**
 * How many of the payer's book the SECONDARY section renders (S2, 2026-08-08).
 *
 * The book is the whole payer's ranking — on a real payer that is dozens of facilities, and a
 * secondary section that pushes the answer it is secondary to off the screen has stopped being
 * secondary. Capped, and the cap is STATED beside the list: a truncated ranking that does not say
 * it is truncated makes a completeness claim it has not earned, and because availability leads the
 * sort (S1) the rows a cap removes are systematically the FULL ones.
 *
 * Not a scroll box and not a `<details>`: both hide rows in ways an assertion cannot tell from an
 * absence. When S3 flips prominence this number is the first thing it should reconsider.
 */
export const QUALIFY_BOOK_PREVIEW = 8;


/**
 * The escape hatch: stop answering questions and go straight to the answer over the identifier's
 * WHOLE footprint, then narrow (or not) with the answer stage's filter lines. Declining to choose is
 * a real answer, and the answer stage says which one it got.
 *
 * ── HOISTED, AND SPARKLING (S6, 2026-08-08) ────────────────────────────────────────────────────────
 * Alec, verbatim: "If there is the option to 'skip — search all plans' this button should be very
 * visible, sparkly with movement just underneath the green timeline." It used to render from THREE
 * sites inside the stage bodies (StagePayer, gated; StagePlan, twice — the pinned header and the
 * empty-cluster early return). It now renders from ONE site in `ResolutionStages`, directly beneath
 * `<StepRail>`, gated by `skipOffered`.
 *
 * ⚠ THAT PUTS IT IN THE CHROME, WHICH IS THE POINT AND ALSO THE CONSTRAINT. Everything above
 * `[data-v3-stage]` is outside the shell's GSAP entrance — and the entrance animates `autoAlpha`,
 * which sets `visibility: hidden`. A control that is the loudest thing on the screen must not be
 * unclickable and out of the accessibility tree for the first 220ms of every stage it appears on.
 * Outside the subtree it is live from frame zero, and the shimmer is pure decoration over it.
 *
 * ⚠ IT NOW PRECEDES THE QUESTION IN TAB ORDER, and that is a real consequence, not an oversight.
 * The shell moves focus to the stage's own `<h2>` on a stage swap, so a keyboard user reaches this
 * by SHIFT-tab from the question rather than by tabbing forward into it. That is the same
 * relationship the receipt strip's "Change" buttons already have on this surface — revisit and
 * escape affordances live in the chrome above the question — so it is a consistent position rather
 * than a new one. The single live region is untouched: it announces the QUESTION, never this.
 *
 * The sparkle itself is `.q-skip-spark` in globals.css, where the motion-contract deviation, the
 * refused sizes and the contrast reasoning are all written down.
 */
function SkipStep(props: { onSkip: () => void; what: string }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onSkip}
      aria-label={`Skip ${props.what} and search across all plans for this member`}
      className="w-fit rounded-xl border border-teal500/60 bg-gradient-to-br from-teal900 to-teal700 px-4 py-2 text-sm font-semibold shadow-ths-sm transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-ths focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/50"
    >
      {/* One span, so the gradient clip has a single text box to run across. The words are the
          control's visible label; the accessible name is the aria-label above, which says what the
          skip actually does rather than what the button says. */}
      <span className="q-skip-spark">Skip — search all plans</span>
    </button>
  );
}

function evidenceWord(has: boolean): React.ReactElement {
  return has ? (
    <span className="text-xs text-ink600">Claims history on file</span>
  ) : (
    <span className="text-xs font-semibold text-ink900">No claim history — a ranking here would have nothing behind it</span>
  );
}

// ── The receipt ──────────────────────────────────────────────────────────────────────────────────

export interface ReceiptProps {
  resolution: QualifyResolution;
  stage: FlowStage;
  payerPick: string | null;
  onChange: (backTo: 'identify' | 'payer' | 'plan') => void;
  /** Optional pre-computed clusters (the shell memoizes one call per resolution). */
  payerGroups?: PayerGroup[];
  /**
   * A skipped search decided nothing past the identifier — see the guard in the body. Sourced from
   * the REDUCER field, never from `scopeSource`: a billed-under re-scope is not a plan pick, and
   * deriving this from the payer-scope enum is exactly the masquerade `ScopeSource` documents.
   */
  skipped?: boolean;
  /**
   * S2: distinct members behind the searched token. It rides the SEARCH entry rather than becoming
   * an entry of its own, and that placement is the receipt's own contract rather than a layout
   * preference — this strip records DECISIONS and every entry is revisitable ("Change"). A member
   * count is neither: it is a fact ABOUT the decision on the Search entry, so it qualifies that
   * entry. Null/omitted renders nothing at all.
   */
  memberCount?: number | null;
  /** The payer the RANKING actually used, for the skipped scope entry. Null when there is none. */
  scopePayer?: string | null;
  /** The ranking spans EVERY billed-under label (identifier-wide). Distinct from `scopePayer ===
   *  null`, which is also true while a first load is still in flight — a receipt must not assert the
   *  wider scope before the core has confirmed it ranked that way. */
  scopeAllPayers?: boolean;
  /**
   * `scopePayer` is the operator's OWN re-scope (a billed-under chip that the core honoured), not a
   * default. Naming that is the honesty pattern of 7c86709 applied to the state this fix uncovered:
   * "no plan chosen, re-scoped to a label you picked" is a real state, so the receipt says so rather
   * than falling silent about half of it.
   */
  scopeByUser?: boolean;
}

/**
 * What has been decided so far, each entry revisitable. Completion is carried by the WORDS on each
 * entry — never by a checkmark hue alone.
 */
export function FlowReceipt({
  resolution,
  stage,
  payerPick,
  onChange,
  payerGroups,
  skipped = false,
  memberCount = null,
  scopePayer = null,
  scopeAllPayers = false,
  scopeByUser = false,
}: ReceiptProps): React.ReactElement {
  // For a full member id the echo is '' by construction — the receipt shows the READING instead,
  // so the id never reaches the markup and the entry still says what was searched.
  const idLabel = resolution.handle.echo !== '' ? resolution.handle.echo : resolution.handle.readAs;
  const payers = payerGroups ?? payerGroupsOf(resolution);
  const entry = 'flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-3 pr-1';
  const change = 'rounded-full px-2 py-0.5 text-xs font-semibold text-teal700 hover:bg-teal50';
  /* HOW MANY PEOPLE THAT SEARCH ACTUALLY MATCHED — the COUNT, not the sentence. The receipt is a
   * compressed trail, so it states the number and leaves the interpretation to the preface on the
   * answer stage; two full sentences saying the same thing in different words is how they drift.
   *
   * ⚠ THE GATE IS `memberBucketOf`, NOT A SECOND null/zero TERNARY. It used to be
   * `memberCount !== null && memberCount > 0`, which is the same logic re-derived — and "one
   * derivation, three surfaces" is only true if the SILENCE rule is shared too, not just the words.
   * 'unknown' (the count was unavailable) and 'none' (it ran and found nobody) are the two states
   * that say nothing; both live in memberPreface.ts, and this reads them rather than restating them.
   *
   * Rendered as ONE element rather than a second entry — see ReceiptProps.memberCount. */
  const memberBucket = memberBucketOf(memberCount);
  const memberChip =
    memberCount !== null && memberBucket !== 'unknown' && memberBucket !== 'none' ? (
      <span className="text-xs text-ink600">
        ·{' '}
        {/* ⚠ THE ACCESSIBLE NAME STATES THE BASIS, because the numeral cannot (final review,
            2026-08-08). It read "N members match this search" — the EXACT mixed-basis wording S2-I1
            removed from the visible preface, kept alive in the one channel a browser pass never sees.
            `memberCount` is the ladder's 365-day rung filtered on `payment_received`, so it means
            "members with a PAID CLAIM in the last 12 months" and never "members who exist". "One
            derivation, three surfaces" is only true if the BASIS travels with the number.

            ⚠ IT DELIBERATELY DOES **NOT** REUSE THE PREFACE'S "behind this search" CLAUSE. This chip
            already sits inside the entry labelled SEARCH, so the clause is redundant here — and, more
            to the point, the receipt is NOT suppressed in flight while the preface is. Sharing the
            preface's exact phrase would put its words on screen during a re-scope through a surface
            that is exempt from the rule, which is the suppression being defeated by wording. */}
        <span
          className="ths-num"
          aria-label={`${memberCount} member${memberCount === 1 ? '' : 's'} with a paid claim in the last 12 months`}
        >
          {memberCount.toLocaleString()}
        </span>{' '}
        member{memberCount === 1 ? '' : 's'}
      </span>
    ) : null;

  // ⚠ A SKIPPED SEARCH DECIDED NOTHING BEYOND THE IDENTIFIER. Rendering the pre-selected candidate's
  // employer as a "PLAN" entry claimed a decision the user explicitly declined to make. The receipt
  // is a record of DECISIONS; after a skip there is one, plus the scope the ranking actually used.
  if (skipped) {
    return (
      <nav aria-label="Your search so far" className="flex flex-wrap items-center gap-2">
        <span className={entry}>
          <span className="text-xs font-medium uppercase tracking-wide text-ink400">Search</span>
          <span className="ths-num text-sm text-ink900">{idLabel}</span>
          {memberChip}
          <button type="button" className={change} onClick={() => onChange('identify')}>
            Change
          </button>
        </span>
        <span className={entry}>
          <span className="text-xs font-medium uppercase tracking-wide text-ink400">Scope</span>
          <span className="text-sm text-ink900">
            All plans{scopeAllPayers ? ' · all payers' : scopePayer ? ` · ${scopePayer}` : ''}
            {scopeByUser ? ' — your re-scope' : ''}
          </span>
          <button type="button" className={change} onClick={() => onChange('payer')}>
            Pick a plan
          </button>
        </span>
      </nav>
    );
  }

  const payerLabel = stage === 'answer' ? resolution.group.payerDisplayName : payerPick;
  const planLabel =
    stage === 'answer' ? (resolution.group.employerLabel ?? 'No plan sponsor on file') : null;
  return (
    <nav aria-label="Your search so far" className="flex flex-wrap items-center gap-2">
      <span className={entry}>
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">Search</span>
        <span className="ths-num text-sm text-ink900">{idLabel}</span>
        {memberChip}
        <button type="button" className={change} onClick={() => onChange('identify')}>
          Change
        </button>
      </span>
      {payerLabel !== null && payers.length > 1 ? (
        <span className={entry}>
          <span className="text-xs font-medium uppercase tracking-wide text-ink400">Carrier</span>
          <span className="text-sm text-ink900">{payerLabel}</span>
          <button type="button" className={change} onClick={() => onChange('payer')}>
            Change
          </button>
        </span>
      ) : null}
      {planLabel !== null && resolution.candidates.total > 1 ? (
        <span className={entry}>
          <span className="text-xs font-medium uppercase tracking-wide text-ink400">Plan</span>
          <span className="text-sm text-ink900">{planLabel}</span>
          <button type="button" className={change} onClick={() => onChange('plan')}>
            Change
          </button>
        </span>
      ) : null}
    </nav>
  );
}

// ── Stage 1 · Identify ───────────────────────────────────────────────────────────────────────────

export function StageIdentify(props: {
  echo: string;
  readAs: string | null;
  action: (fd: FormData) => void;
  pending: boolean;
}): React.ReactElement {
  return (
    <Stage id="qualify-s-identify" question="Who are we looking at?">
      {/* The v2 landing hero's panel language (q-hero-* in globals.css: drifting glows, the comet on
          the frame) with the SEARCH LIVING INSIDE IT — the previous design's centerpiece, carrying
          the flow's first question instead of sitting beside a separate finder. All motion is
          CSS-only and collapses under prefers-reduced-motion. */}
      <section
        aria-label="Search to qualify a lead"
        className="q-hero q-hero-border animate-ths-reveal relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-2xl border border-line px-6 py-12 sm:py-16"
        style={{ background: 'linear-gradient(180deg, #FDFBF8 0%, #FBF8F4 100%)' }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <span className="q-hero-glow q-hero-glow--a" />
          <span className="q-hero-glow q-hero-glow--b" />
        </div>
        <form action={props.action} className="relative z-[2] flex w-full max-w-xl flex-col items-center gap-3 text-center">
          <label htmlFor="qualify-term" className="font-head text-lg font-semibold tracking-tight text-ink900">
            Member ID prefix or full member ID
          </label>
          <div className="flex w-full gap-2">
            <input
              id="qualify-term"
              name="term"
              type="text"
              defaultValue={props.echo}
              autoComplete="off"
              aria-describedby="qualify-term-help"
              className="h-12 w-full rounded-xl border border-line bg-surface px-4 font-mono text-base tracking-wide text-ink900 shadow-ths-sm outline-none transition-colors focus:border-teal500 focus:ring-2 focus:ring-teal500/25"
            />
            <button
              type="submit"
              disabled={props.pending}
              // q-btn-progress (globals.css): a determinate-feeling sweep across the button while the
              // lookup runs — motion says "working", not just a dimmed disable. Collapses under the
              // reduced-motion reset; the "Looking up…" text still carries the state.
              className={`relative h-12 shrink-0 overflow-hidden rounded-xl bg-teal700 px-6 text-sm font-semibold text-white transition-colors hover:bg-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40 disabled:opacity-80 ${
                props.pending ? 'q-btn-progress' : ''
              }`}
            >
              {props.pending ? 'Looking up…' : 'Find coverage'}
            </button>
          </div>
          <p id="qualify-term-help" className="text-xs text-ink600">
            {props.readAs
              ? `We ${props.readAs}.`
              : 'Three characters is read as a prefix; anything longer as a complete member ID.'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-semibold">
            {['Member ID', 'Alpha prefix'].map((t) => (
              <span key={t} className="rounded-full border border-teal200 bg-teal50/70 px-2.5 py-1 text-teal700">
                {t}
              </span>
            ))}
          </div>
        </form>
      </section>
    </Stage>
  );
}

// ── Stage 2 · Payer ──────────────────────────────────────────────────────────────────────────────

/** Left accent rail per evidence state (Phase 5). Colour ACCOMPANIES a word that is already on the
 *  tile — `evidenceWord()` / the Unmapped pill — never replaces one. */
function payerAccent(g: PayerGroup): string {
  if (g.unmapped) return 'border-l-coral400';
  return g.hasClaimEvidence ? 'border-l-teal500' : 'border-l-ink400';
}

export function StagePayer(props: {
  resolution: QualifyResolution;
  onPick: (payer: string) => void;
  /** Optional pre-computed clusters (the shell memoizes one call per resolution). */
  payerGroups?: PayerGroup[];
}): React.ReactElement {
  const groups = props.payerGroups ?? payerGroupsOf(props.resolution);
  const spellingsFolded = groups.reduce((s, g) => s + g.otherSpellings.length, 0);
  return (
    <Stage id="qualify-s-payer" question="Which carrier is on the card?">
      <p className="text-sm text-ink600">
        <strong className="font-semibold text-ink900">
          {groups.length === 1 ? 'One carrier' : `${groups.length} carriers`}
        </strong>{' '}
        sit behind what you typed. Pick the one on the card in front of you.
        {spellingsFolded > 0 ? (
          <span>
            {' '}
            VOBs are hand-typed, so{' '}
            <span className="ths-num" aria-label={`${spellingsFolded} alternate spellings folded in`}>
              {spellingsFolded}
            </span>{' '}
            alternate spelling{spellingsFolded === 1 ? ' was' : 's were'} folded into these cards — each card
            lists what it absorbed.
          </span>
        ) : null}
      </p>
      {/* S6: the Skip moved OUT of this body to a single site beneath the step rail — with the
          carrier-count suppression intact, now expressed by `skipOffered`. */}
      <ul data-v3-grid className="grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {groups.map((g, i) => (
          <li key={g.payer}>
            <button
              type="button"
              data-v3-tile
              onClick={() => props.onPick(g.payer)}
              className={`group flex h-full w-full flex-col items-start gap-1 rounded-xl border border-l-[3px] border-line bg-card p-3 text-left shadow-ths-sm transition-[box-shadow,transform,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-ths focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40 ${payerAccent(g)}`}
            >
              <span className="flex w-full items-start gap-2">
                <span className="font-mono text-xs font-bold text-ink400">#{i + 1}</span>
                {/* The ONE dominant line in the tile. */}
                <span className="line-clamp-2 font-head text-[15px] font-semibold leading-tight tracking-tight text-ink900">
                  {g.payer}
                </span>
                <ChevronRight
                  aria-hidden
                  className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-teal500 transition-transform group-hover:translate-x-0.5"
                  strokeWidth={2.5}
                />
              </span>
              <span className="font-mono text-xs tabular-nums text-ink400">
                <span aria-label={`${g.memberCount} verified members under this carrier`}>
                  {g.memberCount.toLocaleString()}
                </span>{' '}
                members ·{' '}
                <span aria-label={`${g.planCount} plans under this carrier`}>{g.planCount.toLocaleString()}</span>{' '}
                {g.planCount === 1 ? 'plan' : 'plans'}
              </span>
              <span className="flex flex-wrap items-center gap-1 text-xs font-semibold">
                {g.unmapped ? (
                  <span className="rounded-full bg-coral50 px-2 py-0.5 text-coral600">Unmapped payer</span>
                ) : null}
                {/* Spellings DEMOTED to a count chip (they cost two clamped lines before): the full
                    list stays available — title for pointer users, an sr-only sentence for AT, and
                    an inline expansion on tile hover/focus. */}
                {g.otherSpellings.length > 0 ? (
                  <span
                    className="rounded-full bg-ground px-2 py-0.5 text-ink600"
                    title={`Also filed as ${g.otherSpellings.join(' · ')}`}
                  >
                    +{g.otherSpellings.length} spelling{g.otherSpellings.length === 1 ? '' : 's'}
                    <span className="sr-only">. Also filed as {g.otherSpellings.join(', ')}.</span>
                  </span>
                ) : null}
              </span>
              {g.otherSpellings.length > 0 ? (
                <span
                  aria-hidden
                  className="hidden text-xs text-ink400 group-hover:line-clamp-2 group-focus-visible:line-clamp-2"
                >
                  Also filed as {g.otherSpellings.slice(0, 4).join(' · ')}
                  {g.otherSpellings.length > 4 ? ` · +${g.otherSpellings.length - 4} more` : ''}
                </span>
              ) : null}
              {evidenceWord(g.hasClaimEvidence)}
            </button>
          </li>
        ))}
      </ul>
    </Stage>
  );
}

// ── Stage 3 · Plan ───────────────────────────────────────────────────────────────────────────────

/** Above this many plans, a type-to-narrow filter appears (a prefix can span 186 employers). */
export const PLAN_FILTER_THRESHOLD = 8;

export function StagePlan(props: {
  resolution: QualifyResolution;
  payerPick: string | null;
  planFilter: string;
  onPlanFilter: (v: string) => void;
  planAction: (fd: FormData) => void;
  onAskAi: () => void;
  pending: boolean;
  /** Optional pre-computed clusters (the shell memoizes one call per resolution). */
  payerGroups?: PayerGroup[];
}): React.ReactElement {
  const all = orderedCandidates(props.resolution);
  const payers = props.payerGroups ?? payerGroupsOf(props.resolution);
  // The pick is a CLUSTER label; membership is by the cluster's folded spelling set, so plans filed
  // under "ANTHEM BCBS OF CA" surface when the tile said "Anthem Blue Cross of California". A stale
  // pick (label no longer among the clusters after a re-resolve) yields the EMPTY state below — it
  // must not silently fall back to the largest cluster, which would show another carrier's plans
  // under the picked name.
  const cluster =
    props.payerPick !== null
      ? (payers.find((p) => p.payer === props.payerPick) ?? null)
      : (payers[0] ?? null);
  const payer = props.payerPick ?? cluster?.payer ?? props.resolution.group.payerDisplayName;
  const underPayer = cluster === null ? [] : all.filter((c) => cluster.names.has(c.payerDisplayName));
  // A stale carrier pick after a re-resolve can leave zero plans under it — say that plainly
  // instead of rendering "0 plans" over an empty grid with filter copy that presumes a filter.
  if (underPayer.length === 0) {
    return (
      <Stage id="qualify-s-plan" question="Which plan is it?">
        {/* [BOOK-LED EXEMPT: the plan stage has no ranking on screen yet] */}
        <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
          No plans are on file under {payer} in this result. Use the receipt above to change the
          carrier or search again.
        </p>
        {/* S6: no Skip here any more — and this branch is the reason the hoist is a fix rather than
            a move. A dead end has to offer the way out, and an escape hatch rendered from inside a
            rarely-taken early return is one branch away from being lost. It is now rendered above
            every plan-stage body, including this one, from a single site. */}
      </Stage>
    );
  }
  const needle = props.planFilter.trim().toLowerCase();
  const visible =
    needle === ''
      ? underPayer
      : underPayer.filter((c) => (c.employerLabel ?? 'no plan sponsor on file').toLowerCase().includes(needle));
  return (
    <Stage
      id="qualify-s-plan"
      question="Which plan is it?"
      // The question, the count sentence, and the filter PIN (CSS sticky) while the grid scrolls
      // beneath — on a 30-plan carrier the user should never lose what they are answering. Keyboard
      // order is unchanged: this is the same DOM order, in a sticky wrapper.
      pinned={
        <>
          <p className="text-sm text-ink600">
            <strong className="font-semibold text-ink900">
              {underPayer.length === 1 ? 'One plan' : `${underPayer.length} plans`}
            </strong>{' '}
            under {payer}. These are every possibility we have on file — pick the one on the card, or ask the AI
            about one. The largest is a guess, not an answer.
          </p>
          {underPayer.length > PLAN_FILTER_THRESHOLD ? (
            <div className="flex max-w-md flex-col gap-1">
              <label htmlFor="qualify-plan-filter" className="text-sm font-medium text-ink900">
                Narrow by employer
              </label>
              <input
                id="qualify-plan-filter"
                type="text"
                value={props.planFilter}
                onChange={(e) => props.onPlanFilter(e.target.value)}
                autoComplete="off"
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink900 outline-none transition-colors focus:border-teal500 focus:ring-2 focus:ring-teal500/25"
              />
              <p className="text-xs text-ink600">
                Showing {visible.length} of {underPayer.length} plans.
              </p>
            </div>
          ) : null}
        </>
      }
    >
      {/* Density is the design fix here: 1→2→3→4 columns and a p-3 tile. A plan tile is a SCAN
          TARGET — one dominant line (the employer), one muted metric line, pills for the attributes.
          At 2 columns on a wide desktop each tile was ~800px of mostly whitespace; two tiles filled
          the fold. */}
      <ul data-v3-grid className="grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((c) => (
          <li key={`${c.canonicalPayerId ?? 'unmapped'}-${c.index}`}>
            <form
              action={props.planAction}
              data-v3-tile
              className="flex h-full flex-col gap-1 rounded-xl border border-line bg-card p-3 shadow-ths-sm transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-ths"
            >
              <input type="hidden" name="candidate" value={String(c.index)} />
              {/* The ONE dominant line — nothing else in the tile carries this weight. */}
              <span className="line-clamp-2 font-head text-[15px] font-semibold leading-tight tracking-tight text-ink900">
                {c.employerLabel ?? 'No plan sponsor on file'}
              </span>
              <span className="font-mono text-xs tabular-nums text-ink400">
                <span aria-label={`${c.memberCount} members on this plan`}>{c.memberCount.toLocaleString()}</span>{' '}
                members
              </span>
              {/* Attributes as pills: categories, not judgements — two distinguishable muted fills
                  (funding wears the brand teal, plan shape the info blue). Never below 12px. */}
              <span className="flex flex-wrap gap-1 text-xs font-semibold">
                <span className="rounded-full bg-teal50 px-2 py-0.5 text-teal700">{c.funding ?? 'Funding not captured'}</span>
                <span className="rounded-full bg-status-info/10 px-2 py-0.5 text-status-info">
                  {c.planType ?? 'Plan type not captured'}
                </span>
              </span>
              {evidenceWord(c.hasClaimEvidence)}
              {/* Both actions, one compact row — the pair is pinned by the invariant suite. */}
              <span className="mt-auto flex gap-1.5 pt-1.5">
                <button
                  type="submit"
                  disabled={props.pending}
                  className="rounded-lg bg-teal700 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-teal900 disabled:opacity-60"
                >
                  Use this plan
                </button>
                {/* ⚠ `type="button"`, AND THAT ONE WORD IS THE WHOLE FIX (S6, 2026-08-08). It was
                    `type="submit"` inside `<form action={planAction}>`, so a single press fired
                    `ai_armed` AND the form's own submission: asking about a plan PICKED it. The
                    receipt then recorded a "PLAN <employer>" decision the operator never made — the
                    same class of false decision-claim the skip guards exist for, reached through the
                    one control whose entire purpose is to interrogate a plan BEFORE committing.
                    Leaving exactly one submit in the tile also gives the form a single, unambiguous
                    default submission. `autoAsk` is one-shot and survives `plan_submitted`
                    (flow-state invariant l), so arming here and then picking still auto-asks on the
                    answer stage — the two presses are the flow, not a regression of it. */}
                <button
                  type="button"
                  disabled={props.pending}
                  onClick={props.onAskAi}
                  className="rounded-lg border border-teal200 bg-teal50 px-2.5 py-1 text-xs font-semibold text-teal700 transition-colors hover:bg-teal200/60 disabled:opacity-60"
                >
                  <span aria-hidden>✦ </span>Ask AI about this plan
                </button>
              </span>
            </form>
          </li>
        ))}
      </ul>
      {/* [BOOK-LED EXEMPT: a claim about the plan-tile filter, on a stage with no ranking] */}
      {visible.length === 0 && needle !== '' ? (
        <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
          No plan sponsor matches that text. Clear the filter to see all {underPayer.length} plans.
        </p>
      ) : null}
    </Stage>
  );
}

// ── Stage 4 · Answer ─────────────────────────────────────────────────────────────────────────────

const WINDOW_CHOICES: readonly QualifyTrailingDays[] = [30, 60, 90, 180, 270, 365];

/** A stable empty reference for the pre-snapshot render — a fresh `[]` would re-run every area memo
 *  on every keystroke in the employer search while the answer is still loading. */

/** windowDays is the shell's MANUAL selection (null = automatic requested). A null ladder on the
 *  automatic path is NOT "set manually" — the core only auto-sizes prefix searches, so a full
 *  member-id search arrives ladder-less on a default the user never chose. Say which it was. */
function windowSentence(snapshot: QualifySnapshot, windowDays: QualifyTrailingDays | null): string {
  if (windowDays !== null) return `Showing trailing ${windowDays} days — your selection.`;
  const ladder = snapshot.ladder;
  if (!ladder) {
    return 'Showing trailing 90 days — the default window; automatic sizing is not available for this search.';
  }
  if (!ladder.sufficient) {
    return `Showing trailing ${ladder.chosenDays} days — even the widest window holds a thin sample; read with care.`;
  }
  return ladder.chosenDays <= 30
    ? `Showing trailing ${ladder.chosenDays} days — the freshest window already carries a reliable sample.`
    : `Showing trailing ${ladder.chosenDays} days — needed this far back to reach a reliable sample.`;
}

/**
 * ── "RANKING DATA REBUILT …" — THE ONE HONEST FRESHNESS CLAIM THIS SURFACE CAN MAKE (S5) ─────────
 *
 * The input is `collections.rollup_refresh_run.finished_at` for the newest run that reported ok
 * (`buildRollupRefreshFreshnessQuery`, which carries the full argument for why that column and not
 * the two beside it). This function turns it into a sentence, and every clause is load-bearing:
 *
 * · **"Ranking data rebuilt"** names the ROLLUP REBUILD, not the CMD pull. The pull is not
 *   observable at all — there is no run-log for `cmd-explorer`/`indigo-explorer`, and that cron's
 *   210s wall-clock budget silently defers un-pulled customers to the next hour. A sentence saying
 *   "last pulled" would be a claim no SELECT in this database can back.
 * · **A DATE AND A NAMED ZONE, NEVER A BARE HH:MM.** This team spans timezones and the app anchors
 *   civil days to America/Los_Angeles (contract.ts), so "rebuilt at 4:45" is a different claim to
 *   each reader; and without the date a stalled cron's twenty-hour-old timestamp reads as today.
 * · **"up to about 2 hours"** is derived from the schedule rather than guessed: BXR pulls at :00,
 *   Indigo at :30, the rebuild runs at :45 — so a BXR row is invisible for 46 min at best and
 *   **1h45m** at worst (Indigo 17 min / 1h16m), before CMD's own posting lag. Any single-number
 *   staleness claim would be false most of the time; this is the defensible bound.
 *
 * ⚠ BUILT FROM `formatToParts`, NOT `format`. Modern ICU puts a NARROW NO-BREAK SPACE (U+202F)
 * before the day period, so `format()` yields a string that renders fine and fails every assertion
 * written with an ordinary space, invisibly in a diff. Assembling the parts makes the separators ours.
 *
 * PURE, and deliberately takes no `now`: a relative form ("41 min ago") would need one, and a `now`
 * read during render is both untestable and a hydration mismatch. Null / unparseable → the honest
 * unknown, because a freshness read that FAILED must never be dressed as a freshness answer.
 */
const REBUILT_AT_UNKNOWN = 'Ranking data freshness unknown — the rollup rebuild log could not be read.';

export function rebuiltAtSentence(
  rebuiltAt: string | null,
  opts: {
    /**
     * The most recent ranking request FAILED with an answer still on screen. The freshness read and
     * the snapshot read are independent requests fired by the same press, and the heavy one is far
     * the likelier to fail — so this timestamp can legitimately have advanced past the grid beneath
     * it. Say so; do not let the only basis claim on the screen describe a rebuild the rendered list
     * never came from.
     */
    refreshFailed?: boolean;
  } = {},
): string {
  if (rebuiltAt === null) return REBUILT_AT_UNKNOWN;
  const t = Date.parse(rebuiltAt);
  if (Number.isNaN(t)) return REBUILT_AT_UNKNOWN;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(new Date(t));
  const at = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const stamp = `${at('month')} ${at('day')} at ${at('hour')}:${at('minute')} ${at('dayPeriod')} ${at('timeZoneName')}`;
  /* ⚠ THE FAILED ARM DROPS THE CMD LAG BOUND, ON PURPOSE. Two caveats in one sentence bury each
   * other, and "the list you are looking at may not even be from this rebuild" strictly dominates
   * "this rebuild may trail CMD by two hours". The timestamp itself is still stated, because it is
   * true about the REBUILD; what it stops claiming is that it describes the grid. */
  if (opts.refreshFailed === true) {
    return `Ranking data rebuilt ${stamp} — but the last refresh failed, so the ranking below may predate that rebuild.`;
  }
  return `Ranking data rebuilt ${stamp} — the hourly rollup rebuild, so it can trail CMD by up to about 2 hours.`;
}

/**
 * ── THE WINDOW MOVED UNDER YOU, SAID OUT LOUD (S5) ───────────────────────────────────────────────
 *
 * `scopeKeyOf` serializes the automatic case as the literal string `'auto'` and NOT as the ladder's
 * chosen days, so a refresh that re-runs the sufficiency ladder onto a different rung produces an
 * IDENTICAL request key: `loadedKey === scopeKey`, every staleness flag reads "nothing changed", the
 * facet badge goes on saying "On · automatic", and `windowSentence` quietly renders a different
 * number. On a surface whose whole lineage is scope honesty, that is the one silent scope change
 * left — so it gets a sentence rather than a differently-worded paragraph the reader must diff.
 *
 * NAMES THE FLOOR IT MOVED AGAINST. `QUALIFY_RATING_CONFIDENT_PATIENTS` is the threshold the ladder
 * stops at, and "the sample no longer clears the floor" without saying WHICH floor is a mechanism
 * the operator cannot check. Interpolated from the constant rather than typed as "10", so the copy
 * cannot outlive the number.
 *
 * ONE FUNCTION, TWO CHANNELS: the visible `role="status"` notice and `liveSentenceFor` both call it,
 * so the seen and the spoken claim are the same bytes rather than two sentences that agree today.
 *
 * ⚠ NOT ANCHORED TO A MOMENT, AND THAT IS A FIX RATHER THAN A STYLE CHOICE (S5 fix round, M4). This
 * notice NEVER auto-dismisses — `windowMove` clears only on the next resolve, a new refresh, or a
 * navigation — and it correctly survives every grid-narrow toggle, so an operator can sit with it on
 * screen for minutes. The first wording ended "than it did a moment ago", which quietly stops being
 * true while the sentence goes on asserting it. Fixed in COPY, deliberately not with dismissal
 * machinery: naming the REFRESH (a durable event) and stating the span as a fact about the list in
 * front of them is true at any age, and a timer would be new state on a surface whose whole S5 lesson
 * is that in-flight state is where the bugs live.
 *
 * Copy unratified.
 */
export function windowMoveNotice(move: WindowMove): string {
  const floor = `${QUALIFY_RATING_CONFIDENT_PATIENTS}-patient reliability floor`;
  return move.to > move.from
    ? `The automatic window widened from ${move.from} to ${move.to} days on the last refresh — the ${move.from}-day sample no longer clears the ${floor}, so this ranking spans ${move.to} days.`
    : `The automatic window narrowed from ${move.from} to ${move.to} days on the last refresh — the freshest ${move.to} days now clear the ${floor} on their own, so this ranking spans ${move.to} days.`;
}

function FactorRows({ facility }: { facility: QualifyFacility }): React.ReactElement {
  return (
    <ul className="flex list-none flex-col gap-1.5 p-0">
      {facility.factors.map((f) => (
        <li key={f.key} className="flex items-baseline gap-2">
          <span
            className={`w-16 shrink-0 text-xs font-semibold ${
              !f.available ? 'text-ink400' : f.direction === 'pos' ? 'text-teal700' : f.direction === 'neg' ? 'text-status-danger' : 'text-ink600'
            }`}
          >
            {!f.available ? 'No data' : f.direction === 'pos' ? 'Helps' : f.direction === 'neg' ? 'Hurts' : 'Neutral'}
          </span>
          <span className="w-8 shrink-0 text-right font-mono text-xs text-ink400" aria-label={`weight ${f.weight} percent`}>
            {f.weight}%
          </span>
          <span className="text-xs text-ink900">
            <span className="font-semibold">{f.label}.</span> {f.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * THE CENSUS ROW ON THE V3 CARD (S1, 2026-08-08) — beds, UR, auth headroom.
 *
 * v3 is the shipped surface and it carried NO census at all: the #163 bed chip lives on the v2
 * FacilityPanel, which only renders with QUALIFY_V3_FLOW=off. Census still moved the score through
 * `authFit`, so the rep saw a rating shaped by a fact the card refused to state — and after S1 it
 * also moves the ORDER, which makes stating it non-negotiable: a facility cannot be sorted on
 * something the operator cannot see.
 *
 * The bed STATE is not re-derived here. `f.bedState` is the server's answer (bedState.ts), the same
 * value that decided the sort tier, so the greying, the ordering and these words cannot drift apart.
 * The COPY is this surface's own — "3 of 12 beds open" reads better on a wide card than the v2
 * chip's "3 of 12 beds" — with ONE exception: the full case keeps #163's ratified `Full · 0 of N`
 * verbatim, because that sentence was argued over and is pinned by its own tests.
 *
 * CONTRAST. Every chip is 12px (the surface's floor), so every one needs 4.5:1. `text-status-warn`
 * (#C9881E) on its own 10% wash measures **2.71:1** — the v2 chips inherit that and it is not
 * something to propagate into new markup. So hue lives in the BORDER and the WASH and the text is
 * ink900 (≈13.9:1 on either card background). Colour accompanies the word; it never carries it.
 */
interface CensusChip {
  key: string;
  label: string;
  title: string;
  tone: 'warn' | 'plain';
}

function censusChipsOf(f: QualifyFacility): CensusChip[] {
  const chips: CensusChip[] = [];
  const cap = f.bedCapacity;
  if (f.bedState === 'full' && cap !== null) {
    chips.push({
      key: 'beds',
      // #163's ratified copy, unchanged and deliberately so.
      label: `Full · 0 of ${cap}`,
      title: `No open beds — all ${cap} licensed beds occupied on the latest census sync`,
      tone: 'warn',
    });
  } else if (f.bedState === 'open' && f.openBeds !== null) {
    const tight = cap !== null && cap > 0 && f.openBeds / cap <= 0.15;
    chips.push({
      key: 'beds',
      label: cap !== null && cap > 0 ? `${f.openBeds} of ${cap} beds open` : `${f.openBeds} open bed${f.openBeds === 1 ? '' : 's'}`,
      title:
        cap !== null && cap > 0
          ? `${f.openBeds} of ${cap} licensed beds open (${Math.round((f.openBeds / cap) * 100)}% free) on the latest census sync`
          : `${f.openBeds} open bed${f.openBeds === 1 ? '' : 's'} on the latest census sync — licensed bed count not on file, so occupancy is unknown`,
      tone: tight ? 'warn' : 'plain',
    });
  }
  // 'not_applicable' (outpatient) and 'unknown' (no census row / no usable denominator) render
  // NOTHING. Both are "we cannot say", and a card that says nothing is the honest form of that.
  if (f.nextUrDate) {
    chips.push({
      key: 'ur',
      label: `UR ${f.nextUrDate}`,
      title: "A utilization review is scheduled on this facility's census — authorization may change",
      tone: 'warn',
    });
  }
  /* AUTH HEADROOM — authorized days the facility is not using. Server-computed and server-gated
   * (`authHeadroomDays`), so this only formats. Rendered from ONE day out, because "~0d" is not a
   * reading; below that the two averages are the same number and the chip has nothing to add. */
  const h = f.authHeadroomDays;
  const days = h === null ? 0 : Math.round(Math.abs(h));
  // `days >= 1` is the WHOLE condition. It previously sat behind an `Math.abs(h) >= 0.5` guard that
  // could not fail — Math.round(0.5) is 1, so the two tests are the same test — and a branch that
  // cannot be false reads as coverage without being any. One reading, one condition.
  if (h !== null && days >= 1) {
    chips.push({
      key: 'headroom',
      label: h > 0 ? `~${days}d auth headroom` : `~${days}d over auth`,
      title:
        h > 0
          ? `Average authorized stay ${f.avgAuthDays}d vs average actual ${f.avgLosDays}d — about ${days} authorized day${days === 1 ? '' : 's'} typically unused here`
          : `Average actual stay ${f.avgLosDays}d against ${f.avgAuthDays}d authorized — about ${days} day${days === 1 ? '' : 's'} beyond authorization, on the same basis the rating scored`,
      tone: h > 0 ? 'plain' : 'warn',
    });
  }
  return chips;
}

/**
 * `allPayers` is the RANKING's scope, passed down rather than inferred from `f.payerCount`: a
 * single-label card under an all-payers ranking and the same card under a payer-scoped one carry
 * identical counts and are different claims. See the blend disclosure in the body.
 */
function ScoreCard({
  f,
  allPayers,
  /**
   * S3: the member-history mark, ALREADY WORDED (`memberHistoryChipFor`) rather than derived here.
   * The sentence depends on the member bucket, which is a snapshot-level fact this card has no
   * business knowing — and one derivation is what keeps "Seen here before" from being said about a
   * prefix that matched four different people. Null on every card with no annotation, which is every
   * card of the identifier's own footprint by the invariant in `QualifyFacility.memberHistory`.
   */
  historyChip = null,
}: {
  f: QualifyFacility;
  allPayers: boolean;
  historyChip?: string | null;
}): React.ReactElement {
  const location = [f.city, f.state].filter(Boolean).join(', ');
  const chips = censusChipsOf(f);
  /* SUNK, NOT REMOVED (Alec, 2026-08-08). Census sorts, it never filters: a full house drops below
   * everything that can admit today and stays on screen, because the rep is also building a map of
   * where they could send someone tomorrow.
   *
   * ⚠ THE RATIFIED `opacity-60` DIM WAS MEASURED AND REJECTED FOR THIS CARD, and the numbers are
   * the reason rather than taste. That idiom (design-system §Motion; live at the refetch treatment
   * below) is a TRANSIENT state on content that is about to be replaced. Applied persistently to a
   * whole card it composites every text token against the background: ink900 falls 14.73:1 → 4.07,
   * ink600 7.07 → 2.79, and the 30px band numeral 2.99-5.05 → 1.86-2.55. That is below AA for body
   * text and below AA-large for the numeral — an accessibility regression aimed squarely at the row
   * carrying the most operationally important sentence on the screen.
   *
   * So the sink is expressed WITHOUT touching text alpha: the card drops its IQ-band wash for the
   * neutral ground tone (so it visibly recedes from its coloured neighbours, and every text token
   * gains contrast rather than losing it), carries the amber Full chip, and STATES the reason in
   * words. Nothing here gates input, hides the row from assistive technology, or changes its
   * markup order. */
  const sunk = f.bedState === 'full';
  return (
    <li
      data-v3-tile
      data-bed-state={f.bedState}
      className="rounded-xl border border-line bg-surface p-4 shadow-ths-sm"
      // IQ_BAND_WASH at card level (Phase 5): the wash EXTENDS the numeral's hue, which already sits
      // beside its verdict word — colour accompanies the word, never replaces it. Unrated cards keep
      // the plain surface: honest restraint stays visually colourless. A SUNK card also gives it up —
      // the wash is a claim about the paying, and this card's headline is that you cannot use it.
      style={
        sunk
          ? { backgroundColor: QUALIFY_PALETTE.ground }
          : f.iqBand && f.ratingV2 !== null
            ? { backgroundColor: IQ_BAND_WASH[f.iqBand] }
            : undefined
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-ink400" aria-label={`ranked number ${f.rank}`}>
              {f.rank}
            </span>
            <span className="truncate text-base font-semibold text-ink900" title={f.name}>
              {f.name}
            </span>
          </span>
          <span className="text-xs text-ink600">
            {[location || null, f.careSetting].filter(Boolean).join(' · ') || 'Location not mapped'}
          </span>
          <span className="mt-1 text-xs text-ink600">
            <span className="ths-num" aria-label={`${f.distinctPatients} distinct patients of evidence`}>
              {f.distinctPatients}
            </span>{' '}
            patients ·{' '}
            <span className="ths-num" aria-label={`${f.lineCount} charge lines`}>
              {f.lineCount.toLocaleString()}
            </span>{' '}
            lines
            {/* ── THE BLEND DISCLOSURE (Alec, 2026-08-07) ─────────────────────────────────────────
                Under an all-payers ranking this card's percentage and rating are dollar-weighted over
                EVERY billed-under label behind these rows. That honestly answers "what did this
                member's claims actually allow here" and does NOT answer "what does payer X pay here"
                — a facility can read green on an AETNA-heavy mix while the member's other label pays
                badly at the same place. Simpson's paradox, on the screen admissions acts on.

                ⚠ GATED ON THE SCOPE, NOT ON THE COUNT, and the difference is not academic. `payerCount
                > 1` measured live renders on 0 of 14 cards at 30d and 1 of 28 at 365d — so Alec's
                ruling ("each card says across N payers") would have fired almost never, and an
                all-payers card would have been indistinguishable from a payer-scoped one at exactly
                the grain the operator reads. The count is what varies; the SCOPE is what the sentence
                is about. Absent entirely on a payer-scoped ranking, where it would be noise on every
                card of the ~84% of searches that never skip.

                At one label the COUNT alone ("across 1 payer") is a worse sentence than the LABEL, so
                the card names it — `solePayer`, which the core nulls above one precisely so it can
                never name one of several here. */}
            {allPayers ? (
              <>
                {' · '}
                {/* ⚠ THREE STATES, NOT A BINARY. `payerCount > 1 ? … : '1 payer'` read ZERO as one —
                    a fabricated count on the exact surface this disclosure exists to protect. Zero is
                    reachable: count(distinct primary_payer) over an all-NULL group, and
                    identifier-wide mode emits no payer predicate. See core.ts assembleFacilities. */}
                <span className="font-semibold text-ink900">
                  {f.payerCount > 1 ? (
                    <>
                      blended across{' '}
                      <span className="ths-num" aria-label={`${f.payerCount} billed-under labels`}>
                        {f.payerCount}
                      </span>{' '}
                      payers
                    </>
                  ) : f.payerCount === 1 ? (
                    <>
                      <span className="ths-num" aria-label="1 billed-under label">
                        1
                      </span>{' '}
                      payer{f.solePayer ? ` · ${f.solePayer}` : ''}
                    </>
                  ) : (
                    'no billed-under label on these rows'
                  )}
                </span>
              </>
            ) : null}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          {f.ratingV2 !== null ? (
            <>
              <span
                className="font-display text-3xl font-semibold tracking-tight"
                style={{ color: f.iqBand ? IQ_BAND_HEX[f.iqBand] : undefined }}
                aria-label={`rating ${f.ratingV2} out of 100`}
              >
                {f.ratingV2}
              </span>
              {/* The verdict as a WORD beside the colour — hue never carries it alone. The scale is
                  the billing team's own IQ bands ("Watch · 30%+"), not a second vocabulary. */}
              <span className="text-xs font-semibold text-ink600">
                {f.iqBand ? `${IQ_BAND_VERDICTS[f.iqBand]} · ${IQ_BAND_LABELS[f.iqBand]}` : ''}
              </span>
            </>
          ) : (
            <span className="max-w-[130px] text-right text-xs font-medium text-ink600">
              Not enough data to rate — {f.distinctPatients} patient{f.distinctPatients === 1 ? '' : 's'} in window
            </span>
          )}
        </div>
      </div>
      {/* CENSUS — "can they physically go there", which is the first question of the search tree and
          the one this surface used to answer nowhere. 12px, ink text on tinted borders/washes (see
          censusChipsOf for the measured reason the text is not tinted). */}
      {/* ── THE MEMBER-HISTORY MARK (S3, 2026-08-08) ─────────────────────────────────────────────
          "The book ranks, member history annotates." This is the annotation, and it is the most
          operationally decisive thing on a book card: continuity, the facility already knows them,
          prior-auth precedent. It sits ABOVE the census chips because it is about THIS SEARCH rather
          than about the facility's general state, and it carries the teal accent the surface uses
          for "this is about what you asked", never a colour alone — the words say it.

          IT IS ALSO THE VISIBLE REASON FOR THE COMPARATOR'S TIEBREAK. At equal availability and
          equal rating an annotated facility outranks an unannotated one (core.ts), so without this
          mark the grid would reorder itself for a reason nothing on screen states. */}
      {historyChip !== null ? (
        <p data-v3-history className="mt-2 text-xs font-semibold text-teal700">
          {historyChip}
        </p>
      ) : null}
      {chips.length > 0 ? (
        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c.key}
              className={[
                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold text-ink900',
                c.tone === 'warn' ? 'border-status-warn/40 bg-status-warn/10' : 'border-line bg-surface',
              ].join(' ')}
              title={c.title}
            >
              {c.label}
            </span>
          ))}
        </span>
      ) : null}
      {/* THE ROW SAYS WHY IT IS SUNK. A card that dropped below worse-paying facilities without
          explaining itself would be the ranking making a claim it refuses to show its work for —
          and greying alone is a claim carried by appearance, which this surface does not do. */}
      {sunk ? (
        <p className="mt-1.5 text-xs text-ink600">
          No open beds — ranked below every facility that can admit today. The rating is unchanged.
        </p>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-semibold text-teal700">Why this score</summary>
        <div className="mt-2">
          <FactorRows facility={f} />
        </div>
      </details>
    </li>
  );
}

export interface StageAnswerProps {
  resolution: QualifyResolution;
  snapshot: QualifySnapshot | null;
  snapshotError: string | null;
  /**
   * The AI explainer, mounted by the SHELL — a slot, not an import, so this presentational module
   * pulls in no `'use server'` dependency chain (gate → cookies → DB) and stays statically
   * renderable in the hermetic tests. The shell passes `<QualifyAiPanel …autoAsk/>` once the
   * snapshot lands; the plan-tile "Ask AI" drill-down arrives as that panel's autoAsk prop.
   */
  aiPanel: React.ReactNode;
  pending: boolean;
  /**
   * How the snapshot's payer scope was chosen — the shell's pick→ranking bridge (review Critical 1):
   * 'user' = a billed-under chip; 'pick' = the chosen plan's own claims label (claimsPayerLabels[0]);
   * 'dominant' = no label was sent. The captions below MUST distinguish these — "you picked this"
   * and "we defaulted to this" are different claims about the same number.
   *
   * ⚠ 'dominant' STOPPED MEANING ONE THING ON 2026-08-07; amended 2026-08-08 (S6 fix round). It read
   * "nothing to send, the core resolved the identifier's largest payer", which since the reversal
   * describes only HALF the cases that reach it: a plain Skip also sends no label, and the core
   * answers THAT with `payerScope: 'all'` — every billed-under label ranked, no dominant pick made at
   * all. So the value means "the client sent no label", and which of the two the core did with that
   * is read from the RESULT (`resolved.payerScope` / `payerName`), never from here. The code already
   * behaves that way — `billedUnderCaption` takes `allPayers` from the result and lets it outrank
   * every scopeSource row — so this is comment rot cleared, not a behaviour change.
   *
   * It answers ONE question and says nothing about whether a plan was chosen — see `skipped` below
   * and the `ScopeSource` header for the live defect that separation exists to prevent.
   */
  scopeSource: ScopeSource;
  /**
   * WAS A PLAN CHOSEN AT ALL. The reducer's own field (`flow-state.ts`), threaded rather than
   * inferred: only submitting a plan or stepping back through the receipt un-skips (invariants g/h),
   * and in particular a billed-under re-scope does not. Every guard on this screen that suppresses
   * the declined candidate's employer, policy bits, notices and provenance reads THIS.
   */
  skipped: boolean;
  /** The candidate UNIVERSE the filter lines describe: every plan under the picked carrier, or —
   *  after a Skip — every plan behind the identifier. Supplied by the shell so this stays pure. */
  candidates: readonly OrderedCandidate[];
  filters: AnswerFilters;
  onToggleFilter: (facet: 'funding' | 'employer', value: string) => void;
  onClearFilters: () => void;
  /** Set when the employer narrow could not be sent because it exceeded the action's 200 bound —
   *  the caption says the ranking is NOT employer-narrowed rather than implying it is. */
  employerNarrowTooMany: number | null;
  /**
   * The AREA facet: AREA_ALL | a 2-letter state | AREA_OTHER. Narrows the RENDERED scorecard grid
   * only — it is deliberately not part of `filters`, reaches no request, and must never enter
   * `rankingNarrowed` or any caption that describes what was fetched (flow-state.ts invariant m).
   */
  area: string;
  onSelectArea: (key: string) => void;
  /**
   * The FACILITY narrow's vocabulary — `qualifyFacilityOptions`, loaded ONCE by the shell the way the
   * ticker loads trends (mount-once, fail-soft), never inside the snapshot request. EMPTY is a real
   * state, not an error: it is what a first paint and a failed load both look like, and it renders no
   * control at all rather than an empty picker claiming a vocabulary it does not have.
   */
  facilityOptions: readonly QualifyFacilityNarrowOption[];
  /**
   * The picked facilities — canonical picker values. Narrows the RENDERED grid only, exactly like
   * `area`: a sibling of `filters`, never a member, so it reaches no request (flow-state.ts invariant
   * m). Multi-select. See `FacilityNarrowLine` for the measurement behind "display, not fetch".
   */
  facilityNarrow: readonly string[];
  onToggleFacility: (value: string) => void;
  payerOverride: string | null;
  onPayerOverride: (label: string | null) => void;
  windowDays: QualifyTrailingDays | null;
  onWindowDays: (days: QualifyTrailingDays | null) => void;
  /**
   * A RE-SCOPE of content already on screen (window chip, billed-under chip) — per the design
   * system, that keeps the current content rendered at reduced opacity with a thin progress bar,
   * instead of blanking to a skeleton. Skeletons are for genuine first loads only.
   *
   * STRICTLY "a request is in flight". It drives the animated progress beam, so it must never be
   * true for a fetch that has stopped — see `staleAfterError`.
   */
  refetching: boolean;
  /**
   * Content on screen describes a scope the user has moved off, AND the fetch for the new scope
   * FAILED. Dim it exactly like a re-scope — it is equally provisional — but claim no progress: a
   * stopped fetch must not animate a progress marker. Mutually exclusive with `refetching`.
   */
  staleAfterError: boolean;
  /**
   * Re-issue the identical snapshot request. The shell carries a nonce to make this possible: the
   * scope key is unchanged by construction and the fetch effect keys on it, so without an explicit
   * trigger, clicking the same chip again is a no-op.
   *
   * ⚠ TWO RENDER SITES, ONE HANDLER (S5). It was minted for the `refreshFailed` banner's "Try
   * again"; the NARROW SEARCH card's standing "Refresh the ranking" is the same call. Promoting it
   * needed no second refetch path — `retry_requested` is the one reducer case that bypasses the
   * bail-out guard, so it fires with no error present and no input moved — and a second path would
   * be a second writer of the thing the fetch effect keys on.
   *
   * It carries the shell's empty-term guard, which now matters MORE than it did for the banner: a
   * failure implies a request implies a term, but a STANDING control renders on every answer stage
   * and can be pressed after a hot-reload has emptied the PHI ref. It no-ops silently there.
   */
  onRetry: () => void;
  /**
   * A REFRESH IS IN FLIGHT — the refresh's own progress signal, and the reason it needs one is that
   * the other three structurally cannot give it (flow-state.ts invariant o). `refetching` and
   * `staleAfterError` both derive from `loadedKey !== scopeKey`, which on a same-scope re-run is
   * false for the whole in-flight period; `showSkeleton` needs a null snapshot; `pending` is the
   * SERVER ACTION's flag and a refresh does not re-run it. Without this the screen does not move for
   * the 1-2s the request takes and the operator presses again — each press writing one
   * `SEARCH_QUALIFY_PHI` row into a compliance log.
   *
   * Rendered as the design system's RE-SCOPE idiom (dim + progress beam), never a skeleton: a
   * standing control that blanks the answer on every press makes each refresh feel like a rebuild.
   */
  refreshing: boolean;
  /**
   * WHEN THE RANKING INDEX WAS LAST REBUILT — `collections.rollup_refresh_run.finished_at` for the
   * newest ok run, full UTC ISO, or null when the read failed or has not returned. Loaded by the
   * shell as its OWN request (the ticker's mount-once, fail-soft shape), never as a segment of the
   * audited snapshot call. `rebuiltAtSentence` owns the copy and the two columns it must not use.
   */
  dataRebuiltAt: string | null;
  /**
   * THE AUTOMATIC WINDOW MOVED ACROSS A SAME-SCOPE RE-RUN, or null. The one scope change on this
   * surface that no staleness flag can observe — see `windowMoveNotice` and flow-state invariant p.
   */
  windowMove: WindowMove | null;
  /**
   * Is the NARROW SEARCH card showing its FIELDS? The reducer's own bit (flow-state.ts invariant n),
   * threaded rather than held locally: a Skip must land the card open and a plan pick must land it
   * closed, and a `useState` in a component that needs `useActionState` is untestable.
   *
   * ⚠ IT GATES THE CONTROLS, NEVER THE INVENTORY. The card's summary states the resolved scope and
   * every facet's ON/OFF reading in BOTH positions — see the card itself for why that is not a style
   * choice but the ratified promise.
   */
  narrowExpanded: boolean;
  onToggleNarrow: () => void;
}

/**
 * THE ON/OFF INVENTORY BADGE (Alec, 2026-08-07).
 *
 * Every facet on this screen states, in words, whether it is restricting the ranking — because after
 * a Skip the honest answer is "none of them are", and a row of un-highlighted chips does not SAY
 * that. It shows what could be chosen; it never says nothing was. That is the Collections model's
 * fourth behaviour ("the scope is always captioned, INCLUDING the empty state") applied per facet
 * instead of once per screen, which is what a screen with six independent facets needs.
 *
 * `Off · all N` is deliberately not `0 selected`: "off" names the STATE, "all N" names the
 * CONSEQUENCE, and the consequence is the part an operator acts on. An empty selection means NO
 * restriction here exactly as it does in `cmdExplorerQuery.ts` — never `= any(ARRAY[])`, which would
 * match nothing.
 */
/**
 * THE ONE EXPRESSION BEHIND EVERY MULTISELECT FACET'S BADGE — read by the row that carries the
 * controls AND by the NARROW SEARCH card's collapsed summary, which is the whole reason it exists as
 * a function rather than three copies of a ternary.
 *
 * Direct precedent, and it is not hypothetical: the AREA badge's denominator was computed a SECOND
 * way (`chips.length - 1`) and drifted from the list it claimed to count, with a `Math.max(1, …)`
 * floor making the failure silent. A collapsed summary that re-derives "how many of how many" is the
 * same bug with a different denominator. One function, two call sites, no second derivation.
 */
export function facetReading(selected: readonly string[], optionCount: number): { on: boolean; text: string } {
  return selected.length > 0
    ? { on: true, text: `${selected.length} of ${optionCount}` }
    : { on: false, text: `all ${optionCount}` };
}

function FacetState(props: { on: boolean; text: string }): React.ReactElement {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        props.on ? 'bg-teal50 text-teal700' : 'bg-ground text-ink600'
      }`}
    >
      {props.on ? 'On' : 'Off'} · {props.text}
    </span>
  );
}

/** One filter row, styled as the "BILLED UNDER" line: a label, then toggle chips. Multiselect —
 *  `aria-pressed` carries the state and the chip appends " · on" so it is never hue-only.
 *
 *  `data-v3-facet` is the STAGGER HOOK for the skip reveal (see the shell's layout effect). It marks
 *  a row as one beat of the inventory; it carries no styling and nothing reads it at runtime. */
function FilterLine(props: {
  label: string;
  options: readonly Facet[];
  selected: readonly string[];
  onToggle: (v: string) => void;
  /** Trailing note — what the current selection means for the ranking. */
  note?: string;
}): React.ReactElement | null {
  if (props.options.length === 0) return null;
  return (
    <div data-v3-facet className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-ink400">{props.label}</span>
      <FacetState {...facetReading(props.selected, props.options.length)} />
      {props.options.map((o) => {
        const on = props.selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => props.onToggle(o.value)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              on ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600 hover:border-teal200'
            }`}
          >
            {o.value}
            <span className="font-mono tabular-nums text-ink400"> · {o.members.toLocaleString()}</span>
            {on ? ' · on' : ''}
          </button>
        );
      })}
      {props.note ? <span className="text-xs text-ink600">{props.note}</span> : null}
    </div>
  );
}

/**
 * The BILLED UNDER caption — the sentence that says what the chips above it MEAN. Three independent
 * inputs, spelled out as a table because the old nested ternary discriminated on the wrong one and
 * four of these eight rows shipped wrong — three of them saying a PICK had failed when none was
 * made, the fourth ("Your selection.") saying only half of what was true:
 *
 * A NINTH ROW SITS ABOVE THE TABLE (2026-08-07): when `allPayers` is true the ranking is scoped to no
 * label at all, no chip is active, and every row below — which all describe a single-label ranking —
 * is false. It is checked FIRST rather than woven into the table because it is a different KIND of
 * fact: the other three inputs are about how a label was CHOSEN, and this one is about whether one
 * was used.
 *
 *   skipped │ honoured │ source   │ caption
 *   ────────┼──────────┼──────────┼──────────────────────────────────────────────────────────────
 *    true   │  true    │ user     │ no plan chosen, and the label is the operator's own re-scope
 *    true   │  false   │ user     │ no plan chosen, and the chip they sent was rejected
 *    true   │  false   │ dominant │ no plan chosen — the plain skip
 *    false  │  true    │ user     │ a chip, honoured
 *    false  │  true    │ pick     │ the plan pick's own claims label, honoured
 *    false  │  false   │ pick     │ the pick's label was REJECTED — the largest by volume instead
 *    false  │  false   │ user     │ the chip was REJECTED — the largest by volume instead
 *    false  │  false   │ dominant │ nothing was sent at all
 *
 * ⚠ THE SKIPPED ROWS ARE WHY THIS IS A TABLE. The old expression read
 * `payerOverridden ? … : scopeSource !== 'dominant' ? 'Could not scope to the picked plan …' : …`,
 * so a Skip — which sends nothing and picks nothing — landed in the arm written for a rejected PLAN
 * PICK and told the operator a pick had failed when they had declined to make one. `!== 'dominant'`
 * also swallowed a rejected CHIP into the same "picked plan" wording; that row is now its own too.
 *
 * ⚠ THE PARAGRAPH THAT STOOD HERE FORBADE THE CHANGE THAT THEN SHIPPED — amended 2026-08-08 (S6 fix
 * round), and quoted rather than deleted because the instruction was right when it was written. It
 * read: "The skipped copy describes the ranking AS IT BEHAVES TODAY — one dominant billed-under
 * label, the single-label equality in the ranking query. Widening it to the identifier's whole
 * footprint is a separate change, and copy must never pre-announce behaviour that is not shipped."
 *
 * That separate change IS the 2026-08-07 reversal, and it shipped. There is no single-label equality
 * on the skip path any more: the request carries `payerScope: 'all'` and the result comes back with
 * `payerName === null`. So the rule now reads the other way round — the copy must describe the WIDE
 * ranking, and the table below already does, through the `allPayers` row that outranks every other.
 * That row takes its value from the RESULT (`resolved.payerScope`), never from the request, so the
 * caption cannot claim a widening the core declined to perform. Nothing about the discipline changed:
 * copy still describes shipped behaviour. Only the shipped behaviour did.
 */
/* [BOOK-LED EXEMPT: every row describes how the billed-under LABEL was chosen]
 * The book is scoped to that same label, so each row stays true word for word. The population
 * changed; the label's provenance did not. */
export function billedUnderCaption(args: {
  skipped: boolean;
  payerOverridden: boolean;
  scopeSource: ScopeSource;
  /** The RESULT, from `resolved.payerScope` — not the request. See the all-payers row below. */
  allPayers?: boolean;
}): string {
  // ── ALL-PAYERS OUTRANKS EVERY ROW BELOW, and it has to (2026-08-07). Under an identifier-wide
  // ranking NO chip is active, and every string below describes a ranking scoped to ONE label —
  // including the plain-skip row, which used to be the honest answer here and is now the description
  // of a state the skip no longer produces. This is the un-blend affordance's own caption, so it
  // says what the chips DO rather than what was chosen.
  if (args.allPayers) return 'No label selected — ranking across all of them. Pick one to un-blend.';
  if (args.skipped) {
    // NO PLAN WAS CHOSEN leads, because it stays true however the payer label was arrived at.
    if (args.payerOverridden) return 'No plan chosen — this label is your own re-scope.';
    if (args.scopeSource === 'user') return 'No plan chosen — that label could not be applied; showing the largest by volume.';
    return "No plan chosen — showing this identifier's largest label by volume; pick another to re-scope.";
  }
  if (args.payerOverridden) return args.scopeSource === 'user' ? 'Your selection.' : 'Scoped to the plan you picked.';
  if (args.scopeSource === 'pick') return 'Could not scope to the picked plan — showing the largest by volume.';
  if (args.scopeSource === 'user') return 'That label could not be applied — showing the largest by volume.';
  return 'Largest by volume — pick another to re-scope.';
}

/**
 * The AREA chip row — the restored location narrow, rendered in the desktop `FilterLine` idiom
 * (label + toggle chips) rather than the mobile `<AreaChips>` component, whose inline styles belong
 * to the PWA. SINGLE-select, because `facilitiesInArea` takes one key and because "All" is a chip
 * rather than an absence: an explicit way back is what stops a narrow becoming a trap.
 *
 * It lives INSIDE the scorecard section, not on the control card above it, and that placement is the
 * honesty argument made in layout: everything on the control card re-issues the ranking request,
 * and this does not. Selection carries the word "showing", never hue alone (I9).
 */
export function AreaLine(props: {
  chips: readonly AreaChip[];
  active: string;
  counts: ReadonlyMap<string, number>;
  /**
   * How many rows are ACTUALLY on screen — after every grid narrow, not just this one.
   *
   * ⚠ IT EXISTS BECAUSE A SECOND GRID NARROW ARRIVED (S4). Until then the area was the only narrow, so
   * a lit chip meant rows by construction and " · showing" could not be false. Composed with a facility
   * narrow it can be: "All · 2 · showing" renders above ZERO cards. The counts stay over the RANKING —
   * they are the area's own denominators, and their aria-labels say "ranked" — but the WORD has to
   * describe the screen.
   */
  shown: number;
  onSelect: (key: string) => void;
}): React.ReactElement {
  // AREA IS A FACET OF THE INVENTORY EVEN THOUGH IT DOES NOT LIVE ON THE CONTROL CARD (2026-08-07).
  // Its placement beside the grid is deliberate and unchanged — everything on the control card
  // re-issues the ranking request and this does not — but "where the control sits" and "is this
  // facet restricting what I am looking at" are different questions, and the inventory answers the
  // second. Without the badge and the `anyFacetOn` term, the headline sentence reads "nothing is
  // restricting this search" beside a LIT Area chip: the exact contradiction `payerFacetOn` was added
  // to prevent, on the one facet Alec named by name. `data-v3-facet` enrols it in the skip reveal's
  // stagger, which selects on the attribute across the stage rather than inside the control card.
  const on = props.active !== AREA_ALL;
  // ⚠ COUNT THE AREA CHIPS, DO NOT SUBTRACT ONE FROM THE LIST. This read `props.chips.length - 1`,
  // i.e. "everything except the All chip" — an assumption about a list whose composition belongs to
  // the area module, not to this file. If `areaChipsWithActive` ever stops emitting the literal All
  // chip, or grows a second non-area entry, subtraction prints a wrong denominator, and the
  // `Math.max(1, …)` that guarded it made that failure SILENT rather than loud. Filtering on the key
  // asks the list what it contains instead of assuming, and needs no floor: an empty area set cannot
  // reach here (the render gate upstream requires >2 chips or an active narrow).
  const areaOptions = props.chips.filter((c) => c.key !== AREA_ALL).length;
  return (
    <div data-v3-facet className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter the ranked list by area">
      <span className="text-xs font-medium uppercase tracking-wide text-ink400">Area</span>
      <FacetState on={on} text={on ? `1 of ${areaOptions}` : `all ${areaOptions}`} />
      {props.chips.map((c) => {
        const on = c.key === props.active;
        const n = props.counts.get(c.key) ?? 0;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            onClick={() => props.onSelect(c.key)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              on ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600 hover:border-teal200'
            }`}
          >
            {c.label}
            {/* Proper pluralization (review Finding 3) — the same `${n === 1 ? '' : 's'}` idiom
                `panelProvenance` already uses for "member"/"charge line" (resolution.ts). Every
                non-'All' chip in a real ranking routinely carries n=1 (three facilities across three
                distinct states means every per-state chip's count IS 1), so "1 ranked facilities" was
                not an edge case — it was the common case. */}
            <span
              className="font-mono tabular-nums text-ink400"
              aria-label={`${n} ranked facilit${n === 1 ? 'y' : 'ies'}`}
            >
              {' '}
              · {n}
            </span>
            {/* I9 says selection carries a WORD, never hue alone — so the word stays either way; it
                just has to be a TRUE one. The chip IS selected; over an empty grid it is not showing
                anything. `selected` is the house vocabulary the window chips already use. */}
            {on ? (props.shown > 0 ? ' · showing' : ' · selected') : ''}
          </button>
        );
      })}
    </div>
  );
}

/**
 * ── THE FACILITY NARROW (S4, Alec 2026-08-08) ───────────────────────────────────────────────────
 *
 * WHAT WAS LOST. v2's tab carried a Facility type-ahead in its primary search row; the 2026-08-06 v3
 * cutover dropped it, and — like the AREA facet above — the drop is absent from the ratified pattern
 * doc's deliberate-drops list, so it was a casualty rather than a ruling.
 *
 * ⚠ IT NARROWS THE FETCHED SET, NOT THE FETCH, AND THAT IS A MEASURED DECISION RATHER THAN A
 * STRUCTURAL CONVENIENCE. The obvious build is a fetch narrow — the ranking query would take
 * `upper(facility) = any($n::text[])` today and it measures AT OR BELOW baseline. It is still the
 * wrong build: **86.9% of members (3,759 of 4,324) bill at exactly ONE facility in 365 days**, so a
 * facility narrow on a member search is a 1-or-0 outcome almost always — which makes the EMPTY state
 * the common render rather than an edge case. A fetch narrow's empty screen can only say "no history
 * at NASHVILLE". A narrow over the already-fetched set can say *"no history at NASHVILLE — this
 * member billed at LSMH and KWC"*, because the un-narrowed list is still in hand. Strictly more
 * information, zero extra round trips, and no refetch on toggle. See `gridNarrowEmptyCopy`.
 *
 * ⚠ IT RENDERS **BESIDE THE GRID WITH AREA**, NEVER ON THE NARROW SEARCH CARD (controller ruling
 * 2026-08-08, flagged to Alec). His earlier "folds into the card" wording yields to his later
 * fetched-set ruling plus the card's own documented rule — *everything on the control card re-issues
 * the ranking request, and this does not*. That rule is exactly why AREA was sorted out of the card
 * and kept out of `cardFacets`; a requestless field inside the card would either break it or force
 * it to be re-ruled. So the two beside-the-grid narrows sit together, and the card's tally NAMES
 * them rather than absorbing them.
 *
 * THE SHARED PICKER, IN CLIENT MODE. `MultiSelectTagPicker` is the same primitive Collections and the
 * v2 tab render; the vocabulary is 47 options, small enough to load once and filter locally, so no
 * `onQueryChange` and no `minChars`. MULTI-select, because the picker is multi by nature and "show me
 * these two houses" is a real question — single-select would be a restriction invented to simplify
 * the empty state, and the empty state handles a list already.
 *
 * The badge rides the picker's own label row (the Employers precedent): the picker owns the only
 * label this facet has, and a second "Facility" heading above it would say the word twice to a
 * screen reader. `data-v3-facet` enrols it in the skip reveal's stagger, which selects across the
 * stage rather than inside the card.
 */
export function FacilityNarrowLine(props: {
  options: readonly QualifyFacilityNarrowOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}): React.ReactElement {
  /* ⚠ `facetReading(selected, 0)` PRINTS "On · 1 of 0". Reachable rather than theoretical: a failed
     vocabulary reload leaves the selection behind, and `showFacilityLine` deliberately keeps the
     control on screen in that state so the narrow stays clearable. GUARDED rather than commented — a
     denominator of zero under a numerator of one is a broken readout, and the honest thing to say is
     that the list is missing. */
  const reading =
    props.options.length === 0
      ? { on: props.selected.length > 0, text: `${props.selected.length} picked · list unavailable` }
      : facetReading(props.selected, props.options.length);
  return (
    <div data-v3-facet className="min-w-[15rem] max-w-md flex-1">
      <MultiSelectTagPicker
        label="Facility"
        badge={<FacetState {...reading} />}
        placeholder="Type a facility name…"
        icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
        /* `searchText` carries every RAW CMD spelling plus the canonical value, so an operator typing
           what CMD calls the facility finds it. `display` is NOT recomposed into "ACRONYM — Full Name":
           label parity with the score cards is the whole reason display_acronym is preferred, and the
           picker echoes `display` back inside the selected tag. See `pickerMatches`. */
        options={props.options.map((o) => ({
          value: o.value,
          display: o.display,
          badge: o.careSetting,
          searchText: [...o.variants, o.value],
        }))}
        selected={props.selected}
        onToggle={props.onToggle}
        /* The Employers precedent: `onClear` walks the selection back through the SAME toggle rather
           than reaching for a second reducer action. `facility_narrow_toggled` is the machine's only
           write to this field, and a second writer of a narrowing field is the shape `scopeKeyOf`'s
           header is a post-mortem of. */
        onClear={() => {
          for (const v of props.selected) props.onToggle(v);
        }}
        tone="score"
      />
    </div>
  );
}

/**
 * THE SENTENCE THE WHOLE FEATURE EXISTS FOR — and, since fix round 1, the AREA arm too.
 *
 * ⚠ IT OWNS **BOTH** BLAMED ARMS, WHICH IS A CHANGE OF SCOPE AND THE POINT OF IT. S4 shipped the area
 * sentence as an inline literal beside this function, and that split made an EXISTING claim false: both
 * arms computed "the N facilities behind this answer" from the UN-narrowed leading list while
 * instructing the operator to clear ONE control. With `facility=['PHX']` and `area='TN'`, "The 3
 * facilities … choose All above to see them" resolves to ONE row, because the facility narrow is still
 * on. That is the PRE-S4 string, so the regression was a truth regression in shipped copy, not merely
 * a loose new claim. The recovery clause now promises what clearing THAT control actually yields, and
 * names BOTH controls when one click cannot get back to everything.
 *
 * Pure and exported so the copy is testable without a render, and because the branch it makes is a
 * DECISION (which emptiness is this, and what is the way out?) rather than markup. The JSX site keeps
 * the `role="status"` and its book-led marker; this owns the words.
 *
 * The facility arms, and why each is a different claim:
 *  1 · BOOK-LED, and the member HAS billed at some of the picks. The member ranking is FLOORLESS and
 *      the book applies `QUALIFY_MIN_LINES`, so a facility they billed 1-2 lines at is in `facilities`
 *      and NOT in `bookFacilities`. "No history there" would be flatly false about the one fact on the
 *      screen that decides an admission. The floor is the only possible cause (both loads are the same
 *      query over the same rollup with the same payer, window and market — the member's rows are a
 *      SUBSET of the book's before it), which is why this sentence may name it.
 *      ⚠ ITS SUBJECT IS `pickedWithHistory`, NOT `picked`. A boolean over the whole selection let
 *      picks ['NASH','KWC'] against a footprint of NASH alone assert paid claims at a facility with
 *      zero rows — fabricated history, reachable through exactly the "show me these two houses" case
 *      multi-select exists for. The picks with nothing get their own disclaiming clause rather than
 *      being silently dropped.
 *  2 · BOOK-LED, and they have not. The claim is about the PAYER'S BOOK, not about the member, so the
 *      member's own footprint is named separately rather than folded in.
 *  3 · MEMBER-LED, with somewhere else to name. Alec's ruling rationale.
 *  4 · MEMBER-LED, with nowhere else to name. Reachable: `facilitiesElsewhere` strips the
 *      `No Facility` placeholder, so every other row can be a bucket rather than a place. "This member
 *      billed at " with nothing after it would be the fabricated-place claim in its most literal form.
 *
 * EVERY ARM NAMES ITS WINDOW (basis discipline, S2). Arms 1 and 3 shipped without one while 2 and 4
 * had it, which is a mixed-basis screen by omission.
 *
 * Copy unratified.
 */
export function gridNarrowEmptyCopy(input: {
  /** WHICH narrow emptied the grid — computed by the caller, never guessed. */
  blame: 'area' | 'facility';
  areaActive: boolean;
  facilityActive: boolean;
  /** Display labels of every picked facility. */
  picked: readonly string[];
  /** Display labels of the picks the member's OWN footprint actually covers. A subset of `picked`. */
  pickedWithHistory: readonly string[];
  bookLeads: boolean;
  bookPayer: string | null;
  /** The LEADING list's length — what clearing BOTH narrows yields. */
  rankedTotal: number;
  /** Rows left after clearing the FACILITY narrow (i.e. the area narrow alone). */
  afterClearingFacility: number;
  /** Rows left after clearing the AREA narrow (i.e. the facility narrow alone). */
  afterClearingArea: number;
  /** The member's other facilities, by name, placeholder already removed. */
  elsewhere: readonly string[];
}): string {
  const all = facilityCount(input.rankedTotal);
  /* THE WAY BACK, AND THE COUNT IT REALLY DELIVERS. A narrow with no stated way out is a trap; a way
     out that promises a number it cannot produce is worse, because the operator believes it. */
  const recovery = ((): string => {
    if (input.blame === 'facility') {
      if (!input.areaActive) return `Clear the facility above to see all ${all}.`;
      if (input.afterClearingFacility > 0) {
        return (
          `Clear the facility above to see the ${facilityCount(input.afterClearingFacility)} in this area,` +
          ` or clear the area too to see all ${input.rankedTotal}.`
        );
      }
      // BOTH NARROWS INDEPENDENTLY EMPTY. Clearing either one alone still shows nothing, so a
      // single-click promise would resolve to ZERO — say so and name both controls.
      return `Both narrows are on and neither has rows of its own — clear the area and the facility above to see all ${all}.`;
    }
    if (!input.facilityActive) return `The ${all} behind this answer ${input.rankedTotal === 1 ? 'is' : 'are'} still there — choose All above to see them.`;
    if (input.afterClearingArea > 0) {
      return (
        `Choose All above to see the ${facilityCount(input.afterClearingArea)} you picked,` +
        ` or clear the facility too to see all ${input.rankedTotal}.`
      );
    }
    return `Both narrows are on and neither has rows of its own — choose All above and clear the facility to see all ${all}.`;
  })();

  if (input.blame === 'area') return `No ranked facility is in this area. ${recovery}`;

  const where = andList(input.picked);
  if (input.bookLeads) {
    // "This book" rather than "null's book": `scopedPayerOf` refuses a name the scope contradicts, and
    // a possessive built on that null is how a caption starts naming nobody in particular.
    const whoseMid = input.bookPayer === null ? 'this book' : `${input.bookPayer}'s book`;
    const whoseCap = input.bookPayer === null ? 'This book' : `${input.bookPayer}'s book`;
    if (input.pickedWithHistory.length > 0) {
      const seen = andList(input.pickedWithHistory);
      const unseen = input.picked.filter((p) => !input.pickedWithHistory.includes(p));
      // The pronoun follows the SUBJECT of the claim, not the size of the selection.
      const it = input.pickedWithHistory.length === 1 ? 'it' : 'them';
      const disclaimer = unseen.length > 0 ? ` ${whoseCap} has no rows at ${andList(unseen)} at all.` : '';
      return (
        `This member HAS billed at ${seen}, but ${whoseMid} does not rank ${it} in the window shown:` +
        ` the book applies a volume floor and this member's own lines there are below it.` +
        `${disclaimer} ${recovery}`
      );
    }
    const elsewhere = input.elsewhere.length > 0 ? ` This member billed at ${andList(input.elsewhere)}.` : '';
    return `${whoseCap} has no rows at ${where} in the window shown.${elsewhere} ${recovery}`;
  }
  if (input.elsewhere.length > 0) {
    return `No history at ${where} in the window shown — this member billed at ${andList(input.elsewhere)}. ${recovery}`;
  }
  return (
    `No history at ${where} in the window shown. The other rows behind this answer have no facility` +
    ` on them at all, so there is nowhere else to name. ${recovery}`
  );
}

/** First-load ghost sized to the real footprint (window line + hero + two scorecard rows), so the
 *  swap to content does not shift layout. aria-hidden — the visible status line above it announces. */
function AnswerSkeleton(): React.ReactElement {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <div className="h-[74px] animate-pulse rounded-lg border border-line bg-surface" />
      <div className="h-[104px] animate-pulse rounded-xl border border-line bg-surface" />
      <ul className="grid list-none grid-cols-1 gap-3 p-0 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="h-[108px] animate-pulse rounded-xl border border-line bg-surface" />
        ))}
      </ul>
    </div>
  );
}

export function StageAnswer(props: StageAnswerProps): React.ReactElement {
  const { resolution: r, snapshot: snap } = props;
  const g = r.group;
  // ⚠ A SKIPPED SEARCH HAS NO CHOSEN PLAN. `r.group` is still the PRE-SELECTED candidate (the
  // largest employer), and rendering its employer/funding/plan-type as "the resolved policy" claims
  // the user picked a plan they explicitly declined to pick — while the ranking underneath is
  // payer-wide (no payerOverride, no market: verified at the fetch). The identity line names the
  // payer the ranking actually used instead.
  //
  // ⚠ THIS READS THE REDUCER FIELD, NOT `scopeSource`. It used to be `props.scopeSource === 'skipped'`,
  // and one billed-under chip press after a Skip flipped that enum to 'user' and turned every guard
  // below off at once — re-presenting the declined plan as a picked one. See the `ScopeSource` header.
  const skipped = props.skipped;
  // The four render states, named once. A FAILED REFETCH is not a first load and must not be
  // rendered as one: `refreshFailed` keeps the last-known-good answer on screen and APPENDS the
  // banner, where `firstLoadFailed` has nothing to preserve and shows the bare error.
  const firstLoadFailed = props.snapshotError !== null && snap === null;
  const refreshFailed = props.snapshotError !== null && snap !== null;
  /* Dim for any of the three — all mean "what is on screen is provisional". The first two are
   * "you moved off this scope"; the third (S5) is "you asked for this same scope again", which is
   * invisible to `isRefetching` by construction and would otherwise leave a standing refresh control
   * looking dead for 1-2s. Dimming says provisional; the BEAM claims progress, so it stays tied to
   * the two states where a request is genuinely running and drops `staleAfterError`. */
  const stale = props.refetching || props.staleAfterError || props.refreshing;
  const inFlight = props.refetching || props.refreshing;
  // Equivalent to the previous inline expression for every reachable state: with snap === null it
  // reduces to the same `pending || !error`, and with a snapshot present it is false — the old
  // `pending && !refetching` arm was unreachable because all four submit paths null the snapshot
  // before dispatching.
  const showSkeleton = snap === null && (props.pending || props.snapshotError === null);
  /**
   * IS THE RANKING SPANNING EVERY BILLED-UNDER LABEL? Read off `resolved.payerScope`, which the CORE
   * sets from what it actually ranked — never off `skipped`, which is a client intention. A Skip plus
   * a billed-under chip is a payer-scoped ranking with `skipped` still true, and the whole point of
   * this file's #157/#165 lineage is that intentions and results get separate variables.
   */
  const allPayers = snap?.resolved?.payerScope === 'all';
  // ⚠ THE ONLY HONEST PAYER NAME AFTER A SKIP is the one the SNAPSHOT actually resolved. `scopePayer`
  // falls back to `g.payerDisplayName` — the DECLINED candidate's carrier — which is tolerable for
  // the identity line's shipped wording (7c86709) but would smuggle that carrier straight back into
  // the disclosure captions this fix exists to clean, in the exact window where we know least
  // (snapshot still loading, or a first load that failed). Name NOBODY rather than name the payer of
  // a plan the user declined — and under an all-payers ranking name nobody FULL STOP, because there
  // is no single payer to name and the carrier of the declined plan is the worst available guess.
  const scopePayer = allPayers ? null : (snap?.resolved?.payerName ?? g.payerDisplayName);
  const skipUnder = allPayers
    ? ' across every payer on file'
    : snap?.resolved?.payerName
      ? ` under ${snap.resolved.payerName}`
      : '';
  const policyBits = [
    g.employerLabel ?? 'No plan sponsor on file',
    g.funding ?? 'Funding not captured',
    g.planType ?? 'Plan type not captured',
    g.network ?? 'Network not captured on this VOB',
  ].join(' · ');
  const facets = useMemo(() => facetsOf(props.candidates), [props.candidates]);
  const filteredCandidates = useMemo(
    () => filterCandidates(props.candidates, props.filters),
    [props.candidates, props.filters],
  );
  const filtersActive = answerFiltersActive(props.filters);
  // ⚠ NOT just `filtersActive`. That helper answers "is a CANDIDATE filter narrowing the plan list",
  // which covers three of the six facets. The inventory's headline sentence makes a claim about ALL
  // of them, so it counts the billed-under scope too. (Window is excluded deliberately — it is never
  // off; see its FacetState.) Reusing filtersActive here would print "every switch is off" beside a
  // lit BILLED UNDER chip.
  //
  // The `> 1` guard is not defensive padding: with ONE label on file, that label IS the whole
  // footprint, the chip row does not render at all, and calling the scope a switch-that-is-on would
  // point the operator at a control they cannot see, to widen a search that is already as wide as it
  // can be.
  const payerFacetOn = snap !== null && snap.payerOptions.length > 1 && !allPayers;
  /**
   * ⚠ A SKIP IS NOT A PROMISE THAT THE FETCH STAYED WIDE, and v1 of this fix assumed it was.
   * NEITHER of the two values that reach this component knows anything about the answer-stage filter
   * chips: `props.skipped` is the reducer field, written only by Skip / a plan pick / a step back
   * (flow-state.ts, invariants g/h), and `props.scopeSource` is `scopeSourceOf(payerOverride,
   * pickLabel)` (resolution-flow-client.tsx:212), which reads the two payer-label inputs and nothing
   * else. But the fetch effect DOES fold active filters into a real `market` payload
   * (client :269-282): funding goes straight through, and the employer selection narrows by way of
   * the employer set `employerNarrowFor` resolves it to. So "Skip, then one Funding chip" was rendering
   * "this identifier's whole footprint" over a funding-narrowed snapshot, flatly contradicting the
   * "Ranking over N of M plans" line a few rows above it.
   *
   * Recomputed here with the SAME pure function on the SAME inputs the shell used — `props.candidates`
   * IS the shell's `answerCandidates` and `props.filters` IS its `filters` (client :481, :482) — not a
   * second derivation that can drift from the request. That precision earns its keep in two states
   * where "filters are active" and "the ranking is narrowed" come apart: a narrow `employerNarrowFor`
   * refused as not-a-narrow (:325), and one that exceeded the send bound (`tooMany`, :326). Neither
   * reached the request, the plan-count line already discloses the second, and neither may be claimed
   * here — so those fall back to the whole-footprint wording, which is what the snapshot really is.
   */
  const employerNarrow = filtersActive ? employerNarrowFor(props.candidates, filteredCandidates) : null;
  const rankingNarrowed =
    props.filters.funding.length > 0 || (employerNarrow !== null && 'employers' in employerNarrow);
  // Hoisted ahead of `skipProvenance` (below) on purpose — the AI caption needs it too, and a
  // `const` must precede every place that reads it. Trivial and `snap`-independent (props.area alone
  // decides it), so hoisting costs nothing; the fuller AREA-facet block that DOES depend on `snap` —
  // `rankedFacilities`, `areaChips`, `shownFacilities` — stays where it was, next to the grid it
  // narrows. This is the ONLY declaration of `areaActive`; do not re-declare it below.
  const areaActive = props.area !== AREA_ALL;
  // The SECOND beside-the-grid narrow (S4), hoisted for the same reason `areaActive` is: the headline
  // sentence, the tally and the empty states all read it, and a facet re-derived per surface is how
  // they come to disagree.
  const facilityNarrowActive = props.facilityNarrow.length > 0;
  // BOTH BESIDE-THE-GRID NARROWS COUNT AS FACETS (area 2026-08-07, facility 2026-08-08), which is why
  // this sits BELOW them rather than beside `payerFacetOn` above. They are the two facets whose
  // controls live outside the control card — see AreaLine and FacilityNarrowLine for why that
  // placement is right and why it does not exempt them from the inventory — and omitting either let
  // one click produce "nothing is restricting this search" beside a lit control that is restricting it.
  const anyFacetOn = filtersActive || payerFacetOn || areaActive || facilityNarrowActive;
  /* ── THE PAYER'S WHOLE BOOK (S2, 2026-08-08) ────────────────────────────────────────────────────
   *
   * A SECOND ranked list, loaded by the core alongside the identifier's own footprint. It exists
   * because 58.8% of searches resolve to ONE member carrying 1.14 facilities of history — ranking
   * that is not thin, it is malformed, and the list that actually answers "does this policy pay,
   * anywhere" is the payer's book.
   *
   * NULL, NOT EMPTY, when there is no single payer to have a book (the identifier-wide Skip): the
   * all-payers whole book is a 206-713ms scan that spills to disk and belongs in an hourly cache.
   * Rendering an empty shell there would claim a list that was never fetched.
   *
   * Declared HERE, above `skipProvenance`, because the AI grounding caption needs it — "the ranking
   * on screen" identifies nothing once there are two rankings on screen.
   *
   * S2 RENDERS IT SECONDARY, BELOW THE MEMBER RANKING. The prominence flip is S3's, not this file's.
   */
  const bookFacilities: readonly QualifyFacility[] | null = snap?.bookFacilities ?? null;
  /* THE NAME THE BOOK IS ABOUT, taken from the SCOPE rather than from the payer name — `scopedPayerOf`
   * refuses a label whose `payerScope` contradicts it, which is the guard that stops a wider ranking
   * being captioned with one payer's name. Deliberately NOT `scopePayer` a few dozen lines above:
   * that value falls back to `g.payerDisplayName`, the DECLINED candidate's carrier, which is
   * tolerable for the identity line's shipped wording and would be a fabricated basis on a heading
   * that names whose book this is. */
  const bookPayer = scopedPayerOf(snap?.resolved);
  /* HOW MANY OF THE ROWS THE SECONDARY CAP REMOVES HAVE NO OPEN BEDS — a COUNT of this render, which
   * is what the cap sentence says instead of predicting where the full houses are. See that sentence's
   * own note for why the prediction was false in two reachable states. Reads `bedState` (the server's
   * answer, and the same value that decided the sort tier) rather than re-deriving fullness from
   * `openBeds === 0`, which is written on every outpatient row. */
  const bookHiddenFull = (bookFacilities ?? EMPTY_FACILITIES)
    .slice(QUALIFY_BOOK_PREVIEW)
    .filter((f) => f.bedState === 'full').length;
  // ONE PREDICATE, TWO CONSUMERS — see `bookIsOnScreen`. The shell asks the same question to caption
  // the AI panel.
  const bookOnScreen = bookIsOnScreen(snap);
  /* ── THE INVERSION (S3, Alec 2026-08-08) ────────────────────────────────────────────────────────
   *
   * At ONE member the payer's book becomes the answer's own ranked grid and the identifier's
   * footprint survives as annotations on it. `bookLeadsAnswer` owns the whole rule (including why an
   * empty book cannot lead); everything below reads this one boolean, because a flip re-derived per
   * surface is how six claim surfaces come to disagree about which list the screen is showing.
   *
   * ── ⚠ DO NOT PUT THE LIST OF SURFACES HERE. **grep for `BOOK-LED`.** ─────────────────────────
   *
   * This block used to ENUMERATE the surfaces that follow the flip and the ones that do not, and
   * that list is what hid a defect through an entire review: the scope-honesty banner a few hundred
   * lines below was never on it, so both the author and the reviewer checked the LIST instead of the
   * FILE and shipped a coral alarm claiming the member's ranking over the book's grid. An index
   * maintained by hand, in a different place from the code it describes, rots in exactly one
   * direction — it stays convincing while it stops being true.
   *
   * So the index is now an INSTRUCTION, and the surfaces carry their own marks:
   *
   *     grep for `BOOK-LED` in this file. Every claim surface carries exactly one of
   *       · `[BOOK-LED SURFACE]`          — it re-bases when the book leads, and says how, at the site
   *       · `[BOOK-LED EXEMPT: <reason>]` — it does not, and the reason is written where it applies
   *
   * A new claim surface with neither is the bug. `app/test/qualifyV3Flow.test.tsx` enforces this
   * mechanically for every `role="status"` in the file — the LOUD class, which is the class the
   * missed one belonged to — and the test's own comment is explicit that `role="status"` is a proxy
   * rather than a definition: the non-status surfaces (`resolvedScopeSentence`, `billedUnderCaption`,
   * the trace rows, the hero's basis) carry markers too, so the grep still enumerates the whole set.
   *
   * ONE THING THAT IS NOT A RENDER DECISION AND SO CANNOT CARRY A MARKER: **the AI payload.**
   * `buildQualifyAiInput` still maps `snap.facilities` — the member-scoped list — with an unchanged
   * schema. Sending the book instead would be a schema + system-prompt + firewall change and is a
   * SEPARATE RULING. That is why the captions say what actually backs the answer rather than letting
   * the screen relabel it. Mobile (`/qualify/m`) is the other: it keeps the member-scoped deck until
   * its own pass, pinned by a scan test in app/test/qualify-mobile-render.test.tsx.
   */
  const bookLeads = bookLeadsAnswer(snap);
  /* THE LIST THAT LEADS, RESOLVED ONCE. Everything downstream — the area facet, the counts, the
   * hero, the grid — reads this rather than choosing for itself. `bookLeads` implies a non-empty
   * `bookFacilities` (its own precondition), so the `?? EMPTY_FACILITIES` is unreachable and kept
   * only because TS cannot narrow through the predicate. */
  const answerFacilities: readonly QualifyFacility[] = bookLeads
    ? (bookFacilities ?? EMPTY_FACILITIES)
    : (snap?.facilities ?? EMPTY_FACILITIES);
  /* THE HERO, DERIVED FROM THE LIST THAT LEADS — and it SAYS which list that is.
   *
   * `derivePolicyRating(snap.facilities)` was right while the member ranking was the answer. In
   * book-led mode the honest basis for "should I take this policy" IS the book: it is the list on
   * screen, and a bar that patient-weights a list nobody drew breaks the reconciled-by-construction
   * invariant in the one place that invariant exists to hold (policyRating.ts's own header). The
   * scope label is passed rather than derived there, because that module cannot tell two
   * `QualifyFacility[]`s apart and a guess would be a second derivation. */
  const rating = snap
    ? derivePolicyRating(answerFacilities, bookLeads && bookPayer !== null ? `${bookPayer}'s whole book` : undefined)
    : null;
  /* ── THE HOLE THE FLIP OPENS, NAMED RATHER THAN SWALLOWED ────────────────────────────────────────
   *
   * The member ranking is FLOORLESS and the book applies QUALIFY_MIN_LINES (core.ts, deliberately:
   * every facility the identifier billed is relevant, but a payer-wide ranking should not carry a
   * "100% on one claim" fluke). So a facility the member billed 1-2 lines at is in `facilities` and
   * NOT in `bookFacilities` — and once the member grid stops rendering, its annotation has nothing
   * to ride on. "Its information survives as annotations" would then be false for exactly the rows
   * where n is smallest and continuity matters most.
   *
   * The FLOOR is the only possible cause, which is why the sentence can name it: both loads are the
   * same query over the same rollup with the same payer, window and market: the member's rows are a
   * SUBSET of the book's before the floor, so a missing key means the payer-wide line count is below
   * it. Facility names are non-PHI (they already render on every card).
   */
  const unlistedMemberFacilities: readonly QualifyFacility[] = useMemo(() => {
    if (!bookLeads || snap === null) return EMPTY_FACILITIES;
    const inBook = new Set((bookFacilities ?? []).map((f) => f.facilityKey));
    return snap.facilities.filter((f) => !inBook.has(f.facilityKey));
  }, [bookLeads, snap, bookFacilities]);
  /* M8 — THE TRACE PANEL'S RANKING ROW, BOOK-LED. Hoisted here rather than composed in the JSX
   * because that `<details>` renders OUTSIDE the `snap !== null` block: `bookLeads` already implies
   * a snapshot, but only a const computed where `snap` is narrowed can say so to the typechecker,
   * and a `snap!` inside the panel would be the assertion that survives the day the guard moves. */
  const bookLedRankingTrace: string | null =
    bookLeads && snap !== null && bookPayer !== null
      ? `two rankings: ${bookPayer}'s whole book leads the answer, and this member's own history` +
        ` (${snap.facilities.length} ${snap.facilities.length === 1 ? 'facility' : 'facilities'} in this window)` +
        ' is marked on it rather than ranked separately'
      : null;
  /* THE PREFACE SENTENCE, DERIVED ONCE PER RENDER. It was called twice — once to test for null and
   * once to print — which is a second call to a pure function on identical inputs, i.e. the shape
   * that only ever costs and never pays. */
  const preface = snap === null ? null : memberPrefaceFor(snap.memberCount, snap.facilities.length);
  /**
   * ── THE NARROW SEARCH CARD'S FACETS, DERIVED ONCE ────────────────────────────────────────────
   *
   * The card folds the answer stage's filter region behind a click (Alec, 2026-08-07). What may NOT
   * go behind that click is the inventory: the ratified pattern doc's own words are "at the end show
   * which filters are ON and which are OFF so they can toggle them", so the card's SUMMARY carries
   * the ON/OFF reading in both positions and only the CONTROLS live in the disclosure.
   *
   * ⚠ ONE DERIVATION, TWO RENDER SITES. The collapsed strip and the expanded rows read the SAME
   * `facetReading` on the SAME inputs — never a parallel count. That is not tidiness: the AREA
   * badge's denominator was once computed a second way and drifted, silently, behind a
   * `Math.max(1, …)` floor. A summary that re-counts is that bug pre-installed.
   *
   * ⚠ THE GATES MIRROR THE ROWS' OWN SELF-HIDES, EXACTLY. `FilterLine` returns null at zero options,
   * the employer type-ahead is gated on `facets.employers.length > 0`, and the billed-under row on
   * `> 1` label. A strip that listed a facet whose control does not render would point the operator
   * at a switch that is not there.
   *
   * AREA IS ABSENT ON PURPOSE and is the one facet counted by `anyFacetOn` but not by this list: its
   * control lives beside the grid it narrows (see AreaLine), so it is not a member of this card and
   * not a member of this card's tally. "Which switches are on IN HERE" and "is anything narrowing
   * this search AT ALL" are different questions, and the sentence above answers the second.
   */
  const cardFacets: readonly { label: string; on: boolean; text: string }[] =
    snap === null
      ? []
      : [
          // The one facet that is never off — a ranking always has a window; "Automatic" is a CHOICE
          // of window, not the absence of one.
          { label: 'Window', on: true, text: props.windowDays === null ? 'automatic' : `${props.windowDays} days` },
          ...(facets.funding.length > 0
            ? [{ label: 'Funding', ...facetReading(props.filters.funding, facets.funding.length) }]
            : []),
          ...(facets.employers.length > 0
            ? [{ label: 'Employers', ...facetReading(props.filters.employers, facets.employers.length) }]
            : []),
          ...(snap.payerOptions.length > 1
            ? [
                {
                  label: 'Billed under',
                  on: !allPayers,
                  text: allPayers ? `all ${snap.payerOptions.length} labels` : (scopePayer ?? '1 label'),
                },
              ]
            : []),
        ];
  const cardFacetsOn = cardFacets.filter((f) => f.on).length;
  /**
   * WHAT THE SEARCH RESOLVED TO, in one line, for the reader who never opens the card: plan-or-all-
   * plans, the billed-under scope, and the window. Three facts, three sources, none of them re-derived
   *   · the plan half is `skipped`, the reducer's own "was a plan chosen" field;
   *   · the payer half is `resolved.payerScope`, what the CORE actually ranked — never `skipped`,
   *     which is an intention (a Skip plus one chip is a payer-scoped ranking with skipped still true);
   *   · the window half names the MODE only. The DAYS are stated by `windowSentence` a line below,
   *     which reads the ladder; printing a number here would be a second derivation of it.
   * A categorical sentence about the data, so it is suppressed in flight under RULE 2654416.
   */
  /* [BOOK-LED SURFACE] — the population clause below. */
  const resolvedScopeSentence =
    snap === null
      ? null
      : [
          skipped ? 'All plans — no plan chosen' : 'The plan you picked',
          // ⚠ "RANKED", NOT A BARE "UNDER". On the pick-rejected path this line renders directly above
          // a caption reading "Could not scope to the picked plan — showing the largest by volume", and
          // "The plan you picked · under AETNA US HEALTHCARE" invited the label to be read as the
          // PICK'S. Both sentences were true; adjacent, they misread. The verb attaches the label to
          // the ranking. HOW that label was chosen stays the caption's job alone — restating its
          // four-way claim here would be a second derivation of one fact, which is how they drift.
          /* ⚠ S3 ADDS THE POPULATION, BECAUSE THE LABEL ALONE STOPPED IDENTIFYING THE LIST. "Ranked
           * under AETNA" is true of the member's footprint under AETNA AND of AETNA's whole book, so
           * once the book can lead it names the scope without naming what was ranked. The label half
           * is unchanged (the book IS payer-scoped); the clause is additive, and absent — byte for
           * byte the pre-S3 sentence — in every mode that does not flip. */
          allPayers
            ? `ranked across all ${snap.payerOptions.length} billed-under labels`
            : `ranked under ${scopePayer ?? 'one billed-under label'}${
                bookLeads ? " — the whole book, not this member's history" : ''
              }`,
          props.windowDays === null ? 'automatic window' : `trailing ${props.windowDays} days`,
        ].join(' · ');
  /**
   * ⚠ THE DISCLOSURE'S CAPTIONS ARE FROZEN AT RESOLVE TIME AND A SKIP NEVER RE-RESOLVES.
   * `r.provenance` is minted SERVER-side inside `resolveCoverage` (resolutionService.ts:383-408) from
   * the chosen candidate, via `panelProvenance` (resolution.ts:303-317) which interpolates
   * `group.employerLabel`. A Skip is pure client state (resolution-flow-client.tsx:147-149) — no
   * server round trip — so after one, these strings still read
   * "AETNA · FRESNO UNIFIED SCHOOL DISTRICT · 57 members · 1,994 charge lines" about a plan the user
   * explicitly declined, while the panels underneath are identifier-wide: the pick bridge is
   * suppressed (client :205) so, absent a chip press, the fetch sends no payerOverride (client :280)
   * and, absent filters, no market. DISPLAY-ONLY BUG — the data was already honest.
   *
   * Extending 7c86709's pattern: state what IS true rather than blank the row. Keyed on `skipped`
   * ALONE — never on chosenBy/chosenIndex, because a Skip taken AFTER a plan pick leaves `r.group`
   * describing the previously-picked candidate rather than index 0.
   */
  /* WHAT THE RANKING IS, IN THE TRACE PANEL'S OWN WORDS — and after S3 there are two answers.
   * "This identifier's whole footprint" is true of the member list and FALSE of the book, so the
   * book-led arm names the book AND says the footprint is still there, as a mark. Reachable on a
   * skip: a Skip followed by one billed-under chip is a payer-scoped, book-led screen with `skipped`
   * still true. Filters reach BOTH loads (the same `market` is passed to each), so the narrowed arm
   * stays true of the book and simply gains the basis clause. */
  const rankingBasis = bookLeads
    ? `${bookPayer}'s whole book, with this identifier's own history marked on it`
    : "this identifier's whole footprint";
  /* ⚠ `skipUnder` IS DROPPED WHERE THE BASIS ALREADY NAMES THE PAYER (final review, 2026-08-08). Both
   * strings are true and both were appended, so the book-led trace row read "… AETNA US HEALTHCARE's
   * whole book, with this identifier's own history marked on it UNDER AETNA US HEALTHCARE" — one
   * sentence naming one payer twice, which reads as two scopes rather than one. The member-led arm is
   * untouched: "this identifier's whole footprint" names nobody, so it still needs the label. The
   * `ai` row below keeps `skipUnder` unconditionally — its book-led arm ("not the book ranked above")
   * names no payer, so there is nothing there to duplicate. */
  const skipRankingUnder = bookLeads ? '' : skipUnder;
  /* [BOOK-LED SURFACE] — `ranking` and `ai` both re-base; `policy` is a claim about the plan. */
  const skipProvenance: Record<'ranking' | 'policy' | 'ai', string> = {
    ranking: rankingNarrowed
      ? `all plans — no plan chosen, then narrowed by your filter selections${bookLeads ? ` · ${rankingBasis}` : ''}${skipRankingUnder}`
      : `all plans — no plan chosen · ${rankingBasis}${skipRankingUnder}`,
    // Filters narrow rows; they never elect a policy. True either way.
    policy: 'no plan chosen — no single policy backs this screen',
    /**
     * ⚠ "ON SCREEN" STOPS BEING TRUE THE MOMENT AN AREA CHIP IS PRESSED, for the same reason the hero
     * rating comment a few dozen lines down explains for the numeral: `<QualifyAiPanel
     * snapshot={snapshot}>` (resolution-flow-client.tsx) is handed the FULL, un-narrowed snapshot —
     * never `shownFacilities` — because the area facet is a grid-only narrow (invariant (m), see the
     * AREA-facet block below) with no code path to the AI panel's props. So while `areaActive`, the
     * scorecard the user sees is a strict subset of what the AI actually read, and "grounded in the
     * ranking on screen" would describe a ranking narrower than the one really behind the answer.
     * Applying the SAME standard as the hero: say what IS true (the AI covers the full ranking, not
     * the narrowed grid) instead of letting a grid-only control quietly relabel what backs the answer.
     *
     * ⚠ AND "THE RANKING" STOPS IDENTIFYING ANYTHING THE MOMENT THERE ARE TWO (S2, 2026-08-08). The
     * payload is `snap.facilities.slice(0, 10)` — the MEMBER ranking — and the book section below
     * puts a SECOND ranked list of facilities on the same screen that the model has never seen. So
     * with a book present the caption names which one, on exactly the same principle.
     *
     * The four pre-S2 strings are reproduced BYTE FOR BYTE by the composition below (one of them is
     * frozen character-for-character by a test): the grounding half is chosen by the two conditions
     * that can make "on screen" false, and the tail is unchanged. Composed rather than written out
     * eight times, because three independent conditions is where a copy-paste table starts to rot.
     */
    /* ⚠ AND S3 ADDS A THIRD WAY FOR "ON SCREEN" TO BE FALSE — the strongest one. When the BOOK
     * leads, the ranking on screen is the one list the model has NEVER seen (the payload is still
     * `snap.facilities`, unchanged schema — a book payload is a separate ruling), and S2's own fix
     * ("not the whole-book list below") is false by POSITION as well. So the book-led arm outranks
     * the area arm: with the book leading, "the full ranking behind this answer" would point at the
     * grid rather than at the member list the answer is actually grounded in. */
    ai:
      (bookLeads
        ? "grounded in this member's own history, not the book ranked above"
        : areaActive
          ? 'grounded in the full ranking behind this answer, not the narrowed grid'
          : bookOnScreen
            ? "grounded in this member's ranking, not the whole-book list below"
            : 'grounded in the ranking on screen') +
      ` — all plans, no plan chosen${rankingNarrowed ? ', narrowed by your filter selections' : ''}${skipUnder}`,
  };
  /**
   * ⚠ "EVERY deriveNotices KIND IS GROUP-SCOPED" — v1 of this fix asserted that and was wrong about
   * exactly one kind, so here is the per-kind reality (resolution.ts:324-385):
   *   · `unmapped_payer`, `thin_evidence`, `stale_vob`, `network_not_captured` — read off the CHOSEN
   *     candidate's payer identity, claim evidence, VOB freshness and network capture. After a skip
   *     the panels are a wider row set, so all four describe the plan the user declined.
   *     'network_not_captured' ("In-network status is not captured on this VOB") is the line Alec
   *     hit; 'unmapped_payer' is worse still, because it denies facility comparisons the ranking is
   *     visibly making.
   *   · `ambiguous_candidates`, `sole_candidate` — both claim a selection that did not happen.
   *     7c86709 filtered the first; the second makes the same claim and goes with it.
   *   · `no_policy_on_file` — MEMBER-level, not plan-level, and TRUE after a skip on the path that
   *     produced this bug. resolutionService §3 pushes every VOB row before any claims-only row
   *     (:243-302, and nothing sorts `groups` afterwards), so a `claims_only` basis at chosenIndex 0
   *     PROVES the identifier has no VOB row at all — "No verification of benefits on file for this
   *     member" is then a statement about the identifier, and v1 suppressed it, making the screen
   *     claim more confidence than it had.
   * The chosenIndex-0 gate is what the VOB-first ordering actually proves. A pick-then-skip (receipt
   * Change → plan → Skip, which does not clear `state.resolution`) can leave a claims-only group
   * chosen out of a VOB-BEARING set, where the member-level claim would be false — unprovable, so
   * unstated. Note this asks a DIFFERENT question than the `skipped`-alone keying above: that one is
   * "was a plan chosen", this one is "is this basis identifier-wide".
   */
  const skipSurvivingNotices = r.notices.filter(
    (n) => n.kind === 'no_policy_on_file' && r.candidates.chosenIndex === 0,
  );
  // ⟺ the identifier has no VOB row anywhere (see above). Picking a plan therefore cannot surface
  // benefits notes, so the explanation below must not offer that as a way to see them.
  const identifierHasNoVob = skipSurvivingNotices.length > 0;
  /**
   * THE EMPLOYER TYPE-AHEAD'S OPTION LIST — the WHOLE local vocabulary, uncapped and unfiltered.
   *
   * ⚠ CLIENT MODE, DELIBERATELY, AND IT IS NOT AN OPTIMISATION. Collections runs this same picker in
   * SERVER mode (`onQueryChange` + `minChars`) because its employer vocabulary is ~10k rows and
   * cannot be shipped whole. This surface's employers come from `facetsOf(props.candidates)` — they
   * are already in hand, already per-identifier, already member-ranked. Wiring `onQueryChange` here
   * would flip the picker to server mode, which stops it filtering client-side, and would break
   * `employerNarrowFor`: that function decides whether a selection is a narrow AT ALL by comparing it
   * against the FULL local universe (`picked.length >= allEmployers.size`), so a query-filtered
   * universe would make the proper-subset guard mis-fire silently.
   *
   * `display` is the employer text and nothing else. The member counts the old chip wall printed are
   * facts about the UNFILTERED universe, and the picker re-renders `display` inside the selected TAG
   * — so a count there would sit beside a narrowed ranking describing a different set. The ordering
   * (biggest first) survives, because the picker preserves option order.
   */
  const employerPickerOptions = useMemo(
    () => facets.employers.map((o) => ({ value: o.value, display: o.value })),
    [facets.employers],
  );
  // ── The AREA facet, applied ────────────────────────────────────────────────────────────────────
  // Everything below is derived from `snap.facilities` — the rows the ranking ALREADY returned. No
  // memo here feeds `scopeKey`, the fetch effect, or `rankingNarrowed`; grep this block for
  // `props.filters` and there is nothing to find, which is the structural half of invariant (m).
  // S3: whichever list LEADS. The area facet, its counts and the "showing N of M" sentence all
  // narrow the grid the operator is actually looking at — which after the flip is the book.
  const rankedFacilities: readonly QualifyFacility[] = answerFacilities;
  const areaChips = useMemo(
    () => areaChipsWithActive(rankedFacilities, props.area),
    [rankedFacilities, props.area],
  );
  const areaCounts = useMemo(() => {
    const m = new Map<string, number>([[AREA_ALL, rankedFacilities.length]]);
    for (const f of rankedFacilities) {
      const k = areaKeyFor(f.state);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [rankedFacilities]);
  // ── The FACILITY facet, applied (S4) ───────────────────────────────────────────────────────────
  // Same block, same law: derived from the rows the ranking ALREADY returned, and grep this region
  // for `props.filters` — there is nothing to find, which is the structural half of invariant (m).
  //
  // ⚠ THE PLACEHOLDER IS DROPPED FROM THE OPTIONS, NOT FROM THE ROWS. `No Facility` keeps its rank in
  // every grid on this surface (dropping it would hide $29,081,575.38 of charges) and is simply not
  // offerable — you cannot send a patient to a bucket. Because it can never be PICKED, the narrow can
  // never be "show me the placeholder", and the empty states below never have to defend that claim.
  const facilityOptions = useMemo(
    () => offerableFacilityOptions(props.facilityOptions),
    [props.facilityOptions],
  );
  const facilityKeys = useMemo(
    () => facilityNarrowKeys(props.facilityNarrow, props.facilityOptions),
    [props.facilityNarrow, props.facilityOptions],
  );
  // AND ACROSS THE TWO NARROWS — the standard multiselect reading, and what the "Showing N of M"
  // sentence below describes. `narrowByFacility` returns the SAME array when nothing is picked, so a
  // facility-free render is byte-identical to the pre-S4 one and costs no memo churn.
  const shownFacilities = useMemo(
    () => narrowByFacility(facilitiesInArea(rankedFacilities, props.area), facilityKeys),
    [rankedFacilities, props.area, facilityKeys],
  );
  /* WHICH NARROW EMPTIED THE GRID, and WHAT CLEARING EACH ONE WOULD ACTUALLY SHOW. Two questions, one
   * pair of derivations: each narrow applied ALONE. "No ranked facility is in this area" and "no
   * history at NASHVILLE" are different diagnoses of the same empty screen, and offering the wrong one
   * sends the operator to undo the wrong control — so if the facility narrow on its own still has rows,
   * the AREA is what emptied the grid. The same two numbers are what the recovery clause may promise:
   * a way back that names one control must count what THAT control delivers, not the un-narrowed total
   * (fix round 1, I1 — the pre-S4 area string became false the day a second narrow could compose). */
  const facilityOnlyFacilities = useMemo(
    () => narrowByFacility(rankedFacilities, facilityKeys),
    [rankedFacilities, facilityKeys],
  );
  const areaOnlyFacilities = useMemo(
    () => facilitiesInArea(rankedFacilities, props.area),
    [rankedFacilities, props.area],
  );
  /* THE FACTS THE EMPTY STATE NEEDS, all from lists already in hand — which is the whole argument for
   * a display narrow. `snap.facilities` is the SEARCHED IDENTIFIER's own footprint in both modes (the
   * flip moves which list LEADS, never what `facilities` means), so it answers "has this member been
   * here" and "where have they been" even when the book is the grid.
   *
   * ⚠ PER PICK, NOT A BOOLEAN OVER THE SET. See `picksWithRows` — a set-wide `true` rendered every
   * picked name as the subject of "This member HAS billed at …", which fabricates history at the picks
   * with no rows. */
  const picksWithMemberHistory = useMemo(
    () =>
      snap === null
        ? []
        : facilityDisplayNames(
            picksWithRows(props.facilityNarrow, props.facilityOptions, snap.facilities),
            props.facilityOptions,
          ),
    [props.facilityNarrow, props.facilityOptions, snap],
  );
  const memberElsewhere = useMemo(
    () => (facilityKeys === null || snap === null ? [] : facilitiesElsewhere(snap.facilities, facilityKeys)),
    [facilityKeys, snap],
  );
  const pickedFacilityNames = useMemo(
    () => facilityDisplayNames(props.facilityNarrow, props.facilityOptions),
    [props.facilityNarrow, props.facilityOptions],
  );
  /* THE BLAME, RESOLVED ONCE. Three consumers read it — the empty state, the "Not in this book" line's
   * suppression, and (through `shownFacilities`) the area chips' word — and a diagnosis re-derived per
   * surface is how three sentences come to disagree about which control the operator should press. */
  const blamedNarrow: 'area' | 'facility' | null =
    rankedFacilities.length === 0 || shownFacilities.length > 0
      ? null
      : facilityNarrowActive && facilityOnlyFacilities.length === 0
        ? 'facility'
        : 'area';
  /* IS THE FLOOR ARM SPEAKING? S3's "Not in this book: X. This member has history there, but it is
   * below the volume floor…" and that arm state the IDENTICAL fact ~340 characters apart, on the exact
   * screen the arm exists for. The S3 line is not deleted — it still speaks for the member facilities
   * the empty state is NOT about — its set is SUBTRACTED, so each facility is named once. */
  const floorArmSpeaking = blamedNarrow === 'facility' && bookLeads && picksWithMemberHistory.length > 0;
  const unlistedShown = useMemo(
    () =>
      floorArmSpeaking && facilityKeys !== null
        ? unlistedMemberFacilities.filter((f) => !facilityKeys.has(f.facilityKey))
        : unlistedMemberFacilities,
    [floorArmSpeaking, facilityKeys, unlistedMemberFacilities],
  );
  // `areaActive` is declared once, above `skipProvenance` — see the comment there.
  // Two real buckets, or an active narrow that must stay clearable. One bucket is not a choice, and
  // a row of one chip reading "All · 12" is noise — the same rule the mobile deck applies.
  const showAreaLine = areaChips.length > 2 || areaActive;
  // The picker needs a vocabulary; an active narrow must stay clearable even if the vocabulary is
  // gone (a failed reload leaves the selection behind). Same shape as `showAreaLine`'s second arm.
  const showFacilityLine = facilityOptions.length > 0 || facilityNarrowActive;
  /* WHAT THE TWO GRID NARROWS ARE REACHING, in one clause, so one sentence covers both. Written as a
   * phrase rather than two sentences because two `role="status"` lines for one screen state is the
   * overlap review Finding 2 removed for the area alone. A single pick is NAMED — "at NASHVILLE" is
   * what the operator asked for, and repeating it back is how they know the control took. */
  const facilityReach =
    pickedFacilityNames.length === 1
      ? `at ${pickedFacilityNames[0]}`
      : `at the ${pickedFacilityNames.length} facilities you picked`;
  const narrowReach = areaActive
    ? facilityNarrowActive
      ? `in this area, ${facilityReach}`
      : 'in this area'
    : facilityReach;
  return (
    <Stage id="qualify-s-answer" question="Does this payer pay us — and where?">
      {/* [BOOK-LED EXEMPT: it names the payer and the plan-or-no-plan, not the ranking]
          Facts about the RESOLUTION, not about the list beneath it.
          The identity of what is on screen, restated in one line — never re-derived. */}
      <p className="text-sm text-ink900">
        {/* `scopePayer` is null exactly when the ranking spans every label — an empty <span> would
            silently drop the subject of this sentence, so the all-payers case is named. */}
        <span className="font-semibold">
          {skipped ? (allPayers ? ALL_PAYERS_LABEL : scopePayer) : g.payerDisplayName}
        </span>
        <span className="text-ink600"> · {skipped ? 'all plans — no plan chosen' : policyBits}</span>
      </p>

      {/* THREE INDEPENDENT SIBLINGS, not an exclusive ternary chain. The chain put the error arm
          ABOVE the `snap` arm, so any error dropped the whole scorecard even when a perfectly good
          one was in hand — the banner REPLACED the answer instead of annotating it. */}
      {showSkeleton ? (
        <>
          {/* [BOOK-LED EXEMPT: the first-load skeleton names no list]
              `bookLeads` is false with no snapshot, and a progress line makes no claim about which
              list is on its way. */}
          <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
            Ranking facilities for this plan…
          </p>
          <AnswerSkeleton />
        </>
      ) : null}

      {/* A genuine FIRST load failed: there is nothing to preserve and nothing to dim. Copy is
          unchanged, and deliberately carries no Retry — see the refresh banner below for why. */}
      {/* [BOOK-LED EXEMPT: nothing loaded, so no list is on screen to describe] */}
      {firstLoadFailed ? (
        <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
          The facility ranking could not be loaded. The plan resolution above still stands — try again, or
          change the window.
        </p>
      ) : null}

      {/* A REFRESH failed with a good answer still in hand. Say what is on screen and offer a real
          control — the old copy said "try again" while providing nothing to click, and re-clicking
          the same chip was a genuine no-op (unchanged scope key ⇒ the fetch effect never re-ran). */}
      {/* [BOOK-LED EXEMPT: a claim about the REQUEST, not about the list it returned]
          "The ranking below could not be refreshed" is true of either list. */}
      {refreshFailed ? (
        <p role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
          <span>
            The ranking below could not be refreshed
            {props.staleAfterError ? ' — it still shows the scope you were on before' : ''}. Nothing was lost.
          </span>
          <button
            type="button"
            onClick={props.onRetry}
            className="w-fit shrink-0 rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-teal700 transition-colors hover:border-teal500 hover:bg-teal50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
          >
            Try again
          </button>
        </p>
      ) : null}

      {snap ? (
        // The refetch treatment: current content stays RENDERED and readable at reduced opacity with
        // a thin indeterminate bar — a re-scope is not a first load, and blanking to a skeleton
        // makes every chip click feel like a page rebuild.
        <div className={`relative flex flex-col gap-4 ${stale ? 'opacity-60 transition-opacity duration-150' : ''}`}>
          {/* `inFlight`, not `props.refetching`: a same-scope REFRESH is a running request too, and
              the whole point of S5's marker is that `isRefetching` cannot see it. `staleAfterError`
              is still excluded — motion is a progress claim, and a stopped fetch has none. */}
          {inFlight ? (
            <span aria-hidden className="q-refetch-bar absolute inset-x-0 -top-2 h-0.5 overflow-hidden rounded-full">
              <span className="q-refetch-beam block h-full w-1/3 rounded-full bg-teal500" />
            </span>
          ) : null}

          {/* ── THE PREFACE (S2, Alec's tree, 2026-08-08) ────────────────────────────────────────
              WHICH WORLD THIS SEARCH IS IN, said BEFORE anything below claims anything.

              Measured the same day: 58.8% of prefixes are ONE member carrying 1.14 facilities of
              history, 37.0% are 2-9, and only 4.2% are the population the ladder, the confidence
              floor and the blend disclosure were all designed around. Until this line, all three
              were answered in identical words — so the majority case read as a thin ranking rather
              than as what it is: a person, and the wrong shape of question.

              It sits FIRST inside the answer block, above every scope banner, because a preface that
              arrives after the claims is not a preface.

              SUPPRESSED IN FLIGHT (rule 2654416), like every other categorical sentence here: it is
              a statement about the data, and during a re-scope it would describe the set being
              replaced. The dim + beam is the marker; this waits.

              ONE MODULE, THREE SURFACES — this line and `liveSentenceFor` both call
              `memberPrefaceFor`; the RECEIPT prints the count rather than the sentence, but it gates
              on `memberBucketOf`, so all three share the same silence rule as well as the same
              words. (This comment used to claim the receipt called `memberPrefaceFor`. It does not,
              and never did — the chip is a numeral in a pill, not a sentence.)

              ⚠ NOT a `role="status"`. The flow's single sr-only live region already announces this
              exact string through `liveSentenceFor`, so a status role here would make it the one
              doubly-announced sentence on the surface — the same overlap the team ruled against for
              the area narrow's two competing status lines a few hundred rows below. The visible line
              is text; announcing is the live region's job, and only it can sequence with the flow. */}
          {!stale && preface !== null ? (
            <p className="text-sm font-semibold text-ink900">{preface}</p>
          ) : null}

          {/* SCOPE HONESTY (review Critical 1). When the pick couldn't be bridged to a claims label
              — no claims history for this plan, or an unmapped payer — the ranking below is the
              identifier's DOMINANT payer, and that must be said in words, not implied by chips.
              SUPPRESSED IN FLIGHT (rule 2654416): this is a categorical sentence about the data; it
              waits for its answer rather than describing the set being replaced. */}
          {/* `!skipped` is load-bearing now that the two claims are separate values: a plain skip
              sends nothing, so its scopeSource IS 'dominant' — and this banner says a pick could not
              be scoped. Without the guard, decoupling would have swapped one wrong sentence for
              another on the very screen it exists to fix. */}
          {/* ⚠ [BOOK-LED SURFACE] — AND IT WAS THE THIRTEENTH, found in review after this file's own
              index declared the set complete. Both arms re-base; NEITHER is suppressed. The banner
              renders in the coral ALARM treatment directly above the grid, and its gate never
              mentioned `bookLeads` — so on the 58.8% path it claimed "the ranking below is this
              identifier's history under {payer}" over a grid showing that payer's WHOLE BOOK: the
              S2-I1 / PR #92 mixed-claim class, in the loudest voice on the surface. The banner's
              SUBJECT (the pick could not be bridged to a claims label) stays true and stays alarming;
              only the half that describes the LIST moves, on the same discipline as the skip
              banner's re-base below. Copy unratified. */}
          {!stale && !skipped && props.scopeSource === 'dominant' && snap.resolved && r.candidates.total > 1 ? (
            <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
              {g.claimEvidence.lines === 0
                ? bookLeads
                  ? `This plan has no claims history of its own — the ranking below is ${bookPayer}'s whole book, not evidence about ${g.payerDisplayName}.`
                  : `This plan has no claims history of its own — the ranking below is this identifier's history under ${snap.resolved.payerName}, not evidence about ${g.payerDisplayName}.`
                : bookLeads
                  ? `The ranking below could not be scoped to ${g.payerDisplayName} — it shows ${bookPayer}'s whole book, this identifier's largest label by volume, not evidence about ${g.payerDisplayName}.`
                  : `The ranking below could not be scoped to ${g.payerDisplayName} — it shows this identifier's history under ${snap.resolved.payerName}, its largest payer by volume.`}
            </p>
          ) : null}

          {/* A SKIP is its own scope claim: no plan was chosen, so the ranking is the identifier's
              whole footprint. "You declined to narrow" and "we could not narrow" are different
              statements and must not share copy.
              The all-payers arm is the one this promise was WRITTEN for and could not keep until
              2026-08-07: the sentence used to end "under {payerName}", which was true of the label but
              not of the promise ("search all plans"). Now it can say what it always meant, and the
              payer-scoped arm survives for the case where a chip re-scoped it. */}
          {/* [BOOK-LED SURFACE] — the third arm below is the book-led one. */}
          {!stale && skipped && snap.resolved ? (
            <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink900">
              {allPayers ? (
                <>
                  You skipped the plan questions, so this is a general search: every facility this member
                  has history at,{' '}
                  {/* The COUNT comes from payerOptions, which fails SOFT to [] when the spread query is
                      lost — and the ranking is still all-payers in that state. "across all 1 payer"
                      would then be a fabricated number under a true claim, so the count is dropped
                      rather than defaulted. */}
                  {snap.payerOptions.length > 1
                    ? `across all ${snap.payerOptions.length} payers they bill under`
                    : 'across every payer they bill under'}
                  . Use the switches below to narrow it, or the receipt above to pick a plan.
                </>
              ) : bookLeads ? (
                /* ⚠ THE PROMISE IN THE OTHER ARM IS FALSE UNDER A BOOK-LED GRID. "Every facility this
                   member has history at" describes the member's footprint, and after the flip the
                   list below is the payer's whole book — the member's history is a MARK on it. Same
                   state (a Skip re-scoped by one billed-under chip), different list, so it gets its
                   own sentence rather than inheriting one written for the other. */
                <>
                  You skipped the plan questions, and the ranking is {snap.resolved.payerName}&apos;s whole book:
                  every facility that label paid at above the volume floor in this window, with the ones
                  this member has been to marked. Turn the BILLED UNDER switch off to search across every
                  label again.
                </>
              ) : (
                <>
                  You skipped the plan questions, but the ranking is scoped to {snap.resolved.payerName}: every
                  facility this member has history at under that one label. Turn the BILLED UNDER switch off to
                  search all of them again.
                </>
              )}
            </p>
          ) : null}

          {/* ── THE NARROW SEARCH CARD (Alec, 2026-08-07) ────────────────────────────────────────
              The answer stage's filter region folds into a card you click to expand. Two halves, and
              which half a thing belongs in is decided by ONE rule:

                  STATEMENTS GO IN THE SUMMARY · CONTROLS GO BEHIND THE CLICK.

              ⚠ THE COLLAPSED SUMMARY *IS* THE INVENTORY, AND THAT IS NOT A STYLE CHOICE. The ratified
              pattern doc records Alec's own words — "at the end show which filters are ON and which
              are OFF so they can toggle them" — so a collapse may put the toggles behind a click but
              may NOT put the on/off reading behind one. Collapsed, this card still carries the scope
              it resolved to, the anyFacetOn sentence, a named ON/OFF badge per facet, and the tally.
              Expanding swaps the badge strip for the rows that carry those same badges next to their
              controls. Nothing about "which switches are on" ever costs a click.

              ⚠ THIS REVERSES THE COMMENT THAT STOOD HERE ONE DAY ("All visible, none behind a
              dropdown"), which is recorded rather than deleted because that ruling was right for a
              screen with no card and wrong for one with a summary that states what the fields hold.

              ⚠ AND IT IS NOT A `<details>`. A closed <details> serializes its children, so the whole
              inventory would sit in the SSR string — every existing assertion green, the operator
              seeing none of it. The fields are CONDITIONALLY RENDERED and the tests assert their
              absence against an expanded positive control.

              `data-v3-inventory` marks the card for the shell's reveal timeline and `data-v3-facet`
              marks each beat — ON THE SUMMARY BADGES WHEN COLLAPSED, on the rows when expanded, so
              the stagger has 5-6 beats in either position. Without that re-homing a collapse would
              leave AREA as the only beat on the stage and `staggerDelayMs(0) === 0` would make the
              reveal a silent no-op. The shell's layout effect keys on `[stage, hasSnapshot]` and this
              bit is deliberately NOT added to it: `ctx.revert()` would replay the 14px stage rise and
              re-hide the entire scorecard grid on every toggle. ── */}
          <section
            data-v3-inventory
            aria-labelledby="qualify-narrow-heading"
            className="relative isolate flex flex-col gap-3 rounded-xl px-4 py-3.5 shadow-ths-sm"
          >
            {/* ⚠ THE SURFACE IS ITS OWN LAYER, AND THE REASON IS THE TYPE-AHEAD BELOW. `.q-subject`
                and `overflow-hidden` used to sit on the <section>: the class paints the dark teal
                gradient, and its `::after` is a coral glow positioned OUTSIDE the box (right:-40px,
                top:-60px), so something has to clip it. But `overflow-hidden` on the card also clips
                every absolutely-positioned DESCENDANT — and MultiSelectTagPicker's dropdown is one,
                opening downward from a row near the card's bottom edge. That would have shipped a
                type-ahead whose matches are cut off, with nothing wrong in the DOM to notice.
                So the clip moved down onto a layer that holds nothing but paint. It is FIRST in DOM
                order and every sibling below is `relative`, so painting order alone puts the content
                above it — no z-index, no `isolate` dependency beyond the one already here. */}
            <span aria-hidden className="q-subject absolute inset-0 overflow-hidden rounded-xl" />
            {/* LIGHT-ON-DARK. `.q-subject` is the app's dark teal gradient band; every label on it is
                the design system's blessed eyebrow at its dark-surface palette (teal200 on #0e3a3a
                clears AA), and nothing here goes below `text-xs` — 13px in this config, which is the
                house floor. */}
            <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h3 id="qualify-narrow-heading" className="text-xs font-semibold uppercase tracking-wide text-teal200">
                Narrow search
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {/* ── THE REFRESH CONTROL (S5, 2026-08-08) ────────────────────────────────────────
                    ON THE CARD, and the card's own rule is exactly why: *everything on the control
                    card re-issues the ranking request*, and this is the only thing here that does
                    nothing BUT that. The same rule keeps the two grid narrows (area, facility)
                    outside the card; this is it applied in the other direction.

                    IN THE HEADER ROW, so it survives the disclosure. The collapsed card is what an
                    operator meets on every path except a Skip, and a refresh that costs a click to
                    reach is a refresh nobody presses.

                    ⚠ SAME HANDLER AS THE FAILURE BANNER'S "Try again", not a second one.
                    `retry_requested` was always general — the one reducer case that bypasses the
                    bail-out guard, so it fires with no error present and no input moved. A second
                    refetch path would be a second writer of the value the fetch effect keys on,
                    which is the shape `scopeKeyOf`'s header is a post-mortem of.

                    ⚠ DISABLED WHILE IN FLIGHT, AND WHILE THE RESOLVE IS PENDING. Every press writes
                    one `SEARCH_QUALIFY_PHI` row (the core audits BEFORE any data), and this repo has
                    already treated duplicate audit rows from one user action as a defect worth its
                    own fix (payerOverride.ts). `pending` is in the guard because the fetch effect
                    returns early while the server action runs — a press there would arm the
                    in-flight marker with no request behind it.

                    ⚠ `type="button"`. A submit would reach a form action and re-run
                    `resolveCoverageAction`, which writes sixteen reducer fields and drops the
                    operator back to the payer stage. Copy unratified. ── */}
                <button
                  type="button"
                  onClick={props.onRetry}
                  /* ⚠ `aria-disabled`, NOT THE REAL ATTRIBUTE (fix round M3). `disabled` makes the
                     element unfocusable the instant it lands — so the control the operator is
                     STANDING ON stops being focusable mid-press and focus falls to <body>, the exact
                     regression the shell's focus effect exists to prevent one layer up; it is also
                     not reliably announced. The REFUSAL moved into `makeRetryHandler`, where a
                     second press during flight is a tested no-op rather than a browser side effect,
                     and the visual treatment is unchanged. */
                  aria-disabled={props.refreshing || props.pending}
                  aria-busy={props.refreshing}
                  className="flex items-center gap-1.5 rounded-full border border-teal200/40 bg-white/10 px-3 py-1 text-xs font-semibold text-white transition-colors hover:border-teal200 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                >
                  <span aria-hidden className={props.refreshing ? 'animate-spin' : ''}>
                    ↻
                  </span>
                  {props.refreshing ? 'Refreshing the ranking…' : 'Refresh the ranking'}
                </button>
                <button
                  type="button"
                  aria-expanded={props.narrowExpanded}
                  aria-controls="qualify-narrow-fields"
                  onClick={props.onToggleNarrow}
                  className="flex items-center gap-1.5 rounded-full border border-teal200/40 bg-white/10 px-3 py-1 text-xs font-semibold text-white transition-colors hover:border-teal200 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/60"
                >
                  {props.narrowExpanded ? 'Hide the fields' : 'Change these'}
                  <span aria-hidden className={`text-teal200 transition-transform ${props.narrowExpanded ? 'rotate-180' : ''}`}>
                    ▾
                  </span>
                </button>
              </div>
            </div>

            {/* ── THE SUMMARY. Every line below is a STATEMENT about the search, which is why it is
                here and not behind the disclosure. ── */}
            <div className="relative flex flex-col gap-2">
              {/* WHAT THE SEARCH RESOLVED TO, for the reader who never clicks. A categorical sentence
                  about the data, so RULE 2654416 suppresses it in flight rather than letting it
                  describe the set being replaced. */}
              {stale || resolvedScopeSentence === null ? null : (
                <p className="text-sm font-medium text-white">{resolvedScopeSentence}</p>
              )}
              {/* The inventory's own sentence, shown only after a Skip — the state where "nothing is
                  filtered" is a fact worth asserting rather than left to be read off unlit rows. */}
              {skipped && !stale ? (
                <p data-v3-facet className="text-xs font-semibold text-teal50">
                  {/* ⚠ "EVERY SWITCH IS OFF" WAS FALSE ONE CLICK IN. Skip, then press "90 days": no
                      filter is active, no label is scoped, so the old sentence claimed nothing was
                      restricting the search — directly above a Window row reading "On · 90 days".
                      Both halves were wrong at once. The window is a real narrowing that can never be
                      turned off (see its FacetState), so the sentence names it as the standing
                      exception instead of pretending the screen has none. */}
                  {anyFacetOn
                    ? 'Some switches are on — everything marked Off is unrestricted.'
                    : 'No filters are on — apart from the window, nothing is narrowing this search. Turn any switch on to narrow it.'}
                </p>
              ) : null}
              {/* GRANULAR suppression, honouring the RULE 2654416 ruling rather than blanketing it.
                  The MANUAL variant ("— your selection") states the user's own action — a fact,
                  allowed to speak immediately under the dim+beam marker (the standing ruling in the
                  RULE 2654416 test). But the AUTO variants read the RENDERED snapshot's LADDER — a
                  data claim about the set being replaced — so they wait like every other categorical
                  sentence. And after a FAILED refetch (staleAfterError) the WHOLE sentence waits:
                  there is no beam, the duration is unbounded post-F2, and the failure banner just
                  said the content shows the previous scope — "Showing trailing 365 days" printed
                  beside that banner would be a direct contradiction. The Window CHIPS stay behind the
                  disclosure — they are the user's controls (and, after a failure, the escape route). */}
              {props.staleAfterError || (inFlight && props.windowDays === null) ? null : (
                <p className="text-sm text-teal50">{windowSentence(snap, props.windowDays)}</p>
              )}

              {/* ── THE WINDOW MOVED UNDER THE OPERATOR (S5) ──────────────────────────────────────
                  `scopeKeyOf` serializes the automatic case as the literal 'auto' and NOT the
                  ladder's chosen days, so a refresh that lands on a different rung leaves
                  `loadedKey === scopeKey`: every staleness flag reads "nothing changed", the facet
                  badge above still says "On · automatic", and the sentence one line up quietly
                  renders a different number. That is a scope change nobody is told about, on the
                  surface this whole lineage exists to keep honest.

                  ⚠ THREE GATES, AND EACH ONE IS A DIFFERENT FALSE SENTENCE IT PREVENTS.
                    · `!stale` — RULE 2654416: it is a categorical claim about the data, so it waits
                      like every other one rather than describing the set being replaced.
                    · `windowDays === null` — it is a claim about the AUTOMATIC window. Rendered
                      beside "Showing trailing 180 days — your selection" it would be two
                      contradictory sentences about the same control. The reducer cannot know a
                      manual selection arrived after the resolve, so the render decides.
                    · `windowMove !== null` — THE NEGATIVE CONTROL. Most refreshes return the same
                      rung; a notice that fired on every one would be noise, and noise is how the
                      real one gets ignored.

                  ONE EXPRESSION, TWO CHANNELS: `liveSentenceFor` announces this exact string. ── */}
              {/* [BOOK-LED EXEMPT: it describes the WINDOW the request used, not which list came back]
                  Both the member's footprint and the payer's book are loaded over the same chosen
                  window, so the sentence is true word for word in either mode. */}
              {!stale && props.windowDays === null && props.windowMove !== null ? (
                <p role="status" className="rounded-lg border border-teal200/40 bg-white/10 p-2.5 text-xs font-medium text-white">
                  {windowMoveNotice(props.windowMove)}
                </p>
              ) : null}

              {/* ── WHEN THIS DATA WAS BUILT (S5) ─────────────────────────────────────────────────
                  The refresh control's own basis line: what it is refreshing FROM. It sits in the
                  summary rather than beside the button because it is a STATEMENT, and this card's
                  one sorting rule is statements-in-the-summary / controls-behind-the-click.

                  ⚠ NOT SUPPRESSED IN FLIGHT, unlike every sentence above it, and the exception is
                  principled rather than convenient: those describe the SET being replaced, this
                  describes the PIPELINE. Blanking it during the very refresh it explains would
                  remove the one line that answers "is this even going to be newer?" at the only
                  moment the operator is asking.

                  `rebuiltAtSentence` owns the copy, the named timezone, and the argument for why
                  `max(ingested_at)` and `rollup_max_payment_date` are both disqualified. ── */}
              {/* [BOOK-LED EXEMPT: it dates the index rebuild, not the list that came back]
                  `facilities` and `bookFacilities` are two queries over one matview, so one rebuild
                  time is the honest answer in either mode. */}
              <p className="text-xs text-teal200">{rebuiltAtSentence(props.dataRebuiltAt, { refreshFailed })}</p>
              {/* THE PAYER-SCOPE CLAIM. "You picked this" / "your plan pick implies this" / "we
                  defaulted" are three different claims, and a REJECTED override must never render as
                  honoured. It sits in the SUMMARY rather than beside its chips because it is a
                  sentence about what the ranking IS, not a control — and because a caption that only
                  appears once you open the card cannot do the job it exists for. SUPPRESSED IN FLIGHT
                  (rule 2654416); the chips themselves stay live below, they are controls, not claims. */}
              {snap.payerOptions.length > 1 && !stale ? (
                <p className="text-xs text-teal200">
                  {billedUnderCaption({
                    skipped,
                    payerOverridden: snap.payerOverridden,
                    scopeSource: props.scopeSource,
                    allPayers,
                  })}
                </p>
              ) : null}

              {/* ── THE ON/OFF STRIP, collapsed only. Expanded, each row states its own badge beside
                  its own controls (which is strictly better — the state sits next to the thing that
                  changes it), so rendering both would print the inventory twice. Each badge is a
                  `data-v3-facet` beat: this is what keeps the skip reveal alive through the collapse.
                  Values come from `cardFacets`, the SINGLE derivation the rows read too. ── */}
              {props.narrowExpanded ? null : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {cardFacets.map((f) => (
                    <span key={f.label} data-v3-facet className="flex items-center gap-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-teal200">{f.label}</span>
                      <FacetState on={f.on} text={f.text} />
                    </span>
                  ))}
                </div>
              )}

              {/* THE TALLY — the aggregate a reader takes in at a glance, beside the named strip that
                  says WHICH. Derived by counting `cardFacets`, never a hand-written total: a facet
                  that stops rendering (its options ran out, or a future ruling drops it) leaves the
                  list and the tally together. WINDOW IS ALWAYS ON, so "1" is this card's honest floor
                  rather than a bug — the headline sentence names that exception in words.

                  ⚠ "OF THESE" IS LOAD-BEARING, AND SO IS THE AREA CLAUSE. This read a bare "1 on ·
                  4 off", which is a claim about the SCREEN in a card that holds five of the screen's
                  six facets. With an area narrow on and every in-card switch off, the card said
                  "Some switches are on" and then counted one — the Window, which the headline's other
                  arm explicitly discounts. Two live narrows, a tally of one, and nothing pointing at
                  the one that is elsewhere.
                  The fix is NOT to fold AREA into `cardFacets`: its control lives beside the grid it
                  narrows and that placement is the honesty argument made in layout (see AreaLine).
                  Instead the tally scopes its claim to this card ("of these") and NAMES the narrow
                  that is not in it when that narrow is live. Wording is unratified — plain on purpose.

                  ⚠ S4 MADE IT TWO. The facility narrow lands beside the area one, outside this card
                  for the identical reason, so the clause ENUMERATES rather than counts: "plus 2
                  narrows beside the list" is arithmetically honest and operationally useless — it
                  sends an operator hunting for the second one. Naming both costs four words. */}
              <p className="text-xs text-teal200">
                <span className="font-semibold text-white">{cardFacetsOn} of these {cardFacets.length} switches on</span>
                {areaActive && facilityNarrowActive
                  ? ' · plus the area and facility narrows, beside the list'
                  : areaActive
                    ? ' · plus the area narrow, beside the list'
                    : facilityNarrowActive
                      ? ' · plus the facility narrow, beside the list'
                      : ''}
                {props.narrowExpanded ? '' : ' — open the fields to change any of them'}
              </p>

              {/* What the filters DID to the ranking — stated, never inferred. It is a STATEMENT, so
                  it lives here; "Clear filters" rides with it because a narrow the operator cannot
                  reach without first opening the card is a narrow that outlived its own reset. */}
              {filtersActive ? (
                <p className="flex flex-wrap items-center gap-2 text-xs text-teal50">
                  <span>
                    Ranking over {filteredCandidates.length} of {props.candidates.length} plans
                    {props.employerNarrowTooMany !== null
                      ? ` — too many employers (${props.employerNarrowTooMany}) to narrow the ranking by employer, so it is not`
                      : ''}
                    .
                  </span>
                  <button
                    type="button"
                    onClick={props.onClearFilters}
                    className="rounded-full border border-teal200/50 px-2.5 py-0.5 font-semibold text-white hover:bg-white/15"
                  >
                    Clear filters
                  </button>
                </p>
              ) : null}
            </div>

            {/* ── THE FIELDS. Conditionally rendered, so "collapsed" is a fact about the DOM and a
                test can tell a hidden control from an absent one. They sit in a LIGHT WELL rather
                than inheriting the dark palette, and that decision is now load-bearing rather than
                merely conservative: the shared type-ahead below carries the dashboard's own light
                tokens, so a dark well would have meant forking it.

                THE HYBRID (Alec, 2026-08-07): short vocabularies stay counted chips (Window,
                Funding, Billed under — every option visible, each with its own count and toggle),
                long ones become the shared type-ahead (Employers, and Facility when Task 3 lands
                beside it). Plan type is not here in either form; `AnswerFilters` records why. ── */}
            {props.narrowExpanded ? (
              <div
                id="qualify-narrow-fields"
                className="q-narrow-fields relative flex flex-col gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3"
              >
                <div data-v3-facet className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink400">Window</span>
                  {/* THE ONE FACET THAT IS NEVER OFF, and the inventory says so rather than pretending
                      otherwise. A ranking always has a window; "Automatic" is a CHOICE OF window, not the
                      absence of one — so this reads "On · automatic" or "On · 90 days", never "Off". The
                      Collections model carries the same caveat (its 90-day recency chip is a real default
                      narrowing, captioned as "· Last 90 days" rather than hidden). */}
                  <FacetState on text={props.windowDays === null ? 'automatic' : `${props.windowDays} days`} />
                  {WINDOW_CHOICES.map((d) => {
                    const active = props.windowDays === d;
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={active}
                        onClick={() => props.onWindowDays(d)}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                          active ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600 hover:border-teal200'
                        }`}
                      >
                        {d} days{active ? ' · selected' : ''}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    aria-pressed={props.windowDays === null}
                    onClick={() => props.onWindowDays(null)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                      props.windowDays === null ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600 hover:border-teal200'
                    }`}
                  >
                    Automatic{props.windowDays === null ? ' · selected' : ''}
                  </button>
                </div>

                {/* SHORT LIST → COUNTED CHIPS (Alec's hybrid ruling, 2026-08-07). Funding is two or
                    three values on any real search, so every option stays on screen with its member
                    count and its own aria-pressed toggle. PLAN TYPE used to sit here and does not any
                    more — see `AnswerFilters` for why removing it was a correctness change, not a
                    decluttering one. */}
                <FilterLine
                  label="Funding"
                  options={facets.funding}
                  selected={props.filters.funding}
                  onToggle={(v) => props.onToggleFilter('funding', v)}
                />

                {/* LONG LIST → TYPE-AHEAD (the other half of the hybrid ruling), and specifically the
                    SHARED picker: `MultiSelectTagPicker` is the same primitive the Collections
                    explorer and the v2 Qualify tab render, extracted out of cmd-explorer so these
                    surfaces cannot drift into three employer controls. There was nothing to port and
                    nothing to fork — it already carries a Qualify-only `tone` prop.

                    THE BADGE RIDES THE PICKER'S OWN LABEL ROW. This card's contract is that every
                    facet states ON/OFF beside its own control, and the picker owns the only label
                    this facet has; a second "Employers" heading above it would say the word twice to
                    a screen reader. Same `facetReading` expression as every other badge — the
                    collapsed summary reads it too, and one expression is what stops the two from
                    drifting (see `cardFacets`).

                    `onClear` walks the selection through `onToggleFilter` rather than reaching for a
                    new reducer action. `filter_toggled` is the machine's ONLY facet-scoped write to
                    `filters`; a second one would be a second writer of the field the fetch effect
                    keys on, which is the shape `scopeKeyOf`'s header is a post-mortem of. */}
                {facets.employers.length > 0 ? (
                  <div data-v3-facet>
                    <MultiSelectTagPicker
                      label="Employers"
                      badge={<FacetState {...facetReading(props.filters.employers, facets.employers.length)} />}
                      placeholder="Type to find an employer…"
                      icon={<Briefcase className="h-3.5 w-3.5" aria-hidden />}
                      options={employerPickerOptions}
                      selected={props.filters.employers}
                      onToggle={(v) => props.onToggleFilter('employer', v)}
                      onClear={() => {
                        for (const v of props.filters.employers) props.onToggleFilter('employer', v);
                      }}
                      tone="list"
                    />
                  </div>
                ) : null}

                {/* Claims-side scope: which billed-under label the ranking is scoped to. MOVED INSIDE the
                    inventory block 2026-08-07 — it was the one facet living outside the panel that claims
                    to list every facet, and after a Skip it is the facet that matters most (it is the
                    un-blend). Its state badge reads "Off · all N labels" when nothing is selected, which
                    is now a REACHABLE state rather than a hypothetical: before the identifier-wide skip,
                    the core always resolved a dominant label and one chip was always lit.
                    Its CAPTION moved up to the card's summary with the card change — a sentence that
                    appears only once you open the disclosure cannot do the job it exists for. */}
                {snap.payerOptions.length > 1 ? (
                  <div data-v3-facet className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-ink400">Billed under</span>
                    <FacetState
                      on={!allPayers}
                      text={allPayers ? `all ${snap.payerOptions.length} labels` : (scopePayer ?? '1 label')}
                    />
                    {snap.payerOptions.map((p) => {
                      // ⚠ COMPARE AGAINST THE SCOPE, NOT THE NAME. `resolved.payerName` is null under an
                      // all-payers ranking, so `=== p.payer` is false for every chip and none lights —
                      // which is the correct reading and the Collections model exactly (nothing selected
                      // means no restriction). Going through `scopePayer` states that rather than relying
                      // on a null comparison to happen to do the right thing.
                      const active = !allPayers && scopePayer === p.payer;
                      return (
                        <button
                          key={p.payer}
                          type="button"
                          aria-pressed={active}
                          onClick={() => props.onPayerOverride(active ? null : p.payer)}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                            active ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600'
                          }`}
                        >
                          {p.payer}
                          <span className="ths-num" aria-label={`${p.lines} charge lines under this label`}>
                            {' '}
                            · {p.lines.toLocaleString()}
                          </span>
                          {active ? ' · showing' : ''}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* The hero: ONE number, patient-weighted, with its basis stated. The band wash sits
              behind it (Phase 5); the verdict WORD beside the numeral still carries the meaning.
              SUPPRESSED IN FLIGHT (rules e7e8a0e + 2654416): the numeral, the verdict word and the
              basis are claims about the data — at zero rated facilities the basis literally reads
              "no facility clears the sample floor", which is FALSE during a fetch. The dim treatment
              is a marker calibrated for the grid's numbers; these sentences wait instead. */}
          <div
            className="flex items-center gap-5 rounded-xl border border-line bg-surface p-5 shadow-ths-sm"
            style={!stale && rating?.band ? { backgroundColor: IQ_BAND_WASH[rating.band] } : undefined}
          >
            {stale ? (
              // No numeral, no verdict, no basis — a wordless placeholder holds the footprint. It
              // PULSES only while a fetch is genuinely running; after a failure it is static, for
              // the same reason the progress beam is withheld — motion is a progress claim, and
              // there is no progress to claim once the request has stopped.
              <span
                aria-hidden
                className={`h-14 w-full max-w-sm rounded-lg bg-ground ${inFlight ? 'animate-pulse' : ''}`}
              />
            ) : (
              <>
                {rating && rating.rating !== null ? (
                  <span
                    className="font-display text-6xl font-semibold tracking-tight"
                    style={{ color: rating.band ? IQ_BAND_HEX[rating.band] : undefined }}
                    aria-label={`policy rating ${rating.rating} out of 100`}
                  >
                    {rating.rating}
                  </span>
                ) : (
                  <span className="text-2xl font-semibold text-ink600">Not rated</span>
                )}
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-ink900">{rating?.verdict ?? 'Not rated'}</span>
                  <span className="text-xs text-ink600">{rating?.basis ?? 'no facility clears the sample floor'}</span>
                  {rating && rating.rating !== null ? (
                    <span className="text-xs text-ink600">
                      <span className="ths-num" aria-label={`${rating.patients} patients behind this rating`}>
                        {rating.patients.toLocaleString()}
                      </span>{' '}
                      patients ·{' '}
                      <span className="ths-num" aria-label={`${rating.ratedCount} rated facilities`}>
                        {rating.ratedCount}
                      </span>{' '}
                      rated facilities
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>

          {/* The AI layer — preset chips, streamed answers, grounded in THIS snapshot. */}
          {props.aiPanel}

          {/* The scorecard. Ranked; each card explains itself behind ONE disclosure. The AREA row
              sits here rather than on the control card above BECAUSE it does not re-scope anything:
              it hides rows the ranking already returned. Layout carries that distinction. */}
          <section
            aria-labelledby="qualify-scorecard-heading"
            /* THE SAME MARKER THE SECONDARY SECTION CARRIES, so "where is the payer's book" has one
               answer in either position — and so a test asserting a book claim cannot be satisfied by
               a sentence rendered in the other section. Exactly ONE `[data-v3-book]` is ever on the
               page: leading here, or secondary below, never both. */
            {...(bookLeads ? { 'data-v3-book': '' } : {})}
            className="flex flex-col gap-2"
          >
            <h3 id="qualify-scorecard-heading" className="ths-h text-base font-semibold text-ink900">
              {/* THE HEADING NAMES THE LIST (S3). "Facilities, ranked" was minted for the member's own
                  footprint; over the payer's book it is the same words describing a different claim,
                  which is how a surface starts lying without changing a sentence. */}
              {bookLeads ? `Where ${bookPayer} pays — the whole book` : 'Facilities, ranked'}
            </h3>
            {/* ── THE BOOK-LED BASIS LINE ──────────────────────────────────────────────────────────
                It carries the same discipline S2's secondary section established — say what this
                list IS, in its own words, and never borrow the claims above it — plus the one thing
                only the LEADING position needs: what the mark on a card means. Copy unratified. */}
            {bookLeads ? (
              <p className="text-xs text-ink600">
                <span className="ths-num" aria-label={`${rankedFacilities.length} facilities in this payer's book`}>
                  {rankedFacilities.length}
                </span>{' '}
                {/* ⚠ "ABOVE THE VOLUME FLOOR" IS NOT HEDGING — WITHOUT IT THIS SENTENCE CONTRADICTS
                    THE ONE BELOW IT (final review, 2026-08-08). The book load runs
                    `assembleFacilities(..., applyFloor = true)` and the member load does not
                    (core.ts), which is why this very screen can render "…is below the volume floor
                    for {payer} in this window" a few rows down. "Every facility {payer} paid at",
                    unqualified, is false of a floored list and is contradicted in place by its own
                    neighbour. THE THRESHOLD ITSELF IS NOT SPELLED OUT HERE, deliberately: it lives
                    with `QUALIFY_MIN_LINES` (rating.ts) and three hand-copied numerals in three
                    sentences is three places for it to rot. Copy unratified. */}
                facilities — every facility {bookPayer} paid at above the volume floor in the window
                shown, not just this member&apos;s. One member is behind this search and 1.14 facilities is
                not a ranking, so the book leads and this member&apos;s own history is marked on the
                facilities they have been to.
              </p>
            ) : null}
            {/* ── THE GRID-NARROW ROW: the two controls that hide rows without re-asking for them.
                They share a row because they share a rule — everything on the control card above
                re-issues the ranking request, and neither of these does. AREA first, then FACILITY:
                DOM order is the reveal's stagger order, and the type-ahead (which opens a dropdown
                downward) belongs at the bottom edge of the row rather than above a chip wall.

                ⚠ NO CLIPPING ANCESTOR HERE, AND THAT IS CHECKED RATHER THAN ASSUMED. The picker's
                option list is absolutely positioned; the NARROW SEARCH card moved its
                `overflow-hidden` down onto a paint-only layer for exactly that reason. This row sits
                OUTSIDE that card, in the scorecard section, whose chain to `[data-v3-stage]` carries
                no `overflow-hidden` at all — verified 2026-08-08, and a future wrapper that adds one
                would clip these matches with nothing wrong in the DOM to notice. ── */}
            {showAreaLine || showFacilityLine ? (
              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                {showAreaLine ? (
                  <AreaLine
                    chips={areaChips}
                    active={props.area}
                    counts={areaCounts}
                    /* The count on SCREEN, after both grid narrows — so a lit chip cannot say
                       " · showing" over an empty grid. See the prop's own doc. */
                    shown={shownFacilities.length}
                    onSelect={props.onSelectArea}
                  />
                ) : null}
                {showFacilityLine ? (
                  <FacilityNarrowLine
                    options={facilityOptions}
                    selected={props.facilityNarrow}
                    onToggle={props.onToggleFacility}
                  />
                ) : null}
              </div>
            ) : null}
            {/* ⚠ THE HERO IS NOT RE-DERIVED FOR THE AREA, and this sentence is why that is honest
                rather than a bug. `derivePolicyRating` runs over `answerFacilities` — the whole
                LEADING list, whichever it is (it stopped being `snap.facilities` when the book-led
                flip landed, and this citation said otherwise for a round) — and recomputing it per
                area would let a grid-only control silently
                move the headline number and its "N rated facilities" basis. So the number keeps its
                meaning and the narrow states its own reach instead.
                GATED ON `shownFacilities.length > 0` TOO (review Finding 2), not `areaActive` alone:
                an area with nothing in it already gets its OWN sentence below ("No ranked facility is
                in this area…"), and rendering both together put two overlapping `role="status"`
                sentences on screen for the same click — "Showing 0 of 3…" right next to "No ranked
                facility is in this area." The zero-count case has nothing left for this sentence to
                say that the other one doesn't already say better. */}
            {/* [BOOK-LED SURFACE]
                It reads `rankedFacilities`, which IS the leading list, so the "N of M" and the "the
                rating above still covers all M" clause both follow the flip by construction rather
                than by a branch. Marked so the grep finds it anyway: it is a claim about what is on
                screen, and the day it hard-codes `snap.facilities` it lies. */}
            {(areaActive || facilityNarrowActive) && shownFacilities.length > 0 ? (
              <p role="status" className="text-xs text-ink600">
                Showing{' '}
                <span className="ths-num" aria-label={`${shownFacilities.length} facilities shown`}>
                  {shownFacilities.length}
                </span>{' '}
                of{' '}
                <span className="ths-num" aria-label={`${rankedFacilities.length} ranked facilities in total`}>
                  {rankedFacilities.length}
                </span>{' '}
                ranked facilities {narrowReach}. The ranking itself was not re-run — the rating above
                still covers all {rankedFacilities.length}.
              </p>
            ) : null}
            {/* ⚠ NOT CAPPED WHEN THE BOOK LEADS, AND THE ARGUMENT INVERTS RATHER THAN WEAKENS.
                S2 caps the SECONDARY section at QUALIFY_BOOK_PREVIEW because a secondary section
                that pushes the answer off screen has stopped being secondary. Here the book IS the
                answer, and availability leads the sort — so a cap would systematically remove the
                FULL houses, turning "census sorts, it never filters" into a filter by omission on
                the primary grid. The whole book is <=48 facilities; that is a real DOM cost (up to
                48 cards, each with a `<details>` and a factor table) and it is the accepted one. The
                AREA line above is the narrow, and it is why that line earns its place here. */}
            <ul className="grid list-none grid-cols-1 gap-3 p-0 lg:grid-cols-2">
              {shownFacilities.map((f) => (
                <ScoreCard
                  key={f.facilityKey}
                  f={f}
                  allPayers={allPayers}
                  historyChip={memberHistoryChipFor(snap.memberCount, f.memberHistory)}
                />
              ))}
            </ul>
            {/* ── THE MEMBER FACILITIES THE BOOK'S FLOOR DROPPED (S3) ─────────────────────────────
                See `unlistedMemberFacilities` for why this can happen and why the floor is the only
                possible cause. Without this line the flip would silently delete the most decisive
                fact on the screen — "they have been here" — for precisely the thinnest facilities,
                which are the ones a 1.14-facility member is most likely to have. Names only: they
                are non-PHI and already render on every card. Copy unratified. */}
            {/* ⚠ READS `unlistedShown`, NOT `unlistedMemberFacilities` (fix round 1, I3). When the
                facility narrow's FLOOR arm is speaking below, it already states this exact fact about
                the picked facilities — so those are subtracted here rather than the whole line being
                suppressed, which would silently drop the member facilities the empty state is not
                about. Each facility is named once, by the sentence that is about it. */}
            {unlistedShown.length > 0 ? (
              <p className="text-xs text-ink600">
                Not in this book:{' '}
                <span className="font-semibold text-ink900">
                  {unlistedShown.map((f) => f.name).join(' · ')}
                </span>
                . This member has history there, but {unlistedShown.length === 1 ? 'it is' : 'they are'}{' '}
                below the volume floor for {bookPayer} in this window, so the book cannot rank{' '}
                {unlistedShown.length === 1 ? 'it' : 'them'}.
              </p>
            ) : null}
            {/* THREE different emptinesses, three different sentences (S4 added the third). "Nothing
                ranked at all" is a statement about the payer and the window; "nothing in TN" is a
                statement about the chip the user just pressed; "no history at NASHVILLE" is a
                statement about a PLACE, and it is the one an admissions seat is actually asking.
                Each fix is one click away and each sentence says which click.

                ⚠ WHICH NARROW GETS BLAMED IS COMPUTED, NOT GUESSED. With both narrows on, asking the
                facility narrow ALONE separates the diagnoses: rows survive it ⇒ the AREA emptied the
                grid and the area sentence is the honest one; nothing survives it ⇒ the facility
                narrow did. Blaming the wrong control sends the operator to undo the wrong thing. */}
            {/* [BOOK-LED SURFACE]
                Unreachable while the book leads (a leading book is non-empty by `bookLeadsAnswer`'s
                own precondition), which is WHY it still speaks of the member's scope. If that
                precondition is ever relaxed, this sentence is the first thing to move. */}
            {rankedFacilities.length === 0 ? (
              <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
                No facility has claims history under this scope in the window shown.
              </p>
            ) : /* [BOOK-LED SURFACE]
                   BOTH blamed arms now come from ONE builder (fix round 1, I1) — the area arm was an
                   inline literal here, and splitting it is what let it keep promising the un-narrowed
                   total after a second narrow could compose with it. The facility arms re-base on
                   `bookLeads` explicitly, because "no history at NASHVILLE" is a claim about the MEMBER
                   while a book-led grid is a claim about the PAYER; the area arm's count is of the
                   LEADING list and follows the flip by construction. */
            blamedNarrow !== null ? (
              <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
                {gridNarrowEmptyCopy({
                  blame: blamedNarrow,
                  areaActive,
                  facilityActive: facilityNarrowActive,
                  picked: pickedFacilityNames,
                  pickedWithHistory: picksWithMemberHistory,
                  bookLeads,
                  bookPayer,
                  rankedTotal: rankedFacilities.length,
                  afterClearingFacility: areaOnlyFacilities.length,
                  afterClearingArea: facilityOnlyFacilities.length,
                  elsewhere: memberElsewhere,
                })}
              </p>
            ) : null}
          </section>

          {/* ── THE PAYER'S WHOLE BOOK, SECONDARY (S2, 2026-08-08) ───────────────────────────────
              "Does this policy pay, ANYWHERE" — the question the member's own footprint cannot
              answer when that footprint is 1.14 facilities, which it is 58.8% of the time.

              ⚠ IT CARRIES ITS OWN BASIS LABEL AND BORROWS NONE. Every claim surface above this
              section — the identity line, the resolved-scope sentence, the skip banner, the hero's
              "N rated facilities", the AI grounding caption — describes the SEARCHED IDENTIFIER, and
              a second ranked list that quietly inherited any of them would be exactly the scope lie
              PRs #92 / #148 / #157 were each spent removing. So this states what it is, in its own
              words, above its own grid.

              ⚠ SAME `ScoreCard`, DELIBERATELY. S1's census chips, the sunk treatment and the rating
              words come free and cannot fork. `allPayers={false}` is not a convenience: the book is
              payer-scoped BY CONSTRUCTION (it is null whenever the ranking is identifier-wide), so
              `count(distinct primary_payer)` over its rows is 1 by the equality that built them and
              the blend disclosure has nothing to disclose. Passing the member ranking's `allPayers`
              through would have printed "1 payer · AETNA" on every book card — noise dressed as a
              finding.

              ⚠ SECONDARY ONLY WHEN THE BOOK DOES NOT LEAD (S3). At one member the book IS the grid
              above and this section must not render a second copy of it; in every other bucket the
              identifier has a real population of its own, keeps the lead, and this stays where S2
              put it. `!bookLeads` is the whole difference — the section's own markup is unchanged. */}
          {bookOnScreen && !bookLeads && bookPayer !== null ? (
            <section data-v3-book aria-labelledby="qualify-book-heading" className="flex flex-col gap-2">
              <h3 id="qualify-book-heading" className="ths-h text-base font-semibold text-ink900">
                Where {bookPayer} pays — across the whole book
              </h3>
              <p className="text-xs text-ink600">
                <span className="ths-num" aria-label={`${bookFacilities!.length} facilities in this payer's book`}>
                  {bookFacilities!.length}
                </span>{' '}
                {/* THE FLOOR, STATED — see the leading basis line's note. Here the contradiction is
                    starker still: at an EMPTY book this sentence reads "0 facilities — every facility
                    {payer} paid at" directly above "No facility … clears the volume floor". */}
                facilities — every facility {bookPayer} paid at above the volume floor in this window,
                not this member&apos;s history. Ranked the same way: a facility that can admit today first,
                then the rating.
              </p>
              <ul className="grid list-none grid-cols-1 gap-3 p-0 lg:grid-cols-2">
                {bookFacilities!.slice(0, QUALIFY_BOOK_PREVIEW).map((f) => (
                  /* THE ANNOTATION RIDES HERE TOO (S3). The join is a fact about the data, not about
                     the flip — so where the searched identifier HAS billed at a facility in this
                     payer's book, the card says so in every bucket. The WORDS differ (see
                     `memberHistoryChipFor`): at 2-9 the lines belong to several people, and "seen
                     here before" would tell a rep one patient has a relationship a facility that
                     some of four do. */
                  <ScoreCard
                    key={f.facilityKey}
                    f={f}
                    allPayers={false}
                    historyChip={memberHistoryChipFor(snap.memberCount, f.memberHistory)}
                  />
                ))}
              </ul>
              {/* THE CAP IS STATED, NEVER SILENT. A secondary section must not push the answer off
                  the screen, but a truncated list that does not say it is truncated is a list making
                  a completeness claim it has not earned — and because availability leads the sort,
                  the rows a cap removes skew toward the full ones. Both facts, in one line.

                  ⚠ THE SECOND FACT IS NOW **COUNTED**, NOT PREDICTED (final review, 2026-08-08). It
                  read "A facility with no open beds sorts to the end, so it will be in the part not
                  shown" — a claim about WHERE the full houses are, and it holds only while the book
                  has fewer than QUALIFY_BOOK_PREVIEW open facilities. With eight or more open ones,
                  a full house is beyond the cap because there are simply more than eight, not because
                  it is full; and with a full house INSIDE the first eight the sentence is false
                  outright. Both states are reachable on a 48-facility book and both are pinned.

                  So it states what is true of THIS render: how many of the rows the cap removed have
                  no open beds. Zero is a real and honest answer ("0 of the 6 not shown…"), which is
                  precisely what a predicted claim could not say. `f.bedState` is the server's answer
                  — the same value that decided the sort tier — never a second derivation from
                  `openBeds`, which is 0 on every outpatient row. */}
              {bookFacilities!.length > QUALIFY_BOOK_PREVIEW ? (
                <p className="text-xs text-ink600">
                  Showing the {QUALIFY_BOOK_PREVIEW} best-ranked of {bookFacilities!.length}. A facility
                  with no open beds sorts below one that can admit today, and{' '}
                  {bookHiddenFull} of the {bookFacilities!.length - QUALIFY_BOOK_PREVIEW} not shown{' '}
                  {bookHiddenFull === 1 ? 'has' : 'have'} no open beds.
                </p>
              ) : null}
              {/* [BOOK-LED EXEMPT: renders only when the book does NOT lead] */}
              {bookFacilities!.length === 0 ? (
                <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
                  No facility in {bookPayer}&apos;s book clears the volume floor in the window shown.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {/* Everything v2 shouted, behind one calm disclosure — present, honest, not competing. */}
      <details className="rounded-lg border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink900">How this was resolved</summary>
        <div className="mt-3 flex flex-col gap-3">
          {/* Which notices survive a skip is decided at `skipSurvivingNotices` above — per KIND, with
              the reasoning. This SUPERSEDES 7c86709's single-kind filter on 'ambiguous_candidates'.
              Suppression alone is the failure mode 7c86709 warns about, so the suppressed set is
              REPLACED by a line saying why it is absent rather than silently emptied. */}
          <ul className="flex list-none flex-col gap-2 p-0">
            {(skipped ? skipSurvivingNotices : r.notices).map((n) => (
              // Severity hue BEHIND the severity word (Phase 5) — the word stays; the wash makes a
              // caution findable in a scan without reading every line.
              <li
                key={n.kind}
                className={`rounded-lg px-2.5 py-1.5 text-sm text-ink900 ${
                  n.severity === 'caution' ? 'bg-coral50' : 'bg-teal50'
                }`}
              >
                <span className="mr-2 text-xs font-semibold uppercase text-ink600">
                  {n.severity === 'caution' ? 'Caution' : 'Note'}
                </span>
                {n.text}
              </li>
            ))}
            {skipped ? (
              <li className="rounded-lg bg-teal50 px-2.5 py-1.5 text-sm text-ink900">
                <span className="mr-2 text-xs font-semibold uppercase text-ink600">Note</span>
                No plan was chosen, so the notes about one plan — its benefits, its evidence, its network —
                are not shown: every one of them describes the plan you skipped past, not the rows above.
                {/* Only offered when a plan COULD carry them. With no VOB row anywhere behind this
                    identifier, "pick a plan to see them" sends the user after notes that do not exist. */}
                {identifierHasNoVob ? '' : ' Pick a plan from the receipt to see them.'}
              </li>
            ) : null}
          </ul>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(['ranking', 'policy', 'ai'] as const).map((panel) => (
              <div key={panel} className="flex flex-col">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink400">
                  {/* ⚠ M8 (S3): "Facility ranking" IS SINGULAR AND THE SCREEN HAS TWO. This panel is
                      the one place a reader goes to ask what backs each region, so it is the last
                      place the count of rankings may be left implicit. */}
                  {panel === 'ranking'
                    ? bookLeads
                      ? 'Facility rankings'
                      : 'Facility ranking'
                    : panel === 'policy'
                      ? 'Policy card'
                      : 'AI explainer'}
                </dt>
                {/* See skipProvenance: r.provenance is resolve-time and names the DECLINED plan's
                    employer and member/line counts. The panels are identifier-wide after a skip.
                    ⚠ AND ON THE NON-SKIPPED PATH `r.provenance.ranking` IS MINTED SERVER-SIDE from
                    the chosen candidate — it describes a plan, and says nothing about which of the
                    two rankings leads. The book-led arm replaces it rather than appending, because
                    "which list is this" is the question this row exists to answer. The SKIPPED path
                    already carries its own book-led arm through `skipProvenance.ranking`. */}
                <dd className="text-sm text-ink900">
                  {skipped
                    ? skipProvenance[panel]
                    : panel === 'ranking' && bookLedRankingTrace !== null
                      ? bookLedRankingTrace
                      : r.provenance[panel]}
                </dd>
              </div>
            ))}
            <div className="flex flex-col">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink400">KPI tiles</dt>
              {/* The ratified wording, verbatim — the book-wide tiles are deliberately NOT about this client.
                  CORRECT after a skip too: `panelProvenance`'s book_wide arm (resolution.ts:304-308) is
                  minted unconditionally and makes no claim about any plan or employer. Left untouched.

                  ⚠ S3: THE RATIFIED STRING STAYS, AND STOPS BEING A DISTINCTION ON ITS OWN. "Book-wide,
                  not this client" earned its keep by contrasting the tiles with a client-scoped ranking
                  beside them. Once the ranking above is ALSO the book, a reader meeting that sentence
                  reasonably infers a difference that is no longer there. The wording is ratified copy
                  and is not edited; the clause that follows it is this screen's own, and only renders
                  where the contrast has collapsed. */}
              <dd className="text-sm text-ink900">
                {r.provenance.kpis}
                {bookLeads ? ' — and so is the ranking above, now that the book leads' : ''}
              </dd>
            </div>
          </dl>
          {/* ⚠ THE PREDICATE IS RE-CAPTIONED WHEN SKIPPED, NOT SUPPRESSED. `predicateIdFor` hashes the
              chosen candidate's employerLabel/funding/planType (resolutionService.ts:415-423), so after
              a skip it is the identity of a row set NO panel above is about — the "same rows" contract
              is simply false there, and no other surface on the skip screen carries this id to compare
              against. Deleting the line was the tempting move and is the wrong one under 7c86709: the
              id is the only durable handle on what the identify step actually produced, the receipt's
              "Pick a plan" leads straight back to that resolution, and a silent gap exactly where a
              reader looks for the row-identity contract teaches nothing. So it keeps the id and states
              its real relationship to the screen. The non-skipped sentence is byte-identical. */}
          {skipped ? (
            <p className="text-xs text-ink600">
              Predicate <span className="ths-num">{r.predicateId}</span> identifies the plan that was resolved
              before you skipped — not the rows above. A general search has no single row predicate.
            </p>
          ) : (
            <p className="text-xs text-ink600">
              Predicate <span className="ths-num">{r.predicateId}</span> — panels showing the same value are about
              the same rows.
            </p>
          )}
        </div>
      </details>
    </Stage>
  );
}

// ── The root ─────────────────────────────────────────────────────────────────────────────────────

export interface ResolutionStagesProps {
  stage: FlowStage;
  resolution: QualifyResolution | null;
  reason: 'empty' | 'prefix_too_short' | 'no_match' | null;
  echo: string;
  denied?: string | null;
  pending: boolean;
  payerPick: string | null;
  planFilter: string;
  identifyAction: (fd: FormData) => void;
  planAction: (fd: FormData) => void;
  onPickPayer: (payer: string) => void;
  onPlanFilter: (v: string) => void;
  onAskAi: () => void;
  onChange: (backTo: 'identify' | 'payer' | 'plan') => void;
  /** The Skip escape hatch. Since S6 it is dispatched from ONE control, rendered beneath the step
   *  rail on the two narrowing stages — see `skipOffered` and `SkipStep`. Same `skipped` action; no
   *  reducer change. */
  onSkip: () => void;
  /**
   * The "Facilities Heating Up" trend strip, passed as a SLOT (the shell owns its fetch and its
   * marquee hook, so this module stays statically renderable).
   *
   * ⚠ RENDERED ON ALL FOUR STAGES — OVERTURNED 2026-08-07 (Alec, product directive: "I don't like
   * the tickers on the post-click search page. Need them on all the pages."). It used to exclude
   * PAYER and PLAN under the 2026-08-06 rule "it must not compete with the question being asked" —
   * that rule is not being re-argued here; Alec is the ratifier and has overturned it FOR THE
   * TICKER SPECIFICALLY. If this reversal needs correcting, that is a product call for him, not a
   * technical one. `app/test/qualifyV3Flow.test.tsx`'s coverage was REWRITTEN, not deleted, to keep
   * the overturned rule on record rather than letting it silently vanish from history.
   *
   * The armed/inert rule underneath is UNCHANGED — see `tickerIsLive`. On IDENTIFY/PAYER/PLAN the
   * shell still passes it `readOnly`: there is no ranking to narrow on those three, so an inert card
   * is the honest one. Only on ANSWER, with a snapshot on screen, does a click seed the AREA
   * facet — the restored half of v2's clickable ticker (a v2 card pivoted the whole surface to
   * {facility + dominant payer}; a v3 card narrows the ranked grid to that facility's area, because
   * v3 resolves a MEMBER and re-pivoting to a facility would throw the member away).
   */
  ticker: React.ReactNode;
  /** Optional pre-computed clusters — the shell memoizes ONE `payerGroupsOf` call per resolution and
   *  threads it to the rail, receipt, both tile stages, the STAGE MACHINE (`deriveStage`) and the
   *  LIVE SENTENCE, which otherwise each re-derive it. The point is single-source-of-truth, not
   *  speed: `payerGroupsOf` folds candidates by display name BEFORE clustering, so `clusterCarriers`
   *  is O(n²) in the count of DISTINCT carrier names (~13 on a real prefix), not in the candidate
   *  count — measured ~0.05 ms/call at 311 candidates. Threading it means the stage the flow picks
   *  and the carriers the rail counts can never be two derivations that merely happen to agree. */
  payerGroups?: PayerGroup[];
  answer: Omit<StageAnswerProps, 'resolution'> | null;
}

/**
 * The presentational root: rail + receipt + ONE live region + the active stage. Holds no state and
 * fetches nothing — the shell (`resolution-flow-client.tsx`) owns both, so this renders statically
 * for the I9 assertions.
 *
 * MOTION CONTRACT WITH THE SHELL: everything above `[data-v3-stage]` is CHROME — the h1, the rail,
 * the live region, the receipt, and the ticker. The shell's GSAP targets ONLY the `[data-v3-stage]`
 * subtree, so the chrome never blinks on a stage swap; the receipt reads as a persistent trail
 * precisely because it does not move. The ticker sits OUTSIDE the animated subtree for the SAME
 * reason, and — since 2026-08-07 — on EVERY stage that renders (now all four; see `ticker`'s own
 * doc for the reversal). It must STAY outside and stay a SINGLE mount: this is `props.ticker`,
 * rendered from ONE unconditional call site below rather than once per stage branch, precisely so a
 * stage swap cannot unmount and remount it — a remount would reset the marquee's scroll position on
 * every click, and on the answer stage a control that re-enters from `autoAlpha: 0` on every click
 * of itself is a control that flickers under the user's cursor.
 */
export function ResolutionStages(props: ResolutionStagesProps): React.ReactElement {
  // The reducer's own field, arriving through the answer bag — NOT `scopeSource === 'skipped'`, which
  // a single billed-under chip press used to falsify (see the `ScopeSource` header). The receipt is
  // the surface where that lie was loudest: it re-grew a "PLAN <declined employer>" entry.
  const skipped = props.answer?.skipped ?? false;
  const scopePayer = props.answer?.snapshot?.resolved?.payerName ?? null;
  // The receipt's Scope entry used to be able to say only "All plans" plus, when there was one, a
  // label. Under an identifier-wide ranking there is no label AND the payer axis is genuinely wide —
  // "All plans" alone would read as an omission where it is actually the stronger claim, so the
  // receipt names it.
  const scopeAllPayers = props.answer?.snapshot?.resolved?.payerScope === 'all';
  // Only when the core HONOURED the chip: `scopeSource === 'user'` means one was sent, not that it
  // was applied, and `scopePayer` is the label actually used. Calling a rejected chip "your re-scope"
  // would be the same class of overclaim this fix removes.
  const scopeByUser = props.answer?.scopeSource === 'user' && (props.answer?.snapshot?.payerOverridden ?? false);
  return (
    <div role="region" aria-labelledby="qualify-v3-flow-heading" className="flex flex-col gap-5">
      <h1 id="qualify-v3-flow-heading" className="font-head text-2xl font-semibold tracking-tight text-ink900">
        Qualify a client
      </h1>

      <StepRail stage={props.stage} resolution={props.resolution} payerGroups={props.payerGroups} />

      {/* ── THE SKIP, DIRECTLY BENEATH THE RAIL (S6, 2026-08-08) ──────────────────────────────────
          "Just underneath the green timeline", and one site rather than the three it used to render
          from. `skipOffered` carries the per-stage gating — including the preserved 2026-08-06
          carrier-count suppression, whose recorded premise died in the 2026-08-07 reversal and whose
          RULING did not (see `SKIP_CARRIER_MAX`). It reads the same memoized clusters as the rail
          immediately above it, so the two cannot count carriers differently.

          It sits OUTSIDE `[data-v3-stage]` on purpose: the shell's entrance tween animates
          `autoAlpha` over that subtree and `autoAlpha` means `visibility: hidden`, which would make
          the loudest control on the screen unclickable and invisible to AT for the first frames of
          every stage. Chrome does not blink; this control is live from frame zero. */}
      {skipOffered(props.stage, props.resolution, props.payerGroups) ? (
        <SkipStep onSkip={props.onSkip} what={props.stage === 'payer' ? 'the carrier step' : 'the plan step'} />
      ) : null}

      {/* THE single live region — one, not one per panel; the important sentence must not queue. */}
      <p aria-live="polite" className="sr-only">
        {liveSentenceFor(props.stage, props.resolution, props.reason, {
          skipped,
          scopePayer,
          scopeAllPayers,
          payerGroups: props.payerGroups,
          /* S2: the preface, ANNOUNCED — and suppressed on exactly the same condition as the visible
           * line. The sr-only region carries no dim and no beam, so a screen-reader user has no
           * signal that what they are hearing describes a scope already being replaced; withholding
           * the classification is the only way to say "provisional" in this channel. Without this
           * gate the spoken claim would outlive the seen one, which is the disagreement the whole
           * one-derivation discipline exists to prevent.
           *
           * ⚠ `refreshing` JOINS THE OTHER TWO (final review, 2026-08-08). The VISIBLE preface gates
           * on `stale` — all three — and this gated on two, so a same-scope REFRESH left the spoken
           * classification standing while the seen one waited. The aria channel must never say what
           * the visible channel suppresses; S5's `windowMoved` gate below already carried all three,
           * which is what made the gap visible. `bookLedPayer` deliberately keeps the two-state gate:
           * its visible counterpart (the grid heading) is not suppressed on a refresh either, only
           * dimmed, so adding `refreshing` there would make the spoken channel say LESS than the seen
           * one — the same disagreement in the opposite direction. */
          memberCount:
            props.answer?.refetching || props.answer?.staleAfterError || props.answer?.refreshing
              ? null
              : (props.answer?.snapshot?.memberCount ?? null),
          memberFacilityCount: props.answer?.snapshot?.facilities.length ?? 0,
          /* S3: WHICH LIST THE GRID IS, ANNOUNCED. `bookLeadsAnswer` is the same predicate the stage
           * renders on — the sr-only line is exactly where a scope claim survives a browser pass, and
           * after the flip the un-updated sentence would describe the member's ranking over a grid
           * showing the payer's whole book. SUPPRESSED IN FLIGHT on the two conditions that replace
           * the SET (a re-scope, a failed re-scope) — deliberately NOT on `refreshing`; see the note
           * on the classification above for why the third state is asymmetric here. */
          bookLedPayer:
            props.answer?.refetching || props.answer?.staleAfterError || !bookLeadsAnswer(props.answer?.snapshot)
              ? null
              : scopedPayerOf(props.answer?.snapshot?.resolved),
          /* S5: THE WINDOW MOVE, ANNOUNCED — gated on exactly the three conditions the visible
           * notice is gated on, because two channels making the same claim under different
           * conditions is the disagreement this whole one-derivation discipline exists to prevent.
           * `refreshing` joins the in-flight suppression here: a claim about a window that is being
           * re-derived right now is a claim about the set being replaced. */
          windowMoved:
            props.answer?.refetching ||
            props.answer?.staleAfterError ||
            props.answer?.refreshing ||
            props.answer?.windowDays != null
              ? null
              : (props.answer?.windowMove ?? null),
        })}
      </p>

      {/* [BOOK-LED EXEMPT: an access decision, describing the viewer and never a list] */}
      {props.denied ? (
        <p role="status" className="rounded-md border border-line bg-teal50 p-4 text-sm text-ink900">
          {props.denied}
        </p>
      ) : null}

      {props.resolution && props.stage !== 'identify' ? (
        <FlowReceipt
          resolution={props.resolution}
          stage={props.stage}
          payerPick={props.payerPick}
          onChange={props.onChange}
          payerGroups={props.payerGroups}
          skipped={skipped}
          memberCount={props.answer?.snapshot?.memberCount ?? null}
          scopePayer={scopePayer}
          scopeAllPayers={scopeAllPayers}
          scopeByUser={scopeByUser}
        />
      ) : null}

      {/* ALL FOUR STAGES, one persistent mount (2026-08-07 directive — see `ticker`'s doc above). */}
      {props.ticker}

      <div data-v3-stage>
        {props.stage === 'identify' ? (
          <>
            <StageIdentify
              echo={props.echo}
              readAs={props.resolution ? props.resolution.handle.readAs : null}
              action={props.identifyAction}
              pending={props.pending}
            />
            {/* [BOOK-LED EXEMPT: the identifier did not resolve, so no snapshot can lead] */}
            {!props.resolution && props.reason ? (
              <p role="status" className="mt-4 max-w-xl rounded-md border border-line bg-teal50 p-4 text-sm text-ink600">
                {UNRESOLVABLE_COPY[props.reason]}
              </p>
            ) : null}
          </>
        ) : null}

        {props.stage === 'payer' && props.resolution ? (
          <StagePayer resolution={props.resolution} onPick={props.onPickPayer} payerGroups={props.payerGroups} />
        ) : null}

        {props.stage === 'plan' && props.resolution ? (
          <StagePlan
            resolution={props.resolution}
            payerPick={props.payerPick}
            planFilter={props.planFilter}
            onPlanFilter={props.onPlanFilter}
            planAction={props.planAction}
            onAskAi={props.onAskAi}
            pending={props.pending}
            payerGroups={props.payerGroups}
          />
        ) : null}

        {props.stage === 'answer' && props.resolution && props.answer ? (
          <StageAnswer resolution={props.resolution} {...props.answer} />
        ) : null}
      </div>
    </div>
  );
}
