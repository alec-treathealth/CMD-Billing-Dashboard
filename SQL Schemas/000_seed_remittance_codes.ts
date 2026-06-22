/**
 * ref.remittance_code seed script
 * Artifact #0 — run FIRST, before any claim ingest.
 *
 * Source: Sheet_2-Table_1.csv (CMD codebook export — 98 CARC/RARC codes)
 * Target: ref.remittance_code
 *
 * What this does:
 *   1. Parses the codebook CSV (title row + header row + 98 data rows)
 *   2. Assigns category, is_miss_candidate, needs_human_review per code
 *      using deterministic rules grounded in X12 semantics
 *   3. Upserts all 98 rows — safe to re-run
 *   4. Prints a summary for review before you run claim ingest
 *
 * Categorization rules (review output before running ingest):
 *   CONTRACTUAL_EXPECTED   — legitimate write-offs (45, 97, 131, 23, etc.)
 *   PATIENT_RESPONSIBILITY — deductible/coins/copay transfers (1, 2, 3)
 *   DENIAL_OR_MISS         — recoverable denials (147, 197, 29, 50, 109, etc.)
 *   NEEDS_INFO             — recoverable with correct attachment (16, 226, 227, etc.)
 *   INFO_ACTIONABLE        — RARC remarks describing what's missing (M50, M77, etc.)
 *   INFO                   — Informational RARCs only
 *   OTHER_REVIEW           — ambiguous; needs human sign-off before driving decisions
 *
 * Codes flagged needs_human_review (ambiguous — review before trusting gap miner):
 *   22  — COB: could be correct OON behavior or a recoverable underpayment
 *   131 — negotiated discount: contractual usually, but verify for OON contracts
 *   18  — duplicate claim: true dup OR payer wrongly calling resubmission a dup
 *   242 — non-network provider: expected for OON but appealable in some contracts
 *   279 — non-preferred network: same as 242
 *   B13 — previously paid: true prior payment OR erroneous duplicate denial
 *
 * No PHI involved. No libsodium needed. Simple parameterized upsert.
 */

import { createReadStream } from 'fs'
import { parse } from 'csv-parse'
import { Pool } from 'pg'
import path from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DB_URL      = process.env.DATABASE_URL
const INGESTED_BY = process.env.INGEST_USER ?? 'seed_script'

