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
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup. Imports are
 * relative + type-only where possible so the render test runs under tsx without `@/` resolution.
 */
import { ratingBucket, RATING_LEGEND, type RatingBucket } from '../../lib/qualify/rating';
import { bucketClass } from './colors';
import type { QualifyFacility } from '../../lib/qualify/contract';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const LEGEND_BUCKETS: readonly Exclude<RatingBucket, 'neutral'>[] = ['ok', 'warn', 'danger'];

export function FacilityPanel({
  facilities,
  hasAmounts,
  heatOn,
}: {
  facilities: readonly QualifyFacility[];
  hasAmounts: boolean;
  heatOn: boolean;
}) {
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-baseline justify-between px-4 pb-2.5 pt-4">
        <h2 className="font-head text-base font-semibold">Heating up</h2>
        <span className="text-xs font-semibold text-muted-foreground">by reimbursement rating · top 10</span>
      </div>

      <div className={['px-2.5 pb-3', heatOn ? 'q-heat' : ''].join(' ')}>
        {facilities.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No facilities for this payer in the selected window.
          </p>
        ) : (
          facilities.slice(0, 10).map((f) => {
            const bucket = ratingBucket(f.rating);
            const pct = f.pctAllowedOfBilled;
            const width = pct === null ? 0 : Math.max(0, Math.min(100, pct));
            const loc = [f.city, f.state].filter(Boolean).join(', ');
            return (
              <div
                key={f.rank}
                className={['q-fac', bucketClass(bucket), 'mb-0.5 rounded-lg px-2 py-2.5'].join(' ')}
                title={f.rating === null ? 'No rating — insufficient data' : `Rating ${Math.round(f.rating)} · rank ${f.rank}`}
              >
                <div className="flex items-center justify-between gap-2.5">
                  <span className="flex items-center gap-2 text-[13.5px] font-semibold text-ink900">
                    <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-teal50 text-[11px] font-bold text-teal700">
                      {f.rank}
                    </span>
                    {f.name}
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
              </div>
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
      <p className="px-4 pb-3 text-[11px] text-muted-foreground">{RATING_LEGEND.description}</p>
    </section>
  );
}
