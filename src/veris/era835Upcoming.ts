/**
 * ERA-confirmed upcoming payments — the read behind the Overview tile.
 *
 * Reads staging.era_835_payment ONLY (the authoritative payment-grain table from
 * migration 013): one row per ST/SE remittance, so sum(payment_amount) here is safe by
 * construction. NEVER read staging.era_835_adjustment for money — it is triplet-grain
 * and deliberately has no payment_amount column.
 *
 * ⚠️ READ-PATH CONTRACT (from 013's header — binding, not optional): payment_amount is
 * NULLABLE (an out-of-range/malformed BPR02 still lands the remit; dropping it was
 * defect 2). sum() silently skips NULLs, so every query here ALSO returns
 * count(*) FILTER (WHERE payment_amount IS NULL) over the same window and filters, and
 * the UI surfaces it when > 0. A sum shown without that count is a FLOOR presented as a
 * total. The types make the count non-optional so a caller cannot forget it exists.
 *
 * TENANCY: staging.* RLS reads the app.business_entity_id GUC, so every query runs
 * inside withTenant (transaction-local set_config on ONE client — the Supavisor 6543
 * pooler discipline). The explicit `business_entity_id = $1` predicate is kept as well:
 * belt (index-leading filter per the 018 rule) and suspenders (RLS), and it makes the
 * intended scope visible in the SQL itself.
 *
 * NULL payment_date rows are EXCLUDED by `payment_date >= current_date` (SQL null
 * comparison). Correct for THIS tile — a remit with no BPR16 cannot be placed on a
 * timeline, so it is not "upcoming"; it is not lost (it is in the table, and the ingest
 * counts it). A future reconciliation surface can show undated remits separately.
 *
 * Non-PHI throughout: payer, date, method, amounts, counts. The payment table carries
 * no patient columns at all (013 compliance header).
 */
import type pg from 'pg';
import { withTenant } from './withTenant.js';

/** One (payment_date, payer, method) group of upcoming remits. */
export interface EraUpcomingGroup {
  /** ISO date (BPR16 effective entry date). */
  payment_date: string;
  payer_name: string | null;
  /** BPR04 — ACH / CHK / NON…; null when the 835 omitted it. */
  payment_method: string | null;
  /** Remits in the group. */
  remits: number;
  /**
   * Group sum of BPR02 as a fixed-point NUMERIC TEXT (node-postgres numeric), or null
   * when EVERY remit in the group is unquantified. Never a JS float.
   */
  amount: string | null;
  /** Remits in the group whose BPR02 was unparseable (payment_amount IS NULL). */
  unquantified_remits: number;
}

/** The tile payload. `unquantified_remits` is deliberately NOT optional — see header. */
export interface EraUpcomingSummary {
  /** Sum of quantified BPR02 across the window, fixed-2 text. '0.00' when none. */
  total: string;
  /** ALL upcoming remits, quantified or not. */
  remits: number;
  /** Remits excluded from `total` because BPR02 was unparseable. >0 ⇒ total is a FLOOR. */
  unquantified_remits: number;
  /** Date/payer/method breakdown, ascending by date. Capped — see groups_truncated. */
  groups: EraUpcomingGroup[];
  /** True when more groups exist than the cap; `total`/`remits` are NOT affected (they
   *  come from an uncapped aggregate) — only the breakdown list is shortened. */
  groups_truncated: boolean;
}

/** Display cap on breakdown groups. The HEADLINE numbers are never capped. */
const GROUP_CAP = 50;

// Explicit allowlisted columns; table/column names are fixed literals; only the tenant
// value is a bound parameter. (Standing rules: parameterized queries only, no SELECT *.)
const TOTALS_SQL = `
  select count(*)::int                                        as remits,
         coalesce(sum(payment_amount), 0)::text               as total,
         (count(*) filter (where payment_amount is null))::int as unquantified_remits
    from staging.era_835_payment
   where business_entity_id = $1::uuid
     and payment_date >= current_date`;

