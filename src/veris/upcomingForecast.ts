/**
 * Upcoming-payment forecast RESOLUTION + LANDED-MATCH SUGGESTION — pure, no I/O.
 *
 * Two jobs, both deliberately outside the database:
 *
 *   1. RESOLVE. Fold super-admin edits (staging.expected_payment_manual, migration 024) over
 *      the sheet feed (staging.expected_payment_override, 023) into the list the tile shows.
 *   2. SUGGEST. Propose which forecast rows look like they have already landed as an 835, so
 *      a super admin can confirm — never to hide anything automatically.
 *
 * WHY THIS IS NOT A VIEW. The match key between the two tables is CONTENT
 * (facility_code, payer_label, expected_date), not identity — 023 is replace-per-sync
 * precisely because the hand-edited sheet has no stable row id. A SQL view could do the join,
 * but it could not do the part that matters: telling the operator when their correction has
 * been ORPHANED by a sheet edit. Resolution here returns the orphans as first-class output
 * instead of silently dropping them, and stays unit-testable without a database.
 *
 * THE SHEET WINS A KEY COLLISION (2026-08-07). A manual 'add' whose match key the sheet feed
 * already occupies is NOT emitted — it comes back as stale with reason 'duplicate_of_sheet_row',
 * carrying the sheet amounts it collided with. Emitting both double-counted the money on the
 * live tile (one $72,000 KWC / BCBS AR payment rendered twice for a $144,000 overdue subtotal),
 * and a rendered add sharing a key with a sheet row is UNADDRESSABLE by 024's own vocabulary:
 * 024's decision unique index is (entity, kind, facility_code, payer_label, expected_date), so
 * a suppress on that key kills both rows at once and a correct on it applies only to the sheet
 * row. The check is on the KEY, not the amount, for exactly that reason — an add with a
 * mistyped amount beside its sheet twin is the same unaddressable state, not a distinct row.
 * The cost is real and accepted: a genuine SECOND same-key payment can no longer be hand-keyed.
 * It is surfaced with both amounts rather than dropped, and the remedy is the sheet (the feed
 * of record) or a different date.
 *
 * NOTHING HERE HIDES MONEY ON ITS OWN. `suggestLandedMatches` returns candidates and a
 * confidence; only a human writing a 'suppress' row removes anything (024's header, Alec's
 * ruling 2026-08-03). That is the whole reason payer matching is allowed to be fuzzy: a false
 * positive costs a rejected suggestion, not a vanished payment.
 *
 * Money is EXACT INTEGER CENTS throughout. These are deposit figures an operator reconciles
 * against a bank statement, and float addition drifts.
 *
 * PHI: nothing in this module can see a patient name. 023 stores only the
 * is_patient_specific boolean and 024 has no note column, so there is no field to leak.
 */

/** A sheet-fed forecast row, as the 023 read path returns it. */
export interface SheetForecastRow {
  expected_date: string;
  facility_code: string;
  payer_label: string;
  /** 'EFT' | 'Check' — the sheet's vocabulary, never an X12 BPR04 code. */
  method_label: string;
  /** Fixed-point numeric text. Never a JS float. */
  amount: string;
  is_patient_specific: boolean;
}

/** A super-admin edit, as the 024 read path returns it. */
export interface ManualForecastRow {
  /**
   * 024's `bigint generated always as identity`.
   *
   * ⚠️ node-pg's DEFAULT parser hands int8 back as a **string**, and this repo registers no
   * type parser (verified 2026-08-07: no `setTypeParser` outside node_modules; every pool is
   * built with no `types` option). A raw `res.rows` read therefore puts the STRING "15" in a
   * field declared `number` — a type lie the compiler cannot see. Always come through
   * `manualRowFromDb`; never hand the driver's rows straight to this type.
   */
  id: number;
  kind: 'add' | 'correct' | 'suppress';
  facility_code: string;
  payer_label: string;
  expected_date: string;
  method_label: string | null;
  amount: string | null;
  suppress_reason: 'landed' | 'incorrect' | 'cancelled' | null;
  matched_era_key: string | null;
  /**
   * 033's reconciliation lifecycle. Only ever non-'expected' on an 'add' (033's status
   * coherence CHECK), because only an add represents money in its own right.
   *
   * ⚠️ OPTIONAL IN THE TYPE, NEVER READ BARE. Pre-033 fixtures and any hand-built row omit
   * it, and `undefined` is not `'expected'` — read it through `manualStatus()` below, which
   * coalesces. Declaring it required would have been stricter but would also have broken
   * every existing fixture into a compile error rather than a considered default.
   */
  status?: 'expected' | 'needs_review' | 'matched';
  /**
   * 033's soft delete. Non-null means a super admin took this decision back.
   *
   * ⚠️ NEVER WRITE `m.removed_at !== null`. On a row that omits the field that expression is
   * TRUE (undefined !== null), which silently inverts the filter and hides every live row
   * while showing every tombstone. Go through `isRemoved()`. This exact trap has already
   * cost this repo a broken tile and two vacuously-green tests.
   */
  removed_at?: string | null;
}

