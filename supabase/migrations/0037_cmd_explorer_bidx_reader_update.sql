-- 0037 — let the one-shot blind-index backfill (cmdBlindIndexBackfill.ts) write the index
-- columns, run as claims_reader.
--
-- claims_reader already SELECTs every cmd_explorer_rows row (its RLS policy qual = true; tenant
-- scoping is enforced in the application layer via a bound entityIds predicate, not RLS) AND is
-- the role that decrypts PHI for the audited reveal path. So it is the natural actor for the
-- historical backfill: it can read the existing ciphertext and now write ONLY the derived,
-- non-PHI HMAC search tokens.
--
-- The UPDATE is COLUMN-SCOPED to the three *_bidx columns (Postgres column-level privileges),
-- so the reader can never modify PHI ciphertext, money, business_entity_id, or the fingerprint —
-- only the blind-index tokens. This adds NO PHI exposure (the reader already reads + decrypts
-- PHI). NEW rows still get their indexes at ingest via cmd_rollup_writer; this policy exists so
-- the pre-0036 rows can be backfilled once.

grant update (member_id_bidx, member_id_prefix_bidx, group_number_bidx)
  on collections.cmd_explorer_rows to claims_reader;

create policy cmd_explorer_reader_bidx_update
  on collections.cmd_explorer_rows
  for update to claims_reader
  using (true) with check (true);
