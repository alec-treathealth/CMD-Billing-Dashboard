/**
 * THE SHARED MAINTENANCE BYPASS ALLOWLIST — who reaches a surface that is behind a maintenance
 * notice for everyone else.
 *
 * WHY THIS IS ONE LIST AND NOT ONE PER SURFACE: Claims Desk and Payer Intel are gated for the SAME
 * two people, by the same decision, on the same day (Alec, 2026-08-18). Two copies of that list is
 * two chances for them to drift, and the drift is silent in the worst direction — someone added to
 * one surface and not the other looks like a permissions bug rather than a missed edit.
 *
 * ⚠ THIS IS A PRODUCT GATE, NOT A SECURITY BOUNDARY, and the difference matters when reviewing it.
 * It decides what a page RENDERS. It does not decide what a role may DO: every gated surface keeps
 * its own role gate (requirePayerIntelPrincipal, the Claims Desk view clamp), and every Server
 * Action re-gates independently. So a bypassed viewer gains nothing they were not already entitled
 * to, and a blocked viewer loses only the UI — their Server Actions remain reachable by a caller
 * who constructs one directly. That is the same posture Claims Desk has shipped with since the
 * refactor began; it is stated here so nobody mistakes this file for an authorization control.
 *
 * ⚠ QUALIFY DELIBERATELY DOES NOT USE THIS. lib/qualify/maintenance.ts keeps its own single-email
 * list because it is a DIFFERENT decision with a different history, and folding it in here would
 * silently widen Qualify access to whoever is added for Claims Desk or Payer Intel. If Qualify
 * should share this list, that needs to be its own ruling.
 *
 * Server-safe and dependency-free (the alec-only.ts convention) so layout chrome, pages and Server
 * Actions can all read it without pulling in auth or DB code. Staff email is non-PHI.
 */

/**
 * Lowercase, trimmed. Compared against a trimmed/lowercased viewer email, so a differently-cased
 * address in the identity provider still matches.
 *
 * ⚠ `alec@treathealth.ai` — note `treathealth`, not `treatheath`. The request that created this file
 * spelled it `alec@treatheath.ai` (missing the `l`), which would have locked the owner out of both
 * surfaces he was granting himself. Kept as a comment because the two spellings are one keystroke
 * apart and this list has no feedback loop: a typo here fails CLOSED and silently.
 */
const MAINTENANCE_BYPASS_EMAILS: ReadonlySet<string> = new Set([
  'alec@treathealth.ai',
  'ryan@treathealth.ai',
]);

/** True when this viewer bypasses maintenance notices and reaches the live surface. */
export function bypassesMaintenance(email: string | null | undefined): boolean {
  return MAINTENANCE_BYPASS_EMAILS.has((email ?? '').trim().toLowerCase());
}

/** Read-only view of the allowlist, for tests and for admin surfaces that display it. */
export const MAINTENANCE_BYPASS_LIST: readonly string[] = [...MAINTENANCE_BYPASS_EMAILS];
