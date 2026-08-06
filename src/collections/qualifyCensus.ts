/**
 * Qualify Phase G — monday census AGGREGATION (pure logic + the sync's SQL builder). The I/O twin
 * (fetch + write) lives in qualifyCensusSync.ts; everything here is hermetically testable.
 *
 * THE PHI POSTURE, load-bearing: census board item NAMES are patient names. This module's input
 * shape (`CensusItem`) carries COLUMN VALUES ONLY — the fetch never requests the name field on a
 * census board, so patient identifiers never enter this process. Open beds are counted from the
 * Admit Status labels ('Open Bed (Male)' / '(Female)' / '(Either M/F)' — verified live 2026-08-03),
 * not from placeholder item names.
 *
 * COLUMN RESOLUTION BY TITLE, per board: monday mints per-board column ids for the same logical
 * column, and worse, CLONED boards REUSE ids across different boards (`formula_mkt29g1z` is on
 * Pacific, LAMH and Wellness Recovery; `formula_mkt2bdqf` on Lonestar, Dallas and Kentucky), so an
 * id is not a board identity in either direction. Titles are the stable key; the resolver maps
 * title -> this board's id, and the conformance report names every expected title a board lacks.
 *
 * TWO BOARD FAMILIES, AND THEIR LOS FORMULAS DIFFER BY ONE DAY. Measured on all 30 boards
 * (docs/monday-census-board-architecture.md section 2):
 *   residential (15): 'Admit Status'; discharged LOS = DAYS(dc, adm) + 1
 *   outpatient  (15): 'Status' + 'LOC'; discharged LOS = DAYS(dc, adm), NO +1
 * Applying one expression to both families is wrong on 15 boards and disagrees with what the UR
 * team reads on the board, so `computeLosDays` is family-dependent.
 *
 * LOS IS COMPUTED HERE, NOT READ FROM MONDAY. Both families hold LOS in a monday FORMULA column
 * ('Days in RTC' / 'Days in OP'), and monday's API returns `text: ""` for every formula column on
 * all 30 boards — measured 0/233 non-empty on Nashville while 'Total Auth Days' (a numbers column)
 * returned 138/233. That single fact is why `avg_los_days` was NULL for every facility and the
 * auth-fit factor read "no data yet" even where auth data was perfect. The formula's INPUTS
 * (status, 'ADM Date', 'DC Date') are plain status/date columns and read fine, so we recompute the
 * board's own expression from them. The LOS title is deliberately ABSENT from CENSUS_TITLES — see
 * the note there.
 *
 * TENANCY (deliberate exception, PR #73 review): qualify_facility_census carries NO
 * business_entity_id — it is facility-grain, non-PHI ops data keyed by
 * collections.facilities.facility_code, and the facilities table itself is entity-less (verified
 * live 2026-08-03: the per-row tenant key exists on exactly the six DATA tables). Census values
 * only ever SURFACE joined to entity-scoped ranking rows in core.ts, and the Qualify surface is
 * deliberately cross-tenant (QUALIFY_TENANT_SCOPE). Migration 0079 restates this on the SQL side.
 */

export type CensusBoardFamily = 'residential' | 'outpatient';

/**
 * One FACILITY's census configuration. Board -> facility is **N:1**, not 1:1
 * (docs/monday-census-board-architecture.md section 4), so the unit of configuration is the
 * facility and `boardIds` is a set.
 *
 * WHY N:1 IS THE GENERAL SHAPE AND NOT A TELEHEALTH SPECIAL CASE: `facility_code` is a bare
 * `text primary key` on qualify_facility_census, so two boards upserting the same code
 * LAST-WRITE-WINS — the second board silently overwrites the first rather than adding to it.
 * Onboarding only one board of a set undercounts just as silently. TELEHEALTH_MH is the live
 * instance (the parent company plus each `Telehealth MH [state]`, all billing under one CMD
 * account, 10034666, with the state entities absent from CMD); MHC of San Diego is the queued
 * second one. Items are concatenated across a facility's boards and aggregated ONCE — never an
 * average of per-board averages, which would weight a 53-item board equally with a 39-item one.
 */
export interface CensusFacilityConfig {
  /** collections.facilities.facility_code VERBATIM. */
  facilityCode: string;
  family: CensusBoardFamily;
  /** Every monday board that feeds this facility. Order is irrelevant; items are concatenated. */
  boardIds: readonly string[];
}

