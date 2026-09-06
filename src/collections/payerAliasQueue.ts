/**
 * Payer-alias RULING QUEUE — pure SQL builders for the read side of /admin/payer-aliases.
 *
 * READ-ONLY BY CONSTRUCTION. Every builder here emits a SELECT. The write path (a SECURITY DEFINER
 * owned by claims_admin) is Artifact 3 and lands in a separate Veris migration; nothing in this file
 * may grow an INSERT/UPDATE/DELETE. Reads run as claims_reader, which holds SELECT on all three
 * `ref.*` tables and nothing else.
 *
 * SCOPE: `ref.payer_alias_map` + `ref.payer_identity` ONLY. `claims.payer_alias` is a DIFFERENT,
 * unrelated table in the product plane (Billing Audit's facility-scoped matcher) and is deferred
 * until Phase 3 — do not join, reference, or "unify" the two here.
 *
 * PARAMETERIZED ONLY. Table, column and operator names are fixed string literals; only VALUES are
 * `$n` bound params. No `SELECT *` — columns are projected explicitly so a column added upstream
 * cannot silently start flowing into a payload. Supavisor 6543 forbids named prepared statements,
 * so callers use `pool.query(sql, params)`.
 *
 * ── PHI ──────────────────────────────────────────────────────────────────────────────────────────
 * This surface is non-PHI by construction: payer names, payer identifiers, canonical `pi_*` slugs,
 * and prose notes. No member, no patient, no dollars.
 *
 * ⚠️ ONE CAUTION THAT SHAPES THE API: `alias_norm` CAN hold an employer name. The relationship
 * vocabulary includes `employer_self_funded`, so a self-funded employer's own name is a legitimate
 * alias string. `employer_name` was ruled non-PHI for display to an authenticated principal
 * (2026-08-14) but it STAYS in the PhiKey union — it must never reach a URL, a query string,
 * browser storage, or an LLM prompt. Consequently `alias_norm` is only ever a BOUND PARAMETER here
 * and is never accepted as, or emitted into, a route value. Page position is an integer offset for
 * exactly this reason: a keyset cursor would have to carry `alias_norm` through the URL.
 *
 * ── CROSS-TENANT BY RATIFIED DESIGN ──────────────────────────────────────────────────────────────
 * There is no `business_entity_id` predicate in this file and that is deliberate, not an omission:
 * `ref.payer_alias_map`'s PK is (vocabulary, alias_norm) and it carries no tenancy column at all.
 * One ruling governs both BXR and Indigo. If a future change adds a single-entity WHERE here, that
 * is a deviation from ratified design — stop and say so.
 *
 * ── pg_trgm LIVES IN `claims`, NOT `public` ──────────────────────────────────────────────────────
 * Verified live: `pg_extension` → `pg_trgm` @ schema `claims`, and the index that makes the
 * neighbour lookup cheap is `payer_alias_map_alias_trgm_idx … gin (alias_norm claims.gin_trgm_ops)`.
 * So the similarity operator MUST be written `operator(claims.%)` and the function `claims.similarity`.
 * An unqualified `%` resolves only if `claims` happens to be on the search_path, which is not a
 * property this module may assume.
 */

export const PAYER_ALIAS_MAP_TABLE = 'ref.payer_alias_map';
export const PAYER_IDENTITY_TABLE = 'ref.payer_identity';

/** The `payer_alias_map_vocabulary` CHECK, verbatim. A tab per value. */
export const PAYER_ALIAS_VOCABULARIES = [
  'vob_insurance_co',
  'claims_primary_payer',
  'vob_payer_id',
] as const;
export type PayerAliasVocabulary = (typeof PAYER_ALIAS_VOCABULARIES)[number];

/**
 * The `payer_alias_map_relationship` CHECK, verbatim — all SIX, not the four in live use.
 *
 * `tpa` and `employer_self_funded` have zero rows today, and exposing only the four observed values
 * was considered and REJECTED (ruled 2026-09-05): `ref.payer_identity.entity_kind` models both, and
 * `administers_for` exists specifically to express "this TPA administers for that insurer". Forcing
 * a genuine TPA into `same_payer` would write a permanent falsehood into a row whose whole purpose
 * is attributed truth.
 */
