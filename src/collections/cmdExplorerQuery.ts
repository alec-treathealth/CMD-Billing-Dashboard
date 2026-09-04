/**
 * Pure SQL builders + types for the CMD Collections explorer grid and its "smart search"
 * summary. NO Next.js, NO pg, NO I/O — just string building over a closed allowlist, so this
 * module is unit-testable in a plain Node test runner (the compliance-critical surface:
 * injection safety, the PHI-column exclusion, and LIKE-metachar escaping live here).
 *
 * app/lib/server.ts imports these and adds the DB execution + caching; it re-exports the public
 * names so callers keep importing them from '@/lib/server'. Every COLUMN name emitted here is a
 * fixed literal (search/sort/group columns resolve through closed allowlists); every VALUE is a
 * bound `$n` parameter via the `add` closure — never interpolated.
 */
import type { CmdExplorerRow } from './cmdExplorer.js';
import type { GroupedSortColumn } from './groupedSort.js';
// The SQL layer's one copy of the 'No Facility' literal. Imported rather than re-typed, per that
// module's own rule that "a site opts in by naming it".
//
// ⚠ THIS USE IS A FALLBACK, NOT THE SUPPRESSION THAT CONSTANT WAS MINTED FOR. Its docblock rules
// that ENTITY SURFACES suppress the placeholder while DENOMINATORS keep it, and explicitly
// disqualifies folding that logic into cmdExplorerBaseConds. Nothing here suppresses anything: the
// placeholder population is fully preserved and merely RE-PARTITIONED between "still unattributed"
// (branch 3) and "attributed by 0086" (branch 2), and only when a facility filter is active and the
// caller opted in. Collections' 2026-08-10 raw-grain ruling — that the grid keeps NF — is intact.
import { QUALIFY_NO_FACILITY_SQL } from './qualifyFacilityPlaceholder.js';

// --- filters + search allowlist ---------------------------------------------

/**
 * Closed allowlist for the smart search — the UI search-column key → raw SQL column literal.
 * ONLY the 4 TEXT columns admissions actually search by are here (facility / primary_payer /
 * cpt_code / revenue_code). The numeric + date columns (charge_amount, allowed_amount,
 * insurance_payments, adjustments, patient_balance_due, charge_date, payment_received) were REMOVED
 * from the substring bar: a leading-wildcard `::text ILIKE '%q%'` on them can't use any index and
 * roughly DOUBLED the per-keystroke aggregate cost for almost no real use (nobody free-text-searches
 * a dollar amount — the date window, the sort headers, and the drill chips are the right tools for
 * money/date). The 3 PHI columns (patient_name / member_id / group_number) are encrypted bytea and
 * cannot be substring-searched, so they are absent BY DESIGN (the gated blind-index lookup handles
 * those). The client only ever picks KEYS, never raw column names, so no identifier ever reaches SQL
 * from user input (injection-safe).
 */
export const CMD_EXPLORER_SEARCH_COLUMNS = {
  facility: 'facility',
  primary_payer: 'primary_payer',
  cpt_code: 'cpt_code',
  revenue_code: 'revenue_code',
} as const;
export type CmdExplorerSearchColumn = keyof typeof CMD_EXPLORER_SEARCH_COLUMNS;

/**
 * Minimum free-text term length before the substring search runs. A 1–2 char prefix (`%90%`) matches
 * a huge fraction of the tenant slice and is a THROWAWAY mid-typing query — also the single most
 * expensive to run — so a shorter term emits NO substring clause at all (the query degrades to a
 * plain browse of the current window). The client mirrors this floor (MIN_SEARCH_LEN in
 * cmd-explorer.tsx) to avoid firing the request; this is the authoritative, unit-tested server-side
 * floor that the summary + grid builders both honor.
 */
export const CMD_SEARCH_TERM_MIN = 3;

/**
 * Server-side filters for the explorer grid (non-PHI). `facility` is a MULTI-select set membership
 * (`facility = any(...)`) — the facility multi-select dropdown AND a single-facility drill-down chip
 * both feed it (the chip as a one-element array); its vocabulary comes from buildCmdFacilityOptionsQuery,
 * NOT the canonical facility dimension. An EMPTY array means "no facility restriction" (all facilities),
 * NOT "match nothing" — the condition is omitted entirely. `cpt_code` / `revenue_code` / `primary_payer`
 * are EXACT matches (drill-down chips); a (CPT, Revenue-code) combo chip sets `cpt_code` AND
 * `revenue_code` together. `from`/`to` window payment_received ([from, to)). `q` + `searchColumns`
 * are the free-text substring search: `q` is matched as a literal substring (ILIKE) against EACH
 * allowlisted column in `searchColumns`, OR'd together. All values are bound parameters; nulls/empties
 * are no-ops.
 */
export interface CmdExplorerFilter {
  facility?: string[] | null;
  cpt_code?: string | null;
  revenue_code?: string | null;
  primary_payer?: string | null;
  /**
   * Multi-select payer tags (the guided payer search). Set membership like `facility`: a NON-EMPTY
   * array ANDs `primary_payer = any(...)`; empty/absent = no payer restriction (not match-nothing).
   * Distinct from the single `primary_payer` (legacy single-drill field) — both are supported; the
   * explorer UI now feeds this array.
   */
  primary_payers?: string[] | null;
  /**
   * VOB MARKET filters — the member's verified employer / funding, matched through the
   * vob.member_benefits_latest matview on member_id_bidx (member-level; the bidx is tenant-agnostic).
   * Set membership like `facility`/`primary_payers`: a NON-EMPTY array narrows, empty/absent is no
   * restriction. `employers` matches employer_norm (the normalized, indexed employer key the
   * type-ahead picker supplies); `funding` matches the market tag ('Self-Funded' / 'Fully Insured').
   * SEMANTICS: the match is a SEMI-JOIN into the VOB set, so a charge whose member has NO VOB (or
   * whose VOB doesn't match) is EXCLUDED whenever either filter is active — "no-VOB excluded" is
   * intrinsic to the predicate, not a separate flag.
   */
  employers?: string[] | null;
  funding?: string[] | null;
  /**
   * COLLECTIONS-NATIVE employer filter (migration 0101) — the guided employer type-ahead.
   *
   * ⚠ DO NOT CONFUSE WITH `employers` DIRECTLY ABOVE. They are different dimensions from different
   * planes and are deliberately BOTH present:
   *   · `employers`      → vob.member_benefits_latest.employer_norm, reached by a member_id_bidx
   *                        semi-join. VOB-derived. Serves QUALIFY's market filter. Excludes any
   *                        member with no VOB.
   *   · `employer_names` → collections.cmd_explorer_rows.employer_name, the value that arrives on
   *                        the CMD report itself. NO VOB INVOLVEMENT WHATSOEVER (ruled 2026-08-15:
   *                        Collections reads collections data only). A charge with no VOB is fully
   *                        matchable here — which is most of the book.
   * Naming follows the existing `primary_payers` → `primary_payer` convention: the plural filter
   * field names the singular column it matches.
   *
   * Set membership like `facility`/`primary_payers`: a NON-EMPTY array narrows, empty/absent is NO
   * restriction (the condition is omitted entirely — never `= any(ARRAY[]::text[])`, which matches
   * nothing). Emitted as a semi-join on `id` because employer_name is not on the rollup the grid
   * reads; see the emitter in cmdExplorerBaseConds for why that is exact rather than approximate.
   */
  employer_names?: string[] | null;
  /**
   * Row ids the PATIENT-NAME search resolved to. Non-PHI: bigserial keys, the same ids the per-row
   * reveal already uses. The searched NAME never appears here, never reaches SQL, and never leaves
   * the server — only the ids it matched do, which is what makes this safe to put in a filter at
   * all. Empty/absent omits the condition; a search that matched NOTHING must pass `[]` plus its
   * own "no matches" state rather than an empty filter, or it would silently widen to every row.
   */
  row_ids?: string[] | null;
  /**
   * (tenant, member) PAIRS the FULL-BOOK patient-name search resolved to (migration 0105).
   *
   * Keyed-HMAC `member_id_bidx` values, not PHI: the token is one-way and the searched NAME never
   * reaches SQL. Replaces `row_ids` for name search, and the reason is capacity, not taste — a row
   * list has to be capped (it was capped at 2,000) because it grows with CHARGE LINES, while a
   * member list grows with PATIENTS. The whole book holds 686,503 charge lines and 10,941 members,
   * so the same predicate that could only ever describe 0.3% of the book now describes all of it.
   *
   * Matched at MEMBER grain, which is a deliberate and visible imprecision: 0.44% of members carry
   * more than one patient name (dependents on one subscriber policy), so matching such a name
   * returns that whole policy's charge lines. That is an OVER-return, never a miss — the directory
   * keys on the name, so every distinct name is findable. Precise name-grain filtering needs
   * cmd_explorer_rows.patient_name_bidx backfilled (7.18% populated today); see 0105's header.
   *
   * ⚠ IT IS A PAIR, NOT A TOKEN, AND THAT COST A REVIEW ROUND. The first version carried bare
   * `member_id_bidx` values. A member blind index is a keyed HMAC of the member id and NOTHING else,
   * so it is TENANT-AGNOSTIC — the same member id in both tenants hashes to the same token. Measured
   * live 2026-08-18: 240 of 10,701 member tokens exist in BOTH tenants. With bare tokens, a name
   * matched in one tenant selected the OTHER tenant's rows for all 240, in Consolidated view where
   * both are legitimately visible and the mix is therefore invisible. Same defect class as the
   * grouped-rows tenancy hole (#246) one layer up.
   *
   * Empty/absent omits the condition; present-but-empty means "matched nothing" and must select
   * NOTHING, exactly like row_ids.
   */
  patient_members?: Array<{ entity: string; member: string }> | null;
  /**
   * The employer SEGMENT toggle: 'all' (default) · 'employer' · 'individual'.
   *
   * 'individual' means "this policy has no plan sponsor" — a self-funded individual policy rather
   * than a group plan — and is derived from `employer_name IS NULL`. NOTHING IS EVER WRITTEN TO
   * MARK A ROW INDIVIDUAL (ruled 2026-08-15): storing a literal 'Individual' would make a real
   * employer of that name indistinguishable, push ~600k identical strings into the trigram index
   * the employer search depends on, and be irreversible once written.
   *
   * ⚠ NULL IS "NOT YET POPULATED", WHICH IS ONLY THE SAME AS "INDIVIDUAL" ONCE THE DATA LANDS.
   * Employer arrives on rows inserted after the CMD reports started carrying the column, plus
   * whatever the one-shot backfill matches. Before that, EVERY row is null and 'individual' would
   * select the entire book while claiming a meaning it cannot yet support. The predicate here is
   * honest either way — it is the CALLER's job not to offer the segment before coverage exists,
   * which is what buildCmdEmployerCoverageQuery measures.
   *
   * 'all' (or absent) emits NO condition — never a tautology like `1=1`, which would defeat the
   * planner's index selection on the semi-join path.
   */
  employerMode?: 'all' | 'employer' | 'individual' | null;
  from?: string | null; // 'YYYY-MM-DD' inclusive (payment_received >= from)
  to?: string | null; // 'YYYY-MM-DD' exclusive (payment_received < to)
  /**
   * Business-today (ISO, America/Los_Angeles) as resolved server-side for THIS request — the anchor
   * for the projected `is_scheduled` flag. Not a filter: it narrows nothing and appears in no WHERE
   * clause.
   *
   * ⚠ IT LIVES ON THE FILTER ANYWAY, AND THAT IS THE POINT. This object is part of the
   * unstable_cache key, so carrying the anchor here makes a cached page expire when the ops day
   * rolls. Threading it as a separate argument would have left yesterday's badges cached against
   * today's rows for up to the 900s TTL — a silent staleness bug in the one flag whose whole job is
   * to not be silently wrong.
   */
  businessToday?: string | null;
  q?: string | null; // substring term (matched literally; LIKE metachars escaped)
  searchColumns?: CmdExplorerSearchColumn[]; // which NON-PHI columns `q` searches
  /**
   * Searchable-PHI blind-index tokens (migration 0036) — ALREADY keyed-HMAC'd by the caller
   * (see blindIndex.ts). The RAW PHI never reaches this pure module: only the one-way token
   * does, and it's matched by equality. Each present token ANDs an equality predicate (an
   * identifier lookup narrows the result set). The action layer gates this to PHI-entitled
   * users + audits it; here it's just opaque tokens.
   */
  phiIndex?: {
    memberIdBidx?: string | null;
    memberIdPrefixBidx?: string | null;
    groupNumberBidx?: string | null;
  };
}

/** A `$n` parameter emitter: pushes a bound value and returns its placeholder. */
export type ParamAdder = (v: unknown) => string;

/** Escape LIKE metacharacters so `q` matches as a LITERAL substring, then wrap in %…%. */
export function likeContains(term: string): string {
  const escaped = term.replace(/([\\%_])/g, '\\$1');
  return `%${escaped}%`;
}

/** The employer / funding market filter (the member's verified VOB employer + funding). */
export interface VobMarketFilter {
  employers?: string[] | null; // selected employer_norm values (type-ahead picker vocabulary)
  funding?: string[] | null; // market tags: 'Self-Funded' / 'Fully Insured'
}

/**
 * The VOB employer/funding market predicate, as a SEMI-JOIN on member_id_bidx:
 *   `member_id_bidx in (select member_id_bidx from vob.member_benefits_latest where <conds>)`
 * Returns null when neither filter is active (a no-op). Shared by the collections grid/summary AND
 * the qualify builders so the predicate and its column names (funding / employer_norm) live in ONE
 * place. A SEMI-JOIN, not a JOIN: vob.member_benefits_latest also has member_id_bidx, so joining it
 * would make the callers' UNQUALIFIED member_id_bidx conditions ambiguous and force a FROM change.
 * Both sub-conditions target the SAME (latest) VOB row per member. "No-VOB excluded" is intrinsic —
 * a member absent from the subquery cannot satisfy the IN. Every value is bound via `add`.
 */
export function buildVobMarketSemiJoin(filter: VobMarketFilter, add: ParamAdder): string | null {
  const vobConds: string[] = [];
  if (Array.isArray(filter.funding) && filter.funding.length > 0) {
    vobConds.push(`funding = any(${add(filter.funding)}::text[])`);
  }
  if (Array.isArray(filter.employers) && filter.employers.length > 0) {
    vobConds.push(`employer_norm = any(${add(filter.employers)}::text[])`);
  }
  if (vobConds.length === 0) return null;
  // vob.member_benefits_latest is the MATERIALIZED latest-per-member set (migration 0063), refreshed
  // on each VOB load.
  return `member_id_bidx in (select member_id_bidx from vob.member_benefits_latest where ${vobConds.join(' and ')})`;
}

/**
 * The shared WHERE conditions for BOTH the explorer page query and the search-summary
 * aggregates: mandatory tenant scope first, then the optional exact/window/substring filters.
 * `add` pushes a bound parameter and returns its `$n` placeholder — every VALUE is bound, and
 * every column name is a fixed literal (search columns resolve through the closed allowlist).
 */
/** Postgres `bigint` upper bound. 19 digits, so a digit-COUNT check cannot stand in for a range
 *  check at the top of the domain: 9999999999999999999 is 19 digits and out of range. */
const PG_BIGINT_MAX = 9223372036854775807n;

/** A string Postgres will accept as `bigint`. BigInt() is exact here where Number() is not — above
 *  2^53 a float compares equal to the max and would slip through. The regex runs first, so BigInt()
 *  only ever parses plain digits and cannot throw. */
function isPgBigintText(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[0-9]{1,19}$/.test(v)) return false;
  return BigInt(v) <= PG_BIGINT_MAX;
}

/**
 * The 0086 facility-attribution matview — every 'No Facility' charge, at the SAME charge grain and
 * keyed by the SAME `id` as CMD_EXPLORER_CHARGE_ROLLUP (both are rebuilt from that rollup, and
 * `cmd_facility_resolution_id` is UNIQUE, so a join on id is 1:1 and can never fan out).
 *
 * ⚠ THE 1:1 CLAIM IS A REFRESH-CYCLE PROPERTY, NOT A PROPERTY OF `id`. veris-data-notes.md is
 * explicit that the rollup's `id` "is the latest snapshot's line id and shifts when new snapshots
 * arrive" — which is exactly why 0085 keys ASSIGNMENTS on the composite group key instead.
 *
 * ── WHAT HAPPENS WHEN THE TWO MATVIEWS DESYNC (verified 2026-08-30, do not re-derive) ──────────
 * They CAN desync. The hourly :45 route refreshes the rollup and this matview as TWO INDEPENDENT
 * statements in two transactions, and the second sits inside a catch that logs and swallows
 * (app/lib/server.ts, the refresh-charge-rollup handler) — deliberately, so a satellite refresh
 * cannot roll back the production rollup. So "rollup fresh, resolution stale" is a reachable state.
 *
 * IT IS FAIL-SAFE: a stale row matches NOTHING; it never matches the WRONG charge.
 *   - cmd_explorer_rows is append-only with a never-reused bigserial `id`, and a posting's 0059
 *     group membership is a pure function of its own immutable columns. So a posting id is either
 *     ITS OWN group's representative (max(id)) or not a representative at all — it can never become
 *     the representative of a DIFFERENT charge.
 *   - Measured, not assumed: of 27,907 placeholder postings, 11,446 are current representatives and
 *     **16,461 are superseded** — precisely the population a stale matview would be keyed on — and
 *     **0 of them land on a different charge** (group key compared column by column).
 * The failure mode is therefore UNDER-CLAIMING: the cell reverts to the raw 'No Facility', which is
 * the pre-2026-08-30 behaviour. Never misattribution — a charge cannot render another patient's
 * facility. The desync is also one-directional: this matview is DEFINED over the rollup, so it can
 * only lag, never lead.
 *
 * ⚠ WHAT IS MISSING, AND IT IS INVISIBLE: there is NO watermark, NO generation marker and NO drift
 * check on this matview — no `refreshed_at`, no `_state` table (contrast 0105's
 * cmd_patient_directory_state, which has both and a freshness query). Combined with the swallowing
 * catch, a failed refresh has NO reader-visible signal: charges simply go back to saying
 * 'No Facility'. A staleness proxy is derivable — count this matview's ids that are absent from the
 * rollup, 0 today — but nothing computes or surfaces it. Follow-up, not this change.
 *
 * Declared here rather than imported from facilityResolutionQuery.ts to keep the dependency
 * one-way: that module already imports `likeContains` from THIS one, so the reverse import would
 * close a cycle. It consumes this constant instead.
 */
