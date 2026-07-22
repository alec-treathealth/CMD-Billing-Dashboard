'use client';

/**
 * Qualify mobile — facility detail (tap). Renders the FACILITY-SCOPED claim lines for the tapped card
 * (getQualifyFacilityCases with allPayers), by service date. The drill returns EVERY payer's recent
 * patients at the facility (each row carries its own payerName), capped at 50 (the reveal batch cap);
 * `capped` is true when more exist, which the UI labels honestly ("N recent").
 *
 * Each claim line is tappable → onOpenClaim opens the single-claim ClaimDetailSheet above this list.
 *
 * FILTER MODEL (no free-text input): filtering is driven by exactly two things —
 *   1) SEARCH CONTEXT — when the sheet is opened from a prefix/alpha search, `searchContext` seeds the
 *      active filter to the resolved payer and a banner ("Showing EAZ claims · Show all N") lets the user
 *      clear it. Opened with no search term → starts unfiltered, no banner.
 *   2) PAYER CHIPS — a horizontally scrollable strip (built from the FULL, unfiltered case set, so it
 *      ALWAYS shows every payer regardless of the active filter) with payer · count · avg allowed%. The
 *      chip matching the active filter is selected; tapping another switches the filter; tapping the
 *      selected chip clears it (== Show all). The avg% is tinted by the same green/amber/red thresholds
 *      the claim rows use (mobileBucketStyle → ratingBucket 50/30).
 *
 * AMOUNTS GATE: the Billed/Allowed block is OMITTED from the DOM (not CSS-hidden) when !hasAmounts.
 *
 * PHI REVEAL: masked member IDs by default. "Reveal all" (shown only when canReveal) runs one audited
 * revealQualifyRows in the parent; when phiShown, each row swaps its mask for the real member id +
 * patient name from `revealed` (keyed by case id). Payer names are NON-PHI and stay visible regardless
 * of the reveal/Hide-IDs state.
 */
import { useMemo, useState } from 'react';
import type { QualifyClaim, QualifyFacility, QualifyPhi } from '../../../lib/qualify/contract';
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

/** The payer this row groups under; blank rollup payer collapses to a stable placeholder key. */
function payerKey(c: QualifyClaim): string {
  return c.payerName ?? '—';
}

interface PayerChip {
  payer: string;
  count: number;
  /** Mean of the group's non-null allowed% (null when the whole group is null). */
  avg: number | null;
}

