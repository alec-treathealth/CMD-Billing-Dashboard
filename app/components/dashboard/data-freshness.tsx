/**
 * Non-PHI "data last updated by the CMD cron" line, shown on the Overview and Collections
 * pages so users can confirm how fresh the collections data is (the fix for "did the cron
 * actually update?"). Server component: reads the cached, cron-tag-busted timestamp and
 * formats it in Pacific time with an explicit tz label; the raw ISO is in the title for
 * hover precision. No patient data is touched.
 */
import { collectionsDataUpdatedAt } from '@/lib/dataFreshness';
import { viewToEntityIds, type DashboardView } from '@/lib/views';

// Pacific wall-clock (DST-aware, so the time is always correct Pacific local); labeled a
// literal "PST" per request. The raw ISO (UTC) stays in the title attr for exact precision.
const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// `view` is the RBAC-clamped dashboard view resolved server-side by the page (both the overview
// and collections pages gate an entity-less role BEFORE rendering this, so viewToEntityIds is a
// safe, non-empty tenant scope). The freshness timestamp is scoped to that tenant, so an Indigo
// view never shows BXR's last-updated (and vice-versa).
export async function DataFreshness({ view }: { view: DashboardView }) {
  const iso = await collectionsDataUpdatedAt(viewToEntityIds(view));
  if (!iso) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">Collections data: not yet loaded</p>
    );
  }
  return (
    <p className="mt-2 text-xs text-muted-foreground" title={iso}>
      Collections data last updated{' '}
      <time dateTime={iso} className="font-medium text-foreground">
        {FMT.format(new Date(iso))} PST
      </time>
    </p>
  );
}
