/**
 * Qualify v3 — the D2 resolution service. THE only place a `QualifyResolution` is built.
 *
 * Server-side, one module, pure query + assembly. No UI concerns, no formatting decisions the screen
 * could make differently, and no panel-specific filters — panels receive the resolution and render it.
 *
 * ── WHAT THIS MODULE IS RESPONSIBLE FOR NOT DOING ───────────────────────────────────────────────
 *
 * IT NEVER COLLAPSES A CANDIDATE SET (I3). `resolveCoverage` returns every candidate it found and
 * marks which one is *pre-selected*. It does not take `[0]`. 78.1% of members sit on a multi-payer
 * prefix, so ambiguity is the main path, and v2's dominant-payer heuristic — usually right, silently
 * chosen, presented as fact — is the single behaviour this whole re-architecture exists to delete.
 * `chosenBy: 'sole_candidate'` is only ever set when `total === 1`.
 *
 * IT NEVER RESOLVES THROUGH AN UNREVIEWED ALIAS (R8). That guard lives in the SQL, and
 * `test/qualifyResolutionQuery.test.ts` asserts every crosswalk reference carries it. The consequence
 * is visible and intended: 028 loaded 695 proposals and none of them resolve anything, so the
 * identified-search path covers 60.0% of VOB members until a human reviews. Reporting 94.8% by
 * counting proposals would be the exact error the trust-tier table exists to prevent.
 *
 * IT PRODUCES NOTHING DOLLAR-VALUED (I4). Every field it writes is a count, an enum, a date, a
 * boolean or a name. An `admissions_seat` session therefore derives byte-identical output — which is
 * why `resolveCoverage` takes no role parameter at all. A role parameter would be a place for the two
 * outputs to diverge; not having one makes divergence unrepresentable rather than merely tested.
 */
import { makeClient } from '../../../src/collections/db';
import { ALPHA_PREFIX_LEN, alphaPrefixBlindIndex, memberIdBlindIndex } from '../../../src/collections/blindIndex';
import {
  buildCandidateEvidenceBatchQuery,
  buildClaimsOnlyCandidatesQuery,
  buildCoverageCandidatesQuery,
  buildGroupClaimEvidenceQuery,
  buildGroupLadderQuery,
  predicateIdFor,
  type QualifyHandleKind,
} from '../../../src/collections/qualifyResolutionQuery';
import { classifyQualifyHandle } from './contract';
import {
  deriveNotices,
  employerKeyFor,
  isVobStale,
  panelProvenance,
  sampleTierFor,
  shiftIsoDays,
  type ClaimEvidence,
  type CoverageGroup,
  type CoverageGroupSummary,
  type PanelEvidence,
  type PanelId,
  type QualifyResolution,
  type QualifyWindowLadder,
  type ResolutionBasis,
  type ResolvedWindow,
} from './resolution';

/** The ladder's rungs. Same widths as v2's window options, so the two surfaces stay comparable. */
const LADDER_RUNGS = [30, 60, 90, 180, 365] as const;
/** The rung the ladder proposes: the narrowest that clears this many distinct members. */
const LADDER_MIN_MEMBERS = 3;

const PANELS: readonly PanelId[] = ['kpis', 'ranking', 'policy', 'ladder', 'trend', 'ai'];

let pool: ReturnType<typeof makeClient> | null = null;
/** READ-ONLY least-privilege reader. Never `claims_admin`, never the service-role key. */
function reader() {
  if (!pool) {
    const url = process.env.CLAIMS_READER_DATABASE_URL;
    if (!url) throw new Error('Missing CLAIMS_READER_DATABASE_URL (set in env; never hardcode or log it)');
    pool = makeClient(url);
  }
  return pool;
}

interface VobCandidateRow {
  canonical_payer_id: string | null;
  payer_display_name: string;
  payer_relationship: string;
  administrator_id: string | null;
  administrator_name: string | null;
  employer_label: string | null;
  funding: string | null;
  plan_type: string | null;
  policy_type: string | null;
  member_count: number;
  vob_fresh_as_of: string | null;
  group_on_file: boolean;
}

interface ClaimsOnlyRow {
  canonical_payer_id: string | null;
  payer_display_name: string;
  payer_relationship: string;
  member_count: number;
}

