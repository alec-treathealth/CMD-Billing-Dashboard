/**
 * QUALIFY PROMPT TREE (Smoke, 2026-08-10) — the deterministic prompt-selection layer that tunes the
 * explainer to the SITUATION the rep is actually in, in language an admissions rep actually uses.
 *
 * Alec's directive, verbatim intent: "make the AI answer questions in ways Admissions people
 * understand, too many numbers and technical terms will throw them off. Keep it simple but make it
 * concise and to the key point … carefully fine tuned in different payload situations with prompt
 * chains/trees depending on what path the user goes down."
 *
 * ── WHAT A "TREE" IS HERE, engineering-honestly ─────────────────────────────────────────────────
 * A DECISION TREE OVER THE VALIDATED PAYLOAD, not a chain of model calls. Every branch is a pure
 * function of `QualifyAiInput` — the same zod-validated object the firewall admits — so the path is
 * deterministic, hermetically testable, and auditable (`promptTreePath` returns the branch list).
 * A multi-call chain would double latency and cost per click and add a second model output to
 * scrub; a deterministic tree gets the same per-situation tuning for free. The "chain" is the
 * ordered composition: honesty core → audience layer → situation branches → question leaf →
 * situation notes → data → output cue.
 *
 * ── WHAT THIS FILE MAY AND MAY NOT TOUCH ────────────────────────────────────────────────────────
 * The HONESTY CORE (qualifyAi.ts's SYSTEM_PROMPT) is ratified and travels VERBATIM — several tests
 * pin its phrases. This tree only APPENDS layers after it and INSERTS one-line notes into the user
 * turn AFTER the `Question:` framing line (which must stay line 1 — test-pinned). Nothing here may
 * contradict an honesty rule; where a branch touches the same ground (e.g. estimates), it restates
 * the rule in admissions language rather than replacing it.
 *
 * ── STRUCTURAL INPUT TYPE, imported type-only ───────────────────────────────────────────────────
 * `import type` from ./qualifyAi is erased at compile time, so qualifyAi.ts value-importing this
 * module creates no runtime cycle.
 */
import type { QualifyAiInput } from './qualifyAi';

// ── The audience layer — ALWAYS on, the voice of the whole surface ──────────────────────────────

/**
 * Jargon → plain-language table. Exported so the test can assert every banned term carries a
 * translation, and so the layer's text below cannot drift from the table it claims to teach.
 * The LEFT column must never be REQUIRED to understand an answer; the model may show the number,
 * but the sentence has to work without the term.
 */
export const ADMISSIONS_TRANSLATIONS: ReadonlyArray<readonly [jargon: string, plain: string]> = [
  ['allowed-of-billed', 'how much of what we bill the plan approves'],
  ['paid-of-allowed', 'how much of what they approve actually gets paid'],
  ['provenance', 'where this read comes from'],
  ['blend / blended', 'mixed together across plans'],
  ['aggregate', 'the totals'],
  ['median days-to-payment', 'how long the money usually takes'],
  ['sample / sample size', 'how much history we have'],
  ['IQ band', 'our internal grade'],
  ['payerScope', 'which plans this covers'],
  ['comparable cohort', 'plans like this one'],
];

export const ADMISSIONS_VOICE = [
  '',
  'AUDIENCE — read this before anything else. You are talking to an ADMISSIONS REP, not a biller.',
  'They are often on the phone with a family right now. So:',
  '- LEAD WITH THE CALL. First sentence = what to do, in words a rep could say out loud.',
  '- PLAIN WORDS. Every metric gets translated: say "the plan approves about half of what we bill"',
  '  next to (or instead of) "49% allowed of billed". Never require a billing term to understand a',
  '  sentence. Terms to translate on sight: ' +
    ADMISSIONS_TRANSLATIONS.map(([j, p]) => `${j} → "${p}"`).join('; ') +
    '.',
  '- FEW NUMBERS. At most two or three per section, rounded. A rep acts on "about half" and "roughly',
  '  three weeks", not on 49.3% and 23.4 days. The precise numbers are already on their screen.',
  '- SHORT. Two sentences where you drafted four. No preamble, no restating the question.',
  '- CONCRETE NEXT STEPS. "Verify benefits before quoting", "ask billing to confirm", "safe to',
  '  proceed" — a risk without a next step is a worry, not an answer.',
].join('\n');

// ── Situation detection — the branch points, each a pure read of the payload ────────────────────

export type QualifyPromptMode = 'ticker_policy' | 'ticker_facility' | 'search';
export type QualifyPromptEvidence = 'none' | 'thin' | 'solid';

export interface QualifyPromptSituation {
  mode: QualifyPromptMode;
  evidence: QualifyPromptEvidence;
  allPlans: boolean;
  estimated: boolean;
  selfFunded: boolean;
}

/** Patients-below-this across the whole ranking = thin evidence (mirrors the honesty core's ~10). */
export const PROMPT_THIN_PATIENTS = 10;

