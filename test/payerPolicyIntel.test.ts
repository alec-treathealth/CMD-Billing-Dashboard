import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROSTER, matchesAnyDomain, matchesDomainEntry, registrableDomain, rosterEntry,
} from '../src/intel/payer_policy/roster.js';
import {
  MODEL, TURN_BUDGET, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, buildTools, harvestBlocks,
  researchPayer, type MessagesTransport,
} from '../src/intel/payer_policy/client.js';
import {
  UPSERT_FINDING_SQL, deriveSourceTier, findingHash, normalizeDate, resolveFinding,
  resolveStatus, shouldUpdateFinding, upsertRunResults, type Queryable,
} from '../src/intel/payer_policy/upsert.js';
import { estimateCostUsd, failureGateOf, runOnePayer } from '../src/intel/payer_policy/run.js';
import type { EmitFindingsPayload, RawFinding } from '../src/intel/payer_policy/types.js';

/**
 * Hermetic tests for payer policy intelligence ingest. No network, no database,
 * no LLM. Every API response is a fixture; the DB is a recording fake.
 *
 * Fixtures contain NO PHI — this pipeline reads public payer bulletins and CMS
 * documents only. URLs below are real-shaped but the content is invented.
 */

const SYSTEM = 'test system prompt';
const WINDOW = { windowStart: '2026-07-03', windowEnd: '2026-08-03' };
const FOCUS = 'test focus';

// --- fixture helpers -------------------------------------------------------

const OPTUM_URL = 'https://public.providerexpress.com/content/ope-provexpr/us/en/clinical-resources/guidelines-policies/reimbursement-policies.html';
const OPTUM_PDF = 'https://public.providerexpress.com/content/dam/ope-provexpr/us/pdfs/reimb.pdf';

function rawFinding(over: Partial<RawFinding> = {}): RawFinding {
  return {
    payer_plan: 'Optum Behavioral Health — commercial',
    change_type: 'reimbursement',
    originator: 'payer',
    summary: 'Per-diem logic revised for SUD IOP.',
    codes_affected: ['H0015', '0906'],
    scope: 'unclear',
    self_funded_relevant: true,
    date_published: '2026-07-15',
    date_approved: '2026-07-01',
    date_effective: '2026-10-01',
    source_url: OPTUM_URL,
    source_domain: 'providerexpress.com',
    confidence: 'confirmed',
    embed_text: 'Optum revised SUD IOP per-diem logic for H0015 and revenue code 0906, published 2026-07-15, effective 2026-10-01.',
    ...over,
  };
}

function searchResultBlock(urls: string[]) {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: urls.map((url) => ({
      type: 'web_search_result', url, title: 'T', encrypted_content: 'enc', page_age: '1 day ago',
    })),
  };
}

/** Errors come back HTTP 200 with content as a single OBJECT, not a list. */
function searchErrorBlock(errorCode: string) {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_err',
    content: { type: 'web_search_tool_result_error', error_code: errorCode },
  };
}

function emitBlock(payload: EmitFindingsPayload) {
  return { type: 'tool_use', id: 'toolu_emit', name: 'emit_findings', input: payload };
}

function usage(over: Record<string, unknown> = {}) {
  return {
    input_tokens: 1000, output_tokens: 100,
    output_tokens_details: { thinking_tokens: 10 },
    service_tier: 'standard', inference_geo: 'global',
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
    ...over,
  };
}

/** Returns a transport that replays the given messages in order, and records the
 *  requests it was given so continuation behaviour can be asserted.
 *
 *  Each request is SNAPSHOT, not stored by reference: the loop mutates one
 *  `messages` array in place, so a stored reference would have every recorded
 *  request pointing at the final state and the byte-identical assertions below
 *  would silently pass against the wrong thing. A JSON round-trip is also exactly
 *  what the real transport does at this boundary, so the snapshot is faithful. */
