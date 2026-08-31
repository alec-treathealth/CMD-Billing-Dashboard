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
  getPayerIntelGridCore,
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
const CHARGE_GROUP = 444444.44;
const GRID_CHARGE_STR = '333333.33';
const SENTINELS = [BILLED_TOTAL, BILLED_DECLINER, BILLED_PLACEMENT, PAID_PER_PATIENT, CHARGE_COMBO, CHARGE_GROUP];

interface Cap {
  events: string[];
  recorded: { payer: string | null; echo: string | null; entityType: string | null; resolved: boolean | null }[];
  auditDetails: Record<string, unknown>[];
  /** Every filter the aggregate loader saw — the window assertions read from/to off these. */
  filters: { from?: string | null; to?: string | null }[];
  railWindows: number[];
}

function makeDeps(principal: () => ReturnType<typeof SEAT>, over?: Partial<PayerIntelDeps>): { deps: PayerIntelDeps; cap: Cap } {
  const cap: Cap = { events: [], recorded: [], auditDetails: [], filters: [], railWindows: [] };
  const deps: PayerIntelDeps = {
    requirePrincipal: async () => principal(),
    loadGainers: async (deltaDays) => {
      cap.railWindows.push(deltaDays);
      return [
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
      ];
    },
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
    loadAggregates: async (filter) => {
      cap.events.push('aggregates');
      cap.filters.push({ from: filter.from, to: filter.to });
      return {
        totals: { total_count: 558, total_charge: BILLED_TOTAL, total_allowed: 700000, total_paid: 550000 },
        distinctMembers: 96,
        placement: [
          {
            facility: 'Lonestar Mental Health',
            facility_code: 'LSMH',
            care_setting: 'IP' as const,
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
        byPayer: [{ label: 'AETNA', count: 500, charge: CHARGE_GROUP }],
        byFacility: [{ label: 'LONESTAR MENTAL HEALTH LLC', count: 61, charge: CHARGE_GROUP }],
      };
    },
    loadGridRows: async () => ({
      rows: [
        {
          id: 15,
          charge_date: '2026-07-21',
          payment_received: '2026-08-18',
          cpt_code: 'H0035',
          revenue_code: '0913',
          facility: 'LONESTAR MENTAL HEALTH LLC',
          // CMD named this facility, so 0086 never covers the row: both fields are null, and they
          // are null rather than absent so a `!== null` guard cannot take the resolved branch.
          facility_resolved: null,
          facility_method: null,
          // Payer Intel does not resolve a business day, so nothing is ever flagged scheduled here.
          is_scheduled: false,
          charge_amount: GRID_CHARGE_STR,
          allowed_amount: '1041.00',
          insurance_payments: '900.00',
          adjustments: null,
          patient_balance_due: '0.00',
          primary_payer: 'AETNA',
          pct_allowed: '20.06',
          pct_paid: '86.45',
          ingested_at: '2026-08-18T01:00:00Z',
          employer_name: 'VANDERBILT UMC',
        },
      ],
      nextCursor: { id: 15, value: '2026-08-18' },
    }),
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
      byPayer: [],
      byFacility: [],
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

// ── v1.1: window facet, drill groups, charge-line grid (the 2026-08-17 review items) ─────────────

test('window: the recency facet scopes the FILTER — 30d → from today-29, to today+1 (exclusive)', async () => {
  const { deps, cap } = makeDeps(SUPER);
  const result = await runPayerIntelSearchCore(deps, { payer: 'AETNA', windowDays: 30 });
  assert.deepEqual(cap.filters[0], { from: '2026-07-19', to: '2026-08-18' });
  assert.deepEqual(result.window, { from: '2026-07-19', to: '2026-08-18', days: 30 });
});

test('window: an off-menu value clamps to the 90d default', async () => {
  const { deps } = makeDeps(SUPER);
  const result = await runPayerIntelSearchCore(deps, { payer: 'AETNA', windowDays: 45 });
  assert.equal(result.window.days, 90);
});

test('window: the board rails take the toggle too — gainers delta horizon follows it', async () => {
  const { deps, cap } = makeDeps(SUPER);
  await getPayerIntelBoardCore(deps, { windowDays: 14 });
  assert.deepEqual(cap.railWindows, [14]);
});

test('drill groups: an admissions_seat gets counts but NO group dollars; a capable viewer gets both', async () => {
  const seat = await runPayerIntelSearchCore(makeDeps(SEAT).deps, { payer: 'AETNA' });
  assert.equal(seat.byPayer[0]?.count, 500);
  assert.equal(seat.byPayer[0]?.charge, null);
  assert.equal(seat.byFacility[0]?.charge, null);
  assert.ok(!JSON.stringify(seat).includes(String(CHARGE_GROUP)));
  const sup = await runPayerIntelSearchCore(makeDeps(SUPER).deps, { payer: 'AETNA' });
  assert.equal(sup.byPayer[0]?.charge, CHARGE_GROUP);
});

test('grid: an admissions_seat gets rows with NULL dollar strings while ratios and labels survive', async () => {
  const { deps } = makeDeps(SEAT);
  const page = await getPayerIntelGridCore(deps, { payer: 'AETNA' }, null);
  const row = page.rows[0];
  assert.ok(row);
  assert.equal(row.chargeAmount, null);
  assert.equal(row.allowedAmount, null);
  assert.equal(row.insurancePayments, null);
  assert.equal(row.patientBalanceDue, null);
  assert.equal(row.pctAllowed, '20.06'); // ratios survive the strip
  assert.equal(row.payer, 'AETNA');
  assert.equal(row.employerName, 'VANDERBILT UMC');
  assert.ok(!JSON.stringify(page).includes(GRID_CHARGE_STR));
});

test('grid: a capable viewer gets the dollar strings and the keyset cursor rides through', async () => {
  const { deps } = makeDeps(SUPER);
  const page = await getPayerIntelGridCore(deps, { payer: 'AETNA' }, null);
  assert.equal(page.rows[0]?.chargeAmount, GRID_CHARGE_STR);
  assert.deepEqual(page.nextCursor, { id: 15, value: '2026-08-18' });
});

test('grid: an unresolvable term returns an EMPTY page, never the whole book', async () => {
  const { deps } = makeDeps(SUPER);
  const page = await getPayerIntelGridCore(deps, { term: 'zzzzzz unresolvable' }, null);
  assert.deepEqual(page, { rows: [], nextCursor: null });
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

// ── Page 1 of the grid rides the SEARCH, and the census joins the placement table ───────────────

test('search: page 1 of the charge-line grid comes back WITH the result, not on a second hop', async () => {
  // Reported twice as "charge lines will not load". The SQL was never the problem (50ms live as
  // both postgres and claims_reader, zero 5xx logged) — the second Server Action was. Page 1 is
  // part of the search now, so there is no second hop to fail.
  const { deps } = makeDeps(SUPER);
  const r = await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  assert.equal(r.grid.rows.length, 1);
  assert.equal(r.grid.rows[0]?.facility, 'LONESTAR MENTAL HEALTH LLC');
  assert.equal(r.grid.rows[0]?.employerName, 'VANDERBILT UMC');
  assert.deepEqual(r.grid.nextCursor, { id: 15, value: '2026-08-18' });
});

test('search: the embedded grid rides the SAME amounts strip — a blind session gets null dollars', async () => {
  // A second dollar-bearing list that skipped the choke point is exactly how Qualify's
  // bookFacilities leaked. Ratios and labels survive; the sentinel dollar must not appear.
  const { deps } = makeDeps(SEAT);
  const r = await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  const row = r.grid.rows[0];
  assert.equal(row?.chargeAmount, null);
  assert.equal(row?.allowedAmount, null);
  assert.equal(row?.insurancePayments, null);
  assert.equal(row?.pctAllowed, '20.06'); // ratios survive
  assert.ok(!JSON.stringify(r.grid).includes(GRID_CHARGE_STR));
});

test('placement: live census beds join by facility_code — residential lends beds, OP never does', async () => {
  // Reported as "not loading open beds": the placement mapping hardcoded openBeds:null, so the
  // capacity half of "capacity × collectability" was structurally dead — and with it every
  // derivePlacementFlags outcome, since each flag is conditioned on openBeds.
  //
  // The OP row is the other half of the assertion: 0078 stores open_beds = 0 on an outpatient
  // board to mean "beds do not apply", and reading that as "full" is the exact misread the
  // contract exists to prevent, so TREAT_CA must stay null rather than inherit a 0.
  const { deps } = makeDeps(SUPER, {
    loadAggregates: async () => ({
      totals: { total_count: 100, total_charge: 1000, total_allowed: 500, total_paid: 400 },
      distinctMembers: 12,
      placement: [
        {
          facility: 'Lonestar Mental Health',
          facility_code: 'LSMH',
          care_setting: 'IP' as const,
          line_count: 61,
          distinct_members: 9,
          pct_collected: 41.6,
          paid_per_patient: 100,
          billed: 1000,
        },
        {
          facility: 'Treat MH California',
          facility_code: 'TREAT_CA',
          care_setting: 'OP' as const,
          line_count: 40,
          distinct_members: 7,
          pct_collected: 33.1,
          paid_per_patient: 90,
          billed: 900,
        },
      ],
      combos: [],
      byPayer: [],
      byFacility: [],
    }),
  });
  const r = await runPayerIntelSearchCore(deps, { payer: 'AETNA' });
  const lsmh = r.placement.find((p) => p.facilityCode === 'LSMH');
  assert.equal(lsmh?.openBeds, 1);
  assert.equal(lsmh?.bedCapacity, 12);
  assert.equal(lsmh?.censusSyncedAt, '2026-08-17T16:40:00Z');
  // Pending admits stay an honest null everywhere — the Monday sync drops non-admitted statuses
  // before it writes, so there is nothing to join and the renderer shows no column.
  assert.equal(lsmh?.pendingAdmits, null);

  const op = r.placement.find((p) => p.facilityCode === 'TREAT_CA');
  assert.equal(op?.openBeds, null);
  assert.equal(op?.bedCapacity, null);
});
