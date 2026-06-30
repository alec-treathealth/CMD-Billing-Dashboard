/**
 * The standalone "Collections Explorer" sub-route was merged into /dashboard/collections
 * (now the "All Collections" view of the unified Collections tab). This route permanently
 * redirects so any existing links/bookmarks land on the merged page.
 */
import { redirect } from 'next/navigation';

export default function CollectionsExplorerRedirect() {
  redirect('/dashboard/collections');
}
