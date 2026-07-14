/**
 * Billing Audit — payer-alias RESOLVER (report payer_name → sheet carrier alias).
 *
 * ⚠️ NEW in this file (2026-07-13): there was NO pre-existing matcher — the only prior
 * payer_alias code was the set-membership attribution lookup in decisionSync.ts. This
 * resolver is the contract 0051's precedence integers were always implicitly against;
 * it is landed now (ahead of the Phase-3 flag engine that CONSUMES it) so 0051's seed
 * values are meaningful and TESTABLE before they are applied. The flag RULES that call
 * this stay Phase 3.
 *
 * PRECEDENCE CONVENTION — HIGHEST WINS (Alec's locked convention, 2026-07-13): more
 * specific = HIGHER number = wins. exacts 85–90 · family patterns 40–70 · catch-all 10.
 * Ties break on LOWEST id (deterministic). This flips this session's earlier draft
 * (which described lowest-wins) — the flip is deliberate and documented here + in 0051.
 *
 * Resolution is IN-PROCESS over rows fetched by the reader (no dynamic SQL): match_kind
 * 'exact' = case-insensitive equality; 'like' = SQL-LIKE (% / _ wildcards); 'regex' =
 * JS RegExp. Patterns are authored upper-cased and matched against the UPPER-CASED
 * payer name, so matching is effectively case-insensitive either way.
 *
 * FACILITY SCOPING (Phase-3 contract, not enforced here): the flag engine resolves per
 * (facility, payer) by passing ONLY that facility's decision carrier aliases as `rows`,
 * so a cross-facility tie (e.g. CAMH "Anthem BCBS CALIFORNIA" vs Treat CA "Anthem of
 * CALIFORNIA", same match_value) never mis-routes — each facility only ever sees its own
 * candidates. This function is pure given its candidate set; scoping is the caller's job.
 */

export interface PayerAliasRow {
  id: number;
  alias_text: string;
  match_kind: 'exact' | 'like' | 'regex';
  match_value: string;
  precedence: number;
}

/** SQL-LIKE → RegExp: % → .*, _ → ., other regex metachars escaped. Anchored whole-string. */
function likeToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

/** Does one alias rule match an already-upper-cased payer name? Never throws — an
 *  unparseable regex fails closed to "no match" (a bad rule must not crash resolution). */
export function aliasMatches(row: PayerAliasRow, upperPayer: string): boolean {
  const value = row.match_value.toUpperCase();
  try {
    switch (row.match_kind) {
      case 'exact':
        return upperPayer === value;
      case 'like':
        return likeToRegExp(value).test(upperPayer);
      case 'regex':
        return new RegExp(value).test(upperPayer);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Resolve a report payer_name to its winning alias row, or null when nothing matches.
 * Highest precedence wins; ties break on lowest id. `rows` is the candidate set the
 * caller supplies (tenant-wide today; facility-scoped in the Phase-3 flag engine).
 */
export function resolvePayerAlias(
  payerName: string | null | undefined,
  rows: readonly PayerAliasRow[],
): PayerAliasRow | null {
  if (payerName === null || payerName === undefined) return null;
  const upper = payerName.trim().toUpperCase();
  if (upper === '') return null;
  let best: PayerAliasRow | null = null;
  for (const row of rows) {
    if (!aliasMatches(row, upper)) continue;
    if (
      best === null ||
      row.precedence > best.precedence ||
      (row.precedence === best.precedence && row.id < best.id)
    ) {
      best = row;
    }
  }
  return best;
}