function scriptedTransport(replies: Array<Record<string, unknown>>) {
  const requests: Array<Record<string, any>> = [];
  const transport: MessagesTransport = async (payload) => {
    requests.push(JSON.parse(JSON.stringify(payload)) as Record<string, any>);
    const next = replies[Math.min(requests.length - 1, replies.length - 1)];
    return { status: 200, body: JSON.stringify(next) };
  };
  return { transport, requests };
}

function recordingDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const existing = new Map<string, { source_url: string; date_effective: string | null }>();
  const db: Queryable = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (!sql.includes('payer_policy_finding')) return { rowCount: 1, rows: [] };
      const hash = String(params[0]);
      const incoming = { source_url: String(params[13]), date_effective: (params[12] ?? null) as string | null };
      const prior = existing.get(hash);
      if (!prior) {
        existing.set(hash, incoming);
        return { rowCount: 1, rows: [{ inserted: true }] };
      }
      // Mirrors the guarded ON CONFLICT WHERE clause.
      if (shouldUpdateFinding(prior, incoming)) {
        existing.set(hash, incoming);
        return { rowCount: 1, rows: [{ inserted: false }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return { db, calls, existing };
}

// --- roster / domain semantics ---------------------------------------------

test('roster couples payer scope to its own domains only — no federal bleed', () => {
  for (const entry of ROSTER) {
    assert.ok(entry.domains.length > 0, `${entry.key} has domains`);
    if (entry.key !== 'federal' && entry.key !== 'codesets') {
      for (const d of entry.domains) {
        assert.ok(
          !['cms.gov', 'federalregister.gov', 'ama-assn.org', 'nubc.org'].includes(d),
          `${entry.key} must not carry federal domain ${d}`,
        );
      }
    }
  }
  assert.deepEqual(rosterEntry('federal')?.domains, ['cms.gov', 'federalregister.gov']);
  assert.deepEqual(rosterEntry('codesets')?.domains, ['ama-assn.org', 'nubc.org']);
});

test('bare domain matches subdomains; path-scoped entry requires the path', () => {
  assert.ok(matchesDomainEntry('https://providernews.anthem.com/ohio', 'providernews.anthem.com'));
  assert.ok(matchesDomainEntry('https://a.b.cms.gov/x', 'cms.gov'));
  // The parent-domain trap the roster comment warns about.
  assert.ok(!matchesDomainEntry('https://www.anthem.com/find-care', 'providernews.anthem.com'));
  // providernewsroom.com/evernorth must not admit the rest of providernewsroom.com.
  assert.ok(matchesDomainEntry('https://providernewsroom.com/evernorth/x', 'providernewsroom.com/evernorth'));
  assert.ok(!matchesDomainEntry('https://providernewsroom.com/anthem/x', 'providernewsroom.com/evernorth'));
  // Non-http schemes are rejected outright.
  assert.ok(!matchesDomainEntry('javascript:alert(1)', 'cms.gov'));
  assert.ok(!matchesDomainEntry('not a url', 'cms.gov'));
});

test('a trailing-dot FQDN is the same host — regression, this failed a live run', () => {
  // Observed 2026-08-03: web_search returned `https://www.uhcprovider.com./` once in
  // 106 URLs. `new URL().hostname` keeps the trailing root-label dot, so the host
  // compared unequal to `uhcprovider.com` and Gate D marked a healthy run FAILED.
  const entry = rosterEntry('optum')!;
  assert.ok(matchesAnyDomain('https://www.uhcprovider.com./', entry.domains));
  assert.ok(matchesDomainEntry('https://www.uhcprovider.com./', 'uhcprovider.com'));
  assert.ok(matchesDomainEntry('https://uhcprovider.com./x', 'uhcprovider.com'));
  // Grouping was also affected — it bucketed this URL under "com.".
  assert.equal(registrableDomain('www.uhcprovider.com.'), 'uhcprovider.com');
  // Normalization must not open the allow-list: a foreign host with a trailing dot
  // is still foreign.
  assert.ok(!matchesAnyDomain('https://www.cigna.com./', entry.domains));
  assert.ok(!matchesDomainEntry('https://evil-uhcprovider.com./', 'uhcprovider.com'));
});

test('registrableDomain collapses subdomains and handles multipart suffixes', () => {
  assert.equal(registrableDomain('public.providerexpress.com'), 'providerexpress.com');
  assert.equal(registrableDomain('www.cms.gov'), 'cms.gov');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
});

// --- tool wiring -----------------------------------------------------------

test('tools declare web_search + web_fetch on the SAME domain map, and no code_execution', () => {
  const entry = rosterEntry('optum')!;
  const tools = buildTools(entry) as Array<Record<string, any>>;
  const search = tools.find((t) => t.name === 'web_search')!;
  const fetch = tools.find((t) => t.name === 'web_fetch')!;
  assert.equal(search.type, WEB_SEARCH_TOOL);
  assert.equal(fetch.type, WEB_FETCH_TOOL);
  // 'full', not 'excluded' — 'excluded' removes the blocks the provenance gate reads.
  assert.equal(search.response_inclusion, 'full');
  assert.equal(fetch.response_inclusion, 'full');
  // A fetch must not be able to escape the payer's scope.
  assert.deepEqual(fetch.allowed_domains, search.allowed_domains);
  assert.deepEqual(search.allowed_domains, entry.domains);
  assert.ok(!tools.some((t) => String(t.type ?? '').startsWith('code_execution')));
  // emit_findings must be strict, and must NOT ask the model for source_tier.
  const emit = tools.find((t) => t.name === 'emit_findings')! as any;
  assert.equal(emit.strict, true);
  assert.ok(!('source_tier' in emit.input_schema.properties.findings.items.properties));
  assert.ok('date_published' in emit.input_schema.properties.findings.items.properties);
  assert.ok('reason_code' in emit.input_schema.properties.unreachable.items.properties);
});

// --- (a) clean findings ----------------------------------------------------

test('(a) clean run: findings resolved, provenance passes, run is ok', async () => {
  const payload: EmitFindingsPayload = {
    findings: [rawFinding()],
    checked_no_change: ['Provider Express reimbursement index'],
    unreachable: [{ payer: 'Optum', reason_code: 'login_gated', reason: 'Availity SSO', url: 'none' }],
  };
  const { transport } = scriptedTransport([
    {
      stop_reason: 'tool_use', model: MODEL, container: { id: 'container_abc' },
      usage: usage(), content: [searchResultBlock([OPTUM_URL]), emitBlock(payload)],
    },
    { stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: {} }), content: [] },
  ]);

  const res = await runOnePayer({
    payerKey: 'optum', ...WINDOW, focus: FOCUS, systemPrompt: SYSTEM, transport,
  });

  assert.equal(res.status, 'ok');
  assert.equal(res.failureGate, null);
  assert.deepEqual(res.research.failures, []);
  assert.equal(res.research.payload?.findings.length, 1);
  assert.equal(res.research.retrievedUrls.length, 1);
  assert.equal(res.research.fetchRequests, 1);
  assert.ok(res.costUsd > 0);
});

