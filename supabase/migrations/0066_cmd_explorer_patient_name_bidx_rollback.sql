-- ROLLBACK for 0066 — remove the client-name blind index from cmd_explorer_rows.
-- Apply 0067's rollback FIRST if 0067 has been applied (the rebuilt matview projects this column).
-- Idempotent.

revoke update (patient_name_bidx)
  on collections.cmd_explorer_rows from claims_reader;

drop index if exists collections.cmd_explorer_patient_name_bidx_idx;

alter table collections.cmd_explorer_rows
  drop column if exists patient_name_bidx;