/** A manual row's lifecycle status, defaulting an absent field to the honest 'expected'. */
export function manualStatus(m: {
  status?: 'expected' | 'needs_review' | 'matched';
}): 'expected' | 'needs_review' | 'matched' {
  return m.status ?? 'expected';
}

/**
 * Has a super admin taken this decision back (033 soft delete)?
 *
 * The `?? null` is the whole point — see the warning on `removed_at`. A bare
 * `m.removed_at !== null` reads TRUE for an absent field.
 */
export function isRemoved(m: { removed_at?: string | null }): boolean {
  return (m.removed_at ?? null) !== null;
}

/**
 * The 024 read shape AS THE DRIVER RETURNS IT.
 *
 * Typing a `client.query<...>` generic as THIS rather than as ManualForecastRow is the whole
 * structural point: it makes `return res.rows` a tsc error, so the coercion cannot be omitted
 * again. It was omitted once — `getUpcomingManual` (app/lib/server.ts) selected the raw `id`
 * while `saveUpcomingManualRow`, forty lines below in the same file, already typed its own
 * bigint return as `{ id: string }`. The cost was silent and total: every "Remove edit",
 * "Remove row" and "Undo correction" button on the Future Payments tile was a guaranteed
 * no-op, because `deleteUpcomingManual` guards with `Number.isSafeInteger` and
 * `Number.isSafeInteger("15") === false`.
 *
 * `string | number` rather than `string` so the mapper is idempotent and every numeric-literal
 * fixture in the test suites stays valid.
 */
export interface ManualForecastDbRow extends Omit<ManualForecastRow, 'id'> {
  id: string | number;
}

/**
 * Narrow one raw 024 row to the declared shape.
 *
 * THROWS rather than truncating. A bigint past 2^53 cannot round-trip through a JS number, and
 * a silently-wrong id is exactly the failure this function exists to end: the delete path
 * addresses a row BY id, so a truncated id would delete someone else's money decision. In
 * practice unreachable — an identity sequence from 1 over one row per human decision about one
 * forecast row — so this is a tripwire, not a recovery strategy.
 *
 * NON-PHI: the id is a synthetic row number, safe to name in the message.
 */
export function manualRowFromDb(r: ManualForecastDbRow): ManualForecastRow {
  const id = typeof r.id === 'number' ? r.id : Number(r.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `upcomingForecast: expected_payment_manual.id is not a safe positive integer (${String(r.id)})`,
    );
  }
  // Normalize 033's two lifecycle fields AT THE READ BOUNDARY, so nothing downstream has to
  // remember the `?? null` dance. A pre-033 database (or a fixture) omits both; an absent
  // status is honestly 'expected', and an absent removed_at is honestly "not removed".
  return { ...r, id, status: manualStatus(r), removed_at: r.removed_at ?? null };
}

