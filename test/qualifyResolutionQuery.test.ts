/**
 * Qualify v3 D2 — the query layer's invariants (I1 source-level, plus PHI and scoping discipline).
 *
 * Written BEFORE the resolution service that consumes these builders, per §9. Every assertion here
 * corresponds to a failure that has already shipped at least once on this surface.
 *
 * I1's source scan walks the filesystem rather than shelling out to grep: no shell means no injection
 * shape and no platform dependency, and the test stays hermetic.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  buildCandidateEvidenceBatchQuery,
  buildCoverageCandidatesQuery,
  buildClaimsOnlyCandidatesQuery,
  buildGroupClaimEvidenceQuery,
  buildGroupClaimsLabelsQuery,
  buildGroupLadderQuery,
  predicateIdFor,
} from '../src/collections/qualifyResolutionQuery.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

/** Every .ts/.tsx file under a repo-relative directory, as {path, text}. Skips build output. */
function sourceFiles(relDir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const child = join(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      out.push({ path: relative(REPO, child), text: readFileSync(child, 'utf8') });
    }
  };
  walk(join(REPO, relDir));
  return out;
}

const TOKEN = 'bidx_abc123';

// ── I1 — no panel builds its own predicate ───────────────────────────────────────────────────────

test('I1: nothing under app/components/qualify/** imports a query builder', () => {
  // The structural half of I1. A component that can reach a query builder can invent a population,
  // which is how v2 ended up with four panels describing four different populations on one screen.
  // URL-state helpers (buildQualifySearchParams) are NOT query builders and are allowed.
  const banned = ['qualifyQuery', 'qualifyResolutionQuery', 'qualifyPolicyQuery', 'CmdExplorerFilter'];
  const offenders: string[] = [];
  for (const f of sourceFiles('app/components/qualify')) {
    for (const b of banned) {
      if (f.text.includes(b)) offenders.push(`${f.path} → ${b}`);
    }
  }
  assert.deepEqual(offenders, [], `a qualify component reaches a query builder:\n${offenders.join('\n')}`);
});

test('I1: the resolution query module is only reached through the resolution service', () => {
  const allowed = new Set([
    'src/collections/qualifyResolutionQuery.ts', // itself
    'app/lib/qualify/resolutionService.ts',
    'test/qualifyResolutionQuery.test.ts',
  ]);
  const offenders: string[] = [];
  for (const dir of ['app/lib', 'app/components', 'src', 'test']) {
    for (const f of sourceFiles(dir)) {
      if (!f.text.includes('qualifyResolutionQuery')) continue;
      if (!allowed.has(f.path)) offenders.push(f.path);
    }
  }
  assert.deepEqual(offenders, [], `unexpected importer(s) of the D2 query module: ${offenders.join(', ')}`);
});

// ── Parameterization + no SELECT * ───────────────────────────────────────────────────────────────

test('every builder binds VALUES only — no interpolated identifier, no SELECT *', () => {
  const builds = [
    buildCoverageCandidatesQuery(TOKEN, 'prefix'),
    buildCoverageCandidatesQuery(TOKEN, 'member_id'),
    buildClaimsOnlyCandidatesQuery(TOKEN, 'prefix'),
    buildGroupClaimEvidenceQuery(TOKEN, 'prefix', 'pi_cigna', '2026-01-01', '2026-02-01'),
    buildGroupClaimsLabelsQuery(TOKEN, 'prefix', 'pi_cigna', '2026-01-01', '2026-02-01'),
    buildGroupLadderQuery(TOKEN, 'prefix', 'pi_cigna', '2026-02-01', [30, 60, 90]),
  ];
  for (const b of builds) {
    assert.ok(!/select\s+\*/i.test(b.sql), 'no SELECT *');
    assert.ok(!b.sql.includes(TOKEN), 'the handle token must not appear in the SQL text');
    assert.ok(b.params.includes(TOKEN), 'the handle token must be a bound parameter');
  }
});

test('the handle column is chosen by enum — prefix and member_id hit DIFFERENT blind indexes', () => {
  const p = buildCoverageCandidatesQuery(TOKEN, 'prefix');
  const m = buildCoverageCandidatesQuery(TOKEN, 'member_id');
  assert.ok(p.sql.includes('v.member_id_prefix_bidx = $1'), 'prefix searches the prefix index');
  assert.ok(m.sql.includes('v.member_id_bidx = $1'), 'member_id searches the exact index');
  assert.ok(!p.sql.includes('v.member_id_bidx = $1'), 'prefix must not also hit the exact index');
});

// ── PHI ──────────────────────────────────────────────────────────────────────────────────────────

