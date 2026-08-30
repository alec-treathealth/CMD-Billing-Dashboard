/**
 * The Billable Days import LIFECYCLE, as one reducer.
 *
 * ⚠ WHY A REDUCER RATHER THAN SEVEN `useState` CALLS. Every defect this module was written to
 * fix (Qodo 2/7/8/10, 2026-08-30) was the same shape: state that outlived the scope it was
 * valid for. `data`, `files`, `error`, `busy`, the two override maps and the drawer target are
 * not seven independent facts — they are ONE fact ("what has this tab got open, and is it
 * still current?"). Held as separate setters they could be, and were, updated in inconsistent
 * combinations: an error could be shown beside the previous export's grid, and a response that
 * had already been superseded could still write all seven. Held as one transition they cannot.
 *
 * ── THE REQUEST TOKEN (Qodo 10) ────────────────────────────────────────────────────────────
 * `seq` is the id of the LAST request issued. `applied` / `failed` carry the id of the request
 * that produced them and are DROPPED WHOLE when it is not `seq`. That is the entire ordering
 * guarantee, and it has to be all-or-nothing: applying an older response's `files` while
 * keeping the newer response's `data` would leave the tab re-posting the wrong corpus on the
 * next week change — a silently wrong grid rather than a visible failure. `busy` is part of the
 * transition for the same reason; a superseded response must not clear the spinner for the
 * request still in flight.
 *
 * An AbortController would be the other way to do this. It is not available: a Server Action
 * call takes no signal, and aborting the transport would not help anyway — the guard needed is
 * over which response gets to WRITE, not over which request gets to finish.
 *
 * ── FRESH vs. WEEK NAVIGATION (Qodo 7) ─────────────────────────────────────────────────────
 * `fresh` distinguishes "the user picked a new export" from "the user changed week on the
 * export already loaded". They fail differently ON PURPOSE:
 *   - fresh   → the previous export is GONE the moment its replacement is attempted. Any
 *               failure clears data, files, overrides and the drawer. Showing an error for the
 *               new export beside the old export's clients and totals is the worst of both.
 *   - !fresh  → the loaded export is still valid; a failed week hop keeps it. `no-weeks` in
 *               particular is a statement about the requested WEEK, not about the corpus.
 *
 * ── SCOPE KEYS ARE NOT THIS MODULE'S JOB ───────────────────────────────────────────────────
 * Override keys carry their week (see `overrides.ts`); this reducer stores whatever key it is
 * handed. It deliberately does NOT clear overrides on a week change — week-keyed entries are
 * scoped by construction, so a biller's edits survive navigating away and back.
 *
 * Pure and synchronous: no React, no I/O, no `Date.now()`. That is what makes the interleaving
 * in `billableDaysImportState.test.tsx` expressible as four ordinary calls.
 */
import type { ImportError } from '@/lib/billing-audit/kipu-actions';
import type { KipuImportPayload } from '@/lib/billing-audit/kipu-import';
import type { DrawerTarget } from './drawer';
import type { WeekStatus } from './legend';
import type { CellOverrides, StatusOverrides } from './overrides';

/**
 * `send-failed` is not a server error code — it is the body-rejected case, where the Server
 * Action never returned a result at all. It is a FAILURE like any other and takes the same
 * fresh/not-fresh path; only its display text differs.
 */
export type ImportFailure = ImportError | 'send-failed';

export interface ImportState {
  /** Id of the most recently ISSUED request. Anything older may not write. */
  readonly seq: number;
  readonly data: KipuImportPayload | null;
  /** Retained handles, re-posted on a week change. Only ever the corpus behind `data`. */
  readonly files: readonly File[] | null;
  readonly busy: boolean;
  readonly error: ImportFailure | null;
  readonly cellOv: CellOverrides;
  readonly statusOv: StatusOverrides;
  readonly target: DrawerTarget | null;
}

export type ImportAction =
  | { readonly type: 'request'; readonly id: number; readonly fresh?: boolean }
  | {
      readonly type: 'applied';
      readonly id: number;
      readonly payload: KipuImportPayload;
      readonly files: readonly File[];
      readonly fresh: boolean;
    }
  | { readonly type: 'failed'; readonly id: number; readonly error: ImportFailure; readonly fresh: boolean }
  | { readonly type: 'set-cell'; readonly key: string; readonly codes: readonly string[] | null }
  | { readonly type: 'set-status'; readonly key: string; readonly status: WeekStatus | null }
  | { readonly type: 'clear-overrides' }
  | { readonly type: 'open-drawer'; readonly target: DrawerTarget }
  | { readonly type: 'close-drawer' };

const NO_CELLS: CellOverrides = new Map();
const NO_STATUSES: StatusOverrides = new Map();

export const initialImportState: ImportState = {
  seq: 0,
  data: null,
  files: null,
  busy: false,
  error: null,
  cellOv: NO_CELLS,
  statusOv: NO_STATUSES,
  target: null,
};

/** Everything a replacement import invalidates. The previous export is gone, not merely hidden. */
const CLEARED = {
  data: null,
  files: null,
  cellOv: NO_CELLS,
  statusOv: NO_STATUSES,
  target: null,
} as const;

export function importReducer(s: ImportState, a: ImportAction): ImportState {
  switch (a.type) {
    case 'request':
      // Claims the token. Ids come from a monotonic counter in the panel, so this only ever
      // moves forward and every response issued before now is now stale.
      return a.fresh
          ? { ...s, ...CLEARED, seq: a.id, busy: true, error: null }
          : { ...s, seq: a.id, busy: true, error: null };

    case 'applied':
      if (a.id !== s.seq) return s;
      return {
        ...s,
        busy: false,
        error: null,
        data: a.payload,
        files: a.files,
        ...(a.fresh ? { cellOv: NO_CELLS, statusOv: NO_STATUSES, target: null } : { target: null }),
      };

    case 'failed':
      if (a.id !== s.seq) return s;
      if (a.fresh) return { ...s, ...CLEARED, busy: false, error: a.error };
      // Week navigation: the loaded export is untouched by a failed hop. `no-weeks` says the
      // requested week is empty, which is not a reason to discard the corpus either.
      return { ...s, busy: false, error: a.error };

    case 'set-cell': {
      const next = new Map(s.cellOv);
      if (a.codes === null) next.delete(a.key);
      else next.set(a.key, a.codes);
      return { ...s, cellOv: next };
    }

    case 'set-status': {
      const next = new Map(s.statusOv);
      if (a.status === null) next.delete(a.key);
      else next.set(a.key, a.status);
      return { ...s, statusOv: next };
    }

    case 'clear-overrides':
      return { ...s, cellOv: NO_CELLS, statusOv: NO_STATUSES };

    case 'open-drawer':
      return { ...s, target: a.target };

    case 'close-drawer':
      return { ...s, target: null };
  }
}
