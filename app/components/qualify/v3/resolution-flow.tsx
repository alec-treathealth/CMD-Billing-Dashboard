/**
 * Qualify v3 — S0 · S1 · S2, the guided resolution flow.
 *
 * A WALKTHROUGH, NOT A WIZARD: every completed step stays visible and revisitable. The user is never
 * trapped, and they can see what the screen decided on their behalf — which is the whole complaint v3
 * answers ("I'm trying to avoid searching randomness and resolving windows by things that can't be
 * seen").
 *
 * ── A11Y IS ACCEPTANCE CRITERIA HERE, NOT POLISH ────────────────────────────────────────────────
 * Every one of these is asserted in `app/test/qualifyV3Flow.test.tsx` (I9):
 *   · The flow is a landmark (`role="region"` + accessible name); each step is a <section> with an
 *     <h2>, and exposes its completion state as TEXT, not colour.
 *   · ONE aria-live="polite" region, announcing resolution changes as FULL SENTENCES. v2 announced
 *     "1,358 charge lines match" but never announced a resolution change — and that is the event
 *     which invalidates everything else on screen.
 *   · No meaning-bearing text below 12px. v2 shipped 8.5px flank labels and 9.5px values; those are
 *     unreadable for the actual user (a rep on a laptop, mid-call) regardless of what SC 1.4.4 permits.
 *   · Bare numerals get accessible names. A hero "77" in a <span> announces as "77" with no hint that
 *     it is a rating out of 100.
 *   · Every colour-carried state also carries text or shape. Nothing is conveyed by hue alone.
 *   · ONE control per target — v2's card body and its "Why this score" button toggled the same
 *     disclosure, giving one action two tab stops.
 *
 * ── RENDERING MODEL ─────────────────────────────────────────────────────────────────────────────
 * PRESENTATIONAL and server-renderable: it receives a `QualifyResolution` plus a form `action`, holds
 * no state, fetches nothing, and imports no query builder (I1). Every step is a native <form> with
 * native controls, so the keyboard path is the DOM order rather than something a tabindex has to
 * reconstruct.
 *
 * ⚠ THE FORMS POST, THEY DO NOT GET — and that is a correctness requirement, not a style choice. An
 * earlier version of this file used `method="GET" action="/qualify"` with `name="term"`, which puts
 * the typed identifier in the QUERY STRING: browser history, the `Referer` header, edge logs. For a
 * full member ID that is PHI in a URL, violating the standing rule and §S0's explicit requirement
 * that the term never reach the URL. The Server Action posts it in the body instead. Do not "simplify"
 * these back to GET.
 *
 * PHI: the only user-derived string rendered is `resolution.handle.echo`, prefix-only by construction
 * (a full member id echoes as ''), so not even the DOM round-trips an id. `employerLabel` is
 * display-only; `employerKey` is opaque and positional.
 */
import type { CoverageGroupSummary, PanelId, QualifyResolution } from '../../../lib/qualify/resolution';

/** Non-PHI copy for the three states a search can fail in, kept distinct on purpose (I5). */
export const UNRESOLVABLE_COPY: Readonly<Record<'empty' | 'prefix_too_short' | 'no_match', string>> = {
  empty: 'Enter a member ID prefix, a full member ID, or a facility name to begin.',
  prefix_too_short:
    'A prefix needs at least 3 characters to look up. Two characters cannot be matched — this is not the same as finding nothing.',
  no_match: 'That identifier does not match any plan we have coverage or claims for.',
};

