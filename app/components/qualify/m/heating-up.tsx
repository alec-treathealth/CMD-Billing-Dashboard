'use client';

/**
 * Qualify mobile — "Facilities Heating Up" chips (redesign). FACILITY-shaped now (name + rating +
 * Δpts + defined n), fed by the same getQualifyOverview trend rows desktop's cards use — the old
 * payer-mover chips are superseded. Tap = the Change-E HYBRID: resolve the facility's dominant payer
 * AND scope to the facility (wired by the container via onOpen(trend)). Colors come from the SHARED
 * tokens module (Phase 0) — no per-file hex.
 */
import { FlameIcon } from './icons';
import { ratingBucket } from '../../../lib/qualify/rating';
import { qualifyWindowLabel, type QualifyFacilityTrend, type QualifyWindow } from '../../../lib/qualify/contract';
import { QUALIFY_PALETTE, RATING_HEX } from '../tokens';

const GOLD = '#B8862E';

export function HeatingUp({
  trends,
  window: win,
  onOpen,
}: {
  trends: readonly QualifyFacilityTrend[];
  window: QualifyWindow;
  /** The Change-E hybrid: resolve trend.dominantPayer + scope to trend.facilityKey. */
  onOpen: (trend: QualifyFacilityTrend) => void;
}) {
  if (trends.length === 0) return null;
  return (
    <div style={{ padding: '14px 16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <FlameIcon size={14} color={GOLD} />
        <span className="ths-h" style={{ fontSize: 13, fontWeight: 600, color: QUALIFY_PALETTE.ink900 }}>
          Facilities Heating Up
        </span>
        <span style={{ fontSize: 11, color: QUALIFY_PALETTE.ink400, marginLeft: 'auto' }}>{qualifyWindowLabel(win)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {trends.map((t) => {
          const hex = RATING_HEX[ratingBucket(t.currentRating)];
          const up = t.deltaPts !== null && t.deltaPts > 0.2;
          const down = t.deltaPts !== null && t.deltaPts < -0.2;
          const deltaColor = up ? RATING_HEX.ok : down ? RATING_HEX.danger : QUALIFY_PALETTE.ink400;
          return (
            <button
              key={t.facilityKey}
              type="button"
              onClick={() => onOpen(t)}
              disabled={!t.dominantPayer}
              aria-label={`Open ${t.name}`}
              style={{
                flexShrink: 0,
                textAlign: 'left',
                cursor: t.dominantPayer ? 'pointer' : 'default',
                padding: '8px 12px',
                borderRadius: 12,
                background: QUALIFY_PALETTE.surface,
                border: `0.5px solid ${QUALIFY_PALETTE.line}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: hex }} />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: QUALIFY_PALETTE.ink900,
                    maxWidth: 180,
                    // 2-line clamp (mobile has less width to spare): multi-word names wrap instead of
                    // clipping; overflowWrap breaks a single over-long token so it can't spill.
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    whiteSpace: 'normal',
                    overflow: 'hidden',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {t.name}
                </span>
              </div>
              <div style={{ marginTop: 2, fontSize: 11, fontWeight: 600, color: deltaColor, whiteSpace: 'nowrap' }}>
                {t.currentRating === null ? '—' : `${Math.round(t.currentRating)}%`}
                {t.deltaPts === null ? ' · new' : ` · ${up ? '▲' : down ? '▼' : '◆'}${t.deltaPts > 0 ? '+' : ''}${t.deltaPts.toFixed(1)} pts`}
                <span style={{ color: QUALIFY_PALETTE.ink400, fontWeight: 500 }}> · {t.lineCount} claim lines</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