export const CMD_FACILITY_RESOLUTION = 'collections.cmd_facility_resolution';

/**
 * Opt-ins for cmdExplorerBaseConds. Absent/false reproduces the pre-2026-08-30 SQL BYTE FOR BYTE.
 *
 * ⚠ THE DEFAULT IS OFF ON PURPOSE, AND IT IS THE WHOLE REASON THIS FLAG EXISTS. These conds are
 * shared with Qualify (`qualifyQuery.ts`) and Payer Intel (`payerIntelSearch.ts`), which have their
 * own, separately-ruled treatment of the 'No Facility' placeholder — see qualifyFacilityPlaceholder
 * .ts, whose docblock disqualifies folding placeholder logic into this helper precisely because it
 * "would silently change both". Flipping the default would do exactly that. Only the three
 * COLLECTIONS builders in this module opt in, and they opt in TOGETHER so the grid, the grouped
 * view and the search summary can never disagree about which rows a facility selection covers.
 */
export interface CmdExplorerCondOptions {
  /**
   * Resolve the facility filter through the 0086 matview, so a facility selection also returns the
   * 'No Facility' charges ATTRIBUTED to it — and so selecting 'No Facility' returns only the ones
   * still unattributed. Off = plain `facility = any(...)` against the raw CMD cell.
   */
  resolveFacility?: boolean;
  /**
   * Assert a CLOSED window: both `from` and `to` must be present, and both are emitted
   * unconditionally. Off = the historical behaviour, where each bound is emitted only if supplied.
   *
   * ⚠ THE COLLECTIONS PATH HAD NO UPPER BOUND AT ALL until 2026-08-30. `applyDateWindow`'s recency
   * branch set only `from` and returned early, so every preset was `today-N .. ∞` — which silently
   * included 106 future-dated charges (measured, all Indigo, all at business-today + 1) inside
   * totals a reader takes as settled cash. This flag makes an open-ended Collections window a
   * THROWN ERROR rather than a quietly-wrong result set.
   *
   * Opt-in for the same reason resolveFacility is: these conds are shared with Qualify and Payer
   * Intel, which have their own window semantics. Flipping the default would change them silently.
   */
  requireWindow?: boolean;
}

/**
 * What a CALLER of the three Collections builders may ask for.
 *
 * ⚠ DELIBERATELY THREADED FROM THE CALL SITE, NOT DEFAULTED INSIDE THE BUILDER (2026-08-31, #299).
 * Two of the three builders are shared, and defaulting `requireWindow` on inside them breaks a
 * consumer that is out of scope:
 *
 *   - `buildCmdExplorerQuery`        — also Payer Intel (app/lib/payer-intel/loaders.ts:369)
 *   - `buildCmdSearchSummaryQueries` — also Payer Intel (loaders.ts:296, :331) AND the retired-
 *     but-still-routable Qualify surface (app/lib/server.ts loadQualifyMatchSummary /
 *     loadQualifyPatientCohort)
 *   - `buildCmdExplorerGroupedQuery` — Collections only
 *
 * Qualify is the one that would actually THROW: app/lib/qualify/core.ts passes a windowless
 * `{ primary_payers: [p] }` whose own docblock says the windowlessness IS the semantic ("a zero
 * count means 'never billed, ever'"). The Qualify TAB was taken down 2026-08-17 and folded into
 * Payer Intel, but taken down is not deleted — /qualify still renders by direct URL and that loader
 * is still wired — so the hazard is live, not historical.
 *
 * ⚠ An earlier note in this repo blamed PAYER INTEL for this and was WRONG: Payer Intel sets BOTH
 * bounds unconditionally (app/lib/payer-intel/core.ts:432-454), so it would not have thrown. The
 * ~80 failing call sites that produced that diagnosis were TESTS passing windowless filters. Right
 * symptom, wrong cause — corrected here so the next reader does not inherit it.
 */
export interface CmdExplorerBuilderOptions {
  /** Assert a CLOSED window — see CmdExplorerCondOptions.requireWindow. Off unless asked. */
  requireWindow?: boolean;
  /**
   * GROUPED MODE ONLY — which column `buildCmdExplorerGroupedQuery` orders by. Defaults to
   * `payment_received`, which is what every caller got before this option existed.
   *
   * ⚠ EVERY OTHER BUILDER IGNORES IT. Row mode takes a real `sort` argument, so there is no call
   * site where passing this to the wrong builder would be a plausible mistake — but it is silently
   * inert there, so do not read its presence as evidence that a query is ordered by it.
   *
   * The CALLER is responsible for having clamped this through `resolveGroupedSort` first: the
   * builder emits whatever it is handed, and the window cap is policy, not SQL.
   */
  groupedSort?: GroupedSortColumn;
}

export function cmdExplorerBaseConds(
  filter: CmdExplorerFilter,
  entityIds: string[],
  add: ParamAdder,
  opts?: CmdExplorerCondOptions,
): string[] {
  const conds: string[] = [];
  // Tenant scope FIRST — server-derived entitled entity ids, applied to every read.
  //
  // ONE id emits plain EQUALITY, not `= any(...)`, and that is a measured performance fix rather
  // than a style preference. A ScalarArrayOp qual on the LEADING btree column stops the index from
  // returning rows in TRAILING-column order, so the grid's
  // `order by payment_received desc nulls last, id desc` could never be index-served: every page
  // load read the whole tenant slice and top-N sorted it. Measured on the bxr view, 51 rows out:
  // `= any(ARRAY[one])` → Parallel Index Scan + Sort, 61,296 buffers (479 MB); plain `=` →
  // ordered Index Scan on cmd_charge_rollup_entity_payment_id_desc, NO Sort node, 52 buffers
  // (0.41 MB), 4.2 ms. Same rows, ~1,180x fewer buffers.
  //
  // ⚠ STRICTLY length === 1. An EMPTY scope MUST stay on the array form, because
  // `= any(ARRAY[]::uuid[])` matches NOTHING and that is the fail-closed property the three
  // builders in THIS module rely on (they do not call assertEntityScope; the qualify/payer-intel
  // call sites do). Routing an empty array down the `=` branch would bind an array to a uuid
  // parameter — a type error, not a safe deny. Hence the `undefined` sentinel below rather than a
  // `length <= 1` test or a non-null assertion.
  //
  // The CONSOLIDATED (2-id) shape is deliberately unchanged and still plans as a Parallel Seq Scan;
  // making that index-servable needs a per-entity UNION ALL rewrite, which is a separate change.
  const soleEntityId = entityIds.length === 1 ? entityIds[0] : undefined;
  conds.push(
    soleEntityId !== undefined
      ? `business_entity_id = ${add(soleEntityId)}::uuid`
      : `business_entity_id = any(${add(entityIds)}::uuid[])`,
  );
  // Facility set-membership. A NON-EMPTY array narrows to those facilities; an EMPTY array (or
  // null/undefined) is NO restriction — the condition is omitted so the result set is ALL
  // facilities, never zero rows. (Emitting `= any(ARRAY[]::text[])` on empty would match nothing.)
  if (Array.isArray(filter.facility) && filter.facility.length > 0) {
    if (opts?.resolveFacility === true) {
      // RESOLUTION-AWARE facility membership (2026-08-30). Logically this is one predicate —
      //
      //     coalesce(<0086 facility_alias>, facility) = any($sel)
      //
      // — spelled as three OR'd branches so each one stays index-usable and so the sort tuple never
      // widens. It is NOT written as a join: the pre-LIMIT sort in the grouped builder already
      // spills (measured 2026-08-30, CONSOLIDATED scope, 90d: `external merge` Disk 4,544 kB leader
      // / 4,528 kB worker, 46,636 shared buffers), and adding a joined text column to that sort key
      // would deepen a spill we are not here to fix. A semi-join adds a filter; a join adds columns.
      //
      // ⚠ THE TWO SIDES SPEAK DIFFERENT NAMESPACES, which is the whole reason branch 2 is not a
      // plain equality. `filter.facility` carries CMD DISPLAY TEXT ('TREAT MENTAL HEALTH WASHINGTON
      // LLC') — the vocabulary buildCmdFacilityOptionsQuery emits — while `facility_alias` carries a
      // facility CODE ('TREAT_WA'). Measured 2026-08-30: all 13 live aliases are codes and NONE is
      // a selectable option today. So the labels are translated to codes INSIDE the predicate,
      // set-valued in both directions: one code can have several CMD spellings (LSMH is live proof
      // — 'LONESTAR MENTAL HEALTH' and 'LONESTAR MENTAL HEALTH LLC' both map to it), so selecting
      // EITHER spelling must reach the same resolved rows. Unioning codes into the dropdown instead
      // was rejected: it would list the label and the code as two options for one facility, which is
      // precisely the grid/filter disagreement this change exists to remove.
      // Each value bound ONCE and the placeholder re-referenced — a $n may appear any number of
      // times in one statement. Three separate add() calls for the same literal would work and
      // would be three copies of it on the wire.
      const sel = add(filter.facility);
      const scope = add(entityIds);
      const nf = add(QUALIFY_NO_FACILITY_SQL);
      conds.push(
        '(' +
          // 1. CMD named a facility: unchanged behaviour, still served by the rollup's own indexes.
          //    Guarded by `<> placeholder` so a row CMD left blank can never satisfy this branch and
          //    short-circuit branches 2/3 — those two own the placeholder population exclusively.
          `(facility <> ${nf} and facility = any(${sel}::text[])) or ` +
          // 2. The charge is attributed by 0086 to one of the selected facilities. `id in (...)`
          //    rather than EXISTS, for the reason the employer narrow below already records: it
          //    builds one bounded id set and hash-semi-joins it, instead of probing per outer row.
          `id in (select fr.id from ${CMD_FACILITY_RESOLUTION} fr ` +
          `where fr.business_entity_id = any(${scope}::uuid[]) and fr.facility_alias in (` +
          `select coalesce(fe.facility_code, a.facility_code) from unnest(${sel}::text[]) as s(label) ` +
          'left join collections.facilities fe on upper(fe.facility_name) = upper(s.label) ' +
          'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(s.label) ' +
          'where coalesce(fe.facility_code, a.facility_code) is not null)) or ' +
          // 3. 'No Facility' is itself selected AND this charge is still unattributed — so the
          //    selection returns the rows that still DISPLAY the placeholder, not every row that
          //    merely STORES it. Without this branch the grid would show a facility name in the cell
          //    and 'No Facility' would still select it, which is the defect in the opposite
          //    direction. Measured 2026-08-30: 6,064 of 11,446 placeholder charges are unresolved.
          //
          //    ⚠ `id NOT IN (<resolved ids>)`, NOT a correlated `not exists (… where fr2.id = id)`.
          //    These conds emit UNQUALIFIED column names (callers alias the rollup differently), so
          //    inside a subquery an unqualified `id` binds to the INNER relation and the correlation
          //    silently degrades to `fr2.id = fr2.id` — always true, so the branch would match
          //    nothing and every resolved row would vanish from a 'No Facility' selection. The
          //    uncorrelated anti-set has no such trap. NOT IN is safe here specifically because
          //    `cmd_facility_resolution.id` cannot be NULL (it carries a UNIQUE index and is the
          //    rollup's own key); a NULL in that set would make the predicate UNKNOWN for every row.
          `(facility = ${nf} and ${nf} = any(${sel}::text[]) ` +
          `and id not in (select fr2.id from ${CMD_FACILITY_RESOLUTION} fr2 ` +
          `where fr2.business_entity_id = any(${scope}::uuid[]) and fr2.facility_alias is not null))` +
          ')',
      );
    } else {
      conds.push(`facility = any(${add(filter.facility)}::text[])`);
    }
  }
  if (filter.cpt_code) conds.push(`cpt_code = ${add(filter.cpt_code)}`);
  if (filter.revenue_code) conds.push(`revenue_code = ${add(filter.revenue_code)}`);
  if (filter.primary_payer) conds.push(`primary_payer = ${add(filter.primary_payer)}`);
  // Payer set-membership (multi-select tags), same discipline as facility: non-empty array narrows,
  // empty/absent is no restriction (omitted, never `= any(ARRAY[]::text[])` which matches nothing).
  if (Array.isArray(filter.primary_payers) && filter.primary_payers.length > 0) {
    conds.push(`primary_payer = any(${add(filter.primary_payers)}::text[])`);
  }
  // VOB employer / funding market filters — shared semi-join helper (member_id_bidx IN (…); see
  // buildVobMarketSemiJoin for why it's a semi-join, not a JOIN). Applies identically to the grid and
  // every summary aggregate; "no-VOB excluded" is intrinsic when either filter is active.
  const vobMarket = buildVobMarketSemiJoin(filter, add);
  if (vobMarket) conds.push(vobMarket);
  // COLLECTIONS-NATIVE employer narrow (migration 0101) — NOT the VOB one directly above.
  //
  // A semi-join on `id` rather than a plain column predicate, because employer_name lives on the
  // base table and every builder sharing these conds reads the 0059 rollup, which has no such
  // column and deliberately never will (see migration 0101's grain note).
  //
  // This is EXACT, not an approximation: the rollup's `id` IS the latest snapshot's real
  // cmd_explorer_rows.id, so the inner set resolves 1:1 against outer rows — it can neither fan out
  // nor drop a charge. `id in (...)` (not EXISTS) so the trigram/PK path builds a bounded id set
  // once and hash-semi-joins it, instead of probing per outer row across the whole tenant slice.
  //
  // The inner select is NOT re-scoped by business_entity_id: `e.id = <rollup id>` already pins a
  // single base row, and the outer tenant scope is applied to that same row on the line above — a
  // second entity predicate would be redundant and would only mislead a future reader into thinking
  // this set is independently reachable. It is not; it is keyed by an id the outer query owns.
  //
  // Same empty-array discipline as facility/primary_payers: NON-EMPTY narrows, empty/absent omits.
  if (Array.isArray(filter.employer_names) && filter.employer_names.length > 0) {
    conds.push(
      `id in (select e.id from collections.cmd_explorer_rows e ` +
        `where e.employer_name = any(${add(filter.employer_names)}::text[]))`,
    );
  }
  // Patient-name search result. Direct id equality — no join, no subquery: the ids were already
  // resolved server-side against this same tenant scope, so re-deriving them here would be
  // redundant work over a 670k-row table.
  //
  // ⚠ RANGE-FILTERED, NOT JUST BOUND. These are cast to ::bigint[], and a numeric string ABOVE
  // 9223372036854775807 raises 22003 `bigint out of range` at execution — a 500, not an empty
  // result. The action layer validates (applyRowIds → isPgBigintString), but this function is
  // EXPORTED and the same defence-in-depth argument the sort column already makes applies here: a
  // future caller could reach it without going through that boundary.
  //
  // Dropping an out-of-range id is semantically FREE, not a silent narrowing — no row can carry an
  // id bigint cannot represent, so it could never have matched anything.
  if (Array.isArray(filter.row_ids) && filter.row_ids.length > 0) {
    const safe = filter.row_ids.filter(isPgBigintText);
    if (safe.length > 0) {
      conds.push(`id = any(${add(safe)}::bigint[])`);
    } else {
      // Every id was unusable, but the caller DID ask for a set. Omitting the condition here would
      // widen the grid back to every row — the opposite of the request, and the same trap the empty
      // `row_ids: []` case documents. Emit an impossible predicate instead so the result is empty.
      conds.push('false');
    }
  }
  // FULL-BOOK patient-name search result (0105). A direct predicate on the rollup itself — both
  // business_entity_id and member_id_bidx are projected by the 0050 matview and covered by 0092's
  // indexes, so this needs neither a join nor a subquery.
  //
  // PAIRWISE, via two parallel bound arrays zipped by unnest. `member_id_bidx = any(tokens)` would
  // be wrong: the token is tenant-agnostic, so in a multi-entity view it selects every tenant that
  // happens to share a member id (240 of 10,701 do). Zipping keeps each match bound to the tenant it
  // was matched IN. The two arrays are built from one array of pairs immediately below, so they
  // cannot drift out of alignment.
  //
  // NO RANGE FILTER is needed here, unlike row_ids: these are text/uuid values compared as such, so
  // a malformed value can only fail to match. There is no 22003 cast hazard to defend against.
  if (Array.isArray(filter.patient_members)) {
    if (filter.patient_members.length > 0) {
      const entities = filter.patient_members.map((p) => p.entity);
      const members = filter.patient_members.map((p) => p.member);
      conds.push(
        `(business_entity_id, member_id_bidx) in ` +
          `(select e, m from unnest(${add(entities)}::uuid[], ${add(members)}::text[]) as t(e, m))`,
      );
    } else {
      // Present but empty = "the search matched nobody". Omitting the condition would widen the
      // grid to every row and present it as a name result, which is the row_ids trap in a new
      // costume. Emit an impossible predicate so the grid is honestly empty.
      conds.push('false');
    }
  }
  // Employer SEGMENT toggle. Same id semi-join shape as the name filter above and exact for the
  // same reason (rollup id IS the base row id, 1:1).
  //
  // 'employer' tests `is not null AND <> ''` rather than just `is not null`: mapRow coerces a blank
  // CMD cell to null, but the 622k CSV-backfilled rows predate that path, so an empty string is a
  // reachable state. Treating '' as "has an employer" would put a blank-labelled bucket in the
  // segment and an unpickable blank option in the type-ahead.
  //
  // 'individual' is the exact complement, INCLUDING the empty string, so the two segments always
  // partition the book — every row is in exactly one, and 'employer' + 'individual' always sums to
  // 'all'. A reader comparing segment counts to the unfiltered total must never find a gap.
  if (filter.employerMode === 'employer') {
    conds.push(
      `id in (select e.id from collections.cmd_explorer_rows e ` +
        `where e.employer_name is not null and e.employer_name <> '')`,
    );
  } else if (filter.employerMode === 'individual') {
    conds.push(
      `id in (select e.id from collections.cmd_explorer_rows e ` +
        `where e.employer_name is null or e.employer_name = '')`,
    );
  }
  if (opts?.requireWindow === true) {
    // Fail loud, not fail open. A missing bound here is a bug at the app boundary, and the failure
    // mode without this check is invisible: a grid that quietly returns more rows than it should.
    if (!filter.from || !filter.to) {
      throw new Error('cmdExplorerBaseConds: requireWindow needs BOTH from and to; the Collections window must be closed');
    }
    conds.push(`payment_received >= ${add(filter.from)}::date`);
    conds.push(`payment_received < ${add(filter.to)}::date`);
  } else {
    if (filter.from) conds.push(`payment_received >= ${add(filter.from)}::date`);
    if (filter.to) conds.push(`payment_received < ${add(filter.to)}::date`);
  }
  const term = typeof filter.q === 'string' ? filter.q.trim() : '';
  const cols = (filter.searchColumns ?? []).filter(
    (c): c is CmdExplorerSearchColumn => Object.prototype.hasOwnProperty.call(CMD_EXPLORER_SEARCH_COLUMNS, c),
  );
  // A sub-minimum term emits NO substring clause (see CMD_SEARCH_TERM_MIN) — the short-prefix
  // scans were the bulk of the wasted work, and this is the authoritative floor both builders share.
  if (term.length >= CMD_SEARCH_TERM_MIN && cols.length > 0) {
    const p = add(likeContains(term)); // one bound pattern, reused across the OR
    // NO cast: all four allowlisted search columns ARE text (verified against the live rollup
    // 2026-08-03), so `::text` was a parse-time no-op the planner already stripped. It is
    // dropped so the predicate matches the 0081 trigram GIN indexes BY INSPECTION — and because
    // a cast on a hypothetical future non-text column would silently make these indexes
    // unreachable (such a column would need its own expression index, not a cast here).
    const ors = cols.map((c) => `${CMD_EXPLORER_SEARCH_COLUMNS[c]} ilike ${p}`);
    conds.push(`(${ors.join(' or ')})`);
  }
  // Searchable-PHI blind-index equality (opaque keyed-HMAC tokens; raw PHI never gets here).
  const phi = filter.phiIndex;
  if (phi?.memberIdBidx) conds.push(`member_id_bidx = ${add(phi.memberIdBidx)}`);
  if (phi?.memberIdPrefixBidx) conds.push(`member_id_prefix_bidx = ${add(phi.memberIdPrefixBidx)}`);
  if (phi?.groupNumberBidx) conds.push(`group_number_bidx = ${add(phi.groupNumberBidx)}`);
  return conds;
}

