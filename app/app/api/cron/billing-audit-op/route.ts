/**
 * GET /api/cron/billing-audit-op — OP billing-audit ingest (claims.audit_row).
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * IP's sibling for the OP scope: loops the LOCKED 9-customer OP roster
 * (src/billingAudit/auditConfig.ts), pulling the OP audit report
 * (CMD_OP_AUDIT_REPORT_ID / _FILTER_ID, env-var-only, no fallbacks) once per customer.
 * The OP report is a DIFFERENT 39-column projection (duplicate "Charge Status" header,
 * member id under "Current Payer Member ID") — parsed positionally against the locked
 * header list; a mismatched header rejects that customer whole.
 *
 * SOAK STATUS (2026-07-29): the IP sibling route was decommissioned with its dead
 * report pair; this OP cron stays live UNTOUCHED until the consolidated feed
 * (/api/cron/billing-audit-consolidated) proves 5 clean nights, then decommissions the
 * same way. Shared behavior notes now live on the consolidated route.
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
