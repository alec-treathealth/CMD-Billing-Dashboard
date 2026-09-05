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
  assert.match(detail, /matched_members: memberPairs\.size/);
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

test('BOTH halves of the pair are validated, and the pair is rebuilt not passed through', () => {
  assert.match(actionsSrc, /const BIDX_TOKEN_RE = \/\^\[0-9a-f\]\{64\}\$\//);
  assert.match(actionsSrc, /const ENTITY_UUID_RE =/);
  assert.match(actionsSrc, /const CMD_PATIENT_MEMBER_MAX = 2000;/);
  const fn = actionsSrc.slice(
    actionsSrc.indexOf('function applyPatientMembers('),
    actionsSrc.indexOf('/** Max length for the free-text search term'),
  );
  assert.match(fn, /if \(pairs === undefined\) return true;/, 'absent means no condition');
  assert.match(fn, /pairs\.length > CMD_PATIENT_MEMBER_MAX/);
  assert.match(fn, /ENTITY_UUID_RE\.test\(entity\)/, 'the tenant half is validated too');
  assert.match(fn, /BIDX_TOKEN_RE\.test\(member\)/);
  // Rebuilt from the two validated fields, so an extra property cannot ride along into the builder.
  assert.match(fn, /clean\.push\(\{ entity, member \}\)/);
  // The empty array must survive validation - it is the "matched nobody" signal.
  assert.doesNotMatch(fn, /pairs\.length === 0\) return true/, 'an empty array must NOT be dropped');
});

test('all three grid actions run the pair sanitizer, not just the grid page', () => {
  // loadCmdReport, loadCmdReportGrouped and loadCmdSearchSummary each build their own reader filter.
  // A sanitizer wired into only one of them is how a name search ends up applying to the table but
  // not to the totals above it — or to the flat rows but not the grouped ones.
  //
  // The cohort loaders deliberately take NO grid filter (the cohort is defined by prefix + tenant
  // alone, so a patient's lifetime sequence stays intact), which is why the count is three.
  const calls = actionsSrc.match(/applyPatientMembers\(filter, readerFilter\)/g) ?? [];
  assert.equal(calls.length, 3, 'grid + summary + cohort');
  const rowIdCalls = actionsSrc.match(/applyRowIds\(filter, readerFilter\)/g) ?? [];
  assert.equal(calls.length, rowIdCalls.length, 'wired everywhere row ids already were');
});

// -- 3b. The tenancy hole Qodo caught, and the two ways it could come back ----------------------