/**
 * The curated facility -> board[] map. Every board id, facility_code and family below was measured
 * live 2026-08-05 against the monday API across both census-bearing workspaces and against
 * collections.facilities (see docs/monday-census-board-architecture.md section 3 for the per-board
 * column registry). Adding a facility here is the entire onboarding for its auth-fit factor.
 *
 * `facilityCode` MUST be VERBATIM from collections.facilities, and the roster mixes TWO keying
 * conventions (section 5). BXR facilities are mnemonics (CAMH, PCMH, TBH, ...); Indigo facilities
 * are 8-DIGIT CMD customer ids (10021573 OPUS HEALTH, 10028595 REVIVAL, ...). A mnemonic-only
 * search of the roster finds nothing for Opus/Revival/SVR/Hillside/AMH/Modesto/MY Teen and reads as
 * "an operator must name these" — they already have codes, and the codes are 8-digit. Do NOT invent
 * a mnemonic for them: qualify_facility_census.facility_code has NO foreign key to
 * collections.facilities (0078), so a wrong code does not error — it writes an orphan row that
 * never joins to a ranking row, which is exactly the failure this comment exists to prevent.
 */
export const MONDAY_CENSUS_FACILITIES: readonly CensusFacilityConfig[] = [
  // -- residential (12 facilities; 'Admit Status'; discharged LOS carries +1) -------------------
  { facilityCode: 'PCMH', family: 'residential', boardIds: ['7046603503'] }, // Pacific Admissions Census
  { facilityCode: '10021573', family: 'residential', boardIds: ['7046827887'] }, // Opus -- OPUS HEALTH
  { facilityCode: '10028595', family: 'residential', boardIds: ['7047309383'] }, // Revival -- REVIVAL MENTAL HEALTH
  { facilityCode: 'TBH', family: 'residential', boardIds: ['7047312296'] }, // Tennessee Behavioral
  { facilityCode: 'CAMH', family: 'residential', boardIds: ['7047313870'] }, // CAMH
  { facilityCode: '10025950', family: 'residential', boardIds: ['7047316556'] }, // SVR -- SILICON VALLEY RECOVERY, LLC
  { facilityCode: '10026624', family: 'residential', boardIds: ['7047322890'] }, // Hillside -- HILLSIDE HORIZON FOR TEENS
  { facilityCode: 'NASH', family: 'residential', boardIds: ['7422342993'] }, // Nashville MH
  { facilityCode: 'LSMH', family: 'residential', boardIds: ['8401390206'] }, // Lonestar MH
  { facilityCode: 'LAMH', family: 'residential', boardIds: ['18358664283'] }, // LAMH
  { facilityCode: 'DMH', family: 'residential', boardIds: ['18394268482'] }, // Dallas MH
  { facilityCode: 'KWC', family: 'residential', boardIds: ['18400080863'] }, // Kentucky WC
  // -- outpatient (11 facilities / 12 boards; 'Status' + 'LOC'; discharged LOS has NO +1) -------
  { facilityCode: '10029528', family: 'outpatient', boardIds: ['6974268840'] }, // AMH -- ADOLESCENT MENTAL HEALTH
  { facilityCode: 'FRCA', family: 'outpatient', boardIds: ['9933183210'] }, // FRCA
  { facilityCode: 'TREAT_CA', family: 'outpatient', boardIds: ['9976711362'] },
  { facilityCode: 'TREAT_TX', family: 'outpatient', boardIds: ['9976791377'] },
  { facilityCode: 'TREAT_TN', family: 'outpatient', boardIds: ['9977175215'] },
  { facilityCode: 'TREAT_WA', family: 'outpatient', boardIds: ['9977210222'] },
  { facilityCode: 'TREAT_NV', family: 'outpatient', boardIds: ['9977268128'] },
  { facilityCode: '10034230', family: 'outpatient', boardIds: ['18391657878'] }, // MY Teen -- MY TEEN MENTAL HEALTH
  { facilityCode: '10030319', family: 'outpatient', boardIds: ['18393561198'] }, // Modesto -- MENTAL HEALTH MODESTO
  { facilityCode: 'TEEN_MH_TX', family: 'outpatient', boardIds: ['18404698218'] }, // board name has a double space; matched on id
  // THE ROLLUP: 'Telehealth MH' is the parent of each 'Telehealth MH [state]'; the states are absent
  // from CMD and all of them bill under account 10034666. Both boards are outpatient, so item-level
  // concatenation is sound and needs no schema change. More state boards are expected — a new one is
  // a one-line add to this array.
  { facilityCode: 'TELEHEALTH_MH', family: 'outpatient', boardIds: ['18394268978', '18405687473'] },
];

