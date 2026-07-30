---
paths:
  - "app/app/**/*.{ts,tsx}"
  - "app/lib/**/*.{ts,tsx}"
  - "app/components/**/*.{ts,tsx}"
  - "app/test/**/*.{ts,tsx}"
  - "app/middleware.ts"
  - "app/next.config.mjs"
---

# The Next.js app (`app/`)

Next.js 15 App Router, React 18, Tailwind, shadcn/ui, recharts. Vercel app root
is `app/`; `app/vercel.json`'s install command bundles the repo root so `../src`
and `../certs` ship.

## Data path

**The browser's only data path is Server Actions.** `app/lib/actions.ts`
(`'use server'`) → `app/lib/server.ts` (the composition root: builds the
`claims_reader` executor, the Anthropic client, reads the secrets) in-process.
`RESULTS_API_SECRET` never reaches the client. No `NEXT_PUBLIC_*` for anything
server-side; the Supabase browser client is for **auth only**, never PostgREST
for claims data.

## Authorization — check server-side, closest to the data

- `requireExecutive()` (`app/lib/executive.ts`) validates the session via
  `auth.getUser()`. Default-deny.
- `dashboardAccess()` (`app/lib/access.ts`, React-`cache`d) resolves principal +
  role row into allowed views, `canRevealPhi`, `canManageUsers`.
- `app/lib/rbac.ts` is **pure policy** — the view→entitlement decision lives
  there and nowhere else. Roles: `super_admin` (all views, PHI, user mgmt);
  entity `admin` (own entity, PHI); entity `user` (own entity, **non-PHI only**).
  No role row = unprovisioned = default-deny notice.
- Pages `clampView` the `?view=` param to an entitled view. A hand-edited
  `?view=` can never widen access, because the page also scopes data by the
  clamped view. Entity users redirect to their canonical view so URL, branding,
  and data agree.
- Every PHI-reveal Server Action gates on `canRevealPhi`. Adding a new reveal
  surface means adding that gate — there is no ambient check.
- Admin writes go through `claims_admin`-owned SECURITY DEFINER functions
  (`upsert_app_user` / `delete_app_user`, with a last-super-admin guard); the
  roster is read via the postgres-owned `list_app_users()` which projects only
  id/email/confirmed. Authorization (role, entity scope, no self-edit) is
  enforced in `app/lib/admin-actions.ts`, and every mutation writes a
  `claims.access_audit` row.
- `inviteUser` is the **one** deliberate service-role-key exception on the app
  path (`app/lib/supabase/admin.ts`, server-only). Never widen it.

## PHI in the UI

- PHI columns are enumerated in `app/lib/phi.ts`. `ResultsTable` renders
  `••••••` by default and reveals only on an explicit per-row action.
- `IdentityForm` holds patient inputs in local component state only — never
  lifted, never persisted.
- Nothing app-state goes into `localStorage` or cookies. The `?view=` param is
  non-PHI and is fine in the URL; patient terms are not.

## Build traps — `tsc` will not catch these

`npm run typecheck` does not bundle. Run `cd app && npm run build` before any
push that adds an env-dependent import or a new server-only dependency.

- **`libsodium-wrappers` must stay in `serverExternalPackages`** (`next.config.mjs`).
  Its ESM build imports a non-existent sibling, so a native `import` throws
  `ERR_MODULE_NOT_FOUND`; `src/collections/phiCrypto.ts` loads the working CJS
  build via `createRequire`. Any route pulling in `phiCrypto` must not be
  webpacked.
- **Never write `new URL('../../.env', import.meta.url)`.** Webpack detects it as
  a static asset reference; it compiles locally where `.env` exists and fails the
  Vercel build where it does not. Resolve paths via
  `dirname(fileURLToPath(...))` + `path.join`.
- Local builds with `.env` present mask Vercel-only bundler failures. For a
  high-risk change, build with `.env` moved aside.

## Verifying a deploy

Vercel MCP returns 403 here. Check deploy status with `gh` commit-status instead.

## Maintenance gates

`/qualify` and `/billing-audit` render a refactor notice for everyone except
`alec@treathealth.ai` (`app/lib/qualify/maintenance.ts`,
`app/lib/billing-audit/maintenance.ts`, allowlist in `app/lib/alec-only.ts`).
On by default. Kill switch: `QUALIFY_MAINTENANCE` / `CLAIMS_AUDIT_MAINTENANCE`
set to `0`/`false`/`off` — changing it on Vercel requires a redeploy.

## Design

Follow `docs/design-system.md` (TreatHealthOS). Per-view branding is driven by
`brand-theme.tsx` setting `<html data-view=…>` and `--brand-*` CSS variables in
`globals.css`: Consolidated = teal, BXR = navy/brass, Indigo = indigo/violet.
Off-dashboard chrome stays teal; charts keep functional multi-series colors.
