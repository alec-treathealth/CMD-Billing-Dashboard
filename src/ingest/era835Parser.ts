/**
 * X12 005010X221A1 835 (Electronic Remittance Advice) parser — dependency-free.
 *
 * WHY hand-rolled (not x12-parser or similar): the project ships zero EDI deps, the
 * 835 subset we need is small and well-specified, and a vendored parser would be a
 * new supply-chain surface for a PHI pipeline. This module extracts exactly what the
 * recovery/Brain-2 layer needs — the payment envelope, each claim (Loop 2100 CLP +
 * patient/subscriber names), each service line (Loop 2110 SVC), and EVERY CAS
 * adjustment triplet (group/reason/amount/quantity) at claim and line level.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): this module PARSES only. It NEVER logs — no
 * console, no thrown value carrying a segment/element. Patient name + member id are
 * returned in the structure (PHI, in memory) so the caller (src/ingest/era_ingest.ts)
 * can encrypt them at the insert boundary; they never leave this process in plaintext.
 *
 * DELIMITERS: detected from the ISA control segment per the X12 spec — the element
 * separator is the 4th byte (right after "ISA"); the ISA is a fixed 106 bytes, so the
 * component (sub-element) separator is byte 104 and the segment terminator is byte 105
 * (the repetition separator at byte 82 is not needed for this 835 subset).
 * Trailing CR/LF between segments (common from clearinghouse exports) is tolerated.
 * If the payload does not start with a well-formed ISA, we fall back to the ubiquitous
 * *`~`* / element `*` / component `:` defaults.
 */

/** One CAS adjustment triplet, at claim (Loop 2100) or line (Loop 2110) level. */
export interface Era835Adjustment {
  level: 'CLAIM' | 'LINE';
  /** CAS01 group code — CO / PR / OA / PI / CR. */
  groupCode: string;
  /** CARC code, bare numeric ('45', not 'CO-45'). */
  reasonCode: string;
  /** CAS amount — SIGN PRESERVED (reversals/corrections negative). */
  amount: number;
  /** CAS quantity, or null when the triplet omits it. */
  quantity: number | null;
}

/** One service line (Loop 2110). */
export interface Era835ServiceLine {
  /** 1-based position within the claim. */
  lineNumber: number;
  /** SVC01 procedure code portion (composite split on the component separator). */
  procedureCode: string | null;
  /** SVC02 line charge amount. */
  chargeAmount: number | null;
  /** SVC03 line paid amount. */
  paidAmount: number | null;
  /** SVC05 paid units. */
  units: number | null;
  /** DTM*472 service date (ISO YYYY-MM-DD). */
  serviceDate: string | null;
  /** REF*6R line item control number (ties to the submitted 837 service line). */
  lineItemControlNumber: string | null;
  adjustments: Era835Adjustment[];
  /** LQ*HE remark (RARC) codes — captured for counts/future use, not CAS triplets. */
  remarkCodes: string[];
}

/** One claim (Loop 2100). Patient name + member id are PHI. */
export interface Era835Claim {
  /** CLP01 patient control number — the provider's claim id (business id, not PHI). */
  patientControlNumber: string | null;
  /** CLP02 claim status code. */
  claimStatusCode: string | null;
  /** CLP03 total claim charge. */
  totalChargeAmount: number | null;
  /** CLP04 total claim paid. */
  totalPaidAmount: number | null;
  /** CLP05 patient responsibility. */
  patientResponsibilityAmount: number | null;
  /** CLP06 claim filing indicator. */
  claimFilingIndicator: string | null;
  /** CLP07 payer claim control number (ICN/DCN). */
  payerClaimControlNumber: string | null;
  /** Loop 2100 NM1*QC patient name (last first) — PHI. */
  patientName: string | null;
  /** Loop 2100 NM1*IL subscriber/member id — PHI. */
  memberId: string | null;
  claimLevelAdjustments: Era835Adjustment[];
  serviceLines: Era835ServiceLine[];
}

/** The payment envelope (BPR / TRN / Loop 1000A payer / ST). Non-PHI. */
export interface Era835Payment {
  /** BPR04 payment method (ACH / CHK / NON …). */
  paymentMethod: string | null;
  /** BPR02 total actual payment amount. */
  paymentAmount: number | null;
  /**
   * BPR02 EXACTLY as it appeared in the EDI (trimmed), or null when the element was
   * absent/blank. Kept alongside the parsed number because numeric(12,2) cannot hold
   * every value a non-conformant payer might send: when paymentAmount is unrepresentable
   * this raw string is the ONLY surviving record of the figure, and it is what keeps two
   * differently-malformed remits distinguishable in the remit fingerprint.
   */
  paymentAmountRaw: string | null;
  /** BPR16 effective entry date (ISO YYYY-MM-DD). */
  paymentDate: string | null;
  /** TRN02 check/EFT trace number. Unique per PAYER, not globally — qualify it with
   *  traceOriginatingCompanyId before using it as an identity key. */
  traceNumber: string | null;
  /**
   * TRN03 payer's originating company identifier — the field X12 provides to qualify
   * TRN02. Captured because staging.era_835_payment's remit fingerprint hashes it:
   * TRN02 alone is payer-scoped, so without TRN03 two payers' remits can collide.
   */
  traceOriginatingCompanyId: string | null;
  /** Loop 1000A N1*PR payer name. */
  payerName: string | null;
  /** Loop 1000A payer identifier (N104 when present). */
  payerId: string | null;
  /** ST02 transaction set control number. */
  eraControlNumber: string | null;
}

