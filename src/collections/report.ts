/**
 * Collections ingest reports. Failure rows may carry raw cell values (PHI), so
 * they are written ONLY to the gitignored ./reports directory as JSONL — never to
 * stdout/logs (logs get counts only). Mirrors src/report.ts.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

const REPORTS_DIR = 'reports';

export interface CollectionsFailure {
  source_file_id: string;
  source_tab: string;
  source_row_num: number;
  shape: string;
  column: string;
  raw_value: string;
  reason: string;
}

/** Minimal sink the shape parsers write coercion failures to (real impl below;
 *  tests pass a fake that collects into an array, so no report files are written). */
export interface FailSink {
  fail(f: CollectionsFailure): void;
}

/** A whole file/tab that could not be ingested (shape didn't fit the schemas). */
export interface SkippedTab {
  source_file_id: string;
  workbook: string;
  source_tab: string;
  reason: string;
}

export class CollectionsReport {
  private failStream: WriteStream;
  private skipStream: WriteStream;
  public failures = 0;
  public skips = 0;
  public readonly failPath: string;
  public readonly skipPath: string;

  constructor(label: string) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.failPath = join(REPORTS_DIR, `collections-failed-coercion-${label}-${stamp}.jsonl`);
    this.skipPath = join(REPORTS_DIR, `collections-skipped-tabs-${label}-${stamp}.jsonl`);
    this.failStream = createWriteStream(this.failPath, { flags: 'a' });
    this.skipStream = createWriteStream(this.skipPath, { flags: 'a' });
  }

  fail(f: CollectionsFailure): void {
    this.failStream.write(`${JSON.stringify(f)}\n`);
    this.failures += 1;
  }

  skip(s: SkippedTab): void {
    this.skipStream.write(`${JSON.stringify(s)}\n`);
    this.skips += 1;
  }

  async close(): Promise<void> {
    await Promise.all(
      [this.failStream, this.skipStream].map(
        (st) => new Promise<void>((res, rej) => st.end((e?: Error | null) => (e ? rej(e) : res()))),
      ),
    );
  }
}
