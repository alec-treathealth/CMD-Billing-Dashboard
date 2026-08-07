/**
 * CARRIER NAME CLUSTERING — collapse "the same payer, spelled 13 ways" into one tile.
 *
 * WHY. Measured on a live prefix 2026-08-06, the payer stage rendered THIRTEEN carrier tiles that
 * were all Anthem Blue Cross of California: "Anthem Blue Cross of California", "ANTHEM BCBS OF
 * CALIFORNIA", "ANTHEM CA", "BC CA", "ANTHEM BLUE CROSS OF CALIFONIA" (typo), "ANTHEM BLUE CROSS OF
 * CALIFRONIA" (transposition), and so on. A rep on a phone call cannot answer "which carrier is on
 * the card?" from that list — the list IS the noise.
 *
 * ┌─ THIS IS DISPLAY GROUPING. IT NEVER ESTABLISHES PAYER IDENTITY. ──────────────────────────────┐
 * │ Payer identity lives in `ref.payer_alias_map`, CONFIRMED rows only, and this repo's standing   │
 * │ rule is that a machine proposal may never resolve a payer. So the crosswalk always wins here:  │
 * │                                                                                                │
 * │   · Two variants carrying DIFFERENT non-null canonicalPayerIds are NEVER merged, however alike │
 * │     their text. The alias map has already ruled they are different payers.                     │
 * │   · A cluster's pick target is its CONFIRMED member when it has one, so the ranking downstream │
 * │     is scoped by a confirmed alias set, exactly as before.                                     │
 * │   · Folding unconfirmed spellings in is a VISUAL convenience, and the tile says so — it counts │
 * │     them separately (`unconfirmedSpellings`) so the screen can state which members actually    │
 * │     carry confirmed evidence.                                                                  │
 * │                                                                                                │
 * │ The real fix is seeding the alias map. This makes the screen usable meanwhile; it is not a      │
 * │ substitute, and it must never be turned into one by having the ranking read a cluster.          │
 * └────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * WHY TOKEN SETS RATHER THAN STRING SIMILARITY. Whole-string edit distance is unsafe on payer names:
 * "UMR" and "UHC" are two characters apart and are different companies. Worse, the abbreviation
 * expansions that make "ANTHEM BCBS OF CA" match "Anthem Blue Cross of California" push the two
 * strings ELEVEN characters apart, so distance alone both over-merges the short names and
 * under-merges the ones that matter. Token sets plus a narrow filler rule handles both.
 *
 * THE SAFETY CASE THIS IS DESIGNED AROUND: in California, "Anthem Blue Cross" and "Blue Shield of
 * California" are DIFFERENT companies. {BLUE,CROSS,CALIFORNIA} and {BLUE,SHIELD,CALIFORNIA} are not
 * in a subset relation, so they never merge. A test pins that. Any future loosening of these rules
 * has to keep that pair apart.
 *
 * Pure module — no I/O, no server imports. Client components may import it.
 */

/** Tokens that carry no distinguishing information in a payer name. */
const NOISE = new Set(['OF', 'THE', 'AND', 'INC', 'LLC', 'LP', 'CO', 'CORP', 'COMPANY', 'PLAN', 'PLANS']);

/** "BLUE" alone distinguishes nothing — every Blue plan has it. Always filler. */
const BLUE = new Set(['BLUE']);

/**
 * CROSS / SHIELD — filler ONLY when the two names share a company anchor, and distinguishing
 * otherwise. This is the whole safety argument, so it is worth stating plainly:
 *
 *   · WITH an anchor: "Anthem Blue Cross of California" and "ANTHEM BCBS OF CALIFORNIA" are the same
 *     company. Nobody writing "Anthem BCBS" means Blue Shield of California — that is not an Anthem
 *     company. Here CROSS/SHIELD is manual-entry noise and merging is correct.
 *   · WITHOUT an anchor: "BLUE CROSS CA" and "BLUE SHIELD CA" are DIFFERENT COMPANIES, and
 *     CROSS/SHIELD is the only signal distinguishing them. Merging would be a real error.
 *
 * Any future loosening must keep that second pair apart; a test pins it.
 */
const BLUE_TYPE = new Set(['CROSS', 'SHIELD']);

