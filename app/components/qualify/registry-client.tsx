'use client';

/**
 * Registry CRUD client (Phase A). Reads arrive via the server component (getCodingRegistry — already
 * super_admin-gated); writes go through saveCodingDecision, which re-gates, zod-validates, and runs
 * the insert + supersede + audit in ONE coding_editor transaction. After a write, router.refresh()
 * re-renders the server component — no client-side cache to drift.
 *
 * Three degraded states are DESIGNED, not errors:
 *   available:false → migration 0077 not applied yet (the fail-soft class) — read-only notice.
 *   editable:false  → CODING_WRITER_DB_URL not configured — table renders, editing disabled.
 *   rows:[]         → applied but unseeded — points at the seed importer.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  saveCodingDecision,
  type CodingRegistryList,
  type CodingDecisionInput,
} from '@/lib/qualify/registry-actions';

const LIFECYCLES = [
  'CONFIRMED CODES',
  'FINALIZED CODES',
  'CONTINUE TESTS',
  'OPEN TEST',
  'UPCOMING TEST',
  'CLOSED',
  'DISCONTINUED',
  'DISCONTINUE - DID NOT WORK',
] as const;

const LOCS = ['DTX', 'RTC', 'IP', 'IOP', 'OP'] as const;

function lifecycleClass(lc: string): string {
  if (lc === 'CONFIRMED CODES' || lc === 'FINALIZED CODES') return 'bg-[#E6F2EC] text-status-ok';
  if (lc === 'DISCONTINUED' || lc === 'DISCONTINUE - DID NOT WORK') return 'bg-[#FBE7E4] text-status-danger';
  if (lc === 'CLOSED') return 'bg-[#F4F2EF] text-ink400';
  return 'bg-[#FBF1DE] text-status-warn';
}

function codesLabel(r: CodingRegistryList['rows'][number]): string {
  if (r.hcpcs_suppressed) return `NO HCPCS / ${r.revenue_code}`;
  return r.hcpcs_code ? `${r.hcpcs_code} / ${r.revenue_code}` : r.revenue_code;
}

const EMPTY_FORM = {
  payer_family: '',
  payer_variant_label: '',
  facility_code: '',
  level_of_care: '' as string,
  hcpcs_code: '',
  revenue_code: '',
  hcpcs_suppressed: false,
  type_of_bill: '',
  dos_batch: '',
  lifecycle: 'OPEN TEST' as (typeof LIFECYCLES)[number],
  decided_on: '',
  notes: '',
};

export function RegistryClient({ initial }: { initial: CodingRegistryList }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState(EMPTY_FORM);
  const [supersedes, setSupersedes] = useState<number | null>(null);
  // The full row being superseded: the form edits its headline fields, but the columns the form
  // does NOT surface (plan_alpha, employer_norm, DRG, condition codes, modifiers, units, span)
  // must carry into the superseding insert — versioning must never silently strip attributes.
  const [carry, setCarry] = useState<CodingRegistryList['rows'][number] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  if (!initial.available) {
    return (
      <section className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground shadow-ths-sm">
        <p className="font-semibold text-ink600">The registry tables are not live yet.</p>
        <p className="mt-1">
          Migration <b className="font-mono">0077_coding_decision_registry</b> is written but not applied. Apply it,
          run the seed importer, and this page lights up — nothing else to deploy.
        </p>
      </section>
    );
  }

  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const submit = () => {
    setError(null);
    const batch = form.dos_batch.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const carried: Partial<CodingDecisionInput> =
      supersedes !== null && carry
        ? {
            plan_alpha: carry.plan_alpha,
            employer_norm: carry.employer_norm,
            drg_code: carry.drg_code,
            condition_codes: carry.condition_codes,
            modifiers_removed: carry.modifiers_removed,
            units_per_dos: carry.units_per_dos,
            billing_span: carry.billing_span === 'admit_dc' || carry.billing_span === 'interim' ? carry.billing_span : null,
          }
        : {};
    const input: CodingDecisionInput = {
      ...carried,
      payer_family: form.payer_family,
      payer_variant_label: form.payer_variant_label || null,
      facility_code: form.facility_code || null,
      level_of_care: (LOCS as readonly string[]).includes(form.level_of_care) ? (form.level_of_care as (typeof LOCS)[number]) : null,
      hcpcs_code: form.hcpcs_suppressed ? null : form.hcpcs_code || null,
      revenue_code: form.revenue_code,
      hcpcs_suppressed: form.hcpcs_suppressed,
      dos_batch_min: batch ? Number(batch[1]) : null,
      dos_batch_max: batch ? Number(batch[2] ?? batch[1]) : null,
      type_of_bill: form.type_of_bill || null,
      lifecycle: form.lifecycle,
      decided_on: form.decided_on,
      effective_from: form.decided_on,
      notes: form.notes || null,
    };
    startTransition(async () => {
      const res = await saveCodingDecision(input, supersedes ?? undefined);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSavedId(res.id);
      setForm(EMPTY_FORM);
      setSupersedes(null); setCarry(null);
      setFormOpen(false);
      router.refresh();
    });
  };

  const beginSupersede = (r: CodingRegistryList['rows'][number]) => {
    setSupersedes(r.id);
    setCarry(r);
    setForm({
      payer_family: r.payer_family,
      payer_variant_label: r.payer_variant_label ?? '',
      facility_code: r.facility_code ?? '',
      level_of_care: r.level_of_care ?? '',
      hcpcs_code: r.hcpcs_code ?? '',
      revenue_code: r.revenue_code,
      hcpcs_suppressed: r.hcpcs_suppressed,
      type_of_bill: r.type_of_bill ?? '',
      dos_batch: r.dos_batch_min === null ? '' : r.dos_batch_max === null || r.dos_batch_max === r.dos_batch_min ? String(r.dos_batch_min) : `${r.dos_batch_min}-${r.dos_batch_max}`,
      lifecycle: (LIFECYCLES as readonly string[]).includes(r.lifecycle) ? (r.lifecycle as (typeof LIFECYCLES)[number]) : 'OPEN TEST',
      decided_on: '',
      notes: '',
    });
    setFormOpen(true);
  };

  const current = initial.rows.filter((r) => r.effective_to === null);
  const history = initial.rows.filter((r) => r.effective_to !== null);

  return (
    <div className="space-y-4">
      {!initial.editable ? (
        <p className="rounded-xl border border-dashed border-line bg-surface px-4 py-2.5 text-[12.5px] text-muted-foreground">
          Read-only: the <b className="font-mono">coding_editor</b> connection (<b className="font-mono">CODING_WRITER_DB_URL</b>)
          is not configured in this environment yet. Reads work; edits will once the env var lands.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setFormOpen((v) => !v);
              setSupersedes(null); setCarry(null);
              setError(null);
            }}
            className="rounded-lg bg-teal700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal900"
          >
            {formOpen && supersedes === null ? 'Close' : 'New decision'}
          </button>
          {savedId !== null ? <span className="text-[12.5px] text-status-ok">Saved decision #{savedId}.</span> : null}
        </div>
      )}

      {formOpen && initial.editable ? (
        <section className="rounded-2xl border bg-card p-4 shadow-ths-sm">
          <h2 className="font-head text-sm font-semibold tracking-tight">
            {supersedes !== null ? `Supersede decision #${supersedes}` : 'New decision'}
          </h2>
          {supersedes !== null ? (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              The old row is closed (effective_to = the new decision date) and linked — never overwritten.
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="text-[11px] font-semibold text-ink600">
              Payer family*
              <input value={form.payer_family} onChange={set('payer_family')} placeholder="BCBS" className="mt-1 w-full rounded-lg border border-teal200 px-2 py-1.5 text-[13px]" />
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Variant label
              <input value={form.payer_variant_label} onChange={set('payer_variant_label')} placeholder="Anthem BCBS (ALL OTHERS)" className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-[13px]" />
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Facility code
              <input value={form.facility_code} onChange={set('facility_code')} placeholder="NMH (blank = payer-wide)" className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-[13px]" />
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Level of care
              <select value={form.level_of_care} onChange={set('level_of_care')} className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px]">
                <option value="">—</option>
                {LOCS.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              HCPCS
              <input value={form.hcpcs_code} onChange={set('hcpcs_code')} disabled={form.hcpcs_suppressed} placeholder="H0017" className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 font-mono text-[13px] disabled:bg-ground disabled:text-ink400" />
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Revenue code*
              <input value={form.revenue_code} onChange={set('revenue_code')} placeholder="0158" className="mt-1 w-full rounded-lg border border-teal200 px-2 py-1.5 font-mono text-[13px]" />
            </label>
            <label className="flex items-end gap-2 pb-1 text-[11px] font-semibold text-ink600">
              <input type="checkbox" checked={form.hcpcs_suppressed} onChange={set('hcpcs_suppressed')} className="h-4 w-4 accent-teal700" />
              NO HCPCS (rev only — a billing method, not a gap)
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              DOS per claim
              <input value={form.dos_batch} onChange={set('dos_batch')} placeholder="1 or 2-3" className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 font-mono text-[13px]" />
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Type of bill
              <input value={form.type_of_bill} onChange={set('type_of_bill')} placeholder="863 / 86X" className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 font-mono text-[13px]" />
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Lifecycle*
              <select value={form.lifecycle} onChange={set('lifecycle')} className="mt-1 w-full rounded-lg border border-teal200 bg-surface px-2 py-1.5 text-[13px]">
                {LIFECYCLES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-semibold text-ink600">
              Decided on*
              <input type="date" value={form.decided_on} onChange={set('decided_on')} className="mt-1 w-full rounded-lg border border-teal200 px-2 py-1.5 text-[13px]" />
            </label>
            <label className="col-span-2 text-[11px] font-semibold text-ink600 md:col-span-4">
              Notes
              <textarea value={form.notes} onChange={set('notes')} rows={2} className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-[13px]" />
            </label>
          </div>
          {error ? <p className="mt-2 text-[12.5px] font-semibold text-status-danger">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={pending || form.payer_family.trim() === '' || form.revenue_code.trim() === '' || form.decided_on === ''}
              onClick={submit}
              className="rounded-lg bg-teal700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal900 disabled:opacity-50"
            >
              {pending ? 'Saving…' : supersedes !== null ? 'Save & supersede' : 'Save decision'}
            </button>
            <button type="button" onClick={() => { setFormOpen(false); setSupersedes(null); setCarry(null); }} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink600">
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border bg-card shadow-ths-sm">
        <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
          <h2 className="font-head text-sm font-semibold tracking-tight">Current decisions</h2>
          <span className="text-[11.5px] text-muted-foreground">{current.length} live</span>
        </div>
        {current.length === 0 ? (
          <p className="px-4 pb-5 text-[13px] text-muted-foreground">
            Nothing seeded yet — run <b className="font-mono">scripts/seed-coding-decisions.ts</b> against the reconciled
            matrix TSV, then this table (and the coding factor on every scorecard) lights up.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-line bg-ground text-left text-[10.5px] font-bold uppercase tracking-wide text-ink400">
                  <th className="px-4 py-2">Payer</th>
                  <th className="px-2 py-2">Facility</th>
                  <th className="px-2 py-2">LOC</th>
                  <th className="px-2 py-2">Codes</th>
                  <th className="px-2 py-2">DOS</th>
                  <th className="px-2 py-2">TOB</th>
                  <th className="px-2 py-2">Lifecycle</th>
                  <th className="px-2 py-2">Decided</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {current.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="px-4 py-2">
                      <b className="font-semibold text-ink900">{r.payer_family}</b>
                      {r.payer_variant_label ? <span className="block text-[11px] text-ink400">{r.payer_variant_label}</span> : null}
                    </td>
                    <td className="px-2 py-2 font-mono text-[12px]">{r.facility_code ?? <span className="text-ink400">payer-wide</span>}</td>
                    <td className="px-2 py-2">{r.level_of_care ?? '—'}</td>
                    <td className="px-2 py-2 font-mono text-[12px]">{codesLabel(r)}</td>
                    <td className="px-2 py-2 font-mono text-[12px]">
                      {r.dos_batch_min === null ? '—' : r.dos_batch_max === null || r.dos_batch_max === r.dos_batch_min ? r.dos_batch_min : `${r.dos_batch_min}-${r.dos_batch_max}`}
                    </td>
                    <td className="px-2 py-2 font-mono text-[12px]">{r.type_of_bill ?? '—'}</td>
                    <td className="px-2 py-2">
                      <span className={['inline-flex rounded-full px-2 py-px text-[10.5px] font-bold', lifecycleClass(r.lifecycle)].join(' ')}>
                        {r.lifecycle}
                      </span>
                    </td>
                    <td className="px-2 py-2 font-mono text-[12px] tabular-nums">{r.decided_on}</td>
                    <td className="px-2 py-2 text-right">
                      {initial.editable ? (
                        <button type="button" onClick={() => beginSupersede(r)} className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-teal700 hover:border-teal200 hover:bg-teal50">
                          Supersede
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {history.length > 0 ? (
        <section className="overflow-hidden rounded-2xl border bg-card shadow-ths-sm">
          <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
            <h2 className="font-head text-sm font-semibold tracking-tight">History</h2>
            <span className="text-[11.5px] text-muted-foreground">{history.length} superseded — the drift the sheet could never show</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t border-line text-ink400">
                    <td className="px-4 py-1.5">{r.payer_family}{r.payer_variant_label ? ` · ${r.payer_variant_label}` : ''}</td>
                    <td className="px-2 py-1.5 font-mono text-[12px]">{r.facility_code ?? 'payer-wide'}</td>
                    <td className="px-2 py-1.5 font-mono text-[12px]">{codesLabel(r)}</td>
                    <td className="px-2 py-1.5">{r.lifecycle}</td>
                    <td className="px-2 py-1.5 font-mono text-[11.5px] tabular-nums">
                      {r.effective_from} → {r.effective_to}
                      {r.superseded_by !== null ? ` · superseded by #${r.superseded_by}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
