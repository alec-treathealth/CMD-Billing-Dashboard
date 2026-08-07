/**
 * US state extraction for payer-name strings — longest-phrase-first, then bare 2-letter codes.
 *
 * ⚠ THIS IS THE THIRD STATE TABLE IN THE REPO. That is a known duplication, recorded rather than
 * silently fixed, because consolidating them is a real refactor and each copy currently answers a
 * DIFFERENT question:
 *
 *   · app/lib/qualify/carrierCluster.ts `STATES`  — code → distinguishing TOKENS, for display
 *     clustering. Multi-token for NC/ND/SC/SD/WV so the direction word survives tokenization.
 *   · scripts/score-payer-aliases.ts `STATE_SEQ`  — name phrase → 2-letter CODE, for GUARD-C. The
 *     most correct of the three; cannot be imported because that file calls main() at module scope,
 *     so importing it opens a DB pool and runs the whole report.
 *   · this file                                    — string → set of canonical state NAMES, for
 *     audit/reporting where "which states does this string name?" is the question.
 *
 * Consolidating on one table is a worthwhile follow-up. It is NOT a drive-by: score-payer-aliases
 * publishes a measured wrong-rate that two sanity checks assert, so changing its state resolution
 * moves numbers that a migration header quotes.
 *
 * Pure module — no I/O, no DB, no side effects.
 */

/** Two-letter code → canonical state name. Direction words are part of the name, not stripped. */
export const CODE_TO_STATE: Readonly<Record<string, string>> = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA', CO: 'COLORADO',
  CT: 'CONNECTICUT', DE: 'DELAWARE', DC: 'DISTRICT OF COLUMBIA', FL: 'FLORIDA', GA: 'GEORGIA',
  HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA', KS: 'KANSAS',
  KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND', MA: 'MASSACHUSETTS',
  MI: 'MICHIGAN', MN: 'MINNESOTA', MS: 'MISSISSIPPI', MO: 'MISSOURI', MT: 'MONTANA',
  NE: 'NEBRASKA', NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO',
  NY: 'NEW YORK', NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA',
  OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA',
  SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT', VA: 'VIRGINIA',
  WA: 'WASHINGTON', WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING',
};

/**
 * Phrases sorted longest-first so "WEST VIRGINIA" is consumed before "VIRGINIA" can match it, and
 * "NORTH DAKOTA" before "DAKOTA". Without this ordering every WV string also reports VA.
 */
const STATE_PHRASES: readonly string[] = [...new Set(Object.values(CODE_TO_STATE))].sort(
  (a, b) => b.length - a.length,
);

/**
 * Every US state a payer-name string names, by spelled-out phrase or by bare 2-letter code.
 *
 * A matched phrase is CONSUMED before code scanning, so "BCBS OF WEST VIRGINIA" yields exactly
 * {WEST VIRGINIA} — not {WEST VIRGINIA, VIRGINIA}, and the stray "IN"/"OR"/"OK" inside a consumed
 * phrase cannot be re-read as Indiana/Oregon/Oklahoma.
 */
export function statesIn(raw: string): Set<string> {
  const padded = ` ${raw.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const found = new Set<string>();
  let remaining = padded;
  for (const phrase of STATE_PHRASES) {
    if (remaining.includes(` ${phrase} `)) {
      found.add(phrase);
      remaining = remaining.split(` ${phrase} `).join(' ');
    }
  }
  for (const token of remaining.trim().split(' ')) {
    const name = CODE_TO_STATE[token];
    if (name !== undefined) found.add(name);
  }
  return found;
}
