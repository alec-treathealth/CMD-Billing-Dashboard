/**
 * Payer Intel core RBAC + orchestration — the qualifyCore.test.ts discipline: mint a principal
 * per role via the PURE policy, feed fake loaders DISTINCTIVE sentinel dollars, then wire-scan
 * JSON.stringify of the payload. An admissions_seat must receive ZERO sentinels (and
 * viewerHasAmountsCapability:false) on EVERY new endpoint; a capable seat must receive them all —
 * the negative twin is what keeps the positive from going vacuously green.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requirePayerIntelPrincipalFromAccess } from '../app/lib/payer-intel/principal.js';
import {
  buildPayerIntelAiPayloadCore,
  classifyPayerIntelTerm,
  derivePlacementFlags,
  getPayerIntelBoardCore,
  runPayerIntelSearchCore,
  togglePayerIntelStarCore,
  watchPayerIntelSubjectCore,
  type PayerIntelDeps,
} from '../app/lib/payer-intel/core.js';
import type { PayerIntelPlacementItem } from '../app/lib/payer-intel/contract.js';

// ── Principals (pure policy — no auth, no DB) ────────────────────────────────────────────────────

const SEAT = () =>
  requirePayerIntelPrincipalFromAccess({
    ok: true,
    access: { user: { email: 'seat@t.ai', id: 'seat-1' }, role: 'admissions_seat' },
  });
const SUPER = () =>
  requirePayerIntelPrincipalFromAccess({
    ok: true,
    access: { user: { email: 'admin@t.ai', id: 'super-1' }, role: 'super_admin' },
  });

test('principal: entity admin/user and the no-auth fallback are denied fail-closed', () => {
  for (const role of ['admin', 'user', 'anything']) {
    const p = requirePayerIntelPrincipalFromAccess({
      ok: true,
      access: { user: { email: 'x@t.ai', id: 'x' }, role },
    });
    assert.equal(p.ok, false);
  }
  assert.equal(
    requirePayerIntelPrincipalFromAccess({ ok: true, access: { user: null, role: 'super_admin' } }).ok,
    false,
  );
  assert.equal(requirePayerIntelPrincipalFromAccess({ ok: false, reason: 'unauthenticated' }).ok, false);
});

test('principal: hasAmounts is false for admissions_seat and true for super_admin — decided ONLY here', () => {
  const seat = SEAT();
  const sup = SUPER();
  assert.ok(seat.ok && !seat.hasAmounts);
  assert.ok(sup.ok && sup.hasAmounts);
});

// ── Sentinel dollars (distinctive — a wire scan cannot pass vacuously) ───────────────────────────

const BILLED_TOTAL = 999999.99;
const BILLED_DECLINER = 888888.88;
const BILLED_PLACEMENT = 777777.77;
const PAID_PER_PATIENT = 666666.66;
const CHARGE_COMBO = 555555.55;
const SENTINELS = [BILLED_TOTAL, BILLED_DECLINER, BILLED_PLACEMENT, PAID_PER_PATIENT, CHARGE_COMBO];

interface Cap {
  events: string[];
  recorded: { payer: string | null; echo: string | null; entityType: string | null; resolved: boolean | null }[];
  auditDetails: Record<string, unknown>[];
}

function makeDeps(principal: () => ReturnType<typeof SEAT>, over?: Partial<PayerIntelDeps>): { deps: PayerIntelDeps; cap: Cap } {
  const cap: Cap = { events: [], recorded: [], auditDetails: [] };
  const deps: PayerIntelDeps = {
    requirePrincipal: async () => principal(),
    loadGainers: async () => [
      {
        member_id_prefix_bidx: 'a'.repeat(64),
        token_tail: 'abcdef',
        echo: 'W29',
        primary_payer: 'AETNA',
        rating_now: 45,
        band_now: '30',
        rating_then: 41,
        delta_pts: 4,
        distinct_members: 12,
        line_count: 88,
        window_days: 90,
        as_of: '2026-08-16',
      },
    ],
    loadDecliners: async () => [
      {
        facility: 'MHC SAN DIEGO',
        facility_code: '10024431',
        care_setting: 'IP',
        pct_current: 22.4,
        pct_prior: 31.8,
        delta_pts: -9.4,
        line_count: 340,
        distinct_members: 41,
        billed_current: BILLED_DECLINER,
      },
    ],
    loadCensus: async () => [
      {
        facility_code: 'LSMH',
        board_family: 'residential',
        admitted_count: 11,
        open_beds: 1,
        bed_capacity: 12,
        synced_at: '2026-08-17T16:40:00Z',
      },
      {
        facility_code: 'TREAT_CA',
        board_family: 'outpatient',
        admitted_count: 51,
        open_beds: 0,
        bed_capacity: null,
        synced_at: '2026-08-17T16:40:00Z',
      },
    ],
    loadFacilityNames: async () => [
      { facility_code: 'LSMH', facility_name: 'Lonestar Mental Health', care_setting: 'IP' },
      { facility_code: 'TREAT_CA', facility_name: 'Treat MH California', care_setting: 'OP' },
    ],
    loadSavedSearches: async () => [
      {
        id: '15',
        payer_label: 'AETNA',
        prefix_echo: 'W29',
        plan_class: null,
        entity_type: 'prefix',
        resolved: true,
        starred: true,
        searched_at: '2026-08-14T18:23:00Z',
      },
    ],
    loadAggregates: async () => {
      cap.events.push('aggregates');
      return {
        totals: { total_count: 558, total_charge: BILLED_TOTAL, total_allowed: 700000, total_paid: 550000 },
        distinctMembers: 96,
        placement: [
          {
            facility: 'Lonestar Mental Health',
            facility_code: 'LSMH',
            care_setting: 'IP',
            line_count: 61,
            distinct_members: 9,
            pct_collected: 41.6,
            paid_per_patient: PAID_PER_PATIENT,
            billed: BILLED_PLACEMENT,
          },
        ],
        combos: [
          {
            cpt: 'H0017',
            revenue: '0158',
            count: 84,
            charge: CHARGE_COMBO,
            pct_allowed: 48.6,
            pct_paid: 70.2,
            pct_zero_paid: 4.8,
          },
        ],
      };
    },
    loadPayerGroups: async () => [{ label: 'AETNA', count: 500 }],
    loadRating: async () => ({ rating: 45, as_of: '2026-08-16', rating_then: 41 }),
    loadPayerVocabulary: async () => ['AETNA', 'AETNA BETTER HEALTH', 'CIGNA'],
    alphaPrefixToken: (raw) => `tok-${raw}`.padEnd(64, '0'),
    groupNumberToken: (raw) => `grp-${raw}`.padEnd(64, '0'),
    recordAccess: async (entry) => {
      cap.events.push('audit');
      cap.auditDetails.push(entry.detail ?? {});
      return 'audit-1';
    },
    recordSearch: async (args) => {
      cap.events.push('record');
      cap.recorded.push({ payer: args.payer, echo: args.echo, entityType: args.entityType, resolved: args.resolved });
      return { persisted: true };
    },
    setStarred: async () => ({ persisted: true, found: true }),
    clearSearches: async () => ({ persisted: true }),
    saveWatcher: async () => ({ persisted: true }),
    loadCohortCurve: async () => ({
      byPosition: [{ bucket: 1, patients: 96, claims: 200, pct_allowed: 41.2, pct_paid: 78.6, pct_zero_paid: 4.8 }],
      byDays: [{ bucket: 30, patients: 80, claims: 150, pct_allowed: 40.1, pct_paid: 77.2, pct_zero_paid: 5.1 }],
    }),
    cohortMinPatients: 5,
    today: () => '2026-08-17',
    windowDays: 90,
    ...over,
  };
  return { deps, cap };
}

// ── Board RBAC ───────────────────────────────────────────────────────────────────────────────────

test('board: an admissions_seat receives ZERO dollar sentinels on the wire', async () => {
  const { deps } = makeDeps(SEAT);
  const board = await getPayerIntelBoardCore(deps);
  assert.equal(board.viewerHasAmountsCapability, false);
  assert.equal(board.decliners.items[0]?.billedCurrent, null);
  const wire = JSON.stringify(board);
  for (const s of SENTINELS) assert.ok(!wire.includes(String(s)), `sentinel ${s} leaked to a blind session`);
  // Ratios and counts SURVIVE the strip — do not "fix" a leak by stripping these.
  assert.equal(board.decliners.items[0]?.pctCurrent, 22.4);
  assert.equal(board.decliners.items[0]?.lineCount, 340);
});

test('board: a capable viewer carries the decliner dollars', async () => {
  const { deps } = makeDeps(SUPER);
  const board = await getPayerIntelBoardCore(deps);
  assert.equal(board.viewerHasAmountsCapability, true);
  assert.equal(board.decliners.items[0]?.billedCurrent, BILLED_DECLINER);
  assert.ok(JSON.stringify(board).includes(String(BILLED_DECLINER)));
});

test('board: census semantics — outpatient rows carry NO bed fields, residential derives occupancy', async () => {
  const { deps } = makeDeps(SUPER);
  const board = await getPayerIntelBoardCore(deps);
  const lsmh = board.census.rows.find((r) => r.facilityCode === 'LSMH');
  const op = board.census.rows.find((r) => r.facilityCode === 'TREAT_CA');
  assert.ok(lsmh && op);
  assert.equal(lsmh.occupancyPct, 92); // 11 of 12
  assert.equal(lsmh.status, 'open');
  assert.equal(op.openBeds, null); // stored 0 means N/A — nulled so no renderer can misread it
  assert.equal(op.bedCapacity, null);
  assert.equal(op.occupancyPct, null);
  // Pending admits are not stored anywhere — the typed seam stays null.
  assert.ok(board.census.rows.every((r) => r.pendingAdmits === null));
});

// ── Search RBAC + orchestration ──────────────────────────────────────────────────────────────────

test('search: an admissions_seat receives ZERO dollar sentinels — totals, placement, combos', async () => {
  const { deps } = makeDeps(SEAT);
  const result = await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  assert.equal(result.viewerHasAmountsCapability, false);
  assert.equal(result.totals.billed, null);
  assert.equal(result.placement[0]?.paidPerPatient, null);
  assert.equal(result.placement[0]?.billed, null);
  assert.equal(result.combos[0]?.charge, null);
  const wire = JSON.stringify(result);
  for (const s of SENTINELS) assert.ok(!wire.includes(String(s)), `sentinel ${s} leaked to a blind session`);
  // Derived ratios and counts survive.
  assert.equal(result.totals.lineCount, 558);
  assert.equal(result.totals.distinctMembers, 96);
  assert.equal(result.yieldPct.pct_collected, 55); // 550000/999999.99 → 55.00
  assert.equal(result.combos[0]?.pctPaid, 70.2);
});

test('search: a capable viewer carries every dollar', async () => {
  const { deps } = makeDeps(SUPER);
  const result = await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  assert.equal(result.totals.billed, BILLED_TOTAL);
  assert.equal(result.placement[0]?.paidPerPatient, PAID_PER_PATIENT);
  assert.equal(result.combos[0]?.charge, CHARGE_COMBO);
});

test('search: a PHI-tokened term AUDITS BEFORE any aggregate read, with field NAMES only', async () => {
  const { deps, cap } = makeDeps(SUPER);
  await runPayerIntelSearchCore(deps, { term: 'W29' });
  assert.ok(cap.events.indexOf('audit') < cap.events.indexOf('aggregates'), 'audit must precede data');
  const detail = JSON.stringify(cap.auditDetails);
  assert.ok(detail.includes('alpha_prefix'));
  assert.ok(!detail.includes('W29'), 'the raw term must never reach the audit detail');
});

test('search: a payer-only search performs NO PHI audit', async () => {
  const { deps, cap } = makeDeps(SUPER);
  await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  assert.ok(!cap.events.includes('audit'));
});

test('search: an unresolvable term short-circuits to a ZERO result — no aggregate query runs', async () => {
  const { deps, cap } = makeDeps(SUPER);
  const result = await runPayerIntelSearchCore(deps, { term: 'zzzzzz unresolvable' });
  assert.equal(result.totals.lineCount, 0);
  assert.equal(result.placement.length, 0);
  assert.equal(result.resolved, false);
  assert.ok(!cap.events.includes('aggregates'), 'a matched-nothing search must not widen to the book');
});

test('search: a prefix search resolves its payer and records the search with resolved:true', async () => {
  const { deps, cap } = makeDeps(SUPER);
  const result = await runPayerIntelSearchCore(deps, { term: 'W29' });
  assert.equal(result.facets.payer, 'AETNA');
  assert.equal(result.resolved, true);
  assert.equal(result.rating.subject, 'pair');
  assert.equal(result.rating.deltaPts, 4);
  assert.deepEqual(cap.recorded, [{ payer: 'AETNA', echo: 'W29', entityType: 'prefix', resolved: true }]);
});

test('search: a group-number term is masked on the wire and never echoed raw', async () => {
  const { deps } = makeDeps(SUPER);
  const result = await runPayerIntelSearchCore(deps, { term: '0084217' });
  assert.equal(result.facets.groupNumberMasked, '•••• 4217');
  assert.ok(!JSON.stringify(result).includes('0084217'), 'the raw group number must not cross the wire');
});

test('search: a recordSearch failure never costs the search itself', async () => {
  const { deps } = makeDeps(SUPER, {
    recordSearch: async () => {
      throw Object.assign(new Error('down'), { code: '57P01' });
    },
  });
  const result = await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  assert.equal(result.totals.lineCount, 558);
});

// ── Term classification ──────────────────────────────────────────────────────────────────────────

test('classify: 3 alnum chars with a letter → prefix; 5+ digits → group; pure 3 digits → neither', () => {
  const vocab = ['AETNA', 'AETNA BETTER HEALTH'];
  assert.deepEqual(classifyPayerIntelTerm('w29', vocab), { kind: 'prefix', value: 'W29' });
  assert.deepEqual(classifyPayerIntelTerm('0084217', vocab), { kind: 'group', value: '0084217' });
  assert.equal(classifyPayerIntelTerm('123', vocab).kind, 'unknown');
});

test('classify: payer exact beats contains; contains picks the SHORTEST hit; no match → unknown', () => {
  const vocab = ['AETNA BETTER HEALTH', 'AETNA'];
  assert.deepEqual(classifyPayerIntelTerm('aetna', vocab), { kind: 'payer', value: 'AETNA' });
  assert.deepEqual(classifyPayerIntelTerm('better', vocab), { kind: 'payer', value: 'AETNA BETTER HEALTH' });
  assert.equal(classifyPayerIntelTerm('nonexistent payer co', vocab).kind, 'unknown');
});

// ── AI payload assembly ──────────────────────────────────────────────────────────────────────────

test('ai payload: an admissions_seat payload carries NULL dollars by construction', async () => {
  const { deps } = makeDeps(SEAT);
  const out = await buildPayerIntelAiPayloadCore(deps, { term: 'W29' });
  assert.ok(out.ok);
  const totals = out.payload.totals as { billed: number | null };
  assert.equal(totals.billed, null);
  const combos = out.payload.cpt_rev as { charge: number | null }[];
  assert.ok(combos.every((c) => c.charge === null));
  const wire = JSON.stringify(out.payload);
  for (const s of SENTINELS) assert.ok(!wire.includes(String(s)), `sentinel ${s} reached a blind AI payload`);
});

test('ai payload: a capable viewer carries dollars, the cohort curve, and prior_run', async () => {
  const { deps } = makeDeps(SUPER);
  const out = await buildPayerIntelAiPayloadCore(deps, { term: 'W29' });
  assert.ok(out.ok);
  assert.equal((out.payload.totals as { billed: number | null }).billed, BILLED_TOTAL);
  assert.ok(Array.isArray(out.payload.by_visit));
  assert.equal((out.payload.prior_run as { rating: number }).rating, 41);
  assert.equal((out.payload.search_context as { resolution: string }).resolution, 'resolved');
});

test('ai payload: zero matched lines → insufficient', async () => {
  const { deps } = makeDeps(SUPER, {
    loadAggregates: async () => ({
      totals: { total_count: 0, total_charge: 0, total_allowed: 0, total_paid: 0 },
      distinctMembers: 0,
      placement: [],
      combos: [],
    }),
  });
  const out = await buildPayerIntelAiPayloadCore(deps, { payer: 'AETNA' });
  assert.deepEqual(out, { ok: false, reason: 'insufficient' });
});

// ── Star toggle + watch cores ────────────────────────────────────────────────────────────────────

test('star toggle: a non-numeric id is invalid (bigint arrives as a STRING from node-pg)', async () => {
  const { deps } = makeDeps(SUPER);
  assert.deepEqual(await togglePayerIntelStarCore(deps, 'DROP TABLE', true), { ok: false, reason: 'invalid' });
});

test('star toggle: the 12-star definer cap maps to a typed limit reason', async () => {
  const { deps } = makeDeps(SUPER, {
    setStarred: async () => {
      throw new Error('set_qualify_search_starred: starred limit reached (12)');
    },
  });
  assert.deepEqual(await togglePayerIntelStarCore(deps, '15', true), { ok: false, reason: 'limit' });
});

test('star toggle: a row that is not yours reports invalid, never success', async () => {
  const { deps } = makeDeps(SUPER, { setStarred: async () => ({ persisted: true, found: false }) });
  assert.deepEqual(await togglePayerIntelStarCore(deps, '15', true), { ok: false, reason: 'invalid' });
});

test('watch: saves a trend watcher with the prefix token when a valid prefix rides along', async () => {
  const captured: { payer: string; token: string | null }[] = [];
  const { deps } = makeDeps(SUPER, {
    saveWatcher: async (args) => {
      captured.push({ payer: args.payer, token: args.token });
      return { persisted: true };
    },
  });
  const res = await watchPayerIntelSubjectCore(deps, 'AETNA', 'W29');
  assert.deepEqual(res, { ok: true, persisted: true });
  assert.equal(captured[0]?.payer, 'AETNA');
  assert.ok(captured[0]?.token?.startsWith('tok-W29'));
});

// ── Placement flags ──────────────────────────────────────────────────────────────────────────────

test('placement flags: best-yield-full and open-beds-worst-yield light up exactly once each', () => {
  const base: Omit<PayerIntelPlacementItem, 'facility' | 'pctCollected' | 'openBeds'> = {
    facilityCode: null,
    careSetting: null,
    lineCount: 50,
    distinctMembers: 10,
    paidPerPatient: null,
    billed: null,
    bedCapacity: null,
    pendingAdmits: null,
    censusSyncedAt: null,
    flag: null,
  };
  const flagged = derivePlacementFlags([
    { ...base, facility: 'Best', pctCollected: 41.6, openBeds: 0 },
    { ...base, facility: 'Mid', pctCollected: 34.7, openBeds: 3 },
    { ...base, facility: 'Worst', pctCollected: 22.8, openBeds: 4 },
  ]);
  assert.equal(flagged.find((p) => p.facility === 'Best')?.flag, 'best_yield_full');
  assert.equal(flagged.find((p) => p.facility === 'Worst')?.flag, 'open_beds_worst_yield');
  assert.equal(flagged.find((p) => p.facility === 'Mid')?.flag, null);
});

test('placement flags: fewer than two rated rows means no flags at all', () => {
  const one: PayerIntelPlacementItem = {
    facility: 'Only',
    facilityCode: null,
    careSetting: null,
    lineCount: 5,
    distinctMembers: 2,
    pctCollected: 30,
    paidPerPatient: null,
    billed: null,
    openBeds: 0,
    bedCapacity: null,
    pendingAdmits: null,
    censusSyncedAt: null,
    flag: null,
  };
  assert.ok(derivePlacementFlags([one]).every((p) => p.flag === null));
});