export function DetailSheet({
  facility,
  claims,
  loading,
  hasAmounts,
  capped = false,
  canReveal,
  revealed,
  phiShown,
  revealPending,
  revealError,
  onRevealAll,
  onOpenClaim,
  onClose,
  searchContext = null,
}: {
  facility: QualifyFacility;
  /** FULL loaded set for the facility (all payers, ≤50). The chip strip is built from this, unfiltered. */
  claims: readonly QualifyClaim[];
  loading: boolean;
  hasAmounts: boolean;
  /** True when the facility has more claims than the loaded cap — labels read "N recent" so no one reads
   *  the counts as the facility total. */
  capped?: boolean;
  canReveal: boolean;
  revealed: Map<number, QualifyPhi>;
  phiShown: boolean;
  revealPending: boolean;
  revealError: string | null;
  onRevealAll: () => void;
  onOpenClaim: (c: QualifyClaim) => void;
  onClose: () => void;
  /** When the sheet was opened from a prefix/alpha search, the non-PHI term the user typed and the payer it
   *  resolved to — seeds the active filter + banner. Null when opened directly (e.g. from the strength list). */
  searchContext?: { term: string; payer: string } | null;
}) {
  // Filter state is driven ONLY by the search context (seed) and chip taps — never a text input.
  const [activeFilter, setActiveFilter] = useState<string | null>(searchContext?.payer ?? null);

  // Chips are built from the FULL set so the strip always shows every payer regardless of the active filter.
  const chips = useMemo<PayerChip[]>(() => {
    const groups = new Map<string, { count: number; pctSum: number; pctN: number }>();
    for (const c of claims) {
      const key = payerKey(c);
      const g = groups.get(key) ?? { count: 0, pctSum: 0, pctN: 0 };
      g.count += 1;
      if (c.pctAllowedOfBilled !== null) {
        g.pctSum += c.pctAllowedOfBilled;
        g.pctN += 1;
      }
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([payer, g]) => ({ payer, count: g.count, avg: g.pctN > 0 ? g.pctSum / g.pctN : null }))
      .sort((a, b) => b.count - a.count || (b.avg ?? -1) - (a.avg ?? -1) || a.payer.localeCompare(b.payer));
  }, [claims]);

  const visible = activeFilter === null ? claims : claims.filter((c) => payerKey(c) === activeFilter);
  // The banner reflects the search context only while its payer is the active filter (clearing or switching
  // chips takes the user out of that context). `term` is the non-PHI alpha echo (≤3 chars), never a raw id.
  const showBanner = searchContext !== null && activeFilter === searchContext.payer;
  const totalLabel = capped ? `${claims.length} recent` : `${claims.length}`;

  const onChip = (payer: string) => setActiveFilter((cur) => (cur === payer ? null : payer));

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(27,43,42,0.45)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div style={{ width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', background: SURFACE, borderRadius: '20px 20px 0 0', color: INK900 }}>
        <div style={{ padding: '20px 20px 8px' }}>
          <div className="ths-h" style={{ fontSize: 16, fontWeight: 600, color: INK900 }}>{facility.name}</div>
          {facility.city && facility.state ? (
            <div style={{ marginTop: 2, fontSize: 12, color: INK400 }}>{facility.city}, {facility.state}</div>
          ) : null}
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK400 }}>
              Recent claims at this facility
            </span>
            {canReveal && claims.length > 0 ? (
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

        {/* Payer rollup chips — built from the FULL set (every payer at the facility), so the strip is
            stable regardless of the active filter. Selected chip = active filter; tap toggles it. */}
        {!loading && chips.length > 0 ? (
          <>
            {/* Fixed-height row: minHeight fully contains the 28px chips with vertical padding; overflowY
                hidden kills any vertical clip; alignItems centers the chips. Horizontal scroll snaps to
                chip starts (scroll-snap) so the strip never rests mid-chip. The 20px inline padding makes
                the first chip flush with the header's content padding and leaves trailing room after the last. */}
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '8px 20px', boxSizing: 'border-box',
                overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x proximity', scrollPaddingLeft: 20,
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {chips.map((ch) => {
                const selected = activeFilter === ch.payer;
                return (
                  <button
                    key={ch.payer}
                    type="button"
                    onClick={() => onChip(ch.payer)}
                    aria-pressed={selected}
                    style={{
                      flexShrink: 0, scrollSnapAlign: 'start', display: 'inline-flex', alignItems: 'center', gap: 5,
                      maxWidth: 220, height: 28, boxSizing: 'border-box', padding: '0 11px',
                      borderRadius: 999, border: `0.5px solid ${selected ? TEAL700 : LINE}`, background: selected ? TEAL_TINT : GROUND,
                      color: INK900, fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    {/* Only the payer name shrinks + ellipsizes (needs minWidth:0 + block-level overflow in a
                        flex child); the `· count · avg%` suffix is flexShrink:0 so it is never clipped/pushed. */}
                    <span style={{ minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.payer}</span>
                    <span style={{ flexShrink: 0, color: INK400, fontWeight: 500 }}>· {ch.count} ·</span>
                    <span className="ths-num" style={{ flexShrink: 0, color: ch.avg === null ? INK400 : mobileBucketStyle(ch.avg).color }}>
                      {ch.avg === null ? '—' : `${Math.round(ch.avg)}%`} avg
                    </span>
                  </button>
                );
              })}
            </div>
            {capped ? (
              <div style={{ padding: '2px 20px 0', fontSize: 11, color: INK400 }}>
                Showing the {claims.length} most recent claims across payers
              </div>
            ) : null}
          </>
        ) : null}

        {/* Search-context banner — only while the search's payer is the active filter. */}
        {showBanner ? (
          <div style={{ margin: '8px 16px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderRadius: 10, background: TEAL_TINT, border: `0.5px solid ${LINE}` }}>
            <span style={{ fontSize: 12, color: INK900 }}>
              Showing <span className="ths-num" style={{ fontWeight: 700 }}>{searchContext!.term}</span> claims
            </span>
            <button
              type="button"
              onClick={() => setActiveFilter(null)}
              style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: TEAL700, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              Show all {totalLabel}
            </button>
          </div>
        ) : null}

        <div style={{ overflowY: 'auto', padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: INK400 }}>
              Loading claims…
            </div>
          ) : claims.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: INK400 }}>
              No recent claims at this facility in this window.
            </div>
          ) : (
            visible.map((c) => {
              const phi = phiShown ? revealed.get(c.id) : undefined;
              return (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpenClaim(c)}
                style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', border: `0.5px solid ${LINE}`, borderRadius: 12, background: GROUND, padding: '10px 12px', font: 'inherit', color: 'inherit' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  {/* Member id · payer — the payer reads at a glance so a mixed-alpha facility is legible.
                      Payer is NON-PHI and stays visible whether or not IDs are revealed. */}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span className="ths-num" style={{ fontSize: 12, letterSpacing: '0.06em', color: phi ? INK900 : INK400, fontWeight: phi ? 600 : 400 }}>
                      {phi ? (phi.member_id_raw ?? '—') : c.memberIdMasked}
                    </span>
                    {c.payerName ? <span style={{ fontSize: 11, color: INK600 }}> · {c.payerName}</span> : null}
                  </span>
                  {c.program ? (
                    <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#2D7393', background: '#E4F0F5', borderRadius: 999, padding: '2px 8px' }}>{c.program}</span>
                  ) : null}
                </div>
                {phi ? (
                  <div style={{ marginTop: 3, fontSize: 11, color: INK600 }}>
                    {phi.patient_name ?? '—'}{phi.group_number ? ` · Grp ${phi.group_number}` : ''}
                  </div>
                ) : null}
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: INK600 }}>
                  {/* Payment date (the sort axis) leads; DOS (service date) follows, de-emphasized — same
                      two dates the desktop table shows, so the payment-date order reads plainly. */}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span className="ths-num">Paid {c.paymentDate ?? '—'}</span>
                    <span style={{ color: INK400 }}> · DOS {c.dos ?? '—'}</span>
                  </span>
                  {/* Color by the ROW'S OWN allowed% (mobileBucketStyle → ratingBucket 50/30), NOT the
                      parent facility rating — desktop parity (900e084). null → neutral. */}
                  <span className="ths-num" style={{ flexShrink: 0, color: mobileBucketStyle(c.pctAllowedOfBilled).color }}>{c.pctAllowedOfBilled === null ? '—' : `${Math.round(c.pctAllowedOfBilled)}% allowed`}</span>
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
