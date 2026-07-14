/**
 * GET /api/cron/billing-audit-ip — IP billing-audit ingest (claims.audit_row).
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * Loops the LOCKED 8-customer IP roster (src/billingAudit/auditConfig.ts — scope IS
 * the roster), pulling the IP audit report (CMD_IP_AUDIT_REPORT_ID / _FILTER_ID,
 * env-var-only, no fallbacks) once per customer, encrypting the 3 PHI identifiers
 * in-process, and Option-B-upserting charge lines into claims.audit_row as the
 * least-privilege claims_audit_writer role. Non-PHI counts only. A SEPARATE route from
 * the OP scope so a failure is attributable by route name in logs + the Vercel Cron
 * tab. NOT scheduled in vercel.json yet — schedule entries land as their OWN commit
 * after this endpoint is deployed and manually verified (session brief invariant).
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers 8
 * SEQUENTIAL CMD batch polls + DB writes; the wall-clock guard stops launching new
 * customers near the deadline and the rest catch up next run (idempotent upsert).
 */
import { handleBillingAuditIpCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleBillingAuditIpCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
