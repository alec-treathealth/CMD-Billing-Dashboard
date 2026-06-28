/**
 * GET /api/cron/cmd-explorer — daily CMD Collections Explorer ingest.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when
 * CRON_SECRET is set). GET only — any other verb is 405.
 *
 * Pulls the live CMD 14-column explorer report, encrypts the 3 PHI identifiers, and
 * idempotently upserts into collections.cmd_explorer_rows as the least-privilege
 * cmd_rollup_writer role, then revalidates the 'cmd-explorer' cache tag. Returns
 * non-PHI counts only.
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers the CMD
 * batch poll (run → poll → unzip) — requires a Vercel plan that allows a 60s function.
 */
import { handleCmdExplorerCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
