/**
 * Phase 6 collections — workbook list + facility mapping (single source of truth
 * in code; mirrors the seeded collections.facilities table). Sheet IDs are
 * canonical identifiers (not secrets), pinned from the verified Drive enumeration.
 *
 * Group codes (TREAT_FRCA / LSMH_DMH) are workbook LINEAGE only — never facilities.
 * Row-level facility_code is a REAL facility code or NULL.
 */
import type { Workbook } from './types.js';

/** The 10 primary Google Sheets (the "All Historical Reports" subfolder + the
 *  archived subfolders + the two .xlsx are deferred — not listed here). */
export const WORKBOOKS: readonly Workbook[] = [
  { code: 'CAMH', sheetId: '1_Xk7cVP7LzF1f5J093PNnNfwL9D2BpmdF8kJs3mFsX8', kind: 'single', facilityCode: 'CAMH' },
  { code: 'TBH', sheetId: '1sPtp_dXczTehGfucvX5pzPPWrNZZ5UmpkXKiLnnvkTk', kind: 'single', facilityCode: 'TBH' },
  { code: 'PCMH', sheetId: '1HedybZkE_kdVVQASNO1LioeUnSSExtOFttI9wibfoLY', kind: 'single', facilityCode: 'PCMH' },
  { code: 'LAMH', sheetId: '1Gawzrb0VsGCvNSc7VVvf41pwfLlIbMUAu4ITZdIOJe0', kind: 'single', facilityCode: 'LAMH' },
  { code: 'NASH', sheetId: '1FvdYoqYExR-vgVDhso-5XwZ8nEuvFJjr2oRL5U5pJvc', kind: 'single', facilityCode: 'NASH' },
  { code: 'KWC', sheetId: '1Iz2gzLP9J1U7DWW66HVKQfx-mQqToZ0TAM86KIaJNaY', kind: 'single', facilityCode: 'KWC' },
  { code: 'TREAT_FRCA', sheetId: '127b71ENufY4U6VcxF5sMInR9SflvkHXP8sTLjjK9z9k', kind: 'group', groupCode: 'TREAT_FRCA' },
  { code: 'LSMH_DMH', sheetId: '12uz7rBkkrJPDU9Ne0mB77H1NJyNKZoCQu5pm_rscNjY', kind: 'group', groupCode: 'LSMH_DMH' },
  { code: 'BXR_ROLLUP', sheetId: '16z83w8qQchoZV1ZFUp03DyUrYCb35EibYi6N58gvqWY', kind: 'rollup' },
  { code: 'INDIGO_ROLLUP', sheetId: '1qTyix7E8-tB3BTZjHInE3UewXkLY3-tyd5Na1fxkucU', kind: 'rollup' },
];

/**
 * Real facilities = the seeded collections.facilities rows. Names upper-cased for
 * tolerant matching of negotiation "Facility" column values.
 * NOTE: TELEHEALTH_MH appears in the Treat+FRCA workbook (a "Telehealth MH" detail
 * tab) and the rollups but is NOT yet in the seeded table — pending a 1-row add
 * (migration 0007). Included here so the ingest resolves it to a real code.
 */
export const FACILITY_NAME_BY_CODE: Readonly<Record<string, string>> = {
  CAMH: 'CA MENTAL HEALTH',
  TBH: 'TENNESSEE BEHAVIORAL HEALTH',
  PCMH: 'PACIFIC COAST MENTAL HEALTH LLC',
  LAMH: 'LOS ANGELES MENTAL HEALTH',
  NASH: 'NASHVILLE MENTAL HEALTH LLC',
  KWC: 'KENTUCKY WELLNESS CENTER',
  FRCA: 'FIRST RESPONDERS OF CALIFORNIA LLC',
  LSMH: 'LONESTAR MENTAL HEALTH LLC',
  DMH: 'DALLAS MENTAL HEALTH LLC',
  TREAT_CA: 'TREAT MENTAL HEALTH CALIFORNIA',
  TREAT_NV: 'TREAT MENTAL HEALTH NEVADA',
  TREAT_TN: 'TREAT MENTAL HEALTH TENNESSEE',
  TREAT_TX: 'TREAT MENTAL HEALTH TEXAS',
  TREAT_WA: 'TREAT MENTAL HEALTH WASHINGTON LLC',
  TELEHEALTH_MH: 'TELEHEALTH MH',
};

export const FACILITY_CODES: ReadonlySet<string> = new Set(Object.keys(FACILITY_NAME_BY_CODE));

/** Detail-tab title -> real facility code, for GROUP workbooks. (Single workbooks
 *  use their own facilityCode for the "Collections Details" tab.) */
