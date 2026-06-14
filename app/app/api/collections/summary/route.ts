/**
 * GET /api/collections/summary — non-PHI monthly collections summary by facility.
 * Auth: Authorization: Bearer <RESULTS_API_SECRET>. Optional query params:
 *   ?from=YYYY-MM-DD (inclusive) &to=YYYY-MM-DD (exclusive).
 *
 * GET (no body, no PHI). Any non-GET verb is answered 405 by the handler. The
 * response is aggregate-only (month × facility amounts) — no patient data, no
 * source_group_code. Never statically cached.
 *
 * Node runtime (pg).
 */
import { handleCollectionsSummary } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { status, body } = await handleCollectionsSummary({
    method: req.method,
    authorization: req.headers.get('authorization'),
    query: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
    createdBy: req.headers.get('x-created-by'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
export const POST = route;
