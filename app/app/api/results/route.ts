/**
 * POST /api/results — the PHI results fetch (replaces the Express dev harness).
 * Auth: Authorization: Bearer <RESULTS_API_SECRET>. Body:
 *   { "query_id": string, "identity"?: { "patient_last": string, "member_id_norm"?: string } }
 *
 * POST (not GET) so query_id and any client_history identity terms (PHI) travel
 * in the request body, never in a URL/query string. A GET (or any non-POST) is
 * answered 405 by the handler — routed through it explicitly so the method check
 * is exercised, not left to a framework default. Re-executes the stored
 * parameterized query as claims_reader, projecting only allowlisted columns; PHI
 * is never cached. client_history re-verifies identity before serving rows.
 *
 * Node runtime (pg); never statically cached.
 */
import { handleResults } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
  const { status, body: out } = await handleResults({
    method: req.method,
    authorization: req.headers.get('authorization'),
    body,
    createdBy: req.headers.get('x-created-by'),
  });
  return Response.json(out, { status, headers: status === 405 ? { Allow: 'POST' } : undefined });
}

export const POST = route;
export const GET = route;
