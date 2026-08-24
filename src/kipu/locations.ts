/**
 * Kipu session-container label → CMD customer, with an EXPLICIT timezone per location.
 *
 * WHY A REGISTRY AND NOT A REGEX. The facility is only ever present inside the `Session`
 * column ("Telehealth MH TX Group Sessions"), and the shape of that string is not a
 * pattern — it is nine locations naming themselves nine different ways. Measured across
 * the nine-export corpus on 2026-08-24, the eleven labels below are ALL of them, and the
 * previous `/\s*Group Sessions[\s\S]*$/i` strip only ever matched the three telehealth
 * ones. `Group Session 1` carries no state token at all, so no regex will ever place it.
 *
 * ⚠ ONE CMD ACCOUNT CAN HAVE MANY KIPU LABELS — THIS IS N:1, NOT 1:1. Kipu splits
 * Telehealth MH by state; CMD does not. Every `Telehealth MH <state>` bills under CMD
 * customer TELEHEALTH_MH (10034666). This is the same N:1 shape
 * `src/collections/qualifyCensus.ts` documents for census boards, using this very
 * facility as its live example — do not invent a second pattern for it. The
 * reconciliation consequence is the whole point: the Kipu side must be SUMMED across
 * every label mapping to a customer before comparison, or the un-summed states
 * manufacture a variance that does not exist.
 *
 * ⚠ MATCHING IS EXACT AND UNKNOWN LABELS THROW. There is deliberately no fallback to
 * inference: a Kipu location we have never seen must STOP the pipeline until someone maps
 * it, because the alternatives are silently dropping its days or silently attributing
 * them to a neighbour. `assertKnownLabels` is that gate.
 *
 * ⚠ THE TIMEZONE HERE IS AUTHORITATIVE AND KIPU'S IS NOT. Each location states its IANA
 * zone literally rather than deriving it from its own name. Kipu's "My Locations" screen
 * has Colorado and Missouri both set to Eastern when they are Mountain and Central; that
 * is not ours to change from Kipu, so the declared value stays untrusted input that we
 * diff and REPORT (`tzMismatch` in ./billingReport.ts) and never silently correct.
 *
 * NOTE ON WHAT THE ZONE IS USED FOR. Kipu exports each location's own LOCAL date and
 * time, and the day a session belongs to is that local calendar date — so the zone must
 * NOT be applied as a conversion to the parsed timestamps; doing that would shift days by
 * an offset that was never there. The zone is what makes the midnight-adjacency guard and
 * the declared-vs-ours diff mean something per location, which matters here because the
 * corpus spans Pacific, Mountain, Central and Eastern.
 */
import { BXR_ENTITY_ID } from '../tenants.js';

export type ZoneLabel = 'Pacific' | 'Mountain' | 'Central' | 'Eastern';

export interface KipuLocation {
  /** The EXACT `Session` column value after attestation stripping. Matched literally. */
  readonly label: string;
  /** Short human name for logs and reports. Never used for matching. */
  readonly display: string;
  /** USPS two-letter state. */
  readonly state: string;
  /** IANA zone, stated explicitly — never derived from `label` or `state` at runtime. */
  readonly iana: string;
  readonly zoneLabel: ZoneLabel;
  /**
   * `collections.facilities.facility_code` / the roster code in
   * `src/collections/cmdCustomers.ts`, or `null` for "delivering care, no CMD customer
   * yet". `null` means EXCLUDED from reconciliation and rendered as such — never dropped
   * quietly and never folded into a neighbouring state.
   */
  readonly facilityCode: string | null;
  readonly businessEntityId: string;
  readonly note?: string;
}

const PACIFIC = { iana: 'America/Los_Angeles', zoneLabel: 'Pacific' } as const;
const MOUNTAIN = { iana: 'America/Denver', zoneLabel: 'Mountain' } as const;
const CENTRAL = { iana: 'America/Chicago', zoneLabel: 'Central' } as const;
const EASTERN = { iana: 'America/New_York', zoneLabel: 'Eastern' } as const;

/**
 * Every label observed in the corpus (9 exports, Apr 1 – Aug 20 2026, 18,434 session
 * rows). Two exports carry TWO labels each — Texas and Virginia — so one export is NOT
 * one location.
 */
