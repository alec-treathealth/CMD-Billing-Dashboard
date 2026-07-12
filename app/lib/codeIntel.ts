/**
 * Server-side handlers for the behavioral-health code-intelligence feature.
 *
 * Two surfaces, matching the existing app pattern (thin route → handler here):
 *   - handleCmsHcpcsSync: the quarterly Vercel Cron entry. Gated on CRON_SECRET with a
 *     constant-time Bearer check (fail-closed on a missing secret), GET-only. Runs the
 *     sync (which writes as the least-privilege code_intel_writer role via its own env
 *     var) and returns NON-PHI counts.
 *   - handleActiveBillingCodes / handlePendingCodeFlags: dashboard reads over the
 *     least-privilege claims_reader path (PgExecutor), returning non-PHI reference data.
 *
 * Import boundary mirrors lib/server.ts: the app imports the reader pool + query lib
 * from ../../src. No service-role key, no claims_admin, no PostgREST.
 */
import { timingSafeEqual } from 'node:crypto';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../src/queries/executor.js';
import {
  getActiveBillingCodes,
  getPendingCodeFlags,
  type ActiveBillingCodeRow,
  type PendingCodeFlagRow,
} from '../../src/queries/code_intel.js';
import { runCmsHcpcsSync } from '../../src/jobs/cmsHcpcsSync/index.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

// --- auth -------------------------------------------------------------------

/** Constant-time `Authorization: Bearer <secret>` check. Fail-closed on empty secret. */
function isAuthorized(authorization: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.trim() === '') return false;
  const expected = `Bearer ${secret}`;
  const got = authorization ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- cron: quarterly CMS HCPCS sync -----------------------------------------

export async function handleCmsHcpcsSync(req: {
  method?: string;
  authorization?: string | null;
}): Promise<HandlerResult> {
  if (req.method && req.method !== 'GET') {
    return { status: 405, body: { error: 'Method Not Allowed' } };
  }
  if (!isAuthorized(req.authorization, process.env.CRON_SECRET)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  try {
    const summary = await runCmsHcpcsSync();
    return { status: 200, body: { ok: true, summary } };
  } catch (err) {
    // Never leak internals/secrets to the client — log server-side, return a generic error.
    console.error('[codeIntel] handleCmsHcpcsSync:', err);
    return { status: 500, body: { ok: false, error: 'internal error' } };
  }
}

// --- reads ------------------------------------------------------------------

let cachedExecutor: PgExecutor | undefined;
function executor(): PgExecutor {
  cachedExecutor ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return cachedExecutor;
}

// Reader endpoints are gated on the same shared secret as the other non-PHI reader
// routes (/api/collections/*, /api/results → RESULTS_API_SECRET). Fail-closed: no secret
// or a mismatch → 401 before any DB access. These surfaces are currently unwired (no UI
// consumes them) and belong to the code-intelligence workstream; when that workstream
// wires a dashboard UI it should decide whether to move to per-user session auth — until
// then default-deny is the correct posture.
function readAuthorized(authorization: string | null | undefined): boolean {
  return isAuthorized(authorization, process.env.RESULTS_API_SECRET);
}

/** Generic 500 — log the real error server-side, never return internals (DB/schema names) to clients. */
function internalError(context: string, err: unknown): HandlerResult {
  console.error(`[codeIntel] ${context}:`, err);
  return { status: 500, body: { error: 'internal error' } };
}

export async function handleActiveBillingCodes(params: {
  authorization?: string | null;
  facility?: string | null;
  payer?: string | null;
  setting?: string | null;
  asOf?: string | null;
}): Promise<HandlerResult> {
  if (!readAuthorized(params.authorization)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  const facility = (params.facility ?? '').trim();
  const payer = (params.payer ?? '').trim();
  const setting = (params.setting ?? '').trim();
  if (!facility || !payer || !setting) {
    return { status: 400, body: { error: 'facility, payer, and setting are required' } };
  }
  const asOf = params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf) ? params.asOf : undefined;
  try {
    const rows: ActiveBillingCodeRow[] = await getActiveBillingCodes(executor(), {
      facilityCode: facility,
      payerName: payer,
      setting,
      asOf,
    });
    return { status: 200, body: { rows } };
  } catch (err) {
    return internalError('handleActiveBillingCodes', err);
  }
}

export async function handlePendingCodeFlags(params: {
  authorization?: string | null;
}): Promise<HandlerResult> {
  if (!readAuthorized(params.authorization)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  try {
    const rows: PendingCodeFlagRow[] = await getPendingCodeFlags(executor());
    return { status: 200, body: { rows } };
  } catch (err) {
    return internalError('handlePendingCodeFlags', err);
  }
}
