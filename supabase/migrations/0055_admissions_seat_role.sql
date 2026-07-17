-- 0055: claims.app_user — add the `admissions_seat` role (Qualify tab).
--
-- WHY: the Qualify surface (docs/qualify-build-series.md) introduces a NEW, distinct role in the
-- ladder alongside super_admin / admin+entity / user+entity:
--   • admissions_seat — sees ONLY the Qualify tab (nav + route enforced in app code); NEVER sees
--     dollar amounts inside Qualify (percentages only); MAY search + audited-reveal member IDs on
--     Qualify (canRevealPhi=true in rbac.ts); ENTITY-LESS (entity IS NULL), because Qualify reads
--     CROSS-TENANT (BXR + Indigo) by design — it is not scoped to one business_entity_id.
-- This migration ONLY widens the two role CHECK constraints on claims.app_user so such a row can be
-- inserted. All behavior (nav/route restriction, amounts stripping, cross-tenant read) lives in app
-- code shipped in the same PR (rbac.ts / server.ts narrowRole / admin-actions.ts ROLES + the Qualify
-- server actions). The DB CHECK and the code `narrowRole` guard MUST stay in sync: a role string
-- allowed by the DB but absent from narrowRole is coerced to null = unprovisioned/deny, and vice
-- versa an insert of a role the DB rejects fails at write time. Both move together in this PR.
--
-- WIDENING ONLY (safe validate): every existing row is super_admin/admin/user, all of which still
-- satisfy the widened checks, so `add constraint` re-validates cleanly with no NOT VALID needed.
--
-- APPLY PATH: apply_migration runs as postgres (non-superuser). claims.app_user is claims_admin-owned
-- (0025), so this uses `set role claims_admin` / `reset role` — the current dashboard convention
-- (0049/0052/0053) — NOT the older 0017/0018/0025 `grant/revoke claims_admin to postgres` dance,
-- which would strip the standing operator grant `grant claims_admin to postgres with set true`
-- (cluster-level posture; see veris-data-notes 2026-07-13). If `set role claims_admin` fails 42501,
-- the standing grant is missing — re-check pg_has_role('postgres','claims_admin','SET') and restore
-- it as an OPERATOR step (not from a migration), then re-apply.
--
-- IDEMPOTENT-FORWARD: drop-if-exists then add for each constraint; re-applying is a no-op net change.
-- Rollback in 0055_admissions_seat_role_rollback.sql (fails LOUD if any admissions_seat row exists).
-- No role graph change; no DROP ROLE (roles here are app_user rows, not Postgres roles).
-- Dashboard sequence (supabase/migrations/00NN); does not affect the Veris SQL Schemas/0NN sequence.
-- Apply to project dbpabchpvipipkzkogta via Supabase MCP AFTER review (HOLD gate).

set role claims_admin;

-- Widen the role allowlist to include admissions_seat.
alter table claims.app_user drop constraint if exists app_user_role_ck;
alter table claims.app_user add constraint app_user_role_ck
  check (role in ('super_admin', 'admin', 'user', 'admissions_seat'));

-- Role/entity coherence: admissions_seat is ENTITY-LESS (like super_admin) because Qualify is
-- cross-tenant. admin/user remain entity-scoped.
alter table claims.app_user drop constraint if exists app_user_role_entity_ck;
alter table claims.app_user add constraint app_user_role_entity_ck check (
  (role = 'super_admin'      and entity is null) or
  (role = 'admissions_seat'  and entity is null) or
  (role in ('admin', 'user') and entity is not null)
);

-- SECOND DB enum site: the write function claims.upsert_app_user (0026) hard-codes the 3-role list
-- and coherence INDEPENDENTLY of the table CHECK — so provisioning an admissions_seat via the admin
-- UI would raise 'upsert_app_user: invalid role' even after the CHECKs above. Recreate it with the
-- widened role list + admissions_seat's entity-less coherence. CREATE OR REPLACE preserves owner
-- (claims_admin) and the existing EXECUTE grant to claims_reader; only the two validation lines and
-- the coherence branch change. Everything else (entity/email checks, last-super-admin guard, upsert)
-- is byte-identical to 0026.
create or replace function claims.upsert_app_user(
  p_user_id uuid,
  p_email   text,
  p_role    text,
  p_entity  text
) returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user_id is null then
    raise exception 'upsert_app_user: user_id required' using errcode = 'check_violation';
  end if;
  if p_role not in ('super_admin', 'admin', 'user', 'admissions_seat') then
    raise exception 'upsert_app_user: invalid role' using errcode = 'check_violation';
  end if;
  if p_entity is not null and p_entity not in ('bxr', 'indigo') then
    raise exception 'upsert_app_user: invalid entity' using errcode = 'check_violation';
  end if;
  if not ((p_role = 'super_admin' and p_entity is null)
          or (p_role = 'admissions_seat' and p_entity is null)
          or (p_role in ('admin', 'user') and p_entity is not null)) then
    raise exception 'upsert_app_user: super_admin/admissions_seat take no entity; admin/user require one'
      using errcode = 'check_violation';
  end if;
  if p_email is null or length(p_email) not between 3 and 320 then
    raise exception 'upsert_app_user: invalid email' using errcode = 'check_violation';
  end if;

  -- Last-super-admin guard (unchanged from 0026): block a change that demotes the only super_admin.
  if p_role <> 'super_admin'
     and exists (select 1 from claims.app_user where user_id = p_user_id and role = 'super_admin')
     and (select count(*) from claims.app_user where role = 'super_admin') <= 1 then
    raise exception 'upsert_app_user: cannot demote the last super admin'
      using errcode = 'check_violation';
  end if;

  insert into claims.app_user (user_id, email, role, entity)
  values (p_user_id, lower(p_email), p_role, p_entity)
  on conflict (user_id) do update
    set role = excluded.role, entity = excluded.entity, email = excluded.email, updated_at = now();
end;
$$;

reset role;
