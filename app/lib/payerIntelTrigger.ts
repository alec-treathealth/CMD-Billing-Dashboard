/**
 * Vercel Cron -> GitHub Actions bridge for the monthly payer policy research run.
 *
 * The worker CANNOT run in a Vercel function. Measured on the 2026-08-03 batch, one
 * payer key takes ~2.5-8 minutes (multi-turn, web_search + web_fetch, ~50s/turn),
 * and the full roster ~25-70 minutes. That is past the serverless execution
 * ceiling, and a timeout mid-roster would leave a half-written run with no error
 * row — the exact silent failure this pipeline is designed to refuse. So GitHub
 * Actions is the WORKER (.github/workflows/payer-intel.yml) and Vercel is the
 * SCHEDULER, matching the established vob-sync arrangement so the job appears
 * alongside the other crons in one control plane.
 *
 * `dispatchWorkflow` is reused from vobSyncTrigger rather than duplicated — one
 * dispatch path, not two.
 *
 * Detailed run logs live in GitHub Actions. This route reports only whether the
 * dispatch was accepted. No PHI crosses this boundary: the payload is just {ref},
 * and the whole pipeline reads public payer/CMS pages only. The GitHub token is
 * read from env and never logged or echoed.
 */
import { isAuthorized } from '../../src/bearerAuth.js';
import { dispatchWorkflow } from './vobSyncTrigger.js';

const WORKFLOW_FILE = 'payer-intel.yml';
const REF = 'main';

/**
 * GET-only, CRON_SECRET-gated. deps are injectable for tests; in production the
 * token comes from GITHUB_DISPATCH_TOKEN (the same fine-grained token vob-sync
 * uses — Actions: read/write on this repo).
 */
export async function handlePayerIntelTrigger(
  req: { method?: string; authorization?: string | null },
  deps?: { token?: string; fetchImpl?: typeof fetch },
): Promise<{ status: number; body: unknown }> {
  if (req.method && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const token = deps?.token ?? process.env.GITHUB_DISPATCH_TOKEN;
  if (!token || token.trim() === '') {
    // Fail visibly: the cron shows red in Vercel until the token is provisioned.
    console.error('payer-intel trigger: GITHUB_DISPATCH_TOKEN not set');
    return { status: 500, body: { error: 'dispatch_token_missing' } };
  }
  try {
    const result = await dispatchWorkflow({
      token,
      fetchImpl: deps?.fetchImpl,
      workflowFile: WORKFLOW_FILE,
      ref: REF,
    });
    if (result.ok) return { status: 200, body: { ok: true, dispatched: WORKFLOW_FILE, ref: REF } };
    console.error(`payer-intel trigger failed: ${result.detail ?? result.status}`);
    return { status: 502, body: { error: 'dispatch_failed', github_status: result.status } };
  } catch (err) {
    console.error('payer-intel trigger error:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'dispatch_error' } };
  }
}
