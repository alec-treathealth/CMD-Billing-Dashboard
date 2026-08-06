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

/** One carrier tile: every candidate sharing a payer display name, members summed. */
export interface PayerGroup {
  payer: string;
  unmapped: boolean;
  memberCount: number;
  planCount: number;
  hasClaimEvidence: boolean;
}

export function payerGroupsOf(r: QualifyResolution): PayerGroup[] {
  const byPayer = new Map<string, PayerGroup>();
  for (const c of orderedCandidates(r)) {
    const g = byPayer.get(c.payerDisplayName) ?? {
      payer: c.payerDisplayName,
      unmapped: true, // AND-folded below: the tile says Unmapped only when EVERY candidate is
      memberCount: 0,
      planCount: 0,
      hasClaimEvidence: false,
    };
    g.unmapped = g.unmapped && c.canonicalPayerId === null;
    g.memberCount += c.memberCount;
    g.planCount += 1;
    g.hasClaimEvidence = g.hasClaimEvidence || c.hasClaimEvidence;
    byPayer.set(c.payerDisplayName, g);
  }
  return [...byPayer.values()].sort((a, b) => b.memberCount - a.memberCount);
}

/**
 * Which stage the flow is on. PURE — the shell owns `payerPick` (client-side carrier choice) and
 * `picked` (the user submitted a plan). A sole candidate skips straight to the answer; a single
 * carrier skips the payer stage. Skipped stages are STATED on the answer stage's disclosure, never
 * silent (deriveNotices already emits `sole_candidate`).
 */
export function deriveStage(args: {
  resolution: QualifyResolution | null;
  payerPick: string | null;
  picked: boolean;
}): FlowStage {
  const r = args.resolution;
  if (!r) return 'identify';
  if (r.candidates.total <= 1) return 'answer';
  if (args.picked) return 'answer';
  if (payerGroupsOf(r).length > 1 && args.payerPick === null) return 'payer';
  return 'plan';
}

