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
 * 2. THE FILTER WINDOW — the filter MUST be RELATIVE "Last Month" (it ADVANCES
 *    each month), which is the only semantics that makes a recurring catch-up
 *    correct. Under report 10093959 that was 10148481; after the 2026-08-16
 *    swap to report 10094775 it is 10148844. Confirm in the CMD UI filter editor.
 *
 *    ⚠ NEVER point this cron at a FIXED date range (10148479 was one: a spent
 *    07/01-08/01 instrument built to recover the stranded FRCA $540 payment the
 *    2026-07-30 report-deletion incident left behind). Scheduling a fixed-range
 *    filter is the stale-data failure that LOOKS like a working cron: green runs,
 *    plausible counts, silently re-supplying one month forever. A relative and a
 *    fixed filter return identical rows in the month they were made and DIVERGE
 *    at the next rollover — which is why this has to be read off the filter
 *    editor rather than rediscovered from a wrong month of data.
 *
 * 3. THE REPORT ID — CMD_EXPLORER_CATCHUP_REPORT_ID, added 2026-08-17 and
 *    REQUIRED with no fallback.
 *
 *    ⚠ THIS CRON USED TO INHERIT THE EXPLORER'S REPORT, AND THAT BROKE IT. It
 *    spread cmdExplorerConfigFor and overrode only the filter, so when
 *    CMD_EXPLORER_REPORT_ID flipped 10093959 → 10094775 it paired the NEW report
 *    with a filter saved under the OLD one. CMD saved filters are report-SCOPED,
 *    so every pairing returns INVALID CRITERIA — the identical failure the BXR
 *    census hit on 2026-08-01 (0/15 for ~13h). Both ids are now read from their
 *    own env var so that changing one without the other fails loudly.
 *
 *    Both vars are REQUIRED (no fallback — see requiredCatchupReportId and
 *    requiredLastMonthFilterId in app/lib/server.ts) so an unconfigured deploy
 *    fails loudly rather than re-pulling the current month under a catch-up name.
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
