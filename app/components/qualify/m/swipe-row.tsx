'use client';

/**
 * Qualify mobile — one card of the 5-up ranked list (Phase 4b — the per-row swipe GESTURE is GONE).
 * The horizontal gesture now lives on the LIST CONTAINER (facility-list.tsx) and pages the whole column;
 * this component is a plain, tappable card again:
 *   tap the card body → onOpen (facility detail — the grouped claims).
 *   tap the WHY control → onWhy (the why-this-rating sheet; coverage breakdown + reversals note). Its click
 *                 stops propagation so it never also triggers the card-body open, and the container gesture
 *                 leaves a tap alone (it only consumes a locked horizontal drag).
 * Card content (unchanged): rank chip · name · LOC tag · location + volume line · 0059 COVERAGE micro-bar
 * (confirmed/estimate/unknown — amber estimate is never green) · rating number/label. Still NO dollar
 * fields by construction (amounts gate satisfied structurally).
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { mobileBucketStyle, mobileIqStyle } from './colors';
import { ratingSampleTier } from '../../../lib/qualify/sampleGate';
import { BuildingIcon, TrendIcon } from './icons';
import type { QualifyFacility } from '../../../lib/qualify/contract';

const TEAL700 = '#135E5A';
const INK900 = '#1B2B2A';
const INK400 = '#63756E';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';

export function SwipeRow({
  facility,
  onWhy,
  onOpen,
  sampleGated = true,
}: {
  facility: QualifyFacility;
  onWhy: (f: QualifyFacility) => void;
  onOpen: (f: QualifyFacility) => void;
  /** Apply the distinct-patient sample gate (sampleGate.ts, hotfix 2026-07-27). True for the payer-wide
   *  ranking; FALSE for an identifier-scoped list (one known patient by construction — its thinness is
   *  self-evident and intended, so it keeps the raw rating). Default true. */
  sampleGated?: boolean;
}) {
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(facility);
    }
  }

  // SAMPLE GATE: < 3 distinct patients → neutral (no confident color / number); 3-9 → thin flag.
  const tier = sampleGated ? ratingSampleTier(facility.distinctPatients) : 'full';
  const insufficient = tier === 'insufficient';
  // v2: the IQ band is the ONE scale (parity with desktop); v1 bucket style is the unrated fallback.
  const v2 = facility.ratingV2 !== null && facility.iqBand !== null;
  const b = insufficient
    ? mobileBucketStyle(null)
    : v2
      ? mobileIqStyle(facility.iqBand)
      : mobileBucketStyle(facility.rating);
  const ratingText = insufficient
    ? '—'
    : v2
      ? String(facility.ratingV2)
      : facility.rating === null
        ? '—'
        : String(Math.round(facility.rating));
  const label = insufficient ? 'Insufficient' : b.label;
  const patients = `${facility.distinctPatients} patient${facility.distinctPatients === 1 ? '' : 's'}`;
  // "City, ST" only when BOTH are present — partial (city-only / state-only) omits cleanly, never "City, " or ", ST".
  const loc = facility.city && facility.state ? `${facility.city}, ${facility.state}` : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${facility.name} claims`}
      onClick={() => onOpen(facility)}
      onKeyDown={onKeyDown}
      className="relative flex items-center gap-3 px-4"
      style={{
        height: 108,
        borderRadius: 16,
        background: SURFACE,
        border: `0.5px solid ${LINE}`,
        borderLeft: `3px solid ${b.color}`,
        boxShadow: '0 1px 2px rgba(27,43,42,0.06)',
        cursor: 'pointer',
      }}
    >
      <div className="flex h-9 w-9 flex-shrink-0 flex-col items-center justify-center rounded-[9px]" style={{ background: b.tint }}>
        <span className="ths-num text-[13px] font-bold leading-none" style={{ color: b.color }}>{facility.rank}</span>
        <BuildingIcon size={11} color={b.color} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="ths-h truncate text-[13px] font-semibold leading-tight" style={{ color: INK900 }}>
            {facility.name}
          </div>
          {facility.careSetting ? (
            <span
              className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold uppercase"
              style={{ background: '#e4f0f5', color: '#2C6E8A' }}
            >
              {facility.careSetting === 'BOTH' ? 'Both' : facility.careSetting}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs" style={{ color: INK400 }}>
          {loc ? `${loc} · ` : ''}{patients} · {facility.lineCount} lines{tier === 'thin' ? ' · thin sample' : ''}
        </div>
        {/* 0059 coverage micro-bar: confirmed / estimate / unknown (estimate amber, never green). */}
        <div className="mt-1 flex h-[3px] overflow-hidden rounded-full" style={{ background: LINE }} aria-hidden>
          {facility.confirmedClaims > 0 ? (
            <span style={{ width: `${(facility.confirmedClaims / Math.max(1, facility.lineCount)) * 100}%`, background: '#2e8b6f' }} />
          ) : null}
          {facility.estimateClaims > 0 ? (
            <span style={{ width: `${(facility.estimateClaims / Math.max(1, facility.lineCount)) * 100}%`, background: '#c9881e' }} />
          ) : null}
        </div>
      </div>
      <div className="flex-shrink-0 text-right">
        <div className="ths-num text-[20px] font-bold leading-none" style={{ color: b.color }}>
          {ratingText}
        </div>
        <div className="mt-0.5 text-xs font-semibold uppercase" style={{ color: b.color }}>
          {label}
        </div>
      </div>
      {/* Dedicated WHY control (Phase 4b): right-swipe no longer opens "why" — this button does. stopPropagation
          keeps the card-body open from also firing; it is a real <button> so the container gesture leaves it be. */}
      <button
        type="button"
        aria-label={`Why this rating for ${facility.name}`}
        onClick={(e) => { e.stopPropagation(); onWhy(facility); }}
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[9px]"
        style={{ border: `0.5px solid ${LINE}`, background: '#F5F8F7' }}
      >
        <TrendIcon size={14} color={TEAL700} />
      </button>
    </div>
  );
}
