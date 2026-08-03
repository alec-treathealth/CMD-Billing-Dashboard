/**
 * Coding decision REGISTRY — pure SQL builders + the payer-family normalizer (Phase A of
 * qualify-v2-build-plan §4). The registry is the repo's FIRST editable write surface: reads run as
 * claims_reader (SELECT granted in 0077); writes run as the narrow `coding_editor` role through the
 * builders below — never claims_admin, never the service key.
 *
 * NON-PHI BY DESIGN: payer families, facility codes, HCPCS/rev codes, dates, lifecycle, prose rules.
 * No member, no patient, no dollar amounts. That is what lets registry contents reach an LLM prompt
 * (Phase H) and be edited without an audit-reveal path. Keep it that way.
 *
 * MATCHING MODEL (factor v1): rollup `primary_payer` labels are messy free text; the registry keys on
 * a small payer FAMILY vocabulary (the sheet's own blocks). normalizePayerFamily maps label → family
 * with ordered pattern rules; the factor lookup then matches (family, facility_code), preferring a
 * row whose level_of_care matches the facility's care_setting when both are known. Level-of-care
 * inference from revenue codes is DELIBERATELY NOT encoded (plan §8.3 — unconfirmed with billing).
 */

export const CODING_DECISION_TABLE = 'coding.code_decision';
export const CODING_AUDIT_TABLE = 'coding.code_decision_audit';

/** The Test-Status lifecycle enum, verbatim from the sheet (mirrors ratingV2.CodingLifecycle —
 *  src/ must not import from app/, so the literal list is restated; test/codingRegistry.test.ts
 *  asserts the two stay in lockstep). */
export const CODING_LIFECYCLE_VALUES = [
  'CONFIRMED CODES',
  'FINALIZED CODES',
  'CONTINUE TESTS',
  'OPEN TEST',
  'UPCOMING TEST',
  'CLOSED',
  'DISCONTINUED',
  'DISCONTINUE - DID NOT WORK',
] as const;
export type CodingLifecycleValue = (typeof CODING_LIFECYCLE_VALUES)[number];

/** One CURRENT registry row (effective_to is null). Explicit projection — never SELECT *. */
export interface CodingDecisionRow {
  id: number;
  payer_family: string;
  payer_variant_label: string | null;
  plan_alpha: string | null;
  employer_norm: string | null;
  level_of_care: string | null; // 'DTX'|'RTC'|'IP'|'IOP'|'OP' (free text by design; UI constrains)
  facility_code: string | null;
  hcpcs_code: string | null; // null when suppressed
  revenue_code: string;
  hcpcs_suppressed: boolean;
  dos_batch_min: number | null;
  dos_batch_max: number | null;
  type_of_bill: string | null;
  drg_code: string | null;
  condition_codes: string[] | null;
  modifiers_removed: string[] | null;
  units_per_dos: number | null;
  billing_span: string | null; // 'admit_dc' | 'interim'
  lifecycle: string;
  decided_on: string; // ISO date
  effective_from: string;
  effective_to: string | null;
  superseded_by: number | null;
  notes: string | null;
}

const DECISION_COLUMNS =
  'id, payer_family, payer_variant_label, plan_alpha, employer_norm, level_of_care, facility_code, ' +
  'hcpcs_code, revenue_code, hcpcs_suppressed, dos_batch_min, dos_batch_max, type_of_bill, drg_code, ' +
  'condition_codes, modifiers_removed, units_per_dos, billing_span, lifecycle, ' +
  "to_char(decided_on, 'YYYY-MM-DD') as decided_on, " +
  "to_char(effective_from, 'YYYY-MM-DD') as effective_from, " +
  "to_char(effective_to, 'YYYY-MM-DD') as effective_to, " +
  'superseded_by, notes';

/** All CURRENT decisions (effective_to is null), whole table — the registry is ~50 rows by design,
 *  so the factor lookup loads once per request and matches in code. Deterministic order. */
export function buildCurrentCodingDecisionsQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      `select ${DECISION_COLUMNS} from ${CODING_DECISION_TABLE} ` +
      'where effective_to is null ' +
      'order by payer_family, facility_code nulls last, level_of_care nulls last, id',
    params: [],
  };
}

/** Full history for the registry UI (current + superseded), newest first, bounded. */
export function buildCodingDecisionHistoryQuery(limit = 500): { sql: string; params: unknown[] } {
  const lim = Math.max(1, Math.min(2000, Math.trunc(limit)));
  return {
    sql:
      `select ${DECISION_COLUMNS} from ${CODING_DECISION_TABLE} ` +
      `order by (effective_to is null) desc, decided_on desc, id desc limit $1`,
    params: [lim],
  };
}

