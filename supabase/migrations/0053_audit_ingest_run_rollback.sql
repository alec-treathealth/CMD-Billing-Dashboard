-- Rollback 0053 — drop claims.audit_ingest_run (index + policies drop with the table).
set role claims_admin;
drop table if exists claims.audit_ingest_run;
reset role;
