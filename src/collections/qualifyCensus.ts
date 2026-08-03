/**
 * Qualify Phase G — monday census AGGREGATION (pure logic + the sync's SQL builder). The I/O twin
 * (fetch + write) lives in qualifyCensusSync.ts; everything here is hermetically testable.
 *
 * THE PHI POSTURE, load-bearing: census board item NAMES are patient names. This module's input
 * shape (`CensusItem`) carries COLUMN VALUES ONLY — the fetch never requests the name field on a
 * census board, so patient identifiers never enter this process. Open beds are counted from the
 * Admit Status labels ('Open Bed (Male)' / '(Female)' / '(Either M/F)' — verified live 2026-08-03),
 * not from placeholder item names.
 *
 * COLUMN RESOLUTION BY TITLE, per board: monday mints per-board column IDs for the same logical
 * column ('Total Auth Days' has 10 distinct ids across 27 boards — the recon's trap #1), so any
 * id-keyed fetch silently loses data. Titles are the stable key; the resolver maps title → this
 * board's id, and the conformance report names every expected title a board lacks.
 *
 * TWO BOARD FAMILIES (recon: a clean split, not per-board chaos):
 *   residential (13): 'Admit Status' + 'Days in RTC' (+ 'Lost Auth Days', 'IQ')
 *   outpatient  (14): 'Status' + 'Days in OP' (no IQ)
 * 'Total Auth Days' / 'Next UR Date' / 'VOB Status' are universal across all 27.
 *
 * TENANCY (deliberate exception, PR #73 review): qualify_facility_census carries NO
 * business_entity_id — it is facility-grain, non-PHI ops data keyed by
 * collections.facilities.facility_code, and the facilities table itself is entity-less (verified
 * live 2026-08-03: the per-row tenant key exists on exactly the six DATA tables). Census values
 * only ever SURFACE joined to entity-scoped ranking rows in core.ts, and the Qualify surface is
 * deliberately cross-tenant (QUALIFY_TENANT_SCOPE). Migration 0079 restates this on the SQL side.
 */

export type CensusBoardFamily = 'residential' | 'outpatient';

export interface CensusBoardConfig {
  boardId: string;
  facilityCode: string; // collections.facilities.facility_code VERBATIM (mnemonic or 8-digit — the roster mixes both)
  family: CensusBoardFamily;
}

/** The curated board → facility map. VERIFIED boards only — extend via the CLI's --discover output
 *  (which lists the workspace's census boards so an operator can map the remaining ~25). Adding a
 *  row here is the entire onboarding for a facility's auth-fit factor. */
export const MONDAY_CENSUS_BOARDS: readonly CensusBoardConfig[] = [
  // facilityCode = collections.facilities.facility_code VERBATIM (roster-verified 2026-08-03).
  // These facilities are mnemonic-keyed in the roster — 'NASH'/'LSMH' — NOT 8-digit CMD ids; a code
  // the roster doesn't carry would make the auth-fit factor silently never match its facility.
  { boardId: '7422342993', facilityCode: 'NASH', family: 'residential' }, // Nashville MH Admissions Census
  { boardId: '8401390206', facilityCode: 'LSMH', family: 'residential' }, // Lonestar MH Admissions Census
];

/** The Facility Info board (facility-grain — item names are FACILITY names, not patients). */
export const MONDAY_FACILITY_INFO_BOARD = '7475219124';

/** Logical column titles per family. The resolver matches case-insensitively on trimmed titles. */
export const CENSUS_TITLES = {
  residential: { status: 'Admit Status', los: 'Days in RTC' },
  outpatient: { status: 'Status', los: 'Days in OP' },
  universal: { auth: 'Total Auth Days', ur: 'Next UR Date' },
} as const;

export interface BoardColumn {
  id: string;
  title: string;
}

export interface ResolvedCensusColumns {
  statusId: string | null;
  authId: string | null;
  losId: string | null;
  urId: string | null;
  /** Expected titles this board does NOT carry — the conformance report's raw material. */
  missing: string[];
}

/** Resolve a board's per-board column ids from its logical titles. Pure. */
export function resolveCensusColumns(columns: BoardColumn[], family: CensusBoardFamily): ResolvedCensusColumns {
  const byTitle = new Map(columns.map((c) => [c.title.trim().toLowerCase(), c.id]));
  const find = (title: string): string | null => byTitle.get(title.toLowerCase()) ?? null;
  const wanted = [
    CENSUS_TITLES[family].status,
    CENSUS_TITLES.universal.auth,
    CENSUS_TITLES[family].los,
    CENSUS_TITLES.universal.ur,
  ];
  const resolved = {
    statusId: find(CENSUS_TITLES[family].status),
    authId: find(CENSUS_TITLES.universal.auth),
    losId: find(CENSUS_TITLES[family].los),
    urId: find(CENSUS_TITLES.universal.ur),
  };
  const missing = wanted.filter((t) => !byTitle.has(t.toLowerCase()));
  return { ...resolved, missing };
}

