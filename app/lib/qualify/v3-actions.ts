'use server';

/**
 * Qualify v3 — the S0–S2 Server Action. The ONLY way the browser reaches the resolution service.
 *
 * ⚠ WHY THIS FILE EXISTS AT ALL — a defect found in this run's own Phase-F grep. The first version of
 * the v3 flow submitted S0 as `<form method="GET" action="/qualify">` with `name="term"`, which puts
 * the typed identifier in the QUERY STRING. For a 3-character prefix that is arguably within the
 * existing non-PHI contract; for a FULL MEMBER ID it is PHI in a URL, which means browser history,
 * the `Referer` header and edge logs. That is a standing-rule violation
 * ("PHI never reaches … a URL or query string"), and §S0 states the requirement directly: the term
 * stays in component state and never reaches the URL.
 *
 * A POST body carries none of those consequences: it is not in history, not in `Referer`, and not in
 * an access log. So the whole flow submits through this action instead. That is also the repo's
 * standing architecture — "the browser's only data path is Server Actions".
 *
 * GATE: `requireQualifyPrincipal` is the single choke point (super_admin + admissions_seat only,
 * fail-closed). It runs BEFORE the term is read from the form, so an unauthorized request never
 * causes a lookup — not even a rejected one.
 *
 * PHI: the term is read, converted to a blind-index token inside `resolveCoverage`, and dropped. It
 * is never logged, never returned, and never persisted. What comes back is `handle.echo`, which is
 * prefix-safe by construction ('' for a full member id).
 *
 * NOTE ON THE BLIND ROLE: this action takes no role parameter and returns no dollar field, because
 * `QualifyResolution` has nowhere to put one. An `admissions_seat` and a `super_admin` therefore
 * receive byte-identical payloads (I4) — enforced by the contract's shape, not by a stripping step
 * that could be forgotten.
 */
import { requireQualifyPrincipal } from '@/lib/qualify/gate';
import { qualifyBusinessDayIso } from '@/lib/qualify/contract';
import { resolveCoverage, trailingWindowFor } from '@/lib/qualify/resolutionService';

/**
 * ⚠ THE STATE SHAPE AND `V3_INITIAL_STATE` LIVE IN `v3FlowState.ts`, NOT HERE, AND MUST STAY THERE.
 *
 * This file is `'use server'`, so it may export ONLY async functions. `V3_INITIAL_STATE` is a plain
 * object; when it was exported from here, `next build` PASSED and the failure landed at runtime —
 * the flight loader registered the object as a Server Action and the generated per-page action entry
 * threw `A "use server" file can only export async functions, found object.` on first require. That
 * entry hosts every action reachable from `app/qualify/page`, so one bad export 500'd all 19 Qualify
 * actions while the page GET still rendered: the book overview, Heating-Up ticker and KPI tiles all
 * failed with no server log naming the cause. See `v3FlowState.ts` for the full write-up.
 *
 * A TYPE-only import is safe (types are erased). Never re-export a value from this module.
 */
import type { V3FlowState } from '@/lib/qualify/v3FlowState';

/**
 * The resolve window width is PINNED server-side — no form field moves it (audit 2026-08-12: the
 * old `windowDays` FormData read was dead code — no form ever sent it — and a client-movable
 * resolve window would let the resolution evidence and the ranking window drift apart, which is
 * exactly the P1-1 asymmetry the business-day anchor below closes).
 *
 * WIDE (365) on purpose — the resolution stages answer "does this plan have history AT ALL", which
 * is a wide question: at the old 30-day default, a plan whose last claim paid 60 days ago showed
 * "No claim history" on its tile, which is false in the sense the rep reads it. Recency honesty
 * belongs to the ANSWER stage, whose snapshot runs its own auto-window ladder and disclosed
 * rationale (docs/qualify-v3-search-pattern.md §Window policy).
 */
const DEFAULT_WINDOW_DAYS = 365;

function intField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * Resolve whatever S0/S1/S2 submitted. One action for all three steps: they are the same question
 * (what population are we looking at) answered with progressively more input, so splitting them would
 * create three places for the window and the candidate choice to disagree.
 */
export async function resolveCoverageAction(_prev: V3FlowState, form: FormData): Promise<V3FlowState> {
  const principal = await requireQualifyPrincipal();
  if (!principal.ok) {
    return { resolution: null, reason: null, echo: '', denied: principal.error };
  }

  const rawTerm = form.get('term');
  const term = typeof rawTerm === 'string' ? rawTerm : '';

  // "Today" is the ops calendar day in the business zone, NOT the server's UTC day — from
  // ~afternoon-to-midnight Pacific the raw UTC date is already tomorrow, and the ranking beside
  // this resolution anchors in business TZ (contract.ts qualifyWindowBounds), so a UTC anchor here
  // made the two describe different day ranges for that whole stretch (audit 2026-08-12, P1-1).
  const today = qualifyBusinessDayIso(new Date());
  const window = trailingWindowFor(today, DEFAULT_WINDOW_DAYS);

  const candidateRaw = intField(form, 'candidate');
  const { resolution, reason } = await resolveCoverage({
    term,
    from: window.from,
    to: window.to,
    today,
    ...(candidateRaw !== null && candidateRaw >= 0 ? { chosenIndex: candidateRaw } : {}),
  });

  // The echo is what repopulates the input. It is deliberately NOT `term`: for a full member id the
  // classifier returns '', so the id is not round-tripped through the DOM either.
  return { resolution, reason, echo: resolution?.handle.echo ?? '', denied: null };
}
