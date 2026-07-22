/**
 * Qualify SHARED CONTRACT — the single source of truth for the types + pure helpers that the desktop
 * tab (Prompt 3) and the mobile PWA (Prompt 4) consume IDENTICALLY, and that the server actions
 * (actions.ts) produce. This module is NOT 'use server' (such a module may export only async
 * functions) and imports nothing server-only, so both client surfaces can import these types and the
 * window math. Semantics are frozen (Prompt 2); adjust field names only with sign-off.
 */
import type { QualifyConfidence } from './confidence';

export type QualifyWindowDays = 30 | 60 | 90 | 180;
export const QUALIFY_WINDOW_OPTIONS: readonly QualifyWindowDays[] = [30, 60, 90, 180];
const WINDOW_SET: ReadonlySet<number> = new Set(QUALIFY_WINDOW_OPTIONS);
export function isQualifyWindow(n: unknown): n is QualifyWindowDays {
  return typeof n === 'number' && WINDOW_SET.has(n);
}

export interface QualifyInput {
  query: string; // member ID OR alpha prefix — sniffed SERVER-SIDE
  windowDays: QualifyWindowDays;
}

/**
 * Resolve a payer's facilities DIRECTLY by its primary_payer label (the same value a QualifyMover
 * carries), skipping the member-id/prefix PHI step. Deliberately a SEPARATE type from QualifyInput so
 * a member id can never structurally flow down this non-PHI path.
 */
export interface QualifyPayerInput {
  payer: string; // plaintext primary_payer label (non-PHI) — matched exactly against the rollup column
  windowDays: QualifyWindowDays;
}

/**
 * Drill a resolved payer's cases down to ONE facility (the facility-card tap on mobile). `payer` is the
 * resolved primary_payer label (from QualifySnapshot.resolved.payerName — works for both the PHI-search
 * and resolve-by-payer entry paths); `facility` is the tapped card's QualifyFacility.facilityKey (raw
 * rollup text). Both non-PHI; the query is re-gated + re-scoped server-side under the same principal.
 */
export interface QualifyFacilityCasesInput {
  payer: string;
  facility: string; // raw rollup facility text (QualifyFacility.facilityKey)
  windowDays: QualifyWindowDays;
  /** Optional IDENTIFIER narrow carried from the resolving search (Direction B) OR the manual prefix input.
   *  Both terms are the caller's OWN typed value (never row PHI); the blind index is minted SERVER-SIDE and
   *  the raw term is never logged/URL'd. Mutually exclusive in practice; when both arrive, `memberId` (exact)
   *  wins. A term mapping to a different payer returns 0 rows by design.
   *   - `prefix`  : leading ≤3-char alpha prefix  → member_id_prefix_bidx  (the STARTS-WITH narrow).
   *   - `memberId`: a full member-id term (exact) → member_id_bidx         (claims for that member only).
   *   - `group`   : a group-number term (EXACT — the employer PROXY; real employer names do not exist
   *                 in this data) → group_number_bidx. No prefix variant: only the exact group blind
   *                 index is materialized (0036/0059); a prefix index would be its own migration.
   *                 Composable with the member narrows (ANDed). */
  filter?: { prefix?: string; memberId?: string; group?: string };
  /** Forward keyset cursor for page N>0 (null/omitted = first page). Carries no PHI — see QualifyCasesCursor. */
  cursor?: QualifyCasesCursor | null;
  /** ALL-PAYERS facility view (mobile detail sheet): when true, the drill drops the `primary_payer = $payer`
   *  filter and returns EVERY payer's recent patients at the facility, each row tagged with its own payerName.
   *  `payer` is still passed (audit context) but not used to filter. Loads a single larger page (cap 50, the
   *  reveal batch cap) — no cursor — so the sheet can group/chip client-side. Omitted/false = the legacy
   *  single-payer, paged, prefix-filterable drill the desktop cases table uses (UNCHANGED). */
  allPayers?: boolean;
}

/** Forward keyset cursor for the claims panel: the last returned claim's DOS + synthetic id — both NON-PHI
 *  (lastDos = that claim's charge_date, a service date; id = the rollup/reveal synthetic key). No PHI. */
export interface QualifyCasesCursor {
  lastDos: string | null;
  id: number;
}

/** Facility-scoped claim lines + the amounts-capability flag (dollar fields already stripped when false). */
export interface QualifyFacilityCases {
  claims: QualifyClaim[];
  viewerHasAmountsCapability: boolean;
  tenantScope: typeof QUALIFY_TENANT_SCOPE;
  /** Keyset cursor to fetch the next page, or null at the end of the walk. */
  nextCursor: QualifyCasesCursor | null;
  /** True when rows exist beyond this page (computed via a limit+1 over-fetch, never a count). */
  hasMore: boolean;
}

/** member-id EXACT vs 3-letter alpha-PREFIX — the SNIFFED PHI-token kind (sniffed SERVER-SIDE, never
 *  client-declared). This is the kind mintToken/resolvePayer operate on; 'payer' is NOT one of them. */
