'use server';

/**
 * Coding decision registry SERVER ACTIONS (Phase A) — the browser's only path to the registry.
 * The repo's FIRST editable write surface, so the discipline is explicit and narrow:
 *
 *   gate (super_admin only, fail-closed) → zod-validate (strict, bounded) → ONE coding_editor
 *   transaction (insert new [+ close old] + audit rows) → claims access-audit line.
 *
 * Writes connect as `coding_editor` (registry-db.ts) — never claims_admin, never the service key.
 * Reads run as claims_reader (loaders.ts) and FAIL SOFT while migration 0077 is unapplied.
 * NO PHI exists on this surface by construction (payers/facilities/codes/dates/prose only).
 */
import { z } from 'zod';
import { dashboardAccess } from '@/lib/access';
import { requireRegistryEditorFromAccess } from '@/lib/qualify/principal';
import { recordAccess } from '@/lib/server';
import { withCodingEditor, codingWriterPool } from '@/lib/qualify/registry-db';
import { loadCodingDecisionHistory } from '@/lib/qualify/loaders';
import {
  buildInsertCodingDecisionQuery,
  buildSupersedeCodingDecisionQuery,
  buildInsertCodingAuditQuery,
  CODING_LIFECYCLE_VALUES,
  type CodingDecisionRow,
} from '../../../src/collections/codingRegistryQuery';

const REGISTRY_WRITE_ACTION = 'coding_registry_write';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date required');
const short = (max: number) => z.string().trim().min(1).max(max);
const optShort = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional()
    .transform((s) => s ?? null);

/** Strict, bounded input — unknown keys REJECTED (the aiAnalysis .strict() discipline). */
const DecisionInputSchema = z
  .object({
    payer_family: short(40).transform((s) => s.toUpperCase()),
    payer_variant_label: optShort(120),
    plan_alpha: optShort(20),
    employer_norm: optShort(120),
    level_of_care: z.enum(['DTX', 'RTC', 'IP', 'IOP', 'OP']).nullable().optional().transform((v) => v ?? null),
    facility_code: optShort(40),
    hcpcs_code: optShort(10),
    revenue_code: short(10),
    hcpcs_suppressed: z.boolean(),
    dos_batch_min: z.number().int().min(1).max(60).nullable().optional().transform((v) => v ?? null),
    dos_batch_max: z.number().int().min(1).max(60).nullable().optional().transform((v) => v ?? null),
    type_of_bill: optShort(8),
    drg_code: optShort(8),
    condition_codes: z.array(short(8)).max(10).nullable().optional().transform((v) => v ?? null),
    modifiers_removed: z.array(short(4)).max(10).nullable().optional().transform((v) => v ?? null),
    units_per_dos: z.number().positive().max(9999).nullable().optional().transform((v) => v ?? null),
    billing_span: z.enum(['admit_dc', 'interim']).nullable().optional().transform((v) => v ?? null),
    lifecycle: z.enum(CODING_LIFECYCLE_VALUES),
    decided_on: isoDate,
    effective_from: isoDate,
    notes: optShort(2000),
  })
  .strict()
  .refine((d) => d.dos_batch_min === null || d.dos_batch_max === null || d.dos_batch_min <= d.dos_batch_max, {
    message: 'dos_batch_min must be <= dos_batch_max',
  })
  .refine((d) => d.hcpcs_suppressed ? d.hcpcs_code === null : true, {
    message: 'a suppressed decision carries no HCPCS code',
  });

export type CodingDecisionInput = z.input<typeof DecisionInputSchema>;

export interface CodingRegistryList {
  /** False while 0077 is unapplied — the UI renders the "not yet live" notice, never a 500. */
  available: boolean;
  /** False while CODING_WRITER_DB_URL is unset — the UI renders read-only. */
  editable: boolean;
  rows: CodingDecisionRow[];
}

/** Registry list (current + history). super_admin only — same gate as writes. */
export async function getCodingRegistry(): Promise<CodingRegistryList> {
  const gate = requireRegistryEditorFromAccess(await dashboardAccess());
  if (!gate.ok) throw new Error(gate.error);
  const { available, rows } = await loadCodingDecisionHistory();
  return { available, editable: codingWriterPool() !== null, rows };
}

export type SaveCodingDecisionResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * Create a decision; when `supersedesId` is given, close that row in the SAME transaction
 * (effective_to = new effective_from, superseded_by = new id) — never a destructive update.
 */
export async function saveCodingDecision(
  input: CodingDecisionInput,
  supersedesId?: number,
): Promise<SaveCodingDecisionResult> {
  const gate = requireRegistryEditorFromAccess(await dashboardAccess());
  if (!gate.ok) return { ok: false, error: gate.error };

  const parsed = DecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid decision.' };
  }
  const d = parsed.data;
  if (supersedesId !== undefined && (!Number.isSafeInteger(supersedesId) || supersedesId < 1)) {
    return { ok: false, error: 'Invalid decision to supersede.' };
  }

  try {
    const result = await withCodingEditor(async (client) => {
      const ins = buildInsertCodingDecisionQuery({ ...d, created_by: gate.actor.email });
      const res = await client.query(ins.sql, ins.params);
      const newId = (res.rows[0] as { id: number }).id;

      const createAudit = buildInsertCodingAuditQuery({
        decision_id: newId,
        actor_email: gate.actor.email,
        action: 'create',
        before: null,
        after: d,
      });
      await client.query(createAudit.sql, createAudit.params);

      if (supersedesId !== undefined) {
        const sup = buildSupersedeCodingDecisionQuery(supersedesId, newId, d.effective_from);
        const supRes = await client.query(sup.sql, sup.params);
        if (supRes.rowCount !== 1) {
          // Row missing or already closed — abort the WHOLE write (the throw rolls back).
          throw new Error('supersede_target_not_current');
        }
        const supAudit = buildInsertCodingAuditQuery({
          decision_id: supersedesId,
          actor_email: gate.actor.email,
          action: 'supersede',
          before: null,
          after: { superseded_by: newId, effective_to: d.effective_from },
        });
        await client.query(supAudit.sql, supAudit.params);
      }
      return newId;
    });

    if (result === null) {
      return { ok: false, error: 'Registry editing is not configured yet (writer connection absent).' };
    }

    // Operator attribution in the app-wide access audit (non-PHI detail: family + facility labels).
    await recordAccess({
      actorEmail: gate.actor.email,
      actorUserId: gate.actor.userId,
      action: REGISTRY_WRITE_ACTION,
      detail: {
        decision_id: result,
        payer_family: d.payer_family,
        facility_code: d.facility_code,
        lifecycle: d.lifecycle,
        ...(supersedesId !== undefined ? { supersedes: supersedesId } : {}),
      },
    }).catch(() => {
      // best-effort: the coding.audit row is the durable record; a claims-audit hiccup must not
      // report a completed write as failed
    });

    return { ok: true, id: result };
  } catch (err) {
    if (err instanceof Error && err.message === 'supersede_target_not_current') {
      return { ok: false, error: 'That decision was already superseded — reload and try again.' };
    }
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code ?? '') : '';
    console.error(`saveCodingDecision failed (sqlstate ${code || 'none'})`); // code only; never SQL/driver detail, never to the client
    return { ok: false, error: 'The decision could not be saved.' };
  }
}
