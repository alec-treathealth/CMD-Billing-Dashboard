/**
 * "Upcoming Payments" override sheet — the PURE contract + parser.
 *
 * Source: the operator-maintained Google Sheet
 * `1auO2SDezdYS7tbqqDnk9OU_R7G-Erab8omvOZW0ANRQ`, a hand-keyed forward forecast of
 * payments ops knows are coming that have NO 835 yet and therefore cannot appear in
 * staging.era_835_payment. Lands in staging.expected_payment_override (migration 023) and
 * displays ALONGSIDE the ERA rows on the Overview "Future <tenant> Payments" tile.
 *
 * ADDITIVE-ONLY (Alec, 2026-08-03). Nothing here suppresses, replaces, or reconciles
 * against an ERA row. No supersedes key, no join to era_835_payment. ERA reconciliation is
 * separate, later work — until it ships, a forecast row left in the sheet after its 835
 * lands is double-counted, and the mitigation is operational (delete the sheet row).
 *
 * ⚠️ PHI BOUNDARY — THE MOST IMPORTANT THING IN THIS FILE.
 * The sheet's `Client` column CONTAINS PHI (patient first name + last initial on 4 of its
 * 9 current rows; the rest carry the literal batch sentinel `Multiple`). This parser reads
 * that cell, derives the boolean `isPatientSpecific`, and DISCARDS THE STRING. The name is
 * never returned, never stored, never logged, never put in an error message, and never sent
 * to an LLM. `ParsedOverrideRow` deliberately has NO field that could hold it — the type is
 * the enforcement, not a convention. If you find yourself adding one, stop: that makes this
 * whole tile PHI (src/veris/era835Upcoming.ts declares it "Non-PHI throughout") and needs
 * 021's encryption + blind-index treatment in a separate table.
 *
 * REJECTION IS SURFACED, NOT SILENT (decisionSync's proven posture). A row the parser
 * cannot trust is dropped AND reported with its row number and a reason code — never
 * guessed at, never silently skipped. The caller logs the codes; the codes carry no cell
 * content, so they are safe to log.
 *
 * Everything in this module is PURE — no I/O, no clock, no DB. The sync
 * (upcomingOverride.ts) owns the transport and the writes, so all of this is unit-testable
 * without a network or a database.
 */

/** One tab's grid: 1-based sheet row numbers, structured cells (never CSV). */
export interface OverrideGrid {
  rows: { rowNum: number; cells: string[] }[];
}

/**
 * THE CANONICAL TAB. A DEDICATED tab, not the existing multi-section "Upcoming Payments"
 * sheet — that one stacks an abandoned `Auth or Claim Issue` header, a section title, the
 * real header, a 2-row gap, an orphan row, and a `Total` row whose label sits in column 5.
 * Parsing that shape in place would bake permanent brittleness into this module for no
 * benefit. One flat tab, header on row 1, data below. Alec reshapes once.
 */
export const OVERRIDE_TAB = 'Upcoming Payments Overrides';

/**
 * THE CANONICAL HEADER — exact spelling, exact order, row 1.
 *
 * Deliberately identical to the existing sheet's own header row (`Facility`, `Insurance`,
 * `Client`, `Date`, `Check or EFT`, `Amount`) so reshaping is a copy-paste into a new tab
 * rather than a rename exercise. `Client` stays in the contract because the operator needs
 * it to do their job — it is dropped at THIS boundary, not removed from the sheet.
 */
export const OVERRIDE_HEADERS = [
  'Facility',
  'Insurance',
  'Client',
  'Date',
  'Check or EFT',
  'Amount',
] as const;

/** Column indices, derived from the contract so the two can never drift apart. */
const COL = {
  facility: OVERRIDE_HEADERS.indexOf('Facility'),
  insurance: OVERRIDE_HEADERS.indexOf('Insurance'),
  client: OVERRIDE_HEADERS.indexOf('Client'),
  date: OVERRIDE_HEADERS.indexOf('Date'),
  method: OVERRIDE_HEADERS.indexOf('Check or EFT'),
  amount: OVERRIDE_HEADERS.indexOf('Amount'),
} as const;

