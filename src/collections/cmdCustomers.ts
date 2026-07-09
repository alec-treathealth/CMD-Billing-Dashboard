/**
 * CMD customer accounts to loop for per-customer batch pulls (Collections Explorer +
 * Master BXR chart ingest, and the staging 835 ERA ingest src/ingest/era_ingest.ts).
 *
 * The CMD Web API scopes data by CUSTOMER (one CMD customer == one facility/entity): a saved
 * filter's cross-facility criteria are IGNORED by the REST API — it only ever returns the
 * `{customerId}` in the URL path (verified live). So to cover ALL facilities the cron runs the
 * same report/filter once per customer below, varying only CMD_CUSTOMER_ID.
 *
 * Report 10091971 / filter 10147530 returns the 17-column batch export (the 14 explorer columns
 * PLUS `Check Payment` + `EFT Payment` + `Charge Patient Payments`) on a ROLLING (current-month)
 * payment-received window, so each run re-supplies the current month and the pipeline self-heals.
 * (Filter 10147530 is valid under all 15 accounts here; it is NOT saved under the excluded
 * accounts below — see EXCLUDED note.)
 *
 * MULTI-TENANT: each entry carries its owning `businessEntityId`, so a per-customer pull
 * tags its rows to the correct tenant (BXR vs Indigo) — the tenant-aware ingest loops
 * `customer.businessEntityId`, never a single global constant. This is the source of
 * truth for the customer loop; RLS isolation is still enforced per-transaction via
 * set_config('app.business_entity_id', ...) at write time (docs/CLAUDE.md §17).
 *
 * Because each customer IS a facility, we map customerId → facility_code DIRECTLY here
 * (exact, no fragile facility-name parsing).
 *
 * BXR (business_entity_id af504ab6…, CMD account 475729): every facilityCode is a real
 * seeded collections.facilities row (migration 0016) — so the chart's IP/OP split +
 * acronym labels resolve with no dimension change.
 *   EXCLUDED on purpose (empty / defunct BXR accounts, not in collections.facilities):
 *     10030472 BILLING SERVICE ACCOUNT  ·  10035166 TEEN MENTAL HEALTH TEXAS
 *     10035974 TREAT MENTAL HEALTH COLORADO  ·  10033951 WELLNESS RECOVERY CENTER LLC
 *     10035976 HOUSTON MENTAL HEALTH
 *   They carry no data; including the billing umbrella would also double-count. (Note: filter
 *   10147530 isn't even saved under BILLING SERVICE / HOUSTON / TREAT COLORADO — they return
 *   INVALID CRITERIA — and TEEN TX / WELLNESS RECOVERY accept it but return no rows. If any of
 *   these becomes active, add its collections.facilities row + the saved filter before listing it.)
 *
 * Indigo (business_entity_id 141d459c…, CMD account 474623): 32 active facility accounts,
 * confirmed by the business owner. Indigo has no short-code/acronym scheme yet, so facilityCode
 * = the CMD facility ID itself (staging.era_835_adjustment.facility_code is free text). Names
 * below are authoritative — preserve exact spelling/casing; the two CROWN VIEW entries are
 * deliberately distinct (do NOT merge). care_setting (IP/OP/BOTH) lives on collections.facilities
 * (migration 0035), not here.
 *   EXCLUDED on purpose (mirrors BXR's billing-account exclusion): 10025030 BILLING SERVICE
 *   ACCOUNT — empty CMD-side and not saved under filter 10147669 (returns INVALID CRITERIA). If it
 *   ever carries data, save the filter under it + add a collections.facilities row before listing.
 *   REMOVED 2026-07-09 (shut down / no longer exist, verified 0 rows): 10034063 MAPSONG PC,
 *   10035913 NORTHERN CALIFORNIA MENTAL HEALTH, 10032612 POSTPARTUM MENTAL HEALTH,
 *   10029219 THRIVE MEDICAL SPECIALISTS, 10034039 TREADSTONE SERVICES PC.
 */
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';

/** One CMD customer account == one facility, tagged to its owning tenant. */
export interface CmdCustomer {
  /** CMD_CUSTOMER_ID for the API call. */
  readonly customerId: string;
  /** The facility_code this account maps to (BXR: short code; Indigo: the CMD id itself). */
  readonly facilityCode: string;
  /** Owning tenant (business_entity_id). Drives per-customer RLS scoping at ingest. */
  readonly businessEntityId: string;
}

