'use client';

/**
 * Code Performance — the client view. Owns the three controls (tenant, window, facilities), calls the
 * two Server Actions (board eagerly, drill-down lazily per expanded pairing), and renders the notices
 * the data demands. Nothing here persists client-side — no localStorage, no cookies (standing rule);
 * every re-render re-derives from server results. `data-view={tenant}` on the root makes the brand
 * vars resolve to the tenant's colours (the bare-attribute rules in globals.css) for the KPI tiles
 * and MiniBars, so a BXR number never wears Indigo's colour.
 */
import { useEffect, useMemo, useState } from 'react';
import { Filter } from 'lucide-react';

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
import { KpiGrid, MaturityBanner, Notice, TenantToggle, WindowSelector } from './kpi-grid';
import { PairDrilldown } from './pair-drilldown';
import { DEFAULT_PAIRING_SORT, nextSort, pairKeyOf, PairingTable, type PairingSort, type PairingSortKey } from './pairing-table';

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
  const [window, setWindow] = useState<CodePerfWindow>('6mo');
  const [facilities, setFacilities] = useState<string[]>([]);
  const [board, setBoard] = useState<BoardState>({ status: 'loading' });
  const [sort, setSort] = useState<PairingSort>(DEFAULT_PAIRING_SORT);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const facilityKey = facilities.join(FACILITY_KEY_SEPARATOR);

  useEffect(() => {
    let live = true;
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
    getCodePerformancePairDetail({
      tenant,
      window,
      facilities: facilities.length ? facilities : null,
      pair: { hcpcs: row.hcpcs, locSuffix: row.loc_suffix, revcode: row.revcode },
    })
      .then((r) => setDetails((d) => ({ ...d, [key]: r.ok ? { status: 'ready', detail: r.detail } : { status: 'error' } })))
      .catch(() => setDetails((d) => ({ ...d, [key]: { status: 'error' } })));
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
    <div data-view={tenant} className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <TenantToggle tenants={tenants} value={tenant} onChange={setTenant} />
        <WindowSelector value={window} onChange={setWindow} />
        <div className="min-w-[18rem] flex-1">
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
        <div className="space-y-3" aria-busy="true" aria-label="Loading code performance">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {ready && (
        <>
          {ready.immatureWindow && <MaturityBanner maturedShare={ready.summary.matured_share} />}

          <p className="text-xs text-ink600">
            {CODE_PERF_TENANT_LABEL[ready.tenant]} · charges dated {fmtIsoDate(ready.windowStart)} through {fmtIsoDate(ready.windowEnd)} (business day,
            Pacific) · charge feed through {fmtIsoDate(ready.freshness.maxChargeDate)}
            {ready.freshness.chargeLagDays !== null ? ` (${ready.freshness.chargeLagDays} days behind today)` : ''}
            {ready.freshness.maxIngestedAt
              ? ` · last ingest ${new Date(ready.freshness.maxIngestedAt).toLocaleString('en-US', {
                  timeZone: 'America/Los_Angeles',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })} PT`
              : ''}
          </p>

          <KpiGrid board={ready} />

          <div className="space-y-2">
            <Notice tone="muted">
              Payer names are raw CMD strings and are not aliased, so one carrier appears on several rows (for example AETNA and AETNA US
              HEALTHCARE). Alias resolution is out of scope for this surface.
            </Notice>
            {ready.freshness.futurePaymentCharges > 0 && (
              <Notice tone="muted">
                {fmtInt(ready.freshness.futurePaymentCharges)} {CODE_PERF_TENANT_LABEL[ready.tenant]} charges carry a payment date in the future (EFT
                effective dates). They count as paid here, so days-to-money on this tenant is a floor, not a measurement.
              </Notice>
            )}
            {(ready.summary.write_off_rate.state === 'suppressed' || ready.summary.patient_balance_rate.state === 'suppressed') && (
              <Notice tone="warn">
                {ready.summary.write_off_rate.state === 'suppressed' && <p>Write-off rate — {ready.summary.write_off_rate.reason}</p>}
                {ready.summary.patient_balance_rate.state === 'suppressed' && (
                  <p>Patient balance outstanding — {ready.summary.patient_balance_rate.reason}</p>
                )}
              </Notice>
            )}
          </div>

          <PairingTable
            rows={ready.rows}
            descriptions={ready.descriptions}
            summary={ready.summary}
            immatureWindow={ready.immatureWindow}
            sort={sort}
            onSort={(k: PairingSortKey) => setSort((s) => nextSort(s, k))}
            expandedKey={expanded}
            onToggle={toggle}
          />

          {expanded && expandedRow && (
            <section aria-label="Pairing drill-down" className="space-y-3">
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
                <PairDrilldown detail={detail.detail} summary={ready.summary} freshness={ready.freshness} dim={ready.immatureWindow} />
              )}
            </section>
          )}

          <DefinitionsPanel rows={ready.rows} descriptions={ready.descriptions} />
        </>
      )}
    </div>
  );
}
