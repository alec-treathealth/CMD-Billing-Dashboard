/**
 * Local dev harness for the Phase 3 results route — NOT production transport.
 *
 * Production transport is Phase 4 (Next.js on Vercel). This thin Express server
 * exists only to exercise `fetchResults` over HTTP during development. Auth here is
 * a single shared Bearer token (`RESULTS_API_SECRET`) checked at the transport
 * boundary; the callable module (`results.ts`) has NO auth logic of its own. The
 * token is read from env, compared in constant time, and never logged.
 *
 *   GET /results/:query_id    Authorization: Bearer <RESULTS_API_SECRET>
 *
 * Errors never leak internals or PHI: 401 on a missing/wrong token, a generic 500
 * on any failure (the underlying error is not echoed to the client).
 */
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from './queries/executor.js';
import { fetchResults, type ResultsContext } from './routes/results.js';

/** Constant-time Bearer-token comparison (length-safe; never short-circuits on content). */
function tokenMatches(provided: string, secret: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Auth middleware: require `Authorization: Bearer <secret>`; 401 otherwise. */
function requireBearer(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match === null || !tokenMatches(match[1]!, secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Build the Express app over a results context + the shared secret. Exported so
 * the harness can be wired to either a real claims_reader pool (main) or, in
 * principle, a fake executor.
 */
export function createServer(ctx: ResultsContext, secret: string): express.Express {
  const app = express();

  app.get('/results/:query_id', requireBearer(secret), async (req: Request, res: Response) => {
    const queryId = String(req.params.query_id ?? '');
    // The authenticated principal for the audit trail; never PHI. Overridable by a
    // dev header so multiple callers can be distinguished, else the harness identity.
    const createdBy = req.header('x-created-by')?.trim() || 'results-api';
    try {
      const result = await fetchResults({ query_id: queryId, created_by: createdBy }, ctx);
      res.json(result);
    } catch {
      // Do not echo the error (it may name a function/column) — generic 500 only.
      res.status(500).json({ error: 'results_failed' });
    }
  });

  return app;
}

function main(): void {
  const secret = process.env.RESULTS_API_SECRET;
  if (secret === undefined || secret.trim() === '') {
    throw new Error('Missing RESULTS_API_SECRET (set it in .env; never hardcode or log it)');
  }
  // Verify-full TLS is applied centrally in makeReaderPool (src/ssl.ts) — the
  // harness inherits it, so there is no separate SSL config to set here.
  const pool = makeReaderPool(readerConnectionStringFromEnv());
  const ctx: ResultsContext = { executor: new PgExecutor(pool) };
  const app = createServer(ctx, secret);
  const port = Number(process.env.RESULTS_PORT ?? 8787);
  app.listen(port, () => {
    process.stdout.write(`results dev harness listening on :${port}\n`);
  });
}

// Run only when invoked directly (dev harness), never on import (tests, etc.).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
