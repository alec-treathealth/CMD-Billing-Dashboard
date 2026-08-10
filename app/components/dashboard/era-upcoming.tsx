'use client';

/**
 * "Future <tenant> Payments" — the Overview module over staging.era_835_payment (payment grain,
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
 * EVERY EDIT CONTROL REPORTS ITS OUTCOME (2026-08-07). The leaf still only EMITS intents and
 * still holds no client state; what changed is that the host no longer discards what the Server
 * Action returned. `ForecastEditBanner` below is the pure surface for that outcome, and the
 * English lives in app/lib/forecast/edit-feedback.ts. This is not polish: failure and success
 * used to be pixel-identical (a busy flag, a refetch, an unchanged tile), which is how a
 * guaranteed no-op — a bigint id reaching the delete guard as the string "15" — sat unnoticed
 * across every "Remove edit", "Remove row" and "Undo correction" button on this tile.
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
import type {
  ForecastEditIntent,
  ForecastEditOutcome,
} from '../../lib/forecast/edit-feedback';
import type { EraUpcomingSummary } from '../../../src/veris/era835Upcoming.js';
import type {
  UpcomingOverrideRow,
  UpcomingOverrideSummary,
} from '../../../src/veris/upcomingOverride.js';
import {
  resolveForecast,
  suggestLandedMatches,
  type HiddenForecastRow,
  type MatchedForecastRow,
  type LandedSuggestion,
  type ManualForecastRow,
  type ResolvedForecastRow,
  type StaleManualRow,
} from '../../../src/veris/upcomingForecast';

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
  /** Forecast rows only: 'sheet' fed it, or a super admin authored it (024). */
  origin?: 'sheet' | 'manual';
  /** Forecast rows only: a super-admin 'correct' changed this row's amount or method. */
  corrected?: boolean;
  /** Forecast rows only: the 024 row id behind a manual add or the applied correction. */
  manualId?: number;
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
  // Structurally minimal on purpose: callers pass the UPCOMING resolved rows only — the
  // Overdue partition renders in its own section and must never interleave here.
  overrides: { rows: UpcomingOverrideRow[] } | null,
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
    // `origin`/`corrected`/`manualId` are present when the caller passed RESOLVED rows (the
    // live path) and absent when it passed raw sheet rows (the pre-024 shape the render suite
    // still exercises). Optional rather than required so both callers stay valid.
    const r = or as Partial<ResolvedForecastRow> & typeof or;
    g.items.push({
      kind: 'forecast',
      payer: or.payer_label,
      methodLabel: or.method_label,
      amount: or.amount,
      isPatientSpecific: or.is_patient_specific,
      origin: r.origin ?? 'sheet',
      corrected: r.corrected ?? false,
      manualId: r.manualId,
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

/**
 * What the tile asks the host to do. The leaf EMITS intents and never calls a Server Action
 * itself — that keeps it a pure function of its props (so the render suite can drive every
 * control) and keeps the super-admin gate on the server side of one boundary instead of two.
 *
 * The type itself now lives in app/lib/forecast/edit-feedback.ts, beside the outcome policy that
 * turns each intent into the English an operator reads when it fails. Re-exported here so every
 * existing import site is unchanged. Type-only, so this leaf stays free of runtime lib imports.
 */
export type { ForecastEditIntent };

/**
 * The edit-feedback surface. PURE — the host owns the async state and passes the outcome down,
 * so the render suite can assert every tone without a DOM harness or a server module.
 *
 * TWO ALWAYS-MOUNTED REGIONS, never one region with a swapped role. A live region announces
 * reliably only when it is already in the DOM before its text changes; mounting it with content
 * already inside is silent on most screen readers. Failures are assertive (money did not move);
 * success and in-flight are polite. Meaning is carried by the text tag, never by the colour.
 */
export function ForecastEditBanner({ outcome }: { outcome: ForecastEditOutcome | null }) {
  const err = outcome?.tone === 'error' ? outcome : null;
  const soft = outcome && outcome.tone !== 'error' ? outcome : null;
  return (
    <>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {err && (
          <p className="ths-alert mb-2 flex flex-wrap items-center gap-2">
            <span className="ths-tag ths-tag-danger">Not saved</span>
            <span>{err.text}</span>
          </p>
        )}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {soft && (
          <p className="ths-card-meta mb-2 flex flex-wrap items-center gap-2">
            <span className={soft.tone === 'ok' ? 'ths-tag ths-tag-ok' : 'ths-tag ths-tag-neutral'}>
              {soft.tone === 'ok' ? 'Saved' : soft.tone === 'info' ? 'No change' : 'Saving…'}
            </span>
            <span>{soft.text}</span>
          </p>
        )}
      </div>
    </>
  );
}

/** One selectable facility for the add form: canonical code + something a human recognises. */
export interface ForecastFacilityOption {
  code: string;
  label: string;
}

/** The amount shape 024 accepts: up to 10 digits, at most 2 decimals, positive. */
const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * Small pill marking a leaf's epistemic class. Text-labelled, never color-only.
 *
 * "ERA Confirmed" and "Forecasted", not "Confirmed" and "Forecast" (Alec, 2026-08-10). Bare
 * "Confirmed" does not say WHO confirmed it, and on a tile that also carries operator-keyed
 * money that is the one thing the pill exists to disambiguate — a reader could reasonably take
 * it to mean a human confirmed the row. Naming the 835 makes the source unmistakable, and
 * "Forecasted" reads as a state the row is in rather than a noun that could be a section name.
 */
function KindTag({ kind }: { kind: UpcomingItem['kind'] }) {
  return kind === 'forecast' ? (
    <span className="ths-tag ths-tag-accent-2">Forecasted</span>
  ) : (
    <span className="ths-tag ths-tag-accent">ERA Confirmed</span>
  );
}

/** Pure body: given the payloads, render empty / hierarchy (+ floor banner) states. */
export function EraUpcomingBody({
  data,
  overrides = null,
  manual = [],
  canEdit = false,
  onEdit,
  busy = false,
  facilityOptions = [],
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
  /** Super-admin edits (024). Folded over the sheet feed before anything renders. */
  manual?: ManualForecastRow[];
  /** True only for super_admin. Controls are not rendered at all otherwise — and the server
   *  re-checks the role on every write, so hiding them is convenience, not the gate. */
  canEdit?: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
  /** A write is in flight; controls disable so a double-click cannot fire twice. */
  busy?: boolean;
  /**
   * Facilities the ACTIVE TENANT owns — the only valid targets for a manual add. Empty means
   * "no single tenant in scope" (the Consolidated view), and the form is replaced by an
   * explanation rather than shown and then rejected server-side.
   */
  facilityOptions?: ForecastFacilityOption[];
}) {
  // RESOLUTION FIRST, THEN PARTITION (Alec, 2026-08-03). Everything below renders the
  // forecast AFTER super-admin corrections and suppressions are applied, so a corrected
  // amount and a hidden landed row are the truth the whole tile agrees on. Resolution runs
  // over the UNION of both partitions — a suppress/correct must hit its row wherever it
  // sits — and only THEN are rows bucketed. Why post-resolution bucketing: a 024 'correct'
  // cannot move expected_date (the date is the match key), but a manual 'add' is born with
  // its own date and enters HERE, after the SQL partition — a past-dated add must land in
  // Overdue, not wherever the SQL happened to put sheet rows.
  const resolved = resolveForecast(
    [...(overrides?.upcoming.rows ?? []), ...(overrides?.overdue.rows ?? [])],
    manual,
  );
  // THE ONE CLOCK VALUE — the same businessTodayIso() string the SQL partition used, carried
  // in the payload. A date-valued prop; this component never calls for "today" (a browser
  // clock would be a second clock in the wrong timezone). Null only when the whole override
  // payload is absent (023 dark / sync failed soft), where every resolved row is a manual
  // add with no boundary to bucket against — treated as upcoming, the pre-partition shape.
  const cutoff = overrides?.cutoff ?? null;
  /**
   * ⚠️ A MANUAL ADD IS NEVER OVERDUE, WHATEVER ITS DATE (Alec, 2026-08-10).
   *
   * The partition used to be date-only, and it broke the feature's primary use case. The
   * reason a super admin keys a payment by hand is that a check ARRIVED and CollaborateMD has
   * not logged it yet — so the date they type is today or earlier, essentially always. A
   * date-only rule therefore routed every such row into the Overdue strip, which says:
   *
   *     "past their date without landing — not in any total above"
   *
   * Every clause of that is wrong for a check sitting on someone's desk, and the row was also
   * excluded from the Forecast subtotal, so hand-keyed money silently stopped counting.
   * Measured live 2026-08-10: an add dated 2026-08-12 landed in the table and behaved fine; the
   * same form with 2026-08-07 vanished into Overdue. That is what "adding doesn't work" was.
   *
   * A SHEET row past its date still IS overdue, and deliberately stays so — nobody is watching
   * the sheet feed row by row, so that escalation signal is the whole point of the strip
   * (Alec's 2026-08-03 ruling). The asymmetry is the decision: `origin` distinguishes money a
   * human just asserted from a forecast that may have quietly failed.
   *
   * THE COST, accepted and worth knowing: a manual add that genuinely never arrives no longer
   * escalates into Overdue. It stays in the table at its own date, where the operator who
   * typed it can see and remove it. If that turns out to matter, the fix is a per-row
   * "date has passed" marker in the table — NOT sending these back to Overdue.
   */
  const isOverdue = (r: ResolvedForecastRow): boolean =>
    cutoff !== null && r.expected_date < cutoff && r.origin !== 'manual';
  const upcomingResolved = cutoff ? resolved.rows.filter((r) => !isOverdue(r)) : resolved.rows;
  const overdueResolved = cutoff ? resolved.rows.filter(isOverdue) : [];
  // ⚠️ TOTALS PROVENANCE (Alec's constraint): BOTH rendered subtotals are recomputed from
  // the RESOLVED rows of their partition. The SQL aggregates riding in the payload
  // (overrides.upcoming.total / overrides.overdue.total) are pre-resolution and are NOT
  // rendered — the overdue subtotal is not the SQL number just because it is in the payload.
  //
  // An unparseable amount is NEITHER a crash NOR a silent zero: it is COUNTED, and any
  // count > 0 marks that subtotal as a floor in the UI — the ERA half's proven idiom for
  // "a sum shown without its unreadable count is a floor presented as a total". 023's
  // CHECK makes this near-impossible for sheet rows, which is exactly why a silent zero
  // would never be noticed if it ever happened.
  const sumCents = (rows: { amount: string }[]): { cents: number; unparseable: number } => {
    let cents = 0;
    let unparseable = 0;
    for (const r of rows) {
      const c = centsFromText(r.amount);
      if (c === null) unparseable += 1;
      else cents += c;
    }
    return { cents, unparseable };
  };
  const upcomingSum = sumCents(upcomingResolved);
  const overdueSum = sumCents(overdueResolved);
  const forecastCents = upcomingSum.cents;
  const overdueCents = overdueSum.cents;
  const forecastRows = upcomingResolved.length;
  // The upcoming forecast feed for the merged group list — UPCOMING partition only; the
  // Overdue section renders separately and never interleaves with future money.
  const forecastForGroups =
    overrides || manual.length > 0
      ? {
          rows: upcomingResolved,
          rows_truncated: overrides?.upcoming.rows_truncated ?? false,
        }
      : null;
  // Suggestions run against the SAME ERA groups the tile already has — no extra read. The
  // input is the resolved UNION, so a recently-overdue row whose 835 lands inside the
  // 7-day window can now receive a landed-suggestion too. (The deep suggester gap — the
  // candidate pool is bounded by the display window — is filed in veris-data-notes, not
  // fixed here.)
  const suggestions = canEdit ? suggestLandedMatches(resolved.rows, data.groups) : [];

  if (data.remits === 0 && forecastRows === 0 && overdueResolved.length === 0) {
    // Calm empty state — the table is expected to be empty until the ERA ingest cron
    // runs. This is "nothing scheduled", not an error and not a zero-dollar datum.
    return (
      <div className="py-2">
        <p className="text-sm text-foreground">No future payments scheduled.</p>
        <p className="ths-card-meta mt-1">
          Shows finalized 835 remittances with an effective payment date after today,
          plus any forecast rows keyed into the Upcoming Payments sheet. Entries appear once
          ERA ingest is running and payers adjudicate upcoming deposits.
        </p>
        {/* ⚠️ THE STATE THAT MOST NEEDS AN UNDO. Hiding the last row lands the tile HERE, on
            the calm "nothing scheduled" copy. Without this strip the operator has just made
            money disappear and the screen offers nothing to click — which is precisely the
            one-way door HiddenStrip exists to close. The no-dollars calm contract survives:
            it is a collapsed disclosure with no total. */}
        {canEdit && resolved.hidden.length > 0 && (
          <div className="mt-3">
            <HiddenStrip hidden={resolved.hidden} busy={busy} onEdit={onEdit} />
          </div>
        )}
        {/* An all-empty tile is a state a reconciliation can CAUSE — matching the last
            outstanding row empties it — so the undo has to be reachable from here. */}
        {canEdit && resolved.matched.length > 0 && (
          <div className="mt-3">
            <MatchedStrip matched={resolved.matched} busy={busy} onEdit={onEdit} />
          </div>
        )}
        {/* The form used to be repeated here so an empty tile still offered a way in. It now
            lives in the always-visible "Add expected payment" button at the top of the
            Overview tab, which is strictly MORE reachable from this state than an in-tile
            form was — the operator no longer has to open a collapsed panel to find it. */}
      </div>
    );
  }

  // THE THIRD POPULATION (approved wording, Alec 2026-08-03): nothing upcoming on either
  // half, but overdue money exists. "No future payments scheduled" alone would be a lie of
  // omission — an all-overdue book is the state that most needs attention.
  if (data.remits === 0 && forecastRows === 0 && overdueResolved.length > 0 && cutoff) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-foreground">
          No future payments scheduled — {count(overdueResolved.length)} overdue expected{' '}
          {overdueResolved.length === 1 ? 'payment' : 'payments'} below.
        </p>
        {/* ⚠️ THE CALL SITE THAT GETS MISSED. This branch fires only when data.remits === 0 AND
            forecastRows === 0, i.e. when the ENTIRE tile is overdue — precisely the state the
            controls exist for, and a state no populated-tile fixture can ever reach. Any prop
            added to OverdueStrip must be threaded here as well as at the main-return call site. */}
        <OverdueStrip
          rows={overdueResolved}
          totalCents={overdueCents}
          cutoff={cutoff}
          truncated={overrides?.overdue.rows_truncated ?? false}
          unparseable={overdueSum.unparseable}
          canEdit={canEdit}
          busy={busy}
          onEdit={onEdit}
        />
        {/* Stale 024 edits render here too (Alec, 2026-08-03): an all-overdue book is
            precisely when an operator is reconciling by hand and needs to see an edit
            that is silently doing nothing. (The all-empty state above stays without it:
            its no-dollars calm contract is test-pinned, and with zero rows anywhere the
            edits resurface the moment any population returns.) */}
        {resolved.stale.length > 0 && (
          <StaleEditStrip stale={resolved.stale} canEdit={canEdit} busy={busy} onEdit={onEdit} />
        )}
        {canEdit && resolved.hidden.length > 0 && (
          <HiddenStrip hidden={resolved.hidden} busy={busy} onEdit={onEdit} />
        )}
        {canEdit && resolved.matched.length > 0 && (
          <MatchedStrip matched={resolved.matched} busy={busy} onEdit={onEdit} />
        )}
        {/* Add form moved to the top-of-Overview button — see the note in the main return. */}
      </div>
    );
  }

  const groups = buildUpcomingGroups(data, forecastForGroups);
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
            <span className="ths-tag ths-tag-accent-2">Forecasted</span>
            <span className="ths-num tabular-nums">{money(fixed2FromCents(forecastCents))}</span>
            <span>
              across {count(forecastRows)} operator-keyed {forecastRows === 1 ? 'row' : 'rows'} — not
              included in the total above
              {upcomingSum.unparseable > 0
                ? ` · ${count(upcomingSum.unparseable)} unreadable, subtotal is a floor`
                : ''}
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

      {suggestions.length > 0 && (
        <SuggestionStrip suggestions={suggestions} busy={busy} onEdit={onEdit} />
      )}

      {resolved.stale.length > 0 && (
        <StaleEditStrip stale={resolved.stale} canEdit={canEdit} busy={busy} onEdit={onEdit} />
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
          <UpcomingGroupRow key={g.key} group={g} canEdit={canEdit} busy={busy} onEdit={onEdit} />
        ))}
      </div>

      {/* OVERDUE — its own section, after the upcoming list. Never interleaved above, never
          in the Forecast line, never in the ERA headline. */}
      {overdueResolved.length > 0 && cutoff && (
        <OverdueStrip
          rows={overdueResolved}
          totalCents={overdueCents}
          cutoff={cutoff}
          truncated={overrides?.overdue.rows_truncated ?? false}
          unparseable={overdueSum.unparseable}
          canEdit={canEdit}
          busy={busy}
          onEdit={onEdit}
        />
      )}

      {/* After the overdue section, before the add form: the reading order is what IS coming,
          what is LATE, then what you took off — and only then the form to add more. */}
      {canEdit && resolved.hidden.length > 0 && (
        <HiddenStrip hidden={resolved.hidden} busy={busy} onEdit={onEdit} />
      )}

      {canEdit && resolved.matched.length > 0 && (
        <MatchedStrip matched={resolved.matched} busy={busy} onEdit={onEdit} />
      )}

      {/* THE ADD FORM IS NO LONGER HERE. It moved out of this table-bottom position into a
          standalone "Add expected payment" button at the top of the Overview tab
          (AddForecastPanel in overview-kpis.tsx), because a create control buried under a
          list is only discoverable to someone who already knew it existed — and this tile is
          collapsed by default, so it was two clicks and a scroll from the page. The form
          component itself is unchanged and is now exported for that call site. */}

      {/* Truncation is named PER SOURCE. The two halves cap independently and at different
          numbers, so one blended "breakdown capped" sentence would attribute the cut to the
          wrong feed. The ERA cap is stated as its literal 50 (as it always was); the forecast
          cap is stated without a number because importing the server's ROW_CAP here would
          pull pg + withTenant into this pure leaf and break the render suite. */}
      {(data.groups_truncated || forecastForGroups?.rows_truncated) && (
        <p className="ths-card-meta">
          {data.groups_truncated && 'ERA breakdown capped at the first 50 date/payer groups. '}
          {forecastForGroups?.rows_truncated &&
            'Forecast list capped — more rows exist in the sheet. '}
          The headline total and remit count include everything.
        </p>
      )}
    </div>
  );
}