export function promptSituationOf(input: QualifyAiInput): QualifyPromptSituation {
  const ticker = input.ticker ?? null;
  const mode: QualifyPromptMode =
    ticker !== null ? (ticker.kind === 'policy' ? 'ticker_policy' : 'ticker_facility') : 'search';

  let evidence: QualifyPromptEvidence;
  if (mode !== 'search') {
    const bodies = Math.max(ticker!.distinctMembers, ticker!.distinctPatients);
    evidence = bodies === 0 ? 'none' : bodies < PROMPT_THIN_PATIENTS ? 'thin' : 'solid';
  } else if (input.facilities.length === 0 && input.policy === null) {
    evidence = 'none';
  } else {
    const most = input.facilities.reduce((max, f) => Math.max(max, f.distinctPatients), 0);
    evidence =
      input.provenance === 'none' || (input.facilities.length > 0 && most === 0)
        ? 'none'
        : !input.windowSufficient || (input.facilities.length > 0 && most < PROMPT_THIN_PATIENTS)
          ? 'thin'
          : 'solid';
  }

  return {
    mode,
    evidence,
    allPlans: input.payerScope === 'all',
    estimated: input.provenance === 'comparable_employer' || input.provenance === 'comparable_funding',
    selfFunded: (input.policy?.funding ?? '').trim().toLowerCase().startsWith('self'),
  };
}

// ── The branches — each contributes a system paragraph, a user note, or both ────────────────────

interface PromptBranch {
  id: string;
  applies: (s: QualifyPromptSituation) => boolean;
  /** Appended to the system prompt, after the audience layer. Keep each under ~5 lines. */
  system?: string;
  /** One line inserted into the user turn after the Question framing. */
  note?: string;
}

const BRANCHES: readonly PromptBranch[] = [
  {
    id: 'mode:ticker_policy',
    applies: (s) => s.mode === 'ticker_policy',
    system: [
      '',
      'SITUATION: the rep clicked a card on the "Policies on the Move" strip — they have NOT searched',
      'anyone. Explain the card in one breath: what this kind of policy is doing lately and whether',
      "that's good news for admissions. End by telling them what searching this prefix would show.",
    ].join('\n'),
  },
  {
    id: 'mode:ticker_facility',
    applies: (s) => s.mode === 'ticker_facility',
    system: [
      '',
      'SITUATION: the rep clicked a facility card on the momentum strip. Say where this facility',
      'stands and which way it is heading, as two separate facts. What does this mean for placing',
      'clients there this month — that is the question behind the click.',
    ].join('\n'),
  },
  {
    id: 'evidence:none',
    applies: (s) => s.evidence === 'none',
    system: [
      '',
      'SITUATION: there is not enough history to rate anything here. Your FIRST sentence must say',
      'that plainly — "we don\'t have enough claims history with this plan to say how it pays."',
      'Then give the two honest moves: verify benefits before quoting anything, and ask billing',
      'whether they have seen this plan elsewhere. Do not manufacture optimism from thin air.',
    ].join('\n'),
    note: 'Note: evidence is effectively empty here — lead with that, then the next steps.',
  },
  {
    id: 'evidence:thin',
    applies: (s) => s.evidence === 'thin',
    system: [
      '',
      'SITUATION: the history here is a handful of claims, not a track record. Size every hedge to',
      'that: say "based on only a few cases" rather than quoting confidence language. One strong or',
      'weak case can swing every number the rep is looking at, and they should hear that in plain',
      'terms before they lean on any percentage.',
    ].join('\n'),
    note: 'Note: this read rests on a small number of cases — say so early, in plain words.',
  },
  {
    id: 'scope:all',
    applies: (s) => s.allPlans && s.mode === 'search',
    system: [
      '',
      'SITUATION: these numbers span EVERY plan this member has billed under, mixed together. Say',
      '"across all their coverage" — never "blend" or "aggregate". If a facility looks strong here,',
      'remind the rep it can still look different under the one plan that matters for this admit.',
    ].join('\n'),
    note: 'Note: numbers cover all of this member’s plans together, not one plan.',
  },
  {
    id: 'prov:estimated',
    applies: (s) => s.estimated,
    system: [
      '',
      'SITUATION: this read is an ESTIMATE from plans like this one — not this policy’s own claims.',
      'Every time a number appears, the sentence around it must carry that: "plans like this one',
      'usually approve about half" — never "this plan approves half". If the rep quotes an estimate',
      'to a family as a fact, that is on us.',
    ].join('\n'),
    note: 'Note: estimated from similar plans — phrase every number as "plans like this one usually…".',
  },
  {
    id: 'funding:self',
    applies: (s) => s.selfFunded,
    system: [
      '',
      'SITUATION: this plan is self-funded — the EMPLOYER’s plan decides exceptions, not the',
      'insurance company on the card. Phrase it that way: "the employer’s plan makes the call here."',
      'That changes who billing negotiates with and how much room there is; the rep should know',
      'which door to point the family toward.',
    ].join('\n'),
  },
];

/** The ordered branch ids this input walks — the audit/debug handle, and the tests' fixture. */
export function promptTreePath(input: QualifyAiInput): string[] {
  const s = promptSituationOf(input);
  return ['audience', ...BRANCHES.filter((b) => b.applies(s)).map((b) => b.id), `leaf:${input.question}`];
}

/** System prompt = ratified honesty core + audience layer + the situation branches, in that order.
 *  The core comes in as an argument so this module never owns (or drifts) the ratified text. */
export function composePromptSystem(honestyCore: string, input: QualifyAiInput): string {
  const s = promptSituationOf(input);
  const layers = BRANCHES.filter((b) => b.applies(s) && b.system !== undefined).map((b) => b.system!);
  return [honestyCore, ADMISSIONS_VOICE, ...layers].join('\n');
}

/** The one-line situation notes for the user turn (inserted after the Question framing line). */
export function promptSituationNotes(input: QualifyAiInput): string[] {
  const s = promptSituationOf(input);
  return BRANCHES.filter((b) => b.applies(s) && b.note !== undefined).map((b) => b.note!);
}