// --- facility options (multi-select dropdown) -------------------------------

/**
 * One facility choice for the multi-select dropdown. `facility` is the EXACT filterable value
 * (what the grid/summary match on — the CMD report's own facility text). `facility_name` is the
 * friendlier dimension name when it resolves, else null (falls back to `facility` in the UI).
 * `care_setting` powers the "select all IP/OP" group affordance; null = Unclassified/Other (the
 * facility isn't in collections.facilities, or its CMD text doesn't match the dimension name —
 * this is expected for a chunk of BXR facilities whose export text carries a trailing " LLC").
 */
export interface CmdFacilityOption {
  facility: string;
  facility_name: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

/**
 * ONE OPTION PER FACILITY for Qualify's facility picker — the de-duplicated shape.
 *
 * WHY THIS EXISTS SEPARATELY FROM CmdFacilityOption. That one is DISTINCT on the raw CMD facility
 * text, so a facility whose CMD export carries more than one spelling appears more than once. Live
 * example: `LONESTAR MENTAL HEALTH` (4,156 charge lines) and `LONESTAR MENTAL HEALTH LLC` (81 lines)
 * both resolve to `LSMH` and both label from the same dimension row, so the dropdown rendered TWO
 * rows with byte-identical text and the same IP badge. Picking one silently scoped the search to
 * 4,156 lines and picking the other to 81, with nothing on screen to tell them apart.
 *
 * Collapsing by resolved `facility_code` fixes both halves: one row per facility, and `variants`
 * carries EVERY raw text so selecting it covers all 4,237 lines. `CmdExplorerFilter.facility` is
 * already `string[]`, so the variants expand into the existing predicate with no schema change.
 *
 * A text that resolves to no facility (the `No Facility` placeholder, 11,414 lines) groups by itself
 * and keeps its own row — it is a real bucket in the data, not a duplicate.
 *
 * The Collections explorer deliberately keeps using CmdFacilityOption: it is production and out of
 * scope here.
 */
export interface QualifyFacilityOption {
  /** The canonical raw CMD text for this facility — what the UI stores as the selected value. */
  value: string;
  /** EVERY raw CMD text this option covers, including `value`. Expanded into the filter. */
  variants: string[];
  /** display_acronym, else facility_name, else the canonical raw text. */
  display: string;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

/**
 * Build the tenant-scoped facility-options query for the dropdown. The DISTINCT facility list is
 * read from collections.cmd_explorer_filter_options (migration 0080) — the tiny precomputed
 * (business_entity_id, kind, value) dimension matview, refreshed by the same hourly function as
 * the charge rollup — scoped to the caller's entitled entityIds (a BXR user never sees an
 * Indigo-only facility string). BEFORE 0080 this ran a DISTINCT over the whole 503MB/642k-row
 * tenant slice of cmd_explorer_rows per cache miss (measured 1.9s warm / 33.9s cold); the
 * matview is <100KB. Vocabulary semantics are preserved: the matview derives from the 0050/0059
 * charge rollup, which is exactly what the grid/summary `facility = any(...)` filter executes
 * against. Each value is then resolved to the non-PHI facility dimension purely to enrich
 * name + care_setting. Resolution is two-path: an EXACT name match, else the explicit
 * cmd_facility_aliases crosswalk (migration 0039) — which reconciles the CMD export text with the
 * curated dimension name (trailing " LLC", abbreviations, multi-text facilities, a confirmed typo).
 * care_setting is always read from the resolved dimension row (single source of truth), never the
 * crosswalk. The dimension has no business_entity_id, so it is NOT tenant-filtered — but since we
 * only ever surface facility STRINGS that already passed the tenant scope, no other tenant's
 * facility leaks into the list; the joins only attach the IP/OP label. A text that resolves to
 * neither (e.g. the "No Facility" placeholder) yields a null care_setting → "Other" in the UI.
 * `max()` collapses any join multiplicity. Non-PHI; every value bound ($1 = entityIds), every
 * identifier a fixed literal. Null/blank filtering is baked into the matview definition.
 */
export function buildCmdFacilityOptionsQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds];
  const sql =
    'select r.facility, max(f.facility_name) as facility_name, max(f.care_setting) as care_setting ' +
    'from (select distinct value as facility from collections.cmd_explorer_filter_options ' +
    "where business_entity_id = any($1::uuid[]) and kind = 'facility') r " +
    'left join collections.facilities fe on upper(fe.facility_name) = upper(r.facility) ' +
    'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(r.facility) ' +
    'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, a.facility_code) ' +
    'group by r.facility order by r.facility';
  return { sql, params };
}

/**
 * Qualify's facility options, ONE ROW PER FACILITY (see QualifyFacilityOption for why).
 *
 * Same vocabulary source and same two-path crosswalk as buildCmdFacilityOptionsQuery — the 0080
 * filter-options matview, then an exact name match else the cmd_facility_aliases crosswalk — so the
 * option set stays exactly the set of facility texts the grid/summary predicate can match. The only
 * difference is the GROUP BY: `coalesce(f.facility_code, upper(r.facility))` collapses every raw
 * spelling of one facility into a single row and `array_agg` keeps all of them.
 *
 * The label prefers `display_acronym`, which is populated for all 16 mnemonic (BXR) facilities and
 * NULL for every 8-digit (Indigo) one — hence the mandatory `facility_name` fallback, and then the
 * raw text for an unresolved bucket. That ordering also settles a naming inconsistency the raw
 * dimension name could not: `CALIFORNIA MENTAL HEALTH LLC` resolves to a dimension row named
 * `CA MENTAL HEALTH`, so labelling from facility_name alone showed a different name in the picker
 * than everywhere else. `display_acronym` is the curated short label and is the same in both places.
 *
 * Non-PHI throughout (facility names and CMD export text). $1 = entityIds is the only bound value;
 * every identifier is a fixed literal.
 *
 * ── DELIBERATE CROSS-TENANT READ — justification (compliance checklist) ───────────────────────────
 * `business_entity_id = any($1::uuid[])` spans MORE THAN ONE tenant on purpose. Qualify is a
 * cross-tenant surface by product decision: an admissions lead is qualified against the whole book
 * (BXR + Indigo), because the question "who reimburses this policy best" has no per-tenant answer.
 * The scope is NOT client-supplied — `requireQualifyPrincipal` returns a PINNED
 * [BXR_ENTITY_ID, INDIGO_ENTITY_ID] array (app/lib/qualify/principal.ts, QUALIFY_ENTITY_IDS) that no
 * request parameter can widen or redirect, and `assertEntityScope` throws on an empty or malformed
 * scope rather than reading every tenant's rows. The identical array is what the ranking, KPI and
 * compose queries already run under (QUALIFY_TENANT_SCOPE = 'cross-tenant-bxr-indigo').
 * What this returns is non-PHI in both directions: facility names and CMD export text, never a
 * patient identifier or a dollar figure. The `collections.facilities` /
 * `collections.cmd_facility_aliases` joins are NOT tenant-filtered (the dimension is entity-less),
 * but they only enrich labels for facility texts that ALREADY passed the tenant scope in the inner
 * select, so no other tenant's facility can enter the list through them.
 */
export function buildQualifyFacilityOptionsQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds];
  const sql =
    // Cross-tenant by design; scope is the caller's PINNED principal array, never request input.
    'select coalesce(f.display_acronym, f.facility_name, min(r.facility)) as display, ' +
    'min(r.facility) as value, ' +
    'array_agg(r.facility order by r.facility) as variants, ' +
    'max(f.care_setting) as care_setting ' +
    'from (select distinct value as facility from collections.cmd_explorer_filter_options ' +
    "where business_entity_id = any($1::uuid[]) and kind = 'facility') r " +
    'left join collections.facilities fe on upper(fe.facility_name) = upper(r.facility) ' +
    'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(r.facility) ' +
    'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, a.facility_code) ' +
    // Unresolved texts group by themselves (upper() so two casings of one unresolved text still
    // collapse); resolved ones group by their facility_code.
    'group by coalesce(f.facility_code, upper(r.facility)), f.display_acronym, f.facility_name ' +
    'order by 1';
  return { sql, params };
}

/**
 * Distinct payer names for the guided PAYER search's type-ahead, tenant-scoped to the caller's
 * entitled entityIds. Reads collections.cmd_explorer_filter_options (migration 0080, kind =
 * 'payer') — the precomputed dimension matview — instead of a DISTINCT over the 503MB
 * cmd_explorer_rows slice (measured 1.9s warm / 33.9s cold before 0080). DISTINCT is still
 * required: a multi-entity scope (Consolidated) can hold the same payer name under both
 * entities. Non-PHI (`primary_payer` is a payer name, not an identifier). Blank/null payers are
 * excluded by `cmd_explorer_filter_options`'s OWN definition (0080) — ⚠ that is a statement about
 * THIS matview and nothing else. It is NOT true of `cmd_explorer_charge_rollup` (0059), whose body
 * does not filter the column, nor of `cmd_explorer_rows` (0019), where `primary_payer` is a bare
 * `text` and cmdExplorer's norm() maps a blank cell to NULL. Anything aggregating over those must
 * handle a null payer itself; see the payer_count derivation in app/lib/qualify/core.ts, which does.
 * Results are ordered for a stable client list. Every value
 * is bound ($1 = entityIds); every identifier is a fixed literal. ~260 distinct payers per
 * tenant, so the client loads the full list ONCE and filters it as the user types — no
 * per-keystroke round-trip and no server-side pagination needed at this cardinality.
 */
export function buildCmdPayerOptionsQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds];
  const sql =
    'select distinct value as primary_payer from collections.cmd_explorer_filter_options ' +
    "where business_entity_id = any($1::uuid[]) and kind = 'payer' " +
    'order by primary_payer';
  return { sql, params };
}

/** The funding-market vocabulary — the exact stored values the `funding` filter matches. Static (a
 *  two-value enum), so the UI renders a fixed toggle/tag set with no query. */
export const CMD_FUNDING_MARKETS = ['Self-Funded', 'Fully Insured'] as const;

/**
 * One employer choice for the guided employer type-ahead. `employer_norm` is the EXACT filter value
 * (what the grid/qualify `employers` filter matches — the normalized, indexed key); `employer_name`
 * is a representative raw display name (several raw spellings can collapse to one norm), or null.
 */
export interface CmdEmployerOption {
  employer_norm: string;
  employer_name: string | null;
}

/**
 * Distinct EMPLOYER options for the guided employer type-ahead. UNLIKE facility/payer (loaded once at
 * ~260 each), there are ~11.6k distinct employers, so this is a SERVER-SIDE, per-keystroke search:
 * the caller passes the typed `term` (gate a sub-CMD_SEARCH_TERM_MIN term client-side) and a `limit`.
 * Tenant-scoped to employers that actually appear for the caller's own members (via the VOB↔collections
 * member_id_bidx link) so a picked option always has rows. Returns the FILTER value (`employer_norm` —
 * what the grid/qualify `employers` filter matches) plus a representative display `employer_name`
 * (multiple raw names can share one norm). `term` is a LITERAL substring (LIKE metachars escaped);
 * every value is bound ($1 entityIds, $2 pattern, $3 limit), every identifier a fixed literal.
 */
export function buildCmdEmployerOptionsQuery(
  entityIds: string[],
  term: string,
  limit: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds, likeContains(term), limit];
  const sql =
    // DISPLAY the normalized key itself (not a raw variant): employer_norm is the aggressive
    // canonical key (0064), so "GOOGLE" — the value AND the label — reads clean and matches what the
    // filter narrows by. (Before 0064's collapse, max(employer_name) surfaced ugly raw variants.)
    'select employer_norm, employer_norm as employer_name ' +
    // Materialized latest-per-member set (0063/0064): the employer_norm trigram GIN index serves the
    // leading-wildcard ILIKE, and the set is deduped once per load — not recomputed per keystroke.
    'from vob.member_benefits_latest ' +
    'where employer_norm is not null and employer_norm ilike $2 ' +
    'and member_id_bidx in (select member_id_bidx from collections.cmd_explorer_rows ' +
    'where business_entity_id = any($1::uuid[])) ' +
    'group by employer_norm order by employer_norm limit $3';
  return { sql, params };
}

/**
 * COLLECTIONS-NATIVE employer options for the guided employer type-ahead (migration 0101).
 *
 * ⚠ THIS IS NOT buildCmdEmployerOptionsQuery ABOVE, AND THE TWO MUST NOT BE MERGED. That one reads
 * vob.member_benefits_latest.employer_norm and exists to serve QUALIFY's market filter. This one
 * reads collections.cmd_explorer_rows.employer_name — the value that arrives on the CMD report
 * itself — and exists to serve COLLECTIONS. Ruled 2026-08-15: Collections reads collections data
 * only, no VOB. The practical difference is coverage, not style: the VOB set only knows members who
 * have a VOB on file, while this one covers every charge the CMD report carried an employer for.
 *
 * Server-side per-keystroke (not a load-whole-vocabulary dropdown like facility/payer, which are
 * ~260 entries each): the employer vocabulary is large — the VOB side alone carries ~11.6k distinct
 * values — so the client sends a typed `term` and this returns a bounded page.
 *
 * `term` is a LITERAL substring (LIKE metachars escaped by likeContains); every value is bound
 * ($1 entityIds, $2 pattern, $3 limit) and every identifier is a fixed literal — no user text ever
 * reaches SQL as an identifier. Tenant-scoped by the caller's entitled entity ids, so a picked
 * option always has rows the caller can actually see.
 *
 * The leading-wildcard ILIKE is served by 0101's trigram GIN (claims.gin_trgm_ops). Callers MUST
 * gate on CMD_SEARCH_TERM_MIN — a 1–2 char term matches a large fraction of the book and is the
 * single most expensive query here.
 *
 * ⚠ COST IS UNMEASURED UNTIL THE BACKFILL LANDS: the column is 100% NULL today, so any timing taken
 * now is meaningless. If this measures slow once ~650k rows carry employers, the fix is a small
 * distinct-employer matview in the 48 kB class of cmd_explorer_filter_options — NOT a column on
 * cmd_explorer_charge_rollup, which is 165 MB + 313 MB of indexes and whose grain excludes employer
 * by design (migration 0101's grain note). Measure before building either.
 */
/**
 * Does this tenant scope have ANY employer data yet? (migration 0101)
 *
 * The employer segment toggle needs this because `employer_name IS NULL` is ambiguous until the
 * data lands: it means "individual policy" AFTER the CMD reports start carrying the column and the
 * one-shot backfill runs, but "not yet populated" before. Offering an Individual segment in the
 * second state would select the entire book and label it something it is not — wrong in the most
 * expensive way, because it looks like a working filter.
 *
 * So the UI asks this first and degrades honestly: no coverage ⇒ show the toggle disabled with a
 * "no employer data yet" note instead of a filter that silently means "everything".
 *
 * EXISTS, not COUNT: the answer is a boolean and the question is asked on every page load. A count
 * over 650k rows would be a seq scan every time to compute a number nobody displays; EXISTS
 * short-circuits at the first matching row. The `employer_name <> ''` half matters — the CSV
 * backfill predates mapRow's blank→null coercion, so empty strings are reachable and must not
 * count as coverage.
 *
 * Served by 0101's PARTIAL index (business_entity_id) WHERE employer_name is not null — which is
 * what makes the NEGATIVE case fast too. Without it, "no coverage yet" is the slowest possible
 * answer (a full scan finding nothing), and that is precisely the state this exists to detect.
 */
export function buildCmdEmployerCoverageQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  // TWO booleans, because the coverage question has two different answers and they were conflated:
  //
  //   has_employer_data — does ANY selected tenant have employer values? Gates whether the
  //                       All/Employer/Individual segment and the type-ahead are shown at all.
  //   all_have_employer_data — does EVERY selected tenant have them? Gates the "Individual" LABEL.
  //
  // ⚠ WHY THE SECOND ONE EXISTS (2026-08-17). A blank employer means "not yet populated", never
  // "this patient has no employer" — Alec's ruling. In CONSOLIDATED view the old single flag was
  // computed across BOTH tenants at once, so BXR's employers flipped it true and every blank INDIGO
  // cell then rendered "Individual". That is false for all of them: Indigo's facilities do not enter
  // an employer in CMD at all, so their column is structurally empty rather than meaningfully blank.
  // Ruled 2026-08-17: an Indigo row shows a DASH. With these split, Consolidated shows '—' (Indigo
  // drags `all` false) while the filter itself stays available (BXR keeps `has` true).
  return {
    sql:
      'select exists(select 1 from collections.cmd_explorer_rows ' +
      'where business_entity_id = any($1::uuid[]) ' +
      "and employer_name is not null and employer_name <> '') as has_employer_data, " +
      '(select count(distinct business_entity_id) from collections.cmd_explorer_rows ' +
      'where business_entity_id = any($1::uuid[]) ' +
      "and employer_name is not null and employer_name <> '') >= cardinality($1::uuid[]) " +
      'as all_have_employer_data',
    params: [entityIds],
  };
}

