/**
 * Facility Resolution query builders + search grammar. Locks, in order:
 *  1. every builder FAILS CLOSED on an empty/malformed entity scope (the R1 tenancy invariant);
 *  2. every builder binds values as $n and never interpolates a caller string into SQL;
 *  3. the search grammar is DETERMINISTIC: each token maps to exactly one chip kind, an
 *     unparseable token becomes an inert 'unmatched' chip, and nothing is ever guessed;
 *  4. the year-vs-amount rule (4-digit 1900..2100 is a year unless $-prefixed);
 *  5. "jul 2024" binds to ONE month chip (the year token is consumed, not double-counted);
 *  6. sort/cursor resolvers clamp to the allowlist rather than trusting client input;
 *  7. the member display token never exposes more than its documented prefix.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMemberUnresolvedKeysQuery,
  buildResolutionFacilityOptionsQuery,
  buildResolutionOverviewQuery,
  buildResolutionQueueQuery,
  memberDisplayToken,
  MEMBER_TOKEN_LENGTH,
  parseResolutionSearch,
  RESOLUTION_PAGE_SIZE,
  resolveResolutionCursor,
  resolveResolutionSort,
  type ResolutionChip,
} from '../src/collections/facilityResolutionQuery.js';
import {
  OWNED_CMD_CUSTOMERS,
  RETIRED_CMD_CUSTOMERS,
} from '../src/collections/cmdCustomers.js';
import { INDIGO_ENTITY_ID as INDIGO } from '../src/tenants.js';

const BXR = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

// --- 1. fail-closed tenancy ----------------------------------------------------

test('every builder throws on an empty entity scope (never reads all tenants)', () => {
  assert.throws(() => buildResolutionOverviewQuery([]), /entityIds required/);
  assert.throws(() => buildResolutionQueueQuery([], undefined, null, []), /entityIds required/);
  assert.throws(() => buildMemberUnresolvedKeysQuery([], ['abc']), /entityIds required/);
});

test('every builder throws on a non-UUID entity id', () => {
  assert.throws(() => buildResolutionOverviewQuery(['not-a-uuid']), /canonical business_entity_id/);
  assert.throws(() => buildResolutionQueueQuery([], undefined, null, ['x']), /canonical business_entity_id/);
});

test('the queue query always pins business_entity_id, even with no chips', () => {
  const { sql, params } = buildResolutionQueueQuery([], undefined, null, [BXR]);
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(params[0], [BXR]);
});

// --- 2. parameterization -------------------------------------------------------

test('a facility term is bound as a parameter, never interpolated', () => {
  const chip: ResolutionChip = { kind: 'facility', term: "o'brien%_", label: 'x' };
  const { sql, params } = buildResolutionQueueQuery([chip], undefined, null, [BXR]);
  assert.ok(!sql.includes("o'brien"), 'the raw term must not appear in the SQL text');
  // LIKE metacharacters in the term are escaped so they cannot widen the match
  assert.ok(params.some((p) => typeof p === 'string' && p.includes('\\%') && p.includes('\\_')));
});

test('a member prefix is bound and LIKE-escaped', () => {
  const chip: ResolutionChip = { kind: 'member', prefix: 'ab%cd', label: 'x' };
  const { sql, params } = buildResolutionQueueQuery([chip], undefined, null, [BXR]);
  assert.ok(!sql.includes('ab%cd'));
  assert.ok(params.includes('ab\\%cd%'));
});

test('the page query over-fetches exactly one row to detect hasMore', () => {
  const { sql } = buildResolutionQueueQuery([], undefined, null, [BXR]);
  assert.match(sql, new RegExp(`limit ${RESOLUTION_PAGE_SIZE + 1}$`));
});

test('the projection is an explicit allowlist — never SELECT *', () => {
  const { sql } = buildResolutionQueueQuery([], undefined, null, [BXR]);
  assert.ok(!sql.includes('select *'));
  assert.match(sql, /select id, business_entity_id::text/);
});

// --- 3-5. the search grammar ----------------------------------------------------

const kinds = (input: string): string[] => parseResolutionSearch(input).chips.map((c) => c.kind);

test('an empty search yields no chips', () => {
  assert.deepEqual(parseResolutionSearch('   ').chips, []);
});

test('comparators, ranges and exact amounts each map to one amount chip', () => {
  assert.deepEqual(kinds('>5000'), ['amount']);
  assert.deepEqual(kinds('<=250.50'), ['amount']);
  assert.deepEqual(kinds('1200-4000'), ['amount_range']);
  assert.deepEqual(kinds('$1200'), ['amount']);
  const [chip] = parseResolutionSearch('>=99.99').chips;
  assert.equal(chip?.kind === 'amount' && chip.op, '>=');
  assert.equal(chip?.kind === 'amount' && chip.value, '99.99');
});

test('an inverted range is UNMATCHED, not silently reordered', () => {
  assert.deepEqual(kinds('4000-1200'), ['unmatched']);
});

test('a bare 4-digit 1900..2100 is a year; the same number with $ is an amount', () => {
  assert.deepEqual(kinds('2024'), ['year']);
  assert.deepEqual(kinds('$2024'), ['amount']);
  assert.deepEqual(kinds('5000'), ['amount'], 'out of the year range → amount');
});

test('"jul 2024" is ONE month chip carrying the year (the year token is consumed)', () => {
  const { chips } = parseResolutionSearch('jul 2024');
  assert.equal(chips.length, 1);
  assert.equal(chips[0]?.kind, 'month');
  assert.equal(chips[0]?.kind === 'month' && chips[0].year, 2024);
  assert.equal(chips[0]?.kind === 'month' && chips[0].month, 7);
});

test('a bare month name matches any year; YYYY-MM pins the month', () => {
  const bare = parseResolutionSearch('march').chips[0];
  assert.equal(bare?.kind === 'month' && bare.year, null);
  const pinned = parseResolutionSearch('2024-03').chips[0];
  assert.equal(pinned?.kind === 'month' && pinned.year, 2024);
  assert.equal(pinned?.kind === 'month' && pinned.month, 3);
});

test('an ambiguous month prefix does not match a month (it falls through, never guesses)', () => {
  // 'ma' is under the 3-char floor AND ambiguous (march/may) — it must not become a month chip
  assert.ok(!kinds('ma').includes('month'));
});

test('YYYY-MM wins over the range rule (2024-03 is a month, not the range 2024..3)', () => {
  // Regression: the range pattern also matches '2024-03'; reading it as a range inverted it into
  // an unmatched chip, so a perfectly ordinary month search silently filtered nothing.
  assert.deepEqual(kinds('2024-03'), ['month']);
});

test('a YYYY-MM-shaped token with an impossible month falls through, and ends UNMATCHED', () => {
  // It re-enters the range rule (deliberately — see the parser comment), where lo=2024 > hi=13
  // makes it an inverted range. Either way the outcome is the honest one: not applied.
  assert.deepEqual(kinds('2024-13'), ['unmatched']);
  assert.deepEqual(kinds('2000-50'), ['unmatched']);
});

test('methods resolve on a unique prefix of >=3 chars; an ambiguous prefix does not', () => {
  const m = parseResolutionSearch('unres').chips[0];
  assert.equal(m?.kind === 'method' && m.method, 'unresolved');
  const tie = parseResolutionSearch('tie_break').chips[0];
  assert.equal(tie?.kind === 'method' && tie.method, 'tie_break');
  // 'm' prefixes both manual and member_inference — must NOT resolve to either
  const ambiguous = parseResolutionSearch('man').chips[0];
  assert.equal(ambiguous?.kind === 'method' && ambiguous.method, 'manual', 'man → manual only');
  assert.ok(!kinds('me').includes('method'), 'a 2-char token is below the prefix floor');
});

test('era tokens are exact', () => {
  assert.deepEqual(kinds('seed'), ['era']);
  assert.deepEqual(kinds('cron'), ['era']);
});

test('a member display token and a bare long hex both become member chips', () => {
  assert.deepEqual(kinds('M-a1b2c3d4e5'), ['member']);
  assert.deepEqual(kinds('a1b2c3d4e5f6'), ['member']);
});

test('a quoted phrase is one facility chip, preserved verbatim', () => {
  const { chips } = parseResolutionSearch('"mental health"');
  assert.equal(chips.length, 1);
  assert.equal(chips[0]?.kind === 'facility' && chips[0].term, 'mental health');
});

test('unparseable noise is surfaced as an unmatched chip and NEVER applied', () => {
  const parsed = parseResolutionSearch('?? >>> 7');
  assert.ok(parsed.chips.some((c) => c.kind === 'unmatched'));
  assert.ok(!parsed.applied.some((c) => c.kind === 'unmatched'));
});

test('a word with letters IS a facility term (that is the documented fallback, not a guess)', () => {
  assert.deepEqual(kinds('zzz???'), ['facility']);
});

test('unmatched chips are excluded from the query, so they cannot filter anything', () => {
  const parsed = parseResolutionSearch('??? >>>');
  assert.ok(parsed.chips.length > 0 && parsed.chips.every((c) => c.kind === 'unmatched'));
  const { params } = buildResolutionQueueQuery(parsed.applied, undefined, null, [BXR]);
  assert.equal(params.length, 1, 'only the entity scope is bound');
});

test('the chip count is bounded (a pathological input cannot explode the WHERE clause)', () => {
  const many = Array.from({ length: 60 }, (_, i) => `>${i + 100}`).join(' ');
  assert.ok(parseResolutionSearch(many).chips.length <= 12);
});

// --- 6. sort + cursor clamping ---------------------------------------------------

test('an unknown sort column falls back to the default instead of reaching SQL', () => {
  const s = resolveResolutionSort({ column: 'facility_alias; drop table' as never, direction: 'asc' });
  assert.deepEqual(s, { column: 'charge_date', direction: 'desc' });
  const { sql } = buildResolutionQueueQuery([], { column: 'x' as never, direction: 'asc' }, null, [BXR]);
  assert.ok(!sql.includes('drop table'));
  assert.match(sql, /order by charge_date desc nulls last, id desc/);
});

test('a malformed cursor is treated as the first page', () => {
  assert.equal(resolveResolutionCursor({ id: 0, value: 'x' }), null);
  assert.equal(resolveResolutionCursor({ id: 1.5, value: 'x' }), null);
  assert.deepEqual(resolveResolutionCursor({ id: 7, value: null }), { id: 7, value: null });
});

test('a null-valued cursor continues inside the NULLS-LAST block', () => {
  const { sql } = buildResolutionQueueQuery([], undefined, { id: 42, value: null }, [BXR]);
  assert.match(sql, /charge_date is null and id < \$\d+/);
});

// --- 7. bounds + PHI shape --------------------------------------------------------

test('member expansion is bounded to 1..50 members', () => {
  assert.throws(() => buildMemberUnresolvedKeysQuery([BXR], []), /1\.\.50 members/);
  assert.throws(
    () => buildMemberUnresolvedKeysQuery([BXR], Array.from({ length: 51 }, (_, i) => `m${i}`)),
    /1\.\.50 members/,
  );
});

test('member expansion only ever returns UNRESOLVED charges', () => {
  const { sql } = buildMemberUnresolvedKeysQuery([BXR], ['abc']);
  assert.match(sql, /method = 'unresolved'/);
});

test('the facility options builder is bounded', () => {
  assert.throws(() => buildResolutionFacilityOptionsQuery([]), /1\.\.100 roster codes/);
  const { sql, params } = buildResolutionFacilityOptionsQuery(['CAMH']);
  assert.match(sql, /facility_code = any\(\$1::text\[\]\)/);
  assert.deepEqual(params[0], ['CAMH']);
});

// --- the assignment picker's allowlist (loadResolutionFacilityOptions feeds this builder) ------
// That function's result IS the roster-containment gate in app/lib/facility-resolution-actions.ts
// ("That facility is not on this book's roster"), so what it may contain is security-relevant and
// what it must not exceed is a hard throw. Both were untested.

test('the OWNED code set both books together stays inside the builder bound', () => {
  // Consolidated resolves to both tenants, so the picker sends every owned code in one call. The
  // builder throws above 100 and each retirement adds one, so this is the tripwire for that drift.
  const all = OWNED_CMD_CUSTOMERS.map((c) => c.facilityCode);
  assert.ok(all.length >= 1 && all.length <= 100, `owned codes must be 1..100, got ${all.length}`);
  assert.doesNotThrow(() => buildResolutionFacilityOptionsQuery(all));
});

test('a RETIRED facility stays assignable — an assignment is about the past', () => {
  // Deliberately the opposite of the forecast create path: a historical charge genuinely belongs to
  // the facility that incurred it, so the allowlist must still accept a retired code. Narrowing
  // this to the polling roster would make a legitimate in-book assignment fail as "not on this
  // book's roster".
  const retired = RETIRED_CMD_CUSTOMERS[0]!;
  const indigoOwned = OWNED_CMD_CUSTOMERS.filter((c) => c.businessEntityId === INDIGO)
    .map((c) => c.facilityCode);
  assert.ok(indigoOwned.includes(retired.facilityCode), 'retired code must reach the picker');
  const { params } = buildResolutionFacilityOptionsQuery(indigoOwned);
  assert.ok((params[0] as string[]).includes(retired.facilityCode));
});

test('the member display token exposes only its documented prefix', () => {
  const bidx = 'a'.repeat(64);
  const token = memberDisplayToken(bidx);
  assert.equal(token, `M-${'a'.repeat(MEMBER_TOKEN_LENGTH)}`);
  assert.equal(token.length, MEMBER_TOKEN_LENGTH + 2);
});
