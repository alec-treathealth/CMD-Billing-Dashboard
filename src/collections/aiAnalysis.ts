/**
 * Collections AI analysis — the AGGREGATE-ONLY input contract, the PHI firewall (a zod schema that
 * only lets non-PHI aggregate fields through), the data-sufficiency gate, and the streamed-section
 * prompt. Transport-agnostic + hermetic: no SDK, no DB, no env here — the composition root
 * (app/lib/server.ts) owns the live Anthropic stream; this module owns WHAT the model may see and
 * WHAT it must produce.
 *
 * PHI boundary (code-enforced by {@link CollectionsAiInputSchema}): the model receives ONLY
 * aggregates that are already on-screen — the three yield percentages, dollar/charge-line rollups,
 * and top payers / facilities / CPT×Rev rows (names are allowlisted dimensions per CLAUDE.md §8),
 * plus (cohort mode) the deleted curves' per-bucket VALUES. It NEVER receives the alpha-prefix
 * string, a member id / blind-index token, a patient name/DOB, or any raw charge row — there is no
 * schema field that can carry them, and unknown keys are stripped.
 *
 * LENGTH, MEASURED (2026-09-04, `claude-opus-5`, real aggregates — a 46,773-line selection and a
 * 195-patient cohort — at a 4096 cap so nothing clipped; 3 runs per cell). Output tokens INCLUDE
 * the model's adaptive thinking, which draws from `max_tokens` before any text is streamed:
 *   A  prompt as it was ........ 1,101–1,578 out (text ≈ 524–599, thinking ≈ 571–979)  17–23 s
 *   B  + per-section budget .....   490–792 out (text ≈ 266–307, thinking ≈ 208–509)  10–13 s  ← SHIPPED
 *   C  B + output_config.effort:'low' 448–484 out (text ≈ 252–279, thinking ≈ 191–214)   8–10 s
 * Every A run exceeded the old 1024 cap — production clipped every answer (Vercel log 2026-09-04:
 * output_tokens == 1024 exactly). B is what SYSTEM_PROMPT now says and what AI_MAX_TOKENS is sized
 * to. C was measured and DELIBERATELY DEFERRED (Alec, 2026-09-04): B constrains length, C constrains
 * the model's reasoning budget, and this panel's product IS the reasoning — a same-agent read
 * validates formatting far better than analytical depth, so C's marginal ~300 tokens and 2–3 s do
 * not buy an unquantified quality risk. Re-measure before reaching for it.
 */
import { z } from 'zod';

/**
 * SELECTION-MODE sufficiency floor: minimum LOGICAL charge lines (rollup `total_count`) before the
 * AI panel will call the model. Below it the button is disabled and the fixed insufficient sentence
 * shows. This gate is about statistical MEANINGFULNESS (selection mode is a non-PHI filter-wide
 * aggregate — no re-identification concern), not disclosure: under ~2 dozen lines %-paid swings on a
 * single reversal and a "signals/risks" narrative would be noise. Cohort mode uses its own existing
 * COHORT_MIN_PATIENTS floor instead (a resolved `totals` object is the signal it cleared).
 */
export const SELECTION_MIN_CHARGES = 25;

/** The three payer-behavior percentages (0–100, or null when a denominator was 0/negative/null). */
const yieldPctSchema = z.object({
  pct_allowed: z.number().nullable(),
  pct_paid: z.number().nullable(),
  pct_collected: z.number().nullable(),
});

/** A group row (payer / facility) — an allowlisted dimension name + non-PHI aggregate count + $. */
const groupSchema = z.object({
  name: z.string().max(120).nullable(),
  count: z.number(),
  charge: z.number(),
});

/** One CPT×Rev row — codes + line count + the two dollar-weighted ratios (all non-PHI). */
const comboSchema = z.object({
  cpt: z.string().max(16).nullable(),
  revenue: z.string().max(16).nullable(),
  lines: z.number(),
  pct_allowed: z.number().nullable(),
  pct_paid: z.number().nullable(),
});

/** One deleted-curve bucket VALUE (cohort mode only) — bucket ordinal + suppressed-≥5 aggregates. */
const seriesPointSchema = z.object({
  bucket: z.number(),
  patients: z.number(),
  charge_lines: z.number(),
  pct_allowed: z.number().nullable(),
  pct_paid: z.number().nullable(),
});