export type QualifyMatchKind = 'member_id' | 'prefix';
/** How a RESOLVED payer was matched: a sniffed PHI token (member_id | prefix), OR 'payer' — the
 *  resolve-by-primary-payer label path (no PHI token; the movers/Heating-up tap). matchedOn uses this. */
export type QualifyResolvedKind = QualifyMatchKind | 'payer';
/** <=3 chars ⇒ alpha-prefix, else exact member-id (the searchAuditPatients precedent). Pure. */
export function sniffQualifyKind(query: string): QualifyMatchKind {
  return query.trim().length <= 3 ? 'prefix' : 'member_id';
}

export interface QualifyResolved {
  payerName: string;
  matchedOn: QualifyResolvedKind;
  /** Non-PHI alpha-prefix echo (<=3 chars). NEVER the raw member id — the client echoes its own input. */
  matchedValue: string;
  totalCharges: number; // logical charges (rollup grain) for the resolved payer, in-window
  facilityCount: number;
  windowStart: string; // ISO date (inclusive)
  windowEnd: string; // ISO date (exclusive)
}

export interface QualifyFacility {
  /** 1-based rank over the single cross-tenant list, ORDERED BY `rating` desc (ruling Q-G) — NOT by
   *  pctAllowedOfBilled. Do not "fix" the sort to pct: rating is the sort key, pct is a displayed value. */
  rank: number;
  name: string;
  /** RAW rollup facility text — the stable join key for the facility-scoped claim-lines drill
   *  (getQualifyFacilityCases). NON-PHI (facility identity already flows via `name`); always present
   *  (the ranking query filters out null/blank facility). Distinct from `name`, which may be the
   *  resolved dimension name and cannot be matched back to the rollup. */
  facilityKey: string;
  city: string | null; // facility-location lookup; null when unmapped (new/unlisted facility) — never fabricated
  state: string | null;
  /** Dollar-weighted RELIABLE allowed/billed, 0-100 (0059 repoint: sums `allowed_reliable`, tier e2
   *  excluded — see qualifyQuery.ts RANKING_RELIABLE_SELECT). null when the guarded denominator
   *  collapses OR the facility has ZERO reliable evidence in-window → neutral badge, never 0%. */
  pctAllowedOfBilled: number | null;
  /** Value-first rating (rating.ts, ruling 2026-07-19b) = clamp0to100(pctAllowedOfBilled) — the SORT
   *  key AND badge-color source. null → neutral badge. */
  rating: number | null;
  /** v1: ALWAYS null (ruling Q-E; the 0050 rollup can't back a faithful monthly trend). No badge. */
  streakSignal: number | null;
  billedAmount: number | null; // ALL in-window lines; null unless viewerHasAmountsCapability (stripped server-side)
  allowedAmount: number | null; // reliable-evidence sum (e2 excluded); null when zero reliable evidence OR stripped
  lineCount: number; // ALL in-window logical charge lines (volume context: floor + "limited data"; non-dollar, not tier-filtered)
  /** Coverage triple (0059 trust signal): per-facility in-window claim counts by confidence bucket
   *  (confidence.ts — confirmed = a/cd/e1, estimate = e2, unknown = b/none). Sums to lineCount.
   *  NON-DOLLAR: renders for admissions_seat; never stripped. Backs the coverage bar + the
   *  "Rated on {confirmed} of {total} claims" caption (the rating already excludes estimate). */
  confirmedClaims: number;
  estimateClaims: number;
  unknownClaims: number;
  /** Level of care from the facility dimension (care_setting). null when the facility text is
   *  unresolved — render no tag, never a fabricated one. */
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
}

/** ONE claim (charge) line — claim grain (Direction B, ruling 1): one row per charge from the 0050 rollup,
 *  NOT the former distinct-patient dedup. `dos` is the claim's OWN service date (charge_date), not a max. */
export interface QualifyClaim {
  id: number; // rollup id of THIS charge — drives the audited reveal
  memberIdMasked: string; // '••••••' until an audited reveal (revealQualifyRow); standard PHI cell
  /** primary_payer on THIS claim (the SAME rollup column the payer card resolves on — never a per-member
   *  re-lookup). NON-PHI. On the payer-scoped drill this equals the resolved payer for every row; on the
   *  mobile all-payers facility drill it varies per row, so a facility that serves several payers reads at
   *  a glance. Null only if the rollup payer is blank. */
  payerName: string | null;
  facilityName: string;
  program: 'IP' | 'OP' | 'BOTH' | null; // := care_setting; null when the facility text is unresolved
  dos: string | null; // this claim's service date (charge_date), ISO, display only
  /** Per-claim reliable-allowed/billed — the materialized 0059 pct_allowed (repoint ②). NULL when the
   *  claim's allowed is unknown (tiers b/none) — never 0%. e2 claims stay visible here unfiltered
   *  (display surface; the e2 exclusion is rating-evidence-only). */
  pctAllowedOfBilled: number | null;
  billedAmount: number | null; // null unless viewerHasAmountsCapability (stripped server-side)
  allowedAmount: number | null; // per-claim 0059 allowed_reliable (tiered value, not the netted sum); null = unknown or stripped
  /** THIS claim's confidence state (confidence.ts, derived server-side from 0059's allowed_tier —
   *  the raw tier never reaches the client). NON-DOLLAR: renders for admissions_seat. Drives the
   *  confidence-first %-allowed tint: estimate is NEVER green regardless of its number. */
  confidence: QualifyConfidence;
  /** PER-RESPONSE patient ordinal (1, 2, 3… in first-seen order), minted server-side from the
   *  blind index WHICH NEVER LEAVES THE SERVER. Two claims share a patientKey iff they belong to
   *  the same member WITHIN THIS RESPONSE; keys are NOT stable across responses/pages by design
   *  (a stable cross-response key would be a linkage exposure). Non-PHI. Drives the client-side
   *  one-row-per-patient grouping only. */
  patientKey: number;
}

