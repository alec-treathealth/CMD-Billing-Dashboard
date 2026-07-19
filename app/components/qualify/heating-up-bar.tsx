'use client';

/**
 * Qualify desktop — "Heating up" payer quick-pick. The SAME trending-payer data the mobile HeatingUp
 * chips use (getQualifyMovers, filtered to deltaPatients > 0), rendered as a horizontally-scrollable
 * row of chips at the top of the tab. Clicking a chip auto-resolves that payer via resolveByPayer —
 * the desktop equivalent of the mobile chip tap, and an alternative to typing a member-id/prefix search.
 *
 * The payer LABEL is a plaintext primary_payer value (non-PHI), so this quick-pick carries NO
 * member-id/prefix term — it flows down the resolve-by-payer path, never the PHI search path.
 *
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup; relative +
 * type-only imports so the render test runs under tsx without `@/` alias resolution.
 */
import { Flame } from 'lucide-react';
import type { QualifyMover, QualifyWindowDays } from '../../lib/qualify/contract';

export function HeatingUpBar({
  movers,
  windowDays,
  activeLabel = null,
  onOpen,
}: {
  movers: readonly QualifyMover[];
  windowDays: QualifyWindowDays;
  /** The currently-resolved payer label (highlights its chip); null when resolved via PHI search. */
  activeLabel?: string | null;
  onOpen: (label: string) => void;
}) {
  const shown = movers.filter((m) => m.deltaPatients > 0); // trending UP only (mirrors mobile HeatingUp)
  if (shown.length === 0) return null;
  return (
    <section aria-label="Trending payers" className="space-y-1.5 px-0.5">
      <div className="flex items-center gap-1.5">
        <Flame aria-hidden className="h-3.5 w-3.5 text-[#B8862E]" />
        <span className="font-display text-[13px] font-semibold text-ink900">Heating up</span>
        <span className="ml-1 text-[11px] text-muted-foreground">
          payers trending up · last {windowDays} days · click to resolve
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1.5">
        {shown.map((m) => {
          const active = activeLabel !== null && m.label === activeLabel;
          return (
            <button
              key={m.label}
              type="button"
              onClick={() => onOpen(m.label)}
              aria-pressed={active}
              aria-label={`Resolve ${m.label}`}
              className={[
                'shrink-0 rounded-xl border px-3 py-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
                active
                  ? 'border-teal500 bg-teal50 ring-1 ring-teal500'
                  : 'border-line bg-card hover:border-teal200 hover:bg-teal50',
              ].join(' ')}
            >
              <div className="whitespace-nowrap text-[12.5px] font-semibold text-ink900">{m.label}</div>
              <div className="mt-0.5 whitespace-nowrap text-[11px] font-semibold text-teal700">
                {m.deltaPct !== null ? `+${m.deltaPct}%` : `+${m.deltaPatients} new`}
                <span className="text-muted-foreground"> · {m.thisWindowPatients} cases</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