/** BXR's 15 active facility customer accounts (8 IP + 7 OP — matches collections.facilities). */
export const BXR_CUSTOMERS: readonly CmdCustomer[] = [
  { customerId: '10027973', facilityCode: 'CAMH', businessEntityId: BXR_ENTITY_ID }, //          CA MENTAL HEALTH (IP)
  { customerId: '10033950', facilityCode: 'DMH', businessEntityId: BXR_ENTITY_ID }, //           DALLAS MENTAL HEALTH (IP)
  { customerId: '10034908', facilityCode: 'KWC', businessEntityId: BXR_ENTITY_ID }, //           KENTUCKY WELLNESS CENTER (IP)
  { customerId: '10033690', facilityCode: 'LAMH', businessEntityId: BXR_ENTITY_ID }, //          LOS ANGELES MENTAL HEALTH (IP)
  { customerId: '10031977', facilityCode: 'LSMH', businessEntityId: BXR_ENTITY_ID }, //          LONESTAR MENTAL HEALTH (IP)
  { customerId: '10030911', facilityCode: 'NASH', businessEntityId: BXR_ENTITY_ID }, //          NASHVILLE MENTAL HEALTH (IP)
  { customerId: '10030471', facilityCode: 'PCMH', businessEntityId: BXR_ENTITY_ID }, //          PACIFIC COAST MENTAL HEALTH (IP)
  { customerId: '10029105', facilityCode: 'TBH', businessEntityId: BXR_ENTITY_ID }, //           TENNESSEE BEHAVIORAL HEALTH (IP)
  { customerId: '10032340', facilityCode: 'FRCA', businessEntityId: BXR_ENTITY_ID }, //          FIRST RESPONDERS OF CALIFORNIA (OP)
  { customerId: '10034666', facilityCode: 'TELEHEALTH_MH', businessEntityId: BXR_ENTITY_ID }, // TELEHEALTH MH (OP)
  { customerId: '10030101', facilityCode: 'TREAT_CA', businessEntityId: BXR_ENTITY_ID }, //      TREAT MENTAL HEALTH CALIFORNIA (OP)
  { customerId: '10034671', facilityCode: 'TREAT_NV', businessEntityId: BXR_ENTITY_ID }, //      TREAT MENTAL HEALTH NEVADA (OP)
  { customerId: '10029905', facilityCode: 'TREAT_TN', businessEntityId: BXR_ENTITY_ID }, //      TREAT MENTAL HEALTH TENNESSEE (OP)
  { customerId: '10029722', facilityCode: 'TREAT_TX', businessEntityId: BXR_ENTITY_ID }, //      TREAT MENTAL HEALTH TEXAS (OP)
  { customerId: '10031212', facilityCode: 'TREAT_WA', businessEntityId: BXR_ENTITY_ID }, //      TREAT MENTAL HEALTH WASHINGTON (OP)
];

