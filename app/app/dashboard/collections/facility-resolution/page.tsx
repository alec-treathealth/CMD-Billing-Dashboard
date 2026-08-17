/**
 * Facility Resolution moved to the Claims Desk tab (Alec's ruling, 2026-08-17). This is a pure
 * FORWARDER, kept so live links, bookmarks and anything already pasted into Slack keep working —
 * there is no second copy of the workbench and no gate here, because the target page runs the same
 * `dashboardAccess()` → admin/super_admin check it always has and a redirect that arrives at a
 * closed door is still a closed door.
 *
 * `?view=` is carried through: it is the tenant-scope switcher, and dropping it would silently
 * land an Indigo operator on the consolidated view. It is re-clamped against the caller's
 * entitlements at the destination (`clampView`), so forwarding an unentitled value cannot widen
 * anything — it just bounces once more.
 *
 * Delete this file once the old path stops showing up in the logs.
 */
import { redirect } from 'next/navigation';

export default async function FacilityResolutionMovedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.view;
  const view = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  // Allowlisted characters only — this value is re-clamped at the destination, but a redirect
  // target should never be built out of unvalidated request text.
  const safe = typeof view === 'string' && /^[a-z0-9-]{1,32}$/.test(view) ? view : null;
  redirect(safe === null ? '/billing-audit/facility-resolution' : `/billing-audit/facility-resolution?view=${safe}`);
}
