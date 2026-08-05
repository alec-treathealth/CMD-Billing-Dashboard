/**
 * Qualify v3 — the D2 resolution SQL. Candidate coverage groups, their claim evidence, and the
 * window ladder scoped to a CHOSEN group.
 *
 * ── THE RULES THIS FILE OBEYS, AND WHY EACH ONE IS HERE ─────────────────────────────────────────
 *
 * PARAMETERIZED ONLY. Every table, column and GUC name is a fixed string literal; only VALUES are
 * `$n` bound params. No `SELECT *` anywhere — columns are projected explicitly so a column added
 * upstream cannot silently start flowing into a payload.
 *
 * PHI: the handle is a BLIND INDEX TOKEN, never a raw identifier. Callers mint it via
 * `src/collections/blindIndex.ts`; this file only binds it. The only PHI-adjacent column projected is
 * `employer_norm`, for the display-only `employerLabel` — display to an authenticated principal was
 * ruled acceptable 2026-08-04, and R6 keeps it out of every URL. Nothing here projects a member id,
 * a patient name, a group number value, or any dollar amount that reaches a blind role.
 *
 * CROSS-TENANT BY RATIFIED DESIGN. There is no `business_entity_id` predicate in this file and that is
 * deliberate, not an omission: Qualify counts across BXR and Indigo together. `vob.member_benefits_latest`
 * carries no tenancy column at all. If a future change adds a single-entity WHERE here, that is a
 * deviation from ratified design — stop and say so.
 *
 * CONFIRMED ALIASES ONLY (R8). Every crosswalk join carries `and not m.needs_review`. 028 loaded 695
 * machine proposals into `ref.payer_alias_map`; a proposal may NEVER resolve a payer. This single
 * predicate is what makes the trust tier structural instead of a reporting convention — and it is why
 * D2's coverage is 60.0% of VOB members and not the 94.8% you get by counting proposals.
 *
 * SUPAVISOR: `pool.query(sql, params)` only — the transaction pooler forbids named prepared statements.
 */

export type QualifyHandleKind = 'prefix' | 'member_id';

/** The blind-index column each handle kind searches. Fixed literals, selected by an enum — never interpolated input. */
const HANDLE_COLUMN: Readonly<Record<QualifyHandleKind, { vob: string; rollup: string }>> = {
  prefix: { vob: 'member_id_prefix_bidx', rollup: 'member_id_prefix_bidx' },
  member_id: { vob: 'member_id_bidx', rollup: 'member_id_bidx' },
};

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * CANDIDATE COVERAGE GROUPS from the VOB side — the path D2 normally enters from.
 *
 * Grouped by (canonical payer, employer, funding, plan shape). That grain is the definition of a
 * coverage group and it is why the query cannot just return rows: 78.1% of members sit on a
 * multi-payer prefix, so a prefix legitimately produces SEVERAL groups and the user picks (§5b).
 * Collapsing them here would reintroduce the dominant-payer heuristic one layer deeper.
 *
 * A row whose `insurance_co` has no CONFIRMED alias still comes back, with `canonical_payer_id` NULL —
 * that is the UNMAPPED state (I8), and it must reach the UI as a visible candidate rather than being
 * filtered out into a silent miss.
 *
 * `group_on_file` is a PRESENCE boolean. The group number itself is PHI behind a blind index and is
 * never projected.
 */
export function buildCoverageCandidatesQuery(handleToken: string, kind: QualifyHandleKind): BuiltQuery {
  const col = HANDLE_COLUMN[kind].vob;
  const sql = `
    select
      m.canonical_payer_id                                   as canonical_payer_id,
      coalesce(pi.display_name, upper(btrim(v.insurance_co))) as payer_display_name,
      coalesce(m.relationship, 'unmapped')                    as payer_relationship,
      pi.administers_for                                      as administrator_id,
      adm.display_name                                        as administrator_name,
      v.employer_norm                                         as employer_label,
      v.funding                                               as funding,
      v.plan_type                                             as plan_type,
      v.policy_type                                           as policy_type,
      count(distinct v.member_id_bidx)::int                   as member_count,
      max(v.vob_created_at)::text                             as vob_fresh_as_of,
      bool_or(v.group_number_bidx is not null)                as group_on_file,
      bool_or(v.payer_id is not null and btrim(v.payer_id) <> '') as has_payer_id
    from vob.member_benefits_latest v
    left join ref.payer_alias_map m
      on m.vocabulary = 'vob_insurance_co'
     and m.alias_norm = upper(btrim(v.insurance_co))
     and not m.needs_review
    left join ref.payer_identity pi
      on pi.canonical_payer_id = m.canonical_payer_id
    left join ref.payer_identity adm
      on adm.canonical_payer_id = pi.administers_for
    where v.${col} = $1
    group by m.canonical_payer_id, coalesce(pi.display_name, upper(btrim(v.insurance_co))),
             coalesce(m.relationship, 'unmapped'), pi.administers_for, adm.display_name,
             v.employer_norm, v.funding, v.plan_type, v.policy_type
    order by count(distinct v.member_id_bidx) desc,
             coalesce(pi.display_name, upper(btrim(v.insurance_co))) asc`;
  return { sql, params: [handleToken] };
}

