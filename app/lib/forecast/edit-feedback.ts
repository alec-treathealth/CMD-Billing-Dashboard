/**
 * Future-Payments edit feedback — the POLICY half of "did that edit land?", pure and
 * framework-free so it can be driven by a hermetic node:test with no DOM and no server.
 *
 * WHY THIS MODULE EXISTS. The panel's applyEdit used to `await` the Server Action and DISCARD
 * its result. saveUpcomingManual can return any of forbidden / bad_kind / bad_date /
 * bad_facility / bad_payer / bad_method / bad_amount / add_needs_amount / correct_needs_amount /
 * suppress_has_amount / suppress_needs_reason / bad_reason / pick_a_tenant_view /
 * facility_not_in_tenant / write_failed, and deleteUpcomingManual any of forbidden / bad_id /
 * pick_a_tenant_view / write_failed. None of them reached the operator: failure and success were
 * visually identical — a busy flag, a refetch, an unchanged tile. That is not a cosmetic gap. It
 * is why a bigint id arriving as a JS string made every delete button a guaranteed no-op for two
 * days without anyone noticing. A money surface that cannot say "no" is a money surface that
 * lies by omission.
 *
 * DEPENDENCY-INJECTED, not importing the actions. `runForecastEdit` takes the two Server Actions
 * as arguments, which is the seam the old handler lacked: the decision (what to say, whether to
 * refetch) becomes testable without a session, a database, or React.
 *
 * NON-PHI. Every value that can reach a message is a facility short code, a payer label, a
 * calendar date or a dollar amount — the same four fields the tile already renders, and the same
 * four 024 stores. There is no patient field in this type graph to leak. Do not extend a message
 * to carry anything from a patient-specific row beyond the existing unnamed marker.
 */
import { money } from '../format';
import type { DashboardView } from '../views';

/**
 * What the tile asks the host to do.
 *
 * Lives here rather than in the component so the component imports the policy and not the
 * reverse; era-upcoming.tsx re-exports the type, so no call site had to move.
 */
export type ForecastEditIntent =
  | {
      op: 'add';
      facilityCode: string;
      payerLabel: string;
      expectedDate: string;
      methodLabel: 'EFT' | 'Check';
      amount: string;
    }
  | {
      op: 'suppress';
      facilityCode: string;
      payerLabel: string;
      expectedDate: string;
      reason: 'landed' | 'incorrect' | 'cancelled';
      matchedEraKey?: string;
    }
  | {
      op: 'correct';
      facilityCode: string;
      payerLabel: string;
      expectedDate: string;
      amount: string;
    }
  | {
      op: 'delete-edit';
      id: number;
      /**
       * Display-only, so a failure message can NAME the row. A delete-edit carries nothing but
       * an opaque 024 id, and "Could not remove that edit" with no subject is barely better than
       * silence. NEVER marshalled into the Server Action call — the server addresses the row by
       * id and re-derives everything else.
       */
      label?: string;
    };

/** One line of feedback, with its own text tag — meaning is never carried by colour alone. */
export type ForecastEditOutcome =
  | { tone: 'busy'; text: string }
  | { tone: 'ok'; text: string }
  | { tone: 'info'; text: string }
  | { tone: 'error'; text: string };

/**
 * The save input shape, DECLARED STRUCTURALLY rather than imported from app/lib/actions.
 *
 * A type-only import would be erased, but app/lib/actions.ts is a `'use server'` module and this
 * one is pulled into the client component tree — a repo where a stray non-function export from a
 * 'use server' file passes the whole five-command gate and then 500s every Server Action on the
 * page is not a repo to add that edge to for convenience. Drift is caught at compile time
 * anyway: overview-kpis.tsx passes the real `saveUpcomingManual` as `deps.save`, so any
 * divergence from UpcomingManualInput fails there.
 */
export interface ForecastSaveInput {
  kind: 'add' | 'correct' | 'suppress';
  facilityCode: string;
  payerLabel: string;
  expectedDate: string;
  methodLabel?: 'EFT' | 'Check' | null;
  amount?: string | null;
  suppressReason?: 'landed' | 'incorrect' | 'cancelled' | null;
  matchedEraKey?: string | null;
}

type SaveResult = { ok: true; id: string } | { ok: false; error: string };
type DeleteResult = { ok: true; deleted: boolean } | { ok: false; error: string };

