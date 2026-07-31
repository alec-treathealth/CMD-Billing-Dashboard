/**
 * GET /api/cron/era-835 — daily BXR 835 ERA ingest (staging.era_835_payment +
 * staging.era_835_adjustment, migration 013).
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * ⛔ NOT SCHEDULED — DO NOT ADD TO app/vercel.json YET.
 * This route deliberately has NO crons entry (vercel.json is strict JSON, so a
 * commented-out entry is impossible — this header is the note instead). It stays
 * unscheduled until the finding-1 probe re-run confirms the real per-code failure
 * rate: the 2026-07-31 probe saw 30%/42% failure episodes whose root cause is
 * UNKNOWN, and the throttle theory was FALSIFIED (six-times-gentler pacing produced
 * a HIGHER failure rate). Scheduling an ingest whose transport fails ~a third of the
 * time would just spray partial data and noise. Nothing invokes this route until an
 * entry is added — Vercel crons are opt-in per path, and the CRON_SECRET gate stops
 * manual/stray GETs.
 *
 * INTENDED SCHEDULE (when enabled): { "path": "/api/cron/era-835", "schedule": "50 8 * * *" }
 *   - minute :50 — the only clean slot in the :41-:59 quiet window (:00 cmd-explorer,
 *     :15 cmd-census, :30 indigo-explorer, :35 indigo-census, :45 rollup-refresh all
 *     share the hourly grid; CMD allows one report at a time per partner).
 *   - DAILY, not hourly: ERAs do not arrive fast enough to justify 24x the CMD load,
 *     and fingerprint dedup on both tables makes re-pulls free. Hour 8 UTC is a
 *     placeholder (clear of the 02-04 UTC billing-audit block and before the 09:17
 *     vob-sync) — pick deliberately at enable time.
 *   - 5-day lookback per run: ERAs land late relative to receipt date (BPR16 observed
 *     spanning 06-18..07-30 from a 07-21..27 receipt window).
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
