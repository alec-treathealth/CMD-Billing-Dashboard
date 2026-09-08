/**
 * Payer-alias RULING QUEUE — pure SQL builders for the read side of /admin/payer-aliases.
 *
 * READ-ONLY BY CONSTRUCTION. Every builder here emits a SELECT. The write path (a SECURITY DEFINER
 * owned by claims_admin) is Artifact 3 and lands in a separate Veris migration; nothing in this file
 * may grow an INSERT/UPDATE/DELETE. Reads run as claims_reader, which holds SELECT on all three
 * `ref.*` tables and nothing else.
 *
 * SCOPE: `ref.payer_alias_map` + `ref.payer_identity`, plus ONE read-only evidence source —
 * `vob.member_benefits_latest`, read by `buildPayerAliasVobNamesQuery` alone so the vob_payer_id
 * tab can show the VOB names behind an id (2026-09-08; test/payerAliasQueue.test.ts names the
 * relation in its scope guard rather than loosening the guard). `claims.payer_alias` is a
 * DIFFERENT, unrelated table in the product plane (Billing Audit's facility-scoped matcher) and is
 * deferred until Phase 3 — do not join, reference, or "unify" the two here.
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
 * ⚠️ ONE CAUTION THAT SHAPES THE API — AND IT IS A PRECAUTION, NOT A REPO CONVENTION. Read the
 * provenance before treating it as a rule:
 *   · OBSERVED — `employer_name` is in the PhiKey union (`app/lib/phi.ts`) and was ruled display-
 *     permissible to an authenticated principal (2026-08-14).
 *   · INFERRED — `alias_norm` can therefore CONTAIN an employer name, because `employer_self_funded`
 *     is a live value in the `payer_alias_map_relationship` CHECK.
 *   · ASSUMED — that the employer convention transfers to this column. NOTHING SAYS IT DOES.
 *     `pr_compliance_checklist.yaml`'s PHI denylist enumerates patient_name / member_id / dob and
 *     does not mention employer_name, alias_norm, or any payer field.
 *
 * So the handling below is a deliberate over-caution, chosen because the cost is near zero (offset
 * paging instead of a keyset cursor) and the downside of being wrong is a payer-adjacent employer
 * string in a URL. It is enforced by the tests in this repo and by nothing else. If it should be a
 * convention, it needs a line in `pr_compliance_checklist.yaml` — that is a named follow-up, not
 * something this file can grant itself.
 *
 * The handling: `alias_norm` is only ever a BOUND PARAMETER here, and is never accepted as, or
 * emitted into, a route value. Page position is an integer offset for exactly this reason — a keyset
 * cursor would have to carry `alias_norm` through the URL.
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

export function isPayerAliasRelationship(value: unknown): value is PayerAliasRelationship {
  return typeof value === 'string' && (PAYER_ALIAS_RELATIONSHIPS as readonly string[]).includes(value);
}

/**
 * The relationship a ruling form should OPEN on for a queue row.
 *
 * ⚠️ IT IS THE ROW'S OWN PROPOSED RELATIONSHIP, NOT A CONSTANT (Qodo #335 finding 1). The form used
 * to hard-code `same_payer`, while the page passed only the proposed CANONICAL — so a row proposing
 * `carve_out`, `tpa` or `employer_self_funded` would be confirmed as `same_payer` by a reviewer who
 * accepted the pre-selected payer without noticing the relationship control. That writes a permanent
 * falsehood into a row whose entire purpose is attributed truth.
 *
 * Unreachable with today's queue — measured 2026-09-07, the 990 unruled rows are 730 `same_payer`
 * (all with a canonical) and 260 `unmapped` (none with one). But 36 CONFIRMED rows carry `carve_out`,
 * so the value is live in this dataset and a proposer emitting one is not hypothetical.
 *
 * Falls back to `same_payer` only when the stored value is not a member of the union — which the
 * `payer_alias_map_relationship` CHECK should make impossible, so the fallback is for a column that
 * has drifted, not for a normal row.
 */
export function defaultRulingRelationship(rowRelationship: unknown): PayerAliasRelationship {
  return isPayerAliasRelationship(rowRelationship) ? rowRelationship : 'same_payer';
}

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

/** One selectable canonical payer for the ruling form. ACTIVE only — the definer rejects a retired
 *  identity, so offering one would be a dead end the reviewer only discovers on submit. */