export function buildCmdCollectionsEmployerOptionsQuery(
  entityIds: string[],
  term: string,
  limit: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds, likeContains(term), limit];
  const sql =
    'select employer_name ' +
    'from collections.cmd_explorer_rows ' +
    'where business_entity_id = any($1::uuid[]) ' +
    'and employer_name is not null and employer_name <> \'\' ' +
    'and employer_name ilike $2 ' +
    // GROUP BY (not DISTINCT) to mirror the VOB sibling above and keep the shape obvious: one row
    // per employer, deduped server-side so the picker never shows the same name twice.
    'group by employer_name order by employer_name limit $3';
  return { sql, params };
}

/**
 * THE WHOLE COLLECTIONS EMPLOYER VOCABULARY for one tenant scope — every distinct raw spelling, no
 * term, no limit (2026-08-17).
 *
 * ── WHY A WHOLE-VOCABULARY LOAD AND NOT THE PER-KEYSTROKE SEARCH ABOVE ─────────────────────────
 * `buildCmdCollectionsEmployerOptionsQuery` searches per keystroke because the employer vocabulary
 * was believed to be large. **It is not, on this plane.** That belief was measured on the VOB side
 * (~11.6k distinct); the collections book carries **1,073 distinct spellings over 116,871 rows**
 * (measured 2026-08-17, cross-tenant — the widest scope that exists). That is the same order as
 * facility and payer (~260 each), both of which load whole and filter client-side.
 *
 * Measured cost of THIS query, cross-tenant: **118 ms, 13,966 shared hits, index scan on
 * `idx_cmd_explorer_rows_has_employer`** — no seq scan, no sort. Once per view load, against a
 * per-keystroke query on a 686k-row table. It is cheaper in aggregate, not just simpler.
 *
 * ⚠ AND IT IS REQUIRED FOR CORRECTNESS, which is the real reason. Canonical grouping
 * (`employerCanonical.ts`) collapses `TESLA INC` / `TESLA, INC.` / `TESLA,INC.` into one option
 * whose `variants` become the `employer_names` predicate. Those variants must be COMPLETE — a group
 * built from a LIMITed, term-matched page would carry only the spellings that happened to match,
 * and the grid would silently under-select while the option looked authoritative. Typing `TESLA,`
 * matches two of the three spellings; the group must still contain all three. Grouping the whole
 * vocabulary makes completeness structural instead of something the search term has to get right.
 *
 * The per-keystroke builder above STAYS — Payer Intel's employer search uses it
 * (app/lib/payer-intel/loaders.ts), where a term-scoped page is the right shape. Do not merge them.
 *
 * PHI: `employer_name` is the plan SPONSOR (employER, never employEE) and was ruled non-PHI for
 * Collections display/search on 2026-08-14. Tenant-scoped by bound `$1`; no other column projected.
 */
export function buildCmdCollectionsEmployerVocabularyQuery(
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const sql =
    'select distinct employer_name ' +
    'from collections.cmd_explorer_rows ' +
    // ⚠ INTENTIONAL MULTI-TENANT READ. `any($1::uuid[])` is plural BY DESIGN: the caller passes the
    // scope `viewEntityScope` derived for the signed-in principal, which is BOTH entities for the
    // Consolidated view (a super_admin-only view) and exactly one for every entity-scoped role. The
    // array is bound, never interpolated, and this function cannot widen it — an empty or malformed
    // scope is refused upstream by assertEntityScope rather than defaulting to "all tenants".
    // Stated inline because a plural predicate is otherwise indistinguishable from accidental scope
    // widening (compliance rule 2456355; same justification shape as the sibling builders above).
    'where business_entity_id = any($1::uuid[]) ' +
    // The `<> ''` half is not redundant with `is not null`: mapRow coerces a blank CMD cell to null,
    // but the 622k CSV-backfilled rows predate that path, so '' is a reachable state. It also has to
    // match the `employerMode` partition exactly, or the segment counts and this vocabulary disagree.
    "and employer_name is not null and employer_name <> ''";
  return { sql, params: [entityIds] };
}

// --- saved grid views (per-user column layout) ------------------------------

/**
 * The explorer grid's DISPLAY columns — the CLOSED allowlist of column KEYS a saved view may
 * reference. The ORDER of a saved view's array is the display order; MEMBERSHIP is visibility (a
 * column absent from the array is hidden). This includes the 3 PHI *display* keys (patient_name /
 * member_id_raw / group_number): the KEY is non-PHI (the VALUE renders masked until an audited
 * reveal), so a layout may legitimately include or omit them. Kept here (not just in the client's
 * COLUMNS) so the server can validate a client-supplied saved-view column list against a fixed set —
 * no unknown/garbage key is ever persisted. Order mirrors the client's DEFAULT_ORDER.
 */
export const CMD_EXPLORER_COLUMN_KEYS = [
  'charge_date',
  'payment_received',
  'cpt_code',
  'revenue_code',
  'primary_payer',
  // Collections-native plan sponsor (migration 0101). A DISPLAY key like any other — non-PHI, so
  // unlike the three identifier keys below it renders in the clear with no reveal gate.
  'employer_name',
  'patient_name',
  'member_id_raw',
  'group_number',
  'facility',
  'charge_amount',
  'allowed_amount',
  'pct_allowed',
  'insurance_payments',
  'pct_paid',
  'adjustments',
  'patient_balance_due',
] as const;
export type CmdExplorerColumnKey = (typeof CMD_EXPLORER_COLUMN_KEYS)[number];
const CMD_EXPLORER_COLUMN_KEY_SET = new Set<string>(CMD_EXPLORER_COLUMN_KEYS);

/**
 * Sanitize a client-supplied saved-view column list before it is persisted: keep only allowlisted
 * keys, in the supplied order, de-duplicated; silently drop anything unknown/non-string; the result
 * can never exceed the allowlist size. Returns [] when nothing valid remains — the caller treats an
 * empty result as an invalid save (a view must show at least one column). This is the injection/DoS
 * boundary for the untrusted `columns` array (which is otherwise stored verbatim as jsonb).
 */
export function sanitizeGridColumns(input: unknown): CmdExplorerColumnKey[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: CmdExplorerColumnKey[] = [];
  for (const v of input) {
    if (typeof v !== 'string' || !CMD_EXPLORER_COLUMN_KEY_SET.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v as CmdExplorerColumnKey);
  }
  return out;
}

// --- sort + cursor ----------------------------------------------------------

/**
 * Columns the explorer grid may sort by — a CLOSED allowlist of fixed SQL literals (the two dates,
 * the seven rollup-MATERIALIZED money/ratio columns, and the four rollup TEXT columns). Anything
 * else falls back to the default sort. These are all values the 0050 charge-grain rollup carries
 * per charge, so keyset paging drives off the rollup (see buildCmdExplorerQuery).
 *
 * ── THE FOUR TEXT COLUMNS (2026-08-17) ─────────────────────────────────────────────────────────
 * `cpt_code`, `revenue_code`, `primary_payer` and `facility` became sortable on the request to make
 * the grid orderable "just like Excel". They are on the rollup, so they need no schema change.
 *
 * ⚠ ONLY `primary_payer` HAS A SUPPORTING BTREE (`cmd_charge_rollup_entity_payer_payment`). The
 * other three sort by parallel seq scan + top-N heapsort — and that was MEASURED before shipping,
 * because this surface has a 3.5s-grid incident in its history. Cross-tenant, 686k-row book:
 *
 *     order by facility        155.9 ms   (proposed, no index)
 *     order by charge_amount   169.5 ms   (ALREADY SHIPPED, no index either)
 *
 * Identical plan shape, and the new one is marginally FASTER than a sort that has been in
 * production for months. So this widens the allowlist strictly within the cost class the grid
 * already accepts; it does not introduce a new one. Re-measure before adding a column that is NOT
 * on the rollup — that is a different question entirely (see the employer_name note below).
 *
 * ⚠ `employer_name` IS DELIBERATELY ABSENT and must stay that way. It is LEFT JOINed from the base
 * table OUTSIDE the keyset subquery, so an ORDER BY on it would reorder only the 50 rows already
 * fetched — a globally wrong order that looks perfectly correct on screen. Putting it on the rollup
 * to fix that is separately forbidden (it is not in the rollup's GROUP BY, so it would split a
 * charge into several rows and reintroduce the snapshot-grain double-count 0050/0059 exist to fix).
 * A test pins its absence.
 *
 * ⚠ THE THREE PHI COLUMNS ARE ABSENT FOR A SECOND, INDEPENDENT REASON. The rollup carries only
 * blind INDEXES for patient/member/group (`*_bidx`), never plaintext, so there is nothing to sort
 * into a human order — HMAC order is not alphabetical order. Sorting by one would both look broken
 * and leak an ordering over PHI to a caller who never passed a reveal gate.
 *
 * allowed_amount / pct_allowed / pct_paid are SORTABLE AGAIN (0059 repoint ③): the rollup now
 * materializes allowed_reliable + both pcts, so there is a real column to keyset on — BUILD X's
 * per-page selection (which forced dropping these three) is deleted. The grid's displayed
 * "allowed_amount" is the matview's allowed_reliable (aliased), so the allowed_amount sort targets
 * the PHYSICAL allowed_reliable column via CMD_EXPLORER_SORT_SQL below — never the raw netted
 * allowed_amount column, which the grid no longer displays.
 */
/**
 * ⚠ `facility` SORTS ON THE RAW CMD VALUE, NOT ON WHAT THE CELL DISPLAYS. Ruled 2026-08-30; this is
 * a known, accepted divergence, not an oversight. Read this before "fixing" it.
 *
 * WHAT IT SORTS ON: the physical `facility` column of the 0059 rollup — the value CMD sent.
 *
 * WHAT THE CELL SHOWS: `coalesce(<0086 facility_alias>, facility)`. For a charge CMD named, those
 * are the SAME STRING, so the ordering is exactly what the reader sees for all but one population.
 * They differ only inside the 'No Facility' bucket — 11,446 charges of which 5,382 are attributed
 * (measured 2026-08-30) — where the rows sort under the placeholder while displaying a facility.
 *
 * WHY NOT SORT ON THE DISPLAYED VALUE: it would have to enter the PRE-LIMIT sort key, and that sort
 * already spills on the consolidated scope (measured 2026-08-30, 90d: `external merge` Disk 4,544 kB
 * leader / 4,528 kB worker, 46,636 shared buffers, temp written 1,136). Widening a spilling sort
 * with a joined text column is a real regression traded for a cosmetic gain in one bucket. The fix
 * is gated on the per-entity UNION ALL rewrite already named in cmdExplorerBaseConds — the change
 * that makes the consolidated shape index-servable — after which the widening is affordable.
 *
 * This is a DELIBERATE exception to the rule CMD_EXPLORER_SORT_SQL's docblock states for
 * allowed_amount ("the grid DISPLAYS allowed_reliable … so its ORDER BY must bind allowed_reliable").
 * The exception is bounded in a way that one is not: allowed_amount differed on 5,412 charges with
 * no visible marker, whereas every row where facility diverges is RENDERED with a resolution pill
 * and a method badge, so the reader can see which rows are the exception.
 */
export const CMD_EXPLORER_SORTABLE_COLUMNS = [
  'payment_received',
  'charge_date',
  'cpt_code',
  'revenue_code',
  'primary_payer',
  'facility',
  'charge_amount',
  'allowed_amount',
  'pct_allowed',
  'pct_paid',
  'insurance_payments',
  'adjustments',
  'patient_balance_due',
] as const;
export type CmdExplorerSortColumn = (typeof CMD_EXPLORER_SORTABLE_COLUMNS)[number];
const CMD_EXPLORER_SORTABLE = new Set<string>(CMD_EXPLORER_SORTABLE_COLUMNS);

/**
 * Physical rollup column behind each sortable key — ALL fixed literals. `allowed_amount` is the ONE
 * remap: the grid DISPLAYS `allowed_reliable AS allowed_amount` (0059), so its ORDER BY and keyset
 * conditions must bind allowed_reliable — `order by t.allowed_amount` would silently sort by the
 * raw NETTED column, a number the grid does not display (rows would appear misordered vs the cell
 * values, and the keyset cursor — built from the DISPLAYED value — would walk the wrong ordering).
 */
const CMD_EXPLORER_SORT_SQL: Record<CmdExplorerSortColumn, string> = {
  payment_received: 'payment_received',
  charge_date: 'charge_date',
  cpt_code: 'cpt_code',
  revenue_code: 'revenue_code',
  primary_payer: 'primary_payer',
  // Binds the RAW rollup column on purpose — the cell may display a 0086-resolved value instead.
  // See the accepted-divergence note on CMD_EXPLORER_SORTABLE_COLUMNS.
  facility: 'facility',
  charge_amount: 'charge_amount',
  allowed_amount: 'allowed_reliable',
  pct_allowed: 'pct_allowed',
  pct_paid: 'pct_paid',
  insurance_payments: 'insurance_payments',
  adjustments: 'adjustments',
  patient_balance_due: 'patient_balance_due',
};

export interface CmdExplorerSort {
  column: CmdExplorerSortColumn;
  direction: 'asc' | 'desc';
}

/** Default grid order: most-recent Payment Received first. */
export const CMD_EXPLORER_DEFAULT_SORT: CmdExplorerSort = {
  column: 'payment_received',
  direction: 'desc',
};

/**
 * Forward keyset cursor for the grid: the sort-column value + id of the LAST row of the page
 * just shown (both non-PHI). `value` is a JSON-safe scalar (dates are 'YYYY-MM-DD' text, money a
 * decimal string); null means that row sat in the trailing NULLS-LAST block.
 */
export interface CmdExplorerCursor {
  id: number;
  value: string | number | null;
  /**
   * GROUPED MODE ONLY — the ordering this cursor was minted under, as `column|direction`.
   *
   * A keyset cursor is only meaningful for the ordering that produced it, and grouped mode now has
   * more than one. Stamping the ordering onto the cursor lets the reader DETECT a mismatch instead
   * of comparing the wrong quantity. Optional so row-mode cursors (which have a single ordering per
   * request already) are unaffected, and so cursors minted before this field existed still parse.
   */
  sort?: string;
}

/** Clamp a sort to the allowlist; fall back to the Payment-Received-DESC default otherwise. */
export function resolveCmdExplorerSort(sort: CmdExplorerSort | undefined): CmdExplorerSort {
  if (
    sort !== undefined &&
    CMD_EXPLORER_SORTABLE.has(sort.column) &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    return { column: sort.column, direction: sort.direction };
  }
  return { ...CMD_EXPLORER_DEFAULT_SORT };
}

// --- GROUPED-MODE SORT: the payment date, or ONE aggregate under a window cap ------------------
//
// The policy lives in ./groupedSort.js — its own leaf module so a CLIENT component can import the
// predicate without pulling every SQL string in this file into the browser bundle. Re-exported
// here so server-side callers keep importing it from the query module alongside the builder that
// consumes it.
export {
  GROUPED_SORTABLE,
  GROUPED_AGG_SORT_MAX_WINDOW_DAYS,
  groupedSortAllowed,
  resolveGroupedSort,
} from './groupedSort.js';
export type { GroupedSortColumn } from './groupedSort.js';

/** Accept a cursor only if shaped safely; otherwise treat it as the first page. */
export function resolveCmdExplorerCursor(
  cursor: CmdExplorerCursor | null | undefined,
): CmdExplorerCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!Number.isSafeInteger(cursor.id) || cursor.id < 1) return null;
  const v = cursor.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number') return null;
  return { id: cursor.id, value: v ?? null, ...(typeof cursor.sort === 'string' ? { sort: cursor.sort } : {}) };
}

/** The ordering stamp carried on a grouped cursor — see CmdExplorerCursor.sort. */
export function groupedSortStamp(column: GroupedSortColumn, direction: 'asc' | 'desc'): string {
  return `${column}|${direction}`;
}

/**
 * Accept a grouped cursor only if it belongs to the ordering being requested; otherwise return
 * null, which the loader treats as "first page".
 *
 * ── THE BUG THIS CLOSES (Qodo, PR #317) ────────────────────────────────────────────────────────
 * A keyset cursor is only meaningful for the ordering that produced it. `toggleSort` updates the
 * sort synchronously, so the derived ordering changes in that same render, while the effect that
 * clears the cursor list is passive and runs after paint. For one painted frame the pager therefore
 * offers a cursor minted under the PREVIOUS ordering alongside the NEW one.
 *
 * Measured consequence, both ways: the two value types are mutually unparseable, so Postgres
 * RAISES rather than returning wrong rows — `invalid input syntax for type numeric: "2026-09-02"`
 * feeding a date cursor to the total ordering, and `invalid input syntax for type date: "83930.00"`
 * the other way. The user saw "That page could not be loaded." So this was never silent data
 * corruption — but it was a real error on a fast click, and one variant IS silent: flipping only
 * the DIRECTION keeps the value type valid while reversing the comparison, which skips or repeats
 * groups at the boundary. Hence the stamp carries the direction too, not just the column.
 *
 * ⚠ THE VALUE-SHAPE CHECK IS NOT REDUNDANT WITH THE STAMP, and dropping it would leave the bug
 * open across a deploy. Cursors already sitting in a browser when this ships carry NO stamp, so a
 * stamp-only check would wave them through for as long as those tabs stay open. The shape check
 * catches them because it tests the value itself: a date string can never be a total, and a total
 * can never be a date.
 *
 * Returning null rather than raising is the same failure direction as resolveGroupedSort's clamp —
 * the reader lands on page 1, never on an error.
 */
