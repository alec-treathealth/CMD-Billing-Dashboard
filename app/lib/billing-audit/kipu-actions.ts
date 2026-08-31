'use server';

/**
 * Kipu Billing Report upload → parsed Billable Days grid. THE ONLY server entry point for
 * the Billable Days subtab.
 *
 * ⚠ THIS ESTABLISHES THE REPO'S FIRST FILE-UPLOAD PATTERN. There was none before this PR
 * (the other FormData callers are the auth forms, which post strings). Keep it minimal and
 * keep every bound below — a future uploader should copy this shape rather than invent a
 * second one.
 *
 * WHY PARSING IS SERVER-SIDE. The tested engine lives in `src/kipu/` and stays there: the
 * browser never sees the rules, and the response carries only the computed rows for one
 * week. A nine-facility corpus is ~16 MB of CSV — it is never round-tripped back.
 *
 * ⚠ NOTHING IS PERSISTED. No database, no disk, no cache. The parsed model exists for the
 * duration of the request and the DTO lives in React state until the tab is reloaded. The
 * `kipu.*` writer is the NEXT PR and lands behind this exact action signature.
 *
 * PHI DISCIPLINE, AND IT IS THE WHOLE POINT OF THIS FILE:
 *   - Uploaded bytes are PHI. No filename, patient name, MRN, auth number or session topic
 *     is ever logged — the only server-log line is built by `logSafe`, whose signature
 *     accepts a fixed code and NUMBERS, so caller-supplied text cannot reach a log.
 *   - Errors returned to the browser are GENERIC and enumerated (`ImportError`). A parse
 *     failure never echoes file content, a row, or a filename back to the client.
 *   - Name / auth number / session topic are gated on `canRevealPhi` inside
 *     `buildImportPayload`, so for a plain `user` they are ABSENT from the payload rather
 *     than merely hidden by a component.
 */
import { dashboardAccess } from '@/lib/access';
import { clampView, type DashboardView } from '@/lib/views';
import {
  assembleBundle,
  buildFromCsv,
  parseCsv,
  classifyRows,
  type ReportFile,
  type CsvKind,
} from '../../../src/kipu/billingReport.js';
import { LOC_CONFIG_BASE, DEFAULT_RULES } from '../../../src/kipu/assumptions.js';
import { gridRows } from '../../../src/kipu/computeRow.js';
import { buildImportPayload, type KipuImportPayload } from './kipu-import';

/* ── Input bounds. Every one of these is enforced BEFORE any bytes are parsed. ──────────
 * They live in `./kipu-import-bounds.ts` because THIS file is `'use server'`, where a value
 * export would 500 every Server Action on the page while passing the entire gate. See that
 * module's header for the bounds themselves and for why the body ceiling must EXCEED
 * MAX_TOTAL_BYTES rather than match it.
 *
 * ⚠ next.config.mjs ALSO has to allow the body — Server Actions default to 1 MB, which
 * silently rejects even ONE real export. These checks are the real enforcement; that setting
 * only has to stop Next refusing a request before it reaches this function.
 */
import {
  HEADER_SNIFF_BYTES,
  MAX_BYTES_PER_FILE,
  MAX_FILES,
  MAX_TOTAL_BYTES,
} from './kipu-import-bounds';

export type ImportError =
  | 'unauthorized'
  | 'wrong-view'
  | 'no-files'
  | 'too-many-files'
  | 'file-too-large'
  | 'total-too-large'
  | 'not-csv'
  | 'no-recognized-files'
  | 'no-weeks'
  | 'unmapped-location'
  | 'parse-failed';

export type KipuImportResult =
  | ({ ok: true } & KipuImportPayload)
  | { ok: false; error: ImportError };

/**
 * Server-log line. Takes only a fixed code and numbers — it is structurally impossible to
 * pass a filename or a patient identifier through this signature.
 */
function logSafe(code: string, counts: Record<string, number> = {}): void {
  const tail = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.warn(`[kipu-import] ${code}${tail ? ' ' + tail : ''}`);
}

/**
 * Content-based CSV check — NOT an extension check. A file passes only if it decodes as
 * UTF-8 text, carries no NUL byte (the cheap binary tell), and its header row parses into a
 * kind the engine recognises. `classifyRows` keys on header SIGNATURE, so a renamed or
 * extensionless export still works while a PDF named `.csv` still fails.
 */
function sniffKind(text: string): CsvKind {
  if (text.includes('\u0000')) return 'unknown';
  const head = text.slice(0, HEADER_SNIFF_BYTES);
  const firstNl = head.indexOf('\n');
  // No newline inside the sniff window on a file larger than it = not a row-oriented CSV.
  if (firstNl < 0 && text.length > HEADER_SNIFF_BYTES) return 'unknown';
  try {
    const secondNl = firstNl < 0 ? -1 : head.indexOf('\n', firstNl + 1);
    const upto = secondNl < 0 ? head : head.slice(0, secondNl + 1);
    return classifyRows(parseCsv(upto));
  } catch {
    return 'unknown';
  }
}

