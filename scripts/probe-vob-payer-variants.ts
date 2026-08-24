/**
 * THROWAWAY READ-ONLY VOB PAYER-NAME VARIANT PROBE — NOT AN ARTIFACT. DO NOT COMMIT.
 *
 * PURPOSE: answer "which payers do our VOBs spell more than one way, what groupings already
 * exist, and where is a grouping wrong?" and emit a self-contained HTML report.
 *
 * WHAT IT DOES NOT DO:
 *   - WRITES NOTHING. Opens a READ-ONLY claims_reader pool and issues SELECTs only. No INSERT,
 *     UPDATE, temp table or transaction — so "no writes" is structural, not a promise.
 *   - Does not propose a resolution. Every machine grouping it prints is labelled with its
 *     needs_review state; a proposal is never rendered as if it were confirmed.
 *   - Projects no PHI. It selects payer NAME strings and aggregate counts. No member id, member
 *     token, patient name, employer, group number, or dollar. Payer identity is public
 *     information (same posture as intel.*, SQL Schemas/025).
 *
 * The clustering used for the "no grouping at all" tail is the SHIPPED display-clustering module
 * (app/lib/qualify/carrierCluster.ts), imported as-is rather than reimplemented, so what this
 * report proposes is exactly what the payer stage would render.
 *
 *   node --env-file=.env --import tsx scripts/probe-vob-payer-variants.ts > /tmp/out.html
 */
import { writeFileSync } from 'node:fs';

import { clusterCarriers, carrierTokens } from '../app/lib/qualify/carrierCluster.js';
import { makeClient } from '../src/collections/db.js';

const OUT = process.argv[2] ?? 'vob-payer-variants.html';

// ── State detection, for the "this grouping mixes states" outlier rule ───────────────────────────
// Deliberately the same idiom as carrierCluster's STATES/STATE_NAMES: a payer named for one state
// and grouped under another is the single most common way an automated merge goes wrong here.
const CODE_TO_STATE: Record<string, string> = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA', CO: 'COLORADO',
  CT: 'CONNECTICUT', DE: 'DELAWARE', DC: 'DC', FL: 'FLORIDA', GA: 'GEORGIA', HI: 'HAWAII',
  ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA', KS: 'KANSAS', KY: 'KENTUCKY',
  LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND', MA: 'MASSACHUSETTS', MI: 'MICHIGAN',
  MN: 'MINNESOTA', MS: 'MISSISSIPPI', MO: 'MISSOURI', MT: 'MONTANA', NE: 'NEBRASKA',
  NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO', NY: 'NEW YORK',
  NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA', OR: 'OREGON',
  PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA', SD: 'SOUTH DAKOTA',
  TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT', VA: 'VIRGINIA', WA: 'WASHINGTON',
  WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING',
};
// Longest-first so "WEST VIRGINIA" wins over "VIRGINIA" and "NORTH DAKOTA" over "DAKOTA".
const STATE_PHRASES = [...new Set(Object.values(CODE_TO_STATE))].sort((a, b) => b.length - a.length);