export function resolveGroupedCursor(
  cursor: CmdExplorerCursor | null,
  column: GroupedSortColumn,
  direction: 'asc' | 'desc',
): CmdExplorerCursor | null {
  if (cursor === null) return null;
  // A stamped cursor must match the ordering exactly.
  if (cursor.sort !== undefined && cursor.sort !== groupedSortStamp(column, direction)) return null;
  const v = cursor.value;
  if (v === null) return cursor; // the trailing NULLS LAST block is valid under either ordering
  if (column === 'charge_amount') {
    // A total: parseable as a finite number. '2026-09-02' is not.
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return String(v).trim() !== '' && Number.isFinite(n) ? cursor : null;
  }
  // A payment date: ISO 'YYYY-MM-DD'. '83930.00' is not.
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? cursor : null;
}

// --- page query -------------------------------------------------------------

export const CMD_EXPLORER_PAGE_SIZE = 50;

/** One keyset page of the explorer grid + the cursor to fetch the next page (null at end). */
export interface CmdExplorerPage {
  rows: CmdExplorerRow[];
  nextCursor: CmdExplorerCursor | null;
}

// Explicit non-PHI column list — the bytea PHI columns are NEVER selected here. Dates and
// ingested_at are cast to text so the row shape is stable strings (not pg Date objects);
// numeric money stays a fixed-2-decimal string. pct_allowed / pct_paid are the GENERATED STORED
// payer-gap ratios (migration 0038) — non-PHI numerics that arrive as decimal strings (or null),
// formatted as percentages client-side. id (bigserial) is the keyset + reveal key.
export const CMD_EXPLORER_SELECT =
  "select id, to_char(charge_date, 'YYYY-MM-DD') as charge_date, " +
  "to_char(payment_received, 'YYYY-MM-DD') as payment_received, cpt_code, revenue_code, " +
  'facility, charge_amount, allowed_amount, insurance_payments, adjustments, ' +
  'patient_balance_due, primary_payer, pct_allowed, pct_paid, employer_name, ' +
  // FACILITY RESOLUTION IS NOT APPLIED ON THIS PROJECTION — literal NULLs, stated rather than
  // omitted. This select feeds the COHORT DRILLDOWN's patient table (buildCohortDrilldownQueries),
  // which reads the BASE table and has no resolution join; the 0086 fallback shipped 2026-08-30
  // scoped to the Collections Facility column only.
  //
  // The consequence is real and is a KNOWN, NAMED inconsistency rather than an oversight: a charge
  // the grid shows as 'TREAT_WA · Manual' still reads 'No Facility' in the drilldown table. It is
  // projected as NULL rather than left off the row shape entirely because CmdExplorerRow declares
  // both fields REQUIRED and nullable — an ABSENT field would arrive as `undefined`, and
  // `undefined !== null` is true, so every `facility_resolved !== null` guard downstream would take
  // the resolved branch on a row that has no resolution. Null is the honest, safe value.
  'null::text as facility_resolved, null::text as facility_method, ' +
  // Likewise false, not omitted: CmdExplorerRow declares is_scheduled REQUIRED, and an absent
  // field arrives as `undefined` — which is truthy-adjacent in exactly the way that bites
  // (`undefined !== null`). The cohort drilldown does not resolve a business day, so nothing
  // here is scheduled; false is the honest value.
  'false as is_scheduled, ' +
  `to_char(ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at ` +
  // Aliased `t` SO THE ORDER BY CAN TARGET THE RAW COLUMN: the two date columns are projected as
  // `to_char(<date>, 'YYYY-MM-DD') AS <date>` (output name == column name), and an UNQUALIFIED
  // `order by payment_received` resolves to that TEXT output alias (Postgres: output name wins in
  // ORDER BY), which no index can serve — forcing a full seq scan + top-N sort of the tenant slice.
  // `order by t.<col>` (see buildCmdExplorerQuery) binds to the underlying date/numeric column so
  // idx_cmd_explorer_payment_received (and the money/ratio orderings) drive the sort + LIMIT.
  'from collections.cmd_explorer_rows t';

/**
 * Build the CHARGE-GRAIN keyset page for the "All Collections" grid.
 *
 * ONE indexed select over the 0059 matview — BUILD X's per-page base-table override
 * (page→snaps→sel→picked) is DELETED (0059 repoint ③). History, compressed: cmd_explorer_rows is
 * POSTING-snapshot grain (BXR ~2.14 rows/charge), so X collapsed the grid to charge grain by
 * paginating the 0050 rollup and OVERRIDING allowed/pct per page from the base snapshots — the
 * rollup's summed allowed over-stated restated charges (133.88% on the reference fixture) and
 * nothing was materialized to sort on. Migration 0059 materialized that tiered rule INTO the
 * matview (allowed_reliable / allowed_tier / pct_allowed / pct_paid, scratch-verified 100%
 * tier-parity with X's selector), so the grid now reads the materialized columns directly:
 *
 *  - DISPLAYED allowed_amount = the matview's `allowed_reliable` (aliased) — the tiered per-charge
 *    value (single real value / reconciling snapshot / e1 reconciling netted sum / e2
 *    latest-positive / NULL unknown). pct_allowed / pct_paid come straight off the matview (same
 *    0038 formula, NULL-safe: NULL allowed → NULL pct, never 0%).
 *  - E1 DISPLAY DELTA (by design, ruled): X's inline tier-e always showed latest-positive; 0059's
 *    e1 shows the reconciling NETTED sum instead — the 5,412 e1 charges render a different (proven)
 *    dollar than the X-era grid did. e2 stays latest-positive with pct_paid UNCLAMPED >100%
 *    (X's reversal tell, deliberately preserved — do not clamp).
 *  - The three sorts are RESTORED (CMD_EXPLORER_SORTABLE_COLUMNS). Sort/keyset bind the PHYSICAL
 *    column via CMD_EXPLORER_SORT_SQL — allowed_amount remaps to allowed_reliable (see that map's
 *    comment); everything the grid sorts by is now a real matview column.
 *
 * Column/table names are fixed literals; every VALUE (entity ids, facility, dates, cursor value/id,
 * limit) is a bound $n — no interpolation, no SELECT *. The cursor boundary continues STRICTLY
 * after the previous page's last row in the `<sortcol> <dir> NULLS LAST, id <dir>` order (cursor
 * values are built from the DISPLAYED row fields, which match the physical sort columns —
 * row.allowed_amount IS allowed_reliable). `entityIds` is the server-derived RBAC tenant scope,
 * applied as a mandatory WHERE so a page never crosses tenants.
 */
