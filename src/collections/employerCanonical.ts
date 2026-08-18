/**
 * CANONICAL EMPLOYER NAMES for the Collections explorer (2026-08-17).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The employer type-ahead groups by the RAW `collections.cmd_explorer_rows.employer_name`, so one
 * employer spelled several ways in the CMD export renders as several picker rows — and picking one
 * silently scopes the grid to that spelling's rows alone. Typing "Tesla" offered three:
 *
 *     TESLA,INC. (338 rows) · TESLA INC (114) · TESLA, INC. (36)
 *
 * The worst live case is GOOGLE at SIX spellings over 1,044 rows: `GOOGLE PPO`,
 * `GOOGLE GHIP CHDP HSA W/NON-INT`, `GOOGLE INC`, `GOOGLE`, `GOOGLE LLC`,
 * `GOOGLE GHIP CHDP HSA W/NON-INT BAN`. Picking `GOOGLE` returned 98 of 1,044 rows — 9%.
 *
 * ── MEASURED ON COLLECTIONS DATA, NOT INHERITED ────────────────────────────────────────────────
 * ⚠ `vob.normalize_employer` (migration 0064) already does this shape and its header even names
 * TESLA as a verified absorber, so reusing it looks free. **RULED OUT by Alec 2026-08-17: "The VOB
 * data is not accurate. We need to make the canonical layer from collections."** That is the
 * standing no-VOB ruling (PR #225) widened from "don't join vob.*" to "don't source the canonical
 * FORM from vob.* either" — a shared function is still a shared dependency, and it was tuned on
 * values this plane does not trust. This module is Collections' own, and the thresholds below were
 * measured here.
 *
 * Live collections book, 2026-08-17 — 116,871 rows carry an employer over 1,073 distinct spellings:
 *   · de-punctuation alone  → 1,061 keys (10 groups; Tesla is the largest at 3 spellings)
 *   · + suffix truncation   → 1,026 keys (33 groups, 80 raw spellings, 11,134 rows)
 * So truncation is doing most of the work and both tiers ship together. The 33 groups were read by
 * hand: every one is a single real employer collapsing its own variants. The only arguable merge is
 * PUBLIC EMPLOYEE BENEFIT RETIREMEN + PUBLIC EMPLOYEE BENEFITS BOARD (192 rows), and no merge
 * crosses two different companies.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
 * ⚠ NOTHING IS EVER WRITTEN TO `employer_name`. This is a READ-TIME grouping and the raw column is
 * untouched, which is not a style preference — `cmdExplorerQuery.ts` records that an in-place
 * rewrite would be irreversible, would make two employers of one name indistinguishable, and would
 * corrupt the trigram index the search depends on. It would also silently migrate rows across the
 * `employerMode` partition (`employer_name is null or ''` vs not), whose stated invariant is that
 * the two segments always sum to the whole book.
 *
 * ⚠ THE FILTER STILL MATCHES RAW SPELLINGS. A canonical option carries its `variants`, and the
 * client sends those — so the SQL predicate stays `employer_name = any($n::text[])`, unchanged,
 * still served by migration 0101's indexes. No migration, no expression index, and the canonical
 * layer can be changed or reverted without touching the database at all.
 *
 * That only works because the caller groups the COMPLETE tenant vocabulary rather than a search
 * page: 1,073 distinct values is small (the whole DISTINCT is a 118 ms index scan), so every
 * spelling of a key is present and `variants` can never be partial. Do not re-point this at a
 * per-keystroke, LIMITed result set — a group built from a partial match would under-select rows
 * while looking exactly as authoritative.
 */

/**
 * Legal-entity and plan-design noise that follows the employer name. Truncating AT the first of
 * these is what collapses `GOOGLE PPO` / `GOOGLE INC` / `GOOGLE GHIP CHDP HSA W/NON-INT` onto
 * `GOOGLE`: the employer is the leading run, and everything from the first noise token on describes
 * the legal form or the plan, not the company.
 *
 * Word-boundary matched, so `CO` truncates `COCA COLA CO` to `COCA COLA` but never fires inside
 * `COCA`. Order does not matter — the FIRST match in the string wins, not the first in this list.
 */
