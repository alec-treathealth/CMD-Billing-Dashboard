-- Rollback for 0079: restore the DELETE grant 0078 originally issued.
grant delete on collections.qualify_facility_census to cmd_rollup_writer;
