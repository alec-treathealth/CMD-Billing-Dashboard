/**
 * GET /api/cron/qualify-census — monday census → collections.qualify_facility_census aggregates
 * (Qualify Phase G: the auth-fit factor, UR banner, and open-bed context).
 *
 * SCHEDULED hourly at :22 (app/vercel.json) — ratified 2026-08-04 in the explicitly-scoped
 * Auth/LOS session after MONDAY_SECRET_API_KEY landed in Vercel (Preview + Production).
 *
 * ⚠ :22, NOT :41–:59. This was first scheduled at :47 on a misreading of the morning runbook, which
 * called :41–:59 a good slot. It is the opposite: **:41–:59 UTC is the CMD quiet window reserved for
 * live probe work, and no production cron may be scheduled inside it — not even a non-CMD one**
 * (corrected by Alec 2026-08-05). :22 is clear of every existing hourly cron (:00 :15 :30 :35 :45 :55)
 * and outside the reserved band. Do not move this back into the :41–:59 range.
 * A missing/invalid key degrades honestly: runQualifyCensusSync catches per board, the route
 * returns 200 with failure counts, and the auth-fit factor stays "no data yet" — pinned by
 * test/qualifyCensusSync.test.ts. Manual run: scripts/run-qualify-census.ts.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (the standard Vercel cron contract). GET only.
 * PHI: none end to end — the sync fetches monday column values only (never census item names)
 * and writes facility-grain counts/averages/dates. Response is non-PHI stats.
 */
import { makeClient } from '../../../../../src/collections/db';
import { runQualifyCensusSync } from '../../../../../src/collections/qualifyCensusSync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

let pool: ReturnType<typeof makeClient> | null = null;
function writerPool() {
  if (!pool) {
    const url = process.env.CMD_ROLLUP_WRITER_DATABASE_URL;
    if (!url) throw new Error('Missing CMD_ROLLUP_WRITER_DATABASE_URL (set in env; never hardcode or log it)');
    pool = makeClient(url);
  }
  return pool;
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const client = await writerPool().connect();
  try {
    const stats = await runQualifyCensusSync(client);
    return Response.json({ ok: true, ...stats }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error(`qualify-census cron failed (${err instanceof Error ? err.message : 'error'})`);
    return Response.json({ ok: false, error: 'sync_failed' }, { status: 500 });
  } finally {
    client.release();
  }
}