/** Every US state a payer-name string names, by spelled-out phrase or by bare 2-letter code. */
function statesIn(raw: string): Set<string> {
  const up = ` ${raw.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  let rest = up;
  for (const phrase of STATE_PHRASES) {
    if (rest.includes(` ${phrase} `)) {
      out.add(phrase);
      rest = rest.split(` ${phrase} `).join(' '); // consume, so VIRGINIA can't re-match WEST VIRGINIA
    }
  }
  for (const tok of rest.trim().split(' ')) {
    const s = CODE_TO_STATE[tok];
    if (s !== undefined) out.add(s);
  }
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────────────────────────
interface Row {
  spelling: string;
  rows: number;
  facilities: number;
  canonical: string | null;
  display: string | null;
  relationship: string | null;
  provenance: string | null;
  needsReview: boolean | null;
  confidence: number | null;
  reviewNote: string | null;
}

interface Member {
  spelling: string;
  rows: number;
  facilities: number;
  confirmed: boolean;
  provenance: string;
  confidence: number | null;
  states: string[];
  misfiled: boolean;
  why: string;
}

async function main(): Promise<void> {
  const url = process.env.CLAIMS_READER_DATABASE_URL;
  if (!url) throw new Error('CLAIMS_READER_DATABASE_URL not set');
  const db = makeClient(url);

  try {
    // Explicit column projection; every identifier a fixed literal; no bound values needed.
    const res = await db.query<{
      spelling: string; rows: string; facilities: string;
      canonical_payer_id: string | null; display_name: string | null;
      relationship: string | null; provenance: string | null;
      needs_review: boolean | null; confidence: string | null; review_note: string | null;
    }>(
      `with v as (
         select upper(btrim(insurance_co)) as spelling,
                count(*) as rows,
                count(distinct facility) as facilities
           from vob.indigo_vob
          where nullif(btrim(insurance_co), '') is not null
          group by 1
       )
       select v.spelling, v.rows::text as rows, v.facilities::text as facilities,
              m.canonical_payer_id, pi.display_name, m.relationship, m.provenance,
              m.needs_review, m.confidence::text as confidence, m.review_note
         from v
         left join ref.payer_alias_map m
                on m.vocabulary = 'vob_insurance_co' and m.alias_norm = v.spelling
         left join ref.payer_identity pi
                on pi.canonical_payer_id = m.canonical_payer_id
        order by v.rows desc, v.spelling`,
    );

    const totals = await db.query<{ vobs: string; named: string; facilities: string }>(
      `select count(*)::text as vobs,
              count(insurance_co)::text as named,
              count(distinct facility)::text as facilities
         from vob.indigo_vob`,
    );

    const all: Row[] = res.rows.map((r) => ({
      spelling: r.spelling,
      rows: Number(r.rows),
      facilities: Number(r.facilities),
      canonical: r.canonical_payer_id,
      display: r.display_name,
      relationship: r.relationship,
      provenance: r.provenance,
      needsReview: r.needs_review,
      confidence: r.confidence === null ? null : Number(r.confidence),
      reviewNote: r.review_note,
    }));

    // ── Existing groupings: one bucket per canonical payer id ────────────────────────────────────
    const buckets = new Map<string, Row[]>();
    const ungrouped: Row[] = [];
    for (const r of all) {
      if (r.canonical === null) ungrouped.push(r);
      else buckets.set(r.canonical, [...(buckets.get(r.canonical) ?? []), r]);
    }

    const groups = [...buckets.entries()].map(([canonical, rowsIn]) => {
      const sorted = [...rowsIn].sort((a, b) => b.rows - a.rows || a.spelling.localeCompare(b.spelling));
      const display = sorted[0]?.display ?? canonical;

      // The group's HOME states: those named by its confirmed spellings, else by its display name.
      // Confirmed rows are the only human-ratified evidence of what the group IS.
      const confirmedStates = new Set<string>();
      for (const r of sorted) if (r.needsReview === false) for (const s of statesIn(r.spelling)) confirmedStates.add(s);
      const home = confirmedStates.size > 0 ? confirmedStates : statesIn(display);

      const members: Member[] = sorted.map((r) => {
        const st = [...statesIn(r.spelling)];
        const confirmed = r.needsReview === false;
        const foreign = st.filter((s) => !home.has(s));
        // Only a PROPOSAL can be called misfiled — a confirmed row is a human's ruling, and this
        // script does not overrule one. State disagreement is the rule; low confidence is a flag.
        const stateClash = !confirmed && home.size > 0 && st.length > 0 && foreign.length === st.length;
        const why = stateClash
          ? `names ${foreign.join(', ')}; group is ${[...home].join(', ')}`
          : !confirmed && r.confidence !== null && r.confidence < 0.5
            ? `machine confidence ${r.confidence.toFixed(3)}`
            : '';
        return {
          spelling: r.spelling, rows: r.rows, facilities: r.facilities, confirmed,
          provenance: r.provenance ?? '—', confidence: r.confidence, states: st,
          misfiled: stateClash, why,
        };
      });

      return {
        canonical, display,
        family: null as string | null,
        rows: members.reduce((s, m) => s + m.rows, 0),
        spellings: members.length,
        confirmed: members.filter((m) => m.confirmed).length,
        misfiledRows: members.filter((m) => m.misfiled).reduce((s, m) => s + m.rows, 0),
        misfiledSpellings: members.filter((m) => m.misfiled).length,
        lowConfRows: members.filter((m) => !m.misfiled && m.why !== '').reduce((s, m) => s + m.rows, 0),
        members,
      };
    }).sort((a, b) => b.rows - a.rows);

    // ── Identities that are near-duplicates of each other (the same payer, two pi_ ids) ──────────
    const bySquash = new Map<string, typeof groups>();
    for (const g of groups) {
      const k = g.display.toUpperCase().replace(/[^A-Z]/g, '');
      bySquash.set(k, [...(bySquash.get(k) ?? []), g]);
    }
    const dupIdentities = [...bySquash.values()].filter((v) => v.length > 1)
      .map((v) => ({ key: v[0]!.display, members: v.map((g) => ({ canonical: g.canonical, display: g.display, rows: g.rows })) }));

    // ── The tail with no grouping: cluster it with the SHIPPED display-clustering module ─────────
    const proposed = clusterCarriers(
      ungrouped.map((r) => ({ name: r.spelling, canonicalPayerId: null, members: r.rows })),
    ).map((c) => ({
      label: c.label,
      rows: c.members.reduce((s, m) => s + m.members, 0),
      spellings: c.members.length,
      members: c.members.map((m) => ({ spelling: m.name, rows: m.members })),
      // Does this cluster's token core match an EXISTING group's? Then it is a gap, not a new payer.
      core: [...new Set(carrierTokens(c.label))].sort().join(' '),
    })).sort((a, b) => b.rows - a.rows);

    // Which existing group does an unmapped cluster's token core already appear in? Weighted by
    // rows, and ambiguity is reported rather than resolved: a core that appears under TWO canonical
    // ids means the crosswalk itself disagrees about that string, which is a finding, not a gap.
    // (Measured: {BLUE,CROSS,SHIELD,CALIFORNIA} sits under Anthem CA via "BCBS CA" @1350 AND under
    // Blue Shield CA via "BLUE CROSS BLUE SHIELD OF CA" @1 — picking the first hit would have
    // pointed the 94-row "BCBS CALIFORNIA" cluster at the wrong payer on the strength of one row.)
    const coreHomes = new Map<string, Map<string, number>>();
    for (const g of groups) {
      for (const m of g.members) {
        const core = [...new Set(carrierTokens(m.spelling))].sort().join(' ');
        const per = coreHomes.get(core) ?? new Map<string, number>();
        per.set(g.display, (per.get(g.display) ?? 0) + m.rows);
        coreHomes.set(core, per);
      }
    }
    const proposedWithHome = proposed.map((p) => {
      const per = coreHomes.get(p.core);
      if (per === undefined) return { ...p, existingHome: null, homeRows: 0, contested: [] as string[] };
      const ranked = [...per.entries()].sort((a, b) => b[1] - a[1]);
      return {
        ...p,
        existingHome: ranked[0]?.[0] ?? null,
        homeRows: ranked[0]?.[1] ?? 0,
        contested: ranked.length > 1 ? ranked.map(([d, n]) => `${d} (${n})`) : [],
      };
    });

    const data = {
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      totals: {
        vobs: Number(totals.rows[0]?.vobs ?? 0),
        named: Number(totals.rows[0]?.named ?? 0),
        facilities: Number(totals.rows[0]?.facilities ?? 0),
        spellings: all.length,
        groups: groups.length,
        multiSpellingGroups: groups.filter((g) => g.spellings > 1).length,
        groupedRows: groups.reduce((s, g) => s + g.rows, 0),
        ungroupedSpellings: ungrouped.length,
        ungroupedRows: ungrouped.reduce((s, r) => s + r.rows, 0),
        confirmedSpellings: all.filter((r) => r.needsReview === false).length,
        confirmedRows: all.filter((r) => r.needsReview === false).reduce((s, r) => s + r.rows, 0),
        proposalSpellings: all.filter((r) => r.needsReview === true).length,
        proposalRows: all.filter((r) => r.needsReview === true).reduce((s, r) => s + r.rows, 0),
        misfiledRows: groups.reduce((s, g) => s + g.misfiledRows, 0),
        misfiledSpellings: groups.reduce((s, g) => s + g.misfiledSpellings, 0),
      },
      groups,
      dupIdentities,
      ungrouped: ungrouped.map((r) => ({ spelling: r.spelling, rows: r.rows, facilities: r.facilities, relationship: r.relationship })),
      proposed: proposedWithHome,
    };

    writeFileSync(OUT, JSON.stringify(data, null, 1));
    process.stderr.write(
      `wrote ${OUT}\n` +
      `  ${data.totals.spellings} distinct spellings over ${data.totals.named} named VOBs\n` +
      `  ${data.totals.groups} groups (${data.totals.multiSpellingGroups} with >1 spelling)\n` +
      `  ${data.totals.misfiledSpellings} misfiled spellings / ${data.totals.misfiledRows} rows\n` +
      `  ${data.totals.ungroupedSpellings} spellings with no grouping / ${data.totals.ungroupedRows} rows\n` +
      `  ${data.proposed.filter((p) => p.spellings > 1).length} proposed new clusters in that tail\n`,
    );
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