/** Shared step chrome. `complete` is announced as TEXT, never as a colour alone. */
function Step(props: {
  id: string;
  n: number;
  title: string;
  complete: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const headingId = `${props.id}-heading`;
  return (
    <section id={props.id} aria-labelledby={headingId} className="rounded-lg border border-line bg-surface p-5 shadow-ths-sm">
      <div className="mb-3 flex items-baseline gap-3">
        {/* The step number is decorative ONLY because the heading text carries the same ordinal. */}
        <span aria-hidden="true" className="ths-num text-sm font-medium text-ink400">
          {props.n}
        </span>
        <h2 id={headingId} className="ths-h text-base font-semibold text-ink900">
          {`Step ${props.n}: ${props.title}`}
        </h2>
        {/* Completion as a WORD. A checkmark glyph or a green dot alone would be colour/shape-only. */}
        <span className="text-xs font-medium text-ink600">{props.complete ? 'Complete' : 'In progress'}</span>
      </div>
      {props.children}
    </section>
  );
}

/** A labelled fact. 12px floor on the label; the value is 14px body. */
function Fact(props: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink400">{props.label}</span>
      <span className="text-sm text-ink900">{props.value}</span>
    </div>
  );
}

function fundingLabel(f: 'Self-Funded' | 'Fully Insured' | null): string {
  return f ?? 'Funding not captured';
}

