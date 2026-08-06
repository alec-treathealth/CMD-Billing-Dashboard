/**
 * Manual runner for the Qualify monday-census sync (Phase G).
 *
 *   npx tsx scripts/run-qualify-census.ts               # sync the configured facilities
 *   npx tsx scripts/run-qualify-census.ts --discover    # list census-candidate boards to extend the map
 *
 * Requires MONDAY_SECRET_API_KEY + CMD_ROLLUP_WRITER_DATABASE_URL in env (root .env works via
 * `node --env-file`; tsx picks up the shell env). 0078 must be applied first — a missing table
 * fails loudly here (this is an operator tool; fail-soft belongs to the app's read path).
 *
 * PHI: none — see qualifyCensusSync.ts (column values only; census item names never fetched).
 */
import { makeClient } from '../src/collections/db.js';
import { discoverWorkspaceBoards } from '../src/collections/qualifyCensusSync.js';
import { runQualifyCensusSyncLogged } from '../src/collections/qualifyCensusRun.js';
import {
  CENSUS_BLOCKED_BOARDS,
  CENSUS_DEFERRED_BOARDS,
  CENSUS_WORKSPACE_IDS,
  MONDAY_CENSUS_FACILITIES,
  conformanceHasGap,
} from '../src/collections/qualifyCensus.js';

async function main(): Promise<void> {
  if (process.argv.includes('--discover')) {
    // Paginated and multi-workspace: a single unpaginated pass over one workspace hid ten census
    // boards behind a 100-board page cap and two more in another workspace entirely.
    const { boards, perWorkspace } = await discoverWorkspaceBoards(CENSUS_WORKSPACE_IDS);
    for (const w of perWorkspace) {
      console.log(`workspace ${w.workspaceId}: ${w.total} boards over ${w.pages} page(s)`);
    }
    const mapped = new Map<string, string>();
    for (const f of MONDAY_CENSUS_FACILITIES) for (const id of f.boardIds) mapped.set(id, f.facilityCode);
    const blocked = new Map(CENSUS_BLOCKED_BOARDS.map((b) => [b.boardId, b.blocker]));
    const deferred = new Map(CENSUS_DEFERRED_BOARDS.map((b) => [b.boardId, b.reason]));
    console.log(`\n${boards.length} board(s) after exclusions — ✓ mapped, B blocked on roster, D deferred:`);
    for (const b of boards) {
      const flag = mapped.has(b.id) ? '✓' : blocked.has(b.id) ? 'B' : deferred.has(b.id) ? 'D' : ' ';
      const note = mapped.get(b.id) ?? blocked.get(b.id) ?? deferred.get(b.id) ?? '';
      console.log(`  ${flag} ${b.id.padEnd(12)} ${b.name}${note ? `  — ${note}` : ''}`);
    }
    return;
  }

  const url = process.env.CMD_ROLLUP_WRITER_DATABASE_URL;
  if (!url) {
    console.error('Missing CMD_ROLLUP_WRITER_DATABASE_URL');
    process.exit(1);
  }
  const pool = makeClient(url);
  const client = await pool.connect();
  try {
    // Logged like the cron (0087), tagged 'manual' so an operator's ad-hoc run is distinguishable
    // from a scheduled one in collections.qualify_census_run.
    const stats = await runQualifyCensusSyncLogged({ client, triggeredBy: 'manual' });
    console.log(JSON.stringify(stats, null, 2));
    const gapped = stats.conformance.filter(conformanceHasGap);
    if (gapped.length > 0) {
      console.log('\nconformance gaps:');
      for (const c of gapped) {
        const causes = [
          c.missingTitles.length > 0 ? `missing: ${c.missingTitles.join(', ')}` : null,
          c.emptyTitles.length > 0 ? `resolved-but-empty: ${c.emptyTitles.join(', ')}` : null,
          c.familyMismatch,
          c.settingMismatch,
        ].filter((s): s is string => s !== null && s !== '');
        console.log(`  ${c.facilityCode} (${c.family}, boards ${c.boardIds.join(',')}): ${causes.join('; ')}`);
      }
    }
    if (stats.blocked_boards.length > 0) {
      console.log('\nblocked on a roster row (NOT mapped — would write an orphan census row):');
      for (const b of stats.blocked_boards) console.log(`  ${b.boardId}  ${b.boardName} — ${b.blocker}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
