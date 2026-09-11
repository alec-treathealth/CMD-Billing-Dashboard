/**
 * The `user` seat's facility entitlement (migration 0112) — the POLICY layer and the SQL shape.
 *
 * WHAT THIS FILE IS FOR. The entitlement has exactly one failure mode worth engineering against:
 * an empty grant being read as "no restriction" instead of "no access". It is a one-character
 * mistake (`!codes` instead of `codes === null`), it produces NO type error, and its symptom is a
 * restricted user quietly seeing the whole tenant — the opposite of the feature. Every assertion
 * below exists to pin that distinction somewhere it cannot silently invert.
 *
 * Hermetic: pure functions and emitted SQL strings only. No DB, no LLM, node:test only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { allowedFacilitiesFor, canRevealPhi, type Role } from '../lib/rbac';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../lib/views';
import {
  DENY_ALL_FACILITIES,
  UNRESTRICTED_FACILITIES,
  deniesEverything,
  facilityScopeParam,
  narrowByFacilityCode,
  scopedFacilities,
  type FacilityScope,
} from '../../src/collections/facilityScope';
import { cmdExplorerBaseConds } from '../../src/collections/cmdExplorerQuery';
import { collectionsMonthlySummarySql } from '../../src/collections/summary';
import { collectionsDailySql, collectionsKpisSql } from '../../src/collections/daily';
import { cmdPayerMonthSql } from '../../src/collections/cmdPayerRollup';
import { collectionsYoySql } from '../../src/collections/collectionsYoy';

// ---------------------------------------------------------------------------
// allowedFacilitiesFor — null vs [] in BOTH directions
// ---------------------------------------------------------------------------

test('facility scope: every NON-user role is UNRESTRICTED (null), whatever is stored', () => {
  // Even if grant rows somehow exist for them, they are not consulted: these roles are
  // whole-tenant or cross-tenant by definition.
  for (const role of ['super_admin', 'admin', 'admissions_seat'] as const) {
    assert.equal(allowedFacilitiesFor(role, null).kind, 'unrestricted', `${role}`);
    assert.equal(allowedFacilitiesFor(role, []).kind, 'unrestricted', `${role}`);
    assert.equal(allowedFacilitiesFor(role, ['NASH']).kind, 'unrestricted', `${role}`);
  }
});

test('facility scope: a `user` with grants is restricted to exactly those codes', () => {
  const scope = allowedFacilitiesFor('user', ['NASH', 'LSMH']);
  assert.equal(scope.kind, 'scoped');
  assert.deepEqual(facilityScopeParam(scope), ['NASH', 'LSMH']);
});

test('facility scope: a `user` with NO grants DENIES everything — never unrestricted', () => {
  // THE CENTRAL ASSERTION OF THIS FILE. Under the old `string[] | null` encoding this was the
  // one-character inversion that would hand the whole tenant to a seat provisioned with nothing.
  // The union makes that unrepresentable; this now pins the BEHAVIOUR the type guarantees.
  for (const stored of [[], null, undefined] as const) {
    const scope = allowedFacilitiesFor('user', stored);
    assert.equal(scope.kind, 'scoped', 'a user is never unrestricted');
    assert.ok(deniesEverything(scope), 'no grants must deny everything');
    // And at the SQL boundary it binds as an EMPTY ARRAY, not NULL: `= any('{}')` matches no row,
    // whereas NULL would short-circuit the predicate and return the whole tenant.
    assert.deepEqual(facilityScopeParam(scope), []);
  }
});

test('facility scope: the SQL boundary maps each state to the right bind value', () => {
  // The only place `string[] | null` still exists. Unrestricted MUST be null (predicate skipped);
  // deny-all MUST be [] (predicate matches nothing). Swapping these two inverts the feature.
  assert.equal(facilityScopeParam(UNRESTRICTED_FACILITIES), null);
  assert.deepEqual(facilityScopeParam(DENY_ALL_FACILITIES), []);
  assert.deepEqual(facilityScopeParam(scopedFacilities(['NASH'])), ['NASH']);
  // An omitted scope is unrestricted — the pre-0112 behaviour every non-`user` reader wants.
  assert.equal(facilityScopeParam(undefined), null);
});

test('facility scope: the codes are a frozen COPY — a caller cannot widen the entitlement', () => {
  const stored = ['NASH'];
  const got = allowedFacilitiesFor('user', stored);
  assert.equal(got.kind, 'scoped');
  if (got.kind !== 'scoped') return;
  // `got.codes` is readonly string[], so `.push` is a COMPILE error now — the runtime check below
  // is the belt to that braces, covering a plain-JS caller that ignores the types.
  assert.throws(() => (got.codes as string[]).push('LSMH'), 'the codes array is frozen');
  assert.deepEqual(stored, ['NASH'], 'mutating the result must not widen the stored grant');
});

// ---------------------------------------------------------------------------
// R5 — the `user` seat can reveal PHI
// ---------------------------------------------------------------------------

test('R5: `user` CAN reveal PHI — the facility grant is the whole restriction', () => {
  // Flipped 2026-09-10 (Alec). This test previously asserted the opposite; it is updated rather
  // than deleted, because "can a user reveal PHI" is exactly the question worth keeping pinned.
  assert.equal(canRevealPhi('user'), true);
});

test('R5: every other role keeps the PHI capability it already had', () => {
  for (const role of ['super_admin', 'admin', 'admissions_seat'] as Role[]) {
    assert.equal(canRevealPhi(role), true, `${role} still reveals PHI`);
  }
});

// ---------------------------------------------------------------------------
// The Overview aggregate SQL preserves null-vs-empty at the parameter level
// ---------------------------------------------------------------------------

test('aggregates: each reader guards the facility predicate with an IS NULL escape', () => {
  // `$n::text[] is null` is what makes an unrestricted read skip the predicate; without it, an
  // unrestricted caller passing NULL would match nothing and the dashboards would go blank.
  // `= any($n)` on an EMPTY array matches no row, which is the deny case — same expression, no
  // branch in the application. Both halves must be present in every one of these.
  for (const [name, sql] of [
    ['summary', collectionsMonthlySummarySql()],
    ['daily', collectionsDailySql()],
    ['kpis', collectionsKpisSql()],
  ] as const) {
    assert.match(sql, /::text\[\] is null or/, `${name} lost its unrestricted escape`);
    assert.match(sql, /facility_code = any\(\$\d+::text\[\]\)/, `${name} lost its narrowing`);
  }
});

test('aggregates: the ANCHOR CTEs are facility-scoped too, not just the outer query', () => {
  // Both anchors compute max(payment_date) and drive the default window / "as of" date. Scoping
  // only the outer query would anchor a restricted user on a deposit at a facility they cannot
  // see — a date with no row on screen to explain it.
  for (const [name, sql] of [
    ['daily', collectionsDailySql()],
    ['kpis', collectionsKpisSql()],
  ] as const) {
    const anchor = sql.slice(sql.indexOf('with anchor as ('), sql.indexOf(') select') + 1);
    assert.match(anchor, /::text\[\] is null or facility_code = any\(/, `${name} anchor unscoped`);
  }
});

// ---------------------------------------------------------------------------
// The Collections grid predicate
// ---------------------------------------------------------------------------

const SCOPE = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088'];

/** Collect the emitted conds with a throwaway param adder. */
function conds(entitled: FacilityScope | undefined): string[] {
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  return cmdExplorerBaseConds({}, SCOPE, add, { entitledFacilities: entitled });
}

