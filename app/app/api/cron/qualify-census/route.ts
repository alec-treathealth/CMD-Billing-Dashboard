/**
 * GET /api/cron/qualify-census — monday census → collections.qualify_facility_census aggregates
 * (Qualify Phase G: the auth-fit factor, UR banner, and open-bed context).
 *
 * ⚠ DELIBERATELY NOT IN app/vercel.json YET. Scheduling this is a morning decision, not an
 * overnight one: (1) the standing rule keeps the cron surface untouched outside explicitly scoped
 * sessions; (2) the monday token in env is a personal admin-scoped key — the least-privilege
 * service identity should land first; (3) monday quiet-window placement (:41–:59, per the CMD
 * cron contention notes) deserves a human look. Until then: run manually via
 * scripts/run-qualify-census.ts, or hit this route with the Bearer secret.
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