/** One row of the resolved forecast the tile renders. */
export interface ResolvedForecastRow {
  expected_date: string;
  facility_code: string;
  payer_label: string;
  method_label: string;
  /** Fixed-2 text. Post-correction where a 'correct' applied. */
  amount: string;
  is_patient_specific: boolean;
  /** 'sheet' = came from the Google Sheet. 'manual' = a super admin added it. */
  origin: 'sheet' | 'manual';
  /** True when a super-admin 'correct' changed this sheet row's amount or method. */
  corrected: boolean;
  /** The 024 row id behind a manual add, or behind the correction applied to a sheet row. */
  manualId?: number;
  /**
   * 033: an 835 plausibly covers this manual add, but nobody has confirmed it. The row is
   * STILL RENDERED and STILL COUNTED — 'needs_review' is a prompt, not a suppression. Hiding
   * money on a guess is the exact failure `suggestLandedMatches` refuses to commit (024), and
   * doing it here through a status column would be the same mistake wearing a different hat.
   * Only 'matched' (a named human) takes a row out of the count, and that never reaches here.
   */
  needsReview?: boolean;
  /** 033: the 835 key a 'needs_review' row is waiting on a human to confirm or reject. */
  candidateEraKey?: string | null;
}

/**
 * A manual 'add' a super admin has CONFIRMED an 835 already covers (033 status='matched').
 *
 * Not in `rows` and not in `totalCents`, deliberately: the 835 itself is already on the tile
 * through the confirmed half, so counting the forecast too would render one payment twice and
 * double its money — the precise defect that made a manual add + suppress pair the old
 * workaround. Surfaced as its own output so the UI can say "reconciled" and offer an undo,
 * rather than the row simply evaporating with no id on screen (the one-way door
 * HiddenForecastRow was created to close).
 */
export interface MatchedForecastRow {
  manual: ManualForecastRow;
  /** The 835 key the confirming human agreed covers it. */
  eraKey: string;
  /** Fixed-2 amount this row would contribute if it were un-matched. NEVER added to a total. */
  amount: string;
}

/**
 * A super-admin edit that no longer matches anything. NOT an error — the usual cause is the
 * operator editing that row in the sheet, which is allowed. It is surfaced so the edit can be
 * re-pointed or deleted instead of sitting there doing nothing forever.
 */
export interface StaleManualRow {
  manual: ManualForecastRow;
  /**
   * 'no_matching_sheet_row'  — a correct/suppress whose target sheet row changed or vanished.
   * 'duplicate_of_sheet_row' — an ADD whose match key the sheet feed already occupies. THE
   *   SHEET WINS and the add is not emitted; see the ruling in this file's header.
   */
  reason: 'no_matching_sheet_row' | 'duplicate_of_sheet_row';
  /**
   * 'duplicate_of_sheet_row' only: the fixed-2 amounts of the sheet rows holding that key, in
   * sheet order, so the strip can name the money that IS being counted instead of just saying
   * the add was dropped. More than one is possible — 023 has no unique index and two identical
   * forecasts are legal.
   */
  sheetAmounts?: string[];
}

/**
 * A suppression that IS in effect — the record of money a super admin took off the tile.
 *
 * WHY THIS EXISTS (2026-08-07). Suppression was a ONE-WAY DOOR. The fold consumes an applied
 * suppress into `usedSuppress` and moves on, so it is not stale (it is working exactly as
 * asked), it renders nowhere, and there is no id on screen to delete — the hidden row could
 * never come back from the UI. Worse, a manual 'add' at the same key was consumed by the same
 * branch, leaving it invisible AND undeletable: re-keying it through the add form is silently
 * eaten by the suppress that is still standing, so recovery meant SQL. That was survivable
 * while the only Mark-landed buttons sat in the group table; it stopped being survivable when
 * the overdue rows got controls, because overdue is where the entire live forecast sits.
 *
 * Deleting the suppress restores the sheet row AND any add it was killing, so ONE mechanism
 * closes both halves. That is why this is a first-class output rather than an extra `stale`
 * reason: `stale` means "this edit is changing no number", and an applied suppression is
 * changing a number — it is the one edit on the tile that is definitely working.
 *
 * ⚠️ HIDDEN MONEY IS NOT ON THE TILE. These amounts are a record of what was REMOVED. They
 * must never be added into the ERA headline, the Forecast line, the overdue subtotal, or any
 * other total — that would resurrect as a number the money a human just said is not coming.
 */
export interface HiddenForecastRow {
  /** The 'suppress' edit doing the hiding. Its id is what an Undo deletes. */
  manual: ManualForecastRow;
  /**
   * Fixed-2 amounts this suppression is keeping off the tile, sheet rows first then a manual
   * add. More than one is possible: 023 has no unique index, and a suppress kills every row at
   * its key at once. A hidden sheet row that also carried a 'correct' reports the CORRECTED
   * amount — that is the figure that would be on screen if the suppression were undone.
   */
  hiddenAmounts: string[];
  /** True when a manual 'add' is among what is hidden, so the copy can say the add comes back. */
  hidAdd: boolean;
}

