/**
 * A fake tenant pool for the AR Management writer/cron tests. Each connect() is a NEW connection
 * with its own GUC, so a query that escapes withTenant() shows up as a missing BEGIN/set_config on
 * its connId. Every query is recorded {connId, sql, params}. Hermetic: no pg, no network.
 */
import type pg from 'pg';

export interface RecordedCall {
  connId: number;
  sql: string;
  params: unknown[] | undefined;
}

export interface FakeArPoolOpts {
  /** customerIds the freshness read reports as fresh. */
  fresh?: Set<string>;
  /** cmd_note_ids the notes pre-read reports as already present. */
  existingNoteIds?: string[];
  /** Throw on the run-start INSERT for these customerIds (params[1]). */
  failStartFor?: Set<string>;
  /** customerIds with a `running` run younger than 20 min (the running guard reports true). */
  running?: Set<string>;
  /** customerIds that already have live ar_claim rows (the empty-regression guard reports true). */
  liveRows?: Set<string>;
  /** customerId → last successful finished_at (ISO), for the stalest-first ordering pre-pass. */
  lastOkAt?: Record<string, string>;
}

/** Count VALUES tuples in a multi-row insert: every tuple starts with `($n`. */
export function tupleCount(sql: string): number {
  return (sql.match(/\(\$\d+/g) ?? []).length;
}

export function fakeArPool(opts: FakeArPoolOpts = {}) {
  const calls: RecordedCall[] = [];
  let connCounter = 0;
  let runIdCounter = 100;

  function makeClient(connId: number) {
    let guc: string | null = null;
    return {
      async query(sql: string, params?: unknown[]) {
        calls.push({ connId, sql, params });
        if (/^BEGIN/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/set_config/i.test(sql)) {
          guc = params?.[0] === undefined ? null : String(params[0]);
          return { rows: [{ set_config: guc }], rowCount: 1 };
        }
        if (/current_setting/i.test(sql)) return { rows: [{ v: guc }], rowCount: 1 };
        if (/from claims\.ar_snapshot_run/i.test(sql) && /as fresh/i.test(sql)) {
          return { rows: [{ fresh: opts.fresh?.has(String(params?.[1])) ?? false }], rowCount: 1 };
        }
        if (/from claims\.ar_snapshot_run/i.test(sql) && /as last_ok/i.test(sql)) {
          const rows = Object.entries(opts.lastOkAt ?? {}).map(([cmd_customer_id, last_ok]) => ({ cmd_customer_id, last_ok }));
          return { rows, rowCount: rows.length };
        }
        if (/from claims\.ar_snapshot_run/i.test(sql) && /as running/i.test(sql)) {
          return { rows: [{ running: opts.running?.has(String(params?.[1])) ?? false }], rowCount: 1 };
        }
        if (/from claims\.ar_claim where/i.test(sql) && /as has_rows/i.test(sql)) {
          return { rows: [{ has_rows: opts.liveRows?.has(String(params?.[1])) ?? false }], rowCount: 1 };
        }
        if (/insert into claims\.ar_snapshot_run/i.test(sql)) {
          if (opts.failStartFor?.has(String(params?.[1]))) throw new Error('start insert boom');
          runIdCounter += 1;
          return { rows: [{ id: String(runIdCounter) }], rowCount: 1 };
        }
        if (/update claims\.ar_snapshot_run/i.test(sql)) return { rows: [], rowCount: 1 };
        if (/select cmd_note_id from claims\.ar_claim_note/i.test(sql)) {
          return { rows: (opts.existingNoteIds ?? []).map((id) => ({ cmd_note_id: id })), rowCount: (opts.existingNoteIds ?? []).length };
        }
        if (/^insert into claims\.ar_/i.test(sql)) {
          const n = tupleCount(sql);
          return { rows: Array.from({ length: n }, (_, i) => ({ id: String(i + 1) })), rowCount: n };
        }
        if (/^update claims\.ar_(claim|charge) set in_latest_snapshot/i.test(sql)) return { rows: [], rowCount: 3 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }

  const pool = {
    async connect() {
      connCounter += 1;
      return makeClient(connCounter);
    },
    async query() {
      throw new Error('pool.query() must never be used inside withTenant');
    },
  } as unknown as pg.Pool;

  /** Every connection that ran a non-transaction statement must have BEGIN + set_config first. */
  function assertAllScoped(): string[] {
    const problems: string[] = [];
    const byConn = new Map<number, RecordedCall[]>();
    for (const c of calls) {
      const l = byConn.get(c.connId) ?? [];
      l.push(c);
      byConn.set(c.connId, l);
    }
    for (const [connId, list] of byConn) {
      const first = list[0]?.sql ?? '';
      const second = list[1]?.sql ?? '';
      if (!/^BEGIN/i.test(first) || !/set_config/i.test(second)) problems.push(`conn ${connId} not scoped: ${first} / ${second}`);
      if (!list.some((c) => /^COMMIT/i.test(c.sql) || /^ROLLBACK/i.test(c.sql))) problems.push(`conn ${connId} never committed/rolled back`);
    }
    return problems;
  }

  return { pool, calls, assertAllScoped };
}
