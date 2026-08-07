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
// keystroke in the employer tag-search.
import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
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
import { IQ_BAND_LABELS, IQ_BAND_VERDICTS } from '../../../lib/qualify/ratingV2';
import { clusterCarriers, type CarrierCluster } from '../../../lib/qualify/carrierCluster';
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

// ── Answer-stage filters (the general-search escape hatch) ───────────────────────────────────────

/** Multiselect narrows on the answer stage. Empty array = no restriction on that facet. */
export interface AnswerFilters {
  planTypes: string[];
  funding: string[];
  employers: string[];
}

export const NO_ANSWER_FILTERS: AnswerFilters = { planTypes: [], funding: [], employers: [] };

export function answerFiltersActive(f: AnswerFilters): boolean {
  return f.planTypes.length > 0 || f.funding.length > 0 || f.employers.length > 0;
}

/** AND across facets, OR within one — the standard multiselect reading. */
export function filterCandidates(all: readonly OrderedCandidate[], f: AnswerFilters): OrderedCandidate[] {
  return all.filter((c) => {
    if (f.planTypes.length > 0 && !(c.planType !== null && f.planTypes.includes(c.planType))) return false;
    if (f.funding.length > 0 && !(c.funding !== null && f.funding.includes(c.funding))) return false;
    if (f.employers.length > 0 && !(c.employerLabel !== null && f.employers.includes(c.employerLabel))) return false;
    return true;
  });
}

export interface Facet {
  value: string;
  members: number;
}

/** Distinct values per facet, member-weighted and ranked — the biggest option first, so the list
 *  reads as "what this identifier actually has" rather than an alphabet. */
