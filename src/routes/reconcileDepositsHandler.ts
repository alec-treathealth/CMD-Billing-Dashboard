/**
 * Transport-agnostic handler for GET /api/cron/reconcile-deposits.
 *
 * Runs the deposit reconciliation (CMD's bank-view report vs collections.daily_collections) and
 * returns its non-PHI stats. Mirrors cmdPayerRefreshHandler's security posture exactly:
 *   - GET only — any other verb is 405, independent of auth.
 *   - Bearer auth against CRON_SECRET, constant-time; a missing/empty secret fails closed (401).
 *   - On failure the client gets a generic 500 and the cause is logged server-side as a message.
 *
 * ALERTING IS A LOG LINE, DELIBERATELY. This repo has no alerting infrastructure, and persisting
 * reconciliation history would need a new table — i.e. a migration — which is out of scope. So a
 * run that finds something writes console.error with a greppable prefix and returns alert:true;
 * a clean run writes console.log. That is enough to wire a Vercel log drain to later, and it keeps
 * this cron stateless. Nothing here writes to the database at all.
 */
import { isAuthorized } from '../bearerAuth.js';
import { formatReconcileLog, type ReconcileStats } from '../collections/reconcileDeposits.js';

export interface ReconcileDepositsHttpRequest {
  method?: string;
  authorization?: string | null;
}

export interface ReconcileDepositsRouteDeps {
  /** Shared secret; undefined/empty => fail closed (401). Never logged. */
  secret: string | undefined;
  /** Runs the reconciliation; returns non-PHI stats. Throws on failure (caught here). */
  reconcile: () => Promise<ReconcileStats>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** Prefix chosen so a log drain can match one string and catch every alerting run. */
export const RECONCILE_ALERT_PREFIX = 'RECONCILE-ALERT';

export async function handleReconcileDepositsRequest(
  req: ReconcileDepositsHttpRequest,
  deps: ReconcileDepositsRouteDeps,
): Promise<HandlerResult> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (!deps.secret || !isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  try {
    const stats = await deps.reconcile();
    const line = formatReconcileLog(stats);
    if (stats.alert) {
      // error level so it separates from routine cron chatter in the Vercel log view.
      console.error(`${RECONCILE_ALERT_PREFIX} ${line}`);
      for (const m of stats.material_mismatches) {
        console.error(
          `${RECONCILE_ALERT_PREFIX} ${m.facility_code} ${m.payment_date}: ` +
            `report ${m.report_gross.toFixed(2)} vs stored ${m.stored_gross.toFixed(2)} ` +
            `(delta ${m.delta.toFixed(2)})`,
        );
      }
      for (const u of stats.unreached) console.error(`${RECONCILE_ALERT_PREFIX} unreached ${u}`);
    } else {
      console.log(line);
    }
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    console.error('reconcile-deposits failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'reconcile_failed' } };
  }
}
