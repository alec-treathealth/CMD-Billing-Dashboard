/**
 * Resolve and persist findings.
 *
 * Two rules here are the whole point of the module:
 *
 *  1. PROVENANCE IS A HARD GATE, not a warning. `source_url` inside an
 *     emit_findings tool call is a model-typed string. Under
 *     `response_inclusion: "full"` the web_search/web_fetch result blocks give us
 *     the set of URLs the API actually returned, and every source_url is validated
 *     against it. A finding whose source_url is not in that set is QUARANTINED —
 *     stored for audit, excluded from retrieval. This is what stops a
 *     hallucinated or reconstructed citation from being indexed as fact.
 *
 *  2. `no_change` and `unreachable` NEVER become findings and are NEVER embedded.
 *     They go to intel.payer_policy_run_check only. There is no code path here
 *     that can move them, and the finding table has no column able to express
 *     them.
 *
 * All SQL is parameterized with explicit column lists — no SELECT *, no
 * interpolated values. Writes go as `intel_writer` (INSERT + UPDATE only).
 * Non-PHI throughout, so no encryption path is involved.
 */

import { createHash } from 'node:crypto';
import { matchesAnyDomain, registrableDomain } from './roster.js';
import type {
  EmitFindingsPayload, RawFinding, ResolvedFinding, SourceTier,
} from './types.js';

/** Minimal surface we need from a pg Pool, so tests can supply a fake. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

/** The model writes the literal 'unknown' when a date is not establishable. Map
 *  that (and any non-ISO junk) to NULL rather than storing a sentinel string. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * DERIVED, never model-emitted. Under a primary-only allowed_domains map a
 * model-emitted tier is a tautology — the 2026-08-03 batch returned primary
 * 10/10 — so asking the model for it only creates a field it can get wrong.
 */
export function deriveSourceTier(url: string, allowedDomains: readonly string[]): SourceTier {
  return matchesAnyDomain(url, allowedDomains) ? 'primary' : 'secondary';
}

/**
 * sha256 of payer_plan|change_type|date_effective|source_url.
 *
 * Validated on real data: 10/10 distinct tuples with zero collisions across the
 * first batch, including two findings that shared a source_url but differed on
 * change_type. `date_effective` is normalized first so 'unknown' and '' cannot
 * hash to different rows for the same underlying finding.
 */