/**
 * Boards that exist and are healthy but must NOT be mapped: no live `collections.facilities` row.
 * Reported every run so they cannot be silently forgotten — the alternative (map anyway) writes an
 * orphan census row, because facility_code has no FK.
 *
 * Treat MH VA/CO are NOT candidates for a parent rollup. Treat is structurally the opposite of
 * Telehealth: ONE CMD account per state (TREAT_CA 10030101, TREAT_TX 10029722, TREAT_TN 10029905,
 * TREAT_WA 10031212, TREAT_NV 10034671) and there is no Treat parent row in the roster to roll into.
 * Ruling 2026-08-05: they wait for their own CMD accounts.
 */
export const CENSUS_BLOCKED_BOARDS: readonly { boardId: string; boardName: string; blocker: string }[] = [
  {
    boardId: '18424928550',
    boardName: 'North California MH Admissions Census',
    blocker:
      '10035913 / NORTHERN CALIFORNIA MENTAL HEALTH is in 0034_indigo_facilities_seed.sql but NOT in the live table (verified count=0) — file/live drift',
  },
  {
    boardId: '18419837532',
    boardName: 'Wellness Recovery Admissions Census',
    blocker:
      'WELLNESS RECOVERY CENTER LLC, CMD #10033951 — named in the 0006 header as known-but-unseeded; never seeded',
  },
  {
    boardId: '18407820613',
    boardName: 'Treat MH VA Admissions Census',
    blocker: 'no roster row and no CMD account; Treat has no parent row to roll into',
  },
  {
    boardId: '18422175778',
    boardName: 'Treat MH CO Admissions Census',
    blocker: 'no roster row and no CMD account; Treat has no parent row to roll into',
  },
];

/**
 * Boards deferred to their own scoped change: MHC of San Diego (10024431, care_setting 'BOTH') has
 * ONE BOARD PER FAMILY. Aggregating them into a single avg_los_days would average residential LOS
 * (which carries the +1) against outpatient LOS (which does not) — two different quantities. That
 * needs the census grain to become (facility_code, board_family): a migration plus a read-path
 * change in ratingV2.ts and app/lib/qualify/core.ts. CensusFacilityConfig's boardIds shape is what
 * makes that a small change later.
 */
export const CENSUS_DEFERRED_BOARDS: readonly { boardId: string; boardName: string; reason: string }[] = [
  {
    boardId: '7593076989',
    boardName: 'MHC of San Diego  Residential Admissions Census',
    reason: 'facility 10024431 is care_setting BOTH — needs the (facility_code, board_family) re-grain',
  },
  {
    boardId: '9947459669',
    boardName: 'MHC of San Diego OP Admissions Census',
    reason: 'facility 10024431 is care_setting BOTH — needs the (facility_code, board_family) re-grain',
  },
];

/**
 * Boards discovery must drop even though they look like census boards. Excluded BY ID, because
 * name-matching would be the same guesswork this registry replaced.
 */
export const CENSUS_EXCLUDED_BOARD_IDS: readonly string[] = [
  '2968782313', // MHC Outpatient Census -- 2023-vintage schema ('Actual Adm', DC on date9, no Total Auth Days / Next UR Date / LOS). Member of neither family.
  '2968782440', // MHC Outpatient UR -- not a census board
  '9947448656', // Demo Final RTC Admissions Census -- private demo workspace 12357386
  '9947456861', // Demo OP Admissions Census -- private demo workspace 12357386
];

/** Workspaces that hold census boards. `MHC PHP/IOP` is invisible to a pass over Main alone. */
export const CENSUS_WORKSPACE_IDS: readonly string[] = [
  '2613676', // A. Admissions (Main) -- 128 boards, so page 2 is mandatory
  '1717903', // MHC PHP/IOP -- holds the two MHC boards
];

/** The Facility Info board (facility-grain — item names are FACILITY names, not patients). */
export const MONDAY_FACILITY_INFO_BOARD = '7475219124';

/**
 * LICENSED BED COUNT per facility — the CURATED source of truth, operator-supplied 2026-08-05.
 *
 * WHY CURATED RATHER THAN READ FROM THE BOARD. Capacity was being name-matched against the
 * `Facility Info` board, and that had failed three different ways at once: the map held only two
 * keys so 21 facilities wrote `bed_capacity = NULL`, and where it DID match the board was stale.
 * Measured against the operator's list on 2026-08-05, the board disagrees on three facilities:
 *
 *   Nashville   board  8  ->  20   (corroborated by the NASH board's OWN group titles,
 *                                   'Broad St (8 Beds COED)' + 'Rutland Rd (12 Beds COED)' = 20 —
 *                                   the board item was only ever counting one house)
 *   Opus        board 18  ->  12
 *   Hillside    board 18  ->  17
 *
 * Board total 174 vs the operator's 179; those three deltas (-6 +12 -1 = +5) account for the gap
 * exactly, which is what makes this a correction rather than two guesses.
 *
 * Bed count is licensure, not telemetry — it changes when a facility opens or closes a house, which
 * is a deliberate business event, not a daily drift. An explicit reviewable constant is the right
 * shape for that; a silent name-match against an unmaintained board is not. The board is still read
 * as a FALLBACK for a facility absent from this map, and its unmapped names are still reported.
 *
 * OUTPATIENT FACILITIES ARE DELIBERATELY ABSENT: they have no beds. `bed_capacity` stays NULL for
 * them, which is correct, not missing.
 */
