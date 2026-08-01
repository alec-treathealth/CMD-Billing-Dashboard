/**
 * GET /api/cron/cmd-explorer-catchup — BXR LAST-MONTH explorer catch-up ingest
 * (collections.cmd_explorer_rows + collections.daily_collections, source_tag='cmd').
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * ⛔ NOT SCHEDULED — DO NOT ADD TO app/vercel.json YET.
 * This route deliberately has NO crons entry (vercel.json is strict JSON, so a
 * commented-out entry is impossible — this header is the note instead). Nothing
 * invokes it until an entry is added — Vercel crons are opt-in per path, and the
 * CRON_SECRET gate stops manual/stray GETs. TWO decisions block scheduling, both
 * Alec's:
 *
 * 1. THE HOUR — proposed slot 07:52 UTC. Minutes already in use across the grid:
 *    :00 :10 :15 :17 :20 :30 :35 :40 :45. The full-month pull measured ~92s, so a
 *    :52 start finishes ~07:54, clear of the hourly explorer at :00.
 *    CONFLICT: era-835's intended (also-unscheduled) slot is `50 8 * * *` with the
 *    hour marked "pick deliberately". At :50, with a 210s budget and a 4-8 min
 *    realistic runtime, era-835 can still be running at :52 — different endpoint
 *    but the SAME CMD partner session, which allows ONE report at a time. The two
 *    hours must be chosen against each other, not independently.
 *
 * 2. THE FILTER WINDOW — CMD_EXPLORER_LASTMONTH_FILTER_ID (10148479 as probed) has
 *    UNVERIFIED window semantics: "Last Month" (advances each month — correct) vs
 *    fixed 2026-07-01..31 (never advances — silently re-supplies July forever, a
 *    stale-data failure that LOOKS like a working cron: green runs, plausible
 *    counts, wrong month). The two are identical today and diverge Sept 1. Alec
 *    resolves it in the CMD UI filter editor; the route must not be scheduled
 *    until then. The env var is REQUIRED (no fallback) so an unconfigured deploy
 *    fails loudly rather than re-pulling the current month under a catch-up name.
 *
 * INTENDED SCHEDULE (when enabled): { "path": "/api/cron/cmd-explorer-catchup", "schedule": "52 7 * * *" }
 *   - DAILY, not hourly: the catch-up exists for payments that post AFTER the
 *     rolling current-month window rolls over (the 2026-07-30 FRCA $540 class);
 *     once a day is plenty, and the span-scoped daily replace + fingerprint
 *     dedup make re-pulls free.
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
