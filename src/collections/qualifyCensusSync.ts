/**
 * Qualify Phase G — monday census SYNC (the I/O twin of qualifyCensus.ts). Fetches per-board column
 * values from monday's GraphQL API and upserts facility-grain aggregates.
 *
 * PHI POSTURE (the whole point of this file's shape):
 *  - Census boards: the GraphQL selection asks for `column_values` ONLY — the item `name` field
 *    (a patient name) is NEVER in any census query string. Grep this file: `name` appears solely
 *    in the Facility Info and discovery queries, whose items/boards are facilities and boards.
 *  - The token (MONDAY_SECRET_API_KEY) is read from env at call time, never logged, never thrown.
 *    Provisioned in Vercel (Preview + Production) 2026-08-04; the sync is scheduled hourly at :22.
 *  - LEAST-PRIVILEGE (carried): whether the deployed token is a dedicated read-only monday
 *    identity or a personal key is operator-owned — verify before widening this sync's scope.
 *
 * THE UNIT OF WORK IS A FACILITY, NOT A BOARD. Board -> facility is N:1, and facility_code is the
 * census table's primary key, so two boards for one facility must be CONCATENATED at item level and
 * aggregated once. Upserting per board would make the second board overwrite the first
 * (last-write-wins) and averaging per-board averages would weight a 53-item board equally with a
 * 39-item one. See qualifyCensus.ts's CensusFacilityConfig.
 *
 * No retry loop: a failed board is reported and skipped. A facility whose boards ALL failed keeps
 * its previous row (the factor reads slightly-stale aggregates rather than nothing); a facility
 * where only some boards failed is NOT upserted, because a partial item set would silently
 * under-report its averages. The cron cadence self-heals.
 */
import type pg from 'pg';
import {
  CENSUS_BLOCKED_BOARDS,
  CENSUS_EXCLUDED_BOARD_IDS,
  CENSUS_TITLES,
  CENSUS_WORKSPACE_IDS,
  MONDAY_CENSUS_FACILITIES,
  MONDAY_FACILITY_INFO_BOARD,
  aggregateCensusItems,
  buildFacilityCareSettingQuery,
  buildUpsertCensusRowQuery,
  checkCareSetting,
  conformanceHasGap,
  emptyResolvedColumns,
  representativeBoardId,
  resolveCensusColumns,
  type BoardColumn,
  type CensusConformance,
  type CensusFacilityConfig,
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
  /** Facilities configured / upserted / skipped because a board of theirs failed. */
  facilities_total: number;
  facilities_synced: number;
  facilities_failed: number;
  /** BOARDS, summed across every configured facility — what the 0087 run-log columns count. */
  boards_total: number;
  boards_synced: number;
  boards_failed: number;
  conformance: CensusConformance[];
  capacity_mapped: number;
  /** Facility Info item names with NO roster mapping (PR #73 review): a rename or a new facility
   *  must show up in the report like a missing column does — never silently lose its capacity. */
  capacity_unmapped: string[];
  /** Healthy boards deliberately NOT mapped, because the facility has no live roster row. Reported
   *  every run so a blocked board cannot be quietly forgotten. */
  blocked_boards: Array<{ boardId: string; boardName: string; blocker: string }>;
}

/** Fetch care_setting for the configured codes so family <-> care_setting can be asserted. */
async function fetchCareSettings(
  client: pg.PoolClient,
  facilityCodes: readonly string[],
): Promise<Map<string, string | null>> {
  const q = buildFacilityCareSettingQuery(facilityCodes);
  const { rows } = await client.query<{ facility_code: string; care_setting: string | null }>(q.sql, q.params);
  return new Map(rows.map((r) => [r.facility_code, r.care_setting]));
}

/**
 * Run one full sync: every configured FACILITY -> one aggregate row (items concatenated across all
 * of its boards), plus bed capacity from the Facility Info board where a name mapping exists.
 * `client` is a cmd_rollup_writer connection; each facility upserts independently.
 */
