/**
 * AR Management — the SNAPSHOT CRON loop. One pass over the BXR roster: for each customer that is
 * not fresh, download its V2 snapshot (direct GET — no CBI report slot is consumed), parse + map it
 * (arSnapshotMap.ts), write it (arSnapshotWrite.ts), and record the outcome in
 * claims.ar_snapshot_run. Modelled on cmdCensusCron.ts, with the same three guarantees:
 *
 *   - FRESHNESS CURSOR: a customer whose latest run finished ok/empty inside `stalenessMs`
 *     (default 20h — CMD rebuilds the snapshot once a day, in the morning ET) is skipped.
 *   - BUDGET GUARD: stop LAUNCHING customers near the wall-clock budget (default 240s under the
 *     300s function); whatever was not reached is simply not-fresh next run. The roster is walked
 *     STALEST-FIRST (never-ingested first) so a truncated pass rotates instead of starving the same
 *     tail every day — with a fixed order the 20h freshness window under a 24h schedule means the
 *     tail is never reached at all. See the comment on `ordered` below.
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
import { AR_EMPTY_REGRESSION_RATIO, AR_SNAPSHOT_BUDGET_MS, AR_SNAPSHOT_STALENESS_MS } from './arConfig.js';
import { mapSnapshot, type ArMapped } from './arSnapshotMap.js';
import { writeArSnapshot, type ArWriteContext, type ArWriteStats } from './arSnapshotWrite.js';
import { parseSnapshotZip } from './snapshotParse.js';

export type ArCustomerOutcome = 'ok' | 'empty' | 'error' | 'not_configured' | 'unauthorized' | 'skipped_fresh' | 'skipped_budget' | 'skipped_running';

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
  /** Test seams. `write`'s 4th argument is the live progress accumulator (see writeArSnapshot). */
  parseAndMap?: (zip: Buffer) => ArMapped;
  write?: (db: Db, mapped: ArMapped, ctx: ArWriteContext, progress?: ArWriteStats) => Promise<ArWriteStats>;
  now?: () => number;
  budgetMs?: number;
  stalenessMs?: number;
  /** Fraction of the last good claims_seen below which a snapshot is a regression. Default 0.5. */
  emptyRegressionRatio?: number;
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
  /** Another run for the customer is still `running` (started < 20 min ago) — skipped, not started. */
  customers_skipped_running: number;
  /** A previously populated customer whose snapshot mapped to ZERO claims: recorded as an error, nothing written. */
  customers_empty_regression: number;
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
type StageLabel = 'fetch_failed' | 'parse_failed' | 'write_failed' | 'empty_regression';

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
    customers_skipped_running: 0,
    customers_empty_regression: 0,
    claims_upserted: 0,
    charges_upserted: 0,
    notes_inserted: 0,
    per_customer: [],
  };
  let wroteSomething = false;

  // FAIRNESS ORDER — stalest first, never-ingested before everything.
  //
  // The budget guard stops LAUNCHING customers near the ceiling, so a pass that runs long leaves a
  // tail unprocessed. With a FIXED roster order that tail is starved PERMANENTLY rather than merely
  // delayed, because the freshness window (20h) is shorter than the schedule (24h): at the next run
  // every customer is stale again, the loop restarts at roster position 1, and the same head
  // customers consume the same budget. The tail is never reached on any day.
  //
  // Ordering by "longest since a successful pull" makes a truncated pass ROTATE: whoever was skipped
  // yesterday sorts first today. A customer that has never been ingested (no ok/empty run) sorts
  // ahead of everything, so onboarding a facility does not wait behind 18 fresh ones. Ties keep
  // roster order, so a first-ever run is processed exactly as before.
  const lastOkAt = new Map<string, number>();
  /** claims_seen of each customer's LAST successful run — the baseline for the proportional guard. */
  const lastClaimsSeen = new Map<string, number>();
  const entities = [...new Set(deps.customers.map((c) => c.businessEntityId).filter((e): e is string => typeof e === 'string' && e !== ''))];
  for (const entity of entities) {
    const rows = await withTenant(deps.writeDb, entity, async (client) => {
      // distinct on, not max(): this pass needs the claims_seen OF the latest successful run, which a
      // group-by cannot give you — max(claims_seen) would be the largest run the customer ever had.
      const res = await client.query<{ cmd_customer_id: string; last_ok: string | null; claims_seen: number | null }>(
        `select distinct on (cmd_customer_id) cmd_customer_id, finished_at as last_ok, claims_seen ` +
          `from claims.ar_snapshot_run ` +
          `where business_entity_id = $1 and status in ('ok', 'empty') and finished_at is not null ` +
          `order by cmd_customer_id, finished_at desc`,
        [entity],
      );
      return res.rows;
    });
    for (const r of rows) {
      const key = `${entity}:${r.cmd_customer_id}`;
      if (r.last_ok !== null) {
        const t = Date.parse(String(r.last_ok));
        if (Number.isFinite(t)) lastOkAt.set(key, t);
      }
      const seen = r.claims_seen === null ? null : Number(r.claims_seen);
      if (seen !== null && Number.isFinite(seen) && seen > 0) lastClaimsSeen.set(key, seen);
    }
  }
  const ordered = deps.customers
    .map((customer, idx) => ({ customer, idx }))
    .sort((a, b) => {
      // Never ingested → -Infinity → sorts first. Equal keys fall back to roster order (stable).
      const ka = lastOkAt.get(`${a.customer.businessEntityId}:${a.customer.customerId}`) ?? -Infinity;
      const kb = lastOkAt.get(`${b.customer.businessEntityId}:${b.customer.customerId}`) ?? -Infinity;
      return ka === kb ? a.idx - b.idx : ka - kb;
    })
    .map((x) => x.customer);

  for (const customer of ordered) {
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

    // RUNNING GUARD — the cheap mutex. Two invocations for one customer (a manual CLI run beside the
    // cron, or an overlapping platform retry) would race the stale mark; a `running` row younger than
    // 20 minutes means another pass owns this customer right now. Older `running` rows are the
    // never-finished signal of a killed run and do NOT block.
    const running = await withTenant(deps.writeDb, entity, async (client) => {
      const res = await client.query<{ running: boolean }>(
        `select exists (select 1 from claims.ar_snapshot_run ` +
          `where business_entity_id = $1 and cmd_customer_id = $2 and status = 'running' ` +
          `and started_at > now() - interval '20 minutes') as running`,
        [entity, customer.customerId],
      );
      return res.rows[0]?.running === true;
    });
    if (running) {
      report.outcome = 'skipped_running';
      stats.customers_skipped_running += 1;
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

    // Held OUTSIDE the try so the error path can report what was parsed and what actually committed,
    // rather than closing a partially-written run with zeroes (Qodo #348 finding 12).
    const progress: ArWriteStats = { ...EMPTY_WRITE };
    let parsedClaims = 0;
    let parsedCharges = 0;
    let parsedAsOf: string | null = null;
    let attemptedWrite = false;

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
      parsedClaims = mapped.claims.length;
      parsedCharges = mapped.charges.length;
      parsedAsOf = mapped.snapshotAsOf;

      // EMPTY-REGRESSION GUARD, now PROPORTIONAL. A structurally valid snapshot that maps to zero —
      // or to far fewer claims than the last good run — is a broken or truncated export, not a book
      // that emptied overnight. Writing it would stale-mark the missing claims and record a `fresh`
      // run that blocks the re-pull for 20 hours, so the money would drop off the queue and every
      // KPI until someone noticed by eye.
      //
      // ⚠ WHY ZERO WAS NOT ENOUGH: the original guard fired only on `claims.length === 0`, so a
      // TRUNCATED export — 3 of 11,979 claims, which is a far more likely CMD failure than a
      // perfectly empty file — sailed through, stale-marked the rest of the book, and closed `ok`.
      // The threshold catches the shape the zero-check was blind to.
      //
      // The ratio is deliberately loose (AR_EMPTY_REGRESSION_RATIO, 0.5). A claim stays in CMD's
      // snapshot until CMD stops reporting it, so payments do NOT shrink the claim COUNT — a 50%
      // overnight drop has no benign explanation. It can only ever be tightened; loosening it means
      // deciding that halving a facility's book unremarked is acceptable.
      const baseline = lastClaimsSeen.get(`${entity}:${customer.customerId}`) ?? 0;
      const threshold = baseline > 0 ? baseline * (deps.emptyRegressionRatio ?? AR_EMPTY_REGRESSION_RATIO) : 0;
      const shortfall = mapped.claims.length === 0 || (baseline > 0 && mapped.claims.length < threshold);
      if (shortfall && !deps.expectedEmptyCustomerIds.has(customer.customerId)) {
        const hasLive = await withTenant(deps.writeDb, entity, async (client) => {
          const res = await client.query<{ has_rows: boolean }>(
            `select exists (select 1 from claims.ar_claim where business_entity_id = $1 and cmd_customer_id = $2 and in_latest_snapshot) as has_rows`,
            [entity, customer.customerId],
          );
          return res.rows[0]?.has_rows === true;
        });
        if (hasLive) {
          throw new StageError(
            'empty_regression',
            // Counts only — no cell values — so this is safe for the cron's logger.
            new Error(`snapshot mapped ${mapped.claims.length} claims against a last-good ${baseline} (floor ${floor})`),
          );
        }
      }

      // Any writer batch may commit before a later one fails, so the cache bust must not depend on the
      // writer resolving — mark the intent BEFORE the first statement.
      wroteSomething = true;
      attemptedWrite = true;
      let written: ArWriteStats;
      try {
        written = await write(deps.writeDb, mapped, {
          businessEntityId: entity,
          cmdCustomerId: customer.customerId,
          facilityCode: customer.facilityCode,
          runId,
          runStartedAt,
        }, progress);
      } catch (e) {
        throw new StageError('write_failed', e);
      }
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
      if (label === 'empty_regression') stats.customers_empty_regression += 1;
      // Ops-only message (never a cell value: the transport + mapper throw structural errors).
      const cause = err instanceof StageError ? err.cause : err;
      console.error(`ar-snapshot: customer ${customer.customerId} (${customer.facilityCode}) ${label}:`, cause instanceof Error ? cause.message : String(cause));
      // Report what was PARSED and what actually COMMITTED. A write that failed on a later batch has
      // durable earlier batches; recording zeroes here would hide a partial ingest from reconciliation.
      report.claims = progress.claims;
      report.charges = progress.charges;
      report.notesInserted = progress.notesInserted;
      stats.claims_upserted += progress.claims;
      stats.charges_upserted += progress.charges;
      stats.notes_inserted += progress.notesInserted;
      try {
        await finish('error', label, {
          zipBytes: report.zipBytes,
          snapshotAsOf: parsedAsOf,
          claimsSeen: parsedClaims,
          chargesSeen: parsedCharges,
          write: attemptedWrite ? progress : null,
        });
      } catch (e2) {
        console.error(`ar-snapshot: customer ${customer.customerId} run-row close failed:`, e2 instanceof Error ? e2.message : String(e2));
      }
    }
    stats.per_customer.push(report);
  }

  if (wroteSomething && deps.revalidate) await deps.revalidate();
  return stats;
}
