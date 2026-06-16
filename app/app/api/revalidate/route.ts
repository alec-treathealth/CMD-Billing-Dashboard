/**
 * POST /api/revalidate — exact dashboard freshness (Phase 8.2).
 * Auth: Authorization: Bearer <REVALIDATE_SECRET>. Body (optional):
 *   { "tag"?: "dashboard-aggregates" }
 *
 * Invoked by the CMD ingest AFTER it refreshes the aggregate matviews, to drop the
 * dashboard's `unstable_cache` tag immediately instead of waiting out the 15-minute
 * revalidation fallback (which remains as a safety net). POST only — a GET (or any
 * non-POST) is answered 405 by the handler. The tag is restricted to a closed
 * allowlist; an arbitrary tag is rejected and nothing is invalidated. No PHI, no DB
 * access, no logging of the token or body.
 *
 * Node runtime; never statically cached.
 */
import { handleRevalidate } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
  const { status, body: out } = handleRevalidate({
    method: req.method,
    authorization: req.headers.get('authorization'),
    body,
  });
  return Response.json(out, {
    status,
    headers: status === 405 ? { Allow: 'POST' } : { 'Cache-Control': 'no-store' },
  });
}

export const POST = route;
export const GET = route;
