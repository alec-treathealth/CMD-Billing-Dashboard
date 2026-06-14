/**
 * Google Sheets reader for collections workbooks. Reads STRUCTURED CELLS (never
 * CSV) so embedded commas in patient/employer/payer names can't shift columns —
 * the same correctness requirement as Phase 1. Returns every tab with its rows.
 */
import { google } from 'googleapis';
import type { getOAuthClient } from '../auth.js';
import type { Tab } from './shapes.js';

type Auth = Awaited<ReturnType<typeof getOAuthClient>>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True for Sheets API rate-limit / quota errors (HTTP 429). */
function isRateLimit(err: unknown): boolean {
  const e = err as { code?: number; status?: number; response?: { status?: number }; message?: string };
  if (e?.code === 429 || e?.status === 429 || e?.response?.status === 429) return true;
  return typeof e?.message === 'string' && /quota exceeded|rate limit|RESOURCE_EXHAUSTED/i.test(e.message);
}

/**
 * Retry on the per-minute read-quota limit with exponential backoff. The Sheets
 * API enforces ~per-minute read caps; a whole-folder load comfortably exceeds
 * them, so back off and continue rather than failing the run.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [3000, 8000, 15000, 30000, 60000]; // ~2 min of patience
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= delays.length) throw err;
      const wait = delays[attempt]!;
      console.log(`[collections] rate-limited on ${label}; backing off ${wait / 1000}s (attempt ${attempt + 1})…`);
      await sleep(wait);
    }
  }
}

/** List a spreadsheet's tab titles in their natural order. */
export async function listTabs(spreadsheetId: string, auth: Auth): Promise<string[]> {
  const api = google.sheets({ version: 'v4', auth });
  const meta = await withRetry(`listTabs ${spreadsheetId}`, () =>
    api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title))' }));
  return (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '').filter((t) => t !== '');
}

/** Read one tab as structured cells; rows[i] is sheet row (i+1). */
export async function readTab(spreadsheetId: string, title: string, auth: Auth): Promise<Tab> {
  const api = google.sheets({ version: 'v4', auth });
  const res = await withRetry(`readTab ${title}`, () =>
    api.spreadsheets.values.get({
      spreadsheetId,
      range: title,
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    }));
  const values = (res.data.values ?? []) as unknown[][];
  const rows = values.map((r) => (r ?? []).map((c) => (c == null ? '' : String(c))));
  return { title, rows };
}
