import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  getQualifyFacilityCasesCore,
  getQualifyMoversCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  SEARCH_QUALIFY_PHI,
  SEARCH_QUALIFY_PAYER,
  SEARCH_QUALIFY_FACILITY,
  REVEAL_QUALIFY_ROW,
  REVEAL_QUALIFY_ROWS,
  type QualifyDeps,
} from '../app/lib/qualify/core.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
import { QUALIFY_MIN_LINES } from '../app/lib/qualify/rating.js';
import { qualifyWindowBounds } from '../app/lib/qualify/contract.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../app/lib/views.js';

// Sentinel DOLLAR values — distinctive so a wire-level scan can prove they never appear when stripped.
const B1 = 999999.99, A1 = 888888.88; // thin/high-pct facility (BXR)
const B2 = 777777.77, A2 = 666666.66; // solid/mid-pct facility (Indigo)
const CB = 555555.55, CA = 444444.44; // a case's dollars

const FAC_ROWS = [
  { facility: 'ca mental health', facility_name: 'CA MENTAL HEALTH', facility_code: 'CAMH', line_count: 3, billed: B1, allowed: A1, pct_allowed: 60 }, // BXR, thin high pct
  { facility: '405 recovery', facility_name: '405 RECOVERY', facility_code: '10026460', line_count: 400, billed: B2, allowed: A2, pct_allowed: 55 }, // Indigo, solid mid pct
];
const CASE_ROWS = [
  { id: 123, facility: '405 recovery', facility_name: '405 RECOVERY', program: 'OP' as const, last_dos: '2026-07-01', pct_allowed: 80, billed: CB, allowed: CA },
];
const MOVER_ROWS = [
  { primary_payer: 'AETNA', this_patients: 40, prior_patients: 10, delta_patients: 30 },
  { primary_payer: 'CIGNA', this_patients: 8, prior_patients: 0, delta_patients: 8 },
];
const REVEAL_PHI = { patient_name: 'DOE, JANE', member_id_raw: 'AETMEMBER123', group_number: 'GRP9' };

interface Cap {
  audits: Array<{ action: string; detail: Record<string, unknown> }>;
  facilityEntityIds: string[][];
  revealActions: string[];
  facilityCasesArgs: Array<{ payer: string; facility: string; entityIds: string[] }>;
}
function cap(): Cap {
  return { audits: [], facilityEntityIds: [], revealActions: [], facilityCasesArgs: [] };
}

const SUPER = () => requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 's@t.ai', id: 's' }, role: 'super_admin' } });
const SEAT = () => requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'a@t.ai', id: 'a' }, role: 'admissions_seat' } });
const ADMIN = () => requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'x@t.ai', id: 'x' }, role: 'admin' } });

function makeDeps(principal: () => ReturnType<typeof SUPER>, c: Cap, over: Partial<QualifyDeps> = {}): QualifyDeps {
  return {
    requirePrincipal: async () => principal(),
    mintToken: () => 'HMAC_TOKEN', // never the raw query
    resolvePayer: async () => 'AETNA',
    loadFacilities: async (_p, _f, _t, entityIds) => {
      c.facilityEntityIds.push(entityIds);
      return FAC_ROWS;
    },
    loadCases: async () => CASE_ROWS,
    loadFacilityCases: async (payer, facility, _f, _t, entityIds) => {
      c.facilityCasesArgs.push({ payer, facility, entityIds });
      return CASE_ROWS;
    },
    loadMovers: async () => MOVER_ROWS,
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
      { facility: 'fluke', facility_name: 'FLUKE 100%', facility_code: null, line_count: QUALIFY_MIN_LINES - 1, billed: 100, allowed: 100, pct_allowed: 100 },
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
  for (const cse of snap.cases) {
    assert.equal(cse.billedAmount, null);
    assert.equal(cse.allowedAmount, null);
  }
  const wire = JSON.stringify(snap);
  for (const v of [B1, A1, B2, A2, CB, CA]) {
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
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, c, { mintToken: () => null }), { query: 'ab', windowDays: 7 });
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
  for (const v of [B1, A1, B2, A2, CB, CA]) {
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
  assert.ok(res.cases.length > 0);
  for (const c of res.cases) assert.equal(c.memberIdMasked, '••••••');
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
  for (const c of res.cases) {
    assert.equal(c.billedAmount, null);
    assert.equal(c.allowedAmount, null);
  }
  assert.equal(res.viewerHasAmountsCapability, false);
});

test('facility-drill: a blank payer or facility → empty cases and NO audit (nothing looked up)', async () => {
  const c = cap();
  const a = await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { payer: '  ', facility: 'x', windowDays: 30 });
  const b = await getQualifyFacilityCasesCore(makeDeps(SUPER, c), { payer: 'AETNA', facility: '  ', windowDays: 30 });
  assert.deepEqual(a.cases, []);
  assert.deepEqual(b.cases, []);
  assert.equal(c.audits.length, 0);
  assert.equal(c.facilityCasesArgs.length, 0);
});

test('facility-drill: an entity admin is denied fail-closed', async () => {
  await assert.rejects(
    () => getQualifyFacilityCasesCore(makeDeps(ADMIN, cap()), FAC_CASES_IN),
    /does not have access to Qualify/,
  );
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
