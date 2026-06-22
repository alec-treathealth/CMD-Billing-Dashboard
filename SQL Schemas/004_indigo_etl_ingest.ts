/**
 * Indigo Claims CSV → staging.claim_line ETL
 * Artifact #4 — gate-review before applying.
 *
 * Source: Indigo_Claims_Past_Year.csv (and future year equivalents)
 * Format: episode-grain (one row per charge episode, payments summed)
 *         10 columns, no Charge/Debit ID or Credit ID
 *
 * Column mapping:
 *   Patient Full Name          → patient_name_enc (encrypted)
 *   Charge From Date           → charge_from_date
 *   DOS to Received Age        → dos_received_age_bucket (new text col)
 *   Charge CPT Code            → cpt_code
 *   Charge Rev Code            → rev_code
 *   Charge Amount              → charge_amount
 *   Payment Total Paid (Sum)   → charge_primary_paid
 *   Payment Allowed Amount(Sum)→ allowed_amount  ← the key column
 *   Charge Balance Due Pat(Max)→ charge_balance_due_pat
 *   Primary Payer Member ID    → member_id_enc (encrypted)
 *
 * Dedup strategy:
 *   No natural surrogate key. Indigo rows are episode-grain summaries.
 *   12 reversal rows (paid < 0) are excluded — they're already netted
 *   into the positive rows by CMD's SUM aggregation.
 *   Synthetic charge_debit_id: hash(date + CPT + rev + member_id_enc_hex + amount)
 *   credit_id: NULL (no payment-event grain; source_type = INDIGO_CLAIMS)
 *   UNIQUE constraint on (business_entity_id, charge_debit_id, credit_id)
 *   handles re-ingests safely via ON CONFLICT DO UPDATE.
 *
 * Compliance:
 *   Patient Full Name → encrypted bytea before any DB write
 *   Primary Payer Member ID → encrypted bytea
 *   Neither ever logged, never used as features or embeddings
 *   source_type = 'INDIGO_CLAIMS' on all rows
 */

import { createReadStream } from 'fs'
import { parse } from 'csv-parse'
import { Pool, PoolClient } from 'pg'
import * as sodium from 'libsodium-wrappers'
import { createHash } from 'crypto'
import path from 'path'

// ---------------------------------------------------------------------------
// Config — all from env
// ---------------------------------------------------------------------------
const DB_URL             = process.env.DATABASE_URL
const LIBSODIUM_KEY_HEX  = process.env.LIBSODIUM_KEY
const BUSINESS_ENTITY_ID = process.env.CMD_BUSINESS_ENTITY_ID
const INGESTED_BY        = process.env.INGEST_USER ?? 'indigo_etl'

