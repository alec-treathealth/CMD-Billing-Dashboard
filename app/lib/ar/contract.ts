/**
 * AR Management — the CLIENT-SAFE contract: result unions, view models and the small vocabularies
 * the components render. Type-only re-exports from the root library plus a few constants; no DB, no
 * env, no secrets, so a Client Component may import anything here. Server-only code lives in
 * ./server.ts and the `'use server'` binders in ./actions.ts.
 */
import type { ArBandKey } from '../../../src/billingAudit/arBuckets';
import type {
  ArAssigneeOption,
  ArBandSummaryRow,
  ArChargeLineRow,
  ArCursor,
  ArDenialSummaryItem,
  ArEventRow,
  ArFacilityOption,
  ArFilter,
  ArKpiRow,
  ArNotificationRow,
  ArPayerOption,
  ArQueueRow,
  ArRemitRow,
  ArSort,
  ArSortColumn,
  ArStatusEventRow,
  ArWorkStatus,
} from '../../../src/billingAudit/arQuery';

export type {
  ArAssigneeOption, ArBandKey, ArBandSummaryRow, ArChargeLineRow, ArCursor, ArDenialSummaryItem, ArEventRow,
  ArFacilityOption, ArFilter, ArKpiRow, ArNotificationRow, ArPayerOption, ArQueueRow, ArRemitRow, ArSort,
  ArSortColumn, ArStatusEventRow, ArWorkStatus,
};

/** Work-status vocabulary → label + tone. Order is the order the chips/selects render. */
export const WORK_STATUS_META: ReadonlyArray<{ value: ArWorkStatus; label: string; tone: 'muted' | 'info' | 'warn' | 'accent' | 'ok' | 'neutral' }> = [
  { value: 'open', label: 'Open', tone: 'muted' },
  { value: 'in_progress', label: 'In progress', tone: 'info' },
  { value: 'waiting_payer', label: 'Waiting on payer', tone: 'warn' },
  { value: 'appeal', label: 'Appeal', tone: 'accent' },
  { value: 'resolved', label: 'Resolved', tone: 'ok' },
  { value: 'dismissed', label: 'Dismissed', tone: 'neutral' },
];

export function workStatusLabel(value: string): string {
  return WORK_STATUS_META.find((m) => m.value === value)?.label ?? value;
}

/** A decrypted note as the drawer renders it. `text` is PHI-adjacent: only served to canRevealPhi roles. */
export interface ArNote {
  id: number;
  source: 'cmd' | 'user';
  author: string;
  noted_at: string;
  text: string;
  /** false = a patient-level CMD note that applies to every claim of this patient. */
  claim_level: boolean;
  note_type: string | null;
}

export interface ArFreshness {
  customers: number;
  oldest_as_of: string | null;
  newest_as_of: string | null;
  last_run_finished_at: string | null;
}

export interface ArSummary {
  bands: ArBandSummaryRow[];
  kpi: ArKpiRow;
}

export interface ArOptions {
  facilities: ArFacilityOption[];
  payers: ArPayerOption[];
  assignees: ArAssigneeOption[];
  freshness: ArFreshness | null;
}

export interface ArClaimDetail {
  claim: ArQueueRow;
  lines: ArChargeLineRow[];
  remits: ArRemitRow[];
  statusEvents: ArStatusEventRow[];
  events: ArEventRow[];
}

export interface ArWorkPatch {
  workStatus: ArWorkStatus;
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  dueOn: string | null;
  resolutionCode: string | null;
}

export interface ArRevealedPatient {
  patient_name: string;
  patient_dob: string | null;
  member_id: string | null;
}

export interface ArNotificationsPayload {
  unread: number;
  items: ArNotificationRow[];
}

export type ArQueueResult = { ok: true; rows: ArQueueRow[]; nextCursor: ArCursor | null } | { ok: false; error: string };
export type ArSummaryResult = { ok: true; summary: ArSummary } | { ok: false; error: string };
export type ArOptionsResult = { ok: true; options: ArOptions } | { ok: false; error: string };
export type ArClaimDetailResult = { ok: true; detail: ArClaimDetail } | { ok: false; error: string };
export type ArNotesResult = { ok: true; notes: ArNote[] } | { ok: false; error: string };
export type ArMutationResult = { ok: true } | { ok: false; error: string };
export type ArRevealResult = { ok: true; patient: ArRevealedPatient } | { ok: false; error: string };
export type ArRevealRowsResult = { ok: true; patients: Array<{ cmd_patient_id: string; patient_name: string; member_id: string | null }> } | { ok: false; error: string };
export type ArSearchResult = { ok: true; tokens: { patientNameBidx?: string[]; patientNamePrefixBidx?: string[]; memberIdBidx?: string[] } } | { ok: false; error: string };
export type ArNotificationsResult = { ok: true; payload: ArNotificationsPayload } | { ok: false; error: string };