/**
 * The PHI firewall. `.strict()` REJECTS unknown keys (a stray field can't smuggle PHI in), arrays
 * are length-capped, and every field is an aggregate. This is the ONLY shape the server action
 * accepts — the model input is built from its output, so PHI is unreachable by construction.
 */
export const CollectionsAiInputSchema = z
  .object({
    mode: z.enum(['cohort', 'selection']),
    yield_pct: yieldPctSchema,
    scope: z
      .object({
        charge_lines: z.number(),
        total_charge: z.number(),
        /** sum(allowed_reliable) over the slice — the zero-allowed SCALAR. Present in selection mode
         *  (from the tile aggregate); omitted in cohort mode, whose sufficiency is the min-patient
         *  floor (a resolved yield), and whose raw allowed dollars aren't exposed as a scalar. */
        total_allowed: z.number().optional(),
        total_paid: z.number(),
        total_balance: z.number(),
        cohort_patients: z.number().optional(), // cohort mode only — the N (aggregate count)
      })
      .strict(),
    top_payers: z.array(groupSchema).max(25),
    top_facilities: z.array(groupSchema).max(25),
    top_cpt_rev: z.array(comboSchema).max(25),
    series: z
      .object({
        by_visit: z.array(seriesPointSchema).max(40),
        by_days: z.array(seriesPointSchema).max(40),
      })
      .strict()
      .optional(), // cohort mode only
  })
  .strict();

export type CollectionsAiInput = z.infer<typeof CollectionsAiInputSchema>;

/**
 * Does this input clear the data-sufficiency gate (server + client both call this — one rule)?
 * - cohort mode: a resolved yield (any of the three percentages present) means the cohort cleared
 *   the existing COHORT_MIN_PATIENTS floor server-side (below it `totals` is null and the UI never
 *   offers the button).
 * - selection mode: at least SELECTION_MIN_CHARGES logical charge lines AND a positive total_allowed
 *   (the zero-allowed scalar) — an all-zero/absent-allowed selection has no %-allowed/%-paid story to
 *   tell, so the model is never called on it.
 */
export function isSufficientForAi(input: CollectionsAiInput): boolean {
  if (input.mode === 'cohort') {
    const y = input.yield_pct;
    return y.pct_allowed !== null || y.pct_paid !== null || y.pct_collected !== null;
  }
  return input.scope.charge_lines >= SELECTION_MIN_CHARGES && (input.scope.total_allowed ?? 0) > 0;
}

/** The fixed insufficient-state sentences (the panel renders these verbatim; no model call). */
export const INSUFFICIENT_COPY = {
  cohort: 'Not enough data on this cohort to create a reliable summary.',
  selection: 'Not enough data in this selection to create a reliable summary.',
} as const;

/** Section markers the model MUST emit — the client splits the streamed text on these headers. */
export const AI_SECTIONS = ['TL;DR', 'Signals', 'Risks'] as const;
export type AiSection = (typeof AI_SECTIONS)[number];

/**
 * Token ceiling for the analysis — thinking AND text, because on `claude-opus-5` adaptive thinking is
 * on by default and its tokens come out of this cap before a single text delta is streamed.
 *
 * WHY 1536 (measured, see the module docblock): with the per-section budget in SYSTEM_PROMPT the
 * observed maximum across real selection + cohort payloads was 792 output tokens, so 1536 is 1.9×
 * headroom. The prompt as it was measured 1,101–1,578, which is why the previous 1024 clipped EVERY
 * production run (the panel then rendered headers with missing bodies and nothing errored). A larger
 * cap alone was rejected: it raises spend on a surface whose account has already hit zero once, and a
 * clip is rarer at any ceiling but never impossible — which is what AI_TRUNCATED_MARK is for.
 * Change this only with a new measurement; the test pins the value, not a floor.
 */
export const AI_MAX_TOKENS = 1536;

/**
 * THE ONE-CODE-POINT WIRE CONVENTION on the AI stream. The Server Action returns
 * `ReadableStream<string>` of text deltas; when the model stopped at `max_tokens` the server enqueues
 * exactly this code point AFTER the last delta and before close, so the client can say the read was
 * cut short instead of presenting a clipped answer as complete. U+E000 is Unicode private-use: no
 * model output contains it, it is a single UTF-16 code unit (a chunk boundary cannot split it), and
 * `splitAiStream` strips it before anything renders or reaches `parseAiSections`.
 */
