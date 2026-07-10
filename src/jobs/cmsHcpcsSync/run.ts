/**
 * Orchestrator for the quarterly CMS HCPCS sync.
 *
 * Flow: resolve+download+parse latest quarter → BH-filter → read prior snapshot →
 * PURE diff → (unless dry-run) upsert added/revised, mark deleted, insert pending
 * flags idempotently → return a NON-PHI summary.
 *
 * SAFETY GATES (audit-first):
 *   * Disabled by default. Set CMS_HCPCS_SYNC_ENABLED=true only AFTER a maintainer has
 *     verified the fixed-width layout offsets (layout.ts) against the CMS record-layout
 *     PDF for the target year. Until then this returns immediately without touching the
 *     network or DB.
 *   * CMS_HCPCS_SYNC_DRY_RUN=true (or dryRun arg) runs fetch+parse+diff and reports
 *     counts WITHOUT any writes — the recommended first live invocation.
 */
import { liveCmsFileSource, type CmsFileSource } from './cmsSource.js';
import { diffHcpcs } from './diff.js';
import { filterBhRecords } from './filter.js';
import {
  fetchTrackedSnapshot,
  insertChangeEvents,
  makeWriterPool,
  markCodesDeleted,
  upsertRefCodes,
  writerConnectionStringFromEnv,
  type Db,
} from './db.js';
import type { CmsSyncSummary } from './types.js';

export interface RunOptions {
  source?: CmsFileSource;
  /** Provide a pool for tests; otherwise built from CODE_INTEL_WRITER_DATABASE_URL. */
  db?: Db;
  dryRun?: boolean;
  asOf?: Date;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

function emptySummary(overrides: Partial<CmsSyncSummary>): CmsSyncSummary {
  return {
    enabled: false,
    sourceRef: null,
    fetchedUrl: null,
    totalRecords: 0,
    bhRecords: 0,
    added: 0,
    revised: 0,
    deleted: 0,
    refCodesUpserted: 0,
    eventsInserted: 0,
    dryRun: false,
    ...overrides,
  };
}

export async function runCmsHcpcsSync(opts: RunOptions = {}): Promise<CmsSyncSummary> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(`[cms-hcpcs-sync] ${m}`));
  const enabled = (env.CMS_HCPCS_SYNC_ENABLED ?? '').toLowerCase() === 'true';
  const dryRun = opts.dryRun ?? (env.CMS_HCPCS_SYNC_DRY_RUN ?? '').toLowerCase() === 'true';

  if (!enabled) {
    log('disabled (CMS_HCPCS_SYNC_ENABLED != true) — no network, no DB writes');
    return emptySummary({ enabled: false, dryRun });
  }

  const source = opts.source ?? liveCmsFileSource;
  const now = opts.now ?? new Date();

  // 1–4: fetch → parse → BH filter (pure once fetched).
  const quarter = await source.fetchLatestQuarter(opts.asOf ?? now);
  const bh = filterBhRecords(quarter.records);
  log(`fetched ${quarter.sourceRef} (${quarter.url}): ${quarter.records.length} records, ${bh.length} BH-relevant`);

  // Own a pool only if we built it (so we close only what we opened).
  const ownPool = !opts.db && !dryRun;
  const db = opts.db ?? (dryRun ? undefined : makeWriterPool(writerConnectionStringFromEnv(env)));

  try {
    // 5: prior snapshot (dry-run with no db → empty snapshot; everything looks "added").
    const snapshot =
      db !== undefined
        ? await fetchTrackedSnapshot(db)
        : { rows: [], idByCode: new Map<string, string>() };

    // 6: PURE diff.
    const { events, upserts, deletedCodes } = diffHcpcs(bh, snapshot.rows);
    const added = events.filter((e) => e.changeType === 'code_added').length;
    const revised = events.filter((e) => e.changeType === 'code_revised').length;
    const deleted = deletedCodes.length;

    if (dryRun || db === undefined) {
      log(`DRY RUN — would upsert ${upserts.length}, delete ${deleted}, flag ${events.length}`);
      return emptySummary({
        enabled: true,
        dryRun: true,
        sourceRef: quarter.sourceRef,
        fetchedUrl: quarter.url,
        totalRecords: quarter.records.length,
        bhRecords: bh.length,
        added,
        revised,
        deleted,
      });
    }

    // 7–9: writes. Upsert first so added codes have ids for their events.
    const idByCode = new Map(snapshot.idByCode);
    const upsertedIds = await upsertRefCodes(db, upserts, quarter.sourceRef, now);
    for (const [code, id] of upsertedIds) idByCode.set(code, id);
    await markCodesDeleted(db, deletedCodes, now);
    const eventsInserted = await insertChangeEvents(db, events, quarter.sourceRef, idByCode);

    log(`applied — upserted ${upserts.length}, deleted ${deleted}, inserted ${eventsInserted} flags`);
    return emptySummary({
      enabled: true,
      dryRun: false,
      sourceRef: quarter.sourceRef,
      fetchedUrl: quarter.url,
      totalRecords: quarter.records.length,
      bhRecords: bh.length,
      added,
      revised,
      deleted,
      refCodesUpserted: upserts.length,
      eventsInserted,
    });
  } finally {
    if (ownPool && db) await db.end();
  }
}
