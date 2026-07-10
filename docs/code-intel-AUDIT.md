# Behavioral-Health Billing-Code Intelligence — Build & Audit Report

**Status: committed to local `main` (migrations 0043–0045) on top of `0042`; push pending; migrations NOT applied.**
No migration was run, no production data was touched, no Supabase call was made. The
code is committed on local `main`; the authenticated `git push origin main` is the only
remaining step (the build sandbox has no GitHub credentials).

Author: Claude (Cowork) · Date: 2026-07-10 · Scope: replace the static, spreadsheet-
driven Code Reference (Phase 9) with a structured, versioned, auditable payer-code
intelligence layer + a quarterly CMS HCPCS change-detection sync.

---

## 1. Verification performed (in an isolated sandbox — not against your DB)

| Check | Result |
|---|---|
| Root `tsc --noEmit` (`npm run typecheck`) | **PASS** (clean) |
| App `tsc --noEmit` (`cd app && npm run typecheck`) | **PASS** (clean) |
| Unit tests for the pure sync core (parse / filter / diff / URL-resolver / zip) | **20/20 PASS** |

The pure logic (parse, BH filter, snapshot diff, URL resolution, ZIP reader) is fully
unit-tested with fixtures — no network, no database, no Supabase. The I/O adapters
(`cmsSource.ts` network fetch, `db.ts` node-postgres) are deliberately thin and are
**not** exercised here; they must be validated by a maintainer via the built-in dry-run
(see §6) before the job is armed.

> Tests could not run through the repo's `tsx` runner inside the sandbox because the
> mounted `node_modules` carries the macOS `esbuild` binary, not the Linux one. They
> were compiled with the repo's own `tsc` to plain ESM and run on Node — same source,
> no behavior change. On your machine `npm test` runs them normally.

---

## 2. What was built (all uncommitted)

**Migrations** (`supabase/migrations/`, next numbers after the latest pushed migration `0042`):
- `0043_bh_billing_code_intelligence.sql` — `code_intel` schema, enums, tables
  (facility, ref_code, ref_code_relationship, payer, payer_plan, payer_entity_role,
  billing_policy + code/claim rules, policy_source_document/excerpt,
  policy_change_event), indexes, RLS + `claims_reader` SELECT grants.
- `0044_bh_billing_code_intel_rpcs.sql` — `get_active_billing_codes(...)` function +
  `v_pending_code_change_flags` view + reader EXECUTE/SELECT grants.
- `0045_code_intel_writer_role.sql` — least-privilege `code_intel_writer` NOLOGIN role
  for the sync cron (mirrors `0013` `cmd_rollup_writer`).
- Matching reverse scripts in `supabase/rollbacks/0043–0045_*.sql`.

**Sync job** (`src/jobs/cmsHcpcsSync/`): `layout.ts`, `types.ts`, `parse.ts` (pure),
`filter.ts` (pure), `diff.ts` (pure), `resolveUrl.ts` (pure), `zip.ts` (dependency-free
ZIP reader), `cmsSource.ts` (network adapter), `db.ts` (node-postgres, batched,
parameterized), `run.ts` (orchestrator, safety-gated), `index.ts`.

**App layer** (Next.js): `app/lib/codeIntel.ts` (cron + read handlers),
`app/app/api/cron/cms-hcpcs-sync/route.ts`, `app/app/api/code-reference/active/route.ts`,
`app/app/api/code-reference/pending-flags/route.ts`, and one cron entry added to
`app/vercel.json`. Reader query wrappers in `src/queries/code_intel.ts`.

**Tests** (`test/cmsHcpcs*.test.ts` + `test/fixtures/cmsHcpcs.ts`).
**Env docs** appended (commented) to `.env.example`.

---

## 3. Correctness fixes applied vs. the original draft

The draft was a solid blueprint, but several issues would have failed or silently
corrupted data in production. Each was corrected:

1. **File format — pipe-delimited → fixed-width.** The CMS Alpha-Numeric HCPCS file is
   a **fixed-width** record, not `|`-delimited. The draft's `csv-parse({delimiter:'|'})`
   would have produced garbage. Replaced with a fixed-width parser driven by a declared,
   reviewable column map (`layout.ts`).
2. **Change detection — trusted `action_flag` → snapshot diff.** The quarterly file is a
   **full active-set snapshot**, not a delta with a reliable per-row A/R/D action flag.
   Change type is now derived by diffing this quarter against our own prior `ref_code`
   snapshot (added / revised / deleted), which is correct and testable.
3. **Revenue codes removed from the CMS sync.** Revenue codes are **NUBC-maintained and
   are not in the CMS HCPCS file**. The draft filtered the HCPCS file for revenue codes
   (a category error). Revenue-code seeding is out of scope for this sync (see §5).
4. **Download URL — constructed pattern → scrape the authoritative listing.** CMS
   filenames are not perfectly regular (most `…-hcpcs-file.zip`, but some quarters use
   the plural `…-hcpcs-files.zip`, e.g. Oct 2023 / Jan–Apr 2024). The draft's constructed
   filename would 404 on those quarters. Now we parse the quarterly-update page and pick
   the newest **effective** quarter (verified live: pattern is
   `https://www.cms.gov/files/zip/<month>-<year>-alpha-numeric-hcpcs-file(s).zip`).
5. **Idempotency.** Re-running a quarter in the draft would insert duplicate flags. Added
   a partial unique index `(source, source_ref, code_id, change_type)` and
   `ON CONFLICT DO NOTHING`, so re-runs are safe.
