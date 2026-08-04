/**
 * "ON FILE" TAGS — the readout bar's policy row, and its PHI boundary.
 *
 * The boundary is the point of this suite: the employer IS displayed (Alec's ruling 2026-08-04 — it is a
 * factor of the search), while the group number and every dollar-bearing benefit string must remain
 * structurally unable to appear, because this row is shared by a role that is server-stripped of dollars.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveOnFileTags } from '../lib/qualify/onFileTags';

const POLICY = {
  carrier: 'AETNA',
  employerName: 'VANDERBILT UNIV. MEDICAL CENTER',
  funding: 'Self-Funded',
  policyType: 'PPO',
  planType: 'OPEN ACCESS',
  network: null,
};

test('on-file tags carry the six plan-level facts, in order, network in the mono face', () => {
  const tags = deriveOnFileTags(POLICY);
  assert.deepEqual(tags.map((t) => t.label), ['Payer', 'Employer', 'Funding', 'Policy', 'Plan', 'Network']);
  assert.equal(tags[0]?.value, 'AETNA');
  assert.equal(tags[5]?.mono, true);
});

// Alec's ruling 2026-08-04: the employer is a factor of the search and belongs on screen when a prefix
// resolves — it was already rendered by the policy strip, so withholding it here made two summaries of
// one policy disagree. The ruling covers DISPLAY to an authenticated principal only.
test('the EMPLOYER surfaces on a resolved prefix (ruled), second after the payer', () => {
  const tags = deriveOnFileTags(POLICY);
  assert.equal(tags[1]?.label, 'Employer');
  assert.equal(tags[1]?.value, 'VANDERBILT UNIV. MEDICAL CENTER');
  assert.equal(tags[1]?.missing, false);
  // An unnamed employer still reads honestly rather than vanishing.
  assert.equal(deriveOnFileTags({ ...POLICY, employerName: null })[1]?.value, 'not on file');
});

test('a null field says "not on file" — because "network unknown" and "in network" are different answers', () => {
  const tags = deriveOnFileTags(POLICY);
  const network = tags.find((t) => t.label === 'Network');
  assert.equal(network?.value, 'not on file');
  assert.equal(network?.missing, true);
  // Blank-but-present is treated as missing too, not rendered as an empty chip.
  assert.equal(deriveOnFileTags({ ...POLICY, funding: '   ' }).find((t) => t.label === 'Funding')?.missing, true);
});

test('PHI BOUNDARY: no group number and no dollar figure can appear in the tag row', () => {
  // Employer is now deliberately present (ruled). The group number never can be — it exists only as a
  // blind index — and the four benefit strings are dollar-bearing and stripped for admissions_seat, so
  // putting them here would make a shared bar role-dependent. The input type has no field for any of
  // them; this pins the rendered output too, so a future widening cannot leak in unnoticed.
  const json = JSON.stringify(deriveOnFileTags(POLICY));
  for (const forbidden of ['group', '$', 'deductible', 'oop']) {
    assert.ok(!json.toLowerCase().includes(forbidden), `${forbidden} must never reach the on-file row`);
  }
});

test('no policy on file → no tag row at all, not six empty chips', () => {
  assert.deepEqual(deriveOnFileTags(null), []);
});
