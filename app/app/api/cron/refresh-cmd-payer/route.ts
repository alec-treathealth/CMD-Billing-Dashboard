/**
 * GET /api/cron/refresh-cmd-payer — daily CMD payer rollup refresh.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when
 * CRON_SECRET is set). GET only — any other verb is 405.
 *
 * Pulls the live CMD report, aggregates to the non-PHI rollup, and refreshes the
 * trailing window of months in collections.cmd_payer_facility_monthly as the
 * least-privilege cmd_rollup_writer role. Returns non-PHI stats only.
 *
 * Node runtime (pg); never statically cached. maxDuration covers the CMD batch
 * poll (run → poll → unzip), which can take up to ~48s — requires a Vercel plan
 * that allows a 60s function (Pro+).
 */
import { handleCmdPayerRefresh } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleCmdPayerRefresh({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
