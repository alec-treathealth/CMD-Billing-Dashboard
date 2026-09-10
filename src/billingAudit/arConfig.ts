/**
 * AR Management — the snapshot roster and the constants the cron, CLI and cache share.
 *
 * ROSTER = every BXR CMD account the V2 snapshot endpoint SERVES (probed 2026-09-09: 19 of 20
 * return a ZIP; the billing umbrella 10030472 returns 401 and is not listed). That is the 17
 * audit-consolidated accounts (16 facilities + WRC) PLUS the two accounts the audit plane
 * excludes as "not yet open" — TREAT_CO (13 open charges / $39k) and HOUSTON_MH (208 open
 * charges / $1.33M at recon). They carry real AR, and this tab's purpose is oversight of ALL open
 * AR, so they are in. Neither has a `collections.facilities` dimension row; the queue labels them
 * from `facility_name` (B_PRACTICE.NAME in their own snapshot) rather than from the dimension.
 * ⚠ HOLD ITEM for Alec: confirm those two belong on the queue, or retire them here (one line each).
 *
 * `businessEntityId` is BXR on every row: the Indigo account's snapshot is NOT configured
 * (10024431 → 404 on 2026-08-14). Indigo appears on the tab as an honest empty state.
 */
import { BXR_ENTITY_ID } from '../tenants.js';
import type { CmdCustomerTarget } from '../collections/cmdExplorerCron.js';
import { AUDIT_CONSOLIDATED_CUSTOMERS } from './auditConfig.js';

/** The unstable_cache tag every AR read is wrapped in; the ingest + every human write bust it. */
export const AR_CACHE_TAG = 'ar-management';

export const AR_SNAPSHOT_CUSTOMERS: readonly CmdCustomerTarget[] = [
  ...AUDIT_CONSOLIDATED_CUSTOMERS,
  { customerId: '10035974', facilityCode: 'TREAT_CO', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10035976', facilityCode: 'HOUSTON_MH', businessEntityId: BXR_ENTITY_ID },
] as const;

/**
 * Accounts allowed to map to ZERO claims without the run being flagged.
 *
 * ⚠ EMPTY SINCE 2026-09-10, AND THAT IS THE FIX. It held 10033951 (WRC) and 10035974 (TREAT_CO) as
 * "the tiny books", but membership here DISABLES the empty-regression guard for exactly those
 * accounts — and both carry real money: measured 4 live claims / $35,780 and 7 / $39,450. So the
 * two accounts with the least tolerance for a silent wipe were the only two unprotected: a blank
 * CMD export for either would have stale-marked every live claim and closed the run as `empty`,
 * i.e. as a success, with the 20h freshness cursor then blocking a re-pull until the next day.
 *
 * The mechanism is kept, not deleted: an account that genuinely has no book belongs here, and
 * without it the cron records an `error`/`empty_regression` and writes nothing. The bar for adding
 * one is that it has NO live claims — check before you add, because the cost of being wrong is a
 * facility's AR disappearing quietly.
 */
export const AR_EXPECTED_EMPTY_CUSTOMERS: ReadonlySet<string> = new Set([]);

/**
 * A snapshot mapping to fewer than this FRACTION of the last good run's claims_seen is treated as a
 * regression: nothing is written and the run is recorded as an error, so the next pass retries.
 *
 * 0.5 is loose on purpose. A claim stays in CMD's snapshot until CMD stops reporting it, so payments
 * do not shrink the claim COUNT — there is no benign reason for a facility's book to halve overnight.
 * The number can be TIGHTENED freely; loosening it is a decision that halving a book unremarked is
 * acceptable, and should be argued rather than nudged.
 */
export const AR_EMPTY_REGRESSION_RATIO = 0.5;

/** A customer pulled OK inside this window is skipped — the snapshot is rebuilt once a day. */
export const AR_SNAPSHOT_STALENESS_MS = 20 * 3_600_000;

/** Wall-clock budget before the loop stops LAUNCHING customers (maxDuration is 300s). */
export const AR_SNAPSHOT_BUDGET_MS = 240_000;
