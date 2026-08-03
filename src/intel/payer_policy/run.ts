/**
 * Driver. ONE PAYER PER INVOCATION.
 *
 * Deliberately not a fan-out over the roster in a single long-lived call: measured
 * on the 2026-08-03 batch, a key takes ~2.5-4 min and the full roster ~25 min,
 * which is past a serverless execution ceiling. A timeout mid-roster produces a
 * half-written run with no error row — the exact silent failure this design
 * refuses. Each invocation handles one key and writes its own status row, so a
 * failure costs one payer rather than the batch.
 *
 * Nothing here is scheduled. Wiring a cron is a separate, deliberate step.
 */

import { rosterEntry, rosterKeys, type RosterEntry } from './roster.js';
import { researchPayer, type MessagesTransport } from './client.js';
import { upsertRunResults, type Queryable, type UpsertCounts } from './upsert.js';
import type { ResearchResult, RunStatus } from './types.js';

/** Opus 5 input/output rates, $ per token. Only used for the cost_usd metric. */
const INPUT_RATE_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_RATE_PER_TOKEN = 25 / 1_000_000;
/** Web search is billed per request; web fetch carries no charge beyond tokens. */
const COST_PER_SEARCH = 0.01;

export interface RunOneOptions {
  payerKey: string;
  windowStart: string;
  windowEnd: string;
  focus: string;
  systemPrompt: string;
  transport: MessagesTransport;
  db?: Queryable;
  priorState?: string[];
  now?: () => number;
}

export interface RunOneResult {
  payerKey: string;
  status: RunStatus;
  failureGate: string | null;
  research: ResearchResult;
  counts: UpsertCounts | null;
  costUsd: number;
  persisted: boolean;
}

export function estimateCostUsd(research: ResearchResult): number {
  const input = research.usages.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0);
  const output = research.usages.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0);
  const raw = input * INPUT_RATE_PER_TOKEN
    + output * OUTPUT_RATE_PER_TOKEN
    + research.searchRequests * COST_PER_SEARCH;
  // 4dp to match payer_policy_run.cost_usd numeric(12,4).
  return Math.round(raw * 10_000) / 10_000;
}

/** The leading gate label, e.g. "GATE E". Null on a healthy run. */
export function failureGateOf(research: ResearchResult): string | null {
  const first = research.failures[0];
  if (!first) return null;
  return first.split(' — ')[0] ?? first;
}

/**
 * Research one key and, if a db is supplied, persist the results.
 *
 * A FAILED run does NOT persist findings. A gate tripping means we cannot trust
 * what came back — Gate E in particular means the strict-tool input was truncated
 * — so writing those rows would launder a broken run into the retrieval corpus.
 * The run row itself is still the caller's to write, with status and failure_gate,
 * so the failure is visible rather than silent.
 */
export async function runOnePayer(opts: RunOneOptions): Promise<RunOneResult> {
  const entry = rosterEntry(opts.payerKey);
  if (!entry) {
    throw new Error(`Unknown payer key "${opts.payerKey}". One of: ${rosterKeys().join(', ')}`);
  }

  const research = await researchPayer({
    payerKey: opts.payerKey,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    focus: opts.focus,
    transport: opts.transport,
    priorState: opts.priorState,
    now: opts.now,
  }, opts.systemPrompt);

  const status: RunStatus = research.failures.length ? 'failed' : 'ok';
  const failureGate = failureGateOf(research);

  let counts: UpsertCounts | null = null;
  let persisted = false;
  if (opts.db && status === 'ok' && research.payload) {
    counts = await upsertRunResults(opts.db, {
      runId: null,
      payerKey: opts.payerKey,
      allowedDomains: entry.domains,
      retrievedUrls: research.retrievedUrls,
      payload: research.payload,
    });
    persisted = true;
  }

  return {
    payerKey: opts.payerKey,
    status,
    failureGate,
    research,
    counts,
    costUsd: estimateCostUsd(research),
    persisted,
  };
}

/** Prior-state lines for the next run's suppression block. Mirrors the
 *  finding_hash key so what the prompt suppresses and what the DB dedups on
 *  cannot drift apart. */
export function priorStateLines(findings: ReadonlyArray<{
  change_type: string; date_effective: string | null; source_url: string; payer_plan: string;
}>): string[] {
  return findings.map((f, i) =>
    `${i + 1}. ${f.change_type} | eff=${f.date_effective ?? 'unknown'} | ${f.source_url} | ${f.payer_plan}`);
}

export function rosterEntryFor(key: string): RosterEntry | undefined {
  return rosterEntry(key);
}
