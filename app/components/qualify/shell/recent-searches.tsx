'use client';

/**
 * RECENT SEARCHES — the board's history strip (mock: `.recents`). NON-PHI FACETS ONLY, which is
 * the whole design: payer label · ≤3-char prefix echo · plan class · when. Re-run RE-RESOLVES the
 * prefix fresh (the facets are never a cached answer), and a member-ID search appears here only as
 * its prefix — the deliberate degradation the 0097 header records; durable full-ID follow-up is
 * the patient watcher's job, which stores a token instead.
 */
import type { QualifyRecentSearch } from '../../../lib/qualify/watchers';
import { ZoneRule } from './board-zone';
import type { QualifyBoardStatus } from './shell-session';

/**
 * THE EMPTY STATE'S SENTENCE, one per status — see `deriveBoardStatus` for why this is not a
 * boolean. `loading` deliberately makes NO claim about storage: this panel used to receive
 * `available={false}` for the whole mount-fetch window and told every operator, on every page load,
 * that history was session-only "until migration 0097 applies". 0097 has been applied since
 * 2026-08-10, so that sentence was false as well as unactionable.
 *
 * `absent` is now written as a FAULT rather than as a provisioning stage, and it names no migration:
 * an admissions rep cannot act on "0097", but they can act on "tell an admin". The migration number
 * lives where it is useful — the comment in `app/lib/qualify/loaders.ts` beside the code that
 * produces the state.
 */
const EMPTY_COPY: Record<QualifyBoardStatus, string> = {
  loading: 'Loading your recent searches…',
  durable: 'No searches yet.',
  absent:
    'No searches yet. Saved history is unavailable right now, so anything you search stays in this session only — tell an admin if this persists.',
  failed: 'Saved history could not be read just now — this session only.',
};

export function RecentSearches({
  items,
  status,
  onRerun,
  onClear,
}: {
  items: (QualifyRecentSearch & { sessionOnly?: boolean })[];
  /** loading · durable · absent · failed — never a boolean. See WatchersPanel's prop and
   *  `deriveBoardStatus`; collapsing `loading` onto `absent` is the defect this replaced. */
  status: QualifyBoardStatus;
  onRerun: (prefixEcho: string) => void;
  onClear: () => void;
}) {
  return (
    <section aria-label="Recent searches" data-testid="qualify-recent-searches">
      <ZoneRule
        label="Recent searches"
        tag="NON-PHI FACETS ONLY · RE-RUN RESOLVES FRESH"
        level={2}
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
          {EMPTY_COPY[status]}
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
                    // Per-item context (payer + prefix echo — both non-PHI and already rendered),
                    // so AT does not announce every row's control as the identical "Re-run".
                    aria-label={`Re-run search — ${r.payer ?? 'no payer resolved'} · ${r.prefixEcho}`}
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
