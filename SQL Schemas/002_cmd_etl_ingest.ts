/**
 * CMD Batch CSV → Staging Tables ETL  (v2 — noise-filtered)
 * Gate-review before applying. Nothing touches main until confirmed.
 *
 * NOISE FILTER RULES (derived from BATCH_DUMP_ALL_TIME profiling):
 *
 *   EXCLUDED statuses (noise — no adjudication outcome):
 *     DELETED       — claim cancelled in CMD, $589K gap source
 *     ON HOLD       — not sent to payer, billing incomplete
 *     PTM           — "pending to mail", never submitted
 *     TERMED INSURANCE — coverage terminated before claim, $99K gap source
 *
 *   QUARANTINED statuses (excluded from training, kept for ops visibility):
 *     WRITE OFF     — intentional write-off, not a miss; keep for audit, skip training
 *
 *   NULL CREDIT ID rule:
 *     Rows where Credit ID is blank AND status is PAID → CMD data quality issue
 *     (PAID status, $0 paid, $0 adj — ghost rows). Excluded entirely.
 *     Rows where Credit ID is blank AND status is in-flight (CLAIM AT *) → keep one
 *     per charge_debit_id (first occurrence). These are valid unbilled placeholders.
 *
 *   REVERSAL rows (Charge Primary Paid < 0):
 *     Kept but flagged is_reversal=true. Era adjustments skipped on reversals.
 *     The matching positive row carries the net financial position.
 *
 *   ZERO BILLED rows: excluded (24 rows — PAID/BDP with $0 charge amount, no signal)
 *
 *   PAYMENT LAG OUTLIERS (lag > 730 days):
 *     Capped at NULL with a flag — 3,665-day lag is a data error, not a real signal.
 *     46 rows affected. Kept in DB but lag set null to avoid poisoning the label.
 *
 *   CLAIM FREQUENCY:
 *     Now populated for 830 rows. Used for tob_frequency when present.
 *     Format: "1 - Original Claim", "7 - Replacement of Prior Claim", "8 - Void/Cancel"
 *     Parsed to extract leading digit.
 *
 * TRAINING SET FILTER (is_training_eligible):
 *     Exclude: void (freq=8), first-interim (freq=2), reversals, write-offs
 *     Include: original (freq=1), continuing (freq=3), replacement (freq=7)
 *     AND status must be adjudicated (not CLAIM AT *, not ON HOLD)
 *
 * APPROVED FOR HIGHER PAYMENT → separate outcome label (appeals-won class)
 *   Most valuable training label in the dataset. Stored as claim_status verbatim;
 *   Brain 1 training code should treat this as outcome class = 'APPEAL_WON'.
 */

import { createReadStream } from 'fs'
import { parse } from 'csv-parse'
import { Pool, PoolClient } from 'pg'
import sodium from 'libsodium-wrappers'
import path from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DB_URL             = process.env.DATABASE_URL
const LIBSODIUM_KEY_HEX  = process.env.LIBSODIUM_KEY
const BUSINESS_ENTITY_ID = process.env.CMD_BUSINESS_ENTITY_ID
const INGESTED_BY        = process.env.INGEST_USER ?? 'cmd_etl'

