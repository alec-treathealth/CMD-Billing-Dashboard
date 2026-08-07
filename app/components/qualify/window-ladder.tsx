'use client';

/**
 * Qualify v2 — the AUTO-WINDOW ladder disclosure (Phase E). The system decides its own evidence
 * window (30→365, stop at the first rung with a confident distinct-patient sample) and this makes
 * the decision VISIBLE, not silent: every rung it weighed, the count that ruled each in or out, and
 * a plain-language sentence for the outcome. The rungs stagger in (staggerDelayMs — capped, honest
 * pacing over one already-resolved payload, never fake async) so the widening reads as a decision.
 *
 * Pure/presentational (no hooks) → hermetic under renderToStaticMarkup. Non-dollar throughout.
 */
import { QUALIFY_RATING_CONFIDENT_PATIENTS } from '../../lib/qualify/sampleGate';
import { staggerDelayMs } from './tokens';
import type { QualifyWindowLadder } from '../../lib/qualify/contract';

export function WindowLadder({ ladder }: { ladder: QualifyWindowLadder }) {
  const floor = QUALIFY_RATING_CONFIDENT_PATIENTS;
  const chosenIx = ladder.rungs.findIndex((r) => r.days === ladder.chosenDays);
  return (
    <section
      className="rounded-2xl border bg-card px-4 py-3 shadow-ths-sm"
      data-testid="window-ladder"
      aria-label="How the evidence window was chosen"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-head text-[13px] font-semibold tracking-tight text-ink900">
          Finding a window with enough patients to trust
        </h3>
        <span className="text-xs text-muted-foreground">
          needs {floor}+ distinct patients · stops at the first that clears
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-5 gap-2">
        {ladder.rungs.map((r, i) => {
          const isChosen = r.days === ladder.chosenDays;
          const tried = i <= chosenIx || !ladder.sufficient; // insufficient ⇒ every rung was tried
          return (
            <div
              key={r.days}
              className={[
                'relative overflow-hidden rounded-xl border px-2.5 py-2 animate-ths-reveal',
                isChosen && ladder.sufficient
                  ? 'border-teal500 bg-teal50'
                  : isChosen
                    ? 'border-coral-400 border-[#F0917C] bg-[#FCEDE8]'
                    : 'border-line bg-surface',
                tried ? '' : 'opacity-45',
              ].join(' ')}
              style={{ animationDelay: `${staggerDelayMs(i)}ms` }}
              title={
                r.sufficient
                  ? `${r.days} days holds ${r.distinctPatients} distinct patients — enough`
                  : `${r.days} days holds only ${r.distinctPatients} distinct patient${r.distinctPatients === 1 ? '' : 's'} — under the floor of ${floor}`
              }
            >
              <div className="flex items-baseline gap-1 font-mono text-[17px] font-semibold tabular-nums leading-none text-ink900">
                {r.days}
                <span className="text-xs font-normal text-ink400">days</span>
              </div>
              <div
                className={[
                  'mt-1.5 text-xs font-semibold tabular-nums',
                  r.sufficient ? 'text-teal700' : tried ? 'text-ink600' : 'text-ink400',
                ].join(' ')}
              >
                {tried ? `${r.distinctPatients} patient${r.distinctPatients === 1 ? '' : 's'}${r.sufficient ? ' — enough' : ' — too few'}` : 'not needed'}
              </div>
              <span
                aria-hidden
                className={['absolute inset-x-0 bottom-0 h-[2px]', r.sufficient ? 'bg-teal500' : 'bg-[#F0917C]', tried ? '' : 'opacity-0'].join(' ')}
              />
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] text-ink600">
        {ladder.sufficient ? (
          <>
            Showing trailing <b className="font-mono font-semibold tabular-nums">{ladder.chosenDays}</b> days —{' '}
            {ladder.chosenDays === 30
              ? 'the freshest window already carries a reliable sample.'
              : `needed this far back to reach a reliable sample (${floor}+ distinct patients).`}
          </>
        ) : (
          <>
            Even <b className="font-mono font-semibold tabular-nums">365</b> days holds fewer than {floor} distinct
            patients — everything below is <b className="font-semibold">directional, not confirmed</b>. The data
            confidence factor is carrying that penalty; a biller should sanity-check this one.
          </>
        )}
      </p>
    </section>
  );
}
