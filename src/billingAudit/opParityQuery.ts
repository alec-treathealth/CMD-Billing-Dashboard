/**
 * OP-scope row-class PARITY — the soak criterion the "5 clean nights" gate cannot express.
 *
 * WHY THIS EXISTS. The consolidated feed is scheduled to replace the legacy OP pair
 * (`10073210`/`10147817`) once it proves five clean nights. "Clean" today means the cron
 * reported no failures, no header mismatch and no identity conflicts — all of which were
 * already zero on the first night. None of it measures COVERAGE, and coverage is where the
 * cutover actually bites:
 *
 *   measured 2026-08-02 — legacy OP wrote 15,181 rows; consolidated classified 6,857 as OP.
 *   The 8,324-row gap decomposes exactly, to the row:
 *     4,471  PAID                       — filter B excludes paid outright
 *     3,853  BALANCE_DUE_PATIENT        — older than filter C's ~90d window
 *   (4,714 non-paid/non-patient-balance + 2,143 in-window patient-balance = 6,857.)
 *
 * That is filter design working as specified, NOT a defect. But flipping
 * `CMD_AUDIT_CONSOLIDATED_OP_WRITE` and retiring the legacy cron permanently stops REFRESHING
 * those two classes. Because `audit_row` updates rows in place and never deletes them, the
 * frozen rows stay on the worklist looking current forever, and an OP claim that later pays
 * never flips to PAID — so `AT_PAYER` inflates while `PAID` decays. Nothing in the cron log,
 * and no count on `/billing-audit`, would move.
 *
 * WHAT THIS MEASURES. Per `status_category`, the legacy-OP row count against the
 * consolidated-OP row count for the same ingest day, plus the resulting per-class delta. A
 * class present in legacy and absent (or materially short) in consolidated is a coverage loss
 * that the cutover would make permanent. Run it nightly during the soak; a night is only
 * "clean" if the operator has looked at this table and accepted every non-zero delta.
 *
 * SCOPE + SAFETY. Read-only, aggregate-only: counts grouped by `status_category`, which is a
 * closed enum of claim-workflow states, never PHI. No patient identifier, amount or date is
 * projected. Parameterised throughout (`$n` bound values; table, column and enum-literal names
 * are fixed string literals) per the query-library rule. Entity scope is an inline
 * `= any($n::uuid[])` list, app-supplied — this plane is BXR-only today but the builder does
 * not hardcode that.
 *
 * The two feeds are distinguished by `scope_source`, the 0074 provenance column: legacy-OP
 * rows carry NULL (they predate it and were never TOB-derived), consolidated rows carry
 * 'tob' or 'roster_fallback'. That is the only durable discriminator on the table — the
 * `source_filter_id` column is NULL on the legacy feed too.
 */

import { assertEntityScope } from '../collections/entityScope.js';

export type ParamAdder = (v: unknown) => string;

/** One `status_category` compared across the two feeds for a single ingest day. */
export interface OpParityRow {
  status_category: string;
  /** Rows the LEGACY OP cron wrote that day (scope_source IS NULL). */
  legacy_rows: string;
  /** Rows the CONSOLIDATED feed wrote/would write that day (scope_source IS NOT NULL). */
  consolidated_rows: string;
}

/**
 * Build the parity query for one ingest day.
 *
 * `asOfDate` is an ISO `YYYY-MM-DD` bound as a date. It keys on `ingested_at::date` rather
 * than a service date deliberately: the question is "did tonight's two feeds see the same
 * rows", which is an ingest-time question. A service-date window would drag in rows neither
 * feed touched tonight and make every class look short.
 *
 * FULL OUTER JOIN, not a left join: a class that appears ONLY on the consolidated side is
 * also worth seeing (it would mean the new feed is finding rows the legacy one never did),
 * and a left join would silently drop it.
 *
 * FAILS CLOSED ON AN EMPTY SCOPE. `entityIds` goes through the standing `assertEntityScope`
 * guard, which throws on an empty or malformed list. That matters more here than on a normal
 * reader: `= any('{}'::uuid[])` is always false, so an empty scope would return zero rows,
 * `assessOpParity` would see nothing to compare, and the night would grade CLEAN having
 * measured nothing — a fail-OPEN on the very gate that is supposed to block the cutover. Same
 * reasoning as 022's status vocabulary, where zero attempts is `empty` rather than `ok`: a run
 * that proved nothing must never read as a pass.
 */
