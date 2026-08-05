/**
 * Qualify v3 — the S0–S2 flow STATE SHAPE and its initial value.
 *
 * ⚠ WHY THIS FILE EXISTS, AND WHY THE CONSTANT MUST NEVER MOVE BACK INTO `v3-actions.ts`.
 *
 * A `'use server'` module may export ONLY async functions. `V3_INITIAL_STATE` is a plain object, and
 * it originally lived in `v3-actions.ts` (which is `'use server'`). Next did NOT reject that at build
 * time — `next build` passed, and the whole five-command gate passed with it. Instead the webpack
 * flight loader registered the object as a Server Action and deferred the check to RUNTIME, where the
 * generated per-page action entry throws on first require:
 *
 *     ⨯ Error: A "use server" file can only export async functions, found object.
 *       at 8547 (.next/server/app/qualify/page.js)
 *
 * Module 8547 is the entry that hosts EVERY Server Action reachable from `app/qualify/page` — the
 * built `server-reference-manifest` put `getQualifyOverview` and `V3_INITIAL_STATE` in the SAME
 * worker/moduleId. So one bad export took down all 19 Qualify actions on the desktop surface with a
 * 500, while the page GET kept rendering fine (rendering never requires the action entry). The
 * user-visible result was a page that loaded with "Couldn't load the book overview", no Heating-Up
 * ticker, and blank KPI tiles — with NO server-side log line naming the cause, because the throw
 * happens before any of our code runs.
 *
 * Keep runtime values for the v3 flow HERE, in a plain module. `v3-actions.ts` may import the TYPE
 * (types are erased, so a type-only export from a `'use server'` file is safe) but must export
 * nothing except async functions. `test/useServerExports.test.ts` enforces this repo-wide.
 */
import type { QualifyResolution } from '@/lib/qualify/resolution';
import type { UnresolvableReason } from '@/lib/qualify/resolutionService';

export interface V3FlowState {
  resolution: QualifyResolution | null;
  reason: UnresolvableReason | null;
  /** Prefix-safe echo to repopulate the input. NEVER a full member id. */
  echo: string;
  /** Set only on a gate denial, so the screen can say why rather than showing an empty result. */
  denied: string | null;
}

export const V3_INITIAL_STATE: V3FlowState = {
  resolution: null,
  reason: 'empty',
  echo: '',
  denied: null,
};
