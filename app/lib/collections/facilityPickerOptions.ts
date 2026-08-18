/**
 * THE COLLECTIONS FACILITY PICKER — one option per REAL facility.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `buildCmdFacilityOptionsQuery` is DISTINCT on the RAW CMD facility text, so a facility whose CMD
 * export carries more than one spelling produced two options that render identically — same curated
 * name, same IP/OP badge — and picking the wrong one silently scoped the whole search to a fraction
 * of the data with a perfectly plausible number on screen.
 *
 * Live: `LONESTAR MENTAL HEALTH` (10,044 charge lines) and `LONESTAR MENTAL HEALTH LLC` (162) both
 * resolve to facility_code LSMH — one through the exact `facilities.facility_name` match, the other
 * through the `cmd_facility_aliases` crosswalk.
 *
 * ── ⚠ THIS REVERSES THE 2026-08-10 RULING. READ BEFORE "RESTORING" ANYTHING ────────────────────
 * On 2026-08-10 collapsing to one option per facility was PROPOSED AND EXPLICITLY RULED OUT:
 * *"Collections is a raw-grain payment search, not a facility rollup"* — the two options were held
 * to be two legitimate options, and only their LABELS were treated as broken. Two attempts were made
 * to fix this as a labelling problem:
 *
 *   1. 2026-08-10 — append the raw text to colliding labels. Correct, and INVISIBLE: the dropdown
 *      row renders with CSS `truncate`, and the suffix sat behind an identical 27-character prefix,
 *      so both options still read `LONESTAR MENTAL HEALTH LLC · LO…`.
 *   2. 2026-08-17 — move the raw text to an untruncated second line. Legible at last, and Alec's
 *      browser pass rejected it anyway: *"Lonestar Mental Health is still showing double in the
 *      Facility search, it should be merged into one facility."*
 *
 * So the ruling is REVERSED (Alec, 2026-08-18) and this is now a merge. The reasoning that reversed
 * it: a user picking a facility is asking about a PLACE, not about a spelling in a CMD export. Two
 * rows that name the same place are not a choice — they are a trap, however legibly labelled. Both
 * label-only fixes were faithful to the old ruling and both failed the same user, twice.
 *
 * ── HOW THE MERGE KEEPS THE RAW GRAIN WHERE IT MATTERS ─────────────────────────────────────────
 * The DISPLAY merges; the QUERY does not. An option carries every raw spelling in `variants`, and
 * the caller expands its selection through `expandFacilityKeys` before building the filter — so the
 * predicate stays `facility = any(...)` over RAW text, unchanged, on the same indexes. Nothing about
 * the row grain, the rollup, or the summary changes. `buildCmdFacilityOptionsQuery` is untouched.
 *
 * This is the same shape as the employer canonicalisation (employerCanonical.ts): merge for the
 * human, expand for the database.
 *
 * PURE — no React, no server imports, relative import for the type only — so the test can load it
 * under `tsx`. It lives outside cmd-explorer.tsx because that component transitively imports
 * `lib/actions.ts` → `lib/access.ts`, which calls React `cache` at module scope and cannot be
 * imported by the test runner at all.
 */
import type { PickerOption } from '../../components/ui/multi-select-tag-picker';

/** The fields this derivation reads off `CmdFacilityOption` — kept structural so the test needs no
 *  server types and so a future column on the option cannot silently change the label. */
export interface FacilityLabelSource {
  facility: string;
  facility_name: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

/** One merged facility: what the user picks, and what the database is actually asked for. */
export interface FacilityGroup {
  /** Option value + label — the curated dimension name, else the raw text when unresolved. */
  key: string;
  /** EVERY raw CMD spelling behind `key`. This is what the grid filter matches on. */
  variants: string[];
  badge: 'IP' | 'OP' | 'BOTH' | null;
}

/**
 * Collapse the raw facility options into one group per real facility, in first-seen order.
 *
 * Grouped by the CURATED name, which is precisely the crosswalk's own statement that two spellings
 * are one place. An unresolved facility (`facility_name === null`) groups under its own raw text and
 * can therefore never merge with anything — the safe direction: a missing crosswalk entry leaves two
 * options rather than silently fusing two different facilities.
 *
 * `badge` takes the first non-null care setting in the group. They agree in practice (the crosswalk
 * resolves to one dimension row); taking the first non-null just avoids a null badge when only one
 * spelling resolved.
 */
export function facilityGroupsFrom(options: readonly FacilityLabelSource[]): FacilityGroup[] {
  const byKey = new Map<string, FacilityGroup>();
  for (const o of options) {
    const key = o.facility_name ?? o.facility;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.variants.includes(o.facility)) existing.variants.push(o.facility);
      if (existing.badge === null) existing.badge = o.care_setting;
    } else {
      byKey.set(key, { key, variants: [o.facility], badge: o.care_setting });
    }
  }
  return [...byKey.values()];
}

/**
 * Map the raw facility options to ONE picker option per facility.
 *
 * `value` is the curated key, NOT a raw facility text — callers must expand it through
 * `expandFacilityKeys` before it reaches a filter.
 */
export function facilityPickerOptionsFrom(options: readonly FacilityLabelSource[]): PickerOption[] {
  return facilityGroupsFrom(options).map((g) => ({
    value: g.key,
    display: g.key,
    // Says the merge happened, so a user who knows CMD carries two spellings can see they are both
    // covered rather than wondering which one this row is.
    ...(g.variants.length > 1 ? { detail: `${g.variants.length} CMD spellings` } : {}),
    // The raw spellings stay FINDABLE. Someone who knows the export types "LONESTAR MENTAL HEALTH
    // LLC" and must still land on the merged row; `display` is the curated name and would not match.
    searchText: g.variants,
    badge: g.badge,
  }));
}

/**
 * Expand picked curated keys to the raw CMD spellings the filter matches.
 *
 * ⚠ AN UNKNOWN KEY FALLS BACK TO ITSELF rather than being dropped. Dropping it would silently WIDEN
 * the grid — a chip naming a facility while the results ignore it, which is the one failure a filter
 * must never have. Passing it through at worst matches nothing, which is honest. It also keeps a
 * drill-chip value working: those carry a RAW facility text, which is not a key here.
 */
export function expandFacilityKeys(
  keys: readonly string[],
  groups: readonly FacilityGroup[],
): string[] {
  const byKey = new Map(groups.map((g) => [g.key, g.variants]));
  const out: string[] = [];
  for (const k of keys) {
    const variants = byKey.get(k);
    if (variants) out.push(...variants);
    else out.push(k);
  }
  return [...new Set(out)];
}
