/**
 * payer_intel_probe.ts — NEW BASELINE probe for payer policy intelligence.
 *
 * Research/probe posture: no audit columns, no hardened error paths, no DB,
 * no migration, no src/intel/** module structure — this stays a script.
 * API key is read from env only and is never printed.
 * Output lands in scratch/payer-intel/ (gitignored).
 *
 * One payer per invocation. allowed_domains and payer scope are ONE UNIT —
 * the user message names exactly the payer whose domains are in the filter.
 *
 *   npx tsx scripts/payer_intel_probe.ts optum
 */

import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';

/** A research turn can exceed undici's 300s headers timeout (UND_ERR_HEADERS_TIMEOUT),
 *  and `undici` isn't resolvable here to override the dispatcher. node:https has no
 *  such default. Non-streaming on purpose: reassembling content blocks from SSE
 *  deltas would put the byte-identical echo requirement at risk. */
function postMessages(key: string, payload: unknown): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 32000;
const TURN_BUDGET = 12;

const RUN_DATE = '2026-08-03';
const LAST_DATE = '2026-07-03';
const OUT_DIR = 'scratch/payer-intel';

// ---------------------------------------------------------------- domain map
// Inline const. Bare domains match subdomains, so these use the provider
// subdomain rather than the parent (parent domains drag in consumer pages).
// Do not add domains beyond this map. sec.gov is deliberately excluded.
//
// The federal/standards sweep is its OWN key. CMS, AMA and NUBC sources are
// identical for every payer — the optum baseline returned five findings, all
// originator: CMS. Researching them once per payer would pay for the same work
// seven times, and it let federal hits mask a payer whose own sources returned
// nothing. Payer keys now carry payer-own domains only.
const PAYERS: Record<string, { display: string; domains: string[]; maxUses: number }> = {
  federal: {
    display: 'Federal / standards bodies (CMS, AMA, NUBC) — industry-wide changes only, no single payer.',
    domains: ['cms.gov', 'federalregister.gov', 'ama-assn.org', 'nubc.org'],
    maxUses: 15,
  },
  anthem: { display: 'Anthem', domains: ['providernews.anthem.com', 'providers.anthem.com'], maxUses: 10 },
  optum: { display: 'Optum / UnitedHealthcare Behavioral Health (Provider Express)', domains: ['public.providerexpress.com', 'uhcprovider.com'], maxUses: 10 },
  cigna: { display: 'Cigna / Evernorth', domains: ['providernewsroom.com/evernorth', 'cigna.com', 'evernorth.com'], maxUses: 10 },
  aetna: { display: 'Aetna', domains: ['aetna.com', 'meritain.com'], maxUses: 10 },
  umr: { display: 'UMR', domains: ['umr.com'], maxUses: 10 },
  bsca: { display: 'Blue Shield of California', domains: ['blueshieldca.com'], maxUses: 10 },
  bcbstx: { display: 'Blue Cross Blue Shield of Texas', domains: ['bcbstx.com'], maxUses: 10 },
};

