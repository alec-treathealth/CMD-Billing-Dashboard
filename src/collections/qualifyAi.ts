/**
 * Qualify AI EXPLAINER (Phase H, qualify-v2-build-plan §7H) — the strict-zod PHI firewall + prompt
 * builder for the "Ask about this policy" panel. Mirrors aiAnalysis.ts (the collections panel) in
 * shape and discipline; the differences are deliberate and stricter:
 *
 *   ZERO DOLLAR FIELDS FOR EVERY ROLE. The schema cannot express a dollar amount, so the prompt is
 *   identical for super_admin and admissions_seat — blind parity is structural, not filtered
 *   (§7H: "dollars absent from the PROMPT, not filtered from the output"). Percentages, counts,
 *   day-counts, bands, and factor sentences carry the whole story.
 *
 *   NO EMPLOYER NAME. The query-library summary_stats allowlist has never let employer_name reach
 *   a model; the policy story is told through funding + plan type + carrier instead.
 *
 *   NO IDENTIFIERS, structurally: no member id, no prefix (not even the ≤3-char echo), no group,
 *   no patient anything. `.strict()` at every level rejects unknown keys outright.
 */
import { z } from 'zod';

const short = (max: number) => z.string().min(0).max(max);

/** One factor reading as the card shows it — label + weight + direction + the plain sentence.
 *  The detail sentences are generated dollar-free by ratingV2.ts; the length bound is a backstop. */
const factorSchema = z
  .object({
    key: z.enum(['coding', 'claims', 'dataConfidence', 'ttp', 'authFit']),
    label: short(60),
    weight: z.number().int().min(0).max(100),
    score: z.number().min(0).max(1).nullable(),
    available: z.boolean(),
    direction: z.enum(['pos', 'neg', 'neu']),
    detail: short(300),
  })
  .strict();

const facilitySchema = z
  .object({
    name: short(120),
    careSetting: z.enum(['IP', 'OP', 'BOTH']).nullable(),
    ratingV2: z.number().int().min(0).max(100).nullable(),
    iqBand: z.enum(['65', '50', '30', '15', '0']).nullable(),
    pctAllowedOfBilled: z.number().min(0).max(999).nullable(),
    distinctPatients: z.number().int().min(0),
    lineCount: z.number().int().min(0),
    medianDaysToPayment: z.number().min(0).max(3650).nullable(),
    factors: z.array(factorSchema).max(6),
  })
  .strict();

export const QualifyAiInputSchema = z
  .object({
    /** Which preset chip fired — the question shapes the read. */
    question: z.enum(['explain', 'placement', 'speed', 'improve', 'ranks']),
    /** The resolved payer LABEL (non-PHI rollup dimension) — null on comparable/none paths. */
    payerName: short(120).nullable(),
    /** Policy facts on file (plan-level, non-PHI; NO employer, NO identifiers, NO benefit dollars). */
    policy: z
      .object({
        carrier: short(120).nullable(),
        funding: short(40).nullable(),
        policyType: short(40).nullable(),
        planType: short(60).nullable(),
        network: z.enum(['INN', 'OON']).nullable(),
        memberCount: z.number().int().min(0),
        vobStale: z.boolean(),
      })
      .strict()
      .nullable(),
    /** What the ranking's evidence is built ON (§6) — the model must hedge on comparable/none. */
    provenance: z.enum(['direct', 'comparable_employer', 'comparable_funding', 'none']),
    windowDays: z.number().int().min(1).max(366),
    /** False when even 365d never reached the confident sample floor — the model must say so. */
    windowSufficient: z.boolean(),
    facilities: z.array(facilitySchema).max(10),
    /** Amounts-blind viewer? Identical prompt either way (no dollars exist here); the flag only
     *  lets the model avoid phrases like "check the dollar figures" for a viewer who has none. */
    amountsBlind: z.boolean(),
  })
  .strict();

export type QualifyAiInput = z.infer<typeof QualifyAiInputSchema>;

