'use client';

/**
 * "Ask about this policy" — the Qualify AI explainer panel (Phase H). Preset chips (never a
 * free-text box), a word-by-word streamed answer in three labeled sections (TL;DR / Signals /
 * Risks), a blinking caret while streaming. The input is assembled HERE from the snapshot the
 * user is already looking at — aggregates only; the server re-validates through the zod firewall
 * (zero dollar fields for every role) and re-derives the blind flag from the principal.
 *
 * Chips are DERIVED, not fixed (2026-08-04, the v2 mockup's chipsFor port): aiChips.ts conditions
 * every candidate on what this search actually returned and flags the one most worth asking
 * ("suggested" — teal ✦ + soft border until a question is running). While an answer streams, a
 * sentinel keeps the panel's bottom edge in view (scrollIntoView 'nearest' — instant, so the
 * global prefers-reduced-motion reset needs no per-component opt-out).
 */
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { generateQualifyAiExplanation } from '@/lib/qualify/ai-actions';
import { parseAiSections } from '../../../src/collections/aiAnalysis';
import type { QualifySnapshot } from '../../lib/qualify/contract';
import { qualifyAiChips, type QualifyAiChipId } from '../../lib/qualify/aiChips';
import { deriveTopRanks, qualifyRanksHeading } from '../../lib/qualify/policyRating';
// The payload MAP lives in a pure module so it can be tested — see aiPayload.ts for why that is not
// a tidying preference (an untested optional field silently stopped reaching the model once).
import { buildQualifyAiInput } from '../../lib/qualify/aiPayload';
// The scope claim's ONE home — see scopeLabel.ts for why it does not live in this file.
import { aiScopeLabel } from '../../lib/qualify/scopeLabel';
import { IQ_BAND_HEX } from './tokens';

type ChipId = QualifyAiChipId;

