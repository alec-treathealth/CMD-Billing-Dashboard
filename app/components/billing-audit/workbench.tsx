'use client';

/**
 * Billing Audit workbench — the client shell that hosts the three subtabs (IP Audit / OP Audit /
 * Flag Queue) as in-page state (one route, no sub-navigation), matching how Collections keeps its
 * surfaces in a single page. Milestone 1 wires the accessible tab shell + panels; the filter bar,
 * work table, pivot strip, and patient drill fill the IP/OP panels in later build steps. The Flag
 * Queue is a REAL destination now, deliberately inert (empty state) until the Phase-3 flag engine
 * computes exceptions into claims.flag after the soak clears.
 *
 * `canRevealPhi` is threaded down (a plain `user` never sees the reveal control; the reveal action
 * is gated server-side regardless). `view` carries the tenant scope resolved on the server.
 */
import { useCallback, useRef, useState } from 'react';
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
}

export function BillingAuditWorkbench({ view, canRevealPhi }: BillingAuditWorkbenchProps) {
  const [active, setActive] = useState<AuditTab>('ip');
  const tabRefs = useRef<Record<AuditTab, HTMLButtonElement | null>>({ ip: null, op: null, flags: null });

  // Roving arrow-key navigation across the tablist (no Tabs primitive exists in this app).
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
      <div
        role="tablist"
        aria-label="Billing audit scope"
        onKeyDown={onKeyDown}
        className="flex items-center gap-1 border-b border-line"
      >
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
                selected
                  ? 'border-[var(--brand-accent)] text-[var(--brand-ink)]'
                  : 'border-transparent text-ink400 hover:text-ink600',
              ].join(' ')}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`billing-audit-panel-${active}`}
        aria-labelledby={`billing-audit-tab-${active}`}
      >
        {active === 'flags' ? (
          <FlagQueueEmptyState />
        ) : (
          <ScopePanelPlaceholder scope={active} view={view} canRevealPhi={canRevealPhi} />
        )}
      </div>
    </section>
  );
}

/** Placeholder for the IP/OP work-table panel — replaced by the filter bar + work table +
 *  pivot strip + patient drill in the next build milestones. Kept honest, not faked with data. */
function ScopePanelPlaceholder({ scope, view, canRevealPhi }: { scope: 'ip' | 'op'; view: DashboardView; canRevealPhi: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-card p-10 text-center">
      <h2 className="ths-h text-lg font-semibold">
        {scope === 'ip' ? 'IP Audit' : 'OP Audit'} — work table
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        Filter bar, dense work table, pivot strip, and patient drill are being wired in the next
        build steps. Scope: <span className="font-medium text-ink600">{view}</span>
        {canRevealPhi ? ' · reveal enabled for your role' : ' · reveal disabled for your role'}.
      </p>
    </div>
  );
}

/** Flag Queue — a real tab, empty until Phase 3 switches on the flag engine. */
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
