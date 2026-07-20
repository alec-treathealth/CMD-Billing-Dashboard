'use client';

/**
 * Qualify — recent CLAIMS table (claim grain). The most-recent claims for the resolved payer at the
 * selected facility; when the session arrived via an identifier search the list is narrowed to that
 * identifier server-side (Direction B) and the prefix input is prefilled with the searched echo.
 *
 * PHI reveal: masked by default; a SINGLE parent-owned header toggle ("Reveal all" ⇄ "Hide
 * identifiers") unmasks Patient / Member ID / Group # for every row at once (parity with the
 * collections grid + billing-audit work-table). The parent (qualify-tab) owns the `revealAll` flag and
 * fetches the scope's PHI in ONE audited revealQualifyRows call; `revealed` caches it, so toggling
 * off/on re-masks DISPLAY only and never re-audits. Masking reuses lib/phi's PHI_MASK convention.
 * Reveal is ORTHOGONAL to the amounts gate: an admissions_seat can reveal PHI but still sees zero dollars.
 *
 * COLOR: the % ALLOWED cell is tinted by the case's OWN allowed% (pctAllowedOfBilled) through the shared
 * ratingBucket helper (rating.ts cutoffs 50/30) — the same green/amber/red allowed-% scale the facility
 * rating uses, but keyed to this row's value. The facility rating color stays on the facility list (q-fac);
 * the two never cross-contaminate. (Was: inherited the parent facility's rating bucket.)
 * AMOUNTS: Billed/Allowed columns are OMITTED from the DOM when !viewerHasAmountsCapability.
 * SCOPE: `facilityLabel` names the facility these 15 belong to (ruling Q-4 — the list is scoped to the
 * SELECTED facility, so the scope must be visible). Facility name only; never PHI.
 * FILTER (Stage 2): an optional member-ID PREFIX narrow (STARTS-WITH, ≤3 chars) in the header. The parent
 * applies it server-side (member_id_prefix_bidx), so the input carries only the user's own typed prefix,
 * never row PHI. A <3-char entry mints no token (shows all) — the affordance says filtering starts at 3.
 */
