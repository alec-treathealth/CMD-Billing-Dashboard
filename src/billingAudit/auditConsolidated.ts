/**
 * Billing Audit — CONSOLIDATED ingest (report 10064394, filters B 10148376 + C 10148377
 * → claims.audit_row). Transport-agnostic like auditIngest.ts: the composition root
 * injects the roster, the per-(customer, filter) zip fetch, the least-privilege writer
 * pool (claims_audit_writer), and the tenant. Recon ground truth + Alec's rulings:
 * docs/veris-data-notes.md "Consolidated audit report recon — measured (2026-07-29)".
 *
 * IDENTITY (Alec's ruling 2026-07-29): upsert on (business_entity_id, charge_debit_id)
 * — the feed's true unique row key (0073's partial unique index is the arbiter) — with
 * the ruled TRANSITION: legacy rows (charge_debit_id NULL) are matched by fingerprint
 * (primary recipe OR the legacy-IP variant) and stamped through the OLD arbiter
 * (business_entity_id, row_fingerprint), which both backfills the key and updates the
 * row in one statement. row_fingerprint is WRITE-ONCE: never updated on an existing row
 * (the OP cron's arbiter depends on stored fingerprints during its soak; the stored
 * value is inert once a row carries its key).
 *
 * QUARANTINE (fail-loud, never default):
 *   - unrecognised TOB prefix (mapConsolidatedRow) — scope is never guessed;
 *   - fingerprint conflicts: an incoming row whose fingerprint already belongs to a
 *     DIFFERENT charge_debit_id (the retained fingerprint UNIQUE constraint would
 *     reject the insert — see 0073's header; measured occurrences: zero).
 * Quarantined rows are counted + labelled (non-PHI labels) and mark the run 'partial'.
 *
 * OP-SCOPE SOAK DEFERRAL (senior-engineer call under delegated authority, 2026-07-29):
 * while the legacy OP cron soaks (5 clean nights), consolidated OP-scope rows are
 * fetched + parsed + scope-derived + COUNTED but NOT written (writeOpScopeRows=false).
 * Writing them would create near-dupe rows (the recipes fingerprint OP rows differently
 * — units now populated) and let two feeds co-write the same charges, contaminating the
 * soak signal. Fetch-side reconciliation still proves B/C coverage; the write flips on
 * at OP decommission (CMD_AUDIT_CONSOLIDATED_OP_WRITE).
 *
 * PHI DISCIPLINE: identical to auditIngest.ts — 3 identifiers libsodium-encrypted
 * in-process, blind indexes from plaintext before discard, encryption OUTSIDE the
 * tenant transaction, stats/logs are counts + column labels only.
 */
import { encryptPhi } from '../collections/phiCrypto.js';
import { auditBlindIndexesForRowSafe, patientNameBlindIndex } from '../collections/blindIndex.js';
import { withTenant } from '../veris/withTenant.js';
import type { Db } from '../collections/db.js';
import type { CmdCustomerTarget } from '../collections/cmdExplorerCron.js';
import type { AuditScope } from './auditConfig.js';
import {
  consolidatedHeaderMismatch,
  mapConsolidatedRow,
  parsePositionalCsv,
  type PlainConsolidatedRow,
} from './auditRowMap.js';
import type { BillingAuditCronStats, PerCustomerOutcome } from './auditIngest.js';

const DEFAULT_BUDGET_MS = 270_000;
const BATCH = 250;

/** INSERT column list — order matches buildConsolidatedParams() exactly. The five
 *  0073 columns ride at the end. business_entity_id, facility_code, cmd_customer_id and
 *  source_filter_id are stamped per (customer, filter) — never inferred from the row. */
