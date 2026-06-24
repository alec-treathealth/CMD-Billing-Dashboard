/**
 * One-off CMD Web API probe — run BEFORE trusting src/collections/cmdPayer.ts.
 *
 *   npm run probe:cmd            # current 2026 month (or set CMD_PROBE_MONTH=5)
 *
 * Purpose: reveal the report-run response SHAPE so the mapping in cmdPayer.ts can
 * be reconciled with reality (this agent environment has no CMD credentials, so
 * the mapping there is an unverified assumption).
 *
 * PHI SAFETY: this prints STRUCTURE ONLY — top-level type, object keys, array
 * lengths, and the key set of the first row. It never prints field VALUES, so no
 * patient-level data is emitted. If you must inspect values, do so in a trusted
 * terminal and never paste them anywhere. Credentials are read from env and never
 * printed.
 *
 * Credentials (env only): CMD_API_TOKEN, or CMD_USERNAME + CMD_PASSWORD. Optional
 * overrides: CMD_API_BASE_URL, CMD_CUSTOMER_ID, CMD_REPORT_ID, CMD_FILTER_ID.
 */
import { cmdRunReport, type CmdApiConfig } from './cmdPayer.js';

function configFromEnv(): CmdApiConfig {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdApiConfig['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else {
    throw new Error(
      'CMD credentials not set. Provide CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD, in your env.',
    );
  }
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId: process.env.CMD_CUSTOMER_ID?.trim() || '10027973',
    reportId: process.env.CMD_REPORT_ID?.trim() || '10091729',
    filterId: process.env.CMD_FILTER_ID?.trim() || '10147241',
    auth,
  };
}

/** Print structure (keys/types/lengths) only — never values (PHI-safe). */
function describe(label: string, value: unknown, depth = 0): void {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) {
    console.log(`${indent}${label}: Array(${value.length})`);
    const first = value[0];
    if (first && typeof first === 'object') {
      console.log(`${indent}  [0] keys: ${Object.keys(first as object).join(', ')}`);
    } else if (value.length > 0) {
      console.log(`${indent}  [0] type: ${typeof first}`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object);
    console.log(`${indent}${label}: object { ${keys.join(', ')} }`);
    if (depth < 2) {
      for (const k of keys) describe(k, (value as Record<string, unknown>)[k], depth + 1);
    }
    return;
  }
  console.log(`${indent}${label}: ${typeof value}`);
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const now = new Date();
  const month = Number(process.env.CMD_PROBE_MONTH) || (now.getUTCFullYear() === 2026 ? now.getUTCMonth() + 1 : 5);
  const year = 2026;
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  console.log(`Probing CMD report ${cfg.reportId}/filter ${cfg.filterId} for ${from}..${to}`);
  const json = await cmdRunReport(cfg, { from, to });
  console.log('--- response shape (structure only; no values) ---');
  describe('root', json);
  console.log('--- end ---');
}

main().catch((err) => {
  // Status/message only — cmdRunReport never includes the body, so this is PHI-safe.
  console.error('CMD probe failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
