'use client';

/**
 * Two compact charts that replace KPI tiles which were spending a whole card on a single number.
 *
 * ── WHY NOT recharts ─────────────────────────────────────────────────────────────────────────────
 * recharts is already a dependency and `pair-drilldown.tsx` uses it correctly — but it colours by
 * passing values into SVG `fill`/`stroke` ATTRIBUTES, which is why that file is the one place the
 * source sweep permits literal hex. These two charts have to live under the sweep's no-hex rule, and
 * per-tenant brand colour here comes from `data-view` on an ancestor resolving `--brand-*`. A CSS
 * variable is reliable in a CSS PROPERTY and shaky in an SVG presentation attribute, so these are
 * built from divs whose widths/heights are the only computed values. No hex, no alpha-on-a-var
 * (`bg-[var(--x)]/20` emits NO rule — a repo-wide guard exists for exactly that), no new dependency.
 *
 * ── INTERACTION ──────────────────────────────────────────────────────────────────────────────────
 * Every bar is a real <button>, so the figures behind it are reachable by keyboard and on touch, not
 * only under a mouse. The active bar's exact numbers render in a live region beneath the chart
 * rather than in a floating tooltip: on a dense finance surface the reader wants to compare two bars
 * without losing the first one's value, and a tooltip that follows the cursor cannot do that.
 */
import { useState } from 'react';

import type { CodePerfBoard, CodePerfPairingRow } from '@/lib/code-performance/contract';
import { describeCodeSlot } from '../../../src/collections/codePerformanceQuery.js';

import { fmtInt, fmtMoney, fmtPct } from './format';
import { MetricHint } from './metric-hint';
import { pairKeyOf } from './pairing-table';

/**
 * Compact identity for a pairing — "H0015 (IOP) × 0905", the table's label without the descriptions.
 *
 * ⚠️ FOR DISPLAY ONLY. `describeCodeSlot` deliberately maps BOTH a null code and the em-dash no-code
 * marker to the same visible label, so two distinct query groups can share this string. React keys
 * come from `pairKeyOf`, which encodes the raw identity with distinct null sentinels (Qodo #350
 * finding 3). A label is not an identity.
 */
function pairLabel(r: CodePerfPairingRow): string {
  const proc = describeCodeSlot('procedure', r.hcpcs).label;
  const rev = describeCodeSlot('revenue', r.revcode).label;
  return `${proc}${r.loc_suffix ? ` (${r.loc_suffix})` : ''} × ${rev}`;
}

function Panel({ title, hint, children }: { title: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-card p-3 shadow-ths">
      {/* ⚠️ h2, NOT h3 (a11y pass 2026-09-10). These panels are top-level sections of the route, and
          the only heading above them is the page's h1 — an h3 here skipped a level, which breaks the
          document outline a screen-reader user navigates by (WCAG 1.3.1 / 2.4.6). The drill-down's
          own h2 sits alongside these and its internal h3s nest under it correctly. Visual size comes
          from the type classes, never from the tag. */}
      <h2 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <MetricHint label={title}>{hint}</MetricHint>
      </h2>
      {children}
    </section>
  );
}

/**
 * TOP PAIRINGS BY BILLED — where the money actually is, which the 44-row table can only show by
 * scrolling. The bar length is billed against the largest pairing; the darker inner segment is
 * collected, so the GAP is the uncollected remainder and needs no second axis to read.
 */
