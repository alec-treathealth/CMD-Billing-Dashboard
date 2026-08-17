'use client';

/**
 * Starred + Recent searches — the 0104-backed persistence surfaces. Card anatomy per the mock:
 * the PREFIX (or payer, when no prefix) leads at full weight; resolution status is demoted to the
 * meta line; the star toggles persistence per user (12-star cap surfaces as a plain message).
 *
 * "Clear history" clears ONLY the Recent section — starred rows survive by definer contract
 * (0104 change #2). Employer/group searches re-run DEGRADED (their identifying facet is
 * deliberately not persisted); the meta line says so instead of pretending.
 */
import type { PayerIntelSavedSearch } from '../../lib/payer-intel/contract';
import { fmtSearchStamp } from './format';

function entityLabel(s: PayerIntelSavedSearch): string {
  switch (s.entityType) {
    case 'prefix':
      return 'Prefix';
    case 'payer':
      return 'Payer';
    case 'employer':
      return 'Employer';
    case 'funding':
      return 'Funding';
    case 'group':
      return 'Group #';
    case 'facility':
      return 'Facility';
    case 'individual':
      return 'Individual';
    default:
      return 'Search';
  }
}

function SearchCard({
  search,
  onToggleStar,
  onRerun,
}: {
  search: PayerIntelSavedSearch;
  onToggleStar: (s: PayerIntelSavedSearch) => void;
  onRerun: (s: PayerIntelSavedSearch) => void;
}) {
  const lead = search.prefixEcho ?? search.payer ?? entityLabel(search);
  const degraded = search.entityType === 'employer' || search.entityType === 'group';
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3.5 py-3 shadow-ths-sm transition-colors hover:border-teal200 hover:bg-teal50">
      <button
        type="button"
        aria-pressed={search.starred}
        aria-label={search.starred ? `Unstar ${lead}` : `Star ${lead}`}
        onClick={() => onToggleStar(search)}
        className="min-h-6 min-w-6 text-sm leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
        style={{ color: search.starred ? '#E0B05C' : undefined }}
      >
        {search.starred ? '★' : <span className="text-ink400 opacity-40">☆</span>}
      </button>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm font-medium tracking-wide text-ink900">{lead}</div>
        <div className="mt-0.5 truncate text-[11px] text-ink400">
          {entityLabel(search)}
          {search.payer !== null && search.prefixEcho !== null ? ` · ${search.payer}` : ''}
          {' · '}
          {search.resolved === true ? (
            <span className="font-semibold" style={{ color: '#287860' }}>
              resolved
            </span>
          ) : (
            <span>no payer resolved</span>
          )}
          {' · '}
          {fmtSearchStamp(search.searchedAt)}
          {degraded ? ' · re-runs without its saved facet' : ''}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRerun(search)}
        className="whitespace-nowrap rounded-full border border-teal200 px-2.5 py-1 font-mono text-[11px] text-teal700 transition-colors hover:bg-teal50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
      >
        ↻ Re-run
      </button>
    </div>
  );
}

export function PayerIntelSavedSearches({
  starred,
  recent,
  persisted,
  onToggleStar,
  onRerun,
  onClearHistory,
}: {
  starred: readonly PayerIntelSavedSearch[];
  recent: readonly PayerIntelSavedSearch[];
  /** False when the 0097/0104 relations were absent — the sections render session-only copy. */
  persisted: boolean;
  onToggleStar: (s: PayerIntelSavedSearch) => void;
  onRerun: (s: PayerIntelSavedSearch) => void;
  onClearHistory: () => void;
}) {
  return (
    <section aria-label="Saved searches" data-pi-section="saved" className="space-y-5">
      <div>
        <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
          <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Starred</h2>
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">
            non-PHI facets only · re-run resolves fresh
          </span>
        </div>
        {starred.length === 0 ? (
          <p className="px-0.5 text-sm text-ink400">Star a recent search to pin it here.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {starred.map((s) => (
              <SearchCard key={s.id} search={s} onToggleStar={onToggleStar} onRerun={onRerun} />
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
          <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Recent</h2>
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">prefix leads</span>
          <span className="flex-1" />
          {recent.length > 0 ? (
            <button
              type="button"
              onClick={onClearHistory}
              className="text-xs font-semibold text-teal700 hover:text-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
            >
              Clear history
            </button>
          ) : null}
        </div>
        {!persisted ? (
          <p className="px-0.5 text-sm text-ink400">Search history is unavailable right now — this session only.</p>
        ) : recent.length === 0 ? (
          <p className="px-0.5 text-sm text-ink400">Searches you run will appear here.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {recent.map((s) => (
              <SearchCard key={s.id} search={s} onToggleStar={onToggleStar} onRerun={onRerun} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