export const PAYER_ALIAS_RELATIONSHIPS = [
  'same_payer',
  'carve_out',
  'tpa',
  'employer_self_funded',
  'program_label',
  'unmapped',
] as const;
export type PayerAliasRelationship = (typeof PAYER_ALIAS_RELATIONSHIPS)[number];

/**
 * Which relationships REQUIRE a canonical payer, per `payer_alias_map_relationship_canonical`:
 *   (same_payer|carve_out|tpa|employer_self_funded) AND canonical_payer_id IS NOT NULL
 *   OR (program_label|unmapped)                     AND canonical_payer_id IS NULL
 *
 * Restated in TypeScript so the UI can pair the two controls, and so Artifact 3's validator can
 * reject a mis-paired input as a field error rather than letting Postgres raise a bare 23514.
 */
export const RELATIONSHIP_REQUIRES_CANONICAL: Readonly<Record<PayerAliasRelationship, boolean>> = {
  same_payer: true,
  carve_out: true,
  tpa: true,
  employer_self_funded: true,
  program_label: false,
  unmapped: false,
};

export function isPayerAliasVocabulary(value: unknown): value is PayerAliasVocabulary {
  return typeof value === 'string' && (PAYER_ALIAS_VOCABULARIES as readonly string[]).includes(value);
}

/**
 * Clamp an untrusted route value to a vocabulary. Defaults to the largest queue
 * (`vob_insurance_co`, 646 unruled) so a bare /admin/payer-aliases lands on real work.
 */
export function clampVocabulary(value: unknown): PayerAliasVocabulary {
  return isPayerAliasVocabulary(value) ? value : 'vob_insurance_co';
}

export const QUEUE_PAGE_SIZE = 25;
/** Hard ceiling on offset paging — 990 unruled rows today; 200 pages is far past the end. */
const MAX_PAGE = 200;

/** Clamp to an integer in [min,max], falling back for NaN/Infinity. `Math.max(1, NaN)` is NaN, so
 *  the finite check has to come FIRST — a NaN reaching a LIMIT would be a runtime SQL error. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Clamp an untrusted page number to [1, MAX_PAGE]. Non-numeric / NaN / float → 1. */
export function clampPage(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PAGE, Math.max(1, Math.trunc(n)));
}

/** One unruled row plus its resolved proposal. `confidence` is numeric → node-pg hands back a
 *  STRING; it is deliberately NOT coerced to a float here, because the UI renders the value
 *  verbatim rather than a bar and a lossy parse would be invisible. */
export interface PayerAliasQueueRow {
  vocabulary: PayerAliasVocabulary;
  alias_norm: string;
  relationship: string;
  provenance: string;
  confidence: string | null;
  review_note: string | null;
  created_at: string;
  canonical_payer_id: string | null;
  /** ref.payer_identity of the PROPOSED canonical payer (null when there is no proposal). */
  display_name: string | null;
  payer_family: string | null;
  entity_kind: string | null;
  is_active: boolean | null;
  administers_for: string | null;
  /** display_name of the identity the proposal administers FOR (TPA chains). */
  administers_for_name: string | null;
}

const QUEUE_COLUMNS =
  'm.vocabulary, m.alias_norm, m.relationship, m.provenance, m.confidence::text as confidence, ' +
  "m.review_note, to_char(m.created_at, 'YYYY-MM-DD') as created_at, m.canonical_payer_id, " +
  'pi.display_name, pi.payer_family, pi.entity_kind, pi.is_active, pi.administers_for, ' +
  'adm.display_name as administers_for_name';

const QUEUE_FROM =
  `from ${PAYER_ALIAS_MAP_TABLE} m ` +
  `left join ${PAYER_IDENTITY_TABLE} pi on pi.canonical_payer_id = m.canonical_payer_id ` +
  `left join ${PAYER_IDENTITY_TABLE} adm on adm.canonical_payer_id = pi.administers_for`;

