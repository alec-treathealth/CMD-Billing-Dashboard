-- 0096 — Qualify watchers + recent searches: the smoke-shell board's two persistence surfaces.
--
-- WHY: the Smoke shell (docs/mockups/qualify-smoke-NOTES.md §5) persists three things per user:
--   · TRENDWATCHERS  — a payer (optionally pinned to one prefix token) the rep follows, with an
--     alert threshold in rating points. Sparkline data comes from the ALREADY-APPLIED 0093 daily
--     rating table at read time; nothing here duplicates it.
--   · PATIENT WATCHERS — a keyed-HMAC blind-index TOKEN plus a masked display echo
--     ('GGS •••• 8841'). THE RAW MEMBER ID IS NEVER STORED, and no column here is wide enough to
--     make storing it look reasonable.
--   · RECENT SEARCHES — non-PHI FACETS ONLY (payer label · ≤3-char prefix echo · plan class ·
--     timestamp). Search terms are unrecoverable from claims.access_audit BY DESIGN; persisting
--     facets was ruled by Alec 2026-08-10 ("save their history"), and the facet allowlist is the
--     compliance contract: a member-ID search degrades to its alpha prefix, so re-run re-resolves
--     the PREFIX and full-ID persistence remains exclusively the patient watcher's job (which
--     stores a token, not a term).
--
-- PHI DISCIPLINE: no raw identifier, no member ID, no group number, no employer name is storable
--   here. subject_token is a keyed-HMAC blind index (same class as the *_bidx columns, useless
--   without INDEX_HMAC_KEY); prefix_echo is capped at 3.
--   ⚠ display_echo's 13-char cap is a BACKSTOP, NOT the safety property, and the first draft of this
--   header got that wrong ("structurally too small for a full identifier"). It is false for short
--   identifiers: 'ABC1234' masks to 'ABC •••• 1234', which is 13 chars AND the whole id. The real
--   guarantee lives in maskedPatientEcho (src/collections/qualifyWatchers.ts), which counts HIDDEN
--   characters and refuses anything it cannot mask; this column merely bounds the width. Payer labels and plan classes are
--   non-PHI rollup dimensions (the QualifyMover.label class).
--
-- OWNERSHIP: claims_admin owns both tables and all four functions — the 0046 user_grid_views
--   pattern verbatim, because this is the same thing: per-user UI state FK'd to claims.app_user.
--   (NOT the collections plane, so the postgres-ownership rule for collections does not apply.)
--
-- ACCESS MODEL (0046 verbatim):
--   · Reads  — claims_reader SELECTs directly, app-layer scoped `where app_user_id = <uid>`; the
--     Server Action passes its own authenticated uid and NEVER a client-supplied id.
--   · Writes — no direct DML; claims_reader EXECUTEs the SECURITY DEFINER functions below, which
--     validate shape and enforce per-user bounds.
--
-- IDEMPOTENT: create table/index IF NOT EXISTS; CREATE OR REPLACE functions; policies dropped and
--   recreated; grants re-applied. Re-running is safe.
-- DEPENDENCY: 0025 (claims.app_user + roles). 0093 is NOT a dependency — the sparkline read
--   degrades when it is absent, and these tables never reference it.
-- APPLY PATH: apply_migration runs as postgres (non-superuser). Objects here are claims_admin-owned,
--   so this uses `set role claims_admin` / `reset role` — the CURRENT convention (0049/0052/0053/0055)
--   — and NOT the older 0017/0018/0025/0046 `grant/revoke claims_admin to postgres` dance. That dance
--   ends in `revoke claims_admin from postgres`, which STRIPS the cluster-level standing grant
--   (`grant claims_admin to postgres with set true`) and 42501s every later claims migration; the
--   rule file says so in as many words ("Do not 'clean it up'"). This migration copied 0046's shape
--   wholesale and inherited that bug — caught in review before apply, corrected here.
--   If `set role claims_admin` fails 42501, the standing grant is missing: restore it as an OPERATOR
--   step, not from a migration, then re-apply.
-- Rollback: 0096_qualify_watchers_rollback.sql

set role claims_admin;

