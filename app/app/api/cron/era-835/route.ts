/**
 * GET /api/cron/era-835 — daily BXR 835 ERA ingest (staging.era_835_payment +
 * staging.era_835_adjustment, migration 013).
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * SCHEDULED: { "path": "/api/cron/era-835", "schedule": "50 8 * * *" }
 * Enabled 2026-08-01.
 *   - minute :50 — the only clean slot in the :41-:59 quiet window (:00 cmd-explorer,
 *     :15 cmd-census, :30 indigo-explorer, :35 indigo-census, :45 rollup-refresh all
 *     share the hourly grid; CMD allows one report at a time per partner).
 *   - hour 8 UTC — clear of the 02-04 UTC billing-audit block and before the 09:17
 *     vob-sync, and a full hour after cmd-explorer-catchup at `52 7 * * *`. That gap
 *     is load-bearing: both endpoints share the one-report-at-a-time CMD partner
 *     session, and this route's 210s budget plus a 4-8 min realistic runtime would
 *     otherwise overlap the catch-up. Do not move either schedule independently.
 *   - DAILY, not hourly: ERAs do not arrive fast enough to justify 24x the CMD load,
 *     and fingerprint dedup on both tables makes re-pulls free.
 *   - 5-day lookback per run: ERAs land late relative to receipt date (BPR16 observed
 *     spanning 06-18..07-30 from a 07-21..27 receipt window).
 *
 * ⚠ OPEN RISK AT ENABLE TIME (finding 1, still unresolved): the 2026-07-31 probe saw
 * 30%/42% failure episodes whose root cause is UNKNOWN, and the throttle theory was
 * FALSIFIED (six-times-gentler pacing produced a HIGHER failure rate). This cron is
 * now scheduled anyway, deliberately — partial data is tolerable here because BOTH
 * target tables are ON CONFLICT-idempotent at their own grain and each run re-pulls a
 * 5-day trailing window, so a failed pull is retried by the next run rather than lost.
 * WATCH the per-code failure counts in the first several runs; a sustained ~1/3 failure
 * rate is the signal to de-schedule and finish the probe rather than tune blind.
 *
 * Node runtime (pg + libsodium via ../src — libsodium-wrappers must stay in
 * serverExternalPackages); never statically cached. maxDuration 300 covers 15
 * customers × 5 dates = 75 SEQUENTIAL pulls at a 1500ms floor between calls; the
 * wall-clock budget in runEra835Ingest (210s) stops launching new pulls near the
 * deadline and pulls_skipped_budget picks them up on a later run (idempotent).
 */
import { handleEra835IngestCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleEra835IngestCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