/** S1 candidate row. Evidence is stated in the sampleGate idiom, and "no history" is said, not implied. */
function CandidateRow(props: {
  index: number;
  chosen: boolean;
  payerDisplayName: string;
  employerLabel: string | null;
  funding: 'Self-Funded' | 'Fully Insured' | null;
  planType: string | null;
  memberCount: number;
  hasClaimEvidence: boolean;
  evidenceNote: string;
}): React.ReactElement {
  const id = `cand-${props.index}`;
  return (
    <li>
      <label
        htmlFor={id}
        className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
          props.chosen ? 'border-teal500 bg-teal50' : 'border-line bg-surface'
        }`}
      >
        {/* ONE control per target: the radio IS the control, and the label wraps it rather than
            adding a second focusable element for the same action. */}
        <input
          id={id}
          type="radio"
          name="candidate"
          value={String(props.index)}
          defaultChecked={props.chosen}
          className="mt-1 h-4 w-4"
        />
        <span className="flex flex-1 flex-col gap-1">
          <span className="text-sm font-semibold text-ink900">{props.payerDisplayName}</span>
          <span className="text-xs text-ink600">
            {[props.employerLabel ?? 'No plan sponsor on file', fundingLabel(props.funding), props.planType ?? 'Plan type not captured'].join(' · ')}
          </span>
          <span className="text-xs text-ink600">
            {/* An accessible name on the numeral — "61" alone tells a screen reader nothing. */}
            <span className="ths-num" aria-label={`${props.memberCount} members on this plan`}>
              {props.memberCount.toLocaleString()}
            </span>{' '}
            members ·{' '}
            {props.hasClaimEvidence ? (
              props.evidenceNote
            ) : (
              // Marked BEFORE selection, per §S1 — so the user never reaches a ranking about nothing.
              <strong className="font-semibold text-ink900">No claim history — a ranking here would have nothing behind it</strong>
            )}
          </span>
        </span>
        {props.chosen ? <span className="text-xs font-semibold text-teal700">Selected</span> : null}
      </label>
    </li>
  );
}

/**
 * The candidate list in RANK order, with each row carrying its original index.
 *
 * ⚠ WHY THIS EXISTS. The chosen row used to be rendered FIRST and the rejected rows after it, which
 * meant the list was ranked only until the user picked something: choose the third candidate and it
 * jumped to the top, so "we have pre-selected the largest" sat above a list whose order no longer
 * expressed size. Re-ordering under a pick also makes the list move when the user acts, which is
 * exactly the "searching randomness" complaint. The rejected summaries arrive in rank order with the
 * chosen one filtered out, so reinserting it at its own index restores the original ranking.
 */
interface OrderedCandidate {
  index: number;
  chosen: boolean;
  canonicalPayerId: string | null;
  payerDisplayName: string;
  employerLabel: string | null;
  funding: 'Self-Funded' | 'Fully Insured' | null;
  planType: string | null;
  memberCount: number;
  hasClaimEvidence: boolean;
  evidenceNote: string;
}

function orderedCandidates(r: QualifyResolution): OrderedCandidate[] {
  const chosenIdx = r.candidates.chosenIndex;
  const out: OrderedCandidate[] = r.candidates.rejected.map((s: CoverageGroupSummary, i: number) => ({
    // The inverse of `groups.filter((_, i) => i !== chosenIndex)`: every rejected row at or past the
    // chosen position shifts up by one in the filtered array, so add it back.
    index: i + (i >= chosenIdx ? 1 : 0),
    chosen: false,
    canonicalPayerId: s.canonicalPayerId,
    payerDisplayName: s.payerDisplayName,
    employerLabel: s.employerLabel,
    funding: s.funding,
    planType: s.planType,
    memberCount: s.memberCount,
    hasClaimEvidence: s.hasClaimEvidence,
    evidenceNote: 'has claim history',
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
    evidenceNote: evidenceNoteFor(r),
  });
  return out.sort((a, b) => a.index - b.index);
}

export interface ResolutionFlowProps {
  resolution: QualifyResolution | null;
  /** Set when `resolution` is null — the three states stay distinct (I5). */
  reason: 'empty' | 'prefix_too_short' | 'no_match' | null;
  /** The term currently in the box. Prefix-safe: callers pass `handle.echo`, never a full member id. */
  echo: string;
  /** The original term, retained only in action state and submitted via POST for later steps. */
  term?: string;
  /**
   * The Server Action every step submits to. Required — there is no URL fallback ON PURPOSE, because a
   * fallback would be a GET and would put the term back in the query string.
   */
  action: (formData: FormData) => void | Promise<void>;
  /** A gate denial, stated rather than rendered as an empty result. */
  denied?: string | null;
}

export function ResolutionFlow({ resolution, reason, echo, term = echo, action, denied }: ResolutionFlowProps): React.ReactElement {
  const step1Complete = resolution !== null;
  const step2Complete = resolution !== null && !resolution.candidates.wasAmbiguous;
  const step3Complete = resolution?.window.frozen ?? false;

  return (
    <div role="region" aria-labelledby="qualify-v3-flow-heading" className="flex flex-col gap-4">
      <h1 id="qualify-v3-flow-heading" className="font-display text-2xl font-semibold tracking-tight text-ink900">
        Qualify a client
      </h1>

      {/*
        THE SINGLE live region. One, not one per panel: multiple polite regions on a page queue
        unpredictably and the important sentence loses. It announces the RESOLUTION as a sentence —
        v2 announced only a count, and never announced the resolution change that invalidates the
        rest of the screen.
      */}
      <p aria-live="polite" className="sr-only">
        {resolution
          ? `Resolved: ${resolution.group.payerDisplayName}` +
            (resolution.group.employerLabel ? ` · ${resolution.group.employerLabel}` : '') +
            (resolution.group.funding ? ` · ${resolution.group.funding}` : '') +
            `. ${resolution.group.claimEvidence.distinctFacilities} facilities, ` +
            `${resolution.window.from} to ${resolution.window.to}. ` +
            (resolution.candidates.wasAmbiguous
              ? `${resolution.candidates.total} plans matched; this one is selected.`
              : 'Only one plan matched.')
          : reason
            ? UNRESOLVABLE_COPY[reason]
            : ''}
      </p>

      {/* ── S0 ─────────────────────────────────────────────────────────────────────────────────── */}
      <Step id="qualify-s0" n={1} title="Who are we looking at?" complete={step1Complete}>
        <form action={action} className="flex flex-col gap-2">
          <label htmlFor="qualify-term" className="text-sm font-medium text-ink900">
            Member ID prefix, full member ID, or facility name
          </label>
          <input
            id="qualify-term"
            name="term"
            type="text"
            defaultValue={echo}
            autoComplete="off"
            aria-describedby="qualify-term-help"
            className="w-full max-w-md rounded-md border border-line px-3 py-2 text-sm text-ink900"
          />
          <p id="qualify-term-help" className="text-xs text-ink600">
            {resolution
              ? `We ${resolution.handle.readAs}.`
              : 'Three characters is read as a prefix; anything longer as a complete member ID.'}
          </p>
          <button type="submit" className="w-fit rounded-md bg-teal700 px-4 py-2 text-sm font-semibold text-white">
            Find coverage
          </button>
        </form>
      </Step>

      {/* A gate denial is its own state — never an empty result, which would read as "nothing found". */}
      {denied ? (
        <p role="status" className="rounded-md border border-line bg-teal50 p-4 text-sm text-ink900">
          {denied}
        </p>
      ) : null}

      {/* ── The three distinct not-resolved states ─────────────────────────────────────────────── */}
      {!resolution && reason ? (
        <p role="status" className="rounded-md border border-line bg-teal50 p-4 text-sm text-ink600">
          {UNRESOLVABLE_COPY[reason]}
        </p>
      ) : null}

      {resolution ? (
        <>
          {/* ── S1 ─────────────────────────────────────────────────────────────────────────────── */}
          <Step id="qualify-s1" n={2} title="Which plan is this?" complete={step2Complete}>
            {resolution.candidates.wasAmbiguous ? (
              <p className="mb-3 text-sm text-ink900">
                <strong className="font-semibold">
                  {resolution.candidates.total} plans match what you typed.
                </strong>{' '}
                Pick the one on the card in front of you — we have pre-selected the largest, but that is a
                guess, not an answer.
              </p>
            ) : (
              <p className="mb-3 text-sm text-ink600">
                Only one plan matched what you typed, so it was selected for you.
              </p>
            )}
            <form action={action}>
              <input type="hidden" name="term" value={term} />
              <ul className="flex list-none flex-col gap-2 p-0">
                {orderedCandidates(resolution).map((c) => (
                  <CandidateRow
                    key={`${c.canonicalPayerId ?? 'unmapped'}-${c.index}`}
                    index={c.index}
                    chosen={c.chosen}
                    payerDisplayName={c.payerDisplayName}
                    employerLabel={c.employerLabel}
                    funding={c.funding}
                    planType={c.planType}
                    memberCount={c.memberCount}
                    hasClaimEvidence={c.hasClaimEvidence}
                    evidenceNote={c.evidenceNote}
                  />
                ))}
              </ul>
              {resolution.candidates.total > 1 ? (
                <button type="submit" className="mt-3 w-fit rounded-md bg-teal700 px-4 py-2 text-sm font-semibold text-white">
                  Use this plan
                </button>
              ) : null}
            </form>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="sr-only">Payer</dt>
                <dd>
                  <Fact label="Payer" value={resolution.group.payerDisplayName} />
                </dd>
              </div>
              <div>
                <dt className="sr-only">Plan sponsor</dt>
                <dd>
                  <Fact label="Plan sponsor" value={resolution.group.employerLabel ?? 'Not on file'} />
                </dd>
              </div>
              <div>
                <dt className="sr-only">Funding</dt>
                <dd>
                  <Fact label="Funding" value={fundingLabel(resolution.group.funding)} />
                </dd>
              </div>
              <div>
                <dt className="sr-only">Network</dt>
                <dd>
                  {/* The VOB gap, stated rather than left blank. */}
                  <Fact label="Network" value={resolution.group.network ?? 'Not captured on this VOB'} />
                </dd>
              </div>
            </dl>
          </Step>

          {/* ── S2 ─────────────────────────────────────────────────────────────────────────────── */}
          <Step id="qualify-s2" n={3} title="How far back should we look?" complete={step3Complete}>
            {resolution.window.ladder ? (
              <>
                <p className="mb-3 text-sm text-ink900">{resolution.window.ladder.rationale}</p>
                <form action={action}>
                  <input type="hidden" name="term" value={term} />
                  <fieldset className="border-0 p-0">
                    <legend className="mb-2 text-sm font-medium text-ink900">Window</legend>
                    <ul className="flex list-none flex-col gap-2 p-0">
                      {resolution.window.ladder.rungs.map((rung) => {
                        const id = `rung-${rung.days}`;
                        const proposed = rung.days === resolution.window.ladder?.proposedDays;
                        return (
                          <li key={rung.days}>
                            <label htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-md border border-line p-3">
                              <input
                                id={id}
                                type="radio"
                                name="windowDays"
                                value={String(rung.days)}
                                defaultChecked={proposed}
                                className="h-4 w-4"
                              />
                              <span className="text-sm text-ink900">{rung.label}</span>
                              <span className="text-xs text-ink600">
                                <span className="ths-num" aria-label={`${rung.members} members in a ${rung.days} day window`}>
                                  {rung.members.toLocaleString()}
                                </span>{' '}
                                members ·{' '}
                                <span className="ths-num" aria-label={`${rung.lines} charge lines`}>
                                  {rung.lines.toLocaleString()}
                                </span>{' '}
                                charge lines
                              </span>
                              {/* "Proposed" as a WORD, not just a highlighted border. */}
                              {proposed ? <span className="text-xs font-semibold text-teal700">Proposed</span> : null}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                  <button type="submit" className="mt-3 w-fit rounded-md bg-teal700 px-4 py-2 text-sm font-semibold text-white">
                    Confirm window
                  </button>
                </form>
              </>
            ) : (
              <p className="text-sm text-ink600">
                No window proposal is available for this plan, so the window stays as you set it:{' '}
                {resolution.window.from} to {resolution.window.to}.
              </p>
            )}
            <p className="mt-3 text-xs text-ink600">
              {resolution.window.frozen
                ? 'The window is fixed for these results and will only change if you change it.'
                : 'Confirming sets the window for every panel below.'}
            </p>
          </Step>

          {/* ── Notices: the things v2 left the user to infer ──────────────────────────────────── */}
          {resolution.notices.length > 0 ? (
            <section aria-labelledby="qualify-notices-heading" className="rounded-lg border border-line bg-surface p-5">
              <h2 id="qualify-notices-heading" className="ths-h mb-2 text-base font-semibold text-ink900">
                What to know about this result
              </h2>
              <ul className="flex list-none flex-col gap-2 p-0">
                {resolution.notices.map((n) => (
                  <li key={n.kind} className="text-sm text-ink900">
                    {/* Severity as a WORD as well as a colour. */}
                    <span className="mr-2 text-xs font-semibold uppercase text-ink600">
                      {n.severity === 'caution' ? 'Caution' : 'Note'}
                    </span>
                    {n.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ── Provenance: every panel names the subset it used (§5c) ─────────────────────────── */}
          <section aria-labelledby="qualify-provenance-heading" className="rounded-lg border border-line bg-surface p-5">
            <h2 id="qualify-provenance-heading" className="ths-h mb-2 text-base font-semibold text-ink900">
              What each panel is built on
            </h2>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(Object.keys(resolution.provenance) as PanelId[]).map((panel) => (
                <div key={panel} className="flex flex-col">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink400">{PANEL_LABELS[panel]}</dt>
                  <dd className="text-sm text-ink900">{resolution.provenance[panel]}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-ink600">
              Predicate <span className="ths-num">{resolution.predicateId}</span> — panels showing the same
              value are about the same rows.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

const PANEL_LABELS: Readonly<Record<PanelId, string>> = {
  kpis: 'KPI tiles',
  ranking: 'Facility ranking',
  policy: 'Policy card',
  ladder: 'Window ladder',
  trend: 'Trend',
  ai: 'AI explainer',
};

/** Evidence phrased in the sampleGate idiom, so the badge never promises a ranking the gate suppresses. */
function evidenceNoteFor(r: QualifyResolution): string {
  const e = r.group.claimEvidence;
  if (e.lines === 0) return 'no claim history';
  if (e.sampleTier === 'insufficient') {
    return `${e.distinctPatients} patient${e.distinctPatients === 1 ? '' : 's'} of history — too few to rate`;
  }
  if (e.sampleTier === 'thin') return `${e.distinctPatients} patients of history — thin`;
  return `${e.distinctPatients} patients across ${e.distinctFacilities} facilities`;
}