export const QUALIFY_TENANT_SCOPE = 'cross-tenant-bxr-indigo' as const;
export const QUALIFY_MEMBER_ID_MASK = '••••••';

export interface QualifySnapshot {
  /** null ⇒ never-seen-this-identifier (VOB path). A non-null resolved with facilities:[] is the
   *  distinct "payer has no facilities in this window" state — frontends key VOB off resolved===null. */
  resolved: QualifyResolved | null;
  facilities: QualifyFacility[];
  /** Fix A: raw facility text (== QualifyFacility.facilityKey) of the searched identifier's MOST-RECENT
   *  in-window claim under the resolved payer, for auto-selecting the claims panel instead of rating rank-1.
   *  null when the resolution carried NO identifier (resolve-by-payer path) OR the identifier has no claim
   *  at any RANKED (floor-clearing) facility in-window — the honest-empty trigger. Guaranteed to be present
   *  in facilities[] when non-null (the core drops a below-floor candidate to null). NON-PHI (facility text). */
  identifierLandingFacility: string | null;
  viewerHasAmountsCapability: boolean; // === (role !== 'admissions_seat')
  tenantScope: typeof QUALIFY_TENANT_SCOPE; // always the literal — impossible to forget
}

export interface QualifyMover {
  rank: number;
  label: string; // dominant/plaintext primary_payer (non-PHI); taps into the primary_payers filter
  thisWindowPatients: number;
  priorWindowPatients: number;
  deltaPatients: number; // signed (this - prior); list is gainers-first
  deltaPct: number | null; // null when priorWindowPatients === 0 (a NEW payer)
}

export interface QualifyMovers {
  windowStart: string;
  windowEnd: string;
  priorWindowStart: string;
  priorWindowEnd: string;
  movers: QualifyMover[];
  viewerHasAmountsCapability: boolean; // movers carries NO dollar fields in v1 — informational
  tenantScope: typeof QUALIFY_TENANT_SCOPE;
}

/** PHI unmasked by an audited Qualify reveal (mirrors the collections CmdExplorerPhi shape exactly —
 *  all three are nullable: decryptPhi returns null for an absent ciphertext). */
export interface QualifyPhi {
  patient_name: string | null;
  member_id_raw: string | null;
  group_number: string | null;
}
export type RevealQualifyRowResult = { ok: true; phi: QualifyPhi } | { ok: false; error: string };
export interface QualifyRevealedRow extends QualifyPhi {
  id: number;
}
export type RevealQualifyRowsResult = { ok: true; rows: QualifyRevealedRow[] } | { ok: false; error: string };

/** The billing/admissions team's calendar zone — the ops "today" that anchors every window. Matches the
 *  business timezone the admin log surface already renders in (America/Los_Angeles). */
export const QUALIFY_BUSINESS_TZ = 'America/Los_Angeles';

/**
 * BUSINESS-DAY window bounds. this=[from,to) is `windowDays` days ending today (today included);
 * prior=[priorFrom,priorTo) is the adjacent equal-length window. All are calendar (date-only) ISO
 * strings. `today` is anchored to the ops calendar day in QUALIFY_BUSINESS_TZ, NOT the server's UTC
 * day: Vercel runs TZ=UTC, so from ~afternoon-to-midnight Pacific the raw UTC date is already tomorrow
 * and every window would silently slide forward a day. We take the civil Y-M-D in the business zone,
 * then do plain calendar arithmetic on it. `now` is injectable so the math is unit-testable.
 */
export function qualifyWindowBounds(
  windowDays: number,
  now: Date,
): { from: string; to: string; priorFrom: string; priorTo: string } {
  // Civil year/month/day in the business zone (formatToParts is locale-format-independent).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: QUALIFY_BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const anchor = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const shift = (base: Date, days: number) =>
    new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const to = shift(anchor, 1); // exclusive upper = tomorrow, so all of today is in-window
  const from = shift(anchor, -(windowDays - 1)); // inclusive lower → exactly windowDays days
  const priorTo = from; // adjacent, non-overlapping
  const priorFrom = shift(from, -windowDays);
  return { from: iso(from), to: iso(to), priorFrom: iso(priorFrom), priorTo: iso(priorTo) };
}
