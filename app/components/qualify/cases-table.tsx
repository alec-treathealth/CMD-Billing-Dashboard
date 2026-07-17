'use client';

/**
 * Qualify — recent cases table. The 15 most-recent DISTINCT patients for the resolved payer, masked.
 * No reveal on this tab (ruling: masked-by-default; the audited reveal action exists for other
 * surfaces). No Patient column — the contract carries no patient name here (only an audited reveal
 * would), so the single identity cell is the fully-masked Member ID.
 *
 * COLOR: the % cell is tinted by the case's PARENT FACILITY rating bucket (via `facilityBuckets`),
 * NOT the case's own raw pct — so "green" means the same facility-trustworthiness everywhere and a
 * single n=1 case can't fake green. Unknown/ambiguous parent → neutral.
 *
 * AMOUNTS: the Billed/Allowed columns (header AND cells) are OMITTED from the DOM when the viewer
 * lacks the amounts capability — not CSS-hidden. The server has already nulled the values.
 *
 * Pure/presentational (no hooks) so it renders hermetically under renderToStaticMarkup.
 */
import { bucketClass, caseBucket, type RatingBucket } from './colors';
import type { QualifyCase } from '../../lib/qualify/contract';

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const TH = 'border-b bg-teal50 px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap';
const TH_NUM = `${TH} text-right`;
const TD = 'border-b px-3.5 py-2.5 text-[13px] align-middle';

export function CasesTable({
  cases,
  hasAmounts,
  heatOn,
  facilityBuckets,
}: {
  cases: readonly QualifyCase[];
  hasAmounts: boolean;
  heatOn: boolean;
  facilityBuckets: Map<string, RatingBucket>;
}) {
  const colSpan = hasAmounts ? 7 : 5;
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-baseline justify-between px-4 pb-2.5 pt-4">
        <h2 className="font-head text-base font-semibold">Recent cases</h2>
        <span className="text-xs font-semibold text-muted-foreground">
          {cases.length} most-recent distinct patients · masked
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className={['w-full border-collapse', heatOn ? 'q-heat' : ''].join(' ')}>
          <thead>
            <tr>
              <th className={TH}>Member ID</th>
              <th className={TH}>Facility</th>
              <th className={TH}>Program</th>
              <th className={TH}>Last DOS</th>
              <th className={TH_NUM}>% allowed</th>
              {hasAmounts ? <th className={TH_NUM}>Billed</th> : null}
              {hasAmounts ? <th className={TH_NUM}>Allowed</th> : null}
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
                return (
                  <tr key={c.id}>
                    <td className={TD}>
                      <span className="font-mono tracking-widest text-ink400">{c.memberIdMasked}</span>
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
