/**
 * THE SMOKE SHELL'S SESSION DERIVATIONS — pure, for the reason `flow-state.ts` is pure.
 *
 * The shell that owns these (`../v3/resolution-flow-client.tsx`) needs `useActionState`, so it
 * cannot be mounted hermetically and nothing inside it can be asserted on directly. Every rule below
 * was a defect an adversarial review confirmed in the shell wiring; each one now lives here as a
 * total function of its inputs, so `app/test/qualify-shell-session.test.tsx` calls it instead of
 * inferring it from markup — or, worse, from a source scan (see `makeRetryHandler`'s header for the
 * `indexOf` trap that made exactly that kind of scan unfailable).
 *
 * ── PURITY CONTRACT ─────────────────────────────────────────────────────────────────────────────
 * No `'use client'`, no React import, no server import, no I/O, no Date/Math/random.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────────────────────────
 * Nothing here ever receives the raw typed identifier. `recentSearchKeyOf` takes an integer and a
 * hash and returns a string built from exactly those two; that is deliberate and is the point of the
 * function existing — see its own header.
 */

/**
 * IS THE RAIL STANDING IN A LANE? — the "Start over still says Locked to GGS" fix.
 *
 * `state.resolution` lives in `useActionState`, which the shell CANNOT clear: only a new server
 * action dispatch replaces that state. So "Start over" dispatches `went_back` to identify, the
 * machine walks back, the board empties — and `state.resolution !== null` goes on being true, which
 * is what left the lock strip naming the lane the operator just abandoned ("Locked to GGS — answers
 * come only from this lane").
 *
 * THREE INPUTS, NOT TWO, AND AN OBJECT RATHER THAN THREE POSITIONAL BOOLEANS — which would be the
 * "two adjacent call sites spelling different things the same way" hazard in its purest form.
 *
 *  · `resolutionPresent` — the server action resolved something.
 *  · `sessionCleared` — the shell's own bit, armed by "Start over" and disarmed by the next identify
 *    submit. It is the shell's and not the reducer's: a reducer arm cannot express "the server
 *    action's state is stale" because the reducer cannot see that state.
 *  · `stageIsIdentify` — THE SECOND WAY BACK TO THE SAME SCREEN, and the one the first fix missed.
 *    The receipt's "Change" on the Search row (`onChange`) dispatches the SAME
 *    `went_back{target:'identify'}` as the reset, through a handler that arms nothing. The board zone
 *    renders "Nothing resolved yet" off the stage while the rail strip beside it went on claiming a
 *    lock — the two-panes-disagreeing failure that the disarm-at-submit trade-off is itself justified
 *    by. Whatever puts the flow back on the identify question closes the lane.
 *
 * `sessionCleared` IS NOT REDUNDANT AGAINST `stageIsIdentify`, though today every reachable state
 * where the former is true has the latter true as well (the reset dispatches `went_back`, which
 * writes `backTo='identify'`). Keeping both means the rule holds by its own statement rather than by
 * a proof about a neighbouring field's behaviour — the exact dependency `snapshot_resolved`'s
 * `wasRefresh` condition needed its own marker to escape (flow-state invariant p). And the two are
 * genuinely different claims elsewhere: only `sessionCleared` separates a RESET (term dropped, so the
 * search box must be empty) from a CHANGE (term kept, so the box should pre-fill).
 *
 * READ per render rather than stored as a "hasResolution" flag — the shell's header records why
 * derived beats stored on this surface.
 */
export function laneIsOpen(input: {
  resolutionPresent: boolean;
  sessionCleared: boolean;
  stageIsIdentify: boolean;
}): boolean {
  return input.resolutionPresent && !input.sessionCleared && !input.stageIsIdentify;
}