/** Geography is not a company anchor — "…of California" says nothing about who the payer is. */
const STATE_NAMES: ReadonlySet<string> = new Set([
  'ALABAMA', 'ALASKA', 'ARIZONA', 'ARKANSAS', 'CALIFORNIA', 'COLORADO', 'CONNECTICUT', 'DELAWARE',
  'COLUMBIA', 'FLORIDA', 'GEORGIA', 'HAWAII', 'IDAHO', 'ILLINOIS', 'INDIANA', 'IOWA', 'KANSAS',
  'KENTUCKY', 'LOUISIANA', 'MAINE', 'MARYLAND', 'MASSACHUSETTS', 'MICHIGAN', 'MINNESOTA',
  'MISSISSIPPI', 'MISSOURI', 'MONTANA', 'NEBRASKA', 'NEVADA', 'HAMPSHIRE', 'JERSEY', 'MEXICO',
  'YORK', 'CAROLINA', 'DAKOTA', 'OHIO', 'OKLAHOMA', 'OREGON', 'PENNSYLVANIA', 'ISLAND',
  'TENNESSEE', 'TEXAS', 'UTAH', 'VERMONT', 'VIRGINIA', 'WASHINGTON', 'WISCONSIN', 'WYOMING',
  'NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL',
]);

/** Abbreviation expansions. Applied per-token, before noise removal. */
const EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  BCBS: ['BLUE', 'CROSS', 'SHIELD'],
  BCBSA: ['BLUE', 'CROSS', 'SHIELD'],
  BC: ['BLUE', 'CROSS'],
  BS: ['BLUE', 'SHIELD'],
  BX: ['BLUE', 'CROSS'],
  UHC: ['UNITED', 'HEALTHCARE'],
  UBH: ['UNITED', 'BEHAVIORAL', 'HEALTH'],
  BH: ['BEHAVIORAL', 'HEALTH'],
  HP: ['HEALTH'],
  MH: ['MENTAL', 'HEALTH'],
};

/**
 * US state/territory codes → the state's DISTINGUISHING TOKENS, so "ANTHEM CA" and
 * "Anthem … California" agree. Multi-token on purpose for the directional states — see below.
 */
const STATES: Readonly<Record<string, readonly string[]>> = {
  AL: ['ALABAMA'], AK: ['ALASKA'], AZ: ['ARIZONA'], AR: ['ARKANSAS'], CA: ['CALIFORNIA'],
  CO: ['COLORADO'], CT: ['CONNECTICUT'], DE: ['DELAWARE'], DC: ['COLUMBIA'], FL: ['FLORIDA'],
  GA: ['GEORGIA'], HI: ['HAWAII'], ID: ['IDAHO'], IL: ['ILLINOIS'], IN: ['INDIANA'], IA: ['IOWA'],
  KS: ['KANSAS'], KY: ['KENTUCKY'], LA: ['LOUISIANA'], ME: ['MAINE'], MD: ['MARYLAND'],
  MA: ['MASSACHUSETTS'], MI: ['MICHIGAN'], MN: ['MINNESOTA'], MS: ['MISSISSIPPI'],
  MO: ['MISSOURI'], MT: ['MONTANA'], NE: ['NEBRASKA'], NV: ['NEVADA'], NH: ['HAMPSHIRE'],
  NJ: ['JERSEY'], NM: ['MEXICO'], NY: ['YORK'], NC: ['NORTH', 'CAROLINA'],
  ND: ['NORTH', 'DAKOTA'], OH: ['OHIO'], OK: ['OKLAHOMA'], OR: ['OREGON'], PA: ['PENNSYLVANIA'],
  RI: ['ISLAND'], SC: ['SOUTH', 'CAROLINA'], SD: ['SOUTH', 'DAKOTA'], TN: ['TENNESSEE'],
  TX: ['TEXAS'], UT: ['UTAH'], VT: ['VERMONT'], VA: ['VIRGINIA'], WA: ['WASHINGTON'],
  WV: ['WEST', 'VIRGINIA'], WI: ['WISCONSIN'], WY: ['WYOMING'],
};

