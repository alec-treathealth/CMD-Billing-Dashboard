/**
 * Coding-decision SEED PARSER (Phase A) — turns the billing team's matrix (pasted as TSV) into
 * validated coding.code_decision rows, surfacing every defect instead of silently guessing.
 * Pure + hermetic (no I/O); scripts/seed-coding-decisions.ts owns file reading and DB writes.
 *
 * The sheet is a decision LOG, not a fee schedule (§4): no dollar amounts exist here and none are
 * parsed. Known ingest defects handled by NAME (from the plan's own list): '0714/2026' (corrupt
 * date), 'STILL PENDING' in a date column, '04/07/2026 Single DOS per CB as of 6/10' (date +
 * trailing prose), mixed '5/21/2026' / '05/21/2026', 'HCPCS/REV' header noise, facility long-forms
 * needing an alias map, and the 'NO HCPCS' sentinel (a billing METHOD — suppress the HCPCS line and
 * bill the revenue code alone — never a missing value).
 *
 * Expected TSV columns (header row required, case-insensitive, extra columns ignored):
 *   facility_code · payer_label · decided_on · codes_utilizing · billing_rules · lifecycle · notes
 */
import {
  CODING_LIFECYCLE_VALUES,
  normalizePayerFamily,
  type CodingLifecycleValue,
} from './codingRegistryQuery.js';

export interface ParsedCodingDecision {
  payer_family: string;
  payer_variant_label: string;
  plan_alpha: string | null;
  employer_norm: string | null;
  level_of_care: string | null;
  facility_code: string | null;
  hcpcs_code: string | null;
  revenue_code: string;
  hcpcs_suppressed: boolean;
  dos_batch_min: number | null;
  dos_batch_max: number | null;
  type_of_bill: string | null;
  drg_code: string | null;
  condition_codes: string[] | null;
  modifiers_removed: string[] | null;
  units_per_dos: number | null;
  billing_span: string | null;
  lifecycle: CodingLifecycleValue;
  decided_on: string; // ISO
  effective_from: string; // ISO (= decided_on)
  notes: string | null;
}

export interface SeedDefect {
  line: number; // 1-based data-row line number in the TSV (header = line 1)
  field: string;
  value: string;
  reason: string;
}

export interface SeedParseResult {
  decisions: ParsedCodingDecision[];
  defects: SeedDefect[];
  skipped: number; // rows dropped because a required field was unusable
}

const HEADER_ALIASES: Record<string, string> = {
  facility: 'facility_code',
  facility_code: 'facility_code',
  'facility / carrier': 'payer_label', // the sheet's merged header — importer templates split it
  payer: 'payer_label',
  payer_label: 'payer_label',
  carrier: 'payer_label',
  decided_on: 'decided_on',
  'date code decision finalized': 'decided_on',
  codes_utilizing: 'codes_utilizing',
  'codes utilizing': 'codes_utilizing',
  billing_rules: 'billing_rules',
  'additional billing rules': 'billing_rules',
  lifecycle: 'lifecycle',
  'test status': 'lifecycle',
  notes: 'notes',
  plan_alpha: 'plan_alpha',
  employer_norm: 'employer_norm',
  level_of_care: 'level_of_care',
  loc: 'level_of_care',
};

/** 'M/D/YYYY' or 'MM/DD/YYYY' → ISO; null when not a real calendar date ('0714/2026' lands here). */
export function parseSheetDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null; // 2/30-class impossibles
  return d.toISOString().slice(0, 10);
}

/** Codes cell → {hcpcs, rev, suppressed}. 'H0017/0158' · 'NO HCPCS / 1001' · bare '0158'.
 *  'HCPCS/REV' (the header-noise literal) returns null → the caller records a defect. */
export function parseCodesCell(raw: string): { hcpcs: string | null; rev: string | null; suppressed: boolean } | null {
  const cell = raw.trim();
  if (cell === '' || /^HCPCS\s*\/\s*REV$/i.test(cell)) return null;
  const parts = cell.split('/').map((p) => p.trim());
  if (parts.length === 1) {
    // A lone value: a revenue code if it looks like one, else a lone HCPCS with no rev (defect upstream).
    if (/^\d{3,4}$/.test(parts[0]!)) return { hcpcs: null, rev: parts[0]!.padStart(4, '0'), suppressed: false };
    if (/^[A-Z]\d{4}$/i.test(parts[0]!)) return { hcpcs: parts[0]!.toUpperCase(), rev: null, suppressed: false };
    return null;
  }
  const [left, right] = [parts[0]!, parts[1]!];
  const rev = /^\d{3,4}$/.test(right) ? right.padStart(4, '0') : null;
  if (/^NO\s*HCPCS$/i.test(left)) return { hcpcs: null, rev, suppressed: true };
  if (/^[A-Z]\d{4}$/i.test(left) || /^\d{5}$/.test(left)) return { hcpcs: left.toUpperCase(), rev, suppressed: false };
  if (left === '') return { hcpcs: null, rev, suppressed: false };
  return null;
}

