-- 0056: claims.list_access_audit — bounded read path for Alec-only user log dashboard.
--
-- WHY: claims.access_audit is the durable, append-only user/action log, but the app's
-- claims_reader role intentionally has no direct SELECT on the table (0017). The new
-- /admin/user-logs page needs a narrow read bridge for NON-PHI audit metadata only:
-- timestamps, actor email/uid, action, and the existing non-PHI detail blob.
--
-- APP GATE: the page and server loader are hard-gated to Alec's signed-in app
-- account (`alec@treathealth.ai`). This database function does not inspect Supabase
-- sessions; it preserves least privilege by exposing only the existing non-PHI audit
-- projection through EXECUTE, with bounded pagination and fixed predicates.
--
-- SECURITY: SECURITY DEFINER, owner claims_admin, search_path pinned. No dynamic SQL;
-- every filter is a typed parameter. No PHI should ever be present in `detail` per
-- 0017's contract, and this function does not join to any PHI-bearing table.
--
-- IDEMPOTENT: CREATE OR REPLACE + grants re-applied. Safe to deploy before the page.

set role claims_admin;

create or replace function claims.list_access_audit(
  p_limit       integer default 50,
  p_offset      integer default 0,
  p_actor_email text default null,
  p_action      text default null,
  p_from        timestamptz default null,
  p_to          timestamptz default null
) returns table (
  id            uuid,
  created_at    timestamptz,
  actor_email   text,
  actor_user_id text,
  action        text,
  detail        jsonb,
  total_count   bigint
)
language sql
security definer
set search_path = claims, pg_catalog
as $$
  with filtered as (
    select a.id, a.created_at, a.actor_email, a.actor_user_id, a.action, a.detail
      from claims.access_audit a
     where (p_actor_email is null or a.actor_email = lower(p_actor_email))
       and (p_action is null or a.action = p_action)
       and (p_from is null or a.created_at >= p_from)
       and (p_to is null or a.created_at < p_to)
  )
  select f.id,
         f.created_at,
         f.actor_email,
         f.actor_user_id,
         f.action,
         f.detail,
         count(*) over () as total_count
    from filtered f
   order by f.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke execute on function claims.list_access_audit(integer, integer, text, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function claims.list_access_audit(integer, integer, text, text, timestamptz, timestamptz)
  to claims_reader;

reset role;
