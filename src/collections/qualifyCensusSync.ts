/**
 * Qualify Phase G — monday census SYNC (the I/O twin of qualifyCensus.ts). Fetches per-board
 * column values from monday's GraphQL API and upserts facility-grain aggregates.
 *
 * PHI POSTURE (the whole point of this file's shape):
 *  - Census boards: the GraphQL selection asks for `column_values` ONLY — the item `name` field
 *    (a patient name) is NEVER in any census query string. Grep this file: `name` appears solely
 *    in the Facility Info query, whose items are facilities.
 *  - The token (MONDAY_SECRET_API_KEY) is read from env at call time, never logged, never thrown.
 *  - LEAST-PRIVILEGE GAP (recon 2026-08-03, carried, not fixed here): the deployed token is a
 *    personal admin-scoped key. Provision a dedicated read-only monday identity before this sync
 *    is scheduled — tracked in the morning runbook.
 *
 * No retry loop: a failed board is reported and skipped (the table keeps its previous row; the
 * factor reads slightly-stale aggregates rather than nothing). The cron cadence self-heals.
 */
import type pg from 'pg';
import {
  MONDAY_CENSUS_BOARDS,
  MONDAY_FACILITY_INFO_BOARD,
  aggregateCensusItems,
  buildUpsertCensusRowQuery,
  resolveCensusColumns,
  type BoardColumn,
  type CensusBoardConfig,
  type CensusConformance,
  type CensusItem,
} from './qualifyCensus.js';

const MONDAY_API = 'https://api.monday.com/v2';

function mondayToken(): string {
  const t = process.env.MONDAY_SECRET_API_KEY;
  if (!t || t.trim() === '') {
    throw new Error('Missing MONDAY_SECRET_API_KEY (set in env; never hardcode or log it)');
  }
  return t;
}