/** Chips only make sense with something to explain: at least one facility OR a found policy. */
export function isQualifyAiSufficient(input: QualifyAiInput): boolean {
  return input.facilities.length > 0 || input.policy !== null;
}

export const QUALIFY_AI_INSUFFICIENT_COPY =
  'Nothing to explain yet — search a policy or resolve a payer first.';

/** Section markers the model MUST emit — same client-splitting contract as the collections panel. */
export const QUALIFY_AI_SECTIONS = ['TL;DR', 'Signals', 'Risks'] as const;

export const QUALIFY_AI_MAX_TOKENS = 4096; // opus-5 thinks by default and thinking SHARES this cap — 1024 truncated answers mid-section

const SYSTEM_PROMPT = [
  'You are a revenue-cycle analyst for OUT-OF-NETWORK behavioral-health billing, explaining a',
  'facility-fit read to an admissions rep who is on the phone with a prospective client. You get',
  'AGGREGATE, non-dollar metrics only: a five-factor rating per facility (0-100, renormalized over',
  'the factors that have data), the IQ verdict bands the billing team uses (65%+/50%+/30%+/15%+/0%),',
  'reliable allowed-of-billed percentages, distinct-patient counts, median days-to-payment, and the',
  'policy facts on file (carrier, funding, plan type, network when captured).',
  '',
  'Honesty rules — these outrank helpfulness:',
  '- provenance "direct" means the policy\'s own claims; "comparable_*" means an ESTIMATED read from',
  '  a peer cohort — always call an estimate an estimate, never dress it as direct evidence.',
  '- provenance "none" or an empty facility list: there is nothing to rate. Say so; suggest a biller.',
  '- windowSufficient false means even a year of history never reached a reliable sample — every',
  '  number is directional; say "directional, not confirmed".',
  '- A facility below 10 distinct patients is a thin sample; below 3 it is unrated — never invent a',
  '  number for it, and never average away a thin sample\'s uncertainty.',
  '- policy.vobStale true: the VOB feed is stale — tell the rep to verify benefits before quoting.',
  '- Self-funded plans: the employer\'s administrator decides exceptions, not a payer rate sheet.',
  '- Median days-to-payment covers PAID lines only — unresolved claims are invisible on that axis.',
  '- Use ONLY the numbers provided. Never invent payer names, facilities, dollar figures, patient',
  '  detail, or trends not present in the data. No dollar amounts exist in this data; never imply',
  '  the reader should "check the dollars" when amountsBlind is true.',
  '',
  'Output EXACTLY these three markdown sections, in this order, and nothing else:',
  '## TL;DR',
  'One or two sentences — the direct answer to the question asked.',
  '## Signals',
  '2-4 short bullets — concrete, quantitative, each naming a facility/factor + its number.',
  '## Risks',
  '2-4 short bullets — caveats: thin samples, estimated provenance, stale VOB, slow payment.',
].join('\n');

/** The question each chip is actually asking — one line of task framing per chip. */
const QUESTION_FRAMING: Record<QualifyAiInput['question'], string> = {
  explain: 'Question: WHY does the top facility score what it scores? Walk the factors that carry and drag it.',
  placement: 'Question: SHOULD the rep place this client here? A placement read — direct about risk, never a guarantee.',
  speed: 'Question: HOW FAST does this policy pay? Read days-to-payment and what drags it.',
  improve: 'Question: WHAT WOULD MOVE this rating? Only factors reading negative are levers; unavailable factors need data, not effort.',
  ranks: 'Question: WHICH facility does this policy pay best, and how real is the gap between them?',
};

/** Build the {system, user} messages for one explainer call. The user turn is the JSON aggregate. */
export function buildQualifyAiMessages(input: QualifyAiInput): { system: string; user: string } {
  const user = [
    QUESTION_FRAMING[input.question],
    '',
    'Aggregates (JSON):',
    JSON.stringify(input),
    '',
    'Write the TL;DR / Signals / Risks sections now.',
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}
