/**
 * "Upcoming Payments" override sync + read — the I/O half.
 *
 * THE CONNECTOR THIS FILE EXISTS TO PROVIDE. The transport is an INJECTED PORT
 * (`fetchTab`), exactly like src/billingAudit/decisionSync.ts: the composition root
 * (app/lib/server.ts) supplies a Google Sheets reader built from the env-only OAuth
 * refresh-token credentials, and this module never imports `googleapis`. That is what makes
 * the whole sync unit-testable with a fake port and keeps the Google dependency out of the
 * root library's import graph.
 *
 * WRITE PATH — REPLACE-PER-SYNC inside ONE withTenant transaction:
 *   BEGIN → transaction-local set_config('app.business_entity_id', $1, true)
 *     → SELECT the tenant's current sheet_sync_hash set   (no-op detection)
 *     → DELETE this tenant's rows                          (scoped by RLS + explicit predicate)
 *     → INSERT the current parse
 *   → COMMIT
 * Idempotency is STRUCTURAL, not a natural key — the sheet is hand-edited and has no stable
 * row identity (see migration 023 §3). Re-running against an unchanged sheet writes nothing
 * at all (hash no-op); re-running against a changed sheet leaves the table exactly mirroring
 * the sheet.
 *
 * ⚠️ NEVER call pool.query() inside the withTenant callback — each pool.query() can land on
 * a different pooled connection, escaping the transaction and its GUC (Supavisor 6543
 * discipline). Every statement below runs on the client the callback receives.
 *
 * ⚠️ NO NETWORK CALL INSIDE withTenant. The sheet is fetched and parsed BEFORE the
 * transaction opens, so a slow Sheets response can never hold a DB transaction open.
 *
 * FAIL-SOFT on fetch/parse (decisionSync's posture): a throw from the port or a header-drift
 * throw from the parser yields status 'parse_failed' with ZERO writes, so the last good data
 * stays on the tile rather than the sync blanking it. A header change in the sheet must
 * degrade to "stale forecast", never to "forecast vanished".
 *
 * PHI: nothing in this file ever sees a patient name — the parser dropped it (see
 * upcomingOverrideSheet.ts). The stats object and every log line here carry counts, row
 * numbers, reason codes, and facility labels only.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTenant } from './withTenant.js';
import {
  OVERRIDE_TAB,
  fixed2FromCents,
  type OverrideGrid,
  type OverrideReject,
  type ParsedOverrideRow,
  parseOverrideSheet,
} from './upcomingOverrideSheet.js';

export { OVERRIDE_TAB };

/** Pool OR a checked-out client — both expose .query. Mirrors collections/db.ts's Queryable. */
export type OverrideDb = pg.Pool;

export interface OverrideSyncDeps {
  /** Fetch the override tab's full grid (structured cells, 1-based rowNum). Injected. */
  fetchTab: (tab: string) => Promise<OverrideGrid>;
  /** cmd_rollup_writer pool — SELECT/INSERT/DELETE on expected_payment_override only. */
  writeDb: OverrideDb;
  /** The tenant these forecast rows belong to. */
  businessEntityId: string;
  /** Override the tab name (tests, or a second tenant's tab). Defaults to OVERRIDE_TAB. */
  tab?: string;
}

/** Non-PHI sync summary. Safe to log and to return in a cron response body. */
export interface OverrideSyncStats {
  status: 'ok' | 'noop' | 'parse_failed';
  /** sha-256 of the fetched grid; null when the fetch/parse failed. */
  sheet_hash: string | null;
  /** Rows the parser trusted. */
  rows_parsed: number;
  /** Rows deleted by the replace (the previous parse's rows). */
  deleted: number;
  /** Rows inserted by the replace. Equals rows_parsed on a successful non-noop run. */
  inserted: number;
  /** Rejected rows — row number + reason code, never cell content. */
  rejects: OverrideReject[];
  /** Distinct sheet facility labels with no alias entry. NEEDS A RULING — see 023. */
  unmapped_facilities: string[];
  /** Sum of accepted amounts in exact integer cents. Cross-check against the sheet's Total. */
  total_cents: number;
}

const INSERT_COLS = [
  'business_entity_id',
  'facility_code',
  'payer_label',
  'expected_date',
  'method_label',
  'amount',
  'is_patient_specific',
  'source_row_num',
  'sheet_sync_hash',
] as const;

/**
 * Sync the override tab into staging.expected_payment_override for ONE tenant.
 *
 * Returns stats rather than throwing on a sheet problem — the caller maps `status` to a
 * non-ok field in the cron response. A DB failure DOES throw (it is not fail-soft: a broken
 * write path must be loud, and withTenant has already rolled back).
 */
