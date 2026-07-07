/**
 * INDIGO Collections Explorer SEED ADAPTER — the gitignored Indigo 17-column CMD export CSV →
 * collections.cmd_explorer_rows, stamped INDIGO_ENTITY_ID.
 *
 *   node --env-file=.env --import tsx src/collections/indigoSeedAdapter.ts --file="<path>"                    # DRY-RUN (parse+map, NO DB)
 *   node --env-file=.env --import tsx src/collections/indigoSeedAdapter.ts --file="<path>" --limit=N --commit # NARROW load (first N)
 *   node --max-old-space-size=4096 --env-file=.env --import tsx src/collections/indigoSeedAdapter.ts --file="<path>" --commit  # FULL load
 *
 * REUSES the BXR seed's LOCKED computation VERBATIM — this adapter re-derives nothing:
 *   • mapRow (cmdExplorerSeed.ts): the 14-field row_fingerprint = SHA-256 over the normalized
 *     PLAINTEXT fields in the fixed order, computed BEFORE encryption.
 *   • insertRows (cmdExplorerSeed.ts): libsodium-encrypts the 3 PHI fields → bytea, then does the
 *     withTenant batched idempotent upsert (ON CONFLICT (row_fingerprint) DO NOTHING).
 *   • mapReportRows (cmdExplorer.ts): the shared CSV-header → field projection.
 *
 * It adds ONLY what is Indigo-specific:
 *   1. Indigo's 17-column export shape (the 14 explorer columns + Check/EFT/Charge Patient
 *      Payments — the latter three are NOT part of cmd_explorer_rows or the fingerprint).
 *   2. Indigo labels the facility column "Customer Name" (CMD: one customer == one facility),
 *      not "Facility Name". It is aliased onto "Facility Name" PER ROW so the SHARED mapping
 *      resolves it unchanged — cmdExplorer.ts is NOT edited, so the BXR path is untouched.
 *   3. INDIGO_ENTITY_ID stamped EXPLICITLY on every row (never the cmd_explorer_rows column
 *      DEFAULT, which is BXR) — insertRows takes the tenant id as an argument.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the source CSV is REAL Indigo patient PHI, gitignored, and
 * supplied by --file / INDIGO_SEED_FILE at RUNTIME — its path is NEVER hardcoded here. Logs carry
 * COUNTS + skip-labels + the basename only, never a cell value. The 3 PHI identifiers are encrypted
 * in-process (inside insertRows) before any DB write — no plaintext PHI touches the DB or the logs.
 * Writes as the least-privilege cmd_rollup_writer over verify-full TLS. DRY-RUN opens no DB
 * connection. The load itself is HARD-GATED upstream (LOAD NARROW GO / LOAD FULL GO).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseReportCsv, type CmdReportRow } from './cmdPayer.js';
import { mapReportRows } from './cmdExplorer.js';
import { mapRow, insertRows, type PlainRow } from './cmdExplorerSeed.js';
import { encryptPhi } from './phiCrypto.js';
import { makeClient } from './db.js';
import { INDIGO_ENTITY_ID } from '../tenants.js';

/**
 * The Indigo CMD export's 17 columns (report 10092391). Columns 1–13 match the BXR seed's
 * EXPECTED_HEADERS exactly; column 14 is "Customer Name" (the facility); columns 15–17 are the
 * three deposit/patient-payment extras that cmd_explorer_rows does not store. A header set that
 * does not match this EXACTLY aborts — we never partial-map an unknown PHI shape.
 */
export const EXPECTED_INDIGO_HEADERS = [
  'Charge From Date',
  'Payment Received',
  'Charge CPT Code',
  'Revenue Code',
  'Patient Full Name',
  'Claim Primary Member ID',
  'Primary Group Number',
  'Charge/Debit Amount',
  'Payment Allowed Amount',
  'Charge Insurance Payments',
  'Charge Total Adjustments w/o Transfers',
  'Charge Balance Due Pat',
  'Charge Primary Payer Name',
  'Customer Name',
  'Check Payment',
  'EFT Payment',
  'Charge Patient Payments',
] as const;

/** Set-equality diff of the parsed header vs the expected 17 (names only — never PHI). */
export function indigoHeaderDiff(actual: string[]): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const expected = new Set<string>(EXPECTED_INDIGO_HEADERS);
  return {
    missing: [...expected].filter((h) => !a.has(h)),
    extra: [...a].filter((h) => !expected.has(h)),
  };
}

export interface IndigoParseOutcome {
  distinct: PlainRow[];
  dataRows: number;
  mappedValid: number;
  skipsByLabel: Map<string, number>;
  inSetDuplicates: number;
}

/**
 * Parse → validate header → map → dedup the Indigo CSV into distinct PlainRows (fingerprinted,
 * PLAINTEXT PHI held only in memory; encryption happens later, in insertRows). When `limit` is
 * set, only the header + first `limit` DATA lines are parsed — so a narrow load never reads the
 * whole ~490k-row file. No DB, no encryption here.
 */
