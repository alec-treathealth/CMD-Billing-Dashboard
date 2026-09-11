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
 * Node runtime (pg); never statically cached. A timed-out CONCURRENT refresh fails safe: the matview
 * keeps its prior contents and rollup_refresh_run shows the started-but-unfinished row.
 *
 * ⚠ maxDuration HAS NEVER BEEN THE BINDING LIMIT, AND THE NOTE THAT STOOD HERE WAS WRONG ABOUT ITS
 * OWN SUBJECT. It read "maxDuration=180 … 120 left as little as ~7s of headroom, so this bump ships
 * WITH 0059 as operational headroom". Measured 2026-09-11: the DATABASE cancels first —
 * `statement_timeout = 120000`, `source = "configuration file"`, i.e. cluster-wide on this Supabase
 * project. Every failure in rollup_refresh_run is at exactly 120s, a full 60s before Vercel would
 * have intervened, so the 180s of "headroom" could never be reached from here.
 *
 * Migration 0114 raises that cap to 240s for `cmd_rollup_writer` alone, and maxDuration moves to 300
 * to sit ABOVE it. The ordering is the point: DB cap (240) < function cap (300), so a slow refresh is
 * cancelled by Postgres — which fails safe and records an honest row — rather than by Vercel, which
 * kills the function mid-flight and leaves the run row open. Setting these the other way round would
 * relocate the failure rather than fix it. 300 is the platform default ceiling on current plans.
 *
 * The remaining ~60s is the budget for the two jobs riding this cadence AFTER the refresh (the 0086
 * facility-resolution matview and the 0105 patient-name directory). Both are best-effort and already
 * wrapped, so squeezing them costs freshness rather than correctness — but a refresh that genuinely
 * approaches 240s is 0114's tripwire telling you to do the structural work, not to raise a number
 * for the second time.
 */
import { handleRefreshChargeRollup } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
