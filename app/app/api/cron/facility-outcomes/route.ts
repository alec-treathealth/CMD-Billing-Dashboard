/**
 * GET /api/cron/facility-outcomes — completed-stay LOS/auth per facility, from the executive
 * dashboard's census history into collections.qualify_facility_outcomes (migration 0091).
 *
 * SCHEDULED daily 04:10 UTC (app/vercel.json). DAILY, not hourly, on purpose: these are trailing
 * 365-day averages over FINISHED admissions, so a day's worth of discharges moves them
 * imperceptibly — an hourly job would be 24x the cross-project traffic for the same numbers.
 *
 * 04:10 is clear of every existing cron (:00 :15 :22 :30 :35 :45 :55 hourly; 02:20 02:40 03:10 03:40
 * daily) and OUTSIDE the :41-:59 band reserved for live CMD probe work. This calls Supabase, not the
 * CMD API, so it does not contend for CMD's one-report-at-a-time partner slot either way — the slot
 * was chosen conservatively rather than arguing the band down.
 *
 * TWO DATABASES: reads the source project over EXEC_CENSUS_DATABASE_URL, writes THIS project as
 * cmd_rollup_writer. The aggregate runs in the SOURCE, so only facility-grain rows cross the wire —
 * see the PHI block in facilityOutcomesSync.ts. No patient row is ever transferred.
 *
 * FAILS LOUDLY (500), unlike the census cron which returns 200 with counts. The difference is
 * deliberate: the census cron degrades per-board and a partial run is a real, expected state, while
 * this job either reaches the source database or does not. There is no honest partial answer to
 * report, and a silent 200 would let the outcomes table drift stale behind a factor that is now
 * scoring facilities on it.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (the standard Vercel cron contract). GET only.
 */
import type pg from 'pg';
import { makeClient } from '../../../../../src/collections/db';
import { runFacilityOutcomesSync } from '../../../../../src/collections/facilityOutcomesSync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

let writer: ReturnType<typeof makeClient> | null = null;
let sourceDb: ReturnType<typeof makeClient> | null = null;

function writerPool() {
  if (!writer) {
    const url = process.env.CMD_ROLLUP_WRITER_DATABASE_URL;
    if (!url) throw new Error('Missing CMD_ROLLUP_WRITER_DATABASE_URL (set in env; never hardcode or log it)');
    writer = makeClient(url);
  }
  return writer;
}

function sourcePool() {
  if (!sourceDb) {
    const url = process.env.EXEC_CENSUS_DATABASE_URL;
    // Named, not described — the message must be actionable without ever echoing the value.
    if (!url) throw new Error('Missing EXEC_CENSUS_DATABASE_URL (set in env; never hardcode or log it)');
    sourceDb = makeClient(url);
  }
  return sourceDb;
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  let src: pg.PoolClient | null = null;
  let dst: pg.PoolClient | null = null;
  try {
    src = await sourcePool().connect();
    dst = await writerPool().connect();
    const stats = await runFacilityOutcomesSync(src, dst);
    return Response.json({ ok: true, ...stats }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // Message only — a connection error can carry the host, so never the error object, and never
    // the connection string.
    console.error(`facility-outcomes cron failed (${err instanceof Error ? err.message : 'error'})`);
    return Response.json({ ok: false, error: 'sync_failed' }, { status: 500 });
  } finally {
    src?.release();
    dst?.release();
  }
}
