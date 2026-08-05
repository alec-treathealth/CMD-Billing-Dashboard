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
 * THE UPCOMING WINDOW is `payment_date > $2::date` — STRICTLY AFTER today — where $2 is the
 * CIVIL DATE IN THE BUSINESS ZONE (businessTodayIso). Strict `>` per Alec's ruling
 * 2026-08-03: a remit whose BPR16 is today has LANDED (fund movement is today) and its money
 * is in the paid bar chart (measured: CMD posting is same-day-or-earlier for ~94% of
 * matchable remits) — keeping it here clogs the view with non-future money. The residual
 * posting-lag tail is a STRUCTURAL two-clock gap (tile keys on BPR16, chart keys on CMD
 * receipt date) that exists under `>=` as well — see veris-data-notes.md § "two-clock
 * gap". NOT Postgres `current_date`: Vercel runs TZ=UTC and so does the database, so from
 * 17:00 PT to midnight PT `current_date` is already TOMORROW Pacific and the tile silently
 * drops remits dated tomorrow for the people reading it. Bound param rather than SQL-side
 * `(now() at time zone …)` on purpose — a literal date keeps the scan sargable on 013's
 * (business_entity_id, payment_date) index, and it makes the DST math unit-testable instead
 * of only substring-assertable.
 *
 * NULL payment_date rows are EXCLUDED by that same comparison (SQL null comparison).
 * Correct for THIS tile — a remit with no BPR16 cannot be placed on a timeline, so it is
 * not "upcoming"; it is not lost (it is in the table, and the ingest counts it). A future
 * reconciliation surface can show undated remits separately.
 *
 * Non-PHI throughout: payer, date, method, amounts, counts. The payment table carries
 * no patient columns at all (013 compliance header).
 */
import type pg from 'pg';
import { withTenant } from './withTenant.js';

/**
 * The ops calendar zone for "today". DELIBERATELY DUPLICATED from
 * app/lib/qualify/contract.ts (QUALIFY_BUSINESS_TZ) rather than imported: app/ may import
 * src/, never the reverse, and this module lives in src/. Two constants, one value — if the
 * business ever moves zones, both change together.
 */
export const ERA_BUSINESS_TZ = 'America/Los_Angeles';

/**
 * Civil Y-M-D in ERA_BUSINESS_TZ as an ISO date string. DST-aware (Intl resolves the offset
 * for the instant, not a fixed -8/-7), locale-format-independent (formatToParts, not a
 * formatted string), and clock-injectable so the boundary cases are testable. Same proven
 * shape as qualifyWindowBounds' trailing-window anchor.
 */
export function businessTodayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ERA_BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** One (payment_date, facility, payer, method) group of upcoming remits. */
export interface EraUpcomingGroup {
  /** ISO date (BPR16 effective entry date). */
  payment_date: string;
  /**
   * BXR short code / Indigo CMD customer id, resolved from the customer the 835 was
   * pulled for (NOT NULL in 013). Grouping by it is what makes the tile answer "which
   * facility is this deposit for" — without it a payer row silently blends facilities.
   */
  facility_code: string;
  payer_name: string | null;
  /**
   * BPR04 payment method code, stored VERBATIM as the payer sent it — ACH / CHK / NON /
   * FWT / BOP; null when the 835 omitted it. These are X12 codes, not display strings:
   * `NON` is "Non-Payment Data" (a $0 informational remit), NOT a check. Translate for
   * display at the UI edge (`paymentMethodLabel`), never by rewriting stored values.
   */
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
  /**
   * ALL upcoming remits, quantified or not, non-payments included. Kept as the grand
   * total (and the has-anything-to-show test); it is exactly
   * incoming_remits + zero_dollar_remits.
   */
  remits: number;
  /**
   * Remits that represent money actually arriving — BPR04 is anything OTHER than 'NON'
   * (a null method counts as incoming: unstated method, real payment). This is the
   * number the headline leads with.
   */
  incoming_remits: number;
  /**
   * Remits with BPR04 = 'NON' ("Non-Payment Data"): the payer adjudicated claims and
   * sent no money — full denial, or everything applied to patient responsibility. They
   * are real ERA activity and stay in the breakdown, but counting them as incoming
   * payments would imply deposits that will never land.
   *
   * Both this and incoming_remits come from the SAME uncapped TOTALS_SQL as `remits`,
   * never from the capped GROUPS_SQL breakdown (the cap would understate them) and never
   * by arithmetic in the component.
   */
  zero_dollar_remits: number;
  /** Remits excluded from `total` because BPR02 was unparseable. >0 ⇒ total is a FLOOR. */
  unquantified_remits: number;
  /** Date/facility/payer/method breakdown, ascending by date. Capped — see groups_truncated. */
  groups: EraUpcomingGroup[];
  /** True when more groups exist than the cap; `total`/`remits` are NOT affected (they
   *  come from an uncapped aggregate) — only the breakdown list is shortened. */
  groups_truncated: boolean;
}

/**
 * Display cap on breakdown groups. The HEADLINE numbers are never capped.
 * NOTE: grouping includes facility_code, which roughly doubles cardinality versus a
 * date/payer/method grouping (16 → 31 groups on the first live BXR window, 12
 * facilities). Well inside the cap today, but the margin is smaller than it looks —
 * raise this, don't drop facility, if the breakdown starts truncating.
 */
