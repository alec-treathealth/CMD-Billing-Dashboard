/**
 * TMH CALIFORNIA claim-code legend — the biller's mapping from a grid DAY CODE to the
 * CPT/HCPCS that gets submitted for it.
 *
 * ⚠ THIS IS A SEED AND A SURFACE. NOTHING CONSUMES IT YET. No caller emits these codes into
 * the grid, the DTO, a claim, or any other output, and adding one is a separate, ruled
 * decision — not a follow-on refactor. What this file buys today is that the mapping the
 * billers actually work from is IN THE REPO, diffable, and states what it does not know.
 *
 * ── WHY A TYPESCRIPT MODULE AND NOT A TABLE ────────────────────────────────────────────────
 * This is biller-owned reference data, and the repo already has a settled shape for that:
 * `src/collections/cmdCustomers.ts` holds the CMD customer roster the business owner confirms,
 * and `src/kipu/locations.ts` holds the hand-kept Kipu location registry — both are typed
 * modules whose headers carry the owner, the evidence and the exclusion rationale, and both
 * are revised by editing a literal. A migration was considered and rejected: this data is six
 * rows, changes when a PAYER changes its rules rather than when the schema does, needs to be
 * reviewable in a diff by the person who owns it, and has no reader to serve. CLAUDE.md gates
 * every migration behind a human apply for good reason; spending that gate on six rows nothing
 * queries would buy latency and an apply step and lose the diff.
 *
 * ── OWNER AND VINTAGE ──────────────────────────────────────────────────────────────────────
 * Owner:   the TMH billing team. ⚠ A ROLE, NOT A PERSON, because the individual's name was not
 *          recorded when this was seeded and inventing one would be worse than admitting it.
 *          Replace with the named owner when Alec says who — that is the whole point of the
 *          field, and a role cannot be asked to ratify a change.
 * Source:  the manual weekly workbook for TMH CA, August 2026 (four weekly tabs) — the same
 *          artifact `app/components/billing-audit/billable-days/legend.ts` transcribes its
 *          DISPLAY vocabulary from.
 * As of:   the workbook is August 2026; seeded here 2026-08-30.
 *
 * ⚠ THE WORKBOOK ITSELF IS PHI AND IS NOT IN THIS REPO, IN ANY FORM. It carries real patient
 * names, insurers and clinical notes. Six legend lines and the observation COUNTS below are
 * all that crossed over. No patient name, no payer-to-patient association and no note text is
 * here, and none may be added — including as a test fixture. See the payer note on `I`.
 *
 * ── CALIFORNIA ONLY, AND THE SCOPE KEY IS ITSELF AN OPEN QUESTION ──────────────────────────
 * Only CA is seeded. Whether this legend is per-STATE, per-FACILITY or per-PAYER is unresolved
 * with the biller, so `claimCodeFor` REFUSES every other scope with a flag instead of falling
 * back to CA — a legend that quietly generalised to Texas would be a guess wearing a lookup's
 * clothes. The key is the USPS state on `KipuLocation.state` (`src/kipu/locations.ts`), which
 * is where CA already means `TREAT_CA` / Kipu location 36.
 *
 * ── WHY KIPU CANNOT SUPPLY THIS ────────────────────────────────────────────────────────────
 * Measured, not assumed. `GET /api/group_sessions` returns 200 with the billing fields PRESENT
 * BUT EMPTY on every row, at two different locations in two probes:
 *   · Texas   (location 2),  week 2026-08-17..23:  billing_codes, selected_billing_code,
 *     place_of_service, billable_claim_format, ancillary — value on 0/16 rows.
 *   · CALIFORNIA (location 36), week 2026-08-17..23: the same five fields, value on 0/16 rows
 *     (probed 2026-08-30; pagination.total_records=16, so the window is whole, not truncated).
 * That is the same hole `/api/care_levels` has. Two locations in different states rule out a
 * per-location configuration gap, so the source has no codes to give and this seed is the only source.
 *
 * ⚠ `billable` IS POPULATED AND USELESS: true on 16/16 in CA and 65/65 in Texas — CONSTANT, so
 * it cannot discriminate anything. A presence check would have read that as good news, which
 * is exactly why the probe reports value DISTRIBUTIONS rather than presence.
 */