/** INSERT one decision. Values are $n params; RETURNING id for the audit row + supersede linkage. */
export function buildInsertCodingDecisionQuery(d: {
  payer_family: string;
  payer_variant_label: string | null;
  plan_alpha: string | null;
  employer_norm: string | null;
  level_of_care: string | null;
  facility_code: string | null;
  hcpcs_code: string | null;
  revenue_code: string;
  hcpcs_suppressed: boolean;
  dos_batch_min: number | null;
  dos_batch_max: number | null;
  type_of_bill: string | null;
  drg_code: string | null;
  condition_codes: string[] | null;
  modifiers_removed: string[] | null;
  units_per_dos: number | null;
  billing_span: string | null;
  lifecycle: string;
  decided_on: string;
  effective_from: string;
  notes: string | null;
  /** Operator identity (app-user email or the seed script's --actor) — created_by is NOT NULL. */
  created_by: string;
}): { sql: string; params: unknown[] } {
  const params: unknown[] = [
    d.payer_family,
    d.payer_variant_label,
    d.plan_alpha,
    d.employer_norm,
    d.level_of_care,
    d.facility_code,
    d.hcpcs_code,
    d.revenue_code,
    d.hcpcs_suppressed,
    d.dos_batch_min,
    d.dos_batch_max,
    d.type_of_bill,
    d.drg_code,
    d.condition_codes,
    d.modifiers_removed,
    d.units_per_dos,
    d.billing_span,
    d.lifecycle,
    d.decided_on,
    d.effective_from,
    d.notes,
    d.created_by,
  ];
  const sql =
    `insert into ${CODING_DECISION_TABLE} ` +
    '(payer_family, payer_variant_label, plan_alpha, employer_norm, level_of_care, facility_code, ' +
    'hcpcs_code, revenue_code, hcpcs_suppressed, dos_batch_min, dos_batch_max, type_of_bill, drg_code, ' +
    'condition_codes, modifiers_removed, units_per_dos, billing_span, lifecycle, decided_on, effective_from, notes, created_by) ' +
    'values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::date,$20::date,$21,$22) ' +
    'returning id';
  return { sql, params };
}

/** SUPERSEDE: close the old row (effective_to = the new row's effective_from, superseded_by = new id).
 *  Never a destructive UPDATE of the decision fields — history is the point (§4: "change history does
 *  not exist and is already lost" in the sheet; the DB owns versioning). */
export function buildSupersedeCodingDecisionQuery(
  oldId: number,
  newId: number,
  effectiveFrom: string,
): { sql: string; params: unknown[] } {
  return {
    sql:
      `update ${CODING_DECISION_TABLE} ` +
      'set effective_to = $3::date, superseded_by = $2 ' +
      'where id = $1 and effective_to is null ' +
      'returning id',
    params: [oldId, newId, effectiveFrom],
  };
}

/** Append one audit row (who/what/when/before/after). `before`/`after` are JSON snapshots of the
 *  non-PHI decision fields; actor is the app user's email (already non-PHI operator identity). */
export function buildInsertCodingAuditQuery(entry: {
  decision_id: number;
  actor_email: string;
  action: 'create' | 'supersede' | 'lifecycle';
  before: unknown | null;
  after: unknown | null;
}): { sql: string; params: unknown[] } {
  return {
    sql:
      `insert into ${CODING_AUDIT_TABLE} (decision_id, actor_email, action, before_state, after_state) ` +
      'values ($1, $2, $3, $4::jsonb, $5::jsonb)',
    params: [
      entry.decision_id,
      entry.actor_email,
      entry.action,
      entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === null ? null : JSON.stringify(entry.after),
    ],
  };
}

// ── Payer-family normalization (label → registry family) ────────────────────────────────────────

/** The registry's payer-family vocabulary (the sheet's own blocks + the majors in the book). */
export const CODING_PAYER_FAMILIES = [
  'BCBS',
  'CIGNA',
  'UHC/UMR/OPTUM',
  'AETNA',
  'GEHA',
  'HIGHMARK',
  'HEALTH NET',
  'MAGELLAN',
  'KAISER',
  'HUMANA',
  'TRICARE',
  'MERITAIN',
] as const;
export type CodingPayerFamily = (typeof CODING_PAYER_FAMILIES)[number];

/** Ordered pattern rules — FIRST match wins, so more specific families must precede broader ones
 *  (MERITAIN is Aetna-owned but the sheet treats it as its own block; GEHA before the UHC catch-alls
 *  because GEHA plans are UHC-networked and labels sometimes carry both). */
