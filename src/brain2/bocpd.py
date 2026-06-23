"""
Brain 2 — drift detection (Phase 2-C).

Weekly per-payer per-CARC event counts from staging.era_adjustment joined to
staging.claim_line (the payer/date dimensions live on claim_line; the join key is
era_adjustment.claim_line_id = claim_line.id — the spec's cl.claim_line_id does
not exist). Cheap ADWIN first pass pre-filters which (payer, code) series get the
full Poisson-Gamma BOCPD. For each changepoint, retrieves semantically similar
CARCs via pgvector and writes a plain-language row to staging.brain2_alerts.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from river import drift as river_drift
from bayesian_changepoint_detection import online_changepoint_detection as oncd
from bayesian_changepoint_detection.hazard_functions import constant_hazard
from bayesian_changepoint_detection.online_likelihoods import StudentT
from functools import partial

BEID = "af504ab6-3dcd-4aa4-a93c-27bc58de4088"
MIN_WEEKS = 8
CHANGEPOINT_P = 0.5

AGG = """
SELECT cl.canonical_primary_payer_name AS payer_name,
       cl.canonical_primary_payer_family AS payer_family,
       ea.carc_code,
       date_trunc('week', cl.primary_payment_date)::date AS week,
       count(*) AS event_count
FROM staging.era_adjustment ea
JOIN staging.claim_line cl ON ea.claim_line_id = cl.id
WHERE ea.business_entity_id = %(beid)s
  AND cl.primary_payment_date IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY 1, 3, 4
"""


def connect_reader():
    conn = psycopg2.connect(os.environ["CLAIMS_READER_DATABASE_URL"])
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.business_entity_id', %s, false)", (BEID,))
    return conn


def adwin_flags(series: np.ndarray) -> bool:
    adwin = river_drift.ADWIN(delta=0.002)
    flagged = False
    for x in series:
        adwin.update(float(x))
        if adwin.drift_detected:
            flagged = True
    return flagged


def bocpd_changepoints(series: np.ndarray):
    hazard = partial(constant_hazard, 1 / 52)
    R, maxes = oncd.online_changepoint_detection(
        series, hazard, StudentT(alpha=0.1, beta=0.01, kappa=1, mu=0))
    # P(run length == 0) at each step = probability a changepoint just occurred.
    p_cp = R[0, 1:]
    return [(i, float(p_cp[i])) for i in range(len(p_cp)) if p_cp[i] > CHANGEPOINT_P]


def similar_carcs(conn, carc_code: str):
    with conn.cursor() as cur:
        cur.execute("""
            select n.carc_code
            from ref.carc_embeddings q
            join ref.carc_embeddings n on n.carc_code <> q.carc_code
            where q.carc_code = %s
            order by n.dense_embedding <=> q.dense_embedding limit 5""", (carc_code,))
        return [r[0] for r in cur.fetchall()]


def main():
    reader = connect_reader()
    try:
        df = pd.read_sql(AGG, reader, params={"beid": BEID})
    finally:
        reader.close()

    alerts = []
    n_series = n_adwin = n_bocpd = 0
    emb = psycopg2.connect(os.environ["CLAIMS_READER_DATABASE_URL"])
    with emb.cursor() as cur:
        cur.execute("SELECT set_config('app.business_entity_id', %s, false)", (BEID,))
    try:
        for (payer, code), grp in df.groupby(["payer_name", "carc_code"]):
            series = grp.sort_values("week")["event_count"].to_numpy(dtype=float)
            if len(series) < MIN_WEEKS:
                continue
            n_series += 1
            if not adwin_flags(series):
                continue
            n_adwin += 1
            cps = bocpd_changepoints(series)
            if not cps:
                continue
            n_bocpd += 1
            family = grp["payer_family"].iloc[0]
            weeks = grp.sort_values("week")["week"].tolist()
            for idx, p in cps:
                prior = series[:idx].mean() if idx else series[0]
                post = series[idx:].mean()
                denom = series.sum() or 1
                sim = similar_carcs(emb, code)
                alerts.append((BEID, payer, family, code, "BOCPD_CHANGEPOINT",
                               round(p, 4), round(float(prior / denom), 4),
                               round(float(post / denom), 4), sim,
                               f"CARC {code} for {payer} shifted regime around "
                               f"{weeks[idx]}: prior~{prior:.1f}/wk, post~{post:.1f}/wk. "
                               f"Similar codes: {', '.join(sim)}."))
    finally:
        emb.close()

    if alerts:
        admin = psycopg2.connect(os.environ["CLAIMS_ADMIN_DATABASE_URL"])
        try:
            with admin.cursor() as cur:
                execute_values(cur,
                    """insert into staging.brain2_alerts
                       (business_entity_id, payer_name, payer_family, carc_code, alert_type,
                        run_length_posterior, prior_rate, post_rate, similar_carc_cluster,
                        plain_language) values %s""", alerts)
            admin.commit()
        finally:
            admin.close()
    print(f"[bocpd] series>={MIN_WEEKS}w={n_series} adwin_flagged={n_adwin} "
          f"bocpd_changepoints={n_bocpd} alerts_written={len(alerts)}")


if __name__ == "__main__":
    main()
