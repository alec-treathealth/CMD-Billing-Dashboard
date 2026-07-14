/**
 * Billing Audit — "JT Master Issues" decision-matrix parser (PURE: no I/O, no env).
 *
 * LOCKED RULINGS (Alec, 2026-07-13): the CANONICAL matrix is tab "Billing Codes - EH"
 * (cols A–D + stray E/F annotation cells); tab "Test Claim Status- JT" (cols K–O) is
 * read for EXACTLY ONE thing — column O ("Date We Stopped Code") — and its L/M/N cells
 * are ignored entirely (they are staler duplicates; EH wins every conflict). Sync
 * output carries per-tab contribution counts so the precedence stays auditable.
 *
 * GRID SHAPE (live-verified 2026-07-13): repeating blocks. A block starts at a row
 * whose first cell matches `<FACILITY LABEL>/CARRIER` (no whitespace around the
 * slash — the EH tab's row-2 title "Facility / Carrier" deliberately does NOT match)
 * with the remaining cells holding the column labels. Data rows follow until the next
 * block header. Facility labels map to facility_code via FACILITY_LABEL_TO_CODE
 * (note NMH → NASH); an unknown label fails that whole block LOUDLY into parse notes
 * (never guessed).
 *
 * CELL QUIRKS handled (all live-observed):
 *  - "Codes Utilizing": `H0018/1001` · `NO HCPCS / 1001` (hcpcs=null) · `HCPCS/REV`
 *    (placeholder → rules-only row, both null) · spaces around the slash.
 *  - Finalized date: M/D/YYYY or MM/DD/YYYY; blank or non-date text (JT has
 *    "STILL PENDING") → null + a parse note.
 *  - Sub-cohorts ride in the carrier text: `(ZGP ALPHA)` / `(NON ZGP ALPHA)` →
 *    alpha_prefix 'ZGP' / 'NON-ZGP' (negation literal — the Phase-3 matcher
 *    interprets 'NON-<pfx>'); `(DTX)` / `(RTC)` → loc. carrier_text stays VERBATIM.
 *  - EH col E/F annotations (e.g. "Might be discontinued") are folded into
 *    rules_text with an ' — ' separator, never dropped.
 *  - JT stop annotation: `MM/DD (CODE)` with NO YEAR. Year inference: the block row's
 *    finalized year; if that would put the stop BEFORE the finalized date, +1 year.
 *    Un-inferable (no finalized date) → stop recorded as a needs-ruling note, NOT
 *    written (a dateless stop can't drive the generated `active` column).
 *  - Best-effort rule extraction from rules_text: '<n>[-<m>] DOS' → dos_bundle_min/max
 *    ('Single DOS' → 1/1); '86X TOB'/'863 TOB' → tob_pattern; 'DRG <n>' → drg.
 *    Unextracted stays null; rules_text is always verbatim.
 */

// Sheet facility label → claims.facility_alias facility_code. NMH is the sheet's
// label for Nashville (NASH). Keys are upper-cased for tolerant matching.
export const FACILITY_LABEL_TO_CODE: Readonly<Record<string, string>> = {
  KWC: 'KWC',
  LSMH: 'LSMH',
  DMH: 'DMH',
  NMH: 'NASH',
  TBH: 'TBH',
  CAMH: 'CAMH',
  PCMH: 'PCMH',
  'TREAT CA': 'TREAT_CA',
  'TREAT TX': 'TREAT_TX',
  'TREAT TN': 'TREAT_TN',
  'TREAT NV': 'TREAT_NV',
  'TREAT WA': 'TREAT_WA',
};

/** One parsed EH decision row (pre-DB shape; tenant stamped at sync time). */
export interface ParsedDecision {
  facility_code: string;
  carrier_text: string; //  verbatim from the sheet
  alpha_prefix: string | null;
  loc: string | null;
  hcpcs: string | null;
  rev_code: string | null;
  rules_text: string | null;
  dos_bundle_min: number | null;
  dos_bundle_max: number | null;
  tob_pattern: string | null;
  drg: string | null;
  finalized_on: string | null; // ISO
  source_tab: string;
  source_row: number; //        1-based sheet row
}