/** One ST/SE transaction set (one 835 remittance) within the interchange. */
export interface Era835Transaction {
  payment: Era835Payment;
  claims: Era835Claim[];
}

export interface Era835ParseResult {
  transactions: Era835Transaction[];
  /** Total claims across all transactions. */
  claimCount: number;
  /** Total CAS adjustment triplets across all transactions. */
  adjustmentCount: number;
  /** Total LQ remark (RARC) codes seen (counted, not stored as triplets). */
  remarkCount: number;
}

interface Delimiters {
  element: string;
  segment: string;
  component: string;
}

const DEFAULT_DELIMITERS: Delimiters = { element: '*', segment: '~', component: ':' };

/** Detect delimiters from the ISA per the X12 spec (fixed 106-byte control segment). */
export function detectDelimiters(edi: string): Delimiters {
  if (edi.length < 106 || edi.slice(0, 3) !== 'ISA') return DEFAULT_DELIMITERS;
  const element = edi[3]!;
  const component = edi[104]!;
  const segment = edi[105]!;
  // Guard: a well-formed ISA never uses an alphanumeric as element/segment separator.
  const bad = (c: string) => /[A-Za-z0-9]/.test(c) || c === undefined;
  if (bad(element) || bad(segment)) return DEFAULT_DELIMITERS;
  return { element, segment, component: bad(component) ? DEFAULT_DELIMITERS.component : component };
}

