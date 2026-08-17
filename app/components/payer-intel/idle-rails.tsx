'use client';

/**
 * The two IDLE-state rails — "Policies gaining ground" (dark teal, the tape silhouette) and
 * "Facilities losing ground" (dark WARM ground + coral accents, two-line ticks).
 *
 * ⚠ NO MARQUEE, BY SPEC. Unlike the Qualify tape these are STATIC, hand-scrollable strips
 * (`overflow-x-auto`) with hover treatment only — the Payer Intel motion spec forbids
 * auto-scroll here, so `useMarquee` is deliberately not used and no duplicate set exists.
 *
 * PHI/DOLLARS: gainers items are the tape's non-dollar shape verbatim. Decliner ticks carry ONE
 * dollar (current-window billed) which arrives ALREADY NULL for amounts-blind sessions (core
 * choke point) — the micro-line drops the figure rather than rendering '—' noise.
 * `declineReason` is null in v1 (no attribution service exists); the tick renders without a
 * why-tag rather than fabricating one.
 */
import type { QualifyPolicyTapeItem } from '../../lib/qualify/board';
import { TAPE_PALETTE } from '../qualify/tokens';
import type { PayerIntelDeclinerItem } from '../../lib/payer-intel/contract';
import { fmtMoneyCompact } from './format';

/** The warm dark ground the losing-ground rail sits on. A component-local literal (the FLAT_HEX
 *  precedent): TreatHealthOS has no warm-dark surface token, and minting a Tailwind token for one
 *  rail would imply reuse this surface has not earned. White + coral400 both clear 4.5:1 on it. */
const DOWN_RAIL_HEX = '#3B1D17';
const DOWN_LINE = 'rgba(240,145,124,0.16)';
const DOWN_DELTA_HEX = '#FF9B85';

function gainerHandle(item: QualifyPolicyTapeItem): string {
  return item.echo ?? item.prefix ?? `⋯${item.tokenTail.slice(-4)}`;
}