import type { KipuLocation } from './locations.js';

/**
 * Why a day code has no submittable claim code. Each is a NAMED, individually testable
 * reason — the same fail-loud-by-flag posture as `LocConfigEntry.ambiguous` in
 * `./assumptions.ts` and `locationFor`'s undefined-means-unmapped contract in
 * `./locations.ts`. A guessed cap flags a row for review; a guessed HCPCS bills a claim, so
 * there is no defaulting anywhere in this file.
 */
export type ClaimCodeFlag =
  /** The legend offers alternates and no rule for choosing between them. See `I`. */
  | 'claim-code-ambiguous'
  /** The legend names the service and gives it no code at all. See `CM`. */
  | 'claim-code-absent'
  /** The day code is not in this scope's legend. Unknown, never defaulted. */
  | 'claim-code-unknown'
  /** The scope (state) has no seeded legend. CA is the only one that does. */
  | 'claim-code-scope-unseeded';

export interface ClaimCodeEntry {
  /** The grid day code, exactly as `src/kipu/computeRow.ts` emits it. Matched case-folded. */
  readonly dayCode: string;
  /** What the workbook calls the service. */
  readonly label: string;
  /** The single submittable code, or `null` when the legend does not resolve to one. */
  readonly code: string | null;
  /**
   * Codes the legend or the observed record offers when `code` is null. RECORD ONLY — never a
   * candidate list to pick from, and no caller may treat the first entry as a default.
   */
  readonly alternates?: readonly string[];
  /** The workbook's expected duration, verbatim. */
  readonly hours: string | null;
  /** True when this entry does not resolve. Mirrors `LocConfigEntry.ambiguous`. */
  readonly ambiguous?: boolean;
  /** Required whenever `ambiguous` is true. Absent on a resolved entry. */
  readonly flag?: ClaimCodeFlag;
}

/**
 * California, from the August 2026 workbook's legend block. SIX lines were transcribed; three
 * resolve and two do not, and the sixth is not a mapping at all (see below).
 *
 * ⚠ THE KEY IS THE DAY CODE, NOT THE LEVEL OF CARE. The grid already emits these codes
 * (`BILLABLE_CODES` / `CODE_ORDER` in `./computeRow.ts`), so keying on them is what makes this
 * legend joinable to something real. Keying on LOC would have required inventing a mapping the
 * workbook does not contain.
 */
export const CA_CLAIM_CODES: readonly ClaimCodeEntry[] = [
  /**
   * ⚠ `I` IS DELIBERATELY UNRESOLVED, AND MUST STAY THAT WAY UNTIL THE BILLER RULES.
   *
   * The legend prints "S9480 / H0015" — two alternates, no selection rule. In practice neither
   * of those is even the common case, and the code that actually ships varies by payer and is
   * recorded in a FREE-TEXT NOTES COLUMN rather than a field. Observed across all four August
   * weekly tabs, as counts only:
   *     S9480  10   ·   H2013  21   ·   H2019  29   ·   H2020  20
   * Two things that record settles, both of them against resolving this:
   *   1. PAYER IS NOT SUFFICIENT. One payer alone accounts for occurrences of all three of
   *      H2013/H2019/H2020, so even a complete payer→code matrix would not be a function.
   *   2. H2020 — the third most common code in practice, 20 occurrences — DOES NOT APPEAR IN
   *      THE LEGEND AT ALL. The legend is therefore known-incomplete, not merely ambiguous, so
   *      picking either printed alternate would be wrong most of the time.
   * The payer→HCPCS matrix is explicitly NOT built here: it is blocked on the biller explaining
   * that one payer's three-way split, and the payer labels in the source are themselves
   * inconsistent (two spellings of the same plan appear). Normalising them is Alec's call.
   *
   * No payer name appears in this file: the counts above are per-CODE totals only, so nothing
   * here associates a payer with a patient, and the per-payer breakdown stays out of the repo.
   */
  {
    dayCode: 'I',
    label: 'Intensive outpatient',
    code: null,
    alternates: ['S9480', 'H0015', 'H2013', 'H2019', 'H2020'],
    hours: '3 hours',
    ambiguous: true,
    flag: 'claim-code-ambiguous',
  },
  { dayCode: 'G', label: 'Group therapy', code: '90853', hours: '1 hr' },
  { dayCode: 'T', label: 'Individual therapy', code: '90837', hours: '1 hr' },
  { dayCode: 'BPS', label: 'Biopsychosocial evaluation', code: '90791', hours: '1–2 hours' },
  /**
   * `CM` is in the legend as a service and carries NO code. That is the legend's own state, not
   * a transcription gap — so it is seeded as explicitly absent rather than omitted. Omitting it
   * would make it indistinguishable from a code nobody has looked at yet.
   */
  {
    dayCode: 'CM',
    label: 'Case management',
    code: null,
    hours: null,
    ambiguous: true,
    flag: 'claim-code-absent',
  },
  /**
   * The workbook's sixth legend line is "Various CPT Codes with Other Service". It is a
   * CATCH-ALL SENTENCE, not a mapping — there is no day code on its left and no code on its
   * right — so it is recorded here in prose and seeded as nothing. Turning it into an entry
   * would manufacture a mapping the biller never wrote.
   */
];

