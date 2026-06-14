/**
 * Phase 6 collections ingest — shared types.
 *
 * Four tab shapes (mirrors the collections.* schema):
 *   daily        -> collections.daily_collections   (non-PHI)
 *   payment_line -> collections.payment_lines        (PHI)
 *   negotiation  -> collections.negotiation_worklist (PHI: client_name)
 *   rollup       -> collections.rollup_snapshots     (verbatim)
 */

export type Shape = 'daily' | 'payment_line' | 'rollup' | 'negotiation';
export type WorkbookKind = 'single' | 'group' | 'rollup';

export interface Workbook {
  /** Internal label (filename token), e.g. CAMH, TREAT_FRCA, BXR_ROLLUP. */
  readonly code: string;
  readonly sheetId: string;
  readonly kind: WorkbookKind;
  /** Single-facility workbooks: the one real facility code. */
  readonly facilityCode?: string;
  /** Group workbooks: the lineage group code (TREAT_FRCA / LSMH_DMH). */
  readonly groupCode?: string;
}

/** A verbatim source row (entire sheet row) destined for collections_raw. */
export interface RawRecord {
  source_file_id: string;
  source_tab: string;
  source_row_num: number;
  shape: Shape;
  source_group_code: string | null;
  facility_code: string | null; // resolved real code, or NULL (never a group code)
  raw: Record<string, unknown>;
}

export interface DailyRow {
  facility_code: string | null;
  source_group_code: string | null;
  payment_date: string; // ISO
  checks_amount: string; // numeric string
  eft_amount: string;
  gross_amount: string;
}

export interface PaymentLineRow {
  facility_code: string | null;
  source_group_code: string | null;
  service_date: string | null;
  payment_date: string | null;
  cpt_code: string | null;
  revenue_code: string | null;
  patient_name: string | null;
  patient_last: string | null;
  patient_first: string | null;
  member_id_raw: string | null;
  member_id_norm: string | null;
  group_number: string | null;
  charge_amount: string | null;
  allowed_amount: string | null;
  insurance_paid: string | null;
  adjustment: string | null;
  balance_due_pt: string | null;
  payer_name: string | null;
  recon_ok: boolean | null;
  paid_gt_allowed: boolean | null;
}

export interface NegotiationRow {
  facility_code: string | null;
  source_group_code: string | null;
  client_name: string | null;
  insurance: string | null;
  alpha_prefix: string | null;
  homeplan_state: string | null;
  billed_amount: string | null;
  allowed_amount: string | null;
  negotiated_pct: string | null;
  tpp: string | null;
}

export interface RollupRow {
  source_file_id: string;
  grain: string | null; // 'facility' | 'payer'
  raw: Record<string, unknown>;
}

/** A typed row tagged with the shape table it belongs to + its raw lineage key. */
export type TypedRecord =
  | { shape: 'daily'; rowNum: number; row: DailyRow }
  | { shape: 'payment_line'; rowNum: number; row: PaymentLineRow }
  | { shape: 'negotiation'; rowNum: number; row: NegotiationRow }
  | { shape: 'rollup'; rowNum: number; row: RollupRow };