/** The seven orthogonal axes conflated in 'Additional Billing Rules' (§4), extracted per segment. */
export interface ParsedRules {
  dos_batch_min: number | null;
  dos_batch_max: number | null;
  type_of_bill: string | null;
  billing_span: string | null;
  drg_code: string | null;
  condition_codes: string[] | null;
  modifiers_removed: string[] | null;
  units_per_dos: number | null;
  rev_only: string | null; // 'REV ONLY 0124' — suppression stated in the rules column
  residue: string[]; // segments no axis claimed — preserved into notes, never dropped
}

export function parseBillingRules(raw: string): ParsedRules {
  const out: ParsedRules = {
    dos_batch_min: null,
    dos_batch_max: null,
    type_of_bill: null,
    billing_span: null,
    drg_code: null,
    condition_codes: null,
    modifiers_removed: null,
    units_per_dos: null,
    rev_only: null,
    residue: [],
  };
  const segments = raw
    .split(/[;,•·]|(?<=\S)\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const seg of segments) {
    let claimed = false;
    let m: RegExpMatchArray | null;
    if (/single\s+dos/i.test(seg)) {
      out.dos_batch_min = 1;
      out.dos_batch_max = 1;
      claimed = true;
    } else if ((m = seg.match(/(\d+)\s*-\s*(\d+)\s*dos/i))) {
      out.dos_batch_min = Number(m[1]);
      out.dos_batch_max = Number(m[2]);
      claimed = true;
    } else if ((m = seg.match(/bulk\s*(\d+)\s*dos|(\d+)\s*dos\s*bulked|(\d+)\s*dos\s*per\s*claim/i))) {
      const n = Number(m[1] ?? m[2] ?? m[3]);
      out.dos_batch_min = n;
      out.dos_batch_max = n;
      claimed = true;
    }
    if ((m = seg.match(/\btob\s*([0-9]{2,3}x?)\b/i)) || (m = seg.match(/\b([0-9]{2,3}x?)\s*tob\b/i))) {
      out.type_of_bill = m[1]!.toUpperCase();
      claimed = true;
    } else if (/^[0-9]{3}$/.test(seg)) {
      // A bare 3-digit segment in the rules column is a type of bill in the sheet's own idiom ('863', '763').
      out.type_of_bill = seg;
      claimed = true;
    }
    if (/denied\s+for\s+interim/i.test(seg)) {
      out.billing_span = 'admit_dc'; // interim was TRIED and denied — bill admit-through-DC
      claimed = true;
    } else if (/\binterim\b/i.test(seg)) {
      out.billing_span = 'interim';
      claimed = true;
    } else if (/admit\s*-?\s*(through\s*)?dc/i.test(seg)) {
      out.billing_span = 'admit_dc';
      claimed = true;
    }
    if ((m = seg.match(/add\s+drg\s*([0-9A-Z]+)/i))) {
      out.drg_code = m[1]!.toUpperCase();
      claimed = true;
    }
    if ((m = seg.match(/condition\s+code\s*([0-9A-Z]+)/i))) {
      out.condition_codes = [...(out.condition_codes ?? []), m[1]!.toUpperCase()];
      claimed = true;
    }
    if ((m = seg.match(/remov\w*\s+([A-Z0-9]{2})\s+mod/i))) {
      out.modifiers_removed = [...(out.modifiers_removed ?? []), m[1]!.toUpperCase()];
      claimed = true;
    }
    if ((m = seg.match(/(\d+(?:\.\d+)?)\s*units?/i))) {
      out.units_per_dos = Number(m[1]);
      claimed = true;
    }
    if ((m = seg.match(/rev\s*only\s*(\d{3,4})/i))) {
      out.rev_only = m[1]!.padStart(4, '0');
      claimed = true;
    }
    if (!claimed) out.residue.push(seg);
  }
  return out;
}

function lifecycleOf(raw: string): CodingLifecycleValue | null {
  const norm = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  return (CODING_LIFECYCLE_VALUES as readonly string[]).includes(norm) ? (norm as CodingLifecycleValue) : null;
}

/**
 * Parse the whole TSV. `facilityAliases` maps sheet long-forms → facility_code ('KY Wellness' → 'KWC',
 * 'Nashville MH' → 'NMH'); unmatched non-empty facility text becomes a defect (row kept, facility null —
 * a payer-wide default is worse than a named one, so the operator fixes the alias and re-runs).
 */
