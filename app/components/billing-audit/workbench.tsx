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
import { DEFAULT_PRESET, type Preset } from './date-presets';
import type { TagOption } from './tag-picker';
import type { AuditCursor, AuditFilter, AuditGridRow } from '@/lib/actions';
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
  const auditScope: AuditScope = scope === 'ip' ? 'IP' : 'OP';
  return (
    <div className="space-y-3">
      <AuditFilterBar
        facilities={facilities}
        payers={payers}
        value={filter}
        activePreset={preset}
        onChange={(next, p) => { setFilter(next); setPreset(p); }}
      />
      <AuditWorkTable scope={auditScope} view={view} canRevealPhi={canRevealPhi} filter={filter} initialPage={initialPage} />
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
