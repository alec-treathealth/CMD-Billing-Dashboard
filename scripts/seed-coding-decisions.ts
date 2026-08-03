/**
 * ONE-TIME reviewed seed for coding.code_decision (Phase A, qualify-v2-build-plan §4).
 *
 *   npx tsx scripts/seed-coding-decisions.ts <matrix.tsv> [--apply] [--actor you@treathealth.ai]
 *
 * DRY-RUN BY DEFAULT: parses, validates, and prints the defect report + a per-family summary.
 * Nothing touches the database without --apply. With --apply it connects as `coding_editor`
 * (CODING_WRITER_DB_URL — never claims_admin, never the service key), wraps ALL inserts in one
 * transaction (a half-seeded registry is worse than none), and writes one 'create' audit row per
 * decision. Re-running --apply on a non-empty table ABORTS unless --append is given: the seed is
 * one-time; the app owns edits afterward and the sheet becomes the historical record. There is no
 * Sheets sync here on purpose — a two-way sync recreates the drift this registry exists to end.
 *
 * The TSV comes from pasting the sheet (both matrix tabs reconciled by a human first — the two
 * copies have drifted in seven places; the DB must start from the RESOLVED truth, not one tab's).
 * Template: scripts/seed/coding-decisions.template.tsv. Facility long-forms are mapped via
 * FACILITY_ALIASES below — extend it as defects name unmapped forms.
 *
 * NO PHI anywhere in this path: payers, facilities, codes, dates, prose rules only.
 */
import { readFileSync } from 'node:fs';
import { parseCodingSeedTsv } from '../src/collections/codingSeedParser.js';
import {
  buildInsertCodingDecisionQuery,
  buildInsertCodingAuditQuery,
  CODING_DECISION_TABLE,
} from '../src/collections/codingRegistryQuery.js';
import { makeClient } from '../src/collections/db.js';

/** Sheet long-form → collections.facilities.facility_code. Extend as the defect report names forms. */
// Verified against collections.facilities on 2026-08-03: the roster keys THESE facilities by
// mnemonic (KWC/LSMH/DMH/TBH/CAMH/PCMH/TREAT_*), and Nashville is 'NASH' — NOT the sheet's 'NMH'.
// An unmapped mnemonic that happens to match /^[A-Z0-9_]{2,40}$/ would silently seed a code the
// rating lookup can never match, so every block token is mapped EXPLICITLY.
const FACILITY_ALIASES: Record<string, string> = {
  KWC: 'KWC',
  LSMH: 'LSMH',
  DMH: 'DMH',
  NMH: 'NASH', // the one true rename — sheet says NMH, roster says NASH
  TBH: 'TBH',
  CAMH: 'CAMH',
  PCMH: 'PCMH',
  'TREAT CA': 'TREAT_CA',
  'TREAT TX': 'TREAT_TX',
  'TREAT TN': 'TREAT_TN',
  'TREAT NV': 'TREAT_NV',
  'TREAT WA': 'TREAT_WA',
  'TELEHEALTH TX': 'TELEHEALTH_MH',
  'KY WELLNESS': 'KWC',
  'NASHVILLE MH': 'NASH',
  'TRAT TX': 'TREAT_TX', // the sheet's own typo, mapped on purpose so the row seeds facility-scoped
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const append = args.includes('--append');
  const actorIx = args.indexOf('--actor');
  const actor = actorIx >= 0 ? args[actorIx + 1] ?? '' : 'seed-script';
  if (!file) {
    console.error('usage: npx tsx scripts/seed-coding-decisions.ts <matrix.tsv> [--apply] [--append] [--actor email]');
    process.exit(2);
  }

  const tsv = readFileSync(file, 'utf8');
  const { decisions, defects, skipped } = parseCodingSeedTsv(tsv, FACILITY_ALIASES);

  // ── report (always) ──
  console.log(`parsed: ${decisions.length} decision(s) · ${defects.length} defect(s) · ${skipped} row(s) skipped`);
  const byFamily = new Map<string, number>();
  for (const d of decisions) byFamily.set(d.payer_family, (byFamily.get(d.payer_family) ?? 0) + 1);
  for (const [fam, n] of [...byFamily.entries()].sort()) console.log(`  ${fam.padEnd(16)} ${n}`);
  if (defects.length > 0) {
    console.log('\ndefects (fix in the TSV, or extend FACILITY_ALIASES, then re-run):');
    for (const d of defects) console.log(`  line ${d.line} · ${d.field} · "${d.value}" — ${d.reason}`);
  }
  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to seed.');
    return;
  }
  if (decisions.length === 0) {
    console.error('nothing to apply.');
    process.exit(1);
  }

  const url = process.env.CODING_WRITER_DB_URL;
  if (!url) {
    console.error('Missing CODING_WRITER_DB_URL (the coding_editor connection; set in env, never hardcode or log it).');
    process.exit(1);
  }
  const pool = makeClient(url);
  const client = await pool.connect();
  try {
    const existing = await client.query(`select count(*)::int as n from ${CODING_DECISION_TABLE}`);
    const n = (existing.rows[0] as { n: number }).n;
    if (n > 0 && !append) {
      console.error(`coding.code_decision already holds ${n} row(s) — the seed is one-time. Use --append only if you know why.`);
      process.exit(1);
    }
    await client.query('begin');
    let inserted = 0;
    for (const d of decisions) {
      const ins = buildInsertCodingDecisionQuery({ ...d, created_by: actor });
      const res = await client.query(ins.sql, ins.params);
      const id = (res.rows[0] as { id: number }).id;
      const aud = buildInsertCodingAuditQuery({
        decision_id: id,
        actor_email: actor,
        action: 'create',
        before: null,
        after: d,
      });
      await client.query(aud.sql, aud.params);
      inserted++;
    }
    await client.query('commit');
    console.log(`applied: ${inserted} decision(s) seeded, each with a create audit row.`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('seed failed — rolled back. Nothing was written.');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
