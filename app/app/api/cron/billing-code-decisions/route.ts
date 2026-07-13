/**
 * GET /api/cron/billing-code-decisions — "JT Master Issues" decision-matrix sync →
 * claims.billing_code_decision. Auth: Bearer <CRON_SECRET>. GET only — else 405.
 *
 * EH tab is canonical; JT contributes ONLY col-O stop dates (Alec's locked ruling,
 * 2026-07-13). Hash no-op when the sheet is unchanged; disappeared rows are marked
 * stopped, never deleted; a whole-tab parse failure keeps last good data (ok:false in
 * the JSON, no writes). Output carries per-tab contribution counts + the unmatched /
 * catch-all carrier attribution lists. NOT scheduled in vercel.json yet — schedule
 * entries land as their OWN commit after manual verify (session brief invariant).
 */
import { handleBillingCodeDecisionsCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleBillingCodeDecisionsCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