/**
 * THE QUEUE. Unruled rows for ONE vocabulary, ordered by how decidable they are.
 *
 * ── WHY THIS ORDER, MEASURED ─────────────────────────────────────────────────────────────────────
 * `ref.payer_alias_map` carries NO usage signal — no count, no volume, no dollars, no last-seen. It
 * is a crosswalk, not a fact table. So the queue cannot be ordered by impact without joining out to
 * the VOB/claims sources, which is a named follow-up and deliberately not this build.
 *
 * The confidence distribution over the 990 unruled rows, measured 2026-09-05:
 *   vob_insurance_co      646 rows · 646 with confidence (100%)   idf_cosine 0.136–1.000
 *   claims_primary_payer  145 rows · 143 with confidence (98.6%)  idf_cosine 0.226–1.000,
 *                                                                 trigram   0.500–0.875,
 *                                                                 no_candidate 0.000–0.484
 *   vob_payer_id          199 rows ·   0 with confidence (0%)     — alphabetical, unavoidably
 *
 * Two facts from those ranges drive the sort key:
 *  1. `no_candidate` DOES carry a score (it is the best REJECTED candidate's score, capped under
 *     the 0.5 threshold), so "has confidence" does not mean "has a proposal". A flat
 *     `ORDER BY confidence DESC` would interleave "the machine found nothing, best reject 0.48"
 *     with "the machine proposes this at 0.48" — two different questions for the reviewer.
 *  2. The honest tier is "is there something to ACCEPT?", and the CHECK constraint
 *     `payer_alias_map_relationship_canonical` makes that EXACTLY `canonical_payer_id is not null`
 *     (same_payer/carve_out/tpa/employer_self_funded require it; program_label/unmapped forbid it).
 *     So the tier is constraint-guaranteed rather than inferred from provenance strings.
 *
 * Tier 0 = 730 rows with a proposal, confidence-sorted. Tier 1 = 260 needing research.
 * `alias_norm` is the final tiebreak so paging is deterministic (it is half the PK, hence unique
 * within a vocabulary — no two rows can tie all three keys).
 *
 * The table is 1,685 rows total, so ordering cost is irrelevant; the partial index
 * `payer_alias_map_needs_review_idx … WHERE needs_review` is a nicety, not a requirement.
 */
export function buildPayerAliasQueueQuery(
  vocabulary: PayerAliasVocabulary,
  page: number,
  pageSize: number = QUEUE_PAGE_SIZE,
): { sql: string; params: unknown[] } {
  const p = clampPage(page);
  const size = clampInt(pageSize, 1, 100, QUEUE_PAGE_SIZE);
  return {
    sql:
      `select ${QUEUE_COLUMNS} ${QUEUE_FROM} ` +
      'where m.needs_review and m.vocabulary = $1 ' +
      'order by (m.canonical_payer_id is null), m.confidence desc nulls last, m.alias_norm ' +
      'limit $2 offset $3',
    params: [vocabulary, size, (p - 1) * size],
  };
}

/** Unruled counts per vocabulary — drives the tab badges. Three rows at most. */
export function buildPayerAliasQueueCountsQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      `select vocabulary, count(*)::int as unruled from ${PAYER_ALIAS_MAP_TABLE} ` +
      'where needs_review group by vocabulary order by vocabulary',
    params: [],
  };
}

/** One alias as it is ruled in a DIFFERENT vocabulary. */
export interface PayerAliasSiblingRow {
  alias_norm: string;
  vocabulary: string;
  relationship: string;
  canonical_payer_id: string | null;
  needs_review: boolean;
  display_name: string | null;
}

/**
 * CROSS-VOCABULARY SIBLINGS for the rows on screen, in ONE query — never a query per row.
 *
 * The same string can exist under two vocabularies with two different rulings (the PK is
 * (vocabulary, alias_norm), so that is legal and expected). A reviewer ruling `CIGNA` under
 * claims_primary_payer should see what `CIGNA` already resolves to under vob_insurance_co before
 * they decide, or the two halves of the crosswalk drift apart one ruling at a time.
 *
 * Siblings are NOT filtered to confirmed rows: an unruled sibling is still useful ("this one is
 * waiting too — rule them consistently"), and `needs_review` is projected so the UI can say which.
 */
