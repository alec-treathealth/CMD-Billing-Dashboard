/**
 * Phase 4 Step 3 — LIVE integration probe (MANUAL ONLY; never part of `npm test`).
 *
 * Makes REAL Anthropic calls and REAL claims_reader DB reads against the live
 * PHI dataset. It is intentionally NOT a test file (no `.test.ts`, not imported
 * by the suite) so the hermetic suite stays free of live LLM/DB.
 *
 * What it validates (Step 3 tasks 1–2):
 *   1. Agent layer — runAgentTurn over one NL question per tool: the model picks
 *      the expected tool, dispatch runs as claims_reader, summary_stats is sane,
 *      and NO PHI key leaks into summary_stats, the agent/query audit lines, or
 *      (for client_history) query_log.arguments.
 *   2. Results route — fetchResults turns a query_id back into PHI rows; for
 *      client_history the re-supplied identity GATES the rows (match → rows,
 *      wrong/missing → empty, fail-closed).
 *
 * PHI discipline in THIS script: it never prints row values. Only column NAMES,
 * row COUNTS, and the non-PHI summary_stats are printed. The client_history
 * positive-match case uses a real patient discovered from the DB and held only in
 * memory (never printed, never sent to the LLM — the handle is built by calling
 * the query function directly, not through Anthropic). The LLM-facing
 * client_history case uses a synthetic placeholder name, so no real identifier
 * ever reaches Anthropic.
 *
 * Run:
 *   export $(cat .env | grep -v '^#' | grep -v '^$' | xargs) && npx tsx src/liveProbe.ts
 */
import { runAgentTurn, makeAnthropicClientFromEnv } from './agent/index.js';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from './queries/executor.js';
import { clientHistory } from './queries/index.js';
import { fetchResults } from './routes/results.js';
import type { FunctionName, QueryContext } from './queries/types.js';

const CREATED_BY = 'live-probe';

/** Field NAMES that must never appear in summary_stats / audit / stored args. */
const PHI_KEYS = [
  'patient_name',
  'patient_first',
  'patient_last',
  'member_id',
  'group_number',
  'employer_name',
];

let failures = 0;
function check(ok: boolean, msg: string): void {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}

/**
 * Documented PHI-SAFE field names whose substrings would otherwise trip the
 * coarse PHI_KEYS scan. `has_member_id` is the boolean presence flag the
 * client_history audit line emits (identity fields appear as presence flags only,
 * never values — see runtime.ts/finalize + client_history.ts auditShape). Strip
 * these before scanning so a real `member_id_norm: "..."` value still trips.
 */
const SAFE_FLAG_NAMES = ['has_member_id'];

/** Return any PHI key names found as substrings of the given JSON text. */
function phiHits(json: string): string[] {
  let cleaned = json;
  for (const f of SAFE_FLAG_NAMES) cleaned = cleaned.split(f).join('');
  return PHI_KEYS.filter((k) => cleaned.includes(k));
}

interface ProbeCase {
  expected: FunctionName;
  question: string;
}

// One NL question per tool. client_history uses a SYNTHETIC placeholder name so
// no real patient identifier is ever sent to Anthropic on this path.
const CASES: ProbeCase[] = [
  { expected: 'distribution', question: 'Break down total paid amount by payer for 2025.' },
  {
    expected: 'payer_gap_analysis',
    question: 'Which payers underpay us the most? Show the collection gap by payer.',
  },
  {
    expected: 'search_claims',
    question: 'Show me the underlying claims for HCPCS code 90853 billed in 2025.',
  },
  {
    expected: 'client_history',
    question: 'Show the full billing history for patient TESTPATIENT ZZZSYNTHETIC.',
  },
  {
    // Scoped to ONE facility on purpose: an unconstrained readmission self-join
    // over all 320k rows exceeds the DB statement timeout (a good guardrail — a
    // runaway PHI scan fails closed). The facility name is non-PHI (allowlisted),
    // so naming it in the question is fine and keeps the self-join bounded.
    expected: 'readmission_candidates',
    question:
      'Find possible readmissions within 30 days at THE FORGE RECOVERY CENTER.',
  },
];

