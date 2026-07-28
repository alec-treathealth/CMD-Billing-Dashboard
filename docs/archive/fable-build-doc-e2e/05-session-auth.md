# SESSION 5 of 13 — Real Auth (the Indigo Blocker)

**Purpose:** carry `business_entity_id` (+ role) onto the **Veris** request paths so an authenticated
session resolves to a tenant → the `withTenant` GUC. NOTE: per-user auth already EXISTS on the dashboard
(invite-only Supabase Auth + entity-scoped RBAC — migrations 0024–0026, `app/lib/rbac.ts`); this session
extends that identity onto Veris, it does not build auth from zero. Decide explicitly whether to extend
`claims.app_user` / rbac or stand up a parallel Veris membership table (default: EXTEND — a second
identity system is a bug factory). Still Indigo-blocking: RLS tenancy is worthless if the app layer
can't say which tenant a user belongs to.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between it, this prompt, and
observed reality. Trunk-based on main; show every artifact and HOLD
before any commit, migration, push, or deploy. Never add a
Co-Authored-By trailer. PHI denylist absolute. Parameterized queries,
column allowlists, port 6543 no named prepared statements. Server
secrets never reach the browser — no NEXT_PUBLIC_*, Server Actions
remain the browser's only data path. Secrets from env only.

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard's schema/query library/locked semantics stay untouched.
This session builds auth for the VERIS surfaces. The dashboard's own
per-user auth is already DONE (CLAUDE.md §11/§15 — invite-only + RBAC,
NOT deferred); the open decision is only whether Veris REUSES that
identity system or runs its own — raise it once, record Alec's answer,
and do not expand scope unilaterally.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 2's GUC helper and isolation test are green (run it now).
- Session 1's topology answer says where Veris app surfaces live
  (same Next.js app vs separate) — auth lands there.

SCOPE

IN:  Supabase Auth (or the equivalent Alec confirms), session claim
     carrying business_entity_id + role, server-side tenant
     resolution → GUC, route/action guards, real audit principals.
OUT: any UI beyond a minimal login surface, CMD ingest, Indigo data.

THE WORK

1. Present the auth options honestly, then implement the confirmed
   choice (default recommendation: Supabase Auth — same vendor, RLS-
   native, no new bill; alternatives Clerk/WorkOS if Alec wants
   managed SSO later). HOLD on the choice before scaffolding.

2. Identity model: users belong to exactly one business_entity for
   now (membership table user_id → business_entity_id, role in
   {biller, admin, read_only}). The session/JWT carries
   business_entity_id + role as claims. Multi-org membership is
   explicitly out of scope — note the future seam, don't build it.

3. Server-side tenant resolution: the composition root resolves
   business_entity_id from the AUTHENTICATED SESSION ONLY, then runs
   SET LOCAL app.business_entity_id via the Session-2 helper at the
   top of every transaction. A tenant id arriving in any request
   body, query string, or header is ignored and logged as an anomaly
   — never trusted.

4. Guards: every Veris Server Action and route handler requires a
   valid session; unauthenticated → generic 401/redirect, zero PHI
   surface, fail closed. Vercel Deployment Protection STAYS ON as
   the outer belt — this adds a layer, it doesn't swap one.

5. Audit principal becomes the real authenticated user identity on
   the Veris paths (replacing fixed strings), flowing into the
   existing query_log/audit discipline. No email addresses in logs
   if they can identify a patient-adjacent context — use the user id.

6. Extend the tenant-isolation test to run THROUGH the authenticated
   path: a tenant-A user's session yields zero tenant-B rows on
   every Veris query surface; a forged/absent session yields nothing
   at all.

7. Ask Alec once, record the answer in veris-data-notes.md, move on:
   does the existing dashboard adopt this auth now, later, or never?

DEFINITION OF DONE

- Login works locally and on a preview deploy; session inspected
  shows business_entity_id + role claims.
- No Veris Server Action or route reachable without a session
  (probe shown).
- GUC provably set from session, not client input (test).
- Extended isolation test green; the full hermetic suite + typechecks
  clean; no secret reaches the client bundle (grep the build).

HOLD GATES

HOLD on the auth-vendor choice; HOLD before any migration for the
membership table; HOLD before enabling auth on a deployed
environment; HOLD before commit/push.

FIRST OUTPUT I WANT

The auth options comparison (one screen, tradeoffs honest) and the
membership-table schema — before any dependency is installed.

END OF SESSION

Handoff for Session 6 (four sections, <500 words, my voice). Open
threads: Alec's dashboard-auth answer, and the exact claim names the
ingest/UI sessions should read.
=====================================================================
```
