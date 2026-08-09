/**
 * GET /api/cron/qualify-rating-history — nightly (prefix-token × payer) policy-rating snapshot
 * into collections.qualify_policy_rating_daily (mig 0093), the store behind the smoke-shell
 * tape's 90-day rating delta.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Scheduled 10 5 * * * (app/vercel.json): a free minute — after the 04:45 hourly matview refresh
 * settles (the snapshot reads at most ~25-minute-old rollup data) and clear of every hourly ingest
 * minute (:00/:15/:22/:30/:35/:45/:55). DB-ONLY: zero CMD calls, so the CMD-scoped :41–:59 probe
 * window and the one-report-at-a-time partner slot do not bind it (the refresh-charge-rollup
 * precedent).
 *
 * CATCH-UP + BACKFILL: each run computes every as_of date in the trailing 180-day horizon lacking
 * an ok run-log row — the FIRST run backfills the whole horizon (the 90d delta works immediately),
 * later runs normally compute just YESTERDAY (the newest closed date — an as_of=today row would
 * rate a mostly-empty final day; see the anchor note in qualifyRatingHistory.ts), and any missed
 * night self-heals. Reads run as claims_reader, writes as cmd_rollup_writer; each statement its
 * own autocommit (Supavisor 6543).
 *
 * Node runtime (pg); never statically cached. maxDuration=300 (Pro+): the ~180-date backfill is
 * ~0.3-0.6s/date of aggregate scanning — steady-state nightly runs finish in seconds.
 */
import { handleQualifyRatingHistory } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleQualifyRatingHistory({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