/** One JT stop annotation, already matched-ready (facility + carrier keys). */
export interface ParsedStop {
  facility_code: string;
  carrier_text: string;
  stopped_on: string; //  ISO (year inferred — see header)
  stopped_code: string | null;
  source_row: number;
}

const BLOCK_RE = /^(.+)\/CARRIER(\s*\(.*\))?$/i; // no whitespace around the slash (title row excluded)

const norm = (v: string | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

/** M/D/YYYY (or MM/DD/YYYY) → ISO, else null. Multi-line cells use the FIRST line. */
export function parseSheetDate(raw: string): string | null {
  const first = (raw ?? '').split('\n')[0]?.trim() ?? '';
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(first);
  if (!m) return null;
  const mm = m[1]!, dd = m[2]!, yyyy = m[3]!;
  const month = Number(mm), day = Number(dd), year = Number(yyyy);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'H0018/1001' | 'NO HCPCS / 1001' | 'HCPCS/REV' (placeholder) → {hcpcs, rev_code}. */
export function parseCodesCell(raw: string): { hcpcs: string | null; rev_code: string | null; placeholder: boolean } {
  const t = norm(raw);
  if (t === '') return { hcpcs: null, rev_code: null, placeholder: false };
  if (/^HCPCS\s*\/\s*REV$/i.test(t)) return { hcpcs: null, rev_code: null, placeholder: true };
  const m = /^(.+?)\s*\/\s*(\S+)$/.exec(t);
  if (!m) return { hcpcs: null, rev_code: null, placeholder: false };
  const left = norm(m[1]!);
  const rev = m[2]!.trim();
  const hcpcs = /^NO\s+HCPCS$/i.test(left) ? null : left.toUpperCase();
  return { hcpcs, rev_code: rev, placeholder: false };
}

/** Extract sub-cohort qualifiers from the carrier text (text itself stays verbatim). */
export function parseSubCohort(carrier: string): { alpha_prefix: string | null; loc: string | null } {
  let alpha: string | null = null;
  let loc: string | null = null;
  const paren = /\(([^)]+)\)/g;
  for (let m = paren.exec(carrier); m !== null; m = paren.exec(carrier)) {
    const inner = norm(m[1]!).toUpperCase();
    const alphaM = /^(NON\s+)?([A-Z]{2,4})\s+ALPHA$/.exec(inner);
    if (alphaM) alpha = alphaM[1] ? `NON-${alphaM[2]}` : alphaM[2]!;
    else if (/^(DTX|RTC|PHP|IOP)$/.test(inner)) loc = inner;
  }
  return { alpha_prefix: alpha, loc };
}

/** Best-effort DOS-bundle / TOB / DRG extraction from a rules cell (verbatim kept). */
export function parseRuleHints(rules: string): {
  dos_bundle_min: number | null; dos_bundle_max: number | null;
  tob_pattern: string | null; drg: string | null;
} {
  const t = norm(rules).toUpperCase();
  let min: number | null = null, max: number | null = null;
  if (/\bSINGLE DOS\b/.test(t)) { min = 1; max = 1; }
  else {
    const m = /\b(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*DOS\b/.exec(t);
    if (m) { min = Number(m[1]); max = m[2] ? Number(m[2]) : Number(m[1]); }
  }
  const tob = /\b(8\d[X\d])\s*TOB\b/.exec(t) ?? /\bTOB\s*[-:]?\s*(8\d[X\d])\b/.exec(t);
  const drg = /\bDRG\s*(\d{3})\b/.exec(t);
  return {
    dos_bundle_min: min, dos_bundle_max: max,
    tob_pattern: tob ? tob[1]! : null,
    drg: drg ? drg[1]! : null,
  };
}

/** JT col-O stop annotation 'MM/DD (CODE)' → stop date (year inferred) + code. */
export function parseStopAnnotation(
  raw: string,
  finalizedOn: string | null,
): { stopped_on: string; stopped_code: string | null } | { needsRuling: string } {
  const t = norm(raw);
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:\(([^)]+)\))?$/.exec(t);
  if (!m) return { needsRuling: `unparseable stop annotation shape` };
  const mm = m[1]!, dd = m[2]!, yyyy = m[3], code = m[4];
  let year: number;
  if (yyyy) year = Number(yyyy);
  else if (finalizedOn) {
    year = Number(finalizedOn.slice(0, 4));
    const candidate = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    if (candidate < finalizedOn) year += 1; // a stop cannot precede its decision
  } else {
    return { needsRuling: `year-less stop with no finalized date to infer from` };
  }
  if (parseSheetDate(`${mm}/${dd}/${year}`) === null) return { needsRuling: `invalid stop date` };
  const iso = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  return { stopped_on: iso, stopped_code: code ? code.trim().toUpperCase() : null };
}