-- 1. Watchers ----------------------------------------------------------------
create table if not exists claims.qualify_watcher (
  id            bigint generated always as identity primary key,
  app_user_id   uuid not null references claims.app_user (user_id) on delete cascade,
  kind          text not null,
  -- The payer label the watcher follows (trend) or the plan context echo (patient).
  payer_label   text,
  -- Keyed-HMAC blind index: the alpha-prefix token (trend, optional) or member-id token (patient).
  subject_token text,
  -- Masked display echo. REQUIRED for 'patient' (nothing can reconstruct it — the member token is
  -- irreversible); NULL for 'trend' (prefixLabel.ts resolves a readable prefix from the token
  -- in-process, so a stored echo would only drift from the resolver).
  display_echo  text,
  threshold_pts int,
  created_at    timestamptz not null default now(),
  constraint qualify_watcher_kind_ck       check (kind in ('trend', 'patient')),
  constraint qualify_watcher_echo_len_ck   check (display_echo is null or char_length(display_echo) between 1 and 13),
  constraint qualify_watcher_payer_len_ck  check (payer_label is null or char_length(payer_label) between 1 and 120),
  constraint qualify_watcher_token_len_ck  check (subject_token is null or char_length(subject_token) = 64),
  constraint qualify_watcher_threshold_ck  check (threshold_pts is null or threshold_pts between 1 and 100),
  -- Kind-shape contracts, stated as DB facts rather than app promises:
  --   trend   = a payer to follow (label required; token optional narrows it to one prefix)
  --   patient = a token to follow (token + masked echo required; no threshold semantics)
  constraint qualify_watcher_trend_ck   check (kind <> 'trend'   or payer_label is not null),
  constraint qualify_watcher_patient_ck check (kind <> 'patient' or (subject_token is not null and display_echo is not null))
);
alter table claims.qualify_watcher owner to claims_admin;

-- One watcher per (user, kind, subject) — coalesced so "payer-wide" (null token) is its own slot.
create unique index if not exists qualify_watcher_subject_uq
  on claims.qualify_watcher (app_user_id, kind, coalesce(subject_token, ''), coalesce(payer_label, ''));

-- Bound the per-user surface at the DB (the definer enforces it; this documents the intent).
create index if not exists qualify_watcher_user_idx on claims.qualify_watcher (app_user_id);

-- 2. Recent searches ----------------------------------------------------------
create table if not exists claims.qualify_recent_search (
  id           bigint generated always as identity primary key,
  app_user_id  uuid not null references claims.app_user (user_id) on delete cascade,
  payer_label  text,
  -- ≤3 alpha/digit chars — the SAME echo the search UI already renders openly. A full member ID
  -- cannot fit, by column constraint rather than by reviewer vigilance.
  prefix_echo  text,
  plan_class   text,
  searched_at  timestamptz not null default now(),
  constraint qualify_recent_payer_len_ck  check (payer_label is null or char_length(payer_label) between 1 and 120),
  constraint qualify_recent_echo_ck       check (prefix_echo is null or prefix_echo ~ '^[A-Z0-9]{1,3}$'),
  constraint qualify_recent_plan_len_ck   check (plan_class is null or char_length(plan_class) between 1 and 40)
);
alter table claims.qualify_recent_search owner to claims_admin;

create index if not exists qualify_recent_user_time_idx
  on claims.qualify_recent_search (app_user_id, searched_at desc);

-- 3. Grants + RLS (0046 verbatim: reader SELECT app-scoped; writes only via definers) ------------
revoke all on claims.qualify_watcher      from public, anon, authenticated, service_role;
revoke all on claims.qualify_recent_search from public, anon, authenticated, service_role;
grant select on claims.qualify_watcher       to claims_reader;
grant select on claims.qualify_recent_search to claims_reader;

alter table claims.qualify_watcher       enable row level security;
alter table claims.qualify_recent_search enable row level security;

drop policy if exists qualify_watcher_admin_rw on claims.qualify_watcher;
create policy qualify_watcher_admin_rw on claims.qualify_watcher
  for all to claims_admin using (true) with check (true);
drop policy if exists qualify_watcher_reader_select on claims.qualify_watcher;
create policy qualify_watcher_reader_select on claims.qualify_watcher
  for select to claims_reader using (true);

drop policy if exists qualify_recent_admin_rw on claims.qualify_recent_search;
create policy qualify_recent_admin_rw on claims.qualify_recent_search
  for all to claims_admin using (true) with check (true);
drop policy if exists qualify_recent_reader_select on claims.qualify_recent_search;
create policy qualify_recent_reader_select on claims.qualify_recent_search
  for select to claims_reader using (true);

-- 4. Write functions (SECURITY DEFINER, claims_admin-owned; the Server Action authenticates and
-- passes ITS OWN uid — integrity and bounds are enforced here, identity is enforced there). ------