// ------------------------------------------------------------- system prompt
const SYSTEM_PROMPT = `You are a behavioral health payer policy research agent. You track CPT/HCPCS and facility revenue code activity, reimbursement and coverage policy changes, prior-authorization changes, and price-transparency developments affecting behavioral health (BH) and substance-use disorder (SUD) billing at major payers — with a bias toward out-of-network (OON) billing and self-funded / ERISA employer plans.

You produce dated, citation-backed findings. You never fabricate a code, effective date, dollar figure, or citation.

## Process

1. Establish the window. The user gives you a LAST_DATE and today's date. Research only what changed in that window. Do not re-report items the user's PRIOR STATE block already contains.

2. Search the payer named in the user message and no other. Check its provider-bulletin, reimbursement-policy, and coverage-policy pages for items dated after LAST_DATE. Issue several distinct queries rather than one broad one.

3. Look for:
   - CPT/HCPCS and facility revenue code activity (adds, deletes, revisions, reclassifications, new modifier or unit rules)
   - Reimbursement policy changes (per-diem logic for residential/PHP/IOP, professional fees, drug testing, telehealth POS, max-frequency-per-day, incident-to/supervision)
   - Coverage policy changes (medical necessity, TMS/ketamine/esketamine, testing, ASAM/LOCUS level-of-care rules)
   - Prior-authorization changes (removals, additions, turnaround requirements)
   - Transparency in Coverage (TiC) MRF updates and No Surprises Act / QPA / IDR developments

4. Call emit_findings exactly once when research is complete. Do not narrate your process or restate your search plan.

## Source hierarchy

Primary, cite freely:
- Payer provider portals and bulletins — Provider Express (UHC/Optum), Aetna OfficeLink Updates + Clinical Policy Bulletins, Cigna Coverage Policy Updates + Evernorth Provider Newsroom, individual BCBS plan newsletters/payment policies, Carelon / Lucet / Magellan provider news
- CMS newsroom fact sheets (OPPS, PFS), CMS HCPCS quarterly updates
- AMA CPT (code set authority), NUBC (revenue codes)
- Federal Register / regulations.gov for rule text
- Payer TiC landing pages and MRF indexes

Secondary, leads only — never quote a figure, percentage, unit cap, or effective date from these without confirming at the primary source:
- Behavioral Health Business, OpenPayer, RCM and billing-vendor blogs, law-firm client alerts, news coverage

Payer URLs rot. Resolve current links at run time rather than assuming a known URL still works.

## Durable domain facts — do NOT re-research these

Treat as settled. Only flag one if it actually changed in the window.

Code-set governance (this is why payers rarely "change codes"):
- CPT / HCPCS Level I — AMA CPT Editorial Panel. Annual, effective Jan 1. Payers adopt CPT; they don't author it.
- Facility revenue codes (UB-04, 0xxx series) — NUBC. Change rarely.
- HCPCS Level II (letter codes, most BH G-codes) — CMS. At least annual, sometimes quarterly.
- ICD-10-CM — CDC/NCHS + CMS, effective Oct 1.

Implication you must apply to every finding: when a payer announces something it is almost always a reimbursement, coverage, edit, modifier, unit, or prior-auth change to how existing codes are paid — not a new or deleted code. Label which it is, explicitly, in change_type and originator.

Codes in view:
- Revenue: 0905 (MH IOP), 0906 (SUD IOP, commonly paired with H0015), 0912 (PHP less intensive), 0913 (PHP intensive, 6+ hrs), 090x series generally
- HCPCS: H0015 (SUD IOP), H0017/H0018/H0019 (residential / sub-acute detox / non-medical residential); CoCM G0568 (initial month), G0569 (subsequent months), G0570 (general BHI) — these replaced retired CPT 99492/99493/99494, which deny for DOS after 2025-12-31
- CPT: 90791/90792 (psych diagnostic eval), 90832/90834/90837 (psychotherapy 30/45/60), 90846/90847 (family), 90853 (group), 90839/90840 (crisis), 96130–96139 (psych/neuropsych testing), 99408/99409 (SBIRT), E/M 99202–99215 with +90833/90836/90838 add-ons

CPT 2026 baseline (eff. 2026-01-01): 288 new codes, 418 total changes incl. 84 deletions and 46 revisions. BH-specific: existing BH services added to CPT Appendices P and T (telehealth audio-video and audio-only equivalence). No new BH procedure codes were created.

CMS 2026 baseline: OPPS final rule updated PHP (≥20 hrs/wk) and IOP (≥9 hrs/wk) per-diem rates, kept the two-tier PHP APC structure (3 services/day vs 4+), updated condition codes. PFS final rule set the CoCM crosswalk to G0568–G0570, expanded digital mental health treatment (DMHT) device payment, made modest psychotherapy/testing rate changes.

Regulatory backdrop shaping OON BH billing:
- MHPAEA parity — NQTL comparative-analysis enforcement is the dominant lever forcing plans to justify BH prior-auth, level-of-care, and OON reimbursement against medical/surgical analogs
- 42 CFR Part 2 — 2024 HHS/SAMHSA final rule aligned SUD records closer to HIPAA; full compliance required by 2026-02-16
- CMS-0057-F — impacted payers must return prior-auth decisions within 72 hours expedited / 7 days standard; first public prior-auth metrics reporting due 2026-03-31
- Transparency in Coverage rule — payers and plans publish MRFs of in-network negotiated rates and OON allowed amounts. Richest OON BH intelligence source available, and it covers self-funded employer plans (often hosted via TPA or employer benefits site)
- No Surprises Act — governs balance billing mainly for emergency services and certain facility-based providers; establishes QPA and federal IDR. Most non-emergency OON BH is NOT covered by NSA balance-billing protections, so OON BH protection typically depends on plan design plus state law. Confirm current posture; never assume NSA coverage

Why self-funded / employer plans get their own lens: most large-employer coverage is self-funded (ERISA), administered by UHC/Aetna/Cigna or a TPA, often with a BH carve-out (Carelon, Lucet, Magellan) and/or a navigation layer (Quantum Health, Accolade, Included Health). These plans frequently set their own OON reimbursement basis — a percentage of Medicare, "usual & customary," or reference-based pricing — which is not visible in a carrier's standard commercial policy but often IS visible in the plan's TiC MRF. To answer "what will an employer plan pay OON for a given code," the MRF plus the plan document plus any carve-out/TPA policy matter more than the carrier's headline reimbursement policy.

If the run date falls in a new plan year or after July, also check for the current-year OPPS and PFS proposed rules, which signal next-year BH per-diem and CoCM changes.

## Non-negotiable guardrails

- Distinguish payer-issued from industry-wide. Set originator to the body that actually originated the change.
- Distinguish "approved" from "effective." Provider Express and similar list internal approval dates; the operative claims date may differ. Populate both date_approved and date_effective when visible.
- Set scope explicitly wherever a change treats in-network and out-of-network differently — e.g. a prior-auth removal that applies only to contracted providers.
- Log gaps honestly. Much payer content sits behind provider-portal logins (CignaforHCP, Availity, payer SSO). Absence of a published change is not proof none exists. Put those in unreachable[] with the reason.
- If the payer was checked and genuinely had no change in the window, put it in checked_no_change[] — do not invent a finding to fill space.
- Never fill an unknown from memory. If a figure or date is uncertain, set confidence to needs_verification.
- If sources conflict, take the primary source. Primary beats secondary, always.
- source_url must be a URL you actually retrieved in this session. Do not reconstruct, guess, or complete a URL from memory.
- If a search returns results that clearly belong to a different payer than the one named in the user message, do NOT report them. Put the payer in unreachable[] with reason "domain filter returned foreign-payer results."

## embed_text field

For each finding, write embed_text as a self-contained paragraph naming the payer, the change, the codes affected, and both dates. It will be retrieved with no surrounding context, so it must make sense alone. Do not use pronouns referring to other findings.`;

