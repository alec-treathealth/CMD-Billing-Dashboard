'use client';

/**
 * The Cohort Read panel — the AI analysis that REPLACES the cohort visit/day tables as the
 * default view; the underlying aggregate tables stay behind "Show underlying data".
 *
 * The server action returns a PARSED fixed shape (TLDR · 3 signals · BASIS) or a typed failure —
 * raw model text never reaches this component, so a malformed response renders a RETRY state by
 * construction. The aggregates-only badge and the basis line are required chrome, not decoration.
 */
import { useRef, useState } from 'react';
import type { PayerIntelAiBucket, PayerIntelAiResult } from '../../lib/payer-intel/contract';
import { EM_DASH, fmtInt, fmtPct } from './format';

const TONE_HEX: Record<'ok' | 'watch' | 'risk', string> = {
  ok: '#287860',
  watch: '#936316',
  risk: '#B64138',
};

function BucketTable({ title, buckets, unit }: { title: string; buckets: readonly PayerIntelAiBucket[]; unit: string }) {
  if (buckets.length === 0) {
    return <p className="text-xs text-ink400">{title}: every bucket is below the confidence floor.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink600">{title}</h4>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-ink400">
            <th className="py-1 pr-3">{unit}</th>
            <th className="py-1 pr-3 text-right">Patients</th>
            <th className="py-1 pr-3 text-right">Lines</th>
            <th className="py-1 pr-3 text-right">% allowed</th>
            <th className="py-1 pr-3 text-right">% paid</th>
            <th className="py-1 text-right">Zero-paid</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.bucket} className="border-t border-line">
              <td className="py-1 pr-3 font-mono tabular-nums">{b.bucket}</td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">{fmtInt(b.patients)}</td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">{fmtInt(b.lines)}</td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">{fmtPct(b.pctAllowed)}</td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">{fmtPct(b.pctPaid)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{fmtPct(b.pctZeroPaid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PayerIntelAiPanel({
  generate,
}: {
  /** The server action, injected as a prop so the panel stays hermetically renderable. */
  generate: () => Promise<PayerIntelAiResult>;
}) {
  const [state, setState] = useState<
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'done'; result: Extract<PayerIntelAiResult, { ok: true }> }
    | { phase: 'error'; reason: 'insufficient' | 'retry' }
  >({ phase: 'idle' });
  const [showUnderlying, setShowUnderlying] = useState(false);
  const seq = useRef(0);

  const run = () => {
    const mySeq = ++seq.current;
    setState({ phase: 'loading' });
    void generate().then((res) => {
      if (seq.current !== mySeq) return; // superseded by a newer run
      if (res.ok) setState({ phase: 'done', result: res });
      else if (res.reason === 'insufficient') setState({ phase: 'error', reason: 'insufficient' });
      else setState({ phase: 'error', reason: 'retry' });
    });
  };

  return (
    <section aria-label="Cohort read" data-pi-section="ai">
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Cohort read</h2>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">AI · aggregates only</span>
      </div>
      <div className="rounded-md border border-line border-t-2 border-t-teal500 bg-surface p-5 shadow-ths-sm">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="font-head text-base font-medium text-ink900">AI analysis</h3>
          {/* The required aggregates-only badge. */}
          <span className="rounded-full bg-teal50 px-2.5 py-0.5 font-mono text-[10px] text-teal700">
            cohort · no patient data leaves the server
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={run}
            disabled={state.phase === 'loading'}
            className="rounded-md bg-teal700 px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal900"
          >
            {state.phase === 'loading' ? 'Reading…' : state.phase === 'done' ? 'Regenerate' : 'Read this cohort'}
          </button>
        </div>

        {state.phase === 'error' ? (
          <div className="mt-4 rounded-md border border-status-danger/30 bg-status-danger/10 px-4 py-3 text-sm" style={{ color: '#B64138' }}>
            {state.reason === 'insufficient'
              ? 'Not enough matched data to read — widen the search.'
              : 'The read came back malformed or failed. Nothing was shown rather than something wrong — try again.'}
          </div>
        ) : null}

        {state.phase === 'done' ? (
          <div className="mt-4 rounded-md border border-line bg-ground px-4 py-4">
            <p className="text-[13.5px] leading-relaxed text-ink900">
              <b className="font-semibold">TL;DR</b> — {state.result.read.tldr}
            </p>
            <div className="mt-3 space-y-2.5">
              {state.result.read.signals.map((s, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full"
                    style={{ background: TONE_HEX[s.tone] }}
                  />
                  <span className="text-[12.5px] leading-relaxed text-ink600">
                    <span className="sr-only">{s.tone === 'ok' ? 'OK: ' : s.tone === 'watch' ? 'Watch: ' : 'Risk: '}</span>
                    {s.text}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-3.5 border-t border-line pt-3">
              {/* The required basis line. */}
              <span className="font-mono text-[10px] text-ink400">basis: {state.result.read.basis}</span>
              <span className="flex-1" />
              {state.result.underlying !== null ? (
                <button
                  type="button"
                  aria-expanded={showUnderlying}
                  onClick={() => setShowUnderlying(!showUnderlying)}
                  className="text-[12.5px] font-semibold text-teal700 hover:text-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
                >
                  {showUnderlying ? '▾ Hide underlying data' : '▸ Show underlying data'}
                </button>
              ) : (
                <span className="text-[11px] text-ink400">cohort tables need a prefix search</span>
              )}
            </div>
            {showUnderlying && state.result.underlying !== null ? (
              <div className="mt-3 space-y-4 border-t border-line pt-3">
                <BucketTable title="By visit position" buckets={state.result.underlying.byVisit} unit="Visit" />
                <BucketTable title="By days since first visit" buckets={state.result.underlying.byDays} unit="Day bucket" />
              </div>
            ) : null}
          </div>
        ) : state.phase === 'idle' ? (
          <p className="mt-4 text-sm text-ink400">
            One click summarizes this cohort&apos;s payment behavior — {EM_DASH} aggregates only, nothing
            patient-level is sent.
          </p>
        ) : null}
      </div>
    </section>
  );
}
