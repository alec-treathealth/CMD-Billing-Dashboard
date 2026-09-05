'use client';

/**
 * Shared guided multi-select "type-ahead + tags" picker — the search primitive used by the Collections
 * explorer (facility / payer / employer / funding), the desktop Qualify tab (employer / funding) and
 * the Qualify v3 NARROW SEARCH card (employer). Extracted from cmd-explorer so every surface renders
 * ONE consistent control (dashboard tokens only — no new design language). Two modes:
 *   - CLIENT (default): the parent loads the full option list ONCE (facility ~30, payer ~260) and this
 *     picker filters it instantly client-side as the user types.
 *   - SERVER (pass `onQueryChange`): the parent owns the option list and re-fetches it per (debounced)
 *     keystroke, for a vocabulary too large to load whole. The picker then does NOT filter
 *     client-side (options already reflect the query) and reports the raw query up. Payer Intel's
 *     employer search uses this; COLLECTIONS no longer does — its employer vocabulary turned out to
 *     be 1,073 values, not the ~11.6k measured on the VOB plane, so it loads whole like the others.
 * Selected values render as removable tags; a filtered list drops below on focus/typing (capped, with
 * a "keep typing" hint past the cap).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';

/** One option in a guided picker. `value` is the raw filter value the selection carries; `display` is
 *  the friendly label shown AND the text the type-ahead matches on; `badge` (facility only) shows the
 *  IP/OP/Both care setting. */
export type PickerOption = {
  value: string;
  display: string;
  badge?: 'IP' | 'OP' | 'BOTH' | null;
  /**
   * SECOND LINE under `display` — shown, and matched by the type-ahead.
   *
   * Carries a short qualifier about the option, not a second name. Both Collections pickers use it to
   * say that an option MERGED several underlying values — "2 CMD spellings" on a facility whose CMD
   * export carries two spellings of one place, "3 spellings" on a canonicalised employer — so a merge
   * is visible as a merge instead of looking like the only value there is.
   *
   * ⚠ IT IS PART OF THE HAYSTACK. Anything rendered in an option must be matchable, or the user reads
   * a word on screen, types it, and gets "No matches".
   *
   * ⚠ KEEP IT SHORT AND DO NOT PUT A DISTINGUISHING NAME HERE. It exists because an earlier fix put
   * the distinguishing text in `display` as a SUFFIX and the row renders with `truncate`, so the one
   * piece of text added to tell two options apart was the piece guaranteed to be clipped — both
   * LONESTAR options read `LONESTAR MENTAL HEALTH LLC · LO…`. That is now solved upstream by MERGING
   * the options rather than labelling them apart (facilityPickerOptions.ts), which is why this field
   * carries a count and not a name.
   */
  detail?: string | null;
  /**
   * EXTRA HAYSTACK for the type-ahead — matched in addition to `display`, never shown.
   *
   * Added 2026-08-08 for Qualify's facility narrow, where `display` is `display_acronym` and 16 of 47
   * live options therefore have `display !== value`: typing what CMD actually calls the facility
   * returned "No matches" for a facility that was right there. The alternative — composing `display`
   * into `ACRONYM — Full Name` — was rejected, because label parity with the score cards is the whole
   * reason `display_acronym` is preferred in the first place.
   *
   * OPTIONAL AND DEFAULTED TO EMPTY, so every pre-existing caller (Collections' four pickers, the v2
   * tab's two, the v3 card's employer field) filters byte-for-byte as before. Pinned by a query sweep
   * in app/test/multiSelectTagPicker.test.tsx that compares the predicate against the old expression.
   */
  searchText?: readonly string[];
};

/**
 * Does this option match the typed query? CLIENT mode only — see the `serverDriven` short-circuit at
 * the call site, which must stay in FRONT of this rather than inside it: in server mode the parent has
 * already filtered for the query, and re-filtering here would drop rows the server deliberately
 * returned (`employerNarrowFor` needs the full returned set to decide whether a selection is even a
 * narrow).
 *
 * Case-insensitive SUBSTRING, over `display` plus `detail` plus any `searchText`. No token splitting,
 * no fuzzy, no diacritic folding — that is the shipped behaviour and this extraction does not change
 * it. `detail` joined the haystack when it was introduced, to hold the type-ahead byte-identical for
 * options whose disambiguating text merely MOVED out of `display` (see PickerOption.detail).
 *
 * EXPORTED AND PURE because this component had no direct test coverage at all until 2026-08-08, and
 * "the filter four surfaces depend on" is not something to change without one.
 */
export function pickerMatches(option: PickerOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (option.display.toLowerCase().includes(q)) return true;
  if ((option.detail ?? '').toLowerCase().includes(q)) return true;
  return (option.searchText ?? []).some((t) => t.toLowerCase().includes(q));
}

