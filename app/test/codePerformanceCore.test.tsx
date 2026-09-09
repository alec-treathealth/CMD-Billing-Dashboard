/**
 * Code Performance CORE — the shaping seam run through a FAKE `query` (no pg, no auth), which is the
 * contract core.ts states for itself. What this locks (Qodo #346 round 1):
 *   f7) `belowFloor` is derived from the SAME facility rows the table shows, so it survives an empty
 *       rated set — the first draft read it off `rows[0].below_floor`, which does not exist when no
 *       facility reaches the floor, and the drill-down said nothing over an empty table;
 *   f5) a drill-down completion from a STALE scope never reaches the cache (source contract);
 *   f6) a tenant change clears the facility selection in the same event (source contract).
 * Source-regex tests state the contract they check — a statement is in the code — never the runtime
 * outcome (Qodo rule 2726594); the outcome for f5/f6 needs a mounted component and is not claimed.
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getCodePerfPairDetailCore, type CodePerfDeps } from '../lib/code-performance/core';
import type { CodePerfPairInput } from '../lib/code-performance/contract';

const here = dirname(fileURLToPath(import.meta.url));
const BXR = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';
const INPUT: CodePerfPairInput = {
  tenant: 'bxr',
  window: '6mo',
  facilities: null,
  pair: { hcpcs: 'H2013', locSuffix: 'IOP', revcode: '0913' },
};

/** A fake pg that answers each builder by a marker only that builder's SQL carries. */
function fakeDeps(facilityRows: Array<Record<string, unknown>>): CodePerfDeps {
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('as rated')) return { rows: facilityRows as T[] };
      if (sql.includes('as max_ingested_at')) {
        return {
          rows: [
            { business_entity_id: BXR, business_today: '2026-09-09', max_charge_date: '2026-09-01', future_payment_charges: 0, charges_in_lookback: 1 },
          ] as T[],
        };
      }
      return { rows: [] as T[] };
    },
  };
}

/** pg returns numerics as STRINGS; `rated` arrives as a real boolean (a SQL comparison). */
const fac = (facility: string, charges: number) => ({
  facility,
  charges: String(charges),
  billed: '1000.00',
  collected: '100.00',
  rated: charges >= 30,
});

test('belowFloor counts the UNRATED facilities and the table receives only the rated ones, in query order', async () => {
  const d = await getCodePerfPairDetailCore(fakeDeps([fac('A', 40), fac('B', 31), fac('C', 5), fac('D', 29)]), BXR, INPUT);
  assert.deepEqual(d.facilities.map((r) => r.facility), ['A', 'B']);
  assert.ok(d.facilities.every((r) => r.rated), 'every table row is rated');
  assert.equal(d.belowFloor, 2);
});

test('⚠ when NO facility reaches the floor, belowFloor is the FULL count — the first draft returned 0 here', async () => {
  const d = await getCodePerfPairDetailCore(fakeDeps([fac('C', 5), fac('D', 29), fac('E', 1)]), BXR, INPUT);
  assert.deepEqual(d.facilities, []);
  assert.equal(d.belowFloor, 3, 'the exclusion notice needs this number to render at all');
});

test('no facilities in the pairing → empty table, belowFloor 0, nothing throws on the empty rows', async () => {
  const d = await getCodePerfPairDetailCore(fakeDeps([]), BXR, INPUT);
  assert.deepEqual(d.facilities, []);
  assert.equal(d.belowFloor, 0);
  assert.deepEqual(d.payers, []);
  assert.deepEqual(d.monthly, []);
});

test('view source contracts: stale drill-down completions are dropped by scope generation; a tenant change clears facilities', () => {
  const raw = readFileSync(join(here, '..', 'components', 'code-performance', 'code-performance-view.tsx'), 'utf8');
  // Comment-stripped, so the guards match CODE and never the docblocks that describe the fix.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const scopeGen = useRef\(0\);/, 'a scope-generation counter exists');
  assert.match(
    src,
    /useEffect\(\(\) => \{\s*let live = true;\s*scopeGen\.current \+= 1;/,
    'the board effect bumps it on every scope change, before anything else',
  );
  assert.match(src, /const gen = scopeGen\.current;\s*getCodePerformancePairDetail\(/, 'a detail request captures the generation it was issued under');
  assert.equal((src.match(/if \(gen !== scopeGen\.current\) return;/g) ?? []).length, 2, 'both the success and the error completion check it');
  assert.match(
    src,
    /function selectTenant\(next: CodePerfTenant\) \{\s*if \(next === tenant\) return;\s*setTenant\(next\);\s*setFacilities\(\[\]\);/,
    'a tenant change clears the facility selection in the same event',
  );
  assert.match(src, /<TenantToggle [^>]*onChange=\{selectTenant\}/, 'and the toggle uses it');
  assert.doesNotMatch(src, /onChange=\{setTenant\}/, 'no direct setTenant handler left behind');
});
