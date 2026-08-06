'use client';

/**
 * Qualify OVERVIEW strip (redesign) — the "book at a glance" above the resolved payer:
 *
 *   1. BookKpiTiles — the three book-wide KPI gradient tiles (% allowed of billed · % paid of
 *      allowed · % paid of billed). PERCENTAGES ONLY (the contract never carries the dollar sums, so
 *      the tiles are identical for every role). Book-wide by design: the LOC lens does NOT re-scope
 *      them (ruled view-only v1) — a caption says so whenever the lens is active. A null ratio
 *      renders "—" (a collapsed denominator is never a fabricated 0%).
 *
 *   2. EvidenceGauge — the sample-strength pips + verdict for one facility.
 *
 * "Facilities Heating Up" (HeatingUpCards / HeatingUpSkeleton) used to live here and MOVED 2026-08-06
 * to ./shared/heating-ticker.tsx — the v3 staged flow mounts the ticker but deliberately keeps these
 * book-wide tiles behind a disclosure, and one module serving both would have pulled the tiles into
 * v3's bundle.
 *
 * Pure/presentational — no hooks at all now, so every component renders hermetically in the tests.
 * Imports are relative so the render test runs under tsx without `@/` resolution.
 */
import { ratingSampleTier, ratingEvidencePips } from '../../lib/qualify/sampleGate';
import type { QualifyBookKpis } from '../../lib/qualify/contract';
import { NO_TILE_FLANKS, type QualifyTileFlanks, type QualifyTileMetric } from '../../lib/qualify/tileFlanks';
import { staggerDelayMs } from './tokens';

