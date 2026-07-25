'use client';

/**
 * Qualify — facility panel. Ranked cross-tenant facility list for the resolved payer.
 *
 * COLOR = RATING (rulings Q-G / R-RATING): the left border, %-number tint, and bar fill all derive
 * from `ratingBucket(f.rating)` — the volume-dampened value — NOT the raw pct. The displayed number
 * and bar width ARE the raw pctAllowedOfBilled (the human-meaningful "% allowed of billed"), so a
 * high pct on tiny volume can legitimately show a big number in an amber/red row; the row title
 * surfaces the rating so the rank order is explainable. Legend copy comes from RATING_LEGEND.
 *
 * AMOUNTS: the `$allowed / $billed` line renders ONLY when the viewer has the amounts capability AND
 * both values are non-null — the elements are OMITTED from the DOM otherwise (the server has already
 * nulled them; this is belt-and-suspenders, never CSS-hiding a shipped value).
 *
 * SELECTION: each facility row is a button that drives the per-facility cases drill (ruling Q-4 /
 * Prompt-4 finding #4 — "last 15 claims" is scoped to the SELECTED facility, not the payer overall).
 * `selectedKey` (matched against `facilityKey`, the raw rollup join text) marks the active row;
 * `onSelect(facilityKey)` re-scopes the cases panel. Both are optional so the render test can mount
 * the panel hermetically with no handler; the container always supplies them.
 *
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup. Imports are
 * relative + type-only where possible so the render test runs under tsx without `@/` resolution.
 */
import { ratingBucket, RATING_LEGEND, QUALIFY_LIMITED_DATA_LINES, type RatingBucket } from '../../lib/qualify/rating';
import { CONFIDENCE_LEGEND, type QualifyConfidence } from '../../lib/qualify/confidence';
import { bucketClass, confidenceClass } from './colors';
import type { QualifyFacility } from '../../lib/qualify/contract';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const LEGEND_BUCKETS: readonly Exclude<RatingBucket, 'neutral'>[] = ['ok', 'warn', 'danger'];
const LEGEND_CONFIDENCE: readonly QualifyConfidence[] = ['confirmed', 'estimate', 'unknown'];
/** careSetting → the tag text (BOTH renders as "Both" — a tag, not shouting). */
const LOC_LABEL: Record<'IP' | 'OP' | 'BOTH', string> = { IP: 'IP', OP: 'OP', BOTH: 'Both' };

/** One segment of the 3-part coverage bar — q-dot paints from the confidence q-class's --q-c. */
function CoverageSegment({ conf, count, total }: { conf: QualifyConfidence; count: number; total: number }) {
  if (count <= 0 || total <= 0) return null;
  return (
    <span
      className={['q-dot', confidenceClass(conf), 'block h-full'].join(' ')}
      style={{ width: `${(count / total) * 100}%` }}
    />
  );
}

