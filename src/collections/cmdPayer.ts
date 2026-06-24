/**
 * CollaborateMD (CMD) Web API reader — per-payer monthly gap as a non-PHI summary.
 *
 * WHY: the dashboard's "By Payer" chart normally reads claims.mv_payer_gap (built
 * from the Google-Sheets ingest), but that matview is missing complete 2026
 * Apr–May data. CMD is the source of truth for 2026 payer payments, so the
 * past-2026-month payer view sources from the CMD report-run endpoint instead.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the CMD response may contain patient-level
 * rows. This module aggregates to PAYER TOTALS in-process and returns ONLY the
 * non-PHI `PayerGapSummary` shape (payer name + dollar totals — both allowlisted).
 * It never logs the response body, patient fields, or the credentials. The HTTP
 * error path deliberately surfaces the status code only, never the body.
 *
 * SECRETS: this module is env-free by design (composition-root pattern). The
 * caller (app/lib/server.ts) reads CMD_* from the server environment and injects
 * them via `CmdApiConfig`; secrets never reach the browser and are never logged.
 *
 * ⚠️ UNVERIFIED RESPONSE CONTRACT. This environment has no CMD credentials, so the
 * request method / params / response shape below are an ASSUMPTION, not confirmed.
 * Run `npm run probe:cmd` with real credentials, inspect the printed shape, then
 * reconcile `cmdRunReport` (method + body) and `mapCmdReportToPayerGap` (field
 * names) before relying on this path. Until then the caller falls back to the
 * matview range, so a wrong assumption degrades gracefully instead of breaking.
 */
import type { PayerGapRow, PayerGapSummary } from '../queries/types.js';

