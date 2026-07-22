/**
 * CMD Charge CENSUS — Feed 2 ingest mapper + upsert writer (Qualify v2 feed series, artifact ②b).
 *
 * WHY (two-feed architecture, Option (b)): a payment-received-anchored feed structurally cannot
 * contain a never-paid charge, so collections.cmd_explorer_rows (the append-only payment-EVENT log)
 * cannot supply the unpaid denominator Qualify v2's openCount needs. collections.cmd_charge_census
 * (migration 0058) is the SOURCE-OF-TRUTH FOR CHARGE EXISTENCE: Feed 2 = the trailing-90d charge
 * census, ALL payment states, UPSERTed one row per (business_entity_id, charge_id). This module maps
 * a parsed CMD report row to a census row and upserts a batch; the cron loop + run-log lifecycle live
 * in cmdCensusCron.ts.
 *
 * CENSUS OWN MAPPER (ratified) — deliberately NOT cmdExplorerSeed.mapRow. That mapper DROPS a row on
 * a blank member_id / charge_amount / facility / patient_name / charge_date (the cmd_explorer_rows
 * columns are NOT NULL). The census is the openCount DENOMINATOR, so dropping self-pay / no-member /
 * dimension-sparse charges would UNDERCOUNT it. Census required-field policy:
 *   - REQUIRED: charge_id + patient_name  → a blank in either is the ONLY skip (skip+count, label-only).
 *   - EVERYTHING ELSE optional/nullable   → blank OR unparseable → NULL, the row is KEPT. A blank
 *     member_id is a legitimate self-pay census row. We faithfully capture existence; we never gate
 *     the denominator on a soft dimension. (No value-filtering — phantom-allowed / tiered-allowed is a
 *     rollup-rebuild concern, and the census carries no allowed/payment columns anyway.)
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the three identifiers (patient_name / member_id / group_number)
 * are libsodium-encrypted IN-PROCESS via phiCrypto.encryptPhi BEFORE insert (member_id/group_number
 * NULL → NULL ciphertext, not encrypted); the three keyed-HMAC blind indexes come from
 * blindIndexesForRowSafe (safe variant: a missing INDEX_HMAC_KEY yields NULL tokens, never breaks
 * ingest). No plaintext PHI ever reaches the DB; skip labels carry FIELD NAMES only, never a cell value.
 *
 * SECURITY / TENANCY: writes as the least-privilege cmd_rollup_writer, and EVERY write goes through
 * withTenant(pool, entityId, …) — cmd_charge_census's writer RLS policies (0058) are GUC-scoped, so a
 * write outside a tenant transaction RAISES (fail-closed). Mirrors insertRows (cmdExplorerSeed.ts).
 */
import { mapReportRows, type CmdExplorerFullRow } from './cmdExplorer.js';
import { normalizeDate, normalizeMoney } from './normalize.js';
import { normalizeStatus } from './claimStatus.js';
import { encryptPhi } from './phiCrypto.js';
import { blindIndexesForRowSafe } from './blindIndex.js';
import type { CmdReportRow } from './cmdPayer.js';
import type { Db } from './db.js';
import { withTenant } from '../veris/withTenant.js';

/** Column order for the INSERT — matches buildCensusParams() exactly. business_entity_id is stamped
 *  EXPLICITLY per tenant (no DEFAULT-BXR safety net on this table — 0058); the GUC-scoped writer policy
 *  rejects a mis-stamped row fail-closed. first_seen_at / last_seen_at default now() on insert; the
 *  ON CONFLICT clause bumps last_seen_at + refreshes every dimension (see UPSERT_SQL). */
const INSERT_COLS = [
  'business_entity_id', 'charge_id',
  'patient_name', 'member_id', 'group_number',
  'member_id_bidx', 'member_id_prefix_bidx', 'group_number_bidx',
  'charge_date', 'charge_entered_date', 'charge_to_date',
  'facility', 'cpt_code', 'revenue_code', 'charge_amount', 'primary_payer',
  'claim_status_raw', 'claim_status_category', 'last_run_id',
] as const;

const BATCH = 500;

/** Dimensions the ON CONFLICT DO UPDATE refreshes from EXCLUDED (the census tracks LATEST existence
 *  state). business_entity_id + charge_id are the conflict key (never updated); first_seen_at is kept. */
const REFRESH_COLS = INSERT_COLS.filter((c) => c !== 'business_entity_id' && c !== 'charge_id');

