'use client';

/**
 * Shared guided multi-select "type-ahead + tags" picker — the search primitive used by the Collections
 * explorer (facility / payer / employer / funding) and the desktop Qualify tab (employer / funding).
 * Extracted from cmd-explorer so both surfaces render ONE consistent control (dashboard tokens only —
 * no new design language). Two modes:
 *   - CLIENT (default): the parent loads the full option list ONCE (facility ~30, payer ~260) and this
 *     picker filters it instantly client-side as the user types.
 *   - SERVER (pass `onQueryChange`): the parent owns the option list and re-fetches it per (debounced)
 *     keystroke — for the ~11.6k-employer vocabulary that's too large to load whole. The picker then
 *     does NOT filter client-side (options already reflect the query) and reports the raw query up.
 * Selected values render as removable tags; a filtered list drops below on focus/typing (capped, with
 * a "keep typing" hint past the cap).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';

/** One option in a guided picker. `value` is the raw filter value the query matches on; `display` is
 *  the friendly label shown; `badge` (facility only) shows the IP/OP/Both care setting. */
export type PickerOption = { value: string; display: string; badge?: 'IP' | 'OP' | 'BOTH' | null };

export function MultiSelectTagPicker({
  label,
  placeholder,
  icon,
  options,
  selected,
  onToggle,
  onClear,
  onQueryChange,
  loading = false,
  minChars = 0,
  displayOverride,
}: {
  label: string;
  placeholder: string;
  icon: React.ReactNode;
  options: PickerOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  /** SERVER mode: when provided, the parent owns `options` (fetched per query) and this picker does
   *  NOT filter client-side — it reports the raw query up (the parent debounces + fetches). */
  onQueryChange?: (q: string) => void;
  /** SERVER mode: an in-flight fetch is pending → show a "Searching…" state instead of "No matches". */
  loading?: boolean;
  /** SERVER mode: min chars before a search runs (drives the empty-state hint; mirror the server floor). */
  minChars?: number;
  /** value→display for selected tags whose value isn't in the CURRENT `options` (server mode: a picked
   *  employer stays labeled after the query moves on). Merged under the options-derived display map. */
  displayOverride?: Map<string, string>;
}) {
  const serverDriven = typeof onQueryChange === 'function';
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const displayOf = useMemo(() => {
    const m = new Map<string, string>(displayOverride ?? []);
    for (const o of options) m.set(o.value, o.display);
    return m;
  }, [options, displayOverride]);

  // Dismiss on outside pointer-down or Escape (same pattern as the Month/Year + view-switcher popovers).
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const CAP = 50;
  // SERVER mode: `options` already reflect the query (the server filtered) — never re-filter here.
  const matches = useMemo(
    () => (serverDriven || q === '' ? options : options.filter((o) => o.display.toLowerCase().includes(q))),
    [options, q, serverDriven],
  );
  const shown = matches.slice(0, CAP);
  // SERVER mode: the query is still too short to have searched (mirror the parent's floor).
  const belowMinChars = serverDriven && query.trim().length < minChars;

  return (
    <div ref={boxRef} className="relative min-w-[15rem] flex-1">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto font-normal normal-case text-ink400 underline-offset-2 transition-colors hover:text-[var(--brand-ink)] hover:underline"
          >
            Clear {selected.length}
          </button>
        )}
      </div>
      <div
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
        className={[
          'flex min-h-10 w-full flex-wrap items-center gap-1 rounded-lg border bg-surface px-2 py-1.5 text-sm transition-colors',
          open ? 'border-[var(--brand-accent)] ring-2 ring-[var(--brand-accent)]/25' : 'border-line',
        ].join(' ')}
      >
        {selected.map((v) => (
          <span
            key={v}
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-[var(--brand-soft)] py-0.5 pl-2 pr-1 text-xs font-medium text-[var(--brand-ink)]"
          >
            <span className="truncate">{displayOf.get(v) ?? v}</span>
            <button
              type="button"
              aria-label={`Remove ${displayOf.get(v) ?? v}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(v);
              }}
              className="shrink-0 rounded transition-colors hover:text-[var(--brand-accent)]"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            onQueryChange?.(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          placeholder={selected.length === 0 ? placeholder : 'Add more…'}
          aria-label={label}
          className="h-6 min-w-[6rem] flex-1 bg-transparent text-sm text-ink900 outline-none placeholder:text-ink400"
        />
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-ths animate-ths-reveal">
          {belowMinChars ? (
            <p className="px-2 py-2 text-xs text-ink400">Type at least {minChars} characters to search.</p>
          ) : serverDriven && loading ? (
            <p className="px-2 py-2 text-xs text-ink400">Searching…</p>
          ) : !serverDriven && options.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink400">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink400">No matches for “{query.trim()}”.</p>
          ) : (
            shown.map((o) => {
              const on = selectedSet.has(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => onToggle(o.value)}
                  aria-pressed={on}
                  className={[
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    on ? 'bg-[var(--brand-soft)]' : 'hover:bg-[var(--brand-soft)]',
                  ].join(' ')}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Check
                      className={['h-3.5 w-3.5 shrink-0 text-[var(--brand-accent)]', on ? '' : 'opacity-0'].join(' ')}
                      aria-hidden
                    />
                    <span className="truncate text-ink900">{o.display}</span>
                  </span>
                  {o.badge !== undefined && (
                    <span
                      className={[
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        o.badge ? 'bg-[var(--brand-soft)] text-[var(--brand-ink)]' : 'text-ink400',
                      ].join(' ')}
                    >
                      {o.badge ?? 'Other'}
                    </span>
                  )}
                </button>
              );
            })
          )}
          {matches.length > CAP && (
            <p className="px-2 py-1.5 text-[11px] text-ink400">
              Showing first {CAP} of {matches.length.toLocaleString()} — keep typing to narrow.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
