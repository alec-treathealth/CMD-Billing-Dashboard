'use client';

/**
 * TENANT TABS — the on-page "which entity am I looking at" control (2026-08-18).
 *
 * ── WHY THIS REPLACED A DROPDOWN ───────────────────────────────────────────────────────────────
 * The entity selector used to be a combobox in the global top bar, beside the avatar. Requested
 * change (Alec): *"instead of the 'Consolidated', 'Indigo', and 'BXR' in a drop down, just make them
 * big sub tabs on the actual page, so it's very clear to the super admin/user which tenant they want
 * to switch to. Keep this consistent for both the Overview and Collections Search page. (No
 * dropdowns, borderless, nice looking subtabs that are easily accessible by the user)."*
 *
 * The substance behind that: which tenant a number belongs to is the single most consequential piece
 * of context on these pages — a BXR figure read as Consolidated is a wrong answer, not a wrong view —
 * and a collapsed dropdown states it in a label the user has to go looking for. Tabs show the whole
 * choice set at rest, so the active tenant AND its alternatives are legible without interaction.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ─────────────────────────────────────────────────────────────
 * This is a PRESENTATION swap. Everything load-bearing is identical to the dropdown it replaces:
 *   · `?view=` in the URL stays the single source of truth, read server-side by each page;
 *   · other query params are preserved, and selecting the active view is a no-op;
 *   · `allowedViews` still comes from the server layout's RBAC entitlement, and the control renders
 *     nothing when a user is entitled to one view (there is nothing to switch);
 *   · NO localStorage, NO cookies (CLAUDE.md standing rule). The param is non-PHI.
 *   · It never touches data or any auth gate — it rewrites the URL and the page re-clamps + scopes.
 *
 * ⚠ THE CONTROL IS NOT THE GATE. A hand-edited `?view=` cannot widen access: the page clamps the
 * requested view against `allowedViews` server-side and scopes its data by the CLAMPED value. Do not
 * "simplify" by trusting this component's option list for anything.
 *
 * ── ACCESSIBILITY ──────────────────────────────────────────────────────────────────────────────
 * A real `role="tablist"` with roaming tabindex and the standard keyboard model (Arrows / Home /
 * End), so it is not a set of buttons that merely look like tabs. `aria-current="page"` marks the
 * active one for assistive tech — these tabs NAVIGATE rather than reveal a panel on the same page,
 * so there is no `aria-controls`/`tabpanel` to point at, and claiming one would be a lie.
 */
import { useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

import { clampView, resolveView, viewOptions, type DashboardView } from '@/lib/views';

export function TenantTabs({ allowedViews }: { allowedViews?: DashboardView[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  // Nothing to switch with <= 1 entitled view — an entity-scoped user sees their own data and a
  // one-tab tablist would be chrome that implies a choice they do not have.
  if (!allowedViews || allowedViews.length <= 1) return null;

  const view = clampView(resolveView({ view: searchParams?.get('view') ?? undefined }), allowedViews);
  const options = viewOptions.filter((o) => allowedViews.includes(o.value));

  function navigate(next: DashboardView) {
    if (next === view) return;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.push(`${pathname}?${params.toString()}`);
  }

  /** Roaming tabindex: arrows move focus AND selection, wrapping, as a tablist should. */
  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    tabsRef.current[next]?.focus();
    const target = options[next];
    if (target) navigate(target.value);
  }

  return (
    <div role="tablist" aria-label="Tenant" className="flex flex-wrap items-center gap-2">
      {options.map((o, i) => {
        const active = o.value === view;
        return (
          <button
            key={o.value}
            ref={(el) => {
              tabsRef.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            // Roaming tabindex: exactly one tab is in the tab order, and arrows move within.
            tabIndex={active ? 0 : -1}
            onClick={() => navigate(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={[
              // ⚠ THESE WERE BORDERLESS BY REQUEST, AND THAT WAS REVERSED (Alec, 2026-08-18):
              // "put 2pt borders around Consolidated / BXR Consulting / Indigo Billing to make them
              // more visible". The original ask was for borderless sub-tabs; carrying the active
              // state on weight, ink and a soft tint alone turned out not to read as a CONTROL —
              // nothing said "these are clickable" until you hovered one. So every tab now has a
              // 2px stroke and the active one takes the brand accent, which keeps selection legible
              // without going back to a pill-vs-plain-text distinction.
              //
              // The container gap went 1 -> 2 at the same time: at gap-1 two adjacent 2px strokes
              // sit 4px apart and read as one divided box rather than two tabs.
              'relative inline-flex items-center gap-2 rounded-lg border-2 px-4 py-2 text-[15px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]/50',
              active
                ? 'border-[var(--brand-accent)] bg-[var(--brand-soft)] font-semibold text-[var(--brand-ink)]'
                : 'border-line font-medium text-muted-foreground hover:border-[var(--brand-accent)]/50 hover:bg-[var(--brand-soft)]/60 hover:text-ink900',
            ].join(' ')}
          >
            {/* Per-tenant swatch: `data-view` makes globals.css resolve THIS element's
                --brand-accent to that tenant's own accent (BXR gold / Indigo violet /
                Consolidated teal), reusing the design tokens rather than hardcoding hexes. */}
            <span
              data-view={o.value}
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/5"
              style={{ backgroundColor: 'var(--brand-accent)' }}
            />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
