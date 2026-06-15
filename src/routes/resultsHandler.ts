/**
 * Transport-agnostic handler for the PHI results route — replaces the Express dev
 * harness (src/server.ts) as the production transport over `fetchResults`. The
 * Next.js route handler (app/app/api/results/route.ts) is the thin HTTP adapter.
 *
 * This route DOES return PHI rows — that is its purpose (the authenticated UI
 * fetch). It is therefore POST, not GET: the `query_id` and any re-supplied
 * `client_history` identity terms (PHI) travel in the request body, never in a
 * URL/query string (which could be logged). Auth is enforced here (Bearer).
 *
 * `fetchResults` re-executes the stored parameterized query as claims_reader,
 * projecting only allowlisted columns, never caching PHI, and (for
 * client_history) re-verifying the identity hash server-side before serving. A
 * missing/expired handle or a failed identity check fails closed to empty rows.
 * Any unexpected failure is collapsed to a generic 500 (never echoed).
 */
import { isAuthorized } from '../bearerAuth.js';
import { fetchResults, type ResultsContext, type ResultsIdentity } from './results.js';

export interface ResultsHttpRequest {
  /** HTTP method. POST only — any other verb is 405 (identity/query_id ride in the body). */
  method?: string;
  authorization?: string | null;
  /** Parsed JSON body (untrusted): `{ query_id, identity?, limit?, offset? }`. */
  body: unknown;
  /** Optional non-PHI principal for the audit trail (e.g. an `x-created-by` header). */
  createdBy?: string | null;
}

export interface ResultsRouteDeps {
  /** MUST wrap the claims_reader connection. */
  ctx: ResultsContext;
  secret: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export async function handleResultsRequest(
  req: ResultsHttpRequest,
  deps: ResultsRouteDeps,
): Promise<HandlerResult> {
  // POST only — a GET (or any non-POST) must never carry PHI in a URL, so it is
  // rejected outright, independent of auth.
  if (req.method !== undefined && req.method.toUpperCase() !== 'POST') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (!isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const queryId = extractQueryId(req.body);
  if (queryId === null) {
    return { status: 400, body: { error: 'bad_request' } };
  }

  const createdBy = req.createdBy?.trim() || 'results-api';
  const identity = extractIdentity(req.body);
  const { limit, offset } = extractPaging(req.body);

  try {
    const result = await fetchResults(
      { query_id: queryId, created_by: createdBy, identity, limit, offset },
      deps.ctx,
    );
    return { status: 200, body: result };
  } catch {
    // Do not echo the error (it may name a function/column).
    return { status: 500, body: { error: 'results_failed' } };
  }
}

function extractQueryId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as Record<string, unknown>).query_id;
  if (typeof id !== 'string' || id.trim() === '') return null;
  return id;
}

/**
 * Pull re-supplied client_history identity terms from the body, if present. Only
 * the two PHI fields are forwarded; `fetchResults` fully validates and
 * fail-closes (absent/blank/wrong identity → empty rows), so loose extraction
 * here is safe.
 */
/**
 * Pull the optional page bounds from the body. Loose extraction is safe:
 * `fetchResults` clamps `limit` to [1, MAX_PAGE_SIZE] (default 50) and `offset` to
 * a non-negative integer (default 0), so any garbage collapses to a bounded page.
 */
function extractPaging(body: unknown): { limit?: number; offset?: number } {
  if (typeof body !== 'object' || body === null) return {};
  const raw = body as Record<string, unknown>;
  const limit = typeof raw.limit === 'number' ? raw.limit : undefined;
  const offset = typeof raw.offset === 'number' ? raw.offset : undefined;
  return { limit, offset };
}

function extractIdentity(body: unknown): ResultsIdentity | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as Record<string, unknown>).identity;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const patientLast = (raw as Record<string, unknown>).patient_last;
  if (typeof patientLast !== 'string') return undefined;
  const member = (raw as Record<string, unknown>).member_id_norm;
  return {
    patient_last: patientLast,
    member_id_norm: typeof member === 'string' ? member : undefined,
  };
}
