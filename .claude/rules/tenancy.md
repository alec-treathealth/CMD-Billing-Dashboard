---
paths:
  - "src/veris/**"
  - "src/tenants.ts"
  - "src/agent/veris_agent.ts"
  - "src/brain3/**"
  - "src/ingest/**"
  - "app/lib/views.ts"
  - "app/lib/veris/**"
  - "src/collections/entityScope.ts"
---

# Tenancy

Exactly **two** data-bearing tenants in `core.business_entity`, seeded verbatim
from `src/tenants.ts` with canonical UUIDs that are **never re-minted** (BXR's is
already live in production data):

| Tenant | CMD account | Customers |
|---|---|---|
| BXR Consulting | 475729 | 15 |
| Indigo Consulting | 474623 | 32 |

Plus one **derived** surface named "Treat Health" / Consolidated: the read-only
aggregation of both, **super-admins only**. Hard guard: Consolidated is **not a
tenant**. It gets no `business_entity_id`, no row is ever tagged to it, and it
must never become a `core.business_entity` row. A session proposing a Treat
Health entity row is re-opening the ADR and must stop and ask.

The tenant key is the **6-digit CMD account** number. The 8-digit CMD *customer*
numbers are facilities within an account.

## The GUC discipline

Tenant scoping is the GUC `app.business_entity_id`, set **transaction-locally**
(`set_config(..., true)`) and read as
`current_setting('app.business_entity_id')::uuid` in every RLS policy. The GUC
name is a fixed literal; only the value is a bound param.

All tenant-scoped writes go through **`src/veris/withTenant.ts`** — one client,
one transaction. Rules the type signature cannot enforce:

- **Never call `pool.query()` inside the callback.** Each `pool.query()` can land
  on a different pooled connection, escaping the transaction and its GUC. Query
  only through the client the callback receives.
- **No network calls inside the callback** (Anthropic, `fetch`, …). A transaction
  must never be held open across an LLM or tool turn: one `withTenant` per query
  batch, never one per agent loop.
- Session-scoped `set_config(..., false)` is retired drift. Don't reintroduce it.

Malformed tenant ids are rejected **before** a connection is taken.

## Reads fail closed

Collections reads take an explicit `entityIds`, derived server-side from the
RBAC-clamped view (`viewToEntityIds` in `app/lib/views.ts` is the one place the
view→entity decision lives). `assertEntityScope()` (`src/collections/entityScope.ts`)
throws on an empty or malformed scope rather than reading — an empty scope must
never silently return every tenant's rows.

## Reference data is global

`ref.*` is RLS-gated **read-all**: all 13 tables have RLS enabled with
`FOR SELECT USING(true)`. X12/CMS/NPPES/payer reference data is global and must
**never** be tenant-scoped.

## Current posture

The `collections.*` plane **is** multi-tenant (per-row `business_entity_id` +
tenant RLS + writer GUC + reader scoping, migrations 0030–0033) and Indigo is
live. The older "collections is single-tenant, BXR-only" guardrail in the
archived context file is **satisfied and closed** — do not re-apply it.

The Veris **claims** plane (`staging.*`, brains 1/2/3) is **paused, not
abandoned**: brains stay off, its claims-facing UI is down. `staging.*`/`ref.*`/
`core.*` are owned by `claims_admin`; `claims_reader` has RLS-scoped SELECT.

Before onboarding a third tenant, revisit any cross-tenant matview: a matview
cannot carry RLS, so a `claims_reader` SELECT grant exposes every tenant's rows.

`docs/veris-data-notes.md` is the live ledger for this plane and **wins** over
any other doc when they conflict.
