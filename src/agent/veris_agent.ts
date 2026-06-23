/**
 * Phase 4 — Veris reasoning agent.
 *
 * Anthropic tool-calling agent that fuses Brain 1 (risk), Brain 2 (payer drift),
 * and Brain 3 (appeal evidence) into one ≤150-word recommendation for a charge.
 *
 * Tools run parameterized DB reads as claims_reader (no raw SQL exposed to the
 * model). PHI never enters tool results — only coded columns, rates, amounts.
 *
 * API note: thinking { type: 'adaptive' } cannot be combined with
 * tool_choice { type: 'any' } — the API rejects that pair. We use tool_choice
 * 'auto' across turns and no extended thinking.
 */
import Anthropic from '@anthropic-ai/sdk';
import { makeClient, type Db } from '../db.js';
import { retrieveAppealEvidence } from '../brain3/hybrid_search.js';

const BEID = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

export type VerisAction = 'FIX_BEFORE_SEND' | 'INVESTIGATE_PAYER' | 'FILE_APPEAL' | 'MONITOR';
export interface VerisRecommendation {
  charge_debit_id: string;
  recommendation: string;
  action: VerisAction;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  brain1_used: boolean;
  brain2_used: boolean;
  brain3_used: boolean;
}

const SYSTEM_PROMPT =
  'You are Veris, a revenue cycle advisor for behavioral health practices. You have ' +
  'access to three analytical tools: a claim risk predictor (Brain 1), a payer behavior ' +
  'drift detector (Brain 2), and an evidence retrieval system for appeals (Brain 3). ' +
  'Given a charge ID, call all three tools, then produce a single plain-language ' +
  'recommendation of at most 150 words covering: (1) risk assessment, (2) any active ' +
  'payer alerts, (3) whether to appeal and what evidence supports it. Never mention ' +
  'patient names or member IDs.';

const TOOLS: Anthropic.Tool[] = [
  { name: 'get_brain1_score', description: 'Risk scores for a charge.',
    input_schema: { type: 'object', properties: { charge_debit_id: { type: 'string' } },
      required: ['charge_debit_id'] } },
  { name: 'get_brain2_alerts', description: 'Unacknowledged payer drift alerts.',
    input_schema: { type: 'object', properties: { payer_name: { type: 'string' },
      carc_code: { type: 'string' } }, required: ['payer_name'] } },
  { name: 'get_brain3_evidence', description: 'Similar paid claims as appeal evidence.',
    input_schema: { type: 'object', properties: { charge_debit_id: { type: 'string' },
      top_n: { type: 'number' } }, required: ['charge_debit_id'] } },
  { name: 'get_pfs_anchor', description: 'CMS PFS rate context for an HCPCS code.',
    input_schema: { type: 'object', properties: { hcpcs_code: { type: 'string' } },
      required: ['hcpcs_code'] } },
];

async function readerScoped(): Promise<Db> {
  const url = process.env.CLAIMS_READER_DATABASE_URL;
  if (!url) throw new Error('Missing CLAIMS_READER_DATABASE_URL');
  const db = makeClient(url);
  await db.query("select set_config('app.business_entity_id', $1, false)", [BEID]);
  return db;
}

async function runTool(db: Db, name: string, input: any): Promise<unknown> {
  switch (name) {
    case 'get_brain1_score': {
      const r = await db.query(
        `select p_paid, p_denied, p_partial, expected_days_to_pay, shap_top_feature,
                shap_top_value, counterfactual_hint
           from staging.brain1_scores
          where business_entity_id = $1 and charge_debit_id = $2
          order by scored_at desc limit 1`, [BEID, input.charge_debit_id]);
      return r.rows[0] ?? null;
    }
    case 'get_brain2_alerts': {
      const r = await db.query(
        `select alert_type, prior_rate, post_rate, run_length_posterior,
                similar_carc_cluster, plain_language, detected_at
           from staging.brain2_alerts
          where business_entity_id = $1 and payer_name = $2
            and ($3::text is null or carc_code = $3) and acknowledged = false
          order by detected_at desc`, [BEID, input.payer_name, input.carc_code ?? null]);
      return r.rows;
    }
    case 'get_brain3_evidence':
      return retrieveAppealEvidence({ queryClaimId: input.charge_debit_id,
        businessEntityId: BEID, topN: input.top_n ?? 10 });
    case 'get_pfs_anchor': {
      const r = await db.query(
        `select avg(facility_rate) as facility_rate, avg(non_facility_rate) as non_facility_rate,
                avg(rvu_work) as rvu_work
           from ref.cms_pfs_rate where hcpcs_code = $1 and year = 2026`, [input.hcpcs_code]);
      return r.rows[0] ?? null;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

export async function adviseCharge(chargeDebitId: string): Promise<VerisRecommendation> {
  const client = new Anthropic();
  const db = await readerScoped();
  const used = { brain1_used: false, brain2_used: false, brain3_used: false };
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Advise on charge ${chargeDebitId}. Call the tools, then reply ONLY ` +
      `with a compact JSON object: {"recommendation","action","confidence"} where action is one of ` +
      `FIX_BEFORE_SEND|INVESTIGATE_PAYER|FILE_APPEAL|MONITOR and confidence is HIGH|MEDIUM|LOW.` },
  ];

  try {
    for (let turn = 0; turn < 6; turn++) {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: TOOLS, messages,
      });
      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text).join('');
        const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        return { charge_debit_id: chargeDebitId, recommendation: parsed.recommendation,
          action: parsed.action, confidence: parsed.confidence, ...used };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.name === 'get_brain1_score') used.brain1_used = true;
        if (tu.name === 'get_brain2_alerts') used.brain2_used = true;
        if (tu.name === 'get_brain3_evidence') used.brain3_used = true;
        const out = await runTool(db, tu.name, tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new Error('veris_agent: tool loop did not converge');
  } finally {
    await db.end();
  }
}

if (process.argv[2]) {
  adviseCharge(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => { console.error('[veris_agent] failed:', err.message); process.exit(1); });
}