/**
 * The batch sentinel in the `Client` column: "this forecast covers several patients".
 * Compared case-insensitively after trimming. Anything else non-blank is treated as an
 * individual patient — which sets the boolean and discards the value.
 */
const CLIENT_BATCH_SENTINEL = 'multiple';

/** The sheet's own payment-method vocabulary. NOT X12 BPR04 codes — see 023's column comment. */
export type MethodLabel = 'EFT' | 'Check';

/**
 * FACILITY ALIAS TABLE — sheet label → canonical facility_code.
 *
 * The sheet and the customer roster (src/collections/cmdCustomers.ts) DISAGREE on spelling,
 * so this mapping is mandatory rather than cosmetic:
 *   - `TMHWA` / `TMH WA`        → TREAT_WA     (and the same for CA / TN / TX / NV)
 *   - `DLMH`                    → DMH          (Dallas Mental Health)
 *   - `Telehealth MH`           → TELEHEALTH_MH
 * Keys are NORMALIZED (see normalizeFacilityLabel): upper-cased with all spaces,
 * underscores, hyphens and dots removed, so `TMH WA`, `TMHWA`, `tmh_wa` and `TMH-WA` all
 * resolve to the same entry and a stray space in the sheet cannot break the sync.
 *
 * ⚠️ DELIBERATELY ABSENT, AND NOW RULED ON: `Teen Mental Health`, which appears in the
 * workbook's July OP grid and resolves to NOTHING here. The closest roster match is Indigo's
 * MY TEEN MENTAL HEALTH (CMD customer 10034230) — a DIFFERENT TENANT. Alec CONFIRMED that
 * reading on 2026-08-03, so this entry stays absent permanently rather than pending: mapping it
 * to a BXR code would cross-attribute another tenant's money, and mapping it to the Indigo code
 * would land an Indigo row under whichever tenant the sync runs for (BXR today). It is reported
 * as unmapped every run, which is the correct outcome, not a backlog item.
 *
 * The route to actually ingesting it is an INDIGO override tab with its own alias entries and a
 * second sync call under INDIGO_TENANT_ID — a widening of the feed, not of this table.
 * `test/upcomingForecast.test.ts` asserts every value below is on the BXR roster, so an entry
 * added here that crosses tenants fails the suite rather than shipping.
 *
 * Every value below is a real BXR facilityCode from cmdCustomers.ts. The sheet is BXR-only
 * today (all 9 live rows are BXR facilities); an Indigo override tab would need its own
 * alias entries, and Indigo's facilityCode IS the 8-digit CMD id, so those would be
 * numeric strings rather than acronyms.
 */
const FACILITY_ALIASES: Readonly<Record<string, string>> = {
  // Inpatient — sheet label already matches the roster code.
  CAMH: 'CAMH',
  PCMH: 'PCMH',
  LAMH: 'LAMH',
  LSMH: 'LSMH',
  KWC: 'KWC',
  TBH: 'TBH',
  NASH: 'NASH',
  // Inpatient — sheet label DIFFERS from the roster code.
  DLMH: 'DMH', // sheet writes DLMH; roster code is DMH (DALLAS MENTAL HEALTH)
  DMH: 'DMH', // accept the canonical code too, in case someone types it
  // Outpatient — sheet label already matches.
  FRCA: 'FRCA',
  // Outpatient — the TMH family. Roster codes are TREAT_*, sheet writes TMH*.
  TMHCA: 'TREAT_CA',
  TMHTN: 'TREAT_TN',
  TMHTX: 'TREAT_TX',
  TMHWA: 'TREAT_WA',
  TMHNV: 'TREAT_NV',
  TREATCA: 'TREAT_CA', // accept the canonical codes too (normalization strips the underscore)
  TREATTN: 'TREAT_TN',
  TREATTX: 'TREAT_TX',
  TREATWA: 'TREAT_WA',
  TREATNV: 'TREAT_NV',
  // Outpatient — telehealth.
  TELEHEALTHMH: 'TELEHEALTH_MH',
};

