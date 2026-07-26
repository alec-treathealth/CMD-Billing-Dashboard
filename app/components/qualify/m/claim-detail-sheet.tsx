'use client';

/**
 * Qualify mobile — single claim-line detail (tap a claim in DetailSheet). Layered ABOVE DetailSheet
 * (higher z-index); dismissing returns to the facility's claim list, which stays mounted underneath.
 * Renders QualifyClaim fields. This is the PER-PATIENT reveal trigger: "Reveal identifiers" (shown when
 * canReveal && the patient isn't revealed yet) fires the parent's audited reveal for THIS claim's patient
 * (onReveal); once `phi` arrives the sheet swaps its mask for the real values and the list row underneath
 * reflects it too. The mobile list has no patient-group expander, so this popup is the reveal affordance.
 *
 * AMOUNTS GATE: the Billed/Allowed block is OMITTED from the DOM (not CSS-hidden) when
 * !hasAmounts — the server has already nulled the values; this is belt-and-suspenders.
 */
import type { QualifyClaim, QualifyPhi } from '../../../lib/qualify/contract';
import { mobileBucketStyle } from './colors';

const INK900 = '#1B2B2A';
const INK600 = '#4A5C5A';
const INK400 = '#63756E';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';
const GROUND = '#FBF8F4';
const TEAL700 = '#135E5A';
const TEAL_TINT = '#EAF4F2';
const DANGER = '#C0453B';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function Row({ label, value, valueColor = INK900 }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `0.5px solid ${LINE}` }}>
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: INK400 }}>{label}</span>
      <span className="ths-num" style={{ fontSize: 13, fontWeight: 600, color: valueColor, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function ClaimDetailSheet({
  claim,
  hasAmounts,
  phi,
  canReveal = false,
  revealing = false,
  revealError = null,
  onReveal,
  onClose,
}: {
  claim: QualifyClaim;
  hasAmounts: boolean;
  phi: QualifyPhi | null;
  /** PER-PATIENT reveal affordance (this claim's patient). Omitted/false → no reveal button (e.g. tests). */
  canReveal?: boolean;
  revealing?: boolean;
  revealError?: string | null;
  onReveal?: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(27,43,42,0.55)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div style={{ width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', background: SURFACE, borderRadius: '20px 20px 0 0', color: INK900 }}>
        <div style={{ padding: '20px 20px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div className="ths-num" style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.06em', color: INK900 }}>{phi ? (phi.member_id_raw ?? '—') : claim.memberIdMasked}</div>
            {/* Payer sits with the member id (NON-PHI — visible whether or not the id is revealed). */}
            {claim.payerName ? (
              <div style={{ marginTop: 2, fontSize: 12, color: INK600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{claim.payerName}</div>
            ) : null}
          </div>
          {claim.program ? (
            <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#2D7393', background: '#E4F0F5', borderRadius: 999, padding: '2px 8px' }}>{claim.program}</span>
          ) : null}
        </div>
        <div style={{ padding: '0 20px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK400 }}>
          Claim detail
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 20px 4px', background: GROUND, margin: '12px 16px', borderRadius: 12 }}>
          {phi ? <Row label="Patient" value={phi.patient_name ?? '—'} /> : null}
          {phi ? <Row label="Group #" value={phi.group_number ?? '—'} /> : null}
          <Row label="Facility" value={claim.facilityName ?? '—'} />
          <Row label="Payment date" value={claim.paymentDate ?? '—'} />
          <Row label="DOS" value={claim.dos ?? '—'} />
          {/* Color by the claim's OWN allowed% (mobileBucketStyle → ratingBucket 50/30), not the facility
              rating — desktop parity (900e084). null → neutral. Other rows keep the default INK900. */}
          <Row label="% Allowed" value={claim.pctAllowedOfBilled === null ? '—' : `${Math.round(claim.pctAllowedOfBilled)}%`} valueColor={mobileBucketStyle(claim.pctAllowedOfBilled).color} />
          {hasAmounts ? (
            <>
              <Row label="Billed" value={claim.billedAmount === null ? '—' : usd0(claim.billedAmount)} />
              <Row label="Allowed" value={claim.allowedAmount === null ? '—' : usd0(claim.allowedAmount)} />
            </>
          ) : null}
        </div>
        {/* PER-PATIENT reveal: one audited call for THIS claim's patient (across the loaded set). Hidden
            once revealed (phi present) or for a non-entitled viewer. */}
        {canReveal && !phi ? (
          <div style={{ padding: '0 16px' }}>
            <button
              type="button"
              onClick={() => onReveal?.()}
              disabled={revealing}
              style={{ width: '100%', height: 40, borderRadius: 10, border: 'none', background: TEAL_TINT, color: TEAL700, fontWeight: 700, cursor: 'pointer', opacity: revealing ? 0.6 : 1 }}
            >
              {revealing ? 'Revealing…' : 'Reveal identifiers'}
            </button>
            {revealError ? <div style={{ marginTop: 6, fontSize: 11, color: DANGER, textAlign: 'center' }}>{revealError}</div> : null}
          </div>
        ) : null}
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
