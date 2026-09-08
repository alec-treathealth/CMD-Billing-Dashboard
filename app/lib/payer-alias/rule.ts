/**
 * Payer-alias ruling ORCHESTRATION — everything the Server Action does after the gate.
 *
 * ── WHY THIS IS NOT IN ruling-actions.ts ─────────────────────────────────────────────────────────
 * `ruling-actions.ts` is a `'use server'` module and imports `@/lib/access`, which calls React
 * `cache()`. That throws outside a Next request context, so the action CANNOT be imported by the
 * hermetic suite — a test that "drives the action" was structurally impossible while the whole chain
 * lived there. Verified 2026-09-07: importing it fails with
 * `TypeError: (0, import_react.cache) is not a function`.
 *
 * So the chain lives here, free of Next and React imports and taking its two side-effecting
 * dependencies by injection. `ruling-actions.ts` becomes gate → delegate → revalidate. This is the
 * same split that closed the loader coverage gap (Qodo #335 review, and the loaders.ts seam before
 * it): the untestable edge stays thin, and everything with logic in it is reachable by a test.
 *
 * `revalidatePath` deliberately stays in the action — it is a Next primitive with no meaning outside
 * a request, and pulling it in here would re-break the import.
 *
 * ── SECURITY POSTURE IS UNCHANGED BY THE MOVE ────────────────────────────────────────────────────
 * This module NEVER resolves a principal. It takes an already-authenticated one as an argument, so
 * it cannot be called "logged out" — there is no code path from the browser to here that does not
 * pass through the action's `rulingPrincipal()` super_admin gate first. Attribution comes from that
 * principal and never from client input; `RulingInputSchema` has no `ruledBy` key and `.strict()`
 * rejects a payload that invents one.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
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
import type { PayerAliasDb } from './db';

const GENERIC_ERROR = 'The ruling could not be saved right now.';

/**
 * ⚠️⚠️ TEMPORARY DIAGNOSTIC INSTRUMENTATION — PREVIEW ONLY. DO NOT MERGE TO main. ⚠️⚠️
 *
 * Production raised `sqlstate=42601` (`syntax error at or near "select"`) on the first real ruling,
 * 2026-09-08 00:50:01, and wrote nothing. The same SQL, built by the same builders, executes cleanly
 * as `claims_reader` against the SAME project on the SAME port-6543 Supavisor pooler from a laptop.
 * The one thing never observed is the string production actually SENT — the catch below logs only
 * `err.code` by design, so "the text is the same" has always been an assumption, never a measurement.
 *
 * ── WHY THESE FIELDS AND NOT err.message ─────────────────────────────────────────────────────────
 * `err.message` is still NEVER logged, and that restriction is not being relaxed: Postgres echoes
 * offending literals into syntax-error messages, and `alias_norm` can hold an employer name. Every
 * field below is structurally incapable of containing a bound parameter:
 *   · position  — an integer character offset into the statement
 *   · routine   — the C function that raised (e.g. `scanner_yyerror`), a fixed symbol
 *   · sqlLen    — an integer
 *   · sqlSha256 — a one-way digest; it can only ever CONFIRM or DENY a match against a known hash
 *   · paramCount— an integer. Parameter VALUES are never touched.
 *
 * Expected hashes for the defer path, measured locally 2026-09-08 against the live database:
 *   containment   len=214 params=3 sha256=9e167f1f46661267c78d23cdc59233587a6ae5ac5c7fd45f4cc6a384e4a3dde8
 *   definer-call  len=68  params=7 sha256=5532ef59037a263dcc5f1d77ae3627578a4bc602b6c628608a64c2b8b17855a6
 * A MATCH means the bundle sent exactly what the source builds, and the fault is in transport or
 * the pooler. A MISMATCH means the deployed bundle builds a different string, and `position` says
 * where it breaks.
 *
 * `stage` is what makes this decisive rather than suggestive: it names WHICH of the two statements
 * was in flight. Everything so far has had to INFER that from pg_stat_statements call counts.
 */
interface InFlight {
  label: 'containment' | 'definer-call';
  sql: string;
  paramCount: number;
}

function diagnosticSuffix(err: unknown, inFlight: InFlight | null): string {
  if (inFlight === null) return ' stage=none';
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    position?: unknown;
    routine?: unknown;
  };
  const sha = createHash('sha256').update(inFlight.sql, 'utf8').digest('hex');
  return (
    ` stage=${inFlight.label}` +
    ` position=${e.position === undefined ? 'n/a' : String(e.position)}` +
    ` routine=${e.routine === undefined ? 'n/a' : String(e.routine)}` +
    ` sqlLen=${inFlight.sql.length}` +
    ` sqlSha256=${sha}` +
    ` paramCount=${inFlight.paramCount}`
  );
}

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
export const RulingInputSchema = z
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

/** The authenticated reviewer, resolved by the action's gate before this module is reached. */
export interface RulingPrincipal {
  email: string;
  userId: string;
}