/**
 * The reason clause, per server code. Keys mirror app/lib/actions.ts exactly.
 *
 * ACTIONABLE where the operator can act, TERMINAL and internals-free where they cannot. The
 * wording for the recoverable cases is lifted from AddForecastForm so the tile speaks one
 * dialect ("one company's book", "up to two decimals — e.g. 4200 or 4200.50") rather than
 * inventing a second vocabulary for the same constraint.
 */
const REASON: Readonly<Record<string, string>> = {
  forbidden: 'You do not have permission to change future payments.',
  pick_a_tenant_view:
    'Switch to the BXR or Indigo view first — a forecast edit has to name one company’s book.',
  facility_not_in_tenant:
    'That facility is not in this view’s book. Switch to the view that owns it, or pick a facility from the list.',
  bad_facility: 'Pick a facility from the list.',
  bad_payer: 'Enter a payer name of 1 to 200 characters.',
  bad_date: 'Enter the expected date as a calendar date.',
  bad_method: 'Choose EFT or Check.',
  bad_amount: 'Enter an amount in dollars, up to two decimals — e.g. 4200 or 4200.50.',
  add_needs_amount: 'Enter an amount in dollars, up to two decimals — e.g. 4200 or 4200.50.',
  correct_needs_amount: 'Enter an amount in dollars, up to two decimals — e.g. 4200 or 4200.50.',
  write_failed:
    'The change may not have been saved. The panel has reloaded — check whether it took effect before trying again.',
  // A thrown or unreachable Server Action. Same epistemic class as write_failed: the outcome is
  // genuinely unknown, so the message must not claim either way.
  unreachable:
    'Could not reach the server, and the change may not have been saved. The panel has reloaded — check whether it took effect.',
};

/**
 * bad_kind / suppress_has_amount / suppress_needs_reason / bad_reason / bad_id, and anything
 * unrecognised. Every one of these means the UI and the server disagree about what was sent —
 * an operator cannot act on that, so do NOT invent an instruction, and do not print the code.
 */
const REASON_FALLBACK =
  'Nothing was changed. Reload the page and try again; if it keeps happening, report it.';

/** How a row is named in a message: facility · payer · date. Non-PHI by construction. */
export function intentLabel(i: ForecastEditIntent): string {
  return i.op === 'delete-edit'
    ? (i.label ?? 'this edit')
    : `${i.facilityCode} · ${i.payerLabel} · ${i.expectedDate}`;
}

function verb(i: ForecastEditIntent): string {
  if (i.op === 'add') return 'add that payment';
  if (i.op === 'correct') return 'save that amount';
  if (i.op === 'delete-edit') return 'remove that edit';
  return i.reason === 'landed'
    ? 'mark that payment landed'
    : i.reason === 'incorrect'
      ? 'mark that payment as not coming'
      : 'mark that payment cancelled';
}

function pastTense(i: ForecastEditIntent): string {
  if (i.op === 'add') return 'Added';
  if (i.op === 'correct') return 'Amount saved';
  if (i.op === 'delete-edit') return 'Edit removed';
  return i.reason === 'landed'
    ? 'Marked landed'
    : i.reason === 'incorrect'
      ? 'Marked not coming'
      : 'Marked cancelled';
}

/** A `null` code means transport failure / a thrown action, not a server rejection. */
export function forecastEditErrorText(i: ForecastEditIntent, code: string | null): string {
  const reason = code === null ? REASON.unreachable! : (REASON[code] ?? REASON_FALLBACK);
  return `Could not ${verb(i)} — ${intentLabel(i)}. ${reason}`;
}

/**
 * SUCCESS IS ACKNOWLEDGED, quietly. The two most common outcomes make a row DISAPPEAR, which is
 * indistinguishable from a failed no-op for a sighted user and completely silent for a
 * screen-reader user — the exact confusion this whole change exists to end.
 */
export function forecastEditSuccess(i: ForecastEditIntent, deleted = true): ForecastEditOutcome {
  // An idempotent delete of a row that was already gone is NOT a success story: nothing changed,
  // and saying "Edit removed" would claim an effect this call did not have.
  if (i.op === 'delete-edit' && !deleted) {
    return { tone: 'info', text: `That edit was already gone — ${intentLabel(i)}. Nothing to remove.` };
  }
  const amount = i.op === 'add' || i.op === 'correct' ? ` · ${money(i.amount)}` : '';
  return { tone: 'ok', text: `${pastTense(i)} — ${intentLabel(i)}${amount}.` };
}

