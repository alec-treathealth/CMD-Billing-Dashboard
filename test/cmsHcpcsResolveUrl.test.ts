import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractQuarterlyFileLinks,
  resolveLatestQuarterlyFile,
  sourceRefFromLink,
} from '../src/jobs/cmsHcpcsSync/resolveUrl.js';

// Mirrors the real quarterly-update page: singular AND plural ("files") filenames.
const SAMPLE_HTML = `
  <a href="https://www.cms.gov/files/zip/july-2026-alpha-numeric-hcpcs-file.zip">July 2026</a>
  <a href="https://www.cms.gov/files/zip/april-2026-alpha-numeric-hcpcs-file.zip">April 2026</a>
  <a href="https://www.cms.gov/files/zip/january-2026-alpha-numeric-hcpcs-file.zip">January 2026</a>
  <a href="https://www.cms.gov/files/zip/october-2023-alpha-numeric-hcpcs-files.zip">October 2023 (plural)</a>
  <a href="https://www.cms.gov/files/zip/some-other-file.zip">unrelated</a>
`;

test('extractQuarterlyFileLinks: finds singular + plural filenames, ignores unrelated', () => {
  const links = extractQuarterlyFileLinks(SAMPLE_HTML);
  const urls = links.map((l) => l.url);
  assert.equal(links.length, 4);
  assert.ok(urls.some((u) => u.endsWith('october-2023-alpha-numeric-hcpcs-files.zip')));
  assert.ok(!urls.some((u) => u.includes('some-other-file')));
});

test('resolveLatestQuarterlyFile: picks newest effective quarter, not a future one', () => {
  // As of mid-May 2026, the effective quarter is April 2026 (July not yet effective).
  const asOf = new Date('2026-05-15T00:00:00Z');
  const link = resolveLatestQuarterlyFile(SAMPLE_HTML, asOf);
  assert.ok(link);
  assert.equal(link.month, 'april');
  assert.equal(link.year, 2026);
  assert.equal(sourceRefFromLink(link), 'april-2026');
});

test('resolveLatestQuarterlyFile: on/after Jul 1 2026 picks July', () => {
  const link = resolveLatestQuarterlyFile(SAMPLE_HTML, new Date('2026-07-09T00:00:00Z'));
  assert.equal(link?.month, 'july');
});

test('resolveLatestQuarterlyFile: no links → null', () => {
  assert.equal(resolveLatestQuarterlyFile('<p>nothing here</p>'), null);
});
