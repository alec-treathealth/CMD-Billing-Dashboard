/**
 * Transport-agnostic handlers for the Phase 7.1 daily-collections query routes:
 *   GET /api/collections/daily  → granular daily rows (optional facility + window)
 *   GET /api/collections/kpis   → per-facility + overall MTD/YTD (optional as_of)
 *
 * Both are NON-PHI and GET (no body): inputs are only date/facility values in the
 * query string. Auth is the shared Bearer secret (RESULTS_API_SECRET) — the same
 * gate as the agent/results/summary routes. Non-GET → 405; malformed date → 400;
 * unexpected failure → generic 500 (never echoed). The underlying functions read
 * only collections.daily_collections + facilities; never collections_raw /
 * payment_lines, never source_group_code.
 */
import { isAuthorized } from '../bearerAuth.js';
import {
  collectionsDaily,
  collectionsKpis,
  type CollectionsQueryContext,
} from '../collections/daily.js';
import { ISO_DATE_RE } from '../collections/summary.js';

export interface CollectionsQueryHttpRequest {
  method?: string;
  authorization?: string | null;
  query?: { facility?: string | null; from?: string | null; to?: string | null; as_of?: string | null };
  createdBy?: string | null;
}

export interface CollectionsQueryRouteDeps {
  ctx: CollectionsQueryContext;
  secret: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** GET /api/collections/daily */
export async function handleCollectionsDailyRequest(
  req: CollectionsQueryHttpRequest,
  deps: CollectionsQueryRouteDeps,
): Promise<HandlerResult> {
  const gate = preflight(req, deps, ['from', 'to']);
  if (gate) return gate;

  const facility = req.query?.facility?.trim() || undefined;
  const from = req.query?.from?.trim() || undefined;
  const to = req.query?.to?.trim() || undefined;
  const createdBy = req.createdBy?.trim() || 'collections-daily-api';

  try {
    const result = await collectionsDaily({ facility_code: facility, from, to }, { ...deps.ctx, createdBy });
    return { status: 200, body: result };
  } catch {
    return { status: 500, body: { error: 'daily_failed' } };
  }
}

/** GET /api/collections/kpis */
export async function handleCollectionsKpisRequest(
  req: CollectionsQueryHttpRequest,
  deps: CollectionsQueryRouteDeps,
): Promise<HandlerResult> {
  const gate = preflight(req, deps, ['as_of']);
  if (gate) return gate;

  const as_of = req.query?.as_of?.trim() || undefined;
  const createdBy = req.createdBy?.trim() || 'collections-kpis-api';

  try {
    const result = await collectionsKpis({ as_of }, { ...deps.ctx, createdBy });
    return { status: 200, body: result };
  } catch {
    return { status: 500, body: { error: 'kpis_failed' } };
  }
}

/**
 * Shared method/auth/date gate. Returns a HandlerResult to short-circuit, or null
 * to proceed. `dateKeys` lists which query params must be 'YYYY-MM-DD' if present.
 */
function preflight(
  req: CollectionsQueryHttpRequest,
  deps: CollectionsQueryRouteDeps,
  dateKeys: Array<'from' | 'to' | 'as_of'>,
): HandlerResult | null {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (!isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  for (const k of dateKeys) {
    const v = req.query?.[k]?.trim();
    if (v && !ISO_DATE_RE.test(v)) {
      return { status: 400, body: { error: 'bad_request' } };
    }
  }
  return null;
}
