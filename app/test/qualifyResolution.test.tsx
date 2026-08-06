/**
 * Qualify v3 D2 — the resolution invariants I3, I4, I5, I6, I7, I8, over fixtures.
 *
 * Fixture-driven rather than DB-driven, deliberately: the suite is hermetic (no live DB in `npm test`),
 * and every invariant here is about the SHAPE of a resolution, which is exactly what a fixture can
 * pin. The query layer's own invariants live in `test/qualifyResolutionQuery.test.ts`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeFunding, trailingWindowFor } from '../lib/qualify/resolutionService';
import {
  deriveNotices,
  employerKeyFor,
  isVobStale,
  panelProvenance,
  sampleTierFor,
  shiftIsoDays,
  windowReducer,
  VOB_STALE_DAYS,
  type ClaimEvidence,
  type CoverageGroup,
  type PanelEvidence,
  type PanelId,
  type QualifyResolution,
  type ResolvedCandidates,
  type ResolvedWindow,
} from '../lib/qualify/resolution';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const EVIDENCE_OK: ClaimEvidence = {
  distinctMembers: 42,
  lines: 1358,
  distinctFacilities: 28,
  distinctPatients: 42,
  sampleTier: 'ok',
  hasReliableAllowed: true,
};

function group(over: Partial<CoverageGroup> = {}): CoverageGroup {
  return {
    canonicalPayerId: 'pi_aetna',
    payerDisplayName: 'Aetna',
    payerRelationship: 'same_payer',
    administratorId: null,
    administratorName: null,
    resolutionBasis: 'vob_name', // nothing produces 'vob_payer_id' yet — the spine is unwired
    employerKey: 'emp_1',
    employerLabel: 'SOUTHWEST AIRLINES CO',
    funding: 'Self-Funded',
    planType: 'PPO',
    policyType: 'PPO',
    network: null,
    groupOnFile: true,
    memberCount: 61,
    vobFreshAsOf: '2026-07-20',
    vobStale: false,
    claimsPayerLabels: [],
    claimEvidence: EVIDENCE_OK,
    ...over,
  };
}

function candidates(over: Partial<ResolvedCandidates> = {}): ResolvedCandidates {
  return { total: 1, chosenIndex: 0, wasAmbiguous: false, chosenBy: 'sole_candidate', rejected: [], ...over };
}

function windowFixture(over: Partial<ResolvedWindow> = {}): ResolvedWindow {
  return {
    from: '2026-07-06',
    to: '2026-08-05',
    kind: 'trailing',
    chosenBy: 'user',
    ladder: null,
    frozen: false,
    ...over,
  };
}

const PANELS: readonly PanelId[] = ['kpis', 'ranking', 'policy', 'ladder', 'trend', 'ai'];

// ── I3 — ambiguity is never silently collapsed ───────────────────────────────────────────────────

test('I3: a >1 candidate set is always marked ambiguous and says so in a notice', () => {
  const c = candidates({ total: 4, chosenIndex: 0, wasAmbiguous: true, chosenBy: 'user' });
  const notices = deriveNotices(group(), c, '2026-08-05');
  const amb = notices.find((n) => n.kind === 'ambiguous_candidates');
  assert.ok(amb, 'an ambiguous candidate set MUST produce a notice — this is the dominant-payer fix');
  assert.equal(amb.severity, 'caution');
  assert.match(amb.text, /4 plans match/, 'and it names how many, not just that there were some');
});

test('I3: sole_candidate is only claimable when there is exactly one candidate', () => {
  // The failure mode this pins: picking [0] out of many and labelling it "unambiguous", which is
  // precisely v2's silent dominant-payer heuristic wearing an honest-looking label.
  const sole = deriveNotices(group(), candidates({ total: 1, chosenBy: 'sole_candidate' }), '2026-08-05');
  assert.ok(sole.some((n) => n.kind === 'sole_candidate'), 'one candidate ⇒ state that it was unambiguous');

  const many = deriveNotices(group(), candidates({ total: 3, wasAmbiguous: true, chosenBy: 'user' }), '2026-08-05');
  assert.ok(!many.some((n) => n.kind === 'sole_candidate'), 'many candidates must never claim solitude');
  assert.ok(many.some((n) => n.kind === 'ambiguous_candidates'));
});

// ── I4 — blind and sighted roles derive IDENTICAL output ─────────────────────────────────────────

test('I4: every derivation is byte-identical with amounts stripped', () => {
  // The resolution contract has no dollar field, so "stripping amounts" is the identity function on
  // it. That is the point of the test: it proves the CONTRACT has nowhere for a dollar to hide, so a
  // blind role cannot receive different bytes. If someone adds `billedAmount` to CoverageGroup, the
  // deep-equal below still passes — but the field scan in the next test fails.
  const g = group();
  const c = candidates({ total: 2, wasAmbiguous: true, chosenBy: 'user' });
  const sighted = {
    notices: deriveNotices(g, c, '2026-08-05'),
    provenance: PANELS.map((p) =>
      panelProvenance(p, { scope: 'resolution', members: 42, lines: 1358, belowFloor: false, subset: '' }, g),
    ),
  };
  const stripAmounts = (x: CoverageGroup): CoverageGroup => JSON.parse(JSON.stringify(x)) as CoverageGroup;
  const blindG = stripAmounts(g);
  const blind = {
    notices: deriveNotices(blindG, c, '2026-08-05'),
    provenance: PANELS.map((p) =>
      panelProvenance(p, { scope: 'resolution', members: 42, lines: 1358, belowFloor: false, subset: '' }, blindG),
    ),
  };
  assert.deepEqual(blind, sighted, 'blind and sighted derivations must be identical');
});

test('I4: no field anywhere in a resolution is dollar-valued', () => {
  // The structural half. Walks a fully-populated resolution and fails on any key that names money.
  const resolution: QualifyResolution = {
    handle: { kind: 'prefix', readAs: 'read as a 3-character member-ID prefix', echo: 'XDP' },
    group: group(),
    candidates: candidates({
      total: 2,
      wasAmbiguous: true,
      chosenBy: 'user',
      rejected: [
        {
          canonicalPayerId: 'pi_cigna',
          payerDisplayName: 'Cigna',
          employerLabel: null,
          funding: null,
          planType: 'POS',
          memberCount: 4,
          hasClaimEvidence: false,
        },
      ],
    }),
    window: windowFixture(),
    predicateId: 'p_deadbeef',
    evidence: Object.fromEntries(
      PANELS.map((p) => [p, { scope: 'resolution', members: 42, lines: 1358, belowFloor: false, subset: 'x' }]),
    ) as Record<PanelId, PanelEvidence>,
    provenance: Object.fromEntries(PANELS.map((p) => [p, 'x'])) as Record<PanelId, string>,
    unmapped: false,
    policyOnFile: true,
    notices: [],
  };

  const banned = /amount|billed|allowed|paid|charge_amount|dollar|revenue|balance/i;
  const offenders: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      // `hasReliableAllowed` is a BOOLEAN about data quality, not a value — the one allowed match.
      if (banned.test(k) && k !== 'hasReliableAllowed') offenders.push(`${path}.${k}`);
      walk(val, `${path}.${k}`);
    }
  };
  walk(resolution, 'resolution');
  assert.deepEqual(offenders, [], `dollar-shaped field(s) in the resolution: ${offenders.join(', ')}`);
});

// ── I5 — null is never rendered as zero ──────────────────────────────────────────────────────────

test('I5: a book-wide panel carries NULL counts, not 0 — "not about this client" is not "zero"', () => {
  const ev: PanelEvidence = { scope: 'book_wide', members: null, lines: null, belowFloor: false, subset: '' };
  assert.equal(ev.members, null, 'book-wide members is null, never 0');
  const line = panelProvenance('kpis', ev, group());
  assert.equal(line, 'book-wide, not this client', 'and the ratified wording is used verbatim');
  assert.ok(!line.includes('0'), 'a book-wide provenance line must not imply a count of zero');
});

test('I5: zero evidence and unknown evidence produce different provenance text', () => {
  const g = group({ claimEvidence: { ...EVIDENCE_OK, distinctMembers: 0, lines: 0, sampleTier: 'insufficient', distinctPatients: 0 } });
  const zero = panelProvenance('ranking', { scope: 'resolution', members: 0, lines: 0, belowFloor: true, subset: '' }, g);
  const unknown = panelProvenance('ranking', { scope: 'resolution', members: null, lines: null, belowFloor: false, subset: '' }, g);
  assert.notEqual(zero, unknown, '"zero rows" and "we did not count" must read differently');
  assert.match(zero, /0 members/, 'zero states the zero');
  assert.ok(!unknown.includes('0 members'), 'unknown does not invent one');
});

test('I5: no VOB row is "no policy on file", NOT "stale" — different states, different notices', () => {
  assert.equal(isVobStale(null, '2026-08-05'), false, 'absence is not staleness');
  const claimsOnly = deriveNotices(
    group({ resolutionBasis: 'claims_only', vobFreshAsOf: null, employerLabel: null, employerKey: null }),
    candidates(),
    '2026-08-05',
  );
  assert.ok(claimsOnly.some((n) => n.kind === 'no_policy_on_file'));
  assert.ok(!claimsOnly.some((n) => n.kind === 'stale_vob'), 'and it is never also reported as stale');
});

test('staleness is measured, not assumed: exactly at the horizon is fresh, one day past is stale', () => {
  const today = '2026-08-05';
  const atHorizon = shiftIsoDays(today, -VOB_STALE_DAYS);
  const pastHorizon = shiftIsoDays(today, -(VOB_STALE_DAYS + 1));
  assert.equal(isVobStale(atHorizon, today), false, 'the boundary itself is not stale');
  assert.equal(isVobStale(pastHorizon, today), true);
});

// ── I6 — the window never moves on its own ───────────────────────────────────────────────────────

test('I6: a ladder PROPOSAL never moves the window', () => {
  // This is the v2 defect verbatim: the ladder auto-changed the window from a count the user never
  // saw, silently invalidating every other panel on screen.
  const before = windowFixture();
  const after = windowReducer(before, {
    type: 'propose',
    ladder: { rungs: [{ days: 90, label: '90 days', members: 12, lines: 400 }], proposedDays: 90, rationale: 'x' },
  });
  assert.equal(after.from, before.from, 'from is untouched by a proposal');
  assert.equal(after.to, before.to, 'to is untouched by a proposal');
  assert.equal(after.chosenBy, 'user', 'and authorship does not change');
  assert.ok(after.ladder, 'the proposal is merely attached');
});

test('I6: once results render the window is frozen, and only a USER action moves it', () => {
  let w = windowFixture();
  w = windowReducer(w, {
    type: 'propose',
    ladder: { rungs: [{ days: 365, label: '365 days', members: 30, lines: 900 }], proposedDays: 365, rationale: 'x' },
  });
  w = windowReducer(w, { type: 'results_rendered' });
  assert.equal(w.frozen, true);
  const frozenFrom = w.from;

  // A second proposal arriving after render must not move it. 90 days is deliberately NOT the
  // fixture's own width (30) — with a matching width, confirming would be a numeric no-op and the
  // assertion below would pass for the wrong reason.
  w = windowReducer(w, {
    type: 'propose',
    ladder: { rungs: [{ days: 90, label: '90 days', members: 3, lines: 20 }], proposedDays: 90, rationale: 'y' },
  });
  assert.equal(w.from, frozenFrom, 'a late proposal cannot re-window a rendered screen');

  // The user confirming IS allowed to move it, even frozen — the user is the exception, by design.
  w = windowReducer(w, { type: 'confirm_proposal' });
  assert.notEqual(w.from, frozenFrom, 'a confirmed proposal does move it');
  assert.equal(w.from, shiftIsoDays(w.to, -90), 'to exactly the confirmed rung');
  assert.equal(w.chosenBy, 'ladder_proposal_confirmed', 'and authorship records that it was confirmed');

  // And an explicit user set always wins.
  const set = windowReducer(w, { type: 'user_set', from: '2026-01-01', to: '2026-02-01', kind: 'calendar_month' });
  assert.equal(set.from, '2026-01-01');
  assert.equal(set.chosenBy, 'user');
});

test('I6: confirming with no ladder attached is a no-op, not a crash or a silent widen', () => {
  const w = windowFixture({ ladder: null });
  assert.deepEqual(windowReducer(w, { type: 'confirm_proposal' }), w);
});

// ── I7 — no PHI in anything renderable, and nothing employer-ish near a URL ──────────────────────

test('I7: employerKey is opaque and positional — never the employer name or a hash of it', () => {
  // employer_name is in phi.ts PHI_BASE_COLUMNS and employer names are LOW ENTROPY, so an unkeyed
  // hash of one is reversible by dictionary. A positional token carries no information outside its
  // own payload and cannot be correlated across sessions.
  for (const i of [0, 1, 7]) {
    const k = employerKeyFor(i);
    assert.match(k, /^emp_\d+$/, 'positional shape');
    assert.ok(!/southwest|airlines/i.test(k), 'and no trace of the label');
  }
  assert.notEqual(employerKeyFor(0), employerKeyFor(1), 'distinct candidates get distinct keys');
});

test('I7: the resolution never carries a full member id, and the echo is prefix-safe', () => {
  const r: Pick<QualifyResolution, 'handle'> = {
    handle: { kind: 'member_id', readAs: 'read as a complete member ID (10 characters)', echo: '' },
  };
  assert.equal(r.handle.echo, '', 'a member-id handle echoes nothing');
  assert.ok(!/\d{6,}/.test(r.handle.readAs.replace('10', '')), 'and readAs states the length, not the value');
});

test('I7: no v3 module writes employer identity into a URL builder', () => {
  // R6: v3 never puts employer identity near a URL. v2's existing prod behaviour is GRANDFATHERED and
  // deliberately not touched by this run, so the assertion is scoped to the v3 modules.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join, dirname } = require('node:path') as typeof import('node:path');
  const here = dirname(new URL(import.meta.url).pathname);
  for (const rel of ['../lib/qualify/resolution.ts', '../lib/qualify/resolutionService.ts']) {
    const src = readFileSync(join(here, rel), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');
    for (const b of ['buildQualifySearchParams', 'URLSearchParams', 'urlState'] as const) {
      assert.ok(!code.includes(b), `${rel} reaches a URL builder (${b}) — v3 must not`);
    }
  }
});

// ── I8 — unmapped renders as unmapped ────────────────────────────────────────────────────────────

test('I8: an unmapped payer is announced as unmapped and never presented as a match', () => {
  const g = group({ canonicalPayerId: null, payerDisplayName: 'ANTHEM BCBS OF CALIFORNIA', payerRelationship: 'unmapped' });
  const notices = deriveNotices(g, candidates(), '2026-08-05');
  const n = notices.find((x) => x.kind === 'unmapped_payer');
  assert.ok(n, 'the unmapped state must be stated');
  assert.equal(n.severity, 'caution');
  assert.match(n.text, /unmapped/i);
  // And its provenance says "an unmapped payer" rather than dressing the raw string up as an identity.
  const line = panelProvenance('ranking', { scope: 'resolution', members: 0, lines: 0, belowFloor: true, subset: '' }, g);
  assert.match(line, /an unmapped payer/, 'provenance names the state, not the unresolved string');
  assert.ok(!line.includes('ANTHEM BCBS OF CALIFORNIA'), 'the unmapped name is not presented as the payer');
});

// ── sampleGate parity ────────────────────────────────────────────────────────────────────────────

test('sample tiers use the 3/10 DISTINCT-PATIENT thresholds, matching sampleGate.ts', () => {
  // Claims within a patient share one plan, contract and CPT pattern, so they are not independent
  // draws; line counts overstate the sample roughly 23×. A third threshold vocabulary would be a
  // third answer to "is this enough evidence".
  assert.equal(sampleTierFor(0), 'insufficient');
  assert.equal(sampleTierFor(2), 'insufficient');
  assert.equal(sampleTierFor(3), 'thin');
  assert.equal(sampleTierFor(9), 'thin');
  assert.equal(sampleTierFor(10), 'ok');
});

test('an insufficient sample is announced with its actual patient count', () => {
  const g = group({ claimEvidence: { ...EVIDENCE_OK, distinctPatients: 1, sampleTier: 'insufficient' } });
  const n = deriveNotices(g, candidates(), '2026-08-05').find((x) => x.kind === 'thin_evidence');
  assert.ok(n);
  assert.match(n.text, /1 patient of history/, 'singular, and the real number');
});

// ── network stays visible ────────────────────────────────────────────────────────────────────────

test('network null is stated as "not captured", not silently omitted', () => {
  const n = deriveNotices(group(), candidates(), '2026-08-05').find((x) => x.kind === 'network_not_captured');
  assert.ok(n, 'the VOB gap is surfaced rather than left as an absent field');
  // …but not for a claims-only group, where there is no VOB to have captured it.
  const claimsOnly = deriveNotices(group({ resolutionBasis: 'claims_only' }), candidates(), '2026-08-05');
  assert.ok(!claimsOnly.some((x) => x.kind === 'network_not_captured'));
});

// ── Post-ship self-review fixes (2026-08-05) ─────────────────────────────────────────────────────

test('the trailing window ENDS TODAY inclusive, matching v2 — today is not dropped', () => {
  // MEASURED OFF-BY-ONE. The first version returned { from: anchor - days, to: anchor }, and because
  // every rollup read is `charge_date >= from and < to`, that excluded today entirely and shifted the
  // window back a day — so a v3 "30 days" covered different rows than a v2 "30 days". v2's convention
  // (contract.ts) is `to = anchor + 1` exclusive, `from = anchor - (days - 1)`.
  const w = trailingWindowFor('2026-08-05', 30);
  assert.equal(w.to, '2026-08-06', 'exclusive upper is TOMORROW, so all of today is in-window');
  assert.equal(w.from, '2026-07-07', 'inclusive lower gives exactly 30 days');
  // Exactly `days` days wide, for every rung the ladder offers.
  for (const days of [30, 60, 90, 180, 365]) {
    const x = trailingWindowFor('2026-08-05', days);
    const span = (Date.parse(`${x.to}T00:00:00Z`) - Date.parse(`${x.from}T00:00:00Z`)) / 86_400_000;
    assert.equal(span, days, `${days}-day window must span exactly ${days} days, got ${span}`);
  }
});

test('a single-day window is representable and does not invert', () => {
  const w = trailingWindowFor('2026-08-05', 1);
  assert.equal(w.from, '2026-08-05');
  assert.equal(w.to, '2026-08-06');
});

test('funding: a VOB that captured BOTH fundings resolves to NULL, not a coin flip', () => {
  // MEASURED live: 'Self-Funded;Fully Insured' exists on 12 members. A startsWith('self') test
  // resolved it to a definitive "Self-Funded" — a confident wrong answer, which is the failure class
  // this whole surface exists to remove. Unknown must read as unknown.
  assert.equal(normalizeFunding('Self-Funded;Fully Insured'), null);
  assert.equal(normalizeFunding('Fully Insured, Self-Funded'), null);
  // The two real single values still resolve, case- and separator-tolerant.
  assert.equal(normalizeFunding('Self-Funded'), 'Self-Funded');
  assert.equal(normalizeFunding('self funded'), 'Self-Funded');
  assert.equal(normalizeFunding('Fully Insured'), 'Fully Insured');
  assert.equal(normalizeFunding('fully-insured'), 'Fully Insured');
  // Absent / blank / unrecognized are all null rather than a nearest guess.
  for (const v of [null, '', '   ', 'Level Funded', 'unknown']) {
    assert.equal(normalizeFunding(v), null, `${JSON.stringify(v)} must be null`);
  }
});
