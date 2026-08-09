/**
 * PREFIX LABELS — turning a stored `member_id_prefix_bidx` back into the 3-character alpha prefix a
 * human recognises. SERVER-ONLY (it imports blindIndex, which hard-fails in a browser).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The policy tape shipped rendering `⋯820b` — the last four hex characters of a keyed HMAC. Alec, on
 * the live screen 2026-08-09: *"the user doesn't know what these characters mean; we will want to
 * show a prefix"*. He is right, and the tape's own design already said so: `board.ts` describes the
 * masked tail as the FALLBACK "until the search rewrite calls collections.record_qualify_prefix_echo()
 * at term-mint time". That seam is still empty (0 rows, verified 2026-08-09), and it would only ever
 * label prefixes somebody had already searched — a tape of the whole book would stay mostly masked
 * for weeks. This resolves the label directly instead.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────────────────────────
 * An HMAC is one-way, so there is no inverse — but the DOMAIN is tiny. An alpha prefix is exactly
 * three characters of a normalized member id (`ALPHA_PREFIX_LEN`), so over [A-Z0-9] there are 46,656
 * possible values. We hold the key, so we compute all of them once and index token → prefix. Building
 * the map costs one pass of ~47k HMAC-SHA256 calls (~100-150ms) and ~7MB, ONCE per warm process,
 * lazily on the first lookup. Callers are already async and already fail-soft.
 *
 * ⚠ THIS IS NOT AN ATTACK ON THE BLIND INDEX, and the distinction matters. blindIndex.ts's threat
 * model is a DB-only attacker who does NOT have INDEX_HMAC_KEY ("a DB-only attacker cannot reverse
 * the token or brute-force the low-entropy identifiers WITHOUT the key" — its header, emphasis
 * theirs). We are the key holder, inside the process that already computes these same tokens to run
 * a search. Nothing here weakens the index for anyone who is not already the application.
 *
 * ⚠ WHAT IT DISCLOSES, STATED PLAINLY, because this is a judgement Alec owns. A three-character
 * member-id prefix is a PLAN routing code, not a person: for BCBS-style ids it is the published alpha
 * prefix that identifies the plan and the home state. The app already displays it — the search echoes
 * the typed prefix back (`core.ts alphaEcho`, `policy-strip.tsx`) — and the tape only ever shows
 * pairs carrying at least QUALIFY_TAPE_MIN_MEMBERS (3) distinct members, on a surface gated to
 * super_admin + admissions_seat. What CHANGES is that a prefix nobody searched can now appear. If
 * that trade is ever revisited, the whole capability is this one module: return null from
 * `prefixLabelFor` and every caller degrades to the masked tail it used before.
 *
 * NULL-ON-MISS, NEVER FABRICATED. Normalization only upper-cases, strips whitespace and strips a
 * leading '-', so a prefix CAN contain a character outside [A-Z0-9] (a '.', a '/'). Those tokens are
 * simply absent from the map and resolve to null — the caller shows the masked tail, exactly as
 * today. A partial map is the correct outcome; a guessed label would not be.
 */
import { alphaPrefixBlindIndex, ALPHA_PREFIX_LEN } from './blindIndex.js';

/** The candidate character set. Uppercase letters + digits covers every real prefix shape in this
 *  book; anything else degrades to null (see the module header). */
export const PREFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** How many candidates the lazy build enumerates — exported so a test can assert the map is complete
 *  rather than merely non-empty. */
export const PREFIX_LABEL_SPACE = PREFIX_ALPHABET.length ** ALPHA_PREFIX_LEN;

/** Built lazily on first use and kept for the life of the process. Keyed by INDEX_HMAC_KEY, so a key
 *  rotation MUST be accompanied by a process restart (it already must be — blindIndex caches the
 *  decoded key the same way) or `resetPrefixLabelIndex()`. */
let index: Map<string, string> | null = null;

function buildIndex(): Map<string, string> {
  const built = new Map<string, string>();
  const A = PREFIX_ALPHABET;
  for (const a of A) {
    for (const b of A) {
      for (const c of A) {
        const candidate = `${a}${b}${c}`;
        const token = alphaPrefixBlindIndex(candidate);
        // alphaPrefixBlindIndex returns null only for inputs shorter than ALPHA_PREFIX_LEN, which a
        // 3-character candidate never is — but the null-check is the type's, not a guess.
        if (token !== null) built.set(token, candidate);
      }
    }
  }
  return built;
}

/**
 * The 3-character alpha prefix behind a stored token, or null when it is outside the candidate space.
 * Throws only what blindIndex throws (a missing/malformed INDEX_HMAC_KEY) — callers on a fail-soft
 * surface should catch, because a tape that 500s over a display label is worse than a masked one.
 */
export function prefixLabelFor(token: string): string | null {
  if (index === null) index = buildIndex();
  return index.get(token) ?? null;
}

/** Resolve many tokens in one pass — the tape's shape. Builds the map at most once regardless of how
 *  many tokens are asked for. Unresolvable tokens are simply absent from the returned map. */
export function prefixLabelsFor(tokens: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tokens) {
    const label = prefixLabelFor(t);
    if (label !== null) out.set(t, label);
  }
  return out;
}

/** Drop the cached map (tests, and any deliberate key rotation inside a live process). */
export function resetPrefixLabelIndex(): void {
  index = null;
}
