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

/** Compact identity for a pairing — "H0015 (IOP) × 0905", the table's label without the descriptions. */
function pairLabel(r: CodePerfPairingRow): string {
  const proc = describeCodeSlot('procedure', r.hcpcs).label;
  const rev = describeCodeSlot('revenue', r.revcode).label;
  return `${proc}${r.loc_suffix ? ` (${r.loc_suffix})` : ''} × ${rev}`;
}

function Panel({ title, hint, children }: { title: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-card p-3 shadow-ths">
      <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <MetricHint label={title}>{hint}</MetricHint>
      </h3>
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
                <li key={pairLabel(r)}>
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

/** The allowed-rate buckets, coarse on purpose — the shape of the distribution, not a precise count. */
const BUCKETS = [
  { lo: 0, hi: 20 },
  { lo: 20, hi: 40 },
  { lo: 40, hi: 60 },
  { lo: 60, hi: 80 },
  { lo: 80, hi: 101 },
] as const;

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
  const counts = BUCKETS.map((b) => rated.filter((r) => (r.allowed_rate as number) >= b.lo && (r.allowed_rate as number) < b.hi).length);
  const max = counts.length > 0 ? Math.max(...counts) : 0;

  return (
    <Panel
      title="Allowed-rate distribution"
      hint="How many pairings fall in each allowed-rate band. A single tenant-wide average hides a bimodal book — contracted work clustered high and out-of-network work clustered low need different action. Pairings with no reliable allowed amount are excluded, not counted as zero."
    >
      {rated.length === 0 ? (
        <p className="mt-2 text-xs text-ink600">No pairing in this window has a reliable allowed amount.</p>
      ) : (
        <>
          <div className="mt-3 flex h-24 items-end gap-1.5">
            {BUCKETS.map((b, i) => {
              const n = counts[i] ?? 0;
              const h = max > 0 ? (n / max) * 100 : 0;
              return (
                <button
                  key={b.lo}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                  aria-label={`${b.lo} to ${b.hi === 101 ? 100 : b.hi} percent: ${n} pairings`}
                  className="flex h-full flex-1 flex-col justify-end rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500"
                >
                  <span className="ths-num mb-0.5 text-center text-[10px] tabular-nums text-ink600">{n}</span>
                  <span
                    className={`w-full rounded-t ${active === i ? 'bg-[var(--brand-ink)]' : 'bg-[var(--brand-accent)]'}`}
                    style={{ height: `${Math.max(h, n > 0 ? 4 : 1)}%` }}
                  />
                  <span className="ths-num mt-1 text-center text-[10px] tabular-nums text-ink400">{b.lo}</span>
                </button>
              );
            })}
          </div>
          <p aria-live="polite" className="mt-1 text-[11px] leading-snug text-ink600">
            {active !== null ? (
              <>
                <span className="font-semibold text-ink900">
                  {BUCKETS[active]?.lo}–{BUCKETS[active]?.hi === 101 ? 100 : BUCKETS[active]?.hi}%
                </span>{' '}
                — {fmtInt(counts[active] ?? 0)} of {fmtInt(rated.length)} rated pairings
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
 */
export function FacilityMixChart({ options, limit = 8 }: { options: CodePerfBoard['facilityOptions']; limit?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const top = [...options].sort((a, b) => b.billed - a.billed).slice(0, limit);
  const totalBilled = options.reduce((n, o) => n + o.billed, 0);
  const max = top.length > 0 ? Math.max(...top.map((o) => o.billed)) : 0;
  const rest = options.length - top.length;
  const shown = active !== null ? top[active] : undefined;

  return (
    <Panel
      title="Billed by facility"
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
                {fmtInt(options.length)} facilities{rest > 0 ? ` · ${fmtInt(rest)} smaller not shown` : ''}
              </span>
            )}
          </p>
        </>
      )}
    </Panel>
  );
}
