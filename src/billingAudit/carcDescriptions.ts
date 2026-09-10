/**
 * PHI-free descriptions for the CARC / RARC codes that dominate this book's remittances, so the AR
 * drawer can say what a denial MEANS without a `ref.*` join (the claims_reader pool has no
 * guaranteed reach into the Veris `ref` schema). Text is the X12 standard wording, abbreviated.
 * Codes measured at recon (CAMH B_REMITTANCE top 20): 45, 2, 131, M16, N442, 147, 1, 242, N220,
 * N655, 3, MA67, 119, N10, 204, N381, N130, 23, 44, 279. Unknown codes render as the bare code.
 */
const CARC: Readonly<Record<string, string>> = {
  '1': 'Deductible amount',
  '2': 'Coinsurance amount',
  '3': 'Co-payment amount',
  '4': 'Procedure code inconsistent with modifier',
  '11': 'Diagnosis inconsistent with procedure',
  '16': 'Claim lacks information / has billing error',
  '18': 'Duplicate claim / service',
  '22': 'Coordination of benefits — other payer may cover',
  '23': 'Impact of prior payer adjudication',
  '26': 'Expenses incurred prior to coverage',
  '27': 'Expenses incurred after coverage terminated',
  '29': 'Time limit for filing has expired',
  '31': 'Patient cannot be identified as insured',
  '44': 'Prompt-pay discount',
  '45': 'Charge exceeds fee schedule / contracted allowance',
  '50': 'Non-covered — not deemed medically necessary',
  '96': 'Non-covered charge(s)',
  '97': 'Benefit included in another service already adjudicated',
  '109': 'Not covered by this payer — send to correct payer',
  '119': 'Benefit maximum reached',
  '129': 'Prior processing information incorrect',
  '131': 'Claim-specific negotiated discount',
  '147': 'Provider contracted / negotiated rate expired or not on file',
  '197': 'Precertification / authorization absent',
  '198': 'Precertification / authorization exceeded',
  '204': 'Service not covered under the patient’s current plan',
  '226': 'Information requested from the billing provider not received',
  '227': 'Information requested from the patient not received',
  '242': 'Services not provided by network / primary care providers',
  '243': 'Services not authorized by network / primary care providers',
  '252': 'Attachment / other documentation required',
  '279': 'Services not provided by preferred network providers',
  'B7': 'Provider not certified / eligible for this service',
  'B11': 'Claim forwarded to another payer',
};

const RARC: Readonly<Record<string, string>> = {
  'M16': 'See policy article / bulletin for this service',
  'MA67': 'Correction to a prior claim',
  'N10': 'Adjustment based on review by the payer',
  'N54': 'Claim information inconsistent with pre-certified/authorized services',
  'N130': 'Consult plan benefit documents for coverage restrictions',
  'N220': 'See the payer’s web site for the policy',
  'N381': 'Consult contractual agreement for restrictions',
  'N442': 'Payment based on an alternate fee schedule',
  'N655': 'Payment based on provider’s billed rate',
};

/** Description for a CARC (group-coded adjustment) or RARC (remark) code, or null when unknown. */
export function describeRemitCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const k = code.trim().toUpperCase();
  return CARC[k] ?? RARC[k] ?? null;
}

/** What an adjustment GROUP code means financially — the same CARC under PR is a patient balance, under CO a write-off. */
export function describeGroupCode(group: string | null | undefined): string | null {
  switch ((group ?? '').trim().toUpperCase()) {
    case 'CO': return 'Contractual obligation (provider write-off)';
    case 'PR': return 'Patient responsibility';
    case 'PI': return 'Payer-initiated reduction';
    case 'OA': return 'Other adjustment';
    default: return null;
  }
}
