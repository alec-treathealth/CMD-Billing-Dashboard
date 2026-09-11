'use client';

/**
 * Code Performance — the client view. Owns the three controls (tenant, window, facilities), calls the
 * two Server Actions (board eagerly, drill-down lazily per expanded pairing), and renders the notices
 * the data demands. Nothing here persists client-side — no localStorage, no cookies (standing rule);
 * every re-render re-derives from server results. `data-view={tenant}` on the root makes the brand
 * vars resolve to the tenant's colours (the bare-attribute rules in globals.css) for the KPI tiles
 * and MiniBars, so a BXR number never wears Indigo's colour.
 *
 * ── LAYOUT: ONE SCROLL AREA, PINNED HEAD (2026-09-09) ────────────────────────────────────────────
 * The route was a plain document scroll inside `max-w-7xl` (1280px) while Collections and Claims
 * Desk both use `max-w-[1800px]`, so this surface was ~520px narrower than its neighbours while
 * carrying the widest table in the app. It is now the Collections shape: the route bounds itself to
 * the viewport, the controls / freshness line / KPIs are PINNED, and everything below them lives in
 * a single scroll area. One thing scrolls, and the table's header and identity column stay put
 * against that one scrollport.
 *
 * Charts sit at the TOP of the scroll area rather than in the pinned head. Pinning them would have
 * eaten roughly 200px of a 900px viewport and left about ten table rows visible; at the top of the
 * scroller they are still the first thing on screen, and scrolling toward the table reclaims their
 * space instead of holding it open.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Filter, Info } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { MultiSelectTagPicker, type PickerOption } from '@/components/ui/multi-select-tag-picker';
import { getCodePerformanceBoard, getCodePerformancePairDetail } from '@/lib/code-performance/actions';
import {
  CODE_PERF_TENANT_LABEL,
  type CodePerfBoard,
  type CodePerfPairDetail,
  type CodePerfPairingRow,
  type CodePerfTenant,
  type CodePerfWindow,
} from '@/lib/code-performance/contract';

import { DefinitionsPanel } from './definitions-panel';
import { fmtInt, fmtIsoDate } from './format';
import { FacilityMixChart, TopPairingsChart, YieldHistogram } from './mini-charts';
import { KpiGrid, MaturityBanner, Notice, TenantToggle, WindowSelector } from './kpi-grid';
import { PairDrilldown } from './pair-drilldown';
import {
  DEFAULT_PAIRING_SORT,
  nextSort,
  pairKeyOf,
  PairingTable,
  PairingToolbar,
  type PairingSort,
  type PairingSortKey,
} from './pairing-table';

type BoardState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'forbidden' }
  | { status: 'ready'; board: CodePerfBoard };

type DetailState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: CodePerfPairDetail };

/** Identity key for the facility array in the effect dependency; no CMD facility name contains a pipe. */
const FACILITY_KEY_SEPARATOR = '|';

