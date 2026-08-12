/**
 * Non-PHI "data last updated by the CMD cron" line, shown on the Overview and Collections
 * pages so users can confirm how fresh the collections data is (the fix for "did the cron
 * actually update?"). Server component: reads the cached, cron-tag-busted timestamp and
 * formats it in Pacific time with an explicit tz label; the raw ISO is in the title for
 * hover precision. No patient data is touched.
 *
 * THREE STATES, because two of them used to be indistinguishable from "current" (2026-08-12).
 * A background revalidation of this probe can fail — it did, losing a connection-acquire race
 * against an 87-second matview refresh — and Next then serves the previous value with no error
 * anywhere. This component rendered that stale value in exactly the same words as a fresh one, so
 * users read old numbers as live. See app/lib/dataFreshness.ts for the full diagnosis.
 *
 *   current     — read confirmed recently. Unchanged wording.
 *   stale       — a REAL previously-read value, last confirmed against the database a while ago.
 *                 Shown with a "last checked" qualifier so it is not presented as current.
 *   unavailable — no value at all. Says so plainly.
 *
 * NOTHING HERE INVENTS A TIMESTAMP. The 'stale' state shows the genuine last-known update time
 * plus the genuine time it was last read; it never advances either to look fresher.
 *
 * The wording is deliberately "last checked", not "refresh failing". unstable_cache revalidates on
 * ACCESS, so on a quiet page an old measuredAt just means nobody visited — which is not a fault.
 * The unambiguous failure signal is the server-side log line, not this label.
 */
import { collectionsFreshness, type FreshnessState } from '@/lib/dataFreshness';
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

/** Coarse "N minutes/hours ago". Coarse on purpose — this is a confidence cue, not a stopwatch. */
function agoLabel(fromIso: string, now: number): string {
  const ms = now - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return 'recently';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Pure presentational leaf — the three states, no data access. Split out so the render invariants
 * are testable without a database or a Next request context (the same shape as
 * facility-resolution-render.test.tsx). DataFreshness below is the async data-fetching wrapper.
 */
export function FreshnessLine({ state, now = Date.now() }: { state: FreshnessState; now?: number }) {
  if (state.status === 'unavailable') {
    // No cached value AND the read failed. Do not guess, and do not imply the data is current.
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Collections data: last-updated time unavailable right now
      </p>
    );
  }

  if (!state.updatedAt) {
    return <p className="mt-2 text-xs text-muted-foreground">Collections data: not yet loaded</p>;
  }

  const iso = state.updatedAt;
  const stamp = (
    <time dateTime={iso} className="font-medium text-foreground">
      {FMT.format(new Date(iso))} PST
    </time>
  );

  if (state.status === 'stale') {
    return (
      <p
        className="mt-2 text-xs text-muted-foreground"
        title={`Last updated ${iso} · last checked ${state.measuredAt}`}
      >
        Collections data last updated {stamp}{' '}
        <span className="text-amber-700 dark:text-amber-500">
          · not refreshed since {agoLabel(state.measuredAt, now)}
        </span>
      </p>
    );
  }

  return (
    <p className="mt-2 text-xs text-muted-foreground" title={iso}>
      Collections data last updated {stamp}
    </p>
  );
}

// `view` is the RBAC-clamped dashboard view resolved server-side by the page (both the overview
// and collections pages gate an entity-less role BEFORE rendering this, so viewToEntityIds is a
// safe, non-empty tenant scope). The freshness timestamp is scoped to that tenant, so an Indigo
// view never shows BXR's last-updated (and vice-versa).
export async function DataFreshness({ view }: { view: DashboardView }) {
  const state = await collectionsFreshness(viewToEntityIds(view));
  return <FreshnessLine state={state} />;
}
