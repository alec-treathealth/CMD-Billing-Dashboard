/**
 * Payer-alias ruling queue — SERVER-ONLY read layer for /admin/payer-aliases.
 *
 * This module builds a pg pool; importing it from a Client Component fails the build loudly. The
 * page is a Server Component and passes plain data down — there is NO client-side DB access on this
 * surface, and no route handler either.
 *
 * POOL: the qualify/loaders.ts precedent — a module-cached PgExecutor on `makeReaderPool`
 * (claims_reader, max 4, verify-full TLS through the one ssl.ts path, unnamed parameterized queries
 * only for Supavisor 6543). The pool is built LAZILY inside payerAliasReader(), so importing this
 * module reads no env and opens no socket — which is what lets the assembly be tested hermetically.
 *
 * ⚠️ DELIBERATELY NOT WRAPPED IN `unstable_cache`. A failed background revalidation there serves the
 * previous value silently, which on a ruling queue would mean a reviewer working a list that no
 * longer reflects what is unruled — and the failure would never surface. The page is
 * `force-dynamic`; every load is a real read. If a query throws, it throws.
 *
 * READ-ONLY. This module issues SELECTs only: no definer call, no INSERT/UPDATE, no audit row. The
 * write chain lives in the Server Action, not here.
 */
import { PgExecutor, makeReaderPool, readerConnectionStringFromEnv } from '../../../src/queries/executor';
import {
  buildPayerAliasQueueQuery,
  buildPayerAliasQueueCountsQuery,
  buildPayerAliasSiblingsQuery,
  buildPayerAliasNeighboursQuery,
  clampPage,
  PAYER_ALIAS_VOCABULARIES,
  QUEUE_PAGE_SIZE,
  type PayerAliasNeighbourRow,
  type PayerAliasQueueRow,
  type PayerAliasSiblingRow,
  type PayerAliasVocabulary,
} from '../../../src/collections/payerAliasQueue';

/**
 * The ONLY capability this module needs from a database handle. Declared structurally rather than as
 * `PgExecutor` so the assembly can be exercised against a fake with no pg, no pool and no network —
 * see app/test/payer-alias-loaders.test.tsx. PgExecutor satisfies it as-is.
 */
