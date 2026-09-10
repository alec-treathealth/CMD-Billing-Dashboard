'use client';

/**
 * AR Management workbench — the client shell hosting four subtabs (AR Queue / IP Audit / OP Audit /
 * Billable Days) as in-page state (one route, no sub-navigation). The AR QUEUE (2026-09-09) is the
 * default and the tab's reason to exist: the snapshot-fed aged-AR queue with notes and dispositions
 * (components/billing-audit/ar/). It replaced the inert "Flag Queue" placeholder that had rendered
 * `PHASE 3 · NOT YET ACTIVATED` since 2026-07. The IP/OP audit panels each hold their own filter state
 * and a keyset-paged work table, unchanged.
 *
 * `canRevealPhi` threads down (a plain `user` never gets the reveal control; the reveal action is
 * gated server-side regardless). `view` carries the server-resolved tenant scope. The IP panel is
 * seeded with a server-rendered first page for the default (YTD) window; OP fetches on first view.
 */
import { useCallback, useRef, useState } from 'react';
import { AuditFilterBar } from './filter-bar';
import { AuditWorkTable } from './work-table';
import { PivotStrip } from './pivot-strip';
import { PatientDrill, type DrillTarget } from './patient-drill';
import { DEFAULT_PRESET, type Preset } from './date-presets';
import { BillableDaysPanel } from './billable-days/panel';
import { ArWorkbench, type ArSeed } from './ar/ar-workbench';
import type { TagOption } from './tag-picker';
import { searchAuditPatients, type AuditCursor, type AuditFilter, type AuditGridRow } from '@/lib/actions';
import type { AuditScope } from '../../../src/billingAudit/auditConfig';
import type { DashboardView } from '@/lib/views';

type AuditTab = 'ar' | 'ip' | 'op' | 'billable';
/**
 * Whether this route offers scope tabs at all. FALSE since 2026-09-10 — AR Management is the only
 * view. Flip to true to bring IP Audit / OP Audit / Billable Days back; nothing else needs changing
 * except restoring the IP/OP seeds in app/billing-audit/page.tsx if you want them pre-painted.
 */
const SHOW_SCOPE_TABS = false;
const TABS: readonly { id: AuditTab; label: string }[] = [
  { id: 'ar', label: 'AR Queue' },
  { id: 'ip', label: 'IP Audit' },
  { id: 'op', label: 'OP Audit' },
  { id: 'billable', label: 'Billable Days' },
];

export interface BillingAuditWorkbenchProps {
  view: DashboardView;
  canRevealPhi: boolean;
  /** admin / super_admin — may add notes and set work status on the AR queue. */
  canWork: boolean;
  /** Server-seeded AR queue data (summary + options + first page) for the default view. */
  arSeed: ArSeed;
  /** The YTD window the server seeded the IP page with — both panels start here. */
  initialFilter: AuditFilter;
  ipPage: { rows: AuditGridRow[]; nextCursor: AuditCursor | null } | null;
  ipFacilities: TagOption[];
  ipPayers: TagOption[];
  opFacilities: TagOption[];
  opPayers: TagOption[];
}

