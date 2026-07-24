import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  getQualifyFacilityCasesCore,
  getQualifyMoversCore,
  getQualifyInitialCore,
  getQualifyBookKpisCore,
  getQualifyFacilityTrendsCore,
  getQualifyOverviewCore,
  getQualifyPatientCohortCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  SEARCH_QUALIFY_PHI,
  SEARCH_QUALIFY_PAYER,
  SEARCH_QUALIFY_FACILITY,
  SEARCH_QUALIFY_COHORT,
  REVEAL_QUALIFY_ROW,
  REVEAL_QUALIFY_ROWS,
  type QualifyDeps,
} from '../app/lib/qualify/core.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
import { QUALIFY_MIN_LINES } from '../app/lib/qualify/rating.js';
import { qualifyWindowBounds } from '../app/lib/qualify/contract.js';
import { QUALIFY_CASES_MAX, type QualifyClaimRow } from '../src/collections/qualifyQuery.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../app/lib/views.js';

// Sentinel DOLLAR values — distinctive so a wire-level scan can prove they never appear when stripped.
const B1 = 999999.99, A1 = 888888.88; // thin/high-pct facility (BXR)
const B2 = 777777.77, A2 = 666666.66; // solid/mid-pct facility (Indigo)
const CB = 555555.55, CA = 444444.44; // a case's dollars

const FAC_ROWS = [
  { facility: 'ca mental health', facility_name: 'CA MENTAL HEALTH', facility_code: 'CAMH', care_setting: null, line_count: 3, confirmed_claims: 3, estimate_claims: 0, unknown_claims: 0, billed: B1, allowed: A1, pct_allowed: 60, entity_ids: [BXR_ENTITY_ID] }, // BXR, thin high pct
  { facility: '405 recovery', facility_name: '405 RECOVERY', facility_code: '10026460', care_setting: 'OP' as const, line_count: 400, confirmed_claims: 380, estimate_claims: 15, unknown_claims: 5, billed: B2, allowed: A2, pct_allowed: 55, entity_ids: [INDIGO_ENTITY_ID] }, // Indigo, solid mid pct
];
const CASE_ROWS = [
  { id: 123, member_id_bidx: 'BIDX_A', facility: '405 recovery', facility_name: '405 RECOVERY', primary_payer: 'AETNA', program: 'OP' as const, dos: '2026-07-01', payment_date: '2026-07-05', pct_allowed: 80, billed: CB, allowed: CA, allowed_tier: 'cd' },
];
const MOVER_ROWS = [
  { primary_payer: 'AETNA', this_patients: 40, prior_patients: 10, delta_patients: 30 },
  { primary_payer: 'CIGNA', this_patients: 8, prior_patients: 0, delta_patients: 8 },
];
// Trend rows for the redesign overview cores. '405 recovery' is dominant-payer AETNA so the overview
// hybrid resolves AETNA and (since FAC_ROWS ranks '405 recovery') seeds THAT facility, not rank-1.
const TREND_ROWS = [
  { facility: '405 recovery', facility_name: '405 RECOVERY', facility_code: '10026460', care_setting: 'OP' as const, dominant_payer: 'AETNA', entity_ids: [INDIGO_ENTITY_ID], line_count: 400, cur_rating: 55, prior_rating: 40, points: [40, 45, 50, 55] },
  { facility: 'ca mental health', facility_name: 'CA MENTAL HEALTH', facility_code: 'CAMH', care_setting: null, dominant_payer: 'AETNA', entity_ids: [BXR_ENTITY_ID], line_count: 3, cur_rating: 60, prior_rating: null, points: [60] },
];
const REVEAL_PHI = { patient_name: 'DOE, JANE', member_id_raw: 'AETMEMBER123', group_number: 'GRP9' };

interface Cap {
  audits: Array<{ action: string; detail: Record<string, unknown> }>;
  facilityEntityIds: string[][];
  landingArgs: Array<{ kind: string; payer: string; entityIds: string[] }>;
  revealActions: string[];
  facilityCasesArgs: Array<{
    payer: string;
    facility: string;
    entityIds: string[];
    prefixToken: string | null;
    memberToken: string | null;
    limit: number;
    allPayers: boolean | undefined;
  }>;
}
function cap(): Cap {
  return { audits: [], facilityEntityIds: [], landingArgs: [], revealActions: [], facilityCasesArgs: [] };
}

const SUPER = () => requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 's@t.ai', id: 's' }, role: 'super_admin' } });
const SEAT = () => requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'a@t.ai', id: 'a' }, role: 'admissions_seat' } });
const ADMIN = () => requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'x@t.ai', id: 'x' }, role: 'admin' } });

function makeDeps(principal: () => ReturnType<typeof SUPER>, c: Cap, over: Partial<QualifyDeps> = {}): QualifyDeps {
  return {
    requirePrincipal: async () => principal(),
    mintToken: () => 'HMAC_TOKEN', // never the raw query
    mintGroupToken: () => 'GROUP_HMAC_TOKEN', // never the raw group #
    resolvePayer: async () => 'AETNA',
    loadFacilities: async (_p, _f, _t, entityIds) => {
      c.facilityEntityIds.push(entityIds);
      return FAC_ROWS;
    },
    // Fix A: default fake lands the identifier on '405 recovery' (a ranked FAC_ROWS facility) so the core
    // keeps it (it clears the floor). Tests override this to model below-floor / no-in-window cases.
    loadIdentifierLandingFacility: async (_tok, kind, payer, _f, _t, entityIds) => {
      c.landingArgs.push({ kind, payer, entityIds });
      return '405 recovery';
    },
    loadFacilityCases: async (payer, facility, _f, _t, entityIds, opts) => {
      c.facilityCasesArgs.push({ payer, facility, entityIds, prefixToken: opts.prefixToken, memberToken: opts.memberToken, limit: opts.limit, allPayers: opts.allPayers });
      return CASE_ROWS;
    },
    // Phase 3 fakes: a known claim id resolves to a prefix token; the cohort clears the floor.
    loadClaimPrefixToken: async (claimId) => (claimId === 123 ? 'PREFIX_TOKEN_X' : null),
    loadPatientCohort: async () => ({
      patients: 12,
      billed: 100000,
      allowed: 40000,
      paid: 30000,
      byPayer: [{ label: 'AETNA', count: 30, charge: 60000 }],
      byCpt: [{ label: 'H0015', count: 18, charge: 40000 }],
    }),
    loadMovers: async () => MOVER_ROWS,
    loadBookKpis: async () => ({ pct_allowed_of_billed: 44, pct_paid_of_allowed: 82, pct_paid_of_billed: 36 }),
    loadFacilityTrends: async () => TREND_ROWS,
    recordAccess: async (e) => {
      c.audits.push({ action: e.action, detail: e.detail });
    },
    revealRow: async (_id, _a, _e, action) => {
      c.revealActions.push(action);
      return REVEAL_PHI;
    },
    revealRows: async (_ids, _a, _e, action) => {
      c.revealActions.push(action);
      return [{ id: 123, ...REVEAL_PHI }];
    },
    now: () => new Date('2026-07-17T00:00:00Z'),
    ...over,
  };
}

