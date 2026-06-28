/**
 * CMD "Collections Explorer" report mapping (Derek's 14-column batch export).
 *
 * Maps the CMD batch-report CSV rows (parsed by cmdPayer.ts) into the 14-column
 * explorer shape, SPLIT into a non-PHI projection (safe to cache + ship to the
 * browser) and a PHI projection (Patient Full Name / Member ID / Group Number),
 * which is NEVER cached at rest and is surfaced only via the audited per-row reveal.
 *
 * Each row carries a content fingerprint `rowId` = SHA-256 over ALL 14 field values
 * (incl. PHI). The hash is a one-way token (this project already treats SHA-256 of
 * patient terms as a non-PHI binding token — see queries/identity.ts), so it is safe
 * to store in the non-PHI cache. Because the hash includes the PHI, a rowId matches
 * EXACTLY one row's content: the reveal path can fail closed to "unavailable" but can
 * never surface a different patient's identifiers.
 *
 * Pure + env-free (composition-root pattern): no network, no secrets, never logs cell
 * values. The live fetch/poll/unzip lives in cmdPayer.ts; this only maps parsed rows.
 */
import { createHash } from 'node:crypto';
import type { CmdReportRow } from './cmdPayer.js';

/** Verified CMD report CSV headers. One alias each for resilience to label edits. */
const HEADERS = {
  charge_from_date: ['Charge From Date'],
  payment_received: ['Payment Received'],
  cpt_code: ['Charge CPT Code', 'CPT Code'],
  revenue_code: ['Revenue Code'],
  facility: ['Facility Name'],
  patient_name: ['Patient Full Name'], //               PHI
  member_id_raw: ['Claim Primary Member ID'], //         PHI
  group_number: ['Primary Group Number'], //             PHI
  charge_amount: ['Charge/Debit Amount'],
  allowed_amount: ['Payment Allowed Amount'],
  insurance_payments: ['Charge Insurance Payments'],
  adjustments: ['Charge Total Adjustments w/o Transfers'],
  patient_balance_due: ['Charge Balance Due Pat'],
  primary_payer: ['Charge Primary Payer Name'],
} as const;

/** The 3 PHI fields surfaced only behind the audited per-row reveal. */
export interface CmdExplorerPhi {
  patient_name: string | null;
  member_id_raw: string | null;
  group_number: string | null;
}

/** Non-PHI projection of one report line — safe to cache and ship to the browser. */
export interface CmdExplorerNonPhiRow {
  /** Content fingerprint (SHA-256 over all 14 fields incl. PHI); non-reversible. */
  rowId: string;
  charge_from_date: string | null;
  payment_received: string | null;
  cpt_code: string | null;
  revenue_code: string | null;
  facility: string | null;
  charge_amount: string | null;
  allowed_amount: string | null;
  insurance_payments: string | null;
  adjustments: string | null;
  patient_balance_due: string | null;
  primary_payer: string | null;
}

/** Full row = non-PHI projection + its PHI. Held only in volatile server memory. */
export interface CmdExplorerFullRow extends CmdExplorerNonPhiRow {
  phi: CmdExplorerPhi;
}

/**
 * NON-PHI projection of one PERSISTED explorer row (collections.cmd_explorer_rows),
 * returned by the DB-backed reader. `id` is the bigserial PK — the keyset-pagination
 * cursor AND the per-row reveal key (it replaces the old SHA-256 `rowId`). The 3 PHI
 * columns are stored as ciphertext and are NEVER part of this shape; they surface only
 * via the audited reveal. Dates are ISO 'YYYY-MM-DD'; money is a fixed-2-decimal string
 * (pg numeric); `ingested_at` is ISO-8601 UTC.
 */
export interface CmdExplorerRow {
  id: number;
  charge_date: string;
  payment_received: string | null;
  cpt_code: string;
  revenue_code: string | null;
  facility: string;
  charge_amount: string;
  allowed_amount: string | null;
  insurance_payments: string | null;
  adjustments: string | null;
  patient_balance_due: string | null;
  primary_payer: string | null;
  ingested_at: string;
}

/** Trim; empty string → null (so blanks render as an em dash, not ''). */
function norm(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Case-insensitive read across candidate header names. */
function pick(row: CmdReportRow, candidates: readonly string[]): string | null {
  for (const c of candidates) if (c in row) return norm(row[c]);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const c of candidates) {
    const v = lower[c.toLowerCase()];
    if (v !== undefined) return norm(v);
  }
  return null;
}

/** Map parsed CSV rows to the explorer shape (non-PHI + PHI + content rowId). */
export function mapReportRows(rows: CmdReportRow[]): CmdExplorerFullRow[] {
  return rows.map((row) => {
    const nonPhi = {
      charge_from_date: pick(row, HEADERS.charge_from_date),
      payment_received: pick(row, HEADERS.payment_received),
      cpt_code: pick(row, HEADERS.cpt_code),
      revenue_code: pick(row, HEADERS.revenue_code),
      facility: pick(row, HEADERS.facility),
      charge_amount: pick(row, HEADERS.charge_amount),
      allowed_amount: pick(row, HEADERS.allowed_amount),
      insurance_payments: pick(row, HEADERS.insurance_payments),
      adjustments: pick(row, HEADERS.adjustments),
      patient_balance_due: pick(row, HEADERS.patient_balance_due),
      primary_payer: pick(row, HEADERS.primary_payer),
    };
    const phi: CmdExplorerPhi = {
      patient_name: pick(row, HEADERS.patient_name),
      member_id_raw: pick(row, HEADERS.member_id_raw),
      group_number: pick(row, HEADERS.group_number),
    };
    const rowId = createHash('sha256').update(JSON.stringify([nonPhi, phi])).digest('hex');
    return { rowId, ...nonPhi, phi };
  });
}

/** Strip PHI for the cacheable / browser-bound projection. */
export function toNonPhi(rows: CmdExplorerFullRow[]): CmdExplorerNonPhiRow[] {
  return rows.map((r) => {
    const { phi, ...rest } = r;
    void phi; // intentionally omit PHI from the projection
    return rest;
  });
}
