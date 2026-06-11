/**
 * Representative dirty-data fixtures built from the patterns documented in
 * CLAUDE.md. These let the normalizer be verified without live Sheets access.
 * Each row is an array of cell strings exactly as the Sheets API yields them
 * (FORMATTED_VALUE), including API trailing-blank truncation.
 */

export const HEADER_2024 = [
  'Office Name', // 2024 variant
  'Date of Service',
  'HCPCS Code',
  'Revenue Code',
  'Patient Name',
  'Member ID',
  'Group Number',
  'Employer Name',
  'Charge/Debit Amount',
  'Allowed Amount',
  'Paid Amount',
  'Adjustment',
  'Balance Due Pt',
  'Payer Name',
];

export const HEADER_2025 = ['Facility Name', ...HEADER_2024.slice(1)];

/** 2024 Covenant Hills: blank HCPCS + Revenue, NEGATIVE member id. */
export const ROW_COVENANT_HILLS_2024 = [
  'Covenant Hills',
  '3/5/2024', // M/D/YYYY
  '', // HCPCS blank -> NULL
  '', // Revenue blank -> NULL
  'SMITH, JOHN',
  '-11724767', // negative -> norm 11724767
  '',
  '',
  '$1,200.00',
  '$1,000.00',
  '$800.00',
  '$0.00',
  '$200.00',
  'Beacon Carelon',
];

/** Vanguard: employer with embedded comma; MM/DD/YYYY date; negative allowed. */
export const ROW_VANGUARD_2024 = [
  'My Time Recovery',
  '03/12/2024', // MM/DD/YYYY
  'H0015',
  '0905',
  'DOE, JANE',
  'PGE081', // real alphanumeric member id (appears alongside numeric ones in 2026)
  'GRP123',
  'THE VANGUARD GROUP, INC.', // embedded comma — must NOT shift money fields
  '$3,500.00',
  '-$1,660.05', // negative money — minus OUTSIDE the $ (confirmed real 2026 form)
  '$2,000.00',
  '$300.00',
  '$0.00',
  'Anthem Blue Cross',
];

/** Trailing cells truncated by the API; payer ends up blank -> coercion fail. */
export const ROW_TRUNCATED_2025 = ['Hopeful Recovery', '1/9/2025', '', '', 'LEE, SAM', '55512'];

/** Unparseable money in charge -> coercion failure (row still lands raw). */
export const ROW_BAD_MONEY_2025 = [
  'Test Facility',
  '2/2/2025',
  'H0015',
  '0905',
  'ROE, RICH',
  '123',
  '',
  '',
  'abc', // not money
  '$10.00',
  '$5.00',
  '$0.00',
  '$5.00',
  'Cigna',
];

/** Invalid calendar date -> coercion failure. */
export const ROW_BAD_DATE_2024 = [
  'Some Facility',
  '2/30/2024', // Feb 30 does not exist
  'H0015',
  '0905',
  'POE, PAT',
  '777',
  '',
  '',
  '$100.00',
  '$80.00',
  '$60.00',
  '$0.00',
  '$20.00',
  'Aetna',
];