test('no builder projects a raw identifier, a patient name, or a group-number VALUE', () => {
  const sqls = [
    buildCoverageCandidatesQuery(TOKEN, 'prefix').sql,
    buildClaimsOnlyCandidatesQuery(TOKEN, 'member_id').sql,
    buildGroupClaimEvidenceQuery(TOKEN, 'prefix', 'pi_cigna', '2026-01-01', '2026-02-01').sql,
    buildGroupLadderQuery(TOKEN, 'prefix', 'pi_cigna', '2026-02-01', [30, 90]).sql,
  ];
  for (const sql of sqls) {
    // A blind-index column may be COUNTED or COMPARED — its value is a token. What must never appear
    // is a raw PHI column name.
    for (const banned of ['patient_name', 'member_id_enc', 'subscriber', 'dob', 'ssn']) {
      assert.ok(!sql.includes(banned), `SQL references a PHI column: ${banned}`);
    }
    if (sql.includes('group_number_bidx')) {
      assert.ok(
        /bool_or\(v\.group_number_bidx is not null\)/.test(sql),
        'group_number_bidx may only be reduced to a presence boolean',
      );
    }
  }
});

test('claim evidence is a BOOLEAN about allowed data, never a dollar sum (I4 precondition)', () => {
  const { sql } = buildGroupClaimEvidenceQuery(TOKEN, 'prefix', 'pi_cigna', '2026-01-01', '2026-02-01');
  for (const banned of [
    'sum(',
    'avg(',
    'charge_amount',
    'allowed_amount',
    'insurance_payments',
    'patient_balance_due',
  ]) {
    assert.ok(!sql.includes(banned), `evidence query touches a dollar field: ${banned}`);
  }
  assert.ok(sql.includes('bool_or(r.allowed_tier'), 'allowed reliability is a boolean over the tier');
});

// ── R8 — CONFIRMED aliases only ──────────────────────────────────────────────────────────────────

test('R8: every crosswalk reference excludes needs_review — a PROPOSAL may never resolve a payer', () => {
  // 028 loaded 695 machine proposals. If any of these forgets `not needs_review`, an unreviewed guess
  // starts resolving payers and the trust tier becomes a reporting convention, not a structural fact.
  const src = read('src/collections/qualifyResolutionQuery.ts');
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
  const refs = code.split('payer_alias_map').slice(1);
  assert.ok(refs.length >= 4, `expected >=4 payer_alias_map references in code, found ${refs.length}`);
  for (const [i, tail] of refs.entries()) {
    // The guard must appear within the same clause — before the next join/from/closing paren.
    const clause = tail.split(/\n\s*(?:left join|from|group by|order by|\))/)[0] ?? tail;
    assert.ok(
      /not\s+m\.needs_review/.test(clause),
      `payer_alias_map reference #${i + 1} lacks the needs_review guard:\n${clause.slice(0, 300)}`,
    );
  }
});

// ── Cross-tenant by ratified design ──────────────────────────────────────────────────────────────

test('no builder scopes to a single business_entity_id — Qualify is cross-tenant by design', () => {
  const src = read('src/collections/qualifyResolutionQuery.ts');
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(
    !/business_entity_id\s*=/.test(code),
    'a single-entity predicate appeared in the D2 query layer — that is a deviation from ratified design',
  );
});

// ── I8 — unmapped renders as unmapped, never as a match ──────────────────────────────────────────

test('I8: a null canonical payer yields ZERO evidence, not the handle footprint', () => {
  const b = buildGroupClaimEvidenceQuery(TOKEN, 'prefix', null, '2026-01-01', '2026-02-01');
  assert.ok(!b.sql.includes('cmd_explorer_charge_rollup'), 'an unmapped group must not read the rollup at all');
  assert.deepEqual(b.params, [], 'and binds nothing');
  assert.ok(/0::int as distinct_members/.test(b.sql), 'it returns the explicit zero shape');
  assert.ok(/false as has_reliable_allowed/.test(b.sql));
});

test('I8: an unmapped ladder returns zero rungs rather than an unscoped count', () => {
  const b = buildGroupLadderQuery(TOKEN, 'prefix', null, '2026-02-01', [30, 60, 90]);
  assert.ok(!b.sql.includes('cmd_explorer_charge_rollup'));
  assert.equal((b.sql.match(/0::int as members/g) ?? []).length, 3, 'one zero rung per requested rung');
});

// ── The ladder is group-scoped (the §3f defect) ──────────────────────────────────────────────────

test('the ladder counts THE CHOSEN GROUP, not everyone sharing the prefix', () => {
  const { sql, params } = buildGroupLadderQuery(TOKEN, 'prefix', 'pi_cigna', '2026-02-01', [30, 90]);
  assert.ok(sql.includes('canonical_payer_id = $3'), 'the payer predicate is present and bound');
  assert.ok(params.includes('pi_cigna'));
  assert.ok(/not\s+m\.needs_review/.test(sql), 'and it is CONFIRMED-only');
});

test('ladder rungs are validated, never interpolated from unchecked input', () => {
  // Both branches. The unmapped (null canonical) branch used to sit ABOVE the validation loop and
  // therefore interpolated rung widths unchecked — unreachable via today's only caller, but
  // "unreachable" is a property of the callers, not of this function. Found in review.
  for (const canonical of ['pi_cigna', null] as const) {
    for (const bad of [0, -30, 1.5, 4000, Number.NaN]) {
      assert.throws(
        () => buildGroupLadderQuery(TOKEN, 'prefix', canonical, '2026-02-01', [bad]),
        /invalid ladder rung/,
        `rung ${String(bad)} must be rejected for canonical=${String(canonical)}`,
      );
    }
  }
});