export function FacilityPanel({
  facilities,
  hasAmounts,
  heatOn,
  selectedKey = null,
  onSelect,
  pinned = false,
  onClearPin,
  scopeNote = null,
}: {
  facilities: readonly QualifyFacility[];
  hasAmounts: boolean;
  heatOn: boolean;
  /** facilityKey of the row currently driving the cases panel (null before any select). */
  selectedKey?: string | null;
  /** Re-scope the cases panel to this facility (its raw rollup facilityKey). Optional for tests. */
  onSelect?: (facilityKey: string) => void;
  /** When set (an identifier search), a NON-PHI note that this list is the SEARCHED identifier's
   *  footprint — only facilities that billed it in-window — not the payer's whole book. Shown in list
   *  mode (not when a single facility is pinned). Null on the payer-wide path. */
  scopeNote?: string | null;
  /** Change E — FACILITY-SCOPED mode: render ONLY the selected facility as a pinned summary card
   *  (name, rating, coverage) with the "× All facilities" clear pill — never a fully-collapsed panel. */
  pinned?: boolean;
  /** Clear the Change-E facility scope → back to the full ranked list (payer-wide). */
  onClearPin?: () => void;
}) {
  // Pinned mode shows ONLY the scoped facility; the full ranked list otherwise.
  const visible = pinned && selectedKey !== null ? facilities.filter((f) => f.facilityKey === selectedKey) : facilities;
  return (
    <section className="rounded-2xl border bg-card shadow-ths-sm">
      {/* The panel sizes to its OWN content and is NOT co-height with the "Recent cases" panel: the grid
          cell is `items-start`, so this card's height is driven by its facility list, never capped to the
          cases panel. All facilities render inline with no internal scroll — you never have to scroll
          within the card to reach a facility that the shorter neighboring panel would otherwise hide. */}
      <div className="contents">
      <div className="flex items-center justify-between gap-2 px-4 pb-2.5 pt-4">
        <h2 className="font-head text-base font-semibold tracking-tight">Facilities</h2>
        {pinned && selectedKey !== null ? (
          /* Change E clear-scope affordance: visible pill, ≥44px hit target, focus ring, labeled. */
          <button
            type="button"
            onClick={onClearPin}
            aria-label="Clear facility filter, show all facilities"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-teal200 bg-teal50 px-3.5 text-[12px] font-semibold text-teal700 transition-colors hover:bg-teal200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/50"
          >
            <span aria-hidden>×</span> All facilities
          </button>
        ) : (
          <span className="text-xs font-semibold text-muted-foreground">
            by reimbursement rating
            {facilities.length > 0 ? ` · ${facilities.length} ${facilities.length === 1 ? 'facility' : 'facilities'}` : ''}
          </span>
        )}
      </div>
      {pinned && selectedKey !== null ? (
        <p className="px-4 pb-1 text-[11px] text-muted-foreground">
          Scoped to this facility — cases at right are its recent claims only.
        </p>
      ) : scopeNote ? (
        <p className="px-4 pb-1 text-[11px] font-medium text-teal700">{scopeNote}</p>
      ) : null}

      {/* ALL facilities render (server returns the full set, no LIMIT); the cap is gone. */}
      <div className={['px-2.5 pb-3', heatOn ? 'q-heat' : ''].join(' ')}>
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No facilities for this payer in the selected window.
          </p>
        ) : (
          visible.map((f) => {
            const bucket = ratingBucket(f.rating);
            const pct = f.pctAllowedOfBilled;
            const loc = [f.city, f.state].filter(Boolean).join(', ');
            const selected = selectedKey !== null && f.facilityKey === selectedKey;
            return (
              <button
                key={f.rank}
                type="button"
                onClick={() => onSelect?.(f.facilityKey)}
                aria-pressed={selected}
                className={[
                  'q-fac',
                  bucketClass(bucket),
                  'mb-0.5 block w-full rounded-lg px-2 py-2.5 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
                  selected ? 'bg-teal50 ring-2 ring-teal500' : 'hover:bg-surface',
                ].join(' ')}
                title={f.rating === null ? 'No rating — insufficient data' : `Rating ${Math.round(f.rating)} · rank ${f.rank}`}
              >
                <div className="flex items-center justify-between gap-2.5">
                  <span className="flex items-center gap-2 text-[13.5px] font-semibold text-ink900">
                    <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-teal50 text-[11px] font-bold text-teal700">
                      {f.rank}
                    </span>
                    {f.name}
                    {f.careSetting ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-[#e4f0f5] px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-status-info">
                        {LOC_LABEL[f.careSetting]}
                      </span>
                    ) : null}
                    {f.lineCount < QUALIFY_LIMITED_DATA_LINES ? (
                      <span
                        className="inline-flex shrink-0 items-center rounded-full border border-line bg-surface px-1.5 py-px text-[10px] font-semibold text-ink400"
                        title={`Only ${f.lineCount} claim line${f.lineCount === 1 ? '' : 's'} back this rating — treat as an early signal`}
                      >
                        thin sample
                      </span>
                    ) : null}
                  </span>
                  <span className="q-pct tabular-nums text-[15px] font-semibold">
                    {pct === null ? '—' : `${Math.round(pct)}%`}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[11.5px]">
                  <span className="text-ink400">{loc || ' '}{f.entity ? <span className="ml-1 text-[10px] font-semibold">· {f.entity}</span> : null}</span>
                  {hasAmounts && f.allowedAmount !== null && f.billedAmount !== null ? (
                    <span className="tabular-nums text-muted-foreground">
                      {usd0(f.allowedAmount)} / {usd0(f.billedAmount)}
                    </span>
                  ) : null}
                </div>
                {/* ONE bar per card (Alec's surgical ruling, 2026-07-22 — the old pct-width q-bar is
                    REMOVED; two stacked bars was too much for the end user). The surviving bar is the
                    0059 COVERAGE bar: confirmed / estimate / unknown segments, captioned below. The
                    rating already EXCLUDES the estimate segment (ruling Q2a) — this shows that
                    honestly. The pct itself lives in the top-right number (q-pct, rating-colored). */}
                <div className="mt-[7px] flex h-[5px] overflow-hidden rounded-full bg-line" aria-hidden>
                  <CoverageSegment conf="confirmed" count={f.confirmedClaims} total={f.lineCount} />
                  <CoverageSegment conf="estimate" count={f.estimateClaims} total={f.lineCount} />
                  <CoverageSegment conf="unknown" count={f.unknownClaims} total={f.lineCount} />
                </div>
                <p className="mt-1 text-[10.5px] text-ink400">
                  Rated on {f.confirmedClaims} of {f.lineCount} claims
                </p>
              </button>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap gap-3.5 border-t px-4 py-3 text-[11.5px] text-muted-foreground">
        {LEGEND_BUCKETS.map((b) => (
          <span key={b} className="inline-flex items-center gap-1.5">
            <span className={['q-dot', bucketClass(b), 'inline-block h-2.5 w-2.5 rounded-full'].join(' ')} />
            {RATING_LEGEND.labels[b]}
          </span>
        ))}
      </div>
      <p className="px-4 pb-2 text-[11px] text-muted-foreground">{RATING_LEGEND.description}</p>
      {/* Confidence legend (0059): the coverage-bar vocabulary, shared verbatim with mobile. */}
      <div className="flex flex-wrap gap-3.5 px-4 pb-1 text-[11.5px] text-muted-foreground">
        {LEGEND_CONFIDENCE.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={['q-dot', confidenceClass(k), 'inline-block h-2.5 w-2.5 rounded-full'].join(' ')} />
            {CONFIDENCE_LEGEND.labels[k]}
          </span>
        ))}
      </div>
      <p className="px-4 pb-3 text-[11px] text-muted-foreground">{CONFIDENCE_LEGEND.description}</p>
      </div>
    </section>
  );
}
