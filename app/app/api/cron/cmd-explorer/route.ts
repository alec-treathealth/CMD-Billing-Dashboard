/**
 * GET /api/cron/cmd-explorer — daily CMD Collections Explorer ingest.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when
 * CRON_SECRET is set). GET only — any other verb is 405.
 *
 * Pulls the live CMD 16-column report (filter 10147494) once PER CUSTOMER (15 facility
 * accounts), encrypts the 3 PHI identifiers, idempotently upserts charge lines into
 * collections.cmd_explorer_rows AND re-sources per-facility Check+EFT deposits into
 * collections.daily_collections (source_tag='cmd') as the least-privilege cmd_rollup_writer
 * role, then revalidates the 'cmd-explorer' + 'dashboard-aggregates' cache tags. Non-PHI
 * counts only.
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers 15 SEQUENTIAL
 * CMD batch polls (run → poll → unzip) plus the DB writes — requires a Vercel plan that allows
 * a 300s function (Pro+). A wall-clock guard in cmdExplorerCron stops launching new customers
 * near the deadline; unfinished facilities are picked up on the next run (idempotent).
 */
import { handleCmdExplorerCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleCmdExplorerCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
