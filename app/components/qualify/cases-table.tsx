'use client';

/**
 * ⚠ NOT MOUNTED ANYWHERE as of 2026-08-04. Alec ruled the claim-line grid off the desktop /qualify page
 * entirely — that surface answers "which facility", and per-claim rows answered a different question
 * while crowding the ranking and being the only reason PHI rows were fetched there. This component and
 * its tests are RETAINED, not deleted: the masking/reveal behaviour below is carefully specified and
 * tested, and re-mounting it (here or on a future audit surface) should not mean rewriting it. It has no
 * caller today — /qualify/m renders its own claim views. Decide keep-vs-delete deliberately, not by
 * assuming this is live.
 *
 * Qualify — recent CLAIMS table (claim grain). The most-recent claims for the resolved payer at the
 * selected facility, grouped by patient. SORT/COLUMNS: the panel windows AND sorts on PAYMENT date
 * (payment_received) — both the Payment date and DOS (service date) columns render so the order reads
 * plainly (the sort axis is visible, not implied). RULING (settled): the MAIN top-bar search is the ONE
 * place an identifier is ever typed — it LANDS on the searched member's facility (Fix A), and this panel
 * is a PURE DISPLAY of that facility (the searched member present in context among its patients).
 *
 * PHI reveal: PER-PATIENT (not per-page). Masked by default. EXPANDING a patient group reveals THAT
 * patient's claims in ONE audited revealQualifyRows call (onRevealPatient); a single-claim patient gets a
 * small "Reveal" button that does the same for its one claim. A patient's claim count is always <<
 * REVEAL_BATCH_CAP, so the cap is never hit — and only patients the user actually opens are unmasked
 * (least-privilege; the old blanket "Reveal all" is GONE — it couldn't honor the 50-cap over a whole
 * window and over-revealed). `revealed` (parent-owned, keyed by claim id) caches the PHI; a claim shows
 * real identifiers iff its id is cached. "Hide identifiers" (onHideIdentifiers) is a per-session mask reset
 * that clears the cache. Masking reuses lib/phi's PHI_MASK. Reveal is ORTHOGONAL to the amounts gate: an
 * admissions_seat can reveal PHI but still sees zero dollars.
 *
 * COLOR (0059 trust signal — CONFIDENCE-FIRST via confidenceOf; supersedes both prior rules): a
 * `confirmed` claim's % ALLOWED cell grades by its own pct through ratingBucket (50/30 cutoffs); an
 * `estimate` (tier e2 — reversals we couldn't verify, excluded from the facility rating) is ALWAYS
 * amber with a "~" prefix and an "estimate · reversals" caption — NEVER green, however high the
 * number (X's reversal tell); an `unknown` is neutral and reads "no allowed on file". (History: was
 * parent-facility bucket, then row-pct — see colors.ts.)
 * AMOUNTS: Billed/Allowed columns are OMITTED from the DOM when !viewerHasAmountsCapability.
 * SCOPE: `facilityLabel` names the facility these 15 belong to (ruling Q-4 — the list is scoped to the
 * SELECTED facility, so the scope must be visible). Facility name only; never PHI.
 * NO IN-PANEL FILTERS: the former in-header prefix + group-# inputs are REMOVED (redundant echoes of
 * the main bar). The reveal toggle stays — it is NOT a filter.
 */
