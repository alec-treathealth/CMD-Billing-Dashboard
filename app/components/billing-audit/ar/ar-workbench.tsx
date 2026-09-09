'use client';

/**
 * The AR QUEUE tab — the client shell composing the aging strip, the filter bar, the queue table and
 * the claim drawer. Owns the filter / sort / selection state (component memory only — the URL carries
 * `?view=` and nothing else) and refreshes the summary when the filter changes. Seeded from the
 * server with the summary, options and first page so the tab paints with data.
 *
 * Bell hand-off: on mount it consumes the in-memory pending claim (app/lib/ar/open-claim-store.ts)
 * so a notification click lands with the drawer open — no id in the URL, no browser storage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AR_BANDS } from '../../../../src/billingAudit/arBuckets';
import { loadArOptionsAction, loadArSummaryAction, searchArPatientsAction } from '@/lib/ar/actions';
import type { ArBandKey, ArCursor, ArFilter, ArOptions, ArQueueRow, ArSort, ArSortColumn, ArSummary } from '@/lib/ar/contract';
import { takePendingClaim } from '@/lib/ar/open-claim-store';
import type { DashboardView } from '@/lib/views';
import { AgingStrip } from './aging-strip';
import { ArFilterBar } from './ar-filter-bar';
import { ArQueueTable } from './ar-queue-table';
import { ClaimDrawer, type DrawerTarget } from './claim-drawer';
import { shortDate } from './ar-leaves';

export interface ArSeed {
  summary: ArSummary | null;
  options: ArOptions | null;
  page: { rows: ArQueueRow[]; nextCursor: ArCursor | null } | null;
}

export interface ArWorkbenchProps {
  view: DashboardView;
  canRevealPhi: boolean;
  canWork: boolean;
  seed: ArSeed;
}

const AGED_KEYS: ArBandKey[] = AR_BANDS.filter((b) => b.aged).map((b) => b.key);
const EMPTY_KPI = { claims: 0, balance: '0', denied: 0, denied_balance: '0', worked: 0, followup_overdue: 0, never_noted: 0, aged_31_plus: 0, aged_31_plus_balance: '0' };

export function ArWorkbench({ view, canRevealPhi, canWork, seed }: ArWorkbenchProps) {
  const [filter, setFilter] = useState<ArFilter>({});
  const [sort, setSort] = useState<ArSort>({ column: 'balance', direction: 'desc' });
  const [summary, setSummary] = useState<ArSummary | null>(seed.summary);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [options, setOptions] = useState<ArOptions | null>(seed.options);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [revealAll, setRevealAll] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [searching, setSearching] = useState(false);
  const firstSummary = useRef(seed.summary !== null);
  const filterKey = JSON.stringify(filter);

  // Options fall back to a client load only when the server seed failed.
  useEffect(() => {
    if (options !== null) return;
    let cancelled = false;
    loadArOptionsAction(view).then((res) => { if (!cancelled && res.ok) setOptions(res.options); });
    return () => { cancelled = true; };
  }, [options, view]);

  // Summary follows the filter (skip the first render when the server seeded it).
  useEffect(() => {
    if (firstSummary.current) { firstSummary.current = false; return; }
    let cancelled = false;
    setSummaryLoading(true);
    loadArSummaryAction(view, filter).then((res) => {
      if (cancelled) return;
      if (res.ok) setSummary(res.summary);
      setSummaryLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, view]);

  // Bell hand-off: open the pending claim once, on mount.
  useEffect(() => {
    const p = takePendingClaim();
    if (p && p.view === view) setDrawer({ cmdClaimId: p.cmdClaimId, cmdPatientId: null });
  }, [view]);

  const onSort = useCallback((column: ArSortColumn) => {
    setSort((prev) => prev.column === column ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: column === 'age' || column === 'balance' || column === 'total_charges' ? 'desc' : 'asc' });
  }, []);

  const bands = filter.bands ?? [];
  const agedOnly = bands.length === AGED_KEYS.length && AGED_KEYS.every((k) => bands.includes(k));
  const toggleBand = (key: ArBandKey) => {
    setFilter((f) => {
      const cur = agedOnly ? [] : (f.bands ?? []);
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      return { ...f, bands: next.length ? next : undefined };
    });
  };
  const toggleAgedOnly = () => setFilter((f) => ({ ...f, bands: agedOnly ? undefined : [...AGED_KEYS] }));

  const runPatientSearch = useCallback(async (term: string) => {
    if (term.trim() === '') {
      setFilter((f) => ({ ...f, patientNameBidx: undefined, patientNamePrefixBidx: undefined, memberIdBidx: undefined }));
      return;
    }
    setSearching(true);
    const res = await searchArPatientsAction(view, term);
    setSearching(false);
    if (!res.ok) return;
    setFilter((f) => ({ ...f, patientNameBidx: res.tokens.patientNameBidx, patientNamePrefixBidx: res.tokens.patientNamePrefixBidx, memberIdBidx: res.tokens.memberIdBidx }));
  }, [view]);

  const freshness = options?.freshness ?? null;
  if (options !== null && freshness === null) {
    return (
      <div className="rounded-xl border border-line bg-card p-10 text-center">
        <h2 className="ths-h text-lg font-semibold text-ink900">No AR snapshot for this tenant yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-ink600">
          The AR queue is fed by CMD&rsquo;s daily customer data snapshot. Snapshots are enabled per CMD account; this
          tenant&rsquo;s account has not returned one (the Indigo account 474623 answered 404 on 2026-08-14 and the
          BXR account-level endpoint is likewise unconfigured — BXR is loaded per facility). Switch tenant above, or
          ask CMD to enable data snapshots for this account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {freshness ? (
        <p className="text-xs text-ink400">
          Snapshot as of <span className="ths-num text-ink600">{shortDate(freshness.newest_as_of)}</span>
          {freshness.oldest_as_of && freshness.oldest_as_of.slice(0, 10) !== (freshness.newest_as_of ?? '').slice(0, 10) ? <> (oldest facility {shortDate(freshness.oldest_as_of)})</> : null}
          {' · '}{freshness.customers} facilit{freshness.customers === 1 ? 'y' : 'ies'} · refreshed daily from CMD&rsquo;s customer data snapshot.
        </p>
      ) : null}
      <AgingStrip
        bands={summary?.bands ?? []}
        kpi={summary?.kpi ?? EMPTY_KPI}
        selected={bands}
        onToggle={toggleBand}
        agedOnly={agedOnly}
        onToggleAgedOnly={toggleAgedOnly}
        loading={summaryLoading}
      />
      <ArFilterBar options={options} filter={filter} onChange={setFilter} canRevealPhi={canRevealPhi} onPatientSearch={runPatientSearch} searching={searching} />
      <ArQueueTable
        view={view}
        canRevealPhi={canRevealPhi}
        filter={filter}
        sort={sort}
        onSort={onSort}
        initialPage={seed.page}
        onOpenClaim={(row) => setDrawer({ cmdClaimId: row.cmd_claim_id, cmdPatientId: row.cmd_patient_id })}
        revealAll={revealAll}
        onToggleRevealAll={() => setRevealAll((v) => !v)}
        refreshToken={refreshToken}
        activeClaimId={drawer?.cmdClaimId ?? null}
      />
      <ClaimDrawer
        view={view}
        canRevealPhi={canRevealPhi}
        canWork={canWork}
        target={drawer}
        assignees={options?.assignees ?? []}
        onClose={() => setDrawer(null)}
        onChanged={() => setRefreshToken((t) => t + 1)}
      />
    </div>
  );
}
