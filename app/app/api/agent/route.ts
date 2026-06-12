/**
 * POST /api/agent — the search agent over HTTP. Auth: Authorization: Bearer
 * <RESULTS_API_SECRET>. Body: { "question": string }. Returns
 * { tool_name, query_id, summary_stats } — PHI never appears in the response.
 * A GET (or any non-POST) is answered 405 by the handler.
 *
 * Node runtime (pg + the Anthropic SDK); never statically cached.
 */
import { handleAgent } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
  const { status, body: out } = await handleAgent({
    method: req.method,
    authorization: req.headers.get('authorization'),
    body,
    createdBy: req.headers.get('x-created-by'),
  });
  return Response.json(out, { status, headers: status === 405 ? { Allow: 'POST' } : undefined });
}

export const POST = route;
export const GET = route;