test('grid: UNRESTRICTED (or absent) emits NO entitlement predicate at all', () => {
  for (const v of [UNRESTRICTED_FACILITIES, undefined]) {
    const out = conds(v).join(' and ');
    assert.doesNotMatch(out, /cmd_facility_resolution/, 'no entitlement predicate for unrestricted');
    assert.notEqual(out.includes('false'), true, 'unrestricted must not emit a deny');
  }
});

test('grid: an EMPTY grant emits a hard `false` — deny everything', () => {
  // The inverse of the trap: [] must not be treated as "no filter". A literal `false` also makes
  // the intent unmistakable when the SQL turns up in a log or an EXPLAIN.
  assert.ok(conds(DENY_ALL_FACILITIES).includes('false'), 'empty grant must deny');
});

test('grid: a non-empty grant narrows via BOTH the dimension and the alias crosswalk', () => {
  // The two sides speak different namespaces: rows carry CMD DISPLAY TEXT, the grant carries
  // CODES. A facility whose CMD spelling reaches the roster only through cmd_facility_aliases
  // (e.g. a trailing " LLC") must still resolve, or its rows silently vanish for a granted user.
  const out = conds(scopedFacilities(['NASH'])).join(' and ');
  assert.match(out, /collections\.facilities fe/, 'exact dimension-name path missing');
  assert.match(out, /collections\.cmd_facility_aliases a/, 'alias crosswalk path missing');
});