import { bucketClass, type RatingBucket } from './colors';
import { ratingBucket } from '../../lib/qualify/rating';
import { PHI_MASK } from '../../lib/phi';
import type { QualifyClaim, QualifyPhi } from '../../lib/qualify/contract';

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
  claims,
  hasAmounts,
  heatOn,
  facilityLabel = null,
  canReveal,
  revealed,
  revealAll,
  revealing,
  revealError,
  onToggleRevealAll,
  prefix,
  onPrefixChange,
  onApplyPrefix,
  page,
  hasPrev,
  hasNext,
  paging,
  onPrevPage,
  onNextPage,
  emptyIdentifierLabel = null,
}: {
  claims: readonly QualifyClaim[];
  hasAmounts: boolean;
  heatOn: boolean;
  /** Facility-name → rating bucket map. RETAINED in the contract (callers still pass it), but the %
   *  ALLOWED cell no longer colors from it — it now uses the row's own pct via ratingBucket. Kept to
   *  avoid touching every caller in this surgical change; a later cleanup can drop it. */
  facilityBuckets: Map<string, RatingBucket>;
  /** Human name of the selected facility these cases are scoped to (display only; never PHI). */
  facilityLabel?: string | null;
  canReveal: boolean;
  /** Fetched PHI for the current scope, keyed by row id (cleared on scope change; never dropped on hide). */
  revealed: Map<number, QualifyPhi>;
  /** Parent-owned reveal toggle — gates DISPLAY of the cached PHI; there is no per-row state. */
  revealAll: boolean;
  /** A bulk reveal is in flight (the toggle shows "Revealing…"). */
  revealing: boolean;
  /** Last bulk-reveal error for the current scope, if any. */
  revealError: string | null;
  onToggleRevealAll: () => void;
  /** Member-ID PREFIX filter (STARTS-WITH). The user's own typed term — HMAC'd server-side, never row PHI. */
  prefix: string;
  onPrefixChange: (value: string) => void;
  /** Apply the prefix (explicit submit — mirrors the top-bar's Enter-to-resolve). */
  onApplyPrefix: () => void;
  /** Cursor-pagination controls (1-based page for display), matching the collections <Pager> idiom. */
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** A page fetch is in flight — disables the pager (mirrors collections' `disabled={busy}`). */
  paging: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  /** Fix A honest-empty: when set (an identifier search resolved with no in-window claims at any ranked
   *  facility), the empty row reads "No in-window claims for <label> — try a wider window" instead of the
   *  payer-wide copy. NON-PHI (a ≤3 prefix echo, or 'this member' for an exact search). Null = payer-path copy. */
  emptyIdentifierLabel?: string | null;
}) {
  const colSpan = 7 + (hasAmounts ? 2 : 0);
  // Prefix affordance — STARTS-WITH, never "contains". A 1-2 char entry mints no token server-side
  // (Stage 1), so it must read as "not yet filtering"; filtering activates at 3 characters.
  const trimmedPrefix = prefix.trim();
  const prefixHint =
    trimmedPrefix.length === 0
      ? null
      : trimmedPrefix.length < 3
        ? 'Enter 3 characters to filter'
        : 'Matches member IDs starting with these characters — press Enter';
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2.5 pt-4">
        <h2 className="font-display text-base font-semibold">
          Recent Claims
          {facilityLabel ? <span className="ml-2 text-sm font-medium text-muted-foreground">· {facilityLabel}</span> : null}
        </h2>
        <div className="flex items-center gap-3">
          {canReveal ? (
            <input
              value={prefix}
              onChange={(e) => onPrefixChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onApplyPrefix();
              }}
              spellCheck={false}
              maxLength={3}
              placeholder="Filter by ID prefix…"
              aria-label="Filter cases by member ID prefix (starts with)"
              className="h-8 w-40 rounded-md border bg-background px-2.5 text-[13px] text-ink900 outline-none focus:border-teal500 focus:ring-2 focus:ring-teal50"
            />
          ) : null}
          {canReveal ? (
            <button
              type="button"
              onClick={onToggleRevealAll}
              disabled={revealing}
              aria-pressed={revealAll}
              title="Reveal patient identifiers for these cases (audited)"
              className={[
                'rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60',
                revealAll ? 'border-teal500 bg-teal50 text-teal700' : 'border-teal200 bg-teal50 text-teal700 hover:bg-teal200',
              ].join(' ')}
            >
              {revealing ? 'Revealing…' : revealAll ? 'Hide identifiers' : 'Reveal all'}
            </button>
          ) : null}
          <span className="whitespace-nowrap text-xs font-semibold text-muted-foreground">
            {claims.length} recent claims{canReveal ? '' : ' · masked'}
          </span>
        </div>
      </div>
      {canReveal && prefixHint ? (
        <p className="px-4 pb-1 text-[11px] text-muted-foreground">{prefixHint}</p>
      ) : null}
      {canReveal && revealError ? (
        <p className="px-4 pb-1 text-[11px] font-medium text-status-danger">{revealError}</p>
      ) : null}
      <div className="overflow-x-auto">
        <table className={['w-full border-collapse', heatOn ? 'q-heat' : ''].join(' ')}>
          <thead>
            <tr>
              <th className={TH}>Patient</th>
              <th className={TH}>Member ID</th>
              <th className={TH}>Group #</th>
              <th className={TH}>Facility</th>
              <th className={TH}>Program</th>
              <th className={TH}>DOS</th>
              <th className={TH_NUM}>% allowed</th>
              {hasAmounts ? <th className={TH_NUM}>Billed</th> : null}
              {hasAmounts ? <th className={TH_NUM}>Allowed</th> : null}
            </tr>
          </thead>
          <tbody>
            {claims.length === 0 ? (
              <tr>
                <td className="px-3.5 py-6 text-center text-sm text-muted-foreground" colSpan={colSpan}>
                  {emptyIdentifierLabel
                    ? `No in-window claims for ${emptyIdentifierLabel} — try a wider window.`
                    : 'No claims for this payer in the selected window.'}
                </td>
              </tr>
            ) : (
              claims.map((c) => {
                const pct = c.pctAllowedOfBilled;
                // Color by the ROW'S OWN allowed% through the shared ratingBucket helper (rating.ts
                // cutoffs 50/30): ≥50 green, ≥30 amber, else red; null → neutral. NOT the parent
                // facility's rating bucket — this cell reports this case's reimbursement, not the site's.
                const bucket = ratingBucket(pct);
                const phi = revealAll ? revealed.get(c.id) : undefined;
                const isShown = phi !== undefined;
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
                    <td className={`${TD} text-muted-foreground`}>{c.dos ?? '—'}</td>
                    <td className={`${TD} text-right`}>
                      <span
                        className={['q-pctcell', bucketClass(bucket), 'inline-flex items-center gap-1.5 rounded px-2 py-0.5 tabular-nums font-semibold'].join(' ')}
                        title="Colored by this case's % allowed of billed"
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
      {/* Cursor pager — collections' "← Previous / Page N / Next →" idiom (inline to keep this
          render-tested leaf free of the data-grid/@/ deps). Shown only when pagination is relevant. */}
      {hasNext || page > 1 ? (
        <div className="flex items-center justify-between border-t px-4 py-3">
          <button
            type="button"
            onClick={onPrevPage}
            disabled={!hasPrev || paging}
            aria-label="Previous page"
            className="rounded-md border border-teal200 bg-teal50 px-3 py-1 text-[12px] font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-50"
          >
            ← Previous
          </button>
          <span className="text-xs text-muted-foreground">Page {page}</span>
          <button
            type="button"
            onClick={onNextPage}
            disabled={!hasNext || paging}
            aria-label="Next page"
            className="rounded-md border border-teal200 bg-teal50 px-3 py-1 text-[12px] font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-50"
          >
            Next →
          </button>
        </div>
      ) : null}
    </section>
  );
}