// `number | undefined` deliberately: app tsc lacks noUncheckedIndexedAccess, so a plain
// Record<string, number> would type a miss as `number` and make the `?? board` fallback read as dead
// code in the app package while only root tsc told the truth.
export const FACILITY_BED_CAPACITY: Readonly<Record<string, number | undefined>> = {
  // residential, mapped and synced
  CAMH: 12,
  DMH: 12,
  KWC: 16,
  LAMH: 6,
  LSMH: 12,
  NASH: 20,
  PCMH: 6,
  TBH: 8,
  '10021573': 12, // Opus Health
  '10025950': 16, // Silicon Valley Recovery
  '10026624': 17, // Hillside Horizon for Teens
  '10028595': 12, // Revival Mental Health
  // residential, NOT synced — recorded so the number is not lost when they are onboarded.
  '10024431': 24, // MHC of San Diego — DEFERRED (care_setting BOTH; needs the census re-grain)
  // Wellness Recovery Center (6 beds) has no collections.facilities row at all, so it has no
  // facility_code to key on here. It stays in CENSUS_BLOCKED_BOARDS until it is seeded.
};

/**
 * Logical column titles per family. The resolver matches case-insensitively on trimmed titles.
 *
 * THERE IS DELIBERATELY NO `los` ENTRY. Nothing reads the LOS formula column any more
 * (`computeLosDays` recreates it from its inputs), and keeping the title here would be actively
 * harmful: `MHC of San Diego OP Admissions Census` (9947459669) has its LOS column MIS-TITLED
 * 'Days in RTC' while carrying the outpatient column ids, the outpatient status input and the
 * outpatient formula body with no +1. Structure and semantics say outpatient; the title lies.
 * Because we no longer read that column, the mislabel is harmless — but listing 'Days in OP' as an
 * expected title would report a permanent, unfixable conformance gap on that board forever.
 *
 * `adm`/`dc` are the LOS inputs. 'ADM Date' is column id `date` on all 30 boards and 'Total Auth
 * Days' is a numbers column on all 30, but both are still resolved BY TITLE — see the id-collision
 * note in the file header.
 */
export const CENSUS_TITLES = {
  residential: { status: 'Admit Status', adm: 'ADM Date', dc: 'DC Date' },
  outpatient: { status: 'Status', adm: 'ADM Date', dc: 'DC Date' },
  universal: { auth: 'Total Auth Days', ur: 'Next UR Date' },
} as const;

/**
 * Titles that must be PRESENT for a board to structurally belong to its declared family. This is
 * the check that catches a board mapped to the wrong family — which matters precisely because the
 * two families' LOS expressions differ by a day, so a misdeclared family is a silent one-day error
 * rather than a crash.
 *
 * `IQ` is deliberately NOT a discriminator: MHC Residential (7593076989) has no IQ column, so
 * requiring it would fail a legitimate residential board.
 */
export const CENSUS_FAMILY_SIGNATURE: Record<CensusBoardFamily, readonly string[]> = {
  residential: ['Admit Status'],
  outpatient: ['Status', 'LOC'],
};

/** care_setting each family must correspond to. Verified on all 24 mapped boards, zero exceptions. */
export const CENSUS_FAMILY_CARE_SETTING: Record<CensusBoardFamily, 'IP' | 'OP'> = {
  residential: 'IP',
  outpatient: 'OP',
};

export interface BoardColumn {
  id: string;
  title: string;
}

export interface ResolvedCensusColumns {
  statusId: string | null;
  authId: string | null;
  admId: string | null;
  dcId: string | null;
  urId: string | null;
  /** Expected titles this board does NOT carry — the conformance report's raw material. */
  missing: string[];
  /** Set when the board's columns contradict its DECLARED family (a mapping error, not a gap). */
  familyMismatch: string | null;
}