/** Connection + report identity + credentials, injected by the composition root. */
export interface CmdApiConfig {
  /** API origin, e.g. 'https://webapi.collaboratemd.com'. */
  baseUrl: string;
  /** CMD customer/account id (BXR/CMD = '10027973'). */
  customerId: string;
  /** Saved report id ('10091729' — the payer payments report). */
  reportId: string;
  /** Saved filter id ('10147241'). */
  filterId: string;
  /** Either an API token (Bearer) or HTTP Basic credentials. */
  auth:
    | { kind: 'token'; token: string }
    | { kind: 'basic'; username: string; password: string };
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function authHeaders(auth: CmdApiConfig['auth']): Record<string, string> {
  if (auth.kind === 'token') return { Authorization: `Bearer ${auth.token}` };
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  return { Authorization: `Basic ${basic}` };
}

/**
 * Low-level: run the saved CMD report for a [from, to] window and return parsed
 * JSON. Shared by the probe and the mapper so confirming the contract once fixes
 * both. ⚠️ ASSUMED: POST with a JSON `{ startDate, endDate }` body — confirm with
 * the probe. On a non-2xx, throws with the STATUS ONLY (never the body, which
 * could echo PHI or a credential).
 */
export async function cmdRunReport(
  cfg: CmdApiConfig,
  window: { from: string; to: string },
): Promise<unknown> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1/customer/${cfg.customerId}/reports/${cfg.reportId}/filter/${cfg.filterId}/run`;
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders(cfg.auth),
    },
    body: JSON.stringify({ startDate: window.from, endDate: window.to }),
  });
  if (!res.ok) throw new Error(`CMD report run failed: HTTP ${res.status}`);
  return res.json();
}

// --- Response mapping (⚠️ UNVERIFIED field names) --------------------------
// CMD reports are user-defined column sets, so the exact keys are unknown until
// the probe is run. We resolve each field from a documented set of candidate
// names (case-insensitive). If the shape doesn't match we THROW, so the caller
// falls back rather than rendering a wrong/empty chart.

const PAYER_KEYS = ['payer', 'payer_name', 'payerName', 'insurance', 'insuranceName', 'primaryPayer', 'payerCompany'];
const CHARGE_KEYS = ['charge', 'charges', 'totalCharges', 'chargeAmount', 'billed', 'billedAmount'];
const ALLOWED_KEYS = ['allowed', 'allowedAmount', 'totalAllowed', 'contractAllowed'];
const PAID_KEYS = ['paid', 'payment', 'payments', 'totalPayments', 'paidAmount', 'insurancePaid'];
const COUNT_KEYS = ['claims', 'claimCount', 'count', 'visits', 'encounters', 'numClaims'];

/** Case-insensitive field read across a set of candidate keys. */
function pick(row: Record<string, unknown>, candidates: readonly string[]): unknown {
  for (const c of candidates) if (c in row) return row[c];
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const c of candidates) {
    const v = lower[c.toLowerCase()];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Money/number coercion: accepts numbers or '$1,234.56' strings; else 0. */
function toAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toPayerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/** Locate the array of report rows within a few plausible envelope shapes. */
function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const k of ['rows', 'data', 'results', 'records', 'report']) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const vo = v as Record<string, unknown>;
        for (const k of ['rows', 'data', 'results', 'records']) {
          if (Array.isArray(vo[k])) return vo[k] as Record<string, unknown>[];
        }
      }
    }
  }
  throw new Error('CMD report response: could not locate a rows array (unverified shape?)');
}

/**
 * Map a CMD report-run response to the non-PHI `PayerGapSummary`. Aggregates by
 * payer (the report may be pre-grouped by payer or per-claim — both collapse to
 * payer totals here). Throws if no payer totals can be derived, so a mismatched
 * field map fails closed to the caller's fallback instead of a misleading chart.
 */
export function mapCmdReportToPayerGap(json: unknown): PayerGapSummary {
  const rows = extractRows(json);
  const byPayer = new Map<string, PayerGapRow>();
  for (const row of rows) {
    const payer = toPayerName(pick(row, PAYER_KEYS));
    const charge = toAmount(pick(row, CHARGE_KEYS));
    const allowed = toAmount(pick(row, ALLOWED_KEYS));
    const paid = toAmount(pick(row, PAID_KEYS));
    const countRaw = toAmount(pick(row, COUNT_KEYS));
    const count = countRaw > 0 ? countRaw : 1; // per-claim rows have no count field
    const key = payer ?? '__null_payer__';
    const acc =
      byPayer.get(key) ??
      {
        payer_name: payer,
        claim_count: 0,
        total_charge: 0,
        total_allowed: 0,
        total_paid: 0,
        avg_collection_rate: null,
        total_write_down: 0,
        total_collection_gap: 0,
      };
    acc.claim_count += count;
    acc.total_charge += charge;
    acc.total_allowed += allowed;
    acc.total_paid += paid;
    byPayer.set(key, acc);
  }

  const by_payer: PayerGapRow[] = [...byPayer.values()].map((r) => ({
    ...r,
    total_write_down: r.total_charge - r.total_allowed,
    total_collection_gap: r.total_charge - r.total_paid,
    avg_collection_rate: r.total_charge > 0 ? r.total_paid / r.total_charge : null,
  }));

  const anyMoney = by_payer.some((r) => r.total_charge !== 0 || r.total_paid !== 0);
  if (by_payer.length === 0 || !anyMoney) {
    throw new Error('CMD report mapping produced no payer totals (unverified field mapping?)');
  }

  const rows_analyzed = by_payer.reduce((n, r) => n + r.claim_count, 0);
  return { rows_analyzed, by_payer };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Per-payer gap for one calendar month, sourced from CMD (non-PHI summary).
 * Validates year/month, derives the [from, to] window, runs the report, and maps
 * the response to `PayerGapSummary`. Aggregation happens here, server-side; no
 * patient-level data ever leaves this function.
 */
export async function cmdPayerGapForMonth(
  year: number,
  month: number,
  cfg: CmdApiConfig,
): Promise<PayerGapSummary> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('year must be an integer in [2000, 2100]');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('month must be an integer in [1, 12]');
  }
  const from = `${year}-${pad2(month)}-01`;
  const to = `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
  const json = await cmdRunReport(cfg, { from, to });
  return mapCmdReportToPayerGap(json);
}
