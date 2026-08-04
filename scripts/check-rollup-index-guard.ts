/**
 * Guard: a migration that REBUILDS collections.cmd_explorer_charge_rollup must not silently
 * drop the four trigram GIN search indexes (0081).
 *
 * Why this exists: the free-text explorer search is only fast because of
 * cmd_charge_rollup_{facility,payer,cpt,revenue}_trgm on that matview (measured 2026-08-04:
 * 1,326ms Parallel Seq Scan → 5.1ms BitmapOr). Indexes on a matview die with the matview, and
 * this repo has already shipped that exact bug once: 0067 as first authored hand-enumerated
 * "0059's six indexes" and thereby dropped 0068's covering index AND 0069's MAINTAIN grant.
 * A regressed search is invisible in tests and in the UI — it just gets slow — so the
 * protection cannot be a doc note. It has to fail a gate.
 *
 * The rule (deliberately narrow — two escape hatches, both of them correct):
 *   A migration numbered ABOVE 0081 whose DDL TARGETS the rollup matview must EITHER
 *     (a) enumerate live indexes from `pg_indexes` and replay them (the rewritten-0067
 *         carry-forward pattern, which picks up the trgm indexes and any future index
 *         automatically — this is the pattern to copy), OR
 *     (b) name all four *_trgm indexes explicitly (an intentional hand-written rebuild).
 *   Anything else is a failure naming the file and what is missing.
 *
 * Grandfathering is by migration number, not an allowlist: 0050/0059/0067 predate the trgm
 * indexes, so they cannot be expected to mention them and are exempt by construction. There is
 * no list to keep in sync.
 *
 * TARGET-anchored, not mention-anchored: 0080 CREATEs a different matview
 * (cmd_explorer_filter_options) while SELECTing from the rollup. Matching any mention of the
 * rollup name would flag it forever; the regex therefore requires the rollup to be the object
 * of the create/drop, and tolerates the `_next` / `_old` swap suffixes 0067 uses.
 *
 * Run standalone:  npx tsx scripts/check-rollup-index-guard.ts
 * Runs in root `npm test` via test/rollupIndexGuard.test.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

/**
 * Highest migration number that predates the 0081 trigram indexes. Files at or below this are
 * exempt (they could not have mentioned indexes that did not exist yet). Raising this number
 * would silently widen the exemption — don't.
 */
export const TRGM_INDEXES_LANDED_AT = 81;

/** The four indexes 0081 created on the rollup. A rebuild must carry ALL of them forward. */
export const REQUIRED_TRGM_INDEXES = [
  'cmd_charge_rollup_facility_trgm',
  'cmd_charge_rollup_payer_trgm',
  'cmd_charge_rollup_cpt_trgm',
  'cmd_charge_rollup_revenue_trgm',
] as const;

/**
 * CREATE/DROP MATERIALIZED VIEW whose TARGET is the rollup (optionally schema-qualified, with
 * the IF [NOT] EXISTS forms, and allowing 0067's `_next`/`_old` swap suffixes). The trailing
 * boundary is `\b` so `cmd_explorer_charge_rollup_next` matches but
 * `cmd_explorer_charge_rollupsomething` does not silently pass as the rollup.
 */
const ROLLUP_DDL =
  /\b(?:create|drop)\s+materialized\s+view\s+(?:if\s+not\s+exists\s+|if\s+exists\s+)?(?:collections\.)?cmd_explorer_charge_rollup(?:_next|_old)?\b/;

/** The carry-forward pattern: enumerate the live index set instead of hand-listing it. */
const PG_INDEXES_ENUMERATION = /\bpg_indexes\b/;

/** A leading 4-digit-ish migration number, e.g. `0082_foo.sql` → 82. */
const LEADING_NUMBER = /^(\d+)/;

export type GuardFailure = {
  /** Migration filename (not a full path) — what the engineer has to open. */
  file: string;
  /** Migration number parsed from the filename prefix. */
  number: number;
  /** Which required index names are absent (empty when the file is missing the pattern wholesale). */
  missing: string[];
  /** Human-readable reason, safe to print in a test failure message. */
  reason: string;
};

/** Strip `-- line comments` so a commented-out DDL example never trips the guard. */
export function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Migration number from a `00NN_name.sql` filename; null when the name has no numeric prefix. */
export function migrationNumber(file: string): number | null {
  const matched = file.match(LEADING_NUMBER);
  const digits = matched?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}

/** Does this SQL contain DDL that creates or drops the rollup matview itself? */
export function rebuildsRollup(sql: string): boolean {
  return ROLLUP_DDL.test(stripLineComments(sql).toLowerCase());
}

/**
 * Check ONE migration's SQL. Returns null when the file is fine (or out of scope), or a
 * failure describing what a rebuild is missing. `file` is used for the number + the message.
 */
export function checkMigrationSql(file: string, sql: string): GuardFailure | null {
  const number = migrationNumber(file);
  if (number === null || number <= TRGM_INDEXES_LANDED_AT) return null;
  if (!rebuildsRollup(sql)) return null;

  const body = stripLineComments(sql).toLowerCase();
  // Escape hatch (a): the carry-forward pattern picks up every live index automatically.
  if (PG_INDEXES_ENUMERATION.test(body)) return null;

  // Escape hatch (b): an explicit hand-written rebuild that names all four.
  const missing = REQUIRED_TRGM_INDEXES.filter((idx) => !body.includes(idx));
  if (missing.length === 0) return null;

  return {
    file,
    number,
    missing: [...missing],
    reason:
      `${file} rebuilds collections.cmd_explorer_charge_rollup but neither enumerates live ` +
      `indexes from pg_indexes (the rewritten-0067 carry-forward pattern) nor names the 0081 ` +
      `trigram index(es): ${missing.join(', ')}. Indexes die with the matview — carry them ` +
      `forward or the explorer free-text search silently reverts to a seq scan.`,
  };
}

/** Read the migrations directory and check every `.sql` file. Empty array = clean. */
export function checkRollupIndexGuard(dir: string = MIGRATIONS_DIR): GuardFailure[] {
  const failures: GuardFailure[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const failure = checkMigrationSql(file, readFileSync(join(dir, file), 'utf8'));
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

// Standalone CLI: print failures and exit non-zero so it can gate outside `npm test` too.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const failures = checkRollupIndexGuard();
  if (failures.length === 0) {
    console.log('rollup index guard: OK — no unguarded rollup rebuild found');
  } else {
    for (const failure of failures) console.error(`FAIL ${failure.reason}`);
    process.exitCode = 1;
  }
}
