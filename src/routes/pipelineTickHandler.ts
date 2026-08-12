/**
 * Transport-agnostic handler for GET /api/cron/pipeline-tick.
 *
 * Invoked by Vercel Cron every 5 minutes (app/vercel.json) AND callable by hand with the same
 * bearer token. Mirrors refreshChargeRollupHandler's shape exactly.
 *
 * THE MANUAL PATH IS A FEATURE, NOT A DEBUG HOOK. Vercel crons fire only on Production, which is
 * why nothing in the CMD ingest path has ever been testable on a preview deployment. This endpoint
 * takes the standard CRON_SECRET bearer, so a preview URL can be driven directly:
 *
 *   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
 *     'https://<preview>.vercel.app/api/cron/pipeline-tick?trigger=manual'
 *
 * The tick is idempotent and lease-guarded, so a hand-run one cannot collide with a scheduled one.
 *
 * SHIPPED DISABLED. `enabled` is false unless ETL_PIPELINE_ENABLED is truthy, and a disabled tick
 * returns 200 with `disposition: 'disabled'` — it runs no stage and writes no state. The five
 * standalone cron entries keep running exactly as they do today; this PR instruments and builds, it
 * does not cut over. A 200-not-503 on disabled is deliberate: a disabled feature is not a failure,
 * and a red cron in the Vercel tab would train everyone to ignore it.
 *
 * Security:
 *   - GET only — any other verb is 405 (independent of auth).
 *   - Bearer auth against the dedicated CRON_SECRET. A missing/empty secret fails closed (401).
 *   - On failure the client gets a generic 500; the cause is logged server-side as a message only
 *     (never PHI, never the token). The durable record lives in collections.etl_run.
 *
 * Touches NO PHI: no request body, and the report carries stage names, counts, timings and skip
 * reasons only.
 */
import { isAuthorized } from '../bearerAuth.js';
import type { TickReport } from '../collections/pipelineTick.js';

export interface PipelineTickHttpRequest {
  /** HTTP method. GET only — any other verb is 405. */
  method?: string;
  authorization?: string | null;
  /**
   * Optional `?trigger=manual`. Recorded as the lease holder and on etl_run rows so a hand-run tick
   * is distinguishable from a scheduled one in the measurements. Anything other than the literal
   * 'manual' is ignored — this value is stored, so it is not free-form client input.
   */
  trigger?: string | null;
}

export interface PipelineTickRouteDeps {
  /** Shared secret; undefined/empty => fail closed (401). Never logged. */
  secret: string | undefined;
  /** ETL_PIPELINE_ENABLED. False => the tick no-ops (see the header). */
  enabled: boolean;
  /** Runs one tick. Throws on failure (caught here). */
  tick: (holder: string) => Promise<TickReport>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export async function handlePipelineTickRequest(
  req: PipelineTickHttpRequest,
  deps: PipelineTickRouteDeps,
): Promise<HandlerResult> {
  // GET only — reject any other verb before touching auth.
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  // Fail closed on a missing/empty secret, then constant-time Bearer compare.
  if (!deps.secret || !isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  if (!deps.enabled) {
    return {
      status: 200,
      body: {
        ok: true,
        disposition: 'disabled',
        hint: 'set ETL_PIPELINE_ENABLED=1 to enable the completion-chained pipeline',
      },
    };
  }

  // Clamped to two literals — never the raw query value, which is stored on the lease row.
  const holder = req.trigger === 'manual' ? 'manual' : 'cron';

  try {
    const report = await deps.tick(holder);
    // The tick returns ok:false when a stage it ran failed. That is a REPORTED outcome, not a
    // transport failure — the tick itself did its job — so it stays a 200 and the caller reads
    // `ok`. Turning it into a 500 would make the Vercel cron tab red for a condition the pipeline
    // is designed to handle by holding dependents.
    return { status: 200, body: report };
  } catch (err) {
    console.error('pipeline-tick failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'tick_failed' } };
  }
}
