/**
 * PURE snapshot diff. No I/O.
 *
 * The CMS quarterly file is a FULL active-set snapshot, not a delta with an action
 * flag (the original draft's `action_flag` assumption is unsafe — see AUDIT.md). So
 * change detection compares this quarter's BH records against our own prior snapshot
 * of tracked HCPCS codes (code_intel.ref_code) and classifies:
 *
 *   code_added   — code present now, not previously tracked (or was inactive).
 *   code_revised — code tracked + active before, description changed.
 *   code_deleted — code tracked + active before, ABSENT from this quarter's file
 *                  (the full snapshot no longer lists it → terminated).
 *
 * Deletions are scoped to codes WE previously tracked from CMS; we never invent a
 * deletion for a code we never had. Every event is deterministic given the inputs.
 */
import type { CodeChangeEvent, HcpcsRecord, RefCodeSnapshotRow } from './types.js';

function norm(s: string | null): string {
  return (s ?? '').trim();
}

function descriptionsDiffer(record: HcpcsRecord, prior: RefCodeSnapshotRow): boolean {
  return norm(record.shortDesc) !== norm(prior.shortDesc) ||
    norm(record.longDesc) !== norm(prior.longDesc);
}

export interface DiffResult {
  events: CodeChangeEvent[];
  /** Records that should be upserted into ref_code (added + revised). */
  upserts: HcpcsRecord[];
  /** Codes to mark is_active = false (deleted). */
  deletedCodes: string[];
}

/**
 * @param incoming  this quarter's BH-filtered records
 * @param priorRows current tracked CMS HCPCS snapshot from ref_code
 */
export function diffHcpcs(
  incoming: readonly HcpcsRecord[],
  priorRows: readonly RefCodeSnapshotRow[],
): DiffResult {
  const prior = new Map<string, RefCodeSnapshotRow>();
  for (const p of priorRows) prior.set(p.code.trim().toUpperCase(), p);

  const incomingCodes = new Set<string>();
  const events: CodeChangeEvent[] = [];
  const upserts: HcpcsRecord[] = [];

  for (const rec of incoming) {
    const code = rec.code.trim().toUpperCase();
    incomingCodes.add(code);
    const before = prior.get(code);

    if (!before || !before.isActive) {
      // New, or a previously-terminated code that CMS has re-listed.
      events.push({
        code,
        changeType: 'code_added',
        changeSummary: `New CMS HCPCS code active: ${code} — ${rec.shortDesc}`,
        previousValue: before
          ? { short_desc: before.shortDesc, long_desc: before.longDesc, is_active: before.isActive }
          : null,
        newValue: { short_desc: rec.shortDesc, long_desc: rec.longDesc, is_active: true },
        effectiveDate: rec.effectiveDate,
      });
      upserts.push(rec);
      continue;
    }

    if (descriptionsDiffer(rec, before)) {
      events.push({
        code,
        changeType: 'code_revised',
        changeSummary: `CMS HCPCS code revised: ${code} — description changed.`,
        previousValue: { short_desc: before.shortDesc, long_desc: before.longDesc },
        newValue: { short_desc: rec.shortDesc, long_desc: rec.longDesc },
        effectiveDate: rec.effectiveDate,
      });
      upserts.push(rec);
    }
    // else: unchanged — no event, no upsert.
  }

  // Deletions: tracked + active before, but not in this full snapshot.
  const deletedCodes: string[] = [];
  for (const [code, before] of prior) {
    if (before.isActive && !incomingCodes.has(code)) {
      deletedCodes.push(code);
      events.push({
        code,
        changeType: 'code_deleted',
        changeSummary:
          `CMS HCPCS code no longer in quarterly file: ${code} — ${before.shortDesc}. ` +
          `Review every active billing policy that uses it.`,
        previousValue: { short_desc: before.shortDesc, long_desc: before.longDesc, is_active: true },
        newValue: { is_active: false },
        effectiveDate: null,
      });
    }
  }

  return { events, upserts, deletedCodes };
}
