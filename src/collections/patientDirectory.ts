/**
 * collections.cmd_patient_directory - the bounded name index behind the FULL-BOOK patient search
 * (migration 0105).
 *
 * -- WHAT PROBLEM THIS SOLVES ------------------------------------------------------------------
 * The Collections patient-name search decrypts CANDIDATE ROWS, so it carried two restrictions that
 * were both consequences of that one choice: a 2,000-row ceiling and a "narrow by facility / payer /
 * date first" gate. Neither is about names. Measured live 2026-08-18:
 *
 *   - cmd_explorer_rows                                686,503 rows
 *   - distinct (business_entity_id, member_id_bidx)     10,941  = 1.6% of the book
 *   - member_id_bidx populated                         686,503 / 686,503 = 100.00%
 *   - 11,000 libsodium decrypt + substring match            10-17 ms warm (~1.4 us each)
 *   - the same DISTINCT ON computed live                  4,265 ms (seq scan + 106 MB disk sort)
 *
 * Decryption was never the cost. The candidate QUERY was. Materialising the distinct set turns the
 * search into "read ~11k rows, decrypt them in ~15 ms", which needs no cap and no narrowing gate.
 *
 * -- WHY THE DEDUP CANNOT BE SQL ---------------------------------------------------------------
 * patient_name is libsodium secretbox with a RANDOM PER-VALUE NONCE, so two rows carrying the same
 * name carry different bytes: `select distinct patient_name` returns 686,503 rows, not 10,941. The
 * only deterministic key for a name is the keyed HMAC (blindIndex.patientNameBlindIndex), which
 * needs INDEX_HMAC_KEY and therefore cannot exist in a materialised view. That is the whole reason
 * this is an application-built table rather than a matview refreshed by the rollup's definer.
 *
 * -- THE GRAIN IS (tenant, member, NAME) -------------------------------------------------------
 * Members carry more than one distinct patient name - dependents on a subscriber's policy. Keying on
 * the member alone would keep ONE name per member and make the others UNFINDABLE. A silent miss is
 * the one failure a search must not have, so the name is part of the key and coverage is complete by
 * construction.
 *
 * MEASURED AT BUILD (2026-08-18): 213 of 10,941 members = 1.95%, against a 0.44% estimate. The
 * estimate was 4x low because it could only count the 1,374 members inside the 7.18% of rows where
 * patient_name_bidx is populated, which is not a random sample. 213 patients would have been
 * unfindable, not ~50.
 *
 * -- PHI DISCIPLINE ----------------------------------------------------------------------------
 *   - Plaintext names exist ONLY as locals inside `entriesFromRows`, for exactly as long as it takes
 *     to compute the HMAC. They are never returned, stored, logged, or put in an error.
 *   - What lands in the table is the SAME ciphertext already on cmd_explorer_rows plus two keyed
 *     HMAC tokens. The token is not PHI; its input is.
 *   - Every count this module returns is non-PHI and safe to log.
 *   - A decrypt failure is counted, never logged - the error carries ciphertext context.
 *
 * -- ROLE SPLIT (both halves are deliberate) ---------------------------------------------------
 *   - `read`  is claims_reader - the only role with SELECT on the PHI columns of cmd_explorer_rows.
 *   - `write` is cmd_rollup_writer - INSERT on the directory, and NO select grant on patient_name.
 *     It must never get one; it receives ciphertext to copy, not to read.
 * Neither role holds DELETE (0105 section 4).
 */
import { patientNameBlindIndex } from './blindIndex.js';

