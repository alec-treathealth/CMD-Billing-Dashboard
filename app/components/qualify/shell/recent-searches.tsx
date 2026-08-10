'use client';

/**
 * RECENT SEARCHES — the board's history strip (mock: `.recents`). NON-PHI FACETS ONLY, which is
 * the whole design: payer label · ≤3-char prefix echo · plan class · when. Re-run RE-RESOLVES the
 * prefix fresh (the facets are never a cached answer), and a member-ID search appears here only as
 * its prefix — the deliberate degradation the 0096 header records; durable full-ID follow-up is
 * the patient watcher's job, which stores a token instead.
 */
import type { QualifyRecentSearch } from '../../../lib/qualify/watchers';
import { ZoneRule } from './board-zone';

export function RecentSearches({
  items,
  available,
  readFailed = false,
  onRerun,
  onClear,
}: {
  items: (QualifyRecentSearch & { sessionOnly?: boolean })[];
  available: boolean;
  /** The read failed — say that, not "0096 is not applied yet". See WatchersPanel's prop. */
  readFailed?: boolean;
  onRerun: (prefixEcho: string) => void;
  onClear: () => void;
}) {
  return (
    <section aria-label="Recent searches" data-testid="qualify-recent-searches">
      <ZoneRule
        label="Recent searches"
        tag="NON-PHI FACETS ONLY · RE-RUN RESOLVES FRESH"
        action={
          items.length > 0 ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-lg border border-line px-2 py-0.5 font-mono text-[10px] text-ink400 transition-colors hover:text-status-danger"
            >
              clear history
            </button>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-ink400">
          {readFailed
            ? 'Saved history could not be read just now — this session only.'
            : `No searches yet${available ? '' : ' — history is session-only until migration 0096 applies'}.`}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((r, i) => (
            <li key={r.id || `session-${i}`}>
              <div className="flex h-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2">
                <span
                  aria-hidden
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal50 font-head text-[13px] font-bold text-teal700"
                >
                  {(r.payer ?? r.prefixEcho ?? '·').slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-ink900">
                    {r.payer ?? 'No payer resolved'}
                    {r.prefixEcho ? <span className="font-mono"> · {r.prefixEcho}</span> : null}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-ink400">
                    {r.planClass ?? '—'} · {r.sessionOnly ? 'this session' : r.searchedAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </span>
                {r.prefixEcho ? (
                  <button
                    type="button"
                    onClick={() => onRerun(r.prefixEcho!)}
                    className="shrink-0 rounded-lg border border-teal200 px-2 py-1 font-mono text-[10px] font-semibold text-teal700 transition-colors hover:bg-teal50"
                  >
                    ↻ Re-run
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