/**
 * "Looks landed — confirm?" Suggested matches between a forecast row and an 835 that has since
 * arrived. NOTHING IS HIDDEN BY THIS STRIP. Confirming writes a 'landed' suppression stamped
 * with the 835 key the human agreed to; declining is simply not clicking, because a decline
 * would need its own stored state and the suggestion is cheap to re-read next time.
 *
 * Confidence is stated in words, not implied by color: 'high' means the amount matched to the
 * cent AND the payer names corresponded; 'medium' means one of the two. The payer heuristic
 * genuinely cannot see some same-payer pairs ('BCBS' vs 'BLUE CROSS OF CALIFORNIA (CA)'),
 * which is exactly why a human confirms.
 */
function SuggestionStrip({
  suggestions,
  busy,
  onEdit,
}: {
  suggestions: LandedSuggestion[];
  busy: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
  return (
    <div className="ths-notice flex-col items-stretch">
      <div className="ths-card-title mb-1">
        {count(suggestions.length)} forecast {suggestions.length === 1 ? 'row' : 'rows'} may have
        already landed
      </div>
      <ul className="flex flex-col gap-1.5">
        {/* One suggestion per forecast row, and two forecast rows can share the (date, facility,
            payer) tuple — same latent collision the overdue list had. Keyed the same way. */}
        {suggestions.map((sg, i) => (
          <li key={forecastRowKey(sg.forecast, i)} className="flex flex-wrap items-center gap-2">
            <span className="ths-tag ths-tag-accent-2">Forecasted</span>
            <span className="ths-num tabular-nums">{money(sg.forecast.amount)}</span>
            <span>
              {sg.forecast.facility_code} · {sg.forecast.payer_label} · {sg.forecast.expected_date}
            </span>
            <span aria-hidden>→</span>
            <span className="ths-tag ths-tag-accent">835 {sg.era.payment_date}</span>
            <span>
              {sg.era.payer_name ?? '(unnamed payer)'} · {money(sg.era.amount)} ·{' '}
              {sg.confidence === 'high' ? 'amount and payer match' : 'partial match'}
              {sg.dayGap !== 0 ? ` · ${Math.abs(sg.dayGap)}d ${sg.dayGap > 0 ? 'later' : 'earlier'}` : ''}
            </span>
            {/* ONE BUTTON, TWO WRITES, chosen by where the row came from.
                · MANUAL ADD  → reconcile IN PLACE (033 status='matched' + matched_era_key).
                  The row is ours to address, so saying "this landed" is a column on it.
                · SHEET ROW   → write a 'suppress' beside it, as before. The sheet is a feed
                  nothing here can edit, so a decision alongside it is the only way to speak.
                Before 033 both took the suppress path, which meant confirming a manual add
                left TWO rows describing one payment — the pair now sitting in the live BXR
                book (ids 8 and 18). The operator sees no difference; the data does. */}
            <button
              type="button"
              className="ths-btn ths-btn-primary ths-btn-sm"
              disabled={busy}
              onClick={() =>
                onEdit?.(
                  sg.forecast.origin === 'manual' && sg.forecast.manualId !== undefined
                    ? {
                        op: 'match',
                        id: sg.forecast.manualId,
                        status: 'matched',
                        matchedEraKey: sg.eraKey,
                        label: `${sg.forecast.facility_code} · ${sg.forecast.payer_label} · ${sg.forecast.expected_date}`,
                      }
                    : {
                        op: 'suppress',
                        facilityCode: sg.forecast.facility_code,
                        payerLabel: sg.forecast.payer_label,
                        expectedDate: sg.forecast.expected_date,
                        reason: 'landed',
                        matchedEraKey: sg.eraKey,
                      },
                )
              }
            >
              Confirm landed
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A stable React list key for a resolved forecast row.
 *
 * (date, facility, payer) is NOT unique — 023 has no unique index and its header is explicit
 * that two identical forecasts are legal — so the tuple alone collided on real data long before
 * the duplicate-add defect existed, and will keep colliding after it is fixed. `manualId` is no
 * fix either: one 'correct' applies to every sheet row sharing its key, so two rendered rows can
 * carry the same manualId. Amount, method and the 024 id join the tuple, with the index as the
 * last resort for rows that are genuinely indistinguishable.
 *
 * INDEX LAST, AND CONTENT IN THE KEY, on purpose: these rows now carry an UNCONTROLLED amount
 * input (defaultValue is read once at mount), so a key that survives an amount change would keep
 * a stale dollar figure in the box, and a key that collides would let React carry one row's typed
 * value onto another row's money. Remounting is the safe failure here.
 */
export function forecastRowKey(r: ResolvedForecastRow, i: number): string {
  return `${r.expected_date}|${r.facility_code}|${r.payer_label}|${r.method_label}|${r.amount}|${r.manualId ?? ''}|${i}`;
}

/**
 * ResolvedForecastRow → the UpcomingItem shape ForecastRowControls consumes.
 *
 * Exists so the OVERDUE strip can reuse the group table's controls verbatim instead of growing a
 * second copy of the same four buttons and the same aria-label formula. `buildUpcomingGroups`
 * does the equivalent mapping inline (see its forecast loop) from a slightly different input —
 * an UpcomingOverrideRow widened with Partial<ResolvedForecastRow> — so the two stay separate
 * rather than being forced into one over-general helper.
 */
function forecastItemFromResolved(r: ResolvedForecastRow): UpcomingItem {
  return {
    kind: 'forecast',
    payer: r.payer_label,
    methodLabel: r.method_label,
    amount: r.amount,
    isPatientSpecific: r.is_patient_specific,
    origin: r.origin,
    corrected: r.corrected,
    manualId: r.manualId,
  };
}

/** Whole days between two ISO civil dates (b − a). Pure string/UTC arithmetic — no clock. */
function wholeDaysBetween(aIso: string, bIso: string): number {
  const parse = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((parse(bIso) - parse(aIso)) / 86_400_000);
}

/**
 * OVERDUE — forecast rows whose expected_date has passed without the money landing. These are
 * NOT noise and NOT landed: an overdue expected payment from a payer that doesn't do ERA is
 * the highest-value row on the tile (Alec's ruling, 2026-08-03). Rendered as its OWN section
 * with its OWN subtotal — excluded from the ERA headline, the Forecast line, and the merged
 * group list above. Oldest first: the most delinquent row is the escalation priority.
 *
 * The subtotal here is the client-side RESOLVED recomputation for this partition — never the
 * SQL aggregate that rides in the payload (that number predates 024 corrections).
 *
 * CONTROLS LIVE HERE TOO (2026-08-07). Overdue used to be the ONE row class with no buttons at
 * all — amounts and prose and nothing to press — which meant the highest-value row on the tile
 * was the only one that could not be marked landed or not-coming. With every forecast row in
 * the live book currently overdue, that made the whole forecast half unactionable. The controls
 * are the SAME component the group table renders, emitting the SAME 024 intents; the server
 * re-checks super_admin on every write, so `canEdit` is decluttering, not the gate.
 */
function OverdueStrip({
  rows,
  totalCents,
  cutoff,
  truncated,
  unparseable = 0,
  canEdit = false,
  busy = false,
  onEdit,
}: {
  rows: ResolvedForecastRow[];
  totalCents: number;
  cutoff: string;
  truncated: boolean;
  /** Rows whose amount failed to parse — counted, never silently zeroed. See sumCents. */
  unparseable?: number;
  /** super_admin only. Defaulted so the strip stays safe to render bare. */
  canEdit?: boolean;
  busy?: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
  return (
    <div className="ths-notice flex-col items-stretch">
      <div className="ths-card-title mb-1 flex flex-wrap items-center gap-1.5">
        <span className="ths-tag ths-tag-warn">Overdue</span>
        <span className="ths-num tabular-nums">{money(fixed2FromCents(totalCents))}</span>
        <span className="font-normal">
          across {count(rows.length)} expected {rows.length === 1 ? 'payment' : 'payments'} past{' '}
          {rows.length === 1 ? 'its' : 'their'} date without landing — not in any total above
        </span>
      </div>
      {/* The honest limit of the correct form, stated once for the section rather than per row:
          expected_date IS the match key, so a 024 'correct' can change the money but can never
          re-date a row. A payer that reschedules needs Not coming + a fresh add. */}
      {canEdit && (
        <p className="ths-card-meta mb-1">
          A rescheduled payment cannot be re-dated here — the date is part of the match key. Mark
          it Not coming and add it again on the new date.
        </p>
      )}
      <ul className={canEdit ? 'flex flex-col gap-2' : 'flex flex-col gap-1.5'}>
        {rows.map((r, i) => (
          <li key={forecastRowKey(r, i)} className="flex flex-wrap items-center gap-2">
            <span className="ths-num tabular-nums">{money(r.amount)}</span>
            <span>
              {r.facility_code} · {r.payer_label} · {r.method_label}
            </span>
            <span className="ths-card-meta">
              expected {r.expected_date} · {count(wholeDaysBetween(r.expected_date, cutoff))} days
              overdue
              {r.corrected ? ' · corrected' : ''}
              {r.origin === 'manual' ? ' · manual add' : ''}
            </span>
            {/* `context="overdue"` reaches every aria-label below. A screen-reader user tabbing
                a flat list is a long way from the section heading, and "Mark landed: KWC BCBS AR
                2026-05-26" is otherwise indistinguishable from the same row in the group table. */}
            {canEdit && (
              <div className="w-full sm:ml-auto sm:w-auto">
                <ForecastRowControls
                  date={r.expected_date}
                  facilityCode={r.facility_code}
                  item={forecastItemFromResolved(r)}
                  busy={busy}
                  onEdit={onEdit}
                  context="overdue"
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {unparseable > 0 && (
        <p className="ths-card-meta mt-1">
          {count(unparseable)} overdue {unparseable === 1 ? 'row carries' : 'rows carry'} an
          unreadable amount and {unparseable === 1 ? 'is' : 'are'} not included — the subtotal
          shown is a floor, not the full sum.
        </p>
      )}
      {truncated && (
        <p className="ths-card-meta mt-1">
          Overdue list capped — more overdue rows exist in the sheet. The oldest are shown; the
          newest overdue were dropped.
        </p>
      )}
    </div>
  );
}

/**
 * Why ONE stale edit is doing nothing. Exhaustive on purpose — the union grew once already
 * (2026-08-07, 'duplicate_of_sheet_row'), and the strip-level copy used to assert the orphan
 * reason for every row, which the new variant would have silently falsified.
 */
function staleReasonText(st: StaleManualRow): string {
  switch (st.reason) {
    case 'no_matching_sheet_row':
      return 'No forecast row at this date, facility and payer — the sheet row it targeted has changed or gone. Re-make it against the current row, or remove it.';
    case 'duplicate_of_sheet_row': {
      const amounts = (st.sheetAmounts ?? []).map((a) => money(a)).join(' + ');
      const named = amounts ? ` (${amounts})` : '';
      return `The sheet already carries this facility, payer and date${named}. That row is counted; this add is not added on top of it. To key a second payment here, put it in the sheet or use a different date.`;
    }
    default: {
      // A new reason variant is a compile error here rather than inheriting orphan wording.
      const unreachable: never = st.reason;
      return unreachable;
    }
  }
}

/**
 * Super-admin edits that are STORED but changing no number on this tile. Two causes today: the
 * sheet row a correct/suppress targeted has changed or gone (almost always the operator editing
 * the sheet, which is allowed), or an add duplicates a key the sheet already occupies. Surfaced
 * rather than silently ignored — either way the edit contributes NO money and would otherwise
 * sit there looking applied.
 *
 * The heading is REASON-NEUTRAL and each line says why. It used to assert "no longer match a
 * forecast row" for every row, which is false for a duplicate: that add matches a forecast row
 * exactly, which is the entire problem with it.
 */
function StaleEditStrip({
  stale,
  canEdit,
  busy,
  onEdit,
}: {
  stale: StaleManualRow[];
  /**
   * Gates the BUTTON, not the strip. loadUpcomingManual is deliberately open to any entitled
   * viewer (it is non-PHI billing configuration, and the tile must show a corrected amount to
   * everyone who can see the tile at all), so an entity admin legitimately reads these rows —
   * but only a super admin can delete one. This was the single edit control on the tile that
   * was never gated, which went unnoticed for as long as it failed silently.
   */
  canEdit: boolean;
  busy: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
  return (
    <div className="ths-notice flex-col items-stretch">
      <div className="ths-card-title mb-1">
        {count(stale.length)} manual {stale.length === 1 ? 'edit' : 'edits'} not in effect
      </div>
      <p className="ths-card-meta mb-1">
        Stored, but changing no number on this tile. Each line says why.
      </p>
      <ul className="flex flex-col gap-1.5">
        {stale.map((st) => (
          <li key={st.manual.id} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="ths-tag ths-tag-neutral">{st.manual.kind}</span>
              <span>
                {st.manual.facility_code} · {st.manual.payer_label} · {st.manual.expected_date}
                {st.manual.amount ? ` · ${money(st.manual.amount)}` : ''}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="ths-btn ths-btn-secondary ths-btn-sm"
                  disabled={busy}
                  aria-label={`Remove edit: ${st.manual.facility_code} ${st.manual.payer_label} ${st.manual.expected_date}`}
                  onClick={() =>
                    onEdit?.({
                      op: 'delete-edit',
                      id: st.manual.id,
                      // Display-only, so the panel-level failure message can NAME the row. A
                      // delete-edit intent otherwise carries nothing but an opaque id. Never
                      // marshalled into the Server Action call. Non-PHI, like every other value
                      // on this tile.
                      label: `${st.manual.facility_code} · ${st.manual.payer_label} · ${st.manual.expected_date}`,
                    })
                  }
                >
                  Remove edit
                </button>
              )}
            </div>
            <span className="ths-card-meta">{staleReasonText(st)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Why one suppression was written, in the operator's words. Exhaustive over 024's vocabulary. */
function suppressReasonText(reason: ManualForecastRow['suppress_reason']): string {
  switch (reason) {
    case 'landed':
      return 'marked landed';
    case 'incorrect':
      return 'marked not coming';
    case 'cancelled':
      return 'marked cancelled';
    default:
      // 024 allows NULL only on non-suppress kinds, which cannot reach this strip. Rendered
      // rather than thrown: a tile must not blank out over a row it merely cannot label.
      return 'hidden';
  }
}

/**
 * HIDDEN BY YOU — suppressions that are IN EFFECT, each with an Undo.
 *
 * THE ONE-WAY DOOR THIS CLOSES (2026-08-07). "Mark landed" and "Not coming" write a suppress
 * row, the resolver applies it, and the money leaves the tile. Before this strip there was no
 * id on screen to delete: an applied suppress is not stale (it is working), so it rendered
 * nowhere, and any manual add at the same key was swallowed by the same branch — invisible AND
 * undeletable, because re-keying it through the add form is eaten by the suppress still
 * standing. Recovery meant SQL. Deleting the suppress restores the sheet row and the add
 * together, which is why one Undo per suppression is the whole mechanism.
 *
 * COLLAPSED BY DEFAULT, and super-admin only. This is a record of money that is NOT coming;
 * an operator reading the tile for what to expect should not have to scroll past it, and only
 * a super admin can act on it anyway. <details> gives keyboard operation and an announced
 * expanded state for free, exactly as the parent rows and the add form already do.
 *
 * ⚠️ NOT A TOTAL. These amounts are deliberately never summed into a headline figure. The
 * money here is money a human said is not coming; a "hidden: $X" subtotal beside the real ones
 * would put it straight back on the tile as a number. Per-row amounts only.
 */
function HiddenStrip({
  hidden,
  busy,
  onEdit,
}: {
  hidden: HiddenForecastRow[];
  busy: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
  return (
    <details className="ths-item">
      <summary className="ths-item-summary ths-add-summary">
        <span className="ths-item-chevron" aria-hidden>
          ▸
        </span>
        <span className="font-medium">
          Hidden by you ({count(hidden.length)})
        </span>
        <span className="ths-card-meta">
          {hidden.length === 1 ? 'a payment you removed' : 'payments you removed'} from this tile
          — expand to undo
        </span>
      </summary>
      <ul className="flex flex-col gap-1.5 px-3 pb-3 pt-1">
        {hidden.map((h) => {
          const label = `${h.manual.facility_code} · ${h.manual.payer_label} · ${h.manual.expected_date}`;
          return (
            <li key={h.manual.id} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ths-tag ths-tag-neutral">
                  {suppressReasonText(h.manual.suppress_reason)}
                </span>
                {/* Each hidden amount named separately, never added up — one suppress can hide
                    several rows at one key, and a sum here would read as a balance. */}
                {h.hiddenAmounts.map((a, i) => (
                  <span key={`${h.manual.id}-${i}`} className="ths-num tabular-nums">
                    {money(a)}
                  </span>
                ))}
                <span>{label}</span>
                <button
                  type="button"
                  className="ths-btn ths-btn-secondary ths-btn-sm"
                  disabled={busy}
                  aria-label={`Undo hiding: ${h.manual.facility_code} ${h.manual.payer_label} ${h.manual.expected_date}`}
                  onClick={() => onEdit?.({ op: 'delete-edit', id: h.manual.id, label })}
                >
                  Undo
                </button>
              </div>
              <span className="ths-card-meta">
                {h.hidAdd
                  ? 'Undo puts this back on the tile, including the row you added at this date.'
                  : 'Undo puts this back on the tile.'}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * RECONCILED (033): manual adds a human confirmed an 835 already covers.
 *
 * WHY THIS STRIP IS NOT OPTIONAL. `resolveForecast` removes a matched row from `rows` and from
 * `totalCents` — correctly, because the 835 is already on the tile through the confirmed half
 * and rendering both would show one payment twice. But a row that leaves the tile with no id on
 * screen is a ONE-WAY DOOR: no control to undo it, and re-keying the same payment through the
 * add form just revives the row into the same matched state. That is precisely the trap
 * HiddenStrip was built to close for suppressions, and shipping `matched` without the same
 * escape hatch would re-open it in a new place.
 *
 * ⚠️ NEVER TOTALLED. These amounts are money accounted for elsewhere. Summing them here — or
 * folding them into the Forecast line, the ERA headline or the overdue subtotal — would
 * double-count against the 835 that settled them.
 */
function MatchedStrip({
  matched,
  busy,
  onEdit,
}: {
  matched: MatchedForecastRow[];
  busy: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
  return (
    <details className="ths-item">
      <summary className="ths-item-summary ths-add-summary">
        <span className="ths-item-chevron" aria-hidden>
          ▸
        </span>
        <span className="font-medium">Reconciled ({count(matched.length)})</span>
        <span className="ths-card-meta">
          {matched.length === 1 ? 'a payment you added that' : 'payments you added that'} an 835
          now covers — expand to undo
        </span>
      </summary>
      <ul className="flex flex-col gap-1.5 px-3 pb-3 pt-1">
        {matched.map((m) => {
          const label = `${m.manual.facility_code} · ${m.manual.payer_label} · ${m.manual.expected_date}`;
          return (
            <li key={m.manual.id} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ths-tag ths-tag-neutral">matched to an 835</span>
                <span className="ths-num tabular-nums">{money(m.amount)}</span>
                <span>{label}</span>
                <button
                  type="button"
                  className="ths-btn ths-btn-secondary ths-btn-sm"
                  disabled={busy}
                  aria-label={`Undo reconciliation: ${m.manual.facility_code} ${m.manual.payer_label} ${m.manual.expected_date}`}
                  // status 'expected' is the undo: it clears matched_era_key and the row starts
                  // counting as expected money again.
                  onClick={() =>
                    onEdit?.({ op: 'match', id: m.manual.id, status: 'expected', matchedEraKey: null, label })
                  }
                >
                  Undo
                </button>
              </div>
              {/* The 835 is named so the operator can check the decision against the remit
                  rather than having to trust a tag. Non-PHI: date, facility, payer. */}
              <span className="ths-card-meta">
                {m.eraKey ? `Matched to ${m.eraKey}. ` : ''}Undo puts it back on the tile as
                expected money.
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * One parent row + its subitems, as a native disclosure.
 *
 * The <summary> carries the whole accessible name of the group (date, facility, payer
 * count, amount) because that is what a screen reader announces when it lands on the
 * disclosure — so a user who never expands it still hears the complete parent fact.
 */
function UpcomingGroupRow({
  group: g,
  canEdit = false,
  busy = false,
  onEdit,
}: {
  group: UpcomingGroup;
  canEdit?: boolean;
  busy?: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
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
                +{money(fixed2FromCents(g.forecastCents))} forecasted
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
              {/* The controls column exists only for a super admin. The server re-checks the
                  role on every write, so this is decluttering, not the authorization. */}
              {canEdit && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {g.items.map((it, i) => (
              <tr key={`${it.kind}-${it.payer ?? ''}-${it.methodLabel}-${i}`}>
                <td>
                  {it.payer ?? <span className="ths-text-muted">(unnamed payer)</span>}
                  {it.corrected && (
                    <span className="ths-tag ths-tag-neutral ml-1.5">corrected</span>
                  )}
                  {it.origin === 'manual' && (
                    <span className="ths-tag ths-tag-neutral ml-1.5">added by admin</span>
                  )}
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
                {canEdit && (
                  <td>
                    {it.kind === 'forecast' ? (
                      <ForecastRowControls
                        date={g.date}
                        facilityCode={g.facilityCode}
                        item={it}
                        busy={busy}
                        onEdit={onEdit}
                      />
                    ) : (
                      // A confirmed 835 remit is not editable here. It is what a payer sent;
                      // correcting it would mean rewriting the remittance advice.
                      <span className="ths-card-meta">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Super-admin controls on ONE forecast row.
 *
 * Stateless on purpose: the amount form is uncontrolled and read on submit, so this component
 * — and the whole tile — stays a pure function of its props and the render suite can drive
 * every control without a DOM harness. The host owns the in-flight flag and the refetch.
 *
 * "Not coming" is 'incorrect' rather than 'cancelled' because that is the case an operator
 * actually hits: the sheet row was wrong. 'cancelled' exists in 024 for a payer withdrawing a
 * scheduled payment and has no button yet — adding one is a label, not a schema change.
 *
 * Shared verbatim by the group table and the OVERDUE strip. The root is a plain <div>, valid
 * inside both a <td> and an <li>, so the two surfaces cannot drift apart on wording, aria
 * labelling or which intents exist. `context` disambiguates the aria-labels when the same row
 * can appear in two places.
 */
function ForecastRowControls({
  date,
  facilityCode,
  item,
  busy,
  onEdit,
  context,
}: {
  date: string;
  facilityCode: string;
  item: UpcomingItem;
  busy: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
  /** Appended to every aria-label, e.g. "overdue". Omitted in the group table, whose labels
   *  therefore stay byte-identical to what they were before the strip reused this. */
  context?: string;
}) {
  const target = { facilityCode, payerLabel: item.payer ?? '', expectedDate: date };
  const label =
    `${facilityCode} ${item.payer ?? ''} ${date}`.trim() + (context ? ` (${context})` : '');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        className="ths-btn ths-btn-secondary ths-btn-sm"
        disabled={busy}
        aria-label={`Mark landed: ${label}`}
        onClick={() => onEdit?.({ op: 'suppress', ...target, reason: 'landed' })}
      >
        Mark landed
      </button>
      <button
        type="button"
        className="ths-btn ths-btn-secondary ths-btn-sm"
        disabled={busy}
        aria-label={`Mark not coming: ${label}`}
        onClick={() => onEdit?.({ op: 'suppress', ...target, reason: 'incorrect' })}
      >
        Not coming
      </button>
      {/* NO AMOUNT FORM ON A MANUAL-ORIGIN ROW. resolveForecast's adds loop never consults the
          correct map (a 'correct' is a statement about a SHEET row; 024's header is explicit
          that it is not promoted to an add), so a correction keyed to a manual add applies
          nothing and is unconditionally reported stale. Rendering the box here would invite an
          operator to type a dollar figure that lands in the not-in-effect strip instead of on
          the tile. To change a manual add's amount: remove the row and add it again. This
          suppresses the form in the GROUP TABLE too — the trap was already live there. */}
      {item.origin !== 'manual' && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('amount');
            const raw = input instanceof HTMLInputElement ? input.value.trim() : '';
            // SECOND LAYER, not the user-facing one. `required` + `pattern` below mean the
            // browser blocks a malformed amount before submit and announces it ON THE FIELD,
            // which is the accessible place for it and the idiom AddForecastForm already uses.
            // This guard used to be the ONLY check, and a bare `return` here was a silent
            // no-op — the exact class of dead control this whole change exists to remove.
            // It survives as defence for a programmatic submit, where there is no operator to
            // tell. The Server Action validates independently; 024's CHECK is the third layer.
            if (!AMOUNT_RE.test(raw)) return;
            onEdit?.({ op: 'correct', ...target, amount: raw });
          }}
        >
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            defaultValue={item.amount ?? ''}
            size={9}
            required
            // Mirrors AMOUNT_RE. Kept as a literal because the `pattern` attribute takes a
            // string, not a RegExp — if you change one, change both.
            pattern="\d{1,10}(\.\d{1,2})?"
            title="Dollars, up to two decimals — e.g. 4200 or 4200.50"
            className="ths-input ths-num"
            aria-label={`Correct amount: ${label}`}
          />
          <button type="submit" className="ths-btn ths-btn-primary ths-btn-sm" disabled={busy}>
            Save
          </button>
        </form>
      )}
      {item.manualId !== undefined && (
        <button
          type="button"
          className="ths-btn ths-btn-ghost ths-btn-sm"
          disabled={busy}
          aria-label={`Remove admin edit: ${label}`}
          onClick={() =>
            onEdit?.({
              op: 'delete-edit',
              id: item.manualId!,
              // Display-only; see the note on the same call in StaleEditStrip.
              label: `${facilityCode} · ${item.payer ?? ''} · ${date}`,
            })
          }
        >
          {item.origin === 'manual' ? 'Remove row' : 'Undo correction'}
        </button>
      )}
    </div>
  );
}

/**
 * Payer labels already in play, for the add form's datalist. Suggestions only — the field stays
 * free text because 023 deliberately keeps payer labels VERBATIM and unresolved: forcing an
 * operator's shorthand through alias resolution would drop any label with no alias row.
 *
 * Forecast labels come first (they are the vocabulary this feed actually uses), then 835 payer
 * names, deduplicated case-insensitively.
 */
export function payerSuggestions(
  forecast: ResolvedForecastRow[],
  eraGroups: EraUpcomingSummary['groups'],
): string[] {
  const seen = new Map<string, string>();
  for (const r of forecast) {
    const k = r.payer_label.trim().toUpperCase();
    if (k && !seen.has(k)) seen.set(k, r.payer_label.trim());
  }
  for (const g of eraGroups) {
    const name = g.payer_name?.trim();
    if (!name) continue;
    const k = name.toUpperCase();
    if (!seen.has(k)) seen.set(k, name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Add a payment neither feed knows about (024 kind='add').
 *
 * WHY A DISCLOSURE, NOT AN ALWAYS-OPEN FORM: this is the rarest action on the tile — the sheet
 * is the normal way a forecast arrives, and this exists for the payment that never made it
 * there. Collapsed by default keeps the tile a report rather than a data-entry screen, and
 * <details> gives the same free keyboard + announced-state behaviour as the parent rows above.
 *
 * UNCONTROLLED, so the whole tile stays a pure function of its props: values are read off the
 * form on submit, validated, and handed up as an intent. No client state, nothing to get out of
 * sync, and the render suite can drive it.
 *
 * FACILITY IS A SELECT, NOT TEXT. 024 stores a canonical facility_code and has no FK to
 * validate one, so free text would let a typo land a payment under a facility that does not
 * exist — invisible until someone noticed the tile was short. The options are the ACTIVE
 * TENANT's roster only; the Server Action re-checks membership, so this is convenience over a
 * real guard rather than the guard itself.
 *
 * VALIDATION IS DUPLICATED ON PURPOSE. Client-side keeps a bad value from costing a round trip
 * and lets the message land next to the field; the Server Action validates independently
 * because a client check is not a control. 024's CHECK constraints are the third layer.
 */
export function AddForecastForm({
  facilityOptions,
  payerSuggestions: payers,
  busy,
  onEdit,
}: {
  facilityOptions: ForecastFacilityOption[];
  payerSuggestions: string[];
  busy: boolean;
  onEdit?: (intent: ForecastEditIntent) => void;
}) {
  // No single tenant in scope (Consolidated). Say why rather than rendering a form whose every
  // submission the server would reject with 'pick_a_tenant_view'.
  if (facilityOptions.length === 0) {
    return (
      <p className="ths-card-meta">
        Switch to the BXR or Indigo view to add an expected payment — a manual entry has to name
        one company&apos;s book.
      </p>
    );
  }
  return (
    <details className="ths-item">
      <summary className="ths-item-summary ths-add-summary">
        <span className="ths-item-chevron" aria-hidden>
          ▸
        </span>
        <span className="font-medium">Add an expected payment</span>
      </summary>
      <form
        className="ths-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget;
          const read = (name: string): string => {
            const el = f.elements.namedItem(name);
            return el instanceof HTMLInputElement || el instanceof HTMLSelectElement
              ? el.value.trim()
              : '';
          };
          const facilityCode = read('facilityCode');
          const payerLabel = read('payerLabel');
          const expectedDate = read('expectedDate');
          const methodLabel = read('methodLabel');
          const amount = read('amount');
          // Mirrors the Server Action's validator and 024's per-kind CHECK. A silent no-op is
          // better than a submitted-and-rejected round trip; the required/pattern attributes
          // mean the browser has already blocked the common cases before we get here.
          if (!facilityCode || !payerLabel || !AMOUNT_RE.test(amount)) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) return;
          if (methodLabel !== 'EFT' && methodLabel !== 'Check') return;
          onEdit?.({ op: 'add', facilityCode, payerLabel, expectedDate, methodLabel, amount });
          f.reset();
        }}
      >
        <label className="ths-field">
          <span>Facility</span>
          <select name="facilityCode" className="ths-input" required defaultValue="">
            <option value="" disabled>
              Select…
            </option>
            {facilityOptions.map((f) => (
              <option key={f.code} value={f.code}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ths-field">
          <span>Payer</span>
          <input
            name="payerLabel"
            className="ths-input"
            list="ths-payer-suggestions"
            maxLength={200}
            required
            placeholder="e.g. BCBS"
          />
          <datalist id="ths-payer-suggestions">
            {payers.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className="ths-field">
          <span>Expected</span>
          {/* Native date input: gives an ISO value directly, and brings its own keyboard and
              locale handling instead of us parsing a typed MM/DD/YYYY. */}
          <input type="date" name="expectedDate" className="ths-input ths-num" required />
        </label>
        <label className="ths-field">
          <span>Method</span>
          <select name="methodLabel" className="ths-input" defaultValue="EFT">
            <option value="EFT">EFT</option>
            <option value="Check">Check</option>
          </select>
        </label>
        <label className="ths-field">
          <span>Amount</span>
          <input
            name="amount"
            className="ths-input ths-num"
            inputMode="decimal"
            // pattern mirrors AMOUNT_RE so the browser blocks a bad value before submit and
            // announces it on the field, which is the accessible place for the message.
            pattern="\d{1,10}(\.\d{1,2})?"
            title="Dollars, up to two decimals — e.g. 4200 or 4200.50"
            required
            placeholder="4200.00"
          />
        </label>
        <button type="submit" className="ths-btn ths-btn-primary ths-btn-sm" disabled={busy}>
          Add payment
        </button>
      </form>
      <p className="ths-card-meta ths-add-note">
        Added here, not in the sheet — the hourly sheet sync never touches it, and it shows as
        &ldquo;added by admin&rdquo; on the tile.
      </p>
    </details>
  );
}