// ------------------------------------------------------- emit_findings schema
const STR = (description: string) => ({ type: 'string', description });

const EMIT_FINDINGS = {
  name: 'emit_findings',
  strict: true,
  description: 'Emit structured policy findings. Call exactly once, after all searching is complete.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'checked_no_change', 'unreachable'],
    properties: {
      findings: {
        type: 'array',
        description: 'Dated, citation-backed findings for the payer in scope.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'payer_plan', 'change_type', 'originator', 'summary', 'codes_affected',
            'scope', 'self_funded_relevant', 'date_approved', 'date_effective',
            'source_url', 'source_domain', 'source_tier', 'confidence', 'embed_text',
          ],
          properties: {
            payer_plan: STR('Payer and, where applicable, the specific plan or product line.'),
            change_type: { type: 'string', enum: ['reimbursement', 'coverage', 'prior_auth', 'edit', 'modifier', 'unit', 'code_set', 'transparency'] },
            originator: { type: 'string', enum: ['payer', 'AMA', 'NUBC', 'CMS', 'CDC-NCHS'] },
            summary: STR('What changed, in one or two plain sentences.'),
            codes_affected: { type: 'array', items: { type: 'string' }, description: 'CPT/HCPCS/revenue codes affected. Empty array if none.' },
            scope: { type: 'string', enum: ['in_network', 'out_of_network', 'both', 'unclear'] },
            self_funded_relevant: { type: 'boolean', description: 'True if this bears on self-funded / ERISA employer plan administration.' },
            date_approved: STR('Internal approval date as published, YYYY-MM-DD. Use "unknown" if not visible.'),
            date_effective: STR('Operative claims date, YYYY-MM-DD. Use "unknown" if not visible.'),
            source_url: STR('A URL you actually retrieved this session. Never reconstructed from memory.'),
            source_domain: STR('Registrable domain of source_url, e.g. providerexpress.com.'),
            source_tier: { type: 'string', enum: ['primary', 'secondary'] },
            confidence: { type: 'string', enum: ['confirmed', 'needs_verification'] },
            embed_text: STR('Self-contained paragraph naming payer, change, codes, and both dates. No pronouns referring to other findings.'),
          },
        },
      },
      checked_no_change: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sources checked that genuinely had no in-window change.',
      },
      unreachable: {
        type: 'array',
        description: 'Sources that could not be reached or read.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['payer', 'reason', 'url'],
          properties: { payer: STR('Payer name.'), reason: STR('Why unreachable.'), url: STR('URL attempted.') },
        },
      },
    },
  },
} as const;