import { Fragment, useState } from 'react';
import { bucketClass, type RatingBucket } from './colors';
import { ratingBucket } from '../../lib/qualify/rating';
import { CONFIDENCE_LEGEND } from '../../lib/qualify/confidence';
import { groupClaimsByPatient, type QualifyClaimGroup } from '../../lib/qualify/groupClaims';
import { PHI_MASK } from '../../lib/phi';
import { QUALIFY_REVEAL_BATCH_CAP, type QualifyClaim, type QualifyPhi } from '../../lib/qualify/contract';

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
  revealingKeys,
  revealError,
  onRevealPatient,
  onHideIdentifiers,
  onViewCohort,
  capped = false,
  emptyIdentifierLabel = null,
  filterCaption = null,
  globalRevealOn = false,
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
  /** Fetched PHI for the current scope, keyed by claim id. A claim shows PHI iff its id is here. */
  revealed: Map<number, QualifyPhi>;
  /** patientKeys whose per-patient reveal is in flight (drives the row "Revealing…" state). */
  revealingKeys: ReadonlySet<number>;
  /** Last reveal error for the current scope, if any. */
  revealError: string | null;
  /** PER-PATIENT reveal: reveal THIS patient's claims (one audited call). Fired on group EXPAND + the
   *  singleton "Reveal" button. `patientKey` is the per-response ordinal; `claimIds` are that patient's rows. */
  onRevealPatient: (patientKey: number, claimIds: number[]) => void;
  /** "Hide identifiers" — a per-session mask reset (clears the whole revealed cache). */
  onHideIdentifiers: () => void;
  /** Phase 3: open the patient's LIFETIME prefix-cohort slide-over. Called with ONE claim id of the
   *  group (non-PHI synthetic id — the server re-derives the cohort token) + the MASKED group label.
   *  Optional so render tests mount without it (the chip is omitted when absent). */
  onViewCohort?: (claimId: number, patientLabel: string) => void;
  /** True when the window held MORE than QUALIFY_CASES_MAX (500) claims and the list was truncated to the
   *  most recent by payment date — shows an honest "narrow the window" nudge. No pager (the drill is the
   *  whole window, grouped by patient). */
  capped?: boolean;
  /** Fix A honest-empty: when set (an identifier search resolved with no in-window claims at any ranked
   *  facility), the empty row reads "No in-window claims for <label> — try a wider window" instead of the
   *  payer-wide copy. NON-PHI (a ≤3 prefix echo, or 'this member' for an exact search). Null = payer-path copy. */
  emptyIdentifierLabel?: string | null;
  /** Fix 1 — when the resolving search was an identifier (prefix/member/client name), the drill is
   *  narrowed to it server-side, so this panel lists only matching claims. This NON-PHI caption (a ≤3
   *  alpha-prefix echo, or a generic "this member" / "this client name" — never the raw term) names the
   *  narrow in the header AND switches the empty row to the "no matching claims here" copy, so a
   *  payer-wide facility with no matching members reads as intentional. Null = no identifier narrow. */
  filterCaption?: string | null;
  /** Change B — the surface-wide persistent reveal is ON (super_admin/admin): the container is
   *  auto-revealing every loaded scope through the SAME audited path, so the header hint reads
   *  "identifiers revealed (audited)" instead of the per-patient nudge. Display-only. */
  globalRevealOn?: boolean;
}) {
  const colSpan = 8 + (hasAmounts ? 2 : 0); // Patient·Member·Group·Facility·Program·Payment date·DOS·%allowed (+Billed·Allowed)
  // Patient groups expanded to their day-by-day claims (collapsed by default; per-response keys).
  const [expandedPatients, setExpandedPatients] = useState<ReadonlySet<number>>(new Set());
  const togglePatient = (key: number) =>
    setExpandedPatients((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const groups = groupClaimsByPatient(claims);

  /** Small "cohort" chip — opens the patient's prefix-cohort slide-over (Phase 3). */
  const cohortChip = (claimId: number, patientKey: number) =>
    onViewCohort ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onViewCohort(claimId, `Patient ${patientKey}`);
        }}
        title="View this patient's cohort context (lifetime peer group; aggregates only)"
        className="ml-1 rounded-full border border-teal200 bg-teal50 px-1.5 py-px text-[10px] font-semibold text-teal700 hover:bg-teal200"
      >
        cohort
      </button>
    ) : null;

  /** ONE claim row (claim grain) — `indented` marks a day-by-day row under an expanded patient group;
   *  `withCohortChip` adds the Phase-3 affordance on singleton patient rows. */
  const renderClaimRow = (c: QualifyClaim, indented = false, withCohortChip = false) => {
    const pct = c.pctAllowedOfBilled;
    // CONFIDENCE-FIRST (0059): confirmed → grade by this row's own pct (ratingBucket 50/30);
    // estimate → ALWAYS amber (never green, however high the number — the reversal tell);
    // unknown → neutral. See the header comment + colors.ts history.
    const bucket: RatingBucket =
      c.confidence === 'confirmed' ? ratingBucket(pct) : c.confidence === 'estimate' ? 'warn' : 'neutral';
    const phi = revealed.get(c.id); // a claim shows PHI iff its id is in the cache (no page-level gate)
    const isShown = phi !== undefined;
    const maskedCls = 'font-mono tracking-widest text-ink400';
    const realCls = 'font-mono text-ink900';
    return (
      <tr key={c.id} className={indented ? 'bg-surface' : undefined}>
        <td className={TD}>
          <span className={[indented ? 'pl-6' : '', isShown ? 'text-ink900' : 'text-ink400'].join(' ')}>
            {indented ? '↳ ' : ''}
            {phiText(isShown, phi?.patient_name ?? null, PHI_MASK)}
          </span>
          {withCohortChip ? cohortChip(c.id, c.patientKey) : null}
          {/* Singleton-patient reveal (there's no group to expand): one audited call for this one claim. */}
          {withCohortChip && canReveal && !isShown ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRevealPatient(c.patientKey, [c.id]); }}
              disabled={revealingKeys.has(c.patientKey)}
              title="Reveal this patient's identifiers (audited)"
              className="ml-1 rounded-full border border-teal200 bg-teal50 px-1.5 py-px text-[10px] font-semibold text-teal700 hover:bg-teal200 disabled:opacity-60"
            >
              {revealingKeys.has(c.patientKey) ? 'Revealing…' : 'Reveal'}
            </button>
          ) : null}
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
        <td className={`${TD} min-w-[200px]`}>{c.facilityName ?? '—'}</td>
        <td className={TD}>
          {c.program ? (
            <span className="inline-flex items-center rounded-full bg-[#e4f0f5] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-status-info">
              {c.program}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{c.paymentDate ?? '—'}</td>
        <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{c.dos ?? '—'}</td>
        <td className={`${TD} min-w-[116px] text-right`}>
          <span
            className={['q-pctcell', bucketClass(bucket), 'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 tabular-nums font-semibold'].join(' ')}
            title={
              c.confidence === 'estimate'
                ? CONFIDENCE_LEGEND.captions.estimate
                : c.confidence === 'unknown'
                  ? CONFIDENCE_LEGEND.captions.unknown
                  : "Colored by this case's % allowed of billed"
            }
          >
            <span className="q-dot inline-block h-2 w-2 rounded-full" />
            {pct === null ? '—' : c.confidence === 'estimate' ? `~${Math.round(pct)}%` : `${Math.round(pct)}%`}
          </span>
          {c.confidence === 'estimate' ? (
            <span className="block text-[10px] leading-tight text-ink400">estimate · reversals</span>
          ) : null}
          {c.confidence === 'unknown' ? (
            <span className="block text-[10px] leading-tight text-ink400">no allowed on file</span>
          ) : null}
        </td>
        {hasAmounts ? (
          <td className={`${TD} text-right tabular-nums`}>{c.billedAmount === null ? '—' : usd0(c.billedAmount)}</td>
        ) : null}
        {hasAmounts ? (
          <td className={`${TD} text-right tabular-nums`}>{c.allowedAmount === null ? '—' : usd0(c.allowedAmount)}</td>
        ) : null}
      </tr>
    );
  };

  /** ONE patient group: header row (chevron · patient label · count · roll-up pct) + optional day rows. */
  const renderGroup = (g: QualifyClaimGroup) => {
    if (g.claimCount === 1) return renderClaimRow(g.claims[0]!, false, true);
    const open = expandedPatients.has(g.patientKey);
    const first = g.claims[0]!;
    // Group-row PHI: the first claim of the group whose PHI is in the reveal cache (all claims of a
    // patient share identity, so any revealed member works).
    const phi = g.claims.map((c) => revealed.get(c.id)).find((p) => p !== undefined);
    const isShown = phi !== undefined;
    const revealingThis = revealingKeys.has(g.patientKey);
    // EXPAND = reveal (audited, this patient only). Toggle the day rows; on OPEN, reveal the patient's
    // claims (deduped in the parent, so a re-expand never re-audits). Collapsing keeps the PHI cached.
    const onToggle = () => {
      const opening = !open;
      togglePatient(g.patientKey);
      if (opening && canReveal && !isShown) onRevealPatient(g.patientKey, g.claims.map((c) => c.id));
    };
    const programs = [...new Set(g.claims.map((c) => c.program).filter(Boolean))].join('·');
    const bucket: RatingBucket =
      g.confidence === 'confirmed' ? ratingBucket(g.avgPct) : g.confidence === 'estimate' ? 'warn' : 'neutral';
    const billedSum = g.claims.reduce<number | null>((a, c) => (c.billedAmount === null ? a : (a ?? 0) + c.billedAmount), null);
    const allowedSum = g.claims.reduce<number | null>((a, c) => (c.allowedAmount === null ? a : (a ?? 0) + c.allowedAmount), null);
    return (
      <Fragment key={`p${g.patientKey}`}>
        <tr>
          <td className={TD}>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="inline-flex items-center gap-1.5 font-semibold text-ink900"
              title={open ? 'Collapse this patient’s claims' : canReveal ? 'Expand to reveal + see day-by-day claims (audited)' : 'Expand to day-by-day claims'}
            >
              <span aria-hidden className="text-[10px] text-ink400">{open ? '▾' : '▸'}</span>
              <span className={isShown ? 'text-ink900' : 'text-ink400'}>
                {isShown ? (phi?.patient_name ?? '—') : `Patient ${g.patientKey}`}
              </span>
              <span className="rounded-full bg-teal50 px-1.5 py-px text-[10px] font-bold text-teal700">
                {g.claimCount} claims
              </span>
              {revealingThis ? <span className="text-[10px] font-medium text-ink400">Revealing…</span> : null}
            </button>
            {cohortChip(first.id, g.patientKey)}
            {/* Rare high-frequency patient: a single audited batch caps at REVEAL_BATCH_CAP, so IDs beyond
                the 50 most recent stay masked — say so honestly. */}
            {isShown && g.claimCount > QUALIFY_REVEAL_BATCH_CAP ? (
              <span className="ml-1 text-[10px] text-ink400">IDs shown for the 50 most recent</span>
            ) : null}
          </td>
          <td className={TD}>
            <span className={isShown ? 'font-mono text-ink900' : 'font-mono tracking-widest text-ink400'}>
              {isShown ? (phi?.member_id_raw ?? '—') : first.memberIdMasked}
            </span>
          </td>
          <td className={TD}>
            <span className={isShown ? 'font-mono text-ink900' : 'font-mono tracking-widest text-ink400'}>
              {phiText(isShown, phi?.group_number ?? null, PHI_MASK)}
            </span>
          </td>
          <td className={`${TD} min-w-[200px]`}>{first.facilityName ?? '—'}</td>
          <td className={TD}>
            {programs ? (
              <span className="inline-flex items-center rounded-full bg-[#e4f0f5] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-status-info">
                {programs}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </td>
          <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{first.paymentDate ?? '—'}</td>
          <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{first.dos ?? '—'}</td>
          <td className={`${TD} min-w-[116px] text-right`}>
            <span
              className={['q-pctcell', bucketClass(bucket), 'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 tabular-nums font-semibold'].join(' ')}
              title={
                g.confidence === 'estimate'
                  ? CONFIDENCE_LEGEND.captions.estimate
                  : `Mean of this patient's ${g.claimCount} per-claim % allowed values`
              }
            >
              <span className="q-dot inline-block h-2 w-2 rounded-full" />
              {g.avgPct === null ? '—' : g.confidence === 'estimate' ? `~${g.avgPct}% avg` : `${g.avgPct}% avg`}
            </span>
            {g.confidence === 'estimate' ? (
              <span className="block text-[10px] leading-tight text-ink400">estimate · reversals</span>
            ) : null}
            {g.confidence === 'unknown' ? (
              <span className="block text-[10px] leading-tight text-ink400">no allowed on file</span>
            ) : null}
          </td>
          {hasAmounts ? (
            <td className={`${TD} text-right tabular-nums`}>{billedSum === null ? '—' : usd0(billedSum)}</td>
          ) : null}
          {hasAmounts ? (
            <td className={`${TD} text-right tabular-nums`}>{allowedSum === null ? '—' : usd0(allowedSum)}</td>
          ) : null}
        </tr>
        {open ? g.claims.map((c) => renderClaimRow(c, true)) : null}
      </Fragment>
    );
  };
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2.5 pt-4">
        <h2 className="font-display text-base font-semibold">
          Recent Claims
          {facilityLabel ? <span className="ml-2 text-sm font-medium text-muted-foreground">· {facilityLabel}</span> : null}
        </h2>
        <div className="flex items-center gap-3">
          {/* PER-PATIENT reveal is inline (expand a group / the singleton "Reveal" button). The only header
              control is "Hide identifiers" — shown once something IS revealed — plus a discovery hint.
              Under the Change-B GLOBAL toggle the hint states the standing reveal instead. */}
          {globalRevealOn ? (
            <span className="whitespace-nowrap text-[11px] font-medium text-teal700">identifiers revealed (audited)</span>
          ) : canReveal && revealed.size > 0 ? (
            <button
              type="button"
              onClick={onHideIdentifiers}
              title="Re-mask every revealed patient (this session)"
              className="rounded-md border border-teal500 bg-teal50 px-2.5 py-1 text-[11px] font-semibold text-teal700 transition-colors hover:bg-teal200"
            >
              Hide identifiers
            </button>
          ) : canReveal ? (
            <span className="whitespace-nowrap text-[11px] text-muted-foreground">Reveal IDs per patient (audited)</span>
          ) : null}
          <span className="whitespace-nowrap text-xs font-semibold text-muted-foreground">
            {claims.length} recent claims{canReveal ? '' : ' · masked'}
          </span>
        </div>
      </div>
      {filterCaption ? (
        <p className="px-4 pb-1.5 text-[11.5px] font-medium text-teal700">
          Showing claims matching {filterCaption}
        </p>
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
              <th className={TH}>Payment date</th>
              <th className={TH}>DOS</th>
              <th className={`${TH_NUM} min-w-[116px]`}>% allowed</th>
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
                    : filterCaption
                      ? 'No matching claims at this facility for this search.'
                      : 'No claims for this payer in the selected window.'}
                </td>
              </tr>
            ) : (
              // ONE row per patient (multi-claim patients get the expandable group row; single-claim
              // patients render as plain claim rows). Presentation-only over the server's claim page.
              groups.map((g) => renderGroup(g))
            )}
          </tbody>
        </table>
      </div>
      {/* Whole-window honesty: the drill shows every in-window claim (grouped by patient) — no pager. Only
          when a facility exceeds the 500 safety cap do we say so, mirroring the server's `capped` flag. */}
      {capped ? (
        <p className="border-t px-4 py-3 text-center text-[12px] text-muted-foreground">
          Showing the 500 most recent by payment date — narrow the window to see fewer.
        </p>
      ) : null}
    </section>
  );
}
