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
 * ⚠ RE-RULED 2026-09-08, AND THE RULING WAS TO STAY PUT. An in-nav scope control (a pill + popover
 * in the top bar, right of the logo lockup) was specced and then ABANDONED on two findings: it would
 * reverse the "No dropdowns" ruling above, and the nav lives in a Server Component that cannot read
 * `searchParams` — so it could not know that the Claims Desk offers two tenants while /dashboard
 * offers three without duplicating the route-narrowing decision in `lib/billing-audit/views.ts`.
 * The control stays on the page, at these three call sites. Do not move it to the nav.
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
 *
 * Hit target is >=44px (WCAG 2.5.5). It measured ~40px until 2026-09-08 — `py-2` on a 15px label —
 * which is under the floor on every pointer type, not just touch.
 *
 * The `aria-live` region is the other 2026-09-08 addition, and it exists because these tabs
 * NAVIGATE: a screen-reader user got a route change with no spoken confirmation of which tenant is
 * now in scope, and tenant IS the scope here. It is empty on first render — a cold page load
 * announces nothing — and speaks only on a CHANGE, including a browser back/forward that moves
 * `?view=`, which is why it keys off the resolved view rather than off the click handler.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

import { clampView, resolveView, viewOptions, type DashboardView } from '@/lib/views';