const FAMILY_RULES: ReadonlyArray<readonly [CodingPayerFamily, RegExp]> = [
  ['MERITAIN', /MERITAIN/i],
  ['GEHA', /\bGEHA\b/i],
  ['UHC/UMR/OPTUM', /UNITED\s*HEALTH|\bUHC\b|\bUMR\b|OPTUM|\bUBH\b|OXFORD/i],
  ['HIGHMARK', /HIGHMARK/i],
  ['BCBS', /BLUE\s*CROSS|BLUE\s*SHIELD|\bBCBS\w*\b|\bBC\s*BS\b|ANTHEM|CAREFIRST|\bFEP\b|WELLMARK|PREMERA|REGENCE|EMPIRE\s+BLUE/i],
  ['CIGNA', /CIGNA|EVERNORTH/i],
  ['AETNA', /AETNA/i],
  ['HEALTH NET', /HEALTH\s*NET|\bMHN\b/i],
  ['MAGELLAN', /MAGELLAN/i],
  ['KAISER', /KAISER/i],
  ['HUMANA', /HUMANA/i],
  ['TRICARE', /TRICARE|TRIWEST/i],
];

/** Map a rollup primary_payer label to its registry family; null when no rule matches (the factor
 *  then reads "no decision on file" honestly rather than guessing a family). Pure + total. */
export function normalizePayerFamily(primaryPayer: string | null | undefined): CodingPayerFamily | null {
  if (typeof primaryPayer !== 'string') return null;
  const label = primaryPayer.trim();
  if (label === '') return null;
  for (const [family, re] of FAMILY_RULES) {
    if (re.test(label)) return family;
  }
  return null;
}

/** The factor lookup: best CURRENT decision for (payer label, facility_code, care_setting).
 *  Preference order: facility+LOC exact → facility (LOC-agnostic row) → null. A registry row with a
 *  NULL facility_code is a payer-wide default and matches any facility (lowest preference).
 *  care_setting 'BOTH' matches any LOC row. Pure — rows come from buildCurrentCodingDecisionsQuery. */
export function lookupCodingDecision(
  rows: CodingDecisionRow[],
  primaryPayer: string | null,
  facilityCode: string | null,
  careSetting: 'IP' | 'OP' | 'BOTH' | null,
): CodingDecisionRow | null {
  const family = normalizePayerFamily(primaryPayer);
  if (!family) return null;
  const fam = rows.filter((r) => r.payer_family.toUpperCase() === family && r.effective_to === null);
  if (fam.length === 0) return null;
  const locMatches = (loc: string | null): boolean => {
    if (loc === null || careSetting === null || careSetting === 'BOTH') return true;
    const ip = ['DTX', 'RTC', 'IP'];
    return careSetting === 'IP' ? ip.includes(loc.toUpperCase()) : !ip.includes(loc.toUpperCase());
  };
  const scored = fam
    .map((r) => {
      const facExact = facilityCode !== null && r.facility_code !== null && r.facility_code === facilityCode;
      const facWild = r.facility_code === null;
      if (!facExact && !facWild) return null;
      const loc = locMatches(r.level_of_care);
      // Preference: exact facility + LOC = 3 · exact facility (LOC mismatch tolerated — the
      // facility-specific decision wins even when its LOC tag disagrees with our care_setting
      // resolution, which is itself a crosswalk guess) = 2 · payer-wide + LOC-compatible = 1.
      // A payer-wide row whose level_of_care CONTRADICTS the facility's care setting is NOT a
      // match — an OP facility must never be rated on an RTC/DTX-only default (review finding #2;
      // the §8.3 LOC-inference question stays open, but exclusion is the safe side of it).
      if (!facExact && !loc) return null;
      const score = (facExact ? 2 : 0) + (loc ? 1 : 0);
      return { r, score };
    })
    .filter((x): x is { r: CodingDecisionRow; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || Date.parse(b.r.decided_on) - Date.parse(a.r.decided_on));
  return scored[0]?.r ?? null;
}

/** Human codes label for the factor detail: 'H0017 / 0158', 'NO HCPCS / 1001' (suppression is a
 *  billing METHOD, not a missing value — §4), or just the rev code. */
export function codingCodesLabel(row: Pick<CodingDecisionRow, 'hcpcs_code' | 'revenue_code' | 'hcpcs_suppressed'>): string {
  if (row.hcpcs_suppressed) return `NO HCPCS / ${row.revenue_code}`;
  if (row.hcpcs_code) return `${row.hcpcs_code} / ${row.revenue_code}`;
  return row.revenue_code;
}
