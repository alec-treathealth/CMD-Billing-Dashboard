/**
 * GET /api/cron/vob-sync — triggers the VOB incremental sync GitHub Actions workflow.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * The VOB sync is a Python PDF ETL that runs on GitHub's runners (.github/workflows/vob-sync.yml);
 * this route only POSTs a workflow_dispatch so Vercel is the single scheduler + control plane and
 * the job appears alongside the other crons. Detailed execution logs live in GitHub Actions; this
 * route reports only whether the dispatch was accepted. Requires GITHUB_DISPATCH_TOKEN (a
 * fine-grained token with Actions: read/write on this repo) in the Vercel environment. No PHI.
 *
 * Node runtime; never statically cached. maxDuration is small — the dispatch is a single fast POST.
 */
import { handleVobSyncTrigger } from '@/lib/vobSyncTrigger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleVobSyncTrigger({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
