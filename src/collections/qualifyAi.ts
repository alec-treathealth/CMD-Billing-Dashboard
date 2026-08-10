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
// The situation-tuning layer (audience voice + payload-situation branches). Type-only in the other
// direction (qualifyPromptTree imports only `type QualifyAiInput`), so no runtime cycle exists.
import { composePromptSystem, promptSituationNotes } from './qualifyPromptTree';

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
    /**
     * Distinct billed-under labels behind THIS facility's rows. 1 under a payer-scoped read; >1 means
     * pctAllowedOfBilled above is a blend across that many labels and must not be narrated as one
     * payer's contract rate. A count, never a dollar.
     *
     * ⚠ min(0), NOT min(1). Zero is a legal answer — `count(distinct primary_payer)` over a group
     * whose values are all NULL — and this schema is a STRICT firewall, so min(1) did not degrade
     * that one facility, it hard-REJECTED the request and killed Ask AI for the whole snapshot. The
     * firewall exists to stop PHI and dollars crossing, not to refuse an honest count.
     */
    payerCount: z.number().int().min(0).max(1000),
    /**
     * BED AVAILABILITY, as the server decided it (app/lib/qualify/bedState.ts) — the field that
     * explains the ORDER the model is reading.
     *
     * Since 2026-08-08 the facility array is sorted availability-first: a 'full' facility sits below
     * every facility that can admit today, however well it pays. Without this field the model sees a
     * re-ordered list with no reason for the re-ordering and narrates the top of it as the best read
     * — which is the one sentence the sort exists to prevent.
     *
     * A CLOSED enum, like every other on this schema, and deliberately the COMPUTED state rather
     * than raw bed counts: `openBeds: 0` means "full" on a residential board and "beds do not apply"
     * on an outpatient one, and a model asked to disambiguate that will eventually get it wrong.
     * Non-PHI and non-dollar — a bed count is a facility fact, not a patient one.
     *
     * OPTIONAL because the firewall is strict in BOTH directions: a caller built before this field
     * existed (or a snapshot from a cached older payload) must degrade to "the model is not told
     * about beds", never to a hard-rejected request that kills Ask AI for the whole snapshot. That
     * is the exact failure `payerCount`'s min(1) caused, one field up.
     */
    bedState: z.enum(['open', 'full', 'not_applicable', 'unknown']).optional(),
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
  // 2026-08-09 — the two ticker questions. Not chips: they fire from a click on a strip card, and
  // each is answered from `ticker` below rather than from `facilities`/`policy`.
  'tape_move',
  'trend_move',
] as const;

/**
 * ONE TICKER CARD, as the model may see it (2026-08-09). Alec: *"If a user clicks on any one of the
 * tickers, they should be able to receive an AI response that explains the meaning behind why the
 * ticker has the rating that it has, using the data it has on hand."*
 *
 * ⚠ THE POLICY HANDLE IS ABSENT ON PURPOSE, AND THIS IS THE FILE'S OLDEST RULE. The header above:
 * *"NO IDENTIFIERS, structurally: no member id, no prefix (not even the ≤3-char echo)."* The policy
 * tape now RENDERS a readable alpha prefix (prefixLabel.ts) — and it still must not cross this line.
 * There is no field here that can carry it: a policy card is described to the model by its payer, its
 * care setting, its area and its numbers, which is everything needed to explain a MOVE and nothing
 * that identifies whose policy moved. `facilityName` exists because a facility name is an allowlisted
 * rollup dimension the model already receives in `facilities[]`; a prefix is not.
 *
 * Non-dollar like every other shape in this file, so blind parity stays structural.
 */
