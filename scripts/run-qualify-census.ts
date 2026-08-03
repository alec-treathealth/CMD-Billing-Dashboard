/**
 * Manual runner for the Qualify monday-census sync (Phase G).
 *
 *   npx tsx scripts/run-qualify-census.ts               # sync the configured boards
 *   npx tsx scripts/run-qualify-census.ts --discover    # list workspace boards to extend the map
 *
 * Requires MONDAY_SECRET_API_KEY + CMD_ROLLUP_WRITER_DATABASE_URL in env (root .env works via
 * `node --env-file`; tsx picks up the shell env). 0078 must be applied first — a missing table
 * fails loudly here (this is an operator tool; fail-soft belongs to the app's read path).
 *
 * PHI: none — see qualifyCensusSync.ts (column values only; census item names never fetched).
 */
import { makeClient } from '../src/collections/db.js';
import { runQualifyCensusSync, discoverWorkspaceBoards } from '../src/collections/qualifyCensusSync.js';
import { MONDAY_CENSUS_BOARDS } from '../src/collections/qualifyCensus.js';

const ADMISSIONS_WORKSPACE = '2613676'; // 'A. Admissions (Main)' — verified 2026-08-03

async function main(): Promise<void> {
  if (process.argv.includes('--discover')) {
    const boards = await discoverWorkspaceBoards(ADMISSIONS_WORKSPACE);
    console.log(`${boards.length} boards in workspace ${ADMISSIONS_WORKSPACE} (map the census ones in qualifyCensus.ts):`);
    const mapped = new Set(MONDAY_CENSUS_BOARDS.map((b) => b.boardId));
    for (const b of boards) console.log(`  ${mapped.has(b.id) ? '✓' : ' '} ${b.id}  ${b.name}`);
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
    const stats = await runQualifyCensusSync(client);
    console.log(JSON.stringify(stats, null, 2));
    if (stats.conformance.some((c) => c.missing.length > 0)) {
      console.log('\nconformance gaps (board lacks expected columns):');
      for (const c of stats.conformance.filter((x) => x.missing.length > 0)) {
        console.log(`  ${c.boardId} (${c.facilityCode}, ${c.family}): missing ${c.missing.join(', ')}`);
      }
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