export function TopPairingsChart({ rows, limit = 6 }: { rows: readonly CodePerfPairingRow[]; limit?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const top = [...rows].sort((a, b) => b.billed - a.billed).slice(0, limit);
  const max = top.length > 0 ? Math.max(...top.map((r) => r.billed)) : 0;
  const shown = active !== null ? top[active] : undefined;

  return (
    <Panel
      title={`Top ${top.length} pairings by billed`}
      hint="Bar length is billed against the largest pairing in this window. The darker inner segment is collected, so the pale remainder is what has not come in yet — including charges too young to have been paid."
    >
      {top.length === 0 ? (
        <p className="mt-2 text-xs text-ink600">No charges in this window.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1.5">
            {top.map((r, i) => {
              const billedPct = max > 0 ? (r.billed / max) * 100 : 0;
              const collectedPct = r.billed > 0 ? Math.min(100, (r.collected / r.billed) * 100) : 0;
              return (
                <li key={pairKeyOf(r)}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                    aria-label={`${pairLabel(r)}: billed ${fmtMoney(r.billed)}, collected ${fmtMoney(r.collected)}`}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500"
                  >
                    <span className="ths-num w-40 shrink-0 truncate text-[11px] text-ink600">{pairLabel(r)}</span>
                    <span className="h-3 flex-1 overflow-hidden rounded-full bg-[var(--brand-soft)]">
                      <span className="flex h-full rounded-full bg-[var(--brand-accent)]" style={{ width: `${Math.max(billedPct, 2)}%` }}>
                        <span className="h-full rounded-full bg-[var(--brand-ink)]" style={{ width: `${collectedPct}%` }} />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Live region, not a floating tooltip — see the interaction note in the file header. */}
          <p aria-live="polite" className="ths-num mt-2 min-h-[2.25rem] text-[11px] leading-snug text-ink600">
            {shown ? (
              <>
                <span className="font-semibold text-ink900">{pairLabel(shown)}</span>
                <br />
                billed {fmtMoney(shown.billed)} · collected {fmtMoney(shown.collected)} · {fmtInt(shown.charges)} charges · allowed rate{' '}
                {fmtPct(shown.allowed_rate, 2)}
              </>
            ) : (
              <span className="text-ink400">Hover or tab a bar for its figures.</span>
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * The allowed-rate bands, coarse on purpose — the shape of the distribution, not a precise count.
 *
 * ⚠️ THE SET IS TOTAL OVER THE REALS, AND IT HAS TO BE (Qodo #350 finding 2). The first version ran
 * `[0,20) … [80,101)` while the denominator counted every non-null rate, so a negative rate or one
 * above 101 reached the total and appeared in NO bar — the chart silently disagreed with its own
 * caption. `allowed_rate` is an UNCLAMPED sum-over-sum (`reliable allowed ÷ billed`), and the rollup
 * does not bound allowed by the charge amount, so both are reachable values rather than bad data.
 *
 * So the two edge bands are real bands, not a clamp: values stay unclamped and get shown where they
 * actually fall. They render only when non-empty, because on a healthy tenant they are zero and two
 * permanent empty bars would just be noise.
 */
const CORE_BANDS = [
  { lo: 0, hi: 20 },
  { lo: 20, hi: 40 },
  { lo: 40, hi: 60 },
  { lo: 60, hi: 80 },
  { lo: 80, hi: 100 },
] as const;

/** Band labels, indexed by `yieldBandOf`. Index 0 is underflow and 6 is overflow. */
export const YIELD_BAND_LABELS = ['<0', '0', '20', '40', '60', '80', '>100'] as const;

/**
 * Which band a rate falls in: 0 = below zero, 1-5 = the core bands, 6 = above 100.
 *
 * TOTAL by construction — every finite number returns exactly one index, which is the property the
 * render suite asserts. `[80,100]` is closed at the top so an exactly-100% rate is a core band
 * rather than an overflow; anything strictly above 100 is genuine over-allowed exposure.
 */
export function yieldBandOf(rate: number): number {
  if (rate < 0) return 0;
  if (rate > 100) return 6;
  const i = CORE_BANDS.findIndex((b, idx) => rate >= b.lo && (idx === CORE_BANDS.length - 1 ? rate <= b.hi : rate < b.hi));
  // Unreachable for a finite rate in [0,100]; falls back to the top core band rather than vanishing.
  return i === -1 ? CORE_BANDS.length : i + 1;
}

/**
 * ALLOWED-RATE DISTRIBUTION — one tile said "34.10%" for the whole tenant, which hides whether that
 * is every pairing landing near 34% or a bimodal split between contracted and out-of-network work.
 * Those two need different actions, so the shape is worth more than the average.
 *
 * ⚠️ COUNTS PAIRINGS WITH A RELIABLE ALLOWED ONLY. A null allowed_rate is not a zero — it means no
 * reliable allowed amount exists for that pairing — so nulls are excluded and named beneath rather
 * than piled into the first bucket, which would read as "these pay nothing".
 */
export function YieldHistogram({ rows }: { rows: readonly CodePerfPairingRow[] }) {
  const [active, setActive] = useState<number | null>(null);
  const rated = rows.filter((r) => r.allowed_rate !== null);
  const unrated = rows.length - rated.length;
  // One count per band, indexed to match yieldBandOf. Every rated row increments exactly one.
  const counts = YIELD_BAND_LABELS.map(() => 0);
  for (const r of rated) counts[yieldBandOf(r.allowed_rate as number)] += 1;
  // Edge bands appear only when they hold something; the five core bands always do.
  const shownBands = YIELD_BAND_LABELS.map((_, i) => i).filter((i) => (i === 0 || i === 6 ? (counts[i] ?? 0) > 0 : true));
  const max = Math.max(...counts);

  const bandDescription = (i: number): string => {
    if (i === 0) return 'below 0% — allowed is negative';
    if (i === 6) return 'above 100% — allowed exceeds billed';
    const b = CORE_BANDS[i - 1];
    return `${b?.lo}–${b?.hi}%`;
  };

  return (
    <Panel
      title="Allowed-rate distribution"
      hint="How many pairings fall in each allowed-rate band. A single tenant-wide average hides a bimodal book — contracted work clustered high and out-of-network work clustered low need different action. Pairings with no reliable allowed amount are excluded, not counted as zero. Rates below 0% or above 100% get their own band rather than being clamped or dropped: the ratio is unclamped, so both are real."
    >
      {rated.length === 0 ? (
        <p className="mt-2 text-xs text-ink600">No pairing in this window has a reliable allowed amount.</p>
      ) : (
        <>
          <div className="mt-3 flex h-24 items-end gap-1.5">
            {shownBands.map((i) => {
              const n = counts[i] ?? 0;
              const h = max > 0 ? (n / max) * 100 : 0;
              const edge = i === 0 || i === 6;
              return (
                <button
                  key={i}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                  aria-label={`${bandDescription(i)}: ${n} pairings`}
                  className="flex h-full flex-1 flex-col justify-end rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500"
                >
                  <span className="ths-num mb-0.5 text-center text-[10px] tabular-nums text-ink600">{n}</span>
                  <span
                    className={`w-full rounded-t ${active === i ? 'bg-[var(--brand-ink)]' : edge ? 'bg-status-warn' : 'bg-[var(--brand-accent)]'}`}
                    style={{ height: `${Math.max(h, n > 0 ? 4 : 1)}%` }}
                  />
                  <span className="ths-num mt-1 text-center text-[10px] tabular-nums text-ink400">{YIELD_BAND_LABELS[i]}</span>
                </button>
              );
            })}
          </div>
          <p aria-live="polite" className="mt-1 text-[11px] leading-snug text-ink600">
            {active !== null ? (
              <>
                <span className="font-semibold text-ink900">{bandDescription(active)}</span> — {fmtInt(counts[active] ?? 0)} of{' '}
                {fmtInt(rated.length)} rated pairings
              </>
            ) : (
              <span className="text-ink400">
                {fmtInt(rated.length)} rated{unrated > 0 ? ` · ${fmtInt(unrated)} with no reliable allowed` : ''}
              </span>
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * BILLED BY FACILITY — the mix question an executive asks first and the pairing table cannot answer,
 * because that table's grain is the CODE, not the site of service. Reads `facilityOptions`, which the
 * board already carries for the filter picker, so this costs no extra query.
 *
 * ⚠️ A NULL FACILITY IS ITS OWN BAR, NEVER DROPPED AND NEVER MERGED. Charges the feed carries with no
 * facility are a real, attributable volume; folding them into another site would misstate that site,
 * and hiding them would make the bars sum to less than the tenant's billed with no explanation.
 *
 * ⚠️ IT MUST BE SCOPED TO THE ACTIVE FACILITY SELECTION, AND `facilityOptions` IS NOT (Qodo #350
 * finding 1). That collection is the PICKER's vocabulary and its query says so in as many words —
 * "Ignores any facility filter" — because a picker that hid the options you had not chosen yet would
 * be unusable. Feeding it here unscoped meant that selecting two facilities re-scoped the KPIs and
 * the table while this chart still drew every site in the tenant, with percentages against an
 * all-facility denominator.
 *
 * Filtering that collection to `facilitiesApplied` is CORRECT rather than a patch, and the reason is
 * a property of the query: it groups by facility under the same tenant and window predicates and
 * omits only the facility one, so a given site's `billed` is the same number whether or not other
 * sites are in scope. Restricting the list therefore yields true per-facility values AND a
 * denominator equal to the board's own billed total. No second query is needed, and the picker keeps
 * the full vocabulary it requires.
 */
export function FacilityMixChart({
  options,
  facilitiesApplied,
  limit = 8,
}: {
  options: CodePerfBoard['facilityOptions'];
  /** The board's active selection, or null for "all facilities". Scopes this chart to match it. */
  facilitiesApplied: string[] | null;
  limit?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  // A selected set never contains null, and `facility = any($n)` excludes null-facility rows, so
  // dropping the "No facility" bar under a selection matches what the board itself counted.
  const scoped =
    facilitiesApplied === null || facilitiesApplied.length === 0
      ? options
      : options.filter((o) => o.facility !== null && facilitiesApplied.includes(o.facility));
  const top = [...scoped].sort((a, b) => b.billed - a.billed).slice(0, limit);
  const totalBilled = scoped.reduce((n, o) => n + o.billed, 0);
  const max = top.length > 0 ? Math.max(...top.map((o) => o.billed)) : 0;
  const rest = scoped.length - top.length;
  const shown = active !== null ? top[active] : undefined;

  return (
    <Panel
      title={facilitiesApplied && facilitiesApplied.length > 0 ? 'Billed by facility (filtered)' : 'Billed by facility'}
      hint="Share of billed by site of service, largest first. The pairing table cannot show this because its grain is the billing code, not the facility. Charges with no facility on the feed are shown as their own bar rather than merged into a site that did not produce them."
    >
      {top.length === 0 ? (
        <p className="mt-2 text-xs text-ink600">No facilities in this window.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1.5">
            {top.map((o, i) => {
              const label = o.facility ?? 'No facility on the feed';
              const pct = max > 0 ? (o.billed / max) * 100 : 0;
              return (
                <li key={label}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                    aria-label={`${label}: billed ${fmtMoney(o.billed)}, ${fmtInt(o.charges)} charges`}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500"
                  >
                    <span className={`w-40 shrink-0 truncate text-[11px] ${o.facility === null ? 'italic text-ink400' : 'text-ink600'}`}>{label}</span>
                    <span className="h-3 flex-1 overflow-hidden rounded-full bg-[var(--brand-soft)]">
                      <span
                        className={`block h-full rounded-full ${active === i ? 'bg-[var(--brand-ink)]' : 'bg-[var(--brand-accent)]'}`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p aria-live="polite" className="ths-num mt-2 min-h-[2.25rem] text-[11px] leading-snug text-ink600">
            {shown ? (
              <>
                <span className="font-semibold text-ink900">{shown.facility ?? 'No facility on the feed'}</span>
                <br />
                billed {fmtMoney(shown.billed)} · {fmtInt(shown.charges)} charges
                {totalBilled > 0 ? ` · ${fmtPct((shown.billed / totalBilled) * 100, 1)} of billed` : ''}
              </>
            ) : (
              <span className="text-ink400">
                {fmtInt(scoped.length)} facilit{scoped.length === 1 ? 'y' : 'ies'}
                {rest > 0 ? ` · ${fmtInt(rest)} smaller not shown` : ''}
              </span>
            )}
          </p>
        </>
      )}
    </Panel>
  );
}