test('(a) resolveFinding derives source_tier and normalizes "unknown" dates to null', () => {
  const entry = rosterEntry('optum')!;
  const resolved = resolveFinding(
    rawFinding({ date_approved: 'unknown', date_effective: 'unknown', date_published: '2026-07-15' }),
    'optum', entry.domains, new Set([OPTUM_URL]),
  );
  assert.equal(resolved.source_tier, 'primary');
  assert.equal(resolved.date_approved, null);
  assert.equal(resolved.date_effective, null);
  assert.equal(resolved.date_published, '2026-07-15');
  assert.equal(resolved.status, 'confirmed');
});

test('source_tier is derived, not trusted: an off-map URL resolves to secondary', () => {
  const entry = rosterEntry('optum')!;
  assert.equal(deriveSourceTier(OPTUM_URL, entry.domains), 'primary');
  assert.equal(deriveSourceTier('https://behavioralhealthbusiness.com/post', entry.domains), 'secondary');
});

test('normalizeDate rejects sentinels and junk, keeps ISO', () => {
  assert.equal(normalizeDate('2026-07-15'), '2026-07-15');
  assert.equal(normalizeDate('unknown'), null);
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('July 2026'), null);
  assert.equal(normalizeDate(undefined), null);
});

// --- provenance gate -------------------------------------------------------

