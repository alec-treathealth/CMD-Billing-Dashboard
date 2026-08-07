/**
 * DUPLICATE CANONICAL-IDENTITY AUDIT — produces a REVIEW QUEUE, never a merge.
 *
 * WHY THIS EXISTS. `ref.payer_identity` mints one row per real-world billing entity, but the ids
 * were generated from source text by several different seeds (026 §6a literal, §7a derived slug,
 * 027 dedup, 028 payload). Non-idempotent id generation means one company can end up holding two
 * ids, and every ranking that scopes by payer then sees it as two smaller payers. Measured live
 * 2026-08-06: Blue Shield of California is split across `pi_blue_shield_california` (1,560 VOBs)
 * and `pi_blue_shield_of_california` (1,288) — 2,848 VOBs ranked as two payers.
 *
 * ┌─ THIS SCRIPT PROPOSES. IT NEVER MERGES, AND IT NEVER WRITES. ─────────────────────────────────┐
 * │ A merge is destructive and irreversible in practice: it rewrites the canonical id that every   │
 * │ confirmed alias row points at. Two identities that LOOK like duplicates can be two real legal  │
 * │ entities — see the SPLIT_RISK rule below, which is the whole reason plan_type is in here.      │
 * │ Output is a queue for a human. The merge itself is a separate, reviewed migration.             │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * FIVE PASSES, BECAUSE NO SINGLE NORMALIZATION FINDS THEM ALL. Each line below names a pair that
 * ONLY that pass catches on the live book, which is why none of them can be dropped:
 *
 *   1. SAME_CARRIER    `sameCarrier` on the two display names — the display layer's own ruling.
 *                      ONLY pass that finds ANTHEM CONNECTICUT / ANTHEM BCBS OF CT (93 VOBs): the
 *                      extra tokens are BLUE/CROSS/SHIELD, which are filler only because both names
 *                      share the ANTHEM anchor — a conditional no set-comparison can express.
 *   2. SQUASH          letters only. ONLY pass that finds HEALTH NET / HEALTHNET — {HEALTH,NET} and
 *                      {HEALTHNET} share no token, so every token-based rule is blind to it.
 *   3. TOKENS          exact carrierTokens set equality. Subsumed by pass 1 in practice; kept
 *                      because it is independent of sameCarrier's filler rules.
 *   4. TOKENS_SINGULAR token sets equal after a trailing-S fold. Catches plural-only pairs.
 *   5. SUBSET          proper subset where the EXTRA tokens are all generic. ONLY pass that finds
 *                      MERITAIN HEALTH / MERITAIN and MODA HEALTH / MODA.
 *
 * An earlier version of this plan proposed passes 2 and 3 alone. Measured, that pair finds ONE of
 * the six live merge candidates (Health Net) and misses 9,006 VOBs of duplicate volume — including
 * Blue Shield of California, the largest split in the book.
 *
 * WHAT IT DOES NOT DO:
 *   - WRITES NOTHING. Opens a claims_reader pool (SELECT-only grants, per 026 §4) and issues
 *     SELECTs. No INSERT/UPDATE/DELETE/temp table/transaction exists in this file.
 *   - Does not decide. Every pair carries a VERDICT that is a recommendation with its reason.
 *   - Projects no PHI: payer name strings, plan-type codes and aggregate counts only. No member id,
 *     member token, patient name, employer, group number or dollar. Payer identity is public
 *     information (same posture as intel.*, SQL Schemas/025).
 *
 *   node --env-file=.env --import tsx scripts/audit-payer-identity-duplicates.ts
 *   node --env-file=.env --import tsx scripts/audit-payer-identity-duplicates.ts --json out.json
 */
import { writeFileSync } from 'node:fs';

import { buildTokenCanonicalizer, carrierTokens, sameCarrier } from '../app/lib/qualify/carrierCluster.js';
import { makeClient } from '../src/collections/db.js';

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
const JSON_OUT = opt('json');

