'use client';

/**
 * Qualify mobile — single claim-line detail (tap a claim in DetailSheet). Layered ABOVE DetailSheet
 * (higher z-index); dismissing returns to the facility's claim list, which stays mounted underneath.
 * Renders ONLY existing QualifyCase fields — no new data is fetched or exposed here.
 *
 * AMOUNTS GATE: the Billed/Allowed block is OMITTED from the DOM (not CSS-hidden) when
 * !hasAmounts — the server has already nulled the values; this is belt-and-suspenders.
 */
import type { QualifyCase } from '../../../lib/qualify/contract';

const INK900 = '#1B2B2A';
const INK600 = '#4A5C5A';
const INK400 = '#859794';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';
const GROUND = '#FBF8F4';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `0.5px solid ${LINE}` }}>
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: INK400 }}>{label}</span>
      <span className="ths-num" style={{ fontSize: 13, fontWeight: 600, color: INK900, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function ClaimDetailSheet({
  claim,
  hasAmounts,
  onClose,
}: {
  claim: QualifyCase;
  hasAmounts: boolean;
  onClose: () => void;
}) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(27,43,42,0.55)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div style={{ width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', background: SURFACE, borderRadius: '20px 20px 0 0', color: INK900 }}>
        <div style={{ padding: '20px 20px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div className="ths-num" style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.06em', color: INK900 }}>{claim.memberIdMasked}</div>
          {claim.program ? (
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#2D7393', background: '#E4F0F5', borderRadius: 999, padding: '2px 8px' }}>{claim.program}</span>
          ) : null}
        </div>
        <div style={{ padding: '0 20px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK400 }}>
          Claim detail
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 20px 4px', background: GROUND, margin: '12px 16px', borderRadius: 12 }}>
          <Row label="Facility" value={claim.facilityName ?? '—'} />
          <Row label="Last DOS" value={claim.lastDos ?? '—'} />
          <Row label="% Allowed" value={claim.pctAllowedOfBilled === null ? '—' : `${Math.round(claim.pctAllowedOfBilled)}%`} />
          {hasAmounts ? (
            <>
              <Row label="Billed" value={claim.billedAmount === null ? '—' : usd0(claim.billedAmount)} />
              <Row label="Allowed" value={claim.allowedAmount === null ? '—' : usd0(claim.allowedAmount)} />
            </>
          ) : null}
        </div>
        <div style={{ padding: 16 }}>
          <button
            onClick={onClose}
            style={{ width: '100%', height: 40, borderRadius: 10, border: `0.5px solid ${LINE}`, background: SURFACE, color: INK900, fontWeight: 600 }}
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
