/**
 * GET /api/cron/ar-snapshot — daily AR Management ingest from the CMD V2 customer DATA SNAPSHOT.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * For each BXR account on the AR roster (src/billingAudit/arConfig.ts) that is not fresh, downloads
 * `GET /v2/customer/{c}/snapshot` (a direct GET — no CBI report slot is consumed, so this does not
 * contend with the hourly explorer/census pulls), maps every charge/claim/note/remit/status row,
 * encrypts the PHI in-process and upserts claims.ar_* as the least-privilege claims_audit_writer,
 * recording each pull in claims.ar_snapshot_run. Non-PHI counts only in the response.
 *
 * 14:05 UTC (10:05 ET): CMD builds snapshot files in the morning Eastern time; the freshness cursor
 * (20h) means a manual re-run is a no-op until the next day's file. Node runtime (pg + libsodium);
 * never statically cached; maxDuration covers ~19 sequential downloads + upserts, with the loop's own
 * wall-clock guard stopping new launches near the ceiling (the rest catch up next run).
 */
import { handleArSnapshotCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleArSnapshotCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
