/**
 * Qualify SHARED CONTRACT — the single source of truth for the types + pure helpers that the desktop
 * tab (Prompt 3) and the mobile PWA (Prompt 4) consume IDENTICALLY, and that the server actions
 * (actions.ts) produce. This module is NOT 'use server' (such a module may export only async
 * functions) and imports nothing server-only, so both client surfaces can import these types and the
 * window math. Semantics are frozen (Prompt 2); adjust field names only with sign-off.
 */
import type { QualifyConfidence } from './confidence';
import type { QualifyProvenance, QualifyIqBand, QualifyFactorReading } from './ratingV2';

// Rating-v2 vocabulary re-exported so client surfaces keep ONE import seam (contract.ts) — the
// engine itself (ratingV2.ts) is a pure leaf both may import directly for helpers.
export type { QualifyProvenance, QualifyIqBand, QualifyFactorReading } from './ratingV2';

/** Trailing-window day counts. 30/60/90 are the quick PILLS; 180/270/365 (6/9/12 months) are the
 *  longer ROLLING spans in the Range ▾ menu — capped at 12 months so the widest scan stays ~1 year.
 *  Day-count months (180/270/365), NOT calendar months, so the existing trailing engine + prior-window
 *  math generalize unchanged. The 12-month book-wide aggregate rides an index-only scan (mig 0068). */
export type QualifyTrailingDays = 30 | 60 | 90 | 180 | 270 | 365;
export const QUALIFY_WINDOW_OPTIONS: readonly QualifyTrailingDays[] = [30, 60, 90];
/** Longer rolling spans surfaced in the Range menu (NOT quick pills). 6 / 9 / 12 months. */
export const QUALIFY_ROLLING_OPTIONS: readonly QualifyTrailingDays[] = [180, 270, 365];
/** days -> whole months, for the friendly rolling labels ("6mo" chip / "Last 6 months" menu). */
const ROLLING_MONTHS: Readonly<Record<number, number>> = { 180: 6, 270: 9, 365: 12 };
const WINDOW_SET: ReadonlySet<number> = new Set([...QUALIFY_WINDOW_OPTIONS, ...QUALIFY_ROLLING_OPTIONS]);

/** Menu label for a rolling span: "Last 6 months". */
export function qualifyRollingLabel(days: QualifyTrailingDays): string {
  const m = ROLLING_MONTHS[days];
  return m ? `Last ${m} months` : `Last ${days} days`;
}

/**
 * THE window shape (redesign): trailing-N-days OR a CALENDAR month/year (a different window shape,
 * not trailing-N — ruled 2026-07-24). Calendar prior window for every Δ = the previous equivalent
 * calendar period (previous month / previous year), NOT prior-year-same-month.
 */
export type QualifyWindow =
  | { kind: 'trailing'; days: QualifyTrailingDays }
  | { kind: 'month'; year: number; month: number } // month 1-12
  | { kind: 'year'; year: number };

/** Calendar-window year bounds (data begins 2024; generous forward cap — bounded input, not policy). */
export const QUALIFY_CAL_YEAR_MIN = 2024;
export const QUALIFY_CAL_YEAR_MAX = 2035;

/** Convenience constructor for the common trailing shape. */
export function trailingWindow(days: QualifyTrailingDays): QualifyWindow {
  return { kind: 'trailing', days };
}

/** Structural + range validation of a client-supplied window (the trust-boundary check). */
export function isQualifyWindow(w: unknown): w is QualifyWindow {
  if (typeof w !== 'object' || w === null) return false;
  const o = w as { kind?: unknown; days?: unknown; year?: unknown; month?: unknown };
  if (o.kind === 'trailing') return typeof o.days === 'number' && WINDOW_SET.has(o.days);
  const yearOk = typeof o.year === 'number' && Number.isInteger(o.year) && o.year >= QUALIFY_CAL_YEAR_MIN && o.year <= QUALIFY_CAL_YEAR_MAX;
  if (o.kind === 'month') return yearOk && typeof o.month === 'number' && Number.isInteger(o.month) && o.month >= 1 && o.month <= 12;
  if (o.kind === 'year') return yearOk;
  return false;
}

/** Compact NON-PHI token — audit detail, cohortKey, and the Change-F URL param share it:
 *  '30d' | '2026-07' | '2026'. Total over QualifyWindow. */
export function serializeQualifyWindow(w: QualifyWindow): string {
  if (w.kind === 'trailing') return `${w.days}d`;
  if (w.kind === 'month') return `${w.year}-${String(w.month).padStart(2, '0')}`;
  return String(w.year);
}

/** Parse a serialized window token (URL param). Returns null for anything malformed/out-of-range —
 *  the caller falls back to the default window, never trusts the string. */
export function parseQualifyWindow(s: string | null | undefined): QualifyWindow | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  const trailing = t.match(/^(\d{2,3})d$/);
  if (trailing) {
    const days = Number(trailing[1]);
    return WINDOW_SET.has(days) ? { kind: 'trailing', days: days as QualifyTrailingDays } : null;
  }
  const month = t.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const cand = { kind: 'month' as const, year: Number(month[1]), month: Number(month[2]) };
    return isQualifyWindow(cand) ? cand : null;
  }
  const year = t.match(/^(\d{4})$/);
  if (year) {
    const cand = { kind: 'year' as const, year: Number(year[1]) };
    return isQualifyWindow(cand) ? cand : null;
  }
  return null;
}