export interface ResolvedForecast {
  rows: ResolvedForecastRow[];
  stale: StaleManualRow[];
  /**
   * Applied suppressions, ascending by edit id. Invariant: one entry per key in `usedSuppress`
   * — a suppress that hid nothing is `stale`, never `hidden`.
   */
  hidden: HiddenForecastRow[];
  /**
   * 033: manual adds a human confirmed an 835 already covers, ascending by edit id. Never in
   * `rows`, never in `totalCents` — see MatchedForecastRow.
   */
  matched: MatchedForecastRow[];
  /**
   * 033: manual decisions a super admin soft-removed, ascending by edit id. They change no
   * number anywhere; they are returned only so an operator can see what was taken back and by
   * whom. A hard DELETE used to make this unanswerable.
   */
  removed: ManualForecastRow[];
  /** Sum of `rows` in exact integer cents. NEVER includes `hidden` — see the warning above. */
  totalCents: number;
}

/** Exact cents from fixed-point numeric text; null when unreadable. */
export function centsFromAmount(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const m = v.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole * 100 + frac)) return null;
  return (m[1] === '-' ? -1 : 1) * (whole * 100 + frac);
}

/** Integer cents → fixed-2 text. */
export function amountFromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The match key. Payer label is upper-cased and whitespace-collapsed but NOT otherwise
 * normalized: two genuinely different payer shorthands must not collide into one key, and the
 * super admin picks the label off the row they are editing, so it already matches verbatim.
 */
export function matchKey(facilityCode: string, payerLabel: string, expectedDate: string): string {
  return `${expectedDate}|${facilityCode}|${payerLabel.replace(/\s+/g, ' ').trim().toUpperCase()}`;
}

/**
 * Fold manual edits over the sheet feed.
 *
 * Order is load-bearing: SUPPRESS wins over CORRECT. If a super admin has both corrected a
 * row's amount and later marked it landed, the row is gone — the later, stronger statement
 * ("this money arrived") makes the earlier one ("this amount is wrong") irrelevant, and
 * showing a corrected-but-landed row would double-count against its 835.
 *
 * A stale 'correct' is NOT promoted to an 'add'. A correction is a statement ABOUT a sheet
 * row; with the row gone it asserts nothing, and resurrecting it would put money on the tile
 * that neither the sheet nor a deliberate 'add' claims exists.
 *
 * And an 'add' that collides with a sheet row on the match key is SKIPPED, not emitted beside
 * it — see THE SHEET WINS A KEY COLLISION in this file's header. Within the adds loop the
 * order is likewise load-bearing: suppress, then the duplicate check, then emit.
 *
 * THREE OUTPUTS, and the distinction between the last two is the whole point:
 *   rows   — what is on the tile.
 *   stale  — edits changing NO number, so they can be re-pointed or cleared.
 *   hidden — suppressions changing a number RIGHT NOW, so they can be undone. Without this a
 *            suppression was a one-way door; see HiddenForecastRow.
 */
