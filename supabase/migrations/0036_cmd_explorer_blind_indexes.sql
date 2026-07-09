-- 0036 — searchable PHI via BLIND INDEXES (keyed HMAC), not decryption.
--
-- The three PHI identifiers (patient_name, member_id, group_number) stay encrypted at rest
-- (libsodium, migration 0019) and are NEVER made searchable in plaintext. To let internal,
-- PHI-entitled users look up rows by member ID / alpha prefix / group number, we store a
-- KEYED HMAC ("blind index") of the normalized value alongside the ciphertext. Search =
-- HMAC(query) equality-matched against these columns; the plaintext is never decrypted at
-- query time and never leaves storage in the clear.
--
-- The HMAC uses a DEDICATED key (INDEX_HMAC_KEY), separate from LIBSODIUM_KEY (key
-- separation). The tokens are one-way and keyed, so a DB-only attacker can neither reverse
-- them nor brute-force the low-entropy identifiers without the key. Equality leakage (equal
-- values share a token) is the accepted, standard trade-off for blind indexing.
--
--   member_id_bidx         HMAC of the full normalized member id      → exact member-ID lookup
--   member_id_prefix_bidx  HMAC of the first 3 chars (alpha prefix)    → alpha-prefix lookup
--   group_number_bidx      HMAC of the normalized group number         → exact group-# lookup
--
-- Values are lowercase hex (HMAC-SHA256, 64 chars). NULL when the source value is absent.
-- Columns are populated at ingest (cmdExplorerSeed/Cron, from plaintext held before
-- encryption) and backfilled for existing rows by src/collections/cmdBlindIndexBackfill.ts.

alter table collections.cmd_explorer_rows
  add column if not exists member_id_bidx text,
  add column if not exists member_id_prefix_bidx text,
  add column if not exists group_number_bidx text;

create index if not exists cmd_explorer_member_id_bidx_idx
  on collections.cmd_explorer_rows (member_id_bidx);
create index if not exists cmd_explorer_member_id_prefix_bidx_idx
  on collections.cmd_explorer_rows (member_id_prefix_bidx);
create index if not exists cmd_explorer_group_number_bidx_idx
  on collections.cmd_explorer_rows (group_number_bidx);
