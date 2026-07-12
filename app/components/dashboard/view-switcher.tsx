'use client';

/**
 * View switcher — the dashboard "which entity" dropdown, mounted in the global top bar
 * (next to the user avatar). Updates the URL `?view=` param (the single source of truth,
 * read server-side by the dashboard pages), so the selection survives refresh, is
 * shareable, and scopes the whole dashboard (Overview + Collections). Other query params
 * are preserved.
 *
 * Renders ONLY on dashboard routes — on /claims, /ask, etc. there is no view, so it
 * returns null. The `allowedViews` prop comes from the server layout (the signed-in user's
 * RBAC entitlement); the dropdown lists only those, and hides entirely when the user is
 * entitled to a single view (nothing to switch). Reads the ACTIVE view from the URL, clamped
 * to the allowlist. No localStorage/cookies (CLAUDE.md §2); the param is non-PHI. This control
 * never touches data or any auth gate — it only rewrites the URL (the page re-clamps + scopes).
 *
 * PRESENTATION: a custom brand-styled dropdown (not a native <select>), following the WAI-ARIA
 * select-only combobox pattern — the trigger is the focused `role="combobox"` element and carries
 * `aria-activedescendant`; the popover is a `role="listbox"` of `role="option"` rows, each with a
 * per-tenant color swatch (a `data-view`-scoped element, so `var(--brand-accent)` resolves to that
 * tenant's own accent — BXR gold / Indigo violet / Consolidated teal — reusing globals.css tokens,
 * NOT hardcoded) and a check on the active view. Full keyboard model (arrows / Home / End / Enter /
 * Space / Escape / Tab) and outside-click close; focus never leaves the trigger. This layer is
 * PURELY presentational: the `?view=` write, the mount/hide guards, and clampView/resolveView/
 * viewOptions are unchanged from the native-select version.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Check, ChevronDown } from 'lucide-react';

import { clampView, resolveView, viewOptions, type DashboardView } from '@/lib/views';

export function ViewSwitcher({ allowedViews }: { allowedViews?: DashboardView[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listboxId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Outside pointer-down closes the popover. Attached only while open; focus never leaves the
  // trigger, so this is the only dismissal path besides Escape / Tab / selection. (All hooks run
  // unconditionally — the early return that hides the switcher stays BELOW them, per rules-of-hooks.)
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Only the dashboard has a "view"; and there's nothing to switch with ≤1 entitled view.
  const onDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  if (!onDashboard || !allowedViews || allowedViews.length <= 1) return null;

  const view = clampView(resolveView({ view: searchParams?.get('view') ?? undefined }), allowedViews);
  const options = viewOptions.filter((o) => allowedViews.includes(o.value));
  const activeLabel = options.find((o) => o.value === view)?.label ?? view;
  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  // The one behavioral action — UNCHANGED from the native <select>: rewrite ?view=, preserving the
  // other params, no-op if unchanged. No storage; the page re-clamps + scopes server-side.
  function navigate(next: DashboardView) {
    if (next === view) return;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.push(`${pathname}?${params.toString()}`);
  }

  function openMenu() {
    const i = options.findIndex((o) => o.value === view);
    setActiveIndex(i < 0 ? 0 : i);
    setOpen(true);
  }

  function selectIndex(i: number) {
    const next = options[i];
    setOpen(false);
    if (next) navigate(next.value);
  }

  // Keyboard on the combobox trigger (focus stays here; aria-activedescendant tracks the highlight).
  // Arrow movement CLAMPS at the ends, matching a native <select>. Tab is not prevented, so focus
  // moves on naturally (the menu just closes).
  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        selectIndex(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-label="Dashboard view"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        className="flex h-8 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-[13px] font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <span className="truncate">{activeLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <ul
          role="listbox"
          id={listboxId}
          aria-label="Dashboard view"
          className="absolute right-0 top-full z-50 mt-2 min-w-[13rem] animate-ths-reveal rounded-lg border border-line bg-surface p-1 shadow-ths"
        >
          {options.map((o, i) => {
            const selected = o.value === view;
            const active = i === activeIndex;
            return (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                onClick={() => selectIndex(i)}
                onMouseEnter={() => setActiveIndex(i)}
                className={[
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink900',
                  active ? 'bg-[var(--brand-soft)]' : '',
                ].join(' ')}
              >
                {/* Per-tenant swatch: the `data-view` attribute makes globals.css set this element's
                    --brand-accent to that tenant's accent, so each row shows its OWN color. */}
                <span
                  data-view={o.value}
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/5"
                  style={{ backgroundColor: 'var(--brand-accent)' }}
                />
                <span className="flex-1 truncate">{o.label}</span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand-ink)]" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
