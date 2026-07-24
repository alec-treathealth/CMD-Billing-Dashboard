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

-- Backfill write path. The column-scoped UPDATE grant below lets a writer touch ONLY this bidx token
-- (never PHI ciphertext / money / tenancy / fingerprint). NOTE (verified against prod 2026-07-24):
-- migration 0037's reader UPDATE *policy* was NEVER applied to this project — the member/group bidx
-- backfill ran as the table OWNER (postgres, BYPASSRLS; force_rls=false), NOT as claims_reader. So a
-- grant ALONE does not let claims_reader write (RLS default-denies with no permissive UPDATE policy).
-- RUN THE NAME BACKFILL (cmdNameBidxBackfill.ts) AS THE OWNER — set BLIND_INDEX_DB_URL to a postgres
-- connection — matching how member/group were populated. (A reviewed alternative is to apply 0037's
-- reader UPDATE policy first and run as claims_reader; prod does not use that path.) The grant is kept
-- for that reviewed alternative + defense-in-depth; it is inert without a matching policy.
grant update (patient_name_bidx)
  on collections.cmd_explorer_rows to claims_reader;
