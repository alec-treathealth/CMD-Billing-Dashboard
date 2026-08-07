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
    /** Distinct billed-under labels behind THIS facility's rows. 1 under a payer-scoped read; >1
     *  means pctAllowedOfBilled above is a blend across that many labels and must not be narrated as
     *  one payer's contract rate. A count, never a dollar. */
    payerCount: z.number().int().min(1).max(1000),
    factors: z.array(factorSchema).max(6),
  })
  .strict();

/** Every preset chip id, in one place — the zod enum, the framing table, and the tests all derive
 *  from this list so a chip cannot exist without a framing line (TS enforces the Record below).
 *  The 2026-08-04 additions (thin/takeit/plantype/funding/network) are the mockup's conditional
 *  chips ported onto real snapshot fields; 'slide' (steepest-decline) was RULED OUT — same root
 *  cause as the deferred streak badge (no faithful monthly trend behind the 0050 rollup). */
export const QUALIFY_AI_QUESTIONS = [
  'explain',
  'placement',
  'speed',
  'improve',
  'ranks',
  'thin',
  'takeit',
  'plantype',
  'funding',
  'network',
] as const;

export const QualifyAiInputSchema = z
  .object({
    /** Which preset chip fired — the question shapes the read. */
    question: z.enum(QUALIFY_AI_QUESTIONS),
    /** The resolved payer LABEL (non-PHI rollup dimension) — null on comparable/none paths AND in
     *  identifier-wide mode. `payerScope` is what tells those apart; never infer from the null. */
    payerName: short(120).nullable(),
    /**
     * WHAT THE RANKING IS SCOPED TO (2026-08-07). REQUIRED, deliberately — a null `payerName` used to
     * mean exactly one thing ("no payer on this estimated read") and now means two, so an explainer
     * reading only the null would narrate an all-payers ranking as an unscoped estimate.
     *
     *   'payer' — one billed-under label, named in payerName.
     *   'all'   — EVERY label the searched identifier bills under. Each facility's
     *             pctAllowedOfBilled is then a cross-label BLEND (payerCount says across how many).
     *   'none'  — nothing resolved (comparable-cohort / VOB-only reads).
     */
    payerScope: z.enum(['payer', 'all', 'none']),
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
  '- payerScope "all" means the ranking spans EVERY billed-under label this member carries, not one',
  '  payer. Each facility\'s allowed-of-billed is then a BLEND across payerCount labels — say so, and',
  '  never call a blended percentage a payer\'s rate. Where payerCount > 1 the number can be carried',
  '  by one label\'s mix, so a facility can read strong overall and weak under the label that matters.',
  '  Tell the rep the BILLED UNDER chips scope it to one label. payerScope "payer" means payerName is',
  '  the only label in the read.',
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
  // "this policy" presumes ONE payer, which payerScope 'all' does not have — the framing would then
  // fight the scope rule in SYSTEM_PROMPT rather than reinforce it (2026-08-07).
  speed: 'Question: HOW FAST does this read pay? Read days-to-payment and what drags it. Under payerScope "all" that is the member\'s claims across every label, not one policy.',
  improve: 'Question: WHAT WOULD MOVE this rating? Only factors reading negative are levers; unavailable factors need data, not effort.',
  ranks: 'Question: WHICH facility does this read pay best at, and how real is the gap between them? Under payerScope "all" the comparison is between BLENDS — name payerCount where it differs, because a gap can be payer mix rather than facility performance.',
  thin: 'Question: IS THERE ENOUGH HISTORY here to trust these numbers? Distinct patients — not lines — are the unit of evidence; read the sample honestly and say what "directional" means for this rep.',
  takeit: 'Question: SHOULD WE BE TAKING this policy at all? Nothing in the set reads strong — weigh the best available evidence against declining, and be direct about which way it leans.',
  plantype: 'Question: NARROW PLAN (EPO/HMO) — is there a realistic path to payment? Read what the plan type means for access and authorization, using only the policy facts provided.',
  funding: "Question: WHO actually DECIDES this claim? Self-funded means the employer's administrator sets exceptions, not a payer rate sheet; fully insured means the carrier does. Read what that does to flexibility.",
  network: 'Question: WHAT does the NETWORK POSTURE mean for us here? Read INN/OON from the policy facts and what it implies for billing strength and denial risk — never guess a posture that is not provided.',
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

// ── Blind-role defensive scrub (2026-08-04) ──────────────────────────────────────────────────────
//
// The INPUT path is already dollar-free by construction (the schema above cannot express a dollar),
// so on an amounts-blind session any dollar-shaped output is a model violation, never data. This is
// the BACKSTOP for that case: scan the streamed text server-side, drop the offending line, keep the
// rest of the answer. A dropped line beats a leaked figure; a leaked figure beats nothing only for
// viewers entitled to amounts, who never pass through this path.

/** Currency-shaped output that must never reach an amounts-blind viewer. TWO shapes, kept apart so
 *  the alert can say which one tripped without ever echoing the text:
 *    sigil — a '$' anywhere ('$4,200', '$ 500', even a bare column header)
 *    word  — 'dollar(s)'/'USD' ADJACENT TO A FIGURE ('5,000 dollars', 'USD 900', '900 usd')
 *
 *  The word form is deliberately figure-anchored, and that is a correctness fix, not a loosening:
 *  SYSTEM_PROMPT above tells the model that no dollar amounts exist in this data and not to say
 *  "check the dollars" to a blind viewer, so a COMPLIANT answer legitimately contains "no dollar
 *  amounts are available in this read". Matching the bare word would blank that caveat on every
 *  blind read — the admissions_seat persona's normal path — and bury a genuine violation in routine
 *  noise, which this repo has already learned is how a red light stops being a signal.
 *
 *  Not caught: a spelled-out amount carrying no digits ("five thousand dollars"). Accepted — the
 *  prompt is dollar-free by schema construction, so any such figure is a hallucination rather than
 *  protected data, and the same blind spot already applies to a bare "roughly 4,200 per stay". */
export const BLIND_DOLLAR_SIGIL = /\$/;
export const BLIND_DOLLAR_WORD = /\d[\d,.]*\s*(?:dollars?|usd)\b|\busd\s*\d/i;

/** Which currency shape a line carries, or null when it is clean. */
export type BlindDollarShape = 'sigil' | 'word';

export function blindDollarShape(line: string): BlindDollarShape | null {
  if (BLIND_DOLLAR_SIGIL.test(line)) return 'sigil';
  if (BLIND_DOLLAR_WORD.test(line)) return 'word';
  return null;
}

export interface BlindLineScrubber {
  /** Feed one stream delta; returns the text safe to forward now (complete, scanned lines only). */
  push(delta: string): string;
  /** End of stream: scan and release whatever partial line is still buffered. */
  flush(): string;
}

/** What replaces a withheld line. NOT the empty string, and that is load-bearing: parseAiSections
 *  matches `##\s*Signals\s*\n`, whose trailing \s* swallows a blank line, so emptying a section's
 *  ONLY body line makes the next '## Signals' header get captured as TL;DR PROSE — the panel then
 *  renders the literal text "## Signals" and duplicates the body. Reproduced, not theorised. A
 *  single space does not help (\s* eats that too); a visible token both fixes the parse and is more
 *  honest than a silent gap — the reader learns something was withheld. */
export const BLIND_WITHHELD_LINE = '[withheld]';

/** Line-buffered scrub for the blind streaming path. Emission becomes line-granular — a line is
 *  held until its newline arrives — so a dollar split across two deltas ("$" + "4,200") can never
 *  slip through the seam. A matching line is replaced by BLIND_WITHHELD_LINE (its newline kept) so
 *  the markdown section structure the client splits on survives; `onScrub` fires once per withheld
 *  line, carrying only WHICH shape tripped (a two-value enum — never the matched text). */
export function createBlindLineScrubber(onScrub: (shape: BlindDollarShape) => void): BlindLineScrubber {
  let pending = '';
  const scan = (line: string): string => {
    const shape = blindDollarShape(line);
    if (!shape) return line;
    onScrub(shape);
    return BLIND_WITHHELD_LINE;
  };
  return {
    push(delta: string): string {
      pending += delta;
      const cut = pending.lastIndexOf('\n');
      if (cut === -1) return '';
      const complete = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      // complete ends with '\n', so the final split element is '' and passes through untouched.
      return complete
        .split('\n')
        .map((line, i, all) => (i === all.length - 1 ? line : scan(line)))
        .join('\n');
    },
    flush(): string {
      const out = scan(pending);
      pending = '';
      return out;
    },
  };
}

// ── Orchestration core (2026-08-04) ─────────────────────────────────────────────────────────────
//
// The full explainer pipeline — firewall → gate → audit-before-stream → model stream → blind scrub
// → cost line → refusal check — with every side effect injected, so the root hermetic suite can
// prove the ORDER (audit strictly precedes the model call) and the blind scrub end-to-end with a
// fake transport. app/lib/qualify/ai-actions.ts is the thin 'use server' binder that supplies the
// real gate, audit writer, and Anthropic transport. This module is NOT a server action — it is not
// remotely callable, and its deps come only from the binder.

export const QUALIFY_AI_ACTION = 'qualify_ai_explain';

export interface QualifyAiActor {
  email: string;
  userId: string;
}

export type QualifyAiGateResult =
  | { ok: true; actor: QualifyAiActor; hasAmounts: boolean }
  | { ok: false };

export interface QualifyAiUsage {
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface QualifyAiTransportSession {
  /** Text deltas only — the transport adapter filters its provider's event stream down to text. */
  deltas: AsyncIterable<string>;
  /** Resolves after `deltas` is exhausted with the run's usage + stop reason. */
  final(): Promise<QualifyAiUsage>;
  abort(): void;
}

export type QualifyAiTransport = (req: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}) => QualifyAiTransportSession;

export interface QualifyAiRunDeps {
  gate(): Promise<QualifyAiGateResult>;
  recordAccess(entry: {
    actorEmail: string;
    actorUserId: string;
    action: string;
    detail: Record<string, unknown>;
  }): Promise<unknown>;
  transport: QualifyAiTransport;
  model: string;
  /** PHI-free structured ops lines (the cost line + blind-scrub alerts). Counts and ids only —
   *  never streamed text, never matched text. */
  log(line: Record<string, unknown>): void;
}

export type QualifyAiRun =
  | { ok: true; deltas: AsyncIterable<string>; abort(): void }
  | { ok: false; reason: 'insufficient' | 'invalid' | 'unavailable' };

export async function runQualifyAiExplanation(input: unknown, deps: QualifyAiRunDeps): Promise<QualifyAiRun> {
  // 1. PHI firewall BEFORE anything else — unknown keys (and therefore any identifier or dollar
  //    field a compromised client might attach) are rejected structurally, never forwarded.
  const parsed = QualifyAiInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const ai = parsed.data;

  // 2. Gate — same principal policy as every Qualify surface (fail-closed).
  const gate = await deps.gate();
  if (!gate.ok) return { ok: false, reason: 'unavailable' };

  // The prompt is dollar-free for EVERY role by schema construction; amountsBlind only tunes copy.
  // Trust the server-side principal over the client's claim — the flag can tighten, never loosen.
  const blind = !gate.hasAmounts;
  const safeInput: QualifyAiInput = { ...ai, amountsBlind: blind || ai.amountsBlind };

  if (!isQualifyAiSufficient(safeInput)) return { ok: false, reason: 'insufficient' };

  // 3. Durable audit BEFORE the model call (best-effort; non-PHI detail — question id + shape only).
  //    The transport is only constructed inside the generator below, which cannot run until this
  //    function has returned — so the audit row strictly precedes the first model byte.
  try {
    await deps.recordAccess({
      actorEmail: gate.actor.email,
      actorUserId: gate.actor.userId,
      action: QUALIFY_AI_ACTION,
      detail: {
        question: safeInput.question,
        provenance: safeInput.provenance,
        facilities: safeInput.facilities.length,
        window_days: safeInput.windowDays,
        model: deps.model,
      },
    });
  } catch {
    // An audit hiccup must not block a non-PHI aggregate read. Attribution does NOT survive in the
    // durable audit when this fires, so the cost line below carries actor_user_id (a staff uuid,
    // non-PHI — never the email) to keep a DB-outage read traceable in the ops log at least.
  }

  const { system, user } = buildQualifyAiMessages(safeInput);

  let session: QualifyAiTransportSession | null = null;
  const deltas = (async function* () {
    const live = deps.transport({ model: deps.model, system, user, maxTokens: QUALIFY_AI_MAX_TOKENS });
    session = live;
    // Defensive scrub on the SERVER-derived blind flag only — a sighted viewer's stream is untouched.
    const scrub = blind
      ? createBlindLineScrubber((shape) =>
          deps.log({
            evt: 'qualify_ai_blind_scrub',
            question: safeInput.question,
            facilities: safeInput.facilities.length,
            // WHICH shape tripped, so a real violation is triageable without echoing the text:
            // 'sigil' is almost certainly a figure; 'word' is a figure-adjacent dollars/USD phrase.
            shape,
          }),
        )
      : null;
    // A consumer that stops pulling (client navigated away mid-answer) must not leave the upstream
    // model call running — `finally` fires on early break/return, where nothing else would.
    let drained = false;
    try {
      for await (const delta of live.deltas) {
        const out = scrub ? scrub.push(delta) : delta;
        if (out) yield out;
      }
      drained = true;
    } finally {
      if (!drained) live.abort();
    }
    const tail = scrub ? scrub.flush() : '';
    if (tail) yield tail;
    const final = await live.final();
    // One PHI-free cost line (the collections-panel discipline): counts only, never content.
    deps.log({
      evt: 'qualify_ai_explain_cost',
      model: deps.model,
      question: safeInput.question,
      actor_user_id: gate.actor.userId, // uuid only — the one attribution that survives an audit failure

      input_tokens: final.inputTokens,
      output_tokens: final.outputTokens,
      stop_reason: final.stopReason, // truncation ('max_tokens') and refusals must be visible in ops, not silent
    });
    if (final.stopReason === 'refusal') {
      // An opus-5 safety refusal arrives as HTTP 200 — never render it as a finished answer.
      throw new Error('qualify_ai_refusal');
    }
  })();

  return { ok: true, deltas, abort: () => session?.abort() };
}
