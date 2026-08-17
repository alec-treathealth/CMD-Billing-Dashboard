'use client';

/**
 * The AI dock — a sticky launcher in the bottom-right corner that opens the cohort read over the
 * page.
 *
 * ⚠ THIS IS THE THIRD PLACEMENT, and the ruling that settles it (Alec, 2026-08-17): at the page
 * bottom the panel was "still at the bottom of the screen and hidden"; in the right rail it
 * competed with the census for the same 356px. A dock is the shape that survives both problems —
 * it is visible from anywhere on the page without consuming a column, and it never scrolls out of
 * reach. `ai-panel.tsx` stays presentational so the read itself renders identically here, in a
 * rail, or under a hermetic render test.
 *
 * NON-MODAL BY DESIGN (`useDialog(..., {trap:false})`, aria-modal="false"). The point of the dock
 * is reading the answer AGAINST the tables it describes, so it must not trap focus or block the
 * page behind a scrim — a modal here would force the user to close it to check any number it
 * cites. Escape still closes, focus still moves in on open and returns to the launcher on close.
 *
 * RESULT-ONLY: rendered by the view only when a search has resolved. A launcher on IDLE would open
 * onto nothing to analyse, and "Read this cohort" with no cohort is a dead control.
 */
import { useState } from 'react';
import type { PayerIntelAiResult } from '../../lib/payer-intel/contract';
import { useDialog } from '../qualify/useDialog';
import { PayerIntelAiPanel } from './ai-panel';

export function PayerIntelAiDock({
  generate,
  /** Names the cohort in the dock header so the answer is visibly ABOUT the current search. */
  subject,
}: {
  generate: () => Promise<PayerIntelAiResult>;
  subject: string;
}) {
  const [open, setOpen] = useState(false);
  // `active` (not mount-on-open) so the effect keys off the open flag — the useDialog contract.
  const panelRef = useDialog<HTMLDivElement>(() => setOpen(false), { trap: false, active: open });

  return (
    <>
      {/* The launcher. `fixed` + a z-index under no other stacking context on this page; the
          label is text, not an icon alone, so the control is nameable by voice and by AT. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="pi-ai-dock"
        onClick={() => setOpen(!open)}
        className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-teal700 px-4 py-3 text-[13px] font-semibold text-white shadow-ths-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal900 focus-visible:ring-offset-2"
      >
        <span aria-hidden className="text-base leading-none">
          {open ? '×' : '✦'}
        </span>
        {open ? 'Close AI analysis' : 'AI analysis'}
      </button>

      <div
        id="pi-ai-dock"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={`AI analysis of ${subject}`}
        hidden={!open}
        // Capped at 72vh and scrolled INSIDE the panel: the underlying-data tables can be long,
        // and a dock that grows past the viewport puts its own close button off-screen.
        className="fixed bottom-[76px] right-5 z-40 flex max-h-[72vh] w-[min(420px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-lg border border-line border-t-2 border-t-teal500 bg-surface shadow-ths-lg outline-none"
      >
        <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
          <h2 className="font-head text-[14px] font-semibold tracking-tight text-ink900">AI analysis</h2>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-ink400">
            {subject}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close AI analysis"
            className="rounded px-1 text-lg leading-none text-ink400 transition-colors hover:text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3">
          <PayerIntelAiPanel generate={generate} />
        </div>
      </div>
    </>
  );
}