export function resolveForecast(
  sheet: SheetForecastRow[],
  manual: ManualForecastRow[],
): ResolvedForecast {
  const suppress = new Map<string, ManualForecastRow>();
  const correct = new Map<string, ManualForecastRow>();
  const adds: ManualForecastRow[] = [];
  // 033 outputs. Collected in the same pass so a removed/matched row is classified exactly
  // once and can never also reach `rows` — two loops would let the two drift.
  const removed: ManualForecastRow[] = [];
  const matched: MatchedForecastRow[] = [];
  for (const m of manual) {
    // SOFT DELETE WINS OVER EVERYTHING, and it comes first for that reason. A removed row is
    // a decision the operator took back — it must not suppress a sheet row, must not correct
    // an amount, and must not add money. `isRemoved` rather than `m.removed_at !== null`
    // because an absent field makes that comparison TRUE; see the warning on the field.
    if (isRemoved(m)) {
      removed.push(m);
      continue;
    }
    // A CONFIRMED MATCH ALSO LEAVES THE FOLD, before it can be filed as an add. The 835 is
    // already on the tile, so emitting the forecast beside it renders one payment twice.
    // Guarded on kind: 033's status coherence CHECK confines a non-'expected' status to an
    // 'add', and this must not silently start eating suppressions if that ever changes.
    if (m.kind === 'add' && manualStatus(m) === 'matched') {
      matched.push({
        manual: m,
        eraKey: m.matched_era_key ?? '',
        amount: m.amount ?? '0.00',
      });
      continue;
    }
    const key = matchKey(m.facility_code, m.payer_label, m.expected_date);
    if (m.kind === 'suppress') suppress.set(key, m);
    else if (m.kind === 'correct') correct.set(key, m);
    else adds.push(m);
  }

  // The sheet indexed by match key. A BUCKET, not a single row: 023 has no unique index on
  // (facility, payer, date) and its header is explicit that two identical forecasts are legal.
  const sheetByKey = new Map<string, SheetForecastRow[]>();
  for (const s of sheet) {
    const key = matchKey(s.facility_code, s.payer_label, s.expected_date);
    const bucket = sheetByKey.get(key);
    if (bucket) bucket.push(s);
    else sheetByKey.set(key, [s]);
  }

  const rows: ResolvedForecastRow[] = [];
  const usedSuppress = new Set<string>();
  const usedCorrect = new Set<string>();

  // Applied suppressions, accumulated as they fire. Keyed because ONE suppress can hide
  // several rows at once (a duplicated sheet key, or a sheet row plus an add), and the Undo
  // that restores them is a single delete of that one edit.
  const hiddenByKey = new Map<string, HiddenForecastRow>();
  const hide = (key: string, m: ManualForecastRow, amount: string, fromAdd: boolean): void => {
    let h = hiddenByKey.get(key);
    if (!h) {
      h = { manual: m, hiddenAmounts: [], hidAdd: false };
      hiddenByKey.set(key, h);
    }
    h.hiddenAmounts.push(amount);
    if (fromAdd) h.hidAdd = true;
  };

  // Iterates ROWS, not keys, deliberately: two sheet rows at one key must BOTH render.
  for (const s of sheet) {
    const key = matchKey(s.facility_code, s.payer_label, s.expected_date);
    const sup = suppress.get(key);
    if (sup) {
      usedSuppress.add(key);
      // Mark the correction used too, if any: the row is gone either way, and reporting the
      // correction as orphaned would send the operator chasing a row a human deliberately hid.
      const applied = correct.get(key);
      if (applied) usedCorrect.add(key);
      // Report the CORRECTED figure where one applied — that is what would be on screen if the
      // suppression were undone, and naming the pre-correction amount would understate the
      // money an Undo brings back.
      hide(key, sup, applied?.amount ?? s.amount, false);
      continue;
    }
    const c = correct.get(key);
    if (c) {
      usedCorrect.add(key);
      rows.push({
        expected_date: s.expected_date,
        facility_code: s.facility_code,
        payer_label: s.payer_label,
        method_label: c.method_label ?? s.method_label,
        amount: c.amount ?? s.amount,
        is_patient_specific: s.is_patient_specific,
        origin: 'sheet',
        corrected: true,
        manualId: c.id,
      });
      continue;
    }
    rows.push({
      expected_date: s.expected_date,
      facility_code: s.facility_code,
      payer_label: s.payer_label,
      method_label: s.method_label,
      amount: s.amount,
      is_patient_specific: s.is_patient_specific,
      origin: 'sheet',
      corrected: false,
    });
  }

  const staleAdds: StaleManualRow[] = [];
  for (const a of adds) {
    const key = matchKey(a.facility_code, a.payer_label, a.expected_date);
    // SUPPRESS FIRST, and it wins over the duplicate check. A manual add is also subject to
    // suppression: confirming "this landed" must work on a row a super admin typed, not only
    // on a sheet row. And once a human has said "nothing at this key is coming", telling them
    // their add duplicates a row they just hid is noise — the add contributes no money either
    // way. `usedSuppress` is a Set, so the sheet loop having already marked this key is not a
    // double-mark.
    const sup = suppress.get(key);
    if (sup) {
      usedSuppress.add(key);
      // The add is HIDDEN, not stale. Recording it here is what makes it deletable again:
      // before this, the add vanished with no id on screen and the suppress standing over its
      // key swallowed any attempt to re-key it, so recovery meant SQL.
      hide(key, sup, a.amount ?? '0.00', true);
      continue;
    }
    // THE SHEET WINS. Not silently — the add is reported with the colliding sheet amounts so
    // the operator can see the money they typed and clear the now-redundant edit. See the
    // ruling in this file's header for why this is key-only and why the sheet is preferred.
    const collides = sheetByKey.get(key);
    if (collides !== undefined) {
      staleAdds.push({
        manual: a,
        reason: 'duplicate_of_sheet_row',
        sheetAmounts: collides.map((s) => s.amount),
      });
      continue;
    }
    // DELIBERATELY NOT marking usedCorrect here, unlike the sheet loop above — this asymmetry
    // is the decision, not an oversight. A 'correct' is a statement ABOUT A SHEET ROW (024's
    // header: it is never promoted to an add), and this loop never applies one to an add, so a
    // correct at a key held only by an add has no target and is changing nothing. That is
    // genuinely ORPHANED, and hiding it would hide a dead edit — which is the one thing the
    // stale strip exists to prevent. The sheet loop's case is different: there the correction
    // HAD a live target that a human then deliberately hid.
    rows.push({
      expected_date: a.expected_date,
      facility_code: a.facility_code,
      payer_label: a.payer_label,
      // The 024 shape constraint guarantees both are present for kind='add'; the fallbacks
      // exist so a hand-inserted row can never crash the tile.
      method_label: a.method_label ?? 'EFT',
      amount: a.amount ?? '0.00',
      is_patient_specific: false,
      origin: 'manual',
      corrected: false,
      manualId: a.id,
      // STILL COUNTED. needs_review marks a row for a human to look at; it does not take the
      // money off the tile. See the field comment on ResolvedForecastRow.needsReview.
      needsReview: manualStatus(a) === 'needs_review',
      candidateEraKey: a.matched_era_key ?? null,
    });
  }

  const stale: StaleManualRow[] = [...staleAdds];
  for (const [key, m] of suppress) {
    if (!usedSuppress.has(key)) stale.push({ manual: m, reason: 'no_matching_sheet_row' });
  }
  for (const [key, m] of correct) {
    if (!usedCorrect.has(key)) stale.push({ manual: m, reason: 'no_matching_sheet_row' });
  }
  // Numeric subtraction is sound because `manualRowFromDb` guarantees a real number here. It
  // WAS NOT before: the read boundary handed this a bigint-as-string, and this line worked only
  // by JS coercing "10" - "2". Do not "simplify" it to localeCompare — that would order 10
  // before 2 — and do not drop the mapper, which is what makes the arithmetic honest.
  stale.sort((a, b) => a.manual.id - b.manual.id);

  rows.sort(
    (a, b) =>
      a.expected_date.localeCompare(b.expected_date) ||
      a.facility_code.localeCompare(b.facility_code) ||
      a.payer_label.localeCompare(b.payer_label) ||
      // THE MATCH KEY IS NOT UNIQUE, so the three columns above are not a total order. 023 has
      // no unique index, two identical forecasts are legal, and OVERRIDE_*_ROWS_SQL orders by
      // these same three columns — without a tiebreak a duplicated key renders in whatever
      // order the planner happened to return, which can flip between page loads. Larger amount
      // first, matching the group list's descending-amount idiom.
      (centsFromAmount(b.amount) ?? 0) - (centsFromAmount(a.amount) ?? 0) ||
      a.method_label.localeCompare(b.method_label),
  );

  // Ascending by edit id, matching `stale` — both strips read as "oldest decision first".
  const hidden = [...hiddenByKey.values()].sort((a, b) => a.manual.id - b.manual.id);

  // Ascending by edit id, matching `stale` and `hidden` — every strip reads "oldest first".
  matched.sort((a, b) => a.manual.id - b.manual.id);
  removed.sort((a, b) => a.id - b.id);

  return {
    rows,
    stale,
    hidden,
    matched,
    removed,
    // `rows` ONLY. Never `hidden` — see the warning on HiddenForecastRow. Summing what a human
    // deliberately removed would put it straight back on the tile as a number.
    totalCents: rows.reduce((sum, r) => sum + (centsFromAmount(r.amount) ?? 0), 0),
  };
}