/** The upsert: one row per (business_entity_id, charge_id) — 0058's UNIQUE grain. A re-seen charge (a
 *  re-pull, or a duplicate posting snapshot in the SAME export after collapse) UPDATEs: last_seen_at =
 *  now() + every refreshed dimension. `(xmax = 0)` is TRUE for a freshly-inserted row and FALSE for a
 *  DO-UPDATE, so the caller counts rows_new vs rows_refreshed without a second query. */
const UPSERT_TAIL =
  `on conflict (business_entity_id, charge_id) do update set ` +
  `last_seen_at = now(), ` +
  REFRESH_COLS.map((c) => `${c} = excluded.${c}`).join(', ') +
  ` returning (xmax = 0) as inserted`;

/** A fully-parsed census row (PHI fields hold PLAINTEXT; encrypted only at the insert boundary). */
export interface CensusPlainRow {
  charge_id: string; //                required
  patient_name: string; //             PHI plaintext (required)
  member_id: string | null; //         PHI plaintext (NULL = self-pay/no-member — KEPT, not skipped)
  group_number: string | null; //      PHI plaintext
  charge_date: string | null; //       ISO 'YYYY-MM-DD'
  charge_entered_date: string | null;
  charge_to_date: string | null;
  facility: string | null;
  cpt_code: string | null;
  revenue_code: string | null;
  charge_amount: string | null; //     numeric decimal string
  primary_payer: string | null;
  claim_status_raw: string | null;
  claim_status_category: string | null; // derived: normalizeStatus(raw).category, NULL when raw blank
}

export type CensusMapResult = { ok: true; row: CensusPlainRow } | { ok: false; label: string };

/** Trim; blank → null. Defensive (mirrors mapRow's `=== null || trim === ''` guards): mapReportRows'
 *  pick() already nulls blanks, but the census mapper never assumes it — a stray '' must read as absent. */
function blankToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/** Accept M/D/YYYY (claims date parser) OR ISO 'YYYY-MM-DD'. Census LENIENT policy: blank OR
 *  unparseable → null (the field is optional; a soft dimension must never drop a census row). */
function toIsoDateOrNull(raw: string | null): string | null {
  const t = (raw ?? '').trim();
  if (t === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const probe = new Date(`${t}T00:00:00Z`);
    return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === t ? t : null;
  }
  const d = normalizeDate(t); // M/D/YYYY with calendar validation
  return d.ok ? d.value : null;
}

/**
 * Map one parsed report row to a CensusPlainRow, or a skip label. ONLY charge_id + patient_name gate
 * the row; every other field is captured leniently (blank/unparseable → null, row KEPT). Labels name
 * the FIELD only — never a cell value (PHI-safe).
 */
export function mapCensusRow(full: CmdExplorerFullRow): CensusMapResult {
  // REQUIRED — the ONLY two gates. Blank OR null both skip (defensive; label names the field only).
  const chargeId = blankToNull(full.charge_id);
  if (chargeId === null) return { ok: false, label: 'charge_id: missing' };
  const patientName = full.phi.patient_name;
  if (patientName === null || patientName.trim() === '') return { ok: false, label: 'patient_name: missing' };

  // charge_amount is optional: blank OR unparseable → null (never drop the denominator row).
  const money = normalizeMoney(full.charge_amount ?? '', 'phi');
  const chargeAmount = money.ok ? money.value : null;

  const claimStatusRaw = blankToNull(full.claim_status_raw);
  const claimStatusCategory = claimStatusRaw === null ? null : normalizeStatus(claimStatusRaw).category;

  return {
    ok: true,
    row: {
      charge_id: chargeId,
      patient_name: patientName, //                    verbatim PHI plaintext (only presence is gated)
      // member_id / group_number NULLABLE by design (Gate 2): a blank member_id is a self-pay census
      // row, KEPT (blankToNull → null), never a skip.
      member_id: blankToNull(full.phi.member_id_raw),
      group_number: blankToNull(full.phi.group_number),
      charge_date: toIsoDateOrNull(full.charge_from_date),
      charge_entered_date: toIsoDateOrNull(full.charge_entered_date),
      charge_to_date: toIsoDateOrNull(full.charge_to_date),
      facility: blankToNull(full.facility),
      cpt_code: blankToNull(full.cpt_code),
      revenue_code: blankToNull(full.revenue_code),
      charge_amount: chargeAmount,
      primary_payer: blankToNull(full.primary_payer),
      claim_status_raw: claimStatusRaw,
      claim_status_category: claimStatusCategory,
    },
  };
}

/** Non-PHI outcome of mapping one customer's pull (counts + labels only). */
export interface CensusMapOutcome {
  rows: CensusPlainRow[];
  skipsByLabel: Map<string, number>;
}