const IN = { query: 'AETMEMBER123', windowDays: 30 as const }; // long → member_id kind

// ── #1 RANK ORDER (silent-bug guard): value-first — higher allowed% ranks first, volume never demotes ─
test('snapshot: a small high-% facility RANKS ABOVE a large mid-% one (value-first, ruling 2026-07-19b)', async () => {
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, cap()), IN);
  assert.equal(snap.facilities[0]!.name, 'CA MENTAL HEALTH'); // 60% (3 lines, ≥ floor) → rank 1 on merit
  assert.equal(snap.facilities[1]!.name, '405 RECOVERY'); // 55% (400 lines) → rank 2
  // The higher allowed% ranks FIRST despite far less volume — rating = allowed%, no volume drag.
  assert.ok((snap.facilities[0]!.pctAllowedOfBilled ?? 0) > (snap.facilities[1]!.pctAllowedOfBilled ?? 0));
  assert.equal(snap.facilities[0]!.rating, 60); // rating IS the allowed%
  assert.equal(snap.facilities[0]!.rank, 1);
  assert.equal(snap.facilities[1]!.rank, 2);
});

// ── #1b FLOOR: a below-QUALIFY_MIN_LINES fluke never surfaces (but genuinely small facilities do) ────
test('snapshot: a below-floor facility (< QUALIFY_MIN_LINES charge lines) is suppressed from the list', async () => {
  const deps = makeDeps(SUPER, cap(), {
    loadFacilities: async () => [
      { facility: 'fluke', facility_name: 'FLUKE 100%', facility_code: null, care_setting: null, line_count: QUALIFY_MIN_LINES - 1, confirmed_claims: QUALIFY_MIN_LINES - 1, estimate_claims: 0, unknown_claims: 0, billed: 100, allowed: 100, pct_allowed: 100, entity_ids: [BXR_ENTITY_ID] },
      ...FAC_ROWS,
    ],
  });
  const snap = await getQualifySnapshotCore(deps, IN);
  assert.ok(!snap.facilities.some((f) => f.name === 'FLUKE 100%'), 'a 100%-on-1-line fluke is filtered out (below floor)');
  assert.equal(snap.facilities.length, 2); // only the two genuine facilities remain
  assert.equal(snap.facilities[0]!.name, 'CA MENTAL HEALTH'); // still value-first ranked (60% > 55%)
});

// ── #2 AMOUNTS wire-level, BOTH actions, BOTH states ─────────────────────────────────────────────
test('snapshot: admissions_seat payload has ZERO dollar values anywhere (wire-level)', async () => {
  const snap = await getQualifySnapshotCore(makeDeps(SEAT, cap()), IN);
  for (const f of snap.facilities) {
    assert.equal(f.billedAmount, null);
    assert.equal(f.allowedAmount, null);
  }
  // The snapshot no longer carries claims (Direction B: the recent-claims panel is the facility drill) —
  // prove the facility dollars are stripped at the wire.
  const wire = JSON.stringify(snap);
  for (const v of [B1, A1, B2, A2]) {
    assert.ok(!wire.includes(String(v)), `dollar ${v} must NOT appear in an admissions_seat payload`);
  }
  assert.equal(snap.viewerHasAmountsCapability, false);
});

test('snapshot: a non-admissions_seat payload DOES carry the dollar values', async () => {
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, cap()), IN);
  const wire = JSON.stringify(snap);
  assert.ok(wire.includes(String(B2)) && wire.includes(String(A2)), 'super_admin sees dollars');
  assert.equal(snap.facilities.find((f) => f.name === '405 RECOVERY')?.billedAmount, B2);
  assert.equal(snap.viewerHasAmountsCapability, true);
});

test('movers: carries NO dollar fields for either capability state', async () => {
  for (const who of [SEAT, SUPER]) {
    const m = await getQualifyMoversCore(makeDeps(who, cap()), 30);
    const wire = JSON.stringify(m);
    assert.ok(!wire.includes('billedAmount') && !wire.includes('allowedAmount'), 'no dollar keys in movers');
    assert.ok(!wire.includes(String(B1)) && !wire.includes(String(A2)), 'no dollar values in movers');
  }
});

// ── on-load combined action (perf): movers + top-payer snapshot + rank-1 seed cases in ONE call ──────
test('initial: combines movers + top-payer snapshot + rank-1 seed cases, preserving BOTH audits', async () => {
  const c = cap();
  const init = await getQualifyInitialCore(makeDeps(SUPER, c), 30);
  assert.equal(init.movers.length, 2); // AETNA, CIGNA
  assert.equal(init.topPayer, 'AETNA'); // top mover (delta 30)
  assert.equal(init.snapshot?.resolved?.payerName, 'AETNA');
  assert.equal(init.snapshot?.facilities.length, 2);
  // seeded the rank-1 facility's cases (facilityKey of facilities[0], the value-first winner)
  assert.equal(init.seedFacility, init.snapshot?.facilities[0]?.facilityKey);
  assert.ok(init.seedFacility);
  assert.equal(init.seedCases.length, 1);
  assert.equal(init.seedCapped, false);
  // composition preserves the SAME audits the un-combined waterfall emitted: resolve + drill.
  const actions = c.audits.map((a) => a.action);
  assert.ok(actions.includes(SEARCH_QUALIFY_PAYER), 'resolve-by-payer audited');
  assert.ok(actions.includes(SEARCH_QUALIFY_FACILITY), 'seed-cases (facility drill) audited');
});

