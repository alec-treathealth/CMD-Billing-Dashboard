'use client';

/**
 * Billing Audit patient drill (Phase-4 build 5) — a right slide-over showing ONE patient's charge
 * lines (grouped by cmd_patient_id) for the current scope. Detail is NON-PHI (masked). Name / DOB /
 * member id are exposed only via an explicit canRevealPhi-gated + server-audited reveal
 * (revealAuditPatientAction → recordAccess 'reveal_audit_row'). Nothing PHI is fetched until the
 * user clicks Reveal.
 */
import { useEffect, useState } from 'react';
import { StatusChip, money } from './work-table';
import { loadAuditPatientDetailAction, revealAuditPatientAction, type AuditGridRow, type AuditRevealedPatient } from '@/lib/actions';
import type { AuditScope } from '../../../src/billingAudit/auditConfig';
import type { DashboardView } from '@/lib/views';

export interface DrillTarget { cmdPatientId: string; facility: string | null; payer: string | null; }

export function PatientDrill({ scope, view, canRevealPhi, target, revealAll, onClose }: {
  scope: AuditScope;
  view: DashboardView;
  canRevealPhi: boolean;
  target: DrillTarget | null;
  /** Page-level reveal toggle (shared from ScopePanel) — when on, the drill auto-reveals on open. */
  revealAll: boolean;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<AuditGridRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState<AuditRevealedPatient | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  const open = target !== null;
  const patientId = target?.cmdPatientId ?? null;

  useEffect(() => {
    if (!patientId) return;
    setRows([]); setRevealed(null); setRevealErr(null);
    let cancelled = false;
    setLoading(true);
    loadAuditPatientDetailAction(scope, patientId, view).then((res) => {
      if (cancelled) return;
      setRows(res.ok ? res.rows : []);
      setLoading(false);
    });
    // When the page-level "Reveal all" is on, auto-reveal on open so the drill shows PHI
    // immediately (no second click) — the SAME gated + audited action as the manual button.
    if (revealAll && canRevealPhi) {
      setRevealing(true);
      revealAuditPatientAction(scope, patientId, view).then((res) => {
        if (cancelled) return;
        if (res.ok) setRevealed(res.patient); else setRevealErr(res.error);
        setRevealing(false);
      });
    }
    return () => { cancelled = true; };
  }, [patientId, scope, view, revealAll, canRevealPhi]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  const charged = rows.reduce((sum, r) => sum + (Number(r.charge_amount_cents) || 0), 0);
  const firstDos = rows.map((r) => r.charge_from_date).filter(Boolean).sort()[0] ?? null;

  const reveal = async () => {
    if (!patientId) return;
    setRevealing(true); setRevealErr(null);
    const res = await revealAuditPatientAction(scope, patientId, view);
    if (res.ok) setRevealed(res.patient);
    else setRevealErr(res.error);
    setRevealing(false);
  };

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-[rgba(20,30,29,0.28)] transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Patient breakdown"
        aria-hidden={!open}
        className={`fixed right-0 top-0 z-40 flex h-full w-[460px] max-w-[92vw] flex-col bg-card shadow-2xl transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {target && (
          <>
            <div className="flex items-start gap-2 border-b border-line px-4 py-3">
              <div>
                <h3 className="ths-h text-base font-semibold">
                  {revealed
                    ? <span>{revealed.patient_name}</span>
                    : <span className="font-mono tracking-widest text-ink400">••••••</span>}
                  {' '}— patient breakdown
                </h3>
                <div className="mt-0.5 font-mono text-[11px] text-ink400">
                  PT-{target.cmdPatientId} · {target.facility ?? '—'} · {scope}
                </div>
              </div>
              <button onClick={onClose} aria-label="Close" className="ml-auto text-lg leading-none text-ink400 hover:text-ink600">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-ink400">Payer</dt><dd className="text-right text-ink900">{target.payer ?? '—'}</dd>
                <dt className="text-ink400">Member ID</dt>
                <dd className="text-right">
                  {revealed ? (
                    <span className="font-mono text-ink900">{revealed.member_id ?? '—'}</span>
                  ) : canRevealPhi ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-ink400">••••••••</span>
                      <button onClick={reveal} disabled={revealing} className="rounded border border-line-strong bg-ground px-1.5 text-[10.5px] text-teal700 disabled:opacity-50">
                        {revealing ? 'Revealing…' : 'Reveal'}
                      </button>
                    </span>
                  ) : (
                    <span className="font-mono text-ink400" title="Your role does not permit revealing identifiers">••••••••</span>
                  )}
                </dd>
                {revealed && (
                  <>
                    <dt className="text-ink400">Patient name</dt><dd className="text-right text-ink900">{revealed.patient_name}</dd>
                    <dt className="text-ink400">DOB</dt><dd className="text-right font-mono text-ink900">{revealed.patient_dob ?? '—'}</dd>
                  </>
                )}
                <dt className="text-ink400">First charge date</dt><dd className="text-right font-mono text-ink900">{firstDos ?? '—'}</dd>
                <dt className="text-ink400">Charged (sum)</dt><dd className="text-right font-mono text-ink900">{money(String(charged))}</dd>
                <dt className="text-ink400">Charge lines</dt><dd className="text-right font-mono text-ink900">{rows.length}</dd>
                <dt className="text-ink400">Open flags</dt><dd className="text-right font-mono text-ink400">0</dd>
              </dl>
              {revealErr && <p className="mb-3 text-xs text-[color:var(--status-danger,#C0453B)]">{revealErr}</p>}

              <h4 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink400">Charge lines</h4>
              {loading ? (
                <p className="py-6 text-center text-xs text-ink400">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink400">No charge lines.</p>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => (
                    <div key={r.id} className="rounded-lg border border-line p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-ink900">{[r.cpt_code, r.rev_code].filter(Boolean).join(' / ') || '—'}</span>
                        <span className="font-mono text-xs text-ink900">{money(r.charge_amount_cents)}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink600">
                        <span><span className="text-ink400">DOS</span> <span className="font-mono">{r.charge_from_date ?? '—'}</span></span>
                        {r.units ? <span><span className="text-ink400">Units</span> <span className="font-mono">{r.units}</span></span> : null}
                        {r.type_of_bill ? <span><span className="text-ink400">TOB</span> <span className="font-mono">{r.type_of_bill}</span></span> : null}
                        {r.auth_number ? <span><span className="text-ink400">Auth</span> <span className="font-mono">{r.auth_number}</span></span> : null}
                        <StatusChip category={r.status_category} payer={r.status_payer} />
                      </div>
                      {r.principal_diag ? <div className="mt-1 text-[11px] text-ink600"><span className="text-ink400">Principal Dx</span> <span className="font-mono">{r.principal_diag}</span></div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