const INSERT_COLS = [
  'business_entity_id', 'audit_scope', 'cmd_claim_id', 'cmd_patient_id', 'claim_type',
  'claim_frequency', 'office_name', 'office_id', 'provider_name', 'billing_provider_id',
  'patient_name_enc', 'patient_name_bidx', 'patient_name_pfx3_bidx', 'patient_dob_enc',
  'member_id_enc', 'member_id_bidx', 'member_id_pfx3_bidx',
  'charge_from_date', 'charge_to_date', 'stmt_from_date', 'stmt_to_date', 'admission_date',
  'cpt_code', 'rev_code', 'modifier_1', 'modifier_2', 'units', 'type_of_bill',
  'charge_amount_cents', 'payer_name', 'auth_number', 'charge_status_raw',
  'status_category', 'status_payer', 'principal_diag', 'diagnoses', 'last_fu_note',
  'row_fingerprint', 'source_report_id', 'facility_code',
  'charge_debit_id', 'claim_date_entered', 'claim_first_billed_date', 'cmd_customer_id',
  'source_filter_id',
] as const;

/** Columns re-asserted on conflict — everything the 42-col feed CARRIES (under key
 *  identity, formerly-stable fields like dates/codes/amount are assertable too), plus
 *  the 0073 columns. DELIBERATELY ABSENT: claim_frequency / billing_provider_id /
 *  last_fu_note (not on this projection — never null-overwrite legacy values) and
 *  row_fingerprint (write-once; the OP cron's arbiter reads stored fingerprints). */
const UPDATE_COLS = [
  'audit_scope', 'cmd_claim_id', 'cmd_patient_id', 'claim_type', 'office_name',
  'provider_name', 'patient_name_enc', 'patient_name_bidx', 'patient_name_pfx3_bidx',
  'patient_dob_enc', 'member_id_enc', 'member_id_bidx', 'member_id_pfx3_bidx',
  'charge_from_date', 'charge_to_date', 'stmt_from_date', 'stmt_to_date', 'admission_date',
  'cpt_code', 'rev_code', 'modifier_1', 'modifier_2', 'units', 'type_of_bill',
  'charge_amount_cents', 'payer_name', 'auth_number', 'charge_status_raw',
  'status_category', 'status_payer', 'principal_diag', 'diagnoses',
  'source_report_id', 'facility_code',
  'charge_debit_id', 'claim_date_entered', 'claim_first_billed_date', 'cmd_customer_id',
  'source_filter_id',
] as const;

// --- batch classification (pure — unit-tested) ---------------------------------------

/** What the classifier knows about existing rows touching this batch's identity space. */
export interface ExistingIdentityState {
  /** stored row_fingerprint → its charge_debit_id (null = legacy unstamped). */
  fingerprintOwners: ReadonlyMap<string, string | null>;
  /** charge_debit_ids already present for this tenant. */
  existingKeys: ReadonlySet<string>;
}

export interface ClassifiedBatch {
  /** Legacy NULL-key rows matched by fingerprint → OLD arbiter (stamps the key).
   *  arbiterFingerprint is the MATCHED stored fingerprint (primary or legacy variant)
   *  and is what the INSERT carries as row_fingerprint so the conflict lands. */
  stampViaFingerprint: Array<{ row: PlainConsolidatedRow; arbiterFingerprint: string }>;
  /** Key already exists, or brand-new row → NEW arbiter (charge_debit_id). */
  upsertViaKey: PlainConsolidatedRow[];
  /** Fail-loud drops (counted, labelled, non-PHI). */
  quarantined: Array<{ label: string }>;
}

/**
 * Route each incoming row to its arbiter. `rows` MUST already be deduped by
 * charge_debit_id (last occurrence wins — the fresher slice assertion).
 */
