-- 036 — ref.rule_payer_alias: assert the UPDATE touched exactly one row
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY — 035 COULD WRITE AN AUDIT ROW FOR A RULING THAT NEVER HAPPENED
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Found by adversarial review of 035 itself (2026-09-06), before any ruling had been made.
--
-- 035's function does this, in this order:
--
--   1. select ... from ref.payer_alias_map where ... and needs_review for update;
--   2. if not found then raise P0002;            <- the ONLY `found` check in the function
--   3. update ref.payer_alias_map set ... ;      <- defer branch, or confirm branch
--   4. insert into ref.payer_alias_ruling_audit ... returning ruling_id into v_id;
--   5. return v_id;
--
-- There is NO rowcount check between (3) and (4). Step 4 runs unconditionally once step 2 passed, so
-- if the UPDATE matches ZERO rows the audit row is still written, `ruling_id` is still returned, and
-- the caller is told the ruling succeeded. The crosswalk is unchanged and nothing raises.
--
-- ⚠️ THIS IS REACHABLE BY CONSTRUCTION, NOT HYPOTHETICAL, BECAUSE THE READ AND THE WRITE ARE
-- GOVERNED BY DIFFERENT RLS POLICIES:
--
--     statement                     policy                          scope
--     ----------------------------  ------------------------------  ----------------------------
--     select ... for update  (1)    payer_alias_map_read_all        for select using (true) TO PUBLIC
--     update                 (3)    payer_alias_map_ruling_update   for update TO claims_admin
--
-- The read policy is permissive to everyone; the update policy is the narrow one. So the moment RLS
-- actually applies to the definer's role — someone sets ALTER TABLE ... FORCE ROW LEVEL SECURITY, or
-- the definer's owner changes to a non-owner — step 1 still succeeds, `found` is still true, and step
-- 3 silently matches nothing. That is this repo's recurring silent-failure class (0089, 0101, and the
-- patient_name_bidx backfill that has written nothing since June), reproduced inside the one function
-- that was supposed to be immune to it.
--
-- It does NOT fire today: claims_admin owns ref.payer_alias_map and relforcerowsecurity is false, so
-- the owner bypasses row security and the UPDATE reaches its row. 035's apply verification proved
-- that by execution. This migration removes the dependence on that remaining true.
--
-- OTHER ROUTES TO THE SAME DIVERGENCE — MEASURED, NOT ASSUMED (2026-09-06):
--   · user triggers on ref.payer_alias_map / payer_identity / payer_alias_ruling_audit ....... 0
--     (12 internal FK-enforcement triggers exist on those tables, so the catalog query is not
--      returning an empty set because it is mis-written; a positive control found user triggers in
--      storage=4, collections=1, cron=1, realtime=1)
--   · rewrite rules on ref.payer_alias_map (a DO INSTEAD NOTHING would suppress it) ........... 0
-- Both are zero now, and a rowcount assertion catches all three routes without caring which.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE of ref.rule_payer_alias, adding after BOTH the defer UPDATE and the confirm
-- UPDATE:
--
--     get diagnostics v_touched = row_count;
--     if v_touched <> 1 then
--       raise exception 'rule_payer_alias: update affected % rows, expected 1', v_touched
--         using errcode = '25000';
--     end if;
--
-- `<> 1` rather than `= 0` on purpose: the target is the table's full primary key
-- (vocabulary, alias_norm), so >1 is impossible and asserting it costs nothing — a future change that
-- widened the predicate would be caught rather than silently mass-updating.
--
-- SQLSTATE 25000 is deliberately DISTINCT from the P0002 the row guard raises, so the two are
-- distinguishable in a log. P0002 means "that alias is not available to rule" and is an ordinary,
-- expected outcome (a race, a stale page). 25000 means "the row was there and the write did not land"
-- and is an operator-level fault that should never occur. The Server Action logs sqlstate on every
-- failure and maps anything other than P0002 to a generic user-facing message, which is the right
-- treatment: a misconfigured database is not something a reviewer can act on from a form.
--
-- Also corrects the comment above the audit INSERT. 035 said "A ruling without its audit row cannot
-- exist" — true, and stated in a way that reads as asserting the converse, which was NOT guarded. Now
-- that both directions hold, both are stated.
--
-- NOTHING ELSE CHANGES. Same signature, same owner (claims_admin), same pinned search_path, same
-- EXECUTE grants, same body logic. CREATE OR REPLACE preserves privileges; they are re-asserted below
-- anyway so this file describes a complete end state to anyone reading it alone.
--
-- OWNERSHIP: `set role claims_admin` — CREATE OR REPLACE requires ownership, and claims_admin owns
-- both the function and ref.payer_alias_map. This is the claims-plane pattern and is correct in
-- `ref`; do NOT copy it to a `collections` migration, where objects are postgres-owned and SET ROLE
-- downgrades the applier to non-owner (42501).
--
-- IDEMPOTENT: CREATE OR REPLACE; the grants are unconditional REVOKE/GRANT. Re-running is a no-op.
-- DEPENDENCY: 035 must be applied (this replaces the function it created).
-- PHI DISCIPLINE: unchanged. The function never interpolates alias_norm into an error message — the
--   new raise carries a ROW COUNT and nothing else, deliberately, because alias_norm can be an
--   employer name and an exception message reaches logs.
-- Rollback: 036_rule_payer_alias_rowcount_assert_rollback.sql (restores the 035 body verbatim).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

