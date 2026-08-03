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
  id: number;
  kind: 'add' | 'correct' | 'suppress';
  facility_code: string;
  payer_label: string;
  expected_date: string;
  method_label: string | null;
  amount: string | null;
  suppress_reason: 'landed' | 'incorrect' | 'cancelled' | null;
  matched_era_key: string | null;
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
}

/**
 * A super-admin edit that no longer matches anything. NOT an error — the usual cause is the
 * operator editing that row in the sheet, which is allowed. It is surfaced so the edit can be
 * re-pointed or deleted instead of sitting there doing nothing forever.
 */
export interface StaleManualRow {
  manual: ManualForecastRow;
  reason: 'no_matching_sheet_row';
}

export interface ResolvedForecast {
  rows: ResolvedForecastRow[];
  stale: StaleManualRow[];
  /** Sum of `rows` in exact integer cents. */
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
 */
export function resolveForecast(
  sheet: SheetForecastRow[],
  manual: ManualForecastRow[],
): ResolvedForecast {
  const suppress = new Map<string, ManualForecastRow>();
  const correct = new Map<string, ManualForecastRow>();
  const adds: ManualForecastRow[] = [];
  for (const m of manual) {
    const key = matchKey(m.facility_code, m.payer_label, m.expected_date);
    if (m.kind === 'suppress') suppress.set(key, m);
    else if (m.kind === 'correct') correct.set(key, m);
    else adds.push(m);
  }

  const rows: ResolvedForecastRow[] = [];
  const usedSuppress = new Set<string>();
  const usedCorrect = new Set<string>();

  for (const s of sheet) {
    const key = matchKey(s.facility_code, s.payer_label, s.expected_date);
    if (suppress.has(key)) {
      usedSuppress.add(key);
      // Mark the correction used too, if any: the row is gone either way, and reporting the
      // correction as orphaned would send the operator chasing a row a human deliberately hid.
      if (correct.has(key)) usedCorrect.add(key);
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

  for (const a of adds) {
    // A manual add is also subject to suppression: confirming "this landed" must work on a
    // row a super admin typed, not only on a sheet row.
    const key = matchKey(a.facility_code, a.payer_label, a.expected_date);
    if (suppress.has(key)) {
      usedSuppress.add(key);
      continue;
    }
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
    });
  }

  const stale: StaleManualRow[] = [];
  for (const [key, m] of suppress) {
    if (!usedSuppress.has(key)) stale.push({ manual: m, reason: 'no_matching_sheet_row' });
  }
  for (const [key, m] of correct) {
    if (!usedCorrect.has(key)) stale.push({ manual: m, reason: 'no_matching_sheet_row' });
  }
  stale.sort((a, b) => a.manual.id - b.manual.id);

  rows.sort(
    (a, b) =>
      a.expected_date.localeCompare(b.expected_date) ||
      a.facility_code.localeCompare(b.facility_code) ||
      a.payer_label.localeCompare(b.payer_label),
  );

  return {
    rows,
    stale,
    totalCents: rows.reduce((sum, r) => sum + (centsFromAmount(r.amount) ?? 0), 0),
  };
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
