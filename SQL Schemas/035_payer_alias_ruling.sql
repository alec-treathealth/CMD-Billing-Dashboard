-- 035 — ref.payer_alias_ruling_audit + ref.rule_payer_alias: the write path for /admin/payer-aliases
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 029 made confirmation ATTRIBUTED — `needs_review = false` now requires `reviewed_by` and
-- `reviewed_at`. It did not provide anything that can actually perform an attributed confirmation.
-- Today the only route is a hand-written UPDATE as a superuser, which is precisely the unattributed,
-- unreviewable act 029 exists to stop. 990 rows are waiting on it.
--
-- This migration is that route, and nothing else:
--
--   · ref.payer_alias_ruling_audit — APPEND-ONLY history of every ruling, capturing the state BEFORE
--     and AFTER. `ref.payer_alias_map` holds only CURRENT state, last-write-wins: re-rule a row from
--     same_payer→pi_cigna to carve_out→pi_optum and the first ruling is gone with no record it ever
--     existed. For a table whose entire purpose is attributed truth, that is not acceptable, and it
--     is why an existing column cannot serve — reviewed_by/reviewed_at answer "who ruled this LAST",
--     never "what did it say before, and who changed it".
--
--   · ref.rule_payer_alias(...) — the ONE write. SECURITY DEFINER so `claims_reader` (the app's only
--     role) can execute it without ever holding UPDATE on the crosswalk itself.
--
--   · an UPDATE policy on ref.payer_alias_map — defence in depth; see THE RLS QUESTION below.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE RLS QUESTION — MEASURED, AND THE ANSWER IS NOT THE ONE 0101/0102 WOULD SUGGEST
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- This repo has been bitten three times by a GRANT that was inert because RLS had no matching policy
-- (0089's swallowed 42501; 0101's UPDATE that matched zero rows and raised nothing; the
-- patient_name_bidx backfill that has silently written nothing since June). So the question was asked
-- BEFORE authoring rather than discovered at apply. Measured live 2026-09-06:
--
--     relation                     owner          rls_enabled  rls_forced
--     ---------------------------  -------------  -----------  ----------
--     ref.payer_alias_map          claims_admin   t            f
--     ref.payer_identity           claims_admin   t            f
--     collections.cmd_explorer_rows  postgres     t            f     <- the 0101/0102 case
--
--     claims_admin rolbypassrls = false
--
-- A table OWNER bypasses row security unless the table carries FORCE ROW LEVEL SECURITY. This definer
-- is owned by claims_admin, which OWNS ref.payer_alias_map, and force is off — so the UPDATE below
-- reaches its rows on ownership, not on a policy. That is the OPPOSITE of the 0101/0102 situation,
-- where the writer (cmd_rollup_writer) was a NON-OWNER of a postgres-owned table and the missing
-- policy was fatal. `rolbypassrls = false` alone does not settle it; ownership does.
--
-- The UPDATE policy still ships (ruled 2026-09-05). It is honestly labelled: DEFENCE IN DEPTH, not
-- load-bearing. It costs nothing, and it is what stops a later `ALTER TABLE ... FORCE ROW LEVEL
-- SECURITY`, or a change of the definer's owner, from converting this write path into a silent no-op
-- of exactly the class listed above.
--
-- ⚠️ APPLY-TIME VERIFICATION IS BY EXECUTION, NOT BY has_table_privilege. See section (c) below. A
-- privilege that reads as granted and matches zero rows is the failure mode this whole comment is
-- about; only an UPDATE that reports a row count can distinguish them. 0106 learned this the hard
-- way — an INSERT ... ON CONFLICT was asserted not to need SELECT, and it did.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- PLANE, NUMBER, OWNERSHIP
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- VERIS plane (`SQL Schemas/`), because the plane is determined by SCHEMA, not by consumer: both new
-- objects live in `ref`, which CLAUDE.md maps to this directory. That a product surface (/admin) is
-- the caller does not move it — putting a ref.* object in supabase/migrations/ would split one
-- table's history across two directories.
--
-- 035 re-derived 2026-09-06 immediately before authoring, per .claude/rules/sql-migrations.md and the
-- 0096 collision: live ledger max Veris = 034 (`034_drop_expected_payment_manual_live_idx`,
-- 20260810084730); `origin/main` @ea5508b max file = 034; a set-difference of every remote branch
-- against main returned NO branch-only Veris .sql; no untracked .sql in either worktree.
--
-- OWNERSHIP: `set role claims_admin` — the 026/029 pattern for this schema. claims_admin has CREATE
-- on schema ref (verified), owns ref.payer_alias_map (so it can add a policy to it), and holds UPDATE
-- on it. ⚠️ This is the CLAIMS-plane pattern and it is correct HERE; do not copy it to a
-- `collections` migration, where objects are owned by postgres and `set role claims_admin` DOWNGRADES
-- the applier to non-owner and fails 42501.
--
-- ⚠️ THIS IS THE FIRST SECURITY DEFINER IN SCHEMA `ref` (verified: pg_proc has none). It therefore
-- sets the precedent — search_path is pinned (the 0100 audit finding), EXECUTE is revoked from public
-- before being granted, and the function is owned by the role that owns the table it writes.
--
-- ⚠️ NO `revoke claims_admin from postgres` TAIL. 0046's shape was copied into 0097's first draft and
-- would have stripped the standing operator grant, 42501-ing every later migration. Section (f)
-- asserts pg_has_role('postgres','claims_admin','SET') is still TRUE after apply.
--
-- IDEMPOTENT: create table / create index IF NOT EXISTS; policy and function are dropped-if-exists
-- then recreated. Re-running is a no-op.
--
-- ROLLBACK: 035_payer_alias_ruling_rollback.sql
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE AUDIT TABLE — append-only, and deliberately NOT foreign-keyed
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- No FK to ref.payer_alias_map(vocabulary, alias_norm) ON PURPOSE. An audit row is an immutable
-- historical statement about what happened; coupling it to current state would let a future change to
-- the crosswalk block or cascade into the record of a ruling that genuinely occurred. The
-- coding.code_decision_audit precedent is the same shape.
create table if not exists ref.payer_alias_ruling_audit (
  ruling_id                bigint generated always as identity primary key,

  -- WHICH row was ruled (the crosswalk's PK, recorded not referenced).
  vocabulary               text        not null,
  alias_norm               text        not null,
  action                   text        not null,

  -- STATE BEFORE. This is the half that ref.payer_alias_map cannot keep.
  prior_relationship       text        not null,
  prior_canonical_payer_id text,
  prior_needs_review       boolean     not null,
  prior_provenance         text        not null,
  prior_confidence         numeric,
  prior_review_note        text,

  -- STATE AFTER.
  new_relationship         text        not null,
  new_canonical_payer_id   text,
  new_needs_review         boolean     not null,
  new_provenance           text        not null,
  new_review_note          text,

  -- WHO and WHEN. Never nullable — an unattributed audit row would defeat the point of 029.
  ruled_by                 text        not null,
  ruled_at                 timestamptz not null default now(),

  constraint payer_alias_ruling_audit_action
    check (action in ('confirm', 'defer')),
  constraint payer_alias_ruling_audit_ruled_by_len
    check (char_length(ruled_by) between 3 and 200),
  constraint payer_alias_ruling_audit_alias_len
    check (char_length(alias_norm) between 1 and 200),
  -- A 'confirm' must LEAVE the row ruled; a 'defer' must leave it unruled. This is the audit table's
  -- own restatement of the invariant, so a malformed write is caught here as well as in the function.
  constraint payer_alias_ruling_audit_action_outcome
    check ((action = 'confirm' and new_needs_review = false)
        or (action = 'defer'   and new_needs_review = true))
);

comment on table ref.payer_alias_ruling_audit is
  'Append-only history of payer-alias rulings made through ref.rule_payer_alias. Captures state '
  'BEFORE and AFTER, because ref.payer_alias_map holds only current state (last-write-wins). '
  'INSERT is reachable ONLY through the definer — no role holds an insert/update/delete grant.';

comment on column ref.payer_alias_ruling_audit.prior_provenance is
  'The provenance the row carried before the ruling. A confirm flips provenance to ''human'' on the '
  'live row (the human now owns it); this column is where the machine''s proposal method survives.';

create index if not exists payer_alias_ruling_audit_alias_idx
  on ref.payer_alias_ruling_audit (vocabulary, alias_norm, ruled_at desc);
create index if not exists payer_alias_ruling_audit_recent_idx
  on ref.payer_alias_ruling_audit (ruled_at desc);

alter table ref.payer_alias_ruling_audit enable row level security;

drop policy if exists payer_alias_ruling_audit_read_all on ref.payer_alias_ruling_audit;
create policy payer_alias_ruling_audit_read_all on ref.payer_alias_ruling_audit
  for select using (true);

-- READ-ONLY TO EVERY ROLE. No insert/update/delete grant to anyone, ever — the definer writes as its
-- owner (claims_admin, which owns this table), so it needs no grant of its own.
grant select on ref.payer_alias_ruling_audit to claims_reader;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. THE UPDATE POLICY — defence in depth (see THE RLS QUESTION above)
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠️ `with check (true)` IS REQUIRED AND IS NOT SLOPPINESS. When WITH CHECK is omitted, Postgres
-- reuses the USING expression for the post-update row — which here would be `needs_review`, rejecting
-- every confirmation (the whole point of which is to set needs_review = false). The scoping lives in
-- USING: only rows that are CURRENTLY unruled are visible to an UPDATE at all, so the 695 legacy
-- confirmed rows are structurally unreachable through this policy.
drop policy if exists payer_alias_map_ruling_update on ref.payer_alias_map;
create policy payer_alias_map_ruling_update on ref.payer_alias_map
  for update to claims_admin
  using (needs_review)
  with check (true);

-- The reasoning lives ON THE POLICY, not only in this file's header: `with check (true)` reads as
-- sloppy in isolation and the obvious "tightening" silently breaks every confirmation. A reader who
-- finds it in pg_policies must be able to see why without locating this migration.
comment on policy payer_alias_map_ruling_update on ref.payer_alias_map is
  'Defence in depth for ref.rule_payer_alias. Scoping is in USING: only rows that are CURRENTLY '
  'unruled are visible to an UPDATE, so the 695 legacy confirmed rows (029, permanently exempt) are '
  'structurally unreachable through this policy. '
  '⚠️ DO NOT "TIGHTEN" `with check (true)`. Omitting WITH CHECK makes Postgres reuse the USING '
  'expression for the POST-update row — here that is `needs_review`, which every confirmation sets '
  'to false, so the policy would reject every confirmation while permitting defers. The permissive '
  'WITH CHECK is deliberate and load-bearing. '
  'NOTE this policy is not what grants access today: claims_admin OWNS ref.payer_alias_map and '
  'relforcerowsecurity is false, so the definer reaches its rows on ownership. This exists so a '
  'later ALTER TABLE ... FORCE ROW LEVEL SECURITY, or a change of the definer''s owner, cannot turn '
  'the write path into a silent no-op (the 0089 / 0101 / patient_name_bidx failure class).';

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. THE DEFINER — the one write
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
drop function if exists ref.rule_payer_alias(text, text, text, text, text, text, text);

create function ref.rule_payer_alias(
  p_vocabulary         text,
  p_alias_norm         text,
  p_action             text,   -- 'confirm' | 'defer'
  p_relationship       text,   -- required for confirm; ignored for defer
  p_canonical_payer_id text,   -- required iff the relationship requires it
  p_review_note        text,   -- required for defer; optional for confirm
  p_ruled_by           text    -- the principal's email, from the server session — never client input
) returns bigint
language plpgsql
security definer
-- Pinned per the 0100 audit finding (P1-13): a definer without a fixed search_path can be steered
-- into a caller-controlled schema. pg_catalog first; `ref` for the two tables; no `public`.
set search_path = pg_catalog, ref
as $$
declare
  v_row      ref.payer_alias_map%rowtype;
  v_new_rel  text;
  v_new_can  text;
  v_new_note text;
  v_new_prov text;
  v_new_need boolean;
  v_id       bigint;
begin
  if p_action is null or p_action not in ('confirm', 'defer') then
    raise exception 'rule_payer_alias: action must be confirm or defer' using errcode = '22023';
  end if;
  if p_ruled_by is null or char_length(btrim(p_ruled_by)) < 3 then
    raise exception 'rule_payer_alias: ruled_by is required' using errcode = '22023';
  end if;

  -- ⚠️ THE GUARD LIVES HERE, IN THE WHERE CLAUSE — not only in the action layer. `and needs_review`
  -- is what makes "no bulk action may touch the 695 legacy confirmed rows" STRUCTURAL: an already-
  -- ruled row is not selected, so it cannot be re-ruled through this function even if every check
  -- above it were bypassed. FOR UPDATE serialises two reviewers racing on the same row.
  select * into v_row
    from ref.payer_alias_map
   where vocabulary = p_vocabulary
     and alias_norm = p_alias_norm
     and needs_review
   for update;

  if not found then
    raise exception 'rule_payer_alias: no unruled row for that alias' using errcode = 'P0002';
  end if;

  if p_action = 'defer' then
    -- A defer records what the reviewer LEARNED without establishing identity. needs_review stays
    -- true, and reviewed_by / reviewed_at stay NULL — deferring is not confirming, and stamping a
    -- reviewer here would manufacture the attribution 029 exists to protect.
    if p_review_note is null or char_length(btrim(p_review_note)) < 2 then
      raise exception 'rule_payer_alias: a defer requires a note' using errcode = '22023';
    end if;
    v_new_rel  := v_row.relationship;
    v_new_can  := v_row.canonical_payer_id;
    v_new_prov := v_row.provenance;
    v_new_note := btrim(p_review_note);
    v_new_need := true;

    update ref.payer_alias_map
       set review_note = v_new_note
     where vocabulary = p_vocabulary
       and alias_norm = p_alias_norm
       and needs_review;

  else
    -- CONFIRM. Every branch below restates a live CHECK so the failure is a named error rather than
    -- a bare 23514 surfacing from the constraint.
    if p_relationship is null
       or p_relationship not in ('same_payer','carve_out','tpa','employer_self_funded',
                                 'program_label','unmapped') then
      raise exception 'rule_payer_alias: unknown relationship' using errcode = '22023';
    end if;

    -- payer_alias_map_relationship_canonical, restated.
    if p_relationship in ('same_payer','carve_out','tpa','employer_self_funded') then
      if p_canonical_payer_id is null then
        raise exception 'rule_payer_alias: % requires a canonical payer', p_relationship
          using errcode = '22023';
      end if;
    else
      if p_canonical_payer_id is not null then
        raise exception 'rule_payer_alias: % must not carry a canonical payer', p_relationship
          using errcode = '22023';
      end if;
    end if;

    -- The canonical target must exist AND be live. Accepting a proposal onto a retired identity is
    -- how a crosswalk silently starts resolving to something nobody maintains.
    if p_canonical_payer_id is not null then
      if not exists (select 1 from ref.payer_identity
                      where canonical_payer_id = p_canonical_payer_id and is_active) then
        raise exception 'rule_payer_alias: canonical payer is unknown or inactive'
          using errcode = '22023';
      end if;
    end if;

    v_new_rel  := p_relationship;
    v_new_can  := p_canonical_payer_id;
    -- PROVENANCE FLIPS TO 'human' (ruled 2026-09-05). The row's authority is now a named person, not
    -- the proposer that generated the candidate. The machine's method is not lost — prior_provenance
    -- and prior_confidence on the audit row preserve it permanently.
    v_new_prov := 'human';
    v_new_note := case when p_review_note is null or btrim(p_review_note) = ''
                       then null else btrim(p_review_note) end;
    v_new_need := false;

    -- reviewed_by / reviewed_at are set on EVERY confirmation, never optionally: without both,
    -- payer_alias_map_confirmation_attributed (029) rejects the row outright.
    update ref.payer_alias_map
       set relationship       = v_new_rel,
           canonical_payer_id = v_new_can,
           provenance         = v_new_prov,
           review_note        = v_new_note,
           needs_review       = false,
           reviewed_by        = btrim(p_ruled_by),
           reviewed_at        = now()
     where vocabulary = p_vocabulary
       and alias_norm = p_alias_norm
       and needs_review;
  end if;

  -- The UPDATE and this INSERT are one statement-level transaction: the function body runs inside the
  -- caller's transaction, so a failure here rolls the ruling back with it. A ruling without its audit
  -- row cannot exist.
  insert into ref.payer_alias_ruling_audit (
    vocabulary, alias_norm, action,
    prior_relationship, prior_canonical_payer_id, prior_needs_review,
    prior_provenance, prior_confidence, prior_review_note,
    new_relationship, new_canonical_payer_id, new_needs_review,
    new_provenance, new_review_note,
    ruled_by
  ) values (
    p_vocabulary, p_alias_norm, p_action,
    v_row.relationship, v_row.canonical_payer_id, v_row.needs_review,
    v_row.provenance, v_row.confidence, v_row.review_note,
    v_new_rel, v_new_can, v_new_need,
    v_new_prov, v_new_note,
    btrim(p_ruled_by)
  )
  returning ruling_id into v_id;

  return v_id;
end;
$$;

comment on function ref.rule_payer_alias(text, text, text, text, text, text, text) is
  'The ONE write path for payer-alias rulings. SECURITY DEFINER owned by claims_admin; guarded on '
  'needs_review in its own WHERE clause so an already-ruled row (including the 695 legacy confirmed) '
  'can never be re-ruled through it. Updates the crosswalk and appends an audit row in one '
  'transaction. EXECUTE is granted to claims_reader only.';

-- REVOKE BEFORE GRANT — a function is EXECUTABLE BY PUBLIC by default, so creating it without this
-- line would hand the write path to every role in the cluster.
revoke all on function ref.rule_payer_alias(text, text, text, text, text, text, text) from public;
grant execute on function ref.rule_payer_alias(text, text, text, text, text, text, text)
  to claims_reader;

-- Supabase's `anon` is covered by the PUBLIC revoke above; revoked explicitly as well, guarded so
-- this file still applies on a cluster without the role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function ref.rule_payer_alias(text,text,text,text,text,text,text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function ref.rule_payer_alias(text,text,text,text,text,text,text) from authenticated';
  end if;
end $$;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — RUN AFTER APPLY. Privileges are proved by EXECUTING them, not by reading a catalog.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- (a) Objects exist, with the right owner and posture.
-- select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner,
--        p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'ref' and p.proname = 'rule_payer_alias';
-- -- expect: prosecdef = t, owner = claims_admin, proconfig = {search_path=pg_catalog, ref}
--
-- select relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner)
--   from pg_class where oid = 'ref.payer_alias_ruling_audit'::regclass;
-- -- expect: t, f, claims_admin
--
-- (b) EXECUTE is where it should be and nowhere else.
-- select has_function_privilege('claims_reader',
--          'ref.rule_payer_alias(text,text,text,text,text,text,text)', 'EXECUTE') as reader,
--        has_function_privilege('public',
--          'ref.rule_payer_alias(text,text,text,text,text,text,text)', 'EXECUTE') as pub,
--        has_function_privilege('anon',
--          'ref.rule_payer_alias(text,text,text,text,text,text,text)', 'EXECUTE') as anon;
-- -- expect: t, f, f
--
-- select has_table_privilege('claims_reader','ref.payer_alias_ruling_audit','SELECT') as sel,
--        has_table_privilege('claims_reader','ref.payer_alias_ruling_audit','INSERT') as ins,
--        has_table_privilege('claims_reader','ref.payer_alias_ruling_audit','DELETE') as del;
-- -- expect: t, f, f      (no role may write the audit except through the definer)
--
-- ⚠️ (c) THE ONE THAT MATTERS — DOES THE UPDATE ACTUALLY REACH A ROW?
-- A privilege that reads as granted and matches zero rows is this repo's recurring silent failure
-- (0089, 0101, patient_name_bidx). has_table_privilege CANNOT distinguish them. Execute and count.
-- Run inside an explicit transaction and ROLL BACK — production data is not a test fixture.
--
-- begin;
--   select ref.rule_payer_alias(
--            'claims_primary_payer',
--            (select alias_norm from ref.payer_alias_map
--              where vocabulary = 'claims_primary_payer' and needs_review
--              order by alias_norm limit 1),
--            'defer', null, null,
--            'APPLY VERIFICATION — rolled back, not a ruling',
--            'migration-035-verification'
--          ) as audit_row_id;
--   -- expect: a bigint. If this raises P0002 the guard found no unruled row — investigate, do not retry.
--
--   select count(*) as audit_rows_written from ref.payer_alias_ruling_audit;
--   -- expect: 1
--
--   select review_note from ref.payer_alias_map
--    where vocabulary = 'claims_primary_payer' and needs_review
--    order by alias_norm limit 1;
--   -- ⚠️ expect: 'APPLY VERIFICATION — rolled back, not a ruling'
--   -- IF THIS IS THE OLD VALUE, THE UPDATE MATCHED ZERO ROWS. **STOP. DO NOT EDIT AND RETRY AGAINST
--   -- PRODUCTION.** Roll back and report: it means the owner-bypass reasoning in THE RLS QUESTION is
--   -- wrong for this cluster and the policy is not covering it either.
-- rollback;
--
-- select count(*) from ref.payer_alias_ruling_audit;  -- expect: 0 after the rollback
--
-- (d) The 695 legacy confirmed rows are unreachable — the guard, exercised.
-- begin;
--   select ref.rule_payer_alias('vob_insurance_co', 'KAISER', 'confirm', 'same_payer',
--                               'pi_kaiser_permanente', null, 'migration-035-verification');
--   -- expect: ERROR P0002 'no unruled row for that alias'. KAISER is confirmed (and unattributed,
--   -- pre-029) — a legacy-shaped row must not be re-rulable through this path.
-- rollback;
--
-- (e) Input validation rejects both ways, and writes nothing.
-- begin;
--   select ref.rule_payer_alias('claims_primary_payer','ANY','confirm','same_payer',null,null,'x@y.z');
--   -- expect: ERROR 22023 — same_payer requires a canonical payer
-- rollback;
-- begin;
--   select ref.rule_payer_alias('claims_primary_payer','ANY','confirm','unmapped','pi_cigna',null,'x@y.z');
--   -- expect: ERROR 22023 — unmapped must not carry a canonical payer
-- rollback;
-- begin;
--   select ref.rule_payer_alias('claims_primary_payer','ANY','confirm','same_payer','pi_not_real',null,'x@y.z');
--   -- expect: ERROR 22023 — canonical payer is unknown or inactive
-- rollback;
-- select count(*) from ref.payer_alias_ruling_audit;  -- expect: 0
--
-- (f) The standing operator grant SURVIVED. 0097's first draft nearly stripped this.
-- select pg_has_role('postgres','claims_admin','SET');   -- expect: t
--
-- (g) 029's posture is untouched by this migration.
-- select count(*) from ref.payer_alias_map where not needs_review;                    -- expect: 695
-- select count(*) from ref.payer_alias_map where not needs_review and reviewed_by is null; -- expect: 695
-- select convalidated from pg_constraint
--  where conname = 'payer_alias_map_confirmation_attributed';                          -- expect: f