export const KIPU_LOCATIONS: readonly KipuLocation[] = [
  {
    label: 'Treat California',
    display: 'Treat California',
    state: 'CA',
    ...PACIFIC,
    facilityCode: 'TREAT_CA',
    businessEntityId: BXR_ENTITY_ID,
  },
  {
    label: 'Group Session NV',
    display: 'Treat Nevada',
    state: 'NV',
    ...PACIFIC,
    facilityCode: 'TREAT_NV',
    businessEntityId: BXR_ENTITY_ID,
  },
  {
    label: 'Treat Mental Health Washington',
    display: 'Treat Washington',
    state: 'WA',
    ...PACIFIC,
    facilityCode: 'TREAT_WA',
    businessEntityId: BXR_ENTITY_ID,
  },
  {
    label: 'Group Session TN',
    display: 'Treat Tennessee',
    state: 'TN',
    ...CENTRAL,
    facilityCode: 'TREAT_TN',
    businessEntityId: BXR_ENTITY_ID,
  },
  // Texas bills under ONE CMD customer through TWO Kipu labels. The second is a
  // named-provider container, not a second location.
  {
    label: 'TX Group Session',
    display: 'Treat Texas',
    state: 'TX',
    ...CENTRAL,
    facilityCode: 'TREAT_TX',
    businessEntityId: BXR_ENTITY_ID,
  },
  {
    label: 'Scott & Jenny Group Session TX',
    display: 'Treat Texas (Scott & Jenny)',
    state: 'TX',
    ...CENTRAL,
    facilityCode: 'TREAT_TX',
    businessEntityId: BXR_ENTITY_ID,
    note: 'Named-provider container inside Texas; 17 of 4,294 Texas session rows.',
  },
  // ── Telehealth MH: three Kipu labels, ONE CMD account (10034666). ─────────────────
  {
    label: 'Telehealth MH TX Group Sessions',
    display: 'Telehealth MH TX',
    state: 'TX',
    ...CENTRAL,
    facilityCode: 'TELEHEALTH_MH',
    businessEntityId: BXR_ENTITY_ID,
  },
  {
    label: 'Telehealth MH TN Group Sessions',
    display: 'Telehealth MH TN',
    state: 'TN',
    ...CENTRAL,
    facilityCode: 'TELEHEALTH_MH',
    businessEntityId: BXR_ENTITY_ID,
  },
  {
    label: 'Telehealth MH CO Group Sessions',
    display: 'Telehealth MH CO',
    state: 'CO',
    ...MOUNTAIN,
    facilityCode: 'TELEHEALTH_MH',
    businessEntityId: BXR_ENTITY_ID,
    note:
      'TELEHEALTH_MH, deliberately NOT TREAT_CO: 10035974 TREAT MENTAL HEALTH COLORADO is ' +
      'NOT YET OPEN (src/billingAudit/auditConfig.ts). Also the first real data that fires ' +
      "the timezone diff — Kipu declares this location Eastern; Colorado is Mountain.",
  },
  // ── Virginia: delivering care, no CMD customer to bill under. ─────────────────────
  {
    label: 'Group Session VA',
    display: 'Treat Virginia',
    state: 'VA',
    ...EASTERN,
    facilityCode: null,
    businessEntityId: BXR_ENTITY_ID,
    note:
      'No CMD roster entry, so EXCLUDED from reconciliation and rendered as "no CMD ' +
      'facility yet". CMD does know 10036125 TREAT MENTAL HEALTH VIRGINIA, but it is a ' +
      'PRE-LAUNCH facility (src/billingAudit/auditConfig.ts) and absent from ' +
      'src/collections/cmdCustomers.ts, so there is nothing to reconcile against yet.',
  },
  {
    label: 'Group Session 1',
    display: 'Treat Virginia (unnamed container)',
    state: 'VA',
    ...EASTERN,
    facilityCode: null,
    businessEntityId: BXR_ENTITY_ID,
    note:
      'THE PROOF CASE FOR THE REGISTRY: carries no state token, so no regex could ever ' +
      'place it. 1 of 24 Virginia session rows. Same null-facility treatment as Group Session VA.',
  },
];

const BY_LABEL: ReadonlyMap<string, KipuLocation> = new Map(KIPU_LOCATIONS.map((l) => [l.label, l]));

/** Exact lookup. `undefined` means UNMAPPED — callers must fail, never guess. */
export function locationFor(label: string): KipuLocation | undefined {
  return BY_LABEL.get(label.trim());
}

/** Distinct CMD facility codes the registry can reconcile (null-facility labels excluded). */
export const KIPU_FACILITY_CODES: readonly string[] = [
  ...new Set(KIPU_LOCATIONS.map((l) => l.facilityCode).filter((c): c is string => c !== null)),
].sort();

/** Every label that bills under `facilityCode` — the set the Kipu side must be summed over. */
export function labelsForFacility(facilityCode: string): readonly string[] {
  return KIPU_LOCATIONS.filter((l) => l.facilityCode === facilityCode).map((l) => l.label);
}

/**
 * The gate. Throws naming every unmapped label, because a new Kipu location must stop the
 * pipeline rather than be silently dropped or misattributed. Deliberately reports ALL
 * unknowns at once — discovering them one exception at a time wastes a run each.
 */
export function assertKnownLabels(labels: Iterable<string>): void {
  const unknown = [...new Set([...labels].map((l) => l.trim()).filter((l) => l && !BY_LABEL.has(l)))].sort();
  if (unknown.length === 0) return;
  throw new Error(
    `Unmapped Kipu session-container label(s): ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
      'Add each to KIPU_LOCATIONS in src/kipu/locations.ts with its state, explicit IANA zone ' +
      'and CMD facility_code (or null if the location has no CMD customer yet). Refusing to ' +
      'infer — an unmapped location would otherwise be dropped or billed to a neighbour.',
  );
}