test('initial: no movers → empty-prompt shape (all nulls); no resolve or seed happens', async () => {
  const c = cap();
  const init = await getQualifyInitialCore(makeDeps(SUPER, c, { loadMovers: async () => [] }), 30);
  assert.equal(init.movers.length, 0);
  assert.equal(init.topPayer, null);
  assert.equal(init.snapshot, null);
  assert.equal(init.seedFacility, null);
  assert.equal(init.seedCases.length, 0);
  assert.equal(init.seedCapped, false);
  assert.equal(c.audits.filter((a) => a.action === SEARCH_QUALIFY_PAYER).length, 0, 'no resolve → no payer audit');
  assert.equal(c.facilityCasesArgs.length, 0, 'no seed → no cases fetch');
});

// ── #3 CROSS-TENANT dual-entity end-to-end (finding 2a) ──────────────────────────────────────────
test('snapshot: a single result contains BOTH tenants, and the loader gets the pinned [BXR,Indigo]', async () => {
  const c = cap();
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, c), IN);
  const names = snap.facilities.map((f) => f.name);
  assert.ok(names.includes('CA MENTAL HEALTH'), 'BXR facility present'); // facility_code CAMH → BXR
  assert.ok(names.includes('405 RECOVERY'), 'Indigo facility present'); // facility_code 10026460 → Indigo
  assert.deepEqual(c.facilityEntityIds[0], [BXR_ENTITY_ID, INDIGO_ENTITY_ID], 'reads BOTH tenants in one query');
  // city/state crosswalk applied (bonus): CAMH → San Martin, CA.
  assert.equal(snap.facilities.find((f) => f.name === 'CA MENTAL HEALTH')?.state, 'CA');
});

// ── Fix A — identifierLandingFacility (land on the searched member's facility, not rating rank-1) ────
test('snapshot: identifierLandingFacility = the loader facility when it is a RANKED facility (kept)', async () => {
  const c = cap();
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, c), IN);
  assert.equal(snap.identifierLandingFacility, '405 recovery', 'the landing facility (a floor-clearing FAC_ROWS row) is kept');
  // The landing loader is scoped to the RESOLVED payer + pinned tenancy, with the sniffed kind.
  assert.equal(c.landingArgs[0]!.kind, 'member_id'); // IN query is long → member_id
  assert.equal(c.landingArgs[0]!.payer, 'AETNA');
  assert.deepEqual(c.landingArgs[0]!.entityIds, [BXR_ENTITY_ID, INDIGO_ENTITY_ID]);
});

test('snapshot: a BELOW-FLOOR (non-ranked) landing candidate is DROPPED to null (approach ii, honest-empty)', async () => {
  // Loader returns a facility that is NOT in the assembled facilities[] (below QUALIFY_MIN_LINES) → dropped.
  const snap = await getQualifySnapshotCore(
    makeDeps(SUPER, cap(), { loadIdentifierLandingFacility: async () => 'tiny below-floor facility' }),
    IN,
  );
  assert.equal(snap.identifierLandingFacility, null, 'a landing facility absent from facilities[] collapses to null');
  assert.ok(snap.facilities.length > 0, 'the payer still has ranked facilities — this is honest-empty, not no-facilities');
});

test('snapshot: no in-window claim for the identifier (loader null) → identifierLandingFacility null', async () => {
  const snap = await getQualifySnapshotCore(
    makeDeps(SUPER, cap(), { loadIdentifierLandingFacility: async () => null }),
    IN,
  );
  assert.equal(snap.identifierLandingFacility, null);
});

test('by-payer: identifierLandingFacility is null (no identifier on the payer path — ruling 3, stays payer-wide)', async () => {
  const c = cap();
  const snap = await getQualifySnapshotByPayerCore(
    makeDeps(SUPER, c, {
      loadIdentifierLandingFacility: async () => {
        throw new Error('landing lookup must NOT run on the resolve-by-payer path');
      },
    }),
    PAYER_IN,
  );
  assert.equal(snap.identifierLandingFacility, null);
  assert.equal(c.landingArgs.length, 0, 'the landing loader is never called on the payer path');
});

// ── #4 Q-A DENIAL for an entity ADMIN at ALL FOUR entry points (admin-fails, explicitly) ─────────
test('an entity admin is denied fail-closed at getQualifySnapshot / getQualifyMovers / revealQualifyRow(s)', async () => {
  const deps = makeDeps(ADMIN, cap());
  await assert.rejects(() => getQualifySnapshotCore(deps, IN), /does not have access to Qualify/);
  await assert.rejects(() => getQualifyMoversCore(deps, 30), /does not have access to Qualify/);
  assert.deepEqual(await revealQualifyRowCore(deps, 1), { ok: false, error: 'Your role does not have access to Qualify.' });
  const rows = await revealQualifyRowsCore(deps, [1]);
  assert.equal(rows.ok, false);
});

// ── #5 REVEAL: distinct action label + fail-closed ───────────────────────────────────────────────
test('reveal uses the DISTINCT reveal_qualify_row(s) audit action', async () => {
  const c = cap();
  const deps = makeDeps(SUPER, c);
  await revealQualifyRowCore(deps, 123);
  await revealQualifyRowsCore(deps, [123]);
  assert.deepEqual(c.revealActions, [REVEAL_QUALIFY_ROW, REVEAL_QUALIFY_ROWS]);
  assert.equal(REVEAL_QUALIFY_ROW, 'reveal_qualify_row');
  assert.equal(REVEAL_QUALIFY_ROWS, 'reveal_qualify_rows');
});

test('reveal is fail-closed: if the audited-decrypt path throws, NO PHI is returned', async () => {
  const deps = makeDeps(SUPER, cap(), {
    revealRow: async () => {
      throw new Error('audit write failed');
    },
  });
  const res = await revealQualifyRowCore(deps, 123);
  assert.equal(res.ok, false);
  assert.ok(!JSON.stringify(res).includes('AETMEMBER123'), 'no member id leaks on failure');
});