/** One census item's RESOLVED column values (no name, no id — nothing patient-identifying). */
export interface CensusItem {
  status: string | null; // Admit Status / Status label text
  authDays: number | null; // Total Auth Days numeric
  losDays: number | null; // Days in RTC / Days in OP numeric (monday formula → text → parsed)
  urDate: string | null; // Next UR Date ISO 'YYYY-MM-DD'
}

export interface CensusAggregates {
  admittedCount: number;
  openBeds: number;
  avgAuthDays: number | null;
  avgLosDays: number | null;
  authSample: number;
  nextUrDate: string | null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Aggregate one board's items to the facility-grain row. Rules (recon-verified):
 *  - admitted = status label exactly 'Admitted'.
 *  - open beds = status label starting 'Open Bed' (never item names).
 *  - avg auth = over ADMITTED items with a real auth value (the plan's null-guard: monday's MINUS()
 *    blank-propagates rather than fabricating negatives, but the guard is cheap insurance).
 *  - avg LOS = over admitted items with a parseable LOS.
 *  - next UR = the SOONEST date on or after `today` across ALL items (a UR on a pending admit still
 *    matters); past dates never surface as "upcoming".
 */
export function aggregateCensusItems(items: CensusItem[], today: string): CensusAggregates {
  const admitted = items.filter((i) => (i.status ?? '').trim().toLowerCase() === 'admitted');
  const openBeds = items.filter((i) => (i.status ?? '').trim().toLowerCase().startsWith('open bed')).length;
  const withAuth = admitted.filter((i) => i.authDays !== null && Number.isFinite(i.authDays) && (i.authDays as number) > 0);
  const withLos = admitted.filter((i) => i.losDays !== null && Number.isFinite(i.losDays) && (i.losDays as number) >= 0);
  const upcoming = items
    .map((i) => i.urDate)
    .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today)
    .sort();
  return {
    admittedCount: admitted.length,
    openBeds,
    avgAuthDays: withAuth.length > 0 ? round2(withAuth.reduce((s, i) => s + (i.authDays as number), 0) / withAuth.length) : null,
    avgLosDays: withLos.length > 0 ? round2(withLos.reduce((s, i) => s + (i.losDays as number), 0) / withLos.length) : null,
    authSample: withAuth.length,
    nextUrDate: upcoming[0] ?? null,
  };
}

/** Conformance line for one board — which expected columns it lacks (empty = fully instrumented). */
export interface CensusConformance {
  boardId: string;
  facilityCode: string;
  family: CensusBoardFamily;
  missing: string[];
}

/** UPSERT one facility's aggregate row. Values are $n params; identifiers fixed literals. */
export function buildUpsertCensusRowQuery(row: {
  facility_code: string;
  board_id: string;
  board_family: CensusBoardFamily;
  admitted_count: number;
  open_beds: number | null;
  bed_capacity: number | null;
  avg_auth_days: number | null;
  avg_los_days: number | null;
  auth_sample: number;
  next_ur_date: string | null;
  business_entity_id: string;
}): { sql: string; params: unknown[] } {
  return {
    sql:
      'insert into collections.qualify_facility_census ' +
      '(business_entity_id, facility_code, board_id, board_family, admitted_count, open_beds, bed_capacity, avg_auth_days, avg_los_days, auth_sample, next_ur_date, synced_at) ' +
      'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, now()) ' +
      'on conflict (business_entity_id, facility_code) do update set ' +
      'board_id = excluded.board_id, board_family = excluded.board_family, admitted_count = excluded.admitted_count, ' +
      'open_beds = excluded.open_beds, bed_capacity = excluded.bed_capacity, avg_auth_days = excluded.avg_auth_days, ' +
      'avg_los_days = excluded.avg_los_days, auth_sample = excluded.auth_sample, next_ur_date = excluded.next_ur_date, ' +
      'synced_at = now()',
    params: [
      row.business_entity_id,
      row.facility_code,
      row.board_id,
      row.board_family,
      row.admitted_count,
      row.open_beds,
      row.bed_capacity,
      row.avg_auth_days,
      row.avg_los_days,
      row.auth_sample,
      row.next_ur_date,
    ],
  };
}

/** Read every facility's census aggregates (the rating factor's seam — tiny table, whole read). */
export function buildQualifyCensusReadQuery(businessEntityId: string): { sql: string; params: unknown[] } {
  return {
    sql:
      'select facility_code, avg_auth_days::float8 as avg_auth_days, avg_los_days::float8 as avg_los_days, ' +
      "to_char(next_ur_date, 'YYYY-MM-DD') as next_ur_date, open_beds " +
      'from collections.qualify_facility_census where business_entity_id = $1::uuid',
    params: [businessEntityId],
  };
}
