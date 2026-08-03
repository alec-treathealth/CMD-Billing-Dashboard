/**
 * GET /api/cron/payer-intel — triggers the monthly payer policy research workflow.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * The research worker runs on GitHub's runners (.github/workflows/payer-intel.yml),
 * not here: one payer key takes ~2.5-8 minutes and the full roster ~25-70, past the
 * serverless ceiling. This route only POSTs a workflow_dispatch so Vercel stays the
 * single scheduler + control plane, the same arrangement as vob-sync. Requires
 * GITHUB_DISPATCH_TOKEN in the Vercel environment. No PHI — the pipeline reads
 * public payer bulletins and CMS documents only.
 *
 * NOT ARMED until `SQL Schemas/025_payer_policy_intel.sql` is applied. Without it
 * the worker's writes fail against a missing intel schema (the 0056 pattern:
 * merging a migration does not apply it).
 *
 * Node runtime; never statically cached. maxDuration is small — the dispatch is a
 * single fast POST.
 */
import { handlePayerIntelTrigger } from '@/lib/payerIntelTrigger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handlePayerIntelTrigger({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