create or replace function ref.rule_payer_alias(
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
as $fn$
declare
  v_row      ref.payer_alias_map%rowtype;
  v_new_rel  text;
  v_new_can  text;
  v_new_note text;
  v_new_prov text;
  v_new_need boolean;
  v_touched  integer;
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
  --
  -- ⚠️ AND IT IS NOT SUFFICIENT ON ITS OWN. This SELECT is governed by payer_alias_map_read_all
  -- (`using (true)`, to PUBLIC) while the UPDATEs below are governed by payer_alias_map_ruling_update
  -- (to claims_admin). Finding a row here does NOT establish that the UPDATE will reach it. That is
  -- what the rowcount assertions after each UPDATE are for.
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

    -- ⚠️ 036: the write must be PROVEN, not presumed. Zero here means the row was visible to the
    -- SELECT and unreachable by the UPDATE — RLS divergence, a suppressing trigger, or a rewrite
    -- rule. Raising rolls back the whole call, so no audit row survives a ruling that did not land.
    get diagnostics v_touched = row_count;
    if v_touched <> 1 then
      raise exception 'rule_payer_alias: update affected % rows, expected 1', v_touched
        using errcode = '25000';
    end if;

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

    -- ⚠️ 036: same assertion on the branch that actually establishes payer identity. A confirm that
    -- reported success while leaving needs_review = true would put an attributed audit row on record
    -- for a ruling the crosswalk never received — the worst version of this failure, because the
    -- audit trail would then be evidence of something that did not happen.
    get diagnostics v_touched = row_count;
    if v_touched <> 1 then
      raise exception 'rule_payer_alias: update affected % rows, expected 1', v_touched
        using errcode = '25000';
    end if;
  end if;

  -- ── THE TWO DIRECTIONS, BOTH NOW GUARDED (036) ────────────────────────────────────────────────
  -- A RULING WITHOUT ITS AUDIT ROW cannot exist: this INSERT runs in the same transaction as the
  --   UPDATE above, so if it fails the ruling rolls back with it.
  -- AN AUDIT ROW WITHOUT ITS RULING cannot exist either, as of 036: the rowcount assertions above
  --   raise before control reaches this statement unless exactly one crosswalk row was written.
  -- 035 stated only the first and phrased it ("A ruling without its audit row cannot exist") in a way
  -- that invited the reader to assume the second. The second was not true then. It is now, and both
  -- are written down so neither has to be inferred.
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
$fn$;

comment on function ref.rule_payer_alias(text, text, text, text, text, text, text) is
  'The ONE write path for payer-alias rulings. SECURITY DEFINER owned by claims_admin; guarded on '
  'needs_review in its own WHERE clause so an already-ruled row (including the 695 legacy confirmed) '
  'can never be re-ruled through it. Updates the crosswalk and appends an audit row in one '
  'transaction, and since 036 ASSERTS the update affected exactly one row (SQLSTATE 25000) so an '
  'audit row can never outlive a ruling that did not land. EXECUTE is granted to claims_reader only.';

-- CREATE OR REPLACE preserves existing privileges; re-asserted so this file is a complete end state.
revoke all on function ref.rule_payer_alias(text, text, text, text, text, text, text) from public;
grant execute on function ref.rule_payer_alias(text, text, text, text, text, text, text)
  to claims_reader;

do $guard$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function ref.rule_payer_alias(text,text,text,text,text,text,text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function ref.rule_payer_alias(text,text,text,text,text,text,text) from authenticated';
  end if;
end $guard$;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — RUN AFTER APPLY. By EXECUTION, never by reading a catalog.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- (a) The function still has the right shape, owner and pin.
-- select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'ref' and p.proname = 'rule_payer_alias';
-- -- expect: t, claims_admin, {search_path=pg_catalog, ref}
--
-- (b) The assertion is actually in the installed body (not just in this file).
-- select pg_get_functiondef(p.oid) like '%get diagnostics v_touched = row_count%' as has_assertion,
--        (length(pg_get_functiondef(p.oid))
--         - length(replace(pg_get_functiondef(p.oid), 'get diagnostics', ''))) / 15 as assertion_count
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'ref' and p.proname = 'rule_payer_alias';
-- -- expect: t, 2      (one per UPDATE branch — a single one means a branch was missed)
--
-- (c) EXECUTE is unchanged by the replace.
-- select has_function_privilege('claims_reader',
--          'ref.rule_payer_alias(text,text,text,text,text,text,text)','EXECUTE') as reader,
--        has_function_privilege('public',
--          'ref.rule_payer_alias(text,text,text,text,text,text,text)','EXECUTE') as pub;
-- -- expect: t, f
--
-- ⚠️ (d) POSITIVE CONTROL — a well-formed CONFIRM must still succeed. An assertion that rejects
-- everything is not a fix, and this is the half that a "the raise fires" test cannot show. Run inside
-- a DO block terminated by RAISE so the rollback is forced by the exception rather than trusted to
-- the transport; production data is not a test fixture.
--
-- do $v$
-- declare a text; id bigint; nr boolean; rb text; pv text;
-- begin
--   select alias_norm into a from ref.payer_alias_map
--    where vocabulary='claims_primary_payer' and needs_review order by alias_norm limit 1;
--   id := ref.rule_payer_alias('claims_primary_payer', a, 'confirm', 'unmapped', null,
--                              'migration-036-verification', 'migration-036-verification');
--   select needs_review, reviewed_by, provenance into nr, rb, pv
--     from ref.payer_alias_map where vocabulary='claims_primary_payer' and alias_norm=a;
--   raise exception 'V036 || alias=% id=% needs_review=% reviewed_by=% prov=%', a, id, nr, rb, pv;
-- end $v$;
-- -- expect: id is a bigint; needs_review=f; reviewed_by=migration-036-verification; prov=human
-- -- A raise of 25000 here means the assertion is firing on a legitimate confirm — STOP, do not retry.
--
-- (e) The guard and the validators still reject. Same probes as 035 (d)/(e); all must still raise,
--     and ref.payer_alias_ruling_audit must be back to its pre-probe count afterwards.
--
-- (f) The standing operator grant survived the replace.
-- select pg_has_role('postgres','claims_admin','SET');   -- expect: t
--
-- (g) 029's posture untouched.
-- select count(*) from ref.payer_alias_map where not needs_review;                          -- 695
-- select count(*) from ref.payer_alias_map where not needs_review and reviewed_by is null;  -- 695