/** Indigo's 32 active facility customer accounts (CMD account 474623). facilityCode = CMD id. */
export const INDIGO_CUSTOMERS: readonly CmdCustomer[] = [
  { customerId: '10026460', facilityCode: '10026460', businessEntityId: INDIGO_ENTITY_ID }, // 405 RECOVERY
  { customerId: '10029373', facilityCode: '10029373', businessEntityId: INDIGO_ENTITY_ID }, // ADDICTION FREE RECOVERY SERVICES
  { customerId: '10029528', facilityCode: '10029528', businessEntityId: INDIGO_ENTITY_ID }, // ADOLESCENT MENTAL HEALTH
  { customerId: '10031413', facilityCode: '10031413', businessEntityId: INDIGO_ENTITY_ID }, // BRITE RECOVERY
  { customerId: '10028848', facilityCode: '10028848', businessEntityId: INDIGO_ENTITY_ID }, // CALIFORNIA TREATMENT COLLECTIVE
  { customerId: '10028842', facilityCode: '10028842', businessEntityId: INDIGO_ENTITY_ID }, // COVENANT HILLS TREATMENT CENTERS
  { customerId: '10021230', facilityCode: '10021230', businessEntityId: INDIGO_ENTITY_ID }, // CROWN VIEW CO-OCCURRING INSTITUTE - 612335
  { customerId: '10023916', facilityCode: '10023916', businessEntityId: INDIGO_ENTITY_ID }, // CROWN VIEW PSYCHIATRIC INSTITUTE
  { customerId: '10020687', facilityCode: '10020687', businessEntityId: INDIGO_ENTITY_ID }, // HEALTHY LIFE RECOVERY
  { customerId: '10026624', facilityCode: '10026624', businessEntityId: INDIGO_ENTITY_ID }, // HILLSIDE HORIZON FOR TEENS
  { customerId: '10033859', facilityCode: '10033859', businessEntityId: INDIGO_ENTITY_ID }, // INTO THE LIGHT
  { customerId: '10032291', facilityCode: '10032291', businessEntityId: INDIGO_ENTITY_ID }, // KIN WELLNESS
  { customerId: '10030095', facilityCode: '10030095', businessEntityId: INDIGO_ENTITY_ID }, // KNOX RECOVERY
  { customerId: '10036020', facilityCode: '10036020', businessEntityId: INDIGO_ENTITY_ID }, // MADISON RECOVERY CENTER (added 2026-07-08, in filter 10147669)
  { customerId: '10024431', facilityCode: '10024431', businessEntityId: INDIGO_ENTITY_ID }, // MENTAL HEALTH CENTER OF SAN DIEGO
  { customerId: '10030319', facilityCode: '10030319', businessEntityId: INDIGO_ENTITY_ID }, // MENTAL HEALTH MODESTO
  { customerId: '10034979', facilityCode: '10034979', businessEntityId: INDIGO_ENTITY_ID }, // MENTAL HEALTH TREATMENT AND STABILIZATION CENTER OF SACRAMENTO
  { customerId: '10036030', facilityCode: '10036030', businessEntityId: INDIGO_ENTITY_ID }, // MISSOURI BEHAVIORAL HEALTH (added 2026-07-08, in filter 10147669)
  { customerId: '10034230', facilityCode: '10034230', businessEntityId: INDIGO_ENTITY_ID }, // MY TEEN MENTAL HEALTH
  { customerId: '10026125', facilityCode: '10026125', businessEntityId: INDIGO_ENTITY_ID }, // MY TIME RECOVERY, LLC
  { customerId: '10033867', facilityCode: '10033867', businessEntityId: INDIGO_ENTITY_ID }, // NEW ORIGINS
  { customerId: '10034901', facilityCode: '10034901', businessEntityId: INDIGO_ENTITY_ID }, // NEXT FRONTIER RECOVERY
  { customerId: '10021573', facilityCode: '10021573', businessEntityId: INDIGO_ENTITY_ID }, // OPUS HEALTH
  { customerId: '10031652', facilityCode: '10031652', businessEntityId: INDIGO_ENTITY_ID }, // ORANGE COUNTY MENTAL HEALTH
  { customerId: '10035467', facilityCode: '10035467', businessEntityId: INDIGO_ENTITY_ID }, // RESTORED HOPE RECOVERY
  { customerId: '10028595', facilityCode: '10028595', businessEntityId: INDIGO_ENTITY_ID }, // REVIVAL MENTAL HEALTH
  { customerId: '10026159', facilityCode: '10026159', businessEntityId: INDIGO_ENTITY_ID }, // SADDLEBACK RECOVERY
  { customerId: '10028219', facilityCode: '10028219', businessEntityId: INDIGO_ENTITY_ID }, // SHINE MENTAL HEALTH
  { customerId: '10025950', facilityCode: '10025950', businessEntityId: INDIGO_ENTITY_ID }, // SILICON VALLEY RECOVERY, LLC
  { customerId: '10033531', facilityCode: '10033531', businessEntityId: INDIGO_ENTITY_ID }, // THE EDGE TREATMENT CENTER
  { customerId: '10033708', facilityCode: '10033708', businessEntityId: INDIGO_ENTITY_ID }, // THE FORGE RECOVERY CENTER
  { customerId: '10031547', facilityCode: '10031547', businessEntityId: INDIGO_ENTITY_ID }, // VISALIA RECOVERY CENTER
];

/**
 * The Collections Explorer / Master BXR chart cron is BXR-only today, so its roster is
 * unchanged: CMD_EXPLORER_CUSTOMERS keeps the SAME name and the SAME value (BXR's 15) so
 * that cron and its tests are byte-for-byte unaffected by Indigo onboarding.
 */
export const CMD_EXPLORER_CUSTOMERS: readonly CmdCustomer[] = BXR_CUSTOMERS;

/** BXR + Indigo — the full customer roster for tenant-aware ingest loops (era_ingest). */
export const ALL_CMD_CUSTOMERS: readonly CmdCustomer[] = [...BXR_CUSTOMERS, ...INDIGO_CUSTOMERS];
