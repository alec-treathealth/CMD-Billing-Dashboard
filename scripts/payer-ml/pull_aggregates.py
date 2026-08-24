"""
READ-ONLY aggregate pulls for payer-behavior ML. SELECTs only, claims_reader role.

Every output CSV in out/ is a payer-level aggregate: payer/code/date/count/dollars.
No patient-level column is ever selected (see _common.py header).

Run:  venv/bin/python scripts/payer-ml/pull_aggregates.py
"""
from __future__ import annotations

import sys
import time

from _common import ENTITIES, SINCE, connect, fetch, write_csv

# ── Query catalog ──────────────────────────────────────────────────────────────
# Fixed-literal SQL; only tenant uuids are bound params. Explicit projections.

EXP_PAYER_MONTH = """
select upper(btrim(primary_payer)) as payer,
       date_trunc('month', charge_date)::date as svc_month,
       count(*) as lines,
       round(sum(charge_amount), 2) as charge,
       round(sum(allowed_amount), 2) as allowed,
       round(sum(insurance_payments), 2) as paid
  from collections.cmd_explorer_rows
 where business_entity_id = %s
   and charge_date is not null
   and charge_date >= coalesce(%s::date, date '1900-01-01')
   and nullif(btrim(primary_payer), '') is not null
 group by 1, 2
"""

EXP_PAYER_CPT_Q = """
select upper(btrim(primary_payer)) as payer,
       upper(btrim(cpt_code)) as cpt,
       date_trunc('quarter', charge_date)::date as svc_quarter,
       count(*) as lines,
       round(sum(charge_amount), 2) as charge,
       round(sum(insurance_payments), 2) as paid
  from collections.cmd_explorer_rows
 where business_entity_id = %s
   and charge_date is not null
   and charge_date >= coalesce(%s::date, date '1900-01-01')
   and nullif(btrim(primary_payer), '') is not null
   and nullif(btrim(cpt_code), '') is not null
 group by 1, 2, 3
"""

EXP_PAYER_REV_Q = """
select upper(btrim(primary_payer)) as payer,
       upper(btrim(revenue_code)) as rev_code,
       date_trunc('quarter', charge_date)::date as svc_quarter,
       count(*) as lines,
       round(sum(charge_amount), 2) as charge,
       round(sum(insurance_payments), 2) as paid
  from collections.cmd_explorer_rows
 where business_entity_id = %s
   and charge_date is not null
   and charge_date >= coalesce(%s::date, date '1900-01-01')
   and nullif(btrim(primary_payer), '') is not null
   and nullif(btrim(revenue_code), '') is not null
 group by 1, 2, 3
"""

EXP_PAYER_STATUS_MONTH = """
select upper(btrim(primary_payer)) as payer,
       date_trunc('month', charge_date)::date as svc_month,
       coalesce(nullif(btrim(claim_status_category), ''), '(none)') as status_cat,
       count(*) as lines
  from collections.cmd_explorer_rows
 where business_entity_id = %s
   and charge_date is not null
   and charge_date >= coalesce(%s::date, date '1900-01-01')
   and nullif(btrim(primary_payer), '') is not null
 group by 1, 2, 3
"""

EXP_SPELLINGS = """
select upper(btrim(primary_payer)) as spelling,
       min(charge_date)::date as first_seen,
       max(charge_date)::date as last_seen,
       count(*) as lines,
       round(sum(charge_amount), 2) as charge
  from collections.cmd_explorer_rows
 where business_entity_id = %s
   and charge_date >= coalesce(%s::date, date '1900-01-01')
   and nullif(btrim(primary_payer), '') is not null
 group by 1
"""

CL_PAYER_MONTH = """
select coalesce(canonical_primary_payer_name, upper(btrim(primary_payer_name)), '(unknown)') as payer,
       coalesce(canonical_primary_payer_family, '(unmapped)') as family,
       date_trunc('month', charge_from_date)::date as svc_month,
       count(*) as lines,
       round(sum(charge_amount), 2) as charge,
       round(sum(insurance_paid_amount), 2) as paid,
       round(avg(insurance_payment_lag) filter (where insurance_payment_lag between 0 and 1000), 1) as avg_lag,
       percentile_cont(0.5) within group (order by insurance_payment_lag)
         filter (where insurance_payment_lag between 0 and 1000) as med_lag
  from staging.claim_line
 where charge_from_date is not null
   and charge_from_date >= coalesce(%s::date, date '1900-01-01')
 group by 1, 2, 3
"""

CL_FAMILY_CPT_Q = """
select coalesce(canonical_primary_payer_family, '(unmapped)') as family,
       upper(btrim(cpt_code)) as cpt,
       date_trunc('quarter', charge_from_date)::date as svc_quarter,
       count(*) as lines,
       round(sum(charge_amount), 2) as charge,
       round(sum(insurance_paid_amount), 2) as paid
  from staging.claim_line
 where charge_from_date is not null
   and charge_from_date >= coalesce(%s::date, date '1900-01-01')
   and nullif(btrim(cpt_code), '') is not null
 group by 1, 2, 3
"""

CL_LAG_PAYER_MONTH = """
select coalesce(canonical_primary_payer_family, '(unmapped)') as family,
       date_trunc('month', primary_payment_date)::date as pay_month,
       count(*) as lines,
       round(avg(insurance_payment_lag), 1) as avg_lag,
       percentile_cont(0.25) within group (order by insurance_payment_lag) as p25_lag,
       percentile_cont(0.5)  within group (order by insurance_payment_lag) as med_lag,
       percentile_cont(0.75) within group (order by insurance_payment_lag) as p75_lag
  from staging.claim_line
 where primary_payment_date is not null
   and primary_payment_date >= coalesce(%s::date, date '1900-01-01')
   and insurance_payment_lag between 0 and 1000
 group by 1, 2
"""

