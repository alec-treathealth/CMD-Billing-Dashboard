/**
 * Failed-coercion report writer. Output may contain raw cell values (PHI), so
 * it is written ONLY to the gitignored ./reports directory as JSONL — NEVER to
 * stdout/logs. Logs get counts only.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { CoercionFailure } from './types.js';

const REPORTS_DIR = 'reports';

export class CoercionReport {
  private stream: WriteStream;
  public count = 0;
  public readonly path: string;

  constructor(label: string) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.path = join(REPORTS_DIR, `failed-coercion-${label}-${stamp}.jsonl`);
    this.stream = createWriteStream(this.path, { flags: 'a' });
  }

  write(failure: CoercionFailure): void {
    this.stream.write(`${JSON.stringify(failure)}\n`);
    this.count += 1;
  }

  writeAll(failures: CoercionFailure[]): void {
    for (const f of failures) this.write(f);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