/**
 * Tokens that identify no company on their own. A candidate whose ENTIRE shared vocabulary is
 * generic is reported at LOW confidence rather than suppressed — measured: "THE HEALTH PLAN" (WV)
 * and "HEALTH PLANS INC" (MA) both reduce to {HEALTH} because THE/PLAN/PLANS/INC are all NOISE in
 * carrierTokens. They are different companies. Suppressing would hide it; auto-merging would fuse
 * two real payers.
 */
const GENERIC = new Set([
  'HEALTH', 'HEALTHCARE', 'CARE', 'GROUP', 'BENEFIT', 'BENEFITS', 'SYSTEM', 'SYSTEMS',
  'INSURANCE', 'LIFE', 'NETWORK', 'ADMINISTRATOR', 'ADMINISTRATORS', 'SERVICES', 'TRUST',
  'NATIONAL', 'AMERICAN', 'MEDICAL', 'FIRST', 'SELECT', 'CHOICE', 'ADVANTAGE',
]);

/** HMO share inside this band reads as a genuine two-entity split rather than product mix. */
const SPLIT_BAND_LO = 0.35;
const SPLIT_BAND_HI = 0.65;
/** Below this VOB count an HMO share is noise, not evidence. */
const SPLIT_MIN_ROWS = 20;
/** Percentage-point gap in HMO share that, on its own, argues the two ids are different entities. */
const SPLIT_DELTA = 0.2;

interface Identity {
  canonical: string;
  display: string;
  family: string | null;
  entityKind: string | null;
  rows: number;
  spellings: number;
  confirmed: number;
  hmo: number;
  commercial: number;
}

type Verdict =
  | 'MERGE_CANDIDATE'
  | 'SPLIT_RISK — entity review'
  | 'LOW_CONFIDENCE — generic tokens'
  | 'NEVER_MERGE — already ruled by a human';

interface Candidate {
  pass: 'SAME_CARRIER' | 'SQUASH' | 'TOKENS' | 'TOKENS_SINGULAR' | 'SUBSET';
  key: string;
  survivor: Identity;
  absorbed: Identity;
  verdict: Verdict;
  reason: string;
}

const squash = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokenKey = (s: string): string => [...new Set(carrierTokens(s))].sort().join(' ');
/** Trailing-S fold only. Deliberately not a stemmer — "BENEFITS"→"BENEFIT", never "BUSINESS"→"BUSINES". */
const foldPlural = (t: string): string => (t.length > 4 && t.endsWith('S') && !t.endsWith('SS') ? t.slice(0, -1) : t);
const hmoShare = (i: Identity): number | null => {
  const known = i.hmo + i.commercial;
  return known === 0 ? null : i.hmo / known;
};