export function MultiSelectTagPicker({
  label,
  badge,
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
  tone,
  derivedValues,
}: {
  label: string;
  /** Optional state readout rendered INSIDE the label row, between the label and `Clear N`.
   *  Qualify v3's NARROW SEARCH card passes its shared ON/OFF badge here: that card's contract is
   *  that every facet states its own state beside its own control, and the picker owns the only label
   *  this facet has — a second label above it would say "Employers" twice to a screen reader. Omitted
   *  everywhere else, which leaves the label row byte-identical to what Collections ships. */
  badge?: React.ReactNode;
  placeholder: string;
  icon: React.ReactNode;
  options: PickerOption[];
  /** READONLY: the picker only reads it (map, length, Set), and a caller holding a `readonly string[]`
   *  in state had to spread a defensive copy to satisfy `string[]` — which defeats the memo below on
   *  every render. Every existing caller passes a `string[]`, which is assignable. */
  selected: readonly string[];
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
  /** Qualify compose-console zone (Design B made visible): 'score' = payer/facility (tinted zone,
   *  teal200 control border); 'list' = employer/funding (plain zone, line border). Both use teal chips
   *  + teal focus. UNSET (Collections + everywhere else) = the tenant `--brand-*` styling, unchanged. */
  tone?: 'score' | 'list';
  /** CHIP PROVENANCE: values that were added by a Heating-Up ticker-card click rather than hand-picked.
   *  Those chips render dashed with a small ↳ prefix — behaviourally identical (removable the same way),
   *  only visually marked. Omitted everywhere except the Qualify console. */
  derivedValues?: ReadonlySet<string>;
}) {
  // Qualify zones share teal chips + teal focus; they differ only in the RESTING control border
  // (score = teal200, list = line). Unset tone keeps the brand-themed control (Collections parity).
  const tealTone = tone === 'score' || tone === 'list';
  const serverDriven = typeof onQueryChange === 'function';
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // value → the label a SELECTED chip shows. `detail` is folded back in here on purpose: the chip is
  // a single inline row with no second line, so without it two options that differ only in `detail`
  // (the LONESTAR pair) would produce two byte-identical chips — re-creating, in the selection, the
  // exact ambiguity `detail` exists to remove from the dropdown.
  const displayOf = useMemo(() => {
    const m = new Map<string, string>(displayOverride ?? []);
    for (const o of options) m.set(o.value, o.detail ? `${o.display} · ${o.detail}` : o.display);
    return m;
  }, [options, displayOverride]);

  // Dismiss on outside pointer-down or Escape (same pattern as the Month/Year popover).
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
    () => (serverDriven || q === '' ? options : options.filter((o) => pickerMatches(o, q))),
    [options, q, serverDriven],
  );
  const shown = matches.slice(0, CAP);
  // SERVER mode: the query is still too short to have searched (mirror the parent's floor).
  const belowMinChars = serverDriven && query.trim().length < minChars;

  // Select-to-add clears the typed draft immediately, so the filtered list resets for the next add
  // (rapid multi-add unaffected — the dropdown stays open). Clearing happens ONLY on ADD, never on
  // removal: the chip-× calls onToggle directly and bypasses this handler. Server mode also resets the
  // parent query so its fetched option list clears too.
  const handleOption = (value: string, isSelected: boolean) => {
    onToggle(value);
    if (!isSelected) {
      setQuery('');
      onQueryChange?.('');
    }
  };

  return (
    <div ref={boxRef} className="relative min-w-[15rem] flex-1">
      {/* `text-xs` (13px in this config), NOT the `text-[11px]` this row shipped with: the design
          system's 12px floor for meaning-bearing text is repo-wide ("no text-[…px] below it,
          anywhere"), and mounting this picker inside Qualify v3 put the row under that surface's
          machine-enforced sweep for the first time. A label is meaning-bearing by definition. */}
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        {badge}
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
          open
            ? tealTone
              ? 'border-teal700 ring-2 ring-teal500/25'
              : 'border-[var(--brand-accent)] ring-2 ring-[var(--brand-accent-a25)]'
            : tone === 'score'
              ? 'border-teal200 hover:border-teal500'
              : tone === 'list'
                ? 'border-line hover:border-teal500'
                : 'border-line',
        ].join(' ')}
      >
        {selected.map((v) => {
          const derived = derivedValues?.has(v) ?? false;
          return (
            <span
              key={v}
              className={[
                'inline-flex max-w-[16rem] items-center gap-1 rounded-md py-0.5 pl-2 pr-1 text-xs font-medium',
                tealTone ? 'border-teal200 bg-teal50 text-teal700' : 'bg-[var(--brand-soft)] text-[var(--brand-ink)]',
                // Derived (ticker-click) chips read dashed + ↳; else solid. tealTone already draws a border;
                // default tone has none, so a derived default-tone chip picks up a line border for the dash.
                derived ? (tealTone ? 'border border-dashed' : 'border border-dashed border-line') : tealTone ? 'border' : '',
              ].join(' ')}
            >
              {derived ? (
                <span aria-hidden className="-mr-0.5 font-mono text-[10px] leading-none opacity-60">
                  ↳
                </span>
              ) : null}
              <span className="truncate">{displayOf.get(v) ?? v}</span>
              <button
                type="button"
                aria-label={`Remove ${displayOf.get(v) ?? v}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(v);
                }}
                className={[
                  'shrink-0 rounded transition-colors',
                  tealTone ? 'text-teal700 hover:text-teal900' : 'hover:text-[var(--brand-accent)]',
                ].join(' ')}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          );
        })}
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
                  onClick={() => handleOption(o.value, on)}
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
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-ink900">{o.display}</span>
                      {/* NOT truncated: this line exists to be read in full — it is the only thing
                          distinguishing two options that share a label. It wraps instead. */}
                      {o.detail ? (
                        <span className="break-words text-xs leading-tight text-muted-foreground">{o.detail}</span>
                      ) : null}
                    </span>
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
          {/* `text-xs`, same 12px-floor correction as the label row above. This one never reaches the
              SSR sweep (the dropdown is closed until focus) — it is fixed because the rule is the
              rule, not because a test found it. */}
          {matches.length > CAP && (
            <p className="px-2 py-1.5 text-xs text-ink400">
              Showing first {CAP} of {matches.length.toLocaleString()} — keep typing to narrow.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