/**
 * Expected (not-yet-collected) money per facility for ONE calendar month, in exact integer
 * cents. Backs the Master BXR Chart's expected-payment series.
 *
 * WHY THE CHART NEEDS THIS AT ALL. A check can physically arrive days before CMD logs it, so
 * the collections feed shows nothing while the money is provably in hand. The operator keys it
 * as a forecast row; this is what puts that row on the chart immediately instead of after the
 * next hourly pull.
 *
 * ⚠️ THIS IS NOT COLLECTED MONEY AND MUST NEVER BE ADDED INTO ONE. Keep it a separate series
 * with its own label wherever it renders. It is an assertion by a human, not a deposit
 * confirmed by CMD, and the two must stay tellable apart on screen.
 *
 * ⚠️ AND IT MUST NEVER BE WRITTEN INTO collections.daily_collections. That table is read
 * through `daily_collections_resolved`, which is MAX-GROSS-WINS per (entity, facility,
 * payment_date) — not SUM. A forecast row there would either be silently dropped or REPLACE
 * the real CMD deposit for that facility-day. Reading it live from staging, as the chart does,
 * is the only form of this feature that cannot corrupt a collected figure.
 *
 * `month` is 1-based, matching the chart's dropdown and JS's own `YYYY-MM` string, NOT
 * Date#getMonth. Rows are matched on the `YYYY-MM` prefix of expected_date, which is already a
 * civil-date string — no Date parsing, so no timezone can move a row into another month.
 */
