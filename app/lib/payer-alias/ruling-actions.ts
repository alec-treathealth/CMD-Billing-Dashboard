'use server';

/**
 * Payer-alias ruling SERVER ACTIONS — the browser's only path to `ref.payer_alias_map`.
 *
 * Discipline mirrors the stated exemplars (qualify/registry-actions.ts, facility-resolution-actions.ts):
 *
 *   gate (super_admin, fail-closed, real principal only)
 *     → zod .strict() (unknown keys REJECTED, bounds from the live CHECKs)
 *     → containment (shape, then one read) so a rejection names a FIELD
 *     → ONE call to ref.rule_payer_alias
 *     → claims.access_audit line
 *
 * Reads and the write both connect as `claims_reader`. The reader holds SELECT on the three `ref.*`
 * tables and EXECUTE on the definer, and NO UPDATE on the crosswalk. The mutation happens inside
 * `ref.rule_payer_alias` under its owner `claims_admin` (Veris 035). Never claims_admin on the app
 * path, never the service-role key.
 *
 * ── ⚠️ "NO BULK CONFIRM" IS A UI GUARANTEE. THE DATABASE DOES NOT ENFORCE IT. ────────────────────
 * There is no bulk endpoint here and the form rules one alias at a time, but that is the whole of
 * the protection. `claims_reader` holds EXECUTE on `ref.rule_payer_alias` and **nothing bounds call
 * count** — no rate limit, no per-session cap, no server-side batch guard. Anything that can invoke
 * this action can invoke it 990 times in a loop and rule the entire book, one attributed audit row
 * at a time. Raised as H1 in the 2026-09-06 review and ACCEPTED as-is, on the grounds that the
 * surface is super_admin-only and every call is attributed and audited. If a bulk affordance is ever
 * wanted, it needs a DB-side bound (a per-caller cap inside the definer), not just a disabled
 * button — and if a non-super_admin role is ever granted this surface, this paragraph becomes a
 * blocker rather than a note.
 *
 * ── PHI ──────────────────────────────────────────────────────────────────────────────────────────
 * `alias_norm` can hold an EMPLOYER NAME (`employer_self_funded` is a real relationship), and
 * `employer_name` is in the PhiKey union though display to an authenticated principal was ruled
 * acceptable 2026-08-14.
 *
 * ⚠️ THE HANDLING BELOW IS A PRECAUTION WE CHOSE, NOT A CONVENTION WE INHERITED. No repo rule covers
 * `alias_norm`: the PHI denylist in `pr_compliance_checklist.yaml` names patient_name / member_id /
 * dob and stops there. Treating this column like `employer_name` is our inference, enforced by the
 * tests in this repo and nothing else. Codifying it is a named follow-up. It therefore:
 *   · travels only as a bound `$n` parameter, never interpolated into SQL;
 *   · never enters a URL, a redirect target, or browser storage;
 *   · NEVER enters the recordAccess detail blob — see the detail construction below;
 *   · never reaches an LLM (nothing on this surface calls one).
 * Error strings returned to the client are our own field messages, never a raw driver error.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { dashboardAccess } from '@/lib/access';
import { recordAccess } from '@/lib/server';
import { payerAliasDb } from './db';
import {
  buildPayerAliasContainmentQuery,
  buildPayerAliasRulingCall,
  isPayerAliasVocabulary,
  PAYER_ALIAS_RELATIONSHIPS,
  PAYER_ALIAS_RULING_AUDIT_ACTION,
  PAYER_ALIAS_VOCABULARIES,
  RULING_ACTIONS,
  validateRulingContainment,
  validateRulingShape,
  type PayerAliasRulingInput,
  type RulingContainmentFacts,
  type RulingFieldError,
} from '../../../src/collections/payerAliasQueue';

const GENERIC_ERROR = 'The ruling could not be saved right now.';

const RULING_FIELDS = ['alias', 'action', 'relationship', 'canonicalPayerId', 'reviewNote', 'ruledBy'] as const;
function isRulingField(value: string): value is RulingFieldError['field'] {
  return (RULING_FIELDS as readonly string[]).includes(value);
}

export type RulingResult =
  | { ok: true; rulingId: string }
  | { ok: false; error: string; field?: RulingFieldError['field'] };

/**
 * Strict, bounded input — unknown keys REJECTED (the aiAnalysis / registry-actions discipline).
 * Bounds mirror the live CHECK constraints so a violation is a field message, never a raw 23514.
 *
 * `ruledBy` is deliberately ABSENT: the reviewer's identity comes from the session, never from the
 * client. A payload that tried to supply it is rejected by .strict() rather than ignored.
 */
const RulingInputSchema = z
  .object({
    vocabulary: z.enum(PAYER_ALIAS_VOCABULARIES),
    // payer_alias_map_alias_len: 1..200. Not trimmed — alias_norm is a stored PK value and must
    // match byte-for-byte; trimming here would silently miss a row whose key has real whitespace.
    aliasNorm: z.string().min(1).max(200),
    action: z.enum(RULING_ACTIONS),
    relationship: z.enum(PAYER_ALIAS_RELATIONSHIPS).nullable(),
    // payer_identity_id_shape + _id_len.
    canonicalPayerId: z
      .string()
      .regex(/^pi_[a-z0-9_]+$/)
      .min(3)
      .max(80)
      .nullable(),
    // payer_alias_map_review_note_len: 2..500 when present. '' normalises to null (stored as NULL).
    reviewNote: z
      .string()
      .max(500)
      .nullable()
      .transform((s) => (s === null || s.trim() === '' ? null : s.trim())),
  })
  .strict();