export function BillingAuditWorkbench(props: BillingAuditWorkbenchProps) {
  const { view, canRevealPhi, canWork, arSeed, initialFilter } = props;
  const [active, setActive] = useState<AuditTab>('ar');
  const tabRefs = useRef<Record<AuditTab, HTMLButtonElement | null>>({ ar: null, ip: null, op: null, billable: null });

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === active);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : (i - 1 + TABS.length) % TABS.length;
    const nextId = TABS[next]!.id;
    setActive(nextId);
    tabRefs.current[nextId]?.focus();
  }, [active]);

  return (
    <section className="space-y-4">
      {/* ⚠ THE TAB STRIP IS HIDDEN, NOT DELETED (Alec, 2026-09-10: the other subtabs "provide
          irrelevant information"). AR Management is the only view this route offers now.
          `SHOW_SCOPE_TABS = false` is the single switch: the IP/OP audit panels, Billable Days,
          their components, their Server Actions and their tests are all still here and still
          compile, so restoring them is flipping this constant rather than rebuilding a feature.
          The `active` state, the roving-tabindex keyboard handler and the panel branches below are
          intentionally left intact for the same reason — dead while the strip is hidden, correct
          the moment it returns. `page.tsx` stops SEEDING the IP/OP grids in the same change, so the
          hidden panels cost no queries; they fetch on first view if re-enabled. */}
      {SHOW_SCOPE_TABS ? (
      <div role="tablist" aria-label="Billing audit scope" onKeyDown={onKeyDown} className="flex items-center gap-1 border-b border-line">
        {TABS.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              role="tab"
              id={`billing-audit-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`billing-audit-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={[
                'ths-h -mb-px border-b-2 px-4 py-2.5 text-[13px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                selected ? 'border-[var(--brand-accent)] text-[var(--brand-ink)]' : 'border-transparent text-ink400 hover:text-ink600',
              ].join(' ')}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      ) : null}

      <div role="tabpanel" id={`billing-audit-panel-${active}`} aria-labelledby={`billing-audit-tab-${active}`}>
        {active === 'billable' ? (
          /* ⚠ DELIBERATELY NOT KEYED BY `view`, unlike the ScopePanels below — the two panels hold
             different KINDS of state and a tenant switch must treat them differently.

             This panel's state is a corpus the USER uploaded, whose overrides are keyed by
             (entity, week) in `billable-days/overrides.ts`. Those entries are isolated by
             construction, so they can safely outlive an entity switch — and they should: keying
             here would destroy a biller's parsed export and unsaved edits on a BXR → Indigo →
             BXR glance, forcing a re-upload of all four CSVs to recover work that was never in
             danger. `billableDaysEntityScope.test.tsx` is where that isolation is pinned. */
          <BillableDaysPanel view={view} canRevealPhi={canRevealPhi} />
        ) : active === 'ar' ? (
          /* Keyed by `view` like the ScopePanels: the queue holds a server-seeded snapshot of one
             tenant's rows and must be rebuilt on a tenant switch (billingAuditViewRemount.test.tsx). */
          <ArWorkbench key={view} view={view} canRevealPhi={canRevealPhi} canWork={canWork} seed={arSeed} />
        ) : active === 'ip' ? (
          <ScopePanel
            key={view}
            scope="ip" view={view} canRevealPhi={canRevealPhi} initialFilter={initialFilter}
            facilities={props.ipFacilities} payers={props.ipPayers} initialPage={props.ipPage}
          />
        ) : (
          <ScopePanel
            key={view}
            scope="op" view={view} canRevealPhi={canRevealPhi} initialFilter={initialFilter}
            facilities={props.opFacilities} payers={props.opPayers} initialPage={null}
          />
        )}
      </div>
    </section>
  );
}

function ScopePanel({ scope, view, canRevealPhi, initialFilter, facilities, payers, initialPage }: {
  scope: 'ip' | 'op';
  view: DashboardView;
  canRevealPhi: boolean;
  initialFilter: AuditFilter;
  facilities: TagOption[];
  payers: TagOption[];
  initialPage: { rows: AuditGridRow[]; nextCursor: AuditCursor | null } | null;
}) {
  const [filter, setFilter] = useState<AuditFilter>(initialFilter);
  const [preset, setPreset] = useState<Preset>(DEFAULT_PRESET);
  const [drillTarget, setDrillTarget] = useState<DrillTarget | null>(null);
  const [searching, setSearching] = useState(false);
  // Page-level PHI reveal lives HERE (not in the work table) so the work table AND the patient
  // drill share one toggle — turning it on unmasks the grid AND auto-reveals any drill opened.
  const [revealAll, setRevealAll] = useState(false);
  const auditScope: AuditScope = scope === 'ip' ? 'IP' : 'OP';

  // Drill from a pivot cell: union the patch's array fields into the current filter (so clicking
  // Office CAMH adds CAMH to any existing facility selection rather than replacing the filter).
  const drillFilter = useCallback((patch: Partial<AuditFilter>) => {
    setFilter((prev) => {
      const next: AuditFilter = { ...prev };
      for (const key of ['facilityCodes', 'payerNames', 'cptCodes', 'revCodes'] as const) {
        const add = patch[key];
        if (add && add.length) next[key] = [...new Set([...(prev[key] ?? []), ...add])];
      }
      return next;
    });
  }, []);

  // Patient search — resolve the term to blind-index tokens (gated + audited server-side) and set
  // them on the filter; an empty term clears the tokens. Never handles plaintext PHI client-side.
  const runPatientSearch = useCallback(async (term: string) => {
    setSearching(true);
    const res = await searchAuditPatients(term, auditScope, view);
    setSearching(false);
    if (!res.ok) return;
    setFilter((prev) => ({ ...prev, patientNameBidx: res.tokens.patientNameBidx, patientNamePrefixBidx: res.tokens.patientNamePrefixBidx }));
  }, [auditScope, view]);

  const openDrill = useCallback((row: AuditGridRow) => {
    setDrillTarget({ cmdPatientId: row.cmd_patient_id, facility: row.office_name ?? row.facility_code, payer: row.payer_name });
  }, []);

  return (
    <div className="space-y-3">
      <AuditFilterBar
        facilities={facilities}
        payers={payers}
        value={filter}
        activePreset={preset}
        onChange={(next, p) => { setFilter(next); setPreset(p); }}
        canRevealPhi={canRevealPhi}
        onPatientSearch={runPatientSearch}
        searching={searching}
      />
      <PivotStrip scope={auditScope} view={view} filter={filter} onDrill={drillFilter} />
      <AuditWorkTable
        scope={auditScope} view={view} canRevealPhi={canRevealPhi} filter={filter}
        initialPage={initialPage} onOpenDrill={openDrill}
        revealAll={revealAll} onToggleRevealAll={() => setRevealAll((v) => !v)}
      />
      <PatientDrill scope={auditScope} view={view} canRevealPhi={canRevealPhi} target={drillTarget} revealAll={revealAll} onClose={() => setDrillTarget(null)} />
    </div>
  );
}
