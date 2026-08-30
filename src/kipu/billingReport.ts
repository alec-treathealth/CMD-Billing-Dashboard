/**
 * Kipu "Billable" Billing Report import — CSV parsing and normalization.
 *
 * Extracted 2026-08-21 from the KIPU-IMPORT-CORE block of
 * docs/mockups/weekly-billable-days-v4.html, where it was proven against real
 * exports by scripts/test-kipu-report-import.mjs. The assumptions it encodes
 * (A9–A13) live in ./assumptions.ts with their ratification record — read that
 * header before changing behaviour here.
 *
 * Consumes the 4-file export: *-Sessions.csv (one row per patient × group
 * session), *-Evaluations.csv (therapy / BPS), *-Patient.csv (census
 * dimension), *-Labs.csv (ignored). Detection is by HEADER SIGNATURE, never by
 * filename. Facility lives only in the Session container name — the export has
 * no facility column; MRN has no source and stays blank, never faked.
 *
 * PHI: patient names flow through these structures in memory. Nothing here may
 * log, and no note/warning string may embed a patient name — notes carry
 * counts, statuses, and business identifiers only.
 */
import {
  type BillableDayRules,
  type LocConfigEntry,
  type LocConfigMap,
  DEFAULT_RULES,
  isBillableDocumentation,
  isBillableReportFile,
  isBpsEvaluation,
  isMissedService,
} from './assumptions.js';
import { assertKnownLabels, locationFor } from './locations.js';

export type { BillableDayRules, LocConfigEntry, LocConfigMap } from './assumptions.js';
export type { KipuLocation } from './locations.js';

export type CsvRow = Record<string, string>;

export interface KipuAuth {
  readonly no: string;
  readonly start: string;
  readonly end: string;
  readonly freq: string;
  readonly loc: string;
}

export interface KipuSession {
  readonly date: string;
  readonly kind: 'group' | 'therapy' | 'bps';
  readonly topic: string;
  readonly provider: string;
  readonly start: string;
  readonly end: string;
  readonly hrs: number;
  readonly present: boolean;
  readonly billable: boolean;
  readonly status: string;
  readonly srcId: string;
  /**
   * The session-container label this row came from, VERBATIM — the registry key.
   * Present on GROUP rows only: the evaluations export has no `Session` column, so an
   * evaluation cannot name its own location and inherits the client's (see
   * `KipuClient.labels`). Carried per session rather than per client because two exports
   * carry two labels each, so one client can legitimately span containers.
   */
  readonly label?: string;
}

export interface KipuClient {
  readonly id: string;
  readonly name: string;
  /** No source in the export — always blank, never faked. */
  mrn: string;
  admit: string | null;
  discharge: string | null;
  loc: string;
  payer: string;
  /**
   * First container label seen, kept for display and for callers that predate multi-label
   * exports. Prefer `labels` for anything that must be correct when a client spans two.
   */
  facility: string;
  /** Every distinct container label this client's sessions came from, sorted. */
  labels: string[];
  auths: KipuAuth[];
  sessions: KipuSession[];
  warn: string[];
}

/** Sentinel LOC for a patient whose export rows carry no Current UR Loc. */
export const NO_LOC = '(no UR LOC in export)';

/* ------------- RFC4180 CSV: quoted fields, embedded commas AND newlines ------------- */

export function parseCsv(text: string): CsvRow[] {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // Kipu ships a BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (q) {
      if (ch === '"') {
        if (t.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch; // newlines inside quotes are DATA
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      /* skip */
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headerRow = rows[0];
  if (!headerRow) return [];
  // 'Insurance 1   Insurance Company' carries three spaces — collapse header whitespace.
  const head = headerRow.map((h) => h.trim().replace(/\s+/g, ' '));
  return rows
    .slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const o: CsvRow = {};
      head.forEach((h, i) => {
        o[h] = String(r[i] ?? '').trim();
      });
      return o;
    });
}