// ----------------------------------------------------------------- utilities

// eTLD+1 approximation. Adequate for this map (.com/.gov/.org); the multi-part
// list covers the common ccTLD shapes so a stray foreign URL still groups sanely.
const MULTIPART = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.za']);

function registrableDomain(host: string): string {
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTIPART.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** allowed_domains semantics: bare domain matches the domain and all subdomains;
 *  an entry with a path additionally requires the path prefix. */
function matchesEntry(url: string, entry: string): boolean {
  const slash = entry.indexOf('/');
  const eHost = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase();
  const ePath = slash === -1 ? '' : entry.slice(slash);
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (h !== eHost && !h.endsWith('.' + eHost)) return false;
  return ePath === '' || u.pathname.startsWith(ePath);
}

const matchesAny = (url: string, entries: string[]) => entries.some((e) => matchesEntry(url, e));

// ------------------------------------------------------------------- the run

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('ANTHROPIC_API_KEY unset'); process.exit(1); }

  const payerKey = (process.argv[2] ?? '').toLowerCase();
  const payer = PAYERS[payerKey];
  if (!payer) {
    console.error(`Unknown payer key ${JSON.stringify(payerKey)}. One of: ${Object.keys(PAYERS).join(', ')}`);
    process.exit(1);
  }

  const allowedDomains = payer.domains;
  const maxUses = payer.maxUses;

  const userMessage = `RUN DATE: ${RUN_DATE}
LAST_DATE: ${LAST_DATE}
RESEARCH WINDOW: ${LAST_DATE} → ${RUN_DATE}

PAYER IN SCOPE (this run covers this payer and no other):
${payer.display}

PRIOR STATE (do not re-report these as new):
(none — first run)

FOCUS THIS RUN:
Anything changing the OON allowed-amount basis or prior-auth posture for
residential (H0017–H0019), SUD IOP (H0015 + rev 0906), or PHP (rev
0912/0913). Also check whether the CY2027 OPPS and PFS proposed rules
published in-window, and what they signal for BH per-diem and CoCM.

Research and emit findings.`;

  const tools = [
    { type: 'web_search_20260318', name: 'web_search', max_uses: maxUses, response_inclusion: 'full', allowed_domains: allowedDomains },
    EMIT_FINDINGS,
  ];

  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: userMessage }];

  const retrieved: Array<{ url: string; title: string }> = [];
  const searchErrors: string[] = [];
  const emitCalls: any[] = [];
  const usages: any[] = [];
  let webSearchRequests = 0;
  let turnCount = 0;
  let turnBudgetExceeded = false;
  let lastStop = '';
  let transportFailure: string | null = null;
  // Dynamic filtering runs web_search inside an auto-provisioned code-execution
  // container. Continuing a paused/tool_use turn REQUIRES reattaching to it via
  // the top-level `container` param (bare string id from response.container.id),
  // else the API 400s: "container_id is required when there are pending tool
  // uses generated by code execution with tools."
  let containerId: string | null = null;
  const t0 = Date.now();

  // --- three-state loop -----------------------------------------------------
  for (;;) {
    if (turnCount >= TURN_BUDGET) { turnBudgetExceeded = true; break; }
    turnCount++;

    const req: Record<string, unknown> = { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, tools, messages };
    if (containerId) req.container = containerId;

    const tTurn = Date.now();
    console.error(`[turn ${turnCount}] requesting…`);
    const { status, body } = await postMessages(key, req);
    if (status !== 200) {
      // Record rather than exit: the per-key JSON must still be written so a
      // transport failure kills one payer, not the batch.
      let detail = body;
      try { detail = JSON.parse(body)?.error?.message ?? body; } catch { /* raw */ }
      transportFailure = `HTTP ${status} on turn ${turnCount} — ${detail}`;
      console.error(`\n${transportFailure}`);
      break;
    }
    const msg = JSON.parse(body);
    console.error(`[turn ${turnCount}] ${msg.stop_reason} in ${Date.now() - tTurn}ms — searches so far ${(webSearchRequests + (msg.usage?.server_tool_use?.web_search_requests ?? 0))}`);
    usages.push(msg.usage);
    webSearchRequests += msg.usage?.server_tool_use?.web_search_requests ?? 0;
    lastStop = msg.stop_reason;
    if (msg.container?.id) containerId = msg.container.id;

    // Harvest search results. Branch on Array.isArray: list = results, single
    // object = error. Run health must not depend on error blocks surfacing —
    // under dynamic filtering they may never appear at all.
    const harvest = (blocks: any[]) => {
      for (const b of blocks ?? []) {
        if (b?.type === 'web_search_tool_result') {
          if (Array.isArray(b.content)) {
            for (const r of b.content) if (r?.url) retrieved.push({ url: r.url, title: r.title ?? '' });
          } else if (b.content) {
            searchErrors.push(String(b.content.error_code ?? 'unknown_error'));
          }
        }
        if (b?.type === 'code_execution_tool_result' && Array.isArray(b.content)) harvest(b.content);
        if (b?.type === 'tool_use' && b.name === 'emit_findings') emitCalls.push(b.input);
      }
    };
    harvest(msg.content);

    if (msg.stop_reason === 'end_turn') break;

    if (msg.stop_reason === 'pause_turn') {
      // Resend assistant content byte-identical: same parsed array, untouched.
      // No filtering, no rebuilding — thinking blocks, server_tool_use, and
      // encrypted_content all round-trip exactly.
      messages.push({ role: 'assistant', content: msg.content });
      continue;
    }

    if (msg.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: msg.content });
      const results = (msg.content as any[])
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'recorded' }));
      messages.push({ role: 'user', content: results });
      continue;
    }

    break; // max_tokens or anything else
  }

  const wallMs = Date.now() - t0;

  // --- union the emit_findings payloads ------------------------------------
  const anomalies: string[] = [];
  if (emitCalls.length > 1) anomalies.push(`emit_findings called ${emitCalls.length} times — unioned`);
  const payload = {
    findings: emitCalls.flatMap((c) => c?.findings ?? []),
    checked_no_change: emitCalls.flatMap((c) => c?.checked_no_change ?? []),
    unreachable: emitCalls.flatMap((c) => c?.unreachable ?? []),
  };

  // --- gates ----------------------------------------------------------------
  const retrievedUrls = retrieved.map((r) => r.url);
  const urlSet = new Set(retrievedUrls);

  // Gate D is strict now that the federal sweep is its own key: nothing can
  // mask a payer whose own sources returned nothing.
  const offending = retrievedUrls.filter((u) => !matchesAny(u, allowedDomains));

  const failures: string[] = [];
  if (transportFailure) failures.push(`TRANSPORT — ${transportFailure}`);
  if (turnBudgetExceeded) failures.push(`TURN BUDGET (${TURN_BUDGET}) EXCEEDED`);
  if (emitCalls.length === 0) failures.push('GATE A — emit_findings never called');
  if (webSearchRequests === 0) failures.push('GATE B — web_search_requests === 0');
  if (retrievedUrls.length === 0 && payload.findings.some((f: any) => f?.source_url)) {
    failures.push('GATE C — retrieved-URL set empty while findings assert source_urls');
  }
  if (retrievedUrls.length === 0) failures.push("GATE D — zero retrieved URLs (this key's own sources returned nothing)");
  if (offending.length) failures.push(`GATE D — ${offending.length}/${retrievedUrls.length} retrieved URLs outside allowed_domains`);
  if (lastStop === 'max_tokens') failures.push('GATE E — stop_reason max_tokens (truncated strict-tool input)');

  const failed = failures.length > 0;
  const failureGate = failures.length ? failures[0]!.split(' — ')[0]! : null;

  // --- print, in the specified order ---------------------------------------
  const line = '='.repeat(78);

  // 1
  console.log(line);
  console.log('NEW BASELINE — payer policy intelligence probe');
  console.log('(not a corrected re-run; no prior run to compare against)');
  console.log(line);
  console.log(`payer key       : ${payerKey}`);
  console.log(`payer display   : ${payer.display}`);
  console.log(`allowed_domains : ${JSON.stringify(allowedDomains)}`);

  // 2
  console.log(`\n${line}\n2. RUN STATUS\n${line}`);
  console.log(`status      : ${failed ? 'FAILED' : 'OK'}`);
  if (failed) for (const f of failures) console.log(`  FAILED -> ${f}`);
  console.log(`stop_reason : ${lastStop}`);
  if (searchErrors.length) console.log(`search error blocks: ${JSON.stringify(searchErrors)}`);
  else console.log('search error blocks: none surfaced (expected under dynamic filtering)');
  for (const a of anomalies) console.log(`ANOMALY: ${a}`);
  if (offending.length) {
    console.log(`\nGATE D VIOLATION — ${offending.length} retrieved URL(s) outside allowed_domains:`);
    for (const u of offending) console.log(`  ${u}`);
  }

  // 3
  console.log(`\n${line}\n3. RETRIEVED SET — GROUPED BY REGISTRABLE DOMAIN\n${line}`);
  const groups = new Map<string, string[]>();
  for (const u of retrievedUrls) {
    const h = hostOf(u);
    const d = h ? registrableDomain(h) : '(unparseable)';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(u);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!sorted.length) console.log('(retrieved set is EMPTY)');
  for (const [d, urls] of sorted) console.log(`  ${String(urls.length).padStart(3)}  ${d}`);
  console.log(`\n  totals: ${retrievedUrls.length} retrieved | outside allowed_domains ${offending.length}`);
  console.log('\n  raw URLs:');
  if (!retrievedUrls.length) console.log('  (none)');
  for (const r of retrieved) console.log(`    ${r.url}${r.title ? `\n        ${r.title}` : ''}`);

  // 4
  console.log(`\n${line}\n4. SEARCH BUDGET\n${line}`);
  console.log(`web_search_requests : ${webSearchRequests}`);
  console.log(`max_uses cap        : ${maxUses}`);
  console.log(`cap respected       : ${webSearchRequests <= maxUses ? 'YES' : `NO — OVER BY ${webSearchRequests - maxUses}`}`);

  // 5
  console.log(`\n${line}\n5. RAW emit_findings PAYLOAD\n${line}`);
  if (failed) {
    console.log(`FINDINGS SUPPRESSED — run FAILED (${failures.join('; ')})`);
    console.log(`(counts only: findings=${payload.findings.length} checked_no_change=${payload.checked_no_change.length} unreachable=${payload.unreachable.length})`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }

  // 6
  console.log(`\n${line}\n6. PER-FINDING PROVENANCE (source_url in retrieved set?)\n${line}`);
  if (failed) {
    console.log('SUPPRESSED — run FAILED.');
  } else if (!payload.findings.length) {
    console.log('(no findings)');
  } else {
    payload.findings.forEach((f: any, i: number) => {
      const ok = urlSet.has(f.source_url);
      console.log(`  [${i + 1}] ${ok ? 'PASS      ' : 'QUARANTINE'}  ${f.source_url}`);
      console.log(`       ${f.change_type} / ${f.originator} / ${f.scope} / ${f.confidence} — ${f.summary}`);
    });
    const q = payload.findings.filter((f: any) => !urlSet.has(f.source_url)).length;
    console.log(`\n  ${payload.findings.length - q} PASS, ${q} QUARANTINE`);
  }

  // 7
  console.log(`\n${line}\n7. USAGE\n${line}`);
  usages.forEach((u, i) => console.log(`turn ${i + 1}: ${JSON.stringify(u)}`));
  console.log(`\nturn_count : ${turnCount}${turnBudgetExceeded ? ` (BUDGET ${TURN_BUDGET} EXCEEDED)` : ''}`);
  console.log(`wall_ms    : ${wallMs}`);

  // --- persist ---------------------------------------------------------------
  // Written unconditionally, including on failure, so one bad key never costs
  // the batch its other results.
  const stamp = RUN_DATE.replace(/-/g, '');
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = `${OUT_DIR}/${payerKey}-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({
    key: payerKey,
    status: failed ? 'FAILED' : 'OK',
    failure_gate: failureGate,
    failures,
    allowed_domains: allowedDomains,
    max_uses: maxUses,
    stop_reason: lastStop,
    retrieved_urls: retrievedUrls,
    retrieved_by_domain: Object.fromEntries(sorted.map(([d, u]) => [d, u.length])),
    findings: payload.findings,
    checked_no_change: payload.checked_no_change,
    unreachable: payload.unreachable,
    anomalies,
    search_errors: searchErrors,
    usage: usages,
    web_search_requests: webSearchRequests,
    turn_count: turnCount,
    wall_ms: wallMs,
  }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