ERA_CARC_PAYER = """
select upper(btrim(payer_name)) as payer,
       carc_code,
       group_code,
       coalesce(category, '(none)') as category,
       count(*) as adj_lines,
       round(sum(adjustment_amount), 2) as adj_amount
  from staging.era_835_adjustment
 where nullif(btrim(payer_name), '') is not null
   and payment_date >= coalesce(%s::date, date '1900-01-01')
 group by 1, 2, 3, 4
"""

ERA_METHOD_PAYER = """
select upper(btrim(payer_name)) as payer,
       coalesce(nullif(btrim(payment_method), ''), '(none)') as method,
       count(*) as remits,
       round(sum(payment_amount), 2) as amount
  from staging.era_835_payment
 where nullif(btrim(payer_name), '') is not null
   and payment_date >= coalesce(%s::date, date '1900-01-01')
 group by 1, 2
"""

VOB_PAYER_MONTH = """
select upper(btrim(insurance_co)) as spelling,
       date_trunc('month', vob_created_at)::date as vob_month,
       count(*) as vobs,
       count(distinct facility) as facilities
  from vob.indigo_vob
 where nullif(btrim(insurance_co), '') is not null
   and vob_created_at is not null
   and vob_created_at >= coalesce(%s::date, date '1900-01-01')
 group by 1, 2
"""

VOB_SPELLINGS = """
select upper(btrim(insurance_co)) as spelling,
       min(vob_created_at)::date as first_seen,
       max(vob_created_at)::date as last_seen,
       count(*) as vobs,
       count(distinct facility) as facilities
  from vob.indigo_vob
 where nullif(btrim(insurance_co), '') is not null
   and vob_created_at >= coalesce(%s::date, date '1900-01-01')
 group by 1
"""

VOB_FUNDING_MONTH = """
select upper(btrim(insurance_co)) as spelling,
       coalesce(nullif(upper(btrim(funding)), ''), '(none)') as funding,
       date_trunc('month', vob_created_at)::date as vob_month,
       count(*) as vobs
  from vob.indigo_vob
 where nullif(btrim(insurance_co), '') is not null
   and vob_created_at is not null
   and vob_created_at >= coalesce(%s::date, date '1900-01-01')
 group by 1, 2, 3
"""

REF_ALIAS_MAP = """
select vocabulary, alias_norm, canonical_payer_id, relationship,
       confidence, needs_review
  from ref.payer_alias_map
"""

REF_PAYER_IDENTITY = """
select canonical_payer_id, display_name, payer_family, entity_kind,
       administers_for, is_active
  from ref.payer_identity
"""

REF_CARC = """
select carc_code, short_description
  from ref.carc_code
"""


def main() -> int:
    conn = connect()
    t0 = time.time()
    if SINCE:
        print(f"window: rows on/after {SINCE}")
    try:
        # Entity-scoped explorer pulls (GUC set defensively; explicit entity filter too)
        for ent, ent_id in ENTITIES.items():
            for name, sql in [
                (f"exp_payer_month_{ent}.csv", EXP_PAYER_MONTH),
                (f"exp_payer_cpt_q_{ent}.csv", EXP_PAYER_CPT_Q),
                (f"exp_payer_rev_q_{ent}.csv", EXP_PAYER_REV_Q),
                (f"exp_payer_status_month_{ent}.csv", EXP_PAYER_STATUS_MONTH),
                (f"exp_spellings_{ent}.csv", EXP_SPELLINGS),
            ]:
                cols, rows = fetch(conn, sql, (ent_id, SINCE), entity_id=ent_id)
                p = write_csv(name, cols, rows)
                print(f"  {p.name:<36} {len(rows):>7} rows")

        # BXR staging plane (canonical payers, lags, ERA) — GUC required
        bxr = ENTITIES["BXR"]
        for name, sql in [
            ("cl_payer_month.csv", CL_PAYER_MONTH),
            ("cl_family_cpt_q.csv", CL_FAMILY_CPT_Q),
            ("cl_lag_payer_month.csv", CL_LAG_PAYER_MONTH),
            ("era_carc_payer.csv", ERA_CARC_PAYER),
            ("era_method_payer.csv", ERA_METHOD_PAYER),
        ]:
            cols, rows = fetch(conn, sql, (SINCE,), entity_id=bxr)
            p = write_csv(name, cols, rows)
            print(f"  {p.name:<36} {len(rows):>7} rows")

        # Global (VOB + reference)
        for name, sql, params in [
            ("vob_payer_month.csv", VOB_PAYER_MONTH, (SINCE,)),
            ("vob_spellings.csv", VOB_SPELLINGS, (SINCE,)),
            ("vob_funding_month.csv", VOB_FUNDING_MONTH, (SINCE,)),
            ("ref_alias_map.csv", REF_ALIAS_MAP, ()),
            ("ref_payer_identity.csv", REF_PAYER_IDENTITY, ()),
            ("ref_carc.csv", REF_CARC, ()),
        ]:
            cols, rows = fetch(conn, sql, params)
            p = write_csv(name, cols, rows)
            print(f"  {p.name:<36} {len(rows):>7} rows")
    finally:
        conn.close()
    print(f"done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
