'use client';

/**
 * MultiSelectTagPicker — type-ahead multi-select with removable tags (Facility / Payer).
 *
 * ⚠️ DUPLICATED (Alec's call, 2026-07-14) from the live cmd-explorer.tsx rather than extracted,
 * to avoid editing the shipped Collections explorer mid-soak. NAMED CLEANUP CANDIDATE: unify the
 * two into one shared component once the soak + Phase 3 settle (tracked in the session memory,
 * same pattern as the 4-arg save_grid_view overload).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

const SHOW_CAP = 50;

export interface TagOption {
  value: string;
  label: string;
  count?: number;
}

export function MultiSelectTagPicker({
  title,
  options,
  selected,
  onChange,
  placeholder,
}: {
  title: string;
  options: readonly TagOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    const pool = options.filter((o) => !selectedSet.has(o.value));
    const hit = q === '' ? pool : pool.filter((o) => o.label.toUpperCase().includes(q) || o.value.toUpperCase().includes(q));
    return hit.slice(0, SHOW_CAP);
  }, [options, query, selectedSet]);

  const add = (v: string) => { onChange([...selected, v]); setQuery(''); };
  const remove = (v: string) => onChange(selected.filter((x) => x !== v));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink600 hover:border-line-strong"
        aria-expanded={open}
      >
        <span className="font-medium text-ink900">{title}</span>
        {selected.length > 0 && (
          <span className="rounded-full bg-teal50 px-1.5 text-[11px] font-medium text-teal700 tabular-nums">{selected.length}</span>
        )}
        <span className="text-ink400">▾</span>
      </button>

      {selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {selected.map((v) => {
            const opt = options.find((o) => o.value === v);
            return (
              <span key={v} className="inline-flex items-center gap-1 rounded-full bg-teal700 px-2 py-0.5 text-[11px] text-white">
                {opt?.label ?? v}
                <button type="button" aria-label={`Remove ${opt?.label ?? v}`} onClick={() => remove(v)} className="opacity-70 hover:opacity-100">×</button>
              </span>
            );
          })}
        </div>
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-lg border border-line bg-card p-2 shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder ?? `Search ${title.toLowerCase()}…`}
            className="mb-2 w-full rounded-md border border-line px-2 py-1 text-xs outline-none focus:border-teal500"
          />
          <div className="max-h-64 overflow-y-auto">
            {matches.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-ink400">No matches</p>
            ) : (
              matches.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => add(o.value)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-teal50"
                >
                  <span className="truncate text-ink900">{o.label}</span>
                  {o.count !== undefined && <span className="shrink-0 text-[11px] tabular-nums text-ink400">{o.count.toLocaleString()}</span>}
                </button>
              ))
            )}
            {matches.length === SHOW_CAP && (
              <p className="px-2 pt-2 text-[11px] text-ink400">Showing first {SHOW_CAP} — keep typing to narrow.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