export function buildCmdExplorerQuery(
  cursor: CmdExplorerCursor | null,
  filter: CmdExplorerFilter,
  sort: CmdExplorerSort,
  limit: number,
  entityIds: string[],
  opts?: CmdExplorerBuilderOptions,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Physical sort column (fixed literal from the map — allowed_amount → allowed_reliable).
  const col = CMD_EXPLORER_SORT_SQL[sort.column];
  // OUTPUT name for the OUTER order-by (see the employer join below), re-validated against the
  // closed allowlist HERE rather than trusted from the argument.
  //
  // The distinction matters: `col` above is a MAP LOOKUP, so a garbage column yields `undefined`
  // and produces broken-but-inert SQL — safe BY CONSTRUCTION even if a caller skips validation.
  // The outer clause needs the OUTPUT name, which is `sort.column` itself, and interpolating that
  // directly would be safe only BY CONVENTION (resolveCmdExplorerSort is called at the action
  // boundary, app/lib/actions.ts). This function is exported, so a future caller could reach it
  // without that boundary. One Set membership test restores safe-by-construction: an unrecognised
  // column falls back to the default instead of reaching the SQL text.
  const outCol = CMD_EXPLORER_SORTABLE.has(sort.column) ? sort.column : CMD_EXPLORER_DEFAULT_SORT.column;
  const cmp = sort.direction === 'asc' ? '>' : '<';
  const dir = sort.direction === 'asc' ? 'asc' : 'desc';

  /*
   * ONE ordered, LIMITed scan of the rollup for ONE entity scope — the paged subquery this builder
   * has always emitted, extracted into a function so the consolidated view can emit it once per
   * entity (see `paged` below). Everything inside is per-scope on purpose: cmdExplorerBaseConds is
   * re-run so the tenant cond takes its EQUALITY form (scope.length === 1 — see its docblock: a
   * ScalarArrayOp on the leading btree column is what stops the ordered index walk), and the keyset
   * cursor predicate is re-emitted so each branch resumes from the same page boundary. Params
   * repeat per branch; a $n placeholder is cheap and values-only params are the rule here.
   */
  const scanFor = (scope: string[]): string => {
    // Tenant scope + the exact/window/substring filters (shared with the search summary). Every
    // column referenced here exists on the rollup, so the same conds apply unchanged.
    const conds = cmdExplorerBaseConds(filter, scope, add, {
      resolveFacility: true,
      requireWindow: opts?.requireWindow === true,
    });
    if (cursor !== null) {
      if (cursor.value === null) {
        // Cursor row sat in the trailing NULL block: only later NULL rows remain.
        conds.push(`(${col} is null and id ${cmp} ${add(cursor.id)})`);
      } else {
        // Rows past the cursor on the sort key, ties broken by id, plus the whole NULL block
        // (which sorts after any non-null value under NULLS LAST).
        const valueParam = add(cursor.value);
        const idParam = add(cursor.id);
        conds.push(
          `(${col} ${cmp} ${valueParam} or (${col} = ${valueParam} and id ${cmp} ${idParam}) or ${col} is null)`,
        );
      }
    }
    const where = conds.length > 0 ? ` where ${conds.join(' and ')}` : '';
    return (
      `select t.id, to_char(t.charge_date, 'YYYY-MM-DD') as charge_date, ` +
      `to_char(t.payment_received, 'YYYY-MM-DD') as payment_received, t.cpt_code, t.revenue_code, ` +
      `t.facility, t.charge_amount, t.allowed_reliable as allowed_amount, t.insurance_payments, ` +
      `t.adjustments, t.patient_balance_due, t.primary_payer, t.pct_allowed, t.pct_paid, ` +
      `to_char(t.ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at ` +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} t${where} ` +
      `order by t.${col} ${dir} nulls last, t.id ${dir} limit ${add(limit)}`
    );
  };

  /*
   * ── THE CONSOLIDATED SCOPE PAGES PER ENTITY AND MERGES (2026-09-04) ─────────────────────────
   *
   * This is the "per-entity UNION ALL rewrite" cmdExplorerBaseConds' tenant-cond docblock deferred
   * when it fixed the single-entity shape. With 2+ ids the tenant cond is `= any($n)`, a
   * ScalarArrayOp on the leading btree column — so the ordered walk is unavailable BY SHAPE and the
   * old single scan read the ENTIRE window and top-N sorted it for 51 rows out. Measured live
   * (consolidated, 90d, page 1): 46,712 rows / 31,477 buffers / 187 ms WARM — and
   * pg_stat_statements put the production MEAN at 3,475 ms (max 11,379) because the buffer cache is
   * usually cold by the time the 15-min unstable_cache entry has expired or the hourly cron has
   * busted the tag. That number was the Collections tab's time-to-first-byte on every cache miss.
   *
   * Per-entity branches restore the ordered walk (each branch is a single-id scope, so baseConds
   * emits EQUALITY and the branch descends cmd_charge_rollup_entity_payment_id_desc, reading at
   * most `limit` rows), and the merge layer takes the global top-`limit` across branches. Measured
   * live, same page: 1.9 ms / 347 buffers — and the cold story is the real fix: ~2.7 MB of pages
   * touched instead of ~246 MB.
   *
   * ⚠ THE MERGE ORDERS BY THE OUTPUT COLUMN (`outCol`), exactly like the outer re-sort below, and
   * for the same reason it is sound there: the two date keys are ISO-8601 text, which sorts
   * identically to the dates, and every other sortable key is projected raw. The merge input is at
   * most `limit` rows PER BRANCH (a hundred-ish), so this sort costs microseconds — the point of
   * the rewrite is bounding what the branches READ, not avoiding this sort.
   *
   * A 0/1-entity scope emits the single scan with the SAME SHAPE as before this change — the one
   * diff is parameter ORDER: `limit` now binds inside the scan, so it takes the slot ahead of
   * `businessToday` instead of after it. Positional params make that invisible to the database
   * (each placeholder still names its own value; the plan is unchanged) — it is called out because
   * a test pinning the old $-numbering would otherwise read as a semantic change. The BXR/Indigo
   * tabs and Payer Intel's callers keep the plan they already have.
   */
  const paged =
    entityIds.length > 1
      ? `select * from (${entityIds.map((id) => `(${scanFor([id])})`).join(' union all ')}) u ` +
        `order by u.${outCol} ${dir} nulls last, u.id ${dir} limit ${add(limit)}`
      : scanFor(entityIds);

  // The CmdExplorerRow shape (same output names/casts the grid has always returned). Dates and
  // ingested_at to_char'd to stable strings. `t.<col>` / `t.id` bind the RAW columns so the sort is
  // column-driven, never the to_char text alias (see CMD_EXPLORER_SELECT's alias note).
  // EMPLOYER JOIN — deliberately OUTSIDE the paged subquery.
  //
  // employer_name lives ONLY on the base table: the rollup has no such column and must never gain
  // one (migration 0101's grain note — employer is not in the rollup's GROUP BY, so adding it there
  // would split a charge into two rows whenever employer varies across its postings, reintroducing
  // the snapshot-grain double-count 0050/0059 exist to fix; and adding it at all would force a
  // DROP + CREATE MATERIALIZED VIEW, destroying 313 MB of indexes including 0092's covering pair).
  //
  // The join is sound because the rollup's `id` IS the latest snapshot's real cmd_explorer_rows.id
  // (see CMD_EXPLORER_CHARGE_ROLLUP's docblock), so it resolves 1:1 — never fanning out.
  //
  // THE NESTING IS LOad-BEARING, not style. `p` applies the tenant scope, the filters, the ORDER BY
  // and the LIMIT against the rollup ALONE, so the join runs against exactly `limit` rows (50) as a
  // primary-key lookup each. Joining before the limit would invite the planner to hash-join the
  // whole 349 MB base table against the filtered 165 MB rollup slice on every keystroke.
  //
  // LEFT, never INNER: an inner join would silently DROP any grid row whose base row is missing,
  // turning a lookup miss into vanished collections data. A missing employer must render as an
  // em dash, never as one fewer row.
  //
  // `p.*` is safe here (not a `select *` over a table): `p` is this function's own fixed projection
  // immediately above, so the column list stays explicit and allowlisted.
  // FACILITY-RESOLUTION JOIN — same side of the LIMIT as `e`, and for the same reason.
  //
  // `fr` supplies the 0086 attribution for charges whose raw CMD cell is the 'No Facility'
  // placeholder. It is PROJECTION ONLY: the filter half of this feature is a semi-join emitted by
  // cmdExplorerBaseConds INSIDE `p`, because a filter must narrow before the LIMIT or the page
  // walks the wrong set — while a projection must not, or it widens a sort that already spills.
  //
  // 50 lookups on the UNIQUE cmd_facility_resolution_id, exactly like the `e` join above; the
  // relation is 11,446 rows / 3,568 kB total (measured 2026-08-30), so even a mis-plan is bounded.
  //
  // LEFT, never INNER — same rule as `e`: a lookup miss must render the raw CMD facility, never one
  // fewer row. Every non-placeholder charge misses by construction (0086 only covers placeholders),
  // so an INNER join here would delete the entire book except the 11,446.
  //
  // ⚠ `p.facility` IS NOT OVERWRITTEN. The raw CMD value keeps its own column and its own meaning;
  // the resolved value arrives ALONGSIDE it as facility_resolved. The UI composes them (resolved as
  // primary text, raw reachable on hover) — this layer hands over both and decides nothing. Doing
  // the coalesce in SQL would destroy the raw value for every consumer of this row shape, including
  // the audited PHI reveal path and any future export.
/**
 * The `is_scheduled` projection — a future-dated payment, flagged per row.
 *
 * ⚠ COMPUTED SERVER-SIDE AND PROJECTED, NEVER DERIVED IN THE CLIENT (ruled 2026-08-30). The server
 * already knows business-today at the moment it resolves the window; having the `'use client'` grid
 * call businessDayIso() itself would reintroduce a timezone dependency there — the browser's zone
 * is not the ops zone, and a Denver reader would flag a different set of rows than a Los Angeles
 * one looking at the same page.
 *
 * ⚠ THIS REMOVES THE TIMEZONE DEPENDENCY. IT DOES **NOT** REMOVE STALENESS, and an earlier version
 * of this docblock claimed it did — corrected 2026-08-31 after the Qodo review of PR #298 named the
 * gap. `is_scheduled` is request-time data: a tab left open across midnight Pacific keeps rendering
 * the boolean it was served, so a payment that has since settled still reads "scheduled" until some
 * filter, sort, or navigation triggers a refetch. Deriving it client-side would NOT have fixed that
 * either — React does not re-render on a clock tick — so this is a property of a flag-per-row
 * design, not a cost of choosing the server.
 *
 * What the server placement DOES bound: `businessToday` is part of the unstable_cache key, so no
 * NEW request is ever answered against a stale ops day. Only an idle open tab is exposed. Closing
 * that needs a rollover-triggered refetch driven by a server-supplied absolute instant; it is
 * tracked as a follow-up rather than smuggled into this change.
 *
 * ⚠ EMITTED IN THE **OUTER** QUERY, AGAINST THE ALREADY-PROJECTED TEXT DATE. This is the whole
 * reason it costs nothing: `p.payment_received` / `g.payment_received` are already
 * `to_char(...,'YYYY-MM-DD')` in the paged subquery, so the comparison happens on 50 materialized
 * rows AFTER the LIMIT. Putting it inside `p`/`g` would add a column to a pre-LIMIT sort that
 * already spills on the consolidated scope — measured, and the reason this shape was chosen.
 *
 * Text comparison is exact here: ISO-8601 is lexicographically ordered, the same property the
 * outer ORDER BY already relies on for these two columns.
 *
 * NULL-safe via coalesce: payment_received is nullable, and `null > date` is NULL, not false. An
 * undated charge is not "scheduled" — it is unplaceable, which is a different thing and is not this
 * badge's job to say.
 *
 * `businessToday` absent => the literal `false`, so a caller that has not adopted the window
 * control still type-checks and simply never flags a row.
 */
  const businessToday = filter.businessToday ?? undefined;
  const scheduled = businessToday === undefined
    ? 'false as is_scheduled'
    : `coalesce(p.payment_received > ${add(businessToday)}, false) as is_scheduled`;
  const sql =
    `select p.*, e.employer_name, fr.facility_alias as facility_resolved, ` +
    `fr.method as facility_method, ${scheduled} from (` +
    paged +
    `) p left join collections.cmd_explorer_rows e on e.id = p.id ` +
    `left join ${CMD_FACILITY_RESOLUTION} fr on fr.id = p.id ` +
    // Re-stated on the OUTER query: a LEFT JOIN does not preserve the subquery's ordering, and the
    // keyset cursor is built from the LAST ROW of this result set — an unordered page would hand
    // back a cursor for an arbitrary row and silently skip or repeat pages. This re-sort is over
    // 50 already-materialized rows, so it costs nothing.
    //
    // ⚠ `sort.column` HERE, NOT `col`. `col` is the PHYSICAL rollup column and the two differ for
    // exactly one key: allowed_amount → allowed_reliable. The subquery projects that as
    // `t.allowed_reliable AS allowed_amount`, so `p` exposes the OUTPUT name only — `p.allowed_reliable`
    // does not exist and would 42703. sort.column is a member of the closed CMD_EXPLORER_SORTABLE_COLUMNS
    // allowlist (never user text), so it is safe as a literal, exactly as `col` is.
    //
    // The two date keys are `to_char(...,'YYYY-MM-DD')` TEXT on `p` rather than dates. Sorting them
    // as text is order-identical to sorting the underlying dates because ISO-8601 is lexicographically
    // ordered — and the inner query already established the true order against the real date columns;
    // this only has to preserve it.
    `order by p.${outCol} ${dir} nulls last, p.id ${dir}`;
  return { sql, params };
}

/** A row's sort-column value as a JSON-safe cursor scalar (all sortable columns are text/null). */
export function cmdExplorerSortValue(row: CmdExplorerRow, column: CmdExplorerSortColumn): string | null {
  return row[column] ?? null;
}

// --- smart search summary ---------------------------------------------------
// The "search engine" result: instead of paging through noisy rows, the search first returns an
// AGGREGATE summary of everything matching (count + money totals) plus the top facilities /
// payers / CPT codes, each of which the UI turns into a clickable drill-down chip. All non-PHI;
// same tenant scope + filters as the grid, so the summary and the rows it drills into agree.

/** How many entries each top-N grouping returns. */
export const CMD_SEARCH_TOP_N = 8;

/**
 * The CHARGE-GRAIN source (migration 0050): one row per logical charge with
 * grain-correct netting — charge_amount counted once; insurance_payments = the charge-cumulative
 * running total's max (NEVER summed); allowed_amount = the posting-netted sum (± reversal rows
 * cancel); point-in-time fields = latest snapshot. EVERY aggregate builder in this module reads
 * this view: summing raw cmd_explorer_rows (snapshot grain, BXR ~2.14 rows per charge) was the
 * confirmed root cause of the >100% ratios and ~2× inflated totals (2026-07-13 grain audit).
 * The row-browsing grid reads this matview too (buildCmdExplorerQuery; its displayed
 * allowed_amount is the materialized allowed_reliable). Only the drilldown patient TABLE
 * intentionally stays on cmd_explorer_rows — row grain is what it displays — and the view's
 * `id` is the latest snapshot's real row id, so joins back to the base table (and the audited
 * PHI reveal) still hold.
 */
export const CMD_EXPLORER_CHARGE_ROLLUP = 'collections.cmd_explorer_charge_rollup';

/**
 * Shared dollar-weighted %-allowed / %-paid select — ratio of the group's SUMS, never an average
 * of per-row ratios (see CmdComboGroup). %-allowed guards a zero/negative/null denominator to SQL
 * NULL. %-paid guards HARDER: the netted allowed must be a MEANINGFUL denominator — at least 2% of
 * the group's billed dollars and at least $100 — because reversal-heavy groups net allowed toward
 * zero and turn the ratio into a 500–1900% artifact (the pre-0050 readings the footnote used to
 * rationalize as out-of-network). Below the floor the ratio is NULL ("—"), never a huge number.
 */
// 0059 repoint ④: the allowed aggregate is sum(allowed_reliable) — the materialized tiered value —
// not the netted posting sum (which over-states restatements and nets reversal-heavy groups toward
// zero). The pct_paid FLOOR (>= greatest(2% of billed, $100)) is DELIBERATELY UNCHANGED: its
// original netted-toward-zero rationale weakens under allowed_reliable, but re-ruling it is a
// product decision DEFERRED until real allowed_reliable numbers have been observed (Alec,
// 2026-07-22) — do not loosen/drop it inside a repoint diff.
export const PCT_RATIO_SELECT =
  'case when sum(charge_amount) > 0 then round(sum(allowed_reliable) / sum(charge_amount) * 100, 2)::float8 end as pct_allowed, ' +
  'case when sum(allowed_reliable) >= greatest(sum(charge_amount) * 0.02, 100) then round(sum(insurance_payments) / sum(allowed_reliable) * 100, 2)::float8 end as pct_paid';

/** One grouped bucket (facility / payer / cpt): its label + match count + charged total. */
export interface CmdSearchGroup {
  label: string | null;
  count: number;
  charge: number;
}

/**
 * One (CPT code, Revenue code) COMBINATION bucket. A DISTINCT shape from CmdSearchGroup — it
 * carries TWO label fields (`cpt` + `revenue`) plus two ratios — because a combo entry answers
 * "how does this payer treat this exact CPT×revenue-code pairing", which one label can't express.
 *
 * `pct_allowed` / `pct_paid` are DOLLAR-WEIGHTED ratios of the bucket's SUMS —
 * sum(allowed_reliable)/sum(charge_amount) and sum(insurance_payments)/sum(allowed_reliable), each ×100
 * rounded to 2 dp — NEVER an average of each row's individual ratio (avg-of-ratios over-weights
 * small claims and misstates the actual dollar recovery rate, which is the number admissions must
 * trust). NULL when the denominator is 0 / negative / null (guarded in SQL, never an error). `count`
 * + `charge` mirror CmdSearchGroup.
 */
export interface CmdComboGroup {
  cpt: string | null;
  revenue: string | null;
  count: number;
  charge: number;
  pct_allowed: number | null;
  pct_paid: number | null;
}

export interface CmdSearchSummary {
  /** Matching LOGICAL CHARGES (0050 rollup grain) — the grid below pages snapshot rows, so its
   *  page count can exceed this; the UI labels the two grains differently on purpose. */
  total_count: number;
  total_charge: number;
  /** sum(allowed_reliable) over the filtered set — the SAME reliable tiered value the cohort totals
   *  and the combo ratios use, so the selection-mode green cards reconcile with cohort mode and the
   *  CPT×Rev %s. Added so SELECTION-MODE %-allowed / %-paid derive from this one aggregate (no new
   *  query) — see `yield_pct`. */
  total_allowed: number;
  total_paid: number;
  total_balance: number;
  /** SELECTION-MODE payer-behavior percentages, derived server-side from the totals above via the
   *  shared {@link deriveYield} helper — the SAME formula/rounding/guards the cohort whole-cohort
   *  cards use, so the two modes can never drift. %Collected = total_paid/total_charge reconciles
   *  exactly with the Insurance Paid ÷ Charged tiles. */
  yield_pct: CohortTotals;
  by_facility: CmdSearchGroup[];
  by_payer: CmdSearchGroup[];
  by_cpt: CmdSearchGroup[];
  by_combo: CmdComboGroup[];
}

/** Group-by columns the summary rolls up — fixed literals, never user input. */
const CMD_SEARCH_GROUP_COLUMNS = {
  facility: 'facility',
  primary_payer: 'primary_payer',
  cpt_code: 'cpt_code',
} as const;
export type CmdSearchGroupColumn = keyof typeof CMD_SEARCH_GROUP_COLUMNS;

/**
 * Build the five aggregate queries backing the search summary — a totals query, one top-N grouping
 * per single dimension (facility / payer / cpt), and one top-N (CPT, Revenue-code) COMBINATION
 * grouping — all sharing the SAME tenant-scoped WHERE. Column names are fixed literals; every value
 * is a bound parameter. Exposed so a fixture can assert the exact SQL.
 */
export function buildCmdSearchSummaryQueries(
  filter: CmdExplorerFilter,
  entityIds: string[],
  topN: number = CMD_SEARCH_TOP_N,
  opts?: CmdExplorerBuilderOptions,
): {
  totals: { sql: string; params: unknown[] };
  groups: Record<CmdSearchGroupColumn, { sql: string; params: unknown[] }>;
  combo: { sql: string; params: unknown[] };
} {
  const build = (select: string, tail: (add: ParamAdder) => string) => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    // Opted in ALONGSIDE the grid and the grouped view (see CmdExplorerCondOptions): the summary
    // counts the rows the grid shows, so if one resolves a facility selection and the other does
    // not, the tile says one number and the table lists another.
    const conds = cmdExplorerBaseConds(filter, entityIds, add, {
      resolveFacility: true,
      requireWindow: opts?.requireWindow === true,
    });
    const where = ` where ${conds.join(' and ')}`;
    // CHARGE grain (0050 rollup), so counts are logical charges and sums are netted — the grid
    // below the summary still pages snapshot ROWS, which is why its copy says "posting rows".
    return { sql: `${select} from ${CMD_EXPLORER_CHARGE_ROLLUP}${where}${tail(add)}`, params };
  };

  const totals = build(
    'select count(*)::int as total_count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as total_charge, ' +
      // Reliable tiered allowed (0059) — the SAME column the combo ratios + cohort totals sum, so
      // SELECTION-MODE %-allowed / %-paid derive from the tile aggregate with NO new query.
      'coalesce(sum(allowed_reliable), 0)::float8 as total_allowed, ' +
      'coalesce(sum(insurance_payments), 0)::float8 as total_paid, ' +
      'coalesce(sum(patient_balance_due), 0)::float8 as total_balance',
    () => '',
  );

  const groups = {} as Record<CmdSearchGroupColumn, { sql: string; params: unknown[] }>;
  for (const key of Object.keys(CMD_SEARCH_GROUP_COLUMNS) as CmdSearchGroupColumn[]) {
    const col = CMD_SEARCH_GROUP_COLUMNS[key];
    groups[key] = build(
      `select ${col} as label, count(*)::int as count, coalesce(sum(charge_amount), 0)::float8 as charge`,
      (add) => ` group by ${col} order by charge desc nulls last, count desc limit ${add(topN)}`,
    );
  }

  // The (CPT, Revenue-code) combination grouping. Ratios come from the shared PCT_RATIO_SELECT
  // (dollar-weighted ratio-of-sums with the guarded denominators — see its doc). cpt_code and
  // revenue_code are fixed-literal group columns; ::float8 makes the rounded numerics arrive as JS
  // numbers (like `charge`).
  const combo = build(
    'select cpt_code as cpt, revenue_code as revenue, count(*)::int as count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as charge, ' +
      PCT_RATIO_SELECT,
    (add) => ` group by cpt_code, revenue_code order by charge desc nulls last, count desc limit ${add(topN)}`,
  );

  return { totals, groups, combo };
}

// --- alpha-prefix cohort payer-behavior curve (Session D) -------------------
// The merged "attrition rate" (how many claims before a payer's reimbursement degrades) + "days
// insurer paid" (how long a new patient under the same alpha prefix keeps full authorization)
// metric: allowed% / paid% plotted across a patient's claim sequence, rolled up over ALL patients
// sharing an alpha-prefix blind-index token. The OUTPUT is a cohort AGGREGATE — never a single
// patient's figures — but computing it groups by member_id_bidx internally to sequence each
// patient's visits, THEN rolls the cohort up. Two x-axes come from the SAME sequencing idea: claim/
// visit POSITION (ordinal by distinct service date) and DAYS since the patient's first claim.
//
// SMALL-COHORT SUPPRESSION is load-bearing, not cosmetic (a 2-patient "cohort" is a 2-patient
// disclosure wearing an aggregate's clothes). A `HAVING count(distinct member_id_bidx) >= threshold`
// on the FINAL grouped result drops any bucket below the floor ENTIRELY, IN-QUERY, before the data
// serializes — a client-side or action-layer hide would be inspectable in the network tab. The
// threshold is CLAMPED to COHORT_MIN_PATIENTS here so no caller can weaken it below the agreed floor.

/**
 * Floor on distinct patients per bucket. Buckets below it are SUPPRESSED in-query (absent, not
 * caveated). Signed off with Alec (Session D). Callers may raise it; they can NEVER lower it.
 */
export const COHORT_MIN_PATIENTS = 5;
/**
 * Cap on the claim-position axis. Behavioral-health patients average ~40–70 visits, so the raw
 * sequence has a long tail; the early sequence carries the degradation signal and a bounded axis
 * keeps the payload small.
 */
export const COHORT_POSITION_CAP = 24;
/** Day-axis bucket width + cap: monthly buckets across the first ~year since a patient's 1st claim. */
export const COHORT_DAY_BUCKET_DAYS = 30;
export const COHORT_DAY_CAP = 360;

/**
 * One cohort-curve bucket. `patients` is ALWAYS >= COHORT_MIN_PATIENTS (a smaller bucket was
 * suppressed and never appears). `pct_allowed` / `pct_paid` are DOLLAR-WEIGHTED (ratio of the
 * bucket's summed dollars, guarded), the same discipline as the Session C combo grouping.
 *
 * Phase 2 (dollars + zero-pay): `paid_total` is the bucket's summed insurance $ — it powers the
 * client-side avg-$/patient and cumulative-$/starting-patient reads. `pct_zero_paid` is the share
 * of charge LINES with no positive insurance payment; `pct_patient_shifted` is its subset where the
 * balance moved to the patient (deductible/coinsurance — a collections problem, NOT a denial).
 * `allowed_amount <= 0` is deliberately NOT the zero-pay signal: in this dataset ~85% of
 * allowed<=0/null lines carry real payments (CMD often omits a meaningful allowed amount).
 */
export interface CohortCurvePoint {
  bucket: number;
  patients: number;
  /** Logical CHARGE LINES in the bucket (0050 rollup grain). Field name kept for API/cache
   *  compatibility; UI copy says "charge lines", never "claims". */
  claims: number;
  pct_allowed: number | null;
  pct_paid: number | null;
  paid_total: number;
  pct_zero_paid: number;
  pct_patient_shifted: number;
}

export interface CohortCurveOptions {
  minPatients?: number;
  positionCap?: number;
  dayBucketDays?: number;
  dayCap?: number;
}

/**
 * Whole-cohort END-TO-END payer yield — dollar-weighted over the ENTIRE prefix cohort's charge lines
 * (0050 rollup), with NO position cap and NO per-bucket suppression: the honest lifetime total,
 * deliberately free of the curve's survivorship bias. Each ratio is null when its denominator is <= 0.
 * The whole object is null when the cohort is below COHORT_MIN_PATIENTS (the cards then read "not
 * enough data", never a false-precision stat).
 */
export interface CohortTotals {
  /** paid ÷ billed — net collected of billed (end-to-end yield). */
  pct_collected: number | null;
  /** allowed ÷ billed — what the payer agreed to. */
  pct_allowed: number | null;
  /** paid ÷ allowed — paid of what was allowed. */
  pct_paid: number | null;
}

/** Raw dollar sums a yield is derived from — `null`/`0` denominators guard to a `null` ratio. */
export interface YieldInput {
  billed: number | null;
  allowed: number | null;
  paid: number | null;
}

/**
 * THE single derivation of the three payer-behavior percentages from raw dollar sums — the one
 * place BOTH the whole-cohort yield cards (cohort mode) AND the filter-wide green cards (selection
 * mode) read, so the two modes can never drift. Each ratio guards a null/zero/negative denominator
 * to `null` ("—") and rounds to 2 dp — byte-identical to the inline cohort-totals ratio it replaces
 * (Math.round(x*10000)/100). Pure; no PHI; unit-tested in the hermetic suite.
 */
export function deriveYield({ billed, allowed, paid }: YieldInput): CohortTotals {
  const ratio = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? Math.round((num / den) * 10000) / 100 : null;
  return {
    pct_collected: ratio(paid, billed), // paid ÷ billed
    pct_allowed: ratio(allowed, billed), // allowed ÷ billed
    pct_paid: ratio(paid, allowed), // paid ÷ allowed
  };
}

/**
 * The cohort-curve response: both suppressed x-axes plus the cohort's distinct-patient count
 * (derived from the position-1 bucket, since every patient has a first visit). When the whole
 * cohort is below the floor, EVERY bucket is suppressed → both arrays are empty and
 * `cohort_patients` is 0 (the panel then shows "not enough data", never a partial disclosure).
 * `totals` is the whole-cohort end-to-end yield (see CohortTotals) — null below the floor.
 */
export interface CohortCurve {
  by_position: CohortCurvePoint[];
  by_days: CohortCurvePoint[];
  cohort_patients: number;
  totals: CohortTotals | null;
}

// --- cohort-point drilldown (Session G) -------------------------------------
// Clicking one cohort-curve point opens a breakdown for THAT bucket: an aggregate slice (payer mix,
// CPT/rev mix — always renders once the point clears COHORT_MIN_PATIENTS, the SAME floor the curve
// itself already enforces, since a suppressed point is never clickable) plus an OPTIONAL patient
// table gated by a SEPARATE, stricter floor. Row-level disclosure — even PHI-masked — carries more
// re-identification risk than an aggregate ratio, so it needs its own, higher bar than the curve's.

/**
 * Floor on distinct patients before the drilldown's PATIENT TABLE may render rows. Independent of
 * and stricter than COHORT_MIN_PATIENTS (which gates the aggregate breakdown + the curve itself).
 * Signed off with Alec: N=10 (real-data check: at N=5 the table would show for ~78% of points that
 * render on a typical viewable cohort; at N=10, ~25-27% — still usable at early claim positions,
 * where the disclosure risk of a small table is highest anyway).
 */
export const COHORT_DRILLDOWN_TABLE_MIN_PATIENTS = 10;

/**
 * Does a bucket's (server-recomputed) distinct-patient count clear the curve's OWN aggregate floor?
 * Pulled out as a named, pure predicate — rather than an inline `>=` in server.ts — so the exact
 * boundary is unit-testable in this hermetic module (server.ts has no test harness in this repo).
 */
export function clearsCohortFloor(patients: number): boolean {
  return patients >= COHORT_MIN_PATIENTS;
}

/** Does a bucket's patient count clear the STRICTER, separate patient-table floor (Session G)? */
export function clearsDrilldownTableFloor(patients: number): boolean {
  return patients >= COHORT_DRILLDOWN_TABLE_MIN_PATIENTS;
}

/**
 * The aggregate breakdown for ONE cohort-curve point. Pure SQL aggregate, NO row egress, non-PHI.
 * `patients` is RE-DERIVED server-side for this exact bucket (never trusted from the client's
 * click) — the authoritative gate for whether this breakdown may render at all. `by_payer` /
 * `by_cpt_revenue` reuse the EXISTING CmdSearchGroup / CmdComboGroup shapes (same fields the smart-
 * search summary already returns) rather than inventing parallel types.
 */
export interface CohortDrilldownAggregate {
  bucket: number;
  patients: number;
  claims: number;
  pct_allowed: number | null;
  pct_paid: number | null;
  paid_total: number;
  pct_zero_paid: number;
  pct_patient_shifted: number;
  by_payer: CmdSearchGroup[];
  by_cpt_revenue: CmdComboGroup[];
}

/**
 * The patient table for one point: EITHER the masked non-PHI rows (same CmdExplorerRow shape +
 * reveal path the main grid uses) OR a suppression marker — never a partial/truncated row set.
 */
export type CohortDrilldownTable =
  | { kind: 'suppressed'; floor: number }
  | { kind: 'rows'; rows: CmdExplorerRow[] };

/** The full response for one clicked cohort-curve point. */
export interface CohortDrilldownResult {
  aggregate: CohortDrilldownAggregate;
  table: CohortDrilldownTable;
}

// Phase 2 dollars + zero-pay, appended to the SAME suppressed select (the HAVING covers every field
// here — nothing derivable below the min-patient floor can serialize). Ratios come from the shared
// PCT_RATIO_SELECT (dollar-weighted, guarded denominators). Same discipline: sums and filtered
// counts only, never avg() (the fixture tests forbid the token so avg-of-ratios can't creep back
// in). A surviving group always has count(*) >= 1, so the share divisions need no zero guard;
// insurance_payments is coalesced defensively (no NULLs in the data today, but the schema allows
// them, and a NULL must read as "no positive payment", not silently drop out of the zero-pay share).
// At CHARGE grain (0050 rollup) the `claims` count and zero-pay shares are per logical charge line,
// not per snapshot row.
const COHORT_METRIC_SELECT =
  PCT_RATIO_SELECT +
  ', ' +
  'round(coalesce(sum(insurance_payments), 0), 2)::float8 as paid_total, ' +
  'round(count(*) filter (where coalesce(insurance_payments, 0) <= 0)::numeric / count(*) * 100, 2)::float8 as pct_zero_paid, ' +
  'round(count(*) filter (where coalesce(insurance_payments, 0) <= 0 and patient_balance_due > 0)::numeric / count(*) * 100, 2)::float8 as pct_patient_shifted';

/**
 * Build the TWO read-only cohort-curve queries — by claim/visit POSITION and by DAYS-since-first —
 * for one alpha-prefix blind-index token, tenant-scoped. Both enforce the min-patient floor via
 * HAVING on the final grouped result. Every value is a bound parameter; every identifier is a fixed
 * literal. `prefixBidx` is an OPAQUE keyed-HMAC token — no raw PHI reaches this module. The floor is
 * clamped so it can never drop below COHORT_MIN_PATIENTS.
 *
 * Grain: reads the CHARGE-GRAIN rollup (0050) — one row per logical charge line with netted
 * dollars, never the raw snapshot table. A "claim/visit" is a DISTINCT service date (charge_date):
 * one visit → many CPT×rev charge lines, so dense_rank() over charge_date collapses same-day lines
 * into one visit position. The cohort is scoped ONLY by tenant + prefix token (NOT the grid's
 * facility/month filters) so each patient's full lifetime sequence is intact, never truncated to a
 * window.
 */
export function buildCohortCurveQueries(
  prefixBidx: string,
  entityIds: string[],
  opts: CohortCurveOptions = {},
): { byPosition: { sql: string; params: unknown[] }; byDays: { sql: string; params: unknown[] } } {
  // Clamp the floor: a caller may make suppression STRICTER, never weaker than the agreed minimum.
  const minPatients = Math.max(COHORT_MIN_PATIENTS, opts.minPatients ?? COHORT_MIN_PATIENTS);
  const positionCap = opts.positionCap ?? COHORT_POSITION_CAP;
  const dayBucketDays = opts.dayBucketDays ?? COHORT_DAY_BUCKET_DAYS;
  const dayCap = opts.dayCap ?? COHORT_DAY_CAP;

  const byPosition = (() => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const ent = add(entityIds);
    const pref = add(prefixBidx);
    const cap = add(positionCap);
    const minp = add(minPatients);
    // dense_rank over charge_date = VISIT position (same-day charge lines share a position). The
    // HAVING is the suppression boundary — no LIMIT/pagination exists to bypass it.
    const sql =
      'with seq as (select member_id_bidx, ' +
      'dense_rank() over (partition by member_id_bidx order by charge_date) as pos, ' +
      'charge_amount, allowed_reliable, insurance_payments, patient_balance_due ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
      `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null) ` +
      'select pos::int as bucket, count(distinct member_id_bidx)::int as patients, count(*)::int as claims, ' +
      COHORT_METRIC_SELECT + ' ' +
      `from seq where pos <= ${cap} group by pos having count(distinct member_id_bidx) >= ${minp} order by pos`;
    return { sql, params };
  })();

  const byDays = (() => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const ent = add(entityIds);
    const pref = add(prefixBidx);
    const bucket = add(dayBucketDays);
    const cap = add(dayCap);
    const minp = add(minPatients);
    // Bucket by whole `dayBucketDays`-wide windows measured from each patient's OWN first claim
    // (days_since = charge_date − first_dt, an integer). Same HAVING suppression on the rollup.
    const sql =
      'with base as (select member_id_bidx, charge_date, charge_amount, allowed_reliable, insurance_payments, patient_balance_due ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null), ` +
      'firstdt as (select member_id_bidx, min(charge_date) as first_dt from base group by member_id_bidx), ' +
      'seq as (select b.member_id_bidx, (b.charge_date - f.first_dt) as days_since, b.charge_amount, b.allowed_reliable, b.insurance_payments, b.patient_balance_due ' +
      'from base b join firstdt f using (member_id_bidx)) ' +
      `select (floor(days_since::numeric / ${bucket}) * ${bucket})::int as bucket, count(distinct member_id_bidx)::int as patients, count(*)::int as claims, ` +
      COHORT_METRIC_SELECT + ' ' +
      `from seq where days_since <= ${cap} group by floor(days_since::numeric / ${bucket}) having count(distinct member_id_bidx) >= ${minp} order by bucket`;
    return { sql, params };
  })();

  return { byPosition, byDays };
}