/** Minimal read shape - structural so a test needs neither pg nor the app's PgExecutor. */
export interface DirectoryReader {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}
/** Minimal write shape (pg.Pool satisfies it). */
export interface DirectoryWriter {
  query(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

/** One source charge line, as the scan projects it. `patient_name` is ciphertext. */
export interface DirectoryScanRow {
  id: string; // bigint -> string from node-pg
  business_entity_id: string;
  member_id_bidx: string | null;
  patient_name: Buffer;
}

/** One directory entry, ready to insert. Contains NO plaintext. */
export interface DirectoryEntry {
  business_entity_id: string;
  member_id_bidx: string;
  name_fp: string;
  patient_name: Buffer;
  first_seen_row_id: string;
}

export interface PatientDirectorySyncStats {
  /** Charge lines read from cmd_explorer_rows this run. */
  rows_scanned: number;
  /** Directory rows actually inserted (ON CONFLICT DO NOTHING absorbs already-known names). */
  names_inserted: number;
  /** Distinct (tenant, member, name) keys the scan produced, before the conflict filter. */
  keys_seen: number;
  /** Watermark after this run. */
  last_row_id: number;
  /** Rows skipped because member_id_bidx was NULL - they can never be resolved back to the grid. */
  skipped_no_member: number;
  /** Rows whose ciphertext would not decrypt. Counted, never logged. */
  decrypt_failures: number;
  /** true when the scan reached the end of the table; false when the wall-clock budget stopped it. */
  exhausted: boolean;
  duration_ms: number;
}

/** Rows per scan batch. 5,000 x ~55-byte ciphertext is ~1 MB over the wire - large enough that the
 *  686k initial build is ~140 round trips, small enough that a batch never dominates memory. */
export const SCAN_BATCH = 5_000;

/** Default wall-clock budget before the scan stops launching new batches. Leaves room under the
 *  route's 300s maxDuration for the rollup refresh that runs before it. */
export const DEFAULT_BUDGET_MS = 120_000;

export interface PatientDirectorySyncDeps {
  read: DirectoryReader;
  write: DirectoryWriter;
  /** Injected so tests never need LIBSODIUM_KEY. Production passes phiCrypto.decryptPhi. */
  decrypt: (cipher: Buffer) => Promise<string>;
  /** Injected for the same reason; production passes blindIndex.patientNameBlindIndex. */
  fingerprint?: (name: string) => string | null;
  batch?: number;
  budgetMs?: number;
  now?: () => number;
}

/**
 * The scan. Explicit column allowlist - never `select *` - and keyset on the bigserial id, which is
 * the primary key, so each batch is an index range scan regardless of how far the watermark has got.
 *
 * ⚠ DELIBERATE CROSS-TENANT READ - the justification the tenancy rule requires, stated at the query
 * site. This is a BUILD, not a user-facing read: it is the same shape as the charge-rollup refresh,
 * which also rebuilds every tenant in one pass because a derived index that covered one tenant would
 * simply be wrong for the other. There is no single caller whose entitlement could scope it, and the
 * entity is not dropped - every row's own `business_entity_id` is carried into the directory key, so
 * tenant identity survives the build rather than being flattened out of it.
 *
 * Isolation is applied where a PRINCIPAL exists: `buildPatientDirectoryReadQuery` below binds the
 * server-derived entitlement, and the directory's primary key leads with the entity so a read cannot
 * cross tenants even by accident.
 */
export function buildPatientDirectoryScanQuery(
  afterId: string | number,
  limit: number,
): { sql: string; params: unknown[] } {
  return {
    sql:
      'select id, business_entity_id, member_id_bidx, patient_name ' +
      'from collections.cmd_explorer_rows where id > $1 order by id limit $2',
    params: [String(afterId), limit],
  };
}

/**
 * The search-side read: the caller's entitled slice of the directory.
 *
 * ⚠ MULTI-ENTITY BY DESIGN, and here is the required justification. `entityIds` may legitimately
 * hold MORE THAN ONE business_entity_id, because a super_admin's Consolidated view is defined as
 * both tenants at once - that is the product, not a leak. What makes it safe is that the list is
 * ALWAYS the server-derived intersection of the caller's PHI entitlement with the view they are on
 * (requirePhiPrincipal + viewEntityScope); no client input reaches it, so a caller can never widen
 * the slice by asking.
 *
 * ⚠ business_entity_id IS PROJECTED, AND THAT IS LOAD-BEARING - it was missing in the first draft
 * and Qodo was right to call it. A member blind index is a keyed HMAC of the member id and nothing
 * else, so it is TENANT-AGNOSTIC: the same member id in both tenants produces the same token.
 * Measured live 2026-08-18, this is not hypothetical - 240 of 10,701 member tokens exist in BOTH
 * tenants. Returning bare tokens meant a name matched in one tenant selected the other tenant's
 * rows for all 240, in Consolidated view where both are visible and the mix is invisible. The
 * search now carries (entity, member) PAIRS end to end.
 *
 * `business_entity_id = any($1)` is the leading column of the primary key, so this stays a plain
 * index range scan.
 */
export function buildPatientDirectoryReadQuery(
  entityIds: readonly string[],
): { sql: string; params: unknown[] } {
  return {
    sql:
      'select business_entity_id, member_id_bidx, name_fp, patient_name ' +
      'from collections.cmd_patient_directory where business_entity_id = any($1::uuid[])',
    params: [entityIds],
  };
}

/**
 * Directory freshness: how STALE the sync is, and how many charge lines it trails by.
 *
 * ⚠ READ THE STALENESS, NOT THE LAG — the lag alone is a bad alarm and shipping it as one was a
 * mistake worth recording. The sync runs hourly; ~6,000 charge lines land per day. So `lag > 0` is
 * true for most of every hour and would fire a warning on nearly every search. Worse, it would be
 * fire on a HEALTHY system: 6,000 lines/day spread over 11,161 patients means almost every one of
 * those rows belongs to a patient the directory ALREADY holds. A warning that is nearly always on
 * tells the user nothing and trains them to ignore the one time it matters.
 *
 * What actually threatens the whole-book promise is a sync that has STOPPED — the missing-key throw,
 * a permission change, a budget-stopped run that never catches up. That shows as `refreshed_at`
 * ceasing to advance, which is what `stale_minutes` measures.
 *
 * The row lag is still returned, but as the SIZE of the exposure once staleness has established that
 * there IS one — "3 hours behind, 4,000 lines unindexed" is actionable; "12 lines unindexed" is not.
 *
 * Cheap enough to run per search: `max(id)` is a primary-key scan and the state read is one row.
 */
export function buildPatientDirectoryFreshnessQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      'select coalesce((select max(id) from collections.cmd_explorer_rows), 0) ' +
      '     - coalesce((select last_row_id from collections.cmd_patient_directory_state), 0) as lag_rows, ' +
      'coalesce(extract(epoch from (now() - (select refreshed_at ' +
      '  from collections.cmd_patient_directory_state))) / 60, 0)::int as stale_minutes',
    params: [],
  };
}

