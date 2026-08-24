# HANDOFF — Upcoming Payments: finish 023, stop the hourly 500, un-rot the migration docs

**Written** 2026-08-03, from the session that authored 023/024 and applied 024.
**Scope** is deliberately narrow. Read §4 (the Qualify firewall) before you touch anything.

Paste this whole file into a fresh session, or point it here.

---

## 0. TL;DR — the four issues, in the order they must be done

| # | Issue | Kind | Blocked on |
|---|---|---|---|
| 1 | `CLAUDE.md` + `.claude/rules/sql-migrations.md` say the next product migration is **0077** — but 0077/0078/0079 already exist *and are applied live*. A fresh session will author `0077_*.sql` and collide with Qualify's applied work. | docs only | nothing — **do this first** |
| 2 | Veris migration **023 is not applied**. The sheet-forecast half of Upcoming Payments is dark. | `apply_migration` | nothing (the concurrent revision is over — see §2) |
| 3 | `/api/cron/upcoming-overrides` fails **every hour at :55**. Two stacked causes. | ops + apply | issue 2 + a human sheet edit |
| 4 | The `Upcoming Payments Overrides` tab does not exist in the workbook (probably — see §3.2). | **human, Alec only** | Alec |

Issue 1 is the one with real blast radius, and it is a five-line docs fix. Do it first even if
you do nothing else.

---

## 1. Verified state of `origin/main` (checked 2026-08-03, not assumed)

### Branches

```
origin/main    6d62ca6  Merge pull request #77 from alec-treathealth/staging
origin/staging 4430e47  docs(veris): correct fc2c8f6's message …
```

`origin/staging` is **28 commits behind `origin/main` and 0 ahead.** Everything from this
workstream is already merged to main via PRs #71/#72/#77.

> ⚠️ **The local `staging` branch is NOT `origin/staging`.** It carries two *unpushed* commits
> that belong to a **different, concurrent session** (the payer-policy-intel WIP):
>
> ```
> 7985f73 fix(intel): restore priorStateBlock, and typecheck scripts/
> 022c40b refactor(intel): probe uses the shared domain matcher
> ```
>
> Do **not** `reset --hard`, `rebase`, or force-push local `staging`. Do not "sync staging to
> main" as a housekeeping step — you would destroy another agent's unpushed work. If you need a
> clean base, branch from `origin/main` and leave `staging` alone.

### Working tree is shared with at least one other live session

The tree has untracked files and staged/unstaged edits from other sessions. **This already
caused one incident in the previous session** (`fc2c8f6` swept three of another session's files
into a migration-024 commit). The mechanism: two sessions in one working tree share one git
**index**, so `git add <paths>` followed by a bare `git commit` commits *whatever is in the
index at commit time*, not the paths you handed your own `git add`.

**The rule, non-negotiable in this tree:**

```bash
git commit -o <path> [<path>…] -m "…"   # -o = commit ONLY these paths, ignore the index
```

Never `git add -A`. Never a bare `git commit` after staging. Recorded in
`veris-data-notes.md`.

### Migration planes — live apply state

Confirmed against the live DB (`dbpabchpvipipkzkogta`), not read off the docs:

| Plane | On disk (main) | Applied live | **Next free number** |
|---|---|---|---|
| Product `supabase/migrations/` | … 0076, **0077, 0078, 0079** | 0077 ✅ 0078 ✅ 0079 ✅ | **0080** |
| Veris `SQL Schemas/` | … 023, 024, 025 | **024 only** | **026** |

Veris file numbering is **not** the apply order: 024 applied ahead of 023 on purpose.

Live object counts:

```
coding.code_decision                  42   (0077, seeded)
coding.code_decision_audit            42
collections.qualify_facility_census    0   (0078, cron deliberately unscheduled)
staging.expected_payment_manual        0   (024, applied by the previous session)
staging.expected_payment_override      DOES NOT EXIST   ← 023 not applied
ref.payer_policy*                      DOES NOT EXIST   ← 025 not applied
```

`0077_coding_decision_registry.sql` creates `coding.code_decision`, **not** a table named
`coding_decision_registry` — don't search for the filename's noun.

---

## 2. Issue 1 + 2 — the docs collision, and applying 023