export async function upcomingOverrideSync(deps: OverrideSyncDeps): Promise<OverrideSyncStats> {
  const stats: OverrideSyncStats = {
    status: 'ok',
    sheet_hash: null,
    rows_parsed: 0,
    deleted: 0,
    inserted: 0,
    rejects: [],
    unmapped_facilities: [],
    total_cents: 0,
  };

  // ---- FAIL-SOFT boundary: fetch + parse. Any throw here → keep last good data. --------
  // Deliberately OUTSIDE withTenant: no network call may happen inside a transaction.
  let parsed: ParsedOverrideRow[];
  try {
    const grid = await deps.fetchTab(deps.tab ?? OVERRIDE_TAB);
    stats.sheet_hash = createHash('sha256').update(JSON.stringify(grid.rows), 'utf8').digest('hex');
    const result = parseOverrideSheet(grid);
    parsed = result.rows;
    stats.rows_parsed = result.rows.length;
    stats.rejects = result.rejects;
    stats.unmapped_facilities = result.unmappedFacilities;
    stats.total_cents = result.rows.reduce((sum, r) => sum + r.amountCents, 0);
  } catch (err) {
    // Message only — the parser's throws quote HEADER text, never a data cell.
    console.error(
      'upcomingOverrideSync: fetch/parse failed, keeping last good data:',
      err instanceof Error ? err.message : String(err),
    );
    stats.status = 'parse_failed';
    return stats;
  }

  const hash = stats.sheet_hash;
  if (hash === null) {
    stats.status = 'parse_failed';
    return stats;
  }

  return withTenant(deps.writeDb, deps.businessEntityId, async (client) => {
    // ---- NO-OP DETECTION -----------------------------------------------------------
    // Unchanged sheet AND a non-empty landed set ⇒ nothing to do. The row-count equality
    // matters: a hash match with a DIFFERENT row count means a prior run half-landed (or
    // the table was manually truncated), and that must fall through to a full replace
    // rather than being declared a no-op on the strength of the hash alone.
    // `matching` counts rows already carrying THIS hash. Comparing it to both the total
    // landed count and the parsed count is what makes the no-op safe: a partial prior run
    // (some rows at an older hash) fails `landed === matching` and falls through to a full
    // replace. An earlier draft used min(sheet_sync_hash) = $2, which is UNSOUND — a mixed
    // set whose lowest hash happens to be the current one would have declared a false
    // no-op and frozen the forecast at a half-landed state.
    const existing = await client.query<{ landed: number; matching: number }>(
      `select count(*)::int                                        as landed,
              (count(*) filter (where sheet_sync_hash = $2))::int  as matching
         from staging.expected_payment_override
        where business_entity_id = $1::uuid`,
      [deps.businessEntityId, hash],
    );
    const landed = existing.rows[0]?.landed ?? 0;
    const matching = existing.rows[0]?.matching ?? 0;
    if (landed > 0 && landed === matching && landed === parsed.length) {
      stats.status = 'noop';
      return stats;
    }

    // ---- REPLACE -------------------------------------------------------------------
    // Explicit business_entity_id predicate as well as the RLS DELETE policy: belt (the
    // predicate makes the intended scope visible in the SQL and keeps the index-leading
    // filter) and suspenders (RLS DB-enforces it). On a full-replace write path a GUC
    // mistake would otherwise be able to delete another tenant's whole forecast.
    const del = await client.query(
      `delete from staging.expected_payment_override where business_entity_id = $1::uuid`,
      [deps.businessEntityId],
    );
    stats.deleted = del.rowCount ?? 0;

    if (parsed.length > 0) {
      // One multi-row INSERT: the sheet is a hand-keyed forecast (single digits to low
      // hundreds of rows), so batching adds nothing. Columns are fixed literals; every
      // value is a $n bound param.
      const params: unknown[] = [];
      const tuples = parsed.map((r) => {
        const b = params.length;
        params.push(
          deps.businessEntityId,
          r.facilityCode,
          r.payerLabel,
          r.expectedDate,
          r.methodLabel,
          r.amount, // fixed-2 TEXT → numeric(12,2). Never a JS float.
          r.isPatientSpecific,
          r.sourceRowNum,
          hash,
        );
        return (
          `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}::date, $${b + 5}, ` +
          `$${b + 6}::numeric, $${b + 7}::boolean, $${b + 8}::int, $${b + 9})`
        );
      });
      const ins = await client.query(
        `insert into staging.expected_payment_override (${INSERT_COLS.join(', ')}) ` +
          `values ${tuples.join(', ')}`,
        params,
      );
      stats.inserted = ins.rowCount ?? 0;
    }
    return stats;
  });
}

// =============================================================================
// READ PATH — what the tile consumes
// =============================================================================

/** One forecast row as the tile sees it. Non-PHI. Mirrors EraUpcomingGroup's shape. */
export interface UpcomingOverrideRow {
  /** ISO date. Named to line up with EraUpcomingGroup.payment_date for easy interleaving. */
  expected_date: string;
  facility_code: string;
  payer_label: string;
  /** 'EFT' | 'Check' — the SHEET's vocabulary, not a BPR04 code. See 023. */
  method_label: string;
  /** Fixed-point numeric TEXT from node-postgres. Never a JS float. */
  amount: string;
  is_patient_specific: boolean;
}