async function mondayQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: mondayToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday API ${res.status}`); // status only — never the body (could echo the query)
  const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (json.errors?.length) throw new Error(`monday API error: ${json.errors[0]?.message ?? 'unknown'}`);
  if (!json.data) throw new Error('monday API returned no data');
  return json.data;
}

/** Fetch a board's column catalog (id + title only). */
async function fetchBoardColumns(boardId: string): Promise<BoardColumn[]> {
  const data = await mondayQuery<{ boards: Array<{ columns: Array<{ id: string; title: string }> }> }>(
    'query ($ids: [ID!]) { boards(ids: $ids) { columns { id title } } }',
    { ids: [boardId] },
  );
  return data.boards[0]?.columns ?? [];
}

/** Fetch a census board's items — COLUMN VALUES ONLY (no item names; census names are patients). */
async function fetchCensusItems(boardId: string, columnIds: string[]): Promise<Array<Record<string, string | null>>> {
  const out: Array<Record<string, string | null>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: {
      boards: Array<{
        items_page: { cursor: string | null; items: Array<{ column_values: Array<{ id: string; text: string | null }> }> };
      }>;
    } = await mondayQuery(
      'query ($ids: [ID!], $cols: [String!], $cursor: String) { boards(ids: $ids) { items_page(limit: 250, cursor: $cursor) { cursor items { column_values(ids: $cols) { id text } } } } }',
      { ids: [boardId], cols: columnIds, cursor },
    );
    const pageData = data.boards[0]?.items_page;
    for (const item of pageData?.items ?? []) {
      const row: Record<string, string | null> = {};
      for (const cv of item.column_values) row[cv.id] = cv.text;
      out.push(row);
    }
    cursor = pageData?.cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

function num(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const t = text.trim();
  if (t === '') return null;
  const v = Number(t.replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

function isoDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

export interface CensusSyncStats {
  boards_total: number;
  boards_synced: number;
  boards_failed: number;
  conformance: CensusConformance[];
  capacity_mapped: number;
}

/**
 * Run one full sync: every configured census board → one aggregate row, plus bed capacity from the
 * Facility Info board where a name mapping exists. `client` is a cmd_rollup_writer connection; each
 * board upserts independently (a failed board never poisons the others).
 */
export async function runQualifyCensusSync(
  client: pg.PoolClient,
  opts: { boards?: readonly CensusBoardConfig[]; today?: string } = {},
): Promise<CensusSyncStats> {
  const boards = opts.boards ?? MONDAY_CENSUS_BOARDS;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const stats: CensusSyncStats = {
    boards_total: boards.length,
    boards_synced: 0,
    boards_failed: 0,
    conformance: [],
    capacity_mapped: 0,
  };

  // Bed capacity: Facility Info items are FACILITIES (names are facility names — non-PHI). The name
  // is matched against collections facility display names by the operator-curated map below.
  let capacity: Map<string, number> = new Map();
  try {
    capacity = await fetchBedCapacity();
    stats.capacity_mapped = capacity.size;
  } catch (err) {
    console.error(`qualify-census: facility-info fetch failed (${err instanceof Error ? err.message : 'error'})`);
  }

  for (const board of boards) {
    try {
      const columns = await fetchBoardColumns(board.boardId);
      const resolved = resolveCensusColumns(columns, board.family);
      stats.conformance.push({
        boardId: board.boardId,
        facilityCode: board.facilityCode,
        family: board.family,
        missing: resolved.missing,
      });
      const ids = [resolved.statusId, resolved.authId, resolved.losId, resolved.urId].filter(
        (x): x is string => x !== null,
      );
      const rows = ids.length > 0 ? await fetchCensusItems(board.boardId, ids) : [];
      const items: CensusItem[] = rows.map((r) => ({
        status: resolved.statusId ? (r[resolved.statusId] ?? null) : null,
        authDays: resolved.authId ? num(r[resolved.authId]) : null,
        losDays: resolved.losId ? num(r[resolved.losId]) : null,
        urDate: resolved.urId ? isoDate(r[resolved.urId]) : null,
      }));
      const agg = aggregateCensusItems(items, today);
      const upsert = buildUpsertCensusRowQuery({
        facility_code: board.facilityCode,
        board_id: board.boardId,
        board_family: board.family,
        admitted_count: agg.admittedCount,
        open_beds: agg.openBeds,
        bed_capacity: capacity.get(board.facilityCode) ?? null,
        avg_auth_days: agg.avgAuthDays,
        avg_los_days: agg.avgLosDays,
        auth_sample: agg.authSample,
        next_ur_date: agg.nextUrDate,
      });
      await client.query(upsert.sql, upsert.params);
      stats.boards_synced++;
    } catch (err) {
      stats.boards_failed++;
      // board id + error CLASS only — never response bodies (they can echo query text)
      console.error(`qualify-census: board ${board.boardId} failed (${err instanceof Error ? err.message : 'error'})`);
    }
  }
  return stats;
}

/** Facility Info '# of Beds' by facility_code, via the operator-curated name → code map. */
const FACILITY_INFO_NAME_TO_CODE: Readonly<Record<string, string>> = {
  'NASHVILLE MH': '10030911',
  'LONESTAR MH': '10031977',
};

async function fetchBedCapacity(): Promise<Map<string, number>> {
  const columns = await fetchBoardColumns(MONDAY_FACILITY_INFO_BOARD);
  const bedsCol = columns.find((c) => c.title.trim().toLowerCase() === '# of beds')?.id;
  if (!bedsCol) return new Map();
  const data = await mondayQuery<{
    boards: Array<{ items_page: { items: Array<{ name: string; column_values: Array<{ id: string; text: string | null }> }> } }>;
  }>(
    // `name` is requested HERE ONLY — Facility Info items are facilities, not patients.
    'query ($ids: [ID!], $cols: [String!]) { boards(ids: $ids) { items_page(limit: 100) { items { name column_values(ids: $cols) { id text } } } } }',
    { ids: [MONDAY_FACILITY_INFO_BOARD], cols: [bedsCol] },
  );
  const out = new Map<string, number>();
  for (const item of data.boards[0]?.items_page.items ?? []) {
    const code = FACILITY_INFO_NAME_TO_CODE[item.name.trim().toUpperCase()];
    const beds = num(item.column_values.find((cv) => cv.id === bedsCol)?.text ?? null);
    if (code && beds !== null && beds > 0) out.set(code, Math.trunc(beds));
  }
  return out;
}

/** --discover: list the workspace's boards (id + name) so an operator can extend the census map.
 *  Board NAMES are facility/board titles (non-PHI). Used by the CLI only. */
export async function discoverWorkspaceBoards(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const data = await mondayQuery<{ boards: Array<{ id: string; name: string; board_kind: string }> }>(
    'query ($ws: [ID!]) { boards(workspace_ids: $ws, limit: 100) { id name board_kind } }',
    { ws: [workspaceId] },
  );
  return data.boards.filter((b) => b.board_kind !== 'sub_item_board').map((b) => ({ id: b.id, name: b.name }));
}