/**
 * Turn a scan batch into directory entries: decrypt each name, fingerprint it, and dedupe within the
 * batch so a patient with 400 charge lines contributes one row rather than 400 identical INSERT
 * tuples. Cross-batch duplicates are absorbed by ON CONFLICT DO NOTHING.
 *
 * THE PLAINTEXT LIVES ONLY IN `name`, AND ONLY UNTIL THE HMAC IS COMPUTED. Do not widen the return
 * type to carry it, do not log it, and do not put it in an error - the whole point of this module is
 * that a name is decrypted, fingerprinted and dropped.
 */
export async function entriesFromRows(
  rows: readonly DirectoryScanRow[],
  decrypt: (c: Buffer) => Promise<string>,
  fingerprint: (n: string) => string | null,
): Promise<{ entries: DirectoryEntry[]; skippedNoMember: number; decryptFailures: number }> {
  const byKey = new Map<string, DirectoryEntry>();
  let skippedNoMember = 0;
  let decryptFailures = 0;

  for (const row of rows) {
    // A row with no member token can never be resolved back to grid rows, so indexing its name
    // would produce a match that selects nothing. Counted rather than silently dropped: it is
    // 0 of 686,503 today, and a non-zero count means the ingest stopped stamping the token.
    if (row.member_id_bidx === null || row.member_id_bidx === '') {
      skippedNoMember += 1;
      continue;
    }
    let name: string;
    try {
      name = await decrypt(row.patient_name);
    } catch {
      // Deliberately not logged - the error's context is ciphertext. One bad row must not fail a
      // sync, exactly as one bad row must not fail a search.
      decryptFailures += 1;
      continue;
    }
    const fp = fingerprint(name);
    // null only for an empty/blank name (the key itself is probed up front, see syncPatientDirectory).
    if (fp === null) continue;

    const key = `${row.business_entity_id} ${row.member_id_bidx} ${fp}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      business_entity_id: row.business_entity_id,
      member_id_bidx: row.member_id_bidx,
      name_fp: fp,
      patient_name: row.patient_name,
      first_seen_row_id: row.id,
    });
  }

  return { entries: [...byKey.values()], skippedNoMember, decryptFailures };
}

/** Multi-row INSERT with the conflict filter. Every value is a bound parameter. */
export function buildPatientDirectoryInsert(
  entries: readonly DirectoryEntry[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = entries.map((e) => {
    const b = params.length;
    params.push(e.business_entity_id, e.member_id_bidx, e.name_fp, e.patient_name, e.first_seen_row_id);
    return `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::bigint)`;
  });
  return {
    sql:
      'insert into collections.cmd_patient_directory ' +
      '(business_entity_id, member_id_bidx, name_fp, patient_name, first_seen_row_id) values ' +
      `${tuples.join(', ')} on conflict (business_entity_id, member_id_bidx, name_fp) do nothing`,
    params,
  };
}


/**
 * Record that the sync RAN: advance the watermark, accumulate the counters, and stamp refreshed_at.
 *
 * Called on BOTH paths — after a batch, and on the zero-row scan that means "already caught up".
 * The second call is the one that matters for the alarm: without it, `refreshed_at` only moves when
 * there is new data, so a quiet feed is indistinguishable from a dead sync.
 *
 * Counters ACCUMULATE (`+ excluded`), so passing 0/0 stamps the time without disturbing the totals.
 */
async function touchDirectoryState(
  write: DirectoryWriter,
  watermark: number,
  rowsScanned = 0,
  namesInserted = 0,
): Promise<void> {
  await write.query(
    `insert into collections.cmd_patient_directory_state
            (singleton, last_row_id, rows_scanned, names_inserted, refreshed_at)
          values (true, $1, $2, $3, now())
     on conflict (singleton) do update
          set last_row_id    = excluded.last_row_id,
              rows_scanned   = collections.cmd_patient_directory_state.rows_scanned + excluded.rows_scanned,
              names_inserted = collections.cmd_patient_directory_state.names_inserted + excluded.names_inserted,
              refreshed_at   = excluded.refreshed_at`,
    [watermark, rowsScanned, namesInserted],
  );
}

/**
 * Bring the directory up to date with cmd_explorer_rows.
 *
 * THE WATERMARK IS STORED, NOT DERIVED. `max(first_seen_row_id)` would be wrong: a batch of new
 * charge lines for patients already in the directory inserts NOTHING, so a derived watermark would
 * never advance past them and every run would re-scan the same rows forever. It is written after
 * every batch, so a mid-run platform kill resumes from where it stopped instead of from zero.
 *
 * FAILS LOUD ON A KEY PROBLEM, BEFORE ANY WORK. Without INDEX_HMAC_KEY nothing can be fingerprinted,
 * so the sync would scan the whole book, insert nothing, and report a clean run - the exact
 * "succeeded while doing nothing" shape that hid the BXR explorer outage for eleven hours.
 *
 * The probe covers BOTH ways that can happen, which is why it is a call and not an env check:
 * production's `patientNameBlindIndex` THROWS BlindIndexError on a missing/short/non-hex key (the
 * throwing variant is used deliberately here - `patientNameBlindIndexSafe` exists for the ingest
 * money path, where a null must not break a write, and is the wrong choice for a builder whose
 * entire output is fingerprints), while an INJECTED fingerprint that returns null for everything is
 * caught by the explicit null check.
 */
export async function syncPatientDirectory(
  deps: PatientDirectorySyncDeps,
): Promise<PatientDirectorySyncStats> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const batch = deps.batch ?? SCAN_BATCH;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const fingerprint = deps.fingerprint ?? patientNameBlindIndex;

  if (fingerprint('directory-key-probe') === null) {
    throw new Error(
      'INDEX_HMAC_KEY missing/invalid - the patient directory cannot be built without it ' +
        '(every name would fingerprint to null and the sync would silently insert nothing)',
    );
  }

  const stats: PatientDirectorySyncStats = {
    rows_scanned: 0,
    names_inserted: 0,
    keys_seen: 0,
    last_row_id: 0,
    skipped_no_member: 0,
    decrypt_failures: 0,
    exhausted: false,
    duration_ms: 0,
  };

  const stateRes = await deps.read.query<{ last_row_id: string }>(
    'select last_row_id from collections.cmd_patient_directory_state where singleton',
    [],
  );
  let watermark = Number(stateRes.rows[0]?.last_row_id ?? 0);
  stats.last_row_id = watermark;

  for (;;) {
    if (now() - startedMs > budgetMs) break;

    const scan = buildPatientDirectoryScanQuery(watermark, batch);
    const { rows } = await deps.read.query<DirectoryScanRow>(scan.sql, scan.params);
    if (rows.length === 0) {
      // ⚠ STAMP refreshed_at ANYWAY. "Nothing to do" is a SUCCESSFUL run and must be recorded as
      // one: the freshness alarm reads this column to decide whether the sync is still alive, and
      // breaking out without touching it froze the timestamp for as long as the ingest was quiet.
      // Overnight the CMD feed legitimately adds nothing for hours, so the alarm would have fired
      // "the index last updated 3h ago" against a directory that was completely current — the
      // always-on alarm this replaced, wearing the opposite disguise.
      await touchDirectoryState(deps.write, watermark);
      stats.exhausted = true;
      break;
    }

    const { entries, skippedNoMember, decryptFailures } = await entriesFromRows(
      rows,
      deps.decrypt,
      fingerprint,
    );
    stats.rows_scanned += rows.length;
    stats.keys_seen += entries.length;
    stats.skipped_no_member += skippedNoMember;
    stats.decrypt_failures += decryptFailures;

    if (entries.length > 0) {
      const ins = buildPatientDirectoryInsert(entries);
      const res = await deps.write.query(ins.sql, ins.params);
      stats.names_inserted += res.rowCount ?? 0;
    }

    // The scan is ordered by id, so the last row carries the batch maximum.
    watermark = Number(rows[rows.length - 1]!.id);
    stats.last_row_id = watermark;
    await touchDirectoryState(deps.write, watermark, rows.length, entries.length);

    if (rows.length < batch) {
      stats.exhausted = true;
      break;
    }
  }

  stats.duration_ms = now() - startedMs;
  return stats;
}
