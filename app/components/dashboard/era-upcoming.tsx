'use client';

/**
 * "Upcoming Payments" — the Overview module over staging.era_835_payment (payment grain,
 * migration 013) PLUS the hand-keyed forecast in staging.expected_payment_override
 * (migration 023). Rendered inside the OverviewKpis toggle panel, next to "All Facilities
 * Table".
 *
 * THE RENAME (Alec, 2026-08-03). This file used to argue that the label must stay
 * "ERA-Confirmed Upcoming Payments", never plain "Upcoming Payments", because a bare title
 * would imply a completeness nobody had measured. That reasoning was right for an ERA-only
 * tile and is now WRONG for the container: the tile also carries operator-asserted forecast
 * rows, so "ERA-Confirmed" would understate what is on screen. The substance of the old
 * ruling is preserved where it actually matters — INSIDE the tile every row still declares
 * its own epistemic class: 835-confirmed remits vs. operator-keyed forecast. The honesty
 * moved from the title to the rows; it was not dropped.
 *
 * TWO CLASSES OF MONEY, NEVER BLENDED (additive-only, Alec 2026-08-03):
 *   • CONFIRMED — a payer adjudicated it onto an 835 with a future effective date.
 *   • FORECAST  — an operator typed it into the "Upcoming Payments" sheet; no 835 exists.
 * The headline total is CONFIRMED ONLY. The forecast total is shown on its own line and is
 * deliberately NOT added in: a forecast row left in the sheet after its 835 lands is
 * double-counted until someone deletes it, so summing the two would silently overstate.
 * ERA reconciliation is separate, later work. Do not "tidy" these into one number.
 *
 * HEADLINE COUNTS ARE SPLIT, deliberately: "N incoming · M zero-dollar", never one blended
 * "N remits". BPR04 = 'NON' remits carry $0.00 by definition, so counting them as payments
 * implies deposits that will never arrive. Both counts come from the single uncapped
 * TOTALS_SQL aggregate — this component does no arithmetic on them and must not start
 * (subtracting, or counting the groups array, would silently understate once the
 * breakdown is capped). NON rows DO stay in the breakdown: they are real ERA activity, and
 * the row-level "No payment" method label already tells the truth there.
 *
 * ⚠️ READ-PATH CONTRACT (013): payment_amount is nullable, sum() skips NULLs, so a remit
 * with an unreadable BPR02 contributes $0 SILENTLY. The payload therefore always carries
 * unquantified_remits over the same window, and this component MUST render the floor
 * banner whenever it is > 0. Do not remove the banner to tidy the card — without it the
 * tile understates while looking authoritative.
 *
 * THE HIERARCHY (Monday/Asana-style parent → subitems). One disclosure per
 * (date × facility): the parent states what lands at that facility on that day, and
 * expanding it shows the per-payer split. Built on native <details>/<summary> rather than a
 * click handler over table rows, which buys three things a custom widget would have to
 * re-implement and get right: keyboard operation (Enter/Space, focus order) for free, a
 * disclosure role assistive tech already announces with its expanded state, and NO client
 * state at all — so the whole tile stays a pure function of its props and the render suite
 * can assert on real subitem markup.
 *
 * Non-PHI throughout (facility code / payer / date / method / amounts / remit counts) —
 * facility_code is a BXR short code or Indigo CMD customer id, never a patient attribute,
 * so there is no reveal gate here. The forecast half never carries a patient name either:
 * its parser drops the sheet's `Client` cell and keeps only the is_patient_specific
 * boolean (migration 023's PHI boundary), which renders as an unnamed "1 patient" marker.
 * EraUpcomingBody is a pure presentational leaf (relative + type-only imports) so the
 * render suite can assert on real markup without pulling server-only modules.
 */
import { count, money } from '../../lib/format';
import type { EraUpcomingSummary } from '../../../src/veris/era835Upcoming.js';
import type { UpcomingOverrideSummary } from '../../../src/veris/upcomingOverride.js';

/** Amber "data caveat" treatment — same family as the explorer's cohort caveats. */
const FLOOR_BANNER_CLASS =
  'rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 ' +
  'dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200';

/**
 * X12 BPR04 payment-method code → billing-desk English. DISPLAY ONLY: the stored value
 * stays the verbatim payer code so it can be reconciled against the raw 835.
 *
 * ⚠️ `NON` is "Non-Payment Data" — a $0 informational remit (full denial, or everything
 * applied to patient responsibility). It is NOT a check; `CHK` is. On the first live BXR
 * window all 32 NON remits were exactly $0.00 while all 7 CHK remits were positive, so
 * labelling NON as "Check" would both promise money that was never paid and collide with
 * the real checks. Do not "simplify" these two into one label.
 *
 * `ACH` displays as "EFT" because that is what the billing team calls it; it is the same
 * code, not a different one.
 *
 * Codes we have not confirmed semantics for (e.g. BOP, "Financial Institution Option")
 * are deliberately ABSENT: an unmapped code renders as its raw self, which is loud, over
 * a guessed label, which is silently wrong.
 *
 * NOTE the forecast half does NOT come through here. Its method_label is already the
 * sheet's own closed vocabulary ('EFT' | 'Check'), not a BPR04 code — migration 023 keeps
 * the two vocabularies apart so a hand-keyed forecast can never be mistaken for a real
 * remit in a naive query, and mapping one onto the other at this edge would undo that.
 */