export async function importKipuReport(formData: FormData): Promise<KipuImportResult> {
  const access = await dashboardAccess();
  if (!access.ok || access.access.allowedViews.length === 0) return { ok: false, error: 'unauthorized' };

  // Scope: clamp the requested view against this caller's ENTITLEMENT, then require BXR. Treat's
  // locations are BXR facilities; any other view is an explicit unavailable state, never a
  // silently empty grid. Clamping first means a hand-edited ?view= cannot widen anything.
  //
  // ⚠ THIS IS NOT THE SAME CLAMP THE PAGE RUNS, AND IT MUST NOT BE "RESTORED" TO MATCH IT.
  // This comment said "exactly as the page does" until 2026-08-31, when the page moved to the
  // route-scoped `resolveClaimsDeskView` (BXR default, `consolidated` → bxr). The two now
  // diverge deliberately: for a super_admin a forged `view=consolidated` stays `consolidated`
  // here and is REJECTED below, while the page would map it to bxr; an absent value clamps to
  // allowedViews[0] here versus bxr on the page. Every divergence resolves DENY on this side,
  // which is the correct direction for a write path — importing the page's consolidated→bxr
  // mapping to regain "parity" would silently convert those denials into accepts.
  // The page's clamp decides what to RENDER; this one decides what to ACCEPT.
  const requested = String(formData.get('view') ?? '') as DashboardView;
  const view = clampView(requested, access.access.allowedViews);
  if (view !== 'bxr') return { ok: false, error: 'wrong-view' };

  const entries = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (entries.length === 0) return { ok: false, error: 'no-files' };
  if (entries.length > MAX_FILES) {
    logSafe('rejected:too-many-files', { got: entries.length, max: MAX_FILES });
    return { ok: false, error: 'too-many-files' };
  }
  let total = 0;
  for (const f of entries) {
    if (f.size > MAX_BYTES_PER_FILE) {
      logSafe('rejected:file-too-large', { bytes: f.size, max: MAX_BYTES_PER_FILE });
      return { ok: false, error: 'file-too-large' };
    }
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    logSafe('rejected:total-too-large', { bytes: total, max: MAX_TOTAL_BYTES });
    return { ok: false, error: 'total-too-large' };
  }

  // Read + content-sniff. This rejects non-CSV BEFORE handing anything to the full parser.
  const files: ReportFile[] = [];
  const filesByKind: Record<string, number> = {};
  for (const f of entries) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer());
    } catch {
      logSafe('rejected:not-utf8');
      return { ok: false, error: 'not-csv' };
    }
    const kind = sniffKind(text);
    if (kind === 'unknown' || kind === 'empty') {
      logSafe('rejected:unrecognized-kind');
      return { ok: false, error: 'not-csv' };
    }
    filesByKind[kind] = (filesByKind[kind] ?? 0) + 1;
    // `name` feeds the A9 -Billable- variant guard ONLY (`isBillableReportFile`). It reaches
    // no log and no client payload.
    //
    // ⚠ THIS COMMENT WAS FALSE UNTIL 2026-08-30 (Qodo finding 9). `assembleBundle`
    // interpolated the raw filename into its A9 warning, and that string travelled
    // variantWarnings -> BuildResult.notes -> diagnostics.notes -> the browser. An uploaded
    // filename is user-supplied text from a PHI-bearing export and routinely carries a
    // patient name or MRN, so the claim above was not merely stale — it described the
    // opposite of the behaviour. The warning is now positional ("file 2 of 3"), which is
    // what makes this true. Classification stays header-based, so renamed exports still work.
    files.push({ name: f.name, text });
  }
  if (!filesByKind['sessions'] && !filesByKind['evaluations']) {
    logSafe('rejected:no-session-or-eval-file', { files: files.length });
    return { ok: false, error: 'no-recognized-files' };
  }

  try {
    const bundle = assembleBundle(files, DEFAULT_RULES);
    const build = buildFromCsv(bundle, LOC_CONFIG_BASE, DEFAULT_RULES);
    if (build.weeks.length === 0) return { ok: false, error: 'no-weeks' };

    // Week selection: the client echoes back the week it wants. Anything not in the parsed
    // week list falls back to the most recent — a hand-edited value can never widen scope.
    const wanted = String(formData.get('week') ?? '');
    const selectedWeek = build.weeks.some((w) => w.start === wanted) ? wanted : build.weeks[0]!.start;

    const rowsForWeek = gridRows(build.clients, selectedWeek, build.locCfg, DEFAULT_RULES);
    const payload = buildImportPayload({
      build,
      rowsForWeek,
      selectedWeek,
      filesByKind,
      canRevealPhi: access.access.canRevealPhi,
    });
    logSafe('ok', {
      files: files.length,
      clients: build.clients.length,
      weeks: build.weeks.length,
      rows: rowsForWeek.length,
    });
    return { ok: true, ...payload };
  } catch (e) {
    // An UNMAPPED container label is a deliberate hard failure in the registry
    // (assertKnownLabels) — surface it as its own code so the UI can say "a human must map
    // this location" rather than "parse failed". The engine message names a LABEL, which is
    // a business identifier and not PHI, but it is still never echoed to the client.
    const msg = e instanceof Error ? e.message : '';
    const unmapped = msg.startsWith('Unmapped Kipu session-container label');
    logSafe(unmapped ? 'failed:unmapped-location' : 'failed:parse');
    return { ok: false, error: unmapped ? 'unmapped-location' : 'parse-failed' };
  }
}
