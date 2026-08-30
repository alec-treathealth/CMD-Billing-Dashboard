/**
 * Kipu Billing Report import — the PURE mapping from the tested `src/kipu/` engine onto the
 * wire shape the Billable Days grid renders. No auth, no I/O, no 'use server' here on
 * purpose: this is the half that can be unit-tested against the scrubbed in-repo fixture,
 * and `kipu-actions.ts` is the thin authenticated wrapper around it.
 *
 * ⚠ THE ENGINE IS NOT REIMPLEMENTED HERE AND MUST NOT BE. Parsing, the billable-day rules,
 * the location registry and the timezone map all live in `src/kipu/` and are covered by the
 * root suite. This module only *shapes* their output. If you find yourself deciding what
 * counts as a billable day in this file, you are in the wrong file.
 *
 * ⚠ WHAT DELIBERATELY DOES NOT CROSS THE WIRE. The response carries the computed rows for
 * ONE week plus the week list and diagnostics — never the raw session corpus. A nine-facility
 * five-month corpus is ~16 MB of CSV; round-tripping it would be both a payload and a PHI
 * mistake. A week change re-posts the files rather than shipping every week at once; that
 * cost is temporary and disappears when the parsed corpus lands in `kipu.*` (next PR).
 *
 * PHI POSTURE. FOUR fields are gated on `canRevealPhi` and are `null` for everyone else:
 * the patient NAME, the authorization NUMBER, the session TOPIC, and the session PROVIDER.
 * A fifth gate sits on the DIAGNOSTICS: `skipped` carries source-row text and is reduced to
 * reason codes plus counts for an ungated viewer (`gateSkipped`). Everything else the
 * grid needs — dates, times, hours, codes, counts, level of care, payer, container labels,
 * auth windows — is non-identifying and always present. The gate is applied HERE, at the
 * mapping, so an ungated field can never reach the client by way of a component forgetting
 * to mask it: for a plain `user` the value is absent from the payload, not merely hidden.
 */
import { skippedLabel, type BuildResult, type KipuClient, type SkippedRow, type WeekInfo } from '../../../src/kipu/billingReport.js';
import type { GridRow } from '../../../src/kipu/computeRow.js';
import { locationFor } from '../../../src/kipu/locations.js';

/** One session inside a day cell, as the drawer renders it. */
export interface KipuSessionDTO {
  readonly date: string;
  readonly kind: 'group' | 'therapy' | 'bps';
  readonly start: string;
  readonly end: string;
  readonly hrs: number;
  /**
   * Clinician on the session — PHI-adjacent, `null` unless canRevealPhi.
   *
   * RULED 2026-08-29 (Alec). This shipped UNGATED, three lines above a gated `topic` in the
   * same object, and the asymmetry protected almost nothing: a provider on a session row is
   * not a bare staff name, it is "this clinician saw this client on this date" — and the
   * client identity is already on the row. That linkage is part of the record. Worse,
   * withholding a group's TOPIC while disclosing WHO LED IT lets the topic be inferred from
   * the clinician's specialty, so the topic gate was leaking through this field.
   *
   * Billers who need providers get `canRevealPhi`. Provider does not bypass the gate for
   * everyone. Do not re-open this with a separate permission or a config flag.
   */
  readonly provider: string | null;
  readonly status: string;
  readonly billable: boolean;
  /** Clinical topic — PHI-adjacent. `null` unless canRevealPhi. */
  readonly topic: string | null;
  /** Verbatim container label, or null for an evaluation (no `Session` column). */
  readonly label: string | null;
}

export interface KipuDayDTO {
  readonly i: number;
  readonly date: string;
  readonly codes: string[];
  readonly hrs: number;
  /** Attended outside the authorization window. */
  readonly oow: boolean;
  /** Days past the latest auth end. */
  readonly past: number;
  /** Discharge day. */
  readonly dc: boolean;
  readonly sessions: KipuSessionDTO[];
}

export interface KipuAuthDTO {
  /** Authorization number — PHI. `null` unless canRevealPhi. */
  readonly no: string | null;
  readonly start: string;
  readonly end: string;
  readonly freq: string;
  readonly loc: string;
}

export type KipuSegment = 'all' | 'review' | 'past';

export interface KipuRowDTO {
  /** Stable within one import only — an engine-assigned ordinal, never a patient key. */
  readonly id: string;
  /** Patient name — PHI. `null` unless canRevealPhi; the grid masks it regardless. */
  readonly name: string | null;
  readonly loc: string;
  readonly payer: string;
  /** Every container label this client's sessions came from. */
  readonly labels: string[];
  /** Distinct CMD facility codes those labels bill under; `null` entries mean "no CMD customer". */
  readonly facilityCodes: (string | null)[];
  readonly billableDays: number;
  readonly capDays: number;
  readonly iopDays: number;
  readonly totalHours: number;
  readonly flag: boolean;
  readonly maxPast: number;
  readonly multiLoc: boolean;
  readonly hasAuth: boolean;
  readonly days: KipuDayDTO[];
  readonly auths: KipuAuthDTO[];
  readonly warn: string[];
}