interface Grid {
  rows: { rowNum: number; cells: string[] }[];
}

/** Walk a tab's grid block-by-block. `colOffset` selects the matrix columns
 *  (EH: 0 → A–F; JT: 10 → K–O). Yields per-row callbacks with block context. */
function walkBlocks(
  grid: Grid,
  colOffset: number,
  notes: string[],
  tabLabel: string,
  onRow: (facilityCode: string, rowNum: number, cells: string[]) => void,
): void {
  let facilityCode: string | null = null;
  for (const { rowNum, cells } of grid.rows) {
    const a = norm(cells[colOffset]);
    if (a === '') continue;
    const block = BLOCK_RE.exec(a);
    if (block) {
      const label = norm(block[1]!).toUpperCase();
      const code = FACILITY_LABEL_TO_CODE[label];
      if (code === undefined) {
        notes.push(`${tabLabel} r${rowNum}: unknown facility label in block header "${a}" — block skipped`);
        facilityCode = null;
      } else {
        facilityCode = code;
      }
      continue;
    }
    // The EH tab's decorative title row ("Facility / Carrier", spaced slash) and any
    // preamble rows land here before the first block — count them, never guess.
    if (facilityCode === null) {
      notes.push(`${tabLabel} r${rowNum}: data row before any recognized block header — skipped`);
      continue;
    }
    onRow(facilityCode, rowNum, cells);
  }
}

/** Parse the CANONICAL "Billing Codes - EH" grid (cols A–F). */
export function parseEhTab(grid: Grid, sourceTab: string): { decisions: ParsedDecision[]; notes: string[] } {
  const notes: string[] = [];
  const decisions: ParsedDecision[] = [];
  walkBlocks(grid, 0, notes, sourceTab, (facility_code, rowNum, cells) => {
    const carrier = norm(cells[0]);
    const dateRaw = norm(cells[1]);
    const codesRaw = norm(cells[2]);
    const rulesRaw = norm(cells[3]);
    const extras = [norm(cells[4]), norm(cells[5])].filter((v) => v !== '');
    if (carrier === '') return;
    const finalized = parseSheetDate(dateRaw);
    if (finalized === null && dateRaw !== '') {
      notes.push(`${sourceTab} r${rowNum}: ${facility_code}/"${carrier}" non-date finalized cell — finalized_on null`);
    }
    const codes = parseCodesCell(codesRaw);
    if (!codes.placeholder && codes.hcpcs === null && codes.rev_code === null && codesRaw !== '') {
      notes.push(`${sourceTab} r${rowNum}: ${facility_code}/"${carrier}" unparseable codes cell — rules-only row`);
    }
    const rules_text = [rulesRaw, ...extras].filter((v) => v !== '').join(' — ') || null;
    const hints = parseRuleHints(rules_text ?? '');
    const cohort = parseSubCohort(carrier);
    decisions.push({
      facility_code,
      carrier_text: carrier,
      alpha_prefix: cohort.alpha_prefix,
      loc: cohort.loc,
      hcpcs: codes.hcpcs,
      rev_code: codes.rev_code,
      rules_text,
      ...hints,
      finalized_on: finalized,
      source_tab: sourceTab,
      source_row: rowNum,
    });
  });
  return { decisions, notes };
}

