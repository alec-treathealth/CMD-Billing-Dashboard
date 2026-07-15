'use client';

/**
 * Billing Audit pivot strip (Phase-4 build 4) — a collapsible row of click-to-filter accelerators
 * (Office / Payer×CPT / Rev code) over the SAME (scope, tenant, filter) slice as the work table,
 * so the pivot and the rows it drills into always agree. All non-PHI aggregates. Collapsed by
 * default; fetches on first expand and whenever the filter changes while open.
 */
import { useEffect, useState } from 'react';
import { loadAuditPivotAction, type AuditFilter, type AuditPivot } from '@/lib/actions';
import type { AuditScope } from '../../../src/billingAudit/auditConfig';
import type { DashboardView } from '@/lib/views';

export interface PivotStripProps {
  scope: AuditScope;
  view: DashboardView;
  filter: AuditFilter;
  onDrill: (patch: Partial<AuditFilter>) => void;
}

export function PivotStrip({ scope, view, filter, onDrill }: PivotStripProps) {
  const [open, setOpen] = useState(false);
  const [pivot, setPivot] = useState<AuditPivot | null>(null);
  const [loading, setLoading] = useState(false);
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    loadAuditPivotAction(scope, filter, view).then((res) => {
      if (cancelled) return;
      setPivot(res.ok ? res.pivot : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filterKey, scope, view]);

  const n = (v: number) => v.toLocaleString();

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink600"
      >
        <span className={`text-ink400 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="ths-h font-semibold text-ink900">Pivot</span>
        <span className="text-ink400">— click any cell to filter the table below.</span>
        {loading && open ? <span className="ml-auto text-ink400">Loading…</span> : null}
      </button>

      {open && pivot && (
        <div className="flex flex-wrap gap-6 border-t border-line px-3 py-3">
          <PivotGroup title="By Office">
            {pivot.by_office.map((o) => (
              <PivotChip key={o.facility_code} label={o.label ?? o.facility_code} count={n(o.n)} onClick={() => onDrill({ facilityCodes: [o.facility_code] })} />
            ))}
          </PivotGroup>
          <PivotGroup title="By Payer × CPT">
            {pivot.by_payer_cpt.map((p, i) => (
              <PivotChip key={`${p.payer_name}|${p.cpt_code}|${i}`} label={`${p.payer_name} · ${p.cpt_code}`} count={n(p.n)} onClick={() => onDrill({ payerNames: [p.payer_name], cptCodes: [p.cpt_code] })} />
            ))}
          </PivotGroup>
          <PivotGroup title="By Rev Code">
            {pivot.by_rev.map((r) => (
              <PivotChip key={r.rev_code} label={r.rev_code} count={n(r.n)} onClick={() => onDrill({ revCodes: [r.rev_code] })} />
            ))}
          </PivotGroup>
        </div>
      )}
    </div>
  );
}

function PivotGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[200px]">
      <h4 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink400">{title}</h4>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function PivotChip({ label, count, onClick }: { label: string; count: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-xs hover:bg-teal50">
      <span className="truncate text-ink900">{label}</span>
      <span className="shrink-0 font-mono text-ink600">{count}</span>
    </button>
  );
}