export const AI_TRUNCATED_MARK = '\uE000';

/**
 * Split the accumulated stream into renderable text + the truncation flag. Pure; run it on EVERY
 * render path (mid-stream and final) so the mark can never paint and never reaches the section
 * parser. Detection is on the ACCUMULATED string, so it does not matter which chunk carried the mark.
 */
export function splitAiStream(acc: string): { text: string; truncated: boolean } {
  const truncated = acc.includes(AI_TRUNCATED_MARK);
  return { text: truncated ? acc.split(AI_TRUNCATED_MARK).join('') : acc, truncated };
}

const SYSTEM_PROMPT = [
  'You are a revenue-cycle analyst for OUT-OF-NETWORK behavioral-health billing. You are given a',
  'compact set of AGGREGATE metrics for a slice of paid-claim activity (no patient-level data) and',
  'must produce a short, plain-English read for a biller.',
  '',
  'The three headline percentages:',
  '- % Allowed of Billed = allowed ÷ billed — what the payer agreed to pay of the charge.',
  '- % Paid by Payer = paid ÷ allowed — how much of the allowed amount the payer actually paid.',
  '- % Collected of Billed = paid ÷ billed — end-to-end net yield.',
  'For out-of-network care a LOW %Collected is mostly EXPECTED contractual write-off, not lost',
  'revenue — never frame the gap as pure "money left on the table". Read these by COMPARING payers,',
  'facilities and CPT×Rev rows against each other, never against an absolute target. A payer or CPT',
  'that is a clear outlier LOW on %Paid is the real signal.',
  '',
  'Rules: use ONLY the numbers provided — never invent payer names, patient detail, dollar figures,',
  'or trends not present in the data. Be specific and quantitative (cite the percentages / payer /',
  'CPT names you were given). Be concise. If the data is thin or mixed, say so plainly.',
  '',
  // LENGTH BUDGET (measured 2026-09-04, see the module docblock): without it the answer ran to
  // 342–381 words and 1,101–1,578 output tokens and clipped at the ceiling on every production run.
  'Length budget: the WHOLE answer stays under 220 words. Cite the numbers; never restate the tables.',
  'Output EXACTLY these three markdown sections, in this order, and nothing else:',
  '## TL;DR',
  'One or two sentences, 40 words at most — the single most important read.',
  '## Signals',
  '2–4 bullets, each ONE line of 25 words at most — concrete patterns worth acting on (name the payer/CPT/facility + number).',
  '## Risks',
  '2–4 bullets, each ONE line of 25 words at most — caveats, thin buckets, reversal noise, or where the number may mislead.',
].join('\n');

/** Build the {system, user} messages for one analysis call. The user turn is the JSON aggregate. */
export function buildAiMessages(input: CollectionsAiInput): { system: string; user: string } {
  const scopeLine =
    input.mode === 'cohort'
      ? `Mode: COHORT — ${input.scope.cohort_patients ?? 0} patients sharing an insurance member-ID ` +
        `alpha-prefix (a patient cohort; the prefix itself is NOT provided). Figures are ` +
        `dollar-weighted across the whole cohort, prefix-wide (ignores facility/date filters).`
      : `Mode: SELECTION — ${input.scope.charge_lines} logical charge lines matching the current ` +
        `facility / payer / date / search filters. Figures are dollar-weighted across the filtered set.`;
  const user = [
    scopeLine,
    '',
    'Aggregates (JSON):',
    JSON.stringify(input),
    '',
    'Write the TL;DR / Signals / Risks sections now.',
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

/**
 * Split streamed/complete analysis text into the three sections on the `## Header` markers. Tolerant
 * of missing sections (returns '' for any absent one) and of leading prose — used by the client to
 * route streamed chunks and by the server/tests for a final shape-check. Pure; no throw.
 */
export function parseAiSections(text: string): Record<AiSection, string> {
  const out: Record<AiSection, string> = { 'TL;DR': '', Signals: '', Risks: '' };
  for (const section of AI_SECTIONS) {
    const re = new RegExp(
      `##\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
      'i',
    );
    const m = text.match(re);
    if (m) out[section] = m[1]!.trim();
  }
  return out;
}