// ── #6 SEARCH audit is field-names-only (never the term/token/PHI) ────────────────────────────────
test('search_qualify_phi audits field names only — never the query term or the token', async () => {
  const c = cap();
  await getQualifySnapshotCore(makeDeps(SUPER, c), IN);
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_PHI);
  assert.ok(audit, 'a search_qualify_phi audit was written');
  assert.deepEqual(Object.keys(audit!.detail).sort(), ['field', 'window']);
  assert.equal(audit!.detail.field, 'member_id');
  const wire = JSON.stringify(audit);
  assert.ok(!wire.includes('AETMEMBER123'), 'raw query never audited');
  assert.ok(!wire.includes('HMAC_TOKEN'), 'token never audited');
});

test('resolved.matchedValue is a non-PHI alpha-prefix echo, never the raw member id', async () => {
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, cap()), IN);
  assert.equal(snap.resolved?.matchedValue, 'AET'); // first 3 alnum of AETMEMBER123
});

// ── no-data (VOB) paths ──────────────────────────────────────────────────────────────────────────
test('unknown identifier → resolved:null (VOB), still audited', async () => {
  const c = cap();
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, c, { resolvePayer: async () => null }), IN);
  assert.equal(snap.resolved, null);
  assert.deepEqual(snap.facilities, []);
  assert.ok(c.audits.some((a) => a.action === SEARCH_QUALIFY_PHI), 'a real search was audited');
});

test('unusable query (no token) → resolved:null and NO audit (nothing was searched)', async () => {
  const c = cap();
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, c, { mintToken: () => null }), { query: 'ab', windowDays: 30 });
  assert.equal(snap.resolved, null);
  assert.equal(c.audits.length, 0);
});

// ── RESOLVE-BY-PAYER (Heating-up tap path) ───────────────────────────────────────────────────────
const PAYER_IN = { payer: 'AETNA', windowDays: 30 as const };

test('by-payer: resolves facilities in rating order WITHOUT the PHI resolve (mintToken/resolvePayer never called)', async () => {
  const deps = makeDeps(SUPER, cap(), {
    mintToken: () => {
      throw new Error('mintToken must not run on the payer path');
    },
    resolvePayer: async () => {
      throw new Error('resolvePayer must not run on the payer path');
    },
  });
  const snap = await getQualifySnapshotByPayerCore(deps, PAYER_IN);
  assert.equal(snap.resolved?.payerName, 'AETNA');
  assert.equal(snap.resolved?.matchedOn, 'payer');
  assert.equal(snap.resolved?.matchedValue, ''); // no PHI prefix echo on this path
  assert.equal(snap.facilities[0]!.name, 'CA MENTAL HEALTH'); // value-first order preserved (same as PHI path)
  assert.equal(snap.facilities[1]!.name, '405 RECOVERY');
});

test('by-payer: writes the distinct search_qualify_payer audit (payer label) — never search_qualify_phi', async () => {
  const c = cap();
  await getQualifySnapshotByPayerCore(makeDeps(SUPER, c), PAYER_IN);
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_PAYER);
  assert.ok(audit, 'a search_qualify_payer audit was written');
  assert.deepEqual(Object.keys(audit!.detail).sort(), ['payer', 'window']);
  assert.equal(audit!.detail.payer, 'AETNA');
  assert.ok(!c.audits.some((a) => a.action === SEARCH_QUALIFY_PHI), 'no PHI-term audit on the payer path');
});

test('by-payer: admissions_seat payload has ZERO dollar values (wire-level)', async () => {
  const snap = await getQualifySnapshotByPayerCore(makeDeps(SEAT, cap()), PAYER_IN);
  const wire = JSON.stringify(snap);
  for (const v of [B1, A1, B2, A2]) {
    assert.ok(!wire.includes(String(v)), `dollar ${v} must NOT appear in an admissions_seat payer payload`);
  }
  assert.equal(snap.viewerHasAmountsCapability, false);
});

test('by-payer: loader receives the pinned [BXR,Indigo] tenancy scope', async () => {
  const c = cap();
  await getQualifySnapshotByPayerCore(makeDeps(SUPER, c), PAYER_IN);
  assert.deepEqual(c.facilityEntityIds[0], [BXR_ENTITY_ID, INDIGO_ENTITY_ID]);
});

test('by-payer: an entity admin is denied fail-closed', async () => {
  await assert.rejects(
    () => getQualifySnapshotByPayerCore(makeDeps(ADMIN, cap()), PAYER_IN),
    /does not have access to Qualify/,
  );
});

test('by-payer: a blank payer → empty snapshot and NO audit (nothing looked up)', async () => {
  const c = cap();
  const snap = await getQualifySnapshotByPayerCore(makeDeps(SUPER, c), { payer: '  ', windowDays: 30 });
  assert.equal(snap.resolved, null);
  assert.deepEqual(snap.facilities, []);
  assert.equal(c.audits.length, 0);
});

// ── FACILITY DRILL (facility-card tap) ───────────────────────────────────────────────────────────
const FAC_CASES_IN = { payer: 'AETNA', facility: '405 recovery', windowDays: 30 as const };

test('facility-drill: returns masked cases (never a raw member id) for the resolved payer + facility', async () => {
  const res = await getQualifyFacilityCasesCore(makeDeps(SUPER, cap()), FAC_CASES_IN);
  assert.ok(res.claims.length > 0);
  for (const c of res.claims) assert.equal(c.memberIdMasked, '••••••');
});

test('facility-drill: maps each row primary_payer → payerName (the payer chip/label source, not a re-lookup)', async () => {
  const res = await getQualifyFacilityCasesCore(makeDeps(SUPER, cap()), FAC_CASES_IN);
  assert.equal(res.claims[0]!.payerName, 'AETNA'); // CASE_ROWS carries primary_payer: 'AETNA'
});

