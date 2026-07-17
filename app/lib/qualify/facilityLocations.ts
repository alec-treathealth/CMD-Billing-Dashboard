/**
 * Qualify facility city/state lookup (ruling Q-C). PURE, no I/O, safe to import from either surface.
 *
 * WHY in-code (not a DB column): collections.facilities carries no city/state/zip; the only source is
 * the two operator-provided sheets docs/"Facility Locations BXR.csv" + "…Indigo.csv". This module is
 * that data, keyed by `facility_code` — the same code the facility-ranking query resolves each rollup
 * `facility` text to (exact-name/alias crosswalk). Runtime does a single map lookup by facility_code;
 * no CSV/ZIP parsing ships.
 *
 * HOW IT WAS BUILT (scripts/… one-time crosswalk, reviewed with Alec 2026-07-17):
 *  - CSV "Facility Name" → facility_code via normalized match (upper, strip LLC/INC/PC/punct, DBA →
 *    the doing-business-as name) plus 4 confirmed manual aliases (CALIFORNIA→CA; MISSOURI TREATMENT
 *    SERVICES→MISSOURI BEHAVIORAL HEALTH; the CROWNVIEW spelling/typo variants; a 60-char-truncated
 *    "…OF SACRAMEN(TO)").
 *  - `state` is derived from the ZIP (USPS SCF prefix) at build time and baked in here.
 *  - MULTI-ADDRESS facilities use the PRIMARY (first CSV) address; ones with >1 city are flagged
 *    below so a specific choice can be corrected without touching code shape.
 *
 * NULL-ON-MISS, NEVER FABRICATED: a facility_code absent from this map returns null (the contract's
 * city/state are `string | null`). Four facilities are in collections.facilities but have NO address
 * in the sheets yet — they are NEW facilities with little/no data; they resolve to null until their
 * address is added here (add an entry when the next sheet arrives):
 *   10025950 SILICON VALLEY RECOVERY · 10026159 SADDLEBACK RECOVERY ·
 *   10029373 ADDICTION FREE RECOVERY SERVICES · 10033708 THE FORGE RECOVERY CENTER
 *
 * MULTI-ADDRESS (primary = first CSV address; confirm if a different site is canonical):
 *   LSMH Martindale|Dallas TX · NASH Murfreesboro|Mount Juliet TN · TBH Murfreesboro|Nashville TN ·
 *   TELEHEALTH_MH Knoxville TN|Cedar Park TX · TREAT_CA Sacramento|San Jose CA ·
 *   10024431 San Diego|La Jolla CA · 10028595 Fountain Valley|Huntington Beach CA ·
 *   10028842 San Juan Capistrano|Capistrano Beach|San Clemente CA · 10030095 Santa Ana|Fountain Valley CA ·
 *   10031547 Visalia|Bakersfield CA
 */

export interface FacilityLocation {
  city: string;
  /** USPS 2-letter state, derived from ZIP. null only if a ZIP ever fails to resolve (none today). */
  state: string | null;
}

const FACILITY_LOCATIONS: Readonly<Record<string, FacilityLocation>> = {
  // BXR (named facility_codes)
  CAMH: { city: 'San Martin', state: 'CA' },
  DMH: { city: 'Kaufman', state: 'TX' },
  FRCA: { city: 'Costa Mesa', state: 'CA' },
  KWC: { city: 'Cadiz', state: 'KY' },
  LAMH: { city: 'Tarzana', state: 'CA' },
  LSMH: { city: 'Martindale', state: 'TX' },
  NASH: { city: 'Murfreesboro', state: 'TN' },
  PCMH: { city: 'Costa Mesa', state: 'CA' },
  TBH: { city: 'Murfreesboro', state: 'TN' },
  TELEHEALTH_MH: { city: 'Knoxville', state: 'TN' },
  TREAT_CA: { city: 'Sacramento', state: 'CA' },
  TREAT_NV: { city: 'Henderson', state: 'NV' },
  TREAT_TN: { city: 'Nashville', state: 'TN' },
  TREAT_TX: { city: 'Cedar Park', state: 'TX' },
  TREAT_WA: { city: 'Bellevue', state: 'WA' },
  // Indigo (8-digit customer-number facility_codes)
  '10020687': { city: 'San Diego', state: 'CA' },
  '10021230': { city: 'Oceanside', state: 'CA' },
  '10021573': { city: 'Costa Mesa', state: 'CA' },
  '10023916': { city: 'Carlsbad', state: 'CA' },
  '10024431': { city: 'San Diego', state: 'CA' },
  '10026125': { city: 'Fresno', state: 'CA' },
  '10026460': { city: 'Newport Beach', state: 'CA' },
  '10026624': { city: 'Canyon Lake', state: 'CA' },
  '10028219': { city: 'Fresno', state: 'CA' },
  '10028595': { city: 'Fountain Valley', state: 'CA' },
  '10028842': { city: 'San Juan Capistrano', state: 'CA' },
  '10028848': { city: 'Newport Beach', state: 'CA' },
  '10029528': { city: 'Laguna Hills', state: 'CA' },
  '10030095': { city: 'Santa Ana', state: 'CA' },
  '10030319': { city: 'Modesto', state: 'CA' },
  '10031413': { city: 'Newport Beach', state: 'CA' },
  '10031547': { city: 'Visalia', state: 'CA' },
  '10031652': { city: 'Newport Beach', state: 'CA' },
  '10032291': { city: 'Huntington Beach', state: 'CA' },
  '10033531': { city: 'Santa Ana', state: 'CA' },
  '10033859': { city: 'Redlands', state: 'CA' },
  '10033867': { city: 'Redlands', state: 'CA' },
  '10034230': { city: 'Modesto', state: 'CA' },
  '10034901': { city: 'Henrico', state: 'VA' },
  '10034979': { city: 'Roseville', state: 'CA' },
  '10035467': { city: 'Mesa', state: 'AZ' },
  '10036020': { city: 'Madison', state: 'WI' },
  '10036030': { city: 'Springfield', state: 'MO' },
};

/** City/state for a resolved facility_code, or null when unmapped (new/unlisted facility — never fabricated). */
export function facilityLocation(facilityCode: string | null | undefined): FacilityLocation | null {
  if (!facilityCode) return null;
  return FACILITY_LOCATIONS[facilityCode] ?? null;
}