test('a source_url absent from the retrieved set is QUARANTINED, not stored as confirmed', () => {
  const entry = rosterEntry('optum')!;
  const hallucinated = rawFinding({ source_url: 'https://public.providerexpress.com/invented-page.html' });
  assert.equal(resolveStatus(hallucinated, new Set([OPTUM_URL])), 'quarantined');
  const resolved = resolveFinding(hallucinated, 'optum', entry.domains, new Set([OPTUM_URL]));
  assert.equal(resolved.status, 'quarantined');
  // Quarantine is about provenance, not the model's own confidence.
  assert.equal(resolved.confidence, 'confirmed');
});

test('confidence and status are orthogonal — a retrieved needs_verification stays needs_verification', () => {
  const entry = rosterEntry('optum')!;
  const resolved = resolveFinding(
    rawFinding({ confidence: 'needs_verification' }), 'optum', entry.domains, new Set([OPTUM_URL]),
  );
  assert.equal(resolved.status, 'needs_verification');
  assert.equal(resolved.confidence, 'needs_verification');
});

test('a FETCHED url counts as retrieved, so a fetch-sourced finding is not quarantined', () => {
  const harvested = harvestBlocks([
    {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srvtoolu_f',
      content: {
        type: 'web_fetch_result', url: OPTUM_PDF,
        content: { type: 'document', title: 'Reimbursement Policy' },
        retrieved_at: '2026-08-03T10:00:00Z',
      },
    },
  ]);
  assert.deepEqual(harvested.urls, [OPTUM_PDF]);
  assert.equal(resolveStatus(rawFinding({ source_url: OPTUM_PDF }), new Set(harvested.urls)), 'confirmed');
});

// --- (b) pause_turn continuation ------------------------------------------

test('(b) pause_turn resends assistant content byte-identical and reattaches the container', async () => {
  const thinking = { type: 'thinking', thinking: 'deliberating', signature: 'sig-abc' };
  const serverToolUse = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } };
  const searchBlock = searchResultBlock([OPTUM_URL]);
  const pausedContent = [thinking, serverToolUse, searchBlock];

  const { transport, requests } = scriptedTransport([
    { stop_reason: 'pause_turn', model: MODEL, container: { id: 'container_xyz' }, usage: usage(), content: pausedContent },
    {
      stop_reason: 'tool_use', model: MODEL, container: { id: 'container_xyz' }, usage: usage({ server_tool_use: {} }),
      content: [emitBlock({ findings: [rawFinding()], checked_no_change: [], unreachable: [] })],
    },
    { stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: {} }), content: [] },
  ]);

  const res = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);

  assert.equal(res.turnCount, 3);
  assert.deepEqual(res.failures, []);
  // Turn 2 echoed the paused content unchanged, including the thinking block and
  // the encrypted_content — anything else 400s.
  const echoed = requests[1]!.messages.at(-1);
  assert.equal(echoed.role, 'assistant');
  assert.deepEqual(echoed.content, pausedContent);
  assert.equal(echoed.content[0].signature, 'sig-abc');
  assert.equal(echoed.content[2].content[0].encrypted_content, 'enc');
  // Container reattached from turn 2 onwards, else the API 400s on pending
  // code-execution tool uses.
  assert.equal(requests[0]!.container, undefined);
  assert.equal(requests[1]!.container, 'container_xyz');
  assert.equal(requests[2]!.container, 'container_xyz');
});