export function facetsOf(all: readonly OrderedCandidate[]): {
  planTypes: Facet[];
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
    planTypes: tally((c) => c.planType),
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
 *   · toggling a plan type whose employer set is not a proper subset, or exceeds the 200 bound —
 *     both leave `market.employers` null and the market key unchanged.
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
}): string {
  return [
    parts.payerLabel ?? '',
    parts.windowDays === null ? 'auto' : String(parts.windowDays),
    parts.funding.slice().sort().join('|'),
    parts.employers === null ? '' : parts.employers.slice().sort().join('|'),
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
  opts: { skipped?: boolean; scopePayer?: string | null; payerGroups?: PayerGroup[] } = {},
): string {
  if (!resolution) return reason ? UNRESOLVABLE_COPY[reason] : '';
  // A skipped search resolved NOTHING past the identifier: announcing the pre-selected candidate's
  // employer as "Resolved: …" told a screen-reader user a plan had been chosen when none was — the
  // same claim the receipt and the identity line had to stop making.
  if (opts.skipped) {
    return (
      'You skipped the plan questions. Showing a general search across all plans' +
      (opts.scopePayer ? ` under ${opts.scopePayer}` : '') +
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
  /** A skipped search decided nothing past the identifier — see the guard in the body. */
  skipped?: boolean;
  /** The payer the RANKING actually used, for the skipped scope entry. */
  scopePayer?: string | null;
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
          <span className="text-sm text-ink900">All plans{scopePayer ? ` · ${scopePayer}` : ''}</span>
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

/** Employer chips rendered at once in the answer-stage tag-search. Selected chips are always shown
 *  on top of this, so a narrow is never hidden by the cap. */
const EMPLOYER_CHIP_CAP = 40;

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

function ScoreCard({ f }: { f: QualifyFacility }): React.ReactElement {
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
   */
  scopeSource: 'user' | 'pick' | 'dominant' | 'skipped';
  /** The candidate UNIVERSE the filter lines describe: every plan under the picked carrier, or —
   *  after a Skip — every plan behind the identifier. Supplied by the shell so this stays pure. */
  candidates: readonly OrderedCandidate[];
  filters: AnswerFilters;
  onToggleFilter: (facet: 'planType' | 'funding' | 'employer', value: string) => void;
  onClearFilters: () => void;
  employerQuery: string;
  onEmployerQuery: (v: string) => void;
  /** Set when the employer narrow could not be sent because it exceeded the action's 200 bound —
   *  the caption says the ranking is NOT employer-narrowed rather than implying it is. */
  employerNarrowTooMany: number | null;
  payerOverride: string | null;
  onPayerOverride: (label: string | null) => void;
  windowDays: QualifyTrailingDays | null;
  onWindowDays: (days: QualifyTrailingDays | null) => void;
  /**
   * A RE-SCOPE of content already on screen (window chip, billed-under chip) — per the design
   * system, that keeps the current content rendered at reduced opacity with a thin progress bar,
   * instead of blanking to a skeleton. Skeletons are for genuine first loads only.
   */
  refetching: boolean;
}

/** One filter row, styled as the "BILLED UNDER" line: a label, then toggle chips. Multiselect —
 *  `aria-pressed` carries the state and the chip appends " · on" so it is never hue-only. */
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
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-ink400">{props.label}</span>
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
  const skipped = props.scopeSource === 'skipped';
  const scopePayer = snap?.resolved?.payerName ?? g.payerDisplayName;
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
  // Employer options: filtered by the tag-search text, then capped for render — a 311-employer chip
  // wall is not a control. Selected employers are always shown so a narrow is never invisible.
  const employerNeedle = props.employerQuery.trim().toLowerCase();
  const employerMatches = useMemo(
    () => facets.employers.filter((o) => employerNeedle === '' || o.value.toLowerCase().includes(employerNeedle)),
    [facets.employers, employerNeedle],
  );
  const employerOptions = useMemo(
    () => [
      ...facets.employers.filter((o) => props.filters.employers.includes(o.value)),
      ...employerMatches.filter((o) => !props.filters.employers.includes(o.value)).slice(0, EMPLOYER_CHIP_CAP),
    ],
    [facets.employers, employerMatches, props.filters.employers],
  );
  return (
    <Stage id="qualify-s-answer" question="Does this payer pay us — and where?">
      {/* The identity of what is on screen, restated in one line — never re-derived. */}
      <p className="text-sm text-ink900">
        <span className="font-semibold">{skipped ? scopePayer : g.payerDisplayName}</span>
        <span className="text-ink600"> · {skipped ? 'all plans — no plan chosen' : policyBits}</span>
      </p>

      {(props.pending || (!snap && !props.snapshotError)) && !(snap && props.refetching) ? (
        <>
          <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
            Ranking facilities for this plan…
          </p>
          <AnswerSkeleton />
        </>
      ) : props.snapshotError ? (
        <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
          The facility ranking could not be loaded. The plan resolution above still stands — try again, or
          change the window.
        </p>
      ) : snap ? (
        // The refetch treatment: current content stays RENDERED and readable at reduced opacity with
        // a thin indeterminate bar — a re-scope is not a first load, and blanking to a skeleton
        // makes every chip click feel like a page rebuild.
        <div className={`relative flex flex-col gap-4 ${props.refetching ? 'opacity-60 transition-opacity duration-150' : ''}`}>
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
          {!props.refetching && props.scopeSource === 'dominant' && snap.resolved && r.candidates.total > 1 ? (
            <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
              {g.claimEvidence.lines === 0
                ? `This plan has no claims history of its own — the ranking below is this identifier's history under ${snap.resolved.payerName}, not evidence about ${g.payerDisplayName}.`
                : `The ranking below could not be scoped to ${g.payerDisplayName} — it shows this identifier's history under ${snap.resolved.payerName}, its largest payer by volume.`}
            </p>
          ) : null}

          {/* A SKIP is its own scope claim: no plan was chosen, so the ranking is the identifier's
              whole footprint under its largest payer. "You declined to narrow" and "we could not
              narrow" are different statements and must not share copy. */}
          {!props.refetching && props.scopeSource === 'skipped' && snap.resolved ? (
            <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink900">
              You skipped the plan questions, so this is a general search: every facility this member
              has history at under {snap.resolved.payerName}. Use the lines below to narrow it, or the
              receipt above to pick a plan.
            </p>
          ) : null}

          {/* ── The control lines. All visible, none behind a dropdown (the employer tag-search is
              the one exception — 311 employers cannot be chips). Each is the "BILLED UNDER" idiom:
              a label, then toggles. Window is SINGLE-select (a window is one value); the three
              facets are multiselect. ── */}
          <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface px-4 py-3">
            <p className="text-sm text-ink900">{windowSentence(snap, props.windowDays)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-ink400">Window</span>
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

            <FilterLine
              label="Plan type"
              options={facets.planTypes}
              selected={props.filters.planTypes}
              onToggle={(v) => props.onToggleFilter('planType', v)}
            />
            <FilterLine
              label="Funding"
              options={facets.funding}
              selected={props.filters.funding}
              onToggle={(v) => props.onToggleFilter('funding', v)}
            />

            {/* The employer tag-search: a visible dropdown whose SUMMARY states the current reach,
                so the count is readable without opening it. */}
            {facets.employers.length > 0 ? (
              <details className="group/emp text-xs">
                {/* A REAL dropdown control, not a text link: same pill geometry as every other chip
                    on these lines, with its own caret. `list-none` + the webkit rule kill the
                    native marker so the caret is ours and points the right way when open. */}
                <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink900 transition-colors hover:border-teal500 hover:text-teal700 [&::-webkit-details-marker]:hidden">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink400">Employers</span>
                  {props.filters.employers.length > 0
                    ? `Narrowed to ${props.filters.employers.length} of ${facets.employers.length}`
                    : `Searched over ${facets.employers.length}`}
                  <span aria-hidden className="text-ink400 transition-transform group-open/emp:rotate-180">
                    ▾
                  </span>
                </summary>
                <div className="mt-2 flex flex-col gap-2 rounded-xl border border-line bg-ground p-3">
                  <label htmlFor="qualify-answer-employers" className="text-xs font-medium text-ink900">
                    Find an employer
                  </label>
                  <input
                    id="qualify-answer-employers"
                    type="text"
                    value={props.employerQuery}
                    onChange={(e) => props.onEmployerQuery(e.target.value)}
                    autoComplete="off"
                    className="max-w-sm rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink900 outline-none transition-colors focus:border-teal500 focus:ring-2 focus:ring-teal500/25"
                  />
                  <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                    {employerOptions.map((o) => {
                      const on = props.filters.employers.includes(o.value);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => props.onToggleFilter('employer', o.value)}
                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                            on ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600 hover:border-teal200'
                          }`}
                        >
                          {o.value}
                          <span className="font-mono tabular-nums text-ink400"> · {o.members.toLocaleString()}</span>
                          {on ? ' · on' : ''}
                        </button>
                      );
                    })}
                  </div>
                  {employerOptions.length < employerMatches.length ? (
                    <p className="text-ink600">
                      Showing the {employerOptions.length} largest of {employerMatches.length} matches — type to narrow.
                    </p>
                  ) : null}
                </div>
              </details>
            ) : null}

            {/* What the filters DID to the ranking — stated, never inferred. */}
            {filtersActive ? (
              <p className="flex flex-wrap items-center gap-2 text-xs text-ink600">
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
                  className="rounded-full border border-line px-2.5 py-0.5 font-semibold text-teal700 hover:bg-teal50"
                >
                  Clear filters
                </button>
              </p>
            ) : null}
          </div>

          {/* Claims-side scope: which billed-under label the ranking is scoped to. */}
          {snap.payerOptions.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-ink400">Billed under</span>
              {snap.payerOptions.map((p) => {
                const active = snap.resolved?.payerName === p.payer;
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
              {/* "You picked this" / "your plan pick implies this" / "we defaulted" are three
                  different claims — and a REJECTED override must never render as honoured. The
                  caption is SUPPRESSED IN FLIGHT (rule 2654416): it asserts one of four scope
                  claims about a set that has not answered yet. The chips themselves stay — they
                  are the user's controls, not claims. */}
              {props.refetching ? null : (
                <span className="text-xs text-ink600">
                  {snap.payerOverridden
                    ? props.scopeSource === 'user'
                      ? 'Your selection.'
                      : 'Scoped to the plan you picked.'
                    : props.scopeSource !== 'dominant'
                      ? 'Could not scope to the picked plan — showing the largest by volume.'
                      : 'Largest by volume — pick another to re-scope.'}
                </span>
              )}
            </div>
          ) : null}

          {/* The hero: ONE number, patient-weighted, with its basis stated. The band wash sits
              behind it (Phase 5); the verdict WORD beside the numeral still carries the meaning.
              SUPPRESSED IN FLIGHT (rules e7e8a0e + 2654416): the numeral, the verdict word and the
              basis are claims about the data — at zero rated facilities the basis literally reads
              "no facility clears the sample floor", which is FALSE during a fetch. The dim treatment
              is a marker calibrated for the grid's numbers; these sentences wait instead. */}
          <div
            className="flex items-center gap-5 rounded-xl border border-line bg-surface p-5 shadow-ths-sm"
            style={!props.refetching && rating?.band ? { backgroundColor: IQ_BAND_WASH[rating.band] } : undefined}
          >
            {props.refetching ? (
              // No numeral, no verdict, no basis — a wordless pulse holds the footprint.
              <span aria-hidden className="h-14 w-full max-w-sm animate-pulse rounded-lg bg-ground" />
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

          {/* The scorecard. Ranked; each card explains itself behind ONE disclosure. */}
          <section aria-labelledby="qualify-scorecard-heading" className="flex flex-col gap-2">
            <h3 id="qualify-scorecard-heading" className="ths-h text-base font-semibold text-ink900">
              Facilities, ranked
            </h3>
            <ul className="grid list-none grid-cols-1 gap-3 p-0 lg:grid-cols-2">
              {snap.facilities.map((f) => (
                <ScoreCard key={f.facilityKey} f={f} />
              ))}
            </ul>
            {snap.facilities.length === 0 ? (
              <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
                No facility has claims history under this scope in the window shown.
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {/* Everything v2 shouted, behind one calm disclosure — present, honest, not competing. */}
      <details className="rounded-lg border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink900">How this was resolved</summary>
        <div className="mt-3 flex flex-col gap-3">
          <ul className="flex list-none flex-col gap-2 p-0">
            {r.notices
              // 'ambiguous_candidates' reads "You are seeing the one you selected" — false after a
              // Skip, where the user selected nothing. The skip banner above says what happened.
              .filter((n) => !(skipped && n.kind === 'ambiguous_candidates'))
              .map((n) => (
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
          </ul>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(['ranking', 'policy', 'ai'] as const).map((panel) => (
              <div key={panel} className="flex flex-col">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink400">
                  {panel === 'ranking' ? 'Facility ranking' : panel === 'policy' ? 'Policy card' : 'AI explainer'}
                </dt>
                <dd className="text-sm text-ink900">{r.provenance[panel]}</dd>
              </div>
            ))}
            <div className="flex flex-col">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink400">KPI tiles</dt>
              {/* The ratified wording, verbatim — the book-wide tiles are deliberately NOT about this client. */}
              <dd className="text-sm text-ink900">{r.provenance.kpis}</dd>
            </div>
          </dl>
          <p className="text-xs text-ink600">
            Predicate <span className="ths-num">{r.predicateId}</span> — panels showing the same value are about
            the same rows.
          </p>
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
   * marquee hook, so this module stays statically renderable). Rendered on the IDENTIFY stage only:
   * that is the screen the search has not filled yet, and it is what keeps the landing alive instead
   * of the near-empty page the staged rebuild first shipped. On the later stages it would compete
   * with the question being asked, which is the whole point of one-question-per-screen.
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
 * precisely because it does not move. The ticker sits OUTSIDE the animated subtree for the same
 * reason, even though it renders only on the identify stage.
 */
export function ResolutionStages(props: ResolutionStagesProps): React.ReactElement {
  const skipped = props.answer?.scopeSource === 'skipped';
  const scopePayer = props.answer?.snapshot?.resolved?.payerName ?? null;
  return (
    <div role="region" aria-labelledby="qualify-v3-flow-heading" className="flex flex-col gap-5">
      <h1 id="qualify-v3-flow-heading" className="font-head text-2xl font-semibold tracking-tight text-ink900">
        Qualify a client
      </h1>

      <StepRail stage={props.stage} resolution={props.resolution} payerGroups={props.payerGroups} />

      {/* THE single live region — one, not one per panel; the important sentence must not queue. */}
      <p aria-live="polite" className="sr-only">
        {liveSentenceFor(props.stage, props.resolution, props.reason, { skipped, scopePayer, payerGroups: props.payerGroups })}
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
        />
      ) : null}

      {props.stage === 'identify' ? props.ticker : null}

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