export function TenantTabs({ allowedViews }: { allowedViews?: DashboardView[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  // HOISTED ABOVE THE EARLY RETURN so the announcement effect below is an UNCONDITIONAL hook
  // (rules of hooks). `clampView` tolerates an empty allowlist — it falls back to DEFAULT_VIEW —
  // so computing this for a principal who is about to render nothing is safe and unused.
  const view = clampView(
    resolveView({ view: searchParams?.get('view') ?? undefined }),
    allowedViews ?? [],
  );

  const [announcement, setAnnouncement] = useState('');
  const announced = useRef<DashboardView | null>(null);
  useEffect(() => {
    // The null check is what keeps a cold load silent: on first mount there is no PREVIOUS view, so
    // there has been no change to announce. Only a genuine transition speaks.
    if (announced.current !== null && announced.current !== view) {
      const label = viewOptions.find((o) => o.value === view)?.label ?? view;
      setAnnouncement(`Tenant scope: ${label}`);
    }
    announced.current = view;
  }, [view]);

  // Nothing to switch with <= 1 entitled view — an entity-scoped user sees their own data and a
  // one-tab tablist would be chrome that implies a choice they do not have.
  if (!allowedViews || allowedViews.length <= 1) return null;

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
    <>
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
              // ⚠ `data-view` LIVES ON THE PILL ITSELF, AND THAT IS LOAD-BEARING — NOT INHERITED.
              // globals.css's `[data-view='…']` rules are BARE ATTRIBUTE SELECTORS, so they set
              // --brand-ink / --brand-accent on whatever element carries the attribute. `BrandTheme`
              // stamps `<html data-view>` on /dashboard routes ONLY and deletes it everywhere else,
              // so on /billing-audit — which has a real `?view=` and its own two-tenant control —
              // there is NO ancestor to inherit from and every pill would paint default teal. The
              // attribute here is what makes the fill the tenant's colour on all three call sites.
              // The swatch span below inherits from this element, which is why it no longer carries
              // its own copy.
              data-view={o.value}
              onClick={() => navigate(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={[
                // ── THE ACTIVE STATE IS A SOLID FILL (Alec, 2026-09-08) ────────────────────────
                // Ask: the active tenant must "read as the winner from across the room, not as a
                // tinted sibling". It previously carried a 2px --brand-ink stroke over a
                // --brand-soft tint, which is a difference of degree from its neighbours; a solid
                // --brand-ink fill with a white label is a difference of KIND.
                //
                // MEASURED (WCAG sRGB), fill vs the white label (AA text >=4.5) and fill vs the
                // #FBF8F4 page ground it sits on (1.4.11 boundary >=3):
                //
                //     consolidated  #135e5a    7.56 / 7.14    PASS / PASS
                //     bxr           #1a1a2e   17.06 / 16.11   PASS / PASS
                //     indigo        #5b2a9e    9.25 / 8.74    PASS / PASS
                //
                // ⚠ --brand-ACCENT CANNOT BE THE FILL, and the arithmetic is why: the trio has no
                // common foreground (teal #1c8b82 is 4.15 on white AND 3.55 on ink900 — it fails
                // BOTH; BXR gold #c8a24b is 2.41 on white; Indigo #7c3aed is 2.58 on ink900). Only
                // --brand-ink clears AA with one foreground across all three tenants. This is the
                // same trap recorded below in the 2026-08-18 stroke history — do not repoint the
                // fill to --brand-accent because it looks brighter.
                //
                // ── border-2 -> border, DELIBERATELY, AND IT DOES NOT UNDO THE 2026-08-18 ASK ──
                // That ask was *"put 2pt borders around … to make them more visible"* — the goal
                // was VISIBILITY, and the 2026-09-08 ruling reassigns how it is carried: the active
                // pill is now a solid fill (far louder than any stroke), and the inactive ones were
                // ruled a "hairline border", which is 1px by definition. The stroke's job on the
                // active pill is gone; on the inactive pills it is unchanged in kind, only thinner.
                //
                // The 2026-08-18 lesson that DOES still bind is the token, not the width:
                //
                //     line          #E4E9E6   1.16:1   FAIL  <- a border you cannot see
                //     brand-accent  #c8a24b   2.27:1   FAIL  <- BXR gold
                //     ink400        #63756E   4.61:1   PASS  <- the hairline, then and now
                //     ink600        #4A5C5A   6.68:1   PASS  <- the inactive label
                //
                // A stroke that cannot be perceived is worse than no stroke: it looks addressed and
                // is not. `border-line` stays banned by test, at 1.16:1 on this ground.
                //
                // MOTION: `transition-colors` is collapsed to 0.01ms by the global
                // prefers-reduced-motion reset in globals.css (~L176), which zeroes
                // transition-duration on `*`. That is the single mechanism for the whole app — there
                // is deliberately no per-component `motion-reduce:` opt-out here, and adding one
                // would imply the global reset does not cover this.
                'relative inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-4 py-2 text-[15px] transition-colors',
                // The focus ring is --brand-ink on a 2px offset, so it reads against BOTH the dark
                // active fill (the offset gives it a light gap) and the page ground (7.14-16.11:1).
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-ink)] focus-visible:ring-offset-2',
                active
                  ? 'border-[var(--brand-ink)] bg-[var(--brand-ink)] font-semibold text-white'
                  // NO TINT ON INACTIVE (ruled): transparent fill, and hover strengthens the
                  // border + darkens the label rather than washing a --brand-soft behind it. Hover
                  // must never REDUCE contrast — the pre-2026-08-18 `--brand-accent/50` border was
                  // fainter than the resting one, so pointing at a tab made its outline weaker.
                  : 'border-ink400 bg-transparent font-medium text-ink600 hover:border-[var(--brand-ink)] hover:text-ink900',
              ].join(' ')}
            >
              {/* Per-tenant swatch, resolving --brand-accent off the BUTTON's `data-view` (see the
                  note above). Decorative — `aria-hidden`, and the label beside it always carries the
                  meaning, so colour is never the sole signal (WCAG 1.4.1).
                  ⚠ THE RING FLIPS WITH THE STATE, because the dot's own contrast does. On the
                  active pill the accent sits on its own tenant's ink and is nearly edgeless
                  (consolidated 1.82:1, indigo 1.62:1 — BXR gold is fine at 7.09:1), so a white ring
                  supplies the boundary the hue cannot. On an inactive pill it sits on the #FBF8F4
                  ground (3.92 / 2.27 / 5.38) and keeps the original hairline. */}
              <span
                aria-hidden
                className={[
                  'h-2.5 w-2.5 shrink-0 rounded-full ring-1',
                  active ? 'ring-white/70' : 'ring-black/5',
                ].join(' ')}
                style={{ backgroundColor: 'var(--brand-accent)' }}
              />
              {o.label}
            </button>
          );
        })}
      </div>
      {/* ⚠ A FRAGMENT ROOT, AND THE SR-ONLY SPAN IS WHY IT HAS TO BE ONE. The Collections header is
          a `justify-between` flex row and `collections-header-row.test.tsx` pins that this component
          is an UNWRAPPED direct child of it: a wrapper div took the tablist's max-content width and
          overflowed the document by 111px at 390px (WCAG 1.4.10), and an empty one held
          space-between's first slot. A fragment emits no DOM node, so the tablist above is still the
          direct flex item it was. This span is `sr-only` — position:absolute — so it is not a flex
          item at all and cannot add a second one. Do not wrap these two in a div. */}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