test('facility-drill allPayers: threads the flag + the whole-window cap (no prefix) and tags each row its own payer', async () => {
  const c = cap();
  const MIXED = [
    { ...CASE_ROWS[0]!, id: 1, primary_payer: 'AETNA' },
    { ...CASE_ROWS[0]!, id: 2, primary_payer: 'CIGNA' },
  ];
  const res = await getQualifyFacilityCasesCore(
    makeDeps(SUPER, c, {
      loadFacilityCases: async (payer, facility, _from, _to, entityIds, opts) => {
        c.facilityCasesArgs.push({ payer, facility, entityIds, prefixToken: opts.prefixToken, memberToken: opts.memberToken, limit: opts.limit, allPayers: opts.allPayers });
        return MIXED;
      },
    }),
    { ...FAC_CASES_IN, allPayers: true },
  );
  assert.equal(c.facilityCasesArgs[0]!.allPayers, true, 'allPayers reaches the loader');
  assert.equal(c.facilityCasesArgs[0]!.limit, QUALIFY_CASES_MAX, 'both paths load the whole window (QUALIFY_CASES_MAX), not a 50-cap page');
  assert.equal(c.facilityCasesArgs[0]!.prefixToken, null, 'no server-side prefix narrow on the all-payers view (no search term here)');
  assert.equal(c.facilityCasesArgs[0]!.memberToken, null, 'no exact-member narrow on the all-payers view (no search term here)');
  assert.deepEqual(res.claims.map((x) => x.payerName), ['AETNA', 'CIGNA'], 'each row carries its OWN payer');
});

test('facility-drill: passes the RAW facility text + resolved payer + pinned tenancy to the loader', async () => {
  const c = cap();
  await getQualifyFacilityCasesCore(makeDeps(SUPER, c), FAC_CASES_IN);
  assert.equal(c.facilityCasesArgs[0]!.payer, 'AETNA');
  assert.equal(c.facilityCasesArgs[0]!.facility, '405 recovery');
  assert.deepEqual(c.facilityCasesArgs[0]!.entityIds, [BXR_ENTITY_ID, INDIGO_ENTITY_ID]);
});

test('facility-drill: writes the DISTINCT search_qualify_facility audit (payer + facility + window)', async () => {
  const c = cap();
  await getQualifyFacilityCasesCore(makeDeps(SUPER, c), FAC_CASES_IN);
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_FACILITY);
  assert.ok(audit, 'a search_qualify_facility audit was written');
  assert.deepEqual(Object.keys(audit!.detail).sort(), ['facility', 'payer', 'window']);
  assert.equal(audit!.detail.payer, 'AETNA');
  assert.equal(audit!.detail.facility, '405 recovery');
  assert.ok(!c.audits.some((a) => a.action === SEARCH_QUALIFY_PHI), 'no PHI-term audit on the facility drill');
});

test('facility-drill: admissions_seat payload has ZERO dollar values (wire-level, same choke point)', async () => {
  const res = await getQualifyFacilityCasesCore(makeDeps(SEAT, cap()), FAC_CASES_IN);
  const wire = JSON.stringify(res);
  for (const v of [CB, CA]) {
    assert.ok(!wire.includes(String(v)), `dollar ${v} must NOT appear in an admissions_seat facility-drill payload`);
  }
  for (const c of res.claims) {
    assert.equal(c.billedAmount, null);
    assert.equal(c.allowedAmount, null);
  }
  assert.equal(res.viewerHasAmountsCapability, false);
});

// PAIRED POSITIVE (regression teeth for core.ts's `gate.hasAmounts ? assembleClaims : stripClaimsAmounts`):
// a capability session's DRILL response MUST carry the claim dollars. Without this, a strip-for-everyone
// regression would leave every drill test green (the negative wants them gone; nothing proves they survive).
// The default fake returns CASE_ROWS (one row, id 123, billed CB / allowed CA) → res.claims[0] is that row.
test('facility-drill: a capability session DOES carry the claim dollars (wire + structural, the paired positive)', async () => {
  const res = await getQualifyFacilityCasesCore(makeDeps(SUPER, cap()), FAC_CASES_IN);
  const wire = JSON.stringify(res);
  assert.ok(wire.includes(String(CB)) && wire.includes(String(CA)), 'super_admin sees the claim dollars at the wire');
  assert.equal(res.claims[0]!.billedAmount, CB, 'billed survives the choke point for a capable viewer');
  assert.equal(res.claims[0]!.allowedAmount, CA, 'allowed survives the choke point for a capable viewer');
  assert.equal(res.viewerHasAmountsCapability, true);
});

test('facility-drill allPayers: admissions_seat gets ZERO dollar values (SAME choke point as single-payer)', async () => {
  const MIXED = [
    { ...CASE_ROWS[0]!, id: 1, primary_payer: 'AETNA', billed: 12345, allowed: 6789 },
    { ...CASE_ROWS[0]!, id: 2, primary_payer: 'CIGNA', billed: 22222, allowed: 3333 },
  ];
  const res = await getQualifyFacilityCasesCore(
    makeDeps(SEAT, cap(), { loadFacilityCases: async () => MIXED }),
    { ...FAC_CASES_IN, allPayers: true },
  );
  const wire = JSON.stringify(res);
  for (const v of [12345, 6789, 22222, 3333]) {
    assert.ok(!wire.includes(String(v)), `dollar ${v} must NOT appear in an admissions_seat all-payers payload`);
  }
  for (const c of res.claims) {
    assert.equal(c.billedAmount, null);
    assert.equal(c.allowedAmount, null);
  }
  assert.equal(res.viewerHasAmountsCapability, false);
  // The strip nulls dollars but leaves the (non-dollar) payer label — the chip/label source survives.
  assert.deepEqual(res.claims.map((x) => x.payerName), ['AETNA', 'CIGNA']);
});

test('facility-drill: a blank payer or facility → empty cases and NO audit (nothing looked up)', async () => {
  const c = cap();
  const a = await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { payer: '  ', facility: 'x', windowDays: 30 });
  const b = await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { payer: 'AETNA', facility: '  ', windowDays: 30 });
  assert.deepEqual(a.claims, []);
  assert.deepEqual(b.claims, []);
  assert.equal(c.audits.length, 0);
  assert.equal(c.facilityCasesArgs.length, 0);
});

test('facility-drill: an entity admin is denied fail-closed', async () => {
  await assert.rejects(
    () => getQualifyFacilityCasesCore(makeDeps(ADMIN, cap()), FAC_CASES_IN),
    /does not have access to Qualify/,
  );
});