export interface ResolveCoverageInput {
  /** The raw typed term. PHI — used to mint a blind index and then dropped. Never logged or echoed. */
  term: string;
  /** Inclusive window start, ISO. */
  from: string;
  /** EXCLUSIVE window end, ISO — matching the rollup convention used everywhere else. */
  to: string;
  /** Today, ISO. Passed in rather than read, so the resolution is deterministic and testable. */
  today: string;
  /** Which candidate the user picked. Omitted ⇒ pre-select the top-ranked one. */
  chosenIndex?: number;
}

/**
 * Normalize the VOB `funding` string onto the contract's two-value union. Unknown ⇒ null, never a guess.
 *
 * MEASURED (live, 2026-08-05): the column holds `Self-Funded` (15,437), `Fully Insured` (7,078), NULL
 * (499), `''` (9) — and **`'Self-Funded;Fully Insured'` (12)**. That last value is a VOB that captured
 * BOTH, and a `startsWith('self')` test silently resolved it to a definitive "Self-Funded". Reporting
 * a coin-flip as a fact is the exact failure this re-architecture exists to delete, so a multi-valued
 * funding string resolves to NULL — the UI then renders "Funding not captured", which is true, instead
 * of a confident wrong answer on 12 members' plans.
 */
export function normalizeFunding(raw: string | null): CoverageGroup['funding'] {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v.includes(';') || v.includes(',')) return null; // captured more than one — genuinely unknown
  if (v === 'self-funded' || v === 'self funded') return 'Self-Funded';
  if (v === 'fully insured' || v === 'fully-insured') return 'Fully Insured';
  return null;
}

/** VOB `payer_relationship` text → the contract union. Anything unrecognized is 'unmapped', not a guess. */
function normalizeRelationship(raw: string): CoverageGroup['payerRelationship'] {
  switch (raw) {
    case 'same_payer':
    case 'program_label':
    case 'carve_out':
    case 'tpa':
    case 'employer_self_funded':
      return raw;
    default:
      return 'unmapped';
  }
}

/**
 * How this group's identity was actually established.
 *
 * ⚠ CORRECTED 2026-08-05. This used to return `'vob_payer_id'` whenever the VOB row merely HAD a
 * `payer_id`, which overstated the provenance in the one field whose entire job is to say how strongly
 * we know. `buildCoverageCandidatesQuery` resolves identity by joining `insurance_co` against the NAME
 * vocabulary — `payer_id` is not part of that join at all — so the presence of a `payer_id` says
 * nothing about how the payer was identified. Claiming the stronger basis is the same class of error
 * as the dominant-payer heuristic: a confident label over a weaker fact.
 *
 * `'vob_payer_id'` stays in the union because the spine IS a real resolution path — `payer_alias_map`
 * carries 160 CONFIRMED `vob_payer_id` aliases — but it is NOT BUILT YET. When a payer_id-first
 * resolution stage lands, it returns that value; until then nothing may.
 */
function basisFor(row: VobCandidateRow): ResolutionBasis {
  if (normalizeRelationship(row.payer_relationship) === 'program_label') return 'program_label_per_member';
  return 'vob_name';
}

const ZERO_EVIDENCE: ClaimEvidence = {
  distinctMembers: 0,
  lines: 0,
  distinctFacilities: 0,
  distinctPatients: 0,
  sampleTier: 'insufficient',
  hasReliableAllowed: false,
};

/** Why a handle produced no resolution. Distinct values because they are DIFFERENT screen states. */
export type UnresolvableReason =
  /** Nothing typed. Not a failed search — no question was asked. */
  | 'empty'
  /** A prefix shorter than the blind index's fixed width. Searchable PHI is indexed at exactly
   *  ALPHA_PREFIX_LEN characters, so a 2-character prefix has no token to match and CANNOT be
   *  resolved — as opposed to resolving to nothing, which would be a claim about the data. */
  | 'prefix_too_short'
  /** A well-formed handle that matched no coverage group at all. */
  | 'no_match';

export interface ResolveCoverageResult {
  resolution: QualifyResolution | null;
  /** Set exactly when `resolution` is null. The screen states this instead of guessing. */
  reason: UnresolvableReason | null;
}

