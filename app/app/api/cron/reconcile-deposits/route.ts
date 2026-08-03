/**
 * GET /api/cron/reconcile-deposits — daily deposit reconciliation.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Pulls CMD's "what reflects in the bank" report (10050915) once PER CUSTOMER across the 15 BXR
 * accounts, aggregates it through the SAME aggregateDailyDeposits the explorer cron uses, and
 * diffs facility-day totals against collections.daily_collections. A disagreement means the
 * dashboard and the bank are telling different stories for that facility-day.
 *
 * READ-ONLY — the claims_reader pool only. No writer is opened and nothing is persisted, so this
 * cron cannot damage the feed it checks. Findings surface as console.error lines prefixed
 * RECONCILE-ALERT, greppable from a Vercel log drain; a clean run logs a single summary line.
 *
 * Node runtime (pg); never statically cached. maxDuration=300 covers 15 SEQUENTIAL CMD batch
 * polls (a clean single-customer pull measured 11-42s) plus the read-back. The core carries a
 * wall-clock budget guard, and unlike the ingest crons a partial run is SAFE here: nothing is
 * written, and every unreached customer is excluded from the comparison and named in the output,
 * so an incomplete run reports as incomplete rather than as a fake shortfall.
 */
import { handleReconcileDeposits } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleReconcileDeposits({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