/** The forecast payload for one scope. */
export interface UpcomingOverrideSummary {
  /** Sum of `rows` in fixed-2 text. '0.00' when empty. */
  total: string;
  /** Forecast rows from the cutoff date forward, ascending. */
  rows: UpcomingOverrideRow[];
  /** True when more rows exist than the display cap — `total` is NOT affected. */
  rows_truncated: boolean;
}

/**
 * Display cap. Generous relative to the ~9 rows the sheet carries today; the headline total
 * comes from an UNCAPPED aggregate so a cap can never understate the money.
 */
const ROW_CAP = 100;

// Explicit allowlisted columns, fixed literals; only values are bound params. No SELECT *.
// The cutoff mirrors era835Upcoming's: `>= $2::date` where $2 is the CIVIL date in the
// business zone, NOT Postgres current_date (Vercel and the DB both run TZ=UTC, so from
// 17:00 PT onward current_date is already tomorrow Pacific and today's forecast would
// silently vanish for the people reading it).
const OVERRIDE_TOTALS_SQL = `
  select count(*)::int                          as rows_total,
         coalesce(sum(amount), 0)::text         as total
    from staging.expected_payment_override
   where business_entity_id = $1::uuid
     and expected_date >= $2::date`;

const OVERRIDE_ROWS_SQL = `
  select expected_date::text as expected_date,
         facility_code,
         payer_label,
         method_label,
         amount::text        as amount,
         is_patient_specific
    from staging.expected_payment_override
   where business_entity_id = $1::uuid
     and expected_date >= $2::date
   order by expected_date asc, facility_code asc, payer_label asc
   limit ${ROW_CAP + 1}`;

/**
 * One tenant's upcoming forecast rows. Two queries, ONE withTenant transaction, one client.
 *
 * `cutoffIso` is REQUIRED, not defaulted: a multi-tenant caller must compute it once and
 * pass the same value to every tenant, or a Consolidated read straddling midnight PT would
 * scope its tenants to different days. Making it required means a caller cannot forget.
 * Pass era835Upcoming.businessTodayIso() — the SAME value the ERA half of the tile uses, so
 * the two halves can never disagree about what "upcoming" means.
 */
export async function upcomingOverrides(
  pool: OverrideDb,
  businessEntityId: string,
  cutoffIso: string,
): Promise<UpcomingOverrideSummary> {
  return withTenant(pool, businessEntityId, async (client) => {
    const totals = await client.query<{ rows_total: number; total: string }>(
      OVERRIDE_TOTALS_SQL,
      [businessEntityId, cutoffIso],
    );
    const res = await client.query<UpcomingOverrideRow>(OVERRIDE_ROWS_SQL, [
      businessEntityId,
      cutoffIso,
    ]);
    const rows = res.rows;
    const truncated = rows.length > ROW_CAP;
    return {
      total: fixed2FromNumericText(totals.rows[0]?.total ?? '0'),
      rows: truncated ? rows.slice(0, ROW_CAP) : rows,
      rows_truncated: truncated,
    };
  });
}

/**
 * Merge per-tenant forecasts into one (the Consolidated view). Money is added in EXACT
 * integer cents — never float. Rows are concatenated, NOT collapsed: two tenants' forecasts
 * are distinct money even when facility/payer/date coincide, and this feed carries no
 * remit-count column that a collapse could aggregate meaningfully. Deterministic order
 * regardless of input order. Re-caps at ROW_CAP.
 */
export function mergeUpcomingOverrides(
  parts: UpcomingOverrideSummary[],
): UpcomingOverrideSummary {
  if (parts.length === 1) return parts[0]!; // single-tenant view, untouched
  let cents = 0;
  let truncated = false;
  const rows: UpcomingOverrideRow[] = [];
  for (const p of parts) {
    cents += centsFromNumericText(p.total) ?? 0;
    truncated = truncated || p.rows_truncated;
    rows.push(...p.rows);
  }
  rows.sort(
    (a, b) =>
      a.expected_date.localeCompare(b.expected_date) ||
      a.facility_code.localeCompare(b.facility_code) ||
      a.payer_label.localeCompare(b.payer_label),
  );
  const overflow = rows.length > ROW_CAP;
  return {
    total: fixed2FromCents(cents),
    rows: overflow ? rows.slice(0, ROW_CAP) : rows,
    rows_truncated: truncated || overflow,
  };
}

/**
 * Exact integer cents from Postgres numeric TEXT. Deliberately NOT imported from
 * era835Upcoming: this module must not depend on the ERA read, so the two halves of the
 * tile stay independently deletable. Same contract, same arithmetic — `fixed2FromCents`
 * comes from the sheet module, which is already a hard dependency, so only the parse
 * direction is restated here.
 */
function centsFromNumericText(v: string | null): number | null {
  if (v === null) return null;
  const m = v.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(whole * 100)) return null;
  return sign * (whole * 100 + frac);
}

/** Normalize Postgres numeric text ('291000' | '291000.0') to fixed-2 ('291000.00'). */
function fixed2FromNumericText(v: string): string {
  return fixed2FromCents(centsFromNumericText(v) ?? 0);
}
