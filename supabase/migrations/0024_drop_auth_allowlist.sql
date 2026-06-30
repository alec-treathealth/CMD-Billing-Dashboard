-- 0024: retire the email allowlist — auth is now invite-only.
--
-- New model: the admin invites users from the Supabase dashboard, self-signup is disabled,
-- and a valid Supabase session IS authorization. The auth_config allowlist table and the
-- "Before User Created" signup-gating hook (both from migration 0018) are no longer used by
-- the app (middleware + requireExecutive gate on the session alone), so this migration drops
-- them along with the now-empty auth_config schema.
--
-- ORDER OF OPERATIONS — apply this LAST, in this sequence, to avoid lockout / errors:
--   1. Supabase dashboard: DISABLE "Authentication -> Hooks -> Before User Created" FIRST.
--      An enabled hook pointing at the function dropped here breaks ALL user creation
--      (including invites).
--   2. Deploy the app build that no longer reads auth_config.allowed_emails. The currently
--      live build reads it on every request; dropping the table under the old build would
--      lock users out.
--   3. THEN apply this migration.
--
-- Idempotent: DROP ... IF EXISTS throughout; the claims_admin membership dance mirrors 0018
-- (Supabase `postgres` is not a superuser, so it must transiently join claims_admin to drop
-- objects owned by claims_admin). Runs in one transaction; the role graph is unchanged after.

grant claims_admin to postgres;

-- The signup-gating hook function (dropping it also removes its grant to supabase_auth_admin).
drop function if exists auth_config.restrict_signup_to_allowlist(jsonb);

-- The allowlist table, its RLS policy, and the (now-empty) schema.
drop policy if exists allowed_emails_own_row on auth_config.allowed_emails;
drop table  if exists auth_config.allowed_emails;
drop schema if exists auth_config;

revoke claims_admin from postgres;

-- ===========================================================================
-- MANUAL STEPS (Supabase dashboard) to complete the invite-only model:
--   1. Authentication -> Hooks -> "Before User Created" -> DISABLE (do this before step 3
--        above).
--   2. Authentication -> Sign In / Providers -> Email -> "Allow new users to sign up" -> OFF
--        (invite-only: only an admin invite creates an account).
--   3. Authentication -> URL Configuration -> Site URL = the app origin; Redirect URLs must
--        include  <origin>/auth/confirm  and  <origin>/auth/callback.
--   4. Authentication -> Emails: edit the "Invite user" and "Reset Password" templates so the
--        action link points at the token-hash confirm route, e.g.
--          {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type={{ .Type }}
--        (/auth/confirm routes invite + recovery to /set-password automatically).
--   5. Invite users from Authentication -> Users -> "Invite user".
-- NOTE: custom SMTP is strongly recommended — the default Supabase sender is rate-limited and
--   unreliable for external recipient domains.
-- ===========================================================================