test('tool_use continuation returns a tool_result for every client tool_use block', async () => {
  const { transport, requests } = scriptedTransport([
    {
      stop_reason: 'tool_use', model: MODEL, container: { id: 'c1' }, usage: usage(),
      content: [searchResultBlock([OPTUM_URL]), emitBlock({ findings: [], checked_no_change: ['x'], unreachable: [] })],
    },
    { stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: {} }), content: [] },
  ]);
  await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);
  const followUp = requests[1]!.messages.at(-1);
  assert.equal(followUp.role, 'user');
  assert.equal(followUp.content[0].type, 'tool_result');
  assert.equal(followUp.content[0].tool_use_id, 'toolu_emit');
});

// --- (c) all searches errored ---------------------------------------------

test('(c) all-searches-errored run is FAILED and writes ZERO finding rows', async () => {
  // HTTP 200 throughout — the error lives in the body, which is the trap.
  const { transport } = scriptedTransport([
    {
      stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: { web_search_requests: 0 } }),
      content: [searchErrorBlock('max_uses_exceeded'), searchErrorBlock('unavailable')],
    },
  ]);
  const fake = recordingDb();

  const res = await runOnePayer({
    payerKey: 'optum', ...WINDOW, focus: FOCUS, systemPrompt: SYSTEM, transport, db: fake.db,
  });

  assert.equal(res.status, 'failed');
  assert.equal(res.persisted, false);
  assert.equal(res.counts, null);
  // Zero writes of any kind.
  assert.equal(fake.calls.length, 0);
  // Emit-never-called and zero-search both fire; either alone would catch it,
  // which matters because error blocks may never surface under dynamic filtering.
  assert.ok(res.research.failures.some((f) => f.startsWith('GATE A')));
  assert.ok(res.research.failures.some((f) => f.startsWith('GATE B')));
  assert.deepEqual(res.research.toolErrors, ['web_search:max_uses_exceeded', 'web_search:unavailable']);
});

test('end_turn WITHOUT emit_findings is FAILED, not "no findings"', async () => {
  const { transport } = scriptedTransport([
    {
      stop_reason: 'end_turn', model: MODEL, usage: usage(),
      content: [searchResultBlock([OPTUM_URL]), { type: 'text', text: 'I found nothing of note.' }],
    },
  ]);
  const res = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);
  assert.ok(res.failures.some((f) => f.startsWith('GATE A')));
  assert.equal(failureGateOf(res), 'GATE A');
  assert.equal(res.payload, null);
});

test('GATE D fails a run whose retrieval escaped the key domains, or returned nothing', async () => {
  const foreign = 'https://www.cigna.com/reimbursement';
  const { transport } = scriptedTransport([
    {
      stop_reason: 'tool_use', model: MODEL, container: { id: 'c' }, usage: usage(),
      content: [searchResultBlock([foreign]), emitBlock({ findings: [], checked_no_change: [], unreachable: [] })],
    },
    { stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: {} }), content: [] },
  ]);
  const res = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);
  assert.ok(res.failures.some((f) => f.startsWith('GATE D')), 'cross-payer URL must fail gate D');

  const empty = scriptedTransport([
    {
      stop_reason: 'tool_use', model: MODEL, container: { id: 'c' }, usage: usage(),
      content: [emitBlock({ findings: [], checked_no_change: [], unreachable: [] })],
    },
    { stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: {} }), content: [] },
  ]);
  const res2 = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport: empty.transport }, SYSTEM);
  assert.ok(res2.failures.some((f) => f.includes('zero retrieved URLs')));
});

test('GATE E fails a max_tokens run — a truncated strict-tool input is not a payload', async () => {
  const { transport } = scriptedTransport([
    {
      stop_reason: 'max_tokens', model: MODEL, usage: usage(),
      content: [searchResultBlock([OPTUM_URL]), emitBlock({ findings: [rawFinding()], checked_no_change: [], unreachable: [] })],
    },
  ]);
  const fake = recordingDb();
  const res = await runOnePayer({
    payerKey: 'optum', ...WINDOW, focus: FOCUS, systemPrompt: SYSTEM, transport, db: fake.db,
  });
  assert.equal(res.status, 'failed');
  assert.ok(res.research.failures.some((f) => f.startsWith('GATE E')));
  // Even though findings parsed, nothing is written from a truncated run.
  assert.equal(fake.calls.length, 0);
});