/** X12 numeric → JS number (sign preserved); null for blank/unparseable. */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** X12 CCYYMMDD → ISO YYYY-MM-DD; null for anything else. */
function x12Date(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (!/^\d{8}$/.test(t)) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** Trim a trailing empty string caused by a component-only field, and blank→null. */
function str(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Parse a CAS segment's elements into adjustment triplets.
 *
 * CAS layout: [ 'CAS', groupCode, reason1, amount1, qty1, reason2, amount2, qty2, … ]
 * — CAS01 is the group code, then up to 6 (reason, amount, quantity) triplets. A
 * triplet with a blank reason is skipped; a blank/zero quantity is preserved as null.
 * Amounts keep their sign (X12 reversals are negative). Exported so the ingest and
 * tests share ONE implementation.
 */
export function parseCasSegment(elements: string[], level: 'CLAIM' | 'LINE'): Era835Adjustment[] {
  const groupCode = (elements[1] ?? '').trim().toUpperCase();
  const out: Era835Adjustment[] = [];
  if (groupCode === '') return out;
  // Triplets start at element index 2 and repeat every 3 elements.
  for (let i = 2; i < elements.length; i += 3) {
    const reasonCode = (elements[i] ?? '').trim();
    if (reasonCode === '') continue;
    const amount = num(elements[i + 1]);
    const quantity = num(elements[i + 2]);
    out.push({
      level,
      groupCode,
      reasonCode,
      amount: amount ?? 0,
      quantity,
    });
  }
  return out;
}

/**
 * Parse a full 835 payload (one interchange, possibly multiple ST/SE transactions)
 * into a structured result. ISA/GS/ST/SE/GE/IEA envelope segments are consumed for
 * structure but not surfaced (except ST02 as the era control number). Pure + PHI-safe.
 */
export function parseEra835(edi: string): Era835ParseResult {
  const d = detectDelimiters(edi);
  const segments = edi
    .split(d.segment)
    .map((s) => s.replace(/[\r\n]+/g, '').trim())
    .filter((s) => s !== '');

  const transactions: Era835Transaction[] = [];
  let tx: Era835Transaction | null = null;
  let claim: Era835Claim | null = null;
  let line: Era835ServiceLine | null = null;
  let claimCount = 0;
  let adjustmentCount = 0;
  let remarkCount = 0;

  const beginPayment = (): Era835Payment => ({
    paymentMethod: null,
    paymentAmount: null,
    paymentAmountRaw: null,
    paymentDate: null,
    traceNumber: null,
    traceOriginatingCompanyId: null,
    payerName: null,
    payerId: null,
    eraControlNumber: null,
  });

  for (const seg of segments) {
    const el = seg.split(d.element);
    const id = (el[0] ?? '').trim().toUpperCase();

    switch (id) {
      case 'ST': {
        // New transaction set. Flush any in-flight LINE then claim into the previous tx
        // first — a multi-ST/SE interchange (one CMD download = many 835 sets) would
        // otherwise drop the last service line + its line-level CAS of every non-final set.
        if (claim && tx) {
          if (line) claim.serviceLines.push(line);
          tx.claims.push(claim);
        }
        claim = null;
        line = null;
        tx = { payment: beginPayment(), claims: [] };
        tx.payment.eraControlNumber = str(el[2]);
        transactions.push(tx);
        break;
      }
      case 'BPR': {
        if (!tx) break;
        tx.payment.paymentAmount = num(el[2]);
        // Raw BPR02 too: num() returns null for anything unparseable OR out of the range
        // numeric(12,2) can store, and that null would otherwise erase the figure from
        // both the record and the remit's identity.
        tx.payment.paymentAmountRaw = str(el[2]);
        tx.payment.paymentMethod = str(el[4]);
        // BPR16 is the effective entry date (last common element in the 835 BPR).
        tx.payment.paymentDate = x12Date(el[16]);
        break;
      }
      case 'TRN': {
        // TRN02 = check/EFT trace number; TRN03 = payer's originating company id, which
        // qualifies TRN02 (payer-scoped on its own). Both feed the remit fingerprint.
        if (tx) {
          tx.payment.traceNumber = str(el[2]);
          tx.payment.traceOriginatingCompanyId = str(el[3]);
        }
        break;
      }
      case 'N1': {
        // Loop 1000A payer (N101='PR'); 1000B payee (N101='PE'). Capture the payer.
        if (tx && (el[1] ?? '').trim().toUpperCase() === 'PR') {
          tx.payment.payerName = str(el[2]);
          tx.payment.payerId = str(el[4]);
        }
        break;
      }
      case 'CLP': {
        // New claim (Loop 2100). Flush the in-flight one.
        if (claim && tx) {
          if (line) claim.serviceLines.push(line);
          tx.claims.push(claim);
        }
        line = null;
        claim = {
          patientControlNumber: str(el[1]),
          claimStatusCode: str(el[2]),
          totalChargeAmount: num(el[3]),
          totalPaidAmount: num(el[4]),
          patientResponsibilityAmount: num(el[5]),
          claimFilingIndicator: str(el[6]),
          payerClaimControlNumber: str(el[7]),
          patientName: null,
          memberId: null,
          claimLevelAdjustments: [],
          serviceLines: [],
        };
        claimCount += 1;
        break;
      }
      case 'NM1': {
        if (!claim) break;
        const entity = (el[1] ?? '').trim().toUpperCase();
        if (entity === 'QC') {
          // Patient: NM103 last, NM104 first (PHI).
          const last = str(el[3]);
          const first = str(el[4]);
          claim.patientName = [last, first].filter((x) => x !== null).join(' ') || null;
        } else if (entity === 'IL') {
          // Subscriber/insured: NM109 member id (PHI).
          claim.memberId = str(el[9]);
        }
        break;
      }
      case 'SVC': {
        if (!claim) break;
        // Flush the previous line, start a new one (Loop 2110).
        if (line) claim.serviceLines.push(line);
        const composite = (el[1] ?? '').split(d.component);
        line = {
          lineNumber: claim.serviceLines.length + 1,
          // SVC01 is a composite qualifier:code[:mods]; the code is the 2nd component.
          procedureCode: str(composite[1]) ?? str(el[1]),
          chargeAmount: num(el[2]),
          paidAmount: num(el[3]),
          units: num(el[5]),
          serviceDate: null,
          lineItemControlNumber: null,
          adjustments: [],
          remarkCodes: [],
        };
        break;
      }
      case 'DTM': {
        // 472 = service date; attach to the current line if present.
        if (line && (el[1] ?? '').trim() === '472') line.serviceDate = x12Date(el[2]);
        break;
      }
      case 'REF': {
        // 6R = line item control number (Loop 2110).
        if (line && (el[1] ?? '').trim().toUpperCase() === '6R') {
          line.lineItemControlNumber = str(el[2]);
        }
        break;
      }
      case 'CAS': {
        if (!claim) break;
        // A CAS after an SVC is line-level; before any SVC it is claim-level.
        const adjustments = parseCasSegment(el, line ? 'LINE' : 'CLAIM');
        adjustmentCount += adjustments.length;
        if (line) line.adjustments.push(...adjustments);
        else claim.claimLevelAdjustments.push(...adjustments);
        break;
      }
      case 'LQ': {
        // Remark (RARC) code — LQ01='HE', LQ02=code. Counted; not a CAS triplet.
        if (line && (el[1] ?? '').trim().toUpperCase() === 'HE') {
          const code = str(el[2]);
          if (code) {
            line.remarkCodes.push(code);
            remarkCount += 1;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Flush the final in-flight line + claim.
  if (claim) {
    if (line) claim.serviceLines.push(line);
    if (tx) tx.claims.push(claim);
  }

  return { transactions, claimCount, adjustmentCount, remarkCount };
}
