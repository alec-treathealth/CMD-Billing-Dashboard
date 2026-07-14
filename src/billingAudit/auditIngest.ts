/**
 * Billing Audit — per-scope roster-loop ingest (CMD IP/OP audit reports →
 * claims.audit_row). Transport-agnostic (composition-root pattern): no env reads, no
 * secrets, no next/cache — the composition root injects the roster, the per-customer
 * zip fetch, the least-privilege writer pool (claims_audit_writer), and the tenant.
 *
 * TOPOLOGY (Alec's ruling, 2026-07-13): the audit reports are per-customer-scoped, so
 * ONE report+filter pair per scope is run once PER ROSTER CUSTOMER, sequentially (CMD
 * runs one report at a time per partner), with a wall-clock budget guard — the
 * collections-cron pattern. Per-customer failures are isolated (counted + logged,
 * label-only) and the run continues; unfinished customers catch up next run.
 *
 * OPTION B UPSERT (Alec's ruling, 2026-07-13): ON CONFLICT (business_entity_id,
 * row_fingerprint) DO UPDATE — the fingerprint hashes stable-identity fields only
 * (auditRowMap.ts, LOCKED), so a re-pull UPDATES the volatile workflow fields
 * (status, notes, payer, auth, diagnoses, labels) in place. One row per charge line
 * forever; resolved flags stay resolved. RETURNING xmax=0 splits inserted vs updated.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the 3 identifiers (patient name / DOB / member
 * id) are libsodium-encrypted IN-PROCESS before insert; blind indexes are computed
 * from plaintext before it is discarded. Encryption happens OUTSIDE the tenant
 * transaction (never hold a pooled connection across libsodium work). Stats and every
 * log line are COUNTS + column labels only — never a cell value.
 *
 * FAIL-FAST KEY PROBES: encryptPhi + the blind-index key are validated up front with
 * non-PHI probe values, so a misconfigured LIBSODIUM_KEY / INDEX_HMAC_KEY fails the
 * run loudly instead of skipping every row (patient_name_bidx is NOT NULL — a null
 * token would otherwise silently skip the world; the header_mismatch/skip counters
 * would show it, but a thrown probe is clearer).
 */
import { encryptPhi } from '../collections/phiCrypto.js';
import { auditBlindIndexesForRowSafe, patientNameBlindIndex } from '../collections/blindIndex.js';
import { withTenant } from '../veris/withTenant.js';
import type { Db } from '../collections/db.js';
import type { CmdCustomerTarget } from '../collections/cmdExplorerCron.js';
import type { AuditScope } from './auditConfig.js';
import { headerMismatch, mapAuditRow, parsePositionalCsv, type PlainAuditRow } from './auditRowMap.js';

const DEFAULT_BUDGET_MS = 270_000; // headroom under a 300s Vercel function
const BATCH = 250; //                39 columns/row — smaller batches than collections' 500

/** INSERT column list — order matches buildParams() exactly. business_entity_id is
 *  stamped EXPLICITLY per customer target (never inferred); the GUC (withTenant) is the
 *  RLS enforcement layer on top. */
const INSERT_COLS = [
  'business_entity_id', 'audit_scope', 'cmd_claim_id', 'cmd_patient_id', 'claim_type',
  'claim_frequency', 'office_name', 'office_id', 'provider_name', 'billing_provider_id',
  'patient_name_enc', 'patient_name_bidx', 'patient_name_pfx3_bidx', 'patient_dob_enc',
  'member_id_enc', 'member_id_bidx', 'member_id_pfx3_bidx',
  'charge_from_date', 'charge_to_date', 'stmt_from_date', 'stmt_to_date', 'admission_date',
  'cpt_code', 'rev_code', 'modifier_1', 'modifier_2', 'units', 'type_of_bill',
  'charge_amount_cents', 'payer_name', 'auth_number', 'charge_status_raw',
  'status_category', 'status_payer', 'principal_diag', 'diagnoses', 'last_fu_note',
  'row_fingerprint', 'source_report_id',
] as const;

