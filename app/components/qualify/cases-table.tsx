'use client';

/**
 * Qualify — recent cases table. The 15 most-recent DISTINCT patients for the resolved payer.
 *
 * PHI reveal (Prompt 3c): masked by default; a per-row toggle unmasks Patient / Member ID / Group #
 * via the audited revealQualifyRow action. Fetch-once-per-session — `revealed` caches the PHI and
 * `shown` controls visibility, so toggling a revealed row off/on never re-audits (one audited reveal
 * per row per session). Masking reuses lib/phi's PHI_MASK convention. Reveal is ORTHOGONAL to the
 * amounts gate: an admissions_seat can reveal PHI but still sees zero dollars.
 *
 * COLOR: the % cell is tinted by the case's PARENT FACILITY rating bucket (never the case's own pct).
 * AMOUNTS: Billed/Allowed columns are OMITTED from the DOM when !viewerHasAmountsCapability.
 */
import { bucketClass, caseBucket, type RatingBucket } from './colors';
import { PHI_MASK } from '../../lib/phi';
import type { QualifyCase, QualifyPhi } from '../../lib/qualify/contract';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const TH = 'border-b bg-teal50 px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap';
const TH_NUM = `${TH} text-right`;
const TD = 'border-b px-3.5 py-2.5 text-[13px] align-middle';

/** A masked-until-revealed PHI cell, mirroring lib/phi's displayCell convention. */
function phiText(shownReal: boolean, real: string | null, mask: string): string {
  if (!shownReal) return mask;
  return real ?? '—';
}

export function CasesTable({
  cases,
  hasAmounts,
  heatOn,
  facilityBuckets,
  canReveal,
  revealed,
  shown,
  pendingIds,
  revealErrors,
  onToggle,
}: {
  cases: readonly QualifyCase[];
  hasAmounts: boolean;
  heatOn: boolean;
  facilityBuckets: Map<string, RatingBucket>;
  canReveal: boolean;
  /** Fetched PHI, cached for the session (never dropped on hide). */
  revealed: Map<number, QualifyPhi>;
  /** Rows currently unmasked. */
  shown: Set<number>;
  /** Rows with an in-flight reveal. */
  pendingIds: Set<number>;
  /** Last reveal error per row. */
  revealErrors: Map<number, string>;
  onToggle: (id: number) => void;
}) {
  const colSpan = 7 + (hasAmounts ? 2 : 0) + (canReveal ? 1 : 0);
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-baseline justify-between px-4 pb-2.5 pt-4">
        <h2 className="font-display text-base font-semibold">Recent cases</h2>
        <span className="text-xs font-semibold text-muted-foreground">
          {cases.length} most-recent distinct patients{canReveal ? '' : ' · masked'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className={['w-full border-collapse', heatOn ? 'q-heat' : ''].join(' ')}>
          <thead>
            <tr>
              <th className={TH}>Patient</th>
              <th className={TH}>Member ID</th>
              <th className={TH}>Group #</th>
              <th className={TH}>Facility</th>
              <th className={TH}>Program</th>
              <th className={TH}>Last DOS</th>
              <th className={TH_NUM}>% allowed</th>
              {hasAmounts ? <th className={TH_NUM}>Billed</th> : null}
              {hasAmounts ? <th className={TH_NUM}>Allowed</th> : null}
              {canReveal ? <th className={`${TH} text-right`}>PHI</th> : null}
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 ? (
              <tr>
                <td className="px-3.5 py-6 text-center text-sm text-muted-foreground" colSpan={colSpan}>
                  No cases for this payer in the selected window.
                </td>
              </tr>
            ) : (
              cases.map((c) => {
                const bucket = caseBucket(facilityBuckets, c.facilityName);
                const pct = c.pctAllowedOfBilled;
                const phi = shown.has(c.id) ? revealed.get(c.id) : undefined;
                const isShown = phi !== undefined;
                const isPending = pendingIds.has(c.id);
                const err = revealErrors.get(c.id);
                const maskedCls = 'font-mono tracking-widest text-ink400';
                const realCls = 'font-mono text-ink900';
                return (
                  <tr key={c.id}>
                    <td className={TD}>
                      <span className={isShown ? 'text-ink900' : 'text-ink400'}>
                        {phiText(isShown, phi?.patient_name ?? null, PHI_MASK)}
                      </span>
                    </td>
                    <td className={TD}>
                      <span className={isShown ? realCls : maskedCls}>
                        {isShown ? phiText(true, phi?.member_id_raw ?? null, PHI_MASK) : c.memberIdMasked}
                      </span>
                    </td>
                    <td className={TD}>
                      <span className={isShown ? realCls : maskedCls}>
                        {phiText(isShown, phi?.group_number ?? null, PHI_MASK)}
                      </span>
                    </td>
                    <td className={TD}>{c.facilityName ?? '—'}</td>
                    <td className={TD}>
                      {c.program ? (
                        <span className="inline-flex items-center rounded-full bg-[#e4f0f5] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-status-info">
                          {c.program}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={`${TD} text-muted-foreground`}>{c.lastDos ?? '—'}</td>
                    <td className={`${TD} text-right`}>
                      <span
                        className={['q-pctcell', bucketClass(bucket), 'inline-flex items-center gap-1.5 rounded px-2 py-0.5 tabular-nums font-semibold'].join(' ')}
                        title="Colored by the facility's reimbursement rating"
                      >
                        <span className="q-dot inline-block h-2 w-2 rounded-full" />
                        {pct === null ? '—' : `${Math.round(pct)}%`}
                      </span>
                    </td>
                    {hasAmounts ? (
                      <td className={`${TD} text-right tabular-nums`}>{c.billedAmount === null ? '—' : usd0(c.billedAmount)}</td>
                    ) : null}
                    {hasAmounts ? (
                      <td className={`${TD} text-right tabular-nums`}>{c.allowedAmount === null ? '—' : usd0(c.allowedAmount)}</td>
                    ) : null}
                    {canReveal ? (
                      <td className={`${TD} text-right`}>
                        <button
                          type="button"
                          onClick={() => onToggle(c.id)}
                          disabled={isPending}
                          aria-pressed={isShown}
                          className="rounded-md border border-teal200 bg-teal50 px-2 py-1 text-[11px] font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-60"
                        >
                          {isPending ? '…' : isShown ? 'Hide' : 'Reveal'}
                        </button>
                        {err ? <div className="mt-1 text-[10px] font-medium text-status-danger">{err}</div> : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
