'use client';

/**
 * "Ask about this policy" — the Qualify AI explainer panel (Phase H). Preset chips (never a
 * free-text box), a word-by-word streamed answer in three labeled sections (TL;DR / Signals /
 * Risks), a blinking caret while streaming. The input is assembled HERE from the snapshot the
 * user is already looking at — aggregates only; the server re-validates through the zod firewall
 * (zero dollar fields for every role) and re-derives the blind flag from the principal.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { generateQualifyAiExplanation } from '@/lib/qualify/ai-actions';
import { parseAiSections } from '../../../src/collections/aiAnalysis';
import type { QualifyAiInput } from '../../../src/collections/qualifyAi';
import type { QualifySnapshot } from '../../lib/qualify/contract';

type ChipId = QualifyAiInput['question'];

const CHIP_LABELS: Record<ChipId, string> = {
  explain: 'Why does this facility score what it does?',
  ranks: 'Which of our facilities does this policy pay best?',
  placement: 'Should I place this client here?',
  speed: 'How long until we see the money?',
  improve: 'What would move this rating?',
};

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

export function QualifyAiPanel({ snapshot, blind }: { snapshot: QualifySnapshot; blind: boolean }) {
  const [active, setActive] = useState<ChipId | null>(null);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);

  const chips = useMemo<ChipId[]>(() => {
    const out: ChipId[] = ['explain'];
    if (snapshot.facilities.length > 1) out.push('ranks');
    if (snapshot.facilities.length > 0) out.push('placement');
    if (snapshot.facilities.some((f) => f.medianDaysToPayment !== null)) out.push('speed');
    if (snapshot.facilities.some((f) => f.factors.some((x) => x.available && x.direction === 'neg'))) out.push('improve');
    return out;
  }, [snapshot]);

  const run = useCallback(
    async (id: ChipId) => {
      const gen = ++genRef.current;
      setActive(id);
      setText('');
      setError(null);
      setStreaming(true);
      try {
        const res = await generateQualifyAiExplanation(buildInput(id, snapshot, blind));
        if (genRef.current !== gen) return;
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
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (genRef.current !== gen) return;
          if (done) break;
          acc += value;
          setText(acc);
        }
        setStreaming(false);
      } catch {
        if (genRef.current !== gen) return;
        setStreaming(false);
        setError('The explainer is unavailable right now.');
      }
    },
    [snapshot, blind],
  );

  const sections = parseAiSections(text);
  const caret = streaming ? <span aria-hidden className="q-ai-caret ml-0.5 inline-block h-[13px] w-[7px] bg-teal500 align-[-2px]" /> : null;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-ths-sm" data-testid="qualify-ai-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-gradient-to-b from-teal50 to-surface px-4 py-2.5">
        <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-teal700 text-[13px] text-white">✦</span>
        <h2 className="font-head text-[15px] font-semibold tracking-tight">Ask about this policy</h2>
        <span className="text-[11.5px] text-muted-foreground">
          {snapshot.resolved?.payerName ?? snapshot.policy?.carrier ?? 'This search'} · aggregates only
          {blind ? ' · amounts withheld for this role' : ''}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {chips.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => run(id)}
            aria-pressed={active === id}
            className={[
              'rounded-xl border px-3 py-2 text-left text-[12.5px] font-semibold leading-snug transition-colors',
              active === id ? 'border-teal500 bg-teal50 text-teal700' : 'border-line bg-surface text-ink600 hover:border-teal200 hover:text-teal700',
            ].join(' ')}
          >
            {CHIP_LABELS[id]}
          </button>
        ))}
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
            <div aria-live="polite" className="rounded-xl border border-line bg-ground px-4 py-3">
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-teal700">TL;DR</div>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink900">
                {sections['TL;DR'] || (streaming && !text ? 'Reading the numbers…' : sections['TL;DR'])}
                {sections.Signals === '' && sections.Risks === '' ? caret : null}
              </p>
              {sections.Signals ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-status-ok">Signals</div>
                  <div className="prose-sm mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink900">
                    {sections.Signals}
                    {sections.Risks === '' ? caret : null}
                  </div>
                </div>
              ) : null}
              {sections.Risks ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-status-danger">Risks</div>
                  <div className="prose-sm mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink900">
                    {sections.Risks}
                    {caret}
                  </div>
                </div>
              ) : null}
              {!streaming && text ? (
                <p className="mt-3 border-t border-dashed border-line pt-2 text-[10.5px] text-ink400">
                  Grounded in the factors above · window {snapshot.ladder?.chosenDays ?? '—'}d · verify benefits on the
                  case before quoting anything.
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