/**
 * Normalize a facility label for alias lookup: upper-case, then strip spaces, underscores,
 * hyphens and dots. Makes `TMH WA` / `TMHWA` / `tmh_wa` / `TMH-WA` / `T.M.H.W.A` one key,
 * so a cosmetic hand-edit in the sheet cannot drop a forecast row.
 */
export function normalizeFacilityLabel(label: string): string {
  return label.toUpperCase().replace(/[\s_.-]+/g, '');
}

/**
 * Resolve a sheet facility label to a canonical facility_code, or null when unmapped.
 * Null is a REJECTION signal, never a fallback — the caller reports it rather than landing
 * the row under a guessed code (see the `Teen Mental Health` note above).
 */
export function resolveFacilityCode(label: string): string | null {
  return FACILITY_ALIASES[normalizeFacilityLabel(label.trim())] ?? null;
}

/** Every canonical facility_code this parser can produce — for tests and diagnostics. */
export function knownFacilityCodes(): string[] {
  return [...new Set(Object.values(FACILITY_ALIASES))].sort();
}

/**
 * Parse the sheet's currency text to EXACT INTEGER CENTS. Handles both formats present in
 * the workbook — `$35,000.00` (no space, tab 1 / footers) and `$ 19,832.60` (one space,
 * grid cells) — plus bare numbers, and the `$ -` zero sentinel.
 *
 * NEVER parseFloat: this feeds a money total, and float addition drifts (0.1 + 0.2). Same
 * discipline as era835Upcoming.centsFromNumericText, which this deliberately mirrors so the
 * ERA half and the forecast half of the tile add up in the same arithmetic.
 *
 * Returns null on anything unparseable — including the `$ -` sentinel's zero, which is a
 * REJECTION here rather than a value: migration 023 CHECKs amount > 0, and a $0 "expected
 * payment" is not a forecast. Negatives (`-$10`, `($10)`) also return null; a negative
 * expected payment is a takeback, a different concept that must fail loudly.
 */
export function centsFromCurrency(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  // The zero sentinel, in either spacing. Explicitly rejected, not returned as 0.
  if (/^\$?\s*-$/.test(t)) return null;
  const m = t.match(/^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null; // includes every negative form — no leading '-' or '(' is accepted
  const whole = Number(m[1]!.replace(/,/g, ''));
  const frac = Number((m[2] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(whole)) return null;
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) return null;
  // numeric(12,2) tops out at 10 digits before the decimal point.
  if (whole > 9_999_999_999) return null;
  return cents;
}

/** Integer cents → fixed-2 text for a numeric(12,2) bind ('3500000' → '35000.00'). */
export function fixed2FromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse the sheet's `MM/DD/YYYY` to an ISO `YYYY-MM-DD`, STRICTLY.
 *
 * Strict means the round trip is verified: `02/30/2026` parses arithmetically into March 2
 * under Date's rollover, so we rebuild the components from the constructed UTC date and
 * reject any mismatch. A silently rolled-over date would place a forecast on the wrong day
 * on a money timeline.
 *
 * UTC construction on purpose — this is a CIVIL date off a spreadsheet with no time and no
 * zone. Building it in local time would shift the day for anyone running west of UTC
 * (Vercel runs TZ=UTC; a dev machine on PT does not). The tile's "today" cutoff is handled
 * separately and correctly by era835Upcoming.businessTodayIso.
 */
export function isoFromSheetDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  // Round-trip check: rejects 02/30, 04/31, 02/29 in a non-leap year.
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
    return null;
  }
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Normalize the `Check or EFT` cell to the closed set 023 CHECKs. Null when unrecognized. */
export function resolveMethodLabel(raw: string): MethodLabel | null {
  const t = raw.trim().toLowerCase();
  if (t === 'eft' || t === 'ach' || t === 'wire') return 'EFT';
  if (t === 'check' || t === 'chk' || t === 'cheque') return 'Check';
  return null;
}

/**
 * ONE trusted forecast row. NOTE WHAT IS ABSENT: there is no patient/client field, by
 * design (see the PHI boundary note in the file header). This type IS the PHI boundary.
 */