/** Resolve a board's per-board column ids from its logical titles, and check its family. Pure. */
export function resolveCensusColumns(columns: BoardColumn[], family: CensusBoardFamily): ResolvedCensusColumns {
  const byTitle = new Map(columns.map((c) => [c.title.trim().toLowerCase(), c.id]));
  const find = (title: string): string | null => byTitle.get(title.toLowerCase()) ?? null;
  const t = CENSUS_TITLES[family];
  const wanted = [t.status, t.adm, t.dc, CENSUS_TITLES.universal.auth, CENSUS_TITLES.universal.ur];
  const missing = wanted.filter((x) => !byTitle.has(x.toLowerCase()));

  // Structural family assertion. A board is only the family we DECLARED if it carries that family's
  // signature columns; the LOS column's title cannot be trusted for this (see CENSUS_TITLES).
  const absentSignature = CENSUS_FAMILY_SIGNATURE[family].filter((x) => !byTitle.has(x.toLowerCase()));
  const other: CensusBoardFamily = family === 'residential' ? 'outpatient' : 'residential';
  const looksLikeOther = CENSUS_FAMILY_SIGNATURE[other].every((x) => byTitle.has(x.toLowerCase()));
  const familyMismatch =
    absentSignature.length === 0
      ? null
      : `declared ${family} but lacks ${absentSignature.join(' + ')}${
          looksLikeOther ? ` (carries the ${other} signature instead)` : ''
        }`;

  return {
    statusId: find(t.status),
    authId: find(CENSUS_TITLES.universal.auth),
    admId: find(t.adm),
    dcId: find(t.dc),
    urId: find(CENSUS_TITLES.universal.ur),
    missing,
    familyMismatch,
  };
}

/** One census item's RESOLVED column values (no name, no id — nothing patient-identifying). */
export interface CensusItem {
  status: string | null; // 'Admit Status' / 'Status' label text
  authDays: number | null; // 'Total Auth Days' numeric
  admDate: string | null; // 'ADM Date' ISO 'YYYY-MM-DD' — a LOS input
  dcDate: string | null; // 'DC Date' ISO 'YYYY-MM-DD' — a LOS input
  urDate: string | null; // 'Next UR Date' ISO 'YYYY-MM-DD'
}

export interface CensusAggregates {
  admittedCount: number;
  openBeds: number;
  avgAuthDays: number | null;
  avgLosDays: number | null;
  authSample: number;
  losSample: number;
  /** Admitted OUTPATIENT items dropped from the LOS population as not-billed (see isBilledForAuthFit).
   *  Observability only — nothing scores off it, but a facility that suddenly excludes everyone is a
   *  board-hygiene problem worth seeing rather than a facility with no length of stay. */
  losUnbilledExcluded: number;
  /** Admitted items that PASSED the billed gate but produced no usable LOS — no ADM date, discharged
   *  with no DC date, or an unparseable/negative span (see computeLosDays).
   *
   *  This category exists because reporting only `losSample` and `losUnbilledExcluded` invites the
   *  reader to conclude they sum to `admittedCount`, and they do not. With all three named the
   *  partition is EXHAUSTIVE and the identity below holds, which is what a test can pin:
   *
   *      admittedCount === losSample + losUnbilledExcluded + losUncomputable
   *
   *  It also points at a different owner than the other two: unbilled is an outpatient
   *  data-maintenance question, uncomputable is ADM/DC hygiene on any board. */
  losUncomputable: number;
  nextUrDate: string | null;
}

/**
 * Does this admitted item belong in the AUTH/LOS metric at all?
 *
 * RESIDENTIAL: always. A bed night is billed; there is no meaningful unbilled resident.
 *
 * OUTPATIENT: only when the item carries a `Total Auth Days` value OR a `Next UR Date`. Those two
 * columns are the board's own "this patient is being billed / is under utilization review" signal
 * (ruling 2026-08-05). Outpatient enrollment is NOT the same quantity as an authorized episode —
 * a cash-pay or self-pay client can stay enrolled indefinitely with no payer involvement at all —
 * so averaging their length of stay against authorized days compares two unrelated things.
 *
 * The measured consequence of not doing this: FRCA showed avg LOS 223.9 days against 86 authorized,
 * TREAT_CA 109.1 vs 43, TREAT_TX 81.4 vs 30. `authFit` penalises overrun, so all three scored 0 —
 * a full 10-weight-point penalty manufactured out of clients the payer was never billed for.
 *
 * SCOPE, deliberately narrow: this gate applies to the auth/LOS FACTOR ONLY. An excluded client is
 * still in admittedCount and open-bed context, and is untouched in every claims-derived factor
 * (claims reliability, time-to-payment, data confidence, coding) — those read charge lines, not the
 * census, so a client with no auth but real billed claims still scores on all of them.
 */