/* ----------------------------------- normalisers ----------------------------------- */

// Kipu appends a telehealth attestation to LOC names (' - All encounters occur via…'),
// to session names and to evaluation names (': The encounter occurred via…'), plus ' -'
// and ' - import' edit markers.
export const stripAttestation = (s: string): string =>
  String(s ?? '')
    .replace(/\s*[:\-]\s*(All encounters occur|The encounter occurred)\s+via real-time[\s\S]*$/i, '')
    .replace(/\s*-\s*import\s*$/i, '')
    .replace(/\s*-\s*$/, '')
    .trim();

export const usDate = (s: string): string | null => {
  const m = String(s ?? '')
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m && m[1] && m[2] && m[3] ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};

export const usDateTime = (s: string): { date: string; time: string } | null => {
  const m = String(s ?? '')
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2})\s*([AP]M)/i);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5]) return null;
  return {
    date: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`,
    time: `${m[4]} ${m[5].toUpperCase()}`,
  };
};

const num = (v: string): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// One cell can hold SEVERAL auth segments, newline-separated inside the quoted field:
// "No Auth Required, Start: 08/10/2026, End: 10/05/2026, Freq: , LOC: MH OP 3 Adult - …"
const AUTH_RE = /^(.*?),\s*Start:\s*([\d/]+),\s*End:\s*([\d/]+),\s*Freq:\s*(.*?),\s*LOC:\s*([\s\S]*)$/;

export function parseAuths(cell: string): KipuAuth[] {
  const out: KipuAuth[] = [];
  for (const line of String(cell ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(AUTH_RE);
    if (!m || !m[1] || !m[2] || !m[3]) continue;
    const start = usDate(m[2]);
    const end = usDate(m[3]);
    if (!start || !end) continue;
    out.push({ no: m[1].trim(), start, end, freq: (m[4] ?? '').trim(), loc: stripAttestation(m[5] ?? '') });
  }
  return out;
}

export const capFromFreq = (f: string): number | null => {
  const m = String(f ?? '')
    .trim()
    .match(/^(\d+)\s*Day/i);
  return m && m[1] ? parseInt(m[1], 10) : null;
};

/* ------------------------------- TIMEZONE OWNERSHIP --------------------------------
   The export prints a NAKED WALL CLOCK ("08/17/2026 06:00 PM") — no offset, no
   timezone column. Kipu renders those times in the LOCATION's configured timezone,
   and two locations are configured wrong in Kipu today (Colorado and Missouri are
   both set to Eastern; they are Mountain and Central). That setting is not ours to
   change from here, so we do not depend on it: the zone we bill on is a map WE own,
   derived from the state, and Kipu's declared zone is untrusted input we diff
   against and report. The open work is applying this map on the API path — the fix
   is ours to apply, not Kipu's.                                                    */

interface ZoneRow {
  readonly name: RegExp;
  readonly abbr: RegExp;
  readonly iana: string;
  readonly label: string;
}

// Abbreviations are matched CASE-SENSITIVELY on word boundaries — a case-insensitive
// /\bVA\b/ would eventually collide with something like a provider credential.
const TZ_BY_STATE: readonly ZoneRow[] = [
  { name: /california|nevada|washington/i, abbr: /\b(CA|NV|WA)\b/, iana: 'America/Los_Angeles', label: 'Pacific' },
  { name: /colorado/i, abbr: /\b(CO)\b/, iana: 'America/Denver', label: 'Mountain' },
  { name: /texas|tennessee|missouri/i, abbr: /\b(TX|TN|MO)\b/, iana: 'America/Chicago', label: 'Central' },
  { name: /pennsylvania|virginia/i, abbr: /\b(PA|VA)\b/, iana: 'America/New_York', label: 'Eastern' },
];

// What Kipu's "My Locations" screen declares, transcribed 2026-08-21. Only entries
// that DISAGREE with the state belong here.
const KIPU_DECLARED_TZ: readonly { name: RegExp; abbr: RegExp; declared: string }[] = [
  { name: /colorado/i, abbr: /\b(CO)\b/, declared: 'Eastern (GMT-05:00)' },
  { name: /missouri/i, abbr: /\b(MO)\b/, declared: 'Eastern (GMT-05:00)' },
];

const ZONE_OFFSET_H: Record<string, number> = { Pacific: -8, Mountain: -7, Central: -6, Eastern: -5 };

export function zoneFor(facility: string): { iana: string; label: string } | null {
  const f = facility ?? '';
  for (const row of TZ_BY_STATE) if (row.name.test(f) || row.abbr.test(f)) return { iana: row.iana, label: row.label };
  return null;
}

export interface TzFlag {
  readonly facility: string;
  readonly declared: string;
  readonly ours: string;
  readonly deltaH: number;
}

export function tzMismatch(facility: string): TzFlag | null {
  const ours = zoneFor(facility);
  if (!ours) return null;
  const hit = KIPU_DECLARED_TZ.find((d) => d.name.test(facility ?? '') || d.abbr.test(facility ?? ''));
  if (!hit) return null;
  const dLabel = (hit.declared.match(/^[A-Za-z]+/) ?? [''])[0] ?? '';
  if (dLabel === ours.label) return null;
  return {
    facility,
    declared: hit.declared,
    ours: ours.label,
    deltaH: Math.abs((ZONE_OFFSET_H[dLabel] ?? 0) - (ZONE_OFFSET_H[ours.label] ?? 0)),
  };
}

// Minutes from midnight, either side. A timestamp this close to the boundary can be
// relocated to another calendar day by any offset error, so it is reported, not assumed.
export const MIDNIGHT_GUARD_MIN = 120;

export function minsFromMidnight(hhmm: string): number | null {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const h = (parseInt(m[1], 10) % 12) + (/PM/i.test(m[3]) ? 12 : 0);
  const t = h * 60 + parseInt(m[2], 10);
  return Math.min(t, 1440 - t);
}

/* ------------------------- UTC-safe calendar-day arithmetic ------------------------- */
// The mock did `new Date(s+'T00:00:00')` (LOCAL midnight) then `toISOString()` (UTC),
// which only round-trips on machines west of Greenwich. These are date-string pure.

const atUtc = (isoDate: string): number => {
  const [y, m, d] = isoDate.split('-').map((v) => parseInt(v, 10));
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
};
export const isoShift = (isoDate: string, days: number): string =>
  new Date(atUtc(isoDate) + days * 86400000).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string): number => Math.round((atUtc(a) - atUtc(b)) / 86400000);
const mondayOf = (isoDate: string): string => {
  const dow = new Date(atUtc(isoDate)).getUTCDay();
  return isoShift(isoDate, -((dow + 6) % 7));
};
const shortDate = (isoDate: string): string =>
  new Date(atUtc(isoDate)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/* ------------------------- file classification and bundling ------------------------- */

export type CsvKind = 'sessions' | 'evaluations' | 'patient' | 'labs' | 'empty' | 'unknown';

/** Detection is by header signature, never by filename — Kipu renames files freely. */
export function classifyRows(rows: readonly CsvRow[]): CsvKind {
  const first = rows[0];
  if (!first) return 'empty';
  const k = Object.keys(first);
  if (k.includes('Session Id')) return 'sessions';
  if (k.includes('Evaluation Id')) return 'evaluations';
  if (k.includes('Specimen')) return 'labs';
  if (k.includes('Full Name') && k.includes('Current UR Loc')) return 'patient';
  return 'unknown';
}

export interface ReportFile {
  readonly name: string;
  readonly text: string;
}

export interface ReportBundle {
  sessions: CsvRow[];
  evaluations: CsvRow[];
  patient: CsvRow[];
  labs: CsvRow[];
  /** A9 guard output — loud, and merged into BuildResult.notes by buildFromCsv. */
  variantWarnings: string[];
}

export function assembleBundle(files: readonly ReportFile[], rules: BillableDayRules = DEFAULT_RULES): ReportBundle {
  const bundle: ReportBundle = { sessions: [], evaluations: [], patient: [], labs: [], variantWarnings: [] };
  files.forEach((f, i) => {
    const rows = parseCsv(f.text);
    const kind = classifyRows(rows);
    if (kind === 'sessions' || kind === 'evaluations' || kind === 'patient' || kind === 'labs') {
      bundle[kind] = bundle[kind].concat(rows);
    }
    if (rules.requireBillableVariant && !isBillableReportFile(f.name)) {
      // ⚠ THE FILENAME IS NEVER INTERPOLATED HERE (Qodo finding 9). This warning travels
      // variantWarnings -> BuildResult.notes -> the import payload -> the BROWSER, so any
      // source value put in it is published to every viewer regardless of canRevealPhi. An
      // uploaded filename is user-supplied text from a PHI-bearing export and routinely
      // carries a patient name or MRN, so it is identified POSITIONALLY instead.
      //
      // The guard itself still reads `f.name` — that is the -Billable- marker's only home,
      // and renamed exports stay supported because CLASSIFICATION is by header signature
      // (classifyRows), never by name. Reading the name is fine; emitting it is not.
      bundle.variantWarnings.push(
        `A9 GUARD: file ${i + 1} of ${files.length} (detected kind: ${kind}) does not carry the ` +
          '-Billable- report variant marker. Row existence = attended (A9) is only true of the ' +
          'Billable variant — do not bill off this import until the export variant is confirmed.',
      );
    }
  });
  return bundle;
}

/* ------------------------------- build the grid model ------------------------------- */

export interface WeekInfo {
  readonly id: string;
  readonly label: string;
  readonly start: string;
}

export interface BoundaryHit {
  readonly loc: string;
  readonly topic: string;
  readonly near: number;
  readonly billable: boolean;
}

/**
 * One row the parser refused to count, as STRUCTURE rather than prose (Qodo finding 6).
 *
 * ⚠ `detail` CARRIES SOURCE-ROW TEXT AND IS SERVER-SIDE ONLY. It holds the row's Topic or
 * Evaluation name — clinical free text from a PHI-bearing export. This used to be baked
 * into a display string that the import payload copied verbatim to every viewer, so a
 * caller without `canRevealPhi` received clinical text the rest of the payload carefully
 * withholds. Splitting reason from detail is what lets the payload drop one and keep the
 * other; do not merge them back into a single string.
 */
export interface SkippedRow {
  /** Fixed, enumerable — safe for any viewer. */
  readonly reason: 'no-full-name' | 'unparseable-started';
  readonly kind: 'group-session' | 'evaluation';
  /** Source-row text. PHI-adjacent: gate on canRevealPhi before it leaves the server. */
  readonly detail: string | null;
}

/** Human display for a skipped row, INCLUDING its source text. Never send to an ungated viewer. */
export function skippedLabel(s: SkippedRow): string {
  const what = s.kind === 'group-session' ? 'group session' : 'evaluation';
  const why = s.reason === 'no-full-name' ? 'no Full Name' : 'unparseable Started';
  return s.detail ? `${what} "${s.detail}" — ${why}` : `${what} row with ${why}`;
}

export interface BuildResult {
  clients: KipuClient[];
  weeks: WeekInfo[];
  locCfg: LocConfigMap;
  locFlags: string[];
  notes: string[];
  skipped: SkippedRow[];
  facilities: string[];
  boundary: BoundaryHit[];
  tzFlags: TzFlag[];
  tzUnknown: string[];
  midnightGuardMin: number;
}

export function buildFromCsv(
  bundle: ReportBundle,
  baseCfg?: LocConfigMap,
  rules: BillableDayRules = DEFAULT_RULES,
): BuildResult {
  const notes: string[] = [...bundle.variantWarnings];
  const skipped: SkippedRow[] = [];
  const byName = new Map<string, KipuClient>();
  const authKeys = new Map<KipuClient, Set<string>>();
  const facilities = new Set<string>();

  const client = (name: string): KipuClient => {
    let c = byName.get(name);
    if (!c) {
      c = {
        id: 'k' + (byName.size + 1),
        name,
        mrn: '',
        admit: null,
        discharge: null,
        loc: '',
        payer: '',
        facility: '',
        labels: [],
        auths: [],
        sessions: [],
        warn: [],
      };
      byName.set(name, c);
      authKeys.set(c, new Set());
    }
    return c;
  };

  const dim = (c: KipuClient, r: CsvRow): void => {
    c.admit = c.admit || usDate(r['Admission Date'] ?? '');
    c.discharge = c.discharge || usDate(r['Discharge Date'] ?? '');
    const loc = stripAttestation(r['Current UR Loc'] ?? '');
    if (loc) c.loc = loc;
    const pay = (r['Insurance 1 Insurance Company'] ?? '').trim() || (r['Payment Method'] ?? '').trim();
    if (pay) c.payer = pay;
  };

  const addAuths = (c: KipuClient, cell: string): void => {
    const keys = authKeys.get(c);
    if (!keys) return;
    for (const a of parseAuths(cell)) {
      const k = [a.no, a.start, a.end, a.loc].join('|');
      if (keys.has(k)) continue;
      keys.add(k);
      c.auths.push(a);
    }
  };

  for (const r of bundle.patient) {
    const n = (r['Full Name'] ?? '').trim();
    if (n) dim(client(n), r);
  }

  for (const r of bundle.sessions) {
    const n = (r['Full Name'] ?? '').trim();
    if (!n) {
      skipped.push({ reason: 'no-full-name', kind: 'group-session', detail: null });
      continue;
    }
    const c = client(n);
    dim(c, r);
    addAuths(c, r['Authorizations'] ?? '');
    const st = usDateTime(r['Started'] ?? '');
    if (!st) {
      skipped.push({
        reason: 'unparseable-started',
        kind: 'group-session',
        detail: stripAttestation(r['Topic'] ?? '') || null,
      });
      continue;
    }
    const en = usDateTime(r['Ended'] ?? '');
    const sessName = stripAttestation(r['Session'] ?? '');
    // The location is ONLY in the session container name — the export has no facility
    // column. Kept VERBATIM as the registry key: the previous
    // `.replace(/\s*Group Sessions[\s\S]*$/i, '')` matched only the three telehealth
    // labels and passed the other eight through unstripped, and no regex can place
    // "Group Session 1" at all. Unknown labels are collected and thrown on below rather
    // than inferred (see ./locations.ts).
    const fac = sessName.trim();
    if (fac) {
      facilities.add(fac);
      if (!c.facility) c.facility = fac;
      if (!c.labels.includes(fac)) c.labels.push(fac);
    }
    const status = (r['Status'] ?? '').trim();
    const ok = isBillableDocumentation(status, rules);
    c.sessions.push({
      date: st.date,
      kind: 'group',
      topic: stripAttestation(r['Topic'] ?? '') || sessName,
      provider: (r['Provider'] ?? '').trim(),
      start: st.time,
      end: en ? en.time : '',
      hrs: num(r['Duration'] ?? ''),
      present: true,
      billable: ok,
      status,
      srcId: r['Session Id'] ?? '',
      ...(fac ? { label: fac } : {}),
    });
    if (!ok) notes.push(`group session status "${status}" held out of billable (A10)`);
  }

  for (const r of bundle.evaluations) {
    const n = (r['Full Name'] ?? '').trim();
    if (!n) {
      skipped.push({ reason: 'no-full-name', kind: 'evaluation', detail: null });
      continue;
    }
    const c = client(n);
    dim(c, r);
    addAuths(c, r['Authorizations'] ?? '');
    const st = usDateTime(r['Started'] ?? '');
    if (!st) {
      skipped.push({
        reason: 'unparseable-started',
        kind: 'evaluation',
        detail: stripAttestation(r['Evaluation'] ?? '') || null,
      });
      continue;
    }
    const en = usDateTime(r['Ended'] ?? '');
    const name = stripAttestation(r['Evaluation'] ?? '');
    const status = (r['Status'] ?? '').trim();
    const hrs = num(r['Duration'] ?? '');
    const missedHold = rules.missedNeverBillable && isMissedService(name); // A12
    const zeroHold = rules.zeroHourNeverBillable && hrs === 0; // A12 — date-only placeholder
    const billable = isBillableDocumentation(status, rules) && !missedHold && !zeroHold;
    c.sessions.push({
      date: st.date,
      kind: isBpsEvaluation(name) ? 'bps' : 'therapy',
      topic: name,
      provider: (r['Signed By'] ?? '').trim(),
      start: st.time,
      end: en ? en.time : '',
      hrs,
      present: true,
      billable,
      status,
      srcId: r['Evaluation Id'] ?? '',
    });
    if (missedHold) notes.push('"Missed Therapy Session" rows present — never billable (A12)');
    else if (zeroHold) notes.push('evaluations with 0.00 hours present — not billable (A12)');
    else if (!isBillableDocumentation(status, rules))
      notes.push(`evaluation status "${status}" held out of billable (A10)`);
  }

  const clients = [...byName.values()];

  /* ---- date-boundary exposure, measured per import ---- */
  const boundary: BoundaryHit[] = [];
  for (const c of clients) {
    for (const sx of c.sessions) {
      const a = minsFromMidnight(sx.start);
      const b2 = minsFromMidnight(sx.end);
      const near = Math.min(a == null ? 9999 : a, b2 == null ? 9999 : b2);
      // The SESSION's own label, not the client's first one — a client spanning two
      // containers would otherwise have its boundary hits attributed to whichever
      // container happened to appear first, in a report whose whole purpose is per-location
      // timezone exposure.
      if (near <= MIDNIGHT_GUARD_MIN) {
        boundary.push({ loc: sx.label ?? c.facility, topic: sx.topic, near, billable: sx.billable });
      }
    }
  }

  for (const c of clients) {
    c.sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!c.loc) {
      c.loc = NO_LOC;
      c.warn.push('No Current UR Loc in the export — no cap can be resolved.');
    }
    if (!c.admit) c.warn.push('No Admission Date in the export.');
    const locs = [...new Set(c.auths.map((a) => a.loc).filter(Boolean))];
    if (locs.length > 1)
      c.warn.push(
        `Authorisations span ${locs.length} levels of care (${locs.join(' · ')}). ` +
          'Flagged per A13; caps resolve per day from the covering authorisation.',
      );
  }

  /* ---- LOC config: hand-kept entry first, auth-Freq fallback, else uncapped (A11) ---- */
  const locCfg: LocConfigMap = {};
  const locFlags: string[] = [];
  for (const loc of [...new Set(clients.map((c) => c.loc).filter(Boolean))]) {
    const fromBase = baseCfg?.[loc];
    if (fromBase) {
      locCfg[loc] = { ...fromBase };
      continue;
    }
    if (loc === NO_LOC) {
      locCfg[loc] = { track: 'OP', capDays: 7, minHours: 0, ambiguous: true };
      locFlags.push(`${NO_LOC}: patient has no level of care in the export — left uncapped and flagged.`);
      continue;
    }
    const caps = clients
      .flatMap((c) => c.auths)
      .filter((a) => a.loc === loc)
      .map((a) => capFromFreq(a.freq))
      .filter((v): v is number => v != null);
    const cap = caps.length ? Math.max(...caps) : null;
    const iop = /\bIOP\b/i.test(loc);
    const entry: LocConfigEntry = {
      track: iop ? 'IOP' : 'OP',
      capDays: cap == null ? 7 : cap,
      minHours: iop ? 3.0 : 0,
      ambiguous: true,
    };
    locCfg[loc] = entry;
    locFlags.push(
      cap != null
        ? `${loc}: no config entry — cap ${cap} taken from the authorisation Freq, track ${iop ? 'IOP' : 'OP'} ` +
            "inferred from the name. Confirm against Kipu's Levels of Care."
        : `${loc}: no config entry and no parseable auth Freq — left UNCAPPED and flagged. Do not bill` +
            ' off these rows until the level of care is confirmed.',
    );
  }

  /* ---- weeks derived from the data (Monday-start, newest first) ---- */
  const dates = clients
    .flatMap((c) => c.sessions.map((s) => s.date))
    .filter(Boolean)
    .sort();
  const weeks: WeekInfo[] = [];
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  if (firstDate && lastDate) {
    let cur = mondayOf(firstDate);
    const last = mondayOf(lastDate);
    while (cur <= last) {
      weeks.push({
        id: cur,
        label: `${shortDate(cur)} – ${shortDate(isoShift(cur, 6))}, ${cur.slice(0, 4)}`,
        start: cur,
      });
      cur = isoShift(cur, 7);
    }
    weeks.reverse();
  }

  const facilityList = [...facilities].sort();

  // ── THE GATE. An unmapped container label stops the build. ────────────────────────
  // Deliberately AFTER parsing so the error names every unknown label at once, and
  // deliberately fatal: the alternatives are dropping a location's days silently or
  // billing them to a neighbour, and both are worse than a failed run. Opt out with
  // `allowUnmappedLocations` only for exploratory probing of a brand-new export.
  const unmapped = facilityList.filter((f) => !locationFor(f));
  if (unmapped.length > 0 && !rules.allowUnmappedLocations) assertKnownLabels(facilityList);
  for (const u of unmapped) notes.push(`container label "${u}" is not in the location registry`);

  // Zones come from the REGISTRY per label, not from inference on the label's text. The
  // legacy name-derived `zoneFor` is kept only as the fallback for an unmapped label
  // under `allowUnmappedLocations`, and `tzMismatch` still reports Kipu's declared zone
  // as a diff — never a silent correction.
  const zoneOf = (label: string): { iana: string; label: string } | null => {
    const loc = locationFor(label);
    return loc ? { iana: loc.iana, label: loc.zoneLabel } : zoneFor(label);
  };
  const tzFlags = facilityList.map(tzMismatch).filter((f): f is TzFlag => f !== null);
  const tzUnknown = facilityList.filter((f) => !zoneOf(f));

  // ── A client whose labels bill to DIFFERENT CMD customers is flagged, never picked. ──
  // Texas and Virginia each ship two labels, so a client spanning two is expected; what
  // is not tolerable is guessing which customer owns the day. Two labels under ONE
  // customer (both Texas containers) is fine and stays unflagged.
  for (const c of clients) {
    if (c.labels.length < 2) continue;
    const codes = [...new Set(c.labels.map((l) => locationFor(l)?.facilityCode ?? `?${l}`))];
    if (codes.length > 1) {
      c.warn.push(
        `sessions span ${c.labels.length} container labels billing to ${codes.length} different CMD ` +
          `customers (${codes.join(', ')}) — attribution not inferred, excluded from per-customer totals`,
      );
    }
  }

  return {
    clients,
    weeks,
    locCfg,
    locFlags,
    notes: [...new Set(notes)],
    skipped,
    facilities: facilityList,
    boundary,
    tzFlags,
    tzUnknown,
    midnightGuardMin: MIDNIGHT_GUARD_MIN,
  };
}
