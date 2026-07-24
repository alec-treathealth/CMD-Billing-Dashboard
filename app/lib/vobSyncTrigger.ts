/**
 * Vercel Cron -> GitHub Actions bridge for the VOB incremental sync.
 *
 * The VOB sync is a Python PDF ETL that runs on GitHub's runners
 * (.github/workflows/vob-sync.yml), NOT in a Vercel function (pypdf/psycopg + a 30-min
 * budget don't belong in a 300s serverless route). This thin route lets Vercel be the
 * single scheduler + control plane so the job appears and is runnable alongside the other
 * crons: when Vercel fires GET /api/cron/vob-sync we POST a workflow_dispatch to GitHub,
 * which runs the ETL. GitHub is therefore the WORKER and Vercel the SCHEDULER — the
 * workflow's own `schedule:` is removed so it never double-fires.
 *
 * Detailed run logs live in GitHub Actions; this route only reports whether the dispatch
 * was accepted (GitHub returns 204 on success). No PHI crosses this boundary — the payload
 * is just {ref}. The GitHub token is read from env and never logged or echoed.
 */
import { isAuthorized } from '../../src/bearerAuth.js';

const OWNER = 'alec-treathealth';
const REPO = 'CMD-Billing-Dashboard';
const WORKFLOW_FILE = 'vob-sync.yml';
const REF = 'main';

export type DispatchResult = { ok: boolean; status: number; detail?: string };

/**
 * POST a workflow_dispatch to GitHub. `fetchImpl`/`token` are injectable for tests.
 * Never logs or returns the token. GitHub replies 204 No Content on success.
 */
export async function dispatchWorkflow(opts: {
  token: string;
  fetchImpl?: typeof fetch;
  owner?: string;
  repo?: string;
  workflowFile?: string;
  ref?: string;
}): Promise<DispatchResult> {
  const f = opts.fetchImpl ?? fetch;
  const owner = opts.owner ?? OWNER;
  const repo = opts.repo ?? REPO;
  const wf = opts.workflowFile ?? WORKFLOW_FILE;
  const ref = opts.ref ?? REF;
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`;
  const res = await f(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cmd-billing-dashboard-cron',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });
  if (res.status === 204) return { ok: true, status: 204 };
  // Surface the status only — never echo the token or the full body.
  return { ok: false, status: res.status, detail: `github_dispatch_failed_${res.status}` };
}

/**
 * GET-only, CRON_SECRET-gated handler. Triggers the VOB sync workflow via workflow_dispatch.
 * deps are injectable for tests; in production the token comes from GITHUB_DISPATCH_TOKEN.
 */
export async function handleVobSyncTrigger(
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
    console.error('vob-sync trigger: GITHUB_DISPATCH_TOKEN not set');
    return { status: 500, body: { error: 'dispatch_token_missing' } };
  }
  try {
    const r = await dispatchWorkflow({ token, fetchImpl: deps?.fetchImpl });
    if (r.ok) return { status: 200, body: { ok: true, dispatched: WORKFLOW_FILE, ref: REF } };
    console.error(`vob-sync trigger failed: ${r.detail ?? r.status}`);
    return { status: 502, body: { error: 'dispatch_failed', github_status: r.status } };
  } catch (err) {
    console.error('vob-sync trigger error:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'dispatch_error' } };
  }
}
