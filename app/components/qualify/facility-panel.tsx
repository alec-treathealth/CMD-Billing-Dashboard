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
}: {
  facilities: readonly QualifyFacility[];
  hasAmounts: boolean;
  heatOn: boolean;
  /** facilityKey of the row currently driving the cases panel (null before any select). */
  selectedKey?: string | null;
  /** Re-scope the cases panel to this facility (its raw rollup facilityKey). Optional for tests. */
  onSelect?: (facilityKey: string) => void;
}) {
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      {/* The panel sizes to its OWN content and is NOT co-height with the "Recent cases" panel: the grid
          cell is `items-start`, so this card's height is driven by its facility list, never capped to the
          cases panel. All facilities render inline with no internal scroll — you never have to scroll
          within the card to reach a facility that the shorter neighboring panel would otherwise hide. */}
      <div className="contents">
      <div className="flex items-baseline justify-between px-4 pb-2.5 pt-4">
        <h2 className="font-display text-base font-semibold">Heating up</h2>
        <span className="text-xs font-semibold text-muted-foreground">
          by reimbursement rating
          {facilities.length > 0 ? ` · ${facilities.length} ${facilities.length === 1 ? 'facility' : 'facilities'}` : ''}
        </span>
      </div>

      {/* ALL facilities render (server returns the full set, no LIMIT); the cap is gone. */}
      <div className={['px-2.5 pb-3', heatOn ? 'q-heat' : ''].join(' ')}>
        {facilities.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No facilities for this payer in the selected window.
          </p>
        ) : (
          facilities.map((f) => {
            const bucket = ratingBucket(f.rating);
            const pct = f.pctAllowedOfBilled;
            const width = pct === null ? 0 : Math.max(0, Math.min(100, pct));
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
                  <span className="text-ink400">{loc || ' '}</span>
                  {hasAmounts && f.allowedAmount !== null && f.billedAmount !== null ? (
                    <span className="tabular-nums text-muted-foreground">
                      {usd0(f.allowedAmount)} / {usd0(f.billedAmount)}
                    </span>
                  ) : null}
                </div>
                <div className="q-bar mt-[7px] h-[5px] overflow-hidden rounded-full bg-line">
                  <span className="block h-full rounded-full" style={{ width: `${width}%` }} />
                </div>
                {/* Coverage bar (0059 trust signal): confirmed / estimate / unknown segments. The
                    rating above already EXCLUDES the estimate segment (ruling Q2a) — this bar shows
                    that honestly instead of hiding it. Segments reuse the q-class palette (amber
                    estimate is never green). */}
                <div className="mt-[5px] flex h-[4px] overflow-hidden rounded-full bg-line" aria-hidden>
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
