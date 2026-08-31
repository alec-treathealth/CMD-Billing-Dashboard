/**
 * The Collections grid's Payment Received cell — the date, plus the "scheduled" marker.
 *
 * PURE presentational, no hooks, no effects, no '@/' aliases, so the hermetic render suite can load
 * it directly. Extracted for the same reason FacilityCell was: cmd-explorer.tsx is a large
 * `'use client'` island whose import graph reaches @/lib/access, which calls the RSC `cache()` and
 * crashes under the node:test runtime — a cell left inline there ships untested.
 *
 * ── WHAT THE BADGE MEANS, AND WHY IT IS UNCONDITIONAL ──────────────────────────────────────────
 * `is_scheduled` is TRUE when the payment is dated AFTER business-today: money that has not settled.
 * The Collections default window now excludes those rows, and "Include scheduled" brings them back.
 *
 * ⚠ THE BADGE RENDERS REGARDLESS OF THE TOGGLE (ruled 2026-08-30). If a future-dated row is on
 * screen at all, the reader must be able to see that it is not settled cash — otherwise the toggle
 * silently moves a total with no marker, which is the failure the whole change exists to prevent.
 * Do not make it conditional on the toggle: by the time a row is here, the toggle already let it in.
 *
 * ── WHY THE FLAG IS NOT COMPUTED HERE ──────────────────────────────────────────────────────────
 * The server resolves it at the same instant it resolves the window bounds, and ships it per row.
 * Deriving it in this component would mean calling businessDayIso() client-side, which puts a
 * timezone dependency in the browser AND leaves a staleness window: a tab open across midnight
 * Pacific would keep rendering yesterday's answer. Projecting the flag eliminates that rather than
 * bounding it. This component therefore reads no clock and knows no timezone.
 *
 * Non-PHI: a date and a boolean.
 */
import type { ReactNode } from 'react';

/** Exactly the fields this cell reads — not the whole 17-column row, so a fixture stays honest. */
export interface PaymentDateCellRow {
  /** Server-resolved: payment_received > business-today. False for an undated charge. */
  is_scheduled: boolean;
}

export function PaymentDateCell({
  row,
  text,
}: {
  row: PaymentDateCellRow;
  /** The already-formatted date string (or an em dash) from the grid's own cellText(). */
  text: ReactNode;
}): ReactNode {
  if (!row.is_scheduled) return text;
  return (
    <span className="inline-flex items-center gap-1.5">
      {text}
      {/* Dashed + muted rather than a colour fill: this is a qualifier on a value, not an alarm,
          and the distinction must survive greyscale and forced-colours mode (WCAG 1.4.1). */}
      <span
        data-scheduled="true"
        className="rounded-full border border-dashed border-ink400 bg-surface px-2 py-0.5 text-xs font-medium text-ink600"
      >
        scheduled
      </span>
    </span>
  );
}
