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
import { Briefcase, ChevronRight } from 'lucide-react';
import { MultiSelectTagPicker } from '../../ui/multi-select-tag-picker';
import type {
  CoverageGroupSummary,
  QualifyResolution,
} from '../../../lib/qualify/resolution';
import type {
  QualifyFacility,
  QualifySnapshot,
  QualifyTrailingDays,
} from '../../../lib/qualify/contract';
import { derivePolicyRating } from '../../../lib/qualify/policyRating';
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
import { IQ_BAND_HEX, IQ_BAND_WASH } from '../tokens';

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
  } = {},
): string {
  if (!resolution) return reason ? UNRESOLVABLE_COPY[reason] : '';
  // A skipped search resolved NOTHING past the identifier: announcing the pre-selected candidate's
  // employer as "Resolved: …" told a screen-reader user a plan had been chosen when none was — the
  // same claim the receipt and the identity line had to stop making.
  if (opts.skipped) {
    // The screen-reader sentence carries the SAME scope claim as the visible banner, so it takes the
    // same three-way branch. "across all plans under AETNA" said aloud over an all-payers ranking is
    // the identical lie, just less visible — and the sr-only line is exactly where an unfixed claim
    // survives a browser pass.
    return (
      'You skipped the plan questions. Showing a general search across all plans' +
      (opts.scopeAllPayers ? ' and all payers on file' : opts.scopePayer ? ` under ${opts.scopePayer}` : '') +
      '.'
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
  return (
    `Resolved: ${g.payerDisplayName}` +
    (g.employerLabel ? ` · ${g.employerLabel}` : '') +
    (g.funding ? ` · ${g.funding}` : '') +
    `. ${g.claimEvidence.distinctFacilities} facilities with history.` +
    (resolution.candidates.wasAmbiguous
      ? ` ${resolution.candidates.total} plans matched; this one is selected.`
      : ' Only one plan matched.')
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
 */
export const SKIP_CARRIER_MAX = 3;

/**
 * The escape hatch: stop answering questions and go straight to the answer over the identifier's
 * WHOLE footprint, then narrow (or not) with the answer stage's filter lines. Declining to choose is
 * a real answer, and the answer stage says which one it got.
 */
function SkipStep(props: { onSkip: () => void; what: string }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onSkip}
      aria-label={`Skip ${props.what} and search across all plans for this member`}
      className="w-fit rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink600 transition-colors hover:border-teal500 hover:text-teal700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
    >
      Skip <span className="font-normal text-ink400">— search all plans</span>
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

  // ⚠ A SKIPPED SEARCH DECIDED NOTHING BEYOND THE IDENTIFIER. Rendering the pre-selected candidate's
  // employer as a "PLAN" entry claimed a decision the user explicitly declined to make. The receipt
  // is a record of DECISIONS; after a skip there is one, plus the scope the ranking actually used.
  if (skipped) {
    return (
      <nav aria-label="Your search so far" className="flex flex-wrap items-center gap-2">
        <span className={entry}>
          <span className="text-xs font-medium uppercase tracking-wide text-ink400">Search</span>
          <span className="ths-num text-sm text-ink900">{idLabel}</span>
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
  onSkip: () => void;
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
      {groups.length < SKIP_CARRIER_MAX ? <SkipStep onSkip={props.onSkip} what="the carrier step" /> : null}
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
  onSkip: () => void;
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
        <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
          No plans are on file under {payer} in this result. Use the receipt above to change the
          carrier or search again.
        </p>
        <SkipStep onSkip={props.onSkip} what="the plan step" />
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
          <SkipStep onSkip={props.onSkip} what="the plan step" />
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
                <button
                  type="submit"
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
const EMPTY_FACILITIES: readonly QualifyFacility[] = [];

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
 * `allPayers` is the RANKING's scope, passed down rather than inferred from `f.payerCount`: a
 * single-label card under an all-payers ranking and the same card under a payer-scoped one carry
 * identical counts and are different claims. See the blend disclosure in the body.
 */
function ScoreCard({ f, allPayers }: { f: QualifyFacility; allPayers: boolean }): React.ReactElement {
  const location = [f.city, f.state].filter(Boolean).join(', ');
  return (
    <li
      data-v3-tile
      className="rounded-xl border border-line bg-surface p-4 shadow-ths-sm"
      // IQ_BAND_WASH at card level (Phase 5): the wash EXTENDS the numeral's hue, which already sits
      // beside its verdict word — colour accompanies the word, never replaces it. Unrated cards keep
      // the plain surface: honest restraint stays visually colourless.
      style={f.iqBand && f.ratingV2 !== null ? { backgroundColor: IQ_BAND_WASH[f.iqBand] } : undefined}
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
   * 'dominant' = nothing to send, the core resolved the identifier's largest payer. The captions
   * below MUST distinguish these — "you picked this" and "we defaulted to this" are different claims
   * about the same number.
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
   * Re-issue the identical snapshot request after a failure. The shell carries a nonce to make this
   * possible: a retry's scope key is unchanged by construction and the fetch effect keys on it, so
   * without an explicit trigger, clicking the same chip again is a no-op.
   */
  onRetry: () => void;
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
 * The skipped copy describes the ranking AS IT BEHAVES TODAY — one dominant billed-under label, the
 * single-label equality in the ranking query. Widening it to the identifier's whole footprint is a
 * separate change, and copy must never pre-announce behaviour that is not shipped.
 */
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
            {on ? ' · showing' : ''}
          </button>
        );
      })}
    </div>
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
  // Dim for either reason — both mean "this describes a scope you moved off". The BEAM stays tied
  // to props.refetching alone (see below): dimming says provisional, the beam claims progress.
  const stale = props.refetching || props.staleAfterError;
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
  const rating = snap ? derivePolicyRating(snap.facilities) : null;
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
  // AREA COUNTS AS A FACET (2026-08-07), which is why this sits BELOW `areaActive` rather than beside
  // `payerFacetOn` above. Area is the one facet whose control lives outside the control card — see
  // AreaLine for why that placement is right and why it does not exempt it from the inventory —
  // and omitting it let one click produce "nothing is restricting this search" beside a lit Area chip.
  const anyFacetOn = filtersActive || payerFacetOn || areaActive;
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
          allPayers
            ? `ranked across all ${snap.payerOptions.length} billed-under labels`
            : `ranked under ${scopePayer ?? 'one billed-under label'}`,
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
  const skipProvenance: Record<'ranking' | 'policy' | 'ai', string> = {
    ranking: rankingNarrowed
      ? `all plans — no plan chosen, then narrowed by your filter selections${skipUnder}`
      : `all plans — no plan chosen · this identifier's whole footprint${skipUnder}`,
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
     */
    ai: areaActive
      ? rankingNarrowed
        ? `grounded in the full ranking behind this answer, not the narrowed grid — all plans, no plan chosen, narrowed by your filter selections${skipUnder}`
        : `grounded in the full ranking behind this answer, not the narrowed grid — all plans, no plan chosen${skipUnder}`
      : rankingNarrowed
        ? `grounded in the ranking on screen — all plans, no plan chosen, narrowed by your filter selections${skipUnder}`
        : `grounded in the ranking on screen — all plans, no plan chosen${skipUnder}`,
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
  const rankedFacilities: readonly QualifyFacility[] = snap?.facilities ?? EMPTY_FACILITIES;
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
  const shownFacilities = useMemo(
    () => facilitiesInArea(rankedFacilities, props.area),
    [rankedFacilities, props.area],
  );
  // `areaActive` is declared once, above `skipProvenance` — see the comment there.
  // Two real buckets, or an active narrow that must stay clearable. One bucket is not a choice, and
  // a row of one chip reading "All · 12" is noise — the same rule the mobile deck applies.
  const showAreaLine = areaChips.length > 2 || areaActive;
  return (
    <Stage id="qualify-s-answer" question="Does this payer pay us — and where?">
      {/* The identity of what is on screen, restated in one line — never re-derived. */}
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
          <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
            Ranking facilities for this plan…
          </p>
          <AnswerSkeleton />
        </>
      ) : null}

      {/* A genuine FIRST load failed: there is nothing to preserve and nothing to dim. Copy is
          unchanged, and deliberately carries no Retry — see the refresh banner below for why. */}
      {firstLoadFailed ? (
        <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
          The facility ranking could not be loaded. The plan resolution above still stands — try again, or
          change the window.
        </p>
      ) : null}

      {/* A REFRESH failed with a good answer still in hand. Say what is on screen and offer a real
          control — the old copy said "try again" while providing nothing to click, and re-clicking
          the same chip was a genuine no-op (unchanged scope key ⇒ the fetch effect never re-ran). */}
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
          {props.refetching ? (
            <span aria-hidden className="q-refetch-bar absolute inset-x-0 -top-2 h-0.5 overflow-hidden rounded-full">
              <span className="q-refetch-beam block h-full w-1/3 rounded-full bg-teal500" />
            </span>
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
          {!stale && !skipped && props.scopeSource === 'dominant' && snap.resolved && r.candidates.total > 1 ? (
            <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
              {g.claimEvidence.lines === 0
                ? `This plan has no claims history of its own — the ranking below is this identifier's history under ${snap.resolved.payerName}, not evidence about ${g.payerDisplayName}.`
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
              {props.staleAfterError || (props.refetching && props.windowDays === null) ? null : (
                <p className="text-sm text-teal50">{windowSentence(snap, props.windowDays)}</p>
              )}
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
                  that is not in it when that narrow is live. Wording is unratified — plain on purpose. */}
              <p className="text-xs text-teal200">
                <span className="font-semibold text-white">{cardFacetsOn} of these {cardFacets.length} switches on</span>
                {areaActive ? ' · plus the area narrow, beside the list' : ''}
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
                className={`h-14 w-full max-w-sm rounded-lg bg-ground ${props.refetching ? 'animate-pulse' : ''}`}
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
          <section aria-labelledby="qualify-scorecard-heading" className="flex flex-col gap-2">
            <h3 id="qualify-scorecard-heading" className="ths-h text-base font-semibold text-ink900">
              Facilities, ranked
            </h3>
            {showAreaLine ? (
              <AreaLine chips={areaChips} active={props.area} counts={areaCounts} onSelect={props.onSelectArea} />
            ) : null}
            {/* ⚠ THE HERO IS NOT RE-DERIVED FOR THE AREA, and this sentence is why that is honest
                rather than a bug. `derivePolicyRating` runs over `snap.facilities` — the whole
                ranked scope — and recomputing it per area would let a grid-only control silently
                move the headline number and its "N rated facilities" basis. So the number keeps its
                meaning and the narrow states its own reach instead.
                GATED ON `shownFacilities.length > 0` TOO (review Finding 2), not `areaActive` alone:
                an area with nothing in it already gets its OWN sentence below ("No ranked facility is
                in this area…"), and rendering both together put two overlapping `role="status"`
                sentences on screen for the same click — "Showing 0 of 3…" right next to "No ranked
                facility is in this area." The zero-count case has nothing left for this sentence to
                say that the other one doesn't already say better. */}
            {areaActive && shownFacilities.length > 0 ? (
              <p role="status" className="text-xs text-ink600">
                Showing{' '}
                <span className="ths-num" aria-label={`${shownFacilities.length} facilities shown`}>
                  {shownFacilities.length}
                </span>{' '}
                of{' '}
                <span className="ths-num" aria-label={`${rankedFacilities.length} ranked facilities in total`}>
                  {rankedFacilities.length}
                </span>{' '}
                ranked facilities in this area. The ranking itself was not re-run — the rating above
                still covers all {rankedFacilities.length}.
              </p>
            ) : null}
            <ul className="grid list-none grid-cols-1 gap-3 p-0 lg:grid-cols-2">
              {shownFacilities.map((f) => (
                <ScoreCard key={f.facilityKey} f={f} allPayers={allPayers} />
              ))}
            </ul>
            {/* Two different emptinesses, two different sentences. "Nothing ranked at all" is a
                statement about the payer and the window; "nothing in TN" is a statement about the
                chip the user just pressed, and the fix for it is one click away. */}
            {rankedFacilities.length === 0 ? (
              <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
                No facility has claims history under this scope in the window shown.
              </p>
            ) : shownFacilities.length === 0 ? (
              <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
                No ranked facility is in this area. The {rankedFacilities.length} facilities behind this
                answer are still there — choose All above to see them.
              </p>
            ) : null}
          </section>
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
                  {panel === 'ranking' ? 'Facility ranking' : panel === 'policy' ? 'Policy card' : 'AI explainer'}
                </dt>
                {/* See skipProvenance: r.provenance is resolve-time and names the DECLINED plan's
                    employer and member/line counts. The panels are identifier-wide after a skip. */}
                <dd className="text-sm text-ink900">{skipped ? skipProvenance[panel] : r.provenance[panel]}</dd>
              </div>
            ))}
            <div className="flex flex-col">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink400">KPI tiles</dt>
              {/* The ratified wording, verbatim — the book-wide tiles are deliberately NOT about this client.
                  CORRECT after a skip too: `panelProvenance`'s book_wide arm (resolution.ts:304-308) is
                  minted unconditionally and makes no claim about any plan or employer. Left untouched. */}
              <dd className="text-sm text-ink900">{r.provenance.kpis}</dd>
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
  /** The Skip escape hatch, offered on both narrowing stages. */
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

      {/* THE single live region — one, not one per panel; the important sentence must not queue. */}
      <p aria-live="polite" className="sr-only">
        {liveSentenceFor(props.stage, props.resolution, props.reason, {
          skipped,
          scopePayer,
          scopeAllPayers,
          payerGroups: props.payerGroups,
        })}
      </p>

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
            {!props.resolution && props.reason ? (
              <p role="status" className="mt-4 max-w-xl rounded-md border border-line bg-teal50 p-4 text-sm text-ink600">
                {UNRESOLVABLE_COPY[props.reason]}
              </p>
            ) : null}
          </>
        ) : null}

        {props.stage === 'payer' && props.resolution ? (
          <StagePayer
            resolution={props.resolution}
            onPick={props.onPickPayer}
            onSkip={props.onSkip}
            payerGroups={props.payerGroups}
          />
        ) : null}

        {props.stage === 'plan' && props.resolution ? (
          <StagePlan
            resolution={props.resolution}
            payerPick={props.payerPick}
            planFilter={props.planFilter}
            onPlanFilter={props.onPlanFilter}
            planAction={props.planAction}
            onAskAi={props.onAskAi}
            onSkip={props.onSkip}
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