export interface KipuLocCfgDTO {
  readonly loc: string;
  readonly track: 'IOP' | 'OP';
  readonly capDays: number;
  readonly minHours: number;
  /** True when the entry was INFERRED rather than configured — the row carries a review flag. */
  readonly ambiguous: boolean;
}

/** Everything the Import Summary panel shows. All counts, never a filename or an identifier. */
export interface KipuDiagnosticsDTO {
  /** Files accepted, by detected kind — detection is by header signature, never by filename. */
  readonly filesByKind: Record<string, number>;
  readonly rowsByKind: Record<string, number>;
  readonly clientCount: number;
  readonly weekCount: number;
  /** A9/A10 and engine notes — rules-level warnings, no identifiers. */
  readonly notes: string[];
  /**
   * Rows the parser held OUT, and why. Display strings, already PHI-GATED: with
   * `canRevealPhi` they name the source row; without it they are fixed reason codes with
   * counts and carry nothing drawn from the row. See `gateSkipped`.
   */
  readonly skipped: string[];
  readonly facilities: string[];
  readonly locConfig: KipuLocCfgDTO[];
  readonly locFlags: string[];
  readonly tzFlags: { facility: string; ours: string; declared: string; deltaH: number }[];
  readonly tzUnknown: string[];
  readonly midnightAdjacent: number;
  readonly midnightGuardMin: number;
}

export interface KipuStatsDTO {
  readonly clients: number;
  readonly billableDays: number;
  readonly attendedHours: number;
  readonly unauthorizedDays: number;
  readonly furthestPastAuth: number;
  readonly needsReview: number;
  readonly pastAuth: number;
}