export function parseCodingSeedTsv(tsv: string, facilityAliases: Record<string, string> = {}): SeedParseResult {
  const lines = tsv.split(/\r?\n/);
  const defects: SeedDefect[] = [];
  const decisions: ParsedCodingDecision[] = [];
  let skipped = 0;
  if (lines.length === 0 || lines[0]!.trim() === '') return { decisions, defects, skipped };

  const header = lines[0]!.split('\t').map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
  const col = (row: string[], name: string): string => {
    const i = header.indexOf(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  const aliasLookup = new Map(Object.entries(facilityAliases).map(([k, v]) => [k.trim().toUpperCase(), v]));

  for (let li = 1; li < lines.length; li++) {
    const rawLine = lines[li]!;
    if (rawLine.trim() === '') continue;
    const row = rawLine.split('\t');
    const lineNo = li + 1;

    const payerLabel = col(row, 'payer_label');
    if (payerLabel === '') {
      defects.push({ line: lineNo, field: 'payer_label', value: '', reason: 'missing payer label' });
      skipped++;
      continue;
    }
    const family = normalizePayerFamily(payerLabel);
    if (!family) {
      defects.push({ line: lineNo, field: 'payer_label', value: payerLabel, reason: 'no payer-family rule matches — add a rule or correct the label' });
      skipped++;
      continue;
    }

    // Date: strict parse; 'STILL PENDING' and corrupt forms are defects; trailing prose is split off.
    const rawDate = col(row, 'decided_on');
    let decidedIso: string | null = null;
    let dateResidue = '';
    if (/still\s+pending/i.test(rawDate)) {
      defects.push({ line: lineNo, field: 'decided_on', value: rawDate, reason: "'STILL PENDING' in the date column — decide a date or leave the row out until finalized" });
      skipped++;
      continue;
    }
    const dm = rawDate.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)$/);
    if (dm) {
      decidedIso = parseSheetDate(dm[1]!);
      dateResidue = (dm[2] ?? '').trim();
    }
    if (!decidedIso) {
      defects.push({ line: lineNo, field: 'decided_on', value: rawDate, reason: 'not a real calendar date (the 0714/2026 class)' });
      skipped++;
      continue;
    }

    // Codes: the packed cell + the NO-HCPCS sentinel; 'REV ONLY nnnn' in the rules column can rescue
    // a missing rev code.
    const rawCodes = col(row, 'codes_utilizing');
    const codes = parseCodesCell(rawCodes);
    const rules = parseBillingRules([col(row, 'billing_rules'), dateResidue].filter(Boolean).join('; '));
    let hcpcs = codes?.hcpcs ?? null;
    let rev = codes?.rev ?? null;
    let suppressed = codes?.suppressed ?? false;
    if (rules.rev_only) {
      rev = rev ?? rules.rev_only;
      suppressed = true;
      hcpcs = null;
    }
    if (!codes && !rules.rev_only) {
      defects.push({ line: lineNo, field: 'codes_utilizing', value: rawCodes, reason: 'unparseable codes cell (header noise or unknown shape)' });
      skipped++;
      continue;
    }
    if (!rev) {
      defects.push({ line: lineNo, field: 'codes_utilizing', value: rawCodes, reason: 'no revenue code — revenue_code is required on every decision' });
      skipped++;
      continue;
    }

    const lc = lifecycleOf(col(row, 'lifecycle'));
    if (!lc) {
      defects.push({ line: lineNo, field: 'lifecycle', value: col(row, 'lifecycle'), reason: 'not one of the Test Status enum values' });
      skipped++;
      continue;
    }

    // Facility: exact facility_code OR alias long-form; unmatched text → defect, row kept payer-wide.
    const rawFac = col(row, 'facility_code');
    let facility: string | null = null;
    if (rawFac !== '') {
      const aliased = aliasLookup.get(rawFac.toUpperCase());
      if (aliased) facility = aliased;
      else if (/^[A-Z0-9_]{2,40}$/.test(rawFac)) facility = rawFac;
      else {
        defects.push({ line: lineNo, field: 'facility_code', value: rawFac, reason: 'unrecognized facility text — add it to the alias map (row seeded payer-wide until fixed)' });
      }
    }

    const locRaw = col(row, 'level_of_care').toUpperCase();
    const loc = ['DTX', 'RTC', 'IP', 'IOP', 'OP'].includes(locRaw) ? locRaw : null;
    // Date-cell prose is preserved VERBATIM (provenance) even when an axis pattern also claimed part
    // of it — '04/07/2026 Single DOS per CB as of 6/10' must keep 'per CB as of 6/10' somewhere.
    const notes =
      [col(row, 'notes'), dateResidue ? `date cell: ${dateResidue}` : '', ...rules.residue].filter(Boolean).join(' · ') || null;
    const planAlpha = col(row, 'plan_alpha') || null;
    const employerNorm = col(row, 'employer_norm') || null;

    decisions.push({
      payer_family: family,
      payer_variant_label: payerLabel,
      plan_alpha: planAlpha,
      employer_norm: employerNorm,
      level_of_care: loc,
      facility_code: facility,
      hcpcs_code: suppressed ? null : hcpcs,
      revenue_code: rev,
      hcpcs_suppressed: suppressed,
      dos_batch_min: rules.dos_batch_min,
      dos_batch_max: rules.dos_batch_max,
      type_of_bill: rules.type_of_bill,
      drg_code: rules.drg_code,
      condition_codes: rules.condition_codes,
      modifiers_removed: rules.modifiers_removed,
      units_per_dos: rules.units_per_dos,
      billing_span: rules.billing_span,
      lifecycle: lc,
      decided_on: decidedIso,
      effective_from: decidedIso,
      notes,
    });
  }
  return { decisions, defects, skipped };
}