// ── FACILITY DRILL — prefix narrow + cursor pagination (Stage 1) ─────────────────────────────────
test('facility-drill prefix: mints the alpha-prefix token, passes it to the loader, audits fields:[prefix] (never the term)', async () => {
  const c = cap();
  // Prefix chosen so it is NOT a substring of the (legitimately-audited) payer 'AETNA' / facility text.
  await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { ...FAC_CASES_IN, filter: { prefix: 'ZQX' } });
  assert.equal(c.facilityCasesArgs[0]!.prefixToken, 'HMAC_TOKEN', 'the minted (opaque) token reaches the loader');
  assert.equal(c.facilityCasesArgs[0]!.memberToken, null, 'prefix mode does NOT set the exact-member token');
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_FACILITY)!;
  assert.deepEqual(audit.detail.fields, ['prefix'], 'audits the FIELD NAME only');
  const wire = JSON.stringify(audit);
  assert.ok(!wire.includes('ZQX'), 'raw prefix never audited');
  assert.ok(!wire.includes('HMAC_TOKEN'), 'token never audited');
});

test('facility-drill EXACT member: mints the member token, passes it (NOT the prefix), audits fields:[member_id] (never the term)', async () => {
  const c = cap();
  // A full member-id term (> 3 chars → exact narrow). Chosen so it is NOT a substring of payer/facility text.
  await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { ...FAC_CASES_IN, filter: { memberId: 'ZQX998877' } });
  assert.equal(c.facilityCasesArgs[0]!.memberToken, 'HMAC_TOKEN', 'the minted (opaque) member token reaches the loader');
  assert.equal(c.facilityCasesArgs[0]!.prefixToken, null, 'exact mode does NOT set the prefix token');
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_FACILITY)!;
  assert.deepEqual(audit.detail.fields, ['member_id'], 'audits the FIELD NAME only');
  const wire = JSON.stringify(audit);
  assert.ok(!wire.includes('ZQX998877'), 'raw member id never audited');
  assert.ok(!wire.includes('HMAC_TOKEN'), 'token never audited');
});

test('facility-drill: EXACT member wins when both memberId + prefix are supplied (mutually exclusive in practice)', async () => {
  const c = cap();
  await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { ...FAC_CASES_IN, filter: { memberId: 'ZQX998877', prefix: 'ZQX' } });
  assert.equal(c.facilityCasesArgs[0]!.memberToken, 'HMAC_TOKEN', 'the member token is applied');
  assert.equal(c.facilityCasesArgs[0]!.prefixToken, null, 'the prefix token is NOT applied when a member id is present');
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_FACILITY)!;
  assert.deepEqual(audit.detail.fields, ['member_id'], 'the audited field is member_id');
});

// ── DIRECTION B — the headline UX bug this build kills (task 4: prefix-exactness on the FACILITY DRILL). ──
// Hermetic proxy for the DB: three prefixes (W29/W27/W23) resolve to the SAME payer at the SAME facility.
// The loader fake honors the `member_id_prefix_bidx = $tok` equality the real builder emits (a keyed HMAC:
// distinct per prefix), so a W29 search can only match W29* rows — proving W27/W23 never bleed through.
const prefixRow = (id: number): QualifyClaimRow => ({
  id, member_id_bidx: `PBIDX_${id}`, facility: 'shared facility', facility_name: 'SHARED', primary_payer: 'AETNA', program: 'OP' as const,
  dos: `2026-07-${String(id).padStart(2, '0')}`, payment_date: `2026-07-${String(id).padStart(2, '0')}`, pct_allowed: 50, billed: 100, allowed: 50, allowed_tier: 'cd',
});
const PREFIX_OF = new Map<number, string>([[1, 'W29'], [2, 'W29'], [3, 'W27'], [4, 'W23']]);
const PREFIX_ROWS: QualifyClaimRow[] = [prefixRow(4), prefixRow(3), prefixRow(2), prefixRow(1)];
function prefixExactDeps(c: Cap): QualifyDeps {
  return makeDeps(SUPER, c, {
    // Deterministic, term-distinct, opaque-shaped token — models the keyed-HMAC blind index per prefix.
    mintToken: (term, kind) => `tok:${kind}:${term.toUpperCase()}`,
    loadFacilityCases: async (_p, _f, _from, _to, _e, opts) => {
      c.facilityCasesArgs.push({ payer: _p, facility: _f, entityIds: _e, prefixToken: opts.prefixToken, memberToken: opts.memberToken, limit: opts.limit, allPayers: opts.allPayers });
      // Simulate the DB predicate member_id_prefix_bidx = $tok (equality on the prefix's own blind index).
      if (opts.prefixToken) {
        const want = opts.prefixToken.replace('tok:prefix:', '');
        return PREFIX_ROWS.filter((r) => PREFIX_OF.get(r.id) === want);
      }
      return PREFIX_ROWS; // no narrow ⇒ payer-wide (all three prefixes)
    },
  });
}

test('facility-drill prefix-exactness: a W29 search returns ONLY W29 claims — never W27/W23 (the payer-wide bleed is killed)', async () => {
  const res = await getQualifyFacilityCasesCore(prefixExactDeps(cap()), { ...FAC_CASES_IN, filter: { prefix: 'W29' } });
  assert.deepEqual(
    res.claims.map((x) => x.id).sort((a, b) => a - b),
    [1, 2],
    'only the two W29 claims — the sibling W27/W23 rows on the same payer are gone',
  );
});

test('facility-drill prefix-exactness: NO narrow (resolve-by-payer path) stays payer-wide — all prefixes (ruling 3)', async () => {
  const res = await getQualifyFacilityCasesCore(prefixExactDeps(cap()), FAC_CASES_IN); // no filter
  assert.equal(res.claims.length, 4, 'payer-wide: every prefix at the facility, unfiltered');
});

test('facility-drill prefix: a sub-3-char prefix mints NO token → no filter, no audit field', async () => {
  const c = cap();
  // Real alphaPrefixBlindIndex returns null for < 3 chars; model that with a null-minting dep.
  await getQualifyFacilityCasesCore(makeDeps(SUPER, c, { mintToken: () => null }), { ...FAC_CASES_IN, filter: { prefix: 'ab' } });
  assert.equal(c.facilityCasesArgs[0]!.prefixToken, null, 'no token → no prefix predicate downstream');
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_FACILITY)!;
  assert.ok(!('fields' in audit.detail), 'no fields recorded when no filter is applied');
});

