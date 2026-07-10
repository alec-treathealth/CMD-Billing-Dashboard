/**
 * PURE fixed-width parser for the CMS Alpha-Numeric HCPCS file. No I/O.
 *
 * Reads each data line per the (reviewed) HCPCS_RECORD_LAYOUT column map and yields
 * normalized HcpcsRecord objects. Deliberately tolerant: lines shorter than the
 * layout's minLineLength (headers/footers/blank) are skipped; a line with no code in
 * the code column is skipped. Descriptions are trimmed; empty long-desc becomes null.
 *
 * WHY fixed-width (not pipe/CSV): the CMS ANWEB record is a fixed-width layout — the
 * original draft's pipe-delimited assumption does not match the source. See AUDIT.md.
 */
import type { FixedWidthField, HcpcsRecordLayout } from './layout.js';
import { HCPCS_RECORD_LAYOUT } from './layout.js';
import type { HcpcsRecord } from './types.js';

/** Slice a 1-based inclusive [start,end] range out of a line; '' if out of range. */
function slice(line: string, field: FixedWidthField): string {
  // 1-based inclusive → 0-based [start-1, end).
  return line.slice(field.start - 1, field.end);
}

/** YYYYMMDD (all digits, valid-ish month/day) → 'YYYY-MM-DD', else null. */
export function normalizeCmsDate(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d{8}$/.test(s)) return null;
  const y = s.slice(0, 4);
  const m = s.slice(4, 6);
  const d = s.slice(6, 8);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

/**
 * Parse the full text of the HCPCS data member into normalized records.
 * Splits on CRLF or LF. Pure — same input always yields the same output.
 */
export function parseHcpcsFixedWidth(
  text: string,
  layout: HcpcsRecordLayout = HCPCS_RECORD_LAYOUT,
): HcpcsRecord[] {
  const out: HcpcsRecord[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (const line of lines) {
    if (line.length < layout.minLineLength) continue;

    const code = slice(line, layout.code).trim().toUpperCase();
    // A data row must carry a HCPCS Level II code in the code column: exactly one
    // leading letter + four digits (e.g. H0018). This is the canonical alpha-numeric
    // HCPCS format — it deliberately rejects header/footer text (e.g. "HCPCS"),
    // 2-char modifiers, and 5-digit CPT codes (CPT is AMA-owned and not in this file).
    if (!/^[A-Z][0-9]{4}$/.test(code)) continue;

    const longDescRaw = slice(line, layout.longDesc).trim();
    const shortDescRaw = slice(line, layout.shortDesc).trim();
    const effRaw = layout.effectiveDate ? slice(line, layout.effectiveDate) : '';

    out.push({
      code,
      // Prefer short desc; fall back to long when short is blank so a row is never desc-less.
      shortDesc: shortDescRaw || longDescRaw,
      longDesc: longDescRaw || null,
      effectiveDate: effRaw ? normalizeCmsDate(effRaw) : null,
    });
  }

  return dedupeByCode(out);
}

/**
 * CMS files can repeat a code across continuation lines; collapse to one record per
 * code, keeping the first non-empty description seen (deterministic on input order).
 */
function dedupeByCode(records: HcpcsRecord[]): HcpcsRecord[] {
  const byCode = new Map<string, HcpcsRecord>();
  for (const r of records) {
    const existing = byCode.get(r.code);
    if (!existing) {
      byCode.set(r.code, r);
      continue;
    }
    // Merge: fill blanks from the continuation line, never overwrite a set value.
    byCode.set(r.code, {
      code: r.code,
      shortDesc: existing.shortDesc || r.shortDesc,
      longDesc: existing.longDesc ?? r.longDesc,
      effectiveDate: existing.effectiveDate ?? r.effectiveDate,
    });
  }
  return [...byCode.values()];
}
