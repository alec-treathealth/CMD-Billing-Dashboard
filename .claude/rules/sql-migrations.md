---
paths:
  - "supabase/migrations/**"
  - "SQL Schemas/**"
---

# Migrations

Two separate planes. Never put a file in the wrong directory.

| Plane | Directory | Next number (as of 2026-08-03) |
|---|---|---|
| Product (`claims`, `collections`) | `supabase/migrations/00NN_*.sql` | **0080** |
| Veris ML (`staging`, `ref`, `core`) | `SQL Schemas/0NN_*.sql` | **026** |

0077/0078/0079 are **Qualify-owned and applied live** — never author a new
0077. Never edit 023, 024, or 025 in place.

These numbers are a **floor, not the answer**. Before claiming a number,
cross-check (a) untracked and unpushed migration files in every worktree, and
(b) the live applied state via the Supabase MCP.

**Fail loud.** If the next-number here contradicts the live applied state or
an untracked file in another worktree, this doc is stale — stop and
re-derive, don't proceed.

TODO — replace hardcoded numbers with a ref-derived command; naive prefix
matching is poisoned by `2026-06-22_claim_line_nullcredit_dedup.sql` and by
`.ts` files in `SQL Schemas/`.

Veris apply state as of 2026-08-03, which is NOT the same as the file order:
**024 APPLIED LIVE · 023 APPLIED LIVE (2026-08-03, after 024) · 025 authored but NOT
applied.** 024 went first because 023 was under concurrent revision and 024 has no executable
dependency on it — no FK, no view, no trigger (the resolver is in
`src/veris/upcomingForecast.ts`); 023 followed once that revision settled. Do not read the
numbering as an apply order. See `docs/veris-data-notes.md` §§ "023 …" / "024 …".

**Merging a migration in a PR does not apply it to prod.** Same-PR code 500s
until `apply_migration` runs. This has already caused one incident (0056 broke
`/admin/user-logs`). Diagnose prod errors via Supabase `get_logs(postgres)`.

## Required file shape

Every migration ships with a sibling `*_rollback.sql`, and a header block:

```sql
-- 00NN — <one-line what>
--
-- WHY: <the reason, with MEASURED evidence where it is a perf change>
-- PHI DISCIPLINE: <what this does or does not expose>
-- OWNERSHIP: <who owns the created objects>
-- IDEMPOTENT: <why re-running is safe>
-- DEPENDENCY: <what must be applied first>
-- Rollback: 00NN_..._rollback.sql
```

Use numbered section banners in the body and end with a commented
`-- N. Verification (run manually after apply)` block.

## Idempotency rules

- `IF NOT EXISTS` on tables and indexes.
- `DROP POLICY IF EXISTS` before `CREATE POLICY` — otherwise SQLSTATE 42710.
- **Never `DROP ROLE`.** CREATE-if-absent, then unconditional REVOKE/GRANT.
- Passwords stay out of band (`.env`), never in a migration.

## Ownership and the apply path

`apply_migration` runs as `postgres`, a **non-superuser** with BYPASSRLS.
`GRANT claims_admin TO postgres WITH SET TRUE` is the intended standing posture:
migrations create objects **born owned** via `SET ROLE claims_admin` … `RESET
ROLE`. Revoking that grant re-breaks the apply path with SQLSTATE 42501. Do not
"clean it up".

## Conventions

- Money is `numeric(12,2)`, never float. Timestamps are `timestamptz`.
- Composite indexes on tenant-scoped tables **lead with `business_entity_id`**.
- A matview cannot carry RLS. If a matview spans tenants, gate reads behind a
  `security_barrier` view filtering on the GUC — or read only through a plain
  query, which does see the GUC.
- After a matview refresh, `VACUUM (ANALYZE)` it so index-only scans stay hot
  (0069 grants MAINTAIN to the writer for exactly this).

## Landmine

`0067_cmd_charge_rollup_patient_name_bidx.sql` is **stale as authored** — it
drops 0068's covering index and 0069's MAINTAIN grant. It was rewritten to
swap-form with a raise-on-loss gate but has **not** been applied, and it is
gated on a name backfill. Do not apply it without re-reading
`app/lib/qualify/contract.ts` and `docs/veris-data-notes.md`.
