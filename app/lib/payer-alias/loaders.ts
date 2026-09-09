/**
 * Payer-alias ruling queue — SERVER-ONLY read layer for /admin/payer-aliases.
 *
 * This module builds a pg pool; importing it from a Client Component fails the build loudly. The
 * page is a Server Component and passes plain data down — there is NO client-side DB access on this
 * surface, and no route handler either.
 *
 * POOL: shared with the ruling write path via ./db.ts — one lazily-built claims_reader pool serves
 * both halves of this surface. Importing this module reads no env and opens no socket, which is what
 * lets the assembly be tested hermetically.
 *
 * ⚠️ DELIBERATELY NOT WRAPPED IN `unstable_cache`. A failed background revalidation there serves the
 * previous value silently, which on a ruling queue would mean a reviewer working a list that no
 * longer reflects what is unruled — and the failure would never surface. The page is
 * `force-dynamic`; every load is a real read. If a query throws, it throws.
 *
 * READ-ONLY. This module issues SELECTs only: no definer call, no INSERT/UPDATE, no audit row. The
 * write chain lives in the Server Action, not here.
 */
import { payerAliasDb, type PayerAliasDb } from './db';
import {
  buildPayerAliasQueueQuery,
  buildPayerAliasQueueCountsQuery,
  buildPayerAliasSiblingsQuery,
  buildPayerAliasNeighboursQuery,
  buildPayerAliasVobNamesQuery,
  buildPayerIdentityOptionsQuery,
  clampPage,
  PAYER_ALIAS_VOCABULARIES,
  QUEUE_PAGE_SIZE,
  type PayerAliasNeighbourRow,
  type PayerAliasQueueRow,
  type PayerAliasSiblingRow,
  type PayerAliasVobNameRow,
  type PayerAliasVocabulary,
  type PayerIdentityOptionRow,
} from '../../../src/collections/payerAliasQueue';

/** Re-exported so existing callers and tests keep one import site for the handle type. */
export type QueueReader = PayerAliasDb;

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
  /**
   * payer id (the alias_norm) → the VOB names filed under it, heaviest first, capped per id.
   * Populated on the `vob_payer_id` tab ONLY — a payer-id join is meaningless for the two NAME
   * vocabularies, so for those this is `{}` and no query is issued. Non-PHI: names and counts.
   */
  vobNames: Record<string, PayerAliasVobNameRow[]>;
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
 * One queue page plus all of its decision context, in at most FIVE queries — never a query per row.
 * The fifth (VOB names behind a payer id) runs only on the vob_payer_id tab.
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
  db: QueueReader = payerAliasDb(),
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
  let vobNames: Record<string, PayerAliasVobNameRow[]> = {};
  if (aliasNorms.length > 0) {
    const sibQ = buildPayerAliasSiblingsQuery(aliasNorms, vocabulary);
    const nbrQ = buildPayerAliasNeighboursQuery(aliasNorms);
    // On the vob_payer_id tab the alias IS a payer id, so the page's alias set is the id set — one
    // batched query, never one per card. On a name tab the join would be meaningless: skipped.
    const vobQ = vocabulary === 'vob_payer_id' ? buildPayerAliasVobNamesQuery(aliasNorms) : null;
    const [sibRes, nbrRes, vobRes] = await Promise.all([
      db.query<PayerAliasSiblingRow>(sibQ.sql, sibQ.params),
      db.query<PayerAliasNeighbourRow>(nbrQ.sql, nbrQ.params),
      vobQ
        ? db.query<PayerAliasVobNameRow>(vobQ.sql, vobQ.params)
        : Promise.resolve({ rows: [] as PayerAliasVobNameRow[] }),
    ]);
    // ⚠️ THE TWO KEYS ARE DIFFERENT AND THE DIFFERENCE IS EASY TO MISS. A sibling row IS the alias
    // (same string, other vocabulary), so it groups by `alias_norm`. A neighbour row is a DIFFERENT
    // alias that merely looks like the one on screen, so its own `alias_norm` is the look-alike and
    // the column that names the row it belongs to is `seed`. Keying neighbours on `alias_norm` would
    // group every card under the wrong string and blank the look-alike panel everywhere, silently.
    siblings = groupBy(sibRes.rows, (r) => r.alias_norm);
    neighbours = groupBy(nbrRes.rows, (r) => r.seed);
    // A VOB-name row's `payer_id` is the alias_norm it was batched under — the card's own key. Its
    // `name` is a DIFFERENT string (an insurance-co name), so keying on that would scatter every
    // id's names under the names themselves, exactly the neighbour mistake above in a new coat.
    vobNames = groupBy(vobRes.rows, (r) => r.payer_id);
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
    vobNames,
    hasMore: p < lastPage,
  };
}

/** Active canonical payers for the ruling form's picker. Read-only, like everything else here. */
export async function loadRulingIdentities(
  db: QueueReader = payerAliasDb(),
): Promise<PayerIdentityOptionRow[]> {
  const q = buildPayerIdentityOptionsQuery();
  const res = await db.query<PayerIdentityOptionRow>(q.sql, q.params);
  return res.rows;
}
