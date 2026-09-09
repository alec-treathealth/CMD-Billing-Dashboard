/**
 * pg row → contract shapes for the drill-down and summary reads. PURE (tested in app/test). The
 * pairing row shaper lives in the src module (root-tested); these cover what the app adds: summary,
 * payer, facility, monthly (with the per-tenant incomplete-month flag), freshness and descriptions.
 *
 * Every numeric passes through `toNum` — node-pg returns numeric / bigint / sums as STRINGS. Every
 * tenant-gated metric passes through `shapeTenantGatedMetrics`, the ONE place the ruling is applied:
 * a suppressed metric never carries a number out of this layer.
 */
import {
  shapeTenantGatedMetrics,
  toNum,
  type GatedMetric,
} from '../../../src/collections/codePerformanceQuery.js';
import {
  descriptionKey,
  type CodeDescription,
  type CodeDescriptionMap,
  type CodePerfFacilityRow,
  type CodePerfFreshness,
  type CodePerfMonthRow,
  type CodePerfPayerRow,
  type CodePerfSummary,
  type CodeType,
} from './contract';

type Raw = Record<string, unknown>;

/** Calendar date → YYYY-MM-DD. pg hands `date` columns back as Date (local midnight) or as text. */
export function isoDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // Local-midnight Date → the civil date it encodes, independent of the process TZ.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

function isoTimestamp(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v.length >= 10) return v;
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function gated(raw: Raw, entityId: string): { write_off_rate: GatedMetric; patient_balance_rate: GatedMetric } {
  return shapeTenantGatedMetrics(entityId, {
    write_off_rate: raw.write_off_rate,
    patient_balance_rate: raw.patient_balance_rate,
  });
}

function metricBlock(raw: Raw, entityId: string) {
  return {
    charges: toNum(raw.charges) ?? 0,
    billed: toNum(raw.billed) ?? 0,
    collected: toNum(raw.collected) ?? 0,
    allowed_coverage: toNum(raw.allowed_coverage),
    allowed_rate: toNum(raw.allowed_rate),
    paid_of_allowed: toNum(raw.paid_of_allowed),
    underpaid_dollars: toNum(raw.underpaid_dollars),
    days_p50: toNum(raw.days_p50),
    days_p90: toNum(raw.days_p90),
    pct_zero_paid: toNum(raw.pct_zero_paid),
    matured_share: toNum(raw.matured_share),
    ...gated(raw, entityId),
  };
}

export function shapeSummary(raw: Raw | undefined, entityId: string): CodePerfSummary {
  const r = raw ?? {};
  return {
    ...metricBlock(r, entityId),
    pairings: toNum(r.pairings) ?? 0,
    facilities: toNum(r.facilities) ?? 0,
    payers: toNum(r.payers) ?? 0,
    no_procedure_code_charges: toNum(r.no_procedure_code_charges) ?? 0,
    no_revenue_code_charges: toNum(r.no_revenue_code_charges) ?? 0,
  };
}

export function shapePayerRow(raw: Raw, entityId: string): CodePerfPayerRow {
  return {
    ...metricBlock(raw, entityId),
    payer_raw: str(raw.payer_raw),
    share_of_billed: toNum(raw.share_of_billed),
  };
}

export function shapeFacilityRow(raw: Raw, entityId: string): CodePerfFacilityRow {
  return {
    ...metricBlock(raw, entityId),
    facility: str(raw.facility),
    rated: raw.rated === true,
  };
}

/** YYYY-MM-01 of the month containing an ISO date. */
export function monthStart(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`;
}

/**
 * Monthly rows with the PER-TENANT incomplete flag: a month is incomplete when it is at or after the
 * month of that tenant's max(charge_date). BXR (max 2026-09-03) and Indigo (max 2026-08-23) therefore
 * shade different months on the same calendar — never a shared cutoff. With no freshness at all,
 * every month is flagged incomplete (fail toward caution, not toward false confidence).
 */
export function shapeMonthRows(raws: Raw[], maxChargeDate: string | null): CodePerfMonthRow[] {
  const cutoff = maxChargeDate ? monthStart(maxChargeDate) : null;
  return raws
    .map((raw) => {
      const month = isoDate(raw.month);
      if (!month) return null;
      return {
        month,
        charges: toNum(raw.charges) ?? 0,
        billed: toNum(raw.billed) ?? 0,
        collected: toNum(raw.collected) ?? 0,
        allowed_rate: toNum(raw.allowed_rate),
        allowed_coverage: toNum(raw.allowed_coverage),
        matured_share: toNum(raw.matured_share),
        incomplete: cutoff === null ? true : month >= cutoff,
      };
    })
    .filter((m): m is CodePerfMonthRow => m !== null);
}

export function shapeFreshness(raw: Raw | undefined): CodePerfFreshness {
  const r = raw ?? {};
  const businessToday = isoDate(r.business_today);
  const maxChargeDate = isoDate(r.max_charge_date);
  let chargeLagDays: number | null = null;
  if (businessToday && maxChargeDate) {
    const ms = Date.UTC(+businessToday.slice(0, 4), +businessToday.slice(5, 7) - 1, +businessToday.slice(8, 10))
      - Date.UTC(+maxChargeDate.slice(0, 4), +maxChargeDate.slice(5, 7) - 1, +maxChargeDate.slice(8, 10));
    chargeLagDays = Math.round(ms / 86_400_000);
  }
  return {
    businessToday,
    maxIngestedAt: isoTimestamp(r.max_ingested_at),
    maxChargeDate,
    maxPaymentReceived: isoDate(r.max_payment_received),
    futurePaymentCharges: toNum(r.future_payment_charges) ?? 0,
    chargeLagDays,
  };
}

const CODE_TYPES: ReadonlySet<string> = new Set(['CPT', 'HCPCS', 'REV', 'OTHER']);

/** ref.code_description rows (already precedence-resolved by the query) → lookup map. */
export function shapeDescriptions(raws: Raw[]): CodeDescriptionMap {
  const map: CodeDescriptionMap = {};
  for (const raw of raws) {
    const codeType = str(raw.code_type);
    const code = str(raw.code);
    const shortLabel = str(raw.short_label);
    if (!codeType || !CODE_TYPES.has(codeType) || !code || !shortLabel) continue;
    const d: CodeDescription = {
      codeType: codeType as CodeType,
      code,
      shortLabel,
      longDescription: str(raw.long_description),
      priorDescription: str(raw.prior_description),
      sourceCitation: str(raw.source_citation),
      provenance: str(raw.provenance) ?? 'unknown',
      needsReview: raw.needs_review !== false,
      descriptionConflict: raw.description_conflict === true,
      tenantOverride: raw.tenant_override === true,
    };
    map[descriptionKey(codeType === 'REV' ? 'revenue' : 'procedure', code)] = d;
  }
  return map;
}
