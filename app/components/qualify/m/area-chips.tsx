'use client';

/**
 * Qualify mobile — area (state) filter chips over the resolved facility deck. A national payer's deck
 * can span 5-8 states across 30+ facilities; these chips pre-filter the swipeable list to one area WITHOUT
 * a new search, leaving the SwipeRow gesture model (pass/why/tap + sliding-window queue) entirely untouched
 * — tapping a chip only changes which facilities seed the deck.
 *
 * Facilities carry `state` from the in-code facilityLocations lookup (null when unmapped) — no server call.
 * Unmapped facilities are NEVER dropped: they collect under an "Other" chip so otherwise-valid, possibly
 * high-scoring leads stay reachable. The chip row is hidden by the parent when there are <2 real buckets.
 */
import type { QualifyFacility } from '../../../lib/qualify/contract';

const INK600 = '#4A5C5A';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';
const TEAL900 = '#0E3A3A';

/** 'all' | a 2-letter state | 'other' (null-state bucket). Kept as a plain string for simple state wiring. */
export const AREA_ALL = 'all';
export const AREA_OTHER = 'other';

export interface AreaChip {
  key: string; // AREA_ALL | state | AREA_OTHER
  label: string; // 'All' | state | 'Other'
}

/**
 * The chip list for a resolved deck: All (leftmost) + each distinct non-null state present (sorted) +
 * Other (only when at least one facility has no location). PURE — derived entirely from the facilities
 * already on the client. The parent shows the row only when this returns >2 chips (i.e. >=2 real buckets).
 */
export function deriveAreaChips(facilities: readonly QualifyFacility[]): AreaChip[] {
  const states = Array.from(
    new Set(facilities.map((f) => f.state).filter((s): s is string => s !== null && s !== '')),
  ).sort();
  const hasOther = facilities.some((f) => f.state === null || f.state === '');
  return [
    { key: AREA_ALL, label: 'All' },
    ...states.map((s) => ({ key: s, label: s })),
    ...(hasOther ? [{ key: AREA_OTHER, label: 'Other' }] : []),
  ];
}

/** Facilities in the selected area bucket. 'all' → everything; 'other' → null/blank state; else exact state. PURE. */
export function facilitiesInArea(
  facilities: readonly QualifyFacility[],
  key: string,
): QualifyFacility[] {
  if (key === AREA_ALL) return [...facilities];
  if (key === AREA_OTHER) return facilities.filter((f) => f.state === null || f.state === '');
  return facilities.filter((f) => f.state === key);
}

export function AreaChips({
  chips,
  active,
  onSelect,
}: {
  chips: readonly AreaChip[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div style={{ padding: '4px 16px 0' }}>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }} role="group" aria-label="Filter by area">
        {chips.map((c) => {
          const on = c.key === active;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onSelect(c.key)}
              aria-pressed={on}
              style={{
                flexShrink: 0,
                cursor: 'pointer',
                height: 30,
                padding: '0 14px',
                borderRadius: 999,
                border: on ? 'none' : `0.5px solid ${LINE}`,
                background: on ? TEAL900 : SURFACE,
                color: on ? '#fff' : INK600,
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
