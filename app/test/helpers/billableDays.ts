/**
 * SYNTHETIC Billable Days fixtures — built by hand, never from a real Kipu export.
 *
 * Nothing here is drawn from a `.env` value, a credential, or captured output. Names are
 * obviously fake so a leak assertion that matched one would be unambiguous, and the numbers are
 * chosen so an override CHANGES the count: a row whose engine count already equals its adjusted
 * count cannot tell a working fix from a broken one.
 *
 * Helpers only — this file is imported, not collected (the runner's glob is `test/*.test.tsx`).
 */
import type {
  KipuDayDTO,
  KipuImportPayload,
  KipuRowDTO,
  KipuSessionDTO,
} from '../../lib/billing-audit/kipu-import';
import { overrideScope } from '../../components/billing-audit/billable-days/overrides';
import type { DashboardView } from '../../lib/views';

export const WEEK_A = '2026-08-10';
export const WEEK_B = '2026-08-17';

/**
 * The two tenants the Claims Desk offers, and the four (entity, week) scopes they make. An
 * override key is scoped by BOTH halves, so a test that fixes one and varies the other proves
 * exactly one axis of isolation — see `overrides.ts` for why both are load-bearing.
 *
 * `overrideScope` is the ONLY constructor for a scope — `OverrideScope` is branded, so a bare
 * week string does not typecheck. That is deliberate: `view` and `week` are both strings, and a
 * two-string signature would accept them reversed without complaint.
 *
 * These four constants are a convenience for tests whose weeks are fixtures, NOT the only
 * permitted route to a scope. A test whose week comes from parsed data must call the constructor
 * directly — `kipuImportPayload.test.tsx` does exactly that with the week off its CSV payload,
 * which no fixture constant could supply.
 */
export const VIEW_BXR: DashboardView = 'bxr';
export const VIEW_INDIGO: DashboardView = 'indigo';

export const SCOPE_BXR_A = overrideScope(VIEW_BXR, WEEK_A);
export const SCOPE_BXR_B = overrideScope(VIEW_BXR, WEEK_B);
export const SCOPE_INDIGO_A = overrideScope(VIEW_INDIGO, WEEK_A);
export const SCOPE_INDIGO_B = overrideScope(VIEW_INDIGO, WEEK_B);

export function session(over: Partial<KipuSessionDTO> = {}): KipuSessionDTO {
  return {
    date: WEEK_A,
    kind: 'group',
    start: '09:00',
    end: '12:00',
    hrs: 3,
    provider: null,
    status: 'Complete',
    billable: true,
    topic: null,
    label: 'SYNTHETIC IOP',
    ...over,
  };
}

function day(i: number, over: Partial<KipuDayDTO> = {}): KipuDayDTO {
  return {
    i,
    date: `2026-08-${String(10 + i).padStart(2, '0')}`,
    codes: [],
    hrs: 0,
    oow: false,
    past: 0,
    dc: false,
    sessions: [],
    ...over,
  };
}

/**
 * One client, 7 days, exactly ONE billable day (Monday). Monday is `I`, Tuesday is empty — so
 * overriding Tuesday to a billable code moves the count 1 → 2 and leaves the cap (3) untouched.
 */
export function makeRow(over: Partial<KipuRowDTO> = {}): KipuRowDTO {
  return {
    id: 'row-0',
    name: null,
    loc: 'SYNTHETIC IOP',
    payer: 'SYNTHETIC PAYER',
    labels: ['SYNTHETIC IOP'],
    facilityCodes: ['SYNTH_FAC'],
    billableDays: 1,
    capDays: 3,
    iopDays: 1,
    totalHours: 3,
    flag: false,
    maxPast: 0,
    multiLoc: false,
    hasAuth: true,
    days: [
      day(0, { codes: ['I'], hrs: 3, sessions: [session()] }),
      day(1),
      day(2),
      day(3),
      day(4),
      day(5),
      day(6),
    ],
    auths: [{ no: null, start: '2026-08-01', end: '2026-09-01', freq: '3x/wk', loc: 'SYNTHETIC IOP' }],
    warn: [],
    ...over,
  };
}

export function makePayload(over: Partial<KipuImportPayload> = {}): KipuImportPayload {
  const rows = over.rows ?? [makeRow()];
  return {
    weeks: [
      { id: WEEK_B, start: WEEK_B, label: 'Aug 17 – Aug 23' },
      { id: WEEK_A, start: WEEK_A, label: 'Aug 10 – Aug 16' },
    ],
    selectedWeek: WEEK_A,
    rows,
    stats: {
      clients: rows.length,
      billableDays: 1,
      attendedHours: 3,
      unauthorizedDays: 0,
      furthestPastAuth: 0,
      needsReview: 0,
      pastAuth: 0,
    },
    locOptions: ['SYNTHETIC IOP'],
    facilityOptions: ['SYNTHETIC IOP'],
    diagnostics: {
      filesByKind: {},
      rowsByKind: {},
      clientCount: rows.length,
      weekCount: 2,
      notes: [],
      skipped: [],
      facilities: ['SYNTHETIC IOP'],
      locConfig: [],
      locFlags: [],
      tzFlags: [],
      tzUnknown: [],
      midnightAdjacent: 0,
      midnightGuardMin: 0,
    },
    phiIncluded: false,
    ...over,
  };
}
