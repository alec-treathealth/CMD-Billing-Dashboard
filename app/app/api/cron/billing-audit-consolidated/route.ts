/**
 * GET /api/cron/billing-audit-consolidated — CONSOLIDATED billing-audit ingest
 * (claims.audit_row; report 10064394, filter B then C per customer; scope TOB-derived
 * per row). Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * Replaces the dead IP pair's cron (10064394/10147816 — INVALID CRITERIA nightly since
 * 2026-07-17, decommissioned 2026-07-29). The OP cron (/api/cron/billing-audit-op)
 * stays live until this feed proves 5 clean nights; during that soak, OP-scope rows here
 * are fetched + counted but not written (CMD_AUDIT_CONSOLIDATED_OP_WRITE flips that at
 * cutover). Report/filter ids are env-var-only (CMD_AUDIT_CONSOLIDATED_REPORT_ID /
 * _FILTER_B_ID / _FILTER_C_ID — a missing var 500s loudly; never a silent fallback).
 *
 * MULTI-PASS NIGHTLY: the 17-customer × 2-filter sweep (~34 sequential CMD report runs)
 * exceeds one 300s invocation, so vercel.json fires this route several times per night;
 * each pass processes only roster customers no earlier pass finished today (UTC), read
 * from claims.audit_ingest_run. A pass that finds nothing left is a cheap no-op.
 *
 * Node runtime (pg + libsodium); never statically cached. Non-PHI counts only.
 */
import { handleBillingAuditConsolidatedCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleBillingAuditConsolidatedCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
