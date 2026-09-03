/**
 * GROUPED MODE — one row per (patient × payment date × facility × payer).
 *
 * Asked for as: *"if a 'charge from date' is multiple days, which has multiple charge lines, but all
 * on a payment that came in on a single day, are we able to condense the charge lines into a
 * grouping somehow?"*
 *
 * These are SQL-SHAPE tests (the suite is hermetic — no live DB). The arithmetic was verified
 * separately against production before shipping, and those results are recorded here because a
 * shape test cannot prove them:
 *   · CONSERVATION — grouped totals equal ungrouped totals to the cent for charge, allowed and
 *     insurance-paid, and sum(line_count) equals the raw row count. Held under a facility filter too.
 *   · PAGING — 5 pages in each direction, 250 rows, 250 distinct: no duplicates, no gaps.
 *   · 497,337 rollup rows collapse to 101,158 groups (4.92 lines per group); page 1 is ~820 ms.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCmdExplorerGroupedQuery,
  cmdExplorerGroupSortValue,
  type CmdExplorerGroupRow,
} from '../src/collections/cmdExplorerQuery.js';

const ENTITY = ['11111111-1111-1111-1111-111111111111'];
const build = (cursor: Parameters<typeof buildCmdExplorerGroupedQuery>[0] = null, dir: 'asc' | 'desc' = 'desc') =>
  buildCmdExplorerGroupedQuery(cursor, {}, dir, 50, ENTITY);

// ── 1. THE GROUP KEY ────────────────────────────────────────────────────────────────────────────
test('⚠ business_entity_id LEADS the group key — tenancy is structural, not incidental', () => {
  // Without it, Consolidated (the only cross-tenant view) could merge BXR and Indigo money into one
  // row: member_id_bidx is an HMAC under ONE key, so the same member id at both tenants yields the
  // same token. Measured 2026-08-18: 0 groups currently merge across tenants — but only because the
  // two tenants' facilities differ, which is a property of today's data, not a guarantee.
  const { sql } = build();
  assert.match(sql, /group by t\.business_entity_id, /);
});

test('⚠ a NULL member_id_bidx keys on the row id, so member-less rows can never merge', () => {
  // SQL GROUP BY treats NULLs as EQUAL. Without this, every member-less row sharing a payment date,
  // facility and payer would collapse into ONE row claiming to be a single patient — with a summed
  // total and a representative PHI-reveal id belonging to no one. Measured: 0 such rows exist today
  // (ingest rejects a charge with no member id), so this is insurance on a nullable column.
  const { sql } = build();
  assert.match(sql, /coalesce\(t\.member_id_bidx, 'id:' \|\| t\.id\)/);
});

test('the group key carries every UN-AGGREGATED displayed dimension', () => {
  // The rule that chose the key: a column displayed un-aggregated must be IN the key, or the cell
  // shows one of several values arbitrarily. facility and primary_payer are displayed AND are filter
  // dimensions, so omitting them would let a row claim a facility it only partly belongs to.
  // Measured cost of including them: 981 groups out of 101,158 — under 1%.
  const { sql } = build();
  assert.match(sql, /t\.payment_received, t\.facility, t\.primary_payer/);
});

test('it reads the ROLLUP, not the base table', () => {
  // The base table is snapshot-grain: grouping it would double-count every charge that was paid in
  // instalments. 0050/0059 exist precisely to collapse that.
  const { sql } = build();
  assert.match(sql, /from collections\.cmd_explorer_charge_rollup t/);
});

// ── 2. THE ARITHMETIC THAT COULD SILENTLY LIE ───────────────────────────────────────────────────
test('the two percentages are RECOMPUTED from the sums, never averaged', () => {
  // Averaging per-charge ratios would weight a $50 line like a $50,000 one and produce a number that
  // matches nothing on the page. The formulas must also mirror the matview's own — including the
  // *100 and the round(...,2) — or a grouped row and an ungrouped one disagree about the same money.
  const { sql } = build();
  assert.match(sql, /round\(sum\(t\.allowed_reliable\) \/ sum\(t\.charge_amount\) \* 100, 2\)/);
  assert.match(sql, /round\(sum\(t\.insurance_payments\) \/ sum\(t\.allowed_reliable\) \* 100, 2\)/);
  assert.doesNotMatch(sql, /avg\(/, 'an average of ratios is the wrong answer, not a rounding detail');
  // Division guards: the matview emits NULL rather than dividing by zero, and so must this.
  assert.match(sql, /case when sum\(t\.charge_amount\) > 0/);
  assert.match(sql, /case when sum\(t\.allowed_reliable\) > 0/);
});

test('allowed_amount sums allowed_RELIABLE — the column the grid actually displays', () => {
  // The rollup carries BOTH `allowed_amount` (netted) and `allowed_reliable`, and the grid shows the
  // latter aliased as the former. Summing the raw one would total a number no cell displays.
  const { sql } = build();
  assert.match(sql, /sum\(t\.allowed_reliable\) as allowed_amount/);
  assert.doesNotMatch(sql, /sum\(t\.allowed_amount\)/);
});

test('insurance_payments is SUMMED here, and that is correct', () => {
  // The rollup's rule is that insurance_payments is a charge-cumulative running total to be MAXed,
  // never summed — but that governs collapsing SNAPSHOTS OF ONE CHARGE, which the rollup already
  // did. This sums across DIFFERENT charges, each contributing its resolved final total. A MAX here
  // would report one charge's payment as the whole group's.
  const { sql } = build();
  assert.match(sql, /sum\(t\.insurance_payments\) as insurance_payments/);
  assert.doesNotMatch(sql, /max\(t\.insurance_payments\)/);
});

test('non-additive columns become facts about the group, not a picked value', () => {
  const { sql } = build();
  assert.match(sql, /min\(t\.charge_date\).*as charge_date/, 'the span starts at the earliest date');
  assert.match(sql, /max\(t\.charge_date\).*as charge_date_end/);
  assert.match(sql, /count\(\*\)::int as line_count/, 'the collapse is never invisible');
  // Uniform-or-null, NOT count(distinct): measured at 1.2s of a 2.1s page for information nobody
  // asked for. A group of 5 lines sharing one CPT still shows that CPT.
  // THREE states. SQL aggregates skip nulls, so min=max alone would claim ['99213', null] is
  // uniformly 99213, and an all-null group (min=max=NULL, and NULL=NULL is not true) would fall to
  // the ELSE and read as varying. Both misstate the group, in opposite directions.
  assert.match(sql, /count\(t\.cpt_code\) = count\(\*\) and min\(t\.cpt_code\) = max\(t\.cpt_code\)/);
  assert.match(sql, /as cpt_mixed/);
  assert.match(sql, /as revenue_mixed/);
  assert.doesNotMatch(sql, /count\(distinct/, 'dropped on measurement — see the builder');
});

// ── 3. THE KEYSET — the failure that would NOT be loud ──────────────────────────────────────────
test('the ordering is TOTAL, so a page boundary cannot drop or repeat a group', () => {
  // max(id) is unique per group (an id belongs to exactly one group), so (payment_received, max(id))
  // can never tie. A tie here would silently skip or duplicate rows while looking correct.
  const { sql } = build();
  assert.match(sql, /order by t\.payment_received desc nulls last, max\(t\.id\) desc limit/);
  // Re-stated on the OUTER query: the LEFT JOIN does not preserve the subquery's order, and the next
  // cursor is taken from the LAST row of the result set.
  assert.match(sql, /order by g\.payment_received desc nulls last, g\.id desc$/);
});

test('the cursor keyset lives in HAVING, with a WHERE prune beside it', () => {
  const { sql, params } = buildCmdExplorerGroupedQuery(
    { id: 42, value: '2026-08-01' }, {}, 'desc', 50, ENTITY,
  );
  // HAVING because it references max(t.id); payment_received is a grouping column so it is legal there.
  assert.match(sql, /having \(t\.payment_received < \$\d+::date or \(t\.payment_received = \$\d+::date and max\(t\.id\) < \$\d+\) or t\.payment_received is null\)/);
  // The prune runs BEFORE aggregation so paging deep does not re-aggregate the whole book.
  assert.match(sql, /\(t\.payment_received <= \$\d+::date or t\.payment_received is null\)/);
  assert.ok(params.includes('2026-08-01'), 'cursor value is BOUND, never interpolated');
  assert.ok(params.includes(42));
});

test('⚠ the NULL arms are present in BOTH the prune and the keyset', () => {
  // Under NULLS LAST a null payment_received sorts AFTER every real date, so those groups are still
  // ahead of a dated cursor. Drop either `is null` arm and the tail of the result set becomes
  // unreachable — pages just end early, with no error.
  const { sql } = buildCmdExplorerGroupedQuery({ id: 7, value: '2026-01-01' }, {}, 'desc', 50, ENTITY);
  assert.equal((sql.match(/t\.payment_received is null/g) ?? []).length, 2);
});

test('a NULL cursor value pages within the trailing NULL block only', () => {
  const { sql } = buildCmdExplorerGroupedQuery({ id: 9, value: null }, {}, 'desc', 50, ENTITY);
  assert.match(sql, /having \(t\.payment_received is null and max\(t\.id\) < \$\d+\)/);
  assert.doesNotMatch(sql, /payment_received <= /, 'no date prune when there is no date');
});

test('asc flips every comparison together', () => {
  const { sql } = buildCmdExplorerGroupedQuery({ id: 42, value: '2026-08-01' }, {}, 'asc', 50, ENTITY);
  assert.match(sql, /order by t\.payment_received asc nulls last, max\(t\.id\) asc/);
  assert.match(sql, /max\(t\.id\) > \$\d+/);
  assert.doesNotMatch(sql, /max\(t\.id\) < \$/, 'a mixed direction would page backwards forever');
});

// ── 4. Tenancy + injection ──────────────────────────────────────────────────────────────────────
test('tenant scope is bound, and every value is a parameter', () => {
  const { sql, params } = buildCmdExplorerGroupedQuery(null, { facility: ["x'; drop table--"] }, 'desc', 50, ENTITY);
  // ONE-id scope emits plain equality (the ordered-index fix, migration 0107); a 2+-id scope keeps
  // `= any($n::uuid[])`. Either way the tenant id is BOUND, never interpolated — which is what this
  // test is actually guarding.
  assert.match(sql, /business_entity_id = \$\d+::uuid/);
  assert.ok(params.includes(ENTITY[0] as string) || params.some((p) => Array.isArray(p) && p[0] === ENTITY[0]));
  assert.doesNotMatch(sql, /drop table/, 'filter values never reach the SQL text');
  assert.ok((params as unknown[]).some((p) => Array.isArray(p) && (p as string[])[0] === "x'; drop table--"));
});

test('the outer projection is EXPLICIT — no `select *` anywhere', () => {
  // Standing rule, and unconditional on purpose: with `g.*` the outer row shape would be whatever
  // the inner subquery happens to list, so adding a column inside it silently widens what crosses
  // the Server Action boundary. Naming them makes the shape a decision.
  const { sql } = build();
  assert.doesNotMatch(sql, /select \*/i);
  assert.doesNotMatch(sql, /\bg\.\*/, 'the outer projection must name its columns');
  // Every field of CmdExplorerGroupRow is present, so the type and the SQL cannot drift apart.
  for (const c of ['g.id', 'g.charge_date', 'g.charge_date_end', 'g.payment_received', 'g.line_count',
                   'g.cpt_code', 'g.cpt_mixed', 'g.revenue_code', 'g.revenue_mixed', 'g.facility',
                   'g.primary_payer', 'g.charge_amount', 'g.allowed_amount', 'g.insurance_payments',
                   'g.adjustments', 'g.patient_balance_due', 'g.pct_allowed', 'g.pct_paid']) {
    assert.ok(sql.includes(c), `${c} must be projected explicitly`);
  }
});