test('grid: R2 — a granted user sees 0086-RESOLVED charges but NOT the unattributed bucket', () => {
  const out = conds(scopedFacilities(['NASH'])).join(' and ');
  // Branch 2 present: charges the resolution engine attributes to a granted facility DO count.
  assert.match(out, /cmd_facility_resolution fr/, '0086-resolved charges must be included');
  // Branch 3 ABSENT: the entitlement must never admit rows still displaying the placeholder.
  // (`fr2` is the resolveFacility predicate's anti-set alias — its presence here would mean the
  // entitlement had grown a "show me the unattributed bucket" branch.)
  assert.doesNotMatch(out, /fr2/, 'the unattributed bucket must stay hidden (R2)');
});

test('grid: the entitlement is ADDITIONAL to the user-chosen facility filter, never a merge', () => {
  // Choosing a facility outside the grant must return nothing rather than escape the grant, so
  // both predicates have to be present and AND-ed.
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const out = cmdExplorerBaseConds({ facility: ['LONESTAR MENTAL HEALTH'] }, SCOPE, add, {
    resolveFacility: true,
    entitledFacilities: scopedFacilities(['NASH']),
  });
  const sql = out.join(' and ');
  // Bound as an ARRAY (`add(filter.facility)`), not as a scalar — checking for the bare string
  // here fails while the code is correct, which is how this assertion was first written.
  assert.ok(
    params.some((p) => Array.isArray(p) && p.includes('LONESTAR MENTAL HEALTH')),
    'the chosen filter must still be bound',
  );
  assert.ok(
    params.some((p) => Array.isArray(p) && p.includes('NASH')),
    'the entitlement must still be bound',
  );
  assert.match(sql, / and /, 'both predicates must be AND-ed');
});

// ---------------------------------------------------------------------------
// DENY-ALL, ON EVERY SURFACE (Alec's item 3 confirmation, 2026-09-10)
//
// A `user` with zero grants must see NOTHING — not "everything", which is what the old
// `string[] | null` encoding produced on a single-character slip. Six surfaces are in R1's scope,
// and each is asserted at the layer where the denial actually takes effect: the bind parameter for
// the SQL readers, the emitted predicate for the grid, and the returned list for the dropdown.
// ---------------------------------------------------------------------------

