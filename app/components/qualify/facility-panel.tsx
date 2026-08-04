'use client';

/**
 * Qualify — facility panel. Ranked cross-tenant facility list for the resolved payer.
 *
 * COLOR = RATING (rulings Q-G / R-RATING): the left border, %-number tint, and bar fill all derive
 * from `ratingBucket(f.rating)` — the value-first allowed% (rating.ts) — NOT the raw pct. The
 * displayed number and bar width ARE the raw pctAllowedOfBilled (the human-meaningful "% allowed of
 * billed"); the row title surfaces the rating so the rank order is explainable. Legend copy comes
 * from RATING_LEGEND.
 *
 * SAMPLE GATE (hotfix 2026-07-27, sampleGate.ts): the rating carries NO volume term, but under a
 * payer slice the median facility rests on ~2 distinct patients — a confident color on 1-2 patients
 * is sampling noise dressed as signal. So the DISPLAY (not the score) is tiered by distinct patients:
 * < 3 → no bucket color / no confident %, an explicit "insufficient data" state (the row is still
 * listed, since dropping it reads as "no data at all"); 3-9 → the rating shows, flagged a thin
 * sample; >= 10 → unchanged. The patient count is surfaced so the user sees what the judgment rests
 * on. This panel is always payer-wide (never identifier-scoped), so the gate always applies here.
 *
 * AMOUNTS: the `$allowed / $billed` line renders ONLY when the viewer has the amounts capability AND
 * both values are non-null — the elements are OMITTED from the DOM otherwise (the server has already
 * nulled them; this is belt-and-suspenders, never CSS-hiding a shipped value).
 *
 * SELECTION (compose bar): each facility row toggles that facility in the COMPOSE FILTER. Selecting a
 * row HIGHLIGHTS it (adds it to the filter set at right); it NEVER filters/intersects this ranking. The
 * ranking stays PAYER-WIDE ACROSS THE BOOK on purpose — restricting it to facilities the user already
 * picked could only show them what they already chose. `selectedKeys` (matched against `facilityKey`,
 * the raw rollup join text) marks EVERY selected row pressed (several can be pressed at once);
 * `onToggle(facilityKey)` adds/removes it. Both optional so the render test can mount hermetically.
 *
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup. Imports are
 * relative + type-only where possible so the render test runs under tsx without `@/` resolution.
 */
import { ratingBucket, RATING_LEGEND, type RatingBucket } from '../../lib/qualify/rating';
import { ratingSampleTier, ratingEvidencePips, QUALIFY_RATING_MIN_PATIENTS } from '../../lib/qualify/sampleGate';
import { IQ_BAND_LABELS, IQ_BAND_VERDICTS, PROVENANCE_LABELS, facilityFactorsDisagree } from '../../lib/qualify/ratingV2';
import { CONFIDENCE_LEGEND, type QualifyConfidence } from '../../lib/qualify/confidence';
import { bucketClass, confidenceClass, iqBandClass } from './colors';
import type { QualifyFacility, QualifyFactorReading, QualifyProvenance } from '../../lib/qualify/contract';

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

/** Factor direction → arrow + color (the scorecard vocabulary; matches the prototype's ▲/▼/―). */
const DIR_META: Record<QualifyFactorReading['direction'], { arrow: string; label: string; cls: string; bar: string }> = {
  pos: { arrow: '▲', label: 'helps', cls: 'text-status-ok', bar: '#2E8B6F' },
  neg: { arrow: '▼', label: 'hurts', cls: 'text-status-danger', bar: '#C0453B' },
  neu: { arrow: '―', label: 'neutral', cls: 'text-ink400', bar: '#C3CDC9' },
};

/** The thin stacked WEIGHT bar — composition at a glance (§5): each factor's nominal weight as a
 *  segment, colored by direction; an unavailable factor renders as an empty (line-colored) span so
 *  the renormalization is visible, not hidden. */
