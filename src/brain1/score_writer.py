"""
Brain 1 — score writer (Phase 1-D).

Loads the three trained models + the ordinal encoder, scores the FULL
staging.brain1_features set (not just test), and UPSERTs into staging.brain1_scores
via claims_admin. Parameterized, batched (1000), no named prepared statements.

PHI firewall: asserts shap_top_feature is never a PHI column name before any write.
"""
from __future__ import annotations

import os
import pickle
import pathlib
import datetime as dt

import numpy as np
import pandas as pd
import psycopg2
import shap
from psycopg2.extras import execute_values

from feature_engineering import QUERY, RESIDUAL_TO_CLASS, FEATURE_NUMERIC, FEATURE_CATEGORICAL, BEID

DATA = pathlib.Path("data/brain1")
PHI_DENYLIST = {"patient_name", "patient_first", "patient_last", "member_id",
                "member_id_raw", "member_id_norm", "group_number", "dob", "ssn"}
MODEL_VERSION = f"v1.0-{dt.date.today().isoformat()}"
CATEGORICAL = FEATURE_CATEGORICAL


def load_models():
    with open(DATA / "lgb_classifier.pkl", "rb") as f: clf = pickle.load(f)
    with open(DATA / "cox_model.pkl", "rb") as f: cox = pickle.load(f)
    with open(DATA / "ordinal_encoder.pkl", "rb") as f: enc = pickle.load(f)
    return clf, cox, enc


def fetch_features():
    conn = psycopg2.connect(os.environ["CLAIMS_READER_DATABASE_URL"])
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.business_entity_id', %s, false)", (BEID,))
    try:
        df = pd.read_sql(QUERY, conn, params={"beid": BEID})
    finally:
        conn.close()
    df["is_behavioral_health"] = (
        df["cpt_code"].str.startswith("H", na=False)
        | df["cpt_code"].between("90791", "90899", inclusive="both")).astype(int)
    df["pfs_rate_ratio"] = (df["billed_amount"] / df["facility_rate"]).where(
        df["facility_rate"].notna() & (df["facility_rate"] != 0))
    df = df.sort_values("dos")
    df["facility_payer_pair_hist"] = df.groupby(
        ["claim_facility_id", "canonical_primary_payer_name"]).cumcount()
    return df


def main() -> None:
    clf, cox, enc = load_models()
    df = fetch_features()
    feats = FEATURE_NUMERIC + CATEGORICAL
    X = df[feats].copy()
    X[CATEGORICAL] = enc.transform(X[CATEGORICAL].astype("string"))

    proba = clf.predict_proba(X)  # columns align to classes 0..3
    classes = list(clf.classes_)
    def col(c): return proba[:, classes.index(c)] if c in classes else np.zeros(len(df))
    p_paid, p_partial, p_denied = col(0), col(1), col(2)

    # Cox median survival -> expected days to pay (guard for missing covariates)
    try:
        med = cox.predict_median(pd.get_dummies(df).reindex(columns=cox.params_.index, fill_value=0))
        expected_days = med.replace([np.inf, -np.inf], np.nan).to_numpy()
    except Exception:
        expected_days = np.full(len(df), np.nan)

    explainer = shap.TreeExplainer(clf, feature_perturbation="tree_path_dependent")
    sv = explainer.shap_values(X)
    sv_denied = sv[2] if isinstance(sv, list) else sv  # DENIED class contributions
    top_idx = np.abs(sv_denied).argmax(axis=1)
    top_feat = [feats[i] for i in top_idx]
    top_val = sv_denied[np.arange(len(df)), top_idx]
    assert not (set(f.lower() for f in top_feat) & PHI_DENYLIST), "PHI feature leaked into SHAP"

    rows = []
    for i, cd in enumerate(df["charge_debit_id"].tolist()):
        rows.append((BEID, cd, MODEL_VERSION,
                     round(float(p_paid[i]), 4), round(float(p_denied[i]), 4),
                     round(float(p_partial[i]), 4),
                     None if np.isnan(expected_days[i]) else round(float(expected_days[i]), 1),
                     top_feat[i], round(float(top_val[i]), 4),
                     f"top denial driver: {top_feat[i]}"))

    conn = psycopg2.connect(os.environ["CLAIMS_ADMIN_DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            for j in range(0, len(rows), 1000):
                execute_values(cur,
                    """insert into staging.brain1_scores
                       (business_entity_id, charge_debit_id, model_version, p_paid, p_denied,
                        p_partial, expected_days_to_pay, shap_top_feature, shap_top_value,
                        counterfactual_hint) values %s
                       on conflict (business_entity_id, charge_debit_id, model_version) do update set
                         p_paid=excluded.p_paid, p_denied=excluded.p_denied, p_partial=excluded.p_partial,
                         expected_days_to_pay=excluded.expected_days_to_pay,
                         shap_top_feature=excluded.shap_top_feature, shap_top_value=excluded.shap_top_value,
                         counterfactual_hint=excluded.counterfactual_hint, scored_at=now()""",
                    rows[j:j + 1000])
        conn.commit()
    finally:
        conn.close()
    print(f"[score_writer] scored={len(rows)} model_version={MODEL_VERSION} "
          f"denied>0.5={(p_denied > 0.5).sum()}")


if __name__ == "__main__":
    main()