export function classifyConsolidatedBatch(
  rows: PlainConsolidatedRow[],
  state: ExistingIdentityState,
): ClassifiedBatch {
  const out: ClassifiedBatch = { stampViaFingerprint: [], upsertViaKey: [], quarantined: [] };
  const batchFingerprints = new Set<string>();
  for (const row of rows) {
    // In-batch fingerprint dedupe: a second distinct key with an identical fingerprint
    // cannot insert under the retained UNIQUE (see module header) — quarantine it.
    const fps = [row.row_fingerprint, ...(row.legacy_fingerprint ? [row.legacy_fingerprint] : [])];
    if (fps.some((f) => batchFingerprints.has(f))) {
      out.quarantined.push({ label: 'fingerprint_duplicate_in_batch' });
      continue;
    }
    if (state.existingKeys.has(row.charge_debit_id)) {
      // Row already keyed — the key arbiter updates it; stored fingerprint is inert.
      out.upsertViaKey.push(row);
      fps.forEach((f) => batchFingerprints.add(f));
      continue;
    }
    const matchedFp = fps.find((f) => state.fingerprintOwners.has(f));
    if (matchedFp === undefined) {
      out.upsertViaKey.push(row); // brand-new charge line
      fps.forEach((f) => batchFingerprints.add(f));
      continue;
    }
    const owner = state.fingerprintOwners.get(matchedFp) ?? null;
    if (owner === null) {
      // The ruled transition: legacy row, fingerprint-matched → stamp its key.
      out.stampViaFingerprint.push({ row, arbiterFingerprint: matchedFp });
      fps.forEach((f) => batchFingerprints.add(f));
    } else {
      // Fingerprint already owned by a DIFFERENT key (owner ≠ this key — this key does
      // not exist). Inserting would violate the retained fingerprint UNIQUE → quarantine.
      out.quarantined.push({ label: 'fingerprint_conflict' });
    }
  }
  return out;
}

// --- param building (PHI encryption at the edge, outside the txn) --------------------

async function buildConsolidatedParams(
  row: PlainConsolidatedRow,
  businessEntityId: string,
  sourceReportId: string,
  facilityCode: string,
  cmdCustomerId: string,
  sourceFilterId: string,
  fingerprintOverride: string | null,
): Promise<unknown[] | null> {
  const [nameEnc, dobEnc, memberEnc] = await Promise.all([
    encryptPhi(row.patient_name),
    row.patient_dob === null ? Promise.resolve(null) : encryptPhi(row.patient_dob),
    row.member_id === null ? Promise.resolve(null) : encryptPhi(row.member_id),
  ]);
  const bidx = auditBlindIndexesForRowSafe(row.patient_name, row.member_id);
  if (bidx.patient_name_bidx === null) return null; // belt to the up-front key probe
  return [
    businessEntityId, row.audit_scope, row.cmd_claim_id, row.cmd_patient_id, row.claim_type,
    row.claim_frequency, row.office_name, null /* office_id: no source column */,
    row.provider_name, row.billing_provider_id,
    nameEnc, bidx.patient_name_bidx, bidx.patient_name_pfx3_bidx, dobEnc,
    memberEnc, bidx.member_id_bidx, bidx.member_id_pfx3_bidx,
    row.charge_from_date, row.charge_to_date, row.stmt_from_date, row.stmt_to_date, row.admission_date,
    row.cpt_code, row.rev_code, row.modifier_1, row.modifier_2, row.units, row.type_of_bill,
    row.charge_amount_cents, row.payer_name, row.auth_number, row.charge_status_raw,
    row.status_category, row.status_payer, row.principal_diag, JSON.stringify(row.diagnoses), row.last_fu_note,
    fingerprintOverride ?? row.row_fingerprint, sourceReportId, facilityCode,
    row.charge_debit_id, row.claim_date_entered, row.claim_first_billed_date, cmdCustomerId,
    sourceFilterId,
  ];
}

export interface ConsolidatedUpsertCounts {
  inserted: number;
  updated: number;
  /** Legacy rows stamped with their charge_debit_id via the fingerprint arbiter. */
  stamped_legacy: number;
  quarantined_by_label: Record<string, number>;
  /** Rows whose conflict UPDATE was skipped by an in-statement guard (cross-customer
   *  key collision, or a stamp target that acquired a different key mid-flight). */
  identity_conflicts: number;
  key_skipped: number;
}

