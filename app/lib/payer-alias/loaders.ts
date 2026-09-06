/**
 * Payer-alias ruling queue — SERVER-ONLY read layer for /admin/payer-aliases.
 *
 * This module builds a pg pool; importing it from a Client Component fails the build loudly. The
 * page is a Server Component and passes plain data down — there is NO client-side DB access on this
 * surface, and no route handler either.
 *
 * POOL: the qualify/loaders.ts precedent — a module-cached PgExecutor on `makeReaderPool`
 * (claims_reader, max 4, verify-full TLS through the one ssl.ts path, unnamed parameterized queries
 * only for Supavisor 6543).
 *
 * ⚠️ DELIBERATELY NOT WRAPPED IN `unstable_cache`. A failed background revalidation there serves the
 * previous value silently, which on a ruling queue would mean a reviewer working a list that no
 * longer reflects what is unruled — and the failure would never surface. The page is
 * `force-dynamic`; every load is a real read. If a query throws, it throws.
 *
 * READ-ONLY. Artifact 2 ships zero writes: no definer call, no INSERT/UPDATE, no audit row. The
 * write chain is Artifact 3.
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

let executor: PgExecutor | null = null;
/** Module-cached executor on a SEPARATE small claims_reader pool (the verisReaderPool precedent). */
function payerAliasReader(): PgExecutor {
  if (!executor) executor = new PgExecutor(makeReaderPool(readerConnectionStringFromEnv(), 'payer-alias-queue'));
  return executor;
}

export interface PayerAliasQueuePage {
  vocabulary: PayerAliasVocabulary;
  page: number;
  pageSize: number;
  /** Unruled count for EVERY vocabulary, zero-filled — drives the tab badges. */
  counts: Record<PayerAliasVocabulary, number>;
  rows: PayerAliasQueueRow[];
  /** alias_norm → the same string as ruled under other vocabularies. */
  siblings: Record<string, PayerAliasSiblingRow[]>;
  /** alias_norm → up to 3 CONFIRMED look-alikes and how they were ruled. */
  neighbours: Record<string, PayerAliasNeighbourRow[]>;
  /** True when a further page exists for this vocabulary (count-derived, not a probe row). */
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
 * One queue page plus all of its decision context, in at most FOUR queries total — never a query
 * per row. Counts and the page itself always run; siblings and neighbours are skipped entirely when
 * the page is empty (past the end of the list), which is the only case where they would be
 * meaningless.
 */
export async function loadPayerAliasQueue(
  vocabulary: PayerAliasVocabulary,
  page: number,
): Promise<PayerAliasQueuePage> {
  const p = clampPage(page);
  const db = payerAliasReader();

  const countsQ = buildPayerAliasQueueCountsQuery();
  const queueQ = buildPayerAliasQueueQuery(vocabulary, p, QUEUE_PAGE_SIZE);

  const [countsRes, queueRes] = await Promise.all([
    db.query<{ vocabulary: string; unruled: number }>(countsQ.sql, countsQ.params),
    db.query<PayerAliasQueueRow>(queueQ.sql, queueQ.params),
  ]);

  const counts = zeroCounts();
  for (const row of countsRes.rows) {
    // A vocabulary the CHECK allows but we do not model would be dropped silently otherwise.
    if ((PAYER_ALIAS_VOCABULARIES as readonly string[]).includes(row.vocabulary)) {
      counts[row.vocabulary as PayerAliasVocabulary] = row.unruled;
    }
  }

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
    siblings = groupBy(sibRes.rows, (r) => r.alias_norm);
    neighbours = groupBy(nbrRes.rows, (r) => r.seed);
  }

  return {
    vocabulary,
    page: p,
    pageSize: QUEUE_PAGE_SIZE,
    counts,
    rows,
    siblings,
    neighbours,
    hasMore: p * QUEUE_PAGE_SIZE < counts[vocabulary],
  };
}
