'use client';

/**
 * "WHY IS THIS MOVING?" — the streamed explanation behind ONE ticker card.
 *
 * Alec, 2026-08-09: *"If a user clicks on any one of the tickers, they should be able to receive an
 * AI response that explains the meaning behind why the ticker has the rating that it has, using the
 * data it has on hand."* One component for BOTH strips: the policy tape and the facility momentum
 * strip differ in what they send (`tickerAiPayload.ts`), not in how the answer is read.
 *
 * SAME PIPELINE AS EVERY OTHER AI SURFACE HERE — `generateQualifyAiExplanation` → the strict-zod PHI
 * firewall → the Qualify principal gate → a durable audit BEFORE the first token → the streamed
 * answer → the blind-role dollar scrub. Nothing about this path is new; only the input shape and the
 * question are. Deliberately NOT a second transport.
 *
 * ⚠ IT RENDERS BELOW THE STRIP, NOT OVER IT. A dialog would trap focus on a page whose primary
 * control is the search box directly beneath, and would hide the very card the answer is about. This
 * is an inline panel: the card stays visible and pressed, the marquee is force-paused while it is
 * open (the strip must not scroll the subject away mid-sentence), and Escape / the close button
 * return focus to where it was.
 *
 * PHI: nothing identifying crosses. The panel's own HEADING may name the policy's alpha prefix,
 * because the operator is looking at it on the card — but that string never enters the payload; see
 * tickerAiPayload.ts's header for the boundary and where an edit would be tempted to break it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { generateQualifyAiExplanation } from '@/lib/qualify/ai-actions';
import { parseAiSections } from '../../../src/collections/aiAnalysis';
import { Markdown } from '../ui/markdown';
import type { QualifyTickerAiInput } from '../../lib/qualify/tickerAiPayload';

export function TickerExplainer({
  title,
  subtitle,
  input,
  onClose,
}: {
  /** What the operator clicked, in their words — e.g. "GGS · AETNA US HEALTHCARE". */
  title: string;
  /** The numbers being explained, restated so the answer is readable without the card in view. */
  subtitle: string;
  /** Built by `buildTapeAiInput` / `buildTrendAiInput`. A NEW object identity re-runs the ask, which
   *  is what makes clicking a second card replace the answer rather than append to it. */
  input: QualifyTickerAiInput;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Unmount mid-stream must CANCEL the server stream, not merely stop reading it: an abandoned
  // stream keeps the model call — and the billing — running to completion.
  useEffect(() => () => void readerRef.current?.cancel(), []);

  const run = useCallback(async (payload: QualifyTickerAiInput) => {
    const gen = ++genRef.current;
    setText('');
    setError(null);
    setStreaming(true);
    try {
      const res = await generateQualifyAiExplanation(payload);
      if (genRef.current !== gen) {
        // Superseded while the action was still resolving (gate + audit + first token is 1-3s).
        if (res.ok) void res.stream.cancel();
        return;
      }
      if (!res.ok) {
        setStreaming(false);
        setError(
          res.reason === 'insufficient'
            ? 'There is not enough behind this card to explain it.'
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
          void reader.cancel();
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
  }, []);

  // One ask per card. `input` identity changes when a different card is clicked, which supersedes the
  // in-flight generation through genRef rather than racing two streams into one state.
  useEffect(() => {
    void run(input);
  }, [input, run]);

  // Focus the close button on open (the answer streams in below it, so this is the stable anchor)
  // and let Escape dismiss. NOT a focus trap — see the header for why this is not a dialog.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sections = parseAiSections(text);
  const caret = streaming ? (
    <span aria-hidden className="q-ai-caret ml-0.5 inline-block h-[13px] w-[7px] bg-teal500 align-[-2px]" />
  ) : null;

  return (
    <section
      aria-label={`Why this is moving: ${title}`}
      className="mt-2 overflow-hidden rounded-xl border border-line bg-card shadow-ths-sm"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-gradient-to-b from-teal50 to-surface px-4 py-2.5">
        <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-teal700 text-[13px] text-white">
          ✦
        </span>
        <h3 className="font-head text-[15px] font-semibold tracking-tight text-ink900">{title}</h3>
        <span className="text-xs text-ink400">{subtitle}</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="ml-auto rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink600 transition-colors hover:border-teal200 hover:text-teal700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
        >
          Close
        </button>
      </div>

      <div className="px-4 py-3">
        {error ? (
          <p className="rounded-xl border border-dashed border-line bg-ground px-3 py-2.5 text-[12.5px] text-status-danger">
            {error}
          </p>
        ) : (
          /* NOT a live region: aria-live here would re-announce the growing answer token by token and
             compete with the flow's single stage announcer. The sr-only status announces ONCE, on
             completion — the event a non-sighted reader can act on. (The qualify AI panel's ruling,
             applied identically.) */
          <div className="rounded-xl border border-line bg-ground px-4 py-3">
            <p role="status" className="sr-only">
              {!streaming && text ? 'Explanation ready.' : ''}
            </p>
            <div className="font-mono text-xs font-semibold uppercase tracking-wide text-teal700">TL;DR</div>
            <div className="mt-1 text-[13.5px] leading-relaxed text-ink900">
              {sections['TL;DR'] ? (
                <Markdown text={sections['TL;DR']} />
              ) : streaming && !text ? (
                <p>Reading the numbers…</p>
              ) : null}
              {sections.Signals === '' && sections.Risks === '' ? caret : null}
            </div>
            {sections.Signals ? (
              <div className="mt-3 border-t border-line pt-2.5">
                <div className="font-mono text-xs font-semibold uppercase tracking-wide text-status-ok">Signals</div>
                <div className="mt-1 text-[13px] leading-relaxed text-ink900">
                  <Markdown text={sections.Signals} />
                  {sections.Risks === '' ? caret : null}
                </div>
              </div>
            ) : null}
            {sections.Risks ? (
              <div className="mt-3 border-t border-line pt-2.5">
                <div className="font-mono text-xs font-semibold uppercase tracking-wide text-status-danger">Risks</div>
                <div className="mt-1 text-[13px] leading-relaxed text-ink900">
                  <Markdown text={sections.Risks} />
                  {caret}
                </div>
              </div>
            ) : null}
            {!streaming && text ? (
              <p className="mt-3 border-t border-dashed border-line pt-2 text-xs text-ink400">
                Read from this card's own aggregates · a move at this sample size is not a trend ·
                verify benefits on the case before quoting anything.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
