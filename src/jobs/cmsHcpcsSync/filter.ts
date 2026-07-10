/**
 * PURE behavioral-health relevance filter for HCPCS records. No I/O.
 *
 * Keeps only codes relevant to BH / RTC billing so the change layer isn't flooded
 * with the entire HCPCS universe every quarter. Applied to HCPCS codes only —
 * revenue codes are not in the CMS file (see layout.ts / AUDIT.md).
 */
import { BH_HCPCS_EXPLICIT, BH_HCPCS_PREFIXES } from './layout.js';
import type { HcpcsRecord } from './types.js';

/** True if a single code is BH-relevant. Exported for unit testing. */
export function isBhRelevant(code: string): boolean {
  const c = code.trim().toUpperCase();
  if (BH_HCPCS_EXPLICIT.has(c)) return true;
  return BH_HCPCS_PREFIXES.some((p) => c.startsWith(p));
}

export function filterBhRecords(records: readonly HcpcsRecord[]): HcpcsRecord[] {
  return records.filter((r) => isBhRelevant(r.code));
}
