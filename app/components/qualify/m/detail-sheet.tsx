'use client';

/**
 * Qualify mobile — facility detail (tap). Renders the FACILITY-SCOPED claim lines for the tapped card
 * (getQualifyFacilityCases, keyed on QualifyFacility.facilityKey), by service date, capped at 15.
 * Each claim line is tappable → onOpenClaim opens the single-claim ClaimDetailSheet above this list.
 *
 * AMOUNTS GATE: the Billed/Allowed block is OMITTED from the DOM (not CSS-hidden) when
 * !hasAmounts — the server has already nulled the values; this is belt-and-suspenders.
 *
 * PHI REVEAL: masked member IDs by default. "Reveal all" (shown only when canReveal) runs one audited
 * revealQualifyRows in the parent; when phiShown, each row swaps its mask for the real member id +
 * patient name from `revealed` (keyed by case id). Reveal is ORTHOGONAL to the amounts gate.
 */
import type { QualifyCase, QualifyFacility, QualifyPhi } from '../../../lib/qualify/contract';
import { mobileBucketStyle } from './colors';

const INK900 = '#1B2B2A';
const INK600 = '#4A5C5A';
const INK400 = '#859794';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';
const GROUND = '#FBF8F4';
const TEAL700 = '#135E5A';
const TEAL_TINT = '#EAF4F2';
const DANGER = '#C0453B';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function DetailSheet({
  facility,
  cases,
  loading,
  hasAmounts,
  canReveal,
  revealed,
  phiShown,
  revealPending,
  revealError,
  onRevealAll,
  onOpenClaim,
  onClose,
}: {
  facility: QualifyFacility;
  cases: readonly QualifyCase[];
  loading: boolean;
  hasAmounts: boolean;
  canReveal: boolean;
  revealed: Map<number, QualifyPhi>;
  phiShown: boolean;
  revealPending: boolean;
  revealError: string | null;
  onRevealAll: () => void;
  onOpenClaim: (c: QualifyCase) => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(27,43,42,0.45)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div style={{ width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', background: SURFACE, borderRadius: '20px 20px 0 0', color: INK900 }}>
        <div style={{ padding: '20px 20px 12px' }}>
          <div className="ths-h" style={{ fontSize: 16, fontWeight: 600, color: INK900 }}>{facility.name}</div>
          {facility.city && facility.state ? (
            <div style={{ marginTop: 2, fontSize: 12, color: INK400 }}>{facility.city}, {facility.state}</div>
          ) : null}
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK400 }}>
              Recent claims at this facility
            </span>
            {canReveal && cases.length > 0 ? (
              <button
                type="button"
                onClick={onRevealAll}
                disabled={revealPending}
                aria-pressed={phiShown}
                style={{ fontSize: 11, fontWeight: 700, color: TEAL700, background: TEAL_TINT, border: 'none', borderRadius: 999, padding: '5px 12px', cursor: 'pointer', opacity: revealPending ? 0.6 : 1 }}
              >
                {revealPending ? 'Revealing…' : phiShown ? 'Hide IDs' : 'Reveal all'}
              </button>
            ) : null}
          </div>
          {revealError ? <div style={{ marginTop: 6, fontSize: 11, color: DANGER }}>{revealError}</div> : null}
        </div>
        <div style={{ overflowY: 'auto', padding: '0 16px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: INK400 }}>
              Loading claims…
            </div>
          ) : cases.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: INK400 }}>
              No recent claims at this facility in this window.
            </div>
          ) : (
            cases.map((c) => {
              const phi = phiShown ? revealed.get(c.id) : undefined;
              return (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpenClaim(c)}
                style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', border: `0.5px solid ${LINE}`, borderRadius: 12, background: GROUND, padding: '10px 12px', font: 'inherit', color: 'inherit' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span className="ths-num" style={{ fontSize: 12, letterSpacing: '0.06em', color: phi ? INK900 : INK400, fontWeight: phi ? 600 : 400 }}>
                    {phi ? (phi.member_id_raw ?? '—') : c.memberIdMasked}
                  </span>
                  {c.program ? (
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#2D7393', background: '#E4F0F5', borderRadius: 999, padding: '2px 8px' }}>{c.program}</span>
                  ) : null}
                </div>
                {phi ? (
                  <div style={{ marginTop: 3, fontSize: 11, color: INK600 }}>
                    {phi.patient_name ?? '—'}{phi.group_number ? ` · Grp ${phi.group_number}` : ''}
                  </div>
                ) : null}
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: INK600 }}>
                  <span>{c.lastDos ?? '—'}</span>
                  {/* Color by the ROW'S OWN allowed% (mobileBucketStyle → ratingBucket 50/30), NOT the
                      parent facility rating — desktop parity (900e084). null → neutral. */}
                  <span className="ths-num" style={{ color: mobileBucketStyle(c.pctAllowedOfBilled).color }}>{c.pctAllowedOfBilled === null ? '—' : `${Math.round(c.pctAllowedOfBilled)}% allowed`}</span>
                </div>
                {hasAmounts ? (
                  <div className="ths-num" style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end', gap: 12, fontSize: 11, color: INK600 }}>
                    <span>Billed {c.billedAmount === null ? '—' : usd0(c.billedAmount)}</span>
                    <span>Allowed {c.allowedAmount === null ? '—' : usd0(c.allowedAmount)}</span>
                  </div>
                ) : null}
              </button>
              );
            })
          )}
        </div>
        <div style={{ padding: 16 }}>
          <button
            onClick={onClose}
            style={{ width: '100%', height: 40, borderRadius: 10, border: `0.5px solid ${LINE}`, background: SURFACE, color: INK900, fontWeight: 600 }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
