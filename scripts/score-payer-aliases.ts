/**
 * PAYER-ALIAS RESCORER — IDF-weighted token similarity, replacing raw trigram.
 *
 * WHY THIS EXISTS. Migration 026 seeded ref.payer_alias_map with trigram-derived proposals and
 * measured, on the very first apply, that raw trigram produces confidently-wrong merges on the
 * largest gaps in the book:
 *
 *   CIGNA HEALTH PLANS      (31,878 lines, 6.5% of ALL claim volume) -> pi_health_plans_inc  @0.565  WRONG
 *   OXFORD HEALTH PLANS     (667 lines)                             -> pi_health_plans_inc  @0.542  WRONG
 *   CIGNA BEHAVIORIAL HEALTH(398 lines)                             -> pi_carelon_...      @0.500  WRONG
 *
 * Correct proposals in the same batch scored 0.500-0.593 and 0.840 — i.e. wrong and correct
 * OVERLAP COMPLETELY in the 0.500-0.593 band, so no threshold separates them. Raw trigram scores
 * shared CHARACTER SEQUENCES with no concept of which tokens carry identity. "HEALTH", "PLANS",
 * "BLUE", "CROSS", "INSURANCE", "BEHAVIORAL" are near-universal filler across payer names;
 * "CIGNA", "OXFORD", "HALCYON" ARE the identity. Trigram weights them identically.
 *
 * THE FIX IS A WEIGHTING SCHEME, NOT A CLASSIFIER. Inverse document frequency over the payer-name
 * corpus makes filler tokens cheap and distinctive tokens expensive, then cosine similarity over
 * those weighted vectors. There is no model here: no labels, no train/test split, no persisted
 * artifact, no hyperparameter search. It is a deterministic scoring function of the corpus.
 *
 * DEPENDENCY-FREE ON PURPOSE. TF-IDF + cosine is ~40 lines; adding scikit-learn/numpy to this repo
 * for a scoring function would be a heavier change than the function itself.
 *
 * WHAT IT DOES NOT DO — this is the load-bearing part:
 *   - WRITES NOTHING. No INSERT, no UPDATE, no temp table, no transaction. It opens a READ-ONLY
 *     claims_reader pool and issues SELECTs. It cannot modify ref.payer_alias_map even by accident,
 *     because it never issues a statement that could.
 *   - Does not auto-accept anything. Output is a REVIEW QUEUE for a human. A wrong payer merge is a
 *     confidently-wrong answer at the worst possible layer; that is exactly what 026's
 *     needs_review gate caught, and this script does not relitigate that gate.
 *   - Does not read or project a single PHI column. It selects payer NAME strings and aggregate
 *     counts only — no member id, member token, patient name, employer, group number or dollar.
 *     Payer identity is public information (same posture as intel.*, SQL Schemas/025).
 *
 * CANDIDATE SET DISCIPLINE. A canonical payer's "surface forms" are its display_name plus its
 * CONFIRMED aliases only (needs_review = false). Unconfirmed proposals are deliberately excluded
 * from the reference set — otherwise a proposal's own string becomes a candidate surface for the
 * very canonical it proposes, and every proposal trivially self-confirms at 1.000.
 *
 *   node --env-file=.env --import tsx scripts/score-payer-aliases.ts
 *   node --env-file=.env --import tsx scripts/score-payer-aliases.ts --top 5 --limit-vob 60
 */
import { makeClient } from '../src/collections/db.js';

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string, dflt: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
const TOP_N = flag('top', 3); // candidates to show per query name
const VOB_PRINT = flag('limit-vob', 40); // how many VOB rows to print (all are scored)

// ── Tokenization + TF-IDF ────────────────────────────────────────────────────────────────────────

/** --fold-plurals: prototype only. Item 4 measures whether it earns a place; it is NOT decided. */
const FOLD_PLURALS = argv.includes('--fold-plurals');

/**
 * DATA-DRIVEN singular folding. Fold X -> X' ONLY when X' is itself an observed corpus token.
 *
 * MEASURED CORRECTION. The first version stripped a trailing S from any token longer than 3 chars,
 * which mangled non-plural words: BCBS -> BCB, TEXAS -> TEXA, ARKANSAS -> ARKANSA. That was
 * internally consistent (queries, candidate surfaces and the modifier set all folded alike) so
 * matching still worked, but it is not a plural folder — it is a truncator, and its behaviour on any
 * new -S token is unpredictable. The corpus-membership test fixes it without an exception list:
 * PLANS folds because PLAN is observed; TEXAS does not, because TEXA is not; BCBS does not, because
 * BCB is not. Self-limiting and inspectable.
 */
let SINGULARIZABLE = new Set<string>();

