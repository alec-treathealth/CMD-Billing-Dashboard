'use client';

/**
 * Billing Audit filter bar (Phase-4 build 2) — NON-PHI filters only. Patient search is a gated
 * PHI op and lands with the drill/reveal (build 5); the "has open flags" toggle is inert until
 * the Phase-3 flag engine writes claims.flag. Controlled: emits the full AuditFilter on change.
 */
import { useMemo } from 'react';
import { MultiSelectTagPicker, type TagOption } from './tag-picker';
import { presetWindow, type Preset } from './date-presets';
import type { AuditFilter } from '@/lib/actions';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'PAID', label: 'Paid' },
  { value: 'AT_PAYER', label: 'At payer' },
  { value: 'BALANCE_DUE_PATIENT', label: 'Balance due — patient' },
  { value: 'APPROVED_HIGHER', label: 'Approved higher' },
  { value: 'NEEDS_RENEGOTIATING', label: 'Needs renegotiating' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'OTHER', label: 'Other' },
];

export interface AuditFilterBarProps {
  facilities: TagOption[];
  payers: TagOption[];
  value: AuditFilter;
  activePreset: Preset;
  onChange: (next: AuditFilter, preset: Preset) => void;
}

export function AuditFilterBar({ facilities, payers, value, activePreset, onChange }: AuditFilterBarProps) {
  const statusValue = value.statusCategories?.[0] ?? '';
  const patch = (p: Partial<AuditFilter>, preset: Preset = activePreset) => onChange({ ...value, ...p }, preset);
  const setPreset = (preset: Preset) => onChange({ ...value, ...presetWindow(preset) }, preset);

  const presets = useMemo(() => ([
    { id: 'ytd' as const, label: 'YTD' },
    { id: '7' as const, label: 'Past 7d' },
    { id: '14' as const, label: 'Past 14d' },
    { id: '30' as const, label: 'Past 30d' },
    { id: 'all' as const, label: 'All' },
  ]), []);

  return (
    <div className="flex flex-wrap items-start gap-2">
      {/* Date presets */}
      <div className="inline-flex overflow-hidden rounded-lg border border-line" role="group" aria-label="Date window">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={activePreset === p.id}
            onClick={() => setPreset(p.id)}
            className={`px-2.5 py-1.5 text-xs ${activePreset === p.id ? 'bg-teal700 font-semibold text-white' : 'bg-card text-ink600 hover:bg-teal50'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <MultiSelectTagPicker
        title="Facility"
        options={facilities}
        selected={value.facilityCodes ?? []}
        onChange={(next) => patch({ facilityCodes: next.length ? next : undefined })}
      />
      <MultiSelectTagPicker
        title="Payer"
        options={payers}
        selected={value.payerNames ?? []}
        onChange={(next) => patch({ payerNames: next.length ? next : undefined })}
      />

      {/* Status category (+ AT_PAYER sub-payer) */}
      <select
        aria-label="Status"
        value={statusValue}
        onChange={(e) => patch({
          statusCategories: e.target.value ? [e.target.value] : undefined,
          statusPayer: e.target.value === 'AT_PAYER' ? value.statusPayer : null,
        })}
        className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink900"
      >
        <option value="">Status: all</option>
        {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      {statusValue === 'AT_PAYER' && (
        <input
          aria-label="At-payer sub-status"
          placeholder="At-payer (e.g. BCBS)"
          value={value.statusPayer ?? ''}
          onChange={(e) => patch({ statusPayer: e.target.value.trim() ? e.target.value.trim() : null })}
          className="w-36 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs"
        />
      )}

      <input
        aria-label="CPT code"
        placeholder="CPT"
        value={value.cptCodes?.[0] ?? ''}
        onChange={(e) => patch({ cptCodes: e.target.value.trim() ? [e.target.value.trim()] : undefined })}
        className="w-24 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-mono"
      />
      <input
        aria-label="Revenue code"
        placeholder="Rev"
        value={value.revCodes?.[0] ?? ''}
        onChange={(e) => patch({ revCodes: e.target.value.trim() ? [e.target.value.trim()] : undefined })}
        className="w-20 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-mono"
      />

      {/* Inert until Phase 3 (claims.flag is empty). */}
      <span
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-dashed border-line bg-card px-2.5 py-1.5 text-xs text-ink400"
        title="Activated in Phase 3, once the flag engine computes exceptions."
      >
        <span className="h-3 w-3 rounded-[3px] border border-line-strong" /> Has open flags
      </span>
    </div>
  );
}
