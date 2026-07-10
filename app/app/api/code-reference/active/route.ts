/**
 * GET /api/code-reference/active?facility=KWC&payer=BCBS%20AR&setting=residential[&asOf=YYYY-MM-DD]
 *
 * Dashboard read: the active (confirmed) billing codes for a facility × payer × setting
 * as of a date. Reads over the least-privilege claims_reader path. NON-PHI reference
 * data only. facility, payer, and setting are required (400 otherwise).
 *
 * Node runtime (pg); never statically cached.
 */
import { handleActiveBillingCodes } from '@/lib/codeIntel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { status, body } = await handleActiveBillingCodes({
    facility: url.searchParams.get('facility'),
    payer: url.searchParams.get('payer'),
    setting: url.searchParams.get('setting'),
    asOf: url.searchParams.get('asOf'),
  });
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = route;
