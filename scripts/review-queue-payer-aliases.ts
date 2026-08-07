/**
 * PAYER-ALIAS REVIEW QUEUE — the work item for step 1, ordered by how much of the book it unblocks.
 *
 * WHY THIS EXISTS. Every crosswalk join in src/collections/qualifyResolutionQuery.ts carries
 * `and not m.needs_review` (6 sites), so an UNCONFIRMED alias resolves nothing. Measured live
 * 2026-08-06: 646 of 847 VOB-side aliases are unreviewed idf_cosine proposals covering 11,174 VOBs.
 * No algorithm change moves a downstream number until a human ratifies rows — this queue is that
 * work, sorted so the smallest number of decisions covers the most volume.
 *
 * Volume is brutally concentrated: the top 20 spellings are 63.7% of the book and the top 200 are
 * 91.9%, so ~200 decisions is the whole job for practical purposes.
 *
 * ┌─ THIS SCRIPT RECOMMENDS. ONLY A HUMAN CONFIRMS. ──────────────────────────────────────────────┐
 * │ Setting needs_review = false ESTABLISHES PAYER IDENTITY, and this repo's standing rule is that │
 * │ a machine proposal may never resolve a payer (SQL Schemas/026 header, 028 §5 guard). So this   │
 * │ file writes nothing and its RECOMMENDATION column is advisory. The confirmations themselves    │
 * │ are a reviewed migration authored from the decisions made here.                                │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IT DOES NOT DO:
 *   - WRITES NOTHING. claims_reader pool (SELECT-only grants per 026 §4), SELECTs only. No
 *     INSERT/UPDATE/DELETE/temp table/transaction exists in this file.
 *   - Projects no PHI: payer name strings, plan-type codes, aggregate counts. Payer identity is
 *     public information (same posture as intel.*, SQL Schemas/025).
 *
 *   node --env-file=.env --import tsx scripts/review-queue-payer-aliases.ts
 *   node --env-file=.env --import tsx scripts/review-queue-payer-aliases.ts --top 200 --csv queue.csv
 */
import { writeFileSync } from 'node:fs';

import { makeClient } from '../src/collections/db.js';
import { statesIn } from './lib/usStates.js';

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const TOP = Number(opt('top') ?? 200);
const CSV_OUT = opt('csv');

/**
 * Strings that name a company but NO product line, state or other discriminator. A high cosine
 * score cannot rescue these — the input is underspecified, not mis-scored — so they must never
 * auto-confirm however the threshold moves. Measured: bare "UHC" (944 VOBs) is proposed at 0.510
 * to `pi_united_healthcare_medicare_advantage`, i.e. to a MEDICARE product, on no evidence at all.
 */
const STRUCTURALLY_AMBIGUOUS = new Set([
  'UHC', 'BCBS', 'ANTHEM', 'BLUE CROSS BLUE SHIELD', 'BCBS FED', 'REGENCE BCBS',
  'EMPIRE BCBS', 'WELLMARK BCBS', 'HIGHMARK BCBS', 'CAREFIRST BCBS', 'INDEPENDENCE BCBS',
  'ANTHEM BCBS', 'BCBS REGENCE', 'PREMERA BC', 'KAISER', 'MEDICARE', 'TRICARE',
]);

type Action = 'REJECT' | 'MANUAL-ONLY' | 'CONFIRM' | 'REVIEW' | 'NEW-IDENTITY';

interface Row {
  spelling: string;
  vobs: number;
  canonical: string | null;
  display: string | null;
  needsReview: boolean | null;
  confidence: number | null;
  provenance: string | null;
  action: Action;
  why: string;
}

