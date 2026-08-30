/**
 * Weekly Billable Days — the assumptions the Kipu Billing Report pipeline runs on.
 *
 * Every assumption is a NAMED, INDIVIDUALLY SWITCHABLE rule, never an inline
 * conditional, so that when the grid is reconciled against billed actuals a
 * changed assumption is a one-line diff with a test that fails loudly.
 *
 * RATIFICATION RECORD (Alec, 2026-08-21) — do not soften without a new ruling:
 *
 * A9  RATIFIED. Row existence = this patient attended AND the service is billable.
 *     Verified structurally: one row per (Full Name, Session Id) across 196 rows;
 *     `Attended`/`Absent` are group ROSTER counts, never this patient's attendance.
 *     GUARD: A9 is only true of the "Billable" report variant. Every file of that
 *     variant carries `-Billable-` in its filename; `assembleBundle` warns loudly
 *     when a file lacks it, because feeding a different export variant makes A9
 *     silently false and nothing downstream would notice.
 *
 * A10 PROVISIONAL — DO NOT LOCK. Complete-only is the DEFAULT, not a fact. This is
 *     the likeliest source of a discrepancy against billed actuals, in both
 *     directions: Kipu's Billing Report feeds CMD, so if billing receives
 *     non-Complete rows too, holding them back under-reports; and "In Use" may be
 *     a normal end state for some templates (a treatment plan sitting In Use is
 *     not unsigned documentation). `billableStatuses` is the switch, and A10 is
 *     the specific thing the billed-actuals reconciliation is testing.
 *
 * A11 MECHANISM RATIFIED, SOURCE IS A STOPGAP. Precedence: hand-kept config entry
 *     first, then a cap derived from the authorization `Freq`, else UNCAPPED and
 *     flagged — never silently defaulted. Name the conflation: the auth `Freq` is
 *     a PAYER-authorized frequency; capDays is a PROGRAM cap. They coincide for an
 *     IOP-3 patient on a "3 Day (M/W/F)" auth and diverge the moment a payer
 *     approves fewer days than the program runs — deriving one from the other is
 *     correct only while they agree. Kipu's Levels of Care config (`hours`,
 *     `days_of_the_week`, `consider_as`) is the real source and SUPERSEDES the
 *     derivation the moment we can read it (LOC config screen now,
 *     /api/care_levels once the API activates). MH OP 3 Adult and MH OP 5 Adult
 *     stay uncapped and flagged until then.
 *     (The mock's header comment claimed Freq wins over config; its code did the
 *     opposite. The code was right — config first — and that is what ships here.)
 *
 * A12 RATIFIED. 'Missed Therapy Session' rows and 0.00-hour evaluations are never
 *     billable. The 0.00-hour case: Kipu renders a date-only timestamp as
 *     "MM/DD/YYYY 12:00 AM" with no duration — the row is excluded because it is
 *     NOT A SERVICE AT ALL, not merely because its duration is zero.
 *
 * A13 FLAG RATIFIED, RESOLUTION CHANGED. When a patient holds overlapping
 *     authorizations at DIFFERENT levels of care the row is always flagged (that
 *     part stands). Resolving the whole week's cap from Current UR Loc was a
 *     deferral accepted while the engine lived in a mock; the ruled-correct
 *     behaviour — the DEFAULT here — resolves each day's cap from the
 *     authorization that covers that day (`capResolution: 'per-day-auth'`).
 *     'current-ur-loc' reproduces the mock for parity comparison.
 */

export type CapResolution = 'per-day-auth' | 'current-ur-loc';

export interface BillableDayRules {
  /** A9 guard — warn when an import file does not carry the -Billable- marker. */
  readonly requireBillableVariant: boolean;
  /**
   * A10 — documentation statuses the CARE TEAM treats as complete. Retained because the
   * status is still worth SHOWING, but see `statusGatesBillable`: it no longer decides
   * whether a service is billable.
   */
  readonly billableStatuses: ReadonlySet<string>;
  /**
   * A10, RULED BY ALEC 2026-08-27 AND THE DEFAULT IS `false`.
   *
   * ⚠ `Status != 'Complete'` DOES NOT MEAN NOT BILLABLE. The documentation status is a
   * CARE-TEAM signal — it tracks whether a clinician has finished their note, not whether
   * the service happened or may be submitted. Attendance is what bills, so an hour counts
   * on `present === true` alone.
   *
   * This was `true` in effect from the first build until the ruling, which is why the
   * reconciliation reported A10 as UNTESTED on every customer-week: all 18 had zero
   * non-`Complete` GROUP rows, so the gate never actually fired there and the recon numbers
   * are unaffected by the flip. Setting this back to `true` can only ever REMOVE hours.
   */
  readonly statusGatesBillable: boolean;
  /** A12 — 'Missed …' service rows are never billable. */
  readonly missedNeverBillable: boolean;
  /** A12 — 0.00-hour rows are date-only placeholders, not services. */
  readonly zeroHourNeverBillable: boolean;
  /** A13 — how a week's cap regime is resolved for a day. */
  readonly capResolution: CapResolution;
  /**
   * Escape hatch for the location registry gate, DEFAULT FALSE so the build fails loud on
   * a Kipu location nobody has mapped. Set true ONLY to probe a brand-new export before
   * writing its registry entry — never in a reconciliation, because an unmapped label has
   * no CMD customer and its days would be silently excluded from every per-customer total.
   */
  readonly allowUnmappedLocations: boolean;
}

export const DEFAULT_RULES: BillableDayRules = {
  requireBillableVariant: true,
  billableStatuses: new Set(['Complete']),
  statusGatesBillable: false,
  missedNeverBillable: true,
  zeroHourNeverBillable: true,
  capResolution: 'per-day-auth',
  allowUnmappedLocations: false,
};

