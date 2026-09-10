/**
 * CMD V2 snapshot ZIP → typed tab-delimited tables. PURE: no I/O, no env, no PHI handling beyond
 * holding the parsed strings in memory for the mapper (arSnapshotMap.ts) — nothing here logs or
 * throws a cell value.
 *
 * THE FORMAT (measured 2026-09-09 on all 20 BXR snapshots): each `{customer}/{TABLE}.DAT` entry is
 * a TAB-separated file whose first line is the column header; rows end in `\n` (a trailing `\r` is
 * tolerated); no quoting; no embedded tabs or newlines (every row's field count matched its header
 * on every file — free text such as B_PATNOTES.MESSAGE is flattened by CMD before export). Dates
 * are `MM/DD/YYYY`, timestamps `MM/DD/YYYY HH:MM:SS`, money `####.##`, booleans `0/1` (a few
 * lookup tables use `Y/N`). `meta/*.sql` entries are Oracle DDL and are ignored here.
 */
import { readZipEntries } from '../collections/cmdPayer.js';

export type SnapshotRow = Readonly<Record<string, string>>;

export interface SnapshotTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly SnapshotRow[];
}

export interface SnapshotTables {
  /** The table, or null when the snapshot has no such entry. */
  get(name: string): SnapshotTable | null;
  /** The table; throws (name only) when absent. */
  require(name: string): SnapshotTable;
  /** Every table name present, sorted. */
  names(): string[];
}

/** Parse one tab-delimited text: header first, `\r\n`-tolerant, blank lines skipped, short rows padded. */
export function parseTsv(text: string): { columns: string[]; rows: SnapshotRow[] } {
  const lines = text.split('\n');
  const headerLine = (lines[0] ?? '').replace(/\r$/, '');
  if (headerLine === '') return { columns: [], rows: [] };
  const columns = headerLine.split('\t');
  const rows: SnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    if (line === '') continue;
    const fields = line.split('\t');
    const row: Record<string, string> = {};
    for (let j = 0; j < columns.length; j++) row[columns[j]!] = fields[j] ?? '';
    rows.push(row);
  }
  return { columns, rows };
}

/**
 * Build the table map from a snapshot ZIP. Non-`.DAT` entries (the meta SQL) are ignored.
 *
 * ⚠ PARSING IS LAZY, AND THAT IS A MEMORY REQUIREMENT RATHER THAN AN OPTIMISATION. `parseTsv`
 * materialises one JS object per row with a property per column, which costs ~13x the source
 * text: measured 2026-09-09 on CAMH (the largest snapshot), eagerly parsing all 32 tables
 * retained **1,048 MB of live heap / 1,326 MB RSS** from a 6.4 MB ZIP (77.5 MB uncompressed).
 * `arSnapshotMap.ts` reads only 11 of those tables, so B_CREDIT (12.4 MB), CLAIM_ICD_CODE and
 * ICLAIM (4.9 MB each) and ~14 smaller tables were being inflated and thrown away. The cron
 * runs one customer at a time inside a 300s/limited-memory function, so the peak of the LARGEST
 * customer is the ceiling for the whole roster — an OOM there is worse than a timeout, because
 * it kills the process instead of raising: the run row is never closed and the rest of the
 * roster is skipped for the day.
 *
 * A table is decompressed into rows on FIRST access and cached; its inflated bytes are released
 * at that point so the two representations are never both retained. Tables nobody asks for cost
 * only their buffer. `names()` still reports every table in the snapshot, parsed or not.
 */
export function parseSnapshotZip(zip: Buffer): SnapshotTables {
  const raw = new Map<string, Buffer>();
  for (const entry of readZipEntries(zip)) {
    const m = /(?:^|\/)([A-Za-z0-9_]+)\.DAT$/i.exec(entry.name);
    if (!m) continue;
    raw.set(m[1]!.toUpperCase(), entry.data);
  }
  return lazySnapshotTables(raw);
}

/**
 * The lazy view over a name → inflated-bytes map. Parse-on-access, cached, and the buffer is
 * dropped once its rows exist. `names()` is snapshotted up front so it stays complete as
 * buffers are consumed.
 */
function lazySnapshotTables(raw: Map<string, Buffer>): SnapshotTables {
  const allNames = [...raw.keys()].sort();
  const parsed = new Map<string, SnapshotTable>();
  const load = (upper: string): SnapshotTable | null => {
    const cached = parsed.get(upper);
    if (cached !== undefined) return cached;
    const buf = raw.get(upper);
    if (buf === undefined) return null;
    const { columns, rows } = parseTsv(buf.toString('utf8'));
    const table: SnapshotTable = { name: upper, columns, rows };
    parsed.set(upper, table);
    raw.delete(upper); // the rows ARE the retained form now — never hold both
    return table;
  };
  return {
    get: (name) => load(name.toUpperCase()),
    require: (name) => {
      const upper = name.toUpperCase();
      const t = load(upper);
      if (!t) throw new Error(`snapshot: table ${upper} is missing`);
      return t;
    },
    names: () => [...allNames],
  };
}

/** Wrap an already-built table map (the test fixture path). */
export function snapshotTablesFrom(tables: ReadonlyMap<string, SnapshotTable>): SnapshotTables {
  return {
    get: (name) => tables.get(name.toUpperCase()) ?? null,
    require: (name) => {
      const t = tables.get(name.toUpperCase());
      if (!t) throw new Error(`snapshot: table ${name.toUpperCase()} is missing`);
      return t;
    },
    names: () => [...tables.keys()].sort(),
  };
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = m === 2 && !leap ? 28 : MONTH_DAYS[m - 1]!;
  return d <= max;
}
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `MM/DD/YYYY[ HH:MM:SS]` → `YYYY-MM-DD` (calendar-validated), else null. Blank → null. */
export function cmdDate(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(t);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  if (!validYmd(y, mo, d)) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * `MM/DD/YYYY HH:MM:SS` → `YYYY-MM-DDTHH:MM:SS` (NAIVE — CMD stamps are US/Eastern wall clock and
 * carry no zone; stored as-is so ordering is preserved). A bare date → midnight. Else null.
 */
export function cmdTimestamp(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(t);
  if (!m) return null;
  const date = cmdDate(t);
  if (date === null) return null;
  const hh = Number(m[4] ?? '0');
  const mm = Number(m[5] ?? '0');
  const ss = Number(m[6] ?? '0');
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return `${date}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

/** Numeric cell → number, else null (blank → null). */
export function cmdNumber(v: string | undefined): number | null {
  const t = (v ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Money cell → fixed 2dp decimal string (what numeric(12,2) accepts), else null. */
export function cmdMoney(v: string | undefined): string | null {
  const n = cmdNumber(v);
  if (n === null) return null;
  if (Math.abs(n) >= 1e10) return null; // outside numeric(12,2)
  return n.toFixed(2);
}

/** CMD boolean cell: '1' | 'Y' | 'T' (any case) → true. */
export function isCmdTrue(v: string | undefined): boolean {
  const t = (v ?? '').trim().toUpperCase();
  return t === '1' || t === 'Y' || t === 'T' || t === 'TRUE';
}

/** Trim; blank → null. */
export function cmdText(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}