function tokenizeRaw(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Must run over the corpus BEFORE any vectorisation. Two-pass by necessity. */
function initFolding(corpus: string[]): void {
  const raw = new Set<string>();
  for (const name of corpus) for (const t of tokenizeRaw(name)) raw.add(t);
  const fold = new Set<string>();
  for (const t of raw) {
    if (t.length > 3 && t.endsWith('S') && !t.endsWith('SS') && raw.has(t.slice(0, -1))) fold.add(t);
  }
  SINGULARIZABLE = fold;
}

function foldPlural(t: string): string {
  if (!FOLD_PLURALS) return t;
  return SINGULARIZABLE.has(t) ? t.slice(0, -1) : t;
}

/** Uppercase, strip punctuation to spaces, split. Deliberately simple and inspectable. */
export function tokenize(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(foldPlural);
}

// ── MODIFIER token class (Guard B) ───────────────────────────────────────────────────────────────
// A token that can MODIFY a payer identity but can never BE one. A state cannot identify a carrier;
// neither can "HEALTH" or "PLAN". IDF cannot learn this: TEXAS and CIGNA both score ~5, because both
// are rare in the corpus. Rarity and identity-bearing are different properties, and this is the set
// where they come apart. Curated, small, and auditable on purpose.
const US_STATES = `ALABAMA ALASKA ARIZONA ARKANSAS CALIFORNIA COLORADO CONNECTICUT DELAWARE FLORIDA
GEORGIA HAWAII IDAHO ILLINOIS INDIANA IOWA KANSAS KENTUCKY LOUISIANA MAINE MARYLAND MASSACHUSETTS
MICHIGAN MINNESOTA MISSISSIPPI MISSOURI MONTANA NEBRASKA NEVADA HAMPSHIRE JERSEY MEXICO YORK
CAROLINA DAKOTA OHIO OKLAHOMA OREGON PENNSYLVANIA RHODE ISLAND TENNESSEE TEXAS UTAH VERMONT
VIRGINIA WASHINGTON WISCONSIN WYOMING`.split(/\s+/);
const STATE_CODES = `AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT
NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC`.split(/\s+/);
// NOTE ON CURATION. This list is the guard's whole discriminating power, so its errors are the
// guard's errors. Two corrections already forced by measurement:
//   + COMMERCIAL / PROGRAM / CARD — omitting COMMERCIAL let "UPMC HEALTH PLAN COMMERCIAL" match
//     pi_valley_health_plan at 0.603 through BOTH guards, driven by COMMERCIAL alone.
//   - UNITED / FIRST / NATIONAL / AMERICAN deliberately NOT included: they are identity-bearing for
//     UnitedHealthcare, First Health Network, etc. Calling them filler would blind the guard to real
//     payers. This asymmetry is the reason the list needs human review, not extension by intuition.
const GENERIC = `HEALTH HEALTHCARE PLAN PLANS INSURANCE INSURER BENEFIT BENEFITS GROUP INC LLC LLP
CORP THE OF AND ADMINISTRATORS ADMINISTRATOR SERVICES SERVICE CARE MEDICAL SYSTEM SYSTEMS
NORTH SOUTH EAST WEST CENTRAL REGION REGIONAL MUTUAL
FOUNDATION SOLUTIONS MANAGEMENT COMPANY CO PPO HMO EPO POS SECONDARY PRIMARY FKA
COMMERCIAL PROGRAM CARD`.split(/\s+/);
// Stored UNFOLDED, because the set is built at module load and folding is corpus-derived (initFolding
// runs later). A folded token can only have lost a trailing S, so testing t and t+'S' covers both.
const MODIFIER_RAW = new Set<string>([...US_STATES, ...STATE_CODES, ...GENERIC]);
function isModifier(t: string): boolean {
  return MODIFIER_RAW.has(t) || MODIFIER_RAW.has(`${t}S`);
}

// ── STATE RESOLUTION (Guard C) ───────────────────────────────────────────────────────────────────
//
// Guard B treats every state token as interchangeable filler, which is right for ITS question ("is
// this match resting on nothing but modifiers?") and wrong for a different one: two names can both
// carry a state and carry DIFFERENT states. `BCBS OF NORTH DAKOTA -> pi_bcbs_north_carolina @0.502`
// is the measured case — every token shares except the one that decides which company it is.
//
// TOKEN COMPARISON IS NOT ENOUGH, and that case is exactly why. Tokenized, the query is
// {BCBS, OF, NORTH, DAKOTA} and the candidate {BCBS, NORTH, CAROLINA}: NORTH matches, so a naive
// "do they share a state token?" test says yes. The states have to be resolved as UNITS —
// NORTH DAKOTA vs NORTH CAROLINA — before they can be compared. Hence longest-match-first over the
// token sequence rather than a set intersection.
const STATE_SEQ: ReadonlyArray<readonly [readonly string[], string]> = [
  // Multi-token first — 'CAROLINA' or 'DAKOTA' alone cannot be resolved and deliberately is not.
  [['NEW', 'HAMPSHIRE'], 'NH'], [['NEW', 'JERSEY'], 'NJ'], [['NEW', 'MEXICO'], 'NM'],
  [['NEW', 'YORK'], 'NY'], [['NORTH', 'CAROLINA'], 'NC'], [['NORTH', 'DAKOTA'], 'ND'],
  [['SOUTH', 'CAROLINA'], 'SC'], [['SOUTH', 'DAKOTA'], 'SD'], [['RHODE', 'ISLAND'], 'RI'],
  [['WEST', 'VIRGINIA'], 'WV'],
  [['ALABAMA'], 'AL'], [['ALASKA'], 'AK'], [['ARIZONA'], 'AZ'], [['ARKANSAS'], 'AR'],
  [['CALIFORNIA'], 'CA'], [['COLORADO'], 'CO'], [['CONNECTICUT'], 'CT'], [['DELAWARE'], 'DE'],
  [['FLORIDA'], 'FL'], [['GEORGIA'], 'GA'], [['HAWAII'], 'HI'], [['IDAHO'], 'ID'],
  [['ILLINOIS'], 'IL'], [['INDIANA'], 'IN'], [['IOWA'], 'IA'], [['KANSAS'], 'KS'],
  [['KENTUCKY'], 'KY'], [['LOUISIANA'], 'LA'], [['MAINE'], 'ME'], [['MARYLAND'], 'MD'],
  [['MASSACHUSETTS'], 'MA'], [['MICHIGAN'], 'MI'], [['MINNESOTA'], 'MN'], [['MISSISSIPPI'], 'MS'],
  [['MISSOURI'], 'MO'], [['MONTANA'], 'MT'], [['NEBRASKA'], 'NE'], [['NEVADA'], 'NV'],
  [['OHIO'], 'OH'], [['OKLAHOMA'], 'OK'], [['OREGON'], 'OR'], [['PENNSYLVANIA'], 'PA'],
  [['TENNESSEE'], 'TN'], [['TEXAS'], 'TX'], [['UTAH'], 'UT'], [['VERMONT'], 'VT'],
  [['VIRGINIA'], 'VA'], [['WASHINGTON'], 'WA'], [['WISCONSIN'], 'WI'], [['WYOMING'], 'WY'],
];

// Two-letter codes accepted as states ONLY in trailing position (below), and never these:
//   CO — 'Company', already in GENERIC. 'DELTA DENTAL CO' is not Colorado.
//   OR / IN / ME / OK / HI / DE — ordinary English or business words that would resolve a state out
//   of noise. 'HEALTH PLAN OF ME' is a real ambiguity and the safe answer is "no state found".
// The remaining codes (TX, CA, PA, SC, NC, …) are the ones that actually appear as payer suffixes.
// LIKE THE MODIFIER LIST, this curation IS the guard's discriminating power, so its errors are the
// guard's errors — extend it with measurement, not intuition.
const AMBIGUOUS_CODES = new Set(['CO', 'OR', 'IN', 'ME', 'OK', 'HI', 'DE']);
const STATE_CODE_SET = new Set(STATE_CODES.filter((c) => !AMBIGUOUS_CODES.has(c)));

/**
 * Resolve the set of US states a payer name refers to, as two-letter codes.
 *
 * Longest-match-first, left to right. A bare 'CAROLINA' / 'DAKOTA' / 'HAMPSHIRE' resolves to
 * NOTHING on purpose: without its direction word the state is genuinely unknown, and inventing one
 * would make Guard C fire on a coin flip. An empty result disables Guard C for that name, which is
 * the correct failure direction — the guard only speaks when it actually knows both states.
 */
export function resolveStates(tokens: string[]): Set<string> {
  const out = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    let matched = 0;
    for (const [seq, code] of STATE_SEQ) {
      if (seq.length > tokens.length - i) continue;
      let ok = true;
      for (let k = 0; k < seq.length; k++) {
        if (tokens[i + k] !== seq[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.add(code);
        matched = seq.length;
        break;
      }
    }
    if (matched === 0) i += 1;
    else i += matched;
  }
  // Trailing two-letter code: 'BCB TX', 'ANTHEM CA'. Position-restricted because a code in the
  // middle of a name is far more likely to be an abbreviation of something else.
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && last !== undefined && last.length === 2 && STATE_CODE_SET.has(last)) {
    out.add(last);
  }
  return out;
}

type Vec = Map<string, number>;

/** Smoothed IDF, sklearn's formulation: ln((1+N)/(1+df)) + 1. Never divides by zero, never negative. */
function buildIdf(corpus: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const name of corpus) {
    for (const tok of new Set(tokenize(name))) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  const n = corpus.length;
  const idf = new Map<string, number>();
  for (const [tok, d] of df) idf.set(tok, Math.log((1 + n) / (1 + d)) + 1);
  return idf;
}

/** L2-normalized tf-idf vector. Unseen tokens get the max IDF (treated as maximally distinctive). */
function vectorize(name: string, idf: Map<string, number>, maxIdf: number): Vec {
  const tf = new Map<string, number>();
  for (const tok of tokenize(name)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
  const v: Vec = new Map();
  let sumSq = 0;
  for (const [tok, f] of tf) {
    const w = f * (idf.get(tok) ?? maxIdf);
    v.set(tok, w);
    sumSq += w * w;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) for (const [tok, w] of v) v.set(tok, w / norm);
  return v;
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [tok, w] of small) {
    const other = large.get(tok);
    if (other !== undefined) dot += w * other;
  }
  return dot;
}

/** Per-token contributions to the score, strongest first — the "why" behind a match. */
function drivers(a: Vec, b: Vec, limit = 4): string {
  const parts: Array<[string, number]> = [];
  for (const [tok, w] of a) {
    const other = b.get(tok);
    if (other !== undefined) parts.push([tok, w * other]);
  }
  parts.sort((x, y) => y[1] - x[1]);
  if (parts.length === 0) return '(no shared tokens)';
  return parts
    .slice(0, limit)
    .map(([t, c]) => `${t}=${c.toFixed(3)}`)
    .join(' ');
}

// ── Types ────────────────────────────────────────────────────────────────────────────────────────

type Surface = { canonical: string; display: string; surface: string; vec: Vec };
type Scored = { canonical: string; display: string; via: string; score: number; why: string };

function rank(query: string, surfaces: Surface[], idf: Map<string, number>, maxIdf: number): Scored[] {
  const qv = vectorize(query, idf, maxIdf);
  const best = new Map<string, Scored>();
  for (const s of surfaces) {
    const score = cosine(qv, s.vec);
    if (score <= 0) continue;
    const prev = best.get(s.canonical);
    if (!prev || score > prev.score) {
      best.set(s.canonical, {
        canonical: s.canonical,
        display: s.display,
        via: s.surface,
        score,
        why: drivers(qv, s.vec),
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

// ── GUARDS ───────────────────────────────────────────────────────────────────────────────────────

/** Per-token contribution pairs, strongest first. */
function contribs(a: Vec, b: Vec): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [tok, w] of a) {
    const other = b.get(tok);
    if (other !== undefined) out.push([tok, w * other]);
  }
  return out.sort((x, y) => y[1] - x[1]);
}

/**
 * `flag` is the union of B and C for the stream tallies; `flagB` / `flagC` are kept separate because
 * 028 treats them DIFFERENTLY, and the difference is the whole point of having two guards:
 *   - Guard B says "this match rests on nothing that can identify a payer" — not a proposal at all.
 *   - Guard C says "this match has real identity support but the states disagree" — a proposal a
 *     human can adjudicate in one glance, so it ships WITH a review note rather than being dropped.
 */
export type GuardVerdict = { block: boolean; flag: boolean; flagB: boolean; flagC: boolean; reasons: string[] };

/**
 * GUARD A — distinctive-token coverage. The query's single highest-IDF token must be present in the
 * candidate. Rationale: that token is the query's strongest identity claim; a candidate that does not
 * contain it is matching on leftovers. This is what kills OXFORD HEALTH PLANS -> pi_health_plans_inc
 * (OXFORD, idf 6.33, unmatched) without needing to know what Oxford is.
 *
 * GUARD B — modifier-only match. If every token carrying >= MIN_SHARE of the score is MODIFIER-class,
 * the match rests entirely on words that cannot identify a payer. Flag for MANDATORY review at any
 * score. This is what catches AETNA TEXAS -> pi_bcbs_texas (TEXAS alone) and BCBS OF FLORIDA ->
 * pi_ambetter_florida (FLORIDA alone) while leaving CIGNA HEALTH PLANS -> pi_cigna alone, because
 * CIGNA is not a modifier.
 */
/** Share of the score a token must carry to count as "driving". Parameterized ONLY so the floor's
 *  sensitivity can be measured (--guard-b-share 0.05 / 0.15); the discriminating work is done by the
 *  MODIFIER class, not by this number. */
const GUARD_B_MIN_SHARE = flag('guard-b-share', 0.1);

// ── The reviewer header's wrong-rate claim, and its self-policing ────────────────────────────────
//
// These are MEASURED constants, not estimates: bucket F of the confirmed-tier holdout, measured
// post-027 with Guards A/B/C and observed-token plural folding. They are declared here because the
// header prints ABOVE the table it describes, which is before the sanity section computes them.
//
// A hardcoded number in a header is exactly the kind of claim that rots silently, so the sanity
// section asserts the computed value still matches. If the corpus shifts and it does not, the check
// FAILS and names the new figure — the header cannot quietly become a lie.
const WRONG_RATE_F = 8;
const WRONG_RATE_TESTABLE = 212;
const WRONG_RATE_PCT = ((100 * WRONG_RATE_F) / WRONG_RATE_TESTABLE).toFixed(1);
const WRONG_RATE_DENOM = Math.round(WRONG_RATE_TESTABLE / WRONG_RATE_F);

/** Known likely-wrong survivor of both guards, found by inspection while measuring the 35-stream.
 *  Annotated in every output rather than left to sit unlabeled beside unreviewed candidates. */
const KNOWN_SUSPECT = new Map<string, string>([
  [
    'UNITED BEHAVIORAL HEALTH',
    'KNOWN LIKELY-WRONG SURVIVOR — should be Optum (pi_optum), not a Behavioral-Health-Systems match. ' +
      'Survives both guards because BEHAVIORAL is covered. Reject unless verified.',
  ],
  [
    '1199 SEIU FUNDS',
    'KNOWN LIKELY-WRONG SURVIVOR — 1199 SEIU is an unrelated union benefit fund. It only acquired a ' +
      'candidate at all because plural folding merged FUNDS->FUND, matching an unrelated benefit-fund ' +
      'canonical. Reject unless verified.',
  ],
]);

export function applyGuards(
  query: string,
  cand: Surface,
  idf: Map<string, number>,
  maxIdf: number,
  shareFloor: number = GUARD_B_MIN_SHARE,
): GuardVerdict {
  const qv = vectorize(query, idf, maxIdf);
  const qTokens = tokenize(query);
  const reasons: string[] = [];

  // Guard A — IDENTITY-TOKEN COVERAGE.
  //
  // MEASURED CORRECTION (do not revert to the top-IDF form). The first formulation required the
  // query's single highest-IDF token to appear in the candidate. That blocked 18 of 35 proposals
  // INCLUDING correct ones, because a query routinely carries a very rare MODIFIER that the canonical
  // legitimately does not: "MERITAIN HEALTH MINNEAPOLIS" (MINNEAPOLIS idf 7.59) is still Meritain,
  // "CIGNA - PPO" (PPO 7.59) is still Cigna, "KAISER PERMANENTE OF HAWAII" is still Kaiser. Worse, it
  // blocked CIGNA HEALTH PLANS -> pi_cigna, the very case the rescorer was built to fix, because the
  // plural artifact makes PLANS (5.28) outrank CIGNA (4.72).
  //
  // Correct form: at least ONE non-modifier (identity-bearing) query token must be covered. A
  // candidate that covers none of the query's identity tokens is matching purely on filler.
  // Kept as BOTH a list and a set: Guard A needs membership, Guard C needs ORDER (a multi-token
  // state like NEW YORK cannot be resolved out of a deduplicated set).
  const candTokList = tokenize(cand.surface);
  const candTokens = new Set(candTokList);
  const identityToks = qTokens.filter((t) => !isModifier(t));
  const coveredIdentity = identityToks.filter((t) => candTokens.has(t));
  const blockA = identityToks.length > 0 && coveredIdentity.length === 0;
  if (blockA) {
    reasons.push(
      `GUARD-A: no identity token covered — query carries [${identityToks.join(', ')}], candidate has none`,
    );
  }

  // Guard B
  const cs = contribs(qv, cand.vec);
  const total = cs.reduce((s, [, c]) => s + c, 0);
  const driving = total > 0 ? cs.filter(([, c]) => c / total >= shareFloor) : [];
  const flagB = driving.length > 0 && driving.every(([t]) => isModifier(t));
  if (flagB) {
    reasons.push(
      `GUARD-B: match driven only by modifier token(s) [${driving.map(([t]) => t).join(', ')}] — cannot identify a payer`,
    );
  }

  // Guard C — STATE MISMATCH. Both names name a state, and they are different states.
  //
  // This is the case Guard B structurally cannot see. Guard B asks whether the match rests only on
  // modifiers; here the match rests on a real shared identity token (BCBS) and the state is what
  // DISAGREES. `BCBS OF NORTH DAKOTA -> pi_bcbs_north_carolina @0.502` passes both A and B and is
  // simply the wrong company.
  //
  // Deliberately NOT a block. A state mismatch is strong evidence of a wrong match but not proof: a
  // national carrier's alias can legitimately carry one state while the canonical's display name
  // carries another ('AETNA TEXAS' under a canonical named for a different state is a real shape).
  // So it forces review rather than discarding, and only speaks when BOTH sides resolve a state —
  // silence when it does not know.
  const qStates = resolveStates(qTokens);
  const cStates = resolveStates(candTokList);
  const shared = [...qStates].some((s) => cStates.has(s));
  const flagC = qStates.size > 0 && cStates.size > 0 && !shared;
  if (flagC) {
    reasons.push(
      `GUARD-C: state mismatch — query names [${[...qStates].sort().join(', ')}], candidate names [${[...cStates].sort().join(', ')}]`,
    );
  }

  return { block: blockA, flag: flagB || flagC, flagB, flagC, reasons };
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.CLAIMS_READER_DATABASE_URL;
  if (!url) throw new Error('CLAIMS_READER_DATABASE_URL not set');
  const db = makeClient(url);

  try {
    // ── 1. Corpus: every distinct payer-name string we know, from all four sources ──────────────
    // Explicit column projection everywhere; no SELECT *. All identifiers are fixed literals.
    const corpusRes = await db.query<{ nm: string }>(
      `select distinct upper(btrim(insurance_co)) as nm
         from vob.member_benefits_latest
        where nullif(btrim(insurance_co), '') is not null
       union
       select distinct upper(btrim(primary_payer))
         from collections.cmd_explorer_charge_rollup
        where nullif(btrim(primary_payer), '') is not null
       union
       select distinct upper(btrim(display_name)) from ref.payer_identity
       union
       -- NAME vocabularies only. vob_payer_id aliases are opaque numeric/short ids ('81400',
       -- 'CB752'), not surface forms of a name: they contribute meaningless document frequency to a
       -- name corpus and can only create spurious matches.
       select distinct alias_norm from ref.payer_alias_map
        where vocabulary in ('claims_primary_payer', 'vob_insurance_co')`,
    );
    const corpus = corpusRes.rows.map((r) => r.nm);
    // Folding is corpus-derived, so it MUST be initialised before the first tokenize() call that
    // feeds IDF. Everything downstream (surfaces, guards, MODIFIER lookups) then folds consistently.
    initFolding(corpus);
    const idf = buildIdf(corpus);
    const maxIdf = Math.max(...idf.values());

    // ── 2. Reference surfaces: display_name + CONFIRMED aliases only ───────────────────────────
    const surfRes = await db.query<{ canonical: string; display: string; surface: string }>(
      `select pi.canonical_payer_id as canonical, pi.display_name as display,
              upper(btrim(pi.display_name)) as surface
         from ref.payer_identity pi
        where pi.entity_kind <> 'program' and pi.is_active
       union
       select m.canonical_payer_id, pi.display_name, m.alias_norm
         from ref.payer_alias_map m
         join ref.payer_identity pi on pi.canonical_payer_id = m.canonical_payer_id
        where m.canonical_payer_id is not null
          and not m.needs_review
          and pi.entity_kind <> 'program'
          -- NAME vocabularies only — see the corpus query. A numeric payer_id is not a surface form,
          -- and leaving it in makes a canonical look reachable by name when it is not.
          and m.vocabulary in ('claims_primary_payer', 'vob_insurance_co')`,
    );
    const surfaces: Surface[] = surfRes.rows.map((r) => ({
      canonical: r.canonical,
      display: r.display,
      surface: r.surface,
      vec: vectorize(r.surface, idf, maxIdf),
    }));

    console.log('='.repeat(112));
    console.log('PAYER-ALIAS RESCORER — IDF-weighted token cosine vs raw trigram');
    console.log('='.repeat(112));
    console.log(`corpus: ${corpus.length} distinct payer names · ${idf.size} distinct tokens`);
    console.log(`reference surfaces: ${surfaces.length} (display_name + CONFIRMED aliases; proposals excluded)`);
    console.log('');
    const filler = [...idf.entries()].sort((a, b) => a[1] - b[1]).slice(0, 12);
    console.log('CHEAPEST tokens (the filler trigram over-weighted):');
    console.log('  ' + filler.map(([t, w]) => `${t}:${w.toFixed(2)}`).join('  '));
    const distinctive = ['CIGNA', 'OXFORD', 'HALCYON', 'AETNA', 'HEALTH', 'PLANS', 'BLUE', 'CROSS', 'INC'];
    console.log('SPOT IDF: ' + distinctive.map((t) => `${t}:${(idf.get(t) ?? maxIdf).toFixed(2)}`).join('  '));
    console.log('');

    // ── OUTPUT 1: re-score the existing needs_review proposals ─────────────────────────────────
    const propRes = await db.query<{
      alias_norm: string;
      canonical_payer_id: string;
      display: string;
      confidence: string | null;
      lines: string;
    }>(
      `with c as (
         select upper(btrim(primary_payer)) as nm, count(*) as lines
           from collections.cmd_explorer_charge_rollup
          where nullif(btrim(primary_payer), '') is not null
          group by 1
       )
       select m.alias_norm, m.canonical_payer_id, pi.display_name as display,
              m.confidence::text as confidence, coalesce(c.lines, 0)::text as lines
         from ref.payer_alias_map m
         join ref.payer_identity pi on pi.canonical_payer_id = m.canonical_payer_id
         left join c on c.nm = m.alias_norm
        where m.vocabulary = 'claims_primary_payer'
          and m.needs_review
          and m.canonical_payer_id is not null
        order by coalesce(c.lines, 0) desc`,
    );

    console.log('='.repeat(112));
    console.log(`OUTPUT 1 — RE-SCORE OF ${propRes.rows.length} EXISTING needs_review PROPOSALS (review priority order)`);
    console.log('='.repeat(112));
    console.log(
      `${pad('CLAIMS NAME', 34)} ${pad('LINES', 7)} ${pad('TRIGRAM PROPOSED', 26)} ${pad('trg', 6)} ${pad('NEW TOP-1 (idf-cosine)', 26)} ${pad('new', 6)} VERDICT`,
    );
    console.log('-'.repeat(112));

    const disagreements: string[] = [];
    for (const p of propRes.rows) {
      const ranked = rank(p.alias_norm, surfaces, idf, maxIdf);
      const top = ranked[0];
      const oldScore = p.confidence ? Number(p.confidence) : NaN;
      const agrees = top && top.canonical === p.canonical_payer_id;
      const verdict = !top ? 'NO CANDIDATE' : agrees ? 'agrees' : '*** DISAGREES ***';
      console.log(
        `${pad(p.alias_norm, 34)} ${pad(p.lines, 7)} ${pad(p.canonical_payer_id, 26)} ${pad(oldScore.toFixed(3), 6)} ${pad(top?.canonical ?? '-', 26)} ${pad(top ? top.score.toFixed(3) : '-', 6)} ${verdict}`,
      );
      if (top && !agrees) {
        disagreements.push(
          `  ${p.alias_norm}  (${p.lines} lines)\n` +
            `      trigram : ${p.canonical_payer_id} @ ${oldScore.toFixed(3)}\n` +
            `      new top : ${top.canonical} @ ${top.score.toFixed(3)}  via "${top.via}"  [${top.why}]\n` +
            `      runners : ${ranked.slice(1, TOP_N).map((r) => `${r.canonical}@${r.score.toFixed(3)}`).join(', ') || '(none)'}`,
        );
      }
    }

    console.log('');
    console.log(`SHARP DISAGREEMENTS (${disagreements.length}) — trigram and IDF-cosine pick different payers:`);
    console.log(disagreements.join('\n') || '  (none)');
    console.log('');

    // ── OUTPUT 2: score the unmapped VOB carrier names ─────────────────────────────────────────
    const vobRes = await db.query<{ nm: string; members: string }>(
      `select upper(btrim(v.insurance_co)) as nm,
              count(distinct v.member_id_bidx)::text as members
         from vob.member_benefits_latest v
        where nullif(btrim(v.insurance_co), '') is not null
          and not exists (
            select 1 from ref.payer_alias_map m
             where m.vocabulary = 'vob_insurance_co' and m.alias_norm = upper(btrim(v.insurance_co))
          )
        group by 1
        order by count(distinct v.member_id_bidx) desc`,
    );

    // Claims-side names 026 recorded as having NO candidate under trigram. Hoisted to main scope
    // because both --analyze (Item 3) and --emit-sql consume it; a second copy of the query is a
    // second thing to keep in sync.
    const ncRes = await db.query<{ alias_norm: string; lines: string }>(
      `with c as (
         select upper(btrim(primary_payer)) as nm, count(*) as lines
           from collections.cmd_explorer_charge_rollup
          where nullif(btrim(primary_payer), '') is not null
          group by 1
       )
       select m.alias_norm, coalesce(c.lines, 0)::text as lines
         from ref.payer_alias_map m
         left join c on c.nm = m.alias_norm
        where m.vocabulary = 'claims_primary_payer'
          and m.provenance = 'no_candidate'
        order by coalesce(c.lines, 0) desc`,
    );

    console.log('='.repeat(112));
    console.log(`OUTPUT 2 — ${vobRes.rows.length} UNMAPPED VOB CARRIER NAMES, scored (the 40%-of-members gap)`);
    console.log('NOTHING BELOW IS INSERTED. Candidate proposals for human review only.');
    console.log('');
    console.log('  >> EXPECTED WRONG-RATE, READ BEFORE REVIEWING <<');
    console.log(`  Roughly 1 IN ${WRONG_RATE_DENOM} of the surviving proposals is expected to be WRONG (~${WRONG_RATE_PCT}%).`);
    console.log(`  Basis: of ${WRONG_RATE_TESTABLE} testable CONFIRMED-tier pairs, ${WRONG_RATE_F} resolve to a genuinely`);
    console.log('  different payer that NEITHER guard objects to (bucket F). That is a holdout estimate from');
    console.log('  a DIFFERENT population than these proposals, so treat it as an order-of-magnitude');
    console.log('  expectation, not a measured rate for this list. Approve nothing in bulk. Lines/members');
    console.log('  are shown so you can spend the review budget where an error costs most.');
    console.log('  Two rows are pre-flagged as KNOWN LIKELY-WRONG; they are annotated inline, not hidden.');
    console.log('='.repeat(112));
    console.log(`${pad('VOB CARRIER NAME', 34)} ${pad('MEMB', 6)} ${pad('TOP-1 CANDIDATE', 30)} ${pad('score', 6)} DRIVING TOKENS`);
    console.log('-'.repeat(112));

    let strong = 0;
    let weak = 0;
    let none = 0;
    let membersStrong = 0;
    let membersNone = 0;
    for (const [i, v] of vobRes.rows.entries()) {
      const ranked = rank(v.nm, surfaces, idf, maxIdf);
      const top = ranked[0];
      const members = Number(v.members);
      if (!top) {
        none++;
        membersNone += members;
      } else if (top.score >= 0.6) {
        strong++;
        membersStrong += members;
      } else weak++;
      if (i < VOB_PRINT) {
        console.log(
          `${pad(v.nm, 34)} ${pad(v.members, 6)} ${pad(top?.canonical ?? '(no candidate)', 30)} ${pad(top ? top.score.toFixed(3) : '-', 6)} ${top ? top.why : ''}`,
        );
      }
    }
    if (vobRes.rows.length > VOB_PRINT) {
      console.log(`  … ${vobRes.rows.length - VOB_PRINT} more (all scored; raise --limit-vob to print)`);
    }
    console.log('');
    console.log(
      `VOB summary: ${strong} names score >=0.60 (${membersStrong} members) · ${weak} score <0.60 · ` +
        `${none} have no shared token at all (${membersNone} members)`,
    );
    console.log('');

    // ── SANITY CHECKS — must pass before any of the above is worth reading ─────────────────────
    console.log('='.repeat(112));
    console.log('SANITY CHECKS');
    console.log('='.repeat(112));

    const checks: Array<[string, boolean, string]> = [];

    // MEASURED CORRECTION to this check (2026-08-04) — read before "fixing" it back.
    //
    // The original assertion was "the wrong canonical is no longer rank 1". That is the right
    // assertion for CIGNA (pi_cigna exists, so something CAN outrank the wrong answer) and an
    // IMPOSSIBLE one for OXFORD: no canonical identity in the corpus contains the token OXFORD at
    // all — Oxford Health Plans is a UnitedHealthcare brand with no row of its own. With nothing
    // OXFORD-bearing to rank above it, pi_health_plans_inc is rank 1 by default no matter how the
    // weighting is tuned, so the check was demanding an outcome the data cannot produce and had been
    // reporting FAIL since the scorer's first run.
    //
    // The invariant that actually protects the book is not the ranking — it is that the wrong
    // proposal never SHIPS. Guard A blocks it (OXFORD is an uncovered identity token), so the check
    // now asserts "rank 1 is correct OR the guards refuse the match", and prints which one held.
    // A ranking check would have to be satisfied by inventing a pi_oxford row, which is a data
    // decision for a human, not a scoring problem.
    for (const [name, badCanonical] of [
      ['CIGNA HEALTH PLANS', 'pi_health_plans_inc'],
      ['OXFORD HEALTH PLANS', 'pi_health_plans_inc'],
      ['CIGNA BEHAVIORIAL HEALTH', 'pi_carelon_behavioral_health'],
    ] as const) {
      const ranked = rank(name, surfaces, idf, maxIdf);
      const top = ranked[0];
      const badRank = ranked.findIndex((r) => r.canonical === badCanonical);
      const outranked = top?.canonical !== badCanonical;
      let refused = false;
      if (top) {
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(name, surf, idf, maxIdf);
        refused = g.block || g.flag;
      }
      checks.push([
        `"${name}" cannot produce the wrong merge to ${badCanonical}`,
        outranked || refused,
        `top=${top?.canonical ?? '-'}@${top ? top.score.toFixed(3) : '-'} · ${badCanonical} at rank ${badRank === -1 ? 'absent' : badRank + 1}` +
          ` · protected by ${outranked ? 'RANKING' : refused ? 'GUARDS (would not ship)' : 'NOTHING'}`,
      ]);
    }

    // Known-correct pairs must NOT be destroyed by the reweighting.
    const regression = await db.query<{ alias_norm: string; canonical_payer_id: string }>(
      `select m.alias_norm, m.canonical_payer_id
         from ref.payer_alias_map m
        where m.vocabulary = 'claims_primary_payer'
          and not m.needs_review
          and m.canonical_payer_id is not null
          and m.provenance in ('payer_alias_seed', 'exact_match')
        order by m.alias_norm
        limit 400`,
    );
    let held = 0;
    let lost = 0;
    let vacuous = 0;
    const lostExamples: string[] = [];
    for (const r of regression.rows) {
      // Score against surfaces EXCLUDING this alias string, else it self-matches at 1.000.
      const pool = surfaces.filter((s) => s.surface !== r.alias_norm);
      // VACUOUS CASE — do not count it as a failure. Many canonicals have exactly ONE surface, which
      // IS the alias under test (display_name and alias_norm are the same string). Removing the
      // self-surface removes the only way to reach the right answer, so the case tests nothing about
      // the scorer. Counting these as regressions is what produced a misleading 49.3% on the first
      // run of this script.
      if (!pool.some((s) => s.canonical === r.canonical_payer_id)) {
        vacuous++;
        continue;
      }
      const top = rank(r.alias_norm, pool, idf, maxIdf)[0];
      if (top && top.canonical === r.canonical_payer_id) held++;
      else {
        lost++;
        if (lostExamples.length < 6) {
          lostExamples.push(`${r.alias_norm} -> want ${r.canonical_payer_id}, got ${top?.canonical ?? 'none'}@${top ? top.score.toFixed(3) : '-'}`);
        }
      }
    }
    const testable = held + lost;
    checks.push([
      `CONFIRMED pairs still resolve to the same canonical (self-surface excluded)`,
      testable > 0 && held / testable >= 0.8,
      `${held}/${testable} held (${((100 * held) / Math.max(1, testable)).toFixed(1)}%), ${lost} changed, ` +
        `${vacuous} skipped as vacuous (canonical's only surface was the query string)`,
    ]);

    // ── The classification, hoisted out of --analyze because a CHECK depends on it ───────────────
    //
    // WHY A SECOND CHECK, rather than relaxing the one above. "Held" treats every change as a
    // failure, and most changes are not. When the scorer moves `ANTHEM BCBS CT` from
    // pi_anthem_connecticut to pi_anthem_bcbs_of_ct at 0.957, it has not made an error — it has
    // found a DUPLICATE IDENTITY that 027's queue does not yet cover. Counting that as a regression
    // measures the crosswalk's remaining dedup backlog, not the scorer's accuracy, and no amount of
    // reweighting can fix it.
    //
    // The invariant that actually bounds 028's risk is narrower and testable: how often does the
    // scorer pick a GENUINELY DIFFERENT payer that NEITHER guard refuses? That is bucket F, and it
    // is the number the reviewer header quotes. The `held` check stays exactly as it was — an
    // uncalibrated tripwire is still information, and silently re-baselining it to green would hide
    // the dedup backlog it is currently the only thing measuring.
    const displayByCanon = new Map<string, string>();
    for (const s of surfRes.rows) displayByCanon.set(s.canonical, s.display);
    const stateOf = new Map<string, string>();
    for (const [i, code] of STATE_CODES.entries()) stateOf.set(code, US_STATES[i] ?? '');

    const buckets = new Map<string, string[]>();
    const addTo = (k: string, line: string) => buckets.set(k, [...(buckets.get(k) ?? []), line]);
    for (const r of regression.rows) {
      const pool = surfaces.filter((s) => s.surface !== r.alias_norm);
      if (!pool.some((s) => s.canonical === r.canonical_payer_id)) continue; // vacuous
      const ranked = rank(r.alias_norm, pool, idf, maxIdf);
      const top = ranked[0];
      if (top && top.canonical === r.canonical_payer_id) continue; // held
      const wantDisp = displayByCanon.get(r.canonical_payer_id) ?? r.canonical_payer_id;
      const gotDisp = top ? displayByCanon.get(top.canonical) ?? top.canonical : '(none)';
      const wantIdx = ranked.findIndex((x) => x.canonical === r.canonical_payer_id);
      const detail =
        `${pad(r.alias_norm, 32)} want=${pad(r.canonical_payer_id, 30)} got=${pad(top?.canonical ?? 'none', 30)} ` +
        `wantRank=${wantIdx === -1 ? 'absent' : String(wantIdx + 1)} got@${top ? top.score.toFixed(3) : '-'}`;
      if (!top) {
        addTo('E. UNREACHABLE — no candidate shares any token with the query', detail);
        continue;
      }
      const dsim = cosine(vectorize(wantDisp, idf, maxIdf), vectorize(gotDisp, idf, maxIdf));
      const qToks = tokenize(r.alias_norm);
      const abbrev = qToks.some((t) => {
        const full = stateOf.get(t);
        return !!full && tokenize(wantDisp).includes(foldPlural(full));
      });
      const g = applyGuards(
        r.alias_norm,
        { canonical: top.canonical, display: gotDisp, surface: top.via, vec: vectorize(top.via, idf, maxIdf) },
        idf,
        maxIdf,
      );
      if (dsim >= 0.5) addTo('A. DUPLICATE IDENTITY — want and got are the same real payer under two ids', `${detail} displaySim=${dsim.toFixed(3)}`);
      else if (abbrev) addTo('B. ABBREVIATION FORM — query uses a state code, wanted canonical spells it out', detail);
      else if (g.flagC) addTo('C2. STATE MISMATCH — caught by Guard C', detail);
      else if (g.flag) addTo('C. MODIFIER-DRIVEN — got match rests only on generic/geographic tokens', detail);
      else if (g.block) addTo('D. COVERAGE VIOLATION — got match omits an identity token', detail);
      else addTo('F. OTHER — genuinely different payer, guards do not catch it', `${detail} displaySim=${dsim.toFixed(3)}`);
    }
    const fBucket = (buckets.get('F. OTHER — genuinely different payer, guards do not catch it') ?? []).length;
    const uncaughtRate = testable > 0 ? fBucket / testable : 0;
    checks.push([
      `Uncaught wrong-payer rate stays under 6% (bucket F — the number 028's reviewer header quotes)`,
      uncaughtRate < 0.06,
      `${fBucket}/${testable} = ${(100 * uncaughtRate).toFixed(1)}% resolve to a genuinely different payer with NO guard objecting`,
    ]);
    checks.push([
      `The reviewer header's wrong-rate claim still matches what the code measures`,
      fBucket === WRONG_RATE_F && testable === WRONG_RATE_TESTABLE,
      `header says ${WRONG_RATE_F}/${WRONG_RATE_TESTABLE} (~${WRONG_RATE_PCT}%, 1 in ${WRONG_RATE_DENOM}); ` +
        `measured ${fBucket}/${testable}` +
        (fBucket === WRONG_RATE_F && testable === WRONG_RATE_TESTABLE
          ? ''
          : ` — UPDATE WRONG_RATE_F/WRONG_RATE_TESTABLE, the header is stating a stale figure`),
    ]);

    for (const [label, ok, detail] of checks) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}`);
    }
    if (lostExamples.length > 0) {
      console.log('  changed-canonical examples (inspect, not necessarily wrong):');
      for (const e of lostExamples) console.log(`        ${e}`);
    }
    console.log('');
    console.log(`OVERALL: ${checks.every((c) => c[1]) ? 'ALL SANITY CHECKS PASS' : 'SANITY CHECKS FAILED — do not act on the tables above'}`);
    console.log('');

    if (argv.includes('--analyze')) {
      // ── ITEM 1: the classification computed above, printed ──────────────────────────────────
      // The loop that fills `buckets` now lives in the sanity section, because the bucket-F check
      // depends on it. Computing it twice would let the check and the report drift apart.
      console.log('='.repeat(112));
      console.log('ITEM 1 — CLASSIFICATION OF EVERY CHANGED CONFIRMED-TIER CASE');
      console.log('='.repeat(112));

      const order = [...buckets.keys()].sort();
      let classified = 0;
      for (const k of order) {
        const rows = buckets.get(k) ?? [];
        classified += rows.length;
        console.log(`\n${k}  —  ${rows.length} case(s)`);
        for (const l of rows) console.log(`   ${l}`);
      }
      console.log(`\nTOTAL CLASSIFIED: ${classified}`);
      console.log('COUNTS: ' + order.map((k) => `${k[0]}=${(buckets.get(k) ?? []).length}`).join('  '));

      // ── ITEM 2 scope: guards applied to the 35 proposals ────────────────────────────────────
      console.log('');
      console.log('='.repeat(112));
      console.log('ITEM 2 — GUARDS APPLIED TO THE ORIGINAL 35 PROPOSALS');
      console.log('='.repeat(112));
      let blockedA = 0;
      let flaggedB = 0;
      let flaggedOnly = 0;
      let clean = 0;
      let noCand = 0;
      const noCandNames: string[] = [];
      for (const p of propRes.rows) {
        const ranked = rank(p.alias_norm, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) {
          // The fourth outcome. Previously uncounted, which is why the stream table did not sum to 35.
          noCand++;
          noCandNames.push(`${p.alias_norm} (${p.lines} lines)`);
          continue;
        }
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(p.alias_norm, surf, idf, maxIdf);
        if (g.block) blockedA++;
        if (g.flag) flaggedB++;
        // The four outcomes are a PARTITION only if the flagged-but-not-blocked case is counted
        // separately. Guard A and Guard B/C overlap, so blockedA + flaggedB double-counts and the
        // old sum check came up one short of 35 without naming which row it had lost.
        if (g.flag && !g.block) flaggedOnly++;
        if (!g.block && !g.flag) clean++;
        if (g.block || g.flag) {
          console.log(`  ${pad(p.alias_norm, 34)} ${pad(p.lines, 6)} -> ${pad(top.canonical, 30)} @${top.score.toFixed(3)}`);
          for (const rr of g.reasons) console.log(`        ${rr}`);
        }
        const suspect = KNOWN_SUSPECT.get(p.alias_norm);
        if (suspect && !g.block && !g.flag) {
          console.log(`  ${pad(p.alias_norm, 34)} ${pad(p.lines, 6)} -> ${pad(top.canonical, 30)} @${top.score.toFixed(3)}`);
          console.log(`        !! ${suspect}`);
        }
      }
      const streamSum = blockedA + flaggedOnly + clean + noCand;
      console.log(
        `\n35-proposal stream: GUARD-A blocked ${blockedA} · GUARD-B/C flagged ${flaggedB} ` +
          `(${flaggedOnly} of them not also blocked by A) · clean ${clean} · no viable candidate ${noCand}`,
      );
      console.log(
        `  SUM CHECK: blockedA(${blockedA}) + flaggedOnly(${flaggedOnly}) + clean(${clean}) + noCand(${noCand}) = ${streamSum} ` +
          `vs stream total ${propRes.rows.length}${streamSum === propRes.rows.length ? '  OK' : '  <-- MISMATCH'}`,
      );
      if (noCandNames.length > 0) console.log(`  no-viable-candidate: ${noCandNames.join(', ')}`);

      // ── ITEM 3: the claims-side no_candidate names (query hoisted to main scope) ─────────────
      console.log('');
      console.log('='.repeat(112));
      console.log(`ITEM 3 — THE ${ncRes.rows.length} CLAIMS-SIDE 'no_candidate' NAMES, RESCORED WITH BOTH GUARDS`);
      console.log('='.repeat(112));
      let ncClean = 0;
      let ncBlocked = 0;
      let ncFlagged = 0;
      let ncNone = 0;
      let ncCleanLines = 0;
      const ncCleanRows: string[] = [];
      for (const n of ncRes.rows) {
        const ranked = rank(n.alias_norm, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) {
          ncNone++;
          continue;
        }
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(n.alias_norm, surf, idf, maxIdf);
        if (g.block) ncBlocked++;
        else if (g.flag) ncFlagged++;
        else {
          ncClean++;
          ncCleanLines += Number(n.lines);
          if (ncCleanRows.length < 20) {
            ncCleanRows.push(`  ${pad(n.alias_norm, 36)} ${pad(n.lines, 6)} -> ${pad(top.canonical, 30)} @${top.score.toFixed(3)}  [${top.why}]`);
          }
        }
      }
      console.log('SURVIVES BOTH GUARDS (real new coverage, still needs human confirm):');
      for (const l of ncCleanRows) console.log(l);
      if (ncClean > ncCleanRows.length) console.log(`  … ${ncClean - ncCleanRows.length} more`);
      console.log(
        `\n108-stream: survives-both ${ncClean} (${ncCleanLines} lines) · GUARD-A blocked ${ncBlocked} · ` +
          `GUARD-B flagged ${ncFlagged} · no viable candidate ${ncNone}`,
      );
      console.log(
        `  SUM CHECK: ${ncClean} + ${ncBlocked} + ${ncFlagged} + ${ncNone} = ${ncClean + ncBlocked + ncFlagged + ncNone} ` +
          `vs stream total ${ncRes.rows.length}${ncClean + ncBlocked + ncFlagged + ncNone === ncRes.rows.length ? '  OK' : '  <-- MISMATCH'}`,
      );

      // ── ITEM 2 scope: guards applied to the VOB stream ──────────────────────────────────────
      let vClean = 0;
      let vBlocked = 0;
      let vFlagged = 0;
      let vNone = 0;
      let vCleanMembers = 0;
      let vFlaggedMembers = 0;
      const vNoneNames: string[] = [];
      for (const v of vobRes.rows) {
        const ranked = rank(v.nm, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) {
          vNone++;
          vNoneNames.push(v.nm);
          continue;
        }
        const vSuspect = KNOWN_SUSPECT.get(v.nm);
        if (vSuspect) console.log(`  !! ${v.nm} (${v.members} members) -> ${top.canonical} @${top.score.toFixed(3)} — ${vSuspect}`);
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(v.nm, surf, idf, maxIdf);
        if (g.block) vBlocked++;
        else if (g.flag) {
          vFlagged++;
          vFlaggedMembers += Number(v.members);
        } else {
          vClean++;
          vCleanMembers += Number(v.members);
        }
      }
      console.log('');
      console.log('='.repeat(112));
      console.log('ITEM 2 — GUARDS APPLIED TO THE 919-NAME VOB STREAM (all of it, not just >=0.60)');
      console.log('='.repeat(112));
      console.log(
        `  survives both: ${vClean} names (${vCleanMembers} members) · GUARD-A blocked ${vBlocked} · ` +
          `GUARD-B flagged ${vFlagged} (${vFlaggedMembers} members) · no viable candidate ${vNone}`,
      );
      console.log(
        `  SUM CHECK: ${vClean} + ${vBlocked} + ${vFlagged} + ${vNone} = ${vClean + vBlocked + vFlagged + vNone} ` +
          `vs stream total ${vobRes.rows.length}${vClean + vBlocked + vFlagged + vNone === vobRes.rows.length ? '  OK' : '  <-- MISMATCH'}`,
      );
      console.log(`  NO-VIABLE-CANDIDATE LIST (${vNoneNames.length}): ${vNoneNames.sort().join(' | ')}`);

      // ── ITEM 5: Guard-B floor — the 0.10 to 0.15 MARGINAL BAND, named ───────────────────────
      console.log('');
      console.log('='.repeat(112));
      console.log('GUARD-B FLOOR — VOB names flagged at 0.15 but NOT at 0.10 (the band to adjudicate)');
      console.log('='.repeat(112));
      let bandCount = 0;
      let bandMembers = 0;
      for (const v of vobRes.rows) {
        const ranked = rank(v.nm, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) continue;
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const at10 = applyGuards(v.nm, surf, idf, maxIdf, 0.1);
        const at15 = applyGuards(v.nm, surf, idf, maxIdf, 0.15);
        if (at10.block) continue; // Guard A already handles it at either floor
        if (!at10.flag && at15.flag) {
          bandCount++;
          bandMembers += Number(v.members);
          if (bandCount <= 30) {
            console.log(`  ${pad(v.nm, 36)} ${pad(v.members, 5)} -> ${pad(top.canonical, 28)} @${top.score.toFixed(3)}  [${top.why}]`);
          }
        }
      }
      if (bandCount > 30) console.log(`  … ${bandCount - 30} more`);
      console.log(`\n  marginal band: ${bandCount} names, ${bandMembers} members — flagged only at the 0.15 floor`);

      // ── NAMED PROBES — explicit guard verdicts for cases under review ────────────────────────
      console.log('');
      console.log('='.repeat(112));
      console.log('NAMED PROBES — explicit per-case guard verdicts (stated, not implied)');
      console.log('='.repeat(112));
      for (const probe of ['ANTHEM BCBS OF CALIFORNIA', 'UNITED BEHAVIORAL HEALTH', 'BCBS OF FLORIDA', 'AETNA TEXAS']) {
        const ranked = rank(probe, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) {
          console.log(`  ${pad(probe, 28)} NO VIABLE CANDIDATE`);
          continue;
        }
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(probe, surf, idf, maxIdf);
        const verdict = g.block ? 'BLOCKED by GUARD-A' : g.flag ? 'FLAGGED by GUARD-B' : 'SURVIVES BOTH GUARDS';
        console.log(`  ${pad(probe, 28)} -> ${pad(top.canonical, 30)} @${top.score.toFixed(3)}   ${verdict}`);
        console.log(`        drivers: ${top.why}`);
        for (const rr of g.reasons) console.log(`        ${rr}`);
        const sus = KNOWN_SUSPECT.get(probe);
        if (sus) console.log(`        !! ${sus}`);
      }

      // ── ITEM 4: plural folding — Cigna margin ───────────────────────────────────────────────
      console.log('');
      console.log('='.repeat(112));
      console.log(`ITEM 4 — PLURAL FOLDING ${FOLD_PLURALS ? 'ON' : 'OFF'} (--fold-plurals)`);
      console.log('='.repeat(112));
      for (const probe of ['CIGNA HEALTH PLANS', 'OXFORD HEALTH PLANS', 'DEAN HEALTH PLANS']) {
        const ranked = rank(probe, surfaces, idf, maxIdf);
        const t1 = ranked[0];
        const t2 = ranked[1];
        const margin = t1 && t2 ? t1.score - t2.score : NaN;
        console.log(
          `  ${pad(probe, 24)} 1st=${pad(t1?.canonical ?? '-', 26)}@${t1 ? t1.score.toFixed(3) : '-'}  ` +
            `2nd=${pad(t2?.canonical ?? '-', 26)}@${t2 ? t2.score.toFixed(3) : '-'}  MARGIN=${Number.isFinite(margin) ? margin.toFixed(3) : '-'}`,
        );
      }
      console.log(`  IDF: PLAN=${(idf.get(foldPlural('PLAN')) ?? maxIdf).toFixed(2)} PLANS=${(idf.get(foldPlural('PLANS')) ?? maxIdf).toFixed(2)} CIGNA=${(idf.get('CIGNA') ?? maxIdf).toFixed(2)}`);
      console.log(`  corpus tokens: ${idf.size}`);
      console.log(`  CONFIRMED-tier held: ${held}/${testable} (${((100 * held) / Math.max(1, testable)).toFixed(1)}%)`);
    }

    // ── --emit-sql: the 028 payload, generated rather than transcribed ─────────────────────────
    //
    // WHY GENERATE IT. 028 inserts ~700 proposal rows. Hand-transcribing them from a console table
    // would introduce exactly the class of error the guards exist to prevent, and silently: one
    // mis-copied canonical id is a wrong payer merge with a plausible-looking review note attached.
    // Emitting from the same code path that scored them makes the scorer the provenance for the
    // migration, which is why the script is committed alongside it.
    //
    // STILL WRITES NOTHING. This prints SQL to stdout. A human redirects it into a migration file
    // and reads it. There is no DB connection on the write side and no statement issued here.
    if (argv.includes('--emit-sql')) {
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
      const rows: string[] = [];
      let emitClaims = 0;
      let emitVob = 0;

      const noteFor = (name: string, g: GuardVerdict, extra: string | undefined): string | null => {
        const parts: string[] = [];
        if (extra) parts.push(extra);
        if (g.flagC) parts.push('GUARD-C state mismatch: verify the state before accepting.');
        if (parts.length === 0) return null;
        // review_note has a 500-char CHECK (026). Truncate defensively rather than fail the apply.
        const joined = parts.join(' ');
        return joined.length > 500 ? `${joined.slice(0, 497)}...` : joined;
      };

      // (a) claims-side recoveries: names currently provenance='no_candidate' that now resolve.
      for (const n of ncRes.rows) {
        const ranked = rank(n.alias_norm, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) continue;
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(n.alias_norm, surf, idf, maxIdf);
        // Guard A block or Guard B flag => not a proposal. Guard C flag => a proposal WITH a note.
        if (g.block || g.flagB) continue;
        const note = noteFor(n.alias_norm, g, KNOWN_SUSPECT.get(n.alias_norm));
        rows.push(
          `  (${q('claims_primary_payer')}, ${q(n.alias_norm)}, ${q(top.canonical)}, ${top.score.toFixed(3)}, ${note ? q(note) : 'null'})`,
        );
        emitClaims++;
      }

      // (b) VOB-side population: unmapped carrier names that survive both guards.
      for (const v of vobRes.rows) {
        const ranked = rank(v.nm, surfaces, idf, maxIdf);
        const top = ranked[0];
        if (!top) continue;
        const surf: Surface = { canonical: top.canonical, display: top.display, surface: top.via, vec: vectorize(top.via, idf, maxIdf) };
        const g = applyGuards(v.nm, surf, idf, maxIdf);
        if (g.block || g.flagB) continue;
        const note = noteFor(v.nm, g, KNOWN_SUSPECT.get(v.nm));
        rows.push(
          `  (${q('vob_insurance_co')}, ${q(v.nm)}, ${q(top.canonical)}, ${top.score.toFixed(3)}, ${note ? q(note) : 'null'})`,
        );
        emitVob++;
      }

      console.log('');
      console.log('-- ==== BEGIN 028 PAYLOAD (generated by scripts/score-payer-aliases.ts) ====');
      console.log(`-- claims-side recoveries: ${emitClaims} · VOB-side population: ${emitVob} · total ${rows.length}`);
      console.log(`-- guard config: Guard A on · Guard B floor ${GUARD_B_MIN_SHARE} · Guard C on · plural folding ${FOLD_PLURALS ? 'ON' : 'OFF'}`);
      console.log('_028_PAYLOAD_ROWS_BEGIN');
      console.log(rows.join(',\n'));
      console.log('_028_PAYLOAD_ROWS_END');
      console.log('-- ==== END 028 PAYLOAD ====');
    }

    console.log('');
    console.log('This script wrote NOTHING to the database.');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
