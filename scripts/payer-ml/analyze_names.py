"""
Character-level payer-name drift analysis (non-PHI: payer NAME strings only).

Corpus: every distinct payer spelling in (a) VOB intake (vob.indigo_vob),
(b) BXR claims, (c) Indigo claims — with volumes and first/last-seen dates.

Techniques:
  - sklearn TfidfVectorizer (char 2-4 grams) + cosine  -> candidate pairs
  - rapidfuzz token_sort_ratio                          -> confirm merges
  - union-find                                          -> spelling clusters
  - per-pair edit taxonomy                              -> WHAT kind of character
    change actually happens (punctuation, state suffix, plan suffix, typo, ...)
  - variant-emergence timeline                          -> WHEN new spellings appear
  - crosswalk audit vs ref.payer_alias_map              -> conflicts + gaps

Run:  venv/bin/python scripts/payer-ml/analyze_names.py
"""
from __future__ import annotations

import json
import re
import sys

import numpy as np
import pandas as pd
from rapidfuzz import fuzz
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from _common import OUT, RESULTS, family_of, norm_name

MERGE_RATIO = 88.0          # rapidfuzz token_sort_ratio floor for a merge
COSINE_CANDIDATE = 0.60     # char-ngram cosine floor to even consider a pair

STATES = {"ALABAMA","ALASKA","ARIZONA","ARKANSAS","CALIFORNIA","COLORADO","CONNECTICUT",
"DELAWARE","FLORIDA","GEORGIA","HAWAII","IDAHO","ILLINOIS","INDIANA","IOWA","KANSAS",
"KENTUCKY","LOUISIANA","MAINE","MARYLAND","MASSACHUSETTS","MICHIGAN","MINNESOTA",
"MISSISSIPPI","MISSOURI","MONTANA","NEBRASKA","NEVADA","TEXAS","UTAH","VERMONT",
"VIRGINIA","WASHINGTON","WISCONSIN","WYOMING","OHIO","OKLAHOMA","OREGON","PENNSYLVANIA",
"TENNESSEE","GA","TX","CA","IL","NY","NJ","PA","FL","OH","MI","MN","MO","MS","NC","SC",
"TN","VA","WA","WI","AZ","AL","AR","CO","CT","DE","IA","ID","IN","KS","KY","LA","MA",
"MD","ME","MT","ND","NE","NH","NM","NV","OK","OR","RI","SD","UT","VT","WV","WY"}
PLAN_WORDS = {"HMO","PPO","EPO","POS","HDHP","MEDICARE","MEDICAID","ADVANTAGE","SELECT",
"CHOICE","PLUS","PREMIER","COMPLETE","GOLD","SILVER","BRONZE","EXCHANGE","MARKETPLACE",
"FEDERAL","STATE","GROUP","INDIVIDUAL","COMMERCIAL","SUPPLEMENT","SUPPLEMENTAL"}
NOISE_WORDS = {"THE","OF","INC","LLC","CO","COMPANY","CORP","CORPORATION","HEALTH",
"HEALTHCARE","INSURANCE","INS","PLAN","PLANS","BENEFITS","ADMINISTRATORS","ADMIN",
"SERVICES","GRP"}


def classify_pair(a: str, b: str) -> str:
    """Taxonomy of the character-level difference between two clustered spellings."""
    na, nb = norm_name(a), norm_name(b)
    if na == nb:
        return "punctuation/spacing only"
    ta, tb = set(na.split()), set(nb.split())
    diff = ta ^ tb
    if not diff:
        return "word order"
    if diff <= STATES:
        return "state qualifier"
    if diff <= PLAN_WORDS:
        return "plan/product qualifier"
    if diff <= NOISE_WORDS:
        return "boilerplate words (THE/INC/HEALTH...)"
    if re.fullmatch(r"[A-Z0-9 ]*\d+[A-Z0-9 ]*", " ".join(diff)):
        return "numeric/id token"
    if ta <= tb or tb <= ta:
        return "extension (one contains the other)"
    if fuzz.ratio(na, nb) >= 90:
        return "typo/spelling (edit distance small)"
    return "abbreviation/other"