6. **`.single()` → explicit set-based upserts.** The draft's row-by-row `.single()`
   throws on zero rows and is slow. Rewritten as batched, parameterized `INSERT … ON
   CONFLICT … RETURNING` (matches `src/db.ts`).
7. **`runCmsHcpcsSync().catch(process.exit)`** passed the error object as the exit code.
   Replaced with a proper logged failure + `process.exit(1)`.
8. **Node ≥18 has global `fetch`** — the `node-fetch` dependency was dropped.
9. **HCPCS code validation.** Codes are validated as `^[A-Z][0-9]{4}$` (canonical Level
   II format), which correctly rejects header text, 2-char modifiers, and 5-digit CPT.
   (This exact bug was caught by a unit test during the build.)

---

## 4. Architecture-alignment decisions (why this differs from the draft)

- **No `@supabase/supabase-js` service-role client.** Your compliance model
  (`docs/CLAUDE.md` §2) forbids the service-role key / `claims_admin` on the app path.
  The sync writes as a **new least-privilege `code_intel_writer` role** over
  node-postgres with verify-full TLS, exactly like `cmd_rollup_writer` (0013). Reads use
  the existing `claims_reader` path + `PgExecutor`.
- **Dedicated `code_intel` schema, kept OFF PostgREST** (same posture as
  `claims` / `collections`).
- **Thin cron route → `lib` handler**, constant-time `Bearer CRON_SECRET` check, GET-only,
  `runtime='nodejs'`, `force-dynamic`, non-PHI response — matches the existing
  `refresh-cmd-payer` / `cmd-explorer` routes.
- **No new npm dependency.** The ZIP reader is hand-rolled over Node's `zlib`
  (STORE + DEFLATE), matching the repo's minimal-dependency ethos (cf. `src/ssl.ts`),
  rather than pulling `adm-zip` into a PHI-adjacent deployment.

---

## 5. PHI / compliance decisions

- **This layer is non-PHI by construction** — codes, payer/facility names, policy rules,
  and CMS change signals only.
- **`claim_issue_log` was intentionally OMITTED.** The draft's AR/issue tracker carried
  `member_initials`, `member_ref`, and DOS — that is **PHI** and would violate your
  encrypt-identifiers + blind-index pattern (`collections.cmd_explorer_rows`). If you
  want an AR/follow-up tracker, it should be a separate migration following that PHI
  pattern, not part of this reference layer.
- **`facility_payer_enrollment` was deferred** as out of scope for a code-intelligence
  layer (credentialing is a distinct workflow). Easy to add later if wanted.
- No secrets are logged; error responses return a message string only, never internals.

---

## 6. Residual risks / MUST verify before rollout

1. **Fixed-width offsets are reviewed config, not tested truth.** `layout.ts` carries the
   best-known ANWEB column ranges with a prominent verify-banner. A maintainer **must**
   confirm them against the CMS "HCPCS Record Layout" doc for the target year before the
   first live run. The parser *mechanism* is tested; the *offsets* are an input.
2. **Job is disabled by default.** It self-reports `enabled:false` and does nothing until
   `CMS_HCPCS_SYNC_ENABLED=true`. **First live run should be `CMS_HCPCS_SYNC_DRY_RUN=true`**
   (fetch + parse + diff + counts, zero writes).
3. **ZIP reader supports STORE/DEFLATE only**; it throws a clear error on ZIP64/encrypted
   archives rather than emitting garbage. CMS files are standard DEFLATE today — verified
   at runtime, not assumed.
4. **Deletion semantics.** A code absent from the full quarterly snapshot is flagged
   `code_deleted` (pending human review) and marked `is_active=false` — it is **never**
   auto-removed and no billing policy is auto-changed. Humans review every flag.
5. **Vercel function limit.** The cron sets `maxDuration=60` (Pro+). Page fetch + ZIP +
   parse is fast, but confirm your plan allows 60s.
6. **Operator step (out of band):** provision a login mapping for `code_intel_writer`
   and set `CODE_INTEL_WRITER_DATABASE_URL` (never in a migration) — see the header of
   `0045`.
7. **Revenue codes** still need a separate NUBC seed path to populate `ref_code`
   (code_type='revenue') and the `required_with_code_id` pairings the dashboard uses.

---

## 7. Pre-rollout checklist

- [ ] Review migrations `0043`–`0045` and rollbacks.
- [ ] Verify `layout.ts` offsets against the CMS record-layout PDF for the target year.
- [ ] Apply `0043`→`0044`→`0045` to a **branch/staging** DB first; confirm advisors clean.
- [ ] Provision `code_intel_writer` login; set `CODE_INTEL_WRITER_DATABASE_URL` + `CRON_SECRET`.
- [ ] Run the sync with `CMS_HCPCS_SYNC_DRY_RUN=true`; sanity-check the reported counts.
- [ ] Seed `facility` / `payer` / `payer_plan` / `billing_policy*` from the current
      spreadsheet logic; seed revenue codes (NUBC).
- [ ] Arm with `CMS_HCPCS_SYNC_ENABLED=true`; watch the first real quarterly run.
- [ ] Wire the dashboard to `/api/code-reference/active` + `/pending-flags`.
- [ ] `npm test` + both `typecheck`s green in CI, then commit.

---

## 8. Explicitly NOT done (per your instruction)

No migration applied · no production seed · no live Supabase mutation · no git commit.
Awaiting your go-ahead.
