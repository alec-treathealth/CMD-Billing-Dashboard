-- 0002: Correct the collection_rate generated expression (fix option "c'").
--
-- Problem: collection_rate numeric(6,4) (max 99.9999) overflowed on 160 of the
-- 2024 rows where allowed_amount is small-positive, zero, or negative (reversals)
-- -> paid_amount/allowed_amount reached up to ~61,932. See diagnose.ts.
--
-- Fix: compute the rate only when it is representable; otherwise NULL. A NULL
-- rate on a row with non-null paid+allowed is itself a meaningful signal
-- (reversal / adjustment / near-zero or negative allowed) — see CLAUDE.md
-- "Phase 2+ notes". We intentionally KEEP those rows (incl. the 16 allowed<=0
-- reversals) in claims with a NULL rate; we do NOT drop them.
--
-- Altering a STORED generated column's expression requires dropping & recreating
-- the column, so we drop & recreate the whole `claims` table. This is safe:
--   * claims_raw is AUTHORITATIVE (143,190 rows) and is NOT touched here.
--   * claims held only 2,500 rows from a partial, failed run; it is rebuilt in
--     full by re-running the ingest (idempotent on claims_raw).
-- Verified on PG 17: the flat AND form does NOT divide-by-zero when allowed=0
-- (the row yields a NULL rate).

-- Safety guard: this migration must never drop the authoritative raw table.
do $$
begin
  if to_regclass('public.claims_raw') is null then
    raise exception 'claims_raw is missing — aborting (it is authoritative, must exist).';
  end if;
end $$;

drop table if exists claims;

create table if not exists claims (
  id              bigint generated always as identity primary key,
  claims_raw_id   bigint not null references claims_raw(id),
  source_year     smallint not null,

  facility_name   text not null,
  date_of_service date not null,
  hcpcs_code      text,
  revenue_code    text,
  patient_name    text not null,
  patient_last    text not null,
  patient_first   text not null,
  member_id_raw   text,
  member_id_norm  text,
  group_number    text,
  employer_name   text,

  charge_amount   numeric(12,2),
  allowed_amount  numeric(12,2),
  paid_amount     numeric(12,2),
  adjustment      numeric(12,2),
  balance_due_pt  numeric(12,2),
  payer_name      text not null,

  collection_rate numeric(6,4)
    generated always as (
      case when allowed_amount > 0 and abs(paid_amount / allowed_amount) < 100
           then paid_amount / allowed_amount
           else null end
    ) stored,

  created_at      timestamptz not null default now()
);

comment on column claims.collection_rate is
$c$paid_amount/allowed_amount, stored. The "< 100" bound is a REPRESENTABILITY limit tied to numeric(6,4) (max 99.9999), NOT a business threshold: a real collection rate never approaches it. The bound exists only to keep reversal and near-zero/negative-denominator artifacts from overflowing the column. If this column's precision/scale is ever changed, the 100 constant must be revisited deliberately. (A NULL here with non-null paid+allowed is a signal — reversal/adjustment/near-zero allowed — see CLAUDE.md Phase 2+ notes.)$c$;

create index if not exists claims_patient_trgm  on claims using gin (patient_name gin_trgm_ops);
create index if not exists claims_facility_trgm on claims using gin (facility_name gin_trgm_ops);
create index if not exists claims_payer_trgm    on claims using gin (payer_name gin_trgm_ops);
create index if not exists claims_member_norm   on claims (member_id_norm);
create index if not exists claims_dos           on claims (date_of_service);
create index if not exists claims_facility_payer on claims (facility_name, payer_name);