async function main(): Promise<void> {
  const url = process.env.CLAIMS_READER_DATABASE_URL;
  if (!url) throw new Error('CLAIMS_READER_DATABASE_URL not set');
  const db = makeClient(url);

  try {
    const res = await db.query<{
      spelling: string; vobs: string; canonical_payer_id: string | null; display_name: string | null;
      needs_review: boolean | null; confidence: string | null; provenance: string | null;
    }>(
      `with v as (
         select upper(btrim(insurance_co)) as spelling, count(*) as vobs
           from vob.indigo_vob
          where nullif(btrim(insurance_co), '') is not null
          group by 1
       )
       select v.spelling, v.vobs::text as vobs, m.canonical_payer_id, pi.display_name,
              m.needs_review, m.confidence::text as confidence, m.provenance
         from v
         left join ref.payer_alias_map m
                on m.vocabulary = 'vob_insurance_co' and m.alias_norm = v.spelling
         left join ref.payer_identity pi
                on pi.canonical_payer_id = m.canonical_payer_id
        order by v.vobs desc, v.spelling`,
    );

    // The group's HOME states come from its CONFIRMED spellings only — the sole human-ratified
    // evidence of what the group is. Built over ALL rows, then applied to the top-N slice.
    const home = new Map<string, Set<string>>();
    for (const r of res.rows) {
      if (r.canonical_payer_id === null || r.needs_review !== false) continue;
      const set = home.get(r.canonical_payer_id) ?? new Set<string>();
      for (const s of statesIn(r.spelling)) set.add(s);
      home.set(r.canonical_payer_id, set);
    }

    const queue: Row[] = [];
    for (const r of res.rows) {
      const vobs = Number(r.vobs);
      const conf = r.confidence === null ? null : Number(r.confidence);
      const base = {
        spelling: r.spelling, vobs,
        canonical: r.canonical_payer_id, display: r.display_name,
        needsReview: r.needs_review, confidence: conf, provenance: r.provenance,
      };

      if (r.canonical_payer_id === null) {
        queue.push({
          ...base,
          action: 'NEW-IDENTITY',
          why: r.needs_review === null
            ? 'not in the crosswalk at all — needs an identity decision before it can be mapped'
            : `explicitly ${r.provenance ?? 'unmapped'} — confirm that is still right`,
        });
        continue;
      }
      if (r.needs_review === false) continue; // already ratified; not review work

      const named = [...statesIn(r.spelling)];
      const groupHome = home.get(r.canonical_payer_id) ?? new Set<string>();
      const foreign = named.filter((s) => !groupHome.has(s));

      if (groupHome.size > 0 && named.length > 0 && foreign.length === named.length) {
        queue.push({
          ...base,
          action: 'REJECT',
          why: `names ${foreign.join(', ')} but the group's confirmed spellings name ${[...groupHome].join(', ')}`,
        });
      } else if (STRUCTURALLY_AMBIGUOUS.has(r.spelling)) {
        queue.push({
          ...base,
          action: 'MANUAL-ONLY',
          why: 'names no state or product line — structurally underspecified, so no score can resolve it; flag manual-only',
        });
      } else if (conf !== null && conf >= 0.9 && named.length > 0 && foreign.length === 0) {
        queue.push({ ...base, action: 'CONFIRM', why: `confidence ${conf.toFixed(3)}, state agrees with the group` });
      } else if (conf !== null && conf < 0.6) {
        queue.push({ ...base, action: 'REVIEW', why: `low confidence ${conf.toFixed(3)} — read the name before accepting` });
      } else {
        queue.push({
          ...base,
          action: 'REVIEW',
          why: conf === null ? 'no confidence score recorded' : `confidence ${conf.toFixed(3)}, no state token to cross-check`,
        });
      }
    }

    const slice = queue.slice(0, TOP);
    const covered = slice.reduce((s, r) => s + r.vobs, 0);
    const allVobs = res.rows.reduce((s, r) => s + Number(r.vobs), 0);

    const line = '─'.repeat(112);
    console.log(`\nPAYER-ALIAS REVIEW QUEUE — top ${slice.length} unresolved spellings by VOB volume`);
    console.log(`${covered.toLocaleString('en-US')} of ${allVobs.toLocaleString('en-US')} VOBs ` +
      `(${((100 * covered) / allVobs).toFixed(1)}%) ride on these decisions\n${line}`);
    console.log(
      `${'ACTION'.padEnd(13)}${'VOBs'.padStart(6)}  ${'SPELLING AS TYPED'.padEnd(44)}${'PROPOSED PAYER'.padEnd(34)}WHY`,
    );
    console.log(line);
    for (const r of slice) {
      console.log(
        `${r.action.padEnd(13)}${String(r.vobs).padStart(6)}  ${r.spelling.slice(0, 43).padEnd(44)}` +
        `${(r.display ?? '—').slice(0, 33).padEnd(34)}${r.why}`,
      );
    }

    console.log(`${line}\nBy action:`);
    for (const a of ['REJECT', 'MANUAL-ONLY', 'CONFIRM', 'REVIEW', 'NEW-IDENTITY'] as Action[]) {
      const b = slice.filter((r) => r.action === a);
      if (b.length === 0) continue;
      console.log(`  ${a.padEnd(13)} ${String(b.length).padStart(4)} spellings  ${b.reduce((s, r) => s + r.vobs, 0).toLocaleString('en-US').padStart(7)} VOBs`);
    }
    console.log('\nNothing has been confirmed. Every row above is a recommendation for a human.\n');

    if (CSV_OUT !== null) {
      const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`;
      const csv = [
        'action,vobs,spelling,canonical_payer_id,proposed_payer,confidence,provenance,why,DECISION',
        ...slice.map((r) =>
          [
            r.action, String(r.vobs), esc(r.spelling), r.canonical ?? '', esc(r.display ?? ''),
            r.confidence === null ? '' : r.confidence.toFixed(3), r.provenance ?? '', esc(r.why), '',
          ].join(','),
        ),
      ].join('\n');
      writeFileSync(CSV_OUT, `${csv}\n`);
      console.log(`wrote ${CSV_OUT} — fill the DECISION column, then author the confirming migration from it.\n`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
