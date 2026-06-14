/**
 * GET /api/collections/kpis — non-PHI MTD/YTD collections KPIs by facility.
 * Auth: Authorization: Bearer <RESULTS_API_SECRET>. Optional query param:
 *   ?as_of=YYYY-MM-DD (anchor; defaults to the latest payment_date present).
 * Any non-GET verb → 405. Aggregate amounts only — no patient data, no
 * source_group_code, no IP/OP (deferred this slice).
 *
 * Node runtime (pg); never statically cached.
 */
import { handleCollectionsKpis } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { status, body } = await handleCollectionsKpis({
    method: req.method,
    authorization: req.headers.get('authorization'),
    query: { as_of: url.searchParams.get('as_of') },
    createdBy: req.headers.get('x-created-by'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
export const POST = route;