/** VOLATILE columns re-asserted on conflict (Option B) — everything workflow-mutable,
 *  plus the PHI ciphertext/bidx (nonce-fresh ciphertext; deterministic tokens). The
 *  stable-identity fields are inside the fingerprint and never need updating. */
const UPDATE_COLS = [
  'claim_type', 'claim_frequency', 'office_name', 'office_id', 'provider_name',
  'billing_provider_id', 'patient_name_enc', 'patient_name_bidx', 'patient_name_pfx3_bidx',
  'patient_dob_enc', 'member_id_enc', 'member_id_bidx', 'member_id_pfx3_bidx',
  'payer_name', 'auth_number', 'charge_status_raw', 'status_category', 'status_payer',
  'principal_diag', 'diagnoses', 'last_fu_note', 'source_report_id',
] as const;

export interface BillingAuditCronDeps {
  scope: AuditScope;
  /** The scope's roster (auditConfig.auditCustomersFor). Scope IS the roster. */
  customers: ReadonlyArray<CmdCustomerTarget>;
  /** Run the scope's report for ONE customer → raw report zip (null = empty report). */
  fetchZip: (customerId: string) => Promise<Buffer | null>;
  /** Unzip → the report CSV text entries. In prod: cmdPayer.readZipEntries + toString. */
  zipToCsvTexts: (zip: Buffer) => string[];
  /** Least-privilege claims_audit_writer pool, injected by the composition root. */
  writeDb: Db;
  /** Run-level default tenant; a customer's own businessEntityId overrides (roster is
   *  BXR-only today — the override plumbing mirrors the collections cron). */
  businessEntityId: string;
  /** Recorded on every row (claims.audit_row.source_report_id). */
  sourceReportId: string;
  now?: () => number;
  budgetMs?: number;
  revalidate?: () => void | Promise<void>;
}

/** Non-PHI run summary — safe to log and return to the (CRON_SECRET-authed) caller. */
export interface BillingAuditCronStats {
  scope: AuditScope;
  customers_total: number;
  customers_processed: number;
  customers_failed: number;
  customers_skipped_budget: number;
  /** Customers whose report header did not match the scope's locked list (rejected whole). */
  customers_header_mismatch: number;
  rows_fetched: number;
  mapped_valid: number;
  /** Rows skipped for a missing/invalid required field (labels aggregated, counts only). */
  skipped: number;
  skipped_by_label: Record<string, number>;
  inserted: number;
  updated: number;
  /** Customers where EVERY fetched row skipped — the alias-failure signal convention. */
  all_rows_skipped_customers: number;
  /** Per-customer outcome — the self-reporting operability record (non-PHI: ids, facility
   *  labels, counts, and CMD/DB error MESSAGES only, never a cell value). Vercel runtime
   *  logs are not reliably retrievable from every ops context, so a failed/empty/mismatch
   *  customer must be nameable straight from the (authed) response. */
  per_customer: PerCustomerOutcome[];
}

export interface PerCustomerOutcome {
  customer_id: string;
  facility: string;
  outcome: 'processed' | 'empty' | 'failed' | 'header_mismatch' | 'skipped_budget';
  rows_inserted?: number;
  rows_updated?: number;
  /** Non-PHI reason for failed / header_mismatch (CMD or DB message; column-label diff). */
  reason?: string;
}