const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  ACH: 'EFT',
  CHK: 'Check',
  FWT: 'Wire',
  NON: 'No payment',
};

/** BPR04 → display label. Null/blank → em dash; unknown code → the code itself. */
export function paymentMethodLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code.trim() === '') return '—';
  const key = code.trim().toUpperCase();
  return PAYMENT_METHOD_LABELS[key] ?? key;
}

// ---------------------------------------------------------------------------
// Money arithmetic — EXACT INTEGER CENTS, never float.
//
// This component sums per-facility subtotals that the server sends as Postgres numeric
// TEXT. Adding those with `+` after Number() drifts (0.1 + 0.2), and these are deposit
// figures an operator reconciles against a bank statement. Same discipline as
// era835Upcoming.centsFromNumericText and the override sheet parser, restated locally
// because this leaf may not import server-only modules.
// ---------------------------------------------------------------------------

/** Exact cents from Postgres numeric text, or null when unreadable/absent. */
export function centsFromText(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const m = v.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole * 100 + frac)) return null;
  return (m[1] === '-' ? -1 : 1) * (whole * 100 + frac);
}

/** Integer cents → fixed-2 text, the shape `money()` formats without precision loss. */
export function fixed2FromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The hierarchy model
// ---------------------------------------------------------------------------

/** One leaf under a (date × facility) parent — a single payer's confirmed remit or forecast. */
export interface UpcomingItem {
  /** 'confirmed' = on an 835. 'forecast' = operator-keyed, no 835 exists. Never merged. */
  kind: 'confirmed' | 'forecast';
  payer: string | null;
  /** Already display-ready: BPR04 translated for confirmed, verbatim sheet label for forecast. */
  methodLabel: string;
  /** Raw BPR04, for the reconcile-against-the-835 tooltip. Absent on forecast rows. */
  rawMethod?: string | null;
  /** Remit count — confirmed only; a forecast row is one operator assertion, not a remit. */
  remits?: number;
  /** Fixed-point numeric text, or null when every remit in the group was unquantified. */
  amount: string | null;
  /** Confirmed rows only: remits in this leaf whose BPR02 was unreadable. */
  unquantified?: number;
  /** Forecast rows only: the sheet named one patient rather than a batch. NAME NOT STORED. */
  isPatientSpecific?: boolean;
}

/** A (date × facility) parent: what lands at one facility on one day. */
export interface UpcomingGroup {
  key: string;
  date: string;
  facilityCode: string;
  /** Confirmed subtotal in cents; null when the group has no readable confirmed amount. */
  confirmedCents: number | null;
  /** Confirmed remit count across the group's leaves. */
  remits: number;
  /** Confirmed remits in the group with an unreadable BPR02. */
  unquantified: number;
  /** Forecast subtotal in cents. 0 when the group has no forecast rows. */
  forecastCents: number;
  items: UpcomingItem[];
}

/**
 * Fold the two server payloads into one (date × facility) hierarchy.
 *
 * Pure and total: an absent/failed override payload is simply no forecast leaves, so the
 * confirmed half renders unchanged. That is the load-bearing degradation path — migration
 * 023 may not be applied yet, in which case loadUpcomingOverrides returns ok:false forever
 * and this tile must still be the ERA tile rather than an error.
 *
 * Confirmed subtotals stay NULL rather than 0 when every leaf in the group is unquantified:
 * "$0.00" would be a fabricated zero for money we cannot read. Forecast subtotals have no
 * such case — migration 023 CHECKs amount > 0, so a forecast leaf always has a real number.
 */
