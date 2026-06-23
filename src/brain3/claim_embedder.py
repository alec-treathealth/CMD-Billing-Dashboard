"""
Brain 3 — claim signature embedder (Phase 3-B).

Embeds the CLEAN/paid claim pool (outcome_class = 0) as the appeal-evidence
corpus. Signature text is built from CODED, PHI-free columns only — a hard
assertion enforces the allowlist before the encode loop. Writes
staging.claim_signatures via claims_admin. BGE-M3 dense(1024) + sparse.

Real columns: residual_type/charge_debit_id from brain1_features, tob_raw from
claim_line (brain1_features has no tob_raw). outcome_class derived from residual_type.
"""
from __future__ import annotations

import os

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values, Json
from sentence_transformers import SentenceTransformer

BEID = "af504ab6-3dcd-4aa4-a93c-27bc58de4088"
MODEL_NAME = "BAAI/bge-m3"
RESIDUAL_TO_CLASS = {"CLEAN": 0, "ALLOWED_GAP": 1, "BALANCE_DUE_INSURANCE": 2, "MATH_GAP": 3}
ALLOWED_COLS = {
    "canonical_primary_payer_name", "payer_family", "cpt_code",
    "tob_raw", "claim_facility_id", "residual_type", "charge_amount_bucket",
}

QUERY = """
SELECT bf.charge_debit_id, bf.claim_line_id,
       bf.canonical_primary_payer_name,
       bf.canonical_primary_payer_family AS payer_family,
       bf.cpt_code, cl.tob_raw, bf.claim_facility_id,
       bf.residual_type, bf.billed_amount
FROM staging.brain1_features bf
JOIN staging.claim_line cl ON cl.id = bf.claim_line_id
WHERE bf.business_entity_id = %(beid)s AND bf.residual_type = 'CLEAN'
"""


def bucket(amt) -> str:
    if amt is None:
        return "unknown"
    a = float(amt)
    if a < 500: return "$0-500"
    if a < 2000: return "$500-2k"
    if a < 10000: return "$2k-10k"
    return "$10k+"


def vec_literal(v) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in v) + "]"


def main():
    reader = psycopg2.connect(os.environ["CLAIMS_READER_DATABASE_URL"])
    with reader.cursor() as cur:
        cur.execute("SELECT set_config('app.business_entity_id', %s, false)", (BEID,))
    try:
        df = pd.read_sql(QUERY, reader, params={"beid": BEID})
    finally:
        reader.close()
    if df.empty:
        print("[claim_embedder] no CLEAN rows to embed")
        return

    df["outcome_class"] = df["residual_type"].map(RESIDUAL_TO_CLASS)
    df["charge_amount_bucket"] = df["billed_amount"].map(bucket)

    embed_df = df[list(ALLOWED_COLS)]
    assert set(embed_df.columns).issubset(ALLOWED_COLS), "PHI column detected"

    texts = [
        f"{r.payer_family} {r.canonical_primary_payer_name} CPT:{r.cpt_code} "
        f"TOB:{r.tob_raw} {r.charge_amount_bucket} {r.residual_type}"
        for r in df.itertuples()
    ]
    model = SentenceTransformer(MODEL_NAME)
    out = model.encode(texts, batch_size=64, normalize_embeddings=True,
                       return_dense=True, return_sparse=True)
    dense = out["dense_vecs"] if isinstance(out, dict) else out
    sparse = out.get("lexical_weights") if isinstance(out, dict) else [None] * len(texts)

    rows = []
    for i, r in enumerate(df.itertuples()):
        rows.append((BEID, r.charge_debit_id, int(r.claim_line_id) if pd.notna(r.claim_line_id) else None,
                     r.canonical_primary_payer_name, r.payer_family, r.cpt_code, r.tob_raw,
                     r.claim_facility_id, int(r.outcome_class), r.residual_type,
                     r.charge_amount_bucket, vec_literal(dense[i]),
                     Json({str(k): float(v) for k, v in (sparse[i] or {}).items()})))

    admin = psycopg2.connect(os.environ["CLAIMS_ADMIN_DATABASE_URL"])
    try:
        with admin.cursor() as cur:
            for j in range(0, len(rows), 500):
                execute_values(cur,
                    """insert into staging.claim_signatures
                       (business_entity_id, charge_debit_id, claim_line_id,
                        canonical_primary_payer_name, payer_family, cpt_code, tob_raw,
                        claim_facility_id, outcome_class, residual_type, charge_amount_bucket,
                        dense_embedding, sparse_weights) values %s
                       on conflict (business_entity_id, charge_debit_id) do update set
                         dense_embedding = excluded.dense_embedding,
                         sparse_weights = excluded.sparse_weights, embedded_at = now()""",
                    rows[j:j + 500],
                    template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::halfvec,%s)")
        admin.commit()
    finally:
        admin.close()
    print(f"[claim_embedder] embedded={len(rows)} (CLEAN evidence pool) "
          f"outcome_class dist={df['outcome_class'].value_counts().to_dict()}")


if __name__ == "__main__":
    main()
