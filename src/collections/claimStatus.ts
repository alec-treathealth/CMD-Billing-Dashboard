/**
 * CMD Claim/Charge Status taxonomy — the SINGLE source of truth for normalizing CMD's raw
 * "Claim Status" / "Charge Status" label into a small closed category set. Extracted verbatim
 * from src/billingAudit/auditRowMap.ts (Qualify v2 feed series ②a) so BOTH consumers share ONE
 * taxonomy — no duplication, no SQL enum:
 *   - the billing-audit plane (auditRowMap.ts imports + RE-EXPORTS these, so its public surface
 *     and behavior stay byte-identical to before the move), and
 *   - the collections CMD ingest (cmd_explorer_rows.claim_status_category is populated by
 *     normalizeStatus at map time — ②a).
 *
 * Pure + dependency-free (string ops only): safe for either plane to import. billingAudit →
 * collections is an established import direction (alongside normalize.ts / phiCrypto.ts), so this
 * introduces no new pattern and no cycle (this module imports nothing).
 *
 * 24-value live vocabulary → 7 categories (live-verified 2026-07-13). Do NOT change the mapping
 * without a deliberate ruling — it is now shared by two planes.
 */

export type StatusCategory =
  | 'PAID' | 'BALANCE_DUE_PATIENT' | 'AT_PAYER' | 'APPROVED_HIGHER'
  | 'NEEDS_RENEGOTIATING' | 'ON_HOLD' | 'OTHER';

export interface NormalizedStatus {
  category: StatusCategory;
  /** The <X> from 'CLAIM AT <X>[ - SECONDARY]'; null for every other category. */
  statusPayer: string | null;
}

/**
 * Map a raw Charge Status to its category. Exact fixed labels first; the 'CLAIM AT <X>'
 * family (with an optional ' - SECONDARY' suffix, which is stripped INTO the payer —
 * the raw string is preserved separately) → AT_PAYER; everything else → OTHER with the
 * raw preserved by the caller ('PENDING FOR HIGHER PAYMENT' lands here by ruling —
 * pending ≠ approved). Case/whitespace tolerant; never throws.
 */
export function normalizeStatus(raw: string | null): NormalizedStatus {
  const t = (raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (t === 'PAID') return { category: 'PAID', statusPayer: null };
  if (t === 'BALANCE DUE PATIENT') return { category: 'BALANCE_DUE_PATIENT', statusPayer: null };
  if (t === 'APPROVED FOR HIGHER PAYMENT') return { category: 'APPROVED_HIGHER', statusPayer: null };
  if (t === 'NEEDS RENEGOTIATING') return { category: 'NEEDS_RENEGOTIATING', statusPayer: null };
  if (t === 'ON HOLD') return { category: 'ON_HOLD', statusPayer: null };
  if (t.startsWith('CLAIM AT ')) {
    let payer = t.slice('CLAIM AT '.length).trim();
    if (payer.endsWith(' - SECONDARY')) payer = payer.slice(0, -' - SECONDARY'.length).trim();
    return payer === ''
      ? { category: 'OTHER', statusPayer: null }
      : { category: 'AT_PAYER', statusPayer: payer };
  }
  return { category: 'OTHER', statusPayer: null };
}
