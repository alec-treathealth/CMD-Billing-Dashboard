# Handoff — per-user auth, Payers removal, CMD Collections Explorer

Three changes shipped this session (all on `main`, no `Co-Authored-By` trailer):

| Commit | What |
|--------|------|
| `4dd06f5` | **Per-user Supabase Auth login gate** (migration 0018, middleware, allowlist, session principal) |
| `524f1d1` | **Removed the Payers Explorer** route + sub-nav tab |
| `b3418e6` | **CMD-backed Collections Explorer** tab at `/dashboard/collections/explorer` |

> ⚠️ **Auth is built but NOT YET ACTIVE.** Until the env vars + Supabase dashboard
> steps below are done, the middleware/gate is a no-op and the app still relies on
> **Vercel Deployment Protection**. That's a deliberate, safe staged rollout — flip
> auth on by completing the steps, then Deployment Protection becomes defense-in-depth.

---

## 1. What changed

### Task 1 — per-user auth (replaces Deployment Protection as the primary PHI gate)
- **DB (migration `0018_auth_setup.sql`, already applied via MCP to `dbpabchpvipipkzkogta`):**
  `auth_config.allowed_emails` (the single source of truth for who may sign in; RLS =
  own-row read for `authenticated`), seeded with `alec@`, `derek@`, `blake@treathealth.ai`,
  plus a **Before-User-Created auth hook** `auth_config.restrict_signup_to_allowlist`
  that blocks signups for non-allowlisted emails.
- **App:** `middleware.ts` gates all routes except `/login`, `/auth/callback`, `/api/*`;
  signed-in-but-not-allowlisted users are signed out → `/login?error=unauthorized`.
  New `app/lib/supabase/{server,client,middleware,env,allowlist}.ts`, `app/lib/executive.ts`
  (DB-backed allowlist gate), `app/lib/auth-actions.ts` (sign-in/out), a TreatHealthOS
  login page, an `/auth/callback` route, and a top-nav **Sign out** button.
- **Audit principal:** `query_log` now records the **authenticated session email** for
  `runSearch`/`fetchRows` (falls back to the old `phase5-ui` label only while auth env
  is unset, so the staged rollout never breaks search/reveal).
- Kept from prior WIP: `0017_access_audit.sql` (durable `claims.access_audit` +
  `claims.log_access`) and the `/account` proof page.

### Task 2 — Payers Explorer removed
- Deleted `app/app/dashboard/payers/page.tsx` and `app/components/dashboard/payers.tsx`;
  removed the sub-nav tab and the `./payers` barrel export.
- Shared code kept: `payer-chart.tsx` + `overview-bar-chart.tsx` (the Overview's Master
  BXR chart still uses them). `loadPayerGap` in `actions.ts` is now an unused export
  (harmless; prune later if desired).

### Task 3 — CMD Collections Explorer (new tab; existing collections page untouched)
- New `/dashboard/collections/explorer` tab renders Derek's **14-column CMD batch report**
  (reuses `src/collections/cmdPayer.ts` run→poll→unzip→CSV client; report `10091971` /
  filter `10147392`).
- **PHI handling:** non-PHI columns cached 15 min (`unstable_cache`); the 3 PHI columns
  (Patient Name / Member ID / Group Number) are masked `••••••` and revealed **per row**
  via an **audited** server fetch (`claims.log_access`) from a volatile in-process cache.
  Match is by SHA-256 content fingerprint → fails closed, never wrong-patient. No PHI
  is cached at rest.
- The existing `/dashboard/collections` daily Checks/EFT/Gross table + KPI chart are
  unchanged; that tab was relabeled "Collections".

---

## 2. Env vars to set (Vercel project env + `app/.env.local` for local dev)

| Var | Where | Purpose |
|-----|-------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel + `app/.env.local` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel + `app/.env.local` | Supabase publishable/anon key (public) |
| `CMD_API_USERNAME` | Vercel + env (**server-only**) | CMD Batch Reporting API basic-auth user |
| `CMD_API_PASSWORD` | Vercel + env (**server-only**) | CMD Batch Reporting API basic-auth password |
| `CMD_EXPLORER_REPORT_ID` | optional (default `10091971`) | explorer report id |
| `CMD_EXPLORER_FILTER_ID` | optional (default `10147392`) | explorer filter id |

`NEXT_PUBLIC_*` are safe in the browser. `CMD_API_*` are **server-only — never** prefix
`NEXT_PUBLIC`. Placeholders are documented in `.env.example` (root) and `app/.env.example`.

## 3. Supabase dashboard steps (to activate auth)

1. **Auth → Hooks → "Before User Created"** → Enable → Postgres →
   schema `auth_config`, function `restrict_signup_to_allowlist`.
2. **Project Settings → API → "Exposed schemas"** → add **`auth_config`**
   (lets the app read its own-row allowlist under RLS; anon stays denied).
3. **Auth → Users** → invite/create the actual accounts (the hook ensures only
   allowlisted emails succeed). Add more allowed emails by inserting rows into
   `auth_config.allowed_emails` (no redeploy needed).

---

## 4. Manual verification (no browser driver in this environment)

**Auth (after steps 2–3 above, with env set):**
- Incognito → any app URL should redirect to `/login`.
- Sign in as an allowlisted user → lands on `/dashboard`; **Sign out** clears the session.
- Sign in as a signed-in-but-not-allowlisted account → bounced to `/login?error=unauthorized`.
- Attempt signup with a non-allowlisted email → rejected by the hook.

**Payers removal:**
- `/dashboard/payers` → 404; sub-nav shows only Overview · Collections · Collections Explorer.
- Overview Master BXR chart still renders (shared chart code intact).

**Collections Explorer:**
- `/dashboard/collections/explorer` loads the 14-column grid (CMD report runs server-side).
- PHI columns show `••••••`; per-row **Reveal** unmasks that row and writes a
  `claims.access_audit` row (`action = 'reveal_cmd_explorer_row'`, attributed to the
  signed-in email). *(Reveal requires an active session — works only after auth is on.)*
- `/dashboard/collections` daily Checks/EFT/Gross table is unchanged.

---

## 5. Follow-ups (not done this session)

- **Stale copy:** `app/app/dashboard/collections/page.tsx` (and the dashboard overview
  footer) still say *"There is no application login… controlled solely by Vercel
  Deployment Protection."* True only until auth is activated — update then. Likewise
  `CLAUDE.md` §11 ("there is no app-level login") and §15 ("per-user auth deferred").
- **Orphaned export:** `loadPayerGap` in `app/lib/actions.ts` is now unused.
- **Audit principal coverage:** only `runSearch`/`fetchRows` thread the session email;
  `revealClaim`/field-picker/dashboard widgets still use fixed labels.
