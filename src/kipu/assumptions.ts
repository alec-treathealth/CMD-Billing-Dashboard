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
  /** A10 (PROVISIONAL) — documentation statuses treated as billable. */
  readonly billableStatuses: ReadonlySet<string>;
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
 * ⚠ 'MH OP 4 Adult' has been ambiguous since v3: in Kipu's config as IOP/4, but the
 * name says OP. Kipu's `consider_as` resolves it — unanswered until /api/care_levels
 * activates or the LOC config screen is transcribed. Deliberately ABSENT: 'MH OP 3
 * Adult' and 'MH OP 5 Adult' (in real data, no config entry, no parseable auth Freq)
 * stay uncapped and flagged rather than guessed — a guessed cap is a wrong claim.
 */
export const LOC_CONFIG_BASE: LocConfigMap = {
  'MH IOP 3 Adult': { track: 'IOP', capDays: 3, minHours: 3.0 },
  'MH IOP 4 Adult': { track: 'IOP', capDays: 4, minHours: 3.0 },
  'MH OP 4 Adult': { track: 'IOP', capDays: 4, minHours: 3.0, ambiguous: true },
  'MH OP 2 Adult': { track: 'OP', capDays: 2, minHours: 0 },
};
