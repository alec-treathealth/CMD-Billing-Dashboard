/**
 * GET /api/cron/cmd-census — hourly BXR CMD charge-CENSUS ingest (Qualify v2 ②b, Feed 2).
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Pulls the CMD census saved-filter (a TRAILING CHARGE CENSUS, all payment states — env
 * CMD_BXR_CENSUS_FILTER_ID) once PER CUSTOMER (BXR's 15 facility accounts), encrypts the 3 PHI
 * identifiers, and UPSERTs one row per (business_entity_id, charge_id) into
 * collections.cmd_charge_census — the openCount DENOMINATOR — as the least-privilege
 * cmd_rollup_writer role, recording each per-customer pull in collections.cmd_census_run. Non-PHI
 * counts only. Freshness-gated (a customer a prior run completed OK within the staleness window is
 * skipped) so a full sweep amortizes over however many hourly runs it takes. Qualify reads the
 * census live, so there is no cache to revalidate.
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers up to 15 SEQUENTIAL
 * CMD batch polls (run → poll → unzip) plus the UPSERTs; the cron's wall-clock guard stops launching
 * new customers near the deadline and the rest are picked up next run (idempotent + self-healing).
 */
import { handleCmdCensusCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleCmdCensusCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
