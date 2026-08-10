# Qualify Watchers — scoped-session handoff

**Status: SUPERSEDED same day (2026-08-10).** Alec directed the full Smoke build-out hours after
this was written; watchers are now BUILT on `feat/qualify-smoke-tokens-chips` — migration
`supabase/migrations/0096_qualify_watchers.sql` (AUTHORED, **NOT applied**; fail-soft session-only
mode until it is), core `app/lib/qualify/watchers.ts`, actions `watcher-actions.ts`, panels under
`app/components/qualify/shell/`. Three deltas from the design below, all deliberate:
  · kinds shipped as `'trend' | 'patient'` (a trend watcher's optional `subject_token` IS the
    prefix pin, so a separate `trend_prefix` kind was one enum arm too many);
  · the schema is the **claims plane** per 0046's own header (per-user UI state FKs to
    `claims.app_user`), not `collections.qualify_watcher` — §2's sketch had the right pattern and
    the wrong plane;
  · 0096 SHIPPED a retention answer §4 below left open: a 40-watcher-per-user cap
    (`claims.save_qualify_watcher`) and a 20-row recent-search history prune
    (`claims.record_qualify_recent_search`, self-pruning on every insert). It shipped **NO
    `last_seen_at` column** — §4's "a prune job has an axis if one is ever wanted" sentence
    describes a column that was never built; the cap and prune below need no such axis.
§1 (echo asymmetry) and §5's prohibitions remain live and correct. Of §4's two open questions, the
ERA-alert one is still open; the retention one is now ANSWERED by what shipped — see §4's corrected
paragraph. Read the rest as design rationale, not as a to-do.

---

## What a watcher is

Three surfaces from `docs/mockups/qualify-smoke-NOTES.md` §5, in increasing compliance weight:

| Kind | Persists | PHI posture |
|---|---|---|
| **Trendwatcher** | payer label + alpha prefix + alert threshold | non-PHI |
| **Patient watcher** | a keyed-HMAC blind-index **token** + a masked display echo | PHI-adjacent |
| **Recent searches** | non-PHI facets only (payer · prefix echo · plan class · timestamp) | see §4 — unresolved |

---

## 1. The design finding that changes the schema

The notes specify that a patient watcher stores "the keyed-HMAC blind-index TOKEN + a masked display
echo (`GGS •••• 8841`), never the raw member ID." That is right for **member-ID** watchers and
**wrong for prefix** watchers, and the difference is worth encoding rather than storing an echo
column for both.

`src/collections/prefixLabel.ts` (shipped, ratified 2026-08-09) resolves an alpha-prefix token back
to its readable prefix **in-process, with no stored echo**: the domain is 3 characters over
`[A-Z0-9]` = 46,656 values, so the key holder computes the whole token→prefix map once per warm
process. A member-ID token has no such small domain and is genuinely irreversible.

So:

- **prefix watcher** — store the token alone. The label resolves at read time. A stored echo would
  be redundant data that can drift from the resolver.
- **member watcher** — the echo column is load-bearing, because nothing can reconstruct it.

That asymmetry is the reason `display_echo` below is nullable with a CHECK rather than NOT NULL:
null is correct and expected for the prefix kind, and a blanket NOT NULL would force a synthetic
echo for rows that need none — the same shape of mistake as back-filling `reviewed_by` on the 695
pre-029 `ref.payer_alias_map` rows.

## 2. Migration 0096 — sketch

Plain transactional DDL (no `CREATE INDEX CONCURRENTLY`), so `apply_migration` is fine — the
0081/0092 autocommit discipline does not apply.

⚠ **Do NOT add `SET ROLE claims_admin`.** Ownership in the `collections` plane is `postgres`; a
`SET ROLE` there *downgrades* the applying role and fails `42501: must be owner of table`. 0084 and
0085 both hit this. Own any SECURITY DEFINER here as `postgres` — a definer runs as its OWNER, and
a `claims_admin`-owned definer cannot write a `postgres`-owned table.

