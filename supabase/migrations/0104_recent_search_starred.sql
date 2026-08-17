-- 0104 — starred saved searches + card metadata on claims.qualify_recent_search (Payer Intel v1)
--
-- WHY: the /payer-intel tab (2026-08-17 build) shows "Starred" above "Recent" and persists the
--      star per user. History is per-user already (0097: app_user_id FK), so the ruled shape is a
--      column on the existing table, not a separate stars table. Two card-metadata columns ride
--      along so the saved-search card can say "Employer · no payer resolved" without widening the
--      0097 facet allowlist: entity_type is a CLOSED enum of search-entity kinds and resolved is a
--      boolean — neither can carry an identifier.
-- PHI DISCIPLINE: nothing new is storable. The 0097 compliance contract (payer_label ≤120 ·
--      prefix_echo ≤3 [A-Z0-9] · plan_class ≤40 — facets only, terms never) is UNCHANGED. The
--      mockup's group-number history card is deliberately NOT supported in v1: storing a group #
--      (or its token) in history would widen the allowlist and needs its own ruling. entity_type
--      may say 'group'; the number itself is not kept.
-- OWNERSHIP: claims plane — objects born owned via `set role claims_admin` (the 0097 APPLY PATH,
--      NOT the collections no-SET-ROLE rule, and NOT the 0046 grant/revoke dance that strips the
--      standing operator grant).
-- IDEMPOTENT: add column IF NOT EXISTS; CREATE OR REPLACE on every function; DROP POLICY-free
--      (no policy changes); grants re-applied unconditionally. Re-running converges.
-- DEPENDENCY: 0097 (claims.qualify_recent_search + definers) applied live 2026-08-10.
-- Rollback: 0104_recent_search_starred_rollback.sql
--
-- ⚠ BEHAVIOUR CHANGES TO 0097 DEFINERS (both deliberate, both invisible until a row is starred):
--   1. record_qualify_recent_search's 20-row prune now targets ONLY unstarred rows — a starred
--      search must never age out; the starred surface is bounded by its own cap instead (12).
--   2. clear_qualify_recent_searches now deletes ONLY unstarred rows — "Clear history" clears the
--      Recent section, not the Starred one (they are separate surfaces in the UI).

set role claims_admin;

-- ── 1. Columns ────────────────────────────────────────────────────────────────────────────────────
alter table claims.qualify_recent_search
  add column if not exists starred boolean not null default false;
alter table claims.qualify_recent_search
  add column if not exists entity_type text null;
alter table claims.qualify_recent_search
  add column if not exists resolved boolean null;

-- Closed vocabulary; add-if-absent so re-running converges (42710 otherwise).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'qualify_recent_entity_type_ck'
       and conrelid = 'claims.qualify_recent_search'::regclass
  ) then
    alter table claims.qualify_recent_search
      add constraint qualify_recent_entity_type_ck
      check (entity_type is null or entity_type in
        ('prefix','payer','employer','funding','group','facility','individual'));
  end if;
end
$$;

-- No new index: per-user row count is bounded (≤20 unstarred + ≤12 starred) and every read goes
-- through qualify_recent_user_time_idx (app_user_id, searched_at desc); a partial starred index
-- would never win a plan at 32 rows.

