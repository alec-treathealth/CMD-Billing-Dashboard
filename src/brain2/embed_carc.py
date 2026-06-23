"""
Brain 2 — CARC/RARC embedding (Phase 2-A/2-B).

Embeds every ref.carc_code + ref.rarc_code row with BGE-M3 (dense 1024 + sparse
SPLADE), UPSERTs into ref.carc_embeddings / ref.rarc_embeddings, and mirrors the
dense vector onto ref.carc_code.embedding for collocated retrieval. Verifies by
printing the top-5 nearest neighbours of CARC '45'.

Writes as claims_admin. halfvec passed as a bracketed string and cast ::halfvec.
"""
from __future__ import annotations

import os
import json

import psycopg2
from psycopg2.extras import execute_values, Json
from sentence_transformers import SentenceTransformer

MODEL_NAME = "BAAI/bge-m3"
MODEL_VERSION = "bge-m3"


def vec_literal(v) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in v) + "]"


def load_codes(conn, table: str, code_col: str):
    with conn.cursor() as cur:
        cur.execute(f"select {code_col}, short_description from ref.{table} order by {code_col}")
        return cur.fetchall()


def encode(model, texts):
    out = model.encode(texts, batch_size=64, normalize_embeddings=True,
                       return_dense=True, return_sparse=True)
    # sentence-transformers BGE-M3 router returns a dict with these keys.
    dense = out["dense_vecs"] if isinstance(out, dict) else out
    sparse = out.get("lexical_weights") if isinstance(out, dict) else [None] * len(texts)
    return dense, sparse


def upsert(conn, table: str, code_col: str, rows):
    with conn.cursor() as cur:
        execute_values(cur,
            f"""insert into ref.{table} ({code_col}, dense_embedding, sparse_weights, model_version)
                values %s
                on conflict ({code_col}) do update set
                  dense_embedding = excluded.dense_embedding,
                  sparse_weights = excluded.sparse_weights,
                  model_version = excluded.model_version, embedded_at = now()""",
            rows, template=f"(%s, %s::halfvec, %s, '{MODEL_VERSION}')")
    conn.commit()


def embed_table(conn, model, table: str, emb_table: str, code_col: str):
    codes = load_codes(conn, table, code_col)
    if not codes:
        print(f"[embed_carc] ref.{table} empty — run carc_rarc_refresh first")
        return
    texts = [f"{c}: {d}" for c, d in codes]
    dense, sparse = encode(model, texts)
    rows = [(codes[i][0], vec_literal(dense[i]),
             Json({str(k): float(v) for k, v in (sparse[i] or {}).items()}))
            for i in range(len(codes))]
    upsert(conn, emb_table, code_col, rows)
    print(f"[embed_carc] {emb_table}: embedded {len(rows)} codes")


def mirror_to_carc_code(conn):
    with conn.cursor() as cur:
        cur.execute("""update ref.carc_code c set embedding = e.dense_embedding
                       from ref.carc_embeddings e where e.carc_code = c.carc_code""")
    conn.commit()


def verify_neighbours(conn, code: str = "45"):
    with conn.cursor() as cur:
        cur.execute("""
            select n.carc_code, c.short_description,
                   1 - (n.dense_embedding <=> q.dense_embedding) as similarity
            from ref.carc_embeddings q
            join ref.carc_embeddings n on n.carc_code <> q.carc_code
            join ref.carc_code c on c.carc_code = n.carc_code
            where q.carc_code = %s
            order by n.dense_embedding <=> q.dense_embedding limit 5""", (code,))
        print(f"[embed_carc] nearest neighbours of CARC {code}:")
        for row in cur.fetchall():
            print(f"   {row[0]:>5}  sim={row[2]:.3f}  {row[1][:70]}")


def main():
    conn = psycopg2.connect(os.environ["CLAIMS_ADMIN_DATABASE_URL"])
    try:
        model = SentenceTransformer(MODEL_NAME)
        embed_table(conn, model, "carc_code", "carc_embeddings", "carc_code")
        embed_table(conn, model, "rarc_code", "rarc_embeddings", "rarc_code")
        mirror_to_carc_code(conn)
        verify_neighbours(conn, "45")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