/** One INSERT … ON CONFLICT statement over `paramRows` with the given arbiter. */
function upsertSql(arbiter: 'fingerprint' | 'key', tupleCount: number, colsPerRow: number): string {
  const tuples: string[] = [];
  for (let t = 0; t < tupleCount; t++) {
    const base = t * colsPerRow;
    tuples.push(`(${Array.from({ length: colsPerRow }, (_, j) => `$${base + j + 1}`).join(', ')})`);
  }
  const updates = UPDATE_COLS.map((c) => `${c} = excluded.${c}`).join(', ');
  const conflict =
    arbiter === 'fingerprint'
      ? 'on conflict (business_entity_id, row_fingerprint) do update'
      : 'on conflict (business_entity_id, charge_debit_id) where charge_debit_id is not null do update';
  // Guards: a stamp must never overwrite a row that acquired a DIFFERENT key; a key
  // upsert must never re-attribute a row to another customer. Skipped rows are counted
  // by the caller (returned < sent) as identity_conflicts.
  const guard =
    arbiter === 'fingerprint'
      ? 'where claims.audit_row.charge_debit_id is null or claims.audit_row.charge_debit_id = excluded.charge_debit_id'
      : 'where claims.audit_row.cmd_customer_id is null or claims.audit_row.cmd_customer_id = excluded.cmd_customer_id';
  return (
    `insert into claims.audit_row (${INSERT_COLS.join(', ')}) ` +
    `values ${tuples.join(', ')} ` +
    `${conflict} set ${updates}, ingested_at = now() ${guard} ` +
    `returning (xmax = 0) as inserted`
  );
}

/**
 * Batched consolidated upsert inside short tenant-scoped transactions. Per batch:
 * read the batch's identity state (fingerprints incl. legacy variants + keys), classify,
 * then route through the two arbiters. Encryption happens OUTSIDE the transaction.
 */
