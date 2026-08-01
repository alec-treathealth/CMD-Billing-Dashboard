/**
 * GET /api/cron/cmd-explorer-catchup — BXR LAST-MONTH explorer catch-up ingest
 * (collections.cmd_explorer_rows + collections.daily_collections, source_tag='cmd').
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * SCHEDULED: { "path": "/api/cron/cmd-explorer-catchup", "schedule": "52 7 * * *" }
 * Enabled 2026-08-01, after both blocking decisions below were resolved.
 *   - DAILY, not hourly: the catch-up exists for payments that post AFTER the
 *     rolling current-month window rolls over (the 2026-07-30 FRCA $540 class);
 *     once a day is plenty, and the span-scoped daily replace + fingerprint
 *     dedup make re-pulls free.
 *
 * 1. THE HOUR — RESOLVED: 07:52 UTC. Minutes already in use across the grid:
 *    :00 :10 :15 :17 :20 :30 :35 :40 :45. The full-month pull measured ~92s, so a
 *    :52 start finishes ~07:54, clear of the hourly explorer at :00. era-835 sits
 *    at `50 8 * * *` — a full hour later, deliberately: both endpoints share the
 *    SAME CMD partner session, which allows ONE report at a time, and era-835's
 *    210s budget plus a 4-8 min realistic runtime would overlap a :52 slot in the
 *    same hour. The two hours are chosen against each other; do not move either
 *    one independently.
 *
 * 2. THE FILTER WINDOW — RESOLVED: CMD_EXPLORER_LASTMONTH_FILTER_ID = 10148481,
 *    created under report 10093959 and confirmed in the CMD UI filter editor as
 *    RELATIVE "Last Month" — it ADVANCES each month, which is the only semantics
 *    that makes a recurring catch-up correct.
 *
 *    ⚠ DO NOT point this cron at 10148479. That filter is a FIXED 07/01-08/01
 *    range — a one-time instrument, built to recover the single stranded FRCA
 *    $540 payment the 2026-07-30 report-deletion incident left behind, and
 *    already spent. Scheduling a fixed-range filter is the stale-data failure
 *    that LOOKS like a working cron: green runs, plausible counts, silently
 *    re-supplying July forever. The two filters return identical rows today and
 *    DIVERGE on Sept 1 — which is exactly why the distinction has to be read off
 *    this comment rather than rediscovered from a wrong month of data.
 *
 *    The env var is REQUIRED (no fallback, see requiredLastMonthFilterId in
 *    app/lib/server.ts) so an unconfigured deploy fails loudly rather than
 *    re-pulling the current month under a catch-up name.
 *
 * Node runtime (pg + libsodium via ../src — libsodium-wrappers must stay in
 * serverExternalPackages); never statically cached. maxDuration covers 15
 * SEQUENTIAL CMD batch polls (run → poll → unzip) plus the DB writes — requires
 * a Vercel plan that allows a 300s function (Pro+). The wall-clock guard in
 * cmdExplorerCron stops launching new customers near the deadline; unfinished
 * facilities are picked up on the next run (idempotent).
 */
import { handleCmdExplorerCatchupCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleCmdExplorerCatchupCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
