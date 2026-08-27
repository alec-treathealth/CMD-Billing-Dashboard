/**
 * Weekly Billable Days engine — pure week computation over the typed row contract.
 *
 * Extracted 2026-08-21 from computeRow in docs/mockups/weekly-billable-days-v4.html
 * (the rules engine that sat OUTSIDE the harness-tested KIPU-IMPORT-CORE block, so
 * this extraction is what puts it under test for the first time). Assumptions A1–A8
 * are preserved from the mock; A9–A13 are named switchable rules — see
 * ./assumptions.ts for the ratification record.
 *
 *   A1 chronological over-cap tie-break        A2 evals count when present
 *   A3 hours-but-no-code → show hours          A4 "No Auth Required" never expires
 *   A5 D/C STACKS with billable codes          A6 days-past measured from latest auth end
 *   A7 BPS stacks and consumes no cap day      A8 IOP never emits a bare G or T
 *
 * ⚠ THE DEVIATION THAT USED TO BE DOCUMENTED HERE IS GONE — REVERSED 2026-08-27.
 * This header previously said a session counts only when `present && billable`, a
 * deliberate departure from the mock, which counted any present GROUP row into hours
 * and codes regardless of documentation status. Alec ruled the MOCK was right:
 * `Status != 'Complete'` is a care-team signal about an unfinished note, not a
 * statement that the service is unbillable. Attendance bills. The gate is now
 * `present` alone, and `statusGatesBillable` (default false) is the escape hatch.
 *
 * The engine and the mock therefore AGREE again on this point. The reconciled
 * July weeks are unaffected either way — all 18 customer-weeks had zero non-`Complete`
 * group rows, which is precisely why the recon could only ever report A10 as UNTESTED.
 *
 * A13 (ruling 2026-08-21): DEFAULT cap resolution is PER DAY from the authorization
 * covering that day; 'current-ur-loc' reproduces the mock's whole-week resolution
 * for parity comparison. Rows with multi-LOC auths stay flagged in both modes'
 * import warns, and the per-day mode also raises the row flag.
 *
 * Deliberately NOT ported: the mock's `overrides`, `billed` and `writeoffs` maps —
 * they are UI interaction state, not billing rules, and belong to whatever surface
 * hosts the grid. PHI: client objects carry patient names in memory; nothing here
 * logs, and no returned string embeds a name.
 */
import {
  type BillableDayRules,
  type LocConfigEntry,
  type LocConfigMap,
  DEFAULT_RULES,
} from './assumptions.js';
import { type KipuAuth, type KipuClient, type KipuSession, dayDiff, isoShift } from './billingReport.js';

export const BILLABLE_CODES: ReadonlySet<string> = new Set(['I', 'G', 'T', 'BPS']);
const CODE_ORDER = ['BPS', 'I', 'G', 'T', 'N/B', 'HRS', 'D/C'];
const DEFAULT_CFG: LocConfigEntry = { track: 'OP', capDays: 7, minHours: 0 };

/** A4 — a "No Auth Required" grant never expires; a real auth covers start..end. */
const covering = (c: KipuClient, date: string): KipuAuth | undefined =>
  c.auths.find((a) => (a.no === 'No Auth Required' ? date >= a.start : date >= a.start && date <= a.end));

const latestEnd = (c: KipuClient): string | null =>
  c.auths.length ? c.auths.reduce((m, a) => (a.end > m ? a.end : m), '0000-00-00') : null;

// No auth on file => nothing to be 'past'. Returning a number would print NaN days.
const daysPastAuth = (c: KipuClient, date: string): number => {
  if (covering(c, date)) return 0;
  const e = latestEnd(c);
  return e ? Math.max(0, dayDiff(date, e)) : 0;
};

export interface DayCell {
  readonly i: number;
  readonly date: string;
  readonly sess: KipuSession[];
  readonly hrs: number;
  readonly hasGroup: boolean;
  readonly hasTherapy: boolean;
  readonly hasBps: boolean;
  readonly oow: boolean;
  readonly past: number;
  readonly dc: boolean;
  codes: string[];
}

export interface WeekRow {
  readonly days: DayCell[];
  readonly billableDays: number;
  readonly iopDays: number;
  readonly total: number;
  /** The Current-UR-Loc config — what the row header displays as "x / cap". */
  readonly cfg: LocConfigEntry;
  readonly flag: boolean;
  readonly maxPast: number;
  readonly capDays: number;
  /** True when the client's auths span more than one level of care (A13). */
  readonly multiLoc: boolean;
}

