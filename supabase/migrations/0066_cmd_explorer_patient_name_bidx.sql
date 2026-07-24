-- 0066 — CLIENT-NAME blind index on cmd_explorer_rows (Qualify redesign, Change C).
--
-- Supersedes the qualify-build-series Prompt-2 ruling ("no name search") per Alec 2026-07-24:
-- Qualify is an internal tool; Client Name becomes a real resolution path. Same construction as
-- 0036 (keyed HMAC over the NORMALIZED plaintext, held at ingest before encryption; INDEX_HMAC_KEY,
-- distinct from LIBSODIUM_KEY): patient_name stays libsodium-encrypted at rest and is NEVER made
-- searchable in plaintext — search = HMAC(typed name) equality-matched against this column. EXACT
-- name only (ruling: no prefix variant — a 3-char name prefix is far too broad across PHI). The
-- normalization is patientNameNormalized (blindIndex.ts): trim, collapse internal whitespace,
-- uppercase — the SAME transform the billing-audit plane (0049) uses, so ingest + query agree.
--
-- Populated at ingest (cmdExplorerSeed/Cron mint it from plaintext) and backfilled for existing
-- rows by src/collections/cmdNameBidxBackfill.ts (decrypt → HMAC → write; run locally, resumable).
-- The Qualify resolve reads the CHARGE ROLLUP's copy of this column — projected by 0067.
--
-- Additive + instant (no matview touch here; that is 0067's rebuild). Idempotent.
-- Rollback: 0066_cmd_explorer_patient_name_bidx_rollback.sql.

alter table collections.cmd_explorer_rows
  add column if not exists patient_name_bidx text;

create index if not exists cmd_explorer_patient_name_bidx_idx
  on collections.cmd_explorer_rows (patient_name_bidx);

-- Backfill write path (mirror of 0037): claims_reader already SELECTs + decrypts every row for the
-- audited reveal, so it is the natural one-shot backfill actor. The UPDATE is COLUMN-SCOPED to the
-- new bidx column only — the reader can never modify PHI ciphertext, money, tenancy, or the
-- fingerprint. The 0037 policy (cmd_explorer_reader_bidx_update, FOR UPDATE USING/WITH CHECK true)
-- already row-authorizes reader updates on this table; column privilege is the actual constraint,
-- so no new policy is required — just the column grant.
grant update (patient_name_bidx)
  on collections.cmd_explorer_rows to claims_reader;