/**
 * ⚠ THE DIRECTION WORD IS LOAD-BEARING — it is the only thing separating four pairs of real,
 * different payers. NC/SC both used to expand to bare CAROLINA and ND/SD to bare DAKOTA, so
 * "BCBS NC" and "BCBS SC" both reduced to {BLUE,CROSS,SHIELD,CAROLINA} and merged into one tile.
 * WV/VA had the same collision via bare VIRGINIA.
 *
 * A previous version of this comment claimed the collision was "not reachable today (the roster is
 * CA/TN/TX/KY/NV/WA/MO)". That was WRONG, and it was wrong because it reasoned from the FACILITY
 * roster — where our facilities are — rather than from the PAYER book, which is national. Measured
 * live 2026-08-06 against 32,372 VOBs, the collision was firing on three tiles:
 *
 *   BCBS NC(51) + BCBS OF NC(28) + BCBS SC(27) + BCBS OF SC(15)  → one tile, two payers, 121 VOBs
 *   BCBS OF ND(7) + BCBS ND(6) + BCBS SD(1)                       → one tile, two payers,  14 VOBs
 *   ANTHEM BCBS OF NC(2) + ANTHEM BC OF SC(1)                     → one tile, two payers,   3 VOBs
 *
 * Carrying the direction word fixes a SECOND, quieter defect at the same time: state tokens are part
 * of the core (see `sameCarrier`), and the core is compared by cardinality first, so the abbreviated
 * form never merged with its own spelled-out form — {ANTHEM,CAROLINA} (2 tokens) could not equal
 * {ANTHEM,NORTH,CAROLINA} (3). "BCBS NC" and "BCBS OF NORTH CAROLINA" were two tiles. Now both
 * produce three tokens and correctly become one.
 *
 * Deriving the tokens rather than listing exceptions is what keeps this true: any future
 * direction-prefixed state is correct by construction. NORTH/SOUTH/WEST are already in STATE_NAMES,
 * so `anchorsOf` still reads them as geography and no company anchor changes.
 *
 * These are the codes whose expansion carries more than one token — i.e. the ones that would
 * collide if flattened back to a single word. Kept exported as executable documentation of the
 * hazard; `test/carrierCluster.test.tsx` asserts each pair stays apart.
 */
export const DIRECTIONAL_STATE_CODES: readonly string[] = ['NC', 'ND', 'SC', 'SD', 'WV'];

/** Minimum token length for typo-tolerant matching. Below this, one edit is a different word. */
export const FUZZY_MIN_LEN = 6;

/**
 * Optimal string alignment distance (Damerau-Levenshtein restricted to adjacent transpositions),
 * with an early bail at `max`. Transpositions matter: "CALIFRONIA" is one swap from "CALIFORNIA",
 * which plain Levenshtein scores as 2 and would miss at a distance-1 threshold.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  const prev: number[] = new Array(b.length + 1).fill(0);
  const cur: number[] = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0] ?? i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? 0) + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) {
      prev2[j] = prev[j] ?? 0;
      prev[j] = cur[j] ?? 0;
    }
  }
  return prev[b.length] ?? max + 1;
}

/** Split a raw carrier name into normalized, expanded, noise-free tokens. */
export function carrierTokens(raw: string): string[] {
  const words = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const out: string[] = [];
  for (const w of words) {
    // EXPANSIONS wins outright; STATES applies only inside a multi-word name, so a bare "CA" or
    // "IN" stays literal rather than becoming a state nobody named.
    const expanded = EXPANSIONS[w] ?? (words.length > 1 ? STATES[w] : undefined) ?? [w];
    for (const t of expanded) if (!NOISE.has(t)) out.push(t);
  }
  return out;
}

/**
 * Canonicalize tokens against the vocabulary of the population being clustered, so a typo folds into
 * the spelling that actually dominates. Population-relative on purpose: the same misspelling can be
 * the majority form in one book and a one-off in another, and a hardcoded dictionary would rot.
 *
 * Only tokens of at least FUZZY_MIN_LEN characters, only distance 1, and only toward a STRICTLY more
 * frequent token — so two rare variants cannot swap into each other and the mapping is stable.
 */
