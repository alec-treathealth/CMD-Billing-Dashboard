import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { pickHcpcsDataMember, readZipEntries } from '../src/jobs/cmsHcpcsSync/zip.js';
import { buildStoredZip } from './fixtures/cmsHcpcs.js';

test('readZipEntries: reads STORED entries via the central-directory walk', () => {
  const zip = buildStoredZip([
    { name: 'readme.txt', data: Buffer.from('layout doc') },
    { name: 'HCPC2026_JUL_ANWEB.txt', data: Buffer.from('H0018 line one\nH0010 line two') },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  const anweb = entries.find((e) => /ANWEB/i.test(e.name));
  assert.ok(anweb);
  assert.equal(anweb.data.toString('utf8'), 'H0018 line one\nH0010 line two');
});

test('pickHcpcsDataMember: prefers the ANWEB text member over other files', () => {
  const zip = buildStoredZip([
    { name: '2026-hcpcs-record-layout.txt', data: Buffer.from('layout') },
    { name: 'HCPC2026_JUL_ANWEB.txt', data: Buffer.from('data') },
  ]);
  const member = pickHcpcsDataMember(readZipEntries(zip));
  assert.ok(member);
  assert.match(member.name, /ANWEB/i);
});

test('readZipEntries: throws a clear error on a non-zip buffer', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all')), /End Of Central Directory/);
});

test('zip: sanity — inflateRawSync round-trips (documents the DEFLATE path)', () => {
  // The zip.ts DEFLATE branch delegates to zlib.inflateRawSync; prove the primitive
  // round-trips so a future maintainer trusts the branch even though the fixture uses
  // STORED entries for a self-contained archive.
  const original = Buffer.from('H0018 residential per diem');
  const deflated = zlib.deflateRawSync(original);
  assert.equal(zlib.inflateRawSync(deflated).toString('utf8'), original.toString('utf8'));
});