export async function runQualifyCensusSync(
  client: pg.PoolClient,
  opts: { facilities?: readonly CensusFacilityConfig[]; today?: string } = {},
): Promise<CensusSyncStats> {
  const facilities = opts.facilities ?? MONDAY_CENSUS_FACILITIES;
  // "Today" in US Central, not UTC: the boards are US facilities, and a UTC date rolls forward at
  // ~6-7pm CT — which would drop a UR review due TODAY from the chip all evening, and would add a
  // spurious day to every in-house LOS for those hours.
  const today = opts.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const stats: CensusSyncStats = {
    facilities_total: facilities.length,
    facilities_synced: 0,
    facilities_failed: 0,
    boards_total: facilities.reduce((n, f) => n + f.boardIds.length, 0),
    boards_synced: 0,
    boards_failed: 0,
    conformance: [],
    capacity_mapped: 0,
    capacity_unmapped: [],
    blocked_boards: [...CENSUS_BLOCKED_BOARDS],
  };

  // Blocked boards are healthy monday boards with no roster row. facility_code has NO FK, so mapping
  // one would write an orphan census row rather than erroring — log them every run.
  if (stats.blocked_boards.length > 0) {
    console.warn(
      `qualify-census: ${stats.blocked_boards.length} board(s) blocked on a roster row: ` +
        stats.blocked_boards.map((b) => `${b.boardName} (${b.boardId}) — ${b.blocker}`).join(' | '),
    );
  }

  // care_setting for the structural assertion. Fail-soft: if this read fails the sync still runs and
  // every settingMismatch reads as "unknown" rather than taking the feed down.
  let careSettings: Map<string, string | null> = new Map();
  try {
    careSettings = await fetchCareSettings(client, facilities.map((f) => f.facilityCode));
  } catch (err) {
    console.error(
      `qualify-census: care_setting read failed, family<->care_setting unasserted (${err instanceof Error ? err.message : 'error'})`,
    );
  }

  // Bed capacity: Facility Info items are FACILITIES (names are facility names — non-PHI).
  let capacity: Map<string, number> = new Map();
  try {
    const cap = await fetchBedCapacity();
    capacity = cap.byCode;
    stats.capacity_mapped = capacity.size;
    stats.capacity_unmapped = cap.unmapped;
    if (cap.unmapped.length > 0) {
      console.warn(
        `qualify-census: ${cap.unmapped.length} facility-info name(s) with no roster mapping: ${cap.unmapped.join(', ')}`,
      );
    }
  } catch (err) {
    console.error(`qualify-census: facility-info fetch failed (${err instanceof Error ? err.message : 'error'})`);
  }

  for (const facility of facilities) {
    const t = CENSUS_TITLES[facility.family];
    const items: CensusItem[] = [];
    const missingTitles = new Set<string>();
    // Logical titles that carried at least one value on at least one of this facility's boards.
    const sawValue = new Set<string>();
    let familyMismatch: string | null = null;
    let boardsOk = 0;

    for (const boardId of facility.boardIds) {
      try {
        const columns = await fetchBoardColumns(boardId);
        const resolved = resolveCensusColumns(columns, facility.family);
        for (const m of resolved.missing) missingTitles.add(m);
        if (resolved.familyMismatch !== null && familyMismatch === null) {
          familyMismatch = `board ${boardId}: ${resolved.familyMismatch}`;
        }
        const byTitle: Array<{ title: string; id: string | null }> = [
          { title: t.status, id: resolved.statusId },
          { title: t.adm, id: resolved.admId },
          { title: t.dc, id: resolved.dcId },
          { title: CENSUS_TITLES.universal.auth, id: resolved.authId },
          { title: CENSUS_TITLES.universal.ur, id: resolved.urId },
        ];
        const ids = byTitle.map((x) => x.id).filter((x): x is string => x !== null);
        const rows = ids.length > 0 ? await fetchCensusItems(boardId, ids) : [];

        // Value-level conformance: a title that resolved on this board AND carried a value here is
        // proven live, even if a sibling board leaves it blank.
        const emptyHere = new Set(emptyResolvedColumns(rows, byTitle));
        for (const { title, id } of byTitle) {
          if (id !== null && !emptyHere.has(title)) sawValue.add(title);
        }

        for (const r of rows) {
          items.push({
            status: resolved.statusId ? (r[resolved.statusId] ?? null) : null,
            authDays: resolved.authId ? num(r[resolved.authId]) : null,
            admDate: resolved.admId ? isoDate(r[resolved.admId]) : null,
            dcDate: resolved.dcId ? isoDate(r[resolved.dcId]) : null,
            urDate: resolved.urId ? isoDate(r[resolved.urId]) : null,
          });
        }
        boardsOk++;
        stats.boards_synced++;
      } catch (err) {
        stats.boards_failed++;
        // board id + monday's error MESSAGE (non-PHI: census selections never include names)
        console.error(
          `qualify-census: board ${boardId} (${facility.facilityCode}) failed (${err instanceof Error ? err.message : 'error'})`,
        );
      }
    }

    // A title that resolved somewhere but never carried a value anywhere. Only meaningful once the
    // facility has items — on an empty board every column is trivially empty, which is a board
    // state, not a column defect.
    const allTitles = [t.status, t.adm, t.dc, CENSUS_TITLES.universal.auth, CENSUS_TITLES.universal.ur];
    const emptyTitles =
      items.length > 0 ? allTitles.filter((x) => !missingTitles.has(x) && !sawValue.has(x)) : [];

    const conformance: CensusConformance = {
      facilityCode: facility.facilityCode,
      family: facility.family,
      boardIds: [...facility.boardIds],
      itemCount: items.length,
      missingTitles: [...missingTitles],
      emptyTitles,
      familyMismatch,
      settingMismatch: checkCareSetting(facility.family, careSettings.get(facility.facilityCode)),
    };
    stats.conformance.push(conformance);
    if (conformanceHasGap(conformance)) {
      console.warn(
        `qualify-census: ${facility.facilityCode} [boards ${facility.boardIds.join(',')}] conformance — ` +
          [
            conformance.missingTitles.length > 0 ? `missing: ${conformance.missingTitles.join(', ')}` : null,
            conformance.emptyTitles.length > 0 ? `resolved-but-empty: ${conformance.emptyTitles.join(', ')}` : null,
            conformance.familyMismatch,
            conformance.settingMismatch,
          ]
            .filter((s): s is string => s !== null && s !== '')
            .join('; '),
      );
    }

    // Only upsert when EVERY board for this facility was read. A partial set would silently
    // under-report the averages while looking like a clean run.
    if (boardsOk !== facility.boardIds.length) {
      stats.facilities_failed++;
      continue;
    }

    try {
      const agg = aggregateCensusItems(items, today, facility.family);
      const upsert = buildUpsertCensusRowQuery({
        facility_code: facility.facilityCode,
        board_id: representativeBoardId(facility.boardIds),
        board_family: facility.family,
        admitted_count: agg.admittedCount,
        open_beds: agg.openBeds,
        bed_capacity: capacity.get(facility.facilityCode) ?? null,
        avg_auth_days: agg.avgAuthDays,
        avg_los_days: agg.avgLosDays,
        auth_sample: agg.authSample,
        next_ur_date: agg.nextUrDate,
      });
      await client.query(upsert.sql, upsert.params);
      stats.facilities_synced++;
    } catch (err) {
      stats.facilities_failed++;
      console.error(
        `qualify-census: upsert for ${facility.facilityCode} failed (${err instanceof Error ? err.message : 'error'})`,
      );
    }
  }
  return stats;
}

