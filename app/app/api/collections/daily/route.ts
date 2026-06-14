/**
 * GET /api/collections/daily — non-PHI daily collections rows (date × facility).
 * Auth: Authorization: Bearer <RESULTS_API_SECRET>. Optional query params:
 *   ?facility=CAMH &from=YYYY-MM-DD (incl) &to=YYYY-MM-DD (excl).
 * With no from/to, defaults to the latest calendar month present. Any non-GET
 * verb → 405. Aggregate/daily amounts only — no patient data, no source_group_code.
 *
 * Node runtime (pg); never statically cached.
 */
import { handleCollectionsDaily } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { status, body } = await handleCollectionsDaily({
    method: req.method,
    authorization: req.headers.get('authorization'),
    query: {
      facility: url.searchParams.get('facility'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    },
    createdBy: req.headers.get('x-created-by'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
export const POST = route;