/**
 * Resolve a typed handle into the ranked candidate set and one selected `QualifyResolution`.
 *
 * Returns a REASON alongside a null resolution rather than a bare null. "You typed nothing", "that
 * prefix is too short to look up" and "that handle matched no plan" are three different things, and
 * collapsing them is how "no matches yet" ends up on screen for a question nobody asked — the I5
 * null-is-not-zero rule applied to the search itself.
 */
export async function resolveCoverage(input: ResolveCoverageInput): Promise<ResolveCoverageResult> {
  const reading = classifyQualifyHandle(input.term);
  if (reading.kind === 'empty') return { resolution: null, reason: 'empty' };
  const kind: QualifyHandleKind = reading.kind;

  // The raw term becomes a blind-index token here and is never used again. Minting goes through
  // src/collections/blindIndex.ts deliberately — there are two same-named normalizeMemberId helpers in
  // this repo with DIFFERENT whitespace/hyphen semantics, and the live tokens were minted with this one.
  //
  // A prefix token exists only at exactly ALPHA_PREFIX_LEN characters (alphaPrefixNormalized returns
  // null below that), so a 2-character prefix is UNRESOLVABLE rather than empty-resulting. Saying so is
  // the difference between "we cannot look that up" and "there is nothing there".
  const token = kind === 'prefix' ? alphaPrefixBlindIndex(reading.value) : memberIdBlindIndex(reading.value);
  if (token === null) {
    return {
      resolution: null,
      reason: kind === 'prefix' && reading.value.length < ALPHA_PREFIX_LEN ? 'prefix_too_short' : 'no_match',
    };
  }

  const db = reader();

  // ── 1. Candidates from both sides ──────────────────────────────────────────────────────────────
  const vobQ = buildCoverageCandidatesQuery(token, kind);
  const claimsQ = buildClaimsOnlyCandidatesQuery(token, kind);
  const [vobRes, claimsRes] = await Promise.all([
    db.query<VobCandidateRow>(vobQ.sql, vobQ.params),
    db.query<ClaimsOnlyRow>(claimsQ.sql, claimsQ.params),
  ]);

  // ── 2. Evidence for EVERY candidate, in one query (§S1: mark no-evidence before the user picks) ──
  const canonicalIds = [
    ...new Set(
      [...vobRes.rows, ...claimsRes.rows]
        .map((r) => r.canonical_payer_id)
        .filter((x): x is string => x !== null),
    ),
  ];
  const batchQ = buildCandidateEvidenceBatchQuery(token, kind, canonicalIds, input.from, input.to);
  const batchRes = await db.query<{ canonical_payer_id: string; lines: string; members: number }>(
    batchQ.sql,
    batchQ.params,
  );
  const evidenceByCanonical = new Map<string, { lines: number; members: number }>();
  for (const r of batchRes.rows) {
    evidenceByCanonical.set(r.canonical_payer_id, { lines: Number(r.lines), members: r.members });
  }

  // ── 3. Assemble candidate groups. VOB groups first (they carry plan detail), then claims-only. ──
  const groups: CoverageGroup[] = [];

  for (const [i, row] of vobRes.rows.entries()) {
    const ev = row.canonical_payer_id ? evidenceByCanonical.get(row.canonical_payer_id) : undefined;
    groups.push({
      canonicalPayerId: row.canonical_payer_id,
      payerDisplayName: row.payer_display_name,
      payerRelationship: normalizeRelationship(row.payer_relationship),
      administratorId: row.administrator_id,
      administratorName: row.administrator_name,
      resolutionBasis: basisFor(row),
      employerKey: row.employer_label ? employerKeyFor(i) : null,
      employerLabel: row.employer_label,
      funding: normalizeFunding(row.funding),
      planType: row.plan_type,
      policyType: row.policy_type,
      network: null, // VOB does not carry it; kept visible so the UI can say so (see CoverageGroup)
      groupOnFile: row.group_on_file,
      memberCount: row.member_count,
      vobFreshAsOf: row.vob_fresh_as_of,
      vobStale: isVobStale(row.vob_fresh_as_of, input.today),
      // Placeholder counts until the chosen group gets its full evidence query in step 5. `lines` and
      // `distinctMembers` are real here (from the batch); facilities and reliability need the detail
      // query, so they stay at the honest zero rather than a guess.
      claimEvidence: ev
        ? { ...ZERO_EVIDENCE, distinctMembers: ev.members, lines: ev.lines, distinctPatients: ev.members,
            sampleTier: sampleTierFor(ev.members) }
        : ZERO_EVIDENCE,
    });
  }

  for (const row of claimsRes.rows) {
    const ev = row.canonical_payer_id ? evidenceByCanonical.get(row.canonical_payer_id) : undefined;
    groups.push({
      canonicalPayerId: row.canonical_payer_id,
      payerDisplayName: row.payer_display_name,
      payerRelationship: normalizeRelationship(row.payer_relationship),
      administratorId: null,
      administratorName: null,
      resolutionBasis: 'claims_only',
      employerKey: null, // claims carry no plan sponsor — §3d
      employerLabel: null,
      funding: null,
      planType: null,
      policyType: null,
      network: null,
      groupOnFile: false,
      memberCount: row.member_count,
      vobFreshAsOf: null,
      vobStale: false,
      claimEvidence: ev
        ? { ...ZERO_EVIDENCE, distinctMembers: ev.members, lines: ev.lines, distinctPatients: ev.members,
            sampleTier: sampleTierFor(ev.members) }
        : ZERO_EVIDENCE,
    });
  }

  if (groups.length === 0) return { resolution: null, reason: 'no_match' };

  // ── 4. Selection. Pre-select the top-ranked group; the user's pick wins when supplied. ─────────
  // NOTE the asymmetry, and that it is deliberate: pre-selecting is fine, PRETENDING no choice was
  // made is not. `wasAmbiguous` and the 'ambiguous_candidates' notice make the choice visible.
  const requested = input.chosenIndex;
  const chosenIndex =
    requested !== undefined && requested >= 0 && requested < groups.length ? requested : 0;
  const chosen = groups[chosenIndex];
  // Unreachable given the bounds check above; keeps the type honest under noUncheckedIndexedAccess.
  if (!chosen) return { resolution: null, reason: 'no_match' };

  // ── 5. Full evidence for the CHOSEN group only (facilities + allowed reliability) ──────────────
  const evQ = buildGroupClaimEvidenceQuery(token, kind, chosen.canonicalPayerId, input.from, input.to);
  if (evQ.params.length > 0) {
    const evRes = await db.query<{
      distinct_members: number;
      lines: string;
      distinct_facilities: number;
      distinct_patients: number;
      has_reliable_allowed: boolean;
    }>(evQ.sql, evQ.params);
    const r = evRes.rows[0];
    if (r) {
      chosen.claimEvidence = {
        distinctMembers: r.distinct_members,
        lines: Number(r.lines),
        distinctFacilities: r.distinct_facilities,
        distinctPatients: r.distinct_patients,
        sampleTier: sampleTierFor(r.distinct_patients),
        hasReliableAllowed: r.has_reliable_allowed,
      };
    }
  }

  // ── 6. The ladder — a PROPOSAL scoped to the chosen group, never an applied change (§5d) ───────
  const ladder = await buildLadder(db, token, kind, chosen.canonicalPayerId, input.to);

  const window: ResolvedWindow = {
    from: input.from,
    to: input.to,
    kind: 'trailing',
    chosenBy: 'user',
    ladder,
    frozen: false,
  };

  // ── 7. Per-panel evidence + provenance, rendered SERVER-side ───────────────────────────────────
  const rejected: CoverageGroupSummary[] = groups
    .filter((_, i) => i !== chosenIndex)
    .map((g) => ({
      canonicalPayerId: g.canonicalPayerId,
      payerDisplayName: g.payerDisplayName,
      employerLabel: g.employerLabel,
      funding: g.funding,
      planType: g.planType,
      memberCount: g.memberCount,
      hasClaimEvidence: g.claimEvidence.lines > 0,
    }));

  const candidates = {
    total: groups.length,
    chosenIndex,
    wasAmbiguous: groups.length > 1,
    chosenBy: (groups.length === 1 ? 'sole_candidate' : 'user') as 'user' | 'sole_candidate',
    rejected,
  };

  const evidence = {} as Record<PanelId, PanelEvidence>;
  const provenance = {} as Record<PanelId, string>;
  for (const panel of PANELS) {
    const ev: PanelEvidence =
      panel === 'kpis'
        ? {
            // RATIFIED book-wide (see veris-data-notes.md). The tile is deliberately NOT about this
            // client, and its provenance line says exactly that. Scoping it to the group would scope
            // it by EMPLOYER, and facility × payer × employer approaches ~1 distinct patient.
            scope: 'book_wide',
            members: null,
            lines: null,
            belowFloor: false,
            subset: '',
          }
        : {
            scope: 'resolution',
            members: chosen.claimEvidence.distinctMembers,
            lines: chosen.claimEvidence.lines,
            belowFloor: chosen.claimEvidence.sampleTier === 'insufficient',
            subset: '',
          };
    const line = panelProvenance(panel, ev, chosen);
    evidence[panel] = { ...ev, subset: line };
    provenance[panel] = line;
  }

  const resolution: QualifyResolution = {
    handle: { kind, readAs: reading.readAs, echo: reading.echo },
    group: chosen,
    candidates,
    window,
    predicateId: predicateIdFor({
      kind,
      canonicalPayerId: chosen.canonicalPayerId,
      employerLabel: chosen.employerLabel,
      funding: chosen.funding,
      planType: chosen.planType,
      from: input.from,
      to: input.to,
    }),
    evidence,
    provenance,
    unmapped: chosen.canonicalPayerId === null,
    policyOnFile: chosen.resolutionBasis !== 'claims_only',
    notices: deriveNotices(chosen, candidates, input.today),
  };
  return { resolution, reason: null };
}

