/**
 * readmission_candidates — a population scan (no specific patient targeted) that
 * self-joins claims.claims to surface likely cross-claim readmissions: two claims
 * for the same person whose service dates are 1..gap_days apart. Each pair is
 * graded into a confidence tier (exact / strong / possible) by how strongly the
 * identity matches — candidate generation for a human, never an asserted truth
 * (see CLAUDE.md Phase 2+ notes).
 *
 * PHI boundary: patient_last / member_id_norm are used ONLY inside the matching
 * predicates (bound or fixed in SQL); they never appear in summary_stats, stored
 * args, or the audit line. identity_hash is null — no single identity is named.
 *
 * Structure: a pre-filter CTE `f` (so the ClaimFilter applies to BOTH sides of
 * the join with unqualified column names) feeds a `pairs` CTE that computes the
 * confidence tier; the outer query keeps only graded pairs. (The spec sketch used
 * `HAVING confidence IS NOT NULL`, which is invalid without GROUP BY — an outer
 * WHERE on the wrapped result is the correct equivalent.)
 *
 * Pair orientation is by SERVICE DATE, not by id: `b.date_of_service >
 * a.date_of_service` already counts each differing-date pair exactly once (and
 * excludes same-day pairs), with `a.id <> b.id` only guarding against self-pairs.
 * An earlier `a.id < b.id` guard was dropped: claims.id is insertion-order
 * identity and ingest is NOT date-sorted, so id order does not track service
 * date — `a.id < b.id` silently missed any pair whose later-dated claim ingested
 * first, systematically understating counts.
 */
import { randomUUID } from 'node:crypto';
import { buildClaimFilter, validateClaimFilter } from './filters.js';
import { finalize } from './runtime.js';
import type {
  NoPhi,
  QueryContext,
  QueryResult,
  ReadmissionCandidatesArgs,
  ReadmissionConfidenceCounts,
  ReadmissionSummary,
} from './types.js';

const DEFAULT_GAP_DAYS = 30;
const MIN_GAP_DAYS = 1;
const MAX_GAP_DAYS = 365;

interface ReadmissionDbRow {
  confidence: 'exact' | 'strong' | 'possible';
  facility_name: string;
  payer_name: string;
}

function validateGapDays(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_GAP_DAYS;
  if (!Number.isInteger(raw) || raw < MIN_GAP_DAYS || raw > MAX_GAP_DAYS) {
    throw new Error(
      `readmission_candidates: gap_days must be an integer in [${MIN_GAP_DAYS}, ${MAX_GAP_DAYS}]`,
    );
  }
  return raw;
}

/**
 * Build the parameterized self-join query. gap_days is always $1; the filter
 * clause (from buildClaimFilter, numbered from $2) goes inside the pre-filter
 * CTE. Identity columns are fixed in SQL; only the filter VALUES are bound.
 * Exposed for the fixture to assert the exact SQL.
 */
export function readmissionCandidatesSql(filterClause: string): string {
  const filtered = filterClause
    ? `select * from claims.claims where ${filterClause}`
    : `select * from claims.claims`;
  return (
    `with f as (${filtered}), ` +
    `pairs as (` +
    `select ` +
    `case ` +
    `when a.member_id_norm is not null and a.member_id_norm <> '' ` +
    `and b.member_id_norm is not null and b.member_id_norm <> '' ` +
    `and a.member_id_norm = b.member_id_norm ` +
    `and lower(a.patient_last) = lower(b.patient_last) ` +
    `then 'exact' ` +
    `when lower(a.patient_last) = lower(b.patient_last) ` +
    `and a.payer_name = b.payer_name ` +
    `and a.member_id_norm is not null and a.member_id_norm <> '' ` +
    `and b.member_id_norm is not null and b.member_id_norm <> '' ` +
    `and a.member_id_norm <> b.member_id_norm ` +
    `then 'strong' ` +
    `when claims.similarity(a.patient_last, b.patient_last) >= 0.7 ` +
    `and a.payer_name = b.payer_name ` +
    `and (a.member_id_norm is null or a.member_id_norm = '' ` +
    `or b.member_id_norm is null or b.member_id_norm = '') ` +
    `then 'possible' ` +
    `end as confidence, ` +
    `a.facility_name as facility_name, ` +
    `a.payer_name as payer_name ` +
    `from f a ` +
    `join f b on a.id <> b.id ` +
    `and b.date_of_service > a.date_of_service ` +
    `and b.date_of_service <= a.date_of_service + ($1 * interval '1 day')` +
    `) ` +
    `select confidence, facility_name, payer_name from pairs where confidence is not null`
  );
}

export async function readmissionCandidates(
  args: ReadmissionCandidatesArgs,
  ctx: QueryContext,
): Promise<QueryResult<NoPhi<ReadmissionSummary>>> {
  const gapDays = validateGapDays(args.gap_days);
  const filter = validateClaimFilter({
    facility: args.facility,
    payer: args.payer,
    date_from: args.date_from,
    date_to: args.date_to,
  });

  // gap_days is $1; filter values follow from $2.
  const { clause, params: filterParams } = buildClaimFilter(filter, 2);
  const params: unknown[] = [gapDays, ...filterParams];

  const sql = readmissionCandidatesSql(clause);
  const { rows } = await ctx.executor.query<ReadmissionDbRow>(sql, params);

  const by_confidence: ReadmissionConfidenceCounts = { exact: 0, strong: 0, possible: 0 };
  const facilities = new Set<string>();
  const payers = new Set<string>();
  for (const r of rows) {
    by_confidence[r.confidence] += 1;
    facilities.add(r.facility_name);
    payers.add(r.payer_name);
  }

  const summary_stats: ReadmissionSummary = {
    candidate_pairs: rows.length,
    by_confidence,
    facilities: [...facilities].sort(),
    payers: [...payers].sort(),
  };

  const queryId = ctx.uuid?.() ?? randomUUID();
  return finalize<ReadmissionSummary>(ctx, {
    functionName: 'readmission_candidates',
    queryId,
    // All non-PHI: gap_days bound + the non-identity filter. Drives re-execution.
    args: { gap_days: gapDays, filter },
    auditShape: { filter_keys: Object.keys(filter), gap_days: gapDays },
    summaryStats: summary_stats,
    // Population scan — no single patient named, so no identity to bind.
    identityHash: null,
    resultRowCount: rows.length,
  });
}
