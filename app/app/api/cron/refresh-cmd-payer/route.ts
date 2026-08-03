/**
 * GET /api/cron/refresh-cmd-payer — daily CMD payer rollup refresh.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when
 * CRON_SECRET is set). GET only — any other verb is 405.
 *
 * Pulls the live CMD report, aggregates to the non-PHI rollup, and refreshes the
 * trailing window of months in collections.cmd_payer_facility_monthly as the
 * least-privilege cmd_rollup_writer role. Returns non-PHI stats only.
 *
 * Node runtime (pg); never statically cached. maxDuration=300 covers the WHOLE-BOOK pull: 15
 * SEQUENTIAL CMD batch polls (run → poll → unzip, one per BXR customer account) plus aggregation
 * and the write. It was 60 when this route made a single pull; the 2026-08-02 whole-book change
 * made that far too small. 300 matches every other heavy CMD cron here — indigo-explorer covers
 * 30 sequential accounts on the same budget — and a measured whole-book pull took 71.9s.
 *
 * A timeout here is SAFE, which is why the budget is 300 and not the ~720s theoretical worst case
 * (15 x the ~48s poll ceiling). collectRowsAcrossCustomers is all-or-nothing: writeRollup runs
 * only after every account has answered, so being killed mid-pull can never write a partial book —
 * it just leaves the previous rollup in place for the next run to retry. Grinding for 12 minutes
 * to avoid a stale-by-one-day rollup would be the wrong trade.
 */
import { handleCmdPayerRefresh } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