export async function upsertConsolidatedRows(
  db: Db,
  rows: PlainConsolidatedRow[],
  businessEntityId: string,
  sourceReportId: string,
  facilityCode: string,
  cmdCustomerId: string,
  sourceFilterId: string,
): Promise<ConsolidatedUpsertCounts> {
  const counts: ConsolidatedUpsertCounts = {
    inserted: 0, updated: 0, stamped_legacy: 0,
    quarantined_by_label: {}, identity_conflicts: 0, key_skipped: 0,
  };
  // Dedupe by key across the whole pull — LAST occurrence wins (fresher assertion).
  const byKey = new Map<string, PlainConsolidatedRow>();
  for (const row of rows) byKey.set(row.charge_debit_id, row);
  const deduped = [...byKey.values()];

  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const fps = batch.flatMap((r) => (r.legacy_fingerprint ? [r.row_fingerprint, r.legacy_fingerprint] : [r.row_fingerprint]));
    const keys = batch.map((r) => r.charge_debit_id);

    const state = await withTenant(db, businessEntityId, async (client) => {
      const fpRes = await client.query<{ row_fingerprint: string; charge_debit_id: string | null }>(
        'select row_fingerprint, charge_debit_id from claims.audit_row ' +
          'where business_entity_id = $1 and row_fingerprint = any($2::text[])',
        [businessEntityId, fps],
      );
      const keyRes = await client.query<{ charge_debit_id: string }>(
        'select charge_debit_id from claims.audit_row ' +
          'where business_entity_id = $1 and charge_debit_id = any($2::text[])',
        [businessEntityId, keys],
      );
      return {
        fingerprintOwners: new Map(fpRes.rows.map((r) => [r.row_fingerprint, r.charge_debit_id])),
        existingKeys: new Set(keyRes.rows.map((r) => r.charge_debit_id)),
      } satisfies ExistingIdentityState;
    });

    const classified = classifyConsolidatedBatch(batch, state);
    for (const q of classified.quarantined) {
      counts.quarantined_by_label[q.label] = (counts.quarantined_by_label[q.label] ?? 0) + 1;
    }

    // Encrypt OUTSIDE the transaction (never hold a pooled connection across libsodium).
    const stampParams: unknown[][] = [];
    for (const s of classified.stampViaFingerprint) {
      const p = await buildConsolidatedParams(s.row, businessEntityId, sourceReportId, facilityCode, cmdCustomerId, sourceFilterId, s.arbiterFingerprint);
      if (p === null) counts.key_skipped += 1;
      else stampParams.push(p);
    }
    const keyParams: unknown[][] = [];
    for (const r of classified.upsertViaKey) {
      const p = await buildConsolidatedParams(r, businessEntityId, sourceReportId, facilityCode, cmdCustomerId, sourceFilterId, null);
      if (p === null) counts.key_skipped += 1;
      else keyParams.push(p);
    }

    await withTenant(db, businessEntityId, async (client) => {
      if (stampParams.length > 0) {
        const res = await client.query<{ inserted: boolean }>(
          upsertSql('fingerprint', stampParams.length, INSERT_COLS.length),
          stampParams.flat(),
        );
        // Every stamp row conflicts by construction (fingerprint matched an existing
        // row) — a RETURNING row with inserted=true means the legacy row vanished
        // mid-flight and the insert landed fresh; both outcomes carry the key.
        counts.stamped_legacy += res.rows.filter((r) => !r.inserted).length;
        counts.inserted += res.rows.filter((r) => r.inserted).length;
        counts.updated += res.rows.filter((r) => !r.inserted).length;
        counts.identity_conflicts += stampParams.length - res.rows.length;
      }
      if (keyParams.length > 0) {
        const res = await client.query<{ inserted: boolean }>(
          upsertSql('key', keyParams.length, INSERT_COLS.length),
          keyParams.flat(),
        );
        const ins = res.rows.filter((r) => r.inserted).length;
        counts.inserted += ins;
        counts.updated += res.rows.length - ins;
        counts.identity_conflicts += keyParams.length - res.rows.length;
      }
    });
  }
  return counts;
}

// --- the consolidated cron loop -------------------------------------------------------

export interface ConsolidatedCronDeps {
  /** Roster to process THIS invocation (composition root already removed customers a
   *  prior pass processed today — the multi-pass nightly design). */
  customers: ReadonlyArray<CmdCustomerTarget>;
  /** Run one (customer, filter) report → zip (null = SUCCESS-empty post grace). */
  fetchZip: (customerId: string, filterId: string) => Promise<Buffer | null>;
  filterBId: string;
  filterCId: string;
  zipToCsvTexts: (zip: Buffer) => string[];
  writeDb: Db;
  businessEntityId: string;
  sourceReportId: string;
  /** SOAK FLAG: false = fetch/derive/count OP-scope rows but do NOT write them (see
   *  module header). Flips true at OP-pair decommission. */
  writeOpScopeRows: boolean;
  /** Customers whose empty report is EXPECTED (WRC) — never marks the run partial. */
  expectedEmptyCustomerIds: ReadonlySet<string>;
  /** Whether this customer has EVER landed audit rows (the honest-empty seed — a
   *  data-bearing customer coming back empty is suspicious; a never-seen one is not). */
  hasPriorRows?: (facilityCode: string) => Promise<boolean>;
  now?: () => number;
  budgetMs?: number;
  revalidate?: () => void | Promise<void>;
}

/** Superset of the per-scope stats with the consolidated counters. */
export interface ConsolidatedCronStats extends BillingAuditCronStats {
  rows_quarantined: number;
  quarantined_by_label: Record<string, number>;
  /** OP-scope rows fetched but deferred (writeOpScopeRows=false during the soak). */
  rows_op_scope_deferred: number;
  rows_scope_ip: number;
  rows_scope_op: number;
  /** Rows whose revenue code disagreed with the TOB-derived scope (logged check). */
  rev_code_inconsistent: number;
  stamped_legacy: number;
  identity_conflicts: number;
}

