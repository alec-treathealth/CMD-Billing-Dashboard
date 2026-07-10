/**
 * I/O adapter: fetch the CMS quarterly-update page, resolve the latest ZIP, download
 * it, and extract the HCPCS data member as text. Uses Node 20's global fetch (no
 * node-fetch dependency — the original draft's import is unnecessary on Node ≥18).
 *
 * This module is the ONLY network surface of the sync. It is intentionally thin and is
 * NOT unit-tested (the pure parse/diff/filter/resolveUrl modules are). A dry-run / DB
 * test double should stub CmsFileSource instead of hitting the network.
 */
import { resolveLatestQuarterlyFile, sourceRefFromLink } from './resolveUrl.js';
import { parseHcpcsFixedWidth } from './parse.js';
import { pickHcpcsDataMember, readZipEntries } from './zip.js';
import type { HcpcsRecord } from './types.js';

export const CMS_QUARTERLY_UPDATE_PAGE =
  'https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system/quarterly-update';

export interface FetchedQuarter {
  sourceRef: string; // e.g. 'july-2026'
  url: string;
  records: HcpcsRecord[];
}

/** Seam so the orchestrator + tests don't hard-depend on the network. */
export interface CmsFileSource {
  fetchLatestQuarter(asOf?: Date): Promise<FetchedQuarter>;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CMS fetch failed ${res.status} ${res.statusText}: ${url}`);
  return res.text();
}

async function getBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CMS download failed ${res.status} ${res.statusText}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Live implementation. */
export const liveCmsFileSource: CmsFileSource = {
  async fetchLatestQuarter(asOf: Date = new Date()): Promise<FetchedQuarter> {
    const pageHtml = await getText(CMS_QUARTERLY_UPDATE_PAGE);
    const link = resolveLatestQuarterlyFile(pageHtml, asOf);
    if (!link) {
      throw new Error('CMS: could not find any quarterly HCPCS file link on the update page');
    }
    const zipBuf = await getBuffer(link.url);
    const member = pickHcpcsDataMember(readZipEntries(zipBuf));
    if (!member) {
      throw new Error(`CMS: no HCPCS text data member found inside ${link.url}`);
    }
    const records = parseHcpcsFixedWidth(member.data.toString('latin1'));
    return { sourceRef: sourceRefFromLink(link), url: link.url, records };
  },
};