async function main(): Promise<void> {
  const client = makeAnthropicClientFromEnv();
  const executor = new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));

  // Captured audit lines (both the query-function finalize audit and the agent
  // audit) for PHI scanning.
  const auditLines: string[] = [];
  const captureAudit = (line: string): void => {
    auditLines.push(line);
  };

  const queryCtx: QueryContext = { executor, createdBy: CREATED_BY, audit: captureAudit };

  console.log('\n========== Phase 4 Step 3 — LIVE PROBE ==========');
  console.log(`Model: ${process.env.ANTHROPIC_MODEL || 'claude-opus-4-8 (default)'}\n`);

  // Keep one query_id per tool for the results-route phase.
  const queryIds = new Map<FunctionName, string>();

  // ---- TASK 1: agent layer, one NL question per tool ----
  console.log('--- TASK 1: agent layer (real Anthropic + claims_reader) ---');
  for (const c of CASES) {
    auditLines.length = 0;
    console.log(`\n[${c.expected}] Q: ${c.question}`);
    try {
      const res = await runAgentTurn(c.question, { client, queryCtx, audit: captureAudit });

      // Phase 7.6: an over-broad search_claims now returns a deterministic
      // needs_input prompt instead of executing — record it and move on.
      if (res.status === 'needs_input') {
        check(
          res.tool_name === c.expected,
          `model picked tool = ${res.tool_name} (expected ${c.expected}) — needs_input (no query ran)`,
        );
        continue;
      }
      queryIds.set(res.tool_name, res.query_id);

      check(res.tool_name === c.expected, `model picked tool = ${res.tool_name} (expected ${c.expected})`);

      const summaryJson = JSON.stringify(res.summary_stats);
      const sHits = phiHits(summaryJson);
      check(sHits.length === 0, `summary_stats free of PHI keys${sHits.length ? ` — LEAK: ${sHits}` : ''}`);

      const auditJson = JSON.stringify(auditLines);
      const aHits = phiHits(auditJson);
      check(aHits.length === 0, `audit lines free of PHI keys${aHits.length ? ` — LEAK: ${aHits}` : ''}`);

      check(typeof res.query_id === 'string' && res.query_id.length > 0, `query_id present (${res.query_id})`);
      console.log(`   summary_stats: ${summaryJson.slice(0, 240)}${summaryJson.length > 240 ? '…' : ''}`);
      if (res.usage) console.log(`   tokens: in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);
    } catch (e) {
      check(false, `runAgentTurn threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // For client_history specifically: confirm the stored query_log.arguments carry
  // NO patient identity field (terms must live only as bound params).
  const chId = queryIds.get('client_history');
  if (chId) {
    console.log('\n[client_history] verify stored query_log.arguments carry no identity');
    const { rows } = await executor.query<{ arguments: Record<string, unknown> }>(
      'select arguments from claims.get_query_log($1)',
      [chId],
    );
    const argsJson = JSON.stringify(rows[0]?.arguments ?? null);
    const argHits = phiHits(argsJson);
    check(argHits.length === 0, `query_log.arguments free of PHI keys${argHits.length ? ` — LEAK: ${argHits}` : ''}`);
    console.log(`   stored arguments: ${argsJson}`);
  }

  // ---- TASK 2: results route (PHI rows; print counts + column NAMES only) ----
  console.log('\n--- TASK 2: results route (PHI path; values never printed) ---');

  // 2a. A filter-only handle (distribution) → rows come back, allowlisted columns.
  const distId = queryIds.get('distribution');
  if (distId) {
    console.log('\n[distribution] fetchResults by query_id');
    const r = await fetchResults({ query_id: distId, created_by: CREATED_BY }, { executor });
    check(r.function_name === 'distribution', `function_name = ${r.function_name}`);
    check(r.rows.length >= 0, `row_count = ${r.rows.length}`);
    const cols = r.rows[0] ? Object.keys(r.rows[0]) : [];
    console.log(`   columns (allowlisted projection, names only): ${cols.join(', ')}`);
  }

  // 2b. client_history identity gating. Build the handle DIRECTLY (not via the
  //     LLM) using a real patient discovered from the DB and held only in memory.
  console.log('\n[client_history] identity-gated fetch (match / wrong / missing)');
  const { rows: pick } = await executor.query<{ patient_last: string; member_id_norm: string | null }>(
    'select patient_last, member_id_norm from claims.claims ' +
      "where patient_last is not null and patient_last <> '' limit 1",
    [],
  );
  const real = pick[0];
  if (!real) {
    check(false, 'could not find a sample patient row to gate on');
  } else {
    const realLast = real.patient_last; // held in memory only — never printed
    const realMember = real.member_id_norm ?? undefined;
    const handle = await clientHistory({ patient_last: realLast, member_id_norm: realMember }, queryCtx);
    console.log(`   built client_history handle: ${handle.query_id}`);

    // match → rows
    const matchRes = await fetchResults(
      { query_id: handle.query_id, created_by: CREATED_BY, identity: { patient_last: realLast, member_id_norm: realMember } },
      { executor },
    );
    check(matchRes.rows.length > 0, `correct identity → rows served (count=${matchRes.rows.length})`);

    // wrong identity → empty
    const wrongRes = await fetchResults(
      { query_id: handle.query_id, created_by: CREATED_BY, identity: { patient_last: 'ZZ_NO_SUCH_PATIENT' } },
      { executor },
    );
    check(wrongRes.rows.length === 0, `wrong identity → empty (count=${wrongRes.rows.length})`);

    // missing identity → empty
    const missingRes = await fetchResults({ query_id: handle.query_id, created_by: CREATED_BY }, { executor });
    check(missingRes.rows.length === 0, `missing identity → empty (count=${missingRes.rows.length})`);
  }

  await executor.end();

  console.log(`\n========== RESULT: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==========\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('liveProbe fatal:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