// ── FACILITY DRILL — whole window, no pager, safety cap (Part 1: keyset pager retired) ───────────────
test('facility-drill: the whole window returns in one shot — a small set is NOT capped', async () => {
  const res = await getQualifyFacilityCasesCore(makeDeps(SUPER, cap()), FAC_CASES_IN); // default fake returns 1 row
  assert.equal(res.capped, false, 'under the cap → not capped');
  assert.equal(res.claims.length, 1);
  assert.ok(!('nextCursor' in res) && !('hasMore' in res), 'the pager fields are gone from the contract');
});

// A fake facility that OVER-FETCHES by one past the cap (the builder binds limit+1): the core must set
// `capped` and TRIM to QUALIFY_CASES_MAX, keeping the most recent (the loader already returns payment-desc).
const overCapRows: QualifyClaimRow[] = Array.from({ length: QUALIFY_CASES_MAX + 1 }, (_, i) => ({
  id: 100000 - i, // strictly descending, mirrors payment_date desc, id desc
  member_id_bidx: `M_${i}`,
  facility: '405 recovery',
  facility_name: '405 RECOVERY',
  primary_payer: 'AETNA',
  program: 'OP' as const,
  dos: '2026-06-15',
  payment_date: `2026-07-01`,
  pct_allowed: 50,
  billed: 100,
  allowed: 50,
  allowed_tier: 'cd',
}));

test('facility-drill: a window over the cap sets `capped` and truncates to QUALIFY_CASES_MAX (most recent kept)', async () => {
  const res = await getQualifyFacilityCasesCore(
    makeDeps(SUPER, cap(), { loadFacilityCases: async () => overCapRows }),
    FAC_CASES_IN,
  );
  assert.equal(res.capped, true, 'more than the cap → capped');
  assert.equal(res.claims.length, QUALIFY_CASES_MAX, 'trimmed to exactly the cap');
  assert.equal(res.claims[0]!.id, overCapRows[0]!.id, 'the most-recent row is kept (the over-fetch tail is dropped)');
});

// ── window math ──────────────────────────────────────────────────────────────────────────────────
test('qualifyWindowBounds: this + prior windows are adjacent, equal-length, non-overlapping', () => {
  // Noon UTC = 5am Pacific → business day is unambiguously 2026-07-17 in either zone.
  const b = qualifyWindowBounds(30, new Date('2026-07-17T12:00:00Z'));
  assert.equal(b.to, '2026-07-18'); // exclusive upper = tomorrow (today included)
  assert.equal(b.from, '2026-06-18'); // 30 days ending today
  assert.equal(b.priorTo, b.from); // adjacent
  assert.equal(b.priorFrom, '2026-05-19'); // prior 30 days
});

test('qualifyWindowBounds: anchors to the business (Pacific) calendar day, not the UTC day', () => {
  // 2026-07-18T04:00:00Z is 2026-07-17 21:00 Pacific — still the 17th for the ops team even though the
  // server's UTC date has already rolled to the 18th. The window must reflect the 17th, matching the
  // mid-day instant above; a UTC-naive anchor would slide every bound forward a day.
  const evening = qualifyWindowBounds(30, new Date('2026-07-18T04:00:00Z'));
  assert.equal(evening.to, '2026-07-18');
  assert.equal(evening.from, '2026-06-18');
  assert.equal(evening.priorFrom, '2026-05-19');
});

// ── Phase 2: group-# narrow threading + per-response patientKey aliasing ─────────────────────────────
test('facility-drill: filter.group mints server-side, threads the TOKEN, audits the FIELD NAME only', async () => {
  const c = cap();
  let seenGroupToken: string | null | undefined;
  const deps = makeDeps(SUPER, c, {
    loadFacilityCases: async (_p, _f, _from, _to, _e, opts) => {
      seenGroupToken = opts.groupToken;
      return CASE_ROWS;
    },
  });
  const res = await getQualifyFacilityCasesCore(deps, { ...FAC_CASES_IN, filter: { group: 'GRP42' } });
  assert.equal(seenGroupToken, 'GROUP_HMAC_TOKEN', 'only the minted token reaches the loader');
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_FACILITY)!;
  assert.deepEqual(audit.detail.fields, ['group_number'], 'audit carries the field NAME, never the term/token');
  assert.ok(!JSON.stringify(res).includes('GRP42'), 'the raw group term never appears on the wire');
});

test('facility-drill: patientKey aliases same-member rows per response; the bidx NEVER reaches the wire', async () => {
  const rows = [
    { ...CASE_ROWS[0]!, id: 1, member_id_bidx: 'TOK_X' },
    { ...CASE_ROWS[0]!, id: 2, member_id_bidx: 'TOK_Y' },
    { ...CASE_ROWS[0]!, id: 3, member_id_bidx: 'TOK_X' },
    { ...CASE_ROWS[0]!, id: 4, member_id_bidx: null },
    { ...CASE_ROWS[0]!, id: 5, member_id_bidx: null },
  ];
  const res = await getQualifyFacilityCasesCore(
    makeDeps(SUPER, cap(), { loadFacilityCases: async () => rows }),
    FAC_CASES_IN,
  );
  const keys = res.claims.map((cl) => cl.patientKey);
  assert.equal(keys[0], keys[2], 'same bidx → same per-response patientKey (the grouping key)');
  assert.notEqual(keys[0], keys[1], 'different bidx → different key');
  assert.notEqual(keys[3], keys[4], 'null-bidx rows are singletons — never merged into a fake patient');
  const wire = JSON.stringify(res);
  assert.ok(
    !wire.includes('TOK_X') && !wire.includes('TOK_Y') && !wire.includes('member_id_bidx'),
    'the opaque token AND its field name never reach the client',
  );
});

// ── Phase 3: the patient-cohort core (audit → token re-derivation → floor gate → dollar strip) ───────
test('patient-cohort: audits BEFORE data, re-derives the token server-side, returns the lifetime context', async () => {
  const c = cap();
  const res = await getQualifyPatientCohortCore(makeDeps(SUPER, c), {
    payer: 'AETNA', facility: '405 recovery', windowDays: 30, claimId: 123,
  });
  assert.equal(res.suppressed, false);
  assert.equal(res.patients, 12);
  assert.equal(res.pctAllowed, 40, 'lifetime allowed/billed from the raw sums');
  assert.equal(res.pctPaid, 75);
  assert.equal(res.pctCollected, 30);
  assert.equal(res.byPayer[0]!.charge, 60000, 'amounts viewer keeps mix dollars');
  const audit = c.audits.find((a) => a.action === SEARCH_QUALIFY_COHORT)!;
  assert.equal(audit.detail.claimId, 123, 'audited with the synthetic claim id (non-PHI)');
  assert.ok(!JSON.stringify(res).includes('PREFIX_TOKEN_X'), 'the cohort token never reaches the wire');
});

