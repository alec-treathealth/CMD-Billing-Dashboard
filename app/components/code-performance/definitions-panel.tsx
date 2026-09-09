/**
 * Definitions for every code present in the window, from ref.code_description — with the review
 * markers visible (every seeded row is unreviewed; S9475 is the flagged conflict) and the second
 * source's text shown beside the first when one exists. Nothing here is a source of truth yet.
 */
import type { CodeDescriptionMap, CodePerfPairingRow } from '@/lib/code-performance/contract';
import { describeCodeSlot } from '../../../src/collections/codePerformanceQuery.js';

import { lookupDescription, ReviewMarkers } from './code-slot';

export function DefinitionsPanel({ rows, descriptions }: { rows: readonly CodePerfPairingRow[]; descriptions: CodeDescriptionMap }) {
  const procedure = [...new Set(rows.map((r) => r.hcpcs).filter((c): c is string => c !== null))].sort();
  const revenue = [...new Set(rows.map((r) => r.revcode).filter((c): c is string => c !== null))].sort();
  const items = [
    ...procedure.map((c) => ({ kind: 'procedure' as const, code: c })),
    ...revenue.map((c) => ({ kind: 'revenue' as const, code: c })),
  ];
  const unreviewed = items.filter((i) => lookupDescription(i.kind, i.code, descriptions)?.needsReview).length;
  return (
    <details className="rounded-lg border border-line bg-card shadow-ths-sm">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink900">
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
        <dl className="grid gap-3 sm:grid-cols-2">
          {items.map(({ kind, code }) => {
            const slot = describeCodeSlot(kind, code);
            const d = lookupDescription(kind, code, descriptions);
            return (
              <div key={`${kind}:${code}`} className="rounded-md border border-line p-3">
                <dt className="flex flex-wrap items-center gap-1.5">
                  <span className="ths-num font-semibold text-ink900">{slot.label}</span>
                  <span className="text-xs uppercase tracking-wide text-ink400">{kind === 'revenue' ? 'REV' : d?.codeType ?? 'code'}</span>
                  <ReviewMarkers desc={d} />
                </dt>
                <dd className="mt-1 text-ink900">{d?.shortLabel ?? 'No description on file'}</dd>
                {d?.longDescription && <dd className="mt-1 text-xs text-ink600">{d.longDescription}</dd>}
                {d?.priorDescription && (
                  <dd className="mt-1 text-xs text-ink600">
                    <span className="font-semibold">Other source:</span> {d.priorDescription}
                  </dd>
                )}
                {d?.sourceCitation && <dd className="mt-1 break-words text-xs text-ink400">{d.sourceCitation}</dd>}
              </div>
            );
          })}
        </dl>
      </div>
    </details>
  );
}