/** Map + collapse a customer's parsed report rows to one census row per charge_id (LATEST occurrence
 *  wins — the export is roughly chronological, and a re-pull's upsert converges regardless). Collapsing
 *  BEFORE the insert is required: ON CONFLICT DO UPDATE cannot touch the same key twice in one statement. */
export function mapCensusRows(reportRows: CmdReportRow[]): CensusMapOutcome {
  const byChargeId = new Map<string, CensusPlainRow>();
  const skipsByLabel = new Map<string, number>();
  for (const full of mapReportRows(reportRows)) {
    const result = mapCensusRow(full);
    if (!result.ok) {
      skipsByLabel.set(result.label, (skipsByLabel.get(result.label) ?? 0) + 1);
      continue;
    }
    byChargeId.set(result.row.charge_id, result.row); // last occurrence wins
  }
  return { rows: [...byChargeId.values()], skipsByLabel };
}

/** Collapse a batch to one row per charge_id (last wins) — defensive so a caller can never trip the
 *  "ON CONFLICT cannot affect row a second time" error, and so the "duplicate collapses" unit test can
 *  call insertCensusRows directly with dups. */
function collapseByChargeId(rows: CensusPlainRow[]): CensusPlainRow[] {
  const m = new Map<string, CensusPlainRow>();
  for (const r of rows) m.set(r.charge_id, r);
  return [...m.values()];
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Encrypt the PHI trio and assemble one row's positional params (INSERT_COLS order). member_id /
 *  group_number NULL → NULL ciphertext (not encrypted). Blind indexes from PLAINTEXT (safe variant). */
async function buildCensusParams(row: CensusPlainRow, businessEntityId: string, runId: number | null): Promise<unknown[]> {
  const [patient, member, group] = await Promise.all([
    encryptPhi(row.patient_name),
    row.member_id === null ? Promise.resolve(null) : encryptPhi(row.member_id),
    row.group_number === null ? Promise.resolve(null) : encryptPhi(row.group_number),
  ]);
  const bidx = blindIndexesForRowSafe(row.member_id, row.group_number);
  return [
    businessEntityId, row.charge_id,
    patient, member, group,
    bidx.member_id_bidx, bidx.member_id_prefix_bidx, bidx.group_number_bidx,
    row.charge_date, row.charge_entered_date, row.charge_to_date,
    row.facility, row.cpt_code, row.revenue_code, row.charge_amount, row.primary_payer,
    row.claim_status_raw, row.claim_status_category, runId,
  ];
}

/** Counts of an upsert batch — rows_new (freshly inserted) vs rows_refreshed (DO UPDATE fired). */
export interface CensusUpsertStats {
  inserted: number;
  refreshed: number;
}

/**
 * Batched, parameterized census UPSERT. Collapses input to one row per charge_id, then per BATCH:
 * encrypts PHI OUTSIDE the transaction (never hold a pooled connection across libsodium work), opens
 * its OWN short tenant-scoped transaction (withTenant: BEGIN → set_config → INSERT … ON CONFLICT DO
 * UPDATE → COMMIT), and tallies new vs refreshed from the `(xmax = 0)` RETURNING. Each batch commits
 * on its own, so a mid-load failure just re-pulls next invocation (idempotent). Rows are stamped with
 * `businessEntityId` explicitly and scoped into the transaction GUC — never inferred from the data.
 */
export async function insertCensusRows(
  db: Db,
  rows: CensusPlainRow[],
  businessEntityId: string,
  runId: number | null,
): Promise<CensusUpsertStats> {
  const stats: CensusUpsertStats = { inserted: 0, refreshed: 0 };
  for (const batch of chunk(collapseByChargeId(rows), BATCH)) {
    const paramRows = await Promise.all(batch.map((r) => buildCensusParams(r, businessEntityId, runId)));
    await withTenant(db, businessEntityId, async (client) => {
      const params: unknown[] = [];
      const tuples = paramRows.map((vals) => {
        const base = params.length;
        params.push(...vals);
        return `(${vals.map((_, i) => `$${base + i + 1}`).join(', ')})`;
      });
      const sql =
        `insert into collections.cmd_charge_census (${INSERT_COLS.join(', ')}) ` +
        `values ${tuples.join(', ')} ${UPSERT_TAIL}`;
      const res = await client.query<{ inserted: boolean }>(sql, params);
      for (const r of res.rows) {
        if (r.inserted) stats.inserted += 1;
        else stats.refreshed += 1;
      }
    });
  }
  return stats;
}