-- ── 2. Star toggle definer ────────────────────────────────────────────────────────────────────────
-- Scoped by (app_user_id, id) — the WHERE is the authorization, same as delete_qualify_watcher.
-- Starring is capped at 12 per user (applies to the false→true transition only). Returns whether a
-- row was updated so the action layer can distinguish "not yours / gone" from success.
create or replace function claims.set_qualify_search_starred(
  p_user    uuid,
  p_id      bigint,
  p_starred boolean
) returns boolean
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_updated int;
begin
  if p_user is null or p_id is null or p_starred is null then
    raise exception 'set_qualify_search_starred: user, id and starred required' using errcode = 'check_violation';
  end if;

  if p_starred and (
    select count(*) from claims.qualify_recent_search
     where app_user_id = p_user and starred
  ) >= 12 then
    raise exception 'set_qualify_search_starred: starred limit reached (12)' using errcode = 'check_violation';
  end if;

  update claims.qualify_recent_search
     set starred = p_starred
   where app_user_id = p_user and id = p_id;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ── 3. Recorder: new 6-param overload; 4-param original delegates (Qualify's caller unchanged) ────
create or replace function claims.record_qualify_recent_search(
  p_user     uuid,
  p_payer    text,
  p_echo     text,
  p_plan     text,
  p_entity   text,
  p_resolved boolean
) returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null then
    raise exception 'record_qualify_recent_search: user required' using errcode = 'check_violation';
  end if;
  if p_echo is not null and p_echo !~ '^[A-Z0-9]{1,3}$' then
    raise exception 'record_qualify_recent_search: echo must be <=3 chars [A-Z0-9]' using errcode = 'check_violation';
  end if;
  if p_payer is not null and char_length(p_payer) not between 1 and 120 then
    raise exception 'record_qualify_recent_search: invalid payer label' using errcode = 'check_violation';
  end if;
  if p_plan is not null and char_length(p_plan) not between 1 and 40 then
    raise exception 'record_qualify_recent_search: invalid plan class' using errcode = 'check_violation';
  end if;
  if p_entity is not null and p_entity not in
     ('prefix','payer','employer','funding','group','facility','individual') then
    raise exception 'record_qualify_recent_search: invalid entity type' using errcode = 'check_violation';
  end if;

  insert into claims.qualify_recent_search (app_user_id, payer_label, prefix_echo, plan_class, entity_type, resolved)
  values (p_user, p_payer, p_echo, p_plan, p_entity, p_resolved);

  -- Prune the caller's UNSTARRED history past 20. Starred rows are exempt by design (change #1
  -- in the header) — they are bounded separately by the 12-star cap in set_qualify_search_starred.
  delete from claims.qualify_recent_search
   where app_user_id = p_user
     and not starred
     and id not in (
       select id from claims.qualify_recent_search
        where app_user_id = p_user
          and not starred
        order by searched_at desc, id desc
        limit 20
     );
end;
$$;

-- The 0097 4-param signature survives as a delegate so existing Qualify call sites keep working.
create or replace function claims.record_qualify_recent_search(
  p_user  uuid,
  p_payer text,
  p_echo  text,
  p_plan  text
) returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  perform claims.record_qualify_recent_search(p_user, p_payer, p_echo, p_plan, null::text, null::boolean);
end;
$$;

-- ── 4. Clear history keeps starred rows (change #2 in the header) ─────────────────────────────────
create or replace function claims.clear_qualify_recent_searches(p_user uuid)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null then
    raise exception 'clear_qualify_recent_searches: user required' using errcode = 'check_violation';
  end if;
  delete from claims.qualify_recent_search where app_user_id = p_user and not starred;
end;
$$;

-- ── 5. Ownership + grants (0097 shape: EXECUTE to claims_reader only) ─────────────────────────────
alter function claims.set_qualify_search_starred(uuid, bigint, boolean)                          owner to claims_admin;
alter function claims.record_qualify_recent_search(uuid, text, text, text, text, boolean)        owner to claims_admin;
alter function claims.record_qualify_recent_search(uuid, text, text, text)                       owner to claims_admin;
alter function claims.clear_qualify_recent_searches(uuid)                                        owner to claims_admin;

revoke execute on function claims.set_qualify_search_starred(uuid, bigint, boolean) from public, anon, authenticated;
grant  execute on function claims.set_qualify_search_starred(uuid, bigint, boolean) to claims_reader;
revoke execute on function claims.record_qualify_recent_search(uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant  execute on function claims.record_qualify_recent_search(uuid, text, text, text, text, boolean) to claims_reader;
revoke execute on function claims.record_qualify_recent_search(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function claims.record_qualify_recent_search(uuid, text, text, text) to claims_reader;
revoke execute on function claims.clear_qualify_recent_searches(uuid) from public, anon, authenticated;
grant  execute on function claims.clear_qualify_recent_searches(uuid) to claims_reader;

reset role;

-- ── 6. Verification (run manually after apply) ────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where table_schema='claims' and table_name='qualify_recent_search'
--    and column_name in ('starred','entity_type','resolved');           -- expect 3 rows
-- select has_function_privilege('claims_reader',
--   'claims.set_qualify_search_starred(uuid,bigint,boolean)','execute'); -- expect true
-- select has_function_privilege('anon',
--   'claims.set_qualify_search_starred(uuid,bigint,boolean)','execute'); -- expect false
-- select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='claims' and p.proname='record_qualify_recent_search'; -- expect 2 (overloads)
-- Exercise: star a row twice (idempotent), star a 13th (raises check_violation), record 21 unstarred
-- searches with one starred row present (starred row survives the prune), clear (starred survives).