test('turn budget is enforced rather than looping forever', async () => {
  // Always pause_turn: without a budget this never terminates.
  const { transport, requests } = scriptedTransport([
    { stop_reason: 'pause_turn', model: MODEL, container: { id: 'c' }, usage: usage(), content: [searchResultBlock([OPTUM_URL])] },
  ]);
  const res = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);
  assert.equal(res.turnCount, TURN_BUDGET);
  assert.equal(requests.length, TURN_BUDGET);
  assert.ok(res.failures.some((f) => f.includes('TURN BUDGET')));
});

test('a non-200 is recorded as a TRANSPORT failure, not thrown', async () => {
  const transport: MessagesTransport = async () => ({
    status: 400,
    body: JSON.stringify({ error: { message: 'container_id is required when there are pending tool uses' } }),
  });
  const res = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);
  assert.ok(res.failures[0]?.startsWith('TRANSPORT'));
  assert.ok(res.failures[0]?.includes('container_id is required'));
});

// --- (d) idempotency ------------------------------------------------------

test('(d) re-running identical input is a TRUE no-op — zero new rows', async () => {
  const entry = rosterEntry('optum')!;
  const payload: EmitFindingsPayload = {
    findings: [rawFinding(), rawFinding({ change_type: 'prior_auth', summary: 'PA removed.' })],
    checked_no_change: [], unreachable: [],
  };
  const fake = recordingDb();
  const args = {
    runId: null, payerKey: 'optum', allowedDomains: entry.domains,
    retrievedUrls: [OPTUM_URL], payload,
  };

  const first = await upsertRunResults(fake.db, args);
  assert.equal(first.inserted, 2);
  assert.equal(first.unchanged, 0);

  const second = await upsertRunResults(fake.db, args);
  assert.equal(second.inserted, 0, 'no new rows on re-run');
  assert.equal(second.updated, 0, 'nothing updated on re-run');
  assert.equal(second.unchanged, 2, 'both findings recognised as already present');
});

test('(d) the ON CONFLICT is guarded so an unchanged finding does not even churn', () => {
  assert.ok(UPSERT_FINDING_SQL.includes('ON CONFLICT (finding_hash) DO UPDATE'));
  assert.ok(UPSERT_FINDING_SQL.includes('source_url IS DISTINCT FROM EXCLUDED.source_url'));
  assert.ok(UPSERT_FINDING_SQL.includes('date_effective IS DISTINCT FROM EXCLUDED.date_effective'));
  // embedding must stay out of the write path: BGE-M3 fills it separately.
  assert.ok(!UPSERT_FINDING_SQL.includes('embedding'));
  // Explicit columns, never SELECT *.
  assert.ok(!UPSERT_FINDING_SQL.includes('*'));
});

test('shouldUpdateFinding fires only on source_url or date_effective', () => {
  const base = { source_url: OPTUM_URL, date_effective: '2026-10-01' };
  assert.equal(shouldUpdateFinding(base, { ...base }), false);
  assert.equal(shouldUpdateFinding(base, { ...base, source_url: OPTUM_PDF }), true);
  assert.equal(shouldUpdateFinding(base, { ...base, date_effective: '2026-11-01' }), true);
  assert.equal(shouldUpdateFinding(base, { ...base, date_effective: null }), true);
});

test('finding_hash separates two findings sharing a source_url but differing on change_type', () => {
  // This is the real shape observed in the first batch: two CY2027 OPPS findings
  // off one Federal Register URL.
  const a = rawFinding({ change_type: 'reimbursement' });
  const b = rawFinding({ change_type: 'transparency' });
  assert.notEqual(findingHash(a), findingHash(b));
  assert.equal(findingHash(a), findingHash(rawFinding({ change_type: 'reimbursement' })));
  // 'unknown' and '' must not hash apart for the same finding.
  assert.equal(
    findingHash(rawFinding({ date_effective: 'unknown' })),
    findingHash(rawFinding({ date_effective: '' })),
  );
});

