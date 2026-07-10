/**
 * Public surface of the CMS HCPCS quarterly sync.
 *
 * Direct invocation (manual/dry-run):
 *   CMS_HCPCS_SYNC_ENABLED=true CMS_HCPCS_SYNC_DRY_RUN=true npx tsx src/jobs/cmsHcpcsSync/index.ts
 * The Vercel Cron path calls runCmsHcpcsSync() via app/lib/codeIntel.ts.
 */
export { runCmsHcpcsSync, type RunOptions } from './run.js';
export type { CmsSyncSummary } from './types.js';

// Allow `tsx src/jobs/cmsHcpcsSync/index.ts` for a local dry-run.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { runCmsHcpcsSync } = await import('./run.js');
  runCmsHcpcsSync()
    .then((s) => {
      console.log(JSON.stringify(s, null, 2));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('[cms-hcpcs-sync] failed:', err);
      process.exit(1);
    });
}
