'use client';

/**
 * THE LANE RAIL — the Smoke shell's left pane (mock: `.rail`, docs/mockups/qualify-smoke.html).
 *
 * "One search = one guardrailed swimlane." The rail holds the SESSION: the head (what lane you are
 * in + Start over), the LOCK STRIP (the guardrail, stated), the staged flow itself (the existing
 * ResolutionStages, passed as children — this component adds chrome, never flow logic), and the
 * slots-only composer at the bottom.
 *
 * PHI: the strip renders `echo` (prefix-safe by construction — '' for a full member ID) and
 * `readAs` (a sentence ABOUT the identifier that never embeds it, contract.ts's own rule). The raw
 * term never reaches this component; Start over only signals the owner, which clears its own ref.
 */
import type { ReactNode } from 'react';

export function LaneRail({
  echo,
  readAs,
  hasResolution,
  onReset,
  composer,
  children,
}: {
  /** The ≤3-char prefix echo ('' for a full-member-ID search — still a lane, echoed as masked). */
  echo: string;
  /** contract.ts's handle sentence, e.g. "read as a 3-character member-ID prefix". Null pre-search. */
  readAs: string | null;
  hasResolution: boolean;
  onReset: () => void;
  composer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-2xl border border-line bg-surface shadow-ths-sm" data-testid="qualify-lane-rail">
      {/* head — the session crumb + the reset. */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-teal700 text-[12px] text-white">▤</span>
        <span className="min-w-0 flex-1 truncate font-head text-[13.5px] font-semibold tracking-tight text-ink900">
          {hasResolution ? `Lane · ${echo !== '' ? echo : 'member ID'}` : 'New session'}
        </span>
        <button
          type="button"
          onClick={onReset}
          // aria-disabled, not disabled: a disabled control drops keyboard focus to <body> the
          // moment it lands (the refresh control's lesson, flow-state.ts) — the handler no-ops
          // instead, and the treatment says why it is inert.
          aria-disabled={!hasResolution}
          className={[
            'rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
            hasResolution
              ? 'border-teal200 text-teal700 hover:bg-teal50'
              : 'cursor-default border-line text-ink400',
          ].join(' ')}
        >
          ⟲ Start over
        </button>
      </div>

      {/* the lock strip — the guardrail, stated where the operator works. */}
      <p className="border-b border-line bg-teal50/60 px-4 py-2 font-mono text-[10.5px] leading-relaxed text-teal700">
        {hasResolution ? (
          <>
            <span aria-hidden>🔒 </span>
            Locked to {echo !== '' ? <b>{echo}</b> : 'this member ID'}
            {readAs ? ` — ${readAs}` : ''}. Answers come only from this lane&rsquo;s matched lines — nothing outside it.
          </>
        ) : (
          <>No lane yet — identify a client below to open one. One search, one lane.</>
        )}
      </p>

      {/* the staged flow — the existing v3 machinery, untouched, at rail width. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

      {/* the composer — slots only, pinned to the rail's foot like the mock. */}
      {composer}
    </div>
  );
}