// --- invariant: no_change / unreachable never become findings -------------

test('no_change and unreachable go ONLY to run_check, never to findings', async () => {
  const entry = rosterEntry('optum')!;
  const fake = recordingDb();
  await upsertRunResults(fake.db, {
    runId: '00000000-0000-0000-0000-000000000001',
    payerKey: 'optum',
    allowedDomains: entry.domains,
    retrievedUrls: [OPTUM_URL],
    payload: {
      findings: [],
      checked_no_change: ['Provider Express index', 'National Network Manual'],
      unreachable: [
        { payer: 'Optum', reason_code: 'login_gated', reason: 'Availity SSO', url: 'none' },
        { payer: 'Optum', reason_code: 'budget_exhausted', reason: 'ran out', url: OPTUM_PDF },
      ],
    },
  });

  const findingWrites = fake.calls.filter((c) => c.sql.includes('payer_policy_finding'));
  const checkWrites = fake.calls.filter((c) => c.sql.includes('payer_policy_run_check'));
  assert.equal(findingWrites.length, 0, 'no_change/unreachable must never write a finding row');
  assert.equal(checkWrites.length, 4);
  assert.deepEqual(checkWrites.map((c) => c.params[2]), ['no_change', 'no_change', 'unreachable', 'unreachable']);
  // reason_code is preserved so budget_exhausted (retryable) stays distinguishable
  // from login_gated (permanent).
  assert.deepEqual(checkWrites.slice(2).map((c) => c.params[3]), ['login_gated', 'budget_exhausted']);
  // 'none' becomes NULL rather than a sentinel string.
  assert.equal(checkWrites[2]!.params[5], null);
});

// --- cost / misc ---------------------------------------------------------

test('estimateCostUsd sums tokens across turns plus per-search charge', () => {
  const cost = estimateCostUsd({
    usages: [
      { input_tokens: 1_000_000, output_tokens: 0 },
      { input_tokens: 0, output_tokens: 100_000 },
    ],
    searchRequests: 10,
  } as never);
  // 1M input @ $5 + 100k output @ $25/M = $2.50 + 10 searches @ $0.01
  assert.equal(cost, 5 + 2.5 + 0.1);
});

test('unknown payer key throws before any transport call', async () => {
  let called = false;
  const transport: MessagesTransport = async () => { called = true; return { status: 200, body: '{}' }; };
  await assert.rejects(
    () => runOnePayer({ payerKey: 'nope', ...WINDOW, focus: FOCUS, systemPrompt: SYSTEM, transport }),
    /Unknown payer key/,
  );
  assert.equal(called, false);
});

test('emit_findings called twice is unioned and flagged, not an error', async () => {
  const { transport } = scriptedTransport([
    {
      stop_reason: 'tool_use', model: MODEL, container: { id: 'c' }, usage: usage(),
      content: [
        searchResultBlock([OPTUM_URL]),
        emitBlock({ findings: [rawFinding()], checked_no_change: [], unreachable: [] }),
        { type: 'tool_use', id: 'toolu_emit2', name: 'emit_findings', input: { findings: [rawFinding({ change_type: 'coverage' })], checked_no_change: [], unreachable: [] } },
      ],
    },
    { stop_reason: 'end_turn', model: MODEL, usage: usage({ server_tool_use: {} }), content: [] },
  ]);
  const res = await researchPayer({ payerKey: 'optum', ...WINDOW, focus: FOCUS, transport }, SYSTEM);
  assert.equal(res.emitCallCount, 2);
  assert.equal(res.payload?.findings.length, 2);
  assert.deepEqual(res.failures, []);
  assert.ok(res.anomalies[0]?.includes('called 2 times'));
});
