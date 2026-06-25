/**
 * Facility dimension reader (read-only, non-PHI) — the canonical facility_code ->
 * { facility_name, care_setting (IP/OP), display_acronym } map for the Master BXR
 * chart's IP/OP split, Facility(IP)/Facility(OP) filters, and acronym bar labels.
 *
 * Reads ONLY collections.facilities (the non-PHI reference table) as claims_reader.
 * care_setting / display_acronym come from migration 0016 (seeded to mirror
 * config.ts DEPOSIT_FACILITIES). A facility not in the canonical set has a NULL
 * care_setting (treated as "Other" upstream — never guessed). Identifiers are FIXED
 * literals; no parameters. Emits one lightweight non-PHI audit line.
 */
import type { Expect, HasNoPhiKey } from '../queries/types.js';
import type { CollectionsQueryContext } from './daily.js';

/** Inpatient / Outpatient, or null when a facility is outside the canonical set. */
export type CareSetting = 'IP' | 'OP';

/** One facility's non-PHI dimension row. */
export interface FacilityDimensionRow {
  facility_code: string;
  facility_name: string;
  /** 'IP' | 'OP' | null (null = unclassified / "Other"). */
  care_setting: CareSetting | null;
  /** Display acronym (e.g. 'DLMH', 'TMH CA'); null when unseeded. */
  display_acronym: string | null;
}

/** The parameterized-free SQL. Exposed so the fixture can assert the exact string. */
export function facilityDimensionSql(): string {
  return (
    `select facility_code, facility_name, care_setting, display_acronym ` +
    `from collections.facilities ` +
    `order by care_setting nulls last, display_acronym nulls last, facility_code`
  );
}

interface RawRow {
  facility_code: string;
  facility_name: string;
  care_setting: string | null;
  display_acronym: string | null;
}

const asCareSetting = (v: string | null): CareSetting | null => (v === 'IP' || v === 'OP' ? v : null);

export async function facilityDimension(ctx: CollectionsQueryContext): Promise<FacilityDimensionRow[]> {
  const { rows } = await ctx.executor.query<RawRow>(facilityDimensionSql(), []);
  const out: FacilityDimensionRow[] = rows.map((r) => ({
    facility_code: r.facility_code,
    facility_name: r.facility_name,
    care_setting: asCareSetting(r.care_setting),
    display_acronym: r.display_acronym,
  }));
  emitAudit(ctx, { facilities: out.length });
  return out;
}

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function emitAudit(ctx: CollectionsQueryContext, shape: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    event: 'facility_dimension',
    created_by: ctx.createdBy,
    args_shape: shape,
  });
  (ctx.audit ?? stdoutAudit)(line);
}

// Compile-time proof the row carries no PHI key (defense in depth).
export type _FacilityDimensionNoPhi = Expect<HasNoPhiKey<FacilityDimensionRow>>;
