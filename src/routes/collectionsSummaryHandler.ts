/**
 * Transport-agnostic handler for GET /api/collections/summary (Phase 7).
 *
 * Returns the NON-PHI monthly collections summary. It is GET (no PHI, no body):
 * the only inputs are optional `from`/`to` date bounds in the query string. Auth
 * is enforced here with the shared Bearer secret (RESULTS_API_SECRET) — the same
 * gate the agent/results routes use — so the financial aggregate is never served
 * unauthenticated. Any non-GET verb is 405; a malformed date is 400; an
 * unexpected failure collapses to a generic 500 (never echoed).
 *
 * The underlying `collectionsMonthlySummary` reads only
 * collections.daily_collections + collections.facilities as claims_reader; it
 * never reads collections_raw/payment_lines and never exposes source_group_code.
 */
import { isAuthorized } from '../bearerAuth.js';
import {
  collectionsMonthlySummary,
  ISO_DATE_RE,
  type CollectionsSummaryContext,
} from '../collections/summary.js';
import type { CollectionsSummaryArgs } from '../collections/summaryTypes.js';

export interface CollectionsSummaryHttpRequest {
  /** HTTP method. GET only — any other verb is 405. */
  method?: string;
  authorization?: string | null;
  /** Optional non-PHI date bounds parsed from the query string. */
  query?: { from?: string | null; to?: string | null };
  /** Optional non-PHI principal for the audit trail. */
  createdBy?: string | null;
}

export interface CollectionsSummaryRouteDeps {
  /** MUST wrap the claims_reader connection. */
  ctx: CollectionsSummaryContext;
  secret: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export async function handleCollectionsSummaryRequest(
  req: CollectionsSummaryHttpRequest,
  deps: CollectionsSummaryRouteDeps,
): Promise<HandlerResult> {
  // GET only — there is no request body and no PHI; any other verb is rejected
  // outright, independent of auth.
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (!isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const from = req.query?.from?.trim() || undefined;
  const to = req.query?.to?.trim() || undefined;
  // Validate bounds up front so malformed input is a clean 400 (a DB-side error
  // would otherwise collapse to a generic 500 below).
  for (const v of [from, to]) {
    if (v !== undefined && !ISO_DATE_RE.test(v)) {
      return { status: 400, body: { error: 'bad_request' } };
    }
  }

  const args: CollectionsSummaryArgs = { from, to };
  const createdBy = req.createdBy?.trim() || 'collections-summary-api';

  try {
    const summary = await collectionsMonthlySummary(args, { ...deps.ctx, createdBy });
    return { status: 200, body: summary };
  } catch {
    // Never echo the error (it may name a table/column).
    return { status: 500, body: { error: 'summary_failed' } };
  }
}
