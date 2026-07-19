'use client';

/**
 * Qualify mobile — "why is this rated X" trend sheet (right-swipe). Renders entirely from the facility
 * object already in hand (no query): raw pctAllowedOfBilled, lineCount, the DYNAMIC per-facility
 * explanation (explainRating — weight on real data + a generated sentence), then the final rating +
 * bucket. Carries NO dollar fields by design. Light bottom-sheet.
 */
import { mobileBucketStyle } from './colors';
import { explainRating } from '../../../lib/qualify/rating';
import type { QualifyFacility } from '../../../lib/qualify/contract';

const INK900 = '#1B2B2A';
const INK600 = '#4A5C5A';
const INK400 = '#859794';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';

function StatRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
      <span style={{ color: INK600 }}>{label}</span>
      <span className={mono ? 'ths-num' : undefined} style={{ fontWeight: 600, color: INK900 }}>{value}</span>
    </div>
  );
}

export function TrendSheet({ facility, onClose }: { facility: QualifyFacility; onClose: () => void }) {
  const b = mobileBucketStyle(facility.rating);
  const ex = explainRating(facility.pctAllowedOfBilled, facility.lineCount);
  const ratingText = facility.rating === null ? '—' : String(Math.round(facility.rating));
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(27,43,42,0.45)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div style={{ width: '100%', background: SURFACE, borderRadius: '20px 20px 0 0', padding: 20, color: INK900 }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK400 }}>
          Why is this rated {ratingText}?
        </div>
        <div className="ths-h" style={{ marginTop: 4, fontSize: 16, fontWeight: 600, color: INK900 }}>{facility.name}</div>
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <StatRow label="Raw allowed / billed" value={ex.rawPct === null ? '—' : `${Math.round(ex.rawPct)}%`} mono />
          <StatRow label="Claim lines this window" value={String(ex.lineCount)} mono />
          <StatRow label="Weight on real data" value={`${Math.round(ex.volumeWeight * 100)}%`} mono />
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: INK600 }}>{ex.sentence}</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: `0.5px solid ${LINE}`, paddingTop: 10 }}>
            <span style={{ color: INK600 }}>Rating</span>
            <span className="ths-num" style={{ fontWeight: 700, color: b.color }}>{ratingText} · {b.label}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ marginTop: 20, width: '100%', height: 40, borderRadius: 10, border: `0.5px solid ${LINE}`, background: SURFACE, color: INK900, fontWeight: 600 }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