/** Parse "Test Claim Status- JT" (cols K–O) for col-O stop annotations ONLY. */
export function parseJtStops(grid: Grid, tabLabel: string): { stops: ParsedStop[]; notes: string[] } {
  const notes: string[] = [];
  const stops: ParsedStop[] = [];
  walkBlocks(grid, 10, notes, tabLabel, (facility_code, rowNum, cells) => {
    const carrier = norm(cells[10]);
    const stopRaw = norm(cells[14]);
    if (carrier === '' || stopRaw === '' || /^DATE WE STOPPED CODE$/i.test(stopRaw)) return;
    const finalized = parseSheetDate(norm(cells[11])); // JT's own finalized date — ONLY for year inference
    const parsed = parseStopAnnotation(stopRaw, finalized);
    if ('needsRuling' in parsed) {
      notes.push(`${tabLabel} r${rowNum}: ${facility_code}/"${carrier}" stop NOT applied — ${parsed.needsRuling}`);
      return;
    }
    stops.push({ facility_code, carrier_text: carrier, ...parsed, source_row: rowNum });
  });
  return { stops, notes };
}

const carrierKey = (facility: string, carrier: string): string =>
  `${facility}\x1f${norm(carrier).toUpperCase()}`;

/**
 * Attach JT stops to EH decisions (EH-canonical merge). Match = (facility_code,
 * carrier_text) case-insensitively; when a carrier has multiple EH rows (sub-cohorts),
 * a stop carrying a code applies only to rows whose hcpcs equals it; a code-less stop
 * on a multi-row carrier is ambiguous → NOT applied, surfaced as a note. Returns the
 * per-tab contribution counts the sync output must carry.
 */
export function mergeStops(
  decisions: ParsedDecision[],
  stops: ParsedStop[],
): {
  merged: (ParsedDecision & { stopped_on: string | null; stopped_code: string | null })[];
  notes: string[];
  jt_stops_applied: number;
  jt_stops_unmatched: number;
} {
  const notes: string[] = [];
  const byCarrier = new Map<string, number[]>();
  decisions.forEach((d, i) => {
    const k = carrierKey(d.facility_code, d.carrier_text);
    byCarrier.set(k, [...(byCarrier.get(k) ?? []), i]);
  });
  const merged = decisions.map((d) => ({ ...d, stopped_on: null as string | null, stopped_code: null as string | null }));
  let applied = 0, unmatched = 0;
  for (const stop of stops) {
    const idxs = byCarrier.get(carrierKey(stop.facility_code, stop.carrier_text)) ?? [];
    if (idxs.length === 0) {
      unmatched += 1;
      notes.push(`JT stop r${stop.source_row} (${stop.facility_code}/"${stop.carrier_text}") has no EH decision row — unmatched`);
      continue;
    }
    const targets = stop.stopped_code === null
      ? idxs
      : idxs.filter((i) => merged[i]!.hcpcs === stop.stopped_code);
    if (targets.length === 0) {
      unmatched += 1;
      notes.push(
        `JT stop r${stop.source_row} (${stop.facility_code}/"${stop.carrier_text}") code ${stop.stopped_code} matches no EH row's hcpcs — unmatched`,
      );
      continue;
    }
    if (stop.stopped_code === null && targets.length > 1) {
      unmatched += 1;
      notes.push(
        `JT stop r${stop.source_row} (${stop.facility_code}/"${stop.carrier_text}") is code-less but the carrier has ${targets.length} EH rows — ambiguous, not applied`,
      );
      continue;
    }
    for (const i of targets) {
      merged[i]!.stopped_on = stop.stopped_on;
      merged[i]!.stopped_code = stop.stopped_code;
      applied += 1;
    }
  }
  return { merged, notes, jt_stops_applied: applied, jt_stops_unmatched: unmatched };
}
