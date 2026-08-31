/**
 * The Master BXR Chart's EXPECTED-payment series — pure, no I/O, no React.
 *
 * EXTRACTED FROM overview-bar-chart.tsx DELIBERATELY, and not as a tidiness preference: that
 * component imports `@/lib/actions`, which reaches `app/lib/access.ts` and calls React's
 * `cache()`. Under the app's plain-node test runner that is `TypeError: cache is not a
 * function`, so anything importable only through the component is untestable. This is the same
 * seam `app/lib/forecast/edit-feedback.ts` exists to be, for the same reason.
 *
 * WHAT THIS SERIES IS. Money a super admin has asserted is coming — an early check CMD has not
 * logged yet, or a payer commitment — sourced live from staging.expected_payment_override /
 * _manual through resolveForecast.
 *
 * ⚠️ IT IS NOT COLLECTED MONEY, AND `gross` MUST NEVER ABSORB IT. Every existing total,
 * tooltip, sort and CSV export reads `gross` as "what CollaborateMD confirmed". Folding
 * asserted money into it would silently restate the primary financial figure on the product's
 * main surface.
 *
 * ⚠️ AND IT MUST NEVER BE PERSISTED INTO collections.daily_collections. That table is read
 * through daily_collections_resolved, which is MAX-GROSS-WINS per (business_entity_id,
 * facility_code, payment_date) — not SUM:
 *
 *     row_number() over (partition by business_entity_id, facility_code, payment_date
 *                        order by gross_amount desc, ...) ... where rn = 1
 *
 * so a forecast row at a facility-day would either be silently discarded (CMD's gross is
 * higher) or REPLACE the real deposit (the expected amount is higher). Reading the forecast
 * live and stacking it as its own labelled series is the only shape of this feature that
 * cannot destroy a collected number.
 */

/** One facility's bar on the month chart: collected money, split by type, plus expected. */
export interface FacilityGrossRow {
  facility: string;
  /** Real facility code (drill-down key + IP/OP dimension join), or null if unassigned. */
  facility_code: string | null;
  blank: boolean;
  /** COLLECTED gross, as CMD reported it. Never includes `expected`. */
  gross: number;
  checks: number;
  eft: number;
  /**
   * Operator-keyed money not yet confirmed by CMD, in dollars. Rendered as its own stacked
   * segment, in its own colour, with its own legend entry and tooltip row.
   */
  expected: number;
  /**
   * Year-to-date gross for the facility — tooltip context only, never a bar segment (mixing the
   * two time bases in one stack is exactly what the old three-series chart got wrong). Present
   * only when the rows were reshaped from the KPI aggregate (mtdGrossRows), which already carries
   * it; a past month's rows omit it rather than pairing an as-of-today YTD with an old month.
   */
  ytd?: number | null;
}

/**
 * Fold a month's expected money (integer cents, keyed by facility_code) into its collected rows.
 *
 * Three behaviours worth stating, because each is a way the feature could go quietly wrong:
 *
 *   · `gross`, `checks` and `eft` are copied through untouched. Callers that total or sort on
 *     gross keep meaning "collected".
 *   · A facility with expected money and NO collected row is APPENDED rather than dropped.
 *     That is the entire use case — an early check at a facility CMD has logged nothing for
 *     this month — and an inner join would hide exactly the row the operator added it to see.
 *   · A zero-cent entry adds nothing. A facility expecting $0.00 has no bar to draw.
 *
 * Cents in, dollars out: the source is exact integer cents and the chart's axis is dollars, so
 * this single `/ 100` is the only place the two representations meet.
 */
export function mergeExpectedIntoFacilityRows(
  rows: FacilityGrossRow[],
  expectedCentsByCode: Map<string, number>,
  /** Label for a facility that has expected money but no collected row; falls back to the code. */
  labelForCode?: (code: string) => string | null,
): FacilityGrossRow[] {
  const out = rows.map((r) => ({
    ...r,
    // The unassigned bucket can never receive expected money: forecast rows are keyed by a real
    // facility_code the roster validated on write, so there is no such thing as an unassigned
    // expected payment — and putting one under "(unassigned)" would file an operator's own
    // entry where they would never look for it.
    expected:
      r.facility_code === null ? 0 : (expectedCentsByCode.get(r.facility_code) ?? 0) / 100,
  }));
  const present = new Set(out.map((r) => r.facility_code));
  for (const [code, cents] of expectedCentsByCode) {
    if (present.has(code) || cents === 0) continue;
    out.push({
      facility: labelForCode?.(code) ?? code,
      facility_code: code,
      blank: false,
      gross: 0,
      checks: 0,
      eft: 0,
      expected: cents / 100,
    });
  }
  // Sort by what the bar actually stands to, so a facility whose month is entirely expected
  // money is not pinned below facilities with less total height on screen.
  return out.sort((a, b) => b.gross + b.expected - (a.gross + a.expected));
}
