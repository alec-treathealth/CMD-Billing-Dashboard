/**
 * GET /api/cron/upcoming-overrides — "Upcoming Payments" sheet → staging.
 * expected_payment_override (migration 023). Auth: Bearer <CRON_SECRET>. GET only — else 405.
 *
 * Syncs the operator's hand-keyed forward payment forecast so the Overview "ERA-Confirmed
 * Upcoming Payers" tile can show money that has no 835 yet. Replace-per-sync inside one
 * withTenant transaction; hash no-op when the sheet is unchanged; a fetch failure or header
 * drift keeps last good data (ok:false in the JSON, zero writes).
 *
 * ADDITIVE-ONLY: forecast rows never suppress an ERA row. See src/veris/upcomingOverride.ts.
 *
 * Schedule lives in app/vercel.json (single source of truth) — do not restate it here;
 * see the collections-crons rule.
 */
import { handleUpcomingOverridesCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleUpcomingOverridesCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
