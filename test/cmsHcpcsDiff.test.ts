import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffHcpcs } from '../src/jobs/cmsHcpcsSync/diff.js';
import type { HcpcsRecord, RefCodeSnapshotRow } from '../src/jobs/cmsHcpcsSync/types.js';

function rec(code: string, shortDesc: string, longDesc: string | null = null): HcpcsRecord {
  return { code, shortDesc, longDesc, effectiveDate: null };
}
function prior(code: string, shortDesc: string, isActive = true, longDesc: string | null = null): RefCodeSnapshotRow {
  return { code, shortDesc, longDesc, isActive };
}

test('diff: brand-new code → code_added + upsert', () => {
  const { events, upserts, deletedCodes } = diffHcpcs([rec('H0018', 'resid')], []);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.changeType, 'code_added');
  assert.equal(upserts.length, 1);
  assert.equal(deletedCodes.length, 0);
});

test('diff: unchanged code → no event, no upsert', () => {
  const { events, upserts } = diffHcpcs([rec('H0018', 'resid')], [prior('H0018', 'resid')]);
  assert.equal(events.length, 0);
  assert.equal(upserts.length, 0);
});

test('diff: description change → code_revised + upsert', () => {
  const { events, upserts } = diffHcpcs(
    [rec('H0018', 'residential NEW wording')],
    [prior('H0018', 'residential old wording')],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.changeType, 'code_revised');
  assert.equal(upserts.length, 1);
});

test('diff: tracked+active code absent from snapshot → code_deleted', () => {
  const { events, deletedCodes, upserts } = diffHcpcs(
    [rec('H0018', 'resid')],
    [prior('H0018', 'resid'), prior('H2999', 'unlisted mh service')],
  );
  assert.deepEqual(deletedCodes, ['H2999']);
  assert.equal(upserts.length, 0);
  const del = events.find((e) => e.changeType === 'code_deleted');
  assert.ok(del);
  assert.equal(del.code, 'H2999');
});

test('diff: previously-terminated code re-listed → code_added again', () => {
  const { events, upserts } = diffHcpcs(
    [rec('H0018', 'resid')],
    [prior('H0018', 'resid', /* isActive */ false)],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.changeType, 'code_added');
  assert.equal(upserts.length, 1);
});

test('diff: an inactive prior code absent from file is NOT re-flagged as deleted', () => {
  const { events, deletedCodes } = diffHcpcs([rec('H0018', 'resid')], [
    prior('H0018', 'resid'),
    prior('H2999', 'already terminated', /* isActive */ false),
  ]);
  assert.equal(deletedCodes.length, 0);
  assert.equal(events.length, 0);
});