const GROUPS_SQL = `
  select payment_date::text                                    as payment_date,
         payer_name,
         payment_method,
         count(*)::int                                         as remits,
         sum(payment_amount)::text                             as amount,
         (count(*) filter (where payment_amount is null))::int as unquantified_remits
    from staging.era_835_payment
   where business_entity_id = $1::uuid
     and payment_date >= current_date
   group by payment_date, payer_name, payment_method
   order by payment_date asc, payer_name asc nulls last, payment_method asc nulls last
   limit ${GROUP_CAP + 1}`;

interface TotalsRow {
  remits: number;
  total: string;
  unquantified_remits: number;
}

/**
 * One tenant's upcoming ERA-confirmed payments. Two queries, one withTenant transaction,
 * one client (never pool.query inside the callback — pooler discipline).
 */
export async function eraUpcomingPayments(
  pool: pg.Pool,
  businessEntityId: string,
): Promise<EraUpcomingSummary> {
  return withTenant(pool, businessEntityId, async (client) => {
    const totals = await client.query<TotalsRow>(TOTALS_SQL, [businessEntityId]);
    const groups = await client.query<EraUpcomingGroup>(GROUPS_SQL, [businessEntityId]);
    const t = totals.rows[0];
    const rows = groups.rows;
    const truncated = rows.length > GROUP_CAP;
    return {
      total: fixed2FromCents(centsFromNumericText(t?.total ?? '0') ?? 0),
      remits: t?.remits ?? 0,
      unquantified_remits: t?.unquantified_remits ?? 0,
      groups: truncated ? rows.slice(0, GROUP_CAP) : rows,
      groups_truncated: truncated,
    };
  });
}

/**
 * Exact integer-cents from Postgres numeric TEXT ('72986.79', '0', '-10.5').
 * Null/malformed → null. NEVER parse money through parseFloat — a float sum drifts
 * (0.1 + 0.2) and this feeds a money headline.
 */
export function centsFromNumericText(v: string | null): number | null {
  if (v === null) return null;
  const m = v.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(whole * 100)) return null; // beyond numeric(12,2) anyway
  return sign * (whole * 100 + frac);
}

/** Integer cents → fixed-2 text ('-1050' → '-10.50'). */
export function fixed2FromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Merge per-tenant summaries into one (the Consolidated view: BXR + Indigo read
 * separately under their own GUC, merged here). Money is added in EXACT integer cents;
 * identical (date, payer, method) groups from different tenants collapse into one row.
 * Deterministic order (date, then payer, then method; nulls last) regardless of input
 * order. Re-caps at GROUP_CAP: truncated if any part was, or the merge overflows.
 */
export function mergeEraUpcoming(parts: EraUpcomingSummary[]): EraUpcomingSummary {
  if (parts.length === 1) return parts[0]!; // common case: single-tenant view, untouched
  let totalCents = 0;
  let remits = 0;
  let unquantified = 0;
  let truncated = false;
  const byKey = new Map<string, { g: EraUpcomingGroup; cents: number | null }>();
  for (const p of parts) {
    totalCents += centsFromNumericText(p.total) ?? 0;
    remits += p.remits;
    unquantified += p.unquantified_remits;
    truncated = truncated || p.groups_truncated;
    for (const g of p.groups) {
      const key = JSON.stringify([g.payment_date, g.payer_name, g.payment_method]);
      const cents = centsFromNumericText(g.amount);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { g: { ...g }, cents });
      } else {
        prev.g.remits += g.remits;
        prev.g.unquantified_remits += g.unquantified_remits;
        // null means "all unquantified": the merged amount is null only if BOTH are.
        prev.cents = cents === null ? prev.cents : (prev.cents ?? 0) + cents;
      }
    }
  }
  const cmp = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b);
  const groups = [...byKey.values()]
    .map(({ g, cents }) => ({ ...g, amount: cents === null ? null : fixed2FromCents(cents) }))
    .sort(
      (a, b) =>
        a.payment_date.localeCompare(b.payment_date) ||
        cmp(a.payer_name, b.payer_name) ||
        cmp(a.payment_method, b.payment_method),
    );
  const overflow = groups.length > GROUP_CAP;
  return {
    total: fixed2FromCents(totalCents),
    remits,
    unquantified_remits: unquantified,
    groups: overflow ? groups.slice(0, GROUP_CAP) : groups,
    groups_truncated: truncated || overflow,
  };
}