function pctText(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}`;
}

export function BookKpiTiles({
  kpis,
  locActive,
  scopeLabel = null,
  flanks = NO_TILE_FLANKS,
  flankSource = null,
}: {
  kpis: QualifyBookKpis | null;
  locActive: boolean;
  /** When set (a resolved payer), the tiles are scoped to that subject — the caption names it instead
   *  of "book-wide". Null = the fresh, unresolved landing (book-wide). */
  scopeLabel?: string | null;
  /** Worst/best facility PER TILE, each on that tile's own metric (deriveTileFlanks). A null entry =
   *  fewer than two facilities carry that metric above the sample floor, or the set is flat. */
  flanks?: QualifyTileFlanks;
  /** What population the flanks are drawn FROM — printed under them. The ranking that produces the
   *  flanks and the KPI query that produces the headline can be different populations, so the set is
   *  named rather than implied. Null suppresses the flanks entirely: an unlabelled range would be the
   *  parts-vs-whole defect this caption exists to close. */
  flankSource?: string | null;
}) {
  // The tiles either read book-wide (landing) or are scoped to the composed payer + facility set.
  const scope = scopeLabel ?? 'book-wide';
  // SAMPLE GATE (Phase 2, sampleGate.ts): the composed slice can be thin (median ~2 patients under a
  // payer). Gate the tiles by distinct patients so a confident % never renders off 1-2 people. Only once
  // kpis has LOADED (null = still fetching → keep the '—' skeleton, never a false "insufficient" flash).
  const tier = kpis ? ratingSampleTier(kpis.distinctPatients) : 'full';
  const patients = kpis?.distinctPatients ?? 0;
  const insufficient = tier === 'insufficient';
  const tierNote =
    tier === 'insufficient'
      ? ` · insufficient data (${patients} patient${patients === 1 ? '' : 's'})`
      : tier === 'thin'
        ? ` · thin sample (${patients} patient${patients === 1 ? '' : 's'})`
        : '';
  const tiles: { key: QualifyTileMetric; tone: 'g' | 'a'; label: string; value: number | null; caption: string }[] = [
    {
      key: 'allowed',
      tone: 'g',
      label: '% allowed of billed',
      value: kpis?.pctAllowedOfBilled ?? null,
      caption: `${scope} · reliable allowed ÷ billed`,
    },
    {
      key: 'paidOfAllowed',
      tone: 'a',
      label: '% paid of allowed',
      value: kpis?.pctPaidOfAllowed ?? null,
      caption: `${scope} · payer paid ÷ allowed`,
    },
    {
      key: 'paidOfBilled',
      tone: 'a',
      label: '% paid of billed',
      value: kpis?.pctPaidOfBilled ?? null,
      caption: `${scope} · net realization`,
    },
  ];
  // ONE gate for every tile's flanks: a source must be named, and the headline sample must be good
  // enough to bracket. Per-tile the spread can still be null (thin coverage on that metric alone).
  const flanksOn = flankSource !== null && !insufficient;
  return (
    <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-3">
      {tiles.map((t, i) => (
        <div
          key={t.key}
          className={[
            t.tone === 'g' ? 'q-kpi-g' : 'q-kpi-a',
            'animate-ths-reveal relative overflow-hidden rounded-2xl border border-line px-5 py-4 shadow-ths-sm',
          ].join(' ')}
          style={{ animationDelay: `${staggerDelayMs(i)}ms` }}
        >
          <div className="text-[12.5px] font-semibold text-ink600">{t.label}</div>
          <div
            className={[
              'mt-2 flex items-baseline font-mono text-4xl font-semibold leading-none tabular-nums',
              // Insufficient sample → neutral (no confident color/number); else the tone color.
              insufficient ? 'text-ink400' : t.tone === 'g' ? 'text-status-ok' : 'text-status-warn',
            ].join(' ')}
          >
            {insufficient ? '—' : pctText(t.value)}
            {!insufficient && t.value !== null ? <span className="ml-0.5 text-lg">%</span> : null}
          </div>
          {/* THE FLANKS (prototype `spreadFor`): the facilities that SET the range ON THIS TILE'S OWN
              METRIC. All three tiles carry them now — each read from that facility's own
              pctAllowedOfBilled / pctPaidOfAllowed / pctPaidOfBilled, computed server-side by the same
              expressions as the headline. `flankSource` names the set they come from, because the
              ranking and the KPI query are not always the same population and an unlabelled range
              would be the parts contradicting the whole. */}
          {flanksOn && flanks[t.key] ? (
            <div className="mt-2.5">
              <div className="flex items-stretch gap-2">
                {[flanks[t.key]!.worst, flanks[t.key]!.best].map((end) => (
                  <div
                    key={end.label}
                    className="min-w-0 flex-1 border-l-2 pl-2"
                    style={{ borderColor: end.label === 'Best' ? '#2E8B6F' : '#C0453B' }}
                  >
                    <div className="flex items-baseline gap-1">
                      <span className="text-[8.5px] font-extrabold uppercase tracking-[0.08em] text-ink400">{end.label}</span>
                      <span
                        className="font-mono text-[12.5px] font-semibold tabular-nums"
                        style={{ color: end.label === 'Best' ? '#2E8B6F' : '#C0453B' }}
                      >
                        {end.value}%
                      </span>
                    </div>
                    <div className="truncate text-[9.5px] leading-tight text-ink400" title={end.who}>
                      {end.who}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-1 text-[9.5px] leading-tight text-ink400">range {flankSource}</div>
            </div>
          ) : null}
          <div className="mt-2 text-[11px] text-ink400">
            {t.caption}
            {tierNote}
            {locActive ? ' · not LOC-scoped' : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * EVIDENCE GAUGE — four ascending pips that FILL as the composed match's distinct-CLIENT count climbs
 * (ratingEvidencePips, sampleGate.ts), beside a plain-text count. ONE COLOUR: evidence is how many pips
 * are SOLID vs HOLLOW (dashed edge), NEVER a hue — so it reads in greyscale, for colour-blind viewers,
 * and on the dark bar. `variant`: 'dark' = the teal900 readout bar (teal200 solids on a divided cell);
 * 'ink' = a light surface (teal700 solids). The <div> is role=img with the count + verdict as its label;
 * the pips are decorative (aria-hidden) since the same facts are in the adjacent text. Pure/hermetic.
 */
const PIP_HEIGHT = ['h-[7px]', 'h-[10px]', 'h-[13.5px]', 'h-[17px]'] as const;

export function EvidenceGauge({
  distinctPatients,
  variant = 'dark',
}: {
  distinctPatients: number;
  variant?: 'dark' | 'ink';
}) {
  const n = Number.isFinite(distinctPatients) && distinctPatients > 0 ? Math.trunc(distinctPatients) : 0;
  const pips = ratingEvidencePips(n);
  const tier = ratingSampleTier(n);
  const verdict = n === 0 ? 'no matches yet' : tier === 'full' ? 'enough to rate' : tier === 'thin' ? 'directional only' : 'not enough to rate';
  const ink = variant === 'ink';
  return (
    <div
      className={['flex items-center gap-2.5', ink ? '' : 'border-l border-white/15 pl-4'].join(' ')}
      role="img"
      aria-label={`${n.toLocaleString('en-US')} distinct client${n === 1 ? '' : 's'} — ${verdict}`}
    >
      <div aria-hidden className="flex h-[17px] items-end gap-[3px]">
        {[0, 1, 2, 3].map((i) => {
          const on = i < pips;
          return (
            <span
              key={i}
              className={[
                'w-[5px] rounded-[1.5px] border',
                PIP_HEIGHT[i],
                on
                  ? ink
                    ? 'border-teal700 bg-teal700'
                    : 'border-teal200 bg-teal200'
                  : ink
                    ? 'border-dashed border-ink400/40 bg-transparent'
                    : 'border-dashed border-white/35 bg-transparent',
              ].join(' ')}
            />
          );
        })}
      </div>
      <span className={['text-[11.5px] leading-tight', ink ? 'text-ink400' : 'text-white/70'].join(' ')}>
        <b className={['block text-[12px] font-semibold', ink ? 'text-ink900' : 'text-white'].join(' ')}>
          {n.toLocaleString('en-US')} client{n === 1 ? '' : 's'}
        </b>
        {verdict}
      </span>
    </div>
  );
}

/* "Facilities Heating Up" (HeatingUpCards + HeatingUpSkeleton) MOVED 2026-08-06 to
   ./shared/heating-ticker.tsx, so the v3 staged flow can mount the strip without also importing the
   book KPI tiles it deliberately keeps behind a disclosure. Import it from there, not from here. */