-- Upsert one watcher for p_user. Enforces the per-kind shape (redundant with the CHECKs, but a
-- definer that validates loudly beats a constraint violation surfacing as a 500) and a 40-watcher
-- per-user cap ON NEW WATCHERS ONLY.
--
-- CORRECTED (caught in review before apply, 2026-08-10): the first draft counted existing rows and
-- raised BEFORE the upsert, unconditionally — so once a user had 40 watchers, the cap also blocked
-- editing one already on file (e.g. changing a trend watcher's alert threshold), even though the
-- statement below is an UPDATE for that row, not an INSERT. The fix checks whether a row matching
-- the same conflict key (app_user_id, kind, subject_token, payer_label — the qualify_watcher_subject_uq
-- shape) already exists; the cap applies only when it does not, i.e. only to rows that would actually
-- grow the count. Returns the row id.
create or replace function claims.save_qualify_watcher(
  p_user      uuid,
  p_kind      text,
  p_payer     text,
  p_token     text,
  p_echo      text,
  p_threshold int
) returns bigint
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_id bigint;
  v_is_new boolean;
begin
  if p_user is null then
    raise exception 'save_qualify_watcher: user required' using errcode = 'check_violation';
  end if;
  if p_kind not in ('trend', 'patient') then
    raise exception 'save_qualify_watcher: kind must be trend|patient' using errcode = 'check_violation';
  end if;
  if p_kind = 'trend' and (p_payer is null or char_length(p_payer) not between 1 and 120) then
    raise exception 'save_qualify_watcher: trend watcher requires a payer label' using errcode = 'check_violation';
  end if;
  if p_kind = 'patient' and (p_token is null or char_length(p_token) <> 64
     or p_echo is null or char_length(p_echo) not between 1 and 13) then
    raise exception 'save_qualify_watcher: patient watcher requires token + masked echo' using errcode = 'check_violation';
  end if;
  if p_token is not null and p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'save_qualify_watcher: token must be a 64-hex blind index' using errcode = 'check_violation';
  end if;
  if p_threshold is not null and p_threshold not between 1 and 100 then
    raise exception 'save_qualify_watcher: threshold out of range' using errcode = 'check_violation';
  end if;

  -- Same key the ON CONFLICT below targets: a match here means this call UPDATES an existing row,
  -- so it must never count against the cap meant to bound how many DISTINCT watchers a user holds.
  select not exists (
    select 1 from claims.qualify_watcher
     where app_user_id = p_user
       and kind = p_kind
       and coalesce(subject_token, '') = coalesce(p_token, '')
       and coalesce(payer_label, '') = coalesce(p_payer, '')
  ) into v_is_new;

  if v_is_new and (select count(*) from claims.qualify_watcher where app_user_id = p_user) >= 40 then
    raise exception 'save_qualify_watcher: watcher limit reached (40)' using errcode = 'check_violation';
  end if;

  insert into claims.qualify_watcher (app_user_id, kind, payer_label, subject_token, display_echo, threshold_pts)
  values (p_user, p_kind, p_payer, p_token, p_echo, p_threshold)
  on conflict (app_user_id, kind, coalesce(subject_token, ''), coalesce(payer_label, ''))
  do update set threshold_pts = excluded.threshold_pts, display_echo = excluded.display_echo
  returning id into v_id;
  return v_id;
end;
$$;

-- Delete one of the caller's watchers by id (no-op if absent or not theirs — the WHERE is the scope).
create or replace function claims.delete_qualify_watcher(p_user uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null or p_id is null then
    raise exception 'delete_qualify_watcher: user and id required' using errcode = 'check_violation';
  end if;
  delete from claims.qualify_watcher where app_user_id = p_user and id = p_id;
end;
$$;

-- Record one search's non-PHI facets, then prune the caller's history past 20 rows. The prune is
-- inside the definer so no separate cron and no app code owns retention.
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

  insert into claims.qualify_recent_search (app_user_id, payer_label, prefix_echo, plan_class)
  values (p_user, p_payer, p_echo, p_plan);

  delete from claims.qualify_recent_search
   where app_user_id = p_user
     and id not in (
       select id from claims.qualify_recent_search
        where app_user_id = p_user
        order by searched_at desc, id desc
        limit 20
     );
end;
$$;

-- Clear the caller's whole history (the UI's "clear history" control).
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
  delete from claims.qualify_recent_search where app_user_id = p_user;
end;
$$;

alter function claims.save_qualify_watcher(uuid, text, text, text, text, int) owner to claims_admin;
alter function claims.delete_qualify_watcher(uuid, bigint)                    owner to claims_admin;
alter function claims.record_qualify_recent_search(uuid, text, text, text)    owner to claims_admin;
alter function claims.clear_qualify_recent_searches(uuid)                     owner to claims_admin;

revoke execute on function claims.save_qualify_watcher(uuid, text, text, text, text, int) from public, anon, authenticated;
grant  execute on function claims.save_qualify_watcher(uuid, text, text, text, text, int) to claims_reader;
revoke execute on function claims.delete_qualify_watcher(uuid, bigint) from public, anon, authenticated;
grant  execute on function claims.delete_qualify_watcher(uuid, bigint) to claims_reader;
revoke execute on function claims.record_qualify_recent_search(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function claims.record_qualify_recent_search(uuid, text, text, text) to claims_reader;
revoke execute on function claims.clear_qualify_recent_searches(uuid) from public, anon, authenticated;
grant  execute on function claims.clear_qualify_recent_searches(uuid) to claims_reader;

reset role;