const tickerSchema = z
  .object({
    /** Which strip was clicked. 'policy' = a (prefix, payer) pair on the tape; 'facility' = a card on
     *  the momentum strip. The two have genuinely different explanations available, so the framing
     *  and the honesty rules branch on it rather than pretending one shape fits both. */
    kind: z.enum(['policy', 'facility']),
    /** Facility mode only — the allowlisted dimension name. NULL in policy mode (see the ⚠ above). */
    facilityName: short(120).nullable(),
    /** The billed-under label. Present on a tape card (the pair IS a payer); on a facility card it is
     *  the DOMINANT payer by allowed dollars, which is a mix statement, not the only payer there. */
    payer: short(120).nullable(),
    careSetting: z.enum(['IP', 'OP', 'BOTH']).nullable(),
    /** "City, ST" of the facility this card is about (or the pair's dominant facility). Non-PHI: a
     *  facility's own address, from the operator-provided location sheets. */
    area: short(80).nullable(),
    /** How many facilities the pair touched in the window. 0 = unknown, 1 = the area is the whole
     *  story, >1 = `area` names only the dominant one and the model must not generalise from it. */
    facilityCount: z.number().int().min(0).max(10_000),
    ratingNow: z.number().min(0).max(100).nullable(),
    /** The same rating one delta-window earlier. Null on a facility card with no prior window. */
    ratingThen: z.number().min(0).max(100).nullable(),
    deltaPts: z.number().min(-100).max(100).nullable(),
    iqBand: z.enum(['65', '50', '30', '15', '0']).nullable(),
    /** Distinct members behind a tape pair. 0 on a facility card, which counts patients differently
     *  and reports them through `distinctPatients`. */
    distinctMembers: z.number().int().min(0).max(1_000_000),
    distinctPatients: z.number().int().min(0).max(1_000_000),
    lineCount: z.number().int().min(0).max(100_000_000),
    /** The rating window in days, and separately the delta horizon — they are NOT the same number on
     *  the tape (a 90-day rating compared against the 90-day-earlier snapshot). */
    windowDays: z.number().int().min(1).max(366),
    deltaDays: z.number().int().min(1).max(3650),
    /** Facility mode: the current window sliced into even sub-buckets, each a reliable allowed% —
     *  the sparkline the operator is looking at. Thin buckets are already dropped upstream, never
     *  fabricated, so a short array means thin evidence and not a shorter window. */
    points: z.array(z.number().min(0).max(999)).max(24),
  })
  .strict();

