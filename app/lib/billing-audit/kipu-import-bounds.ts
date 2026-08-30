/**
 * Input bounds for the Kipu Billing Report upload, and the Server Action body ceiling they
 * imply. PLAIN MODULE, no `'use server'`, and that is the whole reason it exists.
 *
 * ⚠ THESE CANNOT LIVE IN `kipu-actions.ts`. That file carries `'use server'`, where every
 * export must be an async function — a value export there passes typecheck, passes all five
 * gate commands, and then 500s EVERY Server Action on the page at runtime, unlogged. So the
 * constants move here and the action imports them, rather than the test importing them from a
 * directive file.
 *
 * A Kipu export is 4 CSVs; the largest single real export measured is 3.6 MB with a ~2.6 MB
 * Sessions file. These are sized to accept a couple of exports at once and refuse anything that
 * is obviously not one. All three are enforced in the action BEFORE any bytes are parsed.
 */

export const MAX_FILES = 16;
export const MAX_BYTES_PER_FILE = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Only the first chunk is sniffed — enough to hold a header row plus one data row. */
export const HEADER_SNIFF_BYTES = 64 * 1024;

/**
 * ⚠ THE BODY LIMIT MUST EXCEED `MAX_TOTAL_BYTES`, NOT MATCH IT (Qodo #11 on PR #268).
 *
 * `next.config.mjs` set `serverActions.bodySizeLimit: '32mb'`, and its comment said the value
 * "only has to stay >= MAX_TOTAL_BYTES". That claim was the defect. Next measures the RAW
 * REQUEST BODY, and a multipart/form-data body is strictly larger than the files inside it:
 * every part carries a boundary line, a `Content-Disposition` header with the filename, a
 * `Content-Type`, and CRLFs, and this request adds two more parts of its own (`view`, `week`).
 *
 * With the two numbers EQUAL, an upload at or just under `MAX_TOTAL_BYTES` is rejected by
 * Next BEFORE the action runs — so the action's own bound was unreachable, and the documented
 * ceiling was a number no request could actually hit. The failure is also invisible in the
 * right place: a body Next refuses never reaches `importKipuReport`, so it surfaces through
 * the panel's `catch` as the generic "could not be sent", never as `total-too-large`. The
 * user is told to upload less by a limit that is not the one they exceeded.
 *
 * Worst case measured against this action's own bounds: 16 file parts × (≈74-byte boundary +
 * ≈50-byte disposition + a filename up to 255 bytes + ≈24-byte content-type + CRLFs) ≈ 6.5 KB,
 * plus the two field parts and the closing boundary ≈ 350 bytes. Under 7 KB in total.
 *
 * The allowance is a whole MEBIBYTE — roughly 150× that worst case — deliberately. It costs
 * nothing (this is a ceiling, and the real enforcement is the three bounds above, which are
 * unchanged), and a tight margin would have to be re-derived every time a field is added to
 * the form or a filename gets longer. `MAX_TOTAL_BYTES` is what actually refuses an upload;
 * this only has to stop Next refusing one first.
 */
export const MULTIPART_OVERHEAD_ALLOWANCE = 1024 * 1024;

/**
 * The smallest `serverActions.bodySizeLimit` that lets `MAX_TOTAL_BYTES` be reached.
 * `app/test/kipuImportBodyLimit.test.tsx` asserts `next.config.mjs` is at least this — the
 * config is `.mjs` and cannot import this module, so a test is the only thing that can hold
 * the two in agreement.
 */
export const REQUIRED_BODY_SIZE_LIMIT_BYTES = MAX_TOTAL_BYTES + MULTIPART_OVERHEAD_ALLOWANCE;