/** Human window label for captions/chips: '30d' · '6mo' · 'Jul 2026' · '2026'. */
export function qualifyWindowLabel(w: QualifyWindow): string {
  if (w.kind === 'trailing') {
    const m = ROLLING_MONTHS[w.days];
    return m ? `${m}mo` : `${w.days}d`;
  }
  if (w.kind === 'month') {
    const name = new Date(Date.UTC(w.year, w.month - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return `${name} ${w.year}`;
  }
  return String(w.year);
}

/**
 * VOB MARKET narrow — the member's verified employer(s) and/or funding market, from the Indigo VOB
 * benefits set matched on member_id_bidx. `employers` are normalized employer_norm keys (the
 * type-ahead's own values); `funding` are the market tags ('Self-Funded' / 'Fully Insured'). Both
 * set-membership; empty/absent = no restriction. When either is active the underlying query is a
 * SEMI-JOIN into VOB, so members with no matching VOB row drop out ("no-VOB excluded" is intrinsic).
 * Structurally a VobMarketFilter (src/collections/cmdExplorerQuery) — kept dependency-free here so
 * the client bundles no SQL builder. Sanitized (bounded + funding intersected) at the action boundary.
 */
export interface QualifyMarket {
  employers?: string[];
  funding?: string[];
}

export interface QualifyInput {
  query: string; // member ID OR alpha prefix — sniffed SERVER-SIDE
  window: QualifyWindow;
  /** Optional VOB employer/funding narrow applied to the facility ranking (see QualifyMarket). */
  market?: QualifyMarket;
  /** v2 AUTO-WINDOW: when true the server runs the sufficiency ladder (one bucketed query — 30→365,
   *  stop at the first rung with QUALIFY_RATING_CONFIDENT_PATIENTS distinct patients) and `window` is
   *  treated as a fallback only. The resolved ladder rides back on the snapshot so the UI can show the
   *  decision instead of hiding it. Omitted/false = the manual window (the Range menu, biller path). */
  auto?: boolean;
}

/**
 * Resolve a payer's facilities DIRECTLY by its primary_payer label (the same value a QualifyMover
 * carries), skipping the member-id/prefix PHI step. Deliberately a SEPARATE type from QualifyInput so
 * a member id can never structurally flow down this non-PHI path.
 */
export interface QualifyPayerInput {
  payer: string; // plaintext primary_payer label (non-PHI) — matched exactly against the rollup column
  window: QualifyWindow;
  /** Optional VOB employer/funding narrow applied to the facility ranking (see QualifyMarket). */
  market?: QualifyMarket;
}

/**
 * Resolve by CLIENT NAME (Change C — supersedes the Prompt-2 "no name search" ruling; Alec
 * 2026-07-24). Deliberately a SEPARATE type from QualifyInput (the QualifyPayerInput discipline) so
 * a name can never structurally flow down the member-id sniff path: the name is HMAC'd server-side
 * against the EXACT normalized-name blind index (patient_name_bidx, 0066/0067 — no prefix variant),
 * resolves to the dominant payer among matching rows, then the normal facility + cases drill. The
 * raw name is never logged, never in a URL, never echoed back (matchedValue stays '').
 * NOTE: names are not unique — an exact-name match may span multiple patients (the UI captions this).
 */
export interface QualifyNameInput {
  name: string; // client name (PHI IN TRANSIT ONLY — HMAC'd at the action boundary, never stored/logged)
  window: QualifyWindow;
  /** Optional VOB employer/funding narrow applied to the facility ranking (see QualifyMarket). */
  market?: QualifyMarket;
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
  window: QualifyWindow;
  /** Optional IDENTIFIER narrow carried from the resolving search (Direction B) OR the manual prefix input.
   *  Both terms are the caller's OWN typed value (never row PHI); the blind index is minted SERVER-SIDE and
   *  the raw term is never logged/URL'd. Mutually exclusive in practice; when both arrive, `memberId` (exact)
   *  wins. A term mapping to a different payer returns 0 rows by design.
   *   - `prefix`  : leading ≤3-char alpha prefix  → member_id_prefix_bidx  (the STARTS-WITH narrow).
   *   - `memberId`: a full member-id term (exact) → member_id_bidx         (claims for that member only).
   *   - `group`   : a group-number term (EXACT — the employer PROXY; real employer names do not exist
   *                 in this data) → group_number_bidx. No prefix variant: only the exact group blind
   *                 index is materialized (0036/0059); a prefix index would be its own migration.
   *                 Composable with the member narrows (ANDed).
   *   - `clientName`: a client-name term (EXACT, Change C) → patient_name_bidx (0066/0067). Carried
   *                 from a name-resolving search so the drill narrows to that name's rows. Precedence
   *                 among the identifier narrows: memberId > prefix > clientName. */
  filter?: { prefix?: string; memberId?: string; group?: string; clientName?: string };
  /** Optional VOB employer/funding narrow — carried from the snapshot so the cases drill filters the
   *  SAME market the ranking did (see QualifyMarket). Composable with the identifier/group narrows. */
  market?: QualifyMarket;
  /** ALL-PAYERS facility view (mobile detail sheet): when true, the drill drops the `primary_payer = $payer`
   *  filter and returns EVERY payer's recent patients at the facility, each row tagged with its own payerName.
   *  `payer` is still passed (audit context) but not used to filter. Omitted/false = the single-payer drill
   *  the desktop cases table uses. Both paths now return the WHOLE window (capped at QUALIFY_CASES_MAX), no
   *  keyset pager — the panel groups by patient client-side and reveals per patient. */
  allPayers?: boolean;
}

/**
 * COMPOSE-BAR input (Phase 1) — an AND-composed filter SET, the Qualify-shaped mirror of Collections'
 * CmdExplorerFilter (raw PHI terms here; HMAC'd to blind indexes at the action boundary). An empty/absent
 * field = NO restriction (never match-nothing). Non-PHI arrays are set-membership; the four PHI terms are
 * equality narrows. `clientName` is Qualify's admissions-first name narrow (Change C) — DORMANT until
 * QUALIFY_CLIENT_NAME_ENABLED, and a cases-ONLY narrow (the shared summary builder can't express it, so
 * the live count is name-blind; harmless while the flag is off — see the compose-bar PHI row comment).
 * Drives BOTH getQualifyMatchSummary (the live count) and getQualifyComposedCases (the claims list).
 */
export interface QualifyComposeInput {
  facilities?: string[]; // raw rollup facility text (== QualifyFacility.facilityKey)
  payers?: string[]; // plaintext primary_payer labels
  employers?: string[]; // employer_norm keys (VOB semi-join)
  funding?: string[]; // 'Self-Funded' | 'Fully Insured'
  memberId?: string; // raw PHI — HMAC'd server-side → member_id_bidx
  alphaPrefix?: string; // raw PHI — HMAC'd → member_id_prefix_bidx
  group?: string; // raw PHI — HMAC'd → group_number_bidx
  clientName?: string; // raw PHI (Change C) — HMAC'd → patient_name_bidx (cases-only; dormant behind the flag)
  window: QualifyWindow;
}

/**
 * Live "N charge lines match" summary for the compose bar. `count` + the two percentages are NON-DOLLAR
 * (admissions_seat-safe); the raw dollar sums are null unless the viewer has the amounts capability
 * (stripped at the CORE choke point). Percentages are derived server-side from the sums BEFORE stripping,
 * so admissions_seat still gets them. A collapsed denominator yields null (never a coerced 0%).
 */
export interface QualifyMatchSummary {
  count: number;
  /** Distinct CLIENTS backing the composed match — count(distinct member_id_bidx) over the SAME
   *  predicate as `count`. NON-DOLLAR (admissions_seat sees it). Drives the readout EVIDENCE gauge via
   *  ratingSampleTier / ratingEvidencePips (sampleGate.ts): more distinct clients ⇒ more solid pips. */
  distinctPatients: number;
  totalCharge: number | null;
  totalAllowed: number | null;
  totalPaid: number | null;
  totalBalance: number | null;
  pctAllowedOfBilled: number | null;
  pctPaidOfBilled: number | null;
  viewerHasAmountsCapability: boolean;
  tenantScope: typeof QUALIFY_TENANT_SCOPE;
}

/**
 * Phase 3 — the patient-group "View cohort" slide-over input. `claimId` is ONE claim of the group
 * (the rollup's synthetic id, non-PHI); the SERVER re-derives the member's alpha-prefix cohort token
 * from it (tenant-scoped lookup — a foreign/unknown id fails closed to suppressed). payer/facility/
 * window ride along for AUDIT CONTEXT only — the cohort itself is LIFETIME (cohort semantics are
 * deliberately unwindowed, matching the collections cohort curve).
 */
export interface QualifyPatientCohortInput {
  payer: string;
  facility: string;
  window: QualifyWindow;
  claimId: number;
}

/**
 * The patient's alpha-prefix cohort context (payer-behavior peer group), suppression-gated by the
 * SAME COHORT_MIN_PATIENTS floor the collections cohort curve enforces — `suppressed: true` renders
 * "not enough data", never a thin identifiable slice. `charge` dollars in the mixes and the raw
 * dollar sums are STRIPPED (null) for viewers without the amounts capability; counts + pcts stay.
 */
export interface QualifyPatientCohort {
  suppressed: boolean;
  /** The min-patient floor (copy: "shown only for cohorts of {floor}+ patients"). */
  floor: number;
  patients: number | null; // null when suppressed
  pctCollected: number | null; // lifetime paid ÷ billed
  pctAllowed: number | null; // lifetime allowed ÷ billed
  pctPaid: number | null; // lifetime paid ÷ allowed
  byPayer: { label: string | null; count: number; charge: number | null }[];
  byCpt: { label: string | null; count: number; charge: number | null }[];
  viewerHasAmountsCapability: boolean;
  tenantScope: typeof QUALIFY_TENANT_SCOPE;
}

/** Facility-scoped claim lines + the amounts-capability flag (dollar fields already stripped when false).
 *  The drill returns the WHOLE (facility, payer, window) set (no keyset pager), capped at QUALIFY_CASES_MAX. */
export interface QualifyFacilityCases {
  claims: QualifyClaim[];
  viewerHasAmountsCapability: boolean;
  tenantScope: typeof QUALIFY_TENANT_SCOPE;
  /** True when the window held MORE than QUALIFY_CASES_MAX claims and the list was truncated to the most
   *  recent (by payment date) — drives the honest "narrow the window" nudge (limit+1 over-fetch, never a count). */
  capped: boolean;
}

/**
 * Change C (client-name search) is DATA-GATED and STAYS OFF this session — Part 2 (name activation) is
 * DEFERRED pending ops. Verified 2026-07-27 (live DB): NEITHER prerequisite is met — the
 * cmd_explorer_charge_rollup matview has NO patient_name_bidx column (migration 0067 NOT applied), and
 * patient_name_bidx coverage on cmd_explorer_rows is ~0.07% (backfill effectively not run). Flipping the
 * flag today would 500 every name search (missing column) and, once fixed, silently miss ~99.9% of
 * patients. It requires BOTH: (1) patient_name_bidx present on the matview, and (2) the historical name
 * backfill run as the table OWNER (postgres; claims_reader has no UPDATE policy).
 *
 * ⚠ Do NOT apply migration 0067 as-authored — it is STALE (drops 0068's covering index + 0069's MAINTAIN
 * grant). The full ops analysis + the RECOMMENDED build-alongside-and-swap approach (sub-second lock, no
 * outage — supersedes the old "~90s rebuild/outage" plan) live in veris-data-notes.md → "0067 ops
 * analysis". Until Part 2 lands, the Client Name field + its divergence note are HIDDEN in the compose
 * console (3 PHI fields, not 4).
 *
 * The full code path ships behind this flag. Flipping it ALSO requires making the live count name-aware —
 * and now the readout EVIDENCE count too: BOTH QualifyMatchSummary.count (Collections' shared summary
 * builder) AND QualifyMatchSummary.distinctPatients (buildQualifyMatchClientCountQuery) run the
 * cmdExplorerBaseConds predicate, which cannot express patient_name_bidx, so both must gain the name AND
 * in lockstep or the count + gauge would over-count a name-narrowed search. See veris-data-notes.md
 * → "Qualify Client-Name (Change C) activation".
 */
export const QUALIFY_CLIENT_NAME_ENABLED = false;

/** member-id EXACT vs 3-letter alpha-PREFIX — the SNIFFED PHI-token kind (sniffed SERVER-SIDE, never
 *  client-declared). This is the kind mintToken/resolvePayer operate on; 'payer' is NOT one of them. */
export type QualifyMatchKind = 'member_id' | 'prefix';
/** How a RESOLVED payer was matched: a sniffed PHI token (member_id | prefix), 'client_name' — the
 *  exact-name blind-index path (Change C; the name itself is NEVER echoed back), OR 'payer' — the
 *  resolve-by-primary-payer label path (no PHI token; the movers/Heating-up tap). matchedOn uses this. */
export type QualifyResolvedKind = QualifyMatchKind | 'payer' | 'client_name';
/**
 * How the ONE authority read a typed handle. `kind` is the decision; `readAs` is that decision in
 * plain language, for the screen; `echo` is the only part of the input that may be rendered back.
 *
 * `echo` is PREFIX-SAFE BY CONSTRUCTION: it carries the value for a prefix (<=3 chars, non-PHI under
 * the existing contract) and is EMPTY for a member id. A full member id is PHI, so the classifier
 * refuses to hand it back — otherwise the "how we read your input" line becomes a disclosure surface
 * the moment someone renders it. `readAs` likewise never embeds the value.
 */
export interface QualifyHandleReading {
  kind: QualifyMatchKind | 'empty';
  /** Plain-language statement of the reading. Non-PHI, non-dollar — safe in a provenance string. */
  readAs: string;
  /** Prefix-safe echo: the prefix itself, or '' for a member id / empty input. */
  echo: string;
  /** The trimmed input, for blind-index minting. NOT for rendering — this can be PHI. */
  value: string;
}

/**
 * THE identifier authority (Qualify v3 / D3). Every path — client and server — resolves a typed
 * handle through this function and nothing else.
 *
 * WHY IT EXISTS. Two functions used to make this decision with different rules, and they disagreed on
 * the commonest real shape. The client's `classifyQualifyIdentifier` required /^[A-Za-z]{1,3}$/, so
 * "W26" was an exact member id and minted a `member_id_bidx` token matching NOTHING; the server's
 * `sniffQualifyKind` called it a prefix and resolved a policy, a ladder, a payer and a 28-facility
 * ranking. Result on screen: a populated policy card and a rating of 34 beside "0 charge lines match".
 * Real alpha-prefixes are overwhelmingly ALPHANUMERIC, so the letters-only rule failed on most actual
 * insurance cards while XDP and XQH happened to work — which is why it read as intermittent.
 *
 * The surviving rule is the SERVER's: trimmed length <= 3 ⇒ prefix. A digit does not demote a prefix.
 *
 * A 3-character full member id therefore reads as a prefix, deliberately: a 3-char prefix search is a
 * SUPERSET of the exact search (the 3-char prefix of a 3-char id is the id), so the member is still
 * found. Prefix-as-superset can never lose a row, whereas the old rule minted an exact token against
 * a prefix index and lost every alphanumeric case.
 *
 * Pure — no I/O, no PHI escape. `QUALIFY_PREFIX_MAX_CHARS` is the single width literal.
 */
export const QUALIFY_PREFIX_MAX_CHARS = 3;

export function classifyQualifyHandle(raw: string): QualifyHandleReading {
  const value = raw.trim();
  if (value === '') {
    return { kind: 'empty', readAs: 'no identifier entered', echo: '', value: '' };
  }
  if (value.length <= QUALIFY_PREFIX_MAX_CHARS) {
    return {
      kind: 'prefix',
      readAs: `read as a ${value.length}-character member-ID prefix`,
      echo: value,
      value,
    };
  }
  return {
    kind: 'member_id',
    // Deliberately states the LENGTH, never the value — see QualifyHandleReading.
    readAs: `read as a complete member ID (${value.length} characters)`,
    echo: '',
    value,
  };
}

/**
 * <=3 chars ⇒ alpha-prefix, else exact member-id (the searchAuditPatients precedent). Pure.
 *
 * NOT a second authority — a PROJECTION of `classifyQualifyHandle` onto the two-kind union the
 * server's mint/resolve path already speaks. It is kept because three call sites consume exactly this
 * shape and renaming them buys nothing; `qualifyHandle.test.tsx` asserts the two can never disagree.
 *
 * Empty input maps to 'prefix' to preserve the pre-v3 behaviour of this function exactly. Every caller
 * guards on an empty term before calling, so the value is unobservable — but changing it silently
 * would be a behaviour change smuggled inside a refactor.
 */
export function sniffQualifyKind(query: string): QualifyMatchKind {
  const k = classifyQualifyHandle(query).kind;
  return k === 'member_id' ? 'member_id' : 'prefix';
}

export interface QualifyResolved {
  payerName: string;
  matchedOn: QualifyResolvedKind;
  /** Non-PHI alpha-prefix echo (<=3 chars). NEVER the raw member id — the client echoes its own input. */
  matchedValue: string;
  totalCharges: number; // logical charges (rollup grain) — for an identifier search this is the SEARCHED
  // identifier's footprint (only its matched rows), NOT the whole payer's book; for the by-payer path it
  // is the payer's book. `identifierScoped` says which.
  facilityCount: number;
  windowStart: string; // ISO date (inclusive)
  windowEnd: string; // ISO date (exclusive)
  /** True when the facility ranking + counts + ratings are narrowed to the SEARCHED identifier
   *  (prefix/member/client-name) — only facilities that billed it in-window, rated on its matched claims.
   *  False on the resolve-by-payer path (Heating-Up card / on-load / URL restore), which stays payer-wide.
   *  Lets the UI caption the scope without re-deriving it from matchedOn. */
  identifierScoped: boolean;
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
  /** The other two KPI-tile metrics for THIS facility — insurance payments ÷ reliable allowed, and ÷
   *  billed (0-100, guarded; null when the denominator collapses — never a fabricated 0%). Computed
   *  server-side by the SAME expressions the book-wide tiles use, so the worst/best flanks the tiles
   *  render are the same measurement as the headline above them. NON-DOLLAR (percentages only), so
   *  they survive the amounts strip untouched and an admissions_seat derives identical flanks. */
  pctPaidOfAllowed: number | null;
  pctPaidOfBilled: number | null;
  /** Value-first rating (rating.ts, ruling 2026-07-19b) = clamp0to100(pctAllowedOfBilled) — the SORT
   *  key AND badge-color source. null → neutral badge. */
  rating: number | null;
  /** v1: ALWAYS null (ruling Q-E; the 0050 rollup can't back a faithful monthly trend). No badge. */
  streakSignal: number | null;
  billedAmount: number | null; // ALL in-window lines; null unless viewerHasAmountsCapability (stripped server-side)
  allowedAmount: number | null; // reliable-evidence sum (e2 excluded); null when zero reliable evidence OR stripped
  lineCount: number; // ALL in-window logical charge lines (volume context: floor + "limited data"; non-dollar, not tier-filtered)
  /** Distinct patients (count(distinct member_id_bidx)) backing this facility slice in-window — the
   *  RATING SAMPLE GATE unit (sampleGate.ts, hotfix 2026-07-27). Non-dollar + non-PHI (a count, the
   *  token never leaves the server) → survives the amounts strip for admissions_seat. Under a payer
   *  slice the median facility has ~2 patients, so the UI suppresses the bucket color below 3 and
   *  flags 3-9 as a thin sample; charge lines overstate the sample ~23×, hence the patient unit. */
  distinctPatients: number;
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
  /** Small NON-PHI tenant LABEL — which book this facility's rows belong to. 'Mixed' when a raw
   *  facility text carries rows from both tenants (cross-tenant interleave is intended; this is a
   *  label only, never a grouping/split). null when the rows carried no resolvable entity. */
  entity: 'BXR' | 'Indigo' | 'Mixed' | null;
  // ── Rating v2 (five-factor model; §5). All NON-DOLLAR — survive the amounts strip unchanged. ──
  /** Median days from service (charge_date) to payment (payment_received) over the in-window PAID
   *  lines — the TTP factor's input. Paid-lines-only by construction (the window is payment-dated);
   *  the factor detail discloses that rather than pretending unpaid claims are visible. */
  medianDaysToPayment: number | null;
  /** monday census aggregates (Phase G; fail-soft null until the census snapshot table is live). */
  avgAuthDays: number | null;
  avgLosDays: number | null;
  /** Next UR (utilization review) date on this facility's census, ISO — the §5 UR banner ("auth may
   *  change soon"), a banner not a factor. Null when no census data / nothing scheduled. */
  nextUrDate: string | null;
  /** Open-bed count from the census (items named "Open Bed…"). Display context only. */
  openBeds: number | null;
  /** The five-factor rating (0-100 over available weights) — the v2 SORT KEY and numeral. Null =
   *  suppressed (sample floor / no money evidence) → the honest-restraint card. */
  ratingV2: number | null;
  /** IQ verdict band ('65'|'50'|'30'|'15'|'0') — the billing team's own scale. Null when unrated. */
  iqBand: QualifyIqBand | null;
  /** The factor readings behind ratingV2 (weights, scores, directions, plain-language details) — the
   *  card's "Why this score" expansion ships its work, it never re-derives it client-side. */
  factors: QualifyFactorReading[];
  /** Sum of available factor weights (renormalization denominator) — "scored on N of 100 weighting". */
  availableWeight: number;
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
  /** This claim's PAYMENT date (payment_received), ISO 'YYYY-MM-DD' or null. Display + the drill's sort
   *  axis (the panel windows AND now orders on payment date). NON-PHI. Shown alongside dos on both surfaces. */
  paymentDate: string | null;
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

// ── Rating v2 additions (qualify-v2-build-plan §§2,5,6,7 — policy card, ladder, freshness) ────────

/** VOB data older than this (vs the max vob_created_at behind the searched prefix) renders a staleness
 *  disclosure on the policy card — the Phase 0 defence against the confidently-wrong failure mode
 *  (a silent VOB stall must be visible where the decision is made, not only in ops). In hours. */
export const QUALIFY_VOB_STALE_HOURS = 48;

/**
 * The RESOLVED POLICY strip (Phase B): what is already on file behind the searched alpha prefix, from
 * vob.member_benefits_latest — matched on the prefix BLIND INDEX (member_id_prefix_bidx; there is no
 * readable prefix column, verified 2026-08-03). Modal values across the prefix's members; the rep
 * types five characters and the plan identifies itself.
 *
 * PHI shape: carrier/employer/funding/plan levels are plan-level facts (the registry-adjacent, non-PHI
 * tier); `groupOnFile` is a PRESENCE flag only — the group number exists solely as a blind index and
 * can never be displayed. The four benefit strings are raw VOB text and dollar-bearing → nulled for
 * admissions_seat at the core's strip choke point (display-only, NEVER scored — ruled in §5).
 */
/** One value in a wire-safe spread: the value and how many members carry it. Used for CARRIERS only
 *  on the policy card — see the PHI note on QualifyPolicyCard.carriers for why employers have no
 *  equivalent. Non-PHI and dollar-free, so it is byte-identical for an admissions_seat session. */
export interface QualifyPolicySpreadEntry {
  value: string;
  members: number;
}

/** One payer behind the searched identifier, with the evidence supporting it. Plaintext
 *  primary_payer is non-PHI (same class as QualifyMover.label). Counts and a date only — never an
 *  amount — so this is identical for an admissions_seat session and safe as a rating/AI input. */
export interface QualifyPayerOption {
  payer: string;
  lines: number;
  patients: number;
  lastPayment: string | null; // ISO date of the most recent payment_received
}

export interface QualifyPolicyCard {
  found: boolean; // any VOB rows behind this prefix
  memberCount: number; // distinct members under the prefix in the VOB set
  carrier: string | null; // modal insurance_co
  employerName: string | null; // modal employer_name (display; matching uses employer_norm server-side)
  funding: string | null; // 'Self-Funded' | 'Fully Insured' (raw VOB value)
  policyType: string | null; // modal policy_type (PPO/EPO/…)
  planType: string | null; // modal plan_type
  groupOnFile: boolean; // group_number_bidx present — presence only, the raw group is unrecoverable
  /** How many DISTINCT employers / carriers sit behind this prefix — the honesty denominators for the
   *  two modal chips above. `carrier` is "1 of carrierCount"; >1 means the chip is a SLICE, not the
   *  answer. MEASURED 2026-08-06: weighted by member (how a card-in-hand search actually samples),
   *  80.5% of searches land on a multi-employer prefix and 86.8% on a multi-carrier one, and in 57%
   *  the displayed employer is a MINORITY of the prefix. Mean member-weighted dominance is 49.1% —
   *  so a bare mode with no denominator is wrong more often than right. 1 = genuinely unambiguous.
   *  0 only when the column is null for every member. */
  employerCount: number;
  carrierCount: number;
  /** The carriers behind this prefix, ranked by member count — the drill-down set for the carrier
   *  chip. Capped at QUALIFY_SPREAD_LIMIT server-side, so `carriers.length` can be < carrierCount;
   *  always render the count, never the array length, as the denominator. Empty when the spread query
   *  was unavailable (fail-soft) — an empty array means "not loaded", NOT "only one carrier".
   *
   *  ⚠ There is deliberately NO `employers` counterpart. employer_name is a PHI column
   *  (app/lib/phi.ts) and the AI payload has never carried it (src/collections/qualifyAi.ts); the
   *  employer spread is consumed SERVER-SIDE ONLY, as the comparable-cohort key. Only the COUNT
   *  crosses the wire. Do not add one. */
  carriers: QualifyPolicySpreadEntry[];
  /** Phase D INN/OON gate. ALWAYS null today: network is not extracted from the VOB (three live parser
   *  generations, none carries it — the extractor change is cross-repo work in etl/vob). The three-way
   *  flow ships now so the moment the field lands the gate lights up: INN → contracted-expectation
   *  short-circuit; OON → full model; null → full model + "network not captured on this VOB" banner. */
  network: 'INN' | 'OON' | null;
  vobFreshAsOf: string | null; // max vob_created_at (ISO date) behind this prefix
  vobStale: boolean; // vobFreshAsOf older than QUALIFY_VOB_STALE_HOURS vs "now" (Phase 0 disclosure)
  // Display-only benefit strings (raw VOB text; unparsed). Dollar-bearing → stripped (null) for
  // admissions_seat; never an input to any rating factor.
  deductible: string | null;
  deductibleMet: string | null;
  oopMax: string | null;
  oopMet: string | null;
}

/** One rung of the auto-window sufficiency ladder (Phase E). */
export interface QualifyWindowRung {
  days: QualifyTrailingDays;
  distinctPatients: number;
  sufficient: boolean; // distinctPatients >= the confident floor (sampleGate)
}

/** The resolved ladder: every rung's count (ONE bucketed query — never five round-trips) plus the
 *  window the server chose. `sufficient:false` means even 365d never reached the confident floor —
 *  the UI says so instead of silently showing a thin number. */
export interface QualifyWindowLadder {
  rungs: QualifyWindowRung[];
  chosenDays: QualifyTrailingDays;
  sufficient: boolean;
}

/** Hard PHI-audit cap for ONE audited reveal batch (revealQualifyRows). The per-patient reveal slices a
 *  patient's claim ids to this before the call, so a rare high-frequency patient (>50 in-window claims)
 *  reveals its most-recent 50 with an honest note rather than failing the batch. The SERVER enforces the
 *  same cap (core.ts) — this shared const keeps client + server in lockstep. */
export const QUALIFY_REVEAL_BATCH_CAP = 50;

export interface QualifySnapshot {
  /** null ⇒ this identifier resolved to NO claims history. Pre-v2 that always meant "VOB path"; with
   *  the policy card a null resolved now splits three ways the frontends must distinguish:
   *    resolved=null + policy?.found + facilities.length>0 → the ESTIMATED (comparable-provenance) read
   *    resolved=null + policy?.found + facilities:[]       → policy known, no evidence anywhere → VOB/biller
   *    resolved=null + (!policy || !policy.found)           → never seen at all → VOB path
   *  A non-null resolved with facilities:[] stays the distinct "payer has no facilities in this window". */
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
  // ── v2 additions (all optional-shaped via null so pre-v2 fixtures/paths stay valid) ──
  /** The resolved policy strip (Phase B). Null on non-identifier paths (resolve-by-payer/name) and
   *  when the VOB lookup is unavailable. */
  policy: QualifyPolicyCard | null;
  /** The auto-window ladder actually run for THIS snapshot (Phase E). Null when the caller passed an
   *  explicit window (manual Range) or the path carries no identifier. */
  ladder: QualifyWindowLadder | null;
  /** What the ranking's evidence is built ON (§6). 'direct' on the identifier/payer paths with own
   *  claims; 'comparable_*' when the ranking fell back to an employer/funding cohort; 'none' when
   *  there is nothing to rank on. Factor math consumes the same value — one source of truth. */
  provenance: QualifyProvenance;
  /** EVERY payer the searched identifier bills under, ranked — `resolved.payer` is element [0], not a
   *  different answer. MEASURED 2026-08-06: weighted by member, 80.6% of searches land on a prefix
   *  billing under more than one payer (max 17), so the pre-existing single-payer resolve discarded
   *  real history for four searches in five. length>1 is the signal a disambiguation step is
   *  warranted; length<=1 means the resolve was genuinely unambiguous and the UI should say so rather
   *  than prompt.
   *
   *  EMPTY ARRAY MEANS "NOT LOADED", never "one payer" — it is empty on the non-identifier paths
   *  (resolve-by-payer/name), when the identifier has no claims at all, and when the spread query
   *  fails soft. Read `resolved` for whether a payer was resolved at all. */
  payerOptions: QualifyPayerOption[];
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

/**
 * The combined ON-LOAD payload (perf): the "Heating up" movers + the auto-resolved top payer's
 * snapshot + its rank-1 facility's seed cases, computed in ONE server round-trip instead of the
 * client waterfall (movers → resolve-by-payer → seed cases = 3 serial round-trips). The server runs
 * the SAME three cores back-to-back, so audits + gating + amounts-stripping are identical; only the
 * client hops between them are removed. `snapshot`/`topPayer`/`seedFacility` are null when there are
 * no movers (empty board) — the client then shows the empty search prompt.
 */
export interface QualifyInitial {
  movers: QualifyMover[];
  topPayer: string | null; // the auto-resolved mover label (drives byPayer for window re-resolves)
  snapshot: QualifySnapshot | null;
  seedFacility: string | null; // rank-1 facilityKey the cases were seeded for
  seedCases: QualifyClaim[];
  seedCapped: boolean;
}

/**
 * Book-wide KPI percentages (redesign overview). Cross-tenant, windowed on payment_received, derived
 * IN-PLANE from the charge rollup (NO external collections join). Dollars are summed server-side and
 * NEVER returned — only these three ratios cross the wire, so an admissions_seat reads them safely
 * (non-dollar). Any ratio is null when its guarded denominator collapses (never a coerced 0%).
 */
export interface QualifyBookKpis {
  /** reliable allowed (tier e2 excluded) ÷ billed, 0-100 — the contracted-rate signal. */
  pctAllowedOfBilled: number | null;
  /** insurance_payments ÷ reliable allowed, 0-100 — collection yield ON what was allowed. */
  pctPaidOfAllowed: number | null;
  /** insurance_payments ÷ billed, 0-100 — net realization. */
  pctPaidOfBilled: number | null;
  /** Distinct patients (count(distinct member_id_bidx)) in the composed slice — the TILE sample gate
   *  (Phase 2, sampleGate.ts). Non-dollar, non-PHI count (token never leaves the server) → admissions_seat
   *  safe. Book-wide it's large (full confidence); under a payer/facility slice it can fall below the
   *  tier thresholds, at which point the tiles suppress the confident % (see BookKpiTiles). */
  distinctPatients: number;
  windowStart: string;
  windowEnd: string;
  tenantScope: typeof QUALIFY_TENANT_SCOPE;
}

/**
 * Per-facility rating TREND + prior-window delta (redesign "Facilities Heating Up" + the per-facility
 * sparklines). NON-DOLLAR (ratings only) → admissions_seat-safe. `points` is the current window sliced
 * into evenly-spaced sub-windows, each a reliable allowed% (thin buckets dropped — never fabricated),
 * oldest→newest. `deltaPts` = currentRating − priorRating (null when there is no prior-window evidence —
 * a NEW facility, sorted last). `dominantPayer` powers the Heating-Up hybrid click: resolve that payer,
 * then scope to this facility. `lineCount` is the UI's defined "n" (claim lines backing the rating).
 */
export interface QualifyFacilityTrend {
  facilityKey: string; // raw rollup facility text — the join key (== QualifyFacility.facilityKey)
  name: string;
  city: string | null;
  state: string | null;
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
  entity: 'BXR' | 'Indigo' | 'Mixed' | null;
  dominantPayer: string | null; // most-charges payer in-window — the hybrid-resolve target
  lineCount: number; // ALL current-window charge lines backing the rating (the "n")
  currentRating: number | null; // current-window reliable allowed% (0-100)
  priorRating: number | null; // prior equal-window rating (null → no prior evidence)
  deltaPts: number | null; // currentRating − priorRating (null when priorRating is null)
  points: number[]; // per-bucket ratings, oldest→newest (thin buckets dropped)
}

/**
 * Combined ON-LOAD overview payload (ONE round-trip, perf): the book-wide KPI tiles + the trending
 * facilities + the hybrid-resolved top facility's payer snapshot + that facility's seed cases. Mirrors
 * getQualifyInitial's role but overview-shaped (facility-centric, not payer-centric). `topFacility`/
 * `topPayer`/`snapshot` are null when nothing is trending (empty book) — the client shows the prompt.
 */
export interface QualifyOverview {
  kpis: QualifyBookKpis;
  trends: QualifyFacilityTrend[];
  topFacility: string | null; // trends[0].facilityKey — the hybrid focus
  topPayer: string | null; // trends[0].dominantPayer — resolved on load
  snapshot: QualifySnapshot | null;
  seedFacility: string | null;
  seedCases: QualifyClaim[];
  seedCapped: boolean;
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
 * Window bounds for EVERY QualifyWindow shape. this=[from,to); prior=[priorFrom,priorTo) is the
 * previous EQUIVALENT period (trailing: the adjacent equal-length window; month: the previous
 * calendar month; year: the previous calendar year — the ruled Δ semantics). All calendar
 * (date-only) ISO strings.
 *
 * TRAILING windows anchor "today" to the ops calendar day in QUALIFY_BUSINESS_TZ, NOT the server's
 * UTC day: Vercel runs TZ=UTC, so from ~afternoon-to-midnight Pacific the raw UTC date is already
 * tomorrow and every window would silently slide forward a day. We take the civil Y-M-D in the
 * business zone, then do plain calendar arithmetic on it. CALENDAR windows are explicit — no
 * anchoring needed. `now` is injectable so the math is unit-testable.
 */
export function qualifyWindowBounds(
  window: QualifyWindow,
  now: Date,
): { from: string; to: string; priorFrom: string; priorTo: string } {
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (window.kind === 'month') {
    const from = new Date(Date.UTC(window.year, window.month - 1, 1));
    const to = new Date(Date.UTC(window.year, window.month, 1)); // 1st of next month (Date.UTC normalizes month 12)
    const priorFrom = new Date(Date.UTC(window.year, window.month - 2, 1)); // previous month
    return { from: iso(from), to: iso(to), priorFrom: iso(priorFrom), priorTo: iso(from) };
  }
  if (window.kind === 'year') {
    const from = new Date(Date.UTC(window.year, 0, 1));
    const to = new Date(Date.UTC(window.year + 1, 0, 1));
    const priorFrom = new Date(Date.UTC(window.year - 1, 0, 1)); // previous year
    return { from: iso(from), to: iso(to), priorFrom: iso(priorFrom), priorTo: iso(from) };
  }
  const windowDays = window.days;
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
  const to = shift(anchor, 1); // exclusive upper = tomorrow, so all of today is in-window
  const from = shift(anchor, -(windowDays - 1)); // inclusive lower → exactly windowDays days
  const priorTo = from; // adjacent, non-overlapping
  const priorFrom = shift(from, -windowDays);
  return { from: iso(from), to: iso(to), priorFrom: iso(priorFrom), priorTo: iso(priorTo) };
}

/**
 * Single-identifier field → the two blind-index narrows. Exactly one is ever non-empty, so the old
 * both-identifiers dead-end stays unrepresentable.
 *
 * D3 (2026-08-05): this used to carry its OWN classification rule (/^[A-Za-z]{1,3}$/) and was the
 * losing half of the two-authority divergence — it is now a pure projection of
 * `classifyQualifyHandle`. The behaviour change is intended and is the fix: "W26" now yields
 * `alphaPrefix: 'W26'` (a prefix narrow that matches real rows) instead of `memberId: 'W26'`
 * (an exact token that matched nothing).
 */
export function qualifyIdentifierNarrows(raw: string): { memberId: string; alphaPrefix: string } {
  const h = classifyQualifyHandle(raw);
  if (h.kind === 'prefix') return { memberId: '', alphaPrefix: h.echo };
  if (h.kind === 'member_id') return { memberId: h.value, alphaPrefix: '' };
  return { memberId: '', alphaPrefix: '' };
}