/** Facility Info '# of Beds' by facility_code, via the operator-curated name -> code map.
 *
 *  Keys are matched against `item.name.trim().toUpperCase()`, so they must be the FACILITY INFO
 *  board's item names — NOT the census board names, which use a different convention for the same
 *  facility ("Nashville MH Admissions Census" vs the item "Nashville Mental Health").
 *
 *  MEASURED 2026-08-05: only the two 'MH' keys existed and NEITHER matched, so fetchBedCapacity
 *  returned an empty map on every run and `capacity.get(code) ?? null` wrote bed_capacity = NULL for
 *  every facility. A live --discover run listed all 23 Facility Info names; the two mapped below are
 *  verbatim from it. The 'MH' spellings are retained as aliases because both conventions are live in
 *  the same workspace and a rename in either direction would silently re-break capacity.
 *
 *  STILL PARTIAL, deliberately out of scope here: the remaining ~21 Facility Info names are reported
 *  as `capacity_unmapped` every run rather than guessed at. Capacity is context, not a rating input. */
const FACILITY_INFO_NAME_TO_CODE: Readonly<Record<string, string>> = {
  // Verbatim Facility Info item names — the spellings that actually match (measured 2026-08-05).
  'NASHVILLE MENTAL HEALTH': 'NASH', // roster-verified — collections.facilities keys these by mnemonic
  'LONESTAR MENTAL HEALTH': 'LSMH',
  // Aliases: the census-board convention, kept so a rename toward it does not re-break capacity.
  'NASHVILLE MH': 'NASH',
  'LONESTAR MH': 'LSMH',
};

