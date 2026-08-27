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
 */

export interface CodeMeaning {
  /** Chip text, exactly as the workbook writes it. */
  readonly code: string;
  /** CPT / HCPCS the workbook maps it to, or null where the workbook lists none. */
  readonly cpt: string | null;
  readonly label: string;
  /** The workbook's expected duration for the service. */
  readonly hours: string | null;
  readonly billable: boolean;
}

export const CODE_LEGEND: readonly CodeMeaning[] = [
  { code: 'I', cpt: 'S9480 / H0015', label: 'Intensive outpatient', hours: '3 hours', billable: true },
  { code: 'G', cpt: '90853', label: 'Group therapy', hours: '1 hr', billable: true },
  { code: 'T', cpt: '90837', label: 'Individual therapy', hours: '1 hr', billable: true },
  { code: 'BPS', cpt: '90791', label: 'Biopsychosocial evaluation', hours: '1–2 hours', billable: true },
  { code: 'CM', cpt: null, label: 'Case management', hours: null, billable: false },
  { code: 'N/B', cpt: null, label: 'Not billable — reason required', hours: null, billable: false },
];

const BY_CODE = new Map(CODE_LEGEND.map((c) => [c.code.toUpperCase(), c]));

export function meaningFor(code: string): CodeMeaning | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

/** Tooltip text for a day chip. Falls back to the raw code rather than inventing a meaning. */
export function codeTitle(code: string): string {
  const m = meaningFor(code);
  if (!m) return code;
  const parts = [m.label, m.cpt, m.hours].filter(Boolean);
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
