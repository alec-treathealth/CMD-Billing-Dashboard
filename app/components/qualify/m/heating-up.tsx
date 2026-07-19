'use client';

/**
 * Qualify mobile — "Heating up" module. Payers trending up over a fixed 30-day window (getQualifyMovers
 * verbatim), filtered to deltaPatients > 0, shown as horizontally-scrollable chips. Gold flame per the
 * prototype.
 *
 * TAPPABLE (resolve-by-payer, 2026-07-17): each chip resolves that payer's facilities directly via
 * getQualifySnapshotByPayer (the mover `label` is a primary_payer value) and seeds the swipe deck —
 * supersedes the earlier "informational only" decision. The payer LABEL is non-PHI, so this path
 * carries no member-id/prefix term.
 */
import { FlameIcon } from './icons';
import type { QualifyMover, QualifyWindowDays } from '../../../lib/qualify/contract';

const INK900 = '#1B2B2A';
const INK400 = '#859794';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';
const OK = '#2E8B6F';
const GOLD = '#B8862E';

export function HeatingUp({
  movers,
  windowDays,
  onOpen,
}: {
  movers: readonly QualifyMover[];
  windowDays: QualifyWindowDays;
  onOpen: (label: string) => void;
}) {
  const shown = movers.filter((m) => m.deltaPatients > 0);
  if (shown.length === 0) return null;
  return (
    <div style={{ padding: '14px 16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <FlameIcon size={14} color={GOLD} />
        <span className="ths-h" style={{ fontSize: 13, fontWeight: 600, color: INK900 }}>Heating up</span>
        <span style={{ fontSize: 11, color: INK400, marginLeft: 'auto' }}>last {windowDays} days</span>
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {shown.map((m) => (
          <button
            key={m.label}
            type="button"
            onClick={() => onOpen(m.label)}
            aria-label={`Resolve ${m.label}`}
            style={{ flexShrink: 0, textAlign: 'left', cursor: 'pointer', padding: '8px 12px', borderRadius: 12, background: SURFACE, border: `0.5px solid ${LINE}` }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: INK900, whiteSpace: 'nowrap' }}>{m.label}</div>
            <div style={{ marginTop: 2, fontSize: 11, color: OK, fontWeight: 600 }}>
              {m.deltaPct !== null ? `+${m.deltaPct}%` : `+${m.deltaPatients} new`} · {m.thisWindowPatients} cases
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