async function fetchBedCapacity(): Promise<{ byCode: Map<string, number>; unmapped: string[] }> {
  const columns = await fetchBoardColumns(MONDAY_FACILITY_INFO_BOARD);
  const bedsCol = columns.find((c) => c.title.trim().toLowerCase() === '# of beds')?.id;
  if (!bedsCol) return { byCode: new Map(), unmapped: [] };
  const data = await mondayQuery<{
    boards: Array<{ items_page: { items: Array<{ name: string; column_values: Array<{ id: string; text: string | null }> }> } }>;
  }>(
    // `name` is requested HERE ONLY — Facility Info items are facilities, not patients.
    'query ($ids: [ID!], $cols: [String!]) { boards(ids: $ids) { items_page(limit: 100) { items { name column_values(ids: $cols) { id text } } } } }',
    { ids: [MONDAY_FACILITY_INFO_BOARD], cols: [bedsCol] },
  );
  const out = new Map<string, number>();
  const unmapped: string[] = [];
  for (const item of data.boards[0]?.items_page.items ?? []) {
    const code = FACILITY_INFO_NAME_TO_CODE[item.name.trim().toUpperCase()];
    const beds = num(item.column_values.find((cv) => cv.id === bedsCol)?.text ?? null);
    if (!code) {
      unmapped.push(item.name.trim()); // facility name — non-PHI by board construction
      continue;
    }
    if (beds !== null && beds > 0) out.set(code, Math.trunc(beds));
  }
  return { byCode: out, unmapped };
}

/** How many boards one `boards(...)` page can return. monday's own maximum for this field. */
const DISCOVER_PAGE_SIZE = 100;
/** Hard stop on the page loop — 25 pages x 100 is far beyond any real workspace. */
const DISCOVER_MAX_PAGES = 25;

export interface DiscoveredBoard {
  id: string;
  name: string;
  workspaceId: string;
}

/**
 * --discover: list census-candidate boards so an operator can extend the registry.
 * Board NAMES are board/facility titles (non-PHI). Used by the CLI only.
 *
 * TWO BLIND SPOTS THIS FIXES, both of which produced confidently wrong onboarding advice:
 *
 *  1. NO PAGINATION. The old query was `boards(workspace_ids: $ws, limit: 100)` with no `page`.
 *     `A. Admissions (Main)` holds 128 boards, so page 1 returned the 100 newest and page 2 — which
 *     holds ALL TEN of the oldest census boards (AMH, Pacific, Opus, Revival, Tennessee Behavioral,
 *     CAMH, SVR, Hillside, Nashville MH, Lonestar MH) plus the Facility Info board — was never
 *     fetched. A prior run concluded "CAMH, PCMH and TBH have no board"; all three exist. The
 *     absence was the cap, not the data. Worse, the truncation was SILENT: exactly 100 rows looks
 *     like a complete answer.
 *  2. ONE WORKSPACE. `MHC PHP/IOP` holds two more live census boards, invisible to a pass over Main.
 *
 * So: loop `page` until a short page comes back, accept several workspaces, and report the per-
 * workspace total so a future truncation is visible rather than inferred.
 */
export async function discoverWorkspaceBoards(
  workspaceIds: readonly string[] = CENSUS_WORKSPACE_IDS,
): Promise<{ boards: DiscoveredBoard[]; perWorkspace: Array<{ workspaceId: string; total: number; pages: number }> }> {
  const excluded = new Set(CENSUS_EXCLUDED_BOARD_IDS);
  const boards: DiscoveredBoard[] = [];
  const perWorkspace: Array<{ workspaceId: string; total: number; pages: number }> = [];

  for (const workspaceId of workspaceIds) {
    let total = 0;
    let pages = 0;
    // monday's `page` is 1-based.
    for (let page = 1; page <= DISCOVER_MAX_PAGES; page++) {
      const data = await mondayQuery<{ boards: Array<{ id: string; name: string; board_kind: string }> }>(
        'query ($ws: [ID!], $limit: Int!, $page: Int!) { boards(workspace_ids: $ws, limit: $limit, page: $page) { id name board_kind } }',
        { ws: [workspaceId], limit: DISCOVER_PAGE_SIZE, page },
      );
      const batch = data.boards ?? [];
      pages = page;
      total += batch.length;
      for (const b of batch) {
        if (b.board_kind === 'sub_item_board') continue;
        if (excluded.has(b.id)) continue;
        boards.push({ id: b.id, name: b.name, workspaceId });
      }
      // A short page is the end of the workspace. A full page means there may be more — the bug this
      // replaces was treating a full page as the end.
      if (batch.length < DISCOVER_PAGE_SIZE) break;
    }
    perWorkspace.push({ workspaceId, total, pages });
  }
  return { boards, perWorkspace };
}