/** Raw dollar sums returned by buildCohortTotalsQuery (the caller derives the guarded ratios). */
export interface CohortTotalsRow {
  billed: number | null;
  allowed: number | null;
  paid: number | null;
}

/**
 * Whole-cohort END-TO-END yield aggregate for one alpha-prefix cohort — the honest lifetime totals,
 * scoped IDENTICALLY to buildCohortCurveQueries (tenant + prefix token, 0050 charge grain) but with
 * NO position cap, NO day cap, and NO per-bucket suppression, so it never inherits the curve's
 * survivorship bias. Returns raw dollar sums (billed / allowed / paid); the caller derives the three
 * guarded ratios and applies the COHORT_MIN_PATIENTS gate (see loadCohortCurveData). Every value is a
 * bound parameter; every identifier a fixed literal; no raw PHI reaches this module (prefixBidx is an
 * opaque keyed-HMAC token).
 */
export function buildCohortTotalsQuery(
  prefixBidx: string,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const ent = add(entityIds);
  const pref = add(prefixBidx);
  const sql =
    // 0059 ④: end-to-end yield's allowed = the reliable tiered sum, matching the curve's ratios.
    'select sum(charge_amount)::float8 as billed, sum(allowed_reliable)::float8 as allowed, ' +
    'sum(insurance_payments)::float8 as paid ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null`;
  return { sql, params };
}

/**
 * Build the FOUR read-only queries behind ONE cohort-curve point's drilldown (Session G) — a stats
 * query (patients/claims/dollar-weighted %s + $/zero-pay, RE-DERIVED for this EXACT bucket — the
 * caller must never trust a client-supplied bucket's implied patient count), a top-N payer
 * breakdown, a top-N (CPT, Revenue-code) breakdown, and the FULL non-PHI row projection (reusing
 * CMD_EXPLORER_SELECT verbatim — the exact same column allowlist + shape the main grid returns).
 * All four share the SAME tiny `bucket_rows` CTE (just `id` + `member_id_bidx` for the matching
 * charge lines at this bucket) — every value is a bound parameter, every column/table a fixed
 * literal. The CALLER decides which to run: `stats` first (the authoritative gate), then
 * `byPayer`/`byCptRevenue` only once it clears COHORT_MIN_PATIENTS (the SAME floor the curve itself
 * enforces — a point that never rendered can't be drilled into), and `rows` only if it ADDITIONALLY
 * clears the stricter COHORT_DRILLDOWN_TABLE_MIN_PATIENTS.
 *
 * `axis` picks which of the curve's two x-axes this bucket belongs to (claim/visit POSITION vs DAYS
 * since first claim) — mirrors buildCohortCurveQueries' own by_position/by_days split exactly, so a
 * bucket number here means the same thing it means on the curve.
 */
export function buildCohortDrilldownQueries(
  prefixBidx: string,
  entityIds: string[],
  axis: 'position' | 'days',
  bucket: number,
  opts: CohortCurveOptions & { topN?: number } = {},
): {
  stats: { sql: string; params: unknown[] };
  byPayer: { sql: string; params: unknown[] };
  byCptRevenue: { sql: string; params: unknown[] };
  rows: { sql: string; params: unknown[] };
} {
  const dayBucketDays = opts.dayBucketDays ?? COHORT_DAY_BUCKET_DAYS;
  const topN = opts.topN ?? CMD_SEARCH_TOP_N;

  // The shared `bucket_rows` CTE: which (id, member_id_bidx) pairs fall in this exact bucket, tenant
  // + prefix scoped identically to buildCohortCurveQueries — and, like the curve, at CHARGE grain
  // (0050 rollup: one id per logical charge = the latest snapshot's row id). Deliberately minimal
  // (just the join key + the patient key) — every other column each query needs comes from joining
  // BACK to the rollup (aggregates: netted dollars) or the base table (the patient-table row
  // projection) below, so there is exactly one place that defines "which charges are in this bucket."
  const bucketRowsCte = (add: ParamAdder): string => {
    const ent = add(entityIds);
    const pref = add(prefixBidx);
    if (axis === 'position') {
      const buck = add(bucket);
      return (
        'with seq as (select id, member_id_bidx, ' +
        'dense_rank() over (partition by member_id_bidx order by charge_date) as pos ' +
        `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
        `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null), ` +
        `bucket_rows as (select id, member_id_bidx from seq where pos = ${buck}) `
      );
    }
    const bwidth = add(dayBucketDays);
    const buck = add(bucket);
    return (
      `with base as (select id, member_id_bidx, charge_date from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
      `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null), ` +
      'firstdt as (select member_id_bidx, min(charge_date) as first_dt from base group by member_id_bidx), ' +
      'seq as (select b.id, b.member_id_bidx, (b.charge_date - f.first_dt) as days_since ' +
      'from base b join firstdt f using (member_id_bidx)), ' +
      `bucket_rows as (select id, member_id_bidx from seq where (floor(days_since::numeric / ${bwidth}) * ${bwidth})::int = ${buck}) `
    );
  };

  const build = (select: string, tail: (add: ParamAdder) => string = () => ''): { sql: string; params: unknown[] } => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const cte = bucketRowsCte(add);
    return { sql: `${cte}${select}${tail(add)}`, params };
  };

  // The three AGGREGATE queries join back to the ROLLUP (netted dollars at charge grain — joining
  // the raw snapshot table here would resurrect the grain bug for exactly this bucket).
  // `member_id_bidx` exists on BOTH the rollup and bucket_rows, so it's qualified; every other
  // column referenced is unique to whichever side actually has it (no other ambiguity).
  const stats = build(
    'select count(distinct bucket_rows.member_id_bidx)::int as patients, count(*)::int as claims, ' +
      COHORT_METRIC_SELECT +
      ` from ${CMD_EXPLORER_CHARGE_ROLLUP} join bucket_rows using (id)`,
  );

  const byPayer = build(
    'select primary_payer as label, count(*)::int as count, coalesce(sum(charge_amount), 0)::float8 as charge ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} join bucket_rows using (id)`,
    (add) => ` group by primary_payer order by charge desc nulls last, count desc limit ${add(topN)}`,
  );

  const byCptRevenue = build(
    'select cpt_code as cpt, revenue_code as revenue, count(*)::int as count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as charge, ' +
      PCT_RATIO_SELECT +
      ` from ${CMD_EXPLORER_CHARGE_ROLLUP} join bucket_rows using (id)`,
    (add) => ` group by cpt_code, revenue_code order by charge desc nulls last, count desc limit ${add(topN)}`,
  );

  // Reuse CMD_EXPLORER_SELECT verbatim (aliased `t`, over the BASE table) — the identical non-PHI
  // column allowlist + shape the main grid returns, so the drilldown's patient table is a
  // CmdExplorerRow[] the SAME masking + reveal path already handles. bucket_rows ids are the
  // rollup's latest-snapshot row ids, so this join lands on ONE real row per charge (the current
  // state) rather than every historical snapshot. `using (id)` (not `on bucket_rows.id = t.id`) — CRITICAL:
  // CMD_EXPLORER_SELECT's bare `id` column would otherwise be ambiguous once bucket_rows' OWN `id`
  // is also in scope from an explicit ON-join; USING merges the shared column into one unambiguous
  // output (caught by a live query-execution check — a plain SQL-string match test can't catch this
  // class of bug, since it never actually runs the query against a real Postgres planner).
  const rows = build(`${CMD_EXPLORER_SELECT} join bucket_rows using (id)`, () => ' order by t.charge_date');

  return { stats, byPayer, byCptRevenue, rows };
}

// --- GROUPED MODE: one row per (patient × payment date × facility × payer) ---------------------

/**
 * ONE GROUPED ROW — several charge lines condensed into the payment they arrived on.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────────────────────────
 * Asked for directly: *"if a 'charge from date' is multiple days, which has multiple charge lines,
 * but all on a payment that came in on a single day, are we able to condense the charge lines into
 * a grouping somehow?"* Measured on the live book: 497,337 rollup rows collapse to 101,158 groups —
 * **4.92 charge lines per group**, so a 50-row page carries ~246 lines' worth of content.
 *
 * ── THE GROUP KEY, AND THE RULE THAT CHOSE IT ──────────────────────────────────────────────────
 * `(business_entity_id, member_id_bidx, payment_received, facility, primary_payer)`.
 *
 * ⚠ `business_entity_id` LEADS THE KEY AND IS NOT OPTIONAL. Without it, Consolidated (the only view
 * that spans tenants) could merge BXR and Indigo money into one row: `member_id_bidx` is an HMAC
 * under ONE key, so the same member id at both tenants produces the same token. Measured 2026-08-18
 * this merged nothing — 0 cross-tenant groups — but only because the two tenants' facilities differ,
 * and "no tenant currently collides" is a property of today's data, not a guarantee. Tenancy on
 * this surface is structural everywhere else; it is structural here too.
 *
 * ⚠ A NULL `member_id_bidx` KEYS ON THE ROW ID INSTEAD (`coalesce(member_id_bidx, 'id:' || id)`).
 * SQL GROUP BY treats NULLs as EQUAL, so without this every member-less row sharing a payment date,
 * facility and payer would collapse into a single row purporting to be one patient — with a summed
 * total, a line count, and a representative PHI-reveal id that belong to no one. Keying on the id
 * makes each such row its own group, which is the honest answer: we cannot prove they are the same
 * person, so we do not merge them. Measured 2026-08-18: 0 such rows exist (ingest rejects a charge
 * with no member id), so this is insurance against a column that is nullable rather than a live fix.
 *
 * ⚠ THE COALESCE COSTS ~64%, MEASURED, AND IS KEPT ANYWAY. Median of 6 warm runs, cross-tenant:
 * a plain `t.member_id_bidx` groups in 662 ms, this expression in 1,086 ms — the expression cannot
 * use `cmd_charge_rollup_member` as a presorted prefix, so the planner sorts instead.
 *
 * Kept because "there are no null members today" is the SAME reasoning that produced the
 * cross-tenant hole above ("the tenants' facilities differ, so they cannot collide") — it describes
 * today's data, not an invariant, and both failures are silent and produce a wrong money row with
 * someone else's PHI-reveal id attached. 0.4s on a view the user opted into is a fair price for a
 * guarantee instead of a coincidence.
 *
 * If this is ever revisited, revisit it with a number: the cheap alternative is to drop the coalesce
 * AND enforce member_id_bidx NOT NULL where the invariant actually lives (ingest), rather than
 * paying for the check on every read.
 *
 * The rule: **any column displayed UN-AGGREGATED must be in the group key**, or the cell shows one
 * of several values arbitrarily and the row quietly lies. `member_id_bidx + payment_received` alone
 * is what the request literally describes — but facility and payer are displayed columns AND filter
 * dimensions, so leaving them out would let one row claim a facility it only partly belongs to.
 *
 * Including them costs **981 groups out of 101,158 (under 1%)**, measured — so honesty here is
 * nearly free. That measurement is why this is a key choice and not a compromise.
 *
 * The three PHI columns need no such treatment: `member_id_bidx` IS in the key, so a group is
 * exactly one patient and patient_name / member_id / group_number stay single-valued by
 * construction — the reveal affordance keeps working on the representative row.
 *
 * ── WHAT AGGREGATES, AND HOW ───────────────────────────────────────────────────────────────────
 * SUMMED: charge_amount, allowed_amount (allowed_reliable), insurance_payments, adjustments,
 * patient_balance_due.
 *
 * ⚠ SUMMING `insurance_payments` IS CORRECT HERE, despite the rollup's own rule that it is a
 * charge-cumulative running total to be MAXed and NEVER summed. That rule is about collapsing the
 * SNAPSHOTS OF ONE CHARGE — the rollup already did that (`max(insurance_payments)` per charge). This
 * sums ACROSS DIFFERENT charges, each contributing its own resolved final total, which is addition
 * over disjoint things. Do not "fix" this to a MAX: that would report one charge's payment as the
 * whole group's.
 *
 * ⚠ THE TWO PERCENTAGES ARE RECOMPUTED FROM THE SUMS, NEVER AVERAGED. Averaging per-charge ratios
 * would weight a $50 line the same as a $50,000 one and produce a number that matches nothing. The
 * formulas mirror the rollup's own definitions EXACTLY, including the `* 100` and `round(…, 2)`:
 *     pct_allowed = round(sum(allowed_reliable) / sum(charge_amount)    * 100, 2)
 *     pct_paid    = round(sum(insurance_payments) / sum(allowed_reliable) * 100, 2)
 * If the matview's definition ever changes, these must move with it or a grouped row and an
 * ungrouped one will disagree about the same money.
 *
 * NOT ADDITIVE, so they become facts about the group instead of a value:
 *   · charge_date  → the min..max span (`charge_date` + `charge_date_end`), which is precisely the
 *     "multiple days" the request describes;
 *   · cpt_code / revenue_code → the code only when EVERY line has one and they agree, plus a
 *     `*_mixed` flag. Three states must be distinguishable — one code, several/partial, or none at
 *     all — because a group spanning several CPTs cannot honestly show one of them, and a group
 *     with no CPT at all is not the same thing as one with several.
 *   · line_count   → how many charge lines were condensed, so the collapse is never invisible.
 *
 * ⚠ `sum()` SKIPS NULLS, and `allowed_reliable` is null on 3,939 of 497,337 rows (0.8%) where the
 * rollup could not resolve an allowed amount. A group containing one of those understates its
 * allowed total rather than reporting null. That matches how every other aggregate on this surface
 * already behaves; it is recorded because it is invisible in the output.
 */