test('the search result carries the TENANT, not a bare token', () => {
  // ⚠ MEASURED: 240 of 10,701 live member tokens exist in BOTH tenants. A member blind index is an
  // HMAC of the member id and nothing else, so it cannot distinguish them. Returning bare tokens
  // made a name matched in one tenant select the other tenant's rows for those 240, in Consolidated
  // view where both are legitimately visible and the mix is therefore invisible.
  const body = serverSrc.slice(serverSrc.indexOf('export const CMD_NAME_SEARCH_MEMBER_CAP'));
  assert.match(body, /members: Array<\{ entity: string; member: string \}>/);
  assert.match(body, /business_entity_id: string;/, 'the directory read projects the entity');
  // The dedup key must be the PAIR. A Set of tokens would re-collapse the tenants silently.
  assert.match(body, /memberPairs\.set\(`\$\{r\.business_entity_id\}/);
  assert.doesNotMatch(body, /memberTokens/, 'the bare-token shape must not return');
});

test('a stale result cannot be applied to the next view', () => {
  // Tokens resolved under one view surviving a view switch is the same hole from the client side.
  // Binding the result to its originating view makes it structurally impossible rather than relying
  // on a reset effect firing in the right order.
  assert.match(explorerSrc, /const \[nameMatch, setNameMatch\] = useState</);
  assert.match(explorerSrc, /nameMatch !== null && nameMatch\.view === view \? nameMatch\.members : null/);
  assert.match(explorerSrc, /setNameMatch\(\{ view, members: r\.members \}\)/);
});

test('the name result is wired into BOTH dependency lists', () => {
  // ⚠ IT WAS IN NEITHER, AND THE FEATURE SILENTLY DID NOTHING: the notice updated and the grid kept
  // its previous rows. An `eslint-disable exhaustive-deps` on both hooks meant the lint rule that
  // exists to catch exactly this said nothing, which is why it needs a test and not just the rule.
  assert.match(explorerSrc, /const nameMatchKey =/);
  const deps = [...explorerSrc.matchAll(/\}, \[[^\]]*nameMatchKey[^\]]*\]\);/g)];
  assert.equal(deps.length, 2, 'filterArg memo AND the summary effect');
  // null (never searched) and [] (matched nobody) send different filters and must refetch apart.
  assert.match(explorerSrc, /nameMatchTokens === null \? 'none' :/);
});

test('the index alarm fires on a STOPPED sync, not on a non-zero lag', () => {
  // A budget-stopped sync leaves a NON-EMPTY but PARTIAL directory the empty-guard cannot tell from
  // a complete one, so a patient past the watermark reads as "no match".
  //
  // ⚠ BUT THE FIRST VERSION ALARMED ON `lag > 0`, WHICH IS A HEALTHY STATE. The sync runs hourly and
  // ~6,000 charge lines land per day, so lag is non-zero for most of every hour — and nearly all of
  // those lines belong to patients already indexed. That warning would have appeared under almost
  // every search. This pins the corrected trigger so it cannot regress to the noisy one.
  const body = serverSrc.slice(serverSrc.indexOf('export const CMD_NAME_SEARCH_MEMBER_CAP'));
  assert.match(body, /indexStaleMinutes: number;/);
  assert.match(body, /buildPatientDirectoryFreshnessQuery\(\)/);
  // A failed freshness probe reports 0 (= believed current), never a fabricated warning.
  assert.match(body, /indexStaleMinutes = 0;/);
  // ⚠ IT TAKES BOTH, AND EACH ALONE HAS ALREADY BEEN SHIPPED AND BEEN WRONG:
  //   lag > 0 alone          -> fires on a HEALTHY system (lag is non-zero most of every hour)
  //   staleMinutes > N alone -> fires on a QUIET system (the feed adds nothing overnight, so
  //                             refreshed_at only advances when there is work to do)
  // Conjunction is the only correct form, so the test pins the conjunction, not either half.
  assert.match(explorerSrc, /r\.indexLagRows > 0 && r\.indexStaleMinutes > STALE_INDEX_MINUTES/);
  assert.match(explorerSrc, /const STALE_INDEX_MINUTES = 180;/);
});

test('a tenant switch clears the search UI, not just the filter — and kills a pending search', () => {
  // ⚠ THE TOKEN GUARD ALONE LEFT A PHANTOM SEARCH: the filter correctly stopped applying, while the
  // term stayed in the input and the match count stayed under it describing nothing. Both mechanisms
  // are required — the guard is synchronous and correct for the render before this effect flushes.
  //
  // The generation bump joined the effect with Qodo #325: a name search still in flight when the
  // tenant switches would otherwise land AFTER this reset and repaint the phantom this effect
  // exists to clear. `[^\n]*` after the bump: it carries a trailing why-comment in the source.
  assert.match(
    explorerSrc,
    /useEffect\(\(\) => \{\s*nameSearchGen\.current \+= 1;[^\n]*\s*setNameMatch\(null\);\s*setNameQuery\(''\);\s*setNameNotice\(null\);\s*\}, \[view\]\);/,
  );
});

// -- 4. The client ------------------------------------------------------------------------------

test('the client sends member tokens, and the narrowing gate is gone', () => {
  assert.match(explorerSrc, /const nameSearchAllowed = canRevealPhi;/);
  assert.match(explorerSrc, /f\.patient_members = nameMatchTokens;/);
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
  assert.match(explorerSrc, /if \(nameMatchTokens !== null\) f\.patient_members = nameMatchTokens;/);
  const occurrences = explorerSrc.match(/if \(nameMatchTokens !== null\) f\.patient_members/g) ?? [];
  assert.equal(occurrences.length, 2, 'grid page + summary both carry it');
});

// -- 5. The time-window control (Alec, 2026-08-18: "small and unnoticeable") --------------------

test('the time-window group is labelled, bounded in a visible token, and big enough to hit', () => {
  // Three separate reasons it disappeared, each pinned so a restyle has to re-argue them:
  //   1. its border was `border-line` (#E4E9E6) = 1.23:1 on the white surface — no perceptible
  //      boundary, so it read as loose text rather than a control (WCAG 1.4.11 wants >=3:1);
  //   2. every sibling facet in that row carries a visible uppercase label and this one had only an
  //      aria-label, making it the one facet a sighted user could not name;
  //   3. segments were text-xs at px-2.5/py-1 — the smallest thing in the row.
  const group = explorerSrc.slice(
    explorerSrc.indexOf('aria-label="Time window"') - 400,
    explorerSrc.indexOf('aria-label="Time window"') + 200,
  );
  assert.match(group, /border border-ink400/, 'ink400 = 4.61:1, not line = 1.23:1');
  assert.doesNotMatch(group, /border border-line/, 'the invisible token must not come back');
  assert.match(group, /uppercase tracking-wide text-muted-foreground/, 'labelled like its siblings');
  assert.match(group, /Window/);
});

test('the ACTIVE window segment is not distinguished by tint alone', () => {
  // WCAG 1.4.1: colour must not be the only channel. It previously carried --brand-soft (a pale
  // fill) and nothing else — no weight change, no boundary — so the selected window was nearly
  // unreadable. Fill + weight + an inset ring means three channels, any one of which survives.
  const seg = explorerSrc.slice(
    explorerSrc.indexOf("'rounded-md px-3 py-1.5 text-sm transition-colors'"),
    explorerSrc.indexOf("'rounded-md px-3 py-1.5 text-sm transition-colors'") + 320,
  );
  assert.match(seg, /font-semibold/, 'weight');
  assert.match(seg, /ring-1 ring-inset ring-\[var\(--brand-ink\)\]/, 'boundary');
  assert.match(seg, /bg-\[var\(--brand-soft\)\]/, 'fill');
  // px-3/py-1.5 at text-sm is ~48x34 — over the 24x24 WCAG 2.5.8 minimum. text-xs/px-2.5 was not.
  assert.doesNotMatch(explorerSrc, /'rounded-md px-2\.5 py-1 text-xs/, 'the small target must not return');
});