export function buildPayerAliasSiblingsQuery(
  aliasNorms: readonly string[],
  excludeVocabulary: PayerAliasVocabulary,
): { sql: string; params: unknown[] } {
  return {
    sql:
      'select s.alias_norm, s.vocabulary, s.relationship, s.canonical_payer_id, s.needs_review, ' +
      'pi.display_name ' +
      `from ${PAYER_ALIAS_MAP_TABLE} s ` +
      `left join ${PAYER_IDENTITY_TABLE} pi on pi.canonical_payer_id = s.canonical_payer_id ` +
      'where s.alias_norm = any($1::text[]) and s.vocabulary <> $2 ' +
      'order by s.alias_norm, s.vocabulary',
    params: [[...aliasNorms], excludeVocabulary],
  };
}

/** A confirmed alias that LOOKS like the seed, with the ruling it already received. */
export interface PayerAliasNeighbourRow {
  seed: string;
  alias_norm: string;
  vocabulary: string;
  relationship: string;
  canonical_payer_id: string | null;
  display_name: string | null;
  similarity: string;
}

/** Neighbours shown per seed row. Three is enough to establish a pattern without burying the row. */
export const NEIGHBOURS_PER_ROW = 3;

/**
 * TRIGRAM NEAR-NEIGHBOURS for the rows on screen, in ONE query — the highest-value context on the
 * surface, and it costs nothing new because `payer_alias_map_alias_trgm_idx` already exists.
 *
 * ⚠️ FILTERED TO `not needs_review` ON PURPOSE. The question a reviewer is asking is "how were
 * strings like this one ALREADY ruled?" — a similar row that is itself unruled answers nothing and
 * would crowd out the rows that do. Live example: the unruled `ANTHEM BCBS GA` surfaces the
 * confirmed `ANTHEM BCBS OF GA` → `pi_anthem_georgia` at 0.833, which is the whole ruling in one
 * line. A seed with no confirmed neighbour above pg_trgm's threshold (default 0.3) simply yields no
 * rows — `UHC` is the live example, and that absence is itself a signal.
 *
 * `operator(claims.%)` / `claims.similarity` are schema-qualified because pg_trgm is installed in
 * `claims`, not `public` (see the file header).
 */
export function buildPayerAliasNeighboursQuery(
  aliasNorms: readonly string[],
  perSeed: number = NEIGHBOURS_PER_ROW,
): { sql: string; params: unknown[] } {
  const limit = clampInt(perSeed, 1, 10, NEIGHBOURS_PER_ROW);
  return {
    sql:
      'select q.alias_norm as seed, n.alias_norm, n.vocabulary, n.relationship, ' +
      'n.canonical_payer_id, pi.display_name, n.similarity::text as similarity ' +
      'from unnest($1::text[]) as q(alias_norm) ' +
      'cross join lateral ( ' +
      '  select x.alias_norm, x.vocabulary, x.relationship, x.canonical_payer_id, ' +
      '         claims.similarity(q.alias_norm, x.alias_norm) as similarity ' +
      `  from ${PAYER_ALIAS_MAP_TABLE} x ` +
      '  where x.alias_norm <> q.alias_norm ' +
      '    and not x.needs_review ' +
      '    and x.alias_norm operator(claims.%) q.alias_norm ' +
      '  order by claims.similarity(q.alias_norm, x.alias_norm) desc, x.alias_norm ' +
      '  limit $2 ' +
      ') n ' +
      `left join ${PAYER_IDENTITY_TABLE} pi on pi.canonical_payer_id = n.canonical_payer_id ` +
      'order by q.alias_norm, n.similarity desc, n.alias_norm',
    params: [[...aliasNorms], limit],
  };
}
