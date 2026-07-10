/**
 * GET /api/cron/cms-hcpcs-sync — quarterly CMS HCPCS change-detection sync.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron attaches this when
 * CRON_SECRET is set). GET only — any other verb is 405.
 *
 * Resolves the latest CMS Alpha-Numeric HCPCS quarterly file, diffs BH-relevant codes
 * against code_intel.ref_code, upserts changes and inserts pending policy_change_event
 * flags as the least-privilege code_intel_writer role. Returns NON-PHI counts only.
 *
 * DISABLED unless CMS_HCPCS_SYNC_ENABLED=true (see src/jobs/cmsHcpcsSync/run.ts) — the
 * job self-reports enabled:false and does nothing until a maintainer verifies the
 * fixed-width layout. Recommended first live run: CMS_HCPCS_SYNC_DRY_RUN=true.
 *
 * Node runtime (pg + zlib); never statically cached. maxDuration covers the CMS page
 * fetch + ZIP download + parse + batched writes — requires a Vercel plan that allows a
 * 60s function (Pro+).
 */
import { handleCmsHcpcsSync } from '@/lib/codeIntel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleCmsHcpcsSync({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