export function findingHash(finding: Pick<RawFinding,
  'payer_plan' | 'change_type' | 'date_effective' | 'source_url'>): string {
  const parts = [
    finding.payer_plan.trim(),
    finding.change_type,
    normalizeDate(finding.date_effective) ?? '',
    finding.source_url.trim(),
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

/**
 * Pipeline verdict on the SOURCE — orthogonal to the model's `confidence`, which
 * is a verdict on the CLAIM. Never collapse the two into one filter.
 */
export function resolveStatus(
  finding: RawFinding,
  retrievedUrls: ReadonlySet<string>,
): ResolvedFinding['status'] {
  if (!retrievedUrls.has(finding.source_url)) return 'quarantined';
  return finding.confidence === 'confirmed' ? 'confirmed' : 'needs_verification';
}

export function resolveFinding(
  finding: RawFinding,
  payerKey: string,
  allowedDomains: readonly string[],
  retrievedUrls: ReadonlySet<string>,
): ResolvedFinding {
  let sourceDomain = finding.source_domain?.trim() ?? '';
  if (!sourceDomain) {
    try {
      sourceDomain = registrableDomain(new URL(finding.source_url).hostname);
    } catch {
      sourceDomain = 'unknown';
    }
  }
  return {
    finding_hash: findingHash(finding),
    payer_key: payerKey,
    payer_plan: finding.payer_plan,
    change_type: finding.change_type,
    originator: finding.originator,
    summary: finding.summary,
    codes_affected: finding.codes_affected ?? [],
    scope: finding.scope ?? 'unclear',
    self_funded_relevant: Boolean(finding.self_funded_relevant),
    date_published: normalizeDate(finding.date_published),
    date_approved: normalizeDate(finding.date_approved),
    date_effective: normalizeDate(finding.date_effective),
    source_url: finding.source_url,
    source_domain: sourceDomain,
    source_tier: deriveSourceTier(finding.source_url, allowedDomains),
    confidence: finding.confidence,
    status: resolveStatus(finding, retrievedUrls),
    embed_text: finding.embed_text,
  };
}

/**
 * Whether an existing row needs updating. Only `source_url` or `date_effective`
 * changing counts — those are the two fields that alter what the finding points
 * at. Anything else re-arriving identically is a no-op, which is what makes a
 * re-run of the same window cost zero writes.
 *
 * Extracted as a pure function so the idempotency guarantee is testable without a
 * database.
 */
export function shouldUpdateFinding(
  existing: Pick<ResolvedFinding, 'source_url' | 'date_effective'>,
  incoming: Pick<ResolvedFinding, 'source_url' | 'date_effective'>,
): boolean {
  return existing.source_url !== incoming.source_url
    || (existing.date_effective ?? null) !== (incoming.date_effective ?? null);
}

const FINDING_COLUMNS = [
  'finding_hash', 'run_id', 'payer_key', 'payer_plan', 'change_type', 'originator',
  'summary', 'codes_affected', 'scope', 'self_funded_relevant', 'date_published',
  'date_approved', 'date_effective', 'source_url', 'source_domain', 'source_tier',
  'confidence', 'status', 'embed_text',
] as const;

/**
 * `embedding` is deliberately omitted: it stays NULL here. BGE-M3 (src/brain2,
 * src/brain3) is the one embedding path in this repo and a separate pass fills it.
 * The generated `embed_tsv` column makes findings retrievable on day one without
 * any embedding at all.
 *
 * The guarded ON CONFLICT is the idempotency gate: re-running an identical window
 * matches on finding_hash and the WHERE clause suppresses the write entirely, so
 * `rowCount` comes back 0 rather than churning last_seen_at on every run.
 */
export const UPSERT_FINDING_SQL = `
  INSERT INTO intel.payer_policy_finding (${FINDING_COLUMNS.join(', ')})
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
  ON CONFLICT (finding_hash) DO UPDATE SET
    source_url     = EXCLUDED.source_url,
    date_effective = EXCLUDED.date_effective,
    date_published = EXCLUDED.date_published,
    status         = EXCLUDED.status,
    confidence     = EXCLUDED.confidence,
    run_id         = EXCLUDED.run_id,
    last_seen_at   = now()
  WHERE intel.payer_policy_finding.source_url IS DISTINCT FROM EXCLUDED.source_url
     OR intel.payer_policy_finding.date_effective IS DISTINCT FROM EXCLUDED.date_effective
  RETURNING (xmax = 0) AS inserted
`;

export const INSERT_RUN_CHECK_SQL = `
  INSERT INTO intel.payer_policy_run_check (run_id, payer, outcome, reason_code, reason, url)
  VALUES ($1, $2, $3, $4, $5, $6)
`;

export function findingParams(finding: ResolvedFinding, runId: string | null): unknown[] {
  return [
    finding.finding_hash, runId, finding.payer_key, finding.payer_plan,
    finding.change_type, finding.originator, finding.summary, finding.codes_affected,
    finding.scope, finding.self_funded_relevant, finding.date_published,
    finding.date_approved, finding.date_effective, finding.source_url,
    finding.source_domain, finding.source_tier, finding.confidence, finding.status,
    finding.embed_text,
  ];
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  checksWritten: number;
}

/**
 * Persists one run's findings and its no_change/unreachable checks.
 *
 * Quarantined findings ARE stored — the point is auditability of what the model
 * claimed, with the row marked so retrieval excludes it. Callers wanting them
 * dropped entirely should filter before calling.
 */
export async function upsertRunResults(
  db: Queryable,
  args: {
    runId: string | null;
    payerKey: string;
    allowedDomains: readonly string[];
    retrievedUrls: readonly string[];
    payload: EmitFindingsPayload;
  },
): Promise<UpsertCounts> {
  const retrieved = new Set(args.retrievedUrls);
  const counts: UpsertCounts = {
    inserted: 0, updated: 0, unchanged: 0, quarantined: 0, checksWritten: 0,
  };

  const resolved = args.payload.findings.map((finding) =>
    resolveFinding(finding, args.payerKey, args.allowedDomains, retrieved));

  for (const finding of resolved) {
    if (finding.status === 'quarantined') counts.quarantined += 1;
    const result = await db.query(UPSERT_FINDING_SQL, findingParams(finding, args.runId));
    if (!result.rowCount) {
      // Conflict matched and the guard suppressed the write — a true no-op.
      counts.unchanged += 1;
      continue;
    }
    const inserted = (result.rows[0] as { inserted?: boolean } | undefined)?.inserted;
    if (inserted) counts.inserted += 1;
    else counts.updated += 1;
  }

  // no_change and unreachable go ONLY here. They are never findings, never embedded.
  if (args.runId) {
    for (const source of args.payload.checked_no_change) {
      await db.query(INSERT_RUN_CHECK_SQL, [args.runId, args.payerKey, 'no_change', null, source, null]);
      counts.checksWritten += 1;
    }
    for (const item of args.payload.unreachable) {
      await db.query(INSERT_RUN_CHECK_SQL, [
        args.runId, item.payer ?? args.payerKey, 'unreachable',
        item.reason_code ?? 'other', item.reason ?? null,
        item.url && item.url !== 'none' ? item.url : null,
      ]);
      counts.checksWritten += 1;
    }
  }

  return counts;
}