export interface QueueReader {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

let executor: PgExecutor | null = null;
/** Module-cached executor on a SEPARATE small claims_reader pool (the verisReaderPool precedent). */
function payerAliasReader(): QueueReader {
  if (!executor) executor = new PgExecutor(makeReaderPool(readerConnectionStringFromEnv(), 'payer-alias-queue'));
  return executor;
}

export interface PayerAliasQueuePage {
  vocabulary: PayerAliasVocabulary;
  /** The page actually served. May be LOWER than requested — see the clamp note on loadPayerAliasQueue. */
  page: number;
  pageSize: number;
  /** Highest page that holds rows for this vocabulary; 1 when the queue is empty. */
  lastPage: number;
  /** Unruled count for EVERY vocabulary, zero-filled — drives the tab badges. */
  counts: Record<PayerAliasVocabulary, number>;
  rows: PayerAliasQueueRow[];
  /** alias_norm → the same string as ruled under other vocabularies. */
  siblings: Record<string, PayerAliasSiblingRow[]>;
  /** alias_norm → up to 3 CONFIRMED look-alikes and how they were ruled. */
  neighbours: Record<string, PayerAliasNeighbourRow[]>;
  /** True when a further page exists for this vocabulary. */
  hasMore: boolean;
}

function zeroCounts(): Record<PayerAliasVocabulary, number> {
  return { vob_insurance_co: 0, claims_primary_payer: 0, vob_payer_id: 0 };
}

/** Group rows by a string key, preserving the SQL ORDER BY within each group. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const row of rows) {
    const k = key(row);
    const bucket = out[k];
    if (bucket) bucket.push(row);
    else out[k] = [row];
  }
  return out;
}

/**
 * One queue page plus all of its decision context, in at most FOUR queries — never a query per row.
 *
 * ── WHY COUNTS RUNS FIRST, AND NOT CONCURRENTLY (fixes M2) ──────────────────────────────────────
 * `clampPage` bounds a route value to [1, 200] because it cannot know how many rows exist. 200 pages
 * is ~5000 rows against a queue of 990, so `?p=200` used to issue `offset 4975`, return nothing, and
 * render "Showing 4976–990 of 990 unruled" — an inverted range, reachable by editing the URL.
 *
 * The count is what makes the page number honest, so it is fetched BEFORE the queue and the page is
 * clamped to the real last page. That costs one sequential round trip on a group-by over 1,685 rows,
 * which is the right trade for never serving a nonsensical page. The clamp is silent: the URL may
 * still say p=200 while page 40 is served. That is deliberate — a redirect would be more correct but
 * would have to rebuild the URL, and this surface keeps route construction minimal on purpose
 * (alias_norm must never reach one).
 *
 * `db` is injectable for tests ONLY; production always takes the module-cached claims_reader pool.
 */
export async function loadPayerAliasQueue(
  vocabulary: PayerAliasVocabulary,
  page: number,
  db: QueueReader = payerAliasReader(),
): Promise<PayerAliasQueuePage> {
  const countsQ = buildPayerAliasQueueCountsQuery();
  const countsRes = await db.query<{ vocabulary: string; unruled: number }>(countsQ.sql, countsQ.params);

  const counts = zeroCounts();
  for (const row of countsRes.rows) {
    // A vocabulary the CHECK allows but we do not model would be dropped silently otherwise.
    if ((PAYER_ALIAS_VOCABULARIES as readonly string[]).includes(row.vocabulary)) {
      counts[row.vocabulary as PayerAliasVocabulary] = Number(row.unruled);
    }
  }

  const total = counts[vocabulary];
  // An empty queue still has a page 1 — it renders "Nothing unruled on this page", not page 0.
  const lastPage = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  const p = Math.min(clampPage(page), lastPage);

  const queueQ = buildPayerAliasQueueQuery(vocabulary, p, QUEUE_PAGE_SIZE);
  const queueRes = await db.query<PayerAliasQueueRow>(queueQ.sql, queueQ.params);
  const rows = queueRes.rows;
  const aliasNorms = rows.map((r) => r.alias_norm);

  let siblings: Record<string, PayerAliasSiblingRow[]> = {};
  let neighbours: Record<string, PayerAliasNeighbourRow[]> = {};
  if (aliasNorms.length > 0) {
    const sibQ = buildPayerAliasSiblingsQuery(aliasNorms, vocabulary);
    const nbrQ = buildPayerAliasNeighboursQuery(aliasNorms);
    const [sibRes, nbrRes] = await Promise.all([
      db.query<PayerAliasSiblingRow>(sibQ.sql, sibQ.params),
      db.query<PayerAliasNeighbourRow>(nbrQ.sql, nbrQ.params),
    ]);
    // ⚠️ THE TWO KEYS ARE DIFFERENT AND THE DIFFERENCE IS EASY TO MISS. A sibling row IS the alias
    // (same string, other vocabulary), so it groups by `alias_norm`. A neighbour row is a DIFFERENT
    // alias that merely looks like the one on screen, so its own `alias_norm` is the look-alike and
    // the column that names the row it belongs to is `seed`. Keying neighbours on `alias_norm` would
    // group every card under the wrong string and blank the look-alike panel everywhere, silently.
    siblings = groupBy(sibRes.rows, (r) => r.alias_norm);
    neighbours = groupBy(nbrRes.rows, (r) => r.seed);
  }

  return {
    vocabulary,
    page: p,
    pageSize: QUEUE_PAGE_SIZE,
    lastPage,
    counts,
    rows,
    siblings,
    neighbours,
    hasMore: p < lastPage,
  };
}