const NOISE_TOKENS = [
  'INC', 'INCORPORATED', 'LLC', 'LLP', 'LP', 'LTD', 'CORP', 'CORPORATION', 'COMPANY', 'CO',
  'PC', 'PLLC', 'PPO', 'HMO', 'EPO', 'POS', 'HDHP', 'HSA', 'HRA', 'FSA', 'GHIP', 'CHDP', 'EPP',
  'PLAN', 'PLANS', 'GROUP', 'TRUST', 'FUND', 'BENEFIT', 'BENEFITS', 'INSURANCE',
] as const;

const NOISE_RE = new RegExp(`\\b(?:${NOISE_TOKENS.join('|')})\\b.*$`);

/** Upper-case, replace every run of non-alphanumerics with one space, trim. */
function depunctuate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * The canonical key for one raw employer spelling.
 *
 * Returns '' only for input that is empty or entirely punctuation — callers filter those out before
 * grouping (a blank employer means "individual", a different dimension entirely).
 *
 * FALLS BACK rather than emptying: a name that STARTS with a noise word (`GROUP HEALTH COOPERATIVE`)
 * would truncate to nothing, so the de-punctuated string is kept instead. Without that, every such
 * employer would collapse into one giant '' bucket — the single worst failure this could have.
 */
export function canonicalEmployerKey(raw: string): string {
  const cleaned = depunctuate(raw);
  if (cleaned === '') return '';
  const truncated = cleaned.replace(NOISE_RE, '').trim();
  return truncated === '' ? cleaned : truncated;
}

/** One canonical employer: the filter expansion plus what the picker shows. */
export interface CanonicalEmployer {
  /** Stable option value — the canonical key (`GOOGLE`). Also the label. */
  key: string;
  /** EVERY raw spelling that maps to `key`. This is what the grid filter actually matches on. */
  variants: string[];
  /** How many raw spellings collapsed here. 1 = nothing was merged. */
  variantCount: number;
}

/**
 * Group a tenant's complete raw employer vocabulary into canonical options, sorted by key.
 *
 * Blank/whitespace-only names are DROPPED, not bucketed: they are the `individual` segment's
 * territory, and an unpickable blank option in the type-ahead was an existing complaint.
 *
 * `variants` is sorted for determinism — the array reaches the SQL predicate as a bound parameter,
 * and a stable order keeps the query text and any future plan cache stable across identical picks.
 */
export function groupEmployerNames(rawNames: readonly string[]): CanonicalEmployer[] {
  const byKey = new Map<string, string[]>();
  for (const raw of rawNames) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const key = canonicalEmployerKey(trimmed);
    if (key === '') continue;
    const bucket = byKey.get(key);
    if (bucket) {
      // The same raw spelling can arrive twice if a caller passes a non-DISTINCT list; never let a
      // duplicate inflate variantCount, which is rendered to the user as "N spellings".
      if (!bucket.includes(trimmed)) bucket.push(trimmed);
    } else {
      byKey.set(key, [trimmed]);
    }
  }
  return [...byKey.entries()]
    .map(([key, variants]) => ({
      key,
      variants: [...variants].sort(),
      variantCount: variants.length,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Expand picked canonical keys to the raw spellings the SQL filter matches.
 *
 * ⚠ AN UNKNOWN KEY FALLS BACK TO ITSELF rather than being dropped. Dropping it would silently WIDEN
 * the grid — the user sees a chip naming an employer while the result set ignores it, which is the
 * one failure mode a filter must never have. Passing the key through at worst matches nothing (an
 * honest empty result), and it also keeps a selection valid if the vocabulary reloads mid-session.
 */
export function expandEmployerKeys(
  keys: readonly string[],
  options: readonly CanonicalEmployer[],
): string[] {
  const byKey = new Map(options.map((o) => [o.key, o.variants]));
  const out: string[] = [];
  for (const k of keys) {
    const variants = byKey.get(k);
    if (variants) out.push(...variants);
    else out.push(k);
  }
  // De-duplicate: two keys cannot share a variant today, but the fallback above can collide with a
  // real variant, and a repeated value in `= any(...)` is pure waste.
  return [...new Set(out)];
}