export function buildOpParityQuery(
  asOfDate: string,
  entityIds: readonly string[],
  addParam: ParamAdder,
): string {
  const day = addParam(asOfDate);
  const ents = addParam(assertEntityScope(entityIds, 'buildOpParityQuery'));
  return (
    'with legacy as (' +
    '  select status_category, count(*) as n' +
    '    from claims.audit_row' +
    '   where audit_scope = \'OP\'' +
    '     and scope_source is null' +
    `     and ingested_at::date = ${day}::date` +
    `     and business_entity_id = any(${ents}::uuid[])` +
    '   group by 1' +
    '), consolidated as (' +
    '  select status_category, count(*) as n' +
    '    from claims.audit_row' +
    '   where audit_scope = \'OP\'' +
    '     and scope_source is not null' +
    `     and ingested_at::date = ${day}::date` +
    `     and business_entity_id = any(${ents}::uuid[])` +
    '   group by 1' +
    ') ' +
    'select coalesce(l.status_category, c.status_category) as status_category, ' +
    'coalesce(l.n, 0)::text as legacy_rows, ' +
    'coalesce(c.n, 0)::text as consolidated_rows ' +
    'from legacy l full outer join consolidated c on c.status_category = l.status_category ' +
    'order by 1'
  );
}

/** A per-class parity verdict. `delta` is legacy − consolidated: positive = coverage LOST. */
export interface OpParityVerdict {
  statusCategory: string;
  legacyRows: number;
  consolidatedRows: number;
  delta: number;
  /** True when the consolidated feed carries materially fewer rows for this class. */
  shortfall: boolean;
}

export interface OpParityAssessment {
  verdicts: readonly OpParityVerdict[];
  /** Classes the cutover would stop refreshing entirely (consolidated = 0, legacy > 0). */
  droppedClasses: readonly string[];
  totalLegacy: number;
  totalConsolidated: number;
  /**
   * Did this night actually compare anything? False when the query returned no rows at all —
   * the cron did not run, the day is wrong, or the scope matched nothing. Kept separate from
   * `parityHolds` so "nothing to compare" can never be mistaken for "compared and agreed".
   */
  measured: boolean;
  /**
   * True only when the night was MEASURED and no class shows a shortfall. An unmeasured night
   * is never a pass — it has proven nothing about coverage, and calling it clean is the same
   * false reassurance 022 rejected when it made zero-attempt runs `empty` rather than `ok`.
   */
  parityHolds: boolean;
}

/**
 * Grade one night's parity rows.
 *
 * `toleranceRatio` allows for benign intraday drift between the two crons (they run 20+ minutes
 * apart against a feed that is still growing — the 2026-07-29 recon measured TREAT_NV +81 and
 * TREAT_WA +75 inside one afternoon). It is a RATIO of the legacy count, not an absolute, so it
 * scales with class size. It deliberately does NOT excuse a class dropping to zero: that is a
 * structural loss regardless of magnitude, so `droppedClasses` is computed before tolerance.
 */
export function assessOpParity(
  rows: readonly OpParityRow[],
  toleranceRatio = 0.02,
): OpParityAssessment {
  const verdicts: OpParityVerdict[] = rows.map((r) => {
    const legacyRows = Number(r.legacy_rows);
    const consolidatedRows = Number(r.consolidated_rows);
    const delta = legacyRows - consolidatedRows;
    const allowed = Math.ceil(legacyRows * toleranceRatio);
    // A class that vanished is always a shortfall; otherwise allow proportional drift.
    const shortfall = legacyRows > 0 && (consolidatedRows === 0 || delta > allowed);
    return { statusCategory: r.status_category, legacyRows, consolidatedRows, delta, shortfall };
  });
  const totalLegacy = verdicts.reduce((a, v) => a + v.legacyRows, 0);
  const totalConsolidated = verdicts.reduce((a, v) => a + v.consolidatedRows, 0);
  // "Measured" means the two feeds actually produced something to compare. A day with rows on
  // neither side proves nothing — see the `measured` doc comment.
  const measured = verdicts.length > 0 && (totalLegacy > 0 || totalConsolidated > 0);
  return {
    verdicts,
    droppedClasses: verdicts.filter((v) => v.legacyRows > 0 && v.consolidatedRows === 0).map((v) => v.statusCategory),
    totalLegacy,
    totalConsolidated,
    measured,
    parityHolds: measured && !verdicts.some((v) => v.shortfall),
  };
}
