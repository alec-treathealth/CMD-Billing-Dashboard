/**
 * The Billable Days display vocabulary — TRANSCRIBED FROM THE BILLING TEAM'S OWN WORKBOOK
 * ("TMH CA August 2026 Occupancy Report.xlsx", read 2026-08-27), which is the artifact this
 * grid replaces. It is the source of truth for what a code MEANS, not this file.
 *
 * ⚠ THE CODES HERE ARE DISPLAY LABELS ONLY. What counts as a billable day is decided by
 * `BILLABLE_CODES` in `src/kipu/computeRow.ts` and the rules in `src/kipu/assumptions.ts`.
 * The two agree today — the workbook's billable set is exactly {I, G, T, BPS}, and CM and
 * N/B are the non-billable markers — but if they ever diverge, the ENGINE wins and this map
 * is what gets corrected.
 *
 * The CPT/HCPCS column is the workbook's own legend. It is shown in the chip tooltip because
 * the billers read the grid to decide what to submit, and the code alone does not tell them.
 *
 * ⚠ THAT LAST SENTENCE IS WHY `cpt` MAY NEVER CARRY AN UNRESOLVED MAPPING (fixed 2026-08-30).
 * `I` shipped as `cpt: 'S9480 / H0015'` — the workbook's two printed alternates, rendered to a
 * biller who reads this tooltip to decide what to submit, in a field whose every other value is
 * a single submittable code. Read in that position it states a mapping, and there is none:
 * `src/kipu/claimCodes.ts` records the measured spread — S9480 x10, H2013 x21, H2019 x29,
 * H2020 x20 — where H2020, the third most common in practice, is not in the legend at all. So
 * the printed pair is not merely ambiguous, it is wrong most of the time.
 *
 * `cpt` is now non-null ONLY where exactly one code applies. Everything else states WHY there
 * is no code in `unresolved`, and both render sites print one or the other — never neither,
 * because a silently empty field is what let `CM` (no code at all) and `N/B` (not a service)
 * look identical for months.
 *
 * ⚠ THIS FILE DOES NOT IMPORT `src/kipu/claimCodes.ts`, DELIBERATELY. That seed is scoped to
 * CALIFORNIA and refuses every other state by design; this legend renders for every location in
 * the grid. Wiring the CA seed in here would apply California's policy to a Texas row — the
 * exact generalisation the seed exists to prevent. `app/test/billableDaysLegendCodes.test.tsx`
 * holds the two in agreement instead, which is the coupling that is actually wanted: a shared
 * assertion, not a shared runtime.
 *
 * ⚠ AND THE PRE-EXISTING VERSION OF THAT PROBLEM IS STILL HERE, NAMED AND NOT FIXED: this
 * vocabulary was transcribed from the CALIFORNIA workbook and is rendered for every location.
 * Whether the legend is per-state, per-facility or global is an open question with the biller —
 * the same one blocking the seed. Do not resolve it by quietly importing the CA seed.
 */

export interface CodeMeaning {
  /** Chip text, exactly as the workbook writes it. */
  readonly code: string;
  /**
   * The ONE CPT/HCPCS this code submits as, or `null` when there is not exactly one.
   * ⚠ Never a list, a pair, or a slash-joined pair of alternates — see the header.
   */
  readonly cpt: string | null;
  /**
   * Why there is no single code, shown wherever `cpt` would have been. Required whenever
   * `cpt` is null and absent whenever it is set, so a reader is never left with a blank
   * where a code belongs.
   */
  readonly unresolved: string | null;
  readonly label: string;
  /** The workbook's expected duration for the service. */
  readonly hours: string | null;
  readonly billable: boolean;
}

export const CODE_LEGEND: readonly CodeMeaning[] = [
  // The three `unresolved` strings below are each a DIFFERENT statement, and collapsing them
  // back to a blank would lose the distinction: `I` has codes but no rule for choosing;
  // `CM` is a service the legend gave no code; `N/B` is not a service at all.
  {
    code: 'I',
    cpt: null,
    unresolved: 'no single code — payer-dependent',
    label: 'Intensive outpatient',
    hours: '3 hours',
    billable: true,
  },
  { code: 'G', cpt: '90853', unresolved: null, label: 'Group therapy', hours: '1 hr', billable: true },
  { code: 'T', cpt: '90837', unresolved: null, label: 'Individual therapy', hours: '1 hr', billable: true },
  {
    code: 'BPS',
    cpt: '90791',
    unresolved: null,
    label: 'Biopsychosocial evaluation',
    hours: '1–2 hours',
    billable: true,
  },
  {
    code: 'CM',
    cpt: null,
    unresolved: 'no code in the legend',
    label: 'Case management',
    hours: null,
    billable: false,
  },
  {
    code: 'N/B',
    cpt: null,
    unresolved: 'not a billable service',
    label: 'Not billable — reason required',
    hours: null,
    billable: false,
  },
];

/** What a render site shows where the code goes: the code, or why there isn't one. */
export function codeOrReason(m: CodeMeaning): string {
  return m.cpt ?? m.unresolved ?? '';
}

const BY_CODE = new Map(CODE_LEGEND.map((c) => [c.code.toUpperCase(), c]));

export function meaningFor(code: string): CodeMeaning | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

/** Tooltip text for a day chip. Falls back to the raw code rather than inventing a meaning. */
export function codeTitle(code: string): string {
  const m = meaningFor(code);
  if (!m) return code;
  const parts = [m.label, codeOrReason(m), m.hours].filter(Boolean);
  return `${m.code} — ${parts.join(' · ')}`;
}

/**
 * The week-status vocabulary, verbatim from the workbook's section headers. READ-ONLY in
 * this PR: the grid shows which bucket a week sits in, and nothing here can be changed
 * until the persistence PR gives these a home.
 *
 * ⚠ There is no way to DERIVE these from a Kipu export — they are billing-workflow state a
 * human sets, not anything the engine computes. Until they persist, every imported week
 * renders as `unset`, and that is honest rather than a guess.
 */
export const WEEK_STATUSES = ['NEEDS BILLED', 'AUTH PENDING/HOLD', 'TERMED', 'ANTHEM OP SCA'] as const;
export type WeekStatus = (typeof WEEK_STATUSES)[number];
