-- 0008: Fix collections.payment_lines.collection_rate overflow (mirrors claims 0002).
--
-- Problem: collection_rate numeric(6,4) (max 99.9999) overflows on rows where
-- allowed_amount is small-positive (or zero/negative) so insurance_paid/allowed
-- exceeds the representable range — the same artifact claims hit in 0002. This
-- surfaces only on INSERT (a STORED generated column), which is why the Step 3
-- dry-run (no DB writes) did not catch it.
--
-- Fix: compute the rate only when representable; otherwise NULL — and a NULL rate
-- on a row with non-null paid+allowed is itself a signal (reversal / adjustment /
-- near-zero or negative allowed), exactly as in claims. We KEEP those rows.
--
-- Altering a STORED generated column's expression requires drop + re-add of the
-- column. We re-add it (GENERATED ... STORED computes for existing rows), so the
-- partial data already loaded is preserved and recomputed — no table rebuild, no
-- touch to collections_raw, no RLS/grant/ownership change. collection_rate has no
-- index or policy dependency.

alter table collections.payment_lines drop column if exists collection_rate;

alter table collections.payment_lines
  add column collection_rate numeric(6,4)
    generated always as (
      case when allowed_amount > 0 and abs(insurance_paid / allowed_amount) < 100
           then insurance_paid / allowed_amount
           else null end
    ) stored;

comment on column collections.payment_lines.collection_rate is
$c$insurance_paid/allowed_amount, stored. The "< 100" bound is a REPRESENTABILITY limit tied to numeric(6,4) (max 99.9999), NOT a business threshold. It keeps reversal / near-zero / negative-denominator artifacts from overflowing the column. A NULL here with non-null paid+allowed is a signal (reversal/adjustment/near-zero allowed). If this column's precision/scale changes, the 100 constant must be revisited. Mirrors claims.collection_rate (migration 0002).$c$;