test('deny-all: the three Overview aggregate readers bind [] (matches nothing), not null', () => {
  // Surfaces 1-3: summary, daily, KPIs. All three take the scope on their context and bind it
  // through facilityScopeParam. `[]` makes `= any('{}')` false for every row; NULL would skip the
  // predicate entirely and return the whole tenant — the exact inversion being guarded.
  assert.deepEqual(facilityScopeParam(DENY_ALL_FACILITIES), []);
  // And the SQL each of them emits still carries the guarded predicate that gives `[]` its meaning.
  for (const [name, sql] of [
    ['summary', collectionsMonthlySummarySql()],
    ['daily', collectionsDailySql()],
    ['kpis', collectionsKpisSql()],
  ] as const) {
    assert.match(sql, /facility_code = any\(\$\d+::text\[\]\)/, `${name} lost its narrowing`);
  }
});

test('deny-all: the Collections grid emits a hard `false`', () => {
  // Surfaces 4-5: the row grid and the grouped/summary + cohort builders, which all share
  // cmdExplorerBaseConds — so one assertion covers every builder that reads the rollup.
  assert.ok(conds(DENY_ALL_FACILITIES).includes('false'), 'grid must deny');
});

test('deny-all: the facility dropdown returns an EMPTY list, not the full vocabulary', () => {
  // Surface 6. The vocabulary is cached per TENANT, so this narrowing happens after the cached
  // read — which is precisely where a `!scope` test would have leaked the whole tenant's list.
  const vocab = [
    { facility: 'NASHVILLE MENTAL HEALTH', facility_code: 'NASH' },
    { facility: 'LONESTAR MENTAL HEALTH', facility_code: 'LSMH' },
    { facility: 'No Facility', facility_code: null },
  ];
  assert.deepEqual(narrowByFacilityCode(vocab, DENY_ALL_FACILITIES), []);
  // A granted user sees only their own, and never the null-coded placeholder (R2).
  assert.deepEqual(
    narrowByFacilityCode(vocab, scopedFacilities(['NASH'])).map((f) => f.facility_code),
    ['NASH'],
  );
  // Unrestricted keeps everything, placeholder included.
  assert.equal(narrowByFacilityCode(vocab, UNRESTRICTED_FACILITIES).length, 3);
});

test('deny-all: an UNRESOLVED principal denies rather than falling through to unrestricted', () => {
  // viewFacilityScope returns DENY_ALL_FACILITIES when there is no principal — including the
  // no-auth staged-rollout fallback, which reports super_admin with a null user. "We could not
  // establish who you are" must never resolve to "see everything".
  assert.equal(DENY_ALL_FACILITIES.kind, 'scoped');
  assert.ok(deniesEverything(DENY_ALL_FACILITIES));
});

// ---------------------------------------------------------------------------
// THE CACHE KEY (Alec's item 2, 2026-09-10)
//
// VERIFIED against the installed Next source, not assumed
// (node_modules/next/dist/server/web/spec-extension/unstable-cache.js):
//     const fixedKey      = `${cb.toString()}-${keyParts.join(',')}`;   // L55
//     const invocationKey = `${fixedKey}-${JSON.stringify(args)}`;      // L82
//
// The key is the callback SOURCE + keyParts + JSON.stringify(ARGS). Two consequences:
//   · every argument keys the entry — "argument but unkeyed" is not representable in this API;
//   · a value that reaches the callback WITHOUT being an argument (resolved in the body, read from
//     module state, closed over) does NOT key it. That is the whole hazard.
//
// Unkeyed, a super_admin's UNRESTRICTED page is served from cache to a facility-scoped `user` at
// the same cursor: the grant defeated, every predicate still correct, no error, 15-minute lifetime.
// These assertions were demonstrated to FAIL against a deliberately mutated server.ts in which the
// scope was hoisted out of the args and resolved inside the callback.
// ---------------------------------------------------------------------------

