/**
 * CollaborateMD (CMD) Web API — V2 DATA SNAPSHOT download for one customer.
 *
 *   GET /v2/customer/{customer}/snapshot
 *
 * THE CONTRACT (V2 docs, "Data Snapshot Downloads", + live probe 2026-09-09):
 *   - Returns application/zip: one `{customer}/*.DAT` tab-delimited table per CMD entity
 *     (B_CHARGE, B_CLAIM, B_CLAIMSTATUS, B_CREDIT, B_REMITTANCE, B_PATNOTES, B_PAYOR, …) plus
 *     `meta/oracle-create.sql`. It is CMD's full per-customer data extract — every table is PHI.
 *   - "Snapshot requests must be approved before usage" and are configured per ACCOUNT/customer.
 *     The BXR account-level endpoint (/v2/account/475729/snapshot) returns 404; the per-customer
 *     endpoint returns 200 for 19 of BXR's 20 accounts (the billing umbrella 10030472 → 401). The
 *     Indigo customer probed on 2026-08-14 (10024431) returned 404 — not configured.
 *   - "The most recent snapshot file is the only one available" and it is built in the morning
 *     Eastern Time; a request too early in the day may 404 or serve the previous day's file. The
 *     data as-of is therefore taken FROM THE DATA (max B_CHARGE.LASTUPDATE), never from the clock.
 *   - Unlike the reporting endpoints this one uses HTTP statuses, not a JSON envelope: 404 =
 *     no file / not configured / bad customer; 401 = the credential may not download snapshots.
 *
 * WHY separate from cmd835.ts: same auth envelope and PHI posture, but a different endpoint, a
 * different (non-empty-day) classification, and a MUCH larger body (0.03–6.4 MB per customer at
 * recon; 64 MB cap here). No report slot is consumed — this is a direct GET — so it does not
 * contend with the :00/:15/:30/:35 CBI crons.
 *
 * PHI DISCIPLINE: this module moves BYTES only. It never parses, logs, or throws a value carrying
 * snapshot content. Errors carry the endpoint label, HTTP status, byte count and sha256 only —
 * never the URL, the body, or credentials.
 *
 * SECRETS: env-free by design (composition-root pattern) — the caller injects credentials.
 */
import { createHash } from 'node:crypto';
import type { CmdApiConfig } from './cmdPayer.js';

export interface CmdSnapshotConfig {
  /** API origin, e.g. 'https://webapi.collaboratemd.com'. */
  baseUrl: string;
  /** CMD customer id (one customer == one facility). */
  customerId: string;
  /** HTTP Basic (what CMD documents) or a forward-compat token. */
  auth: CmdApiConfig['auth'];
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 180s — a 6 MB snapshot on a slow link. */
  timeoutMs?: number;
  /** Max bytes to buffer. Default MAX_SNAPSHOT_BYTES. */
  maxBytes?: number;
}

/** 64 MB — ~10x the largest snapshot seen at recon (CAMH, 6.4 MB). */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
/** Local-file-header signature of a ZIP archive ("PK\x03\x04"), little-endian. */
const ZIP_MAGIC = 0x04034b50;

/**
 * Outcome of one download. `not_configured` (404) and `unauthorized` (401/403) are NORMAL,
 * expected outcomes for accounts without the snapshot product — record them, never alarm.
 */
export type CmdSnapshotResult =
  | { kind: 'zip'; bytes: Buffer }
  | { kind: 'not_configured' }
  | { kind: 'unauthorized' };

export type CmdSnapshotErrorCode =
  /** Non-2xx other than 401/403/404. `status` is set. */
  | 'http_status'
  /** HTTP 200 whose body does not start with the ZIP signature. */
  | 'unrecognized_body'
  /** The response exceeded the byte cap. */
  | 'response_too_large'
  /** Network failure, abort, or timeout. */
  | 'request_failed';

export class CmdSnapshotError extends Error {
  readonly code: CmdSnapshotErrorCode;
  readonly status: number | undefined;
  readonly byteLength: number | undefined;
  readonly sha256: string | undefined;
  constructor(code: CmdSnapshotErrorCode, detail: { status?: number; byteLength?: number; sha256?: string }) {
    const parts = [`CMD snapshot ${code}`];
    if (detail.status !== undefined) parts.push(`status=${detail.status}`);
    if (detail.byteLength !== undefined) parts.push(`bytes=${detail.byteLength}`);
    if (detail.sha256 !== undefined) parts.push(`sha256=${detail.sha256}`);
    super(parts.join(' '));
    this.name = 'CmdSnapshotError';
    this.code = code;
    this.status = detail.status;
    this.byteLength = detail.byteLength;
    this.sha256 = detail.sha256;
  }
}

function authHeader(auth: CmdApiConfig['auth']): Record<string, string> {
  if (auth.kind === 'token') return { Authorization: `Bearer ${auth.token}` };
  const basic = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${basic}` };
}

/** Digest of an unrecognized body — the ONLY operation ever performed on one (never a preview). */
function bodyDigest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Download one customer's current snapshot. Never throws for 404/401/403 (returned as kinds);
 * throws CmdSnapshotError for everything else. Never retries: the caller's loop is per-customer
 * isolated and re-attempts on the next scheduled run.
 */
export async function cmdFetchSnapshot(cfg: CmdSnapshotConfig): Promise<CmdSnapshotResult> {
  if (!/^\d{8}$/.test(cfg.customerId)) {
    throw new CmdSnapshotError('request_failed', {}); // a malformed id never reaches the wire
  }
  const doFetch = cfg.fetchImpl ?? fetch;
  const maxBytes = cfg.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v2/customer/${cfg.customerId}/snapshot`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: '*/*', ...authHeader(cfg.auth) },
    });
  } catch {
    clearTimeout(timer);
    throw new CmdSnapshotError('request_failed', {});
  }
  try {
    if (res.status === 404) return { kind: 'not_configured' };
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    if (!res.ok) throw new CmdSnapshotError('http_status', { status: res.status });

    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new CmdSnapshotError('response_too_large', { status: res.status, byteLength: declared });
    }
    let body: Buffer;
    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new CmdSnapshotError('request_failed', { status: res.status });
    }
    if (body.length > maxBytes) {
      throw new CmdSnapshotError('response_too_large', { status: res.status, byteLength: body.length });
    }
    const isZip = body.length >= 4 && body.readUInt32LE(0) === ZIP_MAGIC;
    if (!isZip) {
      throw new CmdSnapshotError('unrecognized_body', {
        status: res.status,
        byteLength: body.length,
        sha256: bodyDigest(body),
      });
    }
    return { kind: 'zip', bytes: body };
  } finally {
    clearTimeout(timer);
  }
}