export const GROUP_DETAIL_TAB_FACILITY: Readonly<Record<string, string>> = {
  'Treat CA': 'TREAT_CA',
  'Treat TN': 'TREAT_TN',
  'Treat TX': 'TREAT_TX',
  'Treat WA': 'TREAT_WA',
  'Treat NV': 'TREAT_NV',
  FRCA: 'FRCA',
  'Telehealth MH': 'TELEHEALTH_MH',
  'LSMH Collections Details': 'LSMH',
  'DMH Collections Details': 'DMH',
};

/** Daily column-block label -> real facility code, for GROUP workbooks. */
export const DAILY_BLOCK_LABEL_FACILITY: Readonly<Record<string, string>> = {
  'TMH CA': 'TREAT_CA',
  'TMH TN': 'TREAT_TN',
  'TMH TX': 'TREAT_TX',
  'TMH WA': 'TREAT_WA',
  'TMH NV': 'TREAT_NV',
  FRCA: 'FRCA',
  'Telehealth MH': 'TELEHEALTH_MH',
  LSMH: 'LSMH',
  DMH: 'DMH',
};

// ---------------------------------------------------------------------------
// Consolidated 2026 deposit Sheet (the "By Location" daily source, re-sourced).
// IP/OP monthly tabs whose facility blocks are labelled with the canonical
// acronyms. This array is the SINGLE source of truth for the acronym → facility
// code + IP/OP classification — reuse it for the item-3a facilities migration;
// do NOT build a second map. Every facility_code below is a real seeded facility
// (collections.facilities); the labels are exactly the sheet's block headers.
// ---------------------------------------------------------------------------

/** Canonical id of the consolidated deposit Sheet (an identifier, not a secret). */
export const DEPOSIT_SHEET_ID = '1auO2SDezdYS7tbqqDnk9OU_R7G-Erab8omvOZW0ANRQ';

export interface DepositFacility {
  /** The block label exactly as it appears in the deposit Sheet header row. */
  readonly label: string;
  /** The real facility_code in collections.facilities. */
  readonly facilityCode: string;
  /** Inpatient (IP tabs) vs Outpatient (OP tabs). For item-3a reuse. */
  readonly careSetting: 'IP' | 'OP';
}

/** The 15 deposit-Sheet facilities (8 IP + 7 OP). Note DLMH → DMH (display relabel
 *  only; the facility_code stays DMH). TMH xx → TREAT_xx. */
export const DEPOSIT_FACILITIES: readonly DepositFacility[] = [
  { label: 'CAMH', facilityCode: 'CAMH', careSetting: 'IP' },
  { label: 'PCMH', facilityCode: 'PCMH', careSetting: 'IP' },
  { label: 'LAMH', facilityCode: 'LAMH', careSetting: 'IP' },
  { label: 'LSMH', facilityCode: 'LSMH', careSetting: 'IP' },
  { label: 'DLMH', facilityCode: 'DMH', careSetting: 'IP' },
  { label: 'TBH', facilityCode: 'TBH', careSetting: 'IP' },
  { label: 'NASH', facilityCode: 'NASH', careSetting: 'IP' },
  { label: 'KWC', facilityCode: 'KWC', careSetting: 'IP' },
  { label: 'TMH CA', facilityCode: 'TREAT_CA', careSetting: 'OP' },
  { label: 'TMH TN', facilityCode: 'TREAT_TN', careSetting: 'OP' },
  { label: 'TMH WA', facilityCode: 'TREAT_WA', careSetting: 'OP' },
  { label: 'TMH TX', facilityCode: 'TREAT_TX', careSetting: 'OP' },
  { label: 'TMH NV', facilityCode: 'TREAT_NV', careSetting: 'OP' },
  { label: 'FRCA', facilityCode: 'FRCA', careSetting: 'OP' },
  { label: 'Telehealth MH', facilityCode: 'TELEHEALTH_MH', careSetting: 'OP' },
];

/** Deposit-Sheet block label → real facility_code (derived from DEPOSIT_FACILITIES). */
export const DEPOSIT_LABEL_TO_FACILITY: Readonly<Record<string, string>> = Object.fromEntries(
  DEPOSIT_FACILITIES.map((f) => [f.label, f.facilityCode]),
);

/** Resolve a free-text facility value (e.g. a negotiation "Facility" cell) to a
 *  real code: exact code match, else exact upper-cased name match, else null. */
export function resolveFacilityValue(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  const upper = v.toUpperCase();
  if (FACILITY_CODES.has(upper)) return upper;
  for (const [code, name] of Object.entries(FACILITY_NAME_BY_CODE)) {
    if (name === upper) return code;
  }
  return null;
}
