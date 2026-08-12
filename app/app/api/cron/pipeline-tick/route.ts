/**
 * GET /api/cron/pipeline-tick — one slice of the completion-chained CMD ETL pipeline.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Reads collections.pipeline_state, runs the next DUE stage in dependency order, records it to
 * collections.etl_run, advances the state, and repeats while a wall-clock budget allows. The chain
 * lives in the database, so a tick that runs out of budget simply returns and the next one continues
 * — no stage is lost the way a single all-five orchestrator route would lose them to a mid-chain
 * platform kill.
 *
 * SHIPPED DISABLED. Without ETL_PIPELINE_ENABLED this returns 200 `{disposition:'disabled'}` and
 * touches nothing. The five existing cron entries (:00/:15/:30/:35/:45) are UNCHANGED by this PR and
 * remain the production path. Enabling the tick and removing those five is the follow-up, gated on a
 * day of measured etl_run durations — the two explorer stages have never been timed.
 *
 * SCHEDULE: every 5 minutes. A 5-minute cadence necessarily lands inside the reserved :41–:59 CMD
 * quiet window; the tick handles that itself rather than dodging it in cron syntax — CMD-calling
 * stages stand down in that band (`usesCmdApi`, see etlStages.ts) while the DB-only rollup keeps
 * running, which is the same distinction that has always let refresh-charge-rollup sit at :45.
 *
 * HAND-RUNNABLE, which is the point of the bearer contract: Vercel crons fire only on Production, so
 * a preview deployment can be driven directly —
 *   curl -H "Authorization: Bearer $CRON_SECRET" '<preview-url>/api/cron/pipeline-tick?trigger=manual'
 * The tick is idempotent and takes a lease (collections.pipeline_lock), so a hand-run one cannot
 * collide with a scheduled one or with itself.
 *
 * Node runtime (the stages it drives pull in pg + libsodium); never statically cached.
 * maxDuration = 300 with a 200s default stage-start budget, leaving headroom for a stage that
 * overruns its reserve. The tick's own overhead is three small queries per stage.
 */
import { handlePipelineTick } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handlePipelineTick({
    method: req.method,
    authorization: req.headers.get('authorization'),
    trigger: new URL(req.url).searchParams.get('trigger'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