/**
 * The ladder proposal. Rungs are counted over THE CHOSEN GROUP (the §3f fix), and the proposal is the
 * NARROWEST rung clearing the member floor — narrow windows are more current, so widening is a cost
 * paid only when the evidence demands it. The rationale string is returned so the screen can state
 * WHY, which is what makes this a proposal rather than the silent re-window v2 shipped.
 */
async function buildLadder(
  db: ReturnType<typeof makeClient>,
  token: string,
  kind: QualifyHandleKind,
  canonicalPayerId: string | null,
  to: string,
): Promise<QualifyWindowLadder | null> {
  const q = buildGroupLadderQuery(token, kind, canonicalPayerId, to, LADDER_RUNGS);
  const res = await db.query<{ days: number; members: number; lines: string }>(q.sql, q.params);
  if (res.rows.length === 0) return null;
  const rungs = res.rows.map((r) => ({
    days: r.days,
    label: `${r.days} days`,
    members: r.members,
    lines: Number(r.lines),
  }));
  const clearing = rungs.find((r) => r.members >= LADDER_MIN_MEMBERS);
  const widest = rungs[rungs.length - 1];
  const proposed = clearing ?? widest;
  if (!proposed) return null;
  const rationale = clearing
    ? `${proposed.days} days is the narrowest window with at least ${LADDER_MIN_MEMBERS} members of history (${proposed.members}).`
    : `No window reaches ${LADDER_MIN_MEMBERS} members; showing the widest (${proposed.days} days, ${proposed.members}).`;
  return { rungs, proposedDays: proposed.days, rationale };
}

/**
 * Trailing window of exactly `days` days ENDING ON `anchor` INCLUSIVE, expressed as a half-open
 * `[from, to)` range.
 *
 * ⚠ MEASURED OFF-BY-ONE, fixed 2026-08-05. The first version returned `{ from: anchor - days, to:
 * anchor }`. Because every rollup read here is `charge_date >= from and < to`, that EXCLUDED today
 * entirely and shifted the whole window back a day — so a v3 "30 days" covered a different 30 days
 * than a v2 "30 days", and today's charges were invisible on the v3 surface until tomorrow.
 *
 * v2's `trailingWindowFromDays` in contract.ts is the convention to match, and it is explicit about
 * why: `to = anchor + 1` ("exclusive upper = tomorrow, so all of today is in-window") and
 * `from = anchor - (days - 1)` ("inclusive lower → exactly windowDays days"). This now computes the
 * identical pair. Do not "simplify" it back to `anchor - days`.
 */
export function trailingWindowFor(anchor: string, days: number): { from: string; to: string } {
  return { from: shiftIsoDays(anchor, -(days - 1)), to: shiftIsoDays(anchor, 1) };
}