export function expectedCentsByFacilityForMonth(
  rows: ResolvedForecastRow[],
  year: number,
  month: number,
): Map<string, number> {
  const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.expected_date.startsWith(prefix)) continue;
    const cents = centsFromAmount(r.amount);
    // An unreadable amount contributes NOTHING rather than a zero-valued bar entry: a facility
    // whose only forecast row is unparseable has no expected money we can honestly draw.
    if (cents === null) continue;
    out.set(r.facility_code, (out.get(r.facility_code) ?? 0) + cents);
  }
  return out;
}

// ===========================================================================
// LANDED-MATCH SUGGESTION
// ===========================================================================

/** The 835 side of a candidate match — a subset of EraUpcomingGroup, kept structural. */
export interface EraCandidate {
  payment_date: string;
  facility_code: string;
  payer_name: string | null;
  /** Fixed-point numeric text, or null when every remit in the group was unquantified. */
  amount: string | null;
}

export interface LandedSuggestion {
  /** The forecast row that looks already-paid. */
  forecast: ResolvedForecastRow;
  /** The 835 group it resembles. */
  era: EraCandidate;
  /**
   * 'high' — the amounts match to the cent AND the payer names correspond.
   * 'medium' — one of those two holds, not both.
   * Never 'confirmed': only a human writing a suppress row decides that.
   */
  confidence: 'high' | 'medium';
  /** Days between the forecast date and the 835 effective date (signed, era − forecast). */
  dayGap: number;
  /** The stamp recorded on the resulting suppression, for the audit trail. */
  eraKey: string;
}

/** How far apart the two dates may be. An operator estimates a date; payers move it. */
const DEFAULT_DAY_WINDOW = 7;