export interface ParsedOverrideRow {
  /** Canonical facility_code, alias-resolved. Never the raw sheet label. */
  facilityCode: string;
  /** The `Insurance` cell, trimmed, otherwise verbatim. Non-PHI. */
  payerLabel: string;
  /** ISO `YYYY-MM-DD`. */
  expectedDate: string;
  methodLabel: MethodLabel;
  /** Fixed-2 numeric text for a numeric(12,2) bind. Never a JS float. */
  amount: string;
  /** Exact integer cents — the same number `amount` encodes. For in-process totals. */
  amountCents: number;
  /** false = the `Client` cell was the `Multiple` batch sentinel. THE NAME IS NOT HERE. */
  isPatientSpecific: boolean;
  /** 1-based sheet row. Traceability only — explicitly not an idempotency key. */
  sourceRowNum: number;
}

/** Why a row was rejected. CODES ONLY — no cell content, so these are safe to log. */
export type OverrideRejectReason =
  | 'unmapped_facility'
  | 'missing_facility'
  | 'missing_payer'
  | 'bad_date'
  | 'bad_method'
  | 'bad_amount';

export interface OverrideReject {
  rowNum: number;
  reason: OverrideRejectReason;
  /**
   * The offending FACILITY LABEL only, and only for `unmapped_facility`. A facility label
   * is non-PHI and is the one value an operator needs echoed back to fix the sheet (or to
   * get an alias ruling). Every other reason carries NO cell content — notably `bad_amount`
   * and `bad_date` never echo their cell, because a mis-keyed row could have a name in the
   * wrong column and echoing it would leak PHI through an error path.
   *
   * ⚠️ RESIDUAL RISK, BOUNDED NOT ELIMINATED (flagged 2026-08-03). That last argument applies
   * to THIS column too: the sheet's Client column holds patient names, and a shifted paste
   * puts one in the Facility cell, from where it reaches the cron log and response body. The
   * echo is kept because the alias ruling genuinely needs the label, but it is now truncated
   * by `safeFacilityLabel` so a pasted block can never spill, and the row number alone is
   * enough for a human to find the cell. If the residual is unacceptable, delete this field
   * and read the label off the sheet by rowNum — nothing else depends on it.
   */
  facilityLabel?: string;
}

/**
 * Bound what a rejection may echo. Facility codes in this roster top out well under 32
 * characters ('TELEHEALTH_MH' is 13), so truncation never loses a real label — it only caps
 * the blast radius when the cell contains something that is not a facility at all. Also
 * collapses whitespace so a multi-line paste cannot forge log lines.
 */
export function safeFacilityLabel(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= 32 ? flat : `${flat.slice(0, 31)}…`;
}

export interface ParsedOverrideSheet {
  rows: ParsedOverrideRow[];
  rejects: OverrideReject[];
  /** Distinct unmapped facility labels, sorted — the needs-a-ruling list, surfaced every run. */
  unmappedFacilities: string[];
}

/**
 * Validate the header row against OVERRIDE_HEADERS. Throws LOUD on any drift.
 *
 * Positional AND exact (case-insensitive on the header text only), mirroring
 * src/sheets.ts.buildColumnOrder: mis-mapping columns on a sheet whose column 3 is PHI and
 * whose column 6 is money is not a recoverable error. A reordered header must fail the
 * sync, not quietly swap `Amount` for `Date`.
 *
 * Extra trailing columns are TOLERATED (an operator adding a scratch note column to the
 * right must not break the feed); the first six must be exactly right.
 */
export function assertOverrideHeader(header: string[]): void {
  if (header.length < OVERRIDE_HEADERS.length) {
    throw new Error(
      `Override tab header has ${header.length} columns, expected at least ` +
        `${OVERRIDE_HEADERS.length} (${OVERRIDE_HEADERS.join(', ')}). ` +
        `Sheet shape has drifted — refusing to map columns by guess.`,
    );
  }
  OVERRIDE_HEADERS.forEach((expected, i) => {
    const actual = (header[i] ?? '').trim();
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `Override tab column ${i} header mismatch: got ${JSON.stringify(actual)}, ` +
          `expected ${JSON.stringify(expected)}. Refusing to map by guess.`,
      );
    }
  });
}