/** Classify a pair. Order matters: a split risk outranks a generic-token warning. */
function classify(a: Identity, b: Identity): { verdict: Verdict; reason: string } {
  const sa = hmoShare(a);
  const sb = hmoShare(b);
  const bothMeasurable = sa !== null && sb !== null && a.rows >= SPLIT_MIN_ROWS && b.rows >= SPLIT_MIN_ROWS;

  if (bothMeasurable) {
    const nearEven = [sa, sb].filter((s) => s >= SPLIT_BAND_LO && s <= SPLIT_BAND_HI);
    if (nearEven.length > 0) {
      return {
        verdict: 'SPLIT_RISK — entity review',
        reason:
          `HMO share ${pct(sa)} / ${pct(sb)} — a near-even split is the signature of two legal ` +
          `entities under one brand (HMO co. vs life-insurance co.), not one payer typed two ways`,
      };
    }
    if (Math.abs(sa - sb) > SPLIT_DELTA) {
      return {
        verdict: 'SPLIT_RISK — entity review',
        reason: `HMO share differs by ${pct(Math.abs(sa - sb))} (${pct(sa)} vs ${pct(sb)}) — the two ids may carry different product lines`,
      };
    }
  }

  // The evidence for a duplicate is the tokens the two names SHARE. If every shared token is
  // generic, the pair is matching on vocabulary that identifies no company.
  const ta = new Set(carrierTokens(a.display));
  const tb = new Set(carrierTokens(b.display));
  const shared = [...ta].filter((t) => tb.has(t));
  if (shared.length === 0 || shared.every((t) => GENERIC.has(t))) {
    return {
      verdict: 'LOW_CONFIDENCE — generic tokens',
      reason:
        shared.length === 0
          ? 'the names share no distinguishing token at all'
          : `the only shared vocabulary is generic (${shared.join(', ')}) — likely two different companies`,
    };
  }

  return {
    verdict: 'MERGE_CANDIDATE',
    reason: bothMeasurable
      ? `HMO share agrees (${pct(sa)} / ${pct(sb)}) and the names share distinctive tokens`
      : 'names share distinctive tokens; volume too low to test the product mix',
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;

/**
 * Survivor = more VOB volume, then more confirmed spellings, then the shorter id. Deterministic.
 *
 * VOLUME LEADS, not confirmed count, and the reason is mechanical: a merge RE-POINTS alias rows at
 * the surviving id, so a confirmed alias survives either way and its human ratification is not lost
 * by absorbing it. Volume is what the book actually uses, so keeping the dominant id minimises churn
 * in everything that already references it. (Ranking by confirmed count first put the 11-VOB
 * `pi_anthem_bcbs_of_ct` ahead of the 82-VOB `pi_anthem_connecticut`, which is backwards.)
 *
 * The DISPLAY NAME is a separate decision from the surviving ID, and this script does not make it —
 * the reviewer may well want the absorbed row's wording on the surviving id.
 */
function pickSurvivor(a: Identity, b: Identity): [Identity, Identity] {
  if (a.rows !== b.rows) return a.rows > b.rows ? [a, b] : [b, a];
  if (a.confirmed !== b.confirmed) return a.confirmed > b.confirmed ? [a, b] : [b, a];
  return a.canonical.length <= b.canonical.length ? [a, b] : [b, a];
}

async function main(): Promise<void> {
  const url = process.env.CLAIMS_READER_DATABASE_URL;
  if (!url) throw new Error('CLAIMS_READER_DATABASE_URL not set');
  const db = makeClient(url);

  try {
    // Explicit column projection; every identifier a fixed literal. plan_type buckets are listed
    // exhaustively so an unrecognized code lands in neither hmo nor commercial rather than being
    // silently counted as commercial.
    const res = await db.query<{
      canonical: string; display: string; family: string | null; entity_kind: string | null;
      rows: string; spellings: string; confirmed: string; hmo: string; commercial: string;
    }>(
      `with v as (
         select upper(btrim(insurance_co)) as alias_norm,
                upper(coalesce(nullif(btrim(plan_type), ''), '?')) as plan_type,
                count(*) as n
           from vob.indigo_vob
          where nullif(btrim(insurance_co), '') is not null
          group by 1, 2
       ),
       j as (
         select m.canonical_payer_id, m.alias_norm, m.needs_review, v.plan_type, v.n
           from v
           join ref.payer_alias_map m
             on m.vocabulary = 'vob_insurance_co' and m.alias_norm = v.alias_norm
          where m.canonical_payer_id is not null
       )
       select pi.canonical_payer_id as canonical,
              pi.display_name       as display,
              pi.payer_family       as family,
              pi.entity_kind        as entity_kind,
              coalesce(sum(j.n), 0)::text                                            as rows,
              count(distinct j.alias_norm)::text                                      as spellings,
              count(distinct j.alias_norm) filter (where not j.needs_review)::text    as confirmed,
              coalesce(sum(j.n) filter (where j.plan_type = 'HMO'), 0)::text          as hmo,
              coalesce(sum(j.n) filter (
                where j.plan_type in ('PPO','EPO','POS','OAP','ASO','OA','OPA','AOP','RPO','HDHP','QHD','INDEMNITY')
              ), 0)::text                                                             as commercial
         from ref.payer_identity pi
         join j on j.canonical_payer_id = pi.canonical_payer_id
        group by 1, 2, 3, 4
        order by 5 desc`,
    );

    const ids: Identity[] = res.rows.map((r) => ({
      canonical: r.canonical,
      display: r.display,
      family: r.family,
      entityKind: r.entity_kind,
      rows: Number(r.rows),
      spellings: Number(r.spellings),
      confirmed: Number(r.confirmed),
      hmo: Number(r.hmo),
      commercial: Number(r.commercial),
    }));

    // ── The human rulings this audit must never overrule ────────────────────────────────────────
    //
    // ⚠ 027 created `ref.payer_identity_never_merge`: pairs a human EXPLICITLY ruled are different
    // payers, with `ruled_by` and `ruled_at`. Six rows as of 2026-08-07, including
    // pi_anthem_california / pi_blue_shield_california — the exact California Cross-vs-Shield case
    // `carrierCluster.ts` also pins a test on.
    //
    // Without this lookup the audit re-derives merge candidates from names and volume alone and will
    // eventually re-propose a pair a human already forbade — a machine overruling a human ruling,
    // which is the one failure every other layer of this system is built to prevent (the crosswalk
    // outranks text in clusterCarriers; a proposal never resolves a payer in the alias map). The
    // audit was missing it; no current pair collides, which was luck rather than design.
    const neverRes = await db.query<{ id_low: string; id_high: string; reason: string; ruled_by: string }>(
      `select id_low, id_high, reason, ruled_by from ref.payer_identity_never_merge`,
    );
    const neverMerge = new Map<string, { reason: string; ruledBy: string }>();
    for (const r of neverRes.rows) {
      neverMerge.set([r.id_low, r.id_high].sort().join('::'), { reason: r.reason, ruledBy: r.ruled_by });
    }

    const seen = new Set<string>();
    const out: Candidate[] = [];
    const pairKey = (a: Identity, b: Identity): string => [a.canonical, b.canonical].sort().join('::');

    const addPair = (pass: Candidate['pass'], key: string, a: Identity, b: Identity): void => {
      const pk = pairKey(a, b);
      if (seen.has(pk)) return; // an earlier pass already reported it; passes run most-precise first
      seen.add(pk);
      const [survivor, absorbed] = pickSurvivor(a, b);
      const ruled = neverMerge.get(pk);
      // A human ruling OUTRANKS every heuristic below it. Reported, not silently dropped, so the
      // reader can see the audit found the pair and was overruled — a silent filter would leave a
      // future maintainer wondering why an obvious-looking duplicate never appears.
      if (ruled !== undefined) {
        out.push({
          pass, key, survivor, absorbed,
          verdict: 'NEVER_MERGE — already ruled by a human',
          reason: `ruled by ${ruled.ruledBy}: ${ruled.reason}`,
        });
        return;
      }
      out.push({ pass, key, survivor, absorbed, ...classify(a, b) });
    };

    // ── Pass 1: SAME_CARRIER — the display layer's OWN ruling, reused rather than reimplemented. ─
    //
    // `sameCarrier` already encodes the hard-won rules: BLUE/CROSS/SHIELD are filler when the two
    // names share a company anchor but distinguishing when they don't, geography is never an anchor,
    // and cores must be EQUAL rather than overlapping. Applying it to two DISPLAY NAMES asks exactly
    // the right question — "would the payer stage show these as one tile?" — and if the answer is
    // yes while they hold two canonical ids, that is the duplicate-identity bug by definition.
    //
    // This is what catches ANTHEM CONNECTICUT vs ANTHEM BCBS OF CT (93 VOBs), which every set-based
    // pass below misses: the extra tokens are BLUE/CROSS/SHIELD, which are filler ONLY because both
    // names share the ANTHEM anchor — a rule the subset pass cannot express.
    const canon = buildTokenCanonicalizer(ids.map((i) => i.display));
    const sets = new Map<string, Set<string>>();
    for (const i of ids) sets.set(i.canonical, new Set(carrierTokens(i.display).map(canon)));
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const a = ids[x] as Identity;
        const b = ids[y] as Identity;
        const sa = sets.get(a.canonical);
        const sb = sets.get(b.canonical);
        if (!sa || !sb || sa.size === 0 || sb.size === 0) continue;
        if (!sameCarrier(sa, sb)) continue;
        addPair('SAME_CARRIER', [...sa].sort().join(' '), a, b);
      }
    }

    // ── Pass 2: SQUASH — identical once punctuation and whitespace are removed. ──────────────────
    // Still earns its place: HEALTH NET tokenizes to {HEALTH,NET} and HEALTHNET to {HEALTHNET}, so
    // no token-based rule — sameCarrier included — can relate them.
    const bySquash = new Map<string, Identity[]>();
    for (const i of ids) bySquash.set(squash(i.display), [...(bySquash.get(squash(i.display)) ?? []), i]);
    for (const [k, group] of bySquash) {
      for (let x = 0; x < group.length; x++) {
        for (let y = x + 1; y < group.length; y++) addPair('SQUASH', k, group[x] as Identity, group[y] as Identity);
      }
    }

    // ── Pass 3: TOKENS — identical distinguishing-token SETS (so OF/INC/PLAN drop out). ──────────
    const byTokens = new Map<string, Identity[]>();
    for (const i of ids) {
      const k = tokenKey(i.display);
      if (k === '') continue; // a name made entirely of noise words identifies nothing
      byTokens.set(k, [...(byTokens.get(k) ?? []), i]);
    }
    for (const [k, group] of byTokens) {
      for (let x = 0; x < group.length; x++) {
        for (let y = x + 1; y < group.length; y++) addPair('TOKENS', k, group[x] as Identity, group[y] as Identity);
      }
    }

    // ── Pass 4: TOKENS_SINGULAR — token sets equal once trailing plurals are folded. ─────────────
    // Catches CBA ADMINISTRATOR / CBA ADMINISTRATORS, which SQUASH misses (the strings differ by a
    // letter) and TOKENS misses (ADMINISTRATOR and ADMINISTRATORS are two different tokens).
    const bySingular = new Map<string, Identity[]>();
    for (const i of ids) {
      const k = [...new Set(carrierTokens(i.display).map(foldPlural))].sort().join(' ');
      if (k === '') continue;
      bySingular.set(k, [...(bySingular.get(k) ?? []), i]);
    }
    for (const [k, group] of bySingular) {
      for (let x = 0; x < group.length; x++) {
        for (let y = x + 1; y < group.length; y++) {
          addPair('TOKENS_SINGULAR', k, group[x] as Identity, group[y] as Identity);
        }
      }
    }

    // ── Pass 5: SUBSET — one id's tokens are a proper subset AND the extra tokens are all generic.
    //
    // ⚠ THE "EXTRA TOKENS MUST BE GENERIC" CLAUSE IS THE WHOLE SAFETY CASE. A bare proper-subset
    // test is far too permissive and contradicts the display layer's own rule that "a stateless name
    // never merges into a state-specific one" (carrierCluster.ts). Measured without the clause, this
    // pass proposed 96 merges over 30,040 VOBs, including:
    //     Anthem BCBS of Indiana ⟵ ANTHEM BCBS     ({ANTHEM,BLUE,CROSS,SHIELD} ⊂ …+INDIANA)
    //     CIGNA                  ⟵ CIGNA WEST      (extra token is a REGION, i.e. distinguishing)
    //     HEALTH NET             ⟵ HEALTH PLANS INC ({HEALTH} ⊂ {HEALTH,NET} — a generic anchor)
    // None of those is a duplicate identity; each is a real distinction the extra token carries.
    // Requiring the difference to be generic-only narrows this to the shape it was built for:
    // "<brand>" vs "<brand> HEALTH".
    const toks = new Map<string, Set<string>>();
    for (const i of ids) toks.set(i.canonical, new Set(carrierTokens(i.display)));
    for (let x = 0; x < ids.length; x++) {
      for (let y = 0; y < ids.length; y++) {
        if (x === y) continue;
        const a = ids[x] as Identity;
        const b = ids[y] as Identity;
        const ta = toks.get(a.canonical);
        const tb = toks.get(b.canonical);
        if (!ta || !tb || ta.size === 0 || ta.size >= tb.size) continue;
        if (![...ta].every((t) => tb.has(t))) continue;
        // The smaller name must itself identify a company...
        if ([...ta].every((t) => GENERIC.has(t))) continue;
        // ...and everything the larger name adds must be generic, or it is a real distinction.
        const extra = [...tb].filter((t) => !ta.has(t));
        if (!extra.every((t) => GENERIC.has(t))) continue;
        addPair('SUBSET', `${[...ta].sort().join(' ')} + {${extra.join(', ')}}`, a, b);
      }
    }

    // ── Report ──────────────────────────────────────────────────────────────────────────────────
    const order: Record<Verdict, number> = {
      'MERGE_CANDIDATE': 0,
      'SPLIT_RISK — entity review': 1,
      'LOW_CONFIDENCE — generic tokens': 2,
      'NEVER_MERGE — already ruled by a human': 3,
    };
    out.sort(
      (p, q) =>
        order[p.verdict] - order[q.verdict] ||
        q.survivor.rows + q.absorbed.rows - (p.survivor.rows + p.absorbed.rows),
    );

    const line = '─'.repeat(96);
    console.log(`\nDUPLICATE CANONICAL-IDENTITY AUDIT — ${ids.length} identities carrying VOB volume\n${line}`);
    for (const v of Object.keys(order) as Verdict[]) {
      const bucket = out.filter((cd) => cd.verdict === v);
      const vobs = bucket.reduce((s, cd) => s + cd.survivor.rows + cd.absorbed.rows, 0);
      console.log(`\n### ${v} — ${bucket.length} pair(s), ${vobs.toLocaleString('en-US')} VOBs\n`);
      for (const cd of bucket) {
        console.log(`  [${cd.pass}] ${cd.survivor.display}  ⟵  ${cd.absorbed.display}`);
        console.log(
          `      keep    ${cd.survivor.canonical.padEnd(46)} ${String(cd.survivor.rows).padStart(5)} VOBs  ` +
          `${cd.survivor.confirmed}/${cd.survivor.spellings} confirmed  HMO ${fmtShare(cd.survivor)}`,
        );
        console.log(
          `      absorb  ${cd.absorbed.canonical.padEnd(46)} ${String(cd.absorbed.rows).padStart(5)} VOBs  ` +
          `${cd.absorbed.confirmed}/${cd.absorbed.spellings} confirmed  HMO ${fmtShare(cd.absorbed)}`,
        );
        console.log(`      why     ${cd.reason}\n`);
      }
    }
    console.log(`${line}\nNothing above has been applied. This is a review queue.`);
    console.log('A merge is a separate reviewed migration; SPLIT_RISK pairs should probably NOT merge at all.\n');

    if (JSON_OUT !== null) {
      writeFileSync(JSON_OUT, JSON.stringify({ identities: ids.length, candidates: out }, null, 1));
      console.log(`wrote ${JSON_OUT}\n`);
    }
  } finally {
    await db.end();
  }
}

function fmtShare(i: Identity): string {
  const s = hmoShare(i);
  return s === null ? ' n/a' : `${(100 * s).toFixed(0)}%`.padStart(4);
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
