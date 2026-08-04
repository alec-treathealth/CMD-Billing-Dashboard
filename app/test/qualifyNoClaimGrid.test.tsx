/**
 * THE RULING, PINNED AS SOURCE FACTS (Alec, 2026-08-04): the desktop /qualify page shows NO claim-line
 * grid. It answers "should we take this client, and which facility" — a decision about facilities.
 * Charge-line COUNTS and DOLLAR AGGREGATES stay; individual identified rows do not appear at all.
 *
 * This is a SOURCE-LEVEL assertion, not a render one, and deliberately so. The container is a client
 * component with ~12 Server-Action effects; standing it up under renderToStaticMarkup would require
 * stubbing every action and would still not prove the absence of a fetch. What actually matters is
 * structural: the module must not import the claim-row table, the cohort sheet, or the two actions that
 * return claim rows. If someone re-adds any of them, this fails and they have to read the ruling first.
 *
 * The privacy consequence is the part worth defending: with no grid, a PHI term typed into this page only
 * ever NARROWS AN AGGREGATE. The server HMACs it to a blind index and returns counts and percentages, so
 * no identified row crosses the wire to the browser on this surface at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAB = readFileSync(join(HERE, '..', 'components', 'qualify', 'qualify-tab.tsx'), 'utf8');

test('the desktop tab does not render a claim-line grid or the patient-cohort sheet', () => {
  for (const banned of ['<CasesTable', '<CohortSheet']) {
    assert.ok(!TAB.includes(banned), `${banned} is back on /qualify — read the ruling in the file header`);
  }
});

test('the desktop tab does not FETCH claim rows — the reads are aggregates only', () => {
  // getQualifyMatchSummary returns a count + non-dollar percentages. These two return identified rows.
  for (const action of ['getQualifyComposedCases', 'getQualifyPatientCohort']) {
    // Allowed in prose (the header explains the removal); banned as a call.
    assert.ok(!new RegExp(`${action}\\s*\\(`).test(TAB), `${action}() is called again — that re-fetches PHI rows`);
  }
  assert.match(TAB, /getQualifyMatchSummary\(composeInput\)/, 'the aggregate count read is still the live one');
});

test('no PHI reveal control survives on a page with nothing to reveal', () => {
  // The audited reveal path itself must stay available to /qualify/m — it is only this page that has
  // lost its reason to call it. A toggle here would unmask nothing while implying it unmasked something.
  assert.ok(!/revealQualifyRows\s*\(/.test(TAB), 'the desktop tab calls the reveal action again');
  assert.ok(!TAB.includes('Reveal PHI identifiers'), 'a reveal control is back with no rows to reveal');
  // And the search inputs are still PHI-gated — removing the grid must not have removed the gate.
  assert.match(TAB, /\{canRevealPhi \? \(/, 'the identified search row is still canRevealPhi-gated');
});

test('the ranking is not laid out beside a second column any more', () => {
  // The two-up grid template was the thing squeezing the scorecard to half width.
  assert.ok(
    !TAB.includes('min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]'),
    'the two-column results template is back — the ranking is full width now',
  );
});