class DSU:
    def __init__(self, n):
        self.p = list(range(n))
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def main() -> int:
    RESULTS.mkdir(parents=True, exist_ok=True)

    # ── corpus assembly ────────────────────────────────────────────────────────
    vob = pd.read_csv(OUT / "vob_spellings.csv", parse_dates=["first_seen", "last_seen"])
    vob = vob.rename(columns={"vobs": "volume"})[["spelling", "first_seen", "last_seen", "volume"]]
    vob["source"] = "VOB"
    frames = [vob]
    for ent in ("BXR", "INDIGO"):
        c = pd.read_csv(OUT / f"exp_spellings_{ent}.csv", parse_dates=["first_seen", "last_seen"])
        c = c.rename(columns={"lines": "volume"})[["spelling", "first_seen", "last_seen", "volume"]]
        c["source"] = f"CLAIMS-{ent}"
        frames.append(c)
    corpus = pd.concat(frames, ignore_index=True)
    corpus["spelling"] = corpus["spelling"].astype(str)

    # one row per (spelling) with per-source presence
    agg = (corpus.groupby("spelling")
           .agg(first_seen=("first_seen", "min"), last_seen=("last_seen", "max"),
                volume=("volume", "sum"),
                sources=("source", lambda s: sorted(set(s))))
           .reset_index())
    spellings = agg["spelling"].tolist()
    n = len(spellings)
    print(f"corpus: {n} distinct spellings "
          f"({(agg['sources'].map(len) > 1).sum()} appear in >1 source)")

    # ── candidate pairs: char n-gram tf-idf cosine ─────────────────────────────
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=1)
    X = vec.fit_transform([norm_name(s) for s in spellings])
    sim = cosine_similarity(X, dense_output=False)

    dsu = DSU(n)
    pair_class: dict[str, int] = {}
    edges = 0
    coo = sim.tocoo()
    for i, j, v in zip(coo.row, coo.col, coo.data):
        if i >= j or v < COSINE_CANDIDATE:
            continue
        r = fuzz.token_sort_ratio(norm_name(spellings[i]), norm_name(spellings[j]))
        if r >= MERGE_RATIO or (v >= 0.92 and r >= 80):
            dsu.union(i, j)
            kind = classify_pair(spellings[i], spellings[j])
            pair_class[kind] = pair_class.get(kind, 0) + 1
            edges += 1
    print(f"merge edges: {edges}")

    # ── clusters ───────────────────────────────────────────────────────────────
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(dsu.find(i), []).append(i)

    clusters = []
    for members in groups.values():
        rows = agg.iloc[members].sort_values("volume", ascending=False)
        label = rows.iloc[0]["spelling"]
        clusters.append({
            "label": label,
            "family": family_of(label),
            "n_variants": len(rows),
            "volume": int(rows["volume"].sum()),
            "sources": sorted(set(s for ss in rows["sources"] for s in ss)),
            "first_seen": str(rows["first_seen"].min())[:10],
            "members": [{
                "spelling": r["spelling"], "volume": int(r["volume"]),
                "first_seen": str(r["first_seen"])[:10],
                "sources": r["sources"],
            } for _, r in rows.iterrows()],
        })
    clusters.sort(key=lambda c: (-c["n_variants"], -c["volume"]))
    multi = [c for c in clusters if c["n_variants"] > 1]
    print(f"clusters: {len(clusters)} total, {len(multi)} with >1 spelling")

    # ── variant-emergence timeline (per year, cluster births vs variant births) ─
    births = []
    for c in multi:
        first = min(m["first_seen"] for m in c["members"])
        for m in c["members"]:
            births.append({"year": m["first_seen"][:4],
                           "kind": "new payer" if m["first_seen"] == first else "new VARIANT of known payer"})
    bdf = pd.DataFrame(births)
    timeline = (bdf.groupby(["year", "kind"]).size().unstack(fill_value=0).sort_index()
                if len(bdf) else pd.DataFrame())

    # ── crosswalk audit ────────────────────────────────────────────────────────
    alias = pd.read_csv(OUT / "ref_alias_map.csv")
    ident = pd.read_csv(OUT / "ref_payer_identity.csv").set_index("canonical_payer_id")
    amap: dict[str, set] = {}
    for _, r in alias.iterrows():
        amap.setdefault(str(r["alias_norm"]), set()).add(str(r["canonical_payer_id"]))
    conflicts, gaps = [], []
    for c in multi:
        ids = set()
        for m in c["members"]:
            ids |= amap.get(m["spelling"], set())
        mapped = sum(1 for m in c["members"] if m["spelling"] in amap)
        if len(ids) > 1:
            disp = [str(ident["display_name"].get(i, i)) for i in sorted(ids)]
            conflicts.append({"label": c["label"], "n_variants": c["n_variants"],
                              "volume": c["volume"], "canonical_ids": disp})
        if mapped == 0 and c["volume"] >= 100:
            gaps.append({"label": c["label"], "n_variants": c["n_variants"],
                         "volume": c["volume"], "sources": c["sources"]})

    # ── front-door vs back-door naming (VOB-only vs claims-only clusters) ──────
    vob_only = [c for c in clusters if c["sources"] == ["VOB"] and c["volume"] >= 200]
    claims_only = [c for c in clusters
                   if "VOB" not in c["sources"] and c["volume"] >= 2000]

    res = {
        "corpus_size": n,
        "merge_edges": edges,
        "edit_taxonomy": dict(sorted(pair_class.items(), key=lambda kv: -kv[1])),
        "n_clusters": len(clusters),
        "n_multi_variant": len(multi),
        "top_drifty": [{k: c[k] for k in ("label", "family", "n_variants", "volume", "sources", "members")}
                       for c in multi[:20]],
        "variant_timeline": {str(y): {str(k): int(v) for k, v in row.items()}
                             for y, row in timeline.iterrows()} if len(timeline) else {},
        "n_conflicts_total": len(conflicts),
        "n_gaps_total": len(gaps),
        "crosswalk_conflicts": sorted(conflicts, key=lambda d: -d["volume"])[:15],
        "crosswalk_gaps": sorted(gaps, key=lambda d: -d["volume"])[:15],
        "vob_only_payers": [{k: c[k] for k in ("label", "n_variants", "volume")} for c in vob_only[:15]],
        "claims_only_payers": [{k: c[k] for k in ("label", "n_variants", "volume")} for c in claims_only[:15]],
    }
    path = RESULTS / "names.json"
    path.write_text(json.dumps(res, indent=1, default=str))
    print(f"wrote {path}")

    print("\nedit taxonomy (what character-level changes actually happen):")
    for k, v in res["edit_taxonomy"].items():
        print(f"  {k:<42}{v}")
    print("\nmost drifty payers (variant count):")
    for c in multi[:10]:
        print(f"  {c['n_variants']:>3} variants  {c['label'][:44]:<46}{c['volume']:>8} rows  {'+'.join(c['sources'])}")
    print(f"\ncrosswalk conflicts: {len(conflicts)}  |  high-volume unmapped clusters: {len(gaps)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
