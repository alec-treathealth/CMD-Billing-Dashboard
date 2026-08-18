/**
 * FULL-BOOK PATIENT-NAME SEARCH (migration 0105) - the invariants that outlive the implementation.
 *
 * A true import test is impossible here for the usual reason: cmd-explorer.tsx's import graph pulls
 * @/lib/actions -> @/lib/access, which calls the RSC `cache()` and crashes under node:test. So these
 * pin the contract at the SOURCE level, the same way cmd-recency-default.test.tsx does. A benign
 * refactor will trip them - that is intended, because each one below is a decision that should have
 * to be re-affirmed deliberately rather than edited away in passing.
 *
 * Must be .tsx - app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass" by
 * never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const actionsSrc = readFileSync(join(here, '../lib/actions.ts'), 'utf8');
const serverSrc = readFileSync(join(here, '../lib/server.ts'), 'utf8');
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');

// -- 1. Nothing the client sends may decide WHICH rows are searched -----------------------------

test('the search Server Action takes NO filter - only a term and a view', () => {
  // This is the strongest property of the rewrite. The old signature took the whole grid filter and
  // re-applied it to bound the decrypt, which meant client input shaped the candidate set. Now the
  // scope is entirely server-derived: the PHI entitlement intersected with the view.
  const sig = actionsSrc.slice(actionsSrc.indexOf('export async function searchCollectionsPatientName('));
  const head = sig.slice(0, sig.indexOf('): Promise<'));
  assert.match(head, /term: string,\s*view\?: DashboardView,/);
  assert.doesNotMatch(head, /filter/, 'a filter parameter must not come back');
});

test('the search intersects the PHI entitlement with the view before querying', () => {
  const body = actionsSrc.slice(
    actionsSrc.indexOf('export async function searchCollectionsPatientName('),
    actionsSrc.indexOf('export async function revealCmdReportRows('),
  );
  assert.match(body, /requirePhiPrincipal\(\)/);
  assert.match(body, /gate\.entityIds\.filter\(\(id\) => viewIds\.includes\(id\)\)/);
  assert.match(body, /entityIds\.length === 0/, 'an empty scope must fail closed, never widen');
});

// -- 2. The term is PHI and the result is not ---------------------------------------------------

test('the audit records COUNTS only - never the term, a name, or a token', () => {
  const body = serverSrc.slice(
    serverSrc.indexOf('export async function searchCmdExplorerPatientName('),
    serverSrc.indexOf('// Claims Data Explorer (Phase 7.4)'),
  );
  const detail = body.slice(body.indexOf('detail: {'), body.indexOf('});', body.indexOf('detail: {')));
  assert.match(detail, /scanned: rows\.length/);
  assert.match(detail, /matched_patients: nameHits\.size/);
  assert.match(detail, /matched_members: memberTokens\.size/);
  // EVERY value must be a count. `memberTokens.size` is fine and `[...memberTokens]` would not be —
  // the difference is the whole rule, so assert the shape rather than the identifier.
  const values = [...detail.matchAll(/\w+: ([^,}]+)/g)].map((m) => m[1]!.trim());
  assert.ok(values.length >= 3);
  for (const v of values) {
    assert.match(v, /\.(size|length)$/, `audit detail values must be counts, got: ${v}`);
  }
  for (const forbidden of ['term', 'needle', 'patient_name', 'name_fp']) {
    assert.doesNotMatch(detail, new RegExp(forbidden), `audit detail must not carry ${forbidden}`);
  }
});

test('an unbuilt or missing index is NOT reported as "no matches"', () => {
  // Both render as an empty grid, so conflating them would tell the user that a patient is not in
  // the book when the truth is that nothing has been indexed. The two states are distinct on the
  // result type and the 42P01 path is explicit.
  const body = serverSrc.slice(serverSrc.indexOf('export const CMD_NAME_SEARCH_MEMBER_CAP'));
  assert.match(body, /reason: 'directory_unavailable'/);
  assert.match(body, /reason: 'directory_empty'/);
  assert.match(body, /42P01/, 'the undefined-table code is handled, not swallowed');
  // The empty check must come BEFORE the decrypt loop, or an empty directory reports 0 matches.
  const emptyAt = body.indexOf("reason: 'directory_empty'");
  const decryptAt = body.indexOf('await decryptPhi(r.patient_name)');
  assert.ok(emptyAt > 0 && decryptAt > emptyAt, 'the empty guard precedes the match loop');
});

// -- 3. The wire carries tokens, and they are bounded and shape-checked -------------------------

test('member tokens are validated as 64-hex and count-bounded at the action boundary', () => {
  assert.match(actionsSrc, /const BIDX_TOKEN_RE = \/\^\[0-9a-f\]\{64\}\$\//);
  assert.match(actionsSrc, /const CMD_PATIENT_MEMBER_MAX = 2000;/);
  const fn = actionsSrc.slice(
    actionsSrc.indexOf('function applyPatientMemberTokens('),
    actionsSrc.indexOf('/** Max length for the free-text search term'),
  );
  assert.match(fn, /if \(tokens === undefined\) return true;/, 'absent means no condition');
  assert.match(fn, /tokens\.length > CMD_PATIENT_MEMBER_MAX/);
  assert.match(fn, /BIDX_TOKEN_RE\.test\(t\)/);
  // The empty array must survive validation - it is the "matched nobody" signal.
  assert.doesNotMatch(fn, /tokens\.length === 0\) return true/, 'an empty array must NOT be dropped');
});

test('all three grid actions run the token sanitizer, not just the grid page', () => {
  // The grid, the summary and the cohort/refinement paths each build their own reader filter. A
  // sanitizer wired into only one of them is how a name search ends up applying to the table but
  // not to the totals above it.
  const calls = actionsSrc.match(/applyPatientMemberTokens\(filter, readerFilter\)/g) ?? [];
  assert.equal(calls.length, 3, 'grid + summary + cohort');
  const rowIdCalls = actionsSrc.match(/applyRowIds\(filter, readerFilter\)/g) ?? [];
  assert.equal(calls.length, rowIdCalls.length, 'wired everywhere row ids already were');
});

// -- 4. The client ------------------------------------------------------------------------------

test('the client sends member tokens, and the narrowing gate is gone', () => {
  assert.match(explorerSrc, /const nameSearchAllowed = canRevealPhi;/);
  assert.match(explorerSrc, /f\.patient_member_bidx = nameMatchTokens;/);
  assert.doesNotMatch(explorerSrc, /f\.row_ids = nameMatchTokens/, 'row ids are not the wire format');
  // The cap copy is gone with the cap.
  assert.doesNotMatch(explorerSrc, /NAME_SEARCH_CAP/);
  // The placeholder used to say "narrow first" when the field was inert. The field is never inert
  // now, and the only surviving occurrence of that phrase is the help text saying it is NOT needed.
  assert.doesNotMatch(explorerSrc, /placeholder=\{nameSearchAllowed/, 'the placeholder no longer refuses');
  assert.match(explorerSrc, /no need to narrow first/);
});

test('the match denominator is DISTINCT NAMES, not directory rows', () => {
  // Measured at build 2026-08-18: 11,161 directory rows but 9,986 distinct names, because the
  // directory is keyed on (member, name) and one name can sit under two member policies. Reporting
  // the row count as "patients" over-states the book by 12% in a number the user reads, so the
  // result carries a separately-counted denominator.
  const body = serverSrc.slice(serverSrc.indexOf('export const CMD_NAME_SEARCH_MEMBER_CAP'));
  assert.match(body, /patientsInScope: namesInScope\.size/);
  assert.match(body, /namesInScope\.add\(r\.name_fp\)/);
  assert.doesNotMatch(body, /scanned: rows\.length,\n\s*\};/, 'the row count must not be the headline');
  // The AUDIT still records rows decrypted — that is a PHI-volume fact and a different question.
  assert.match(body, /scanned: rows\.length/);
  assert.match(explorerSrc, /r\.patientsInScope\.toLocaleString\(\)/);
});

test('a null token set means "no search"; an empty one still reaches the filter', () => {
  // `null` = never searched -> omit the key entirely. `[]` = searched, matched nobody -> send it, so
  // the shared builder emits its impossible predicate. Collapsing the two would silently widen the
  // grid to the whole book right after a search that found no one.
  assert.match(explorerSrc, /if \(nameMatchTokens !== null\) f\.patient_member_bidx = nameMatchTokens;/);
  const occurrences = explorerSrc.match(/if \(nameMatchTokens !== null\) f\.patient_member_bidx/g) ?? [];
  assert.equal(occurrences.length, 2, 'grid page + summary both carry it');
});
