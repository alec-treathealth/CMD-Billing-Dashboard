-- 036 ROLLBACK — restore the 035 body of ref.rule_payer_alias (no rowcount assertion).
--
-- ⚠️ READ THIS BEFORE RUNNING. THIS ROLLBACK REINSTATES A KNOWN DEFECT.
--
-- 036 exists because 035's function writes ref.payer_alias_ruling_audit unconditionally after its
-- UPDATE, with no rowcount check between them. Running this file puts that back: an UPDATE that
-- matches zero rows will once again produce an audit row, return a ruling_id, and report success
-- while the crosswalk is unchanged.
--
-- That state is reachable because the SELECT and the UPDATE are governed by different RLS policies
-- (payer_alias_map_read_all, `using (true)` to PUBLIC, vs payer_alias_map_ruling_update, to
-- claims_admin). It does not fire while claims_admin owns the table and relforcerowsecurity is false
-- — but that is exactly the assumption 036 was written to stop depending on.
--
-- THERE IS ALMOST NEVER A GOOD REASON TO RUN THIS. The assertion cannot cause a false rejection on a
-- correct system: the UPDATE targets the full primary key (vocabulary, alias_norm) plus needs_review,
-- on a row already locked FOR UPDATE in the same transaction, so exactly one row is the only correct
-- outcome. If the assertion IS firing, the database is telling you the write is not landing — the
-- fix is to find out why, not to silence the messenger.
--
-- Rulings already made are untouched by this file, in either direction. It replaces a function; it
-- does not read or write ref.payer_alias_map or ref.payer_alias_ruling_audit.
--
-- Apply as: postgres -> set role claims_admin (the same path 036 used).

set role claims_admin;

create or replace function ref.rule_payer_alias(
  p_vocabulary         text,
  p_alias_norm         text,
  p_action             text,
  p_relationship       text,
  p_canonical_payer_id text,
  p_review_note        text,
  p_ruled_by           text
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ref
as $fn$
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
    if p_relationship is null
       or p_relationship not in ('same_payer','carve_out','tpa','employer_self_funded',
                                 'program_label','unmapped') then
      raise exception 'rule_payer_alias: unknown relationship' using errcode = '22023';
    end if;

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

    if p_canonical_payer_id is not null then
      if not exists (select 1 from ref.payer_identity
                      where canonical_payer_id = p_canonical_payer_id and is_active) then
        raise exception 'rule_payer_alias: canonical payer is unknown or inactive'
          using errcode = '22023';
      end if;
    end if;

    v_new_rel  := p_relationship;
    v_new_can  := p_canonical_payer_id;
    v_new_prov := 'human';
    v_new_note := case when p_review_note is null or btrim(p_review_note) = ''
                       then null else btrim(p_review_note) end;
    v_new_need := false;

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
  'transaction. EXECUTE is granted to claims_reader only.';

revoke all on function ref.rule_payer_alias(text, text, text, text, text, text, text) from public;
grant execute on function ref.rule_payer_alias(text, text, text, text, text, text, text)
  to claims_reader;

reset role;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- POST-ROLLBACK VERIFICATION
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- select pg_get_functiondef(p.oid) like '%get diagnostics%' as still_asserting
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'ref' and p.proname = 'rule_payer_alias';
-- -- expect: f   (the assertion is gone — which is the defect this rollback reinstates)
--
-- select pg_has_role('postgres','claims_admin','SET');   -- expect: t
