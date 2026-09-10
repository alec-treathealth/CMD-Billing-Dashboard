'use client';

/**
 * A tenant-gated metric is a STATE, never an absence (ruling 2026-09-08). Suppressed renders as an
 * explicit pill carrying the reason, so a column that is unavailable for one tenant never reads as
 * "this tenant has no write-offs". The reason line also renders once in the column header.
 */
import type { GatedMetric } from '@/lib/code-performance/contract';

import { MetricHint } from './metric-hint';

export function GatedValue({
  metric,
  format,
}: {
  metric: GatedMetric;
  format: (v: number | null) => string;
}) {
  if (metric.state === 'suppressed') {
    return (
      <span
        className="inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-medium text-ink600"
        title={metric.reason}
        data-state="suppressed"
      >
        suppressed
      </span>
    );
  }
  return <>{format(metric.value)}</>;
}

/**
 * The suppressed marker for a COLUMN HEADER; renders nothing when the metric is available.
 *
 * ⚠️ IT IS A SHORT TAG PLUS A HINT, NOT THE REASON INLINE — and the reason is a layout hazard, not a
 * style preference. These reasons run past 200 characters. Rendered inline into a header cell they
 * wrap to a dozen lines, and because a table row is as tall as its tallest cell, ONE of them inflated
 * the entire header to roughly 250px. With `align-bottom` the labels then sat at the floor of a tall
 * teal slab, which is exactly the "huge blue gap above the columns" this replaces. A sticky header
 * makes it worse: that slab is pinned, so it eats the top of the scroll area permanently.
 *
 * The full reason is still in the DOM inside the hint (`hidden` toggles visibility, not presence), so
 * the render suite's "the header carries the reason" assertion holds and find-in-page still works.
 *
 * ⚠️ NO `data-state="suppressed"` HERE. That attribute marks the suppressed CELL, and the suite
 * counts it to assert exactly one suppressed cell per row — a header carrying it would make BXR count
 * two and fail. The header is a label; the cell is the state.
 */
export function SuppressionReason({ metric, label = 'this metric' }: { metric: GatedMetric; label?: string }) {
  if (metric.state !== 'suppressed') return null;
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap font-normal normal-case tracking-normal text-status-warn">
      suppressed
      <MetricHint label={`why ${label} is suppressed`} align="right">
        {metric.reason}
      </MetricHint>
    </span>
  );
}
