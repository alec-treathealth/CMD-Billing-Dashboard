/**
 * THE CLAIMS DESK'S TENANT SET — a route-scoped surface capability, tested as one.
 *
 * Three separable claims live here, and they fail for different reasons:
 *   1. the offered set is the RBAC entitlement ∩ this screen's planes, and the intersection can
 *      only ever NARROW — a view added here must not become an entitlement;
 *   2. `consolidated` is absent and CLAMPS rather than throwing, because this desk is
 *      entity-scoped and has no cross-tenant plane;
 *   3. a bare `/billing-audit` resolves to BXR, not to `views.ts`'s `consolidated` DEFAULT_VIEW,
 *      which is what made the Billable Days tab unreachable without hand-editing the URL.
 *
 * ⚠ EVERY CLAMP ASSERTION CHECKS THE ABSENCE OF THE UNENTITLED VALUE, not merely the presence
 * of a plausible one. `assert.equal(view, 'bxr')` would pass for a function that ignored its
 * `allowedViews` argument entirely and hardcoded the default — which is precisely the bug that
 * would widen an Indigo admin's scope to BXR.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAIMS_DESK_DEFAULT_VIEW,
  CLAIMS_DESK_VIEWS,
  claimsDeskViews,
  resolveClaimsDeskView,
  urlView,
} from '../lib/billing-audit/views';
import { ALL_VIEWS, DEFAULT_VIEW, type DashboardView } from '../lib/views';

/** The three entitlement shapes `allowedViewsFor` can actually produce (see rbac.ts). */
const SUPER: readonly DashboardView[] = ALL_VIEWS;
const BXR_ONLY: readonly DashboardView[] = ['bxr'];
const INDIGO_ONLY: readonly DashboardView[] = ['indigo'];

test('the desk offers BXR and Indigo only — Consolidated is not on the list', () => {
  assert.deepEqual([...CLAIMS_DESK_VIEWS], ['bxr', 'indigo']);
  assert.equal(
    CLAIMS_DESK_VIEWS.includes('consolidated'),
    false,
    'a cross-tenant tab would promise a screen nobody has specified',
  );
});

test('the route default is BXR, and it deliberately differs from the global DEFAULT_VIEW', () => {
  assert.equal(CLAIMS_DESK_DEFAULT_VIEW, 'bxr');
  // The whole point of the module. If these ever match, the override is pointless and the
  // /dashboard default has silently moved — which would be a change to two other routes.
  assert.notEqual(
    CLAIMS_DESK_DEFAULT_VIEW,
    DEFAULT_VIEW,
    'the route default now equals the global one; either this module is dead or /dashboard moved',
  );
});

test('a super_admin is offered exactly the two tenants, in route order', () => {
  // Order is load-bearing: TenantTabs falls back to allowedViews[0], so a reversed list would
  // light Indigo while the page scoped its data to BXR.
  assert.deepEqual(claimsDeskViews(SUPER), ['bxr', 'indigo']);
});

test('the offered set NARROWS an entitlement and never widens one', () => {
  assert.deepEqual(claimsDeskViews(BXR_ONLY), ['bxr']);
  assert.deepEqual(claimsDeskViews(INDIGO_ONLY), ['indigo']);
  // The direction that matters. An Indigo-scoped admin must not be offered BXR by virtue of
  // BXR being in CLAIMS_DESK_VIEWS — the intersection is the guarantee.
  assert.equal(claimsDeskViews(INDIGO_ONLY).includes('bxr'), false, 'Indigo admin offered BXR');
  assert.equal(claimsDeskViews(BXR_ONLY).includes('indigo'), false, 'BXR admin offered Indigo');
});

test('an entitlement this screen has no plane for yields NO tenant, not a default', () => {
  // `consolidated`-only is not a shape rbac.ts produces today; it is tested because the failure
  // mode is silent and severe — substituting the default here would scope a cross-tenant-only
  // principal to BXR's PHI.
  assert.deepEqual(claimsDeskViews(['consolidated']), []);
  assert.equal(
    resolveClaimsDeskView({}, ['consolidated']),
    null,
    'an unservable entitlement resolved to a real tenant instead of failing closed',
  );
  assert.deepEqual(claimsDeskViews([]), []);
  assert.equal(resolveClaimsDeskView({}, []), null);
});

test('an absent ?view= resolves to BXR — this is the bug that hid the Billable Days tab', () => {
  assert.equal(resolveClaimsDeskView({}, SUPER), 'bxr');
  assert.equal(resolveClaimsDeskView(undefined, SUPER), 'bxr');
});

test('an explicit, supported, entitled ?view= wins', () => {
  assert.equal(resolveClaimsDeskView({ view: 'indigo' }, SUPER), 'indigo');
  assert.equal(resolveClaimsDeskView({ view: 'bxr' }, SUPER), 'bxr');
});

test('?view=consolidated clamps to BXR rather than throwing', () => {
  const got = resolveClaimsDeskView({ view: 'consolidated' }, SUPER);
  assert.notEqual(got, 'consolidated', 'the desk accepted a view it has no plane for');
  assert.equal(got, 'bxr');
});

test('garbage and repeated params clamp, and a repeated param takes the FIRST', () => {
  assert.equal(resolveClaimsDeskView({ view: 'nonsense' }, SUPER), 'bxr');
  assert.equal(resolveClaimsDeskView({ view: '' }, SUPER), 'bxr');
  // `?view=indigo&view=bxr` arrives as an array — first wins, matching resolveView's contract.
  assert.equal(resolveClaimsDeskView({ view: ['indigo', 'bxr'] }, SUPER), 'indigo');
});

test('an UNENTITLED explicit view clamps to the entitlement, not to the route default', () => {
  // The security-relevant case. An Indigo-scoped admin hand-editing ?view=bxr must land on
  // indigo — NOT on CLAIMS_DESK_DEFAULT_VIEW, which is bxr and would be a cross-tenant grant.
  const got = resolveClaimsDeskView({ view: 'bxr' }, INDIGO_ONLY);
  assert.notEqual(got, 'bxr', 'an Indigo-scoped admin was clamped INTO BXR by the route default');
  assert.equal(got, 'indigo');
  // And the mirror, so the test cannot pass by always returning 'indigo'.
  const other = resolveClaimsDeskView({ view: 'indigo' }, BXR_ONLY);
  assert.notEqual(other, 'indigo', 'a BXR-scoped admin was clamped into Indigo');
  assert.equal(other, 'bxr');
});

test('urlView reports what is in the URL, so the page can tell "absent" from "already right"', () => {
  assert.equal(urlView({}), undefined);
  assert.equal(urlView(undefined), undefined);
  assert.equal(urlView({ view: 'bxr' }), 'bxr');
  assert.equal(urlView({ view: ['indigo', 'bxr'] }), 'indigo');
  // Reported RAW — an unsupported value must survive to the redirect comparison, or a
  // ?view=consolidated visit would compare equal to its clamp and never redirect.
  assert.equal(urlView({ view: 'consolidated' }), 'consolidated');
});
