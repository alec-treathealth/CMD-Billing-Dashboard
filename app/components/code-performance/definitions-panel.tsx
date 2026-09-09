'use client';

/**
 * Definitions for every code present in the window, from ref.code_description — with the review
 * markers visible (every seeded row is unreviewed; S9475 is the flagged conflict) and the second
 * source's text shown beside the first when one exists. Nothing here is a source of truth yet.
 *
 * ── PAGINATED (2026-09-09) ───────────────────────────────────────────────────────────────────────
 * A BXR 6-month window carries 44 pairings, which resolve to dozens of distinct codes. Rendering all
 * of them into a two-column definition list made this panel the tallest thing on the route by a wide
 * margin — open it and the page became a scroll with no end, which is the complaint this change
 * answers. Eight per page keeps the panel a fixed, predictable height whether the window holds six
 * codes or sixty.
 *
 * ⚠️ THE PAGE IS CLAMPED AT RENDER, NOT ONLY IN THE HANDLER. `rows` changes whenever the tenant,
 * window or facility filter changes, and the new code set is usually smaller — a reader sitting on
 * page 5 of the old set would otherwise be handed an empty panel with no indication why. Clamping
 * where the slice is computed means the last page is served instead, silently and correctly.
 */
import { useState } from 'react';

import type { CodeDescriptionMap, CodePerfPairingRow } from '@/lib/code-performance/contract';
import { describeCodeSlot } from '../../../src/collections/codePerformanceQuery.js';

import { lookupDescription, ReviewMarkers } from './code-slot';

/** Enough that a small window shows everything at once; small enough to bound the panel's height. */
const PER_PAGE = 8;

export function DefinitionsPanel({ rows, descriptions }: { rows: readonly CodePerfPairingRow[]; descriptions: CodeDescriptionMap }) {
  const [page, setPage] = useState(1);
  const procedure = [...new Set(rows.map((r) => r.hcpcs).filter((c): c is string => c !== null))].sort();
  const revenue = [...new Set(rows.map((r) => r.revcode).filter((c): c is string => c !== null))].sort();
  const items = [
    ...procedure.map((c) => ({ kind: 'procedure' as const, code: c })),
    ...revenue.map((c) => ({ kind: 'revenue' as const, code: c })),
  ];
  const unreviewed = items.filter((i) => lookupDescription(i.kind, i.code, descriptions)?.needsReview).length;
  const lastPage = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const shown = Math.min(Math.max(1, page), lastPage);
  const start = (shown - 1) * PER_PAGE;
  const slice = items.slice(start, start + PER_PAGE);
  const navCls =
    'inline-flex min-h-[36px] items-center rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink900 transition-colors hover:bg-teal50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500';

  return (
    <details className="rounded-lg border border-line bg-card shadow-ths-sm">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink900">
        Code definitions in this window ({items.length}) — {unreviewed} unreviewed
      </summary>
      <div className="border-t border-line px-4 py-3 text-sm">
        <p className="mb-3 text-xs text-ink600">
          From <code>ref.code_description</code>.{' '}
          <span className="rounded-full bg-status-warn/10 px-1.5 py-0.5 font-semibold text-status-warn">unreviewed</span> means the text has not
          been validated against an authoritative source;{' '}
          <span className="rounded-full bg-status-danger/10 px-1.5 py-0.5 font-semibold text-status-danger">conflict</span> means two sources
          disagree in substance and both are shown.
        </p>
        <dl className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {slice.map(({ kind, code }) => {
            const slot = describeCodeSlot(kind, code);
            const d = lookupDescription(kind, code, descriptions);
            return (
              <div key={`${kind}:${code}`} className="rounded-md border border-line p-2.5">
                <dt className="flex flex-wrap items-center gap-1.5">
                  <span className="ths-num font-semibold text-ink900">{slot.label}</span>
                  <span className="text-xs uppercase tracking-wide text-ink400">{kind === 'revenue' ? 'REV' : d?.codeType ?? 'code'}</span>
                  <ReviewMarkers desc={d} />
                </dt>
                <dd className="mt-1 text-xs text-ink900">{d?.shortLabel ?? 'No description on file'}</dd>
                {d?.longDescription && <dd className="mt-1 text-[11px] text-ink600">{d.longDescription}</dd>}
                {d?.priorDescription && (
                  <dd className="mt-1 text-[11px] text-ink600">
                    <span className="font-semibold">Other source:</span> {d.priorDescription}
                  </dd>
                )}
                {d?.sourceCitation && <dd className="mt-1 break-words text-[11px] text-ink400">{d.sourceCitation}</dd>}
              </div>
            );
          })}
        </dl>
        {items.length > PER_PAGE && (
          <nav aria-label="Definition pages" className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs tabular-nums text-ink600">
              {items.length === 0 ? 'No codes' : `Showing ${start + 1}–${Math.min(start + PER_PAGE, items.length)} of ${items.length}`}
            </p>
            <div className="flex gap-2">
              <button type="button" className={navCls} onClick={() => setPage(shown - 1)} disabled={shown <= 1}>
                Previous
              </button>
              <button type="button" className={navCls} onClick={() => setPage(shown + 1)} disabled={shown >= lastPage}>
                Next
              </button>
            </div>
          </nav>
        )}
      </div>
    </details>
  );
}
