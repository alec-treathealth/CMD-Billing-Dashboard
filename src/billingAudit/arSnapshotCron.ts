/**
 * AR Management — the SNAPSHOT CRON loop. One pass over the BXR roster: for each customer that is
 * not fresh, download its V2 snapshot (direct GET — no CBI report slot is consumed), parse + map it
 * (arSnapshotMap.ts), write it (arSnapshotWrite.ts), and record the outcome in
 * claims.ar_snapshot_run. Modelled on cmdCensusCron.ts, with the same three guarantees:
 *
 *   - FRESHNESS CURSOR: a customer whose latest run finished ok/empty inside `stalenessMs`
 *     (default 20h — CMD rebuilds the snapshot once a day, in the morning ET) is skipped.
 *   - BUDGET GUARD: stop LAUNCHING customers near the wall-clock budget (default 240s under the
 *     300s function); whatever was not reached is simply not-fresh next run.
 *   - PER-CUSTOMER ISOLATION: a customer that throws closes its run row status='error' with a
 *     PHI-SAFE STAGE LABEL (fetch_failed / parse_failed / write_failed) and the loop continues.
 *     404 and 401 are NOT errors — they are recorded as their own statuses (not_configured /
 *     unauthorized) because they describe the ACCOUNT, and they never abort the run.
 *
 * RUN-LOG LIFECYCLE IS TENANT-SCOPED: every ar_snapshot_run read/write goes through withTenant()
 * (the writer policies are GUC-scoped and RAISE when unset). The START row commits BEFORE the
 * download so a mid-pull kill leaves a durable finished_at=NULL row (the never-finished signal),
 * which the freshness predicate deliberately does not count as fresh.
 *
 * LAYERING: transport-agnostic — no env reads, no next/cache. The composition root injects the
 * roster, the fetch, the writer pool, the writer identity and the cache-revalidate callback.
 */
import type { Db } from '../collections/db.js';
import type { CmdCustomerTarget } from '../collections/cmdExplorerCron.js';
import type { CmdSnapshotResult } from '../collections/cmdSnapshot.js';
import { withTenant } from '../veris/withTenant.js';
import { AR_SNAPSHOT_BUDGET_MS, AR_SNAPSHOT_STALENESS_MS } from './arConfig.js';
import { mapSnapshot, type ArMapped } from './arSnapshotMap.js';
import { writeArSnapshot, type ArWriteContext, type ArWriteStats } from './arSnapshotWrite.js';
import { parseSnapshotZip } from './snapshotParse.js';

export type ArCustomerOutcome = 'ok' | 'empty' | 'error' | 'not_configured' | 'unauthorized' | 'skipped_fresh' | 'skipped_budget';

export interface ArSnapshotCronDeps {
  customers: readonly CmdCustomerTarget[];
  /** Download ONE customer's snapshot. In prod: cmdFetchSnapshot({...creds, customerId}). */
  fetchSnapshot: (customerId: string) => Promise<CmdSnapshotResult>;
  /** Least-privilege claims_audit_writer pool. */
  writeDb: Db;
  /** current_user of the writer pool, asserted by the composition root before the run. */
  writerUser: string;
  /** Customers allowed to map to zero claims without a warning outcome. */
  expectedEmptyCustomerIds: ReadonlySet<string>;
  /** Bust the AR cache tag after any successful write. */
  revalidate?: () => void | Promise<void>;
  /** Test seams. */
  parseAndMap?: (zip: Buffer) => ArMapped;
  write?: (db: Db, mapped: ArMapped, ctx: ArWriteContext) => Promise<ArWriteStats>;
  now?: () => number;
  budgetMs?: number;
  stalenessMs?: number;
}

export interface ArCustomerReport {
  customerId: string;
  facilityCode: string;
  outcome: ArCustomerOutcome;
  errorLabel: string | null;
  claims: number;
  charges: number;
  notesInserted: number;
  zipBytes: number | null;
}