function gainerClause(item: QualifyPolicyTapeItem): string | null {
  const parts: string[] = [];
  if (item.careSetting !== null) parts.push(item.careSetting === 'BOTH' ? 'IP+OP' : item.careSetting);
  if (item.facilityCount > 1) parts.push(`${item.facilityCount} facilities`);
  else if (item.area !== null) parts.push(item.area);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function PayerIntelGainersRail({
  items,
  asOf,
  deltaDays,
  onSeed,
}: {
  items: readonly QualifyPolicyTapeItem[];
  asOf: string | null;
  deltaDays: number;
  /** Seed a search from a tick (prefix + payer). */
  onSeed?: (item: QualifyPolicyTapeItem) => void;
}) {
  return (
    <section aria-label="Policies gaining ground" data-pi-section="gainers">
      <div className="mb-2 flex items-baseline gap-2 px-0.5">
        <h2 className="font-head text-[15px] font-semibold tracking-tight text-ink900">Policies gaining ground</h2>
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">
          {deltaDays}-day rating change{asOf ? ` · as of ${asOf}` : ''}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink400">
          No policy has gained ground over the last {deltaDays} days — nothing to lead with yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-teal900 shadow-ths-sm">
          <ul className="flex items-center overflow-x-auto py-2.5" style={{ scrollbarWidth: 'thin' }}>
            {items.map((p) => {
              const band = p.bandNow ?? '0';
              const clause = gainerClause(p);
              const label =
                `${gainerHandle(p)}, ${p.payer}${clause ? `, ${clause}` : ''}. ` +
                `Rating ${p.ratingNow}, up ${p.deltaPts} points over ${deltaDays} days.` +
                (onSeed ? ' Search this policy.' : '');
              const body = (
                <>
                  <span className="font-mono text-xs font-medium tracking-wide text-white">{gainerHandle(p)}</span>
                  <span className="max-w-[168px] truncate text-xs text-white/60">{p.payer}</span>
                  {clause ? <span className="whitespace-nowrap text-xs text-white/60">{clause}</span> : null}
                  {/* TAPE_PALETTE.band, never IQ_BAND_HEX — inverse-surface set (audit C-4). */}
                  <span className="font-mono text-[15px] font-semibold" style={{ color: TAPE_PALETTE.band[band] }}>
                    {p.ratingNow}
                  </span>
                  <span className="font-mono text-xs font-medium" style={{ color: TAPE_PALETTE.up }}>
                    ▲ +{p.deltaPts} pts
                  </span>
                </>
              );
              return (
                <li key={`${p.token}-${p.payer}`} className="flex flex-none border-r border-white/10 last:border-r-0">
                  {onSeed ? (
                    <button
                      type="button"
                      aria-label={label}
                      onClick={() => onSeed(p)}
                      className="flex items-baseline gap-2.5 px-5 py-0.5 text-left transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70"
                    >
                      {body}
                    </button>
                  ) : (
                    <span className="flex items-baseline gap-2.5 px-5">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

export function PayerIntelDeclinersRail({
  items,
  windowDays,
  thresholdPts,
  onSeed,
}: {
  items: readonly PayerIntelDeclinerItem[];
  windowDays: number;
  thresholdPts: number;
  onSeed?: (item: PayerIntelDeclinerItem) => void;
}) {
  return (
    <section aria-label="Facilities losing ground" data-pi-section="decliners">
      <div className="mb-2 flex items-baseline gap-2 px-0.5">
        {/* RATING_HEX.danger, not status-danger: small text on the light page ground needs the
            text-safe darkened value (audit C-5); this heading sits on bg-ground, not the rail. */}
        <h2 className="font-head text-[15px] font-semibold tracking-tight" style={{ color: '#B64138' }}>
          Facilities losing ground
        </h2>
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">
          % collected of billed · {windowDays}d · decliners only
        </span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink600">
          No facility is down more than {thresholdPts} pts in {windowDays} days — nothing to chase.
        </p>
      ) : (
        <>
          <div
            className="overflow-hidden rounded-xl shadow-ths-sm"
            style={{ background: DOWN_RAIL_HEX, borderTop: '2px solid #E2674F' }}
          >
            <ul className="flex items-stretch overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
              {items.map((d) => {
                const label =
                  `${d.facility}${d.careSetting ? `, ${d.careSetting === 'BOTH' ? 'IP and OP' : d.careSetting}` : ''}. ` +
                  `Collecting ${d.pctCurrent ?? '—'} percent of billed, down ${Math.abs(d.deltaPts)} points over ${windowDays} days.` +
                  (onSeed ? ' Search this facility.' : '');
                const microParts = [
                  `${d.lineCount.toLocaleString('en-US')} ln`,
                  ...(d.billedCurrent !== null ? [fmtMoneyCompact(d.billedCurrent)] : []),
                ];
                const body = (
                  <>
                    <span className="flex items-center gap-2">
                      <span className="text-[12.5px] font-semibold tracking-wide text-white">{d.facility}</span>
                      {d.careSetting !== null ? (
                        <span
                          className="rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wider"
                          style={{ color: '#F0917C', borderColor: 'rgba(240,145,124,0.4)' }}
                        >
                          {d.careSetting === 'BOTH' ? 'IP+OP' : d.careSetting}
                        </span>
                      ) : null}
                      <span className="font-display text-[17px] font-medium" style={{ color: '#F0917C' }}>
                        {d.pctCurrent !== null ? `${Math.round(d.pctCurrent)}%` : '—'}
                      </span>
                      <span className="font-mono text-xs font-medium" style={{ color: DOWN_DELTA_HEX }}>
                        ▼ −{Math.abs(d.deltaPts).toFixed(1)}
                      </span>
                    </span>
                    {/* Second micro-line. NO why-tag in v1: decline_reason attribution does not
                        exist server-side, and fabricating one client-side is forbidden by spec.
                        TODO(payer-intel): render `declineReason` here once the attribution service
                        ships a real value. */}
                    <span className="flex items-center gap-2 font-mono text-[10px] text-white/45">
                      {microParts.join(' · ')}
                    </span>
                  </>
                );
                return (
                  <li key={d.facility} className="flex flex-none" style={{ borderRight: `1px solid ${DOWN_LINE}` }}>
                    {onSeed ? (
                      <button
                        type="button"
                        aria-label={label}
                        onClick={() => onSeed(d)}
                        className="flex flex-col justify-center gap-1 px-5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70 hover:bg-[rgba(240,145,124,0.06)]"
                      >
                        {body}
                      </button>
                    ) : (
                      <span className="flex flex-col justify-center gap-1 px-5 py-2.5">{body}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="mt-1.5 px-0.5 text-xs text-ink400">
            Decliners only, ≥{thresholdPts} pts over {windowDays} days on payment-date windows. Drill before acting —
            a thin window can move without the payer changing anything.
          </p>
        </>
      )}
    </section>
  );
}