export function isBilledForAuthFit(family: CensusBoardFamily, item: CensusItem): boolean {
  if (family === 'residential') return true;
  const hasAuth = item.authDays !== null && Number.isFinite(item.authDays) && item.authDays > 0;
  const hasUr = typeof item.urDate === 'string' && item.urDate.trim() !== '';
  return hasAuth || hasUr;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whole-day difference `to - from`, matching monday's `DAYS()`: both operands are calendar dates, so
 * the arithmetic is done in UTC on midnight-anchored values. Using a local-timezone Date here would
 * make the result depend on the server's offset and could be off by one across a DST boundary.
 * Returns null on an unparseable operand rather than NaN.
 */
export function daysBetweenUtc(fromIso: string, toIso: string): number | null {
  const a = fromIso.trim().match(ISO_DATE);
  const b = toIso.trim().match(ISO_DATE);
  if (!a || !b) return null;
  const from = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const to = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((to - from) / 86_400_000);
}

/**
 * Recompute the board's own LOS formula from its inputs, family-dependent.
 *
 * The two bodies, read from `columns.settings_str` on all 30 boards:
 *   residential: IF(status = "Discharged", Add(ROUND(DAYS(dc, adm), 0), 1), ROUND(DAYS(TODAY(), adm), 0))
 *   outpatient:  IF(status = "Discharged",     ROUND(DAYS(dc, adm), 0),     ROUND(DAYS(TODAY(), adm), 0))
 *
 * The ONLY difference is the residential `+1` (an inclusive-of-both-days count on a bed night).
 * Getting it wrong overstates outpatient LOS by a day on 15 boards and makes our number disagree
 * with what the UR team reads on the board — a disagreement nobody would trace back to here.
 *
 * Null rules, deliberately conservative: no ADM date -> null (there is no anchor, so any number
 * would be invented); discharged with no DC date -> null (the stay has a known end we cannot see,
 * and measuring it to TODAY would inflate it without bound). Both are excluded from the average
 * rather than counted as zero.
 */
export function computeLosDays(
  family: CensusBoardFamily,
  status: string | null,
  admIso: string | null,
  dcIso: string | null,
  todayIso: string,
): number | null {
  if (!admIso) return null;
  const discharged = (status ?? '').trim().toLowerCase() === 'discharged';
  if (discharged) {
    if (!dcIso) return null;
    const d = daysBetweenUtc(admIso, dcIso);
    if (d === null) return null;
    return family === 'residential' ? d + 1 : d;
  }
  return daysBetweenUtc(admIso, todayIso);
}

/**
 * Aggregate one FACILITY's items — concatenated across every board that feeds it — to the
 * facility-grain row. Rules (recon-verified):
 *  - admitted = status label exactly 'Admitted'.
 *  - open beds = status label starting 'Open Bed' (never item names).
 *  - avg auth = over ADMITTED items with a real auth value.
 *  - avg LOS = over ADMITTED, BILLED items whose LOS is computable (see isBilledForAuthFit and
 *    computeLosDays). Negative values are dropped: a DC date before the ADM date is a data-entry
 *    error on the board, not a stay.
 *  - next UR = the SOONEST date on or after `today` across ALL items (a UR on a pending admit still
 *    matters); past dates never surface as "upcoming".
 *
 * `family` is required because LOS is computed here and the two families' formulas differ.
 */
export function aggregateCensusItems(
  items: CensusItem[],
  today: string,
  family: CensusBoardFamily,
): CensusAggregates {
  const admitted = items.filter((i) => (i.status ?? '').trim().toLowerCase() === 'admitted');
  const openBeds = items.filter((i) => (i.status ?? '').trim().toLowerCase().startsWith('open bed')).length;
  const withAuth = admitted.filter(
    (i) => i.authDays !== null && Number.isFinite(i.authDays) && (i.authDays as number) > 0,
  );
  // The LOS population is the BILLED admitted set, which for residential is all of them and for
  // outpatient is those carrying an auth or a UR date. Comparing a cash-pay client's open-ended
  // enrolment against authorized days is not an overrun, it is a category error.
  const billed = admitted.filter((i) => isBilledForAuthFit(family, i));
  const losValues = billed
    .map((i) => computeLosDays(family, i.status, i.admDate, i.dcDate, today))
    .filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  const upcoming = items
    .map((i) => i.urDate)
    .filter((d): d is string => typeof d === 'string' && ISO_DATE.test(d) && d >= today)
    .sort();
  return {
    admittedCount: admitted.length,
    openBeds,
    avgAuthDays:
      withAuth.length > 0 ? round2(withAuth.reduce((s, i) => s + (i.authDays as number), 0) / withAuth.length) : null,
    avgLosDays: losValues.length > 0 ? round2(losValues.reduce((s, v) => s + v, 0) / losValues.length) : null,
    authSample: withAuth.length,
    losSample: losValues.length,
    losUnbilledExcluded: admitted.length - billed.length,
    losUncomputable: billed.length - losValues.length,
    nextUrDate: upcoming[0] ?? null,
  };
}

/**
 * Which resolved columns came back with ZERO non-empty values across a board's items.
 *
 * THIS IS THE CHECK THAT WAS MISSING. `resolveCensusColumns` asserts title PRESENCE only, so the
 * API-empty LOS formula column passed conformance on every run — `conformance_gap_boards: 0` was
 * reported against a column that was 100% empty. Title presence is necessary and not sufficient; a
 * column that resolves and never carries a value is indistinguishable, downstream, from a column
 * that does not exist.
 *
 * Only meaningful with at least one item: on an empty board every column is trivially empty, which
 * is a board state, not a column defect. The caller guards on that.
 */
export function emptyResolvedColumns(
  rows: ReadonlyArray<Record<string, string | null>>,
  resolved: ReadonlyArray<{ title: string; id: string | null }>,
): string[] {
  const out: string[] = [];
  for (const { title, id } of resolved) {
    if (id === null) continue; // already reported as missing
    const anyValue = rows.some((r) => {
      const v = r[id];
      return v !== null && v !== undefined && v.trim() !== '';
    });
    if (!anyValue) out.push(title);
  }
  return out;
}

/**
 * Conformance line for ONE FACILITY (not one board — a facility can have several).
 * `missingTitles` / `emptyTitles` / `familyMismatch` / `settingMismatch` are four distinct operator
 * responses, so they are recorded separately rather than collapsed into one flag.
 */
export interface CensusConformance {
  facilityCode: string;
  family: CensusBoardFamily;
  /** EVERY board that fed this facility's row — the run report must name them all. */
  boardIds: string[];
  itemCount: number;
  /** The LOS population, partitioned EXHAUSTIVELY so nobody has to subtract:
   *  `admittedCount === losSample + losUnbilledExcluded + losUncomputable`.
   *
   *  Reported, NOT a gap: an admitted client with no ADM date yet is ordinary, and demoting every
   *  run to 'partial' for it would make the status meaningless. These carry the board-hygiene signal
   *  ("avg LOS over 3 of 54") that decides whether a facility's auth-fit number is worth reading. */
  admittedCount: number;
  losSample: number;
  losUnbilledExcluded: number;
  losUncomputable: number;
  /** Expected titles that did not resolve on at least one board. */
  missingTitles: string[];
  /** Titles that resolved but carried zero values across every item. */
  emptyTitles: string[];
  /** The board's columns contradict its declared family. */
  familyMismatch: string | null;
  /** family <-> care_setting violated (or care_setting is BOTH / absent). */
  settingMismatch: string | null;
}

/** True when this facility's line records anything an operator needs to act on. */
export function conformanceHasGap(c: CensusConformance): boolean {
  return (
    c.missingTitles.length > 0 || c.emptyTitles.length > 0 || c.familyMismatch !== null || c.settingMismatch !== null
  );
}

/**
 * Check the free invariant family <-> care_setting (residential<->IP, outpatient<->OP). It holds on
 * all 24 mapped boards, so a violation means a board was mapped to the wrong facility.
 *
 * 'BOTH' is a reportable EXCEPTION, not a pass: the only BOTH facility is 10024431 (MHC), which is
 * exactly the facility with one board per family and is deferred for that reason. If it ever gets
 * mapped without the re-grain, this says so instead of quietly averaging two different quantities.
 * An absent care_setting is likewise reported — it means the roster row is missing or unclassified.
 */
export function checkCareSetting(family: CensusBoardFamily, careSetting: string | null | undefined): string | null {
  const expected = CENSUS_FAMILY_CARE_SETTING[family];
  if (careSetting === null || careSetting === undefined || careSetting.trim() === '') {
    return `no care_setting on the roster row (expected ${expected} for a ${family} board)`;
  }
  const actual = careSetting.trim().toUpperCase();
  if (actual === 'BOTH') {
    return 'care_setting BOTH — one avg_los_days cannot mix residential (+1) and outpatient LOS; needs the (facility_code, board_family) re-grain';
  }
  return actual === expected ? null : `care_setting ${actual} but a ${family} board expects ${expected}`;
}

/** UPSERT one facility's aggregate row. Values are $n params; identifiers fixed literals. */
export function buildUpsertCensusRowQuery(row: {
  facility_code: string;
  /** ONE member of the facility's board set — the lowest id, for determinism. The column predates
   *  N:1 and is `text not null`, so it cannot hold the set; the full set is reported per run by
   *  CensusConformance.boardIds. Widening this to `board_ids text[]` is a migration we deliberately
   *  did not spend here, because nothing reads board_id. */
  board_id: string;
  board_family: CensusBoardFamily;
  admitted_count: number;
  open_beds: number | null;
  bed_capacity: number | null;
  avg_auth_days: number | null;
  avg_los_days: number | null;
  auth_sample: number;
  /** 0088. Pairs with auth_sample so the rating can gate on min(auth, los) rather than one side. */
  los_sample: number;
  next_ur_date: string | null;
}): { sql: string; params: unknown[] } {
  return {
    sql:
      'insert into collections.qualify_facility_census ' +
      '(facility_code, board_id, board_family, admitted_count, open_beds, bed_capacity, avg_auth_days, avg_los_days, auth_sample, los_sample, next_ur_date, synced_at) ' +
      'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, now()) ' +
      'on conflict (facility_code) do update set ' +
      'board_id = excluded.board_id, board_family = excluded.board_family, admitted_count = excluded.admitted_count, ' +
      'open_beds = excluded.open_beds, bed_capacity = excluded.bed_capacity, avg_auth_days = excluded.avg_auth_days, ' +
      'avg_los_days = excluded.avg_los_days, auth_sample = excluded.auth_sample, los_sample = excluded.los_sample, ' +
      'next_ur_date = excluded.next_ur_date, synced_at = now()',
    params: [
      row.facility_code,
      row.board_id,
      row.board_family,
      row.admitted_count,
      row.open_beds,
      row.bed_capacity,
      row.avg_auth_days,
      row.avg_los_days,
      row.auth_sample,
      row.los_sample,
      row.next_ur_date,
    ],
  };
}

/**
 * Order two monday board ids NUMERICALLY, not lexicographically.
 *
 * `Array.sort()` with no comparator sorts by UTF-16 code unit, which is NOT numeric order for
 * mixed-length digit strings: '18394268978' sorts BEFORE '7046603503' because '1' < '7'. The
 * registry holds both 10- and 11-digit ids, so a lexicographic "lowest" would be wrong the moment a
 * facility mixed widths — today's only multi-board facility happens to have two 11-digit ids, which
 * is exactly the kind of accident that hides a broken contract until it doesn't.
 *
 * Length-then-lexicographic IS numeric order for non-negative integers without leading zeros, which
 * is what monday ids are. Chosen over BigInt because it cannot throw on an unexpected non-numeric id
 * — such an id falls through to a plain lexicographic compare, so the result stays deterministic
 * rather than crashing the sync.
 */
function compareBoardIds(a: string, b: string): number {
  const bothNumeric = /^\d+$/.test(a) && /^\d+$/.test(b);
  if (bothNumeric && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The NUMERICALLY lowest board id in a facility's set — the deterministic representative stored in
 *  board_id. Deterministic is the load-bearing property (the column can only hold one of the set);
 *  "lowest" is just how that one is chosen, and compareBoardIds makes the claim true. */
export function representativeBoardId(boardIds: readonly string[]): string {
  return [...boardIds].sort(compareBoardIds)[0] ?? '';
}

/**
 * Minimum number of computable LOS values before an average is worth scoring.
 *
 * A mean over one or two stays is noise, and the auth/LOS factor carries 10 of 100 weight points —
 * enough for a two-row sample to move a facility's band. Set to 3 to match the lower tier of the
 * repo's existing patient-count idiom (`sampleGate.ts`, tiers 3 / 10) rather than inventing a third
 * threshold. Below the floor the average is written NULL, which renders the factor unavailable and
 * renormalizes its weight away — no score, rather than a confident wrong one.
 */
export const QUALIFY_LOS_MIN_SAMPLE = 3;

/** Read every facility's census aggregates (the rating factor's seam — tiny table, whole read).
 *  `board_family` rides along because the rating suppresses auth/LOS for outpatient outright. */
export function buildQualifyCensusReadQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      'select facility_code, board_family, avg_auth_days::float8 as avg_auth_days, avg_los_days::float8 as avg_los_days, ' +
      'auth_sample, los_sample, ' +
      "to_char(next_ur_date, 'YYYY-MM-DD') as next_ur_date, open_beds " +
      'from collections.qualify_facility_census',
    params: [],
  };
}

/** care_setting per configured facility_code — the input to checkCareSetting. Fixed literals only. */
export function buildFacilityCareSettingQuery(facilityCodes: readonly string[]): { sql: string; params: unknown[] } {
  return {
    sql: 'select facility_code, care_setting from collections.facilities where facility_code = any($1::text[])',
    params: [[...facilityCodes]],
  };
}
