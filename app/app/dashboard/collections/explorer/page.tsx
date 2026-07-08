/**
 * The standalone "Collections Explorer" sub-route was merged into /dashboard/collections
 * (now the "All Collections" view of the unified Collections tab). This route permanently
 * redirects so any existing links/bookmarks land on the merged page — forwarding ?view= so a
 * bookmarked tenant scope survives the redirect (the destination re-clamps it server-side).
 */
import { redirect } from 'next/navigation';

export default async function CollectionsExplorerRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams)?.view;
  const view = Array.isArray(raw) ? raw[0] : raw;
  redirect(view ? `/dashboard/collections?view=${encodeURIComponent(view)}` : '/dashboard/collections');
}