export interface ArSnapshotCronStats {
  customers_total: number;
  customers_processed: number;
  customers_empty: number;
  customers_failed: number;
  customers_not_configured: number;
  customers_unauthorized: number;
  customers_skipped_fresh: number;
  customers_skipped_budget: number;
  claims_upserted: number;
  charges_upserted: number;
  notes_inserted: number;
  per_customer: ArCustomerReport[];
}

interface FinishCounts {
  zipBytes: number | null;
  snapshotAsOf: string | null;
  claimsSeen: number;
  chargesSeen: number;
  write: ArWriteStats | null;
}

const EMPTY_WRITE: ArWriteStats = { patients: 0, claims: 0, charges: 0, remits: 0, statusEvents: 0, notesInserted: 0, claimsMarkedStale: 0, chargesMarkedStale: 0 };

/** Fixed PHI-safe stage labels — never a message, URL or cell value. */
type StageLabel = 'fetch_failed' | 'parse_failed' | 'write_failed';

class StageError extends Error {
  constructor(readonly label: StageLabel, cause: unknown) {
    super(label, { cause });
  }
}

export async function arSnapshotCron(deps: ArSnapshotCronDeps): Promise<ArSnapshotCronStats> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? AR_SNAPSHOT_BUDGET_MS;
  const stalenessMs = deps.stalenessMs ?? AR_SNAPSHOT_STALENESS_MS;
  const parseAndMap = deps.parseAndMap ?? ((zip: Buffer) => mapSnapshot(parseSnapshotZip(zip)));
  const write = deps.write ?? writeArSnapshot;
  const t0 = now();

  const stats: ArSnapshotCronStats = {
    customers_total: deps.customers.length,
    customers_processed: 0,
    customers_empty: 0,
    customers_failed: 0,
    customers_not_configured: 0,
    customers_unauthorized: 0,
    customers_skipped_fresh: 0,
    customers_skipped_budget: 0,
    claims_upserted: 0,
    charges_upserted: 0,
    notes_inserted: 0,
    per_customer: [],
  };
  let wroteSomething = false;

  for (const customer of deps.customers) {
    const entity = customer.businessEntityId;
    if (!entity) throw new Error(`arSnapshotCron: customer ${customer.customerId} has no businessEntityId`);
    const report: ArCustomerReport = {
      customerId: customer.customerId,
      facilityCode: customer.facilityCode,
      outcome: 'ok',
      errorLabel: null,
      claims: 0,
      charges: 0,
      notesInserted: 0,
      zipBytes: null,
    };

    if (now() - t0 >= budgetMs) {
      report.outcome = 'skipped_budget';
      stats.customers_skipped_budget += 1;
      stats.per_customer.push(report);
      continue;
    }

    const fresh = await withTenant(deps.writeDb, entity, async (client) => {
      const res = await client.query<{ fresh: boolean }>(
        `select exists (select 1 from claims.ar_snapshot_run ` +
          `where business_entity_id = $1 and cmd_customer_id = $2 and status in ('ok', 'empty') ` +
          `and finished_at is not null and finished_at > now() - make_interval(secs => $3::double precision)) as fresh`,
        [entity, customer.customerId, stalenessMs / 1000],
      );
      return res.rows[0]?.fresh === true;
    });
    if (fresh) {
      report.outcome = 'skipped_fresh';
      stats.customers_skipped_fresh += 1;
      stats.per_customer.push(report);
      continue;
    }

    const runStartedAt = new Date(now()).toISOString();
    const runId = await withTenant(deps.writeDb, entity, async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into claims.ar_snapshot_run (business_entity_id, cmd_customer_id, facility_code, status, writer_user, started_at) ` +
          `values ($1, $2, $3, 'running', $4, $5::timestamptz) returning id`,
        [entity, customer.customerId, customer.facilityCode, deps.writerUser, runStartedAt],
      );
      return Number(res.rows[0]!.id);
    });

    const finish = (status: ArCustomerOutcome, errorLabel: string | null, counts: FinishCounts) =>
      withTenant(deps.writeDb, entity, async (client) => {
        const w = counts.write ?? EMPTY_WRITE;
        await client.query(
          `update claims.ar_snapshot_run set status = $2, finished_at = now(), error_label = $3, zip_bytes = $4, ` +
            `snapshot_as_of = $5::timestamptz, claims_seen = $6, charges_seen = $7, patients_upserted = $8, claims_upserted = $9, ` +
            `charges_upserted = $10, remits_upserted = $11, status_events_upserted = $12, notes_inserted = $13 ` +
            `where id = $1 and business_entity_id = $14`,
          [runId, status, errorLabel, counts.zipBytes, counts.snapshotAsOf, counts.claimsSeen, counts.chargesSeen,
            w.patients, w.claims, w.charges, w.remits, w.statusEvents, w.notesInserted, entity],
        );
      });

    try {
      let snap: CmdSnapshotResult;
      try {
        snap = await deps.fetchSnapshot(customer.customerId);
      } catch (e) {
        throw new StageError('fetch_failed', e);
      }
      if (snap.kind === 'not_configured' || snap.kind === 'unauthorized') {
        report.outcome = snap.kind;
        if (snap.kind === 'not_configured') stats.customers_not_configured += 1; else stats.customers_unauthorized += 1;
        await finish(snap.kind, null, { zipBytes: null, snapshotAsOf: null, claimsSeen: 0, chargesSeen: 0, write: null });
        stats.per_customer.push(report);
        continue;
      }
      report.zipBytes = snap.bytes.length;

      let mapped: ArMapped;
      try {
        mapped = parseAndMap(snap.bytes);
      } catch (e) {
        throw new StageError('parse_failed', e);
      }

      let written: ArWriteStats;
      try {
        written = await write(deps.writeDb, mapped, {
          businessEntityId: entity,
          cmdCustomerId: customer.customerId,
          facilityCode: customer.facilityCode,
          runId,
          runStartedAt,
        });
      } catch (e) {
        throw new StageError('write_failed', e);
      }
      wroteSomething = true;
      report.claims = written.claims;
      report.charges = written.charges;
      report.notesInserted = written.notesInserted;
      stats.claims_upserted += written.claims;
      stats.charges_upserted += written.charges;
      stats.notes_inserted += written.notesInserted;

      const empty = mapped.claims.length === 0;
      report.outcome = empty ? 'empty' : 'ok';
      if (empty) stats.customers_empty += 1; else stats.customers_processed += 1;
      if (empty && !deps.expectedEmptyCustomerIds.has(customer.customerId)) {
        console.warn(`ar-snapshot: customer ${customer.customerId} (${customer.facilityCode}) mapped to ZERO claims — not in the expected-empty set`);
      }
      await finish(report.outcome, null, {
        zipBytes: snap.bytes.length,
        snapshotAsOf: mapped.snapshotAsOf,
        claimsSeen: mapped.claims.length,
        chargesSeen: mapped.charges.length,
        write: written,
      });
    } catch (err) {
      const label: StageLabel = err instanceof StageError ? err.label : 'write_failed';
      report.outcome = 'error';
      report.errorLabel = label;
      stats.customers_failed += 1;
      // Ops-only message (never a cell value: the transport + mapper throw structural errors).
      const cause = err instanceof StageError ? err.cause : err;
      console.error(`ar-snapshot: customer ${customer.customerId} (${customer.facilityCode}) ${label}:`, cause instanceof Error ? cause.message : String(cause));
      try {
        await finish('error', label, { zipBytes: report.zipBytes, snapshotAsOf: null, claimsSeen: 0, chargesSeen: 0, write: null });
      } catch (e2) {
        console.error(`ar-snapshot: customer ${customer.customerId} run-row close failed:`, e2 instanceof Error ? e2.message : String(e2));
      }
    }
    stats.per_customer.push(report);
  }

  if (wroteSomething && deps.revalidate) await deps.revalidate();
  return stats;
}