const BY_DAY_CODE = new Map(CA_CLAIM_CODES.map((e) => [e.dayCode.toUpperCase(), e]));

/** The scopes with a seeded legend. CA only, on purpose — see the header. */
export const SEEDED_CLAIM_CODE_SCOPES: readonly string[] = ['CA'];

export type ClaimCodeResolution =
  | { readonly resolved: true; readonly code: string; readonly entry: ClaimCodeEntry }
  | {
      readonly resolved: false;
      readonly code: null;
      readonly flag: ClaimCodeFlag;
      readonly entry?: ClaimCodeEntry;
      readonly alternates?: readonly string[];
    };

/**
 * The only reader. Returns a submittable code ONLY when the legend resolves to exactly one;
 * every other outcome is an explicit flag with `code: null`.
 *
 * ⚠ THERE IS NO DEFAULT AND NO FALLBACK SCOPE. An unseeded state does not fall back to CA, and
 * an unknown day code does not fall back to anything — both flag, the same way an unmapped
 * Kipu label stops the pipeline in `./locations.ts` rather than being folded into a neighbour.
 * A caller that wants a code must handle `resolved: false`; it can never receive a guess.
 *
 * `scope` takes `KipuLocation['state']` so the caller passes the state off the location
 * registry rather than a literal it typed itself.
 */
export function claimCodeFor(scope: KipuLocation['state'], dayCode: string): ClaimCodeResolution {
  if (!SEEDED_CLAIM_CODE_SCOPES.includes(scope.trim().toUpperCase())) {
    return { resolved: false, code: null, flag: 'claim-code-scope-unseeded' };
  }
  const entry = BY_DAY_CODE.get(dayCode.trim().toUpperCase());
  if (!entry) return { resolved: false, code: null, flag: 'claim-code-unknown' };
  if (entry.code === null) {
    return {
      resolved: false,
      code: null,
      flag: entry.flag ?? 'claim-code-absent',
      entry,
      ...(entry.alternates ? { alternates: entry.alternates } : null),
    };
  }
  return { resolved: true, code: entry.code, entry };
}

/** Every day code this scope resolves to a single submittable code. Reporting/surfacing only. */
export function resolvedClaimCodes(scope: KipuLocation['state']): readonly ClaimCodeEntry[] {
  if (!SEEDED_CLAIM_CODE_SCOPES.includes(scope.trim().toUpperCase())) return [];
  return CA_CLAIM_CODES.filter((e) => e.code !== null);
}

/** Every day code the legend names but cannot resolve, with its reason. Surfacing only. */
export function unresolvedClaimCodes(scope: KipuLocation['state']): readonly ClaimCodeEntry[] {
  if (!SEEDED_CLAIM_CODE_SCOPES.includes(scope.trim().toUpperCase())) return [];
  return CA_CLAIM_CODES.filter((e) => e.code === null);
}