### 2.1 Fix the docs first (no DB, no risk, five lines)

Both files carry the same stale table. The Qualify v2 merge (#75) added 0077–0079 but **did not
update either doc** — verified: the Qualify diff touches neither `CLAUDE.md` nor
`.claude/rules/sql-migrations.md`.

In **`CLAUDE.md`** (§ Repo layout) and **`.claude/rules/sql-migrations.md`** (top table):

- Product next number: `0077` → **`0080`**
- Add to the Veris apply-state note that the product plane's numbering is likewise ahead of the
  docs, and that 0077/0078/0079 are Qualify-owned and applied.

Two more stale facts in `CLAUDE.md` while you are in there:

- `app/vercel.json` declares **18 cron entries across 16 distinct routes** (not 17/15). The new
  ones are `/api/cron/payer-intel` (`20 7 2 * *`, monthly) and — *unscheduled, see §4* —
  `/api/cron/qualify-census`.
- The verification-gate tripwire says `889 pass` (root) / `176 pass` (app). Both are stale; the
  previous session measured **1001 / 189** but on a tree containing other sessions' edits, so
  that number is not trustworthy either. **Re-baseline from a clean checkout of `origin/main`**
  and write the measured numbers in.

Commit with `-o` on exactly those two paths.

### 2.2 Apply Veris 023

`SQL Schemas/023_expected_payment_override.sql` on `origin/main` is **byte-identical** to the
worktree copy — the "another WIP is modifying 023" hold that made the previous session apply 024
first **no longer applies**. Confirm that is still true before you apply:

```bash
git diff origin/main -- "SQL Schemas/023_expected_payment_override.sql"   # must be empty
```

Then, per the standing gate: **show the file and HOLD for Alec before `apply_migration`.**

Apply checklist — the previous session's 024 apply is the template to match, and it caught a real
defect this way:

1. **Read the whole file for dollar-quoting bugs before applying.** 024 had 12 instances of `''`
   inside a `$t$…$t$` block, where `''` is *two literal apostrophes*, not an escape — they would
   have landed in the live comment as `sheet row''s amount`. Ordinary-quoted `COMMENT ON COLUMN`
   statements are the opposite: there `''` *is* correct. Check both forms in 023.
2. Apply, then run the file's own `-- N. Verification` block **live**. `{"success": true}` is not
   evidence.
3. Assert specifically: owner is `claims_admin`; RLS on; **no PHI column** (023's parser drops the
   `Client` name at the boundary — the table must have nowhere to put it); grants are
   `claims_admin` + `claims_reader/SELECT` + `cmd_rollup_writer` (023 *does* need the writer —
   unlike 024, which correctly gets none, because 023 is replace-per-sync and 024 is app-owned).
4. **Exercise the constraints, don't just read them.** 023 CHECKs `amount > 0`. Insert a $0 row in
   a `DO $probe$ … $probe$` block, assert it raises, assert `rows_left_behind = 0`.
5. `get_advisors(security)` must return `{"lints":[]}`.
6. Append an apply record to `veris-data-notes.md` (see the `## 024 —` section for the shape),
   and flip 023's line in both migration tables to APPLIED.

---

## 3. Issue 3 + 4 — the hourly cron failure

### 3.1 Diagnosis

`/api/cron/upcoming-overrides` runs hourly at `:55` (`app/vercel.json`). Reading
`handleUpcomingOverridesCron` in `app/lib/server.ts` (~L1161): every failure path is a single
`catch` that returns **HTTP 500** `{error:'cron_failed'}` with the real reason going only to
`console.error`. So this is a **hard-failing cron in the Vercel UI**, not just a log line.

> Confidence note: the 500 is derived from **reading the route + the two missing preconditions**,
> not from reading Vercel logs. First action should be to pull the actual log line for a recent
> `:55` invocation and confirm which of the two causes fires first.

Two causes, stacked — fixing either one alone still leaves it red:

| Cause | Fix | Owner |
|---|---|---|
| **(a)** The `Upcoming Payments Overrides` tab does not exist → `fetchTab` throws inside `readSheet`. | Create the tab (§3.2) | **Alec** |
| **(b)** 023 not applied → `staging.expected_payment_override` doesn't exist → the write throws. | §2.2 | you |

**Env is fully configured — do not chase this.** Verified in Vercel Production:
`UPCOMING_PAYMENTS_SHEET_ID` (set 2026-08-03), `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_SHEETS_REFRESH_TOKEN`, `CRON_SECRET`. All present.

The **read path fails soft** and is verified to do so: `loadUpcomingOverrides` returns
`{ok:false}` on any throw, so the Overview tile degrades to the ERA-only half with no error
surfaced to users. Nothing is user-visibly broken today. This is a monitoring problem — and a red
light that is always red stops being a signal.

### 3.2 The sheet tab — Alec's action, and what to confirm

The workbook ID is confirmed to be a real, live, BXR-owned workbook:

```
id       1auO2SDezdYS7tbqqDnk9OU_R7G-Erab8omvOZW0ANRQ
title    Master BXR Spreadsheet 2026
owner    catherine@bxrconsulting.com
```

BXR ownership is consistent with the sync hardcoding `businessEntityId: BXR_TENANT_ID`.

**Tab existence could not be confirmed.** The Drive MCP renders only the workbook's first sheet,
so absence of the string is not proof of absence of the tab. What *was* confirmed is that the
first sheet has exactly the malformed shape the source comment documents — an abandoned
`Facility | Insurance | Client | Date/Range | Auth or Claim Issue | Last Update` header, then a
bare `Upcoming Payments` section-title row, then the real header. The contract comment in
`src/veris/upcomingOverrideSheet.ts` is accurate. **Confirm the tab list via the Sheets API (or
just ask Alec) rather than trusting the Drive rendering.**

Required tab — exact spelling, exact order, **header on row 1**, flat (no section titles, no gap
rows, no `Total` row):

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| `Facility` | `Insurance` | `Client` | `Date` | `Check or EFT` | `Amount` |

Tab name: **`Upcoming Payments Overrides`** (`OVERRIDE_TAB`). Header validation throws loud on any
drift — it will not map by guess. Note column D is **`Date`**, not `Date/Range` as on the existing
sheet.

`Client` stays in the contract because ops needs it to do their job. It **contains PHI** and is
dropped at the parser boundary — `ParsedOverrideRow` has no field that can hold it, and the
previous session bounded a related PHI echo (`safeFacilityLabel`) so reject logs carry row numbers
and reason codes only. **Do not add a field for the name.** Doing so makes the whole tile PHI and
requires 021's encryption + blind-index treatment in a separate table.

### 3.3 Locked semantics — do not "improve" these

Alec's rulings, verbatim intent:

- **Additive-only.** Forecast rows display *alongside* ERA rows. `method_label` is `'EFT' | 'Check'`
  (the sheet's vocabulary); the ERA half uses `ACH/CHK/NON`. They are kept separate **on purpose**
  so a forecast row can't be mistaken for a real remit in a naive query. No join to
  `era_835_payment` in 023.
- **Never sum the forecast total into the ERA headline.** Render forecast rows visually distinct.
- A forecast row left in the sheet after its 835 lands **is double-counted** — known, accepted,
  documented. The mitigation is operational (delete the sheet row) plus 024's suggest-then-confirm
  reconciliation. Do not invent suppression semantics in 023 without re-opening the call with Alec.

### 3.4 If Alec can't make the tab soon

Then the honest fix is to stop the cron from reporting a red light for a precondition that isn't
met yet: distinguish "not configured / tab absent" from "sync genuinely failed" and return
**200 with `ok:false, status:'tab_absent'`** for the former, keeping 500 for real failures. That is
a real behavioural change to a cron route — **propose it to Alec, don't just ship it.** The
alternative (de-schedule the cron until the tab exists) is one line in `app/vercel.json` and is
cleaner if the tab is weeks away.

---

## 4. The Qualify firewall — read before touching anything

**Verified:** the Qualify v2 merge (#75) and the Upcoming Payments work share **zero files.**
57 files vs 25 files, empty intersection. Keep it that way.

### Qualify owns these — do not touch

```
supabase/migrations/0077_* 0078_* 0079_*   (applied live)
coding.code_decision, coding.code_decision_audit
collections.qualify_facility_census
app/lib/qualify/**, app/components/qualify/**
app/app/api/cron/qualify-census/route.ts
docs/qualify-v2-morning-runbook.md
```

**`/api/cron/qualify-census` is absent from `vercel.json` deliberately.** Its runbook (§ "Step 4 —
monday census (deliberately NOT scheduled)") reserves scheduling for *"a separate, explicitly-scoped
session"*, gated on a read-only monday service identity in `MONDAY_SECRET_API_KEY`. **Do not
schedule it.** If you edit `app/vercel.json` for issue 3.4, change *only* the
`upcoming-overrides` entry and leave the file otherwise byte-identical.

### The migration rule Alec asked for

**This work needs no product migration at all.** Issues 1–4 are: two docs edits, one Veris
`apply_migration` of an already-authored file, one human sheet edit, and possibly one line of
`vercel.json`.

If a migration *does* turn out to be necessary:

- **Veris plane** (`staging`/`ref`/`core`) → new file starts at **026**. Never edit 023, 024, or
  025 in place — 024 is applied, and 025 belongs to the live payer-intel session.
- **Product plane** (`claims`/`collections`/`coding`) → new file starts at **0080**, never 0077.
  It must not reference `coding.*` or `collections.qualify_facility_census`. If you believe you
  need to alter a Qualify-owned object, **stop and hand it back to Alec** — that is a separate
  migration in a separate, Qualify-scoped session, per his instruction.
- Every migration ships a sibling `*_rollback.sql` and the full header block
  (`WHY` / `PHI DISCIPLINE` / `OWNERSHIP` / `IDEMPOTENT` / `DEPENDENCY` / `Rollback`).

---

## 5. Standing rules that bite on this specific task

- **Gate outward-facing actions.** Show results and HOLD before `apply_migration`, commit, push,
  or deploy. Alec confirms, then you act.
- **PR against `staging`, never `main`:** `gh pr create --base staging`. But note staging is 28
  behind main right now — coordinate with Alec on whether to branch from `origin/main` instead.
- **Never add a `Co-Authored-By` trailer.**
- **The five-command gate** before any commit — typecheck alone is not "verified":
  ```
  npm test  ·  npm run typecheck  ·  cd app && npm test  ·  cd app && npm run typecheck  ·  cd app && npm run build
  ```
  Root `tsc` is stricter than app `tsc` (`noUncheckedIndexedAccess`) — run both.
  In this shared tree, **a single `next build` failure is not evidence** until it reproduces; the
  previous session hit one caused by another session saving a file mid-build.
- **Merging a migration in a PR does not apply it.** Same-PR code 500s until `apply_migration`
  runs. This has already caused one incident (0056 → `/admin/user-logs`).
- **Don't go near the hourly collections crons** (`:00/:15/:30/:35/:45`) or schedule CMD work near
  those minutes. `upcoming-overrides` at `:55` is outside that contention window — keep it there.

---

## 6. Suggested order

1. **Docs fix** (issue 1) — 0077→0080, cron counts, re-baselined test tripwire. Commit with `-o`.
2. **Pull the real Vercel log line** for a recent `:55` `upcoming-overrides` run; confirm which
   cause fires first. Report it.
3. **Ask Alec for the sheet tab** (issue 4) — it is the only truly blocking human step. Give him
   the exact header row from §3.2.
4. **Show 023 and HOLD.** On his go: apply, run §7 verification live, exercise the `amount > 0`
   CHECK, `get_advisors`, record in `veris-data-notes.md`.
5. **Re-verify the cron** end to end once both (a) and (b) are cleared — one green `:55` run,
   `ok:true`, rows landed, and the Overview tile showing forecast rows visually distinct from the
   ERA half.
6. Only then propose §3.4 if it is still needed.

## 7. Explicitly out of scope

- Scheduling `/api/cron/qualify-census` (Qualify's own session).
- Applying Veris **025** (the payer-intel session's, still in flight — it has unpushed commits on
  local `staging`).
- Syncing / resetting `staging` (see the warning in §1).
- Applying `0067_cmd_charge_rollup_patient_name_bidx.sql` — stale as authored, gated on a name
  backfill. Leave it alone.
- ERA reconciliation beyond what 024 already ships.