if (!DB_URL) {
  console.error('Missing required env: DATABASE_URL')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Categorization rules
// Deterministic, code-first. Description keywords are a fallback only.
// Edit these sets here and re-run to update categories — don't edit the DB directly.
// ---------------------------------------------------------------------------

// CARC sets — codes where category is unambiguous
const PATIENT_RESPONSIBILITY = new Set(['1', '2', '3', '66', '100'])  // 100 = payment made to patient/insured directly

const CONTRACTUAL_EXPECTED = new Set([
  '45',   // charge exceeds fee schedule (with CO/PR group)
  '97',   // bundled per NCCI
  '23',   // prior payer COB impact
  '59',   // not billed separately per guidelines
  '94',   // processed in excess of charges
  '131',  // claim-specific negotiated discount — ⚠ needs_human_review (OON ambiguous)
  '144',  // incentive adjustment
  '193',  // original payment maintained on review
])

const DENIAL_OR_MISS = new Set([
  '109',  // wrong payer
  '119',  // benefit maximum reached
  '147',  // rate expired/not on file ← #1 code in your data, $240K
  '197',  // authorization absent ← denial 197/288/243 your codebook flagged
  '200',  // coverage lapse
  '204',  // not covered under current benefit plan
  '22',   // COB — ⚠ needs_human_review
  '242',  // non-network provider — ⚠ needs_human_review
  '243',  // services not authorized
  '279',  // non-preferred network — ⚠ needs_human_review
  '288',  // referral absent
  '29',   // timely filing expired
  '27',   // coverage terminated
  '50',   // not deemed medically necessary
  '96',   // non-covered charge
  'A1',   // claim/service denied
  'B11',  // transferred to correct payer
  'B12',  // service not documented
  '31',   // patient cannot be identified
  '35',   // lifetime benefit maximum
  '44',   // prompt-pay discount
  '78',   // non-covered charge adjustment
])

const NEEDS_INFO = new Set([
  '16',   // lacks information / submission error (+ remark required)
  '129',  // prior processing info incorrect
  '133',  // pending further review
  '135',  // interim bills cannot be processed
  '226',  // missing information from billing provider
  '227',  // missing information from patient/insured
  '250',  // incorrect attachment/document received
  '251',  // attachment incomplete/deficient
  '252',  // attachment required to adjudicate
])

// Codes where category depends on context — flag for human review
// Gap miner will still surface these but marks them requires_review=true
const NEEDS_HUMAN_REVIEW = new Set([
  '22',   // COB: correct OON behavior OR recoverable underpayment
  '131',  // negotiated discount: contractual usually, but verify OON contracts
  '18',   // duplicate: true dup OR payer wrongly denying resubmission
  '242',  // non-network: expected OON OR appealable
  '279',  // non-preferred network: same as 242
  'B13',  // previously paid: true prior pay OR erroneous duplicate denial
])

// ---------------------------------------------------------------------------
// Determine CARC type from code pattern
// RARC codes: start with M, N, or are known alpha codes (MA*, N*)
// CARC codes: numeric or A1, B11, B12, B13
// ---------------------------------------------------------------------------
function inferCodeType(code: string): 'CARC' | 'RARC' {
  if (/^[MN]/i.test(code) || /^MA/i.test(code)) return 'RARC'
  return 'CARC'
}

function categorize(code: string, cmdType: string, desc: string): {
  category: string
  isMissCandidate: boolean
  needsHumanReview: boolean
} {
  const d = desc.toLowerCase()
  const isRarc = cmdType === 'Remark'

  if (isRarc) {
    // RARC: informational only — categorize by whether they name a fixable problem
    const actionable = /missing|incomplete|invalid|not provided|mismatch|duplicate|no appeal|crossover|not on file|unable to|update|report|provide/i.test(desc)
    return {
      category: actionable ? 'INFO_ACTIONABLE' : 'INFO',
      isMissCandidate: false,
      needsHumanReview: false,
    }
  }

  // CARC: code-first, description fallback
  if (PATIENT_RESPONSIBILITY.has(code)) {
    return { category: 'PATIENT_RESPONSIBILITY', isMissCandidate: false, needsHumanReview: false }
  }
  if (CONTRACTUAL_EXPECTED.has(code)) {
    return { category: 'CONTRACTUAL_EXPECTED', isMissCandidate: false, needsHumanReview: NEEDS_HUMAN_REVIEW.has(code) }
  }
  if (DENIAL_OR_MISS.has(code)) {
    return { category: 'DENIAL_OR_MISS', isMissCandidate: true, needsHumanReview: NEEDS_HUMAN_REVIEW.has(code) }
  }
  if (NEEDS_INFO.has(code)) {
    return { category: 'NEEDS_INFO', isMissCandidate: true, needsHumanReview: false }
  }

  // Description keyword fallback for codes not in explicit sets
  if (/not covered|denied|authorization|timely|filing|lapse|terminat|benefit maximum|not identified|non-covered|referral|not on file/i.test(desc)) {
    return { category: 'DENIAL_OR_MISS', isMissCandidate: true, needsHumanReview: false }
  }
  if (/information|attachment|documentation|remark|pending|incorrect|lacks|submission|missing|incomplete/i.test(desc)) {
    return { category: 'NEEDS_INFO', isMissCandidate: true, needsHumanReview: false }
  }

  return { category: 'OTHER_REVIEW', isMissCandidate: false, needsHumanReview: true }
}

// ---------------------------------------------------------------------------
// Parse the codebook CSV
// Row 0: 'Table 1' title — skip
// Row 1: 'Code','Type','Description',... — header — skip
// Row 2+: data
// ---------------------------------------------------------------------------
interface CodebookRow {
  code: string
  cmdType: string    // 'Adj. Reason' | 'Remark'
  description: string
}

async function parseCodebook(csvPath: string): Promise<CodebookRow[]> {
  const results: CodebookRow[] = []
  let rowIndex = 0

  await new Promise<void>((resolve, reject) => {
    createReadStream(csvPath)
      .pipe(parse({ trim: true, skip_empty_lines: true, relax_column_count: true }))
      .on('data', (row: string[]) => {
        rowIndex++
        if (rowIndex <= 2) return  // skip title + header
        const code = row[0]?.trim()
        const typ  = row[1]?.trim()
        const desc = row[2]?.trim()
        if (code && typ && desc) results.push({ code, cmdType: typ, description: desc })
      })
      .on('end', resolve)
      .on('error', reject)
  })

  return results
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function seed(csvPath: string, dryRun = false): Promise<void> {
  const rows = await parseCodebook(csvPath)
  console.log(`Parsed ${rows.length} codes from ${path.basename(csvPath)}`)

  // Build annotated rows
  const annotated = rows.map(r => ({
    ...r,
    codeType: inferCodeType(r.code),
    ...categorize(r.code, r.cmdType, r.description),
  }))

  // Print category summary for review
  const byCat: Record<string, number> = {}
  const missCandidates: typeof annotated = []
  const needsReview: typeof annotated = []

  for (const r of annotated) {
    byCat[r.category] = (byCat[r.category] ?? 0) + 1
    if (r.isMissCandidate) missCandidates.push(r)
    if (r.needsHumanReview) needsReview.push(r)
  }

  console.log('\nCategory distribution:')
  for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    const missFlag = ['DENIAL_OR_MISS','NEEDS_INFO'].includes(cat) ? ' ← gap miner targets' : ''
    console.log(`  ${n.toString().padStart(3)}  ${cat}${missFlag}`)
  }

  console.log(`\nMiss candidates (is_miss_candidate=true): ${missCandidates.length}`)
  console.log(`Needs human review: ${needsReview.length}`)
  console.log('\nCodes flagged needs_human_review (review before trusting gap miner):')
  for (const r of needsReview) {
    console.log(`  ${r.code.padEnd(6)} [${r.category}] ${r.description.slice(0, 70)}`)
  }

  if (dryRun) {
    console.log('\nDRY RUN — no writes. Remove --dry-run to apply.')
    return
  }

  const pool = new Pool({ connectionString: DB_URL })
  let upserted = 0

  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      for (const r of annotated) {
        await client.query(`
          INSERT INTO ref.remittance_code (
            code, code_type, description,
            category, is_miss_candidate, needs_human_review,
            is_inactive, ingested_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (code, code_type) DO UPDATE SET
            description         = EXCLUDED.description,
            category            = EXCLUDED.category,
            is_miss_candidate   = EXCLUDED.is_miss_candidate,
            needs_human_review  = EXCLUDED.needs_human_review
        `, [
          r.code,
          r.codeType,
          r.description,
          r.category,
          r.isMissCandidate,
          r.needsHumanReview,
          false,          // is_inactive: none in your export are marked inactive
          INGESTED_BY,
        ])
        upserted++
      }

      await client.query('COMMIT')
      console.log(`\nSeeded ${upserted} rows into ref.remittance_code`)
      console.log('Run 002_cmd_etl_ingest.ts and 004_indigo_etl_ingest.ts next.')
    } catch (err) {
      await client.query('ROLLBACK')
      console.error('Seed failed — rolled back:', err instanceof Error ? err.message : err)
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [,, csvPath, ...flags] = process.argv
if (!csvPath) {
  console.error('Usage: ts-node 000_seed_remittance_codes.ts <path/to/Sheet_2-Table_1.csv> [--dry-run]')
  process.exit(1)
}

seed(csvPath, flags.includes('--dry-run')).catch(() => process.exit(1))