const GROUP_CAP = 50;

// Explicit allowlisted columns; table/column names are fixed literals; only the tenant
// value is a bound parameter. (Standing rules: parameterized queries only, no SELECT *.)
// Every headline number the tile shows comes from THIS ONE statement, over one window and
// one set of filters. The two BPR04 partitions are complementary by construction
// (= 'NON' vs IS DISTINCT FROM 'NON', so a NULL method lands in incoming), which makes
// incoming_remits + zero_dollar_remits = remits an invariant rather than a hope. Neither
// is subtracted in the component, and neither is read off the capped breakdown.
const TOTALS_SQL = `
  select count(*)::int                                        as remits,
         coalesce(sum(payment_amount), 0)::text               as total,
         (count(*) filter (where payment_amount is null))::int as unquantified_remits,
         (count(*) filter (
            where payment_method is distinct from 'NON'))::int as incoming_remits,
         (count(*) filter (where payment_method = 'NON'))::int as zero_dollar_remits
    from staging.era_835_payment
   where business_entity_id = $1::uuid
     and payment_date > $2::date`;

const GROUPS_SQL = `
  select payment_date::text                                    as payment_date,
         facility_code,
         payer_name,
         payment_method,
         count(*)::int                                         as remits,
         sum(payment_amount)::text                             as amount,
         (count(*) filter (where payment_amount is null))::int as unquantified_remits
    from staging.era_835_payment
   where business_entity_id = $1::uuid
     and payment_date > $2::date
   group by payment_date, facility_code, payer_name, payment_method
   order by payment_date asc,
            facility_code asc,
            payer_name asc nulls last,
            payment_method asc nulls last
   limit ${GROUP_CAP + 1}`;

interface TotalsRow {
  remits: number;
  total: string;
  unquantified_remits: number;
  incoming_remits: number;
  zero_dollar_remits: number;
}

/**
 * One tenant's upcoming ERA-confirmed payments. Two queries, one withTenant transaction,
 * one client (never pool.query inside the callback — pooler discipline).
 *
 * cutoffIso defaults to today-in-the-business-zone. A MULTI-TENANT caller must compute it
 * ONCE and pass the same value to every tenant: defaulting per call means a Consolidated
 * read straddling midnight PT would scope its two tenants to different days. Both
 * statements here get the SAME value for the same reason — a headline that does not match
 * its own breakdown is the failure mode.
 */
export async function eraUpcomingPayments(
  pool: pg.Pool,
  businessEntityId: string,
  cutoffIso: string = businessTodayIso(),
): Promise<EraUpcomingSummary> {
  return withTenant(pool, businessEntityId, async (client) => {
    const totals = await client.query<TotalsRow>(TOTALS_SQL, [businessEntityId, cutoffIso]);
    const groups = await client.query<EraUpcomingGroup>(GROUPS_SQL, [businessEntityId, cutoffIso]);
    const t = totals.rows[0];
    const rows = groups.rows;
    const truncated = rows.length > GROUP_CAP;
    return {
      total: fixed2FromCents(centsFromNumericText(t?.total ?? '0') ?? 0),
      remits: t?.remits ?? 0,
      incoming_remits: t?.incoming_remits ?? 0,
      zero_dollar_remits: t?.zero_dollar_remits ?? 0,
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
 * identical (date, facility, payer, method) groups collapse into one row. facility_code
 * is part of the key: it is tenant-unique in practice, so cross-tenant rows can never
 * collapse — but leaving it out would blend two facilities of the SAME tenant that share
 * a date/payer/method, which is exactly the attribution the column exists to show.
 * Deterministic order (date, facility, payer, method; nulls last) regardless of input
 * order. Re-caps at GROUP_CAP: truncated if any part was, or the merge overflows.
 */
export function mergeEraUpcoming(parts: EraUpcomingSummary[]): EraUpcomingSummary {
  if (parts.length === 1) return parts[0]!; // common case: single-tenant view, untouched
  let totalCents = 0;
  let remits = 0;
  let incoming = 0;
  let zeroDollar = 0;
  let unquantified = 0;
  let truncated = false;
  const byKey = new Map<string, { g: EraUpcomingGroup; cents: number | null }>();
  for (const p of parts) {
    totalCents += centsFromNumericText(p.total) ?? 0;
    remits += p.remits;
    // Summed per tenant, never recomputed from the merged groups: the parts may already
    // be capped, so the breakdown is not a valid source for a headline count.
    incoming += p.incoming_remits;
    zeroDollar += p.zero_dollar_remits;
    unquantified += p.unquantified_remits;
    truncated = truncated || p.groups_truncated;
    for (const g of p.groups) {
      const key = JSON.stringify([
        g.payment_date,
        g.facility_code,
        g.payer_name,
        g.payment_method,
      ]);
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
        a.facility_code.localeCompare(b.facility_code) ||
        cmp(a.payer_name, b.payer_name) ||
        cmp(a.payment_method, b.payment_method),
    );
  const overflow = groups.length > GROUP_CAP;
  return {
    total: fixed2FromCents(totalCents),
    remits,
    incoming_remits: incoming,
    zero_dollar_remits: zeroDollar,
    unquantified_remits: unquantified,
    groups: overflow ? groups.slice(0, GROUP_CAP) : groups,
    groups_truncated: truncated || overflow,
  };
}
