'use client';

/**
 * Reserves the navigation rail's footprint beside the page content.
 *
 * Pinned at RAIL_COLLAPSED_PX in BOTH rail states on purpose — the expanded rail
 * overlays rather than pushes, so the collections/claims grids never reflow when the
 * rail is toggled. Gated on the same `isFullPageRoute` predicate the rail and the
 * HeaderGate use, so the auth screens and the /qualify/m PWA keep their full bleed.
 *
 * `children` is a server-rendered subtree passed through untouched — this component
 * is client-side only because the pathname is its input.
 */
import { usePathname } from 'next/navigation';

import { RAIL_COLLAPSED_PX, railActive, type ShellMode } from '@/lib/shell';

export function ContentInset({ mode, children }: { mode: ShellMode; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = railActive(mode, pathname);
  return <div style={active ? { paddingLeft: RAIL_COLLAPSED_PX } : undefined}>{children}</div>;
}
