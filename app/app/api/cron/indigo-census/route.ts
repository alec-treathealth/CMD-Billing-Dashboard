/**
 * GET /api/cron/indigo-census — hourly Indigo CMD charge-CENSUS ingest (Qualify v2 ②b, Feed 2).
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Indigo's sibling of /api/cron/cmd-census: pulls the CMD census saved-filter (env
 * CMD_INDIGO_CENSUS_FILTER_ID, on Indigo's report) once PER CUSTOMER (32 Indigo facility accounts),
 * aliases the "Customer Name" facility column (aliasIndigoFacilityColumn — the shared census mapper
 * reads facility only from "Facility Name"), encrypts the 3 PHI identifiers, and UPSERTs into
 * collections.cmd_charge_census as the least-privilege cmd_rollup_writer role, recording each pull in
 * collections.cmd_census_run. Non-PHI counts only. A SEPARATE route (not a param on cmd-census) so an
 * Indigo failure is attributable by route name; scheduled with cmd-census at :15 (both off the :00/:30
 * explorer crons on the shared one-report-at-a-time CMD partner session).
 *
 * Node runtime (pg + libsodium); never statically cached. maxDuration covers up to 32 SEQUENTIAL CMD
 * batch polls plus the UPSERTs; the cron's wall-clock guard + freshness cursor amortize a full Indigo
 * sweep over multiple hourly runs (idempotent + self-healing).
 */
import { handleIndigoCensusCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleIndigoCensusCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