export function parseIndigoCsv(path: string, limit: number | null): IndigoParseOutcome {
  const raw = readFileSync(path, 'utf8');
  // Narrow load: slice to header + first `limit` data lines BEFORE parsing (memory-light; patient
  // rows carry no embedded newlines, so a line slice is exact for this data).
  const text = limit === null ? raw : raw.split(/\r?\n/).slice(0, limit + 1).join('\n');
  const rows = parseReportCsv(text);
  if (rows.length === 0) throw new Error('no data rows parsed from the Indigo seed CSV');

  const diff = indigoHeaderDiff(Object.keys(rows[0]!));
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    const parts: string[] = [];
    if (diff.missing.length) parts.push(`missing [${diff.missing.join(', ')}]`);
    if (diff.extra.length) parts.push(`extra [${diff.extra.join(', ')}]`);
    throw new Error(
      `Indigo seed header mismatch — ${parts.join('; ')} (refusing to partial-map an unknown PHI shape)`,
    );
  }

  const source = basename(path);
  const byFingerprint = new Map<string, PlainRow>();
  const skipsByLabel = new Map<string, number>();
  let mappedValid = 0;
  let inSetDuplicates = 0;

  for (const row of rows) {
    // Alias Indigo's facility label onto the one the shared mapping expects (in place — no second
    // 490k-row array). mapReportRows ignores the 3 extra deposit columns.
    if (!('Facility Name' in row)) row['Facility Name'] = row['Customer Name'] ?? '';
    const full = mapReportRows([row])[0]!;
    const result = mapRow(full, source); // LOCKED fingerprint + required-field validation (reused)
    if (!result.ok) {
      skipsByLabel.set(result.label, (skipsByLabel.get(result.label) ?? 0) + 1);
      continue;
    }
    mappedValid += 1;
    if (byFingerprint.has(result.row.row_fingerprint)) inSetDuplicates += 1;
    else byFingerprint.set(result.row.row_fingerprint, result.row);
  }

  return {
    distinct: [...byFingerprint.values()],
    dataRows: rows.length,
    mappedValid,
    skipsByLabel,
    inSetDuplicates,
  };
}

function parseArgs(argv: string[]): { commit: boolean; file?: string; limit: number | null } {
  let commit = false;
  let file: string | undefined;
  let limit: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === '--commit') commit = true;
    else if (arg.startsWith('--file=')) file = arg.slice('--file='.length);
    else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit must be a positive integer');
      limit = n;
    }
  }
  return { commit, file, limit };
}

async function main(): Promise<void> {
  const { commit, file: fileArg, limit } = parseArgs(process.argv);
  const file = (fileArg ?? process.env.INDIGO_SEED_FILE ?? '').trim();
  if (!file) {
    throw new Error('Indigo seed CSV path required: pass --file="<path>" or set INDIGO_SEED_FILE (never hardcoded here)');
  }
  const writerUrl = process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim();
  if (commit && !writerUrl) {
    throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL not set (required for --commit; never hardcode or log it)');
  }
  // Fail fast if the PHI key is misconfigured (both modes), before --commit reaches the DB.
  await encryptPhi('indigo-seed-key-probe');

  const mode = commit ? 'COMMIT' : 'DRY-RUN';
  const scope = limit === null ? 'FULL' : `NARROW (limit=${limit})`;
  console.log(`Indigo seed adapter — ${mode} — ${scope} — file: ${basename(file)} — tenant: INDIGO`);

  const out = parseIndigoCsv(file, limit);
  const totalSkipped = [...out.skipsByLabel.values()].reduce((a, b) => a + b, 0);
  console.log(`  data rows read: ${out.dataRows}; mapped valid: ${out.mappedValid}; skipped: ${totalSkipped}`);
  for (const [label, n] of [...out.skipsByLabel.entries()].sort()) console.log(`    - ${label}: ${n}`);
  console.log(`  in-set duplicates collapsed: ${out.inSetDuplicates}`);
  console.log(`  distinct fingerprints to insert: ${out.distinct.length}`);

  if (!commit) {
    console.log('DRY-RUN — no database connection made. Add --commit to load (only after LOAD NARROW GO / LOAD FULL GO).');
    return;
  }

  const db = makeClient(writerUrl!); // verify-full TLS (src/ssl.ts) via makeClient
  try {
    const inserted = await insertRows(db, out.distinct, INDIGO_ENTITY_ID); // EXPLICIT Indigo stamp
    console.log(
      `COMMIT — inserted ${inserted} (Indigo); already in DB (ON CONFLICT skipped): ${out.distinct.length - inserted}.`,
    );
  } finally {
    await db.end();
  }
}

// Only run the CLI when invoked directly (never when imported).
if (process.argv[1] && /indigoSeedAdapter\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    // Message only — never CSV contents / cell values (PHI).
    console.error('Indigo seed adapter failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
