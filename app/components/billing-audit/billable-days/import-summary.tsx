'use client';

/**
 * Import Summary — every diagnostic the engine produced for this import, in one collapsible
 * panel. This is deliberately verbose: the grid's numbers are only trustworthy if the things
 * the parser HELD OUT are visible, so nothing here is hidden behind a "details" affordance
 * that a biller will not click.
 *
 * All counts and rule text. No filename, no patient identifier — the server never sent any.
 */
import { useState } from 'react';
import type { KipuDiagnosticsDTO } from '@/lib/billing-audit/kipu-import';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-44 shrink-0 text-xs text-ink400">{label}</span>
      <div className="min-w-0 flex-1 text-xs text-ink900">{children}</div>
    </div>
  );
}

function Bullets({ items, tone = 'plain' }: { items: readonly string[]; tone?: 'plain' | 'warn' }) {
  if (items.length === 0) return <span className="text-ink400">none</span>;
  return (
    <ul className="space-y-1">
      {items.map((t, i) => (
        <li key={i} className={tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''}>
          {t}
        </li>
      ))}
    </ul>
  );
}

export function ImportSummary({ d }: { d: KipuDiagnosticsDTO }) {
  const [open, setOpen] = useState(false);
  const kinds = Object.entries(d.filesByKind);
  const warnCount = d.notes.length + d.locFlags.length + d.tzFlags.length + d.tzUnknown.length;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <span className={`text-ink400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ▸
        </span>
        <span className="ths-h font-semibold text-ink900">Import summary</span>
        <span className="text-ink400">
          {kinds.map(([k, n]) => `${n} ${k}`).join(' · ')} · {d.clientCount} clients · {d.weekCount} weeks
        </span>
        {warnCount > 0 && (
          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[10.5px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {warnCount} to read
          </span>
        )}
      </button>

      {open && (
        <div className="divide-y divide-line border-t border-line px-3 py-2">
          <Row label="Files parsed">
            {kinds.length === 0 ? 'none' : kinds.map(([k, n]) => `${k}: ${n}`).join(' · ')}
            <div className="mt-1 text-ink400">
              Detected by header signature, never by filename — a renamed export still parses.
            </div>
          </Row>

          <Row label="Rows counted">
            group sessions: {d.rowsByKind['sessions'] ?? 0} · evaluations: {d.rowsByKind['evaluations'] ?? 0}
          </Row>

          <Row label="Held non-billable">
            <Bullets items={d.skipped} tone="warn" />
            <div className="mt-1 text-ink400">
              Rows the parser refused to count, with the engine&apos;s reason. These are excluded from
              every number above.
            </div>
          </Row>

          <Row label="Rules notes">
            <Bullets items={d.notes} tone="warn" />
          </Row>

          <Row label="Level-of-care config">
            {d.locConfig.length === 0 ? (
              <span className="text-ink400">none</span>
            ) : (
              <ul className="space-y-0.5">
                {d.locConfig.map((c) => (
                  <li key={c.loc}>
                    <span className="font-medium">{c.loc}</span> — {c.track} · cap {c.capDays} d/wk · min{' '}
                    {c.minHours} h
                    {c.ambiguous && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        inferred
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1">
              <Bullets items={d.locFlags} tone="warn" />
            </div>
          </Row>

          <Row label="Timezone">
            {d.tzFlags.length === 0 && d.tzUnknown.length === 0 ? (
              <span className="text-ink400">no mismatches</span>
            ) : (
              <ul className="space-y-1">
                {d.tzFlags.map((f) => (
                  <li key={f.facility} className="text-amber-700 dark:text-amber-400">
                    <span className="font-medium">{f.facility}</span>: Kipu declares {f.declared}, registry
                    says {f.ours} (Δ{f.deltaH}h) — reported, never silently corrected.
                  </li>
                ))}
                {d.tzUnknown.map((f) => (
                  <li key={f} className="text-amber-700 dark:text-amber-400">
                    <span className="font-medium">{f}</span>: no zone in the registry.
                  </li>
                ))}
              </ul>
            )}
          </Row>

          <Row label="Midnight-adjacent">
            {d.midnightAdjacent} session{d.midnightAdjacent === 1 ? '' : 's'} within ±{d.midnightGuardMin} min
            of a day boundary
            <div className="mt-1 text-ink400">
              Reported, not moved. A session this close to midnight can land on either calendar day
              depending on the location&apos;s zone.
            </div>
          </Row>

          <Row label="Locations seen">
            {d.facilities.length === 0 ? <span className="text-ink400">none</span> : d.facilities.join(' · ')}
          </Row>
        </div>
      )}
    </div>
  );
}
