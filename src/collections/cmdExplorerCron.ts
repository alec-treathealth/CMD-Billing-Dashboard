/**
 * CMD Collections Explorer CRON — live CMD batch report → collections.cmd_explorer_rows.
 *
 * WHY: keeps the DB-backed Collections Explorer current after the one-shot historical
 * seed (cmdExplorerSeed.ts). Invoked daily by Vercel Cron (app/api/cron/cmd-explorer)
 * via the server composition root, which injects the live-report fetch, the
 * least-privilege writer pool, and the cache-revalidate callback.
 *
 * Reuses the SEED's exact logic — mapReportRows + mapRow (normalize + fingerprint +
 * required-field validation) and insertRows (encrypt + batched ON CONFLICT DO NOTHING
 * upsert) — so a row pulled by the cron is byte-identical in shape and fingerprint to
 * the same row loaded from CSV. Overlapping pulls therefore dedup against existing rows;
 * only genuinely new content snapshots insert (full-history grain). source_file='cmd_api'.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): identifiers are encrypted in-process before insert
 * (insertRows → encryptPhi); the returned/logged summary is COUNTS ONLY — never a cell
 * value, never a skip "reason" carrying raw input. The live report body is never logged.
 *
 * LAYERING (§10): this module is transport-agnostic — no next/cache, no env reads, no
 * secrets. The composition root (app/lib/server.ts) injects fetchRows / writeDb /
 * revalidate, exactly as it does for refreshCmdPayerRollup. That keeps it unit-testable
 * and importable outside Next.
 */
import { mapReportRows } from './cmdExplorer.js';
import { insertRows, mapRow, type PlainRow } from './cmdExplorerSeed.js';
import type { CmdReportRow } from './cmdPayer.js';
import type { Db } from './db.js';

/** Marks rows that arrived via the live API (vs a seed CSV filename). */
const CRON_SOURCE = 'cmd_api';

export interface CmdExplorerCronDeps {
  /** Fetch the live CMD report rows — in prod: () => cmdReportRows(cmdExplorerConfig()). */
  fetchRows: () => Promise<CmdReportRow[]>;
  /** Least-privilege writer pool (cmd_rollup_writer), injected by the composition root. */
  writeDb: Db;
  /** Bust the explorer's non-PHI cache after a successful insert. In prod:
   *  () => revalidateTag('cmd-explorer'). Kept injected so this module stays Next-free. */
  revalidate?: () => void | Promise<void>;
}

/** Non-PHI summary of a cron run — safe to log and return to the (authed) caller. */
export interface CmdExplorerCronStats {
  /** Charge-line rows pulled from the live CMD report. */
  rows_fetched: number;
  /** Rows that passed required-field validation and mapped successfully. */
  mapped_valid: number;
  /** Rows skipped for a missing/invalid required field (counts only; no values). */
  skipped: number;
  /** Fingerprint duplicates within THIS pull (collapsed before insert). */
  in_set_duplicates: number;
  /** Distinct fingerprints attempted against the table. */
  distinct: number;
  /** New rows actually inserted (ON CONFLICT DO NOTHING skipped the rest). */
  inserted: number;
  /** distinct − inserted: fingerprints already present in the table. */
  duplicates_in_db: number;
}

/**
 * Pull the live CMD report, map + dedup + encrypt + upsert, and revalidate the cache
 * when anything new landed. Returns non-PHI stats only. Throws on fetch/DB failure so
 * the route fails closed to a generic 500.
 */
export async function cmdExplorerCron(deps: CmdExplorerCronDeps): Promise<CmdExplorerCronStats> {
  const reportRows = await deps.fetchRows();

  // De-dup by fingerprint within this pull (first wins) — same key the seed uses, so
  // these collapse against existing rows at the ON CONFLICT step too.
  const byFingerprint = new Map<string, PlainRow>();
  const skipsByLabel = new Map<string, number>();
  let mappedValid = 0;
  let inSetDuplicates = 0;
  for (const full of mapReportRows(reportRows)) {
    const result = mapRow(full, CRON_SOURCE);
    if (!result.ok) {
      skipsByLabel.set(result.label, (skipsByLabel.get(result.label) ?? 0) + 1);
      continue;
    }
    mappedValid += 1;
    if (byFingerprint.has(result.row.row_fingerprint)) inSetDuplicates += 1;
    else byFingerprint.set(result.row.row_fingerprint, result.row);
  }

  const distinct = [...byFingerprint.values()];
  const inserted = await insertRows(deps.writeDb, distinct);

  // Only bust the cache when something actually changed.
  if (inserted > 0 && deps.revalidate) await deps.revalidate();

  const stats: CmdExplorerCronStats = {
    rows_fetched: reportRows.length,
    mapped_valid: mappedValid,
    skipped: [...skipsByLabel.values()].reduce((a, b) => a + b, 0),
    in_set_duplicates: inSetDuplicates,
    distinct: distinct.length,
    inserted,
    duplicates_in_db: distinct.length - inserted,
  };

  // Summary — counts only, never a cell value or a skip "reason" string.
  console.log(
    `cmd-explorer cron: fetched ${stats.rows_fetched}, valid ${stats.mapped_valid}, ` +
      `skipped ${stats.skipped}, distinct ${stats.distinct}, inserted ${stats.inserted}, ` +
      `dup-in-db ${stats.duplicates_in_db}`,
  );
  for (const [label, n] of [...skipsByLabel.entries()].sort()) console.log(`  skip ${label}: ${n}`);

  return stats;
}