/** The shape of `recordAccess` — injected so the chain is testable without the composition root. */
export type RecordAccessFn = (entry: {
  actorEmail: string;
  actorUserId: string;
  action: string;
  detail?: Record<string, unknown>;
}) => Promise<string>;

export interface RulingDeps {
  db: PayerAliasDb;
  recordAccess: RecordAccessFn;
}

/**
 * Rule one payer alias. Confirm, Defer-with-note, and Rule-as-unmapped are all this one path —
 * "unmapped" is a `confirm` carrying relationship `unmapped` and no canonical payer, which is what
 * the `payer_alias_map_relationship_canonical` CHECK requires.
 *
 *   zod .strict() → shape containment → DB containment → ONE definer call → access-audit line
 */
export async function executeRuling(
  deps: RulingDeps,
  principal: RulingPrincipal,
  raw: RulingFormInput,
): Promise<RulingResult> {
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

  // Belt and braces on the enum — .strict() already rejects a bad vocabulary, but the caller uses
  // this value to pick a revalidate path and it must never be anything but a known member.
  if (!isPayerAliasVocabulary(input.vocabulary)) {
    return { ok: false, error: 'That ruling is not valid.', field: 'alias' };
  }

  const shapeError = validateRulingShape(input);
  if (shapeError) return { ok: false, error: shapeError.message, field: shapeError.field };

  // ⚠️ DIAGNOSTIC ONLY (see diagnosticSuffix). Names the statement in flight so the catch can say
  // WHICH one raised instead of leaving it to be inferred. Function-local, never module state — two
  // concurrent rulings must not overwrite each other's context.
  let inFlight: InFlight | null = null;

  try {
    // ── Containment read: does the row exist and is it still unruled; is the canonical live. ──
    // This is for the MESSAGE, not the safety — the definer re-checks needs_review under FOR UPDATE.
    const cq = buildPayerAliasContainmentQuery(input.vocabulary, input.aliasNorm, input.canonicalPayerId);
    inFlight = { label: 'containment', sql: cq.sql, paramCount: cq.params.length };
    const cres = await deps.db.query<RulingContainmentFacts>(cq.sql, cq.params);
    const facts: RulingContainmentFacts = cres.rows[0] ?? { rowNeedsReview: null, canonicalActive: null };

    const containmentError = validateRulingContainment(input, facts);
    if (containmentError) {
      return { ok: false, error: containmentError.message, field: containmentError.field };
    }

    // ── THE ONE WRITE. ──
    const wq = buildPayerAliasRulingCall(input);
    inFlight = { label: 'definer-call', sql: wq.sql, paramCount: wq.params.length };
    const wres = await deps.db.query<{ ruling_id: string }>(wq.sql, wq.params);
    const rulingId = wres.rows[0]?.ruling_id;
    if (rulingId === undefined || rulingId === null) {
      // The definer returns a bigint on every success path; nothing back means something is wrong
      // enough that claiming success would be a lie.
      console.error('rulePayerAlias: definer returned no ruling id');
      return { ok: false, error: GENERIC_ERROR };
    }

    // ── Access-audit line — BEST-EFFORT, AND DELIBERATELY SO (Qodo #335 finding 4). ──
    //
    // ⚠️ THE RULING HAS ALREADY COMMITTED BY THIS POINT. `ref.rule_payer_alias` updated the crosswalk
    // and appended `ref.payer_alias_ruling_audit` in ONE transaction, which returned above — that
    // audit row is THE DURABLE RECORD of the ruling: which alias, prior and new relationship,
    // canonical, needs_review, provenance, confidence, note, ruled_by, ruled_at. It cannot be lost
    // without the ruling being lost with it (036 asserts both directions).
    //
    // `claims.access_audit` is a SECOND, weaker record: the access trail, operational metadata only,
    // no alias content. It runs on a different executor and can fail independently. Awaiting it bare
    // meant a hiccup there returned {ok:false} for a ruling that HAD landed — the client would not
    // refresh, and the reviewer's retry would hit "already ruled" and look like a bug in the queue.
    //
    // So: log it loudly and carry on. Same call the registry write surface makes
    // (app/lib/qualify/registry-actions.ts) — "the coding.audit row is the durable record; a
    // claims-audit hiccup must not report a completed write as failed". Not a bare swallow: an
    // operator needs to see that the access trail has a hole in it.
    await deps
      .recordAccess({
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
          // ⚠️ NO alias_norm — it can be an employer name, and claims.access_audit's 0017 contract is
          // operational metadata only. This id joins to the domain row that has the content.
          ruling_audit_id: String(rulingId),
        },
      })
      .catch((e) => {
        console.error('rulePayerAlias: access audit failed', e);
      });

    return { ok: true, rulingId: String(rulingId) };
  } catch (err) {
    // sqlstate only to the server log; never the driver message, which can echo bound parameters.
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : 'unknown';
    // ⚠️ TEMPORARY — the diagnosticSuffix half comes OUT before this reaches main. err.message is
    // still absent and stays absent; every appended field is an integer, a fixed symbol, or a digest.
    console.error(`rulePayerAlias failed: sqlstate=${code}${diagnosticSuffix(err, inFlight)}`);
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