test('no PHI column is ever projected', () => {
  const { sql } = build();
  for (const c of ['patient_name', 'member_id_raw', 'group_number', 'member_id_bidx as', 'group_number_bidx']) {
    assert.ok(!sql.includes(`, ${c}`), `${c} must not be projected`);
  }
  // member_id_bidx appears ONLY inside the grouping key (wrapped in the null-safe coalesce) — an
  // HMAC token used to define the group, never projected back to the client.
  assert.match(sql, /coalesce\(t\.member_id_bidx/);
  assert.doesNotMatch(sql, /select[^;]*t\.member_id_bidx as/, 'never projected');
});

// ── 5. The cursor scalar ────────────────────────────────────────────────────────────────────────
test('cmdExplorerGroupSortValue reads the payment date, normalising undefined to null', () => {
  // The sort column is now a REQUIRED second argument — see the helper's docblock. Passing it
  // explicitly here is the point: a cursor scalar taken from a different column than the page was
  // ordered by produces a keyset that compares the wrong quantity and silently skips or repeats
  // groups at every boundary.
  const row = { payment_received: '2026-08-01' } as CmdExplorerGroupRow;
  assert.equal(cmdExplorerGroupSortValue(row, 'payment_received'), '2026-08-01');
  assert.equal(cmdExplorerGroupSortValue({} as CmdExplorerGroupRow, 'payment_received'), null);
  assert.equal(
    cmdExplorerGroupSortValue({ payment_received: null } as CmdExplorerGroupRow, 'payment_received'),
    null,
  );
});

test('cmdExplorerGroupSortValue reads the TOTAL under an aggregate sort, as a string', () => {
  const row = { payment_received: '2026-08-01', charge_amount: '83930.00' } as unknown as CmdExplorerGroupRow;
  // The same row yields a DIFFERENT scalar per ordering — which is the whole reason the column has
  // to be passed rather than inferred.
  assert.equal(cmdExplorerGroupSortValue(row, 'charge_amount'), '83930.00');
  assert.equal(cmdExplorerGroupSortValue(row, 'payment_received'), '2026-08-01');
  // Textual end to end: sum(numeric) can exceed exact double range, and this value becomes a
  // ::numeric bind param that decides page boundaries. A number must not be introduced here.
  assert.equal(typeof cmdExplorerGroupSortValue(row, 'charge_amount'), 'string');
  // A group whose every line had a null charge_amount sums to NULL — the trailing NULLS LAST block.
  assert.equal(
    cmdExplorerGroupSortValue({ charge_amount: null } as unknown as CmdExplorerGroupRow, 'charge_amount'),
    null,
  );
  assert.equal(cmdExplorerGroupSortValue({} as CmdExplorerGroupRow, 'charge_amount'), null);
});

// ── 6. AGGREGATE ORDERING — sort groups by their TOTAL, capped by window size ───────────────────
//
// Shipped 2026-09-03. As above these are SQL-SHAPE tests; the behaviour a shape test cannot prove
// was verified against production first and is recorded here:
//   · KEYSET CORRECTNESS — paged the full result set through the real cursor in BOTH directions,
//     on BXR (475 groups / 10 pages) and Consolidated (1,471 / 30): zero repeats, zero skips, order
//     identical to the same ordering taken unpaginated, and (total, id) monotonic across every page
//     boundary. That is the property the builder's docblock warns is silently violable.
//   · COST — the reason for the cap. Ordering by the payment date is index-served and stops early
//     (~708 rows, ~87 groups, 2.8 ms on BXR 90d); ordering by a sum cannot stop early and reads the
//     window (14,489 rows, 2,998 groups, 62 ms). Flat across page depth, linear in window size:
//     Consolidated measures 10 / 74 / 207 / 402 / 724 ms at 7d / 30d / 90d / 180d / 1y.
const buildAgg = (
  cursor: Parameters<typeof buildCmdExplorerGroupedQuery>[0] = null,
  dir: 'asc' | 'desc' = 'desc',
) => buildCmdExplorerGroupedQuery(cursor, {}, dir, 50, ENTITY, { groupedSort: 'charge_amount' });

test('the default ordering is UNCHANGED when no grouped sort is requested', () => {
  // Every pre-existing caller must keep the payment-date ordering it already had.
  const { sql } = build();
  assert.match(sql, /order by t\.payment_received desc nulls last, max\(t\.id\) desc/);
  assert.match(sql, /order by g\.payment_received desc nulls last, g\.id desc$/);
  assert.doesNotMatch(sql, /order by sum\(t\.charge_amount\)/, 'no aggregate ordering unless asked');
});

test('an aggregate sort orders BOTH the inner keyset and the outer projection by the total', () => {
  const { sql } = buildAgg();
  assert.match(sql, /order by sum\(t\.charge_amount\) desc nulls last, max\(t\.id\) desc limit/);
  // The outer ORDER BY must name the SAME column: the page is SELECTED by the inner ordering and
  // DISPLAYED by the outer one, so a mismatch would show 50 correct rows in the wrong order.
  assert.match(sql, /order by g\.charge_amount desc nulls last, g\.id desc$/);
  assert.doesNotMatch(sql, /order by t\.payment_received/, 'the date ordering is replaced, not kept');
});

test('direction flows through to both orderings', () => {
  const { sql } = buildAgg(null, 'asc');
  assert.match(sql, /order by sum\(t\.charge_amount\) asc nulls last, max\(t\.id\) asc limit/);
  assert.match(sql, /order by g\.charge_amount asc nulls last, g\.id asc$/);
});

test('⚠ the aggregate keyset lives in HAVING and emits NO pre-aggregation WHERE prune', () => {
  /*
   * THE LOAD-BEARING ASSERTION IN THIS FILE. The payment_received path pushes its cursor into the
   * WHERE clause as well, pruning charge lines before they are grouped — that is what keeps deep
   * paging cheap. Copying that onto the aggregate path is the obvious "optimisation" and it is
   * WRONG in a way that does not raise: it would filter individual CHARGE LINES by the cursor's
   * GROUP TOTAL, two different quantities. A group whose total clears the cursor can be built from
   * lines that individually do not, so rows would silently vanish out of groups and the totals on
   * screen would be understated — not merely mis-ordered.
   */
  const { sql } = buildAgg({ id: 900, value: '40000.00' });
  assert.match(sql, /having \(sum\(t\.charge_amount\) < \$\d+::numeric/, 'keyset compares the total');
  assert.match(sql, /or \(sum\(t\.charge_amount\) = \$\d+::numeric and max\(t\.id\) < \$\d+\)/, 'ties break on id');
  assert.match(sql, /or sum\(t\.charge_amount\) is null\)/, 'the trailing NULLS LAST block stays reachable');
  // The WHERE clause must not mention charge_amount at all.
  const where = sql.slice(sql.indexOf(' where '), sql.indexOf(' group by '));
  assert.doesNotMatch(where, /charge_amount/, 'NO charge_amount predicate before aggregation');
});

test('the cursor total is a BOUND PARAMETER, never interpolated', () => {
  const { sql, params } = buildAgg({ id: 7, value: "1'; drop table x--" });
  assert.doesNotMatch(sql, /drop table/, 'the value never reaches the SQL text');
  assert.ok(params.includes("1'; drop table x--"), 'it is bound instead');
  // Cast explicitly so a text bind compares as a number, not as a string.
  assert.match(sql, /::numeric/, 'the bound total is cast to numeric');
});

test('a NULL-total cursor selects only the trailing NULL block', () => {
  // Defensive symmetry with the payment_received path. Unreachable with today's data (0 of 505,423
  // charge lines have a null charge_amount) but the column is nullable — see the builder's note.
  const { sql } = buildAgg({ id: 12, value: null });
  assert.match(sql, /having \(sum\(t\.charge_amount\) is null and max\(t\.id\) < \$\d+\)/);
  assert.doesNotMatch(sql, /::numeric/, 'no total to compare against in the NULL block');
});

test('max(t.id) remains the tiebreaker, which is what keeps the ordering TOTAL', () => {
  // It matters MORE here than under the date sort: two groups can easily share a total, where
  // (payment_received, id) could never tie at all. Without a total order a page boundary may drop
  // or duplicate a group.
  const { sql } = buildAgg({ id: 5, value: '100.00' });
  assert.match(sql, /max\(t\.id\) < \$\d+/);
  assert.match(sql, /, max\(t\.id\) desc limit/);
});

test('the group key is untouched by the ordering change', () => {
  // Ordering must not silently re-grain the result: same five-part key as the date-ordered query.
  const grouping = /group by t\.business_entity_id, coalesce\(t\.member_id_bidx, 'id:' \|\| t\.id\), t\.payment_received, t\.facility, t\.primary_payer/;
  assert.match(build().sql, grouping);
  assert.match(buildAgg().sql, grouping);
});