export function CodePerformanceView({ tenants, defaultTenant }: { tenants: CodePerfTenant[]; defaultTenant: CodePerfTenant }) {
  const [tenant, setTenant] = useState<CodePerfTenant>(defaultTenant);
  const [window, setWindow] = useState<CodePerfWindow>('91-180');
  const [facilities, setFacilities] = useState<string[]>([]);
  const [board, setBoard] = useState<BoardState>({ status: 'loading' });
  const [sort, setSort] = useState<PairingSort>(DEFAULT_PAIRING_SORT);
  // Owned here, not in PairingTable: the control that sets it is PINNED outside the table's scroller.
  const [dense, setDense] = useState(false);
  // The sidebar costs the table 21rem, so it is a lever rather than a fixed decision. Not persisted
  // — the standing rule is no localStorage and no cookies on this surface.
  const [chartsOpen, setChartsOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const facilityKey = facilities.join(FACILITY_KEY_SEPARATOR);

  // ⚠ SCOPE GENERATION — the drill-down cache is keyed by PAIRING ONLY, so a detail request that
  // resolves AFTER the tenant / window / facilities changed would write the OLD scope's numbers into
  // the NEW scope's cache under the same key, and the effect's `setDetails({})` below cannot stop a
  // promise that is already in flight (Qodo #346 finding 5). Every scope change bumps the generation;
  // a completion whose generation is stale is dropped, success and error alike.
  const scopeGen = useRef(0);
  /** The revealed drill-down, so opening a row can MOVE the reader to it. See the effect below. */
  const drilldownRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    scopeGen.current += 1;
    setBoard({ status: 'loading' });
    setExpanded(null);
    setDetails({});
    getCodePerformanceBoard({ tenant, window, facilities: facilities.length ? facilities : null })
      .then((r) => {
        if (!live) return;
        if (r.ok) setBoard({ status: 'ready', board: r.board });
        else setBoard({ status: r.reason === 'forbidden' ? 'forbidden' : 'error' });
      })
      .catch(() => {
        if (live) setBoard({ status: 'error' });
      });
    return () => {
      live = false;
    };
    // facilityKey stands in for the array's identity on purpose (a fresh array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, window, facilityKey]);

  /**
   * OPENING A ROW NAVIGATES TO WHAT IT OPENED.
   *
   * The drill-down renders BELOW a full-height table inside the same scroller, so expanding a row
   * used to reveal it off-screen: the chevron changed direction and nothing else appeared to happen,
   * and the reader had to scroll a 13-column table's worth of rows to find what they had just asked
   * for. This moves FOCUS to the panel rather than only scrolling it, which does three jobs at once
   * — the browser scrolls it into view, a screen reader's reading position follows it instead of
   * staying on the chevron, and `scroll-mt` on the section keeps it clear of the sticky header.
   *
   * Runs on expand ONLY; collapsing leaves focus where the reader put it. `expanded` is the pairing
   * key, so re-opening a DIFFERENT row re-fires and re-navigates, which is what a reader clicking
   * down a list wants.
   */
  useEffect(() => {
    if (expanded === null) return;
    drilldownRef.current?.focus();
  }, [expanded]);

  const rowsByKey = useMemo(() => {
    const m = new Map<string, CodePerfPairingRow>();
    if (board.status === 'ready') for (const r of board.board.rows) m.set(pairKeyOf(r), r);
    return m;
  }, [board]);

  function toggle(key: string) {
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (details[key]) return;
    const row = rowsByKey.get(key);
    if (!row) return;
    setDetails((d) => ({ ...d, [key]: { status: 'loading' } }));
    const gen = scopeGen.current;
    getCodePerformancePairDetail({
      tenant,
      window,
      facilities: facilities.length ? facilities : null,
      pair: { hcpcs: row.hcpcs, locSuffix: row.loc_suffix, revcode: row.revcode },
    })
      .then((r) => {
        if (gen !== scopeGen.current) return;
        setDetails((d) => ({ ...d, [key]: r.ok ? { status: 'ready', detail: r.detail } : { status: 'error' } }));
      })
      .catch(() => {
        if (gen !== scopeGen.current) return;
        setDetails((d) => ({ ...d, [key]: { status: 'error' } }));
      });
  }

  /**
   * Facility names are TENANT vocabulary — the options come from that tenant's rollup — so a tenant
   * change clears the selection in the SAME event. Otherwise the old names ride onto the new tenant,
   * match nothing by exact equality, and the board reads as "No charges" until the user notices the
   * stale tags (Qodo #346 finding 6). Same-tenant re-clicks are a no-op and keep the selection.
   */
  function selectTenant(next: CodePerfTenant) {
    if (next === tenant) return;
    setTenant(next);
    setFacilities([]);
  }

  const facilityOptions: PickerOption[] = useMemo(() => {
    if (board.status !== 'ready') return [];
    return board.board.facilityOptions
      .filter((o): o is { facility: string; charges: number; billed: number } => o.facility !== null)
      .map((o) => ({ value: o.facility, display: o.facility, detail: `${fmtInt(o.charges)} charges` }));
  }, [board]);

  const ready = board.status === 'ready' ? board.board : null;
  const expandedRow = expanded ? rowsByKey.get(expanded) : undefined;
  const detail = expanded ? details[expanded] : undefined;

  return (
    <div data-view={tenant} className="flex min-h-0 flex-1 flex-col gap-3">
      {/* PINNED HEAD — controls. `shrink-0` so the scroll area below, not this row, absorbs pressure. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <TenantToggle tenants={tenants} value={tenant} onChange={selectTenant} />
        <WindowSelector value={window} onChange={setWindow} />
        <div className="min-w-[16rem] flex-1">
          <MultiSelectTagPicker
            label="Facilities"
            placeholder={facilities.length ? 'Add a facility' : 'All facilities'}
            icon={<Filter aria-hidden className="h-4 w-4" />}
            options={facilityOptions}
            selected={facilities}
            onToggle={(v) => setFacilities((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]))}
            onClear={() => setFacilities([])}
            loading={board.status === 'loading'}
          />
        </div>
      </div>

      {board.status === 'forbidden' && <Notice tone="warn">This session is not entitled to any tenant on this surface.</Notice>}
      {board.status === 'error' && <Notice tone="warn">The code performance data could not be loaded right now.</Notice>}
      {board.status === 'loading' && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading code performance">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-14 w-full" />
          <div className="grid gap-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
        </div>
      )}

      {ready && (
        <>
          {ready.immatureWindow && <MaturityBanner maturedShare={ready.summary.matured_share} />}

          {/* ONE ROW: provenance left, the caveats that used to be two full-width banners right. */}
          <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-xs text-ink600">
              {CODE_PERF_TENANT_LABEL[ready.tenant]} · charges {fmtIsoDate(ready.windowStart)} – {fmtIsoDate(ready.windowEnd)} (business day,
              Pacific) · feed through {fmtIsoDate(ready.freshness.maxChargeDate)}
              {ready.freshness.chargeLagDays !== null ? ` (${ready.freshness.chargeLagDays}d behind)` : ''}
              {ready.freshness.maxIngestedAt
                ? ` · ingest ${new Date(ready.freshness.maxIngestedAt).toLocaleString('en-US', {
                    timeZone: 'America/Los_Angeles',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })} PT`
                : ''}
            </p>
            <Caveats board={ready} />
          </div>

          <KpiGrid board={ready} />

          {/* ── TWO COLUMNS: the table reads, the charts stay visible ────────────────────────────
              The charts used to stack ABOVE the table, which cost ~300px of vertical space on a
              route that bounds itself to the viewport — so the table opened with about three rows
              showing and everything was a scroll. On a 1800px surface that space is available
              HORIZONTALLY. Below `lg` they stack, because a 21rem sidebar beside a 13-column table
              is not a phone layout.

              ⚠️ `min-w-0` ON BOTH FLEX ITEMS, and it is the horizontal twin of the `min-h-0` note
              below. A flex item's default `min-width:auto` refuses to shrink below its CONTENT's
              min-content width, and this column contains a `w-max` table — so without it the column
              grew wider than `main`, `main` overflowed, and the DOCUMENT scrolled sideways, carrying
              the pinned KPI header off-screen with it. The symptom read as "the KPIs move when I
              scroll the table", which sounds like a sticky bug and is a min-width bug. */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              {/* PINNED above the scroller — see the note on PairingToolbar for why it cannot live
                  inside it. */}
              <PairingToolbar
                count={ready.rows.length}
                sort={sort}
                dense={dense}
                onDenseChange={setDense}
                chartsOpen={chartsOpen}
                onChartsChange={setChartsOpen}
              />

              {/* ⚠️ `min-h-0` is load-bearing: a flex child's default `min-height:auto` refuses to
                  shrink below its content, so without it `flex-1` resolves to CONTENT height and the
                  document scrolls again. `overflow-auto` on this one element is also what makes the
                  table's `sticky` header and identity column resolve, since sticky positions against
                  the nearest scrollport. */}
              <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                <div className="space-y-3 pb-1">
                  <PairingTable
                    rows={ready.rows}
                    descriptions={ready.descriptions}
                    summary={ready.summary}
                    immatureWindow={ready.immatureWindow}
                    sort={sort}
                    onSort={(k: PairingSortKey) => setSort((s) => nextSort(s, k))}
                    expandedKey={expanded}
                    onToggle={toggle}
                    dense={dense}
                  />

                  {expanded && expandedRow && (
                    <section
                      ref={drilldownRef}
                      tabIndex={-1}
                      aria-label="Pairing drill-down"
                      className="scroll-mt-12 space-y-2"
                    >
                      <h2 className="text-base font-semibold text-ink900">
                        {expandedRow.hcpcs ?? 'No procedure code'}
                        {expandedRow.loc_suffix ? ` (${expandedRow.loc_suffix})` : ''} × {expandedRow.revcode ?? 'No revenue code'}
                      </h2>
                      {(!detail || detail.status === 'loading') && (
                        <div className="space-y-2" aria-busy="true">
                          <Skeleton className="h-6 w-1/2" />
                          <Skeleton className="h-40 w-full" />
                        </div>
                      )}
                      {detail?.status === 'error' && <Notice tone="warn">The drill-down could not be loaded right now.</Notice>}
                      {detail?.status === 'ready' && (
                        <PairDrilldown
                          detail={detail.detail}
                          summary={ready.summary}
                          freshness={ready.freshness}
                          dim={ready.immatureWindow}
                          tenant={ready.tenant}
                        />
                      )}
                    </section>
                  )}

                  <DefinitionsPanel rows={ready.rows} descriptions={ready.descriptions} />
                </div>
              </div>
            </div>

            {/* A LABELLED COMPLEMENTARY LANDMARK, not a styled div. `<aside aria-label>` is what puts
                these charts in a screen reader's landmark list, so they can be jumped to and skipped
                past instead of being read as a wall of buttons between the toolbar and the table. */}
            {/* ⚠️ CONDITIONALLY RENDERED, not `hidden`. The `hidden` ATTRIBUTE is a UA-level
                `display:none`, and this element carries `display:flex` from a class — the class wins
                on specificity, so a `hidden` aside would stay visible and the collapse would appear
                to do nothing. Nothing is lost by unmounting it: every figure in these charts is
                derived from the table that remains on screen. */}
            {chartsOpen && (
            <aside
              id="cp-charts"
              aria-label="Summary charts"
              className="flex min-h-0 shrink-0 flex-col gap-2 overflow-auto lg:w-[21rem]"
            >
              <TopPairingsChart rows={ready.rows} limit={6} />
              <YieldHistogram rows={ready.rows} />
              {/* `facilityOptions` is the PICKER's vocabulary and ignores the facility filter by
                  design, so the chart is handed the active selection and scopes itself to it —
                  otherwise it draws every site while the KPIs and table show two. */}
              <FacilityMixChart options={ready.facilityOptions} facilitiesApplied={ready.facilitiesApplied} limit={6} />
            </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The caveats that used to be two full-width banners stacked above the table.
 *
 * Both were permanent — neither depends on anything the reader did — and together they cost about
 * 120px of a viewport-bounded route on every load, to say two things that do not change. They are
 * still here, in full, one click away, with a summary that says how many there are so the reader
 * knows whether to open it.
 *
 * ⚠️ THE SUPPRESSION REASONS ARE DELIBERATELY NOT REPEATED HERE. They live on the KPI strip beside
 * the metric they suppress, where the number would otherwise be — that is the only place a reader
 * looking at "Suppressed" will actually look, and repeating a 240-character reason in two places is
 * how the original layout ran out of room.
 */
function Caveats({ board }: { board: CodePerfBoard }) {
  const future = board.freshness.futurePaymentCharges;
  const notes: React.ReactNode[] = [
    <>
      <span className="font-semibold text-ink900">Payer names are raw CMD strings.</span> They are not aliased, so one carrier appears on
      several rows — AETNA and AETNA US HEALTHCARE are the same payer. Alias resolution is out of scope for this surface.
    </>,
    <>
      <span className="font-semibold text-ink900">All ratios are sum-over-sum</span> on the charge rollup, and allowed figures use reliable
      tiers only. Days to money is charge → last posting, not first dollar.
    </>,
  ];
  if (future > 0) {
    notes.push(
      <>
        <span className="font-semibold text-ink900">{fmtInt(future)} charges carry a future payment date</span> (EFT effective dates). They
        count as paid here, so days-to-money on this tenant is a floor, not a measurement.
      </>,
    );
  }
  return (
    <details className="group relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-ink600 hover:bg-teal50 hover:text-teal900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500">
        <Info aria-hidden className="h-3.5 w-3.5" />
        Reading these numbers ({notes.length})
      </summary>
      <div className="absolute right-0 z-30 mt-1 w-[26rem] max-w-[90vw] rounded-lg border border-line bg-surface p-3 shadow-ths-lg">
        <ul className="space-y-2 text-[11px] leading-snug text-ink600">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}
