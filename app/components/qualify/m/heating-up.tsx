'use client';

/**
 * Qualify mobile — "Heating up" module. Payers trending up over a fixed 30-day window (getQualifyMovers
 * verbatim), filtered to deltaPatients > 0, shown as horizontally-scrollable chips. Gold flame per the
 * prototype.
 *
 * INFORMATIONAL ONLY (ratified 2026-07-17): the chips are NOT tappable and do not prefill the search.
 * The frozen contract resolves a payer from a member-id / alpha-prefix token, NOT from a payer name, so
 * there is no resolve-by-payer path today — these chips are a trend indicator. A resolve-by-payer
 * capability would be a future contract addition, out of scope here.
 */
import { FlameIcon } from './icons';
import type { QualifyMover } from '../../../lib/qualify/contract';

const INK900 = '#1B2B2A';
const INK400 = '#859794';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';
const OK = '#2E8B6F';
const GOLD = '#B8862E';

export function HeatingUp({ movers }: { movers: readonly QualifyMover[] }) {
  const shown = movers.filter((m) => m.deltaPatients > 0);
  if (shown.length === 0) return null;
  return (
    <div style={{ padding: '14px 16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <FlameIcon size={14} color={GOLD} />
        <span className="ths-h" style={{ fontSize: 13, fontWeight: 600, color: INK900 }}>Heating up</span>
        <span style={{ fontSize: 11, color: INK400, marginLeft: 'auto' }}>last 30 days</span>
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {shown.map((m) => (
          <div
            key={m.label}
            style={{ flexShrink: 0, padding: '8px 12px', borderRadius: 12, background: SURFACE, border: `0.5px solid ${LINE}` }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: INK900, whiteSpace: 'nowrap' }}>{m.label}</div>
            <div style={{ marginTop: 2, fontSize: 11, color: OK, fontWeight: 600 }}>
              {m.deltaPct !== null ? `+${m.deltaPct}%` : `+${m.deltaPatients} new`} · {m.thisWindowPatients} cases
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
