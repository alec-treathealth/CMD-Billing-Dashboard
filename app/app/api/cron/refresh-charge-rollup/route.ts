/**
 * GET /api/cron/refresh-charge-rollup — dedicated hourly refresh of the 0050 charge-grain matview
 * collections.cmd_explorer_charge_rollup.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when CRON_SECRET is set).
 * GET only — any other verb is 405.
 *
 * Scheduled 45 * * * * (app/vercel.json) so it runs AFTER the :00 BXR (cmd-explorer) and :30 Indigo
 * (indigo-explorer) ingests. It calls collections.refresh_cmd_explorer_charge_rollup() (the 0050
 * SECURITY-DEFINER function) UNCONDITIONALLY as the least-privilege cmd_rollup_writer role, then
 * writes one collections.rollup_refresh_run row per attempt (start row → updated on completion) so
 * refresh freshness is queryable by SELECT with zero Vercel-log access. Returns non-PHI stats only.
 *
 * This replaces the inline best-effort refresh formerly in the ingest loop (cmdExplorerCron): that
 * one only fired on non-zero inserts and competed with the 210s ingest budget inside one 300s
 * function, and swallowed failures. Here the refresh gets its OWN function with headroom.
 *
 * Node runtime (pg); never statically cached. maxDuration=180: the 0059 rollup rebuild
 * (allowed_reliable + tiers) raised the REFRESH ... CONCURRENTLY cost from ~58s to 76–113s measured
 * (2026-07-22, ~485k logical charges; the 113s reading ran against a cold-ish cache) — 120 left as
 * little as ~7s of headroom, so this bump ships WITH 0059 as operational headroom for the matview's
 * own refresh (Alec's ruling: not a consumer repoint, don't park it behind one). A timed-out
 * CONCURRENT refresh fails safe (matview keeps prior contents; rollup_refresh_run shows the
 * started-but-unfinished row) — requires a Vercel plan that allows a 180s function (Pro+).
 */
import { handleRefreshChargeRollup } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleRefreshChargeRollup({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
