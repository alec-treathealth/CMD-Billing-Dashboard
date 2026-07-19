import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  getQualifyMoversCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  SEARCH_QUALIFY_PHI,
  SEARCH_QUALIFY_PAYER,
  REVEAL_QUALIFY_ROW,
  REVEAL_QUALIFY_ROWS,
  type QualifyDeps,
} from '../app/lib/qualify/core.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
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
}
function cap(): Cap {
  return { audits: [], facilityEntityIds: [], revealActions: [] };
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

// ── #1 RANK ORDER (silent-bug guard): the ACTION returns facilities in RATING order ──────────────
test('snapshot: a thin high-pct facility sorts BELOW a solid mid-pct one (rating-ordered, not pct)', async () => {
  const snap = await getQualifySnapshotCore(makeDeps(SUPER, cap()), IN);
  assert.equal(snap.facilities[0]!.name, '405 RECOVERY'); // 55%@400 → rating ~52 → rank 1
  assert.equal(snap.facilities[1]!.name, 'CA MENTAL HEALTH'); // 60%@3 → rating ~32 → rank 2
  // The higher RAW pct is the one ranked SECOND — proves the sort is rating, not pctAllowedOfBilled.
  assert.ok((snap.facilities[1]!.pctAllowedOfBilled ?? 0) > (snap.facilities[0]!.pctAllowedOfBilled ?? 0));
  assert.equal(snap.facilities[0]!.rank, 1);
  assert.equal(snap.facilities[1]!.rank, 2);
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
  assert.equal(snap.facilities[0]!.name, '405 RECOVERY'); // rating order preserved (same as PHI path)
  assert.equal(snap.facilities[1]!.name, 'CA MENTAL HEALTH');
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

// ── window math ──────────────────────────────────────────────────────────────────────────────────
test('qualifyWindowBounds: this + prior windows are adjacent, equal-length, non-overlapping', () => {
  const b = qualifyWindowBounds(30, new Date('2026-07-17T00:00:00Z'));
  assert.equal(b.to, '2026-07-18'); // exclusive upper = tomorrow (today included)
  assert.equal(b.from, '2026-06-18'); // 30 days ending today
  assert.equal(b.priorTo, b.from); // adjacent
  assert.equal(b.priorFrom, '2026-05-19'); // prior 30 days
});