function WeightBar({ factors }: { factors: readonly QualifyFactorReading[] }) {
  if (factors.length === 0) return null;
  return (
    <div className="flex h-[5px] overflow-hidden rounded-full bg-line" aria-hidden>
      {factors.map((x) => (
        <span
          key={x.key}
          title={`${x.label} · ${x.weight}% · ${x.available ? DIR_META[x.direction].label : 'no data yet'}`}
          style={{
            width: `${x.weight}%`,
            background: x.available ? DIR_META[x.direction].bar : 'transparent',
            borderRight: '1px solid rgba(255,255,255,.7)',
          }}
          className="block h-full"
        />
      ))}
    </div>
  );
}

/** Evidence pips (sampleGate breakpoints) — 4 slots, filled by sample strength. */
function EvidencePips({ patients }: { patients: number }) {
  const filled = ratingEvidencePips(patients);
  const HEIGHTS = ['7px', '10px', '13px', '16px'];
  return (
    <span className="inline-flex items-end gap-[3px]" style={{ height: 16 }} aria-hidden>
      {HEIGHTS.map((h, i) => (
        <span
          key={i}
          className="inline-block w-[4px] rounded-[2px]"
          style={{
            height: h,
            background: i < filled ? '#135E5A' : 'transparent',
            border: `1px ${i < filled ? 'solid #135E5A' : 'dashed rgba(99,117,110,.45)'}`,
          }}
        />
      ))}
    </span>
  );
}

/** The expanded "Why this score" factor list — ships the server-computed work verbatim (§5): each
 *  factor's weight, direction, and plain-language detail. Non-dollar by construction. */
