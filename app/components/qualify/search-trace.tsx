'use client';

/**
 * SearchTrace — what this search did, and why.
 *
 * CCR-Agent's `AgentActivity` shape ("reads like a colleague narrating their chart pull, not a
 * terminal") with one honest difference, which the header copy states to the user rather than
 * hiding: CCR narrates a streaming backend, whereas `getQualifySnapshot` is ONE round trip that
 * returns everything at once. There is no progress to observe, so revealing these lines on timers
 * would imply work happening at moments when it had already finished. This surface does not
 * manufacture what it cannot measure, so the trace is retrospective and says so.
 *
 * It answers the question the ranked list cannot: the search widened the window and that cost
 * confidence; it picked one payer out of four; it ranked a comparable cohort because this policy has
 * no claims of its own. Today those answers are scattered across four components.
 *
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup, and
 * non-dollar by construction — identical for an admissions_seat session.
 */
import type { QualifyTraceLine } from '../../lib/qualify/searchTrace';

const TONE_META: Record<QualifyTraceLine['tone'], { mark: string; cls: string }> = {
  ok: { mark: '✓', cls: 'text-status-ok' },
  note: { mark: '•', cls: 'text-teal700' },
  flag: { mark: '!', cls: 'text-status-warn' },
};

export function SearchTrace({ lines }: { lines: QualifyTraceLine[] }) {
  // Nothing to narrate renders nothing. The empty state above already says "no match" better than a
  // trace line claiming the search found nothing would.
  if (lines.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-ths-sm" data-testid="search-trace">
      <div className="flex flex-wrap items-baseline gap-x-2 border-b border-line bg-surface px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">How this was resolved</span>
        {/* Says plainly that this is a record, not a live feed — see the module header. */}
        <span className="ml-auto text-xs italic text-ink400">a record of the decisions, not a live feed</span>
      </div>
      <ol className="space-y-1.5 px-4 py-2.5">
        {lines.map((l, i) => {
          const meta = TONE_META[l.tone];
          return (
            <li key={`${l.tone}-${i}`} className="flex items-start gap-2">
              <span aria-hidden className={['mt-px w-4 shrink-0 text-center text-xs font-bold', meta.cls].join(' ')}>
                {meta.mark}
              </span>
              <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink600">{l.text}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