export interface KipuImportPayload {
  readonly weeks: readonly WeekInfo[];
  readonly selectedWeek: string;
  readonly rows: readonly KipuRowDTO[];
  readonly stats: KipuStatsDTO;
  readonly locOptions: readonly string[];
  readonly facilityOptions: readonly string[];
  readonly diagnostics: KipuDiagnosticsDTO;
  /** True when names/auth numbers/topics/providers are present in this payload. */
  readonly phiIncluded: boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Distinct CMD facility codes for a client's labels. `null` = mapped location with no CMD customer. */
export function facilityCodesFor(labels: readonly string[]): (string | null)[] {
  const out = new Set<string | null>();
  for (const l of labels) out.add(locationFor(l)?.facilityCode ?? null);
  return [...out];
}

function mapRow(g: GridRow, canRevealPhi: boolean): KipuRowDTO {
  const c: KipuClient = g.client;
  return {
    id: c.id,
    name: canRevealPhi ? c.name : null,
    loc: c.loc,
    payer: c.payer,
    labels: [...c.labels],
    facilityCodes: facilityCodesFor(c.labels),
    billableDays: g.row.billableDays,
    capDays: g.row.capDays,
    iopDays: g.row.iopDays,
    totalHours: round1(g.row.total),
    flag: g.row.flag,
    maxPast: g.row.maxPast,
    multiLoc: g.row.multiLoc,
    hasAuth: c.auths.length > 0,
    days: g.row.days.map((d) => ({
      i: d.i,
      date: d.date,
      codes: [...d.codes],
      hrs: round1(d.hrs),
      oow: d.oow,
      past: d.past,
      dc: d.dc,
      sessions: d.sess.map((s) => ({
        date: s.date,
        kind: s.kind,
        start: s.start,
        end: s.end,
        hrs: round1(s.hrs),
        provider: canRevealPhi ? s.provider : null,
        status: s.status,
        billable: s.billable,
        topic: canRevealPhi ? s.topic : null,
        label: s.label ?? null,
      })),
    })),
    auths: c.auths.map((a) => ({
      no: canRevealPhi ? a.no : null,
      start: a.start,
      end: a.end,
      freq: a.freq,
      loc: a.loc,
    })),
    warn: [...c.warn],
  };
}

/**
 * The skipped-row PHI gate (Qodo finding 6) — the SAME `canRevealPhi ? value : withheld`
 * shape `mapRow` already applies to name, auth number and session topic. There is
 * deliberately no second mechanism here.
 *
 * ⚠ WHY THIS EXISTS. `build.skipped` used to be copied to the payload verbatim, and its
 * entries interpolate the source row's Topic / Evaluation name — clinical free text from a
 * PHI-bearing export. Every viewer received it, including a plain `user` for whom the very
 * same topic string is `null` two fields away in the same response. That is the defect.
 *
 * Ungated callers get the REASON and a COUNT and nothing drawn from the row. Aggregating
 * also stops the list length itself from tracking individual rows.
 */
export function gateSkipped(rows: readonly SkippedRow[], canRevealPhi: boolean): string[] {
  if (canRevealPhi) return rows.map(skippedLabel);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.kind}|${r.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort().map(([key, n]) => {
    const [kind, reason] = key.split('|') as [SkippedRow['kind'], SkippedRow['reason']];
    const what = kind === 'group-session' ? 'group session' : 'evaluation';
    const why = reason === 'no-full-name' ? 'no Full Name' : 'unparseable Started';
    return `${n} ${what} row${n === 1 ? '' : 's'} held out — ${why}`;
  });
}

export function segmentOf(r: KipuRowDTO): KipuSegment[] {
  const segs: KipuSegment[] = ['all'];
  if (r.flag) segs.push('review');
  if (r.maxPast > 0) segs.push('past');
  return segs;
}

/**
 * ⚠ `attendedHours` IS SUMMED FROM THE ENGINE'S RAW TOTALS, NOT FROM THE ROUNDED DTO ROWS.
 * Each row's `totalHours` is rounded to 1dp for display, and summing 26 rounded values
 * drifts from the true total (measured: 212.9 vs 212.6 on the fixture week). The strip has
 * to agree with the engine — and therefore with `scripts/kipu-recon.ts` — so it is computed
 * upstream of the rounding. Per-row values can still be re-added by hand to a slightly
 * different figure; that is ordinary display rounding, and the engine's number is the one
 * that is correct.
 */
function statsFor(rows: readonly KipuRowDTO[], rawHours: number): KipuStatsDTO {
  let billableDays = 0, unauthorizedDays = 0, furthest = 0, review = 0, past = 0;
  const attendedHours = rawHours;
  for (const r of rows) {
    billableDays += r.billableDays;
    unauthorizedDays += r.days.filter((d) => d.oow).length;
    if (r.maxPast > furthest) furthest = r.maxPast;
    if (r.flag) review += 1;
    if (r.maxPast > 0) past += 1;
  }
  return {
    clients: rows.length,
    billableDays,
    attendedHours: round1(attendedHours),
    unauthorizedDays,
    furthestPastAuth: furthest,
    needsReview: review,
    pastAuth: past,
  };
}

/**
 * Shape one week of engine output for the wire.
 *
 * `rowsForWeek` is the caller's `gridRows(...)` result for `selectedWeek` — passed in rather
 * than recomputed here so this module never has to own the rules engine's arguments.
 */
export function buildImportPayload(args: {
  build: BuildResult;
  rowsForWeek: readonly GridRow[];
  selectedWeek: string;
  filesByKind: Record<string, number>;
  canRevealPhi: boolean;
}): KipuImportPayload {
  const { build, rowsForWeek, selectedWeek, filesByKind, canRevealPhi } = args;
  const rows = rowsForWeek.map((g) => mapRow(g, canRevealPhi));

  const locOptions = [...new Set(build.clients.map((c) => c.loc).filter(Boolean))].sort();
  const facilityOptions = [...build.facilities].sort();

  return {
    weeks: build.weeks as readonly WeekInfo[],
    selectedWeek,
    rows,
    stats: statsFor(rows, rowsForWeek.reduce((a, g) => a + g.row.total, 0)),
    locOptions,
    facilityOptions,
    phiIncluded: canRevealPhi,
    diagnostics: {
      filesByKind,
      rowsByKind: {
        sessions: build.clients.reduce((n, c) => n + c.sessions.filter((s) => s.kind === 'group').length, 0),
        evaluations: build.clients.reduce((n, c) => n + c.sessions.filter((s) => s.kind !== 'group').length, 0),
      },
      clientCount: build.clients.length,
      weekCount: build.weeks.length,
      notes: [...build.notes],
      skipped: gateSkipped(build.skipped, canRevealPhi),
      facilities: facilityOptions,
      locConfig: Object.entries(build.locCfg).map(([loc, e]) => ({
        loc,
        track: e.track,
        capDays: e.capDays,
        minHours: e.minHours,
        ambiguous: e.ambiguous === true,
      })),
      locFlags: [...build.locFlags],
      tzFlags: build.tzFlags.map((f) => ({
        facility: f.facility,
        ours: f.ours,
        declared: f.declared,
        deltaH: f.deltaH,
      })),
      tzUnknown: [...build.tzUnknown],
      midnightAdjacent: build.boundary.length,
      midnightGuardMin: build.midnightGuardMin,
    },
  };
}