/**
 * CLAIMS-ONLY candidate groups — §3d as a first-class shape, not a fallback.
 *
 * 35% of members in claims have no VOB row, so for them the VOB query above returns nothing and the
 * screen would otherwise be empty while the member demonstrably has history. This returns one group
 * per CONFIRMED canonical payer seen in the rollup for the handle, with `employer`/`funding`/`plan`
 * necessarily null — claims carry no plan sponsor.
 *
 * The anti-join on `vob.member_benefits_latest` is what keeps this from double-counting members who
 * DO have a VOB row: those belong to a VOB group and must not appear twice as two "candidates" that
 * are the same coverage.
 */
export function buildClaimsOnlyCandidatesQuery(handleToken: string, kind: QualifyHandleKind): BuiltQuery {
  const col = HANDLE_COLUMN[kind].rollup;
  const sql = `
    select
      m.canonical_payer_id                                   as canonical_payer_id,
      coalesce(pi.display_name, upper(btrim(r.primary_payer))) as payer_display_name,
      coalesce(m.relationship, 'unmapped')                    as payer_relationship,
      count(distinct r.member_id_bidx)::int                   as member_count
    from collections.cmd_explorer_charge_rollup r
    left join ref.payer_alias_map m
      on m.vocabulary = 'claims_primary_payer'
     and m.alias_norm = upper(btrim(r.primary_payer))
     and not m.needs_review
    left join ref.payer_identity pi
      on pi.canonical_payer_id = m.canonical_payer_id
    where r.${col} = $1
      and nullif(btrim(r.primary_payer), '') is not null
      and not exists (
        select 1 from vob.member_benefits_latest v
         where v.member_id_bidx = r.member_id_bidx
      )
    group by m.canonical_payer_id, coalesce(pi.display_name, upper(btrim(r.primary_payer))),
             coalesce(m.relationship, 'unmapped')
    order by count(distinct r.member_id_bidx) desc`;
  return { sql, params: [handleToken] };
}

/**
 * CLAIM EVIDENCE for one chosen group, inside the resolved window.
 *
 * `canonicalPayerId` null means the group is UNMAPPED: there is no set of claims-side names that
 * provably belongs to it, so the honest evidence is ZERO ROWS rather than "all rows for this handle".
 * The caller renders that as unmapped (I8). Returning the handle's whole footprint here is exactly
 * the confidently-wrong answer the crosswalk exists to prevent — it would attribute another payer's
 * history to an unidentified one.
 *
 * `has_reliable_allowed` is a BOOLEAN over `allowed_tier`, never a dollar sum, so an
 * `admissions_seat` session derives the identical value (I4). `distinct_patients` equals
 * `distinct_members` today — the rollup has no patient token (0067 unapplied); see `ClaimEvidence`.
 */
export function buildGroupClaimEvidenceQuery(
  handleToken: string,
  kind: QualifyHandleKind,
  canonicalPayerId: string | null,
  from: string,
  to: string,
): BuiltQuery {
  const col = HANDLE_COLUMN[kind].rollup;
  if (canonicalPayerId === null) {
    // No canonical ⇒ no defensible row set. Return the zero shape without touching the rollup.
    return {
      sql: `select 0::int as distinct_members, 0::bigint as lines, 0::int as distinct_facilities,
                   0::int as distinct_patients, false as has_reliable_allowed`,
      params: [],
    };
  }
  const sql = `
    select
      count(distinct r.member_id_bidx)::int as distinct_members,
      count(*)::bigint                      as lines,
      count(distinct r.facility)::int        as distinct_facilities,
      count(distinct r.member_id_bidx)::int as distinct_patients,
      bool_or(r.allowed_tier is not null and r.allowed_tier <> 'e2') as has_reliable_allowed
    from collections.cmd_explorer_charge_rollup r
    where r.${col} = $1
      and r.charge_date >= $3::date
      and r.charge_date <  $4::date
      and upper(btrim(r.primary_payer)) in (
        select m.alias_norm
          from ref.payer_alias_map m
         where m.vocabulary = 'claims_primary_payer'
           and m.canonical_payer_id = $2
           and not m.needs_review
      )`;
  return { sql, params: [handleToken, canonicalPayerId, from, to] };
}

/**
 * PER-CANDIDATE evidence presence, for the WHOLE candidate set in ONE query.
 *
 * §S1 requires a candidate with no claim history to be marked BEFORE the user picks it, so they never
 * reach a ranking that turns out to be about nothing. That means evidence must be known for every
 * candidate, not just the chosen one — and one query per candidate would be N round trips on the
 * critical path of the first screen.
 *
 * Unmapped candidates (null canonical) are simply absent from the result; the caller treats absence as
 * "no evidence", which is the same answer `buildGroupClaimEvidenceQuery` gives them and for the same
 * reason (I8).
 */
