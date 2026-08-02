/**
 * Runtime env-var preflight for cron handlers. Pure leaf (no I/O, no PHI) so tests are hermetic
 * and it can be imported anywhere without dragging pg/libsodium into the graph.
 *
 * Purpose: when a cron declares required-no-fallback env vars (e.g. CMD_BXR_CENSUS_REPORT_ID),
 * throwing deep inside the config builder means one missing var fails the run at the FIRST call
 * site that touches it — one gap per attempt, discovered serially over hourly reruns. This helper
 * checks the whole set up front and names EVERY missing var in one error line, so the operator
 * sees the full gap after one failed run instead of chasing them one at a time.
 *
 * PHI/log posture: the values are never read here (never logged, never returned) — only the NAMES
 * of missing vars appear in the thrown message. Names are compile-time literals from server.ts.
 */

/** Consider a var "missing" if it is undefined, empty, or whitespace-only. */
function isMissing(name: string): boolean {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '';
}

/**
 * Assert every required env var is set. Throws once, listing all missing names.
 * Returns nothing on success (nothing to consume — the deep-throw builders remain the value source).
 *
 * @param cronLabel human label used in the error prefix; matches the tenant.label used in the
 *   handler's failure log line, so a preflight-caught gap and a runtime-caught gap attribute to
 *   the same cron in the shared log stream.
 * @param required the required env var names for this cron (compile-time literals in server.ts).
 */
export function assertRequiredEnvVars(cronLabel: string, required: readonly string[]): void {
  const missing = required.filter(isMissing);
  if (missing.length === 0) return;
  throw new Error(
    `${cronLabel} cron missing required env: ${missing.join(', ')} (set in Vercel; never hardcode or log values)`,
  );
}