const CACHED_WRAPPERS_WITH_SCOPE = [
  ['dashboardCollectionsSummary', "['dashboard-collections-summary']"],
  ['dashboardCollectionsKpis', "['dashboard-collections-kpis']"],
  ['dashboardCollectionsKpisOverview', "['dashboard-collections-kpis-overview']"],
  ['dashboardCollectionsDaily', "['dashboard-collections-daily']"],
  ['dashboardCollectionsDailyOverview', "['dashboard-collections-daily-overview']"],
  ['loadCmdExplorerNonPhi', "['cmd-explorer-nonphi']"],
  ['loadCmdExplorerGroupedNonPhi', "['cmd-explorer-grouped']"],
] as const;

test('cache key: every scope-bearing unstable_cache wrapper takes the scope as an ARGUMENT', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/server.ts'), 'utf8');
  for (const [name, keyParts] of CACHED_WRAPPERS_WITH_SCOPE) {
    const start = src.indexOf(`export const ${name} = unstable_cache`);
    assert.notEqual(start, -1, `${name} not found — was it renamed?`);
    const end = src.indexOf(keyParts, start);
    assert.notEqual(end, -1, `${name}'s keyParts not found — the slice would be wrong`);
    const body = src.slice(start, end);

    // 1. Declared parameter ⇒ it lands in JSON.stringify(args) ⇒ it varies the key.
    assert.match(
      body,
      /facilityScope:\s*FacilityScope|entitledFacilities:\s*FacilityScope/,
      `${name} must take the facility scope as a parameter`,
    );
    // 2. And must NOT resolve it itself — that path bypasses the key entirely.
    assert.doesNotMatch(
      body,
      /viewFacilityScope|dashboardAccess/,
      `${name} must not resolve the scope inside the cached callback`,
    );
  }
});

test('cache key: the two scope states serialize DIFFERENTLY, so they cannot share an entry', () => {
  // JSON.stringify(args) is the mechanism, so the states must be distinguishable AS JSON. Under the
  // old `string[] | null` encoding this held too — but `{kind}` makes it legible in a cache dump,
  // and makes an accidental `undefined` (which JSON.stringify DROPS) impossible to confuse with
  // unrestricted.
  const unrestricted = JSON.stringify([UNRESTRICTED_FACILITIES]);
  const denyAll = JSON.stringify([DENY_ALL_FACILITIES]);
  const scoped = JSON.stringify([scopedFacilities(['NASH'])]);
  assert.notEqual(unrestricted, denyAll, 'unrestricted and deny-all must not share a cache entry');
  assert.notEqual(scoped, unrestricted, 'a scoped user must not share an entry with a super_admin');
  assert.notEqual(scoped, denyAll);
  assert.notEqual(
    JSON.stringify([scopedFacilities(['NASH'])]),
    JSON.stringify([scopedFacilities(['LSMH'])]),
    'two different grants must not share an entry',
  );
});

// ---------------------------------------------------------------------------
// TENANT-ID PARITY: migration 0112 <-> app/lib/views.ts
//
// The definer resolves a grantee's tenant with two hardcoded uuids, because
// claims.app_user.entity is the slug 'bxr'/'indigo' and core.business_entity carries names and CMD
// account numbers, not slugs. Those uuids are FIXED, business-owner-confirmed constants that also
// live in app/lib/views.ts and src/tenants.ts (test/tenantIdParity.test.ts already locks that pair).
// This extends the same discipline to the SQL copy: three places, one value, drift caught by a test
// rather than by a cross-tenant grant slipping through the check.
// ---------------------------------------------------------------------------

test('parity: migration 0112 uses the SAME tenant uuids as app/lib/views.ts', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const sql = readFileSync(join(root, 'supabase/migrations/0112_app_user_facility.sql'), 'utf8');
  // Only the executable body — the header carries the same uuids inside the detection query, and
  // matching those would pass even if the CASE expression were wrong.
  const body = sql.slice(sql.indexOf('v_entity_id := case v_entity'));
  assert.match(
    body,
    new RegExp(`when 'bxr'\\s+then '${BXR_ENTITY_ID}'::uuid`),
    'the BXR uuid in the definer must match views.ts',
  );
  assert.match(
    body,
    new RegExp(`when 'indigo' then '${INDIGO_ENTITY_ID}'::uuid`),
    'the Indigo uuid in the definer must match views.ts',
  );
});

