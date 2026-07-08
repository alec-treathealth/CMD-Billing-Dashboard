/**
 * GET /api/cron/indigo-explorer — daily Indigo CMD Collections Explorer ingest.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Indigo's sibling of /api/cron/cmd-explorer: pulls the live CMD report (report 10092391 /
 * filter 10147669) once PER CUSTOMER (37 Indigo facility accounts), aliases the "Customer Name"
 * facility column, encrypts the 3 PHI identifiers, idempotently upserts charge lines into
 * collections.cmd_explorer_rows AND re-sources per-facility Check+EFT deposits into
 * collections.daily_collections (source_tag='cmd') as the least-privilege cmd_rollup_writer role,
 * then revalidates the shared 'cmd-explorer' + 'dashboard-aggregates' cache tags. Non-PHI counts
 * only. A SEPARATE route (not a param on cmd-explorer) so an Indigo failure is attributable by
 * route name in logs + the Vercel Cron tab; scheduled at :30 to stay off the shared CMD partner
 * session that BXR uses at :00.
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers 37 SEQUENTIAL CMD
 * batch polls plus the DB writes; the cron's wall-clock guard stops launching new customers near
 * the deadline and the rest are picked up next run (idempotent).
 */
import { handleIndigoExplorerCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleIndigoExplorerCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