```sql
create table if not exists collections.qualify_watcher (
  id            bigint generated always as identity primary key,
  user_id       uuid        not null,             -- auth.users.id; the RLS axis
  kind          text        not null check (kind in ('trend_payer','trend_prefix','member')),
  -- The blind index. NEVER a raw member id, and never an alpha prefix in cleartext for the
  -- member kind. Same token the search mints (src/collections/blindIndex.ts).
  subject_token text,
  payer_key     text,                             -- trend_payer only
  -- Masked display echo. NULL for prefix/payer kinds (prefixLabel.ts resolves those) and
  -- REQUIRED for 'member', which nothing can reconstruct. See §1.
  display_echo  text        check (display_echo is null or length(display_echo) <= 12),
  threshold_pts int         check (threshold_pts is null or threshold_pts between 1 and 100),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  constraint qualify_watcher_member_needs_echo
    check (kind <> 'member' or (subject_token is not null and display_echo is not null)),
  constraint qualify_watcher_payer_needs_key
    check (kind <> 'trend_payer' or payer_key is not null)
);

alter table collections.qualify_watcher enable row level security;
```

**Grants + policies — the two are SEPARATE gates and only the GRANT errors.** A missing policy is a
silent empty result, and MCP connects as `postgres` (`rolbypassrls`), so RLS is invisible there:
verify as the actual app role, not as `postgres`. Model the policy set on 0091
(`qualify_facility_outcomes`), including **no DELETE for the writer** unless un-watching is required
— and it is, so this table is the one place a narrow DELETE is justified. Scope every policy to
`user_id = auth.uid()`.

Check the writer's grant before any cron reads this table: `has_table_privilege(...)`. The 0089
lesson — a fail-soft catch turned a 42501 into permanently wrong data (`conformance_gap_boards: 23
of 23` on every run) rather than a visible failure.

## 3. Write path

The app reads as `claims_reader` and writes as a narrow writer role. A watcher write is a
user-initiated write from a read-path session, which is exactly the shape `record_qualify_prefix_echo`
solved in 0093: a `security definer` owned by `postgres`, `EXECUTE` revoked from `public` and granted
to `claims_reader`, with input validation inside. Copy that pattern rather than widening
`claims_reader`'s table grants.

Validate inside the definer (0093 exercised its validation both ways at apply — four malformed calls
wrote nothing, one well-formed call upserted, test row deleted; do the same here).

## 4. Open — needs a ruling, do not guess

- **Recent searches.** The notes flag this: search terms are unrecoverable from
  `claims.access_audit` **by design**. Persisting them is an audit-policy decision, not merely a
  feature — it creates a durable per-user record of who looked up whom. Needs Alec, not a schema.
- **Patient-watcher alerts** ("a new ERA posted"). Feasible by joining era-835 output against
  watcher tokens through the same blind index, but it is a second scoped session: it makes a
  background job that reads PHI-adjacent state on a schedule.
- **Retention — ANSWERED by 0096, not open.** Watchers are capped at 40 per user, enforced in
  `claims.save_qualify_watcher` (checked against existing rows before an INSERT only, so hitting the
  cap still permits editing an existing watcher's threshold — see the definer's header). Recent
  searches self-prune to the newest 20 rows per user inside `claims.record_qualify_recent_search`,
  so no separate cron and no app code owns that retention. There is no `last_seen_at` column on
  either table — this paragraph previously proposed one as a future prune axis; 0096 shipped the
  prune without it.
- **Cross-tenant.** Every other `collections` surface carries a tenant scope. Watchers are
  per-USER and the Qualify surface is already cross-tenant for super_admin (by design — see the
  QA-pass ruling; do not re-flag it). Decide explicitly whether a watcher is user-scoped only or
  user × tenant, because retrofitting a tenant axis onto rows that already exist is the expensive
  direction.

## 5. What NOT to do

- Do not store a raw member ID, an employer name, or any free text a rep typed. `employer_norm`
  already has an open question about reaching a URL while `phi.ts` calls `employer_name` PHI.
- Do not put a watcher subject in a URL or query string — the v3 flow deliberately moved the search
  term into a POST body for exactly this reason (`app/app/qualify/page.tsx`'s "no searchParams" note).
- Do not add a free-text "label this watcher" field without a ruling. It is the same hole Phase 2's
  slot grammar closed on the AI surface: a text box on a PHI surface eventually receives a member ID.
