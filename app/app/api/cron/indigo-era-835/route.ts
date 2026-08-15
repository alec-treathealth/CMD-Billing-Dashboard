/**
 * GET /api/cron/indigo-era-835 — daily INDIGO 835 ERA ingest (staging.era_835_payment +
 * staging.era_835_adjustment, migration 013; run log 022).
 * Auth: Authorization: Bearer <CRON_SECRET>. GET only — any other verb is 405.
 *
 * SCHEDULED: { "path": "/api/cron/indigo-era-835", "schedule": "50 9 * * *" }
 *   - Mirrors the BXR route's minute (:50) exactly ONE HOUR LATER, the same offset shape the
 *     explorer and census pairs use (cmd-explorer :00 / indigo-explorer :30, cmd-census :15 /
 *     indigo-census :35). BXR's era-835 fires 08:50 with maxDuration 300, so it is finished
 *     well before 09:50 — the two never contend for CMD's one-report-at-a-time partner slot.
 *   - Hour 9 is otherwise clear: vob-sync at 09:17 runs as a GitHub Action, not a CMD call,
 *     and the two crons inside the :41-:59 band on the hourly grid do not touch CMD
 *     (refresh-charge-rollup :45 is DB-only; upcoming-overrides :55 calls Google Sheets).
 *   - :50 sits INSIDE the :41-:59 CMD quiet window BY DESIGN, on the same reading as era-835
 *     and refresh-cmd-payer: the band is held for live CMD probe work, and a scheduled CMD
 *     cron that owns its slot is what the band protects, not what it excludes.
 *   - DAILY, not hourly: ERAs do not arrive fast enough to justify 24x the CMD load, and
 *     fingerprint dedup on both tables makes re-pulls free.
 *   - 5-day lookback per run (ERA835_LOOKBACK_DAYS), same as BXR: ERAs land late relative to
 *     receipt date, so each run re-pulls a trailing window.
 *
 * ⚠ TWO OPEN RISKS AT MERGE TIME — both are the reason this ships behind a HOLD rather than
 * being scheduled in the same change. Do NOT add the vercel.json entry until both clear:
 *
 *   1. THE CMD PAYMENT ROLE ON INDIGO'S ACCOUNT (474623) IS UNVERIFIED. download-835 requires
 *      it specifically. indigo-explorer / indigo-census prove the shared credential REACHES
 *      Indigo, but those are report endpoints, not this one. A 401/403 here is fatal by design
 *      (it aborts the whole run rather than burning 144 more doomed pulls) and is a
 *      provisioning fix, not a retry — the thrown CmdEra835Error names the credential path.
 *   2. INDIGO ERA COVERAGE IS UNMEASURED. ERA enrollment is per-payer per-provider; Indigo may
 *      receive few or no ERAs through CMD, which would make this route inert. The read-only
 *      probe (scripts/probe-era-coverage.ts --live --customers <indigo ids>) answers both 1
 *      and 2 with zero DB connections and zero writes. Run it first.
 *
 * ⚠ ALSO INHERITED FROM BXR (finding 1, still unresolved): the 2026-07-31 probe saw 30%/42%
 * failure episodes whose root cause is UNKNOWN, and the throttle theory was FALSIFIED
 * (six-times-gentler pacing produced a HIGHER failure rate). This route roughly DOUBLES the
 * daily CMD 835 call volume against that unknown. Watch pulls_failed_by_code in
 * staging.era_835_ingest_run on the first several runs.
 *
 * pulls_skipped_budget > 0 IS EXPECTED HERE and is not a fault — 29 customers × 5 dates = 145
 * pulls needs ~218s of inter-call pacing before any network time, against a 210s budget. The
 * skip lands on the NEWEST dates (expandDateRange is ascending), which stay in the trailing
 * window and are picked up on later runs. See handleIndigoEra835IngestCron for the full note.
 *
 * Node runtime (pg + libsodium via ../src — libsodium-wrappers must stay in
 * serverExternalPackages); never statically cached. maxDuration 300 matches era-835.
 */
import { handleIndigoEra835IngestCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleIndigoEra835IngestCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