export interface CmdExplorerGroupRow {
  /** The representative (latest) rollup id — the keyset tiebreak AND the PHI-reveal key. */
  id: number;
  /** Earliest charge_date in the group ('YYYY-MM-DD'). */
  charge_date: string | null;
  /** Latest charge_date in the group. Equal to `charge_date` for a single-day group. */
  charge_date_end: string | null;
  payment_received: string | null;
  /** How many charge lines this row condenses. Always >= 1. */
  line_count: number;
  /** The CPT when EVERY line in the group has one and they agree; null otherwise. Read together
   *  with `cpt_mixed`, which separates "several/some missing" from "no line has a CPT". */
  cpt_code: string | null;
  /** True when the group's lines do not all carry the same CPT (including some-missing). */
  cpt_mixed: boolean;
  /** Same contract as `cpt_code`. */
  revenue_code: string | null;
  /** Same contract as `cpt_mixed`. */
  revenue_mixed: boolean;
  facility: string | null;
  primary_payer: string | null;
  employer_name: string | null;
  charge_amount: string | null;
  allowed_amount: string | null;
  insurance_payments: string | null;
  adjustments: string | null;
  patient_balance_due: string | null;
  pct_allowed: string | null;
  pct_paid: string | null;
  /** 0086 attribution for the group — see CmdExplorerRow.facility_resolved. Resolved on the
   *  REPRESENTATIVE row, which is exact here because facility_alias is functionally dependent on
   *  this query's group key (measured; see the join's comment). */
  facility_resolved: string | null;
  /** The 0086 method behind facility_resolved. Null exactly when that is null. */
  facility_method: string | null;
  /** See CmdExplorerRow.is_scheduled. A grouped row IS one payment date, so the flag is exact. */
  is_scheduled: boolean;
}

export interface CmdExplorerGroupPage {
  rows: CmdExplorerGroupRow[];
  nextCursor: CmdExplorerCursor | null;
}

/**
 * Keyset page of GROUPED rows, ordered by payment_received then the representative id.
 *
 * ── SORTING IS DELIBERATELY FIXED TO payment_received IN v1 ────────────────────────────────────
 * Not an oversight. Ordering groups by an AGGREGATE (`sum(charge_amount)`, the recomputed pcts) is
 * perfectly possible — the keyset simply carries the aggregate value — but every such column needs
 * its own cursor path and its own test, and a half-tested cursor does not fail loudly: it SKIPS OR
 * REPEATS rows while looking correct. Shipping the grain first, with one ordering that is provably
 * right, is the trade. `payment_received` is also the natural order for a payment-grouped view and
 * the grid's existing default.
 *
 * ⚠ THE ORDERING IS TOTAL, WHICH IS WHAT MAKES THE CURSOR SAFE. `max(t.id)` is unique per group (an
 * id belongs to exactly one group), so `(payment_received, max(id))` can never tie — the failure
 * that would otherwise silently drop or duplicate a group at a page boundary. This is the same
 * `{value, id}` cursor shape row mode uses, so `CmdExplorerCursor` is reused unchanged rather than
 * inventing a second cursor type that would need its own validation.
 *
 * The keyset lives in HAVING because it references `max(t.id)`; `payment_received` is a grouping
 * column so it is legal there too. A WHERE prune on payment_received is emitted alongside it — same
 * predicate, applied before aggregation — so paging deep does not re-aggregate the whole book. The
 * NULLS-LAST handling mirrors buildCmdExplorerQuery exactly; read them side by side.
 */
export function buildCmdExplorerGroupedQuery(
  cursor: CmdExplorerCursor | null,
  filter: CmdExplorerFilter,
  direction: 'asc' | 'desc',
  limit: number,
  entityIds: string[],
  opts?: CmdExplorerBuilderOptions,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = cmdExplorerBaseConds(filter, entityIds, add, {
    resolveFacility: true,
    requireWindow: opts?.requireWindow === true,
  });
  const dir = direction === 'asc' ? 'asc' : 'desc';
  const cmp = direction === 'asc' ? '>' : '<';

  /**
   * WHICH COLUMN THIS PAGE IS ORDERED BY. Policy (the window cap) lives in resolveGroupedSort; by
   * the time we are here the decision is made and this just emits SQL.
   *
   * The two paths differ in more than an ORDER BY clause, which is why they are branched rather
   * than parameterised into one string:
   *   · payment_received is a GROUPING KEY, so its keyset can ALSO be applied as a WHERE prune
   *     before aggregation — that is what keeps deep paging cheap.
   *   · sum(charge_amount) is an AGGREGATE. There is no pre-aggregation prune for it (you cannot
   *     filter on a sum before the rows are grouped), so the keyset lives in HAVING alone and the
   *     whole window is aggregated on every page. Measured flat at ~62 ms (BXR 90d) on page 1 and
   *     page 10 — the cost does not grow with depth, it starts at its ceiling.
   */
  const sortCol: GroupedSortColumn = opts?.groupedSort === 'charge_amount' ? 'charge_amount' : 'payment_received';
  const AGG = 'sum(t.charge_amount)';

  const having: string[] = [];
  if (cursor !== null) {
    if (sortCol === 'charge_amount') {
      if (cursor.value === null) {
        // A NULL sum: every line in that group had a null charge_amount. Under NULLS LAST those
        // sort after every real total, so only later null-sum groups remain.
        //
        // ⚠ UNREACHABLE WITH TODAY'S DATA, AND KEPT ANYWAY. Measured 2026-09-03: 0 of 505,423
        // charge lines have a null charge_amount, so no group total is null and this arm never
        // fires — unlike its payment_received counterpart, where nulls are real. It stays because
        // the column IS nullable in the matview, and the failure mode if that ever changes is the
        // silent kind: without this arm the trailing NULL block would be dropped from the last
        // page rather than raising. Do not "simplify" it away on coverage grounds.
        having.push(`(${AGG} is null and max(t.id) ${cmp} ${add(cursor.id)})`);
      } else {
        // ⚠ NO `conds.push(...)` COUNTERPART HERE, and its absence is the point — see the docblock
        // above. Adding a WHERE prune on charge_amount would filter individual CHARGE LINES by the
        // cursor's GROUP TOTAL, which is a different quantity: a group whose total clears the
        // cursor can be assembled from lines that individually do not, so rows would vanish from
        // groups and the totals on screen would be wrong rather than merely mis-ordered.
        const vParam = add(cursor.value);
        const idParam = add(cursor.id);
        having.push(
          `(${AGG} ${cmp} ${vParam}::numeric ` +
            `or (${AGG} = ${vParam}::numeric and max(t.id) ${cmp} ${idParam}) ` +
            `or ${AGG} is null)`,
        );
      }
    } else if (cursor.value === null) {
      // The cursor row sat in the trailing NULL block: only later NULL-payment groups remain.
      having.push(`(t.payment_received is null and max(t.id) ${cmp} ${add(cursor.id)})`);
    } else {
      // Prune BEFORE aggregating. The `is null` arm is required: under NULLS LAST a null
      // payment_received sorts after every real date, so those groups are still ahead of us.
      const pruneParam = add(cursor.value);
      conds.push(`(t.payment_received ${cmp}= ${pruneParam}::date or t.payment_received is null)`);
      const vParam = add(cursor.value);
      const idParam = add(cursor.id);
      having.push(
        `(t.payment_received ${cmp} ${vParam}::date ` +
          `or (t.payment_received = ${vParam}::date and max(t.id) ${cmp} ${idParam}) ` +
          `or t.payment_received is null)`,
      );
    }
  }

  const where = conds.length > 0 ? ` where ${conds.join(' and ')}` : '';
  const havingSql = having.length > 0 ? ` having ${having.join(' and ')}` : '';
  const groupedToday = filter.businessToday ?? undefined;
  const groupedScheduled = groupedToday === undefined
    ? 'false as is_scheduled'
    : `coalesce(g.payment_received > ${add(groupedToday)}, false) as is_scheduled`;

  // ⚠ THE OUTER PROJECTION IS SPELLED OUT, NOT `g.*`.
  //
  // `g.*` would have been safe by inspection — `g` is this function's own fixed subquery — and it
  // was written that way first. The standing rule ("never SELECT *; project explicit allowlisted
  // columns") is deliberately unconditional, and this is a good illustration of why: with `g.*` the
  // outer row shape is defined by whatever the inner select happens to list, so ADDING a column
  // inside the subquery silently widens what crosses the Server Action boundary. Naming them here
  // means the shape is a decision, and CmdExplorerGroupRow is the only thing it can be.
  //
  // employer_name is LEFT JOINed on the REPRESENTATIVE id, for the same reason row mode joins it
  // outside the paged subquery: it lives on the 349 MB base table and the rollup deliberately does
  // not carry it, so joining after the LIMIT costs 50 primary-key lookups instead of a hash join.
  // Within one group it is one patient's plan sponsor and effectively constant; taking the latest
  // row's value is a documented choice, not an accident.
  const sql =
    `select g.id, g.charge_date, g.charge_date_end, g.payment_received, g.line_count, ` +
    `g.cpt_code, g.cpt_mixed, g.revenue_code, g.revenue_mixed, g.facility, g.primary_payer, ` +
    `g.charge_amount, g.allowed_amount, g.insurance_payments, g.adjustments, ` +
    `g.patient_balance_due, g.pct_allowed, g.pct_paid, e.employer_name, ` +
    `fr.facility_alias as facility_resolved, fr.method as facility_method, ` +
    // Same shape and same rationale as row mode — outer query, already-projected text date, after
    // the LIMIT. See buildCmdExplorerQuery's is_scheduled docblock.
    `${groupedScheduled} from (` +
    `select max(t.id) as id, ` +
    `to_char(min(t.charge_date), 'YYYY-MM-DD') as charge_date, ` +
    `to_char(max(t.charge_date), 'YYYY-MM-DD') as charge_date_end, ` +
    `to_char(t.payment_received, 'YYYY-MM-DD') as payment_received, ` +
    `count(*)::int as line_count, ` +
    // ⚠ THREE STATES, NOT TWO — and count/min/max rather than count(distinct).
    //
    // count(distinct) was measured at 1.2s of a 2.1s page (it sorts within every group); count, min
    // and max are streaming aggregates and effectively free, a 2.6x on the whole query.
    //
    // But min/max ALONE is wrong, because SQL aggregates SKIP NULLS. A group of ['99213', null]
    // has min = max = '99213' and would claim every line carries that CPT; a group where every line
    // is null has min = max = NULL, and `NULL = NULL` is NULL rather than true, so it would fall to
    // the ELSE and be reported as varying. Both misstate what the group contains, in OPPOSITE
    // directions. So the value is emitted only when EVERY line has a code AND they agree
    // (`count(code) = count(*)`), and a separate `*_mixed` flag distinguishes "several / some
    // missing" from "no line has one at all". The UI renders those as Multiple and an em dash.
    `case when count(t.cpt_code) = count(*) and min(t.cpt_code) = max(t.cpt_code) ` +
    `then min(t.cpt_code) else null end as cpt_code, ` +
    `(count(t.cpt_code) > 0 and (count(t.cpt_code) <> count(*) or min(t.cpt_code) <> max(t.cpt_code))) as cpt_mixed, ` +
    `case when count(t.revenue_code) = count(*) and min(t.revenue_code) = max(t.revenue_code) ` +
    `then min(t.revenue_code) else null end as revenue_code, ` +
    `(count(t.revenue_code) > 0 and (count(t.revenue_code) <> count(*) or min(t.revenue_code) <> max(t.revenue_code))) as revenue_mixed, ` +
    `t.facility, t.primary_payer, ` +
    `sum(t.charge_amount) as charge_amount, ` +
    `sum(t.allowed_reliable) as allowed_amount, ` +
    `sum(t.insurance_payments) as insurance_payments, ` +
    `sum(t.adjustments) as adjustments, ` +
    `sum(t.patient_balance_due) as patient_balance_due, ` +
    // Recomputed from the SUMS with the matview's own formulas — see the docblock.
    `case when sum(t.charge_amount) > 0 and sum(t.allowed_reliable) is not null ` +
    `then round(sum(t.allowed_reliable) / sum(t.charge_amount) * 100, 2) else null end as pct_allowed, ` +
    `case when sum(t.allowed_reliable) > 0 ` +
    `then round(sum(t.insurance_payments) / sum(t.allowed_reliable) * 100, 2) else null end as pct_paid ` +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} t${where} ` +
    `group by t.business_entity_id, coalesce(t.member_id_bidx, 'id:' || t.id), ` +
    `t.payment_received, t.facility, t.primary_payer${havingSql} ` +
    // `max(t.id)` stays the tiebreaker on BOTH paths, and it is what keeps the cursor safe: an id
    // belongs to exactly one group, so the ordering is TOTAL and no page boundary can drop or
    // repeat a group. That matters MORE under the aggregate sort than under the date sort — two
    // groups can easily share a total, where (date, id) could never tie at all.
    `order by ${sortCol === 'charge_amount' ? AGG : 't.payment_received'} ${dir} nulls last, ` +
    `max(t.id) ${dir} limit ${add(limit)}` +
    `) g left join collections.cmd_explorer_rows e on e.id = g.id ` +
    // FACILITY RESOLUTION IN GROUPED MODE — resolved on the REPRESENTATIVE id, outside the LIMIT,
    // exactly as employer_name is, and licensed by the same kind of argument.
    //
    // WHAT MAKES THE REPRESENTATIVE ROW REPRESENTATIVE: facility_alias is functionally dependent on
    // this query's group key. MEASURED against live data before this line was written (2026-08-30,
    // all 3,023 placeholder groups):
    //   0 groups with >1 distinct facility_alias   (max distinct = 1)
    //   0 groups with >1 distinct method
    //   0 groups MIXING resolved and unresolved lines
    // The third is the one that matters most and is easy to skip: without it, a group holding one
    // attributed line and one unattributed line would take the attribution for the whole group. No
    // such group exists. Re-run that check before trusting this after any change to 0086.
    //
    // ⚠ THREE FORMULATIONS WERE TRIED; TAKE THIS ONE. (a) `min(fr.facility_alias)` over a LEFT JOIN
    // in the inner query is ALSO correct under the same FD — but joining `fr` there makes the
    // UNQUALIFIED `id` / `business_entity_id` that cmdExplorerBaseConds emits AMBIGUOUS (42702),
    // because both relations carry those names. (b) A correlated scalar subquery per line dodges
    // that but runs ~47,000 index lookups on the consolidated 90-day scope instead of 50, inside
    // the input to a sort that already spills. (c) This: 50 unique-index lookups after the LIMIT,
    // zero effect on the group key, the sort key, or the spill.
    `left join ${CMD_FACILITY_RESOLUTION} fr on fr.id = g.id ` +
    // Re-stated on the OUTER query: a LEFT JOIN does not preserve the subquery's ordering, and the
    // next cursor is built from the LAST ROW of this result set — an unordered page would hand back
    // a cursor for an arbitrary group and silently skip or repeat pages. Costs nothing over 50 rows.
    // `g.payment_received` is the to_char TEXT here, and sorting it as text is order-identical to the
    // date because ISO-8601 is lexicographically ordered (the same argument row mode relies on).
    // `g.charge_amount` needs no such argument — it is the subquery's numeric `sum`, sorted as a
    // number. The outer ORDER BY re-states the inner one over the already-limited 50 rows. It must
    // name the SAME column, or the page would be selected by one ordering and displayed in another.
    `order by g.${sortCol} ${dir} nulls last, g.id ${dir}`;
  return { sql, params };
}

/**
 * A grouped row's cursor scalar — the value of whichever column the page was ORDERED BY, or null
 * for a row in the trailing NULL block.
 *
 * ⚠ IT MUST AGREE WITH THE ORDERING THE PAGE WAS BUILT WITH. Handing back a payment date while the
 * page was ordered by total (or the reverse) produces a keyset that compares the wrong quantity —
 * which does not error, it silently skips or repeats groups at every page boundary. That is the
 * exact failure the builder's own docblock warns about, so the sort column is a REQUIRED argument
 * rather than an optional one with a default: a caller that forgets it fails to compile.
 *
 * The total is returned as a STRING. `sum(numeric)` can exceed what a double represents exactly,
 * and the value round-trips through a Server Action to become a `::numeric` bind param, so keeping
 * it textual end-to-end avoids a float ever touching a comparison that decides page boundaries.
 */
export function cmdExplorerGroupSortValue(
  row: CmdExplorerGroupRow,
  sortColumn: GroupedSortColumn,
): string | null {
  if (sortColumn === 'charge_amount') {
    const v = row.charge_amount;
    return v === null || v === undefined ? null : String(v);
  }
  return row.payment_received ?? null;
}
