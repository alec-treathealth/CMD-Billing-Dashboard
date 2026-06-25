-- 0015: refine the daily_collections_resolved precedence to MOST-COMPLETE (max gross).
--
-- WHY: 0014's view used "deposit_sheet always wins where both sources have a row".
-- Post-ingest verification found exactly ONE bucket where that hides real money —
-- CAMH 2026-01-30: the legacy workbook recorded $4,236.38 (incl. a $3,600 check) but
-- the deposit Sheet recorded only $636.38 (it lost that check). "Deposit wins" would
-- display $636.38, dropping the $3,600 from view — defeating the zero-wipe intent.
--
-- FIX: per (facility_code, payment_date), the row with the LARGER gross_amount wins
-- (most-complete record), with deposit_sheet preferred only as the tiebreak when the
-- two sources agree (so fresh data still reads from the live Sheet). Verified blast
-- radius: this changes EXACTLY one bucket (CAMH 2026-01-30 -> $4,236.38). Everywhere
-- else the deposit Sheet's gross is >= the workbook's (the 06-13..24 fill-ins, Dallas,
-- TREAT_WA 06-12, and the 1,815 agreements), so the resolved values are unchanged.
--
-- Assumption (domain-valid here): a larger daily deposit gross = a more complete
-- record (deposits accumulate; there are no legitimate downward corrections in this
-- data — confirmed: the single CAMH case is the only bucket where workbook > deposit).
--
-- PHI: none. §7 lineage untouched. Idempotent: CREATE OR REPLACE VIEW + reapplied
-- REVOKE/GRANT. DEPENDENCY: 0014 (the view + source_tag) has run.

create or replace view collections.daily_collections_resolved
  with (security_invoker = true) as
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount
  from (
    select
      facility_code, payment_date, checks_amount, eft_amount, gross_amount,
      row_number() over (
        partition by facility_code, payment_date
        order by
          gross_amount desc,                                          -- most-complete record wins
          case when source_tag = 'deposit_sheet' then 0 else 1 end,   -- equal -> prefer the live Sheet
          id                                                          -- deterministic tiebreak
      ) as rn
    from collections.daily_collections
    where facility_code is not null
  ) ranked
  where rn = 1
  union all
  -- NULL-facility (group-code-only lineage) rows are not deduped: keep all.
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount
  from collections.daily_collections
  where facility_code is null;

revoke all on collections.daily_collections_resolved from public, anon, authenticated, service_role;
grant select on collections.daily_collections_resolved to claims_reader;
grant select on collections.daily_collections_resolved to claims_admin;