/** Encrypt the 3 PHI fields + compute blind indexes → one row's positional params. */
async function buildParams(row: PlainAuditRow, businessEntityId: string, sourceReportId: string): Promise<unknown[] | null> {
  const [nameEnc, dobEnc, memberEnc] = await Promise.all([
    encryptPhi(row.patient_name),
    row.patient_dob === null ? Promise.resolve(null) : encryptPhi(row.patient_dob),
    row.member_id === null ? Promise.resolve(null) : encryptPhi(row.member_id),
  ]);
  const bidx = auditBlindIndexesForRowSafe(row.patient_name, row.member_id);
  // patient_name_bidx is NOT NULL in the schema; the up-front key probe makes this
  // unreachable in practice — belt to the probe's suspenders.
  if (bidx.patient_name_bidx === null) return null;
  return [
    businessEntityId, row.audit_scope, row.cmd_claim_id, row.cmd_patient_id, row.claim_type,
    row.claim_frequency, row.office_name, null /* office_id: no source column in either report */,
    row.provider_name, row.billing_provider_id,
    nameEnc, bidx.patient_name_bidx, bidx.patient_name_pfx3_bidx, dobEnc,
    memberEnc, bidx.member_id_bidx, bidx.member_id_pfx3_bidx,
    row.charge_from_date, row.charge_to_date, row.stmt_from_date, row.stmt_to_date, row.admission_date,
    row.cpt_code, row.rev_code, row.modifier_1, row.modifier_2, row.units, row.type_of_bill,
    row.charge_amount_cents, row.payer_name, row.auth_number, row.charge_status_raw,
    row.status_category, row.status_payer, row.principal_diag, JSON.stringify(row.diagnoses), row.last_fu_note,
    row.row_fingerprint, sourceReportId,
  ];
}

/** Batched Option-B upsert inside short tenant-scoped transactions (withTenant GUC —
 *  what the 0049 writer policies enforce). Exported for the tests' fake-db assertions. */