test('0112: the definer rejects a cross-tenant grant, and says which facility', () => {
  // The check itself is exercised for real against a Supabase BRANCH before apply (the role matrix
  // in the PR description). This asserts the SQL is actually present and shaped as intended, so a
  // later edit cannot quietly drop the tenant half and leave only the existence check.
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const sql = readFileSync(join(root, 'supabase/migrations/0112_app_user_facility.sql'), 'utf8');
  const body = sql.slice(sql.indexOf('create or replace function claims.set_app_user_facilities'));
  assert.match(body, /business_entity_id <> v_entity_id/, 'the tenant-coherence predicate is present');
  assert.match(body, /holds data in another tenant/, 'the rejection names the failure');
  // All three fact sources must be consulted — dropping one reopens the gap for codes that appear
  // only in that table.
  for (const src of [
    'collections.daily_collections_resolved',
    'claims.audit_row',
    'claims.ar_claim',
  ]) {
    assert.ok(body.includes(src), `${src} must be one of the checked fact sources`);
  }
});

// ---------------------------------------------------------------------------
// NO WRAPPER MAY MAKE THE SCOPE OPTIONAL OR DEFAULTED (Alec, 2026-09-11)
//
// The residual that follows from `invocationKey = ... + JSON.stringify(args)`:
//
//     JSON.stringify([undefined]) === '[null]'
//
// So an OMITTED argument serializes identically to an explicit null. Under the old
// `string[] | null` encoding that was "unrestricted" outright; under the union it would still
// collapse two distinct callers onto ONE cache entry. The union fixes the VALUE; only a required
// parameter fixes the OMISSION — a default (`= UNRESTRICTED_FACILITIES`) is exactly as dangerous,
// because it fails OPEN and silently.
//
// This asserts the property directly rather than trusting a one-time grep.
// ---------------------------------------------------------------------------

test('wrappers: JSON.stringify proves an omitted arg is indistinguishable from unrestricted', () => {
  // The mechanism, stated as an executable fact rather than a comment.
  assert.equal(JSON.stringify([undefined]), '[null]');
  assert.equal(JSON.stringify([null]), '[null]');
  // Which is why the parameter must be REQUIRED: these two callers must never key the same.
  assert.notEqual(JSON.stringify([UNRESTRICTED_FACILITIES]), JSON.stringify([undefined]));
});

test('wrappers: none of the seven takes the facility scope as optional or defaulted', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/server.ts'), 'utf8');
  for (const [name, keyParts] of CACHED_WRAPPERS_WITH_SCOPE) {
    const start = src.indexOf(`export const ${name} = unstable_cache`);
    const body = src.slice(start, src.indexOf(keyParts, start));
    // `?:` would let a caller omit it; `= ...` would substitute unrestricted on omission.
    assert.doesNotMatch(
      body,
      /(facilityScope|entitledFacilities)\s*\?\s*:/,
      `${name} must not make the facility scope optional`,
    );
    assert.doesNotMatch(
      body,
      /(facilityScope|entitledFacilities)\s*:\s*FacilityScope\s*=/,
      `${name} must not default the facility scope — a default fails OPEN`,
    );
  }
});

test('readers: the non-cached scope-bearing functions are not defaulted either', () => {
  // loadCmdExplorerPage / GroupedPage and both reveal readers sit BELOW the wrappers and are the
  // last thing between a caller and the rows. They carried `= UNRESTRICTED_FACILITIES` defaults
  // until 2026-09-11; a default there would let a future caller reach PHI unscoped by forgetting
  // an argument, with no type error.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/server.ts'), 'utf8');
  assert.doesNotMatch(
    src,
    /(facilityScope|entitledFacilities)\s*:\s*FacilityScope\s*=\s*UNRESTRICTED_FACILITIES/,
    'no scope parameter anywhere in server.ts may default to unrestricted',
  );
});