export function buildUpcomingGroups(
  era: EraUpcomingSummary,
  overrides: UpcomingOverrideSummary | null,
): UpcomingGroup[] {
  const byKey = new Map<string, UpcomingGroup>();
  const get = (date: string, facilityCode: string): UpcomingGroup => {
    const key = `${date}|${facilityCode}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        date,
        facilityCode,
        confirmedCents: null,
        remits: 0,
        unquantified: 0,
        forecastCents: 0,
        items: [],
      };
      byKey.set(key, g);
    }
    return g;
  };

  for (const eg of era.groups) {
    const g = get(eg.payment_date, eg.facility_code);
    const cents = centsFromText(eg.amount);
    if (cents !== null) g.confirmedCents = (g.confirmedCents ?? 0) + cents;
    g.remits += eg.remits;
    g.unquantified += eg.unquantified_remits;
    g.items.push({
      kind: 'confirmed',
      payer: eg.payer_name,
      methodLabel: paymentMethodLabel(eg.payment_method),
      rawMethod: eg.payment_method,
      remits: eg.remits,
      amount: eg.amount,
      unquantified: eg.unquantified_remits,
    });
  }

  for (const or of overrides?.rows ?? []) {
    const g = get(or.expected_date, or.facility_code);
    g.forecastCents += centsFromText(or.amount) ?? 0;
    g.items.push({
      kind: 'forecast',
      payer: or.payer_label,
      methodLabel: or.method_label,
      amount: or.amount,
      isPatientSpecific: or.is_patient_specific,
    });
  }

  const groups = [...byKey.values()];
  groups.sort((a, b) => a.date.localeCompare(b.date) || a.facilityCode.localeCompare(b.facilityCode));
  // Confirmed money first inside a parent, then forecast, each by descending amount — the
  // operator reads "what is certain here" before "what someone expects here".
  for (const g of groups) {
    g.items.sort((x, y) => {
      if (x.kind !== y.kind) return x.kind === 'confirmed' ? -1 : 1;
      return (centsFromText(y.amount) ?? 0) - (centsFromText(x.amount) ?? 0);
    });
  }
  return groups;
}

/** Small pill marking a leaf's epistemic class. Text-labelled, never color-only. */
function KindTag({ kind }: { kind: UpcomingItem['kind'] }) {
  return kind === 'forecast' ? (
    <span className="ths-tag ths-tag-accent-2">Forecast</span>
  ) : (
    <span className="ths-tag ths-tag-accent">Confirmed</span>
  );
}

/** Pure body: given the payloads, render empty / hierarchy (+ floor banner) states. */
export function EraUpcomingBody({
  data,
  overrides = null,
}: {
  data: EraUpcomingSummary;
  /**
   * Hand-keyed forecast payload, or null when unavailable. Null is a NORMAL state, not an
   * error: migration 023 may be unapplied, or the sheet sync may have failed soft. The tile
   * renders the confirmed half either way and says nothing about the missing forecast,
   * because a reader cannot act on it and a scary banner would misrepresent a feed that is
   * working exactly as designed.
   */
  overrides?: UpcomingOverrideSummary | null;
}) {
  const forecastCents = centsFromText(overrides?.total ?? null) ?? 0;
  const forecastRows = overrides?.rows.length ?? 0;

  if (data.remits === 0 && forecastRows === 0) {
    // Calm empty state — the table is expected to be empty until the ERA ingest cron
    // runs. This is "nothing scheduled", not an error and not a zero-dollar datum.
    return (
      <div className="py-2">
        <p className="text-sm text-foreground">No upcoming payments scheduled.</p>
        <p className="ths-card-meta mt-1">
          Shows finalized 835 remittances with an effective payment date of today or later,
          plus any forecast rows keyed into the Upcoming Payments sheet. Entries appear once
          ERA ingest is running and payers adjudicate upcoming deposits.
        </p>
      </div>
    );
  }

  const groups = buildUpcomingGroups(data, overrides);
  // From the ERA groups, NOT from `groups`: the headline line it sits on is labelled
  // "ERA-confirmed", and `groups` now also contains forecast-only parents. Taking the first
  // merged parent would print a forecast date under a confirmed heading whenever a forecast
  // row lands before the earliest real remit.
  const earliest = data.groups[0]?.payment_date;
  // When EVERY upcoming remit is unquantified, the quantified sum is 0.00 — but showing
  // "$0.00" would be a fabricated zero for money we simply cannot read. Render the
  // unknown as unknown; the floor banner below carries the explanation.
  const allUnquantified = data.remits > 0 && data.unquantified_remits >= data.remits;

  return (
    <div className="space-y-3">
      <div>
        <div className="ths-num whitespace-nowrap text-2xl font-semibold leading-tight tabular-nums text-[var(--brand-ink)]">
          {data.remits === 0 ? '—' : allUnquantified ? '—' : money(data.total)}
        </div>
        <div className="ths-card-meta mt-0.5">
          ERA-confirmed · {count(data.incoming_remits)} incoming
          {/* Suppressed at zero on purpose: with no non-payments in the window, a bare
              "N incoming" is the honest read and a "· 0 zero-dollar" clause is noise. */}
          {data.zero_dollar_remits > 0 ? ` · ${count(data.zero_dollar_remits)} zero-dollar` : ''}
          {earliest ? ` · earliest ${earliest}` : ''}
        </div>
        {/* THE SEPARATE FORECAST LINE. Not added into the figure above — see the
            additive-only note in this file's header. */}
        {forecastRows > 0 && (
          <div className="ths-card-meta mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="ths-tag ths-tag-accent-2">Forecast</span>
            <span className="ths-num tabular-nums">{money(fixed2FromCents(forecastCents))}</span>
            <span>
              across {count(forecastRows)} operator-keyed {forecastRows === 1 ? 'row' : 'rows'} — not
              included in the total above
            </span>
          </div>
        )}
      </div>

      {data.unquantified_remits > 0 && (
        <p className={FLOOR_BANNER_CLASS}>
          {count(data.unquantified_remits)}{' '}
          {data.unquantified_remits === 1 ? 'remit carries' : 'remits carry'} an unreadable
          amount and {data.unquantified_remits === 1 ? 'is' : 'are'} not included — the total
          shown is a floor, not the full sum.
        </p>
      )}

      {/* Column headings for the parent rows. aria-hidden: this is a visual key for the
          grid below, and every <summary> already names its own values in its accessible
          text, so exposing it to a screen reader would just read a stray row of nouns. */}
      <div className="ths-item-head" aria-hidden>
        <span />
        <span>Date</span>
        <span>Facility</span>
        <span>Payers</span>
        <span className="text-right">Amount</span>
      </div>

      <div className="ths-item-list">
        {groups.map((g) => (
          <UpcomingGroupRow key={g.key} group={g} />
        ))}
      </div>

      {/* Truncation is named PER SOURCE. The two halves cap independently and at different
          numbers, so one blended "breakdown capped" sentence would attribute the cut to the
          wrong feed. The ERA cap is stated as its literal 50 (as it always was); the forecast
          cap is stated without a number because importing the server's ROW_CAP here would
          pull pg + withTenant into this pure leaf and break the render suite. */}
      {(data.groups_truncated || overrides?.rows_truncated) && (
        <p className="ths-card-meta">
          {data.groups_truncated && 'ERA breakdown capped at the first 50 date/payer groups. '}
          {overrides?.rows_truncated && 'Forecast list capped — more rows exist in the sheet. '}
          The headline total and remit count include everything.
        </p>
      )}
    </div>
  );
}

/**
 * One parent row + its subitems, as a native disclosure.
 *
 * The <summary> carries the whole accessible name of the group (date, facility, payer
 * count, amount) because that is what a screen reader announces when it lands on the
 * disclosure — so a user who never expands it still hears the complete parent fact.
 */
function UpcomingGroupRow({ group: g }: { group: UpcomingGroup }) {
  const payers = g.items.length;
  const hasForecast = g.forecastCents > 0;
  return (
    <details className="ths-item">
      <summary className="ths-item-summary">
        <span className="ths-item-chevron" aria-hidden>
          ▸
        </span>
        <span className="ths-num whitespace-nowrap tabular-nums">{g.date}</span>
        <span className="font-medium">{g.facilityCode}</span>
        <span className="ths-card-meta">
          {count(payers)} {payers === 1 ? 'payer' : 'payers'}
          {hasForecast && (
            <>
              {' '}
              <span className="ths-tag ths-tag-accent-2">
                +{money(fixed2FromCents(g.forecastCents))} forecast
              </span>
            </>
          )}
        </span>
        <span className="ths-num whitespace-nowrap text-right tabular-nums">
          {g.confirmedCents === null ? '—' : money(fixed2FromCents(g.confirmedCents))}
          {g.unquantified > 0 && (
            <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
              +{count(g.unquantified)} unq.
            </span>
          )}
        </span>
      </summary>

      <div className="ths-scroll-x">
        <table className="ths-table ths-item-table">
          <thead>
            <tr>
              <th>Payer</th>
              <th>Class</th>
              <th>Method</th>
              <th className="num">Remits</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {g.items.map((it, i) => (
              <tr key={`${it.kind}-${it.payer ?? ''}-${it.methodLabel}-${i}`}>
                <td>
                  {it.payer ?? <span className="ths-text-muted">(unnamed payer)</span>}
                  {/* The forecast half stores NO patient name (023's PHI boundary) — only
                      that the sheet row was for one patient rather than a batch. */}
                  {it.isPatientSpecific && (
                    <span className="ths-card-meta"> · 1 patient</span>
                  )}
                </td>
                <td>
                  <KindTag kind={it.kind} />
                </td>
                {/* title keeps the raw BPR04 available for anyone reconciling against the 835. */}
                <td className="ths-text-muted" title={it.rawMethod ?? undefined}>
                  {it.methodLabel}
                </td>
                <td className="num">{it.remits === undefined ? '—' : count(it.remits)}</td>
                <td className="num">
                  {money(it.amount)}
                  {it.unquantified !== undefined && it.unquantified > 0 && (
                    <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
                      +{count(it.unquantified)} unq.
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
