'use client';

/**
 * Billing Audit workbench — the client shell hosting three subtabs (IP Audit / OP Audit / Flag
 * Queue) as in-page state (one route, no sub-navigation). Each scope panel holds its own filter
 * state and a keyset-paged work table; the Flag Queue is a real destination, deliberately inert
 * (empty state) until the Phase-3 flag engine computes exceptions into claims.flag.
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
import type { TagOption } from './tag-picker';
import { searchAuditPatients, type AuditCursor, type AuditFilter, type AuditGridRow } from '@/lib/actions';
import type { AuditScope } from '../../../src/billingAudit/auditConfig';
import type { DashboardView } from '@/lib/views';

type AuditTab = 'ip' | 'op' | 'flags';
const TABS: readonly { id: AuditTab; label: string }[] = [
  { id: 'ip', label: 'IP Audit' },
  { id: 'op', label: 'OP Audit' },
  { id: 'flags', label: 'Flag Queue' },
];

export interface BillingAuditWorkbenchProps {
  view: DashboardView;
  canRevealPhi: boolean;
  /** The YTD window the server seeded the IP page with — both panels start here. */
  initialFilter: AuditFilter;
  ipPage: { rows: AuditGridRow[]; nextCursor: AuditCursor | null } | null;
  ipFacilities: TagOption[];
  ipPayers: TagOption[];
  opFacilities: TagOption[];
  opPayers: TagOption[];
}

export function BillingAuditWorkbench(props: BillingAuditWorkbenchProps) {
  const { view, canRevealPhi, initialFilter } = props;
  const [active, setActive] = useState<AuditTab>('ip');
  const tabRefs = useRef<Record<AuditTab, HTMLButtonElement | null>>({ ip: null, op: null, flags: null });

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
              {t.id === 'flags' && (
                <span className="rounded-full bg-ground px-1.5 font-mono text-[10.5px] font-medium text-ink400" title="No flags until Phase 3">0</span>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`billing-audit-panel-${active}`} aria-labelledby={`billing-audit-tab-${active}`}>
        {active === 'flags' ? (
          <FlagQueueEmptyState />
        ) : active === 'ip' ? (
          <ScopePanel
            scope="ip" view={view} canRevealPhi={canRevealPhi} initialFilter={initialFilter}
            facilities={props.ipFacilities} payers={props.ipPayers} initialPage={props.ipPage}
          />
        ) : (
          <ScopePanel
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
      <AuditWorkTable scope={auditScope} view={view} canRevealPhi={canRevealPhi} filter={filter} initialPage={initialPage} onOpenDrill={openDrill} />
      <PatientDrill scope={auditScope} view={view} canRevealPhi={canRevealPhi} target={drillTarget} onClose={() => setDrillTarget(null)} />
    </div>
  );
}

function FlagQueueEmptyState() {
  return (
    <div className="rounded-xl border border-line bg-card p-12 text-center">
      <span className="mx-auto mb-4 inline-block rounded-full bg-teal50 px-3 py-1 font-mono text-xs text-teal700">
        PHASE 3 · NOT YET ACTIVATED
      </span>
      <h2 className="ths-h text-xl font-semibold">No flags yet</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
        The Flag Queue is live as a destination, but the flag engine hasn&rsquo;t been switched on.
        Once the ingest soak clears and the facility-scoped resolver is in place, computed exceptions
        (missing auth, code-vs-decision mismatch, stopped-code-still-billed, stale-at-payer,
        aged-on-hold) will land here for acknowledge / resolve / dismiss.
      </p>
    </div>
  );
}