if (!DB_URL || !LIBSODIUM_KEY_HEX || !BUSINESS_ENTITY_ID) {
  console.error('Missing required env: DATABASE_URL, LIBSODIUM_KEY, CMD_BUSINESS_ENTITY_ID')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Noise filter rules — all derived from data profiling, documented above
// ---------------------------------------------------------------------------

// Hard exclude: these statuses have no adjudication outcome and pollute labels
const EXCLUDE_STATUSES = new Set([
  'DELETED',
  'ON HOLD',
  'PTM',
  'TERMED INSURANCE',
])

// Quarantine: keep for ops/audit but flag out of training
const QUARANTINE_STATUSES = new Set([
  'WRITE OFF',
])

// In-flight: valid claims not yet adjudicated — keep one row per charge
const IN_FLIGHT_PREFIX = 'CLAIM AT'

// Payment lag cap: beyond 730 days assume data error, store as null
const LAG_CAP_DAYS = 730

// Statuses that map to Brain 1 outcome classes
const OUTCOME_MAP: Record<string, string> = {
  'PAID':                        'PAID',
  'BALANCE DUE PATIENT':         'PAID_PAT_BAL',
  'APPROVED FOR HIGHER PAYMENT': 'APPEAL_WON',      // ← most valuable label
  'PENDING FOR HIGHER PAYMENT':  'APPEAL_PENDING',
  'NEEDS RENEGOTIATING':         'NEEDS_RENEGOTIATION',
  'WRITE OFF':                   'WRITE_OFF',
}

function classifyOutcome(status: string): string {
  const s = status.trim()
  if (OUTCOME_MAP[s]) return OUTCOME_MAP[s]
  if (s.startsWith(IN_FLIGHT_PREFIX)) return 'IN_FLIGHT'
  if (s === 'CLAIM AT SELF PAY') return 'SELF_PAY'
  return 'OTHER'
}

// ---------------------------------------------------------------------------
// TOB decomposition
// CMD displays 3-digit TOB (leading 0 suppressed).
// s[0]=facility type, s[1]=care setting, s[2]=frequency
// Verified against 14 TOBs: 861,862,863,867,868,892,893,897,898,111,113,117,133,137
//
// NEW: Claim Frequency field now has values for 830 rows:
//   "1 - Original Claim", "7 - Replacement of Prior Claim", "8 - Void/Cancel Prior Claim"
// Parse leading digit as tob_frequency fallback when TOB raw unavailable.
// ---------------------------------------------------------------------------
type TobDecomposition = {
  tob_raw:          string | null
  tob_facility_type: number | null
  tob_care_setting:  number | null
  tob_frequency:     number | null
}

const VALID_FACILITY_TYPES = new Set([1, 8])
const VALID_CARE_SETTINGS  = new Set([1, 3, 6, 9])
const VALID_FREQUENCIES    = new Set([1, 2, 3, 7, 8])
const TRAINING_FREQUENCIES = new Set([1, 3, 7])  // exclude void(8) and first-interim(2)

function parseTobFrequency(claimFrequency: string | undefined): number | null {
  if (!claimFrequency?.trim()) return null
  // Format: "1 - Original Claim" / "7 - Replacement of Prior Claim" / "8 - Void/Cancel"
  const match = claimFrequency.trim().match(/^(\d)/)
  if (!match) return null
  const n = parseInt(match[1], 10)
  return VALID_FREQUENCIES.has(n) ? n : null
}

function decomposeTob(tobRaw: string | undefined, claimFrequency: string | undefined): TobDecomposition {
  // Try TOB raw first
  const s = tobRaw?.trim()
  if (s && s.length >= 3) {
    const facilityType = parseInt(s[0], 10)
    const careSetting  = parseInt(s[1], 10)
    const frequency    = parseInt(s[2], 10)
    return {
      tob_raw:           s,
      tob_facility_type: VALID_FACILITY_TYPES.has(facilityType) ? facilityType : null,
      tob_care_setting:  VALID_CARE_SETTINGS.has(careSetting)   ? careSetting  : null,
      tob_frequency:     VALID_FREQUENCIES.has(frequency)       ? frequency    : null,
    }
  }
  // Fallback: parse frequency from Claim Frequency field (830 rows in all-time dump)
  const freq = parseTobFrequency(claimFrequency)
  return {
    tob_raw:           null,
    tob_facility_type: null,
    tob_care_setting:  null,
    tob_frequency:     freq,
  }
}

function isTrainingEligible(
  tob: TobDecomposition,
  status: string,
  isReversal: boolean,
  isQuarantined: boolean
): boolean {
  if (isReversal || isQuarantined) return false
  if (status.startsWith(IN_FLIGHT_PREFIX)) return false
  if (EXCLUDE_STATUSES.has(status)) return false
  if (tob.tob_frequency !== null && !TRAINING_FREQUENCIES.has(tob.tob_frequency)) return false
  return true
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
function parseMoney(s: string | undefined): number | null {
  if (!s?.trim()) return null
  const cleaned = s.trim().replace(/\$/g, '').replace(/,/g, '').replace(/\((.+)\)/, '-$1')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function parseDate(s: string | undefined): string | null {
  if (!s?.trim()) return null
  const [m, d, y] = s.trim().split('/')
  if (!m || !d || !y) return null
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

function parseBoolean(s: string | undefined): boolean | null {
  if (!s?.trim()) return null
  const v = s.trim().toLowerCase()
  if (v === 'yes' || v === 'true' || v === 'y' || v === '1') return true
  if (v === 'no'  || v === 'false' || v === 'n' || v === '0') return false
  return null
}

function parseLag(s: string | undefined): number | null {
  if (!s?.trim()) return null
  const n = parseInt(s.trim(), 10)
  if (isNaN(n) || n < 0) return null
  return n > LAG_CAP_DAYS ? null : n  // cap outliers — 3,665-day lag is a data error
}

// ---------------------------------------------------------------------------
// PHI encryption
// ---------------------------------------------------------------------------
let _sodiumKey: Uint8Array | null = null

async function sodiumKey(): Promise<Uint8Array> {
  if (_sodiumKey) return _sodiumKey
  await sodium.ready
  const hex = LIBSODIUM_KEY_HEX!
  if (hex.length !== 64) throw new Error('LIBSODIUM_KEY must be 32 bytes hex (64 chars)')
  _sodiumKey = sodium.from_hex(hex)
  return _sodiumKey
}

async function encryptPhi(value: string | undefined): Promise<Buffer | null> {
  if (!value?.trim()) return null
  await sodium.ready
  const key = await sodiumKey()
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(value.trim()), nonce, key)
  const result = Buffer.alloc(nonce.length + ciphertext.length)
  Buffer.from(nonce).copy(result, 0)
  Buffer.from(ciphertext).copy(result, nonce.length)
  return result
}

// ---------------------------------------------------------------------------
// Adjustment code parser (unpivot 99 wide columns → Map)
// Sums duplicate columns (96, N776 appear twice in CMD export)
// PRESERVES SIGN: negatives are intentional reversal/correction events (~8.1% of
// cells; codes 147 ~34% neg, 242 ~26% neg). Brain 2 drift detection needs them;
// downstream (003 dominant_carc) must sign-handle. Do NOT drop or ABS them.
// ---------------------------------------------------------------------------
function parseAdjustmentCodes(
  row: Record<string, string>,
  header: string[],
  isReversal: boolean
): Map<string, number> {
  const result = new Map<string, number>()
  if (isReversal) return result  // no CARC data on reversal rows

  for (const col of header) {
    if (!col.startsWith('Adjustment Amount by Code ')) continue
    const code   = col.replace('Adjustment Amount by Code ', '').trim()
    const amount = parseMoney(row[col])
    if (amount === null || amount === 0) continue
    result.set(code, (result.get(code) ?? 0) + amount)
  }
  return result
}

// ---------------------------------------------------------------------------
// Dedup logic
//
// Primary key: (charge_debit_id, credit_id)
//   — confirmed unique for rows where credit_id is present (BATCH_TEST_7 verified)
//
// Null Credit ID cases (1,175 rows in all-time dump):
//   PAID + null credit + $0 paid + $0 adj → ghost row, hard exclude
//   WRITE OFF + null credit              → quarantine, keep one per charge
//   CLAIM AT * + null credit             → in-flight, keep one per charge
//   ON HOLD + null credit                → excluded by status filter
//   DELETED + null credit                → excluded by status filter
//
// For "keep one per charge" cases: last-write-wins on the Map (stable across runs
// since CMD reports rows in consistent order within a charge).
// ---------------------------------------------------------------------------
type FilterResult =
  | { action: 'exclude'; reason: string }
  | { action: 'quarantine'; reason: string }
  | { action: 'keep'; dedupKey: string; isReversal: boolean }

function filterRow(row: Record<string, string>): FilterResult {
  const status   = row['Claim Status']?.trim() ?? ''
  const creditId = row['Credit ID']?.trim()    ?? ''
  const billed   = parseMoney(row['Charge Amount']) ?? 0
  const paid     = parseMoney(row['Charge Primary Paid']) ?? 0
  const insAdj   = parseMoney(row['Charge Insurance Adjustments']) ?? 0
  const chargeId = row['Charge/Debit ID']?.trim() ?? ''

  // Hard excludes — no data value
  if (EXCLUDE_STATUSES.has(status)) {
    return { action: 'exclude', reason: status }
  }

  // PAID + null credit + $0 paid + $0 adj = ghost row (39 rows in all-time)
  if (status === 'PAID' && !creditId && paid === 0 && insAdj === 0) {
    return { action: 'exclude', reason: 'PAID_GHOST' }
  }

  // Zero billed (24 rows — no financial signal)
  if (billed === 0 && paid === 0) {
    return { action: 'exclude', reason: 'ZERO_BILLED' }
  }

  // Write-off: quarantine (keep for audit, exclude from training)
  if (QUARANTINE_STATUSES.has(status)) {
    const key = creditId ? `${chargeId}__${creditId}` : `${chargeId}__WO`
    return { action: 'quarantine', reason: 'WRITE_OFF' }
  }

  // Reversal: negative paid amount — keep but flag
  const isReversal = paid < 0

  // Build dedup key
  // Null-credit grain reconciled to the DB key (migration 007: claim_line unique is
  // NULLS NOT DISTINCT, so null-credit rows for one charge are equal). The in-memory
  // key MUST collapse them too -- else two in-flight statuses for one charge would
  // silently collapse via ON CONFLICT (last-write-wins) instead of by this explicit
  // rule. Verified 2026-06-22: 0 of 6,842 null-credit charges carry >1 distinct
  // status, so this loses nothing today.
  const dedupKey = creditId
    ? `${chargeId}__${creditId}`
    : `${chargeId}__`  // null credit: exactly one row per charge (grain = charge,null)

  return { action: 'keep', dedupKey, isReversal }
}

// ---------------------------------------------------------------------------
// Ref table check
// ---------------------------------------------------------------------------
interface RemitRef { code_type: string | null; category: string | null; is_miss_candidate: boolean | null }

// Load ref.remittance_code once into an in-memory Map (98 rows) so the CARC unpivot
// does a local lookup instead of one SELECT per code per row — saves ~65K round
// trips over the 6543 pooler on a full backfill.
async function loadRemittanceCodes(client: PoolClient): Promise<Map<string, RemitRef>> {
  const { rows } = await client.query(
    'SELECT code, code_type, category, is_miss_candidate FROM ref.remittance_code'
  )
  if (rows.length === 0) {
    console.warn('WARNING: ref.remittance_code is empty. Run 000_seed_remittance_codes.ts first.')
    console.warn('Continuing — era_adjustment rows will have null category.')
  }
  const m = new Map<string, RemitRef>()
  for (const r of rows) {
    m.set(r.code, { code_type: r.code_type, category: r.category, is_miss_candidate: r.is_miss_candidate })
  }
  return m
}

// ---------------------------------------------------------------------------
// Main ingest
// ---------------------------------------------------------------------------
interface IngestOptions {
  csvPath: string
  sourceReportDate: string
  dryRun?: boolean
}

interface IngestStats {
  total_parsed:    number
  excluded:        Record<string, number>
  quarantined:     number
  deduped_away:    number
  reversals:       number
  lag_capped:      number
  upserted_claims: number
  upserted_adjs:   number
  upserted_payers: number
}

async function ingest(opts: IngestOptions): Promise<IngestStats> {
  const { csvPath, sourceReportDate, dryRun = false } = opts
  const sourceFileName = path.basename(csvPath)

  await sodium.ready
  const pool = new Pool({ connectionString: DB_URL })
  let client: PoolClient | null = null

  const stats: IngestStats = {
    total_parsed: 0, excluded: {}, quarantined: 0, deduped_away: 0,
    reversals: 0, lag_capped: 0, upserted_claims: 0, upserted_adjs: 0, upserted_payers: 0,
  }

  try {
    client = await pool.connect()
    await client.query(`SELECT set_config('app.business_entity_id', $1, true)`, [BUSINESS_ENTITY_ID])
    const remitCache = await loadRemittanceCodes(client)

    // Parse CSV
    const records: Record<string, string>[] = []
    let headerRow: string[] = []

    await new Promise<void>((resolve, reject) => {
      createReadStream(csvPath)
        .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
        .on('data', (row: Record<string, string>) => records.push(row))
        .on('end', resolve)
        .on('error', reject)
    })
    // Header derivation: csv-parse (columns:true) yields header-keyed objects and
    // does NOT emit a 'headers' event — that belongs to the separate csv-parser
    // package. Derive the column list from the first record so the CARC unpivot
    // sees the 99 "Adjustment Amount by Code X" columns. (Prior bug: relying on the
    // never-fired 'headers' event left headerRow=[] -> zero era_adjustment rows.)
    headerRow = records.length ? Object.keys(records[0]) : []
    stats.total_parsed = records.length
    console.log(`Parsed ${records.length.toLocaleString()} rows from ${sourceFileName}`)

    // Apply noise filters + dedup
    const kept   = new Map<string, Record<string, string>>()
    const quarantined: Record<string, string>[] = []

    for (const row of records) {
      const result = filterRow(row)

      if (result.action === 'exclude') {
        stats.excluded[result.reason] = (stats.excluded[result.reason] ?? 0) + 1
        continue
      }
      if (result.action === 'quarantine') {
        quarantined.push(row)
        stats.quarantined++
        continue
      }

      // Keep: last-write-wins for null-credit-ID dedup
      if (kept.has(result.dedupKey)) stats.deduped_away++
      kept.set(result.dedupKey, row)
    }

    console.log(`After filtering: ${kept.size.toLocaleString()} rows to ingest`)
    console.log(`Excluded: ${JSON.stringify(stats.excluded)}`)
    console.log(`Quarantined (write-offs): ${stats.quarantined}`)
    console.log(`Deduped away: ${stats.deduped_away}`)

    if (dryRun) {
      // Show money summary on kept rows
      let billed = 0, paid = 0, balIns = 0, denial = 0
      const DENIAL = new Set(['147','197','29','50','109','119','200','204','22','242','243','279','288','96','A1'])
      const code_cols_dry = headerRow.filter(h => h.startsWith('Adjustment Amount by Code '))
      for (const row of kept.values()) {
        billed += parseMoney(row['Charge Amount']) ?? 0
        paid   += parseMoney(row['Charge Primary Paid']) ?? 0
        balIns += parseMoney(row['Charge Balance Due Ins']) ?? 0
        for (const col of code_cols_dry) {
          const code = col.replace('Adjustment Amount by Code ', '').trim()
          const v = parseMoney(row[col]) ?? 0
          if (v > 0 && DENIAL.has(code)) denial += v
        }
      }
      console.log(`\nDRY RUN summary (${kept.size.toLocaleString()} rows):`)
      console.log(`  Billed:       $${billed.toLocaleString()}`)
      console.log(`  Paid:         $${paid.toLocaleString()}`)
      console.log(`  Bal due ins:  $${balIns.toLocaleString()}`)
      console.log(`  Denial codes: $${denial.toLocaleString()}`)
      console.log('Remove --dry-run to apply.')
      return stats
    }

    await client.query('BEGIN')

    for (const row of kept.values()) {
      const chargeId   = row['Charge/Debit ID']?.trim()
      const creditId   = row['Credit ID']?.trim() || null
      const status     = row['Claim Status']?.trim() ?? ''
      const paid       = parseMoney(row['Charge Primary Paid']) ?? 0
      const isReversal = paid < 0
      if (isReversal) stats.reversals++

      // allowed_amount — payer-contracted allowed proxy, adjudicated rows only.
      // Accounting identity: Charge Amount − Charge Insurance Adjustments.
      // Equals paid + patient responsibility in 99.8% of adjudicated rows
      // (Fee Schedule cross-check, all 10 major payers). NULL otherwise.
      // NOTE: parseMoney(), not parseFloat — CMD money cells carry '$' and ','
      // (e.g. "$1,465.00"); parseFloat() would return NaN on every row.
      // `Fee Schedule Applied` (text label) and `Current Payer Contract Amount`
      // (100% $0.00) are intentionally NOT used as allowed sources.
      const chargeAmt = parseMoney(row['Charge Amount'])
      const insAdjAmt = parseMoney(row['Charge Insurance Adjustments'])
      const isAdjudicated = status === 'PAID' || status === 'BALANCE DUE PATIENT'
      let allowedAmount: number | null = null
      if (isAdjudicated) {
        const computed = (chargeAmt ?? 0) - (insAdjAmt ?? 0)
        if (computed < 0) {
          // Data anomaly (adjustments exceed charge). Charge ID only — no PHI.
          console.warn(`allowed_amount negative (${computed.toFixed(2)}) for charge ${chargeId} — set null`)
        } else {
          allowedAmount = computed
        }
      }

      // TOB decomposition — uses Claim Frequency fallback for rows without TOB raw
      const tob = decomposeTob(row['Type of Bill'], row['Claim Frequency'])
      const trainingEligible = isTrainingEligible(tob, status, isReversal, false)

      // Lag cap
      const rawLag = parseInt2(row['Insurance Payment Lag'])
      if (rawLag !== null && rawLag > LAG_CAP_DAYS) stats.lag_capped++
      const lag = parseLag(row['Insurance Payment Lag'])

      // Outcome class (Brain 1 label)
      const outcomeClass = classifyOutcome(status)

      // Payer upsert
      const cmdPayerId = row['Charge Current Payer ID']?.trim() ?? ''
      if (cmdPayerId) {
        await client.query(`
          INSERT INTO staging.payer_dim (
            business_entity_id, cmd_payer_id, clearinghouse_payer_id,
            payer_name, payer_name_with_id, payer_plan_name,
            payer_type, network_status, process_mode, default_billing_status,
            participates_in_era, participates_in_elig,
            requires_inst_agreement, accepts_secondary_elec, ingested_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (business_entity_id, cmd_payer_id) DO UPDATE SET
            clearinghouse_payer_id = EXCLUDED.clearinghouse_payer_id,
            payer_name             = EXCLUDED.payer_name,
            payer_plan_name        = EXCLUDED.payer_plan_name,
            payer_type             = EXCLUDED.payer_type,
            process_mode           = EXCLUDED.process_mode,
            participates_in_era    = EXCLUDED.participates_in_era,
            participates_in_elig   = EXCLUDED.participates_in_elig
        `, [
          BUSINESS_ENTITY_ID, cmdPayerId,
          row['Clearinghouse Payer ID']?.trim() || null,
          row['Charge Current Payer Name']?.trim() || null,
          row['Payer Name w/ID']?.trim() || null,
          row['Payer Plan Name']?.trim() || null,
          row['Charge Current Payer Type']?.trim() || null,
          row['Payer Network Status']?.trim() || null,
          row['Process Mode']?.trim() || null,
          row['Default Billing Status']?.trim() || null,
          parseBoolean(row['Participates in ERA?']),
          parseBoolean(row['Participates in Eligibility?']),
          parseBoolean(row['Requires Inst Claim Agreement?']),
          parseBoolean(row['Accepts Secondary Electronic?']),
          INGESTED_BY,
        ])
        stats.upserted_payers++
      }

      const { rows: payerRows } = await client.query(
        `SELECT id FROM staging.payer_dim WHERE business_entity_id = $1 AND cmd_payer_id = $2`,
        [BUSINESS_ENTITY_ID, cmdPayerId]
      )
      const payerDimId: number | null = payerRows[0]?.id ?? null

      // PHI encryption
      const patientNameRaw = [row['Patient First Name']?.trim(), row['Patient Last Name']?.trim()]
        .filter(Boolean).join(' ')
      const [patientIdEnc, patientNameEnc, memberIdEnc, groupNumEnc] = await Promise.all([
        encryptPhi(row['Charge Patient ID']),
        encryptPhi(patientNameRaw),
        encryptPhi(row['Current Payer Member ID']),
        encryptPhi(row['Current Payer Group #']),
      ])

      // Claim line upsert
      const { rows: claimRows } = await client.query(`
        INSERT INTO staging.claim_line (
          business_entity_id, charge_debit_id, credit_id, claim_id,
          patient_id_enc, patient_name_enc, member_id_enc, group_number_enc,
          claim_facility_id, claim_rendering_provider, charge_rendering_provider,
          tob_raw, tob_facility_type, tob_care_setting, tob_frequency,
          charge_from_date, charge_to_date, claim_from_date,
          primary_payment_date, secondary_payment_date,
          payment_received_date, payment_entered_date,
          cpt_code, rev_code, rev_code_description,
          tos_code, tos_description, pos_description,
          diagnosis_pointer_list, units, fee_schedule_applied,
          payer_dim_id, current_payer_name, current_payer_id,
          current_payer_type, current_payer_priority,
          primary_payer_name, secondary_payer_name, tertiary_payer_name,
          current_payer_contract,
          charge_amount, charge_primary_paid, charge_secondary_paid,
          insurance_paid_amount, charge_insurance_adj, charge_patient_adj,
          charge_balance_due_pat, charge_balance_due_ins,
          charge_net_amount, charge_balance_at_coll,
          current_payer_contract_amt,
          insurance_payment_lag, insurance_billing_lag, total_time_to_payment,
          claim_status, claim_type, claim_frequency,
          charge_incomplete, auth_exception,
          acct_credit_type, eft_payment,
          source_type, source_report_date, source_file_name, ingested_by,
          allowed_amount
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
          $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
          $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
          $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
          $61,$62,$63,$64,$65,$66
        )
        ON CONFLICT (business_entity_id, charge_debit_id, credit_id) DO UPDATE SET
          claim_status           = EXCLUDED.claim_status,
          -- allowed_amount tracks claim_status: a row flipping to PAID on a later
          -- report run must recompute its allowed proxy, not keep a stale NULL.
          allowed_amount         = EXCLUDED.allowed_amount,
          charge_balance_due_ins = EXCLUDED.charge_balance_due_ins,
          charge_balance_due_pat = EXCLUDED.charge_balance_due_pat,
          insurance_payment_lag  = EXCLUDED.insurance_payment_lag,
          total_time_to_payment  = EXCLUDED.total_time_to_payment,
          payer_dim_id           = EXCLUDED.payer_dim_id
        RETURNING id
      `, [
        BUSINESS_ENTITY_ID,
        chargeId, creditId,
        row['Claim ID']?.trim(),
        patientIdEnc, patientNameEnc, memberIdEnc, groupNumEnc,
        row['Claim Facility ID']?.trim() || null,
        row['Claim Rendering Provider ID']?.trim() || null,
        row['Charge Rendering Provider ID']?.trim() || null,
        tob.tob_raw, tob.tob_facility_type, tob.tob_care_setting, tob.tob_frequency,
        parseDate(row['Charge From Date']),
        parseDate(row['Charge To Date']),
        parseDate(row['Claim From Date']),
        parseDate(row['Charge Primary Payment Date']),
        parseDate(row['Charge Secondary Payment Date']),
        parseDate(row['Payment Received']),
        parseDate(row['Payment Entered']),
        row['Charge CPT Code']?.trim() || null,
        row['Charge Rev Code']?.trim()  || null,
        row['Revenue Code Description']?.trim() || null,
        row['Charge TOS Code']?.trim()  || null,
        row['Charge TOS Description']?.trim() || null,
        row['Charge POS Description']?.trim() || null,
        row['Charge Diagnosis Pointer List']?.trim() || null,
        parseMoney(row['Charge Units']),
        row['Fee Schedule Applied']?.trim() || null,
        payerDimId,
        row['Charge Current Payer Name']?.trim() || null,
        row['Charge Current Payer ID']?.trim()   || null,
        row['Charge Current Payer Type']?.trim()  || null,
        row['Charge Current Payer Priority']?.trim() || null,
        row['Charge Primary Payer Name']?.trim()  || null,
        row['Charge Secondary Payer Name']?.trim() || null,
        row['Charge Tertiary Payer Name']?.trim()  || null,
        row['Current Payer Contract Name']?.trim() || null,
        chargeAmt,
        parseMoney(row['Charge Primary Paid']),
        parseMoney(row['Charge Secondary Paid']),
        parseMoney(row['Insurance Paid Amount']),
        insAdjAmt,
        parseMoney(row['Charge Patient Adjustments']),
        parseMoney(row['Charge Balance Due Pat']),
        parseMoney(row['Charge Balance Due Ins']),
        parseMoney(row['Charge Net Amount']),
        parseMoney(row['Charge Balance At Collections']),
        parseMoney(row['Current Payer Contract Amount']),
        lag,
        parseLag(row['Insurance Billing Lag']),
        parseLag(row['Total Time to Payment']),
        status,
        row['Claim Type']?.trim() || null,
        row['Claim Frequency']?.trim() || null,
        parseBoolean(row['Charge Incomplete?']),
        row['Claim Service Auth. Exception']?.trim() || null,
        row['Acct Credit Type']?.trim() || null,
        row['EFT Payment']?.trim() || null,
        'CMD_BATCH',
        sourceReportDate,
        sourceFileName,
        INGESTED_BY,
        allowedAmount,
      ])

      stats.upserted_claims++
      const claimLineId: number = claimRows[0].id

      // Era adjustments — credit-level grain (charge, credit_id, code). Whole
      // isReversal rows still skip adjustments; per-code negatives on normal rows
      // are PRESERVED (reversal/correction signal for Brain 2). See parseAdjustmentCodes.
      if (!isReversal) {
        const creditId = (row['Credit ID'] ?? '').trim()  // '' for null-credit charges (matches 006 unique key)
        const codes = parseAdjustmentCodes(row, headerRow, isReversal)
        for (const [code, amount] of codes.entries()) {
          const ref = remitCache.get(code)

          await client.query(`
            INSERT INTO staging.era_adjustment (
              business_entity_id, claim_line_id, charge_debit_id, credit_id,
              carc_code, carc_type, adjustment_amount,
              category, is_miss_candidate, ingested_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (business_entity_id, charge_debit_id, credit_id, carc_code)
            DO UPDATE SET
              adjustment_amount = EXCLUDED.adjustment_amount,
              category          = EXCLUDED.category,
              is_miss_candidate = EXCLUDED.is_miss_candidate
          `, [
            BUSINESS_ENTITY_ID,
            claimLineId, chargeId, creditId, code,
            ref?.code_type ?? (code.match(/^[MN]/i) ? 'RARC' : 'CARC'),
            amount,
            ref?.category ?? null,
            ref?.is_miss_candidate ?? null,
            INGESTED_BY,
          ])
          stats.upserted_adjs++
        }
      }
    }

    await client.query('COMMIT')
    return stats

  } catch (err) {
    if (client) await client.query('ROLLBACK')
    console.error('Ingest failed — rolled back:', err instanceof Error ? err.message : 'unknown')
    throw err
  } finally {
    client?.release()
    await pool.end()
  }
}

function parseInt2(s: string | undefined): number | null {
  if (!s?.trim()) return null
  const n = parseInt(s.trim(), 10)
  return isNaN(n) ? null : n
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [,, csvPath, reportDate, ...flags] = process.argv
if (!csvPath || !reportDate) {
  console.error('Usage: ts-node 002_cmd_etl_ingest.ts <report.csv> <YYYY-MM-DD> [--dry-run]')
  console.error('')
  console.error('Examples:')
  console.error('  ts-node 002_cmd_etl_ingest.ts BATCH_DUMP_ALL_TIME.csv 2026-06-20 --dry-run')
  console.error('  ts-node 002_cmd_etl_ingest.ts BATCH_TEST_7.csv 2026-06-14')
  process.exit(1)
}

ingest({ csvPath, sourceReportDate: reportDate, dryRun: flags.includes('--dry-run') })
  .then(stats => {
    if (!flags.includes('--dry-run')) {
      console.log('\nIngest complete:')
      console.log(`  payer upserts:   ${stats.upserted_payers.toLocaleString()}`)
      console.log(`  claim upserts:   ${stats.upserted_claims.toLocaleString()}`)
      console.log(`  adjustment rows: ${stats.upserted_adjs.toLocaleString()}`)
      console.log(`  reversals kept:  ${stats.reversals}`)
      console.log(`  lag capped:      ${stats.lag_capped} (>${LAG_CAP_DAYS}d set null)`)
    }
  })
  .catch(() => process.exit(1))
