/**
 * GET /api/cron/era-835-sync — rolling-window 835 ERA remittance sync.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when
 * CRON_SECRET is set). GET only — any other verb is 405.
 *
 * Pulls each CMD customer's 835 ERA(s) for a short trailing window (today back
 * ERA835_SYNC_WINDOW_DAYS days, default 3 — covers ordinary CMD posting lag
 * without reprocessing real history), parses the X12, and idempotently upserts
 * into staging.era_835_payment (the authoritative money row, one per remit) +
 * staging.era_835_adjustment (CAS triplets) as the least-privilege
 * cmd_rollup_writer role. This is the "Step 2" era_ingest.ts's own header
 * comment referred to and that was never wired up — see src/ingest/era_ingest.ts
 * for the shared core (runEra835Ingest) this route and the manual --commit CLI
 * both use. A full historical backfill stays a manual CLI run; this route only
 * keeps the rolling window current. Returns non-PHI counts only.
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers
 * ~50 customers × up to 3 days of sequential CMD 835 pulls — requires a Vercel
 * plan that allows a 300s function (Pro+).
 */
import { handleEra835SyncCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleEra835SyncCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
