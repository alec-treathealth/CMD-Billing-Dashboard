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
 * Accounts allowed to map to ZERO claims without the run being flagged — the tiny books. Any
 * other account that maps to zero claims is recorded `empty` too, but the cron's per-customer
 * outcome names it so a silently-blank snapshot is visible in the run log.
 */
export const AR_EXPECTED_EMPTY_CUSTOMERS: ReadonlySet<string> = new Set(['10033951', '10035974']);

/** A customer pulled OK inside this window is skipped — the snapshot is rebuilt once a day. */
export const AR_SNAPSHOT_STALENESS_MS = 20 * 3_600_000;

/** Wall-clock budget before the loop stops LAUNCHING customers (maxDuration is 300s). */
export const AR_SNAPSHOT_BUDGET_MS = 240_000;