/**
 * REFETCH ONLY WHEN THE SERVER MAY HAVE CHANGED STATE.
 *
 * Most of both actions' codes are returned BEFORE anything is written — forbidden and the
 * validation family land before `recordAccess` even runs. Refetching after one of those costs
 * three round-trips, blanks the tile to "Loading…", throws away whatever the operator just typed
 * into the uncontrolled amount box, and makes a deterministic rejection look like a reload. The
 * old handler refetched unconditionally on the argument that "the tile re-renders whatever the
 * server actually holds", which is sound only when a write was ATTEMPTED.
 */
export function shouldRefetch(code: string | null | undefined, ok: boolean): boolean {
  return ok || code === null || code === 'write_failed';
}

/**
 * Run one edit and RETURN what happened. The whole point: the result is not discarded.
 *
 * Never rejects — a thrown Server Action is absorbed into an error outcome, which also removes
 * the unhandled-rejection hazard from the `void applyEdit(intent)` call site.
 */
export async function runForecastEdit(
  intent: ForecastEditIntent,
  view: DashboardView | undefined,
  deps: {
    save: (input: ForecastSaveInput, view?: DashboardView) => Promise<SaveResult>;
    remove: (id: number, view?: DashboardView) => Promise<DeleteResult>;
  },
): Promise<{ outcome: ForecastEditOutcome; refetch: boolean }> {
  try {
    if (intent.op === 'delete-edit') {
      const r = await deps.remove(intent.id, view);
      // ⚠️ `refetch: true` EVEN WHEN `deleted === false`. This looks like a wasted reload and
      // has already been flagged as one in review (PR #146) — it is not, and the reason is not
      // guessable from this line alone.
      //
      // `deleted` is ROW_COUNT > 0 from
      // `delete ... where id = $2 and business_entity_id = $1`. The id reaching here came from
      // the tile's own render, via a loadUpcomingManual scoped to that same tenant. So
      // `deleted === false` does not mean "nothing happened" — it means THE ROW EXISTED WHEN
      // THIS TILE LOADED AND IS GONE NOW. The tile is stale: another super admin, or another
      // tab, removed it in between. That is the strongest reason to reload there is.
      //
      // Skipping the refetch would leave the vanished row on screen with its Undo/Remove button
      // still offering to delete it, answering every click with "already gone" forever — a dead
      // control that reports its own deadness, which is the entire bug class this module exists
      // to end. The only other path to `deleted === false` is a double-fire beating the `busy`
      // latch, and there the FIRST call already returned refetch: true, so the second reload is
      // redundant rather than wrong.
      return r.ok
        ? { outcome: forecastEditSuccess(intent, r.deleted), refetch: true }
        : {
            outcome: { tone: 'error', text: forecastEditErrorText(intent, r.error) },
            refetch: shouldRefetch(r.error, false),
          };
    }
    const input: ForecastSaveInput =
      intent.op === 'add'
        ? {
            kind: 'add',
            facilityCode: intent.facilityCode,
            payerLabel: intent.payerLabel,
            expectedDate: intent.expectedDate,
            methodLabel: intent.methodLabel,
            amount: intent.amount,
          }
        : intent.op === 'suppress'
          ? {
              kind: 'suppress',
              facilityCode: intent.facilityCode,
              payerLabel: intent.payerLabel,
              expectedDate: intent.expectedDate,
              amount: null,
              suppressReason: intent.reason,
              matchedEraKey: intent.matchedEraKey ?? null,
            }
          : {
              kind: 'correct',
              facilityCode: intent.facilityCode,
              payerLabel: intent.payerLabel,
              expectedDate: intent.expectedDate,
              amount: intent.amount,
            };
    const r = await deps.save(input, view);
    return r.ok
      ? { outcome: forecastEditSuccess(intent), refetch: true }
      : {
          outcome: { tone: 'error', text: forecastEditErrorText(intent, r.error) },
          refetch: shouldRefetch(r.error, false),
        };
  } catch {
    // The outcome is unknown, so refetch: the write may have landed before the throw.
    return { outcome: { tone: 'error', text: forecastEditErrorText(intent, null) }, refetch: true };
  }
}