export function buildCandidateEvidenceBatchQuery(
  handleToken: string,
  kind: QualifyHandleKind,
  canonicalIds: readonly string[],
  from: string,
  to: string,
): BuiltQuery {
  const col = HANDLE_COLUMN[kind].rollup;
  if (canonicalIds.length === 0) {
    return { sql: 'select null::text as canonical_payer_id, 0::bigint as lines where false', params: [] };
  }
  const sql = `
    select m.canonical_payer_id                as canonical_payer_id,
           count(*)::bigint                    as lines,
           count(distinct r.member_id_bidx)::int as members
      from collections.cmd_explorer_charge_rollup r
      join ref.payer_alias_map m
        on m.vocabulary = 'claims_primary_payer'
       and m.alias_norm = upper(btrim(r.primary_payer))
       and not m.needs_review
     where r.${col} = $1
       and m.canonical_payer_id = any($2::text[])
       and r.charge_date >= $3::date
       and r.charge_date <  $4::date
     group by m.canonical_payer_id`;
  return { sql, params: [handleToken, [...canonicalIds], from, to] };
}

/**
 * WINDOW LADDER rungs, scoped to THE CHOSEN GROUP.
 *
 * This is the §3f fix. v2's ladder counted `count(distinct member_id_bidx)` over EVERYONE sharing the
 * prefix across ALL payers — a third population, and the one that then silently re-windowed every
 * other panel. Here the payer predicate is the same CONFIRMED-alias set the evidence query uses, so
 * the rungs describe the population the user actually chose.
 *
 * One bucketed pass rather than N queries: each rung is a FILTER over the widest window, so the
 * planner reads the range once.
 */
export function buildGroupLadderQuery(
  handleToken: string,
  kind: QualifyHandleKind,
  canonicalPayerId: string | null,
  to: string,
  rungDays: readonly number[],
): BuiltQuery {
  const col = HANDLE_COLUMN[kind].rollup;
  const widest = Math.max(...rungDays);
  if (canonicalPayerId === null) {
    return {
      sql: rungDays
        .map((d, i) => `select ${d}::int as days, 0::int as members, 0::bigint as lines${i === 0 ? '' : ''}`)
        .join(' union all '),
      params: [],
    };
  }
  // Rung day-counts are numeric LITERALS derived from a caller-supplied number[] that is validated
  // below — never from a string. A non-finite or negative rung is rejected rather than interpolated.
  for (const d of rungDays) {
    if (!Number.isInteger(d) || d <= 0 || d > 3650) {
      throw new Error(`invalid ladder rung: ${String(d)} (must be a positive integer <= 3650)`);
    }
  }
  const buckets = rungDays
    .map(
      (d) =>
        `select ${d}::int as days,
                count(distinct r.member_id_bidx) filter (where r.charge_date >= ($2::date - ${d})) ::int as members,
                count(*) filter (where r.charge_date >= ($2::date - ${d})) ::bigint as lines
           from scoped r`,
    )
    .join(' union all ');
  const sql = `
    with scoped as (
      select r.member_id_bidx, r.charge_date
        from collections.cmd_explorer_charge_rollup r
       where r.${col} = $1
         and r.charge_date >= ($2::date - ${widest})
         and r.charge_date <  $2::date
         and upper(btrim(r.primary_payer)) in (
           select m.alias_norm
             from ref.payer_alias_map m
            where m.vocabulary = 'claims_primary_payer'
              and m.canonical_payer_id = $3
              and not m.needs_review
         )
    )
    ${buckets}
    order by days asc`;
  return { sql, params: [handleToken, to, canonicalPayerId] };
}

/**
 * A non-PHI digest identifying the row predicate. Two panels with the same id are provably about the
 * same rows.
 *
 * Deliberately NOT built from the handle token: that token is a blind index of PHI, and putting it in
 * a value the UI renders or logs would leak the searchable index. Built from the scope's SHAPE
 * instead — kind, canonical payer, window, group grain — which is exactly what "same predicate" means.
 */
export function predicateIdFor(input: {
  kind: QualifyHandleKind;
  canonicalPayerId: string | null;
  employerLabel: string | null;
  funding: string | null;
  planType: string | null;
  from: string;
  to: string;
}): string {
  const parts = [
    input.kind,
    input.canonicalPayerId ?? 'unmapped',
    input.employerLabel === null ? 'anyemp' : `emp${hash32(input.employerLabel)}`,
    input.funding ?? 'anyfund',
    input.planType ?? 'anyplan',
    input.from,
    input.to,
  ];
  return `p_${hash32(parts.join('|'))}`;
}

/**
 * FNV-1a 32-bit, hex. Used ONLY to shorten the non-PHI predicate shape into a comparable token, and
 * for the employer component it is applied to a value that never leaves the server in this form.
 * Not a security primitive and not used as one — see `CoverageGroup.employerKey` for why the
 * employer's OPAQUE key is positional rather than hashed.
 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