/**
 * THE RECENT-SEARCH DEDUPE KEY — and the reason it cannot be any of the three obvious candidates.
 *
 * The list must log a SEARCH once, not a snapshot: a window chip, a billed-under chip or a refresh
 * re-fetches the same resolved search and must not mint a second history row. What it must never do
 * is silently swallow a DIFFERENT operator's search, which is precisely what keying on `predicateId`
 * alone did.
 *
 *  · `predicateId` — WRONG, and invisibly so. `predicateIdFor` (resolutionService.ts:415) hashes
 *    {kind, canonicalPayerId, employerLabel, funding, planType, from, to}. There is NO identifier in
 *    it. Two different members on the same plan shape in the same window hash IDENTICALLY, so the
 *    second member's search was never recorded and nothing on screen said so.
 *  · `scopeKey` — WRONG FOR THE SAME REASON, one layer out. `scopeKeyOf` serializes payer label,
 *    window, funding, employers and allPayers; its own header (and flow-state invariant p) states
 *    outright that it "carries NO identifier at all", which is why `snapshot_resolved` had to stop
 *    using it as a stand-in for "was this a refresh".
 *  · `predicateId` + `handle.echo` — STILL WRONG. `echo` is '' for every full-member-ID search by
 *    construction, so the whole class of searches most likely to collide contributes nothing.
 *  · The raw term — FORBIDDEN. It is PHI; a Set of terms living in a ref is PHI at rest for the life
 *    of the mount, which is longer than the request that legitimately needs it.
 *
 * What genuinely identifies a search WITHIN a session is the session's own count of them:
 * `searchSeq` is bumped once per identify dispatch, so two members are two sequence numbers however
 * identically they hash. `predicateId` stays in the key on purpose — a plan pick inside one search
 * re-resolves to a new predicate with a concrete plan class, which is a genuinely new history row,
 * and dropping the hash would swallow it.
 *
 * Non-PHI by construction: an integer the shell minted, and a hash with no identifier in it.
 */
export function recentSearchKeyOf(searchSeq: number, predicateId: string): string {
  return `${searchSeq}:${predicateId}`;
}

/**
 * WHERE THE TILE/FACET REVEAL LOOKS FOR ITS TARGETS.
 *
 * Single-column: the answer renders inside `[data-v3-stage]`, so the stage subtree is the whole
 * animated world and scoping to it keeps the chrome (h1, rail, receipt, live region, ticker) out of
 * the tween — the motion contract ResolutionStages' header states.
 *
 * SHELL: the answer renders in the BOARD pane, outside `[data-v3-stage]` entirely (`answerInline` is
 * false, so `StageAnswer` is mounted by the shell beside the rail). Scoping the reveal to the stage
 * therefore found the rail's tiles and NONE of the answer's — the stagger and the facet reveal never
 * ran on the surface they were written for. The shell's root holds both panes, so it is the scope.
 *
 * ⚠ THE STAGE ENTRANCE DOES NOT MOVE WITH IT. That tween animates `autoAlpha` — `visibility:hidden`
 * — and widening it to the root would hide the board, the composer and the watchers on every stage
 * change, which is the exact `<main>`-level regression the shell's motion header is a post-mortem of.
 * Only the two REVEALS take this scope; the entrance and the focus call stay on the stage subtree.
 *
 * Generic over the node type so the decision is testable without a DOM.
 */
export function revealScopeFor<T>(shellMode: boolean, root: T, stageEl: T): T {
  return shellMode ? root : stageEl;
}

/** Why a watcher save did not happen — the action's own `reason` union, re-exported as the UI's. */
export type QualifyWatcherSaveFailure = 'denied' | 'invalid' | 'failed';

/**
 * THE SENTENCE A REFUSED OR FAILED WATCHER SAVE GETS. Before this, `saveQualifyTrendWatcher` /
 * `saveQualifyPatientWatcher` returning `{ok:false}` produced no UI change whatsoever — the button
 * appeared to do nothing, and the operator's only reading was "the click missed".
 *
 * Each reason gets its OWN sentence because they are different problems with different next moves,
 * and the panel's neighbouring `readFailed` copy is the precedent: a permission error wearing "not
 * provisioned yet" as a costume is the 0089 failure shape this whole panel is careful about. Every
 * sentence ends by saying nothing was stored, because the silence being fixed here is precisely the
 * one that let a rep believe otherwise.
 *
 * NON-PHI: fixed literals. Nothing about the search reaches this string.
 */
export function watcherSaveNotice(reason: QualifyWatcherSaveFailure): string {
  switch (reason) {
    case 'denied':
      return 'watcher not saved — your account was refused permission to save watchers. Nothing is stored.';
    case 'invalid':
      return 'watcher not saved — this search cannot be watched. Nothing is stored.';
    case 'failed':
      return 'watcher not saved — the request failed. Nothing is stored; try again, or tell an admin if it persists.';
  }
}
