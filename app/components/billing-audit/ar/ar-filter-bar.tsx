'use client';

/**
 * AR queue filters — NON-PHI facets plus the gated patient search. Controlled: emits the full
 * ArFilter on every change. Facility and payer use the shared MultiSelectTagPicker (client mode:
 * the vocabularies are ≤19 facilities and ≤400 payers, loaded once with the page). The patient box
 * is shown only to reveal-entitled roles and resolves to blind-index tokens server-side — no name
 * or member id is ever held outside this component's local input state.
 */
import { useState } from 'react';
import { Building2, Landmark, Search, X } from 'lucide-react';
import { MultiSelectTagPicker, type PickerOption } from '@/components/ui/multi-select-tag-picker';
import { SELECT_CLASS } from '@/components/data-grid';
import { WORK_STATUS_META, type ArFilter, type ArOptions, type ArWorkStatus } from '@/lib/ar/contract';
import { moneyCompact } from './ar-leaves';

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Any CMD status' },
  { value: 'AT_PAYER', label: 'At payer' },
  { value: 'BALANCE_DUE_PATIENT', label: 'Patient balance' },
  { value: 'NEEDS_RENEGOTIATING', label: 'Needs renegotiating' },
  { value: 'APPROVED_HIGHER', label: 'Approved higher' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'OTHER', label: 'Other / write-off / escalations' },
  { value: 'PAID', label: 'Paid (needs "include paid")' },
];

export interface ArFilterBarProps {
  options: ArOptions | null;
  filter: ArFilter;
  onChange: (next: ArFilter) => void;
  canRevealPhi: boolean;
  onPatientSearch: (term: string) => void;
  searching: boolean;
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={[
        'rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        on ? 'border-teal700 bg-teal700 text-white' : 'border-line bg-card text-ink600 hover:bg-teal50 hover:text-ink900',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function ArFilterBar({ options, filter, onChange, canRevealPhi, onPatientSearch, searching }: ArFilterBarProps) {
  const [q, setQ] = useState('');
  const patch = (p: Partial<ArFilter>) => onChange({ ...filter, ...p });
  const searchActive = Boolean(filter.patientNameBidx || filter.patientNamePrefixBidx || filter.memberIdBidx);

  const facilityOptions: PickerOption[] = (options?.facilities ?? []).map((f) => ({
    value: f.facility_code,
    display: f.facility_code,
    detail: `${f.n.toLocaleString('en-US')} open · ${moneyCompact(f.balance)}`,
    searchText: f.facility_name ? [f.facility_name] : [],
  }));
  const payerOptions: PickerOption[] = (options?.payers ?? []).map((p) => ({
    value: p.payer_name,
    display: p.payer_name,
    detail: `${p.n.toLocaleString('en-US')} open · ${moneyCompact(p.balance)}`,
  }));

  const toggleList = (key: 'facilityCodes' | 'payerNames', value: string) => {
    const cur: string[] = filter[key] ?? [];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    patch(key === 'facilityCodes' ? { facilityCodes: next.length ? next : undefined } : { payerNames: next.length ? next : undefined });
  };
  const toggleWork = (value: ArWorkStatus) => {
    const cur = filter.workStatuses ?? [];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    patch({ workStatuses: next.length ? next : undefined });
  };

  const anyActive = Boolean(
    filter.facilityCodes || filter.payerNames || filter.statusCategories || filter.workStatuses || filter.assigneeUserIds ||
    filter.hasDenial || filter.includePaid || filter.followupOverdue || filter.minBalance || searchActive,
  );

  return (
    <div className="rounded-lg border border-line bg-card p-3 shadow-ths-sm">
      <div className="grid gap-3 lg:grid-cols-2">
        <MultiSelectTagPicker
          label="Facility"
          placeholder="Type a facility code or name…"
          icon={<Building2 aria-hidden className="h-4 w-4" />}
          options={facilityOptions}
          selected={filter.facilityCodes ?? []}
          onToggle={(v) => toggleList('facilityCodes', v)}
          onClear={() => patch({ facilityCodes: undefined })}
        />
        <MultiSelectTagPicker
          label="Payer (claim is at)"
          placeholder="Type a payer…"
          icon={<Landmark aria-hidden className="h-4 w-4" />}
          options={payerOptions}
          selected={filter.payerNames ?? []}
          onToggle={(v) => toggleList('payerNames', v)}
          onClear={() => patch({ payerNames: undefined })}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="ar-status">CMD status</label>
        <select
          id="ar-status"
          className={SELECT_CLASS}
          value={filter.statusCategories?.[0] ?? ''}
          onChange={(e) => patch({ statusCategories: e.target.value ? [e.target.value] : undefined, includePaid: e.target.value === 'PAID' ? true : filter.includePaid })}
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <label className="sr-only" htmlFor="ar-assignee">Assignee</label>
        <select
          id="ar-assignee"
          className={SELECT_CLASS}
          value={filter.assigneeUserIds?.[0] ?? ''}
          onChange={(e) => patch({ assigneeUserIds: e.target.value ? [e.target.value] : undefined })}
        >
          <option value="">Any assignee</option>
          {(options?.assignees ?? []).map((a) => <option key={a.user_id} value={a.user_id}>{a.email}</option>)}
        </select>

        <div role="group" aria-label="Work status" className="flex flex-wrap items-center gap-1">
          {WORK_STATUS_META.map((m) => (
            <Toggle key={m.value} on={(filter.workStatuses ?? []).includes(m.value)} onClick={() => toggleWork(m.value)}>{m.label}</Toggle>
          ))}
        </div>

        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <Toggle on={Boolean(filter.hasDenial)} onClick={() => patch({ hasDenial: filter.hasDenial ? undefined : true })}>Has denial</Toggle>
        <Toggle on={Boolean(filter.followupOverdue)} onClick={() => patch({ followupOverdue: filter.followupOverdue ? undefined : true })}>Follow-up overdue</Toggle>
        <Toggle on={Boolean(filter.includePaid)} onClick={() => patch({ includePaid: filter.includePaid ? undefined : true })}>Include paid</Toggle>

        {canRevealPhi ? (
          <form
            className="ml-auto flex items-center gap-1"
            onSubmit={(e) => { e.preventDefault(); onPatientSearch(q); }}
          >
            <label className="sr-only" htmlFor="ar-patient-search">Patient name or member id</label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink400" />
              <input
                id="ar-patient-search"
                type="search"
                autoComplete="off"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Patient name or member id"
                className="h-9 w-56 rounded-md border border-line bg-surface pl-7 pr-2 text-sm text-ink900 placeholder:text-ink400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button type="submit" disabled={searching} className="h-9 rounded-md bg-teal700 px-3 text-xs font-semibold text-white transition-colors hover:bg-teal900 disabled:opacity-60">
              {searching ? 'Searching…' : 'Search'}
            </button>
            {searchActive ? (
              <button type="button" onClick={() => { setQ(''); onPatientSearch(''); }} className="inline-flex h-9 items-center gap-1 rounded-md border border-line px-2 text-xs text-ink600 hover:bg-teal50" aria-label="Clear patient search">
                <X aria-hidden className="h-3.5 w-3.5" /> patient
              </button>
            ) : null}
          </form>
        ) : null}

        {anyActive ? (
          <button type="button" onClick={() => { setQ(''); onChange({}); }} className="text-xs font-medium text-teal700 underline-offset-2 hover:underline">
            Clear all
          </button>
        ) : null}
      </div>
    </div>
  );
}
