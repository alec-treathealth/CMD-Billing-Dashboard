/**
 * GET /api/cron/billing-audit-op — OP billing-audit ingest (claims.audit_row).
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * IP's sibling for the OP scope: loops the LOCKED 11-customer OP roster
 * (src/billingAudit/auditConfig.ts), pulling the OP audit report
 * (CMD_OP_AUDIT_REPORT_ID / _FILTER_ID, env-var-only, no fallbacks) once per customer.
 * The OP report is a DIFFERENT 39-column projection (duplicate "Charge Status" header,
 * member id under "Current Payer Member ID") — parsed positionally against the locked
 * header list; a mismatched header rejects that customer whole. See
 * /api/cron/billing-audit-ip for the shared behavior notes. NOT scheduled in
 * vercel.json yet — schedule entries land as their OWN commit after manual verify.
 */
import { handleBillingAuditOpCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleBillingAuditOpCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
