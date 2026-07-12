/**
 * GET /api/code-reference/pending-flags
 *
 * Dashboard read: all pending code-change flags (CMS quarterly + manual), urgency-
 * ordered with deletions first. Powers the "⚠️ Pending Review" panel. Reads over the
 * least-privilege claims_reader path. NON-PHI.
 *
 * Node runtime (pg); never statically cached.
 */
import { handlePendingCodeFlags } from '@/lib/codeIntel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const { status, body } = await handlePendingCodeFlags({
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = route;