export async function consolidatedAuditCron(deps: ConsolidatedCronDeps): Promise<ConsolidatedCronStats> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = now();

  await encryptPhi('audit-key-probe'); // fail-fast key probes, as the per-scope cron
  if (patientNameBlindIndex('audit-key-probe') === null) {
    throw new Error('INDEX_HMAC_KEY missing/invalid — audit ingest requires blind indexes (patient_name_bidx is NOT NULL)');
  }

  const stats: ConsolidatedCronStats = {
    scope: 'CONSOLIDATED',
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
    customers_empty: 0,
    customers_empty_unexpected: 0,
    rows_quarantined: 0,
    quarantined_by_label: {},
    rows_op_scope_deferred: 0,
    rows_scope_ip: 0,
    rows_scope_op: 0,
    rev_code_inconsistent: 0,
    stamped_legacy: 0,
    identity_conflicts: 0,
  };

  for (const target of deps.customers) {
    if (now() - started > budgetMs) {
      stats.customers_skipped_budget += 1;
      stats.per_customer.push({ customer_id: target.customerId, facility: target.facilityCode, outcome: 'skipped_budget' });
      continue;
    }
    const entityId = target.businessEntityId ?? deps.businessEntityId;
    try {
      let customerInserted = 0;
      let customerUpdated = 0;
      let customerQuarantined = 0;
      const perFilterFetched: Record<string, number> = {};
      let emptyFilters = 0;
      let mismatch: string | null = null;

      // B then C, sequentially — one report at a time per CMD partner session.
      for (const filterId of [deps.filterBId, deps.filterCId]) {
        const zip = await deps.fetchZip(target.customerId, filterId);
        if (zip === null) {
          perFilterFetched[filterId] = 0;
          emptyFilters += 1;
          continue;
        }
        const rows: PlainConsolidatedRow[] = [];
        let fetched = 0;
        for (const text of deps.zipToCsvTexts(zip)) {
          const parsed = parsePositionalCsv(text);
          mismatch = consolidatedHeaderMismatch(parsed.header);
          if (mismatch !== null) break; // reject the customer whole — never guess columns into PHI rows
          fetched += parsed.rows.length;
          for (const raw of parsed.rows) {
            const result = mapConsolidatedRow(raw);
            if (result.kind === 'ok') {
              rows.push(result.row);
            } else if (result.kind === 'quarantine') {
              customerQuarantined += 1;
              stats.rows_quarantined += 1;
              stats.quarantined_by_label[result.label] = (stats.quarantined_by_label[result.label] ?? 0) + 1;
            } else {
              stats.skipped += 1;
              stats.skipped_by_label[result.label] = (stats.skipped_by_label[result.label] ?? 0) + 1;
            }
          }
        }
        if (mismatch !== null) break;
        perFilterFetched[filterId] = fetched;
        stats.rows_fetched += fetched;

        const ipRows = rows.filter((r) => r.audit_scope === 'IP');
        const opRows = rows.filter((r) => r.audit_scope === 'OP');
        stats.rows_scope_ip += ipRows.length;
        stats.rows_scope_op += opRows.length;
        stats.rev_code_inconsistent += rows.filter((r) => !r.rev_scope_consistent).length;
        const writable = deps.writeOpScopeRows ? rows : ipRows;
        if (!deps.writeOpScopeRows) stats.rows_op_scope_deferred += opRows.length;
        stats.mapped_valid += rows.length;

        if (writable.length > 0) {
          const counts = await upsertConsolidatedRows(
            deps.writeDb, writable, entityId, deps.sourceReportId,
            target.facilityCode, target.customerId, filterId,
          );
          customerInserted += counts.inserted;
          customerUpdated += counts.updated;
          stats.inserted += counts.inserted;
          stats.updated += counts.updated;
          stats.stamped_legacy += counts.stamped_legacy;
          stats.identity_conflicts += counts.identity_conflicts;
          for (const [label, n] of Object.entries(counts.quarantined_by_label)) {
            stats.rows_quarantined += n;
            customerQuarantined += n;
            stats.quarantined_by_label[label] = (stats.quarantined_by_label[label] ?? 0) + n;
          }
          if (counts.key_skipped > 0) {
            stats.skipped += counts.key_skipped;
            stats.skipped_by_label['blind_index: unavailable'] =
              (stats.skipped_by_label['blind_index: unavailable'] ?? 0) + counts.key_skipped;
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
          `billing-audit consolidated cron: customer ${target.customerId} (${target.facilityCode}) header mismatch — ${mismatch}`,
        );
        continue;
      }

      if (emptyFilters === 2) {
        // Honest-empty accounting (recon item 6): counted, and PARTIAL unless expected.
        stats.customers_empty += 1;
        const expected = deps.expectedEmptyCustomerIds.has(target.customerId);
        let unexpected = false;
        if (!expected && deps.hasPriorRows) unexpected = await deps.hasPriorRows(target.facilityCode);
        if (unexpected) stats.customers_empty_unexpected += 1;
        stats.customers_processed += 1;
        stats.per_customer.push({
          customer_id: target.customerId, facility: target.facilityCode, outcome: 'empty',
          reason: expected ? 'expected-empty (allowlisted)' : unexpected ? 'UNEXPECTED — customer has prior rows' : undefined,
        });
        continue;
      }

      stats.customers_processed += 1;
      const outcome: PerCustomerOutcome = {
        customer_id: target.customerId, facility: target.facilityCode,
        outcome: 'processed', rows_inserted: customerInserted, rows_updated: customerUpdated,
      };
      const fetchedB = perFilterFetched[deps.filterBId] ?? 0;
      const fetchedC = perFilterFetched[deps.filterCId] ?? 0;
      outcome.reason = `B:${fetchedB} C:${fetchedC}${customerQuarantined > 0 ? ` quarantined:${customerQuarantined}` : ''}`;
      stats.per_customer.push(outcome);
    } catch (err) {
      stats.customers_failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      stats.per_customer.push({
        customer_id: target.customerId, facility: target.facilityCode, outcome: 'failed', reason,
      });
      console.error(
        `billing-audit consolidated cron: customer ${target.customerId} (${target.facilityCode}) failed: ${reason}`,
      );
    }
  }

  if (stats.customers_processed > 0 && deps.revalidate) await deps.revalidate();

  console.log(
    `billing-audit consolidated cron: customers ${stats.customers_processed}/${stats.customers_total} ` +
      `(failed ${stats.customers_failed}, header-mismatch ${stats.customers_header_mismatch}, ` +
      `budget-skipped ${stats.customers_skipped_budget}, empty ${stats.customers_empty}` +
      `${stats.customers_empty_unexpected > 0 ? ` [${stats.customers_empty_unexpected} UNEXPECTED]` : ''}); ` +
      `fetched ${stats.rows_fetched} (IP ${stats.rows_scope_ip} / OP ${stats.rows_scope_op}` +
      `${stats.rows_op_scope_deferred > 0 ? `, OP deferred ${stats.rows_op_scope_deferred}` : ''}), ` +
      `valid ${stats.mapped_valid}, skipped ${stats.skipped}, quarantined ${stats.rows_quarantined}, ` +
      `rev-inconsistent ${stats.rev_code_inconsistent}, inserted ${stats.inserted}, updated ${stats.updated}, ` +
      `stamped-legacy ${stats.stamped_legacy}, identity-conflicts ${stats.identity_conflicts}`,
  );
  return stats;
}