export interface PayerIdentityOptionRow {
  canonical_payer_id: string;
  display_name: string;
  entity_kind: string | null;
}

/** All live identities, ordered for a picker. 188 rows today — small enough to send whole. */
export function buildPayerIdentityOptionsQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      'select canonical_payer_id, display_name, entity_kind ' +
      `from ${PAYER_IDENTITY_TABLE} where is_active order by display_name`,
    params: [],
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * VOB NAMES BEHIND A PAYER ID — the one read on this surface that leaves the two `ref.*` tables.
 *
 * `vob_payer_id` rows are IDENTIFIERS, not names (see VOCAB_HINTS): a reviewer cannot judge `62308`
 * by reading it. What they CAN judge is the set of insurance-company names that VOBs filed under
 * that id — which is exactly what Veris 026 §8c read to seed these rows in the first place. This
 * builder re-reads the same source (`vob.member_benefits_latest`, one row per member, claims_reader
 * SELECT granted by product migration 0063) so the card can show the evidence the machine saw.
 *
 * ── BARE EQUALITY JOIN, MEASURED 2026-09-07 ──────────────────────────────────────────────────────
 * `v.payer_id = q.alias_norm` — no upper(), no btrim(), no ltrim(). Against the live matview that
 * matches 23,979 of 23,992 VOB rows carrying a payer_id (99.95%) with ZERO fan-out: one VOB row
 * joins one alias. `ltrim` was tried and REJECTED — it adds no coverage and creates a 1,103-row
 * fan-out. The 13 unmatched rows are not a normalisation gap worth a fan-out to close.
 *
 * ── THE APOSTROPHE FINDING — "first row on the page" is not "representative row" ─────────────────
 * The vob_payer_id tab is alphabetical (there is no confidence to sort by), and its FIRST card is
 * `'01260` — a leading apostrophe, the spreadsheet text-marker artefact. It is the top card ONLY
 * because `'` (0x27) sorts before every digit, and it is 1 of exactly 2 apostrophe rows in 359.
 * Anyone eyeballing the page for a "typical" row meets the least typical one first: the sort key
 * decides which row is first, and nothing about being first makes a row representative. The
 * bare-equality join handles it correctly anyway (the raw payer_id carries the same apostrophe), so
 * this note exists to stop a later reader from "fixing" the join for a 2-row case.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────────────────────────
 * ONE query for the whole page, batched by the page's alias set — never per card. Per id: the top
 * `perId` names by member count (cap 12, a bound param), plus `total_names` and `total_members`
 * over ALL names for that id, so the UI can say "showing 12 of 47 · 1,204 members" without a second
 * query. Names are grouped as `upper(btrim(insurance_co))` because that is the `vob_insurance_co`
 * alias_norm normalisation (026 §8c's `id_names` CTE): a name shown here is the string a reviewer
 * would find on the VOB-insurance-co tab, not a casing variant of it. A VOB row with an empty
 * insurance_co cannot be named and is not counted.
 *
 * Written as nested subqueries rather than a CTE so it starts with `select`, which is what the
 * read-only guard asserts of every read builder.
 *
 * NON-PHI: a payer id, a payer name, and a COUNT of members. No member_id_bidx, no prefix, no group
 * number is projected — the matview's blind-index columns are never read.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

export const PAYER_ALIAS_VOB_SOURCE = 'vob.member_benefits_latest';

/**
 * Names returned per payer id. Chosen against the measured distribution of names-per-id over the
 * 359 vob_payer_id rows (2026-09-07): median 2, mean 9.36, p90 13.2, max 369. Twelve shows every
 * name whole on roughly nine cards in ten; the tail beyond it is what `total_names` is for.
 */
export const VOB_NAMES_PER_ID = 12;

export interface PayerAliasVobNameRow {
  /** The `vob_payer_id` alias_norm this name was filed under — the loader's grouping key. */
  payer_id: string;
  /**
   * `upper(btrim(insurance_co))` — the vob_insurance_co alias_norm form. NULL on exactly one kind
   * of row: the MARKER the query emits for an id that has members but no named ones, so the card
   * can say that instead of "no VOB row" (Qodo #343 finding 2).
   */
  name: string | null;
  /** Members whose latest VOB carries this id AND this name. `count(*)::int`, so a number. 0 on a marker. */
  members: number;
  /** Distinct NAMED entries under this id, over ALL names — not only the `perId` returned. 0 on a marker. */
  total_names: number;
  /**
   * EVERY member whose latest VOB carries this id, named or not. A blank insurance_co is a member
   * without a name, not a missing member — this figure must not shrink because a VOB left the
   * company field empty. Measured 2026-09-07: 0 blank rows today; this guards the drift.
   */
  total_members: number;
  /** Of total_members, how many carry a name. total_members − named_members = unnamed. */
  named_members: number;
}

export function buildPayerAliasVobNamesQuery(
  payerIds: readonly string[],
  perId: number = VOB_NAMES_PER_ID,
): { sql: string; params: unknown[] } {
  const limit = clampInt(perId, 1, 50, VOB_NAMES_PER_ID);
  // Two aggregates over the same bare-equality join (Qodo #343 finding 2):
  //   n — the POPULATION: every member under the id, named or not (total_members), and how many
  //       carry a name (named_members). Aliased `n` so the per-id cap window stays
  //       `partition by n.payer_id`, which the root suite pins as the proof the cap is per id.
  //   x — the NAMED subset the list is built from, unchanged from the first version.
  // LEFT JOIN n→x: an id whose members are all unnamed yields ONE row with x.* null — name null,
  // members 0, total_names 0 — which is the MARKER the card renders as "N members, none named"
  // instead of the false "No VOB row carries this payer id". No CTE and no UNION: the read-only
  // guard requires every read builder to START with `select`, and this one does.
  return {
    sql:
      'select r.payer_id, r.name, r.members, r.total_names, r.total_members, r.named_members ' +
      'from ( ' +
      '  select n.payer_id, x.name, coalesce(x.members, 0) as members, ' +
      '         row_number() over (partition by n.payer_id order by x.members desc nulls last, x.name) as rn, ' +
      '         (count(x.name) over (partition by n.payer_id))::int as total_names, ' +
      '         n.total_members, n.named_members ' +
      '  from ( ' +
      '    select q.alias_norm as payer_id, count(*)::int as total_members, ' +
      "           count(nullif(btrim(v.insurance_co), ''))::int as named_members " +
      '    from unnest($1::text[]) as q(alias_norm) ' +
      `    join ${PAYER_ALIAS_VOB_SOURCE} v on v.payer_id = q.alias_norm ` +
      '    group by q.alias_norm ' +
      '  ) n ' +
      '  left join ( ' +
      '    select q.alias_norm as payer_id, upper(btrim(v.insurance_co)) as name, count(*)::int as members ' +
      '    from unnest($1::text[]) as q(alias_norm) ' +
      `    join ${PAYER_ALIAS_VOB_SOURCE} v on v.payer_id = q.alias_norm ` +
      "    where nullif(btrim(v.insurance_co), '') is not null " +
      '    group by q.alias_norm, upper(btrim(v.insurance_co)) ' +
      '  ) x on x.payer_id = n.payer_id ' +
      ') r ' +
      'where r.rn <= $2 ' +
      'order by r.payer_id, r.members desc, r.name',
    params: [[...payerIds], limit],
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE WRITE PATH — one builder, one definer, and the containment that must precede it.
 *
 * Everything above this line is a SELECT over the crosswalk. Everything below exists because
 * `claims_reader` holds no UPDATE on `ref.payer_alias_map` and never will: the only write is
 * EXECUTE on `ref.rule_payer_alias`, the SECURITY DEFINER applied by Veris 035.
 *
 * ⚠️ THE DEFINER CANNOT SUPPLY FIELD-LEVEL ERRORS, WHICH IS WHY THE CONTAINMENT BELOW EXISTS.
 * Discovered by probing it live at apply (2026-09-06): its `needs_review` row guard is the FIRST
 * thing it evaluates, before any field validation. Passing a well-formed-but-wrong relationship for
 * an alias that is already ruled — or simply misspelled — returns `P0002 no unruled row`, not the
 * `22023` the field actually deserves. Four probes intended to test relationship validation all came
 * back P0002 because the fixture alias lived in a different vocabulary.
 *
 * That ordering is CORRECT (fail closed on the row before trusting anything about the payload) and
 * must not be reordered. The consequence is that a user cannot be told which field is wrong by the
 * database, so every rejection the definer can raise is restated here and checked BEFORE the call.
 * The definer's own checks remain as the authority — this layer exists for the message, not the
 * safety.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The two DB-level actions. "Rule as unmapped" is a `confirm` carrying relationship `unmapped`. */
export const RULING_ACTIONS = ['confirm', 'defer'] as const;
export type RulingAction = (typeof RULING_ACTIONS)[number];

/**
 * The `claims.access_audit` action name for a ruling.
 *
 * ⚠️ IT LIVES HERE, NOT IN ruling-actions.ts, AND THAT IS NOT ARBITRARY. A `'use server'` module may
 * export ONLY async functions. Exporting a plain string from one passes `next build`, both
 * typechecks and both test suites, then throws at first require — "A 'use server' file can only
 * export async functions, found string" — and the blast radius is the whole PAGE, not the file:
 * Next generates one action-entry module per page, so a single bad export 500s every Server Action
 * on it while the page still renders 200. Constants that an action needs belong on this side of the
 * boundary.
 */
export const PAYER_ALIAS_RULING_AUDIT_ACTION = 'payer_alias_ruling_write';

/** `payer_identity_id_shape` + `payer_identity_id_len`, restated. */
export const CANONICAL_PAYER_ID_RE = /^pi_[a-z0-9_]+$/;

export interface PayerAliasRulingInput {
  vocabulary: PayerAliasVocabulary;
  aliasNorm: string;
  action: RulingAction;
  /** Required for `confirm`; ignored by the definer for `defer`. */
  relationship: PayerAliasRelationship | null;
  canonicalPayerId: string | null;
  reviewNote: string | null;
  /** The principal's email, resolved server-side from the session — NEVER client input. */
  ruledBy: string;
}

/** A rejection aimed at one form control, so the UI can point at it. */
export interface RulingFieldError {
  field: 'alias' | 'action' | 'relationship' | 'canonicalPayerId' | 'reviewNote' | 'ruledBy';
  message: string;
}

/**
 * SHAPE containment — every definer rejection that can be decided WITHOUT touching the database.
 * Ordered to mirror the definer so the first failure a user sees is the first one it would raise.
 */
export function validateRulingShape(input: PayerAliasRulingInput): RulingFieldError | null {
  if (!(RULING_ACTIONS as readonly string[]).includes(input.action)) {
    return { field: 'action', message: 'Pick Confirm or Defer.' };
  }
  // payer_alias_ruling_audit_ruled_by_len: 3..200. Cannot come from the client, but an empty session
  // email must never reach the definer as a bare 22023.
  const ruledBy = input.ruledBy.trim();
  if (ruledBy.length < 3 || ruledBy.length > 200) {
    return { field: 'ruledBy', message: 'Your account has no usable email; sign in again.' };
  }
  // payer_alias_map_alias_len: 1..200.
  const alias = input.aliasNorm;
  if (alias.length < 1 || alias.length > 200) {
    return { field: 'alias', message: 'That alias is not a valid crosswalk key.' };
  }

  const note = input.reviewNote === null ? null : input.reviewNote.trim();

  if (input.action === 'defer') {
    // The definer requires a note on defer — deferring without one records nothing.
    if (note === null || note.length < 2) {
      return { field: 'reviewNote', message: 'A defer needs a note saying what you found.' };
    }
    if (note.length > 500) {
      return { field: 'reviewNote', message: 'Keep the note under 500 characters.' };
    }
    return null;
  }

  // ── confirm ──
  if (input.relationship === null || !(PAYER_ALIAS_RELATIONSHIPS as readonly string[]).includes(input.relationship)) {
    return { field: 'relationship', message: 'Pick how this alias relates to a canonical payer.' };
  }
  // payer_alias_map_review_note_len: 2..500 when present. An empty note is stored as NULL, not ''.
  if (note !== null && note.length > 0 && (note.length < 2 || note.length > 500)) {
    return { field: 'reviewNote', message: 'A note must be 2–500 characters, or left blank.' };
  }

  const requires = RELATIONSHIP_REQUIRES_CANONICAL[input.relationship];
  if (requires && input.canonicalPayerId === null) {
    return { field: 'canonicalPayerId', message: `“${input.relationship}” needs a canonical payer.` };
  }
  if (!requires && input.canonicalPayerId !== null) {
    return {
      field: 'canonicalPayerId',
      message: `“${input.relationship}” must not carry a canonical payer.`,
    };
  }
  if (input.canonicalPayerId !== null && !CANONICAL_PAYER_ID_RE.test(input.canonicalPayerId)) {
    return { field: 'canonicalPayerId', message: 'That is not a canonical payer id.' };
  }
  return null;
}

/** What the containment query answers. `null` on either field means "no such row". */
export interface RulingContainmentFacts {
  /** `ref.payer_alias_map.needs_review` for the target, or null when the alias does not exist. */
  rowNeedsReview: boolean | null;
  /** `ref.payer_identity.is_active` for the proposed canonical, or null when it does not exist. */
  canonicalActive: boolean | null;
}

/**
 * DATABASE containment — the two rejections that need a read: does the target row exist and is it
 * still unruled, and is the proposed canonical payer real and live.
 *
 * ⚠️ THIS IS NOT THE SAFETY BOUNDARY AND MUST NOT BE MISTAKEN FOR ONE. Between this check and the
 * definer call another reviewer can rule the same row; the definer's own `and needs_review`
 * re-evaluates under `FOR UPDATE` and is what actually prevents the double-rule. This exists so the
 * common case produces "already ruled — refresh the queue" instead of an opaque P0002.
 */
export function validateRulingContainment(
  input: PayerAliasRulingInput,
  facts: RulingContainmentFacts,
): RulingFieldError | null {
  if (facts.rowNeedsReview === null) {
    return { field: 'alias', message: 'That alias is no longer in the queue. Refresh and try again.' };
  }
  if (facts.rowNeedsReview === false) {
    return { field: 'alias', message: 'Someone already ruled this alias. Refresh to see their ruling.' };
  }
  if (input.canonicalPayerId !== null) {
    if (facts.canonicalActive === null) {
      return { field: 'canonicalPayerId', message: 'That canonical payer does not exist.' };
    }
    if (facts.canonicalActive === false) {
      return { field: 'canonicalPayerId', message: 'That canonical payer is retired — pick a live one.' };
    }
  }
  return null;
}

/**
 * The containment READ. Two scalar subqueries, one round trip, both null-when-absent. It is a
 * SELECT and touches only the two in-scope tables, so it sits under the read-only guard with the
 * queue builders rather than with the write builder below.
 */
export function buildPayerAliasContainmentQuery(
  vocabulary: PayerAliasVocabulary,
  aliasNorm: string,
  canonicalPayerId: string | null,
): { sql: string; params: unknown[] } {
  return {
    sql:
      'select ' +
      `(select needs_review from ${PAYER_ALIAS_MAP_TABLE} ` +
      '  where vocabulary = $1 and alias_norm = $2) as "rowNeedsReview", ' +
      `(select is_active from ${PAYER_IDENTITY_TABLE} ` +
      '  where canonical_payer_id = $3) as "canonicalActive"',
    params: [vocabulary, aliasNorm, canonicalPayerId],
  };
}

/**
 * ⚠️ THE ONLY BUILDER ON THIS SURFACE THAT CAUSES A WRITE. Everything it changes is changed by the
 * definer, under the definer's owner — this emits a bare `select` of a function call and contains no
 * write verb of its own, which is exactly the property the read-only guard asserts about it.
 *
 * `ref.rule_payer_alias` is the single sanctioned mutation path for `ref.payer_alias_map`; adding a
 * second write builder here, or an `update` anywhere in this file, is a rule violation that
 * test/payerAliasQueue.test.ts fails on rather than a style preference.
 */
export const PAYER_ALIAS_RULING_FN = 'ref.rule_payer_alias';

export function buildPayerAliasRulingCall(input: PayerAliasRulingInput): {
  sql: string;
  params: unknown[];
} {
  const note = input.reviewNote === null ? null : input.reviewNote.trim();
  return {
    sql: `select ${PAYER_ALIAS_RULING_FN}($1, $2, $3, $4, $5, $6, $7) as ruling_id`,
    params: [
      input.vocabulary,
      input.aliasNorm,
      input.action,
      // The definer ignores these two on a defer; passing null keeps the audit row's "new" columns
      // equal to its "prior" columns, which is what a defer means.
      input.action === 'confirm' ? input.relationship : null,
      input.action === 'confirm' ? input.canonicalPayerId : null,
      note === null || note === '' ? null : note,
      input.ruledBy.trim(),
    ],
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