function FactorList({ f }: { f: QualifyFacility }) {
  return (
    <div className="mt-1 rounded-xl border border-line bg-ground px-3 py-1">
      {f.factors.map((x) => (
        <div key={x.key} className="flex items-start gap-2.5 border-b border-line py-2 last:border-b-0">
          <span className={['mt-px w-4 shrink-0 text-center text-[11px] font-bold', x.available ? DIR_META[x.direction].cls : 'text-ink400'].join(' ')} aria-hidden>
            {x.available ? DIR_META[x.direction].arrow : '·'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2">
              <b className="text-[12.5px] font-semibold text-ink900">{x.label}</b>
              <span className={['text-[10.5px] font-bold', x.available ? DIR_META[x.direction].cls : 'text-ink400'].join(' ')}>
                {x.available ? DIR_META[x.direction].label : 'no data yet'}
              </span>
            </span>
            <span className="block text-[11.5px] leading-snug text-ink600">{x.detail}</span>
          </span>
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink400">{x.weight}%</span>
        </div>
      ))}
      <p className="py-1.5 text-[10.5px] text-ink400">
        Scored on {f.availableWeight} of 100 weighting — factors without data are excluded, never guessed.
      </p>
    </div>
  );
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export function FacilityPanel({
  facilities,
  hasAmounts,
  heatOn,
  selectedKeys = EMPTY_KEYS,
  onToggle,
  payerLabel = null,
  expandedKeys = EMPTY_KEYS,
  onExpandToggle,
  provenance = 'direct',
}: {
  facilities: readonly QualifyFacility[];
  hasAmounts: boolean;
  heatOn: boolean;
  /** facilityKeys currently in the compose filter — EVERY matching row reads pressed (several at once).
   *  Selecting HIGHLIGHTS; it never filters this ranking (which stays payer-wide across the book). */
  selectedKeys?: ReadonlySet<string>;
  /** Toggle this facility in the compose filter (add/remove its raw rollup facilityKey). Optional for tests. */
  onToggle?: (facilityKey: string) => void;
  /** The single resolved payer this ranking is for — named in the header next to "payer-wide across the
   *  book" so the ranking is never mistaken for the filtered match count above it. */
  payerLabel?: string | null;
  /** v2 scorecard expansion state (parent-held so this stays hook-free/hermetic): facilityKeys whose
   *  "Why this score" factor list is open. */
  expandedKeys?: ReadonlySet<string>;
  onExpandToggle?: (facilityKey: string) => void;
  /** What this ranking's evidence is built ON (§6). comparable_* renders the ESTIMATED treatment —
   *  dashed cards + an explicit banner — so nobody mistakes a cohort read for direct evidence. */
  provenance?: QualifyProvenance;
}) {
  const visible = facilities; // ALWAYS the full payer-wide ranking — selection highlights, never filters
  const estimated = provenance === 'comparable_employer' || provenance === 'comparable_funding';
  return (
    <section className={['rounded-2xl border bg-card shadow-ths-sm', estimated ? 'border-dashed border-teal200' : ''].join(' ')}>
      {/* The panel sizes to its OWN content and is NOT co-height with the "Recent cases" panel: the grid
          cell is `items-start`, so this card's height is driven by its facility list, never capped to the
          cases panel. All facilities render inline with no internal scroll — you never have to scroll
          within the card to reach a facility that the shorter neighboring panel would otherwise hide. */}
      <div className="contents">
      <div className="flex items-center justify-between gap-2 px-4 pb-2.5 pt-4">
        <h2 className="font-head text-base font-semibold tracking-tight">Facilities</h2>
        <span className="text-xs font-semibold text-muted-foreground">
          by reimbursement rating
          {facilities.length > 0 ? ` · ${facilities.length} ${facilities.length === 1 ? 'facility' : 'facilities'}` : ''}
        </span>
      </div>
      {estimated ? (
        <p className="mx-4 mb-1 rounded-lg border border-dashed border-teal200 bg-teal50/50 px-2.5 py-1.5 text-[11.5px] font-semibold text-teal700">
          Estimated — {PROVENANCE_LABELS[provenance]}. Directional, not confirmed; this plan has no claims of its own yet.
        </p>
      ) : null}
      {/* This ranking is PAYER-WIDE across the whole book — NOT the filtered match count above. Tapping a
          row adds that facility to the filter (highlight), it never narrows this list. */}
      <p className="px-4 pb-1 text-[11px] text-muted-foreground">
        {payerLabel ? <b className="font-semibold text-ink600">{payerLabel}</b> : 'This payer'} · payer-wide across the
        book · tap a facility to add it to your filter
      </p>

      {/* ALL facilities render (server returns the full set, no LIMIT); the cap is gone. */}
      <div className={['px-2.5 pb-3', heatOn ? 'q-heat' : ''].join(' ')}>
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No facilities for this payer in the selected window.
          </p>
        ) : (
          visible.map((f) => {
            // SAMPLE GATE (hotfix 2026-07-27): tier by distinct patients, then suppress the color at
            // 'insufficient'. The score (f.rating) is untouched — only the DISPLAY bucket + pct are gated.
            const tier = ratingSampleTier(f.distinctPatients);
            const bucket = tier === 'insufficient' ? 'neutral' : ratingBucket(f.rating);
            const showPct = tier !== 'insufficient';
            const pct = f.pctAllowedOfBilled;
            const loc = [f.city, f.state].filter(Boolean).join(', ');
            const selected = selectedKeys.has(f.facilityKey);
            const expanded = expandedKeys.has(f.facilityKey);
            const unrated = f.ratingV2 === null;
            // Only meaningful on a card that shows a number: an unrated/suppressed card has no
            // blended figure for a disagreement to be hiding behind.
            const factorsDisagree = !unrated && tier !== 'insufficient' && facilityFactorsDisagree(f.factors);
            // v2 paint: the left border + verdict block color from the IQ band; the legacy bucket
            // still grades the secondary confirmed-% line via a nested span class.
            const paint = unrated || tier === 'insufficient' ? 'q-neutral' : iqBandClass(f.iqBand);
            void bucket; // legacy bucket retained for the pct tint below
            return (
              <div
                key={f.rank}
                className={[
                  'q-fac',
                  paint,
                  'mb-0.5 rounded-lg px-2 py-2.5 transition-colors',
                  selected ? 'bg-teal50 ring-2 ring-teal500' : '',
                ].join(' ')}
              >
                <button
                  type="button"
                  onClick={() => onToggle?.(f.facilityKey)}
                  aria-pressed={selected}
                  className="block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
                  title={
                    tier === 'insufficient'
                      ? `Insufficient data — only ${f.distinctPatients} patient${f.distinctPatients === 1 ? '' : 's'} in this slice`
                      : unrated
                        ? 'No rating — insufficient evidence'
                        : `Rating ${f.ratingV2} (${IQ_BAND_LABELS[f.iqBand!]}) · rank ${f.rank}`
                  }
                >
                  <div className="flex items-start justify-between gap-2.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink900">
                      <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-teal50 text-[11px] font-bold text-teal700">
                        {f.rank}
                      </span>
                      {f.name}
                      {f.careSetting ? (
                        <span className="inline-flex shrink-0 items-center rounded-full bg-[#e4f0f5] px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-status-info">
                          {LOC_LABEL[f.careSetting]}
                        </span>
                      ) : null}
                      {tier === 'insufficient' ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-full border border-line bg-surface px-1.5 py-px text-[10px] font-semibold text-ink400"
                          title={`Only ${f.distinctPatients} patient${f.distinctPatients === 1 ? '' : 's'} back this rating — not enough to score this slice`}
                        >
                          insufficient data
                        </span>
                      ) : tier === 'thin' ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-full border border-line bg-surface px-1.5 py-px text-[10px] font-semibold text-ink400"
                          title={`Only ${f.distinctPatients} patients back this rating — treat as an early signal`}
                        >
                          thin sample
                        </span>
                      ) : null}
                      {/* FACTORS DISAGREE — the case a single blended numeral hides (strong allowed
                          rate, terrible aging). Badged so the rep opens the reasoning rather than
                          reading a mid-band number and moving on. Coral, because it is the one thing
                          on this card that says "the number alone is not the answer". */}
                      {factorsDisagree ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-full border border-[#F0917C] bg-[#FCEDE8] px-1.5 py-px text-[10px] font-semibold text-status-danger"
                          title="At least one factor reads positive and another reads negative — the blended rating hides that. Open “Why this score”."
                        >
                          factors disagree
                        </span>
                      ) : null}
                      {f.nextUrDate ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-full border border-[#F0917C] bg-[#FCEDE8] px-1.5 py-px text-[10px] font-semibold text-status-danger"
                          title="A utilization review is scheduled on this facility's census — authorization may change"
                        >
                          UR {f.nextUrDate}
                        </span>
                      ) : null}
                      {f.openBeds !== null && f.openBeds > 0 ? (
                        <span className="inline-flex shrink-0 items-center rounded-full border border-line bg-surface px-1.5 py-px text-[10px] font-semibold text-ink600">
                          {f.openBeds} open bed{f.openBeds === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </span>
                    {/* v2 VERDICT block: the one big display numeral + the IQ band pill (the billing
                        team's own 65/50/30/15/0 scale); the confirmed-% is the secondary metric. */}
                    {/* THE VERDICT DOMINATES (2026-08-04). Was a 26px numeral sized for the old fixed
                        380px column, where it read as just another number in a dense row; the whole
                        point of this card is that the rep sees one figure from across the desk. The
                        supporting metrics recede beneath it. */}
                    <span className="shrink-0 text-right">
                      <span className="q-pct block font-display text-[38px] font-semibold leading-[0.9] tabular-nums min-[720px]:text-[52px]">
                        {unrated || tier === 'insufficient' ? '—' : f.ratingV2}
                      </span>
                      <span className="mt-1 inline-flex items-center gap-1">
                        {!unrated && tier !== 'insufficient' && f.iqBand ? (
                          <span
                            className="inline-flex items-center rounded-full px-2 py-[2px] text-[10.5px] font-bold"
                            style={{ background: 'var(--q-wash)', color: 'var(--q-c)' }}
                          >
                            {IQ_BAND_VERDICTS[f.iqBand]} · {IQ_BAND_LABELS[f.iqBand]}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-line px-2 py-[2px] text-[10.5px] font-bold text-ink400">
                            Not rated
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-[11px] tabular-nums text-ink400">
                        {showPct && pct !== null ? `${Math.round(pct)}% allowed` : ''}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11.5px]">
                    <span className="flex items-center gap-1.5 text-ink400">
                      <EvidencePips patients={f.distinctPatients} />
                      {loc || ' '}
                      {f.entity ? <span className="text-[10px] font-semibold">· {f.entity}</span> : null}
                    </span>
                    {hasAmounts && f.allowedAmount !== null && f.billedAmount !== null ? (
                      <span className="tabular-nums text-muted-foreground">
                        {usd0(f.allowedAmount)} / {usd0(f.billedAmount)}
                      </span>
                    ) : null}
                  </div>
                  {/* ONE bar per card (Alec's surgical ruling, 2026-07-22): the 0059 COVERAGE bar —
                      confirmed / estimate / unknown segments, captioned below. The rating already
                      EXCLUDES the estimate segment (ruling Q2a) — this shows that honestly. */}
                  <div className="mt-[7px] flex h-[5px] overflow-hidden rounded-full bg-line" aria-hidden>
                    <CoverageSegment conf="confirmed" count={f.confirmedClaims} total={f.lineCount} />
                    <CoverageSegment conf="estimate" count={f.estimateClaims} total={f.lineCount} />
                    <CoverageSegment conf="unknown" count={f.unknownClaims} total={f.lineCount} />
                  </div>
                  <p className="mt-1 text-[10.5px] text-ink400">
                    Rated on {f.confirmedClaims} of {f.lineCount} claims · {f.distinctPatients} patient{f.distinctPatients === 1 ? '' : 's'}
                  </p>
                </button>
                {/* v2 "Why this score": the WEIGHT bar always shows (composition at a glance, §5);
                    the factor list expands via parent-held state. Insufficient tier expands to the
                    honest-restraint copy — restraint is a designed state, never an error. */}
                {f.factors.length > 0 ? (
                  <>
                    <div className="mt-1.5">
                      <WeightBar factors={f.factors} />
                    </div>
                    <button
                      type="button"
                      onClick={() => onExpandToggle?.(f.facilityKey)}
                      aria-expanded={expanded}
                      className="mt-1 flex w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[11px] font-semibold text-teal700 transition-colors hover:bg-teal50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
                    >
                      <span aria-hidden className="inline-block transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
                        ›
                      </span>
                      {expanded ? 'Hide the reasoning' : 'Why this score'}
                      <span className="ml-auto font-normal text-ink400">
                        {tier === 'insufficient' ? 'what we do have' : `${f.factors.filter((x) => x.available).length} of ${f.factors.length} factors live`}
                      </span>
                    </button>
                    {expanded ? (
                      tier === 'insufficient' ? (
                        <div className="mt-1 rounded-xl border border-dashed border-line bg-[#F4F2EF] px-3 py-2.5">
                          <p className="text-[12.5px] font-semibold text-ink600">Not enough data to rate</p>
                          <p className="mt-0.5 text-[11.5px] leading-snug text-ink400">
                            {f.distinctPatients} patient{f.distinctPatients === 1 ? '' : 's'} in this window — the floor is{' '}
                            {QUALIFY_RATING_MIN_PATIENTS} to show a number at all. A number built on that would be noise
                            wearing a color. Ask a biller.
                          </p>
                          <FactorList f={f} />
                        </div>
                      ) : (
                        <FactorList f={f} />
                      )
                    ) : null}
                  </>
                ) : null}
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
