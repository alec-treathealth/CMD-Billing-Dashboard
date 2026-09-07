'use server';

/**
 * Payer-alias ruling SERVER ACTION — the browser's only path to `ref.payer_alias_map`.
 *
 * This module is deliberately THIN: gate → delegate → revalidate. Everything with logic in it lives
 * in ./rule.ts, which imports no Next and no React and is therefore reachable by the hermetic suite.
 * A `'use server'` module cannot be imported by a test — it pulls `@/lib/access`, which calls React
 * `cache()` and throws outside a request context (verified 2026-09-07:
 * `TypeError: (0, import_react.cache) is not a function`) — so any chain that lived here was
 * untestable by construction. Keep it that way: new logic goes in ./rule.ts, not below.
 *
 *   gate (super_admin, fail-closed, real principal only)                          <- here
 *     → zod .strict() → containment → ONE ref.rule_payer_alias call → audit line  <- ./rule.ts
 *     → revalidate                                                                <- here
 *
 * ⚠️ A `'use server'` module may export ONLY async functions. `export type` is erased at compile
 * time and is safe; a plain value export passes next build, both typechecks and both suites, then
 * throws at first require and 500s EVERY Server Action on the page.
 *
 * Reads and the write both connect as `claims_reader`. The reader holds SELECT on the three `ref.*`
 * tables and EXECUTE on the definer, and NO UPDATE on the crosswalk. The mutation happens inside
 * `ref.rule_payer_alias` under its owner `claims_admin` (Veris 035/036). Never claims_admin on the
 * app path, never the service-role key. This follows the facility-resolution precedent
 * (app/lib/facility-resolution-actions.ts) rather than the registry's dedicated-role shape — ruled
 * 2026-09-05, and re-affirmed against Qodo #335 finding 2.
 *
 * ── ⚠️ "NO BULK CONFIRM" IS A UI GUARANTEE. THE DATABASE DOES NOT ENFORCE IT. ────────────────────
 * There is no bulk endpoint and the form rules one alias at a time, but that is the whole of the
 * protection. `claims_reader` holds EXECUTE on `ref.rule_payer_alias` and **nothing bounds call
 * count** — no rate limit, no per-session cap, no server-side batch guard. Anything that can invoke
 * this action can invoke it 990 times and rule the entire book, one attributed audit row at a time.
 * Raised as H1 in the 2026-09-06 review and ACCEPTED as-is: the surface is super_admin-only and every
 * call is attributed and audited. A bulk affordance would need a DB-side bound inside the definer,
 * not a disabled button — and if a non-super_admin role is ever granted this surface, this paragraph
 * becomes a blocker rather than a note.
 *
 * ── PHI ──────────────────────────────────────────────────────────────────────────────────────────
 * `alias_norm` can hold an EMPLOYER NAME (`employer_self_funded` is a real relationship), and
 * `employer_name` is in the PhiKey union though display to an authenticated principal was ruled
 * acceptable 2026-08-14.
 *
 * ⚠️ THE HANDLING IS A PRECAUTION WE CHOSE, NOT A CONVENTION WE INHERITED. No repo rule covers
 * `alias_norm`: the PHI denylist in `pr_compliance_checklist.yaml` names patient_name / member_id /
 * dob and stops there. Treating this column like `employer_name` is our inference, enforced by the
 * tests in this repo and nothing else. Codifying it is a named follow-up. It therefore:
 *   · travels only as a bound `$n` parameter, never interpolated into SQL;
 *   · never enters a URL, a redirect target, or browser storage;
 *   · NEVER enters the recordAccess detail blob — see ./rule.ts;
 *   · never reaches an LLM (nothing on this surface calls one).
 * Error strings returned to the client are our own field messages, never a raw driver error.
 */
import { revalidatePath } from 'next/cache';
import { dashboardAccess } from '@/lib/access';
import { recordAccess } from '@/lib/server';
import { payerAliasDb } from './db';
import { executeRuling, type RulingFormInput, type RulingPrincipal, type RulingResult } from './rule';

export type { RulingFormInput, RulingResult };

/** Gate: super_admin only, real principal only, fail-closed. Mirrors the page's front-door check. */
async function rulingPrincipal(): Promise<RulingPrincipal | null> {
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
 * "unmapped" is a `confirm` carrying relationship `unmapped` and no canonical payer.
 */
export async function rulePayerAlias(raw: RulingFormInput): Promise<RulingResult> {
  const principal = await rulingPrincipal();
  if (!principal) return { ok: false, error: 'You are not permitted to rule payer aliases.' };

  const result = await executeRuling({ db: payerAliasDb(), recordAccess }, principal, raw);

  // Only on success — a rejected ruling changed nothing, and revalidating would throw away a warm
  // page to redraw the identical list.
  if (result.ok) revalidatePath('/admin/payer-aliases');
  return result;
}