export function computeRow(
  c: KipuClient,
  weekStart: string,
  locCfg: LocConfigMap,
  rules: BillableDayRules = DEFAULT_RULES,
): WeekRow {
  const cfg = locCfg[c.loc] ?? DEFAULT_CFG;
  const cfgFor = (loc: string): LocConfigEntry => locCfg[loc] ?? DEFAULT_CFG;

  const authLocs = [...new Set(c.auths.map((a) => a.loc).filter(Boolean))];
  const multiLoc = authLocs.length > 1;
  // Per-day resolution applies exactly to the A13 population — everyone else
  // computes identically in both modes, which the tests assert.
  const perDay = rules.capResolution === 'per-day-auth' && multiLoc;

  const days: DayCell[] = [];
  for (let i = 0; i < 7; i++) {
    const date = isoShift(weekStart, i);
    const sess = c.sessions.filter((s) => s.date === date);
    // A2 + A10 at the engine.
    //
    // ⚠ ATTENDANCE BILLS, DOCUMENTATION STATUS DOES NOT (ruled 2026-08-27). `present` is
    // the gate; the documentation status is a CARE-TEAM signal about whether a clinician
    // finished their note, and a non-`Complete` note does not make a delivered service
    // unbillable. `statusGatesBillable` restores the old behaviour if that is ever
    // reversed, and defaults to false — see assumptions.ts.
    const counted = sess.filter(
        (s) => s.present && !(rules.missedNeverBillable && /missed/i.test(s.topic)) && !(rules.zeroHourNeverBillable && s.hrs === 0) && (!rules.statusGatesBillable || s.billable === true),
      );
    const hrs = +counted.reduce((a, s) => a + s.hrs, 0).toFixed(2);
    days.push({
      i,
      date,
      sess,
      hrs,
      hasGroup: counted.some((s) => s.kind === 'group'),
      hasTherapy: counted.some((s) => s.kind === 'therapy'),
      hasBps: counted.some((s) => s.kind === 'bps'),
      oow: hrs > 0 && !covering(c, date),
      past: daysPastAuth(c, date),
      dc: c.discharge === date,
      codes: [],
    });
  }

  // The LOC regime a day bills under: its covering auth's LOC in per-day mode,
  // the client's Current UR Loc otherwise (and as the fallback).
  const regimes = days.map((d) => {
    if (!perDay) return c.loc;
    const a = covering(c, d.date);
    return a && a.loc ? a.loc : c.loc;
  });
  const regimeCfg = (idx: number): LocConfigEntry => (perDay ? cfgFor(regimes[idx] ?? c.loc) : cfg);

  // Cap applies to IOP days (IOP track) or attended G/T days (OP track). BPS rides
  // free (A7). In per-day mode each regime's cap applies within its own group of
  // days; chronological order (A1) is preserved inside every group.
  const qualifies = (d: DayCell, k: LocConfigEntry): boolean =>
    !d.oow && d.hrs > 0 && (k.track === 'IOP' ? d.hrs >= k.minHours : d.hasGroup || d.hasTherapy);

  const keep = new Set<number>();
  const over = new Set<number>();
  const byRegime = new Map<string, DayCell[]>();
  days.forEach((d, idx) => {
    const k = regimeCfg(idx);
    if (!qualifies(d, k)) return;
    const regime = perDay ? (regimes[idx] ?? c.loc) : c.loc;
    const group = byRegime.get(regime);
    if (group) group.push(d);
    else byRegime.set(regime, [d]);
  });
  for (const [regime, group] of byRegime) {
    const k = perDay ? cfgFor(regime) : cfg;
    group.slice(0, k.capDays).forEach((d) => keep.add(d.i));
    group.slice(k.capDays).forEach((d) => over.add(d.i));
  }

  let ambiguousUsed = cfg.ambiguous === true;
  days.forEach((d, idx) => {
    const k = regimeCfg(idx);
    if (d.hrs > 0 && k.ambiguous === true) ambiguousUsed = true;
    const codes: string[] = [];
    if (d.hrs > 0 && !d.oow) {
      if (d.hasBps) codes.push('BPS'); // A7 — stacks, no cap cost
      if (keep.has(d.i)) {
        if (k.track === 'IOP') codes.push('I'); // A8 — no bare G/T on IOP
        else {
          if (d.hasGroup) codes.push('G');
          if (d.hasTherapy) codes.push('T');
        }
      } else if (over.has(d.i)) codes.push('N/B');
    }
    if (d.hrs > 0 && d.oow) codes.push('HRS'); // outside auth window
    if (d.hrs > 0 && !codes.length) codes.push('HRS'); // A3 — below threshold
    if (d.dc) codes.push('D/C'); // A5 — stacks
    d.codes = codes.sort((a, b) => CODE_ORDER.indexOf(a) - CODE_ORDER.indexOf(b));
  });

  const billableDays = days.filter((d) => d.codes.some((x) => BILLABLE_CODES.has(x))).length;
  const iopDays = days.filter((d) => d.codes.includes('I')).length;
  const total = +days.reduce((a, d) => a + d.hrs, 0).toFixed(2);
  const maxPast = days.reduce((m, d) => (d.hrs > 0 && d.past > m ? d.past : m), 0);
  const flag =
    days.some((d) => d.codes.includes('N/B') || d.codes.includes('HRS')) ||
    ambiguousUsed ||
    (perDay && multiLoc); // the ratified A13 flag survives the resolution change
  return { days, billableDays, iopDays, total, cfg, flag, maxPast, capDays: cfg.capDays, multiLoc };
}

export interface GridRow {
  readonly client: KipuClient;
  readonly row: WeekRow;
}

/** The grid's row set: clients with any counted hours in the week, or a D/C chip. */
export function gridRows(
  clients: readonly KipuClient[],
  weekStart: string,
  locCfg: LocConfigMap,
  rules: BillableDayRules = DEFAULT_RULES,
): GridRow[] {
  return clients
    .map((c) => ({ client: c, row: computeRow(c, weekStart, locCfg, rules) }))
    .filter((x) => x.row.total > 0 || x.row.days.some((d) => d.dc));
}
