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
import type { QualifyAiInput } from '../../../src/collections/qualifyAi';
import type { QualifySnapshot } from '../../lib/qualify/contract';
import { qualifyAiChips, type QualifyAiChipId } from '../../lib/qualify/aiChips';
import { deriveTopRanks } from '../../lib/qualify/policyRating';
import { IQ_BAND_HEX } from './tokens';

type ChipId = QualifyAiChipId;

function buildInput(question: ChipId, snap: QualifySnapshot, blind: boolean): QualifyAiInput {
  return {
    question,
    payerName: snap.resolved?.payerName ?? null,
    policy: snap.policy?.found
      ? {
          carrier: snap.policy.carrier,
          funding: snap.policy.funding,
          policyType: snap.policy.policyType,
          planType: snap.policy.planType,
          network: snap.policy.network,
          memberCount: snap.policy.memberCount,
          vobStale: snap.policy.vobStale,
        }
      : null,
    provenance: snap.provenance,
    windowDays: snap.ladder?.chosenDays ?? 90,
    windowSufficient: snap.ladder?.sufficient ?? true,
    facilities: snap.facilities.slice(0, 10).map((f) => ({
      name: f.name,
      careSetting: f.careSetting,
      ratingV2: f.ratingV2,
      iqBand: f.iqBand,
      pctAllowedOfBilled: f.pctAllowedOfBilled,
      distinctPatients: f.distinctPatients,
      lineCount: f.lineCount,
      medianDaysToPayment: f.medianDaysToPayment,
      factors: f.factors.map((x) => ({
        key: x.key,
        label: x.label,
        weight: x.weight,
        score: x.score,
        available: x.available,
        direction: x.direction,
        detail: x.detail.slice(0, 300),
      })),
    })),
    amountsBlind: blind,
  };
}

export function QualifyAiPanel({
  snapshot,
  blind,
  autoAsk = false,
  onAutoAsked,
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
        const res = await generateQualifyAiExplanation(buildInput(id, snapshot, blind));
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
        <span className="text-xs text-muted-foreground">
          {snapshot.resolved?.payerName ?? snapshot.policy?.carrier ?? 'This search'} · aggregates only
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
          Preset questions only — each streams a short read grounded in the exact numbers on this screen. Nothing here
          is a guarantee of payment.
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
                  the numbers stay ours, so this can never disagree with the cards or the bar. */}
              {!streaming && text && active === 'ranks' && ranks.length > 1 ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="font-mono text-xs font-semibold uppercase tracking-wide text-teal700">
                    Top {ranks.length} facilities · {snapshot.resolved?.payerName ?? snapshot.policy?.carrier ?? 'this search'}
                  </div>
                  <div className="mt-2 flex flex-col">
                    {ranks.map((r) => (
                      <div
                        key={r.facilityKey}
                        className="grid grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-surface"
                      >
                        <span className="font-mono text-xs font-semibold text-ink400">{r.rank}</span>
                        <span className="truncate text-[13px] font-semibold text-ink900" title={r.name}>
                          {r.name}
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