export async function upsertAuditRows(
  db: Db,
  rows: PlainAuditRow[],
  businessEntityId: string,
  sourceReportId: string,
): Promise<{ inserted: number; updated: number; key_skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let keySkipped = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // Encrypt OUTSIDE the transaction — never hold a pooled connection across libsodium work.
    const paramRows = (await Promise.all(batch.map((r) => buildParams(r, businessEntityId, sourceReportId))))
      .filter((p): p is unknown[] => {
        if (p === null) keySkipped += 1;
        return p !== null;
      });
    if (paramRows.length === 0) continue;
    const counts = await withTenant(db, businessEntityId, async (client) => {
      const params: unknown[] = [];
      const tuples = paramRows.map((vals) => {
        const base = params.length;
        params.push(...vals);
        return `(${vals.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const updates = UPDATE_COLS.map((c) => `${c} = excluded.${c}`).join(', ');
      const sql =
        `insert into claims.audit_row (${INSERT_COLS.join(', ')}) ` +
        `values ${tuples.join(', ')} ` +
        `on conflict (business_entity_id, row_fingerprint) do update set ${updates}, ingested_at = now() ` +
        `returning (xmax = 0) as inserted`;
      const res = await client.query<{ inserted: boolean }>(sql, params);
      const ins = res.rows.filter((r) => r.inserted).length;
      return { ins, upd: res.rows.length - ins };
    });
    inserted += counts.ins;
    updated += counts.upd;
  }
  return { inserted, updated, key_skipped: keySkipped };
}

/**
 * Loop the scope's roster, pull + parse + map + upsert per customer. Mirrors
 * cmdExplorerCron's budget/isolation semantics. Returns non-PHI stats only.
 */
export async function billingAuditCron(deps: BillingAuditCronDeps): Promise<BillingAuditCronStats> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = now();

  // Fail-fast key probes (non-PHI values) — see module header.
  await encryptPhi('audit-key-probe');
  if (patientNameBlindIndex('audit-key-probe') === null) {
    throw new Error('INDEX_HMAC_KEY missing/invalid — audit ingest requires blind indexes (patient_name_bidx is NOT NULL)');
  }

  const stats: BillingAuditCronStats = {
    scope: deps.scope,
    customers_total: deps.customers.length,
    customers_processed: 0,
    customers_failed: 0,
    customers_skipped_budget: 0,
    customers_header_mismatch: 0,
    rows_fetched: 0,
    mapped_valid: 0,
    skipped: 0,
    skipped_by_label: {},
    inserted: 0,
    updated: 0,
    all_rows_skipped_customers: 0,
    per_customer: [],
  };

  for (const target of deps.customers) {
    const entityId = target.businessEntityId ?? deps.businessEntityId;
    if (now() - started > budgetMs) {
      stats.customers_skipped_budget += 1;
      stats.per_customer.push({ customer_id: target.customerId, facility: target.facilityCode, outcome: 'skipped_budget' });
      continue;
    }
    try {
      const zip = await deps.fetchZip(target.customerId);
      if (zip === null) {
        // Genuinely-empty report (post empty-grace) — processed, nothing to write.
        stats.customers_processed += 1;
        stats.per_customer.push({ customer_id: target.customerId, facility: target.facilityCode, outcome: 'empty' });
        continue;
      }
      let customerFetched = 0;
      let customerValid = 0;
      const rows: PlainAuditRow[] = [];
      let mismatch: string | null = null;
      for (const text of deps.zipToCsvTexts(zip)) {
        const parsed = parsePositionalCsv(text);
        mismatch = headerMismatch(deps.scope, parsed.header);
        if (mismatch !== null) break; // reject the customer whole — never guess columns into PHI rows
        customerFetched += parsed.rows.length;
        for (const raw of parsed.rows) {
          const result = mapAuditRow(deps.scope, raw);
          if (result.ok) {
            customerValid += 1;
            rows.push(result.row);
          } else {
            stats.skipped += 1;
            stats.skipped_by_label[result.label] = (stats.skipped_by_label[result.label] ?? 0) + 1;
          }
        }
      }
      if (mismatch !== null) {
        stats.customers_header_mismatch += 1;
        stats.per_customer.push({
          customer_id: target.customerId, facility: target.facilityCode,
          outcome: 'header_mismatch', reason: mismatch,
        });
        console.error(
          `billing-audit ${deps.scope} cron: customer ${target.customerId} (${target.facilityCode}) header mismatch — ${mismatch}`,
        );
        continue;
      }
      stats.rows_fetched += customerFetched;
      stats.mapped_valid += customerValid;
      if (customerFetched > 0 && customerValid === 0) stats.all_rows_skipped_customers += 1;

      // De-dup by fingerprint within the pull (LAST occurrence wins — under Option B the
      // later row is the fresher status snapshot for the same charge line).
      const byFingerprint = new Map<string, PlainAuditRow>();
      for (const row of rows) byFingerprint.set(row.row_fingerprint, row);
      const counts = await upsertAuditRows(deps.writeDb, [...byFingerprint.values()], entityId, deps.sourceReportId);
      stats.inserted += counts.inserted;
      stats.updated += counts.updated;
      stats.customers_processed += 1;
      stats.per_customer.push({
        customer_id: target.customerId, facility: target.facilityCode,
        outcome: 'processed', rows_inserted: counts.inserted, rows_updated: counts.updated,
      });
    } catch (err) {
      stats.customers_failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      stats.per_customer.push({
        customer_id: target.customerId, facility: target.facilityCode, outcome: 'failed', reason,
      });
      console.error(
        `billing-audit ${deps.scope} cron: customer ${target.customerId} (${target.facilityCode}) failed: ${reason}`,
      );
    }
  }

  if (stats.customers_processed > 0 && deps.revalidate) await deps.revalidate();

  console.log(
    `billing-audit ${deps.scope} cron: customers ${stats.customers_processed}/${stats.customers_total} ` +
      `(failed ${stats.customers_failed}, header-mismatch ${stats.customers_header_mismatch}, ` +
      `budget-skipped ${stats.customers_skipped_budget}); fetched ${stats.rows_fetched}, ` +
      `valid ${stats.mapped_valid}, skipped ${stats.skipped}, inserted ${stats.inserted}, updated ${stats.updated}`,
  );
  return stats;
}
