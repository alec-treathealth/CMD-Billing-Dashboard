'use client';

/**
 * Field-picker (Phase 7.6) — the deterministic UI shown when /ask decides a search
 * is too broad to run (a whole-table scan). It collects ONLY safe, non-PHI
 * ClaimFilter inputs (facility, payer, service year, date range, HCPCS / revenue
 * code) and hands back a ClaimFilter; it NEVER requests patient name, member ID,
 * employer, group number, or any other PHI. Facet option lists come from the
 * cached, non-PHI distribution. Nothing here is persisted.
 */
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ClaimFacets, ClaimFilter } from '@/lib/actions';

/** Human labels for the safe filter fields the server may list in `missing`. */
const FIELD_LABELS: Record<string, string> = {
  facility: 'Facility',
  payer: 'Payer',
  source_year: 'Service year',
  date_from: 'Date from',
  date_to: 'Date to',
  hcpcs_code: 'HCPCS code',
  revenue_code: 'Revenue code',
};

interface Draft {
  facility: string;
  payer: string;
  source_year: string;
  date_from: string;
  date_to: string;
  hcpcs_code: string;
  revenue_code: string;
}

const EMPTY: Draft = {
  facility: '',
  payer: '',
  source_year: '',
  date_from: '',
  date_to: '',
  hcpcs_code: '',
  revenue_code: '',
};

/** Build a ClaimFilter from the draft; only non-empty, well-formed fields are kept. */
function draftToFilter(d: Draft): ClaimFilter {
  const f: ClaimFilter = {};
  if (d.facility.trim()) f.facility = d.facility.trim();
  if (d.payer.trim()) f.payer = d.payer.trim();
  if (/^\d{4}$/.test(d.source_year.trim())) f.source_year = Number(d.source_year.trim());
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.date_from.trim())) f.date_from = d.date_from.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.date_to.trim())) f.date_to = d.date_to.trim();
  if (d.hcpcs_code.trim()) f.hcpcs_code = d.hcpcs_code.trim();
  if (d.revenue_code.trim()) f.revenue_code = d.revenue_code.trim();
  return f;
}

export function FieldPicker({
  missing,
  facets,
  pending,
  onSubmit,
}: {
  missing: string[];
  facets: ClaimFacets | null;
  pending: boolean;
  onSubmit: (filter: ClaimFilter) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const set = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const filter = useMemo(() => draftToFilter(draft), [draft]);
  const hasAny = Object.keys(filter).length > 0;

  // Only offer fields the server flagged (defaults to the full safe set).
  const show = (k: string) => missing.length === 0 || missing.includes(k);

  return (
    <div className="space-y-3 rounded-md border border-teal200 bg-teal50/40 p-4">
      <div className="text-sm text-ink600">
        That search would scan every claim. Add at least one filter to narrow it — these are the only
        fields used (no patient identifiers).
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {show('facility') && (
          <Field label={FIELD_LABELS.facility} id="fp-facility">
            <SelectOrInput
              id="fp-facility"
              value={draft.facility}
              onChange={(v) => set('facility', v)}
              options={facets?.facility}
              placeholder="any facility"
            />
          </Field>
        )}
        {show('payer') && (
          <Field label={FIELD_LABELS.payer} id="fp-payer">
            <SelectOrInput
              id="fp-payer"
              value={draft.payer}
              onChange={(v) => set('payer', v)}
              options={facets?.payer}
              placeholder="any payer"
            />
          </Field>
        )}
        {show('source_year') && (
          <Field label={FIELD_LABELS.source_year} id="fp-year">
            <SelectOrInput
              id="fp-year"
              value={draft.source_year}
              onChange={(v) => set('source_year', v)}
              options={facets?.source_year.map(String)}
              placeholder="any year"
              inputMode="numeric"
            />
          </Field>
        )}
        {show('date_from') && (
          <Field label={FIELD_LABELS.date_from} id="fp-from">
            <Input id="fp-from" type="date" value={draft.date_from} onChange={(e) => set('date_from', e.target.value)} />
          </Field>
        )}
        {show('date_to') && (
          <Field label={FIELD_LABELS.date_to} id="fp-to">
            <Input id="fp-to" type="date" value={draft.date_to} onChange={(e) => set('date_to', e.target.value)} />
          </Field>
        )}
        {show('hcpcs_code') && (
          <Field label={FIELD_LABELS.hcpcs_code} id="fp-hcpcs">
            <Input id="fp-hcpcs" value={draft.hcpcs_code} placeholder="e.g. H0015" onChange={(e) => set('hcpcs_code', e.target.value)} />
          </Field>
        )}
        {show('revenue_code') && (
          <Field label={FIELD_LABELS.revenue_code} id="fp-rev">
            <Input id="fp-rev" value={draft.revenue_code} placeholder="e.g. 0906" onChange={(e) => set('revenue_code', e.target.value)} />
          </Field>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={!hasAny || pending} onClick={() => onSubmit(filter)}>
          {pending ? 'Searching…' : 'Run filtered search'}
        </Button>
        {!hasAny && <span className="text-xs text-muted-foreground">Set at least one field.</span>}
      </div>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/** A native select when facet options exist, else a free-text input fallback. */
function SelectOrInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  inputMode,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options?: string[];
  placeholder?: string;
  inputMode?: 'numeric';
}) {
  if (options && options.length > 0) {
    return (
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <option value="">{placeholder ?? 'any'}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      id={id}
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
