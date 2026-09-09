-- 0109 ROLLBACK — drop the AR Management plane. Reverses 0109_ar_management.sql.
-- Drops functions first (they reference the tables), then tables in dependency order.
-- Never drops a role. The claims_audit_writer / claims_reader grants die with the objects.
set role claims_admin;

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