/**
 * Parse the override tab. Row 1 is the header (validated, throws on drift); every row below
 * is a candidate forecast.
 *
 * Fully-blank rows are SKIPPED SILENTLY, not rejected — a hand-maintained sheet always has
 * trailing empties and spacer rows, and reporting them as failures would bury the real
 * rejections in noise. A row with SOME content but a bad field IS rejected and reported.
 */
export function parseOverrideSheet(grid: OverrideGrid): ParsedOverrideSheet {
  const headerRow = grid.rows.find((r) => r.rowNum === 1) ?? grid.rows[0];
  assertOverrideHeader(headerRow?.cells ?? []);

  const rows: ParsedOverrideRow[] = [];
  const rejects: OverrideReject[] = [];
  const unmapped = new Set<string>();

  for (const { rowNum, cells } of grid.rows) {
    if (rowNum <= 1) continue; // the header
    const cell = (i: number): string => (cells[i] ?? '').trim();

    const facilityLabel = cell(COL.facility);
    const payerLabel = cell(COL.insurance);
    const dateRaw = cell(COL.date);
    const methodRaw = cell(COL.method);
    const amountRaw = cell(COL.amount);
    const clientRaw = cell(COL.client);

    // A row with nothing in ANY of the six contract columns is sheet whitespace, not a
    // defect. Note clientRaw participates in the blank test but is never stored.
    if (
      facilityLabel === '' &&
      payerLabel === '' &&
      dateRaw === '' &&
      methodRaw === '' &&
      amountRaw === '' &&
      clientRaw === ''
    ) {
      continue;
    }

    if (facilityLabel === '') {
      rejects.push({ rowNum, reason: 'missing_facility' });
      continue;
    }
    const facilityCode = resolveFacilityCode(facilityLabel);
    if (facilityCode === null) {
      // Truncated on the way out — see safeFacilityLabel and the residual-risk note on
      // OverrideReject.facilityLabel. The unmapped SET carries the same bounded form so the
      // needs-a-ruling list and the per-row reject can never disagree.
      const safe = safeFacilityLabel(facilityLabel);
      unmapped.add(safe);
      rejects.push({ rowNum, reason: 'unmapped_facility', facilityLabel: safe });
      continue;
    }
    if (payerLabel === '') {
      rejects.push({ rowNum, reason: 'missing_payer' });
      continue;
    }
    const expectedDate = isoFromSheetDate(dateRaw);
    if (expectedDate === null) {
      rejects.push({ rowNum, reason: 'bad_date' });
      continue;
    }
    const methodLabel = resolveMethodLabel(methodRaw);
    if (methodLabel === null) {
      rejects.push({ rowNum, reason: 'bad_method' });
      continue;
    }
    const amountCents = centsFromCurrency(amountRaw);
    if (amountCents === null || amountCents <= 0) {
      // Catches blanks, the `$ -` sentinel, negatives, and the `Total` footer row if one
      // is ever pasted in (its label sits in a different column, so it fails here).
      rejects.push({ rowNum, reason: 'bad_amount' });
      continue;
    }

    // ⚠️ THE PHI DROP, RIGHT HERE. clientRaw is read to derive the boolean and then goes
    // out of scope. It is not assigned to the pushed object, not logged, not put in a
    // reject. A blank Client cell is treated as a batch (not patient-specific) — the
    // conservative reading, and it keeps a missing cell from implying a named patient.
    const isPatientSpecific =
      clientRaw !== '' && clientRaw.toLowerCase() !== CLIENT_BATCH_SENTINEL;

    rows.push({
      facilityCode,
      payerLabel,
      expectedDate,
      methodLabel,
      amount: fixed2FromCents(amountCents),
      amountCents,
      isPatientSpecific,
      sourceRowNum: rowNum,
    });
  }

  return {
    rows,
    rejects,
    unmappedFacilities: [...unmapped].sort(),
  };
}
