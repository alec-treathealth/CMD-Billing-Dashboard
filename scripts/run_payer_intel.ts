/**
 * Monthly payer policy research worker. Invoked by .github/workflows/payer-intel.yml
 * (Vercel Cron is the scheduler; GitHub Actions is the worker — one key takes
 * minutes, which is past a serverless ceiling).
 *
 *   npx tsx scripts/run_payer_intel.ts                 # whole roster
 *   npx tsx scripts/run_payer_intel.ts optum cigna     # named keys
 *   DRY_RUN=1 npx tsx scripts/run_payer_intel.ts       # research, print, no DB write
 *
 * Each key is an independent unit of work with its own run row, and a failure in
 * one key never aborts the rest. Reads ANTHROPIC_API_KEY and, unless DRY_RUN,
 * INTEL_WRITER_DATABASE_URL from the environment. Neither is ever logged.
 *
 * PRECONDITION: `SQL Schemas/025_payer_policy_intel.sql` must be applied. A DB
 * preflight (src/intel/payer_policy/preflight.ts) asserts the intel schema and
 * intel_writer grants before the first API call, so an unapplied migration
 * costs one fast red run instead of the full research spend. DRY_RUN skips it —
 * dry runs never touch the DB.
 */

import https from 'node:https';
import { Pool } from 'pg';
import { assertIntelPreflight } from '../src/intel/payer_policy/preflight.js';
import { ROSTER, rosterEntry, rosterKeys } from '../src/intel/payer_policy/roster.js';
import { runOnePayer } from '../src/intel/payer_policy/run.js';
import { PAYER_POLICY_SYSTEM_PROMPT, DEFAULT_FOCUS } from '../src/intel/payer_policy/systemPrompt.js';
import type { MessagesTransport } from '../src/intel/payer_policy/client.js';
import type { Queryable } from '../src/intel/payer_policy/upsert.js';

/**
 * node:https, not fetch: a research turn routinely exceeds undici's 300s headers
 * timeout (UND_ERR_HEADERS_TIMEOUT) and `undici` is not resolvable here to
 * override the dispatcher. Non-streaming on purpose — reassembling content blocks
 * from SSE deltas would jeopardise the byte-identical echo that pause_turn
 * continuation requires.
 */
function makeTransport(apiKey: string): MessagesTransport {
  return (payload) => {
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  };
}

/** Window is the trailing month ending today, matching the monthly cadence. */
function researchWindow(today: Date): { windowStart: string; windowEnd: string } {
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime());
  start.setUTCMonth(start.getUTCMonth() - 1);
  return { windowStart: start.toISOString().slice(0, 10), windowEnd: end };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY unset');
    process.exit(1);
  }
  const dryRun = ['1', 'true', 'yes'].includes((process.env.DRY_RUN ?? '').toLowerCase());

  const requested = process.argv.slice(2);
  const keys = requested.length ? requested : ROSTER.map((r) => r.key);
  for (const key of keys) {
    if (!rosterEntry(key)) {
      console.error(`Unknown payer key "${key}". One of: ${rosterKeys().join(', ')}`);
      process.exit(1);
    }
  }

  let pool: Pool | null = null;
  let db: Queryable | undefined;
  if (!dryRun) {
    const url = process.env.INTEL_WRITER_DATABASE_URL;
    if (!url) {
      console.error('INTEL_WRITER_DATABASE_URL unset (set DRY_RUN=1 to research without persisting)');
      process.exit(1);
    }
    // Supavisor transaction pooler (6543) forbids named prepared statements, so
    // only pool.query(sql, params) is used — never a named prepare.
    pool = new Pool({ connectionString: url, max: 2 });
    db = { query: (sql, params) => pool!.query(sql, params) };
    // Fail BEFORE the first API call: with 025 unapplied the roster researches
    // ~$40 / ~50 min and then fails every write. Also forces the lazy pool to
    // connect, so a bad credential surfaces here instead of after the spend.
    try {
      await assertIntelPreflight(db);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      await pool.end();
      process.exit(1);
    }
  }

  const { windowStart, windowEnd } = researchWindow(new Date());
  const transport = makeTransport(apiKey);
  const summary: Array<Record<string, unknown>> = [];

  console.log(`payer-intel: window ${windowStart} -> ${windowEnd}, ${keys.length} key(s), dryRun=${dryRun}`);

  for (const key of keys) {
    const started = Date.now();
    try {
      const result = await runOnePayer({
        payerKey: key,
        windowStart,
        windowEnd,
        focus: DEFAULT_FOCUS,
        systemPrompt: PAYER_POLICY_SYSTEM_PROMPT,
        transport,
        db,
      });
      summary.push({
        key,
        status: result.status,
        gate: result.failureGate,
        findings: result.research.payload?.findings.length ?? 0,
        retrieved: result.research.retrievedUrls.length,
        searches: result.research.searchRequests,
        fetches: result.research.fetchRequests,
        turns: result.research.turnCount,
        persisted: result.persisted,
        inserted: result.counts?.inserted ?? 0,
        unchanged: result.counts?.unchanged ?? 0,
        quarantined: result.counts?.quarantined ?? 0,
        cost_usd: result.costUsd,
        wall_s: Math.round(result.research.wallMs / 1000),
      });
      console.log(`  ${key}: ${result.status}${result.failureGate ? ` (${result.failureGate})` : ''} — ` +
        `${result.research.payload?.findings.length ?? 0} findings, ` +
        `${result.research.retrievedUrls.length} urls, $${result.costUsd.toFixed(4)}`);
      for (const failure of result.research.failures) console.log(`      FAILED -> ${failure}`);
    } catch (err) {
      // One key's crash must not take the roster down.
      const message = err instanceof Error ? err.message : String(err);
      summary.push({ key, status: 'error', error: message, wall_s: Math.round((Date.now() - started) / 1000) });
      console.error(`  ${key}: ERROR — ${message}`);
    }
  }

  await pool?.end();

  console.log('\n--- summary ---');
  console.log(JSON.stringify(summary, null, 2));
  const failed = summary.filter((s) => s.status !== 'ok');
  const totalCost = summary.reduce((sum, s) => sum + (Number(s.cost_usd) || 0), 0);
  console.log(`\n${summary.length - failed.length}/${summary.length} ok, $${totalCost.toFixed(2)} total`);
  // Non-zero exit so the Action surfaces red when any key failed a gate.
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
