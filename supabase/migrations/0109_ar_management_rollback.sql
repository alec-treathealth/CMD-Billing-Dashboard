-- 0109 ROLLBACK — drop the AR Management plane. Reverses 0109_ar_management.sql.
-- Drops functions first (they reference the tables), then tables in dependency order.
-- Never drops a role. The claims_audit_writer / claims_reader grants die with the objects.
--
-- ⚠⚠ THIS DESTROYS HUMAN-AUTHORED WORK THAT CMD CANNOT RE-SUPPLY. Everything else in this plane is
-- a derived replica of CMD's daily snapshot and comes back on the next ingest. These do not:
--     claims.ar_claim_work                     -- every work status, assignee, due date, resolution
--     claims.ar_claim_event                    -- the change feed the notifications bell reads
--     claims.ar_claim_note WHERE source='user' -- notes typed by staff (source='cmd' notes re-import)
--     claims.ar_notification_seen              -- each user's read cursor (trivial, listed for completeness)
-- Re-running the ingest after this rollback restores the CLAIMS and loses the WORK.
--
-- So this file is safe today (ar_claim_work and ar_claim_event are both at 0 rows as of 2026-09-10)
-- and stops being safe the first day a biller uses the tab. The guard below refuses to run once any
-- human-authored row exists: if you genuinely intend to discard that work, delete the guard in your
-- own copy and say so out loud — do not weaken it here.
set role claims_admin;

do $guard$
declare
  v_work bigint := 0;
  v_events bigint := 0;
  v_notes bigint := 0;
begin
  -- to_regclass so a partial/failed forward migration can still be rolled back.
  if to_regclass('claims.ar_claim_work') is not null then
    execute 'select count(*) from claims.ar_claim_work' into v_work;
  end if;
  if to_regclass('claims.ar_claim_event') is not null then
    execute 'select count(*) from claims.ar_claim_event' into v_events;
  end if;
  if to_regclass('claims.ar_claim_note') is not null then
    execute $q$select count(*) from claims.ar_claim_note where source = 'user'$q$ into v_notes;
  end if;
  if v_work > 0 or v_events > 0 or v_notes > 0 then
    raise exception using
      errcode = 'raise_exception',
      message = format(
        'REFUSING to roll back 0109: it would destroy human-authored work (ar_claim_work=%s, ar_claim_event=%s, user notes=%s)',
        v_work, v_events, v_notes),
      hint = 'Export or migrate those rows first. If discarding them is intended, remove this guard deliberately.';
  end if;
end
$guard$;

drop function if exists claims.ar_mark_notifications_seen(uuid);
drop function if exists claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text);
drop function if exists claims.ar_add_note(uuid, text, uuid, text, bytea);

drop table if exists claims.ar_notification_seen;
drop table if exists claims.ar_claim_event;
drop table if exists claims.ar_claim_work;
drop table if exists claims.ar_claim_note;
drop table if exists claims.ar_claim_status_event;
drop table if exists claims.ar_remit;
drop table if exists claims.ar_charge;
drop table if exists claims.ar_claim;
drop table if exists claims.ar_patient;
drop table if exists claims.ar_snapshot_run;

reset role;
