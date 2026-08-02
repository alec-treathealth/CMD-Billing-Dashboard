'use client';

/**
 * Material-3 navigation rail — the 'rail' shell mode.
 *
 * STRUCTURE is Material 3 (rail at 80dp, expands to 232dp; a pill "active indicator"
 * behind the icon; state-layer hover; emphasized easing). COLOR is TreatHealthOS:
 * every surface here resolves through the `--m3-rail-*` variables in globals.css,
 * which are themselves defined in terms of `--brand-bar` / `--brand-accent`. That is
 * what keeps per-tenant branding (teal / navy-brass / indigo-violet, stamped on
 * <html data-view=…> by BrandTheme) alive in the new shell without a second palette.
 *
 * EXPANDS AS AN OVERLAY, never a push. The collections and claims grids are dense and
 * horizontally tight; reflowing them on every rail toggle would be its own bug. The
 * content inset stays pinned at RAIL_COLLAPSED_PX in both states (see ContentInset).
 *
 * Nav VISIBILITY comes from `lib/nav-model.ts` — the same `linksFor` the top bar uses.
 * This component makes no authorization decision of its own.
 */
import { useId, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { isActiveNav, linksFor, navHref } from '@/lib/nav-model';
import type { Role } from '@/lib/rbac';
import {
  RAIL_COLLAPSED_PX,
  RAIL_EXPANDED_PX,
  railActive,
  type ShellMode,
} from '@/lib/shell';

/** TreatHealthOS hexagon mark, inline so the rail needs no asset (mirrors the header logo). */
function RailMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden focusable="false">
      <polygon
        points="50,4 88,26 88,74 50,96 12,74 12,26"
        fill="rgba(255,255,255,.08)"
        stroke="#fff"
        strokeWidth="5"
      />
      <polygon points="50,20 68,31 50,42 32,31" fill="#1C8B82" />
      <polygon points="68,31 68,53 50,64 50,42" fill="#135E5A" />
      <polygon points="50,42 50,64 32,53 32,31" fill="#E2674F" />
      <polygon points="50,64 66,73 50,82 34,73" fill="#F0917C" />
    </svg>
  );
}

/**
 * The rail's markup, as a PURE leaf — every input arrives as a prop, no router hooks.
 * Split out so it can be render-tested hermetically (the repo's convention for
 * presentational leaves); `NavRail` below is the thin hook-reading wrapper.
 */
export function NavRailView({
  links,
  pathname,
  view,
  expanded,
  onToggle,
  navId,
}: {
  links: ReturnType<typeof linksFor>;
  pathname: string | null;
  view: string | null;
  expanded: boolean;
  onToggle: () => void;
  navId: string;
}) {
  return (
    <div
      // The fixed footprint the page is inset by never changes — only the visual rail widens.
      style={{ width: RAIL_COLLAPSED_PX }}
      className="fixed inset-y-0 left-0 z-40"
    >
      <div
        style={{
          width: expanded ? RAIL_EXPANDED_PX : RAIL_COLLAPSED_PX,
          backgroundColor: 'var(--m3-rail-surface)',
          transitionTimingFunction: 'var(--m3-ease-emphasized)',
          transitionDuration: 'var(--m3-dur-expand)',
        }}
        className={[
          'flex h-full flex-col overflow-hidden transition-[width,box-shadow]',
          expanded ? 'shadow-ths-lg' : '',
        ].join(' ')}
      >
        {/* ---- Header: expand toggle + wordmark (the wordmark only exists when there's room) ---- */}
        <div className="flex h-14 shrink-0 items-center gap-2 px-[18px]">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={navId}
            aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            className="grid h-11 w-11 shrink-0 -translate-x-[10px] place-items-center rounded-full text-white/80 transition-colors hover:bg-[var(--m3-rail-state)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {expanded ? (
              <PanelLeftClose aria-hidden className="h-5 w-5" />
            ) : (
              <PanelLeftOpen aria-hidden className="h-5 w-5" />
            )}
          </button>
          <div
            aria-hidden={!expanded}
            className={[
              'flex items-center gap-2.5 whitespace-nowrap transition-opacity',
              expanded ? 'opacity-100 delay-100' : 'pointer-events-none opacity-0',
            ].join(' ')}
          >
            <RailMark size={24} />
            <span className="ths-h text-sm font-semibold tracking-tight text-white">
              TreatHealth<span className="text-[#5FBFA8]">OS</span>
            </span>
          </div>
        </div>

        {/* ---- Destinations ---- */}
        <nav id={navId} aria-label="Main" className="flex-1 overflow-y-auto overflow-x-hidden py-2">
          <ul className="flex flex-col gap-1">
            {links.map(({ href, label, railIcon: Icon, isBeta }) => {
              const active = isActiveNav(href, pathname);
              return (
                <li key={href}>
                  <Link
                    href={navHref(href, view)}
                    aria-current={active ? 'page' : undefined}
                    title={expanded ? undefined : label}
                    className={[
                      'group relative flex items-center rounded-full outline-none',
                      // Collapsed: a 56x32 indicator with the label beneath (M3 rail).
                      // Expanded: one full-width 56dp pill, icon then label (M3 expanded rail).
                      expanded ? 'mx-3 h-14 gap-3 px-4' : 'mx-auto h-14 w-14 flex-col justify-center gap-1',
                      'transition-colors focus-visible:ring-2 focus-visible:ring-white/60',
                    ].join(' ')}
                    style={{
                      backgroundColor: active ? 'var(--m3-rail-indicator)' : undefined,
                      color: active ? 'var(--m3-rail-on-active)' : 'var(--m3-rail-on)',
                    }}
                  >
                    {/* State layer — M3 draws hover/press as a translucent overlay, not a color swap. */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ backgroundColor: 'var(--m3-rail-state)' }}
                    />
                    <Icon aria-hidden className="relative h-5 w-5 shrink-0" />
                    {expanded ? (
                      <span className="relative flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap text-sm font-medium">
                        <span className="truncate">{label}</span>
                        {/* Beta flag only when there is room to read it; collapsed shows a dot. */}
                        {isBeta ? (
                          <span className="q-beta-badge" aria-hidden="true">
                            Beta
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="relative w-full truncate px-1 text-center text-[10px] font-medium leading-none">
                        {label}
                      </span>
                    )}
                    {/* Collapsed Beta marker: a coral dot on the indicator's top-right. */}
                    {isBeta && !expanded ? (
                      <span
                        aria-hidden
                        className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-coral400"
                      />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}

/**
 * The mounted rail: reads the route + tenant scope, owns the expand state, and self-gates.
 * All markup lives in NavRailView above.
 */
export function NavRail({ mode, role }: { mode: ShellMode; role?: Role }) {
  const pathname = usePathname();
  const view = useSearchParams().get('view');
  const [expanded, setExpanded] = useState(false);
  const navId = useId();

  // Hooks run unconditionally; the bail-outs stay below them (rules of hooks).
  // The rail exists only in 'rail' mode, and never on a route that draws its own chrome.
  // ONE predicate shared with ContentInset so the rail and its reserved footprint can
  // never disagree (see railActive in lib/shell.ts).
  if (!railActive(mode, pathname)) return null;

  return (
    <NavRailView
      links={linksFor(role)}
      pathname={pathname}
      view={view}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      navId={navId}
    />
  );
}