/** The live-region sentence for the current state — announced once, as a full sentence. */
export function liveSentenceFor(
  stage: FlowStage,
  resolution: QualifyResolution | null,
  reason: 'empty' | 'prefix_too_short' | 'no_match' | null,
): string {
  if (!resolution) return reason ? UNRESOLVABLE_COPY[reason] : '';
  if (stage === 'identify') {
    // Back at the search step with a result still held — announce the STAGE, not the stale result
    // (an unchanged "Resolved: …" sentence would mean no announcement at all, and it would describe
    // a screen no longer shown).
    return 'Back at the search step. Searching again replaces the current result.';
  }
  if (stage === 'payer') {
    return `${payerGroupsOf(resolution).length} carriers match what you typed. Pick the one on the card.`;
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
function Stage(props: { id: string; question: string; children: React.ReactNode }): React.ReactElement {
  const headingId = `${props.id}-heading`;
  return (
    <section id={props.id} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2
        id={headingId}
        tabIndex={-1}
        className="ths-h font-display text-xl font-semibold tracking-tight text-ink900 outline-none"
      >
        {props.question}
      </h2>
      {props.children}
    </section>
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
}

/**
 * What has been decided so far, each entry revisitable. Completion is carried by the WORDS on each
 * entry — never by a checkmark hue alone.
 */
export function FlowReceipt({ resolution, stage, payerPick, onChange }: ReceiptProps): React.ReactElement {
  // For a full member id the echo is '' by construction — the receipt shows the READING instead,
  // so the id never reaches the markup and the entry still says what was searched.
  const idLabel = resolution.handle.echo !== '' ? resolution.handle.echo : resolution.handle.readAs;
  const payers = payerGroupsOf(resolution);
  const payerLabel = stage === 'answer' ? resolution.group.payerDisplayName : payerPick;
  const planLabel =
    stage === 'answer' ? (resolution.group.employerLabel ?? 'No plan sponsor on file') : null;
  const entry = 'flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-3 pr-1';
  const change = 'rounded-full px-2 py-0.5 text-xs font-semibold text-teal700 hover:bg-teal50';
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
      <form action={props.action} className="flex w-full max-w-xl flex-col gap-2">
        <label htmlFor="qualify-term" className="text-sm font-medium text-ink900">
          Member ID prefix or full member ID
        </label>
        <div className="flex gap-2">
          <input
            id="qualify-term"
            name="term"
            type="text"
            defaultValue={props.echo}
            autoComplete="off"
            aria-describedby="qualify-term-help"
            className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-base text-ink900 shadow-ths-sm"
          />
          <button
            type="submit"
            disabled={props.pending}
            className="shrink-0 rounded-lg bg-teal700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {props.pending ? 'Looking up…' : 'Find coverage'}
          </button>
        </div>
        <p id="qualify-term-help" className="text-xs text-ink600">
          {props.readAs
            ? `We ${props.readAs}.`
            : 'Three characters is read as a prefix; anything longer as a complete member ID.'}
        </p>
      </form>
    </Stage>
  );
}

// ── Stage 2 · Payer ──────────────────────────────────────────────────────────────────────────────

export function StagePayer(props: {
  resolution: QualifyResolution;
  onPick: (payer: string) => void;
}): React.ReactElement {
  const groups = payerGroupsOf(props.resolution);
  return (
    <Stage id="qualify-s-payer" question="Which carrier is on the card?">
      <p className="text-sm text-ink600">
        <strong className="font-semibold text-ink900">{groups.length} carriers</strong> sit behind what you
        typed. Pick the one on the card in front of you.
      </p>
      <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <li key={g.payer}>
            <button
              type="button"
              data-v3-tile
              onClick={() => props.onPick(g.payer)}
              className="flex w-full flex-col items-start gap-1 rounded-xl border border-line bg-surface p-4 text-left shadow-ths-sm transition-colors hover:border-teal500 hover:bg-teal50"
            >
              <span className="text-base font-semibold text-ink900">{g.payer}</span>
              {g.unmapped ? <span className="text-xs font-semibold text-ink600">Unmapped payer</span> : null}
              <span className="text-xs text-ink600">
                <span className="ths-num" aria-label={`${g.memberCount} verified members under this carrier`}>
                  {g.memberCount.toLocaleString()}
                </span>{' '}
                members ·{' '}
                <span className="ths-num" aria-label={`${g.planCount} plans under this carrier`}>
                  {g.planCount.toLocaleString()}
                </span>{' '}
                {g.planCount === 1 ? 'plan' : 'plans'}
              </span>
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
}): React.ReactElement {
  const all = orderedCandidates(props.resolution);
  const payers = payerGroupsOf(props.resolution);
  const payer = props.payerPick ?? payers[0]?.payer ?? props.resolution.group.payerDisplayName;
  const underPayer = all.filter((c) => c.payerDisplayName === payer);
  // A stale carrier pick after a re-resolve can leave zero plans under it — say that plainly
  // instead of rendering "0 plans" over an empty grid with filter copy that presumes a filter.
  if (underPayer.length === 0) {
    return (
      <Stage id="qualify-s-plan" question="Which plan is it?">
        <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
          No plans are on file under {payer} in this result. Use the receipt above to change the
          carrier or search again.
        </p>
      </Stage>
    );
  }
  const needle = props.planFilter.trim().toLowerCase();
  const visible =
    needle === ''
      ? underPayer
      : underPayer.filter((c) => (c.employerLabel ?? 'no plan sponsor on file').toLowerCase().includes(needle));
  return (
    <Stage id="qualify-s-plan" question="Which plan is it?">
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
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink900"
          />
          <p className="text-xs text-ink600">
            Showing {visible.length} of {underPayer.length} plans.
          </p>
        </div>
      ) : null}
      <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
        {visible.map((c) => (
          <li key={`${c.canonicalPayerId ?? 'unmapped'}-${c.index}`}>
            <form
              action={props.planAction}
              data-v3-tile
              className="flex h-full flex-col gap-1 rounded-xl border border-line bg-surface p-4 shadow-ths-sm"
            >
              <input type="hidden" name="candidate" value={String(c.index)} />
              <span className="text-base font-semibold text-ink900">
                {c.employerLabel ?? 'No plan sponsor on file'}
              </span>
              <span className="text-xs text-ink600">
                {[c.funding ?? 'Funding not captured', c.planType ?? 'Plan type not captured'].join(' · ')}
              </span>
              <span className="text-xs text-ink600">
                <span className="ths-num" aria-label={`${c.memberCount} members on this plan`}>
                  {c.memberCount.toLocaleString()}
                </span>{' '}
                members
              </span>
              {evidenceWord(c.hasClaimEvidence)}
              <span className="mt-2 flex gap-2">
                <button
                  type="submit"
                  disabled={props.pending}
                  className="rounded-lg bg-teal700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  Use this plan
                </button>
                <button
                  type="submit"
                  disabled={props.pending}
                  onClick={props.onAskAi}
                  className="rounded-lg border border-teal200 bg-teal50 px-3 py-1.5 text-sm font-semibold text-teal700 disabled:opacity-60"
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
    <li data-v3-tile className="rounded-xl border border-line bg-surface p-4 shadow-ths-sm">
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
                className="font-display text-3xl font-semibold tracking-tight text-ink900"
                aria-label={`rating ${f.ratingV2} out of 100`}
              >
                {f.ratingV2}
              </span>
              <span className="text-xs font-semibold text-ink600">{f.iqBand ?? ''}</span>
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
  scopeSource: 'user' | 'pick' | 'dominant';
  payerOverride: string | null;
  onPayerOverride: (label: string | null) => void;
  windowDays: QualifyTrailingDays | null;
  onWindowDays: (days: QualifyTrailingDays | null) => void;
}

export function StageAnswer(props: StageAnswerProps): React.ReactElement {
  const { resolution: r, snapshot: snap } = props;
  const g = r.group;
  const policyBits = [
    g.employerLabel ?? 'No plan sponsor on file',
    g.funding ?? 'Funding not captured',
    g.planType ?? 'Plan type not captured',
    g.network ?? 'Network not captured on this VOB',
  ].join(' · ');
  const rating = snap ? derivePolicyRating(snap.facilities) : null;
  return (
    <Stage id="qualify-s-answer" question="Does this payer pay us — and where?">
      {/* The policy identity the user resolved, restated in one line — never re-derived. */}
      <p className="text-sm text-ink900">
        <span className="font-semibold">{g.payerDisplayName}</span>
        <span className="text-ink600"> · {policyBits}</span>
      </p>

      {props.pending || (!snap && !props.snapshotError) ? (
        <p role="status" className="rounded-lg border border-line bg-teal50 p-4 text-sm text-ink600">
          Ranking facilities for this plan…
        </p>
      ) : props.snapshotError ? (
        <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
          The facility ranking could not be loaded. The plan resolution above still stands — try again, or
          change the window.
        </p>
      ) : snap ? (
        <>
          {/* SCOPE HONESTY (review Critical 1). When the pick couldn't be bridged to a claims label
              — no claims history for this plan, or an unmapped payer — the ranking below is the
              identifier's DOMINANT payer, and that must be said in words, not implied by chips. */}
          {props.scopeSource === 'dominant' && snap.resolved && r.candidates.total > 1 ? (
            <p role="status" className="rounded-lg border border-line bg-coral50 p-4 text-sm text-ink900">
              {g.claimEvidence.lines === 0
                ? `This plan has no claims history of its own — the ranking below is this identifier's history under ${snap.resolved.payerName}, not evidence about ${g.payerDisplayName}.`
                : `The ranking below could not be scoped to ${g.payerDisplayName} — it shows this identifier's history under ${snap.resolved.payerName}, its largest payer by volume.`}
            </p>
          ) : null}

          {/* The window decision, DISCLOSED in one line with the override one expander away. */}
          <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3">
            <p className="text-sm text-ink900">{windowSentence(snap, props.windowDays)}</p>
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-teal700">Change the window</summary>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {WINDOW_CHOICES.map((d) => {
                  const active = props.windowDays === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={active}
                      onClick={() => props.onWindowDays(d)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                        active ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600'
                      }`}
                    >
                      {d} days{active ? ' · selected' : ''}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => props.onWindowDays(null)}
                  className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink600"
                >
                  Automatic{props.windowDays === null ? ' · selected' : ''}
                </button>
              </div>
            </details>
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
              <span className="text-xs text-ink600">
                {/* "You picked this" / "your plan pick implies this" / "we defaulted" are three
                    different claims — and a REJECTED override must never render as honoured. */}
                {snap.payerOverridden
                  ? props.scopeSource === 'user'
                    ? 'Your selection.'
                    : 'Scoped to the plan you picked.'
                  : props.scopeSource !== 'dominant'
                    ? 'Could not scope to the picked plan — showing the largest by volume.'
                    : 'Largest by volume — pick another to re-scope.'}
              </span>
            </div>
          ) : null}

          {/* The hero: ONE number, patient-weighted, with its basis stated. */}
          <div className="flex items-center gap-5 rounded-xl border border-line bg-surface p-5 shadow-ths-sm">
            {rating && rating.rating !== null ? (
              <span
                className="font-display text-6xl font-semibold tracking-tight text-ink900"
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
        </>
      ) : null}

      {/* Everything v2 shouted, behind one calm disclosure — present, honest, not competing. */}
      <details className="rounded-lg border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink900">How this was resolved</summary>
        <div className="mt-3 flex flex-col gap-3">
          <ul className="flex list-none flex-col gap-2 p-0">
            {r.notices.map((n) => (
              <li key={n.kind} className="text-sm text-ink900">
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
  /**
   * The "Facilities Heating Up" trend strip, passed as a SLOT (the shell owns its fetch and its
   * marquee hook, so this module stays statically renderable). Rendered on the IDENTIFY stage only:
   * that is the screen the search has not filled yet, and it is what keeps the landing alive instead
   * of the near-empty page the staged rebuild first shipped. On the later stages it would compete
   * with the question being asked, which is the whole point of one-question-per-screen.
   */
  ticker: React.ReactNode;
  answer: Omit<StageAnswerProps, 'resolution'> | null;
}

/**
 * The presentational root: receipt + ONE live region + the active stage. Holds no state and fetches
 * nothing — the shell (`resolution-flow-client.tsx`) owns both, so this renders statically for the
 * I9 assertions.
 */
export function ResolutionStages(props: ResolutionStagesProps): React.ReactElement {
  return (
    <div role="region" aria-labelledby="qualify-v3-flow-heading" className="flex flex-col gap-5">
      <h1 id="qualify-v3-flow-heading" className="font-display text-2xl font-semibold tracking-tight text-ink900">
        Qualify a client
      </h1>

      {/* THE single live region — one, not one per panel; the important sentence must not queue. */}
      <p aria-live="polite" className="sr-only">
        {liveSentenceFor(props.stage, props.resolution, props.reason)}
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
        />
      ) : null}

      {props.stage === 'identify' ? (
        <>
          {props.ticker}
          <StageIdentify
            echo={props.echo}
            readAs={props.resolution ? props.resolution.handle.readAs : null}
            action={props.identifyAction}
            pending={props.pending}
          />
          {!props.resolution && props.reason ? (
            <p role="status" className="max-w-xl rounded-md border border-line bg-teal50 p-4 text-sm text-ink600">
              {UNRESOLVABLE_COPY[props.reason]}
            </p>
          ) : null}
        </>
      ) : null}

      {props.stage === 'payer' && props.resolution ? (
        <StagePayer resolution={props.resolution} onPick={props.onPickPayer} />
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
        />
      ) : null}

      {props.stage === 'answer' && props.resolution && props.answer ? (
        <StageAnswer resolution={props.resolution} {...props.answer} />
      ) : null}
    </div>
  );
}