// ---------------------------------------------------------------------------
// THE TWO OVERVIEW READERS THAT WERE MISSED (Alec, 2026-09-11)
//
// R1 put "the Overview aggregates" in scope from the start. Three were narrowed (summary, daily,
// KPIs) and two were NOT, because I traced the surfaces I had already touched rather than the
// surfaces a `user` can REACH. Both are reachable: a role='user' with entity='bxr' loads
// /dashboard (nav-model BASE_LINKS includes Overview; the page gates only admissions_seat and an
// empty allowlist), and both Server Actions pass viewEntityScope for that principal.
//
//   · loadCmdPayerMonth  -> cmd_payer_facility_monthly, which returns a per-FACILITY breakdown
//     (`by_facility`). Tenant-gated, never facility-gated. The worst of the two: facility-grained
//     money for every facility in the tenant.
//   · loadCollectionsYoy -> payment_lines. Aggregate grain, not per-facility, but still whole-
//     tenant money on an Overview tile.
//
// Not in scope, and the distinction matters: loadPayerGapRange / loadPayerGapCmd return
// `by_payer` ONLY (no facility grain), and loadFacilityDimension returns roster reference data
// (code/name/care_setting). Those three carry a real PRE-EXISTING tenancy gap — no viewEntityScope
// at all — which is a different bug, filed rather than fixed here.
// ---------------------------------------------------------------------------

test('payer month: the per-facility breakdown is facility-narrowed via the name crosswalk', () => {
  const sql = cmdPayerMonthSql();
  assert.match(sql, /\$4::text\[\] is null or/, 'unrestricted escape missing');
  // The table stores facility_NAME, not facility_code, so the grant resolves through the same
  // two-path crosswalk the explorer uses. Measured 2026-09-11: 2,610/2,611 rows resolve (99.96%);
  // the only unresolvable value is 'No Facility', which R2 hides from a scoped user anyway.
  assert.match(sql, /collections\.facilities fe/, 'exact dimension-name path missing');
  assert.match(sql, /collections\.cmd_facility_aliases a/, 'alias crosswalk path missing');
});

test('payer month: the outer table is ALIASED so the crosswalk correlates correctly', () => {
  // collections.facilities ALSO has a `facility_name` column. An unqualified `facility_name`
  // inside the EXISTS would bind to the INNER relation, degrading the correlation to
  // `fe.facility_name = fe.facility_name` — always true, narrowing NOTHING, with no error.
  // The same trap cmdExplorerQuery's branch 3 documents for `id`.
  const sql = cmdPayerMonthSql();
  assert.match(sql, /from collections\.cmd_payer_facility_monthly m\b/, 'outer table must be aliased');
  assert.match(sql, /upper\(fe\.facility_name\) = upper\(m\.facility_name\)/, 'correlation must be qualified');
  assert.match(sql, /upper\(a\.facility_text\) = upper\(m\.facility_name\)/, 'correlation must be qualified');
});

test('yoy: payment_lines is facility-narrowed on its native facility_code', () => {
  const sql = collectionsYoySql();
  assert.match(sql, /\$6::text\[\] is null or facility_code = any\(\$6::text\[\]\)/, 'yoy unscoped');
});

test('yoy: the cached wrapper takes the scope as an ARGUMENT, so it keys the entry', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/server.ts'), 'utf8');
  const start = src.indexOf('export const dashboardCollectionsYoy = unstable_cache');
  const body = src.slice(start, src.indexOf("['dashboard-collections-yoy']", start));
  assert.match(body, /facilityScope:\s*FacilityScope/, 'yoy must take the scope as a parameter');
  assert.doesNotMatch(body, /viewFacilityScope|dashboardAccess/, 'must not resolve the scope inside the callback');
});