test('the empty-batch evidence query returns the FULL row shape, not a subset', () => {
  // A zero-row query that omits a column the caller's row type declares is a lie that happens to be
  // unobservable. Found in review.
  const { sql } = buildCandidateEvidenceBatchQuery(TOKEN, 'prefix', [], '2026-01-01', '2026-02-01');
  for (const col of ['canonical_payer_id', 'lines', 'members']) {
    assert.ok(sql.includes(`as ${col}`), `the empty shape must still declare ${col}`);
  }
  assert.match(sql, /where false/, 'and return no rows');
});

// ── predicateId ──────────────────────────────────────────────────────────────────────────────────

test('predicateId is stable, non-PHI, and distinguishes populations that differ', () => {
  const base = {
    kind: 'prefix' as const,
    canonicalPayerId: 'pi_cigna',
    employerLabel: 'SOUTHWEST AIRLINES',
    funding: 'Self-Funded',
    planType: 'PPO',
    from: '2026-01-01',
    to: '2026-02-01',
  };
  const a = predicateIdFor(base);
  assert.equal(a, predicateIdFor({ ...base }), 'same shape ⇒ same id');
  assert.notEqual(a, predicateIdFor({ ...base, from: '2025-01-01' }), 'a different window is a different population');
  assert.notEqual(a, predicateIdFor({ ...base, canonicalPayerId: 'pi_aetna' }), 'a different payer likewise');
  assert.notEqual(a, predicateIdFor({ ...base, employerLabel: null }), 'employer-narrowed vs not likewise');
  assert.ok(!a.includes('SOUTHWEST'), 'predicateId must not embed the employer label');
  assert.match(a, /^p_[0-9a-f]{8}$/, 'and is an opaque fixed-width token');
});

test('predicateId never embeds the blind-index token', () => {
  // The token is a searchable index OF PHI. Putting it in a rendered value would leak the index
  // itself, which is worse than leaking one lookup.
  const id = predicateIdFor({
    kind: 'member_id',
    canonicalPayerId: 'pi_cigna',
    employerLabel: null,
    funding: null,
    planType: null,
    from: '2026-01-01',
    to: '2026-02-01',
  });
  assert.ok(!id.includes(TOKEN));
});

// ── Claims-only groups (§3d) ─────────────────────────────────────────────────────────────────────

test('the claims-labels bridge is crosswalk-scoped, bounded, and totally ordered', () => {
  // Review Critical 1: the answer stage passes labels[0] as the snapshot payerOverride, so a label
  // outside the chosen group's CONFIRMED alias set would silently re-scope the ranking to another
  // payer — the exact defect the bridge exists to prevent.
  const b = buildGroupClaimsLabelsQuery(TOKEN, 'prefix', 'pi_cigna', '2026-01-01', '2026-02-01');
  assert.ok(/vocabulary = 'claims_primary_payer'/.test(b.sql), 'labels come from the claims vocabulary');
  assert.ok(/m\.canonical_payer_id = \$2/.test(b.sql), 'scoped to the chosen canonical payer, bound');
  assert.ok(/limit 3\b/.test(b.sql), 'bounded — one to send, a couple to show');
  assert.ok(/order by count\(\*\) desc, r\.primary_payer asc/.test(b.sql), 'total order — ties cannot reshuffle');
  assert.deepEqual(b.params, [TOKEN, 'pi_cigna', '2026-01-01', '2026-02-01']);
});

test('candidate ordering is TOTAL — equal member counts cannot reshuffle between requests', () => {
  // The plan tiles post a positional candidate index back to the server, which re-resolves against a
  // freshly built list. Without a total order, two 1-member plans under one carrier could swap
  // between the render and the pick, and the server would honour an index pointing at a different
  // plan than the tile the user clicked (review, Important 3).
  const vob = buildCoverageCandidatesQuery(TOKEN, 'prefix').sql;
  for (const tieBreak of ['v.employer_norm asc nulls last', 'v.plan_type asc nulls last', 'v.funding asc nulls last', 'v.policy_type asc nulls last']) {
    assert.ok(vob.includes(tieBreak), `VOB candidates missing tie-breaker: ${tieBreak}`);
  }
  const claims = buildClaimsOnlyCandidatesQuery(TOKEN, 'prefix').sql;
  const orderBy = claims.slice(claims.indexOf('order by'));
  assert.ok(
    /coalesce\(pi\.display_name, upper\(btrim\(r\.primary_payer\)\)\) asc/.test(orderBy),
    'claims-only candidates need the display-name tie-breaker',
  );
});

test('the claims-only path anti-joins VOB so a member with a policy is never double-counted', () => {
  const { sql } = buildClaimsOnlyCandidatesQuery(TOKEN, 'prefix');
  assert.ok(/not exists\s*\(/.test(sql), 'anti-join present');
  assert.ok(sql.includes('vob.member_benefits_latest'), 'against the VOB matview');
  assert.ok(
    sql.includes('v.member_id_bidx = r.member_id_bidx'),
    'correlated on the member token, so it excludes exactly the members that have a policy row',
  );
});