export const QualifyAiInputSchema = z
  .object({
    /** Which preset chip fired — the question shapes the read. Since Phase 2 this is equally the
     *  TEMPLATE ID: the chip is a sentence template and `slots` below carries its variable parts. */
    question: z.enum(QUALIFY_AI_QUESTIONS),
    /**
     * SLOT VALUES for the template named by `question` (Smoke Phase 2, 2026-08-10).
     *
     * THE FIREWALL'S POINT, restated because this is the field most likely to be "improved" into a
     * hole: there is deliberately NO string slot here, and none may be added. Every value is either
     * a closed enum or an INDEX into `facilities` above. The mock's composer lets a rep pick a
     * facility by name, and the tempting shape is `facility: z.string()` — but a string field is a
     * place prose can live, and on this surface prose means a rep pastes a member ID into a model
     * prompt. `facility: 2` resolves server-side against the array this schema already validated, so
     * the name never crosses the boundary and no new data reaches the model. A compromised client's
     * widest possible statement is "the third one".
     *
     * The index bound (0-9) matches `facilities`' own `.max(10)`. An index past the end of a SHORTER
     * list is not an error — buildQualifyAiMessages degrades to omitting that clause, because a
     * ranking can shrink between render and click and a hard reject would kill Ask AI over a race.
     *
     * OPTIONAL + nullable for the reason recorded on `bedState` and `ticker`: a caller built before
     * this field must degrade to "the model is told no slots", never hard-reject. That is the exact
     * failure `payerCount: min(1)` caused. `.strict()` still rejects an unknown KEY outright.
     */
    slots: z
      .object({
        facility: z.number().int().min(0).max(9).nullable(),
        comparator: z.number().int().min(0).max(9).nullable(),
        metric: z.enum(['allowed', 'paidOfAllowed', 'paidOfBilled', 'speed', 'rating']).nullable(),
        horizonDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).nullable(),
        careSetting: z.enum(['IP', 'OP', 'BOTH', 'ANY']).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
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
    /**
     * THE CLICKED TICKER CARD (2026-08-09) — present only for the two ticker questions, absent for
     * every chip. OPTIONAL, so every caller written before this field keeps validating: the firewall
     * is strict in both directions, and a hard reject here would kill Ask AI for the whole snapshot
     * (the `payerCount: min(1)` lesson, recorded on facilitySchema).
     */
    ticker: tickerSchema.nullable().optional(),
    /** Amounts-blind viewer? Identical prompt either way (no dollars exist here); the flag only
     *  lets the model avoid phrases like "check the dollar figures" for a viewer who has none. */
    amountsBlind: z.boolean(),
  })
  .strict();

export type QualifyAiInput = z.infer<typeof QualifyAiInputSchema>;

/**
 * Something to explain: at least one facility, a found policy, OR a clicked ticker card.
 *
 * The ticker arm is its own: a strip card is clickable from the LANDING state, where there is no
 * search, no resolved policy and no facility ranking — so requiring either of those would make the
 * feature un-runnable exactly where Alec asked for it. A card carries its own numbers.
 */
export function isQualifyAiSufficient(input: QualifyAiInput): boolean {
  return input.facilities.length > 0 || input.policy !== null || (input.ticker ?? null) !== null;
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
  '- payerCount 0 on a facility means its rows carry NO billed-under label at all — say the label is',
  '  unknown there; never call it one payer, and never treat its percentage as attributable.',
  '- payerScope "all" means the ranking spans EVERY billed-under label this member carries, not one',
  '  payer. Each facility\'s allowed-of-billed is then a BLEND across payerCount labels — say so, and',
  '  never call a blended percentage a payer\'s rate. Where payerCount > 1 the number can be carried',
  '  by one label\'s mix, so a facility can read strong overall and weak under the label that matters.',
  '  Tell the rep the BILLED UNDER chips scope it to one label. payerScope "payer" means payerName is',
  '  the only label in the read.',
  '- THE FACILITY LIST IS ORDERED BY BED AVAILABILITY FIRST, then by rating. A facility with',
  '  bedState "full" (no open beds on the latest census) sits BELOW every facility that can admit',
  '  today, however well it pays — so the first entry is the best AVAILABLE read, not necessarily the',
  '  best-paying one. Never call a "full" facility top-ranked, best or recommended without saying it',
  '  has no open beds right now; a strong rating there is a fact about future placements, not this',
  '  one. bedState "not_applicable" means an outpatient facility where beds are not the unit of',
  '  admission (NOT a full one), and "unknown" means no census reading — neither is a bed problem and',
  '  neither should be described as one.',
  '- You receive at most the first ten facilities in that order. On a longer ranking, full facilities',
  '  can fall past the tenth and be absent here while still shown to the rep — so never state or',
  '  imply that this is every facility in the read.',
  '- policy.vobStale true: the VOB feed is stale — tell the rep to verify benefits before quoting.',
  '- Self-funded plans: the employer\'s administrator decides exceptions, not a payer rate sheet.',
  '- Median days-to-payment covers PAID lines only — unresolved claims are invisible on that axis.',
  '- Use ONLY the numbers provided. Never invent payer names, facilities, dollar figures, patient',
  '  detail, or trends not present in the data. No dollar amounts exist in this data; never imply',
  '  the reader should "check the dollars" when amountsBlind is true.',
  '',
  'When `ticker` is present, the reader clicked ONE card on a scrolling strip and wants to know what',
  'its number means. Extra rules for that case, and they are the strict kind:',
  '- The card is ALL you have about it. There is no facility ranking and usually no resolved policy',
  '  behind a ticker click — do not refer to "the ranking above" or "the other facilities"; nothing',
  '  else is on screen. Answer from the card.',
  '- TWO SEPARATE FACTS: the LEVEL (ratingNow, iqBand) and the MOVE (deltaPts over deltaDays). A',
  '  facility falling from 62 is not the same story as one climbing to 22, and a reader who only',
  '  hears "up 8 points" will act on the wrong one. Say both.',
  '- A MOVE IS NOT A TREND. These ratings are allowed-of-billed over a window, so a delta can come',
  '  from genuinely better payment OR from the claim MIX changing — a few large reversals, a new',
  '  service line, one slow claim finally paying. At small samples the second is more likely than the',
  '  first. Name the mechanism as a possibility, never as a finding, and scale that hedge to the',
  '  sample (distinctMembers / distinctPatients / lineCount): under ~10 members or patients say',
  '  plainly that the move may be a handful of claims.',
  '- facilityCount > 1 means `area` and careSetting describe only the DOMINANT facility behind the',
  '  card, not the whole policy. Never state or imply the policy is treated only there.',
  '- `points` is the current window in equal sub-buckets, oldest first, with thin buckets DROPPED —',
  '  so a short array means thin evidence, not a shorter window, and gaps are not zeroes. Read shape',
  '  (steady / recovering / slipping), never a per-bucket story.',
  '- A tape card has no facility name and no identifier by design. Call it "this policy" — never',
  '  guess whose it is, where it is, or what plan it is.',
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
  tape_move:
    'Question: WHY does this POLICY carry the rating it carries, and what does its move mean? You have ' +
    'one card from the "Policies on the Move" tape in `ticker`. Read the rating, the move, and the ' +
    'evidence behind them (members, claim lines, window) — then say what an admissions rep should do ' +
    'differently, if anything. A move is not a trend: name what could produce it at this sample size.',
  trend_move:
    'Question: WHY is this FACILITY rated where it is, and what is its trajectory? You have one card ' +
    'from the "Facility Momentum" strip in `ticker`, including the sub-window sparkline in `points`. ' +
    'Read the level and the direction as two separate facts — a facility can be falling from a strong ' +
    'rating or rising toward a weak one, and only one of those is good news.',
};

/** How each slot metric reads in a sentence. Prompt-side only — never sent by the client. */
const SLOT_METRIC_PHRASE: Record<string, string> = {
  allowed: 'percent allowed of billed',
  paidOfAllowed: 'percent paid of allowed',
  paidOfBilled: 'percent paid of billed',
  speed: 'days to payment',
  rating: 'the overall five-factor rating',
};

const SLOT_CARE_SETTING_PHRASE: Record<string, string> = {
  IP: 'residential (IP)',
  OP: 'outpatient (OP)',
  BOTH: 'combined-setting',
  ANY: '',
};

/**
 * The template's slot values, resolved into a sentence for the prompt.
 *
 * FACILITY INDICES ARE RESOLVED HERE AND ONLY HERE — this is the server side of the boundary
 * described on the `slots` schema field, and the one place an index becomes a name.
 *
 * An index past the end of a shorter `facilities` list DEGRADES to omitting that clause rather than
 * throwing. The ranking can shrink between the render that offered the choice and the click that
 * used it (a refetch, a narrowed window), and killing Ask AI over that race would repeat the
 * `payerCount: min(1)` failure at a different seam. The model simply is not told which facility was
 * picked, which is honest — nothing tells it a wrong one.
 */
function describeSlots(input: QualifyAiInput): string | null {
  const slots = input.slots ?? null;
  if (!slots) return null;
  const parts: string[] = [];
  const nameAt = (i: number | null): string | null =>
    i === null ? null : input.facilities[i]?.name ?? null;

  const facility = nameAt(slots.facility);
  if (facility) parts.push(`The rep is asking specifically about ${facility}.`);
  const comparator = nameAt(slots.comparator);
  if (comparator) parts.push(`Compare it against ${comparator}.`);
  if (slots.metric) parts.push(`The measure they chose is ${SLOT_METRIC_PHRASE[slots.metric] ?? slots.metric}.`);
  if (slots.horizonDays !== null) {
    // The horizon is the REP'S framing, not a re-scoping of the data: every number in this payload
    // was computed over `windowDays`. Saying so stops the model narrating a 30-day answer off a
    // 90-day aggregate, which it will otherwise do because the slot sounds authoritative.
    parts.push(
      `They framed the question over ${slots.horizonDays} days; the figures here still cover ` +
        `${input.windowDays} days, so answer on the data's window and say so if the two differ.`,
    );
  }
  const setting = slots.careSetting ? SLOT_CARE_SETTING_PHRASE[slots.careSetting] ?? '' : '';
  if (setting) parts.push(`Limit the comparison to ${setting} facilities where the data allows.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Build the {system, user} messages for one explainer call. The user turn is the JSON aggregate.
 *
 * SINCE THE PROMPT TREE (2026-08-10) this is a composition, not a constant: the ratified honesty
 * core (SYSTEM_PROMPT above, VERBATIM — tests pin its phrases) + the admissions audience layer +
 * whichever situation branches this payload walks (qualifyPromptTree.ts — deterministic, pure,
 * path inspectable via promptTreePath). The `Question:` framing stays LINE 1 of the user turn
 * (test-pinned); situation notes and the slot sentence follow it.
 */
export function buildQualifyAiMessages(input: QualifyAiInput): { system: string; user: string } {
  const slotLine = describeSlots(input);
  const user = [
    QUESTION_FRAMING[input.question],
    ...promptSituationNotes(input),
    ...(slotLine ? [slotLine] : []),
    '',
    'Aggregates (JSON):',
    JSON.stringify(input),
    '',
    'Write the TL;DR / Signals / Risks sections now.',
  ].join('\n');
  return { system: composePromptSystem(SYSTEM_PROMPT, input), user };
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
