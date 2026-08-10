'use client';

/**
 * THIS SEARCH — the board's resolution zone (mock: `.zone` + the `.rule` header above it).
 * "Drill left → resolve right": the rail asks the questions; this zone fills in as they are
 * answered — empty → matched strip → payer hero → the full answer (passed as children; it is the
 * SAME StageAnswer the single-column layout renders, just hosted here).
 *
 * NON-DOLLAR BY CONSTRUCTION, deliberately diverging from the mock: the mock's hero shows
 * "$1,059,000 billed", and that figure must not exist on this surface — an admissions_seat is
 * server-stripped of every dollar field, and the shell renders ONE zone for every role. Lines,
 * members, carriers, plans: those are the hero's stats.
 */
import type { ReactNode } from 'react';
import type { QualifyResolution } from '../../../lib/qualify/resolution';
import type { FlowStage, PayerGroup } from '../v3/resolution-flow';

const STAGE_TAGS: Record<FlowStage, string> = {
  identify: 'NOTHING RESOLVED YET',
  payer: 'MATCHED · PICK A CARRIER',
  plan: 'CARRIER LOCKED · PICK A PLAN',
  answer: 'ANSWERED',
};

export function ThisSearchZone({
  stage,
  resolution,
  payerGroups,
  payerPick,
  echo,
  children,
}: {
  stage: FlowStage;
  resolution: QualifyResolution | null;
  payerGroups: PayerGroup[];
  payerPick: string | null;
  echo: string;
  /** The answer-stage content (StageAnswer + AI panel), rendered by the owner. */
  children: ReactNode;
}) {
  return (
    <section aria-label="This search" data-testid="qualify-this-search">
      <ZoneRule label="This search" tag={STAGE_TAGS[stage]} level={2} />

      {stage === 'identify' || resolution === null ? (
        <p className="rounded-xl border border-dashed border-line bg-surface px-4 py-6 text-center text-[13px] leading-relaxed text-ink600">
          Nothing resolved yet — <b>the board fills in as you answer the rail</b>.
          <br />
          Start with a member ID prefix or a full member ID in the search lane.
        </p>
      ) : null}

      {stage === 'payer' && resolution !== null ? (
        <p className="rounded-xl border border-teal200 bg-teal50/50 px-4 py-3 text-[13px] leading-relaxed text-ink900">
          {echo !== '' ? <b className="font-mono">{echo}</b> : <b>Member ID</b>} matched —{' '}
          {payerGroups.length} carrier{payerGroups.length === 1 ? '' : 's'} possible ·{' '}
          <b>{payerGroups.reduce((n, g) => n + g.planCount, 0)}</b> plans on file across{' '}
          {payerGroups.reduce((n, g) => n + g.memberCount, 0)} members. Pick the carrier in the lane.
        </p>
      ) : null}

      {stage === 'plan' && resolution !== null ? (
        <PayerHero payerPick={payerPick} payerGroups={payerGroups} echo={echo} />
      ) : null}

      {stage === 'answer' ? children : null}
    </section>
  );
}

/** The resolved-payer hero (mock `.hero`), from the picked carrier's own cluster — counts only. */
function PayerHero({
  payerPick,
  payerGroups,
  echo,
}: {
  payerPick: string | null;
  payerGroups: PayerGroup[];
  echo: string;
}) {
  const group = payerPick !== null ? payerGroups.find((g) => g.payer === payerPick) ?? null : null;
  if (group === null) {
    return (
      <p className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-ink600">
        Carrier picked — choosing a plan in the lane narrows this board to it.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-teal200 bg-surface p-4" data-testid="qualify-payer-hero">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink400">Resolved carrier</div>
      <div className="mt-1 font-head text-xl font-semibold tracking-tight text-ink900">{group.payer}</div>
      <div className="mt-0.5 text-[12px] text-ink600">
        {echo !== '' ? `matched via prefix ${echo}` : 'matched via member ID'}
        {group.otherSpellings.length > 0 ? ` · absorbs ${group.otherSpellings.length} other spelling${group.otherSpellings.length === 1 ? '' : 's'}` : ''}
        {group.hasClaimEvidence ? ' · claims evidence on file' : ' · no claims evidence yet'}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wide text-ink400">Plans on file</dt>
          <dd className="font-display text-2xl text-ink900">{group.planCount}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wide text-ink400">Members behind them</dt>
          <dd className="font-display text-2xl text-ink900">{group.memberCount}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11.5px] text-ink400">Pick a plan in the lane — the full answer lands here.</p>
    </div>
  );
}

/**
 * The mock's `.rule` — a labelled divider with a state tag. Shared by the board's sections.
 *
 * `level` is opt-in: omit it and the label renders as the original `<span>` (byte-identical for
 * any caller left unchanged, e.g. `resolution-flow-client.tsx`'s import). Pass a heading level and
 * the SAME classes render on a real heading element instead — the board's three sections
 * (This search, Watchers, Recent searches) all do, because their `<h3>`s (WatchersPanel's
 * Trendwatchers / Patient watchers) were dangling under no `<h2>` and the page's only `<h1>` lives
 * in the rail's `ResolutionStages`, two levels up.
 */
export function ZoneRule({
  label,
  tag,
  action,
  level,
}: {
  label: string;
  tag?: string;
  action?: ReactNode;
  level?: 2 | 3 | 4;
}) {
  const Label: 'span' | 'h2' | 'h3' | 'h4' = level === 2 ? 'h2' : level === 3 ? 'h3' : level === 4 ? 'h4' : 'span';
  return (
    <div className="mb-3 mt-6 flex items-center gap-3 first:mt-0">
      <Label className="font-head text-[13px] font-semibold tracking-tight text-ink900">{label}</Label>
      {tag ? (
        <span className="font-mono text-[9.5px] font-medium uppercase tracking-[1px] text-ink400">{tag}</span>
      ) : null}
      <span aria-hidden className="h-px flex-1 bg-line" />
      {action}
    </div>
  );
}