if (!DB_URL || !LIBSODIUM_KEY_HEX || !BUSINESS_ENTITY_ID) {
  console.error('Missing required env: DATABASE_URL, LIBSODIUM_KEY, CMD_BUSINESS_ENTITY_ID')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Helpers (identical to 002_cmd_etl_ingest.ts — extract to shared lib later)
// ---------------------------------------------------------------------------
function parseMoney(s: string | undefined): number | null {
  if (!s?.trim()) return null
  const cleaned = s.trim()
    .replace(/\$/g, '').replace(/,/g, '')
    .replace(/\((.+)\)/, '-$1')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function parseDate(s: string | undefined): string | null {
  if (!s?.trim()) return null
  const [m, d, y] = s.trim().split('/')
  if (!m || !d || !y) return null
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

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
// Synthetic charge_debit_id for Indigo rows
// Deterministic: re-ingesting the same file produces the same IDs.
// Input: raw strings before encryption — hash is not PHI-sensitive since
//        it's a one-way digest, but we still avoid logging it.
// ---------------------------------------------------------------------------
function syntheticChargeId(
  date: string,
  cpt: string,
  rev: string,
  memberId: string,
  amount: string
): string {
  const payload = [date, cpt, rev, memberId, amount].join('|')
  return 'IND-' + createHash('sha256').update(payload).digest('hex').slice(0, 20)
}

// ---------------------------------------------------------------------------
// Main ingest
// ---------------------------------------------------------------------------
interface IngestOptions {
  csvPath: string
  sourceReportDate: string  // YYYY-MM-DD — use end of reporting period
  dryRun?: boolean
}

async function ingest(opts: IngestOptions): Promise<void> {
  const { csvPath, sourceReportDate, dryRun = false } = opts
  const sourceFileName = path.basename(csvPath)

  await sodium.ready
  const pool = new Pool({ connectionString: DB_URL })
  let client: PoolClient | null = null

  try {
    client = await pool.connect()
    await client.query(
      `SELECT set_config('app.business_entity_id', $1, true)`,
      [BUSINESS_ENTITY_ID]
    )

    // Parse CSV
    const records: Record<string, string>[] = []
    await new Promise<void>((resolve, reject) => {
      createReadStream(csvPath)
        .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
        .on('data', (row: Record<string, string>) => records.push(row))
        .on('end', resolve)
        .on('error', reject)
    })
    console.log(`Parsed ${records.length} rows from ${sourceFileName}`)

    // Exclude reversal rows (Payment Total Paid < 0)
    // These are already netted into the positive rows by CMD's SUM — including
    // them would double-count the reversal against the adjusted positive row.
    const reversals = records.filter(r => (parseMoney(r['Payment Total Paid (Sum)']) ?? 0) < 0)
    const usable    = records.filter(r => (parseMoney(r['Payment Total Paid (Sum)']) ?? 0) >= 0)
    console.log(`Excluded ${reversals.length} reversal rows (paid < 0). Processing ${usable.length}.`)

    if (dryRun) {
      // Dry run: show money summary without writing
      const totalBilled   = usable.reduce((s, r) => s + (parseMoney(r['Charge Amount']) ?? 0), 0)
      const totalPaid     = usable.reduce((s, r) => s + (parseMoney(r['Payment Total Paid (Sum)']) ?? 0), 0)
      const totalAllowed  = usable.reduce((s, r) => s + (parseMoney(r['Payment Allowed Amount (Sum)']) ?? 0), 0)
      const gapRows       = usable.filter(r =>
        (parseMoney(r['Payment Allowed Amount (Sum)']) ?? 0) >
        (parseMoney(r['Payment Total Paid (Sum)']) ?? 0) + 0.01
      )
      const totalGap = gapRows.reduce((s, r) =>
        s + (parseMoney(r['Payment Allowed Amount (Sum)']) ?? 0)
          - (parseMoney(r['Payment Total Paid (Sum)']) ?? 0), 0)
      console.log(`DRY RUN — would insert ${usable.length} rows`)
      console.log(`  Billed:  $${totalBilled.toLocaleString()}`)
      console.log(`  Allowed: $${totalAllowed.toLocaleString()}`)
      console.log(`  Paid:    $${totalPaid.toLocaleString()}`)
      console.log(`  Gap (allowed>paid): $${totalGap.toLocaleString()} across ${gapRows.length} rows`)
      console.log('Remove --dry-run to apply.')
      return
    }

    let upserted = 0, skipped = 0

    await client.query('BEGIN')

    for (const row of usable) {

      const dateRaw    = row['Charge From Date']?.trim() ?? ''
      const cptRaw     = row['Charge CPT Code']?.trim()  ?? ''
      const revRaw     = row['Charge Rev Code']?.trim()  ?? ''
      const memberRaw  = row['Primary Payer Member ID']?.trim() ?? ''
      const amountRaw  = row['Charge Amount']?.trim() ?? ''

      // Synthetic dedup key — deterministic on raw values before encryption
      const chargeDebitId = syntheticChargeId(dateRaw, cptRaw, revRaw, memberRaw, amountRaw)

      // Encrypt PHI
      const [patientNameEnc, memberIdEnc] = await Promise.all([
        encryptPhi(row['Patient Full Name']),
        encryptPhi(memberRaw),
      ])

      const allowedAmount = parseMoney(row['Payment Allowed Amount (Sum)'])
      const paidAmount    = parseMoney(row['Payment Total Paid (Sum)'])

      // Skip rows where both allowed and paid are zero — no financial content
      if (!allowedAmount && !paidAmount && !parseMoney(amountRaw)) {
        skipped++
        continue
      }

      await client.query(`
        INSERT INTO staging.claim_line (
          business_entity_id,
          charge_debit_id,
          credit_id,
          claim_id,
          patient_name_enc,
          member_id_enc,
          charge_from_date,
          cpt_code,
          rev_code,
          charge_amount,
          charge_primary_paid,
          allowed_amount,
          charge_balance_due_pat,
          claim_status,
          source_type,
          source_report_date,
          source_file_name,
          ingested_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18
        )
        ON CONFLICT (business_entity_id, charge_debit_id, credit_id) DO UPDATE SET
          charge_primary_paid   = EXCLUDED.charge_primary_paid,
          allowed_amount        = EXCLUDED.allowed_amount,
          charge_balance_due_pat = EXCLUDED.charge_balance_due_pat
      `, [
        BUSINESS_ENTITY_ID,
        chargeDebitId,
        null,                                          // credit_id: null for Indigo (episode grain)
        null,                                          // claim_id: not available in Indigo
        patientNameEnc,
        memberIdEnc,
        parseDate(dateRaw),
        cptRaw   || null,
        revRaw   || null,
        parseMoney(amountRaw),
        paidAmount,
        allowedAmount,
        parseMoney(row['Charge Balance Due Pat (Max)']),
        // Derive a readable status from allowed vs paid
        allowedAmount && paidAmount !== null
          ? (allowedAmount > paidAmount + 0.01 ? 'UNDERPAID' : 'PAID')
          : 'UNKNOWN',
        'INDIGO_CLAIMS',
        sourceReportDate,
        sourceFileName,
        INGESTED_BY,
      ])
      upserted++
    }

    await client.query('COMMIT')
    console.log(`Indigo ingest complete: ${upserted} upserted, ${skipped} skipped (zero-value)`)

  } catch (err) {
    if (client) await client.query('ROLLBACK')
    // Never log row data — may contain PHI path via error context
    console.error('Indigo ingest failed — rolled back:', err instanceof Error ? err.message : 'unknown error')
    throw err
  } finally {
    client?.release()
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [,, csvPath, reportDate, ...flags] = process.argv
if (!csvPath || !reportDate) {
  console.error('Usage: ts-node 004_indigo_etl_ingest.ts <path/to/Indigo_Claims.csv> <YYYY-MM-DD> [--dry-run]')
  console.error('  reportDate: use end of the reporting period, e.g. 2025-12-31 for 2025 annual')
  process.exit(1)
}

ingest({
  csvPath,
  sourceReportDate: reportDate,
  dryRun: flags.includes('--dry-run'),
}).catch(() => process.exit(1))
