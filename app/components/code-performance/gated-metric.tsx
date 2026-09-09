/**
 * A tenant-gated metric is a STATE, never an absence (ruling 2026-09-08). Suppressed renders as an
 * explicit pill carrying the reason, so a column that is unavailable for one tenant never reads as
 * "this tenant has no write-offs". The reason line also renders once in the column header.
 */
import type { GatedMetric } from '@/lib/code-performance/contract';

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

/** The one-line reason for a suppressed metric; renders nothing when the metric is available. */
export function SuppressionReason({ metric }: { metric: GatedMetric }) {
  if (metric.state !== 'suppressed') return null;
  return <span className="block max-w-[18rem] whitespace-normal text-xs font-normal normal-case tracking-normal text-status-warn">{metric.reason}</span>;
}