test('patient-cohort: admissions_seat gets counts + pcts but ZERO dollars (mix charge nulled)', async () => {
  const res = await getQualifyPatientCohortCore(makeDeps(SEAT, cap()), {
    payer: 'AETNA', facility: '405 recovery', windowDays: 30, claimId: 123,
  });
  assert.equal(res.suppressed, false);
  assert.equal(res.pctAllowed, 40, 'pcts survive the strip');
  assert.equal(res.byPayer[0]!.charge, null, 'mix dollars stripped');
  assert.equal(res.byCpt[0]!.charge, null);
  const wire = JSON.stringify(res);
  for (const v of [100000, 40000, 30000, 60000]) assert.ok(!wire.includes(String(v)), `dollar ${v} absent`);
});

test('patient-cohort: unknown/foreign claim id AND a below-floor cohort BOTH collapse to the SAME suppressed shape', async () => {
  const foreign = await getQualifyPatientCohortCore(makeDeps(SUPER, cap()), {
    payer: 'AETNA', facility: '405 recovery', windowDays: 30, claimId: 999, // loadClaimPrefixToken fake → null
  });
  const thin = await getQualifyPatientCohortCore(
    makeDeps(SUPER, cap(), { loadPatientCohort: async () => null }),
    { payer: 'AETNA', facility: '405 recovery', windowDays: 30, claimId: 123 },
  );
  for (const r of [foreign, thin]) {
    assert.equal(r.suppressed, true);
    assert.equal(r.patients, null);
    assert.deepEqual(r.byPayer, []);
  }
  assert.deepEqual({ ...foreign, viewerHasAmountsCapability: true }, { ...thin, viewerHasAmountsCapability: true },
    'no oracle: "not yours" is indistinguishable from "too small"');
  const bad = await getQualifyPatientCohortCore(makeDeps(SUPER, cap()), {
    payer: 'AETNA', facility: '405 recovery', windowDays: 30, claimId: -1,
  });
  assert.equal(bad.suppressed, true, 'malformed id fails closed without reaching any loader');
});

// ── Redesign overview cores: book KPIs, facility trend (entity label + delta), the on-load hybrid ────
test('book KPIs core: returns the three ratios + window; runs for an admissions_seat (no dollars anywhere)', async () => {
  const kpis = await getQualifyBookKpisCore(makeDeps(SEAT, cap()), 30);
  assert.equal(kpis.pctAllowedOfBilled, 44);
  assert.equal(kpis.pctPaidOfAllowed, 82);
  assert.equal(kpis.pctPaidOfBilled, 36);
  assert.ok(kpis.windowStart && kpis.windowEnd, 'window bounds attached');
  assert.equal(kpis.tenantScope, 'cross-tenant-bxr-indigo');
  // The KPIs are percentages only — the shape carries no dollar field to strip.
  assert.ok(!('billed' in kpis) && !('allowed' in kpis), 'no raw dollar fields on the KPI contract');
});

test('facility trend core: maps entity label + computes deltaPts; a null-prior facility gets a null delta (NEW)', async () => {
  const trends = await getQualifyFacilityTrendsCore(makeDeps(SUPER, cap()), 30);
  const solid = trends.find((t) => t.facilityKey === '405 recovery')!;
  assert.equal(solid.entity, 'Indigo', 'entity_ids [Indigo uuid] → Indigo label');
  assert.equal(solid.currentRating, 55);
  assert.equal(solid.priorRating, 40);
  assert.equal(solid.deltaPts, 15, 'delta = current - prior');
  assert.equal(solid.dominantPayer, 'AETNA');
  assert.deepEqual(solid.points, [40, 45, 50, 55], 'sparkline points passed through');
  const newFac = trends.find((t) => t.facilityKey === 'ca mental health')!;
  assert.equal(newFac.entity, 'BXR', 'entity_ids [BXR uuid] → BXR label');
  assert.equal(newFac.priorRating, null);
  assert.equal(newFac.deltaPts, null, 'no prior evidence → null delta (a NEW facility)');
});

test('overview core (hybrid): resolves the top trend facility’s dominant payer AND seeds THAT facility, not rank-1', async () => {
  const c = cap();
  const ov = await getQualifyOverviewCore(makeDeps(SUPER, c), 30);
  assert.equal(ov.kpis.pctAllowedOfBilled, 44, 'KPIs included');
  assert.equal(ov.trends.length, 2, 'trends included');
  assert.equal(ov.topPayer, 'AETNA', 'resolved the top trend facility’s dominant payer');
  // '405 recovery' is trends[0] and ranks under AETNA (FAC_ROWS), so the hybrid focuses IT (not the
  // rating rank-1 'ca mental health'), and seeds its cases.
  assert.equal(ov.topFacility, '405 recovery');
  assert.equal(ov.seedFacility, '405 recovery');
  assert.equal(ov.seedCases.length, 1, 'seed cases loaded for the focused facility');
  const seededDrill = c.facilityCasesArgs.at(-1)!;
  assert.equal(seededDrill.facility, '405 recovery', 'the drill was scoped to the trend facility');
  // The overview composes the resolve-by-payer + facility-drill cores, so their audits fire.
  assert.ok(c.audits.some((a) => a.action === SEARCH_QUALIFY_PAYER), 'resolve-by-payer audited');
  assert.ok(c.audits.some((a) => a.action === SEARCH_QUALIFY_FACILITY), 'facility drill audited');
});

test('overview core: an empty book (no trends) returns KPIs + empty trends + a null snapshot (prompt state)', async () => {
  const ov = await getQualifyOverviewCore(makeDeps(SUPER, cap(), { loadFacilityTrends: async () => [] }), 30);
  assert.deepEqual(ov.trends, []);
  assert.equal(ov.snapshot, null);
  assert.equal(ov.topFacility, null);
  assert.equal(ov.seedCases.length, 0);
  assert.ok(ov.kpis, 'KPIs still returned even with no trending facilities');
});