export function QualifyAiPanel({
  snapshot,
  blind,
  autoAsk = false,
  onAutoAsked,
  bookPlacement = 'none',
}: {
  snapshot: QualifySnapshot;
  blind: boolean;
  /** v3 plan-tile drill-down: run the SUGGESTED chip once, unprompted, when the panel arrives. The
   *  suggestion derives from this snapshot (aiChips), so the auto-question is grounded in what the
   *  search actually returned — a self-funded plan opens with the plan-administrator question, etc.
   *  Same run() path as a click: gate, audit and PHI firewall are identical. */
  autoAsk?: boolean;
  /** Called the moment autoAsk is consumed, so the OWNER disarms it. Without this, a re-scope that
   *  unmounts and remounts the panel (v3 nulls the snapshot on every window/payer change) resets the
   *  per-mount guard and re-fires an unrequested, audited, billed model call. One ask per arm. */
  onAutoAsked?: () => void;
  /**
   * WHERE THE PAYER'S WHOLE BOOK IS DRAWN, relative to this panel (S2, extended by S3 2026-08-08).
   *
   * The payload is `snap.facilities.slice(0, 10)` — the identifier's OWN ranking — in every mode, so
   * with a book anywhere on screen "the exact numbers on this screen" no longer identifies which list
   * the model read. THREE states, because the honest sentence differs in each:
   *
   *   'none'      — no book drawn. The caption is byte-identical to the pre-S2 one.
   *   'secondary' — the book sits BELOW the member ranking (the 2-9 and 10+ buckets). The model read
   *                 the list above.
   *   'leading'   — the book IS the ranked grid and the member's footprint is a MARK on its rows (one
   *                 member; S3's flip). The model read the member's own history, which is no longer a
   *                 grid at all — so "the ranking above" would point at the one list it never saw.
   *
   * ⚠ AN EXPLICIT PROP, NOT DERIVED FROM `snapshot`. `bookFacilities` is on the wire for every caller
   * of the direct core, INCLUDING the v2 tab, which renders no book section — deriving the caption
   * from the data would make the v2 panel disclaim a list that is not there. Only the surface knows
   * what it drew. Defaults 'none', so v2 and every existing caller stay byte-identical.
   *
   * ⚠ AND AN ENUM RATHER THAN TWO BOOLEANS, on purpose: `bookOnScreen && bookLeads` is a pair that a
   * call site can set to an impossible combination, and this caption is precisely the surface where
   * an impossible combination renders as a confident sentence.
   */
  bookPlacement?: 'none' | 'secondary' | 'leading';
}) {
  const [active, setActive] = useState<ChipId | null>(null);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const followRef = useRef<HTMLDivElement | null>(null);
  // Unmount mid-stream must cancel the server stream (bounded waste otherwise, but still waste).
  useEffect(() => () => { void readerRef.current?.cancel(); }, []);
  // Auto-scroll-follow: as the streamed answer grows, keep its bottom edge in view. scrollIntoView
  // 'nearest' nudges the nearest scrollable ancestor minimally (no jump when already visible) and
  // is instant, not smooth — so prefers-reduced-motion needs nothing beyond the global reset.
  // Gated on `streaming`: once the answer is done, the panel stops steering the scroll position.
  // ALSO gated on the reader still being near the tail: following unconditionally scroll-LOCKS a
  // reader who scrolled up to re-read an earlier bullet, because the next delta yanks them back.
  useEffect(() => {
    if (!streaming || !text) return;
    const el = followRef.current;
    if (!el) return;
    const { top } = el.getBoundingClientRect();
    if (top <= window.innerHeight + 200) el.scrollIntoView({ block: 'nearest' });
  }, [streaming, text]);

  // A NEW SEARCH INVALIDATES THE OLD ANSWER (review). `ranks` re-derives off the new snapshot while
  // `text`/`active` were only reset inside run(), so the previous payer's prose sat above a freshly
  // re-derived table — an authoritative-looking numeric table under reasoning about a different
  // policy. Supersede the in-flight generation too, so a landing stream cannot repopulate it.
  useEffect(() => {
    genRef.current += 1;
    void readerRef.current?.cancel();
    readerRef.current = null;
    setActive(null);
    setText('');
    setError(null);
    setStreaming(false);
  }, [snapshot]);

  const { chips, suggestedId } = useMemo(() => qualifyAiChips(snapshot), [snapshot]);
  const ranks = useMemo(() => deriveTopRanks(snapshot.facilities), [snapshot.facilities]);

  const run = useCallback(
    async (id: ChipId) => {
      const gen = ++genRef.current;
      setActive(id);
      setText('');
      setError(null);
      setStreaming(true);
      try {
        const res = await generateQualifyAiExplanation(buildQualifyAiInput(id, snapshot, blind));
        if (genRef.current !== gen) {
          // Superseded while the action was still resolving (gate + audit + first token is 1-3s).
          // Cancel rather than drop it: an unread stream keeps the model call — and the billing —
          // running to completion, and the in-loop supersede path below already cancels.
          if (res.ok) void res.stream.cancel();
          return;
        }
        if (!res.ok) {
          setStreaming(false);
          setError(
            res.reason === 'insufficient'
              ? 'Nothing to explain yet — resolve a policy or payer first.'
              : 'The explainer is unavailable right now.',
          );
          return;
        }
        const reader = res.stream.getReader();
        readerRef.current = reader;
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (genRef.current !== gen) {
            void reader.cancel(); // superseded question — stop the server stream, don't just abandon it
            return;
          }
          if (done) break;
          acc += value;
          setText(acc);
        }
        readerRef.current = null;
        setStreaming(false);
      } catch {
        if (genRef.current !== gen) return;
        setStreaming(false);
        setError('The explainer is unavailable right now.');
      }
    },
    [snapshot, blind],
  );

  // The auto-ask fires ONCE per ARM, after the reset effect above (declaration order), and only
  // while nothing has run yet — a user who already clicked a chip is never interrupted. The ref
  // guards this mount; onAutoAsked disarms the owner so a REMOUNT cannot fire again (Critical 2:
  // v3 unmounts this panel on every re-scope, and a per-mount guard alone re-fires on arrival).
  const autoAskedRef = useRef(false);
  useEffect(() => {
    if (!autoAsk || autoAskedRef.current || active !== null) return;
    autoAskedRef.current = true;
    onAutoAsked?.();
    void run(suggestedId);
  }, [autoAsk, active, run, suggestedId, onAutoAsked]);

  const sections = parseAiSections(text);
  const caret = streaming ? <span aria-hidden className="q-ai-caret ml-0.5 inline-block h-[13px] w-[7px] bg-teal500 align-[-2px]" /> : null;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-ths-sm" data-testid="qualify-ai-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-gradient-to-b from-teal50 to-surface px-4 py-2.5">
        <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-teal700 text-[13px] text-white">✦</span>
        <h2 className="font-head text-[15px] font-semibold tracking-tight">Ask about this policy</h2>
        {/* The scope this panel answers over. `?? carrier ?? 'This search'` alone would print the VOB
            CARRIER over an all-payers ranking — a narrower claim than the data — so all-payers gets
            its own words rather than falling through the chain. */}
        <span className="text-xs text-muted-foreground">
          {aiScopeLabel(snapshot)} · aggregates only
          {blind ? ' · amounts withheld for this role' : ''}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {chips.map((chip) => {
          // The suggestion is a resting-state nudge only — it clears the moment any chip runs.
          const suggested = chip.id === suggestedId && active === null;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => run(chip.id)}
              aria-pressed={active === chip.id}
              className={[
                'rounded-xl border px-3 py-2 text-left text-[12.5px] font-semibold leading-snug transition-colors',
                active === chip.id
                  ? 'border-teal500 bg-teal50 text-teal700'
                  : suggested
                    ? 'border-teal200 bg-teal50 text-ink600 hover:text-teal700'
                    : 'border-line bg-surface text-ink600 hover:border-teal200 hover:text-teal700',
              ].join(' ')}
            >
              {suggested ? (
                <span aria-hidden className="mr-1.5 text-teal500">
                  ✦
                </span>
              ) : null}
              {chip.label}
            </button>
          );
        })}
      </div>

      {active === null ? (
        <p className="px-4 pb-3.5 text-[12px] leading-relaxed text-muted-foreground">
          {/* "ON THIS SCREEN" IDENTIFIES NOTHING ONCE TWO RANKINGS ARE ON IT (S2), AND "THE RANKING
              ABOVE" STOPS BEING THE MEMBER'S ONCE THE BOOK LEADS (S3). The payload is the first ten
              of `snapshot.facilities` — the identifier's own ranking — in every mode; the payer's book
              is never mapped into it (a book payload is a schema + prompt + firewall change and a
              separate ruling). So the caption names the list the model actually read, by POSITION.
              With no book drawn (v2, and any v3 answer without one) the string is byte-identical to
              what shipped. */}
          {bookPlacement === 'leading'
            ? "Preset questions only — each streams a short read grounded in the exact numbers in this member's own history, not the whole-book ranking above. Nothing here is a guarantee of payment."
            : bookPlacement === 'secondary'
              ? 'Preset questions only — each streams a short read grounded in the exact numbers in the ranking above, not the whole-book list below. Nothing here is a guarantee of payment.'
              : 'Preset questions only — each streams a short read grounded in the exact numbers on this screen. Nothing here is a guarantee of payment.'}
        </p>
      ) : (
        <div className="px-4 pb-4">
          {error ? (
            <p className="rounded-xl border border-dashed border-line bg-ground px-3 py-2.5 text-[12.5px] text-status-danger">{error}</p>
          ) : (
            /* NOT a live region (review): aria-live on the streaming container re-announced the
               growing answer token-by-token and competed with the flow's single stage announcer —
               "the important sentence must not queue". The sr-only status below announces ONCE, on
               completion, which is the event a non-sighted user can act on. */
            <div className="rounded-xl border border-line bg-ground px-4 py-3">
              <p role="status" className="sr-only">
                {!streaming && text ? 'Answer ready.' : ''}
              </p>
              <div className="font-mono text-xs font-semibold uppercase tracking-wide text-teal700">TL;DR</div>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink900">
                {sections['TL;DR'] || (streaming && !text ? 'Reading the numbers…' : sections['TL;DR'])}
                {sections.Signals === '' && sections.Risks === '' ? caret : null}
              </p>
              {sections.Signals ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="font-mono text-xs font-semibold uppercase tracking-wide text-status-ok">Signals</div>
                  <div className="prose-sm mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink900">
                    {sections.Signals}
                    {sections.Risks === '' ? caret : null}
                  </div>
                </div>
              ) : null}
              {sections.Risks ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="font-mono text-xs font-semibold uppercase tracking-wide text-status-danger">Risks</div>
                  <div className="prose-sm mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink900">
                    {sections.Risks}
                    {caret}
                  </div>
                </div>
              ) : null}
              {/* RANKS TABLE — shown when the answer IS a ranking, once the stream finishes. Derived
                  from the snapshot rather than parsed from the prose: the model writes the reasoning,
                  the numbers stay ours.

                  ⚠ IT CAN DISAGREE WITH THE GRID, and the previous comment here flatly denied it
                  ("this can never disagree with the cards or the bar"). Since the availability tier
                  landed at the head of the grid's comparator, this table — which sorts by ratingV2
                  alone — can lead with a facility the grid ranked second, so one facility wears a
                  "2" on its card and a "1" here, on the same screen, under prose that says it is
                  full. Fixed by DISCLOSURE rather than by re-sorting: this answers "which pays
                  best", a rating question, and re-ordering it on beds would delete the only reading
                  on screen that answers it. The heading states the basis (qualifyRanksHeading) and
                  a full row says so on its own line. The bare ordinal was REMOVED — it was the
                  colliding number, and the rows are already in order with their rating beside them. */}
              {!streaming && text && active === 'ranks' && ranks.length > 1 ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="font-mono text-xs font-semibold uppercase tracking-wide text-teal700">
                    {qualifyRanksHeading(ranks, aiScopeLabel(snapshot, 'lower'))}
                  </div>
                  <div className="mt-2 flex flex-col">
                    {ranks.map((r) => (
                      <div
                        key={r.facilityKey}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-surface"
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate text-[13px] font-semibold text-ink900" title={r.name}>
                            {r.name}
                          </span>
                          {/* The placement caveat, ON the row that needs it. A strip that ranks by
                              money must not let a house with no bed read as a recommendation. */}
                          {r.bedState === 'full' ? (
                            <span
                              className="shrink-0 rounded-full border border-status-warn/40 bg-status-warn/10 px-1.5 py-0.5 text-xs font-semibold text-ink900"
                              title="No open beds on the latest census — this facility pays well but cannot admit anyone today"
                            >
                              Full
                            </span>
                          ) : null}
                        </span>
                        <span className="whitespace-nowrap text-xs text-ink400">{r.evidence}</span>
                        <span
                          className="min-w-[34px] text-right font-mono text-[14px] font-semibold tabular-nums"
                          style={{ color: IQ_BAND_HEX[r.band] }}
                        >
                          {r.rating}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {!streaming && text ? (
                <p className="mt-3 border-t border-dashed border-line pt-2 text-xs text-ink400">
                  Grounded in the factors above · window {snapshot.ladder?.chosenDays ?? '—'}d · verify benefits on the
                  case before quoting anything.
                </p>
              ) : null}
              <div ref={followRef} aria-hidden className="h-px scroll-mb-4" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
