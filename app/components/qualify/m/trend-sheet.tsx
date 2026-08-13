'use client';

/**
 * Qualify mobile — "why is this rated X" trend sheet (right-swipe peek). Renders entirely from the
 * facility object already in hand (no query): raw pctAllowedOfBilled, lineCount, the DYNAMIC per-facility
 * explanation (explainRating — the value-first sentence + limited-data flag), the 0059 coverage
 * breakdown (confirmed / estimate / unknown + the reversal note — Phase 4), then the final rating +
 * bucket. Carries NO dollar fields by design. Light bottom-sheet.
 *
 * ⚠ RATING PARITY WITH THE CARD (audit 2026-08-12, P0-1): this sheet explains THE NUMBER THE CARD
 * SHOWS — ratingV2 + IQ band when rated, the v1 bucket only as the unrated fallback, the exact
 * derivation swipe-row.tsx uses. It used to print v1 here unconditionally, so tapping "why" on a
 * card reading 56 opened a sheet asking "Why is this rated 78?". If you change one derivation,
 * change both.
 */
import { mobileBucketStyle, mobileIqStyle } from './colors';
import { explainRating } from '../../../lib/qualify/rating';
import { ratingSampleTier } from '../../../lib/qualify/sampleGate';
import type { QualifyFacility } from '../../../lib/qualify/contract';

const INK900 = '#1B2B2A';
const INK600 = '#4A5C5A';
const INK400 = '#63756E';
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

export function TrendSheet({
  facility,
  onClose,
  sampleGated = true,
}: {
  facility: QualifyFacility;
  onClose: () => void;
  /** Apply the distinct-patient sample gate (sampleGate.ts). True for the payer-wide ranking; false
   *  for an identifier-scoped facility (one known patient — keeps the raw rating). Default true. */
  sampleGated?: boolean;
}) {
  // SAMPLE GATE (hotfix 2026-07-27): suppress the confident rating below 3 distinct patients.
  const tier = sampleGated ? ratingSampleTier(facility.distinctPatients) : 'full';
  const insufficient = tier === 'insufficient';
  // v2 preferred, v1 fallback — the SAME derivation as swipe-row.tsx (P0-1 parity; see header ⚠).
  const v2 = facility.ratingV2 !== null && facility.iqBand !== null;
  const b = insufficient
    ? mobileBucketStyle(null)
    : v2
      ? mobileIqStyle(facility.iqBand)
      : mobileBucketStyle(facility.rating);
  const ex = explainRating(facility.pctAllowedOfBilled, facility.lineCount);
  const ratingText = insufficient
    ? '—'
    : v2
      ? String(facility.ratingV2)
      : facility.rating === null
        ? '—'
        : String(Math.round(facility.rating));
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
        {facility.city && facility.state ? (
          <div style={{ marginTop: 2, fontSize: 12, color: INK400 }}>
            {facility.city}, {facility.state}
          </div>
        ) : null}
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <StatRow label="Allowed / billed" value={insufficient ? '—' : ex.rawPct === null ? '—' : `${Math.round(ex.rawPct)}%`} mono />
          <StatRow label="Distinct patients" value={String(facility.distinctPatients)} mono />
          <StatRow label="Claim lines this window" value={String(ex.lineCount)} mono />
          {/* 0059 coverage breakdown (Phase 4): what the rating is — and is not — based on. */}
          <StatRow label="Confirmed claims" value={String(facility.confirmedClaims)} mono />
          <StatRow label="Estimates (excluded)" value={String(facility.estimateClaims)} mono />
          <StatRow label="No allowed on file" value={String(facility.unknownClaims)} mono />
          <div style={{ display: 'flex', height: 4, borderRadius: 999, overflow: 'hidden', background: LINE }} aria-hidden>
            {facility.confirmedClaims > 0 ? (
              <span style={{ width: `${(facility.confirmedClaims / Math.max(1, facility.lineCount)) * 100}%`, background: '#2e8b6f' }} />
            ) : null}
            {facility.estimateClaims > 0 ? (
              <span style={{ width: `${(facility.estimateClaims / Math.max(1, facility.lineCount)) * 100}%`, background: '#c9881e' }} />
            ) : null}
          </div>
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: INK400 }}>
            Rated on {facility.confirmedClaims} of {facility.lineCount} claims. Estimate = payer reversals we
            couldn&rsquo;t verify — shown in the claims list, excluded from this rating.
          </p>
          {/* SAMPLE GATE note (hotfix 2026-07-27): patient-based, above the line-based ex.sentence. */}
          {tier === 'insufficient' ? (
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: INK600 }}>
              Only {facility.distinctPatients} patient{facility.distinctPatients === 1 ? '' : 's'} in this slice — not
              enough to score, so no rating is shown. Widen the window or the payer to build a reliable sample.
            </p>
          ) : tier === 'thin' ? (
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: INK600 }}>
              Backed by only {facility.distinctPatients} patients — treat this rating as an early signal.
            </p>
          ) : null}
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: INK600 }}>{ex.sentence}</p>
          {/* The composite's basis (P0-2/P0-6 companion): out-of-100 weighting, renormalized over
              the factors that have data — so equal numbers over different factor sets say so. */}
          {v2 && !insufficient ? (
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: INK600 }}>
              Scored on {facility.availableWeight} of 100 weighting — factors without data are excluded, never guessed.
            </p>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: `0.5px solid ${LINE}`, paddingTop: 10 }}>
            <span style={{ color: INK600 }}>Rating</span>
            <span className="ths-num" style={{ fontWeight: 700, color: b.color }}>{insufficient ? 'Insufficient data' : `${ratingText} · ${b.label}`}</span>
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
