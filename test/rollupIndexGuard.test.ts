import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REQUIRED_TRGM_INDEXES,
  TRGM_INDEXES_LANDED_AT,
  checkMigrationSql,
  checkRollupIndexGuard,
  migrationNumber,
  rebuildsRollup,
  stripLineComments,
} from '../scripts/check-rollup-index-guard.js';

// The point of this suite: the four 0081 trigram GIN indexes live ON the rollup matview, so ANY
// future migration that rebuilds that matview destroys them. A lost index does not fail a test
// or break the UI — the explorer search just silently goes back to a multi-second seq scan. So
// the guard has to catch the migration at authoring time. These tests prove it catches a bad
// rebuild (not merely that it passes on today's tree).

test('the live migrations directory is clean', () => {
  assert.deepEqual(checkRollupIndexGuard(), []);
});

// ---- the failure case this whole guard exists for ----

const BAD_REBUILD = `
-- 0090 — widen the rollup with a new column
drop materialized view if exists collections.cmd_explorer_charge_rollup;
create materialized view collections.cmd_explorer_charge_rollup as select 1 as id;
create unique index cmd_charge_rollup_id on collections.cmd_explorer_charge_rollup (id);
create index cmd_charge_rollup_member on collections.cmd_explorer_charge_rollup (member_id_bidx);
`;

test('a hand-written rebuild that forgets the trgm indexes FAILS, naming all four', () => {
  const failure = checkMigrationSql('0090_rollup_widen.sql', BAD_REBUILD);
  assert.ok(failure !== null, 'an unguarded rollup rebuild must be reported');
  assert.equal(failure.file, '0090_rollup_widen.sql');
  assert.equal(failure.number, 90);
  assert.deepEqual(failure.missing, [...REQUIRED_TRGM_INDEXES]);
  assert.match(failure.reason, /neither enumerates live indexes from pg_indexes/);
});

test('a PARTIAL carry-forward fails and names only the indexes actually missing', () => {
  // The realistic version of the bug: someone copies two of the four across.
  const partial =
    BAD_REBUILD +
    'create index cmd_charge_rollup_facility_trgm on collections.cmd_explorer_charge_rollup using gin (facility claims.gin_trgm_ops);\n' +
    'create index cmd_charge_rollup_payer_trgm on collections.cmd_explorer_charge_rollup using gin (primary_payer claims.gin_trgm_ops);\n';
  const failure = checkMigrationSql('0091_rollup_partial.sql', partial);
  assert.ok(failure !== null);
  assert.deepEqual(failure.missing, ['cmd_charge_rollup_cpt_trgm', 'cmd_charge_rollup_revenue_trgm']);
});

// ---- the two legitimate escape hatches ----

test('escape hatch (a): enumerating pg_indexes passes — the carry-forward pattern', () => {
  const carryForward =
    BAD_REBUILD +
    `for r in select indexname, indexdef from pg_indexes
       where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup' loop
       execute r.indexdef; end loop;`;
  assert.equal(checkMigrationSql('0092_rollup_swap.sql', carryForward), null);
});

test('escape hatch (b): naming all four trgm indexes explicitly passes', () => {
  const explicit =
    BAD_REBUILD +
    REQUIRED_TRGM_INDEXES.map(
      (idx) => `create index ${idx} on collections.cmd_explorer_charge_rollup using gin (facility claims.gin_trgm_ops);`,
    ).join('\n');
  assert.equal(checkMigrationSql('0093_rollup_explicit.sql', explicit), null);
});

// ---- scoping: the guard must not cry wolf ----

test('0080-style DDL on a DIFFERENT matview that merely READS the rollup is out of scope', () => {
  // This is exactly 0080's shape. A mention-based guard would flag it forever.
  const otherMatview = `
    drop materialized view if exists collections.cmd_explorer_filter_options;
    create materialized view collections.cmd_explorer_filter_options as
      select business_entity_id, 'payer'::text as kind, primary_payer as value
        from collections.cmd_explorer_charge_rollup group by 1, 3;
  `;
  assert.equal(checkMigrationSql('0080_cmd_explorer_filter_options.sql', otherMatview), null);
  assert.equal(rebuildsRollup(otherMatview), false, 'reading the rollup is not rebuilding it');
});

test('REFRESH and index-only migrations against the rollup are out of scope', () => {
  assert.equal(rebuildsRollup('refresh materialized view concurrently collections.cmd_explorer_charge_rollup;'), false);
  assert.equal(
    rebuildsRollup('create index concurrently foo on collections.cmd_explorer_charge_rollup using gin (facility);'),
    false,
  );
});

test('migrations at or below the trgm landing number are grandfathered', () => {
  // 0050/0059/0067 legitimately rebuild the rollup and predate the indexes.
  assert.equal(checkMigrationSql('0050_cmd_explorer_charge_rollup.sql', BAD_REBUILD), null);
  assert.equal(checkMigrationSql(`00${TRGM_INDEXES_LANDED_AT}_at_the_boundary.sql`, BAD_REBUILD), null);
  // One past the boundary is NOT exempt.
  assert.ok(checkMigrationSql(`00${TRGM_INDEXES_LANDED_AT + 1}_just_after.sql`, BAD_REBUILD) !== null);
});

test('a commented-out rebuild does not trip the guard', () => {
  const commented = `
    -- drop materialized view if exists collections.cmd_explorer_charge_rollup;
    -- create materialized view collections.cmd_explorer_charge_rollup as select 1;
    alter table collections.cmd_explorer_rows set (autovacuum_vacuum_scale_factor = 0.02);
  `;
  assert.equal(checkMigrationSql('0094_comment_only.sql', commented), null);
});

// ---- helper units ----

test('the _next / _old swap suffixes count as rebuilding the rollup (0067 pattern)', () => {
  assert.equal(rebuildsRollup('create materialized view collections.cmd_explorer_charge_rollup_next as select 1;'), true);
  assert.equal(rebuildsRollup('drop materialized view collections.cmd_explorer_charge_rollup_old;'), true);
  // Unqualified + IF NOT EXISTS forms too.
  assert.equal(rebuildsRollup('CREATE MATERIALIZED VIEW IF NOT EXISTS cmd_explorer_charge_rollup AS SELECT 1;'), true);
  // A different relation whose name merely starts with the rollup's is NOT the rollup.
  assert.equal(rebuildsRollup('create materialized view collections.cmd_explorer_charge_rollupsomething as select 1;'), false);
});

test('migrationNumber reads the filename prefix and rejects unnumbered files', () => {
  assert.equal(migrationNumber('0082_cmd_explorer_rows_hygiene.sql'), 82);
  assert.equal(migrationNumber('0082_cmd_explorer_rows_hygiene_rollback.sql'), 82);
  assert.equal(migrationNumber('2026-06-22_claim_line_nullcredit_dedup.sql'), 2026);
  assert.equal(migrationNumber('cmd_rollup_writer_role.sql'), null);
});

test('stripLineComments removes trailing comments but keeps the SQL', () => {
  assert.equal(stripLineComments('select 1; -- a note\nselect 2;'), 'select 1; \nselect 2;');
});