export function buildTokenCanonicalizer(names: readonly string[]): (token: string) => string {
  const freq = new Map<string, number>();
  for (const n of names) {
    for (const t of carrierTokens(n)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const vocab = [...freq.keys()];
  const map = new Map<string, string>();
  for (const t of vocab) {
    if (t.length < FUZZY_MIN_LEN) continue;
    let best = t;
    let bestFreq = freq.get(t) ?? 0;
    for (const other of vocab) {
      if (other === t || other.length < FUZZY_MIN_LEN) continue;
      const f = freq.get(other) ?? 0;
      if (f <= bestFreq) continue;
      if (editDistance(t, other, 1) <= 1) {
        best = other;
        bestFreq = f;
      }
    }
    if (best !== t) map.set(t, best);
  }
  return (token: string) => map.get(token) ?? token;
}

/** The clusterable view of one candidate. Kept structural so callers need not import UI types. */
export interface ClusterableCarrier {
  /** Raw display name as it came from the resolution. */
  name: string;
  /** null ⇒ unmapped. A non-null value is the crosswalk's ruling and OUTRANKS text similarity. */
  canonicalPayerId: string | null;
  members: number;
}

/** A name's COMPANY anchors: what is left after Blue branding and geography — e.g. {ANTHEM}. */
export function anchorsOf(tokens: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (BLUE.has(t) || BLUE_TYPE.has(t) || STATE_NAMES.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Same carrier? Compare COMPANY CORES, with the CROSS/SHIELD rule above deciding what counts as
 * noise. Cores must be EQUAL — not merely overlapping — so "Anthem Blue Cross" (no state) never
 * merges into "Anthem Blue Cross of California": a stateless name could be any state's plan.
 *
 * Worked example, the live 13-tile case:
 *   "Anthem Blue Cross of California" → anchors {ANTHEM}, core {ANTHEM, CALIFORNIA}
 *   "ANTHEM BCBS OF CALIFORNIA"       → anchors {ANTHEM}, core {ANTHEM, CALIFORNIA}   → merge
 *   "ANTHEM CA"                        → anchors {ANTHEM}, core {ANTHEM, CALIFORNIA}   → merge
 *   "BCBS OF CA"                       → anchors {},       core {CROSS, SHIELD, CALIFORNIA}
 *   "BC CA"                            → anchors {},       core {CROSS, CALIFORNIA}    → separate
 * Thirteen spellings collapse to three tiles, and the two anchorless families stay apart because
 * without a company name their Blue type is the only thing distinguishing them.
 */
export function sameCarrier(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const anchorsA = anchorsOf(a);
  const anchorsB = anchorsOf(b);
  let sharedAnchor = false;
  for (const t of anchorsA) {
    if (anchorsB.has(t)) {
      sharedAnchor = true;
      break;
    }
  }
  const isFiller = (t: string): boolean => BLUE.has(t) || (sharedAnchor && BLUE_TYPE.has(t));
  const coreA = [...a].filter((t) => !isFiller(t));
  const coreB = [...b].filter((t) => !isFiller(t));
  if (coreA.length !== coreB.length) return false;
  const setB = new Set(coreB);
  return coreA.every((t) => setB.has(t));
}

export interface CarrierCluster<T extends ClusterableCarrier> {
  /** Stable identity for this cluster — the label, which is unique within one resolution. */
  key: string;
  /** What the tile says. The CONFIRMED name when the cluster has one, else the biggest spelling. */
  label: string;
  /** Every candidate folded in, largest first. */
  members: T[];
  /** The crosswalk's id for this cluster, or null when no member is mapped. */
  canonicalPayerId: string | null;
  /** Spellings other than the label — what the disclosure lists. */
  otherSpellings: string[];
  /** Members whose spelling is NOT confirmed to this payer in the alias map. */
  unconfirmedMembers: number;
}

/**
 * Cluster carriers for display. Order is preserved by member count (largest cluster first), and
 * within a cluster the largest spelling first, so nothing re-orders under the user's pick.
 */
export function clusterCarriers<T extends ClusterableCarrier>(items: readonly T[]): CarrierCluster<T>[] {
  const canon = buildTokenCanonicalizer(items.map((i) => i.name));
  const sets = items.map((i) => new Set(carrierTokens(i.name).map(canon)));

  // Union-find. Refusing a union is how the crosswalk keeps its authority.
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  const canonicalOf = (root: number): string | null => {
    for (let i = 0; i < items.length; i++) {
      if (find(i) === root && items[i]?.canonicalPayerId) return items[i]?.canonicalPayerId ?? null;
    }
    return null;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) continue;
      if (!sameCarrier(sets[i] as Set<string>, sets[j] as Set<string>)) continue;
      // ⚠ THE CROSSWALK WINS. Two confirmed-but-different payers never merge on text similarity.
      const ci = canonicalOf(ri);
      const cj = canonicalOf(rj);
      if (ci !== null && cj !== null && ci !== cj) continue;
      parent[rj] = ri;
    }
  }

  const byRoot = new Map<number, T[]>();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(items[i] as T);
    byRoot.set(r, arr);
  }

  const clusters: CarrierCluster<T>[] = [];
  for (const group of byRoot.values()) {
    const members = [...group].sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
    const confirmed = members.find((m) => m.canonicalPayerId !== null);
    const label = confirmed?.name ?? (members[0]?.name ?? '');
    clusters.push({
      key: label,
      label,
      members,
      canonicalPayerId: confirmed?.canonicalPayerId ?? null,
      otherSpellings: members.filter((m) => m.name !== label).map((m) => m.name),
      unconfirmedMembers: members
        .filter((m) => m.canonicalPayerId === null)
        .reduce((sum, m) => sum + m.members, 0),
    });
  }
  return clusters.sort(
    (a, b) =>
      b.members.reduce((s, m) => s + m.members, 0) - a.members.reduce((s, m) => s + m.members, 0) ||
      a.label.localeCompare(b.label),
  );
}
