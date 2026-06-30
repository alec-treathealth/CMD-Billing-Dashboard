/**
 * CMD customer accounts to loop for the Collections Explorer + Master BXR chart ingest.
 *
 * The CMD Web API scopes data by CUSTOMER (one CMD customer == one facility/entity).
 * Report 10091971 / filter 10147430 returns the 16-column batch export (the 14 explorer
 * columns PLUS `Check Payment` + `EFT Payment`) for the window baked into the filter
 * (1/1/2026 → 6/30/2027). To cover ALL facilities the cron runs that same report/filter
 * once per customer below, varying only CMD_CUSTOMER_ID.
 *
 * Because each customer IS a facility, we map customerId → facility_code DIRECTLY here
 * (exact, no fragile facility-name parsing). Every facilityCode is a real seeded
 * collections.facilities row (migration 0016) — so the chart's IP/OP split + acronym
 * labels resolve with no dimension change.
 *
 * EXCLUDED on purpose (empty / defunct accounts, not in collections.facilities):
 *   10030472 BILLING SERVICE ACCOUNT  ·  10035166 TEEN MENTAL HEALTH TEXAS
 *   10035974 TREAT MENTAL HEALTH COLORADO  ·  10033951 WELLNESS RECOVERY CENTER LLC
 * They carry no data; including the billing umbrella would also double-count.
 */

/** One CMD customer account == one facility. */
export interface CmdCustomer {
  /** CMD_CUSTOMER_ID for the API call. */
  readonly customerId: string;
  /** The real collections.facilities.facility_code this account maps to. */
  readonly facilityCode: string;
}

/** The 15 active facility customer accounts (8 IP + 7 OP — matches collections.facilities). */
export const CMD_EXPLORER_CUSTOMERS: readonly CmdCustomer[] = [
  { customerId: '10027973', facilityCode: 'CAMH' }, //          CA MENTAL HEALTH (IP)
  { customerId: '10033950', facilityCode: 'DMH' }, //           DALLAS MENTAL HEALTH (IP)
  { customerId: '10034908', facilityCode: 'KWC' }, //           KENTUCKY WELLNESS CENTER (IP)
  { customerId: '10033690', facilityCode: 'LAMH' }, //          LOS ANGELES MENTAL HEALTH (IP)
  { customerId: '10031977', facilityCode: 'LSMH' }, //          LONESTAR MENTAL HEALTH (IP)
  { customerId: '10030911', facilityCode: 'NASH' }, //          NASHVILLE MENTAL HEALTH (IP)
  { customerId: '10030471', facilityCode: 'PCMH' }, //          PACIFIC COAST MENTAL HEALTH (IP)
  { customerId: '10029105', facilityCode: 'TBH' }, //           TENNESSEE BEHAVIORAL HEALTH (IP)
  { customerId: '10032340', facilityCode: 'FRCA' }, //          FIRST RESPONDERS OF CALIFORNIA (OP)
  { customerId: '10034666', facilityCode: 'TELEHEALTH_MH' }, // TELEHEALTH MH (OP)
  { customerId: '10030101', facilityCode: 'TREAT_CA' }, //      TREAT MENTAL HEALTH CALIFORNIA (OP)
  { customerId: '10034671', facilityCode: 'TREAT_NV' }, //      TREAT MENTAL HEALTH NEVADA (OP)
  { customerId: '10029905', facilityCode: 'TREAT_TN' }, //      TREAT MENTAL HEALTH TENNESSEE (OP)
  { customerId: '10029722', facilityCode: 'TREAT_TX' }, //      TREAT MENTAL HEALTH TEXAS (OP)
  { customerId: '10031212', facilityCode: 'TREAT_WA' }, //      TREAT MENTAL HEALTH WASHINGTON (OP)
];