/** Days between two ISO dates, era − forecast. UTC math; both are civil dates. */
function dayGap(forecastIso: string, eraIso: string): number {
  const a = Date.parse(`${forecastIso}T00:00:00Z`);
  const b = Date.parse(`${eraIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

/** Letters and digits only, upper-cased — the comparison form for payer names. */
function normalizePayer(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/** Words of 3+ letters, upper-cased. Drops the noise that every payer name shares. */
const PAYER_STOPWORDS = new Set([
  'INSURANCE', 'COMPANY', 'HEALTH', 'PLAN', 'PLANS', 'LIFE', 'AND', 'THE', 'INC', 'LLC',
  'CORP', 'GROUP', 'SERVICES', 'SERVICE', 'BEHAVIORAL', 'OF', 'CO', 'MUTUAL', 'ASSOCIATION',
]);

function payerTokens(v: string): string[] {
  return v
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3 && !PAYER_STOPWORDS.has(t));
}

/**
 * Do an operator's shorthand and a payer's legal 835 name plausibly refer to one payer?
 *
 * THIS IS THE REASON MATCHING IS SUGGEST-ONLY. The sheet says 'BCBS'; the 835 says
 * 'BLUE CROSS OF CALIFORNIA (CA)'. There is no reliable join here — an initialism test gets
 * BCBS→Blue Cross Blue Shield but not BCBS→Blue Cross of California, and a substring test
 * gets 'AETNA' but also matches almost anything short. So this returns a plausibility signal
 * that a human checks, and a false positive costs a declined suggestion rather than money.
 *
 * Three signals, any of which is enough:
 *   · one normalized form contains the other  ('AETNA' vs 'AETNA')
 *   · a shared significant token              ('SUREST' in 'UHC SUREST')
 *   · the short form is an initialism of the long form's significant words
 */
export function payersCorrespond(shorthand: string, legalName: string | null): boolean {
  if (legalName === null) return false;
  const a = normalizePayer(shorthand);
  const b = normalizePayer(legalName);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const shortTokens = payerTokens(shorthand);
  const longTokens = payerTokens(legalName);
  if (shortTokens.some((t) => longTokens.includes(t))) return true;

  // Initialism: 'BCBS' vs 'BLUE CROSS BLUE SHIELD'. Compared against the FULL word list, not
  // the stopword-filtered one — 'HEALTH' is noise as a token but its H counts in an acronym.
  const initials = legalName
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
  return a.length >= 3 && initials.includes(a);
}

/**
 * Propose forecast rows that appear to have already landed as an 835.
 *
 * A candidate must share the facility EXACTLY and fall inside the day window — those are the
 * two facts we can trust. Beyond that, at least one of {amount to the cent, payer
 * correspondence} must hold, or no suggestion is emitted at all: "same facility, same week"
 * alone describes most of a busy facility's remits and would bury the real matches.
 *
 * Each forecast row yields AT MOST ONE suggestion — its best candidate — because the operator
 * is answering a yes/no question about one payment, not picking from a list. Ties break toward
 * the smaller date gap, then the earlier date, so the output is deterministic.
 */
export function suggestLandedMatches(
  forecast: ResolvedForecastRow[],
  era: EraCandidate[],
  dayWindow: number = DEFAULT_DAY_WINDOW,
): LandedSuggestion[] {
  const out: LandedSuggestion[] = [];
  for (const f of forecast) {
    const fCents = centsFromAmount(f.amount);
    let best: LandedSuggestion | null = null;
    for (const e of era) {
      if (e.facility_code !== f.facility_code) continue;
      const gap = dayGap(f.expected_date, e.payment_date);
      if (!Number.isFinite(gap) || Math.abs(gap) > dayWindow) continue;

      const eCents = centsFromAmount(e.amount);
      const amountMatches = fCents !== null && eCents !== null && fCents === eCents;
      const payerMatches = payersCorrespond(f.payer_label, e.payer_name);
      if (!amountMatches && !payerMatches) continue;

      const candidate: LandedSuggestion = {
        forecast: f,
        era: e,
        confidence: amountMatches && payerMatches ? 'high' : 'medium',
        dayGap: gap,
        eraKey: `${e.payment_date}|${e.facility_code}|${e.payer_name ?? ''}`,
      };
      if (best === null || betterSuggestion(candidate, best)) best = candidate;
    }
    if (best !== null) out.push(best);
  }
  out.sort(
    (a, b) =>
      a.forecast.expected_date.localeCompare(b.forecast.expected_date) ||
      a.forecast.facility_code.localeCompare(b.forecast.facility_code) ||
      a.forecast.payer_label.localeCompare(b.forecast.payer_label),
  );
  return out;
}

/** High beats medium; then the smaller absolute day gap; then the earlier 835 date. */
function betterSuggestion(a: LandedSuggestion, b: LandedSuggestion): boolean {
  if (a.confidence !== b.confidence) return a.confidence === 'high';
  if (Math.abs(a.dayGap) !== Math.abs(b.dayGap)) return Math.abs(a.dayGap) < Math.abs(b.dayGap);
  return a.era.payment_date < b.era.payment_date;
}
