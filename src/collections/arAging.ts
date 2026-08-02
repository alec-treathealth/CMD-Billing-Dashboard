/**
 * AR aging read builders over collections.cmd_charge_census.
 *
 * PURE / transport-agnostic (docs/CLAUDE.md §3.1): these return { text, values } for a parameterized
 * query — no pool, no env, no secrets, no PHI decrypt. The composition root (app/lib/server.ts) runs
 * them against the reader pool with the caller's entity array and decrypts any PHI per app/lib/phi.ts.
 *
 * AGE is derived at read time (Phase 0, docs/veris-data-notes.md 2026-07-28): the census carries no
 * `Charge Fromdate Age` column, but charge_date (a real DATE, from "Charge From Date") is ingested, so
 * age-in-days = ($asOf::date - charge_date) and the bucket CASE below mirrors src/collections/ageBucket.ts
 * EXACTLY (same 8 CMD-verbatim labels, same day boundaries — day 30 → 'a', etc.). Keep the two in sync.
 *
 * TENANCY (§3.5): reads are cross-tenant and scope APP-SIDE via `business_entity_id = any($1::uuid[])`
 * with the GUC UNSET (a GUC-scoped reader policy returns zero rows). The reader policy is USING (true).
 *
 * FACILITY: the census stores facility as the raw CMD name text. This builder returns that raw name and
 * does NOT join collections.cmd_facility_aliases — deliberately, until the Teen MH TX repoint lands
 * (Phase 0.1 = separate entity; the 0042 alias currently folds Teen TX → TREAT_TX). When a facility_code
 * join is added it MUST be a LEFT JOIN ('No Facility' / unmapped names resolve to 'Other', never dropped).
 */

/** Positional-param SQL. Matches the pg driver's { text, values } call shape. */
export interface ParamQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * The age-bucket CASE, in terms of a day-difference SQL expression. Mirrors ageBucket.ts:
 * NULL date → NULL; negative age (future service date) → NULL; then the 8 contiguous CMD bands.
 */
function ageBucketCaseSql(ageDaysExpr: string): string {
  return (
    `case ` +
    `when charge_date is null then null ` +
    `when ${ageDaysExpr} < 0 then null ` +
    `when ${ageDaysExpr} <= 30 then 'a) Less than 30 days' ` +
    `when ${ageDaysExpr} <= 60 then 'b) 31 to 60 days' ` +
    `when ${ageDaysExpr} <= 90 then 'c) 61 to 90 days' ` +
    `when ${ageDaysExpr} <= 120 then 'd) 91 to 120 days' ` +
    `when ${ageDaysExpr} <= 150 then 'e) 121 to 150 days' ` +
    `when ${ageDaysExpr} <= 180 then 'f) 151 to 180 days' ` +
    `when ${ageDaysExpr} <= 365 then 'g) 181 to 365 days' ` +
    `else 'h) Over 1 year' end`
  );
}

/**
 * Phase 1e data-quality / distribution query: rows + distinct-charges + $ per (facility, age_bucket),
 * entity-scoped. NON-PHI (no patient columns). Purpose-built for the census's first-ever read gate:
 *   • row count per (facility, bucket) vs. Alec's export distribution,
 *   • FAN-OUT proof: charges == distinct_charges confirms the (business_entity_id, charge_id) UPSERT grain
 *     collapsed the ~6× export fan-out (§2.5). A gap means the grain leaked — investigate before UI.
 *   • 'No Facility' surfaces as its own row (facility text is null/‘No Facility’), never silently dropped.
 *
 * @param entityIds tenant uuids (e.g. [BXR]). asOf drives the age math; the caller passes "today".
 */
export function buildArAgingDistributionQuery(entityIds: readonly string[], asOf: string): ParamQuery {
  const ageExpr = '($2::date - charge_date)';
  const text =
    `select facility, ` +
    `${ageBucketCaseSql(ageExpr)} as age_bucket, ` +
    `count(*)::int as charges, ` +
    `count(distinct charge_id)::int as distinct_charges, ` +
    `count(*) filter (where charge_date is null)::int as null_date_charges, ` +
    `coalesce(sum(charge_amount), 0)::numeric(14,2) as charge_amount_sum ` +
    `from collections.cmd_charge_census ` +
    `where business_entity_id = any($1::uuid[]) ` +
    `group by facility, age_bucket ` +
    `order by facility nulls first, age_bucket nulls last`;
  return { text, values: [entityIds, asOf] };
}

export interface ArAgingWorklistOpts {
  readonly entityIds: readonly string[];
  /** As-of date (ISO 'YYYY-MM-DD') for the age math. */
  readonly asOf: string;
  /** Optional exact facility-name filter (raw census name). Omit for book-wide. */
  readonly facility?: string;
  /** Keyset cursor: return rows strictly older-position than this (charge_date, charge_id). */
  readonly after?: { readonly chargeDate: string | null; readonly chargeId: string };
  /** Page size (bounded input — always cap at the call site). */
  readonly limit: number;
}

/**
 * The worklist read: entity-scoped open charges, OLDEST FIRST (charge_date asc, unknown-age last),
 * keyset-paginated (§3.8 — never OFFSET) with charge_id as the tiebreaker. Backed by 0071's
 * (business_entity_id, charge_date, charge_id) index.
 *
 * PHI: selects patient_name / member_id / group_number as the RAW bytea ciphertext — the composition
 * root decrypts + masks (app/lib/phi.ts), never this layer. No plaintext identifier is selected.
 *
 * NOTE — "open": the census has no balance column (Phase 0.3), so this does NOT filter to an outstanding
 * balance. It returns all charges (the aging denominator). Refining to genuinely-open AR (by
 * claim_status_category, or a balance feed) is a Phase 2 decision — left explicit rather than guessed.
 */
export function buildArAgingWorklistQuery(opts: ArAgingWorklistOpts): ParamQuery {
  const { entityIds, asOf, facility, after, limit } = opts;
  const values: unknown[] = [entityIds, asOf];
  const conds: string[] = ['business_entity_id = any($1::uuid[])'];

  if (facility !== undefined) {
    values.push(facility);
    conds.push(`facility = $${values.length}`);
  }

  // Keyset: (charge_date asc nulls last, charge_id asc). Rows with a known date page before null-date
  // rows; within a date, charge_id breaks ties. The null-date tail pages by charge_id alone.
  if (after !== undefined) {
    if (after.chargeDate === null) {
      values.push(after.chargeId);
      conds.push(`(charge_date is null and charge_id > $${values.length})`);
    } else {
      values.push(after.chargeDate);
      const dParam = values.length;
      values.push(after.chargeId);
      const idParam = values.length;
      conds.push(
        `(charge_date is null ` + // null-date rows always come after any dated cursor
          `or charge_date > $${dParam} ` +
          `or (charge_date = $${dParam} and charge_id > $${idParam}))`,
      );
    }
  }

  values.push(limit);
  const limitParam = values.length;

  const text =
    `select charge_id, charge_date, ` +
    `($2::date - charge_date) as age_days, ` +
    `${ageBucketCaseSql('($2::date - charge_date)')} as age_bucket, ` +
    `facility, primary_payer, charge_amount, claim_status_raw, claim_status_category, ` +
    `patient_name, member_id, group_number ` + // raw ciphertext — decrypted/masked at the composition root
    `from collections.cmd_charge_census ` +
    `where ${conds.join(' and ')} ` +
    `order by charge_date asc nulls last, charge_id asc ` +
    `limit $${limitParam}`;

  return { text, values };
}