/** Convenience for tests and reconciliation experiments: override one rule at a time. */
export const withRules = (overrides: Partial<BillableDayRules>): BillableDayRules => ({
  ...DEFAULT_RULES,
  ...overrides,
});

/* ------------------------------ predicates ------------------------------- */

/** A9 — the Billable report variant stamps `-Billable-` into every CSV filename. */
export const isBillableReportFile = (filename: string): boolean => /-Billable-/.test(filename);

/** A12 — matches 'Missed Therapy Session', 'Missed Initial Psychiatry Evaluation', …. */
export const isMissedService = (name: string): boolean => /missed/i.test(String(name ?? ''));

/** BPS detection — biopsychosocial assessments stack without consuming a cap day (A7). */
export const isBpsEvaluation = (name: string): boolean => /biopsychosocial/i.test(String(name ?? ''));

/** A10 — is this documentation status billable under the current rules? */
export const isBillableDocumentation = (status: string, rules: BillableDayRules): boolean =>
  rules.billableStatuses.has(status);

/* --------------------------- level-of-care config ------------------------ */

export interface LocConfigEntry {
  readonly track: 'IOP' | 'OP';
  readonly capDays: number;
  readonly minHours: number;
  /** True when the entry is inferred or unresolved — the row must carry a review flag. */
  readonly ambiguous?: boolean;
}

export type LocConfigMap = Record<string, LocConfigEntry>;

/**
 * The hand-kept PROGRAM-cap config (A11's stopgap source — see the record above).
 * Kipu's Levels of Care config supersedes this the moment it is readable.
 *
 * ⚠ THE OP LADDER IS `OP-N = N BILLABLE DAYS PER WEEK, ON THE OP TRACK` — RULED BY ALEC
 * 2026-08-27, superseding the "leave them uncapped" posture below. The OP track bills a
 * day on ANY attended group or individual therapy (G or T); there is no per-day hours
 * threshold, which is what separates it from IOP. `MH OP 1/3/5 Adult` are added on that
 * rule; they were previously absent and therefore uncapped-and-flagged.
 *
 * ⚠ 'MH OP 4 Adult' IS RECLASSIFIED IOP/4 -> OP/4 BY THE SAME RULING. It had been
 * ambiguous since v3 (Kipu's config said IOP/4, the name says OP) and carried
 * `ambiguous: true`. It now follows the OP ladder like its siblings, which is a REAL
 * BEHAVIOUR CHANGE: it no longer requires 3 hours in a day to bill one, it bills any G/T
 * day up to 4. If /api/care_levels ever activates and its `consider_as` disagrees, that is
 * a fresh ruling — do not silently revert this one.
 *
 * These caps came from a verbal ruling, NOT from Kipu's own config, because
 * /api/care_levels still 403s (the API client is not enabled). That is the authoritative
 * source the moment it is readable.
 */
export const LOC_CONFIG_BASE: LocConfigMap = {
  // IOP: a day bills only when it reaches minHours (3.0) of attended service; BPS hours
  // count toward that total, and the weekly cap is the ladder number.
  //
  // ⚠ MH IOP 1 / 2 / 3 ARE THE SAME PROGRAM (ruled by Alec 2026-08-29). The trailing
  // numeral is the weekly billable-day cap and NOTHING else varies: the 3.0h/day minimum,
  // the `I` day code, the no-bare-G-or-T rule on an IOP track and BPS stacking without
  // consuming a cap day are all inherited verbatim from MH IOP 3 Adult below.
  //
  // ⚠ ENUMERATED ON PURPOSE — DO NOT REPLACE THIS WITH A PARSER. It would be one line to
  // read the trailing digit and synthesise a cap for any `MH IOP N`, and that is exactly
  // what must not happen: the unmapped-level error is load-bearing. A future MH IOP 5 has
  // to FAIL LOUDLY so a human confirms the cap actually is 5, rather than being silently
  // absorbed by a pattern nobody has verified holds beyond 1-4.
  //
  // ⚠ THE RULE IS PREFIX-SCOPED TO `MH IOP N` AND STOPS THERE. It does NOT extend to
  // `MH OP N`, which is a different track: MH OP 4 Adult resolves via Kipu's own
  // `consider_as` to OUTPATIENT (verified live 2026-08-29), not IOP-with-cap-4. Making
  // MH OP N inherit IOP semantics would revert the #268 ruling and is a regression.
  //
  // Kipu cannot supply any of this: /api/care_levels returns EMPTY `hours` and
  // `days_of_the_week` on all 9 levels, so the caps are policy, not a Kipu read.
  'MH IOP 1 Adult': { track: 'IOP', capDays: 1, minHours: 3.0 },
  'MH IOP 2 Adult': { track: 'IOP', capDays: 2, minHours: 3.0 },
  'MH IOP 3 Adult': { track: 'IOP', capDays: 3, minHours: 3.0 },
  'MH IOP 4 Adult': { track: 'IOP', capDays: 4, minHours: 3.0 },
  // OP: any attended G or T day bills, up to the ladder number. No hours threshold.
  'MH OP 1 Adult': { track: 'OP', capDays: 1, minHours: 0 },
  'MH OP 2 Adult': { track: 'OP', capDays: 2, minHours: 0 },
  'MH OP 3 Adult': { track: 'OP', capDays: 3, minHours: 0 },
  'MH OP 4 Adult': { track: 'OP', capDays: 4, minHours: 0 },
  'MH OP 5 Adult': { track: 'OP', capDays: 5, minHours: 0 },
};
