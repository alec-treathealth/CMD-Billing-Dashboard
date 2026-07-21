-- Rollback for 0057 — drops the Feed-1 dimension columns + charge_id index from cmd_explorer_rows.
--
-- Reverse dependency order: drop the index first, then the columns. The forward migration is
-- additive-nullable only (no data transform, no grant/RLS change), so this is a clean reversal.
-- If ② has NOT yet populated the columns this loses nothing; if ② HAS populated them, dropping
-- discards that data — acceptable for a rollback (a feed re-pull under a re-applied 0057 repopulates;
-- cmd_explorer_rows is append-only and self-heals).
--
-- IDEMPOTENT: DROP ... IF EXISTS throughout. Grants/RLS untouched (0057 added none).

drop index if exists collections.cmd_explorer_charge_id_idx;

alter table collections.cmd_explorer_rows
  drop column if exists claim_status_category,
  drop column if exists claim_status_raw,
  drop column if exists charge_to_date,
  drop column if exists charge_entered_date,
  drop column if exists charge_id;
