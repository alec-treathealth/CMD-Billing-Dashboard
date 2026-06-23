"""
Brain 1 — feature engineering (Phase 1-B).

Pulls from staging.brain1_features (already leakage-firewalled in migration 005:
features are submission-time-knowable, labels are post-adjudication and separated).
Adds the CMS PFS anchor (billed / facility_rate) and a few derived features, then
performs a TIME-BASED split (not random) and writes parquet to data/brain1/.

Read-only via claims_reader (CLAIMS_READER_DATABASE_URL). The tenant GUC is set
per-session so RLS returns this tenant's rows. Pooler 6543 -> no server-side
prepared statements (psycopg2 binds client-side, so this is satisfied).

NOTE on `days_from_dos_to_submit`: the spec wanted submission_date - service_date,
but there is no submission_date column. We use insurance_billing_lag (CMD's
days service->first bill), which IS submission-time-knowable. Documented divergence.
"""
from __future__ import annotations

import os
import pathlib

import pandas as pd
import psycopg2

BEID = "af504ab6-3dcd-4aa4-a93c-27bc58de4088"
OUT = pathlib.Path("data/brain1")

FEATURE_NUMERIC = [
    "billed_amount", "pfs_rate_ratio", "units", "days_from_dos_to_submit",
    "diagnosis_pointer_count", "tob_facility_type", "tob_care_setting", "tob_frequency",
    "dos_year", "dos_month", "dos_dow", "facility_payer_pair_hist",
]
FEATURE_CATEGORICAL = [
    "canonical_primary_payer_name", "canonical_primary_payer_family",
    "payer_type", "network_status", "claim_facility_id", "cpt_code", "claim_type",
    "is_behavioral_health",
]
# Labels — NEVER placed in the feature matrix X.
LABELS = ["outcome_class", "days_to_pay", "is_paid_event", "residual_type", "outcome"]

RESIDUAL_TO_CLASS = {"CLEAN": 0, "ALLOWED_GAP": 1, "BALANCE_DUE_INSURANCE": 2, "MATH_GAP": 3}

QUERY = """
SELECT
  bf.charge_debit_id,
  bf.canonical_primary_payer_name,
  bf.canonical_primary_payer_family,
  bf.payer_type,
  bf.network_status,
  bf.participates_in_era,
  bf.claim_facility_id,
  bf.cpt_code,
  bf.rev_code,
  bf.tos_code,
  bf.units,
  bf.diagnosis_pointer_count,
  bf.tob_facility_type,
  bf.tob_care_setting,
  bf.tob_frequency,
  bf.claim_type,
  bf.billed_amount,
  bf.dos,
  bf.dos_year,
  bf.dos_month,
  bf.dos_dow,
  bf.insurance_billing_lag      AS days_from_dos_to_submit,
  bf.outcome,
  bf.residual_type,
  bf.days_to_pay,
  bf.is_training_eligible,
  bf.label_is_terminal,
  pfs.facility_rate
FROM staging.brain1_features bf
LEFT JOIN LATERAL (
  SELECT avg(facility_rate) AS facility_rate
  FROM ref.cms_pfs_rate r
  WHERE r.hcpcs_code = bf.cpt_code AND r.year = 2026
) pfs ON true
WHERE bf.business_entity_id = %(beid)s
"""


def connect():
    url = os.environ["CLAIMS_READER_DATABASE_URL"]
    conn = psycopg2.connect(url)
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.business_entity_id', %s, false)", (BEID,))
    return conn


def build() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        df = pd.read_sql(QUERY, conn, params={"beid": BEID})
    finally:
        conn.close()

    # ---- labels ----
    df["outcome_class"] = df["residual_type"].map(RESIDUAL_TO_CLASS)
    # PENDING / non-terminal rows have no settled outcome -> drop from supervised set.
    df = df[df["label_is_terminal"] & df["outcome_class"].notna()].copy()
    # days_to_pay regression target is meaningful only when actually paid.
    df["is_paid_event"] = df["days_to_pay"].notna().astype(int)

    # ---- derived features ----
    df["is_behavioral_health"] = (
        df["cpt_code"].str.startswith("H", na=False)
        | df["cpt_code"].between("90791", "90899", inclusive="both")
    ).astype(int)
    df["pfs_rate_ratio"] = (df["billed_amount"] / df["facility_rate"]).where(
        df["facility_rate"].notna() & (df["facility_rate"] != 0)
    )
    # Volume proxy: prior count of this facility x payer pair, in DOS order (no look-ahead).
    df = df.sort_values("dos")
    df["facility_payer_pair_hist"] = df.groupby(
        ["claim_facility_id", "canonical_primary_payer_name"]
    ).cumcount()

    # ---- TIME-BASED split (not random) ----
    df = df.sort_values("dos").reset_index(drop=True)
    cutoff_idx = int(len(df) * 0.8)
    cutoff_date = df.loc[cutoff_idx, "dos"]
    print(f"[feature_engineering] rows={len(df)} time-split cutoff DOS={cutoff_date}")
    train = df[df["dos"] < cutoff_date]
    test = df[df["dos"] >= cutoff_date]

    print("[feature_engineering] outcome_class distribution (train):")
    print(train["outcome_class"].value_counts().sort_index().to_string())

    feature_cols = FEATURE_NUMERIC + FEATURE_CATEGORICAL
    for name, part in (("train", train), ("test", test)):
        part[feature_cols].to_parquet(OUT / f"X_{name}.parquet", index=False)
        part[LABELS].to_parquet(OUT / f"y_{name}.parquet", index=False)
    # survival frame for Cox (paid + censored)
    df[["days_to_pay", "is_paid_event", "canonical_primary_payer_family",
        "is_behavioral_health", "pfs_rate_ratio", "tob_frequency"]].to_parquet(
        OUT / "survival_df.parquet", index=False)
    print(f"[feature_engineering] wrote parquet to {OUT}/  (train={len(train)} test={len(test)})")


if __name__ == "__main__":
    build()
