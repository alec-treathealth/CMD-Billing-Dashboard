---
paths:
  - "supabase/migrations/**"
  - "SQL Schemas/**"
---

# Migrations

Two separate planes. Never put a file in the wrong directory.

| Plane | Directory | Next number (as of 2026-08-10) |
|---|---|---|
| Product (`claims`, `collections`) | `supabase/migrations/00NN_*.sql` | **0098** — 0092/0093/0094 applied live; **0095 consumed its slot with NO file** (one-shot prune, ledger 20260809073608 — never reuse it); **0096 = `manual_deposits`, applied live 2026-08-10 by a concurrent session, file UNTRACKED on every ref**; **0097 (qualify watchers) APPLIED LIVE 2026-08-10** (ledger `20260810120258`) |
| Veris ML (`staging`, `ref`, `core`, `intel`) | `SQL Schemas/0NN_*.sql` | **035** — 029 applied live; 030/031 authored-not-applied (031 held on purpose — see CLAUDE.md); **032/033/034 applied live 2026-08-10** (`intel_writer_select_grant`, `expected_payment_manual_lifecycle`, `drop_expected_payment_manual_live_idx`) |

⚠ **2026-08-10 — THE COLLISION THIS PARAGRAPH WARNS ABOUT ACTUALLY HAPPENED.** The qualify-watchers
migration was numbered `0096` off a directory listing. While it sat unapplied, a concurrent session
authored and APPLIED its own `0096_manual_deposits`; that file is untracked in the primary worktree
and exists on no branch, so *nothing in git* would ever have revealed the clash. It was caught only
because the number was re-verified against `supabase_migrations.schema_migrations` immediately
before `apply_migration`, and the watchers migration was renumbered to 0097 before touching the
database. **Query the ledger every time, and grep every worktree for untracked `.sql` — the numbers
in this table are a floor, and on a busy day they are stale within hours.**

0077/0078/0079 are **Qualify-owned and applied live** — never author a new
0077. 0080/0081/0082 (explorer perf: filter-options matview, rollup trigram
GIN, base-table hygiene) are **applied live 2026-08-04**; 0081 was applied
statement-by-statement via autocommit `execute_sql` (CREATE INDEX
CONCURRENTLY), NOT `apply_migration` — see its file header before imitating.
Never edit 023, 024, or 025 in place.

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
**024 APPLIED LIVE · 023 APPLIED LIVE (2026-08-03, after 024) · 025 APPLIED LIVE
(2026-08-03, after two 42501 posture corrections — see the file header).** 024 went first
because 023 was under concurrent revision and 024 has no executable dependency on it — no FK,
no view, no trigger (the resolver is in `src/veris/upcomingForecast.ts`); 023 followed once
that revision settled. Do not read the numbering as an apply order. See
`veris-data-notes.md` §§ "023 …" / "024 …" / "025 …".

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

⚠ **That paragraph describes the `claims` schema ONLY. It is wrong for
`collections`.** Measured 2026-08-05: every live `collections` relation is
`relowner = postgres`, so a `SET ROLE claims_admin` there *downgrades* the
applying role from owner to non-owner and fails `42501: must be owner of table …`.
It cost two failed applies on 0084/0085. In the `collections` plane write the
plain statement with **no `SET ROLE`**, and own SECURITY DEFINER functions as
`postgres` (a definer runs as its OWNER, so a `claims_admin`-owned definer cannot
write a postgres-owned table).

## Grants for cron writers — check before you read

A cron that adds a read of a NEW `collections.*` table must also check that its
writer role can read it. `cmd_rollup_writer`'s grants are per-table and were
**not** blanket-granted across the schema. 0089 exists because the census sync
started reading `collections.facilities` without one: the read raised 42501, a
fail-soft `catch` absorbed it, and the conformance alarm reported `23 of 23` on
every run for weeks over data that was completely fine.

```sql
select has_table_privilege('cmd_rollup_writer', 'collections.<table>', 'SELECT');
```

⚠ **A GRANT IS ONLY HALF THE GATE, AND `has_table_privilege` ONLY ANSWERS THAT
HALF.** 0089 granted the SELECT and the alarm still read 23 of 23, because
`collections.facilities` also has **RLS enabled** and `cmd_rollup_writer` matched
no policy. Under RLS a role with no applicable policy sees an **empty table — not
an error**. So the grant satisfied the privilege check and RLS silently filtered
every row away. 0090 added the policy. Check BOTH:

```sql
-- gate 1: the GRANT
select has_table_privilege('cmd_rollup_writer','collections.<table>','SELECT');
-- gate 2: RLS — is it on, and is there a policy for this role?
select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='collections' and c.relname='<table>';
select policyname, roles, cmd from pg_policies
 where schemaname='collections' and tablename='<table>';
```

⚠⚠ **YOU CANNOT VERIFY THIS AS `postgres`.** `postgres` has `rolbypassrls = true`
(measured), so it sees every row regardless of policy — checking a per-role
visibility problem from a role that bypasses RLS cannot detect it, by
construction. The Supabase MCP connects as `postgres`, so every MCP query is
blind to this class. Verify by running the actual job with the actual role's
credential, or read `pg_policies` directly.

And in the code: **never let a fail-soft catch absorb a 42501**, and **treat
"zero rows for a non-empty ask" as a misconfiguration, not a data state.** A
permission error cannot succeed on retry, so absorbing it converts an outage into
permanently wrong output — and an RLS-filtered read raises nothing at all, so the
row count is the only signal it leaves. Degrade on transient codes; rethrow on
42501; rethrow on an all-rows-missing result (see `CensusVisibilityError` in
`src/collections/qualifyCensusSync.ts`).

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
`app/lib/qualify/contract.ts` and `veris-data-notes.md`.