export type RulingFormInput = z.input<typeof RulingInputSchema>;

/** Gate: super_admin only, real principal only, fail-closed. Mirrors the page's front-door check. */
async function rulingPrincipal(): Promise<{ email: string; userId: string } | null> {
  const result = await dashboardAccess();
  if (!result.ok) return null;
  const { access } = result;
  // The staged-rollout fallback returns role super_admin with user: null. Testing the role alone
  // would hand the write path to an unauthenticated request wherever auth is unconfigured.
  if (!access.user) return null;
  if (access.role !== 'super_admin') return null;
  const email = access.user.email?.trim();
  if (!email) return null;
  return { email, userId: access.user.id };
}

/**
 * Rule one payer alias. Confirm, Defer-with-note, and Rule-as-unmapped are all this one action —
 * "unmapped" is a `confirm` carrying relationship `unmapped` and no canonical payer, which is what
 * the `payer_alias_map_relationship_canonical` CHECK requires.
 */
export async function rulePayerAlias(raw: RulingFormInput): Promise<RulingResult> {
  const principal = await rulingPrincipal();
  if (!principal) return { ok: false, error: 'You are not permitted to rule payer aliases.' };

  const parsed = RulingInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path[0];
    return {
      ok: false,
      error: 'That ruling is not valid.',
      // Only surface a field name we actually model; an unknown-key rejection has no field to blame.
      field: typeof field === 'string' && isRulingField(field) ? field : undefined,
    };
  }

  const input: PayerAliasRulingInput = { ...parsed.data, ruledBy: principal.email };

  // Belt and braces on the enum — .strict() already rejects a bad vocabulary, but this value selects
  // a revalidate path below and must never be anything but a known member.
  if (!isPayerAliasVocabulary(input.vocabulary)) {
    return { ok: false, error: 'That ruling is not valid.', field: 'alias' };
  }

  const shapeError = validateRulingShape(input);
  if (shapeError) return { ok: false, error: shapeError.message, field: shapeError.field };

  const db = payerAliasDb();

  try {
    // ── Containment read: does the row exist and is it still unruled; is the canonical live. ──
    // This is for the MESSAGE, not the safety — the definer re-checks needs_review under FOR UPDATE.
    const cq = buildPayerAliasContainmentQuery(input.vocabulary, input.aliasNorm, input.canonicalPayerId);
    const cres = await db.query<RulingContainmentFacts>(cq.sql, cq.params);
    const facts: RulingContainmentFacts = cres.rows[0] ?? { rowNeedsReview: null, canonicalActive: null };

    const containmentError = validateRulingContainment(input, facts);
    if (containmentError) {
      return { ok: false, error: containmentError.message, field: containmentError.field };
    }

    // ── THE ONE WRITE. ──
    const wq = buildPayerAliasRulingCall(input);
    const wres = await db.query<{ ruling_id: string }>(wq.sql, wq.params);
    const rulingId = wres.rows[0]?.ruling_id;
    if (rulingId === undefined || rulingId === null) {
      // The definer returns a bigint on every success path; nothing back means something is wrong
      // enough that claiming success would be a lie.
      console.error('rulePayerAlias: definer returned no ruling id');
      return { ok: false, error: GENERIC_ERROR };
    }

    // ── Access-audit line. ⚠️ NO alias_norm — it can be an employer name, and claims.access_audit's
    // 0017 contract is operational metadata only. The DOMAIN record (which alias, prior and new
    // state) lives in ref.payer_alias_ruling_audit, keyed by this same ruling id. That split is
    // deliberate: the audit table holds the content, the access trail holds the access.
    await recordAccess({
      actorEmail: principal.email,
      actorUserId: principal.userId,
      action: PAYER_ALIAS_RULING_AUDIT_ACTION,
      detail: {
        vocabulary: input.vocabulary,
        ruling_action: input.action,
        relationship: input.action === 'confirm' ? input.relationship : null,
        canonical_payer_id: input.canonicalPayerId,
        confirmed: input.action === 'confirm',
        note_present: input.reviewNote !== null,
        ruling_audit_id: String(rulingId),
      },
    });

    revalidatePath('/admin/payer-aliases');
    return { ok: true, rulingId: String(rulingId) };
  } catch (err) {
    // sqlstate only to the server log; never the driver message, which can echo bound parameters.
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : 'unknown';
    console.error(`rulePayerAlias failed: sqlstate=${code}`);
    // P0002 here means the row was ruled between our containment read and the definer call — a real
    // race, and the definer's guard is what caught it. Say so rather than showing a generic failure.
    if (code === 'P0002') {
      return {
        ok: false,
        error: 'Someone ruled this alias a moment ago. Refresh to see their ruling.',
        field: 'alias',
      };
    }
    return { ok: false, error: GENERIC_ERROR };
  }
}

