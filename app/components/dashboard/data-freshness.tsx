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
        CollaborateMD collections data last updated at {stamp}{' '}
        <span className="text-amber-700 dark:text-amber-500">
          · not refreshed since {agoLabel(state.measuredAt, now)}
        </span>
      </p>
    );
  }

  return (
    <p className="mt-2 text-xs text-muted-foreground" title={iso}>
      CollaborateMD collections data last updated at {stamp}
    </p>
  );
}

/**
 * Suspense fallback for <DataFreshness>. Reserves the line box; asserts nothing.
 *
 * WHY A RESERVED BOX RATHER THAN `fallback={null}`. DataFreshness is the LAST CHILD of the
 * <header> on both render sites (/dashboard and /dashboard/collections), so the page body
 * below it — <Dashboard> / <CollectionsView> — is laid out immediately beneath. A null
 * fallback paints the header one line short and then shoves the whole page down when the
 * probe resolves, which is a visible post-paint jump on every cold load. The class list here
 * is byte-identical to FreshnessLine's wrapper <p> above (`mt-2 text-xs text-muted-foreground`
 * — Tailwind's `text-xs` carries the line-height, so matching the class matches the metric),
 * and the non-breaking space gives it the same single line box the real line occupies. The
 * swap is height-neutral.
 *
 * IT DELIBERATELY REUSES NO FreshnessState WORDING. Not 'not yet loaded', not 'unavailable':
 * both are REAL, EARNED outcomes of a COMPLETED read (see lib/dataFreshness.ts — 'unavailable'
 * means the read failed with no cached value, and 'not yet loaded' means a SUCCESSFUL read
 * returned null for this tenant). Rendering either one while the read is still in flight would
 * state a data fact we do not have yet. A blank reserved line is the only honest fallback.
 *
 * aria-hidden because a screen reader should be handed nothing here rather than an empty
 * paragraph; the real line is announced when it replaces this one.
 *
 * ⚠ RESIDUAL, KNOWN, AND ACCEPTED: this reserves exactly ONE line. The 'stale' variant is the
 * longest string and can wrap to two lines on a narrow viewport, which would still shift by one
 * line there. Reserving two lines instead would over-reserve and shift the common single-line
 * case in the opposite direction, so one line is the right trade — not an oversight.
 */
export function FreshnessLinePlaceholder() {
  // The <p>'s only child is U+00A0 (a non-breaking space), NOT a plain space. It is invisible in
  // most editors, so, explicitly: HTML collapses ordinary whitespace, so a <p> whose only child
  // is ' ' has no line box and reserves nothing at all. The nbsp is load-bearing — the test
  // 'the placeholder reserves a NON-COLLAPSING line box' is what keeps it that way.
  return (
    <p className="mt-2 text-xs text-muted-foreground" aria-hidden="true">
      {' '}
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
