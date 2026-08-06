'use client';

/**
 * Qualify — the PAYER RAIL: every payer the searched identifier bills under, as a non-blocking
 * drill-down beside the resolved one.
 *
 * WHY A RAIL AND NOT A DISAMBIGUATION STEP. Measured live 2026-08-06 over the whole rollup, weighted
 * by MEMBER (how a real search samples — a rep types the prefix off the card of the patient in front
 * of them, so exposure is proportional to member count, not uniform over prefixes):
 *
 *     1 payer .... 17.8% of searches        top payer holds 73.4% of lines on average
 *     2 payers ... 23.9%                    top payer is a MINORITY in only 15.7%
 *     3-5 payers . 43.3%
 *     >5 payers .. 15.0%                    max observed: 17 payers on one prefix
 *
 * So the default resolve — dominant payer by volume — is RIGHT about 84% of the time. A blocking
 * "which payer did you mean?" step would tax 100% of searches to fix 15.7% of them. That is the
 * wrong trade, and it is why this is a rail the user may ignore rather than a gate they must clear.
 *
 * It is also not a carousel. 67% of searches sit at 2-5 payers, so there is no width problem to
 * solve with scrolling; a scroll affordance over 3 chips is animation pretending to be navigation.
 *
 * WHAT IT IS NOT ALLOWED TO DO: widen the search. Clicking re-runs the SAME identifier scoped to the
 * chosen payer (QualifyInput.payerOverride), so the answer stays "this patient's history under that
 * payer". The server validates the choice against the identifier's own spread and silently falls
 * back to the dominant payer if it does not match — a rejected override never renders as honoured
 * (QualifySnapshot.payerOverridden).
 *
 * AMOUNTS: lines / patients / a date only — never a dollar — so this renders BYTE-IDENTICALLY for an
 * admissions_seat session. Do not add a dollar column here; it would split the two views.
 *
 * PHI: primary_payer is plaintext non-PHI (the same value a QualifyMover carries as its label).
 * Nothing here is patient-identifying. Pure/presentational (no hooks) so it renders hermetically
 * under renderToStaticMarkup.
 */
import type { QualifyPayerOption } from '../../lib/qualify/contract';

/** Below this share of lines the resolved payer is not a safe default to present silently. Set to
 *  1/2 deliberately: "a minority of this identifier's own claims" is the honest, explainable bar,
 *  not a tuned threshold. Measured: fires on 15.7% of member-weighted searches. */
const MINORITY_SHARE = 0.5;

export function PayerRail({
  options,
  activePayer,
  overridden,
  onSelect,
  busy = false,
}: {
  /** Every payer behind the identifier, ranked by volume. EMPTY means "not loaded" — never "one". */
  options: QualifyPayerOption[];
  /** The payer the snapshot actually resolved to (options[0] unless the user drilled down). */
  activePayer: string | null;
  /** True when `activePayer` came from a user click rather than the volume resolve. */
  overridden: boolean;
  onSelect: (payer: string) => void;
  busy?: boolean;
}) {
  // A single payer is not a choice, and an empty array means the spread never loaded. Rendering a
  // one-item "rail" would imply alternatives were checked and none existed, which is a claim this
  // component cannot make in the empty case. Silence is the honest state for both.
  if (options.length <= 1) return null;

  const totalLines = options.reduce((s, o) => s + o.lines, 0);
  const active = options.find((o) => o.payer === activePayer) ?? null;
  const activeShare = active !== null && totalLines > 0 ? active.lines / totalLines : null;
  const activeIsMinority = activeShare !== null && activeShare < MINORITY_SHARE;

  return (
    <section
      className="rounded-2xl border bg-card px-4 py-3 shadow-ths-sm"
      data-testid="payer-rail"
      aria-label="Payers this identifier bills under"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[9.5px] font-bold uppercase tracking-[0.07em] text-ink400">Billed under</span>
        <span className="font-head text-[13px] font-semibold tracking-tight text-ink900">
          {options.length} payers
        </span>
        {/* The honesty line. Two DIFFERENT claims, never conflated: the user chose this scope, or we
            did and it is thin. Both are more informative than showing a payer with no provenance. */}
        {overridden ? (
          <span className="text-[11px] text-muted-foreground">
            showing your selection — <b className="font-semibold text-ink600">{activePayer}</b>
          </span>
        ) : activeIsMinority ? (
          <span className="text-[11px] font-semibold text-status-warn">
            {activePayer} is only {active!.lines.toLocaleString('en-US')} of{' '}
            {totalLines.toLocaleString('en-US')} claim lines — check the others
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            ranked by volume; <b className="font-semibold text-ink600">{activePayer}</b> leads
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const isActive = o.payer === activePayer;
          const share = totalLines > 0 ? Math.round((o.lines / totalLines) * 100) : 0;
          return (
            <button
              key={o.payer}
              type="button"
              disabled={busy || isActive}
              onClick={() => onSelect(o.payer)}
              aria-pressed={isActive}
              // A date, two counts and a share — no dollars, so this string is identical for a
              // blind seat and a sighted session.
              title={
                `${o.payer} — ${o.lines.toLocaleString('en-US')} claim lines (${share}%), ` +
                `${o.patients.toLocaleString('en-US')} patient${o.patients === 1 ? '' : 's'}` +
                (o.lastPayment ? `, last payment ${o.lastPayment}` : ', no payment recorded') +
                (isActive ? ' — currently showing' : ' — click to scope to this payer')
              }
              className={[
                'inline-flex max-w-full items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-left transition',
                isActive
                  ? 'border-teal700 bg-teal900 text-white'
                  : 'border-line bg-surface text-ink600 hover:border-teal200 hover:bg-teal50',
                busy && !isActive ? 'cursor-wait opacity-60' : '',
                isActive ? 'cursor-default' : '',
              ].join(' ')}
            >
              <span className="min-w-0 truncate text-[12px] font-semibold leading-5">{o.payer}</span>
              <span
                className={[
                  'shrink-0 text-[9.5px] font-bold tabular-nums',
                  isActive ? 'text-white/70' : 'text-ink400',
                ].join(' ')}
              >
                {o.lines.toLocaleString('en-US')} lines
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[10.5px] italic text-ink400">
        Each of these is still this client’s own history — picking one narrows the scope, it never widens it
        to the payer’s whole book.
      </p>
    </section>
  );
}
