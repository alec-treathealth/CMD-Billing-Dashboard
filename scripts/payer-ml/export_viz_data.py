"""
Distill out/results/*.json + aggregate CSVs into out/results/viz-data.json —
exactly the series the insights dashboard embeds. All payer-level aggregates.

Run:  venv/bin/python scripts/payer-ml/export_viz_data.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pandas as pd

from _common import OUT, RESULTS, SINCE, family_of

# Windowed runs reuse the FULL-HISTORY name clustering (a payer first seen in
# 2019 must not masquerade as "new in the window") — point this at out/results/
# names.json and emergence stats get scoped to SINCE below.
NAMES_JSON = Path(os.environ.get("PAYER_ML_NAMES_JSON") or (RESULTS / "names.json"))

CODE_LABEL = {"—": "(no CPT)"}

# Fixed slot order — color follows the entity across every chart.
FAMILY_SLOTS = [
    "Blues (BCBS/Anthem)", "UnitedHealth", "Aetna/CVS", "Cigna/Evernorth",
    "Other/Regional", "Carelon/Beacon", "Magellan", "Kaiser",
]


def book_code_shares(ent: str, top_n=6) -> dict:
    df = pd.read_csv(OUT / f"exp_payer_cpt_q_{ent}.csv", parse_dates=["svc_quarter"])
    df = df[df["svc_quarter"] < df["svc_quarter"].max()]  # drop partial quarter
    df["cpt"] = df["cpt"].replace(CODE_LABEL)
    piv = df.pivot_table(index="svc_quarter", columns="cpt", values="lines",
                         aggfunc="sum", fill_value=0)
    top = piv.sum().nlargest(top_n).index.tolist()
    other = piv.drop(columns=top).sum(axis=1)
    piv = piv[top].assign(Other=other)
    shares = piv.div(piv.sum(axis=1), axis=0)
    return {
        "quarters": [str(q)[:10] for q in shares.index],
        "codes": list(shares.columns),
        "shares": [[round(float(v), 4) for v in row] for row in shares.to_numpy()],
    }


def family_charge_lines(ent: str, fams: list[str]) -> dict:
    df = pd.read_csv(OUT / f"exp_payer_month_{ent}.csv", parse_dates=["svc_month"])
    df["family"] = df["payer"].map(family_of)
    df = df[df["svc_month"] < df["svc_month"].max()]
    out = {}
    for fam in fams:
        s = df[df["family"] == fam].groupby("svc_month")["charge"].sum().asfreq("MS").fillna(0)
        out[fam] = {"months": [str(m)[:10] for m in s.index],
                    "charge": [round(float(v), 0) for v in s]}
    return out


def main() -> int:
    b = json.load(open(RESULTS / "behavior.json"))
    n = json.load(open(NAMES_JSON))

    viz: dict = {"family_slots": FAMILY_SLOTS}

    # KPIs
    drv = b["paid_rate_drivers"]
    viz["kpis"] = {
        "spellings": n["corpus_size"],
        "clusters": n["n_clusters"],
        "multi_variant": n["n_multi_variant"],
        "changepoints": len(b["changepoints"]),
        "anomalies": len(b["anomalies"]),
        "r2_random": drv["r2_random_split"],
        "r2_temporal": drv["r2_temporal_split"],
    }

    # payer mix (monthly shares, from behavior.json)
    viz["mix"] = {ent: {k: b["mix"][ent][k] for k in ("months", "families", "shares", "jsd_mom")}
                  for ent in ("BXR", "INDIGO")}
    viz["mix_movers"] = {ent: b["mix"][ent]["movers"][:6] for ent in ("BXR", "INDIGO")}

    # volume regime lines + their change points
    fams_by_ent = {"BXR": ["Blues (BCBS/Anthem)", "UnitedHealth", "Aetna/CVS", "Cigna/Evernorth"],
                   "INDIGO": ["Blues (BCBS/Anthem)", "UnitedHealth", "Aetna/CVS", "Cigna/Evernorth"]}
    viz["volume"] = {}
    for ent, fams in fams_by_ent.items():
        lines = family_charge_lines(ent, fams)
        brks = [cp for cp in b["changepoints"]
                if cp["entity"] == ent and cp["metric"] == "monthly_charge" and cp["family"] in fams]
        viz["volume"][ent] = {"lines": lines,
                              "breaks": [{"family": c["family"], "month": c["break_month"]} for c in brks]}
    if SINCE:
        # window edition: Kaiser's Indigo regime flip deserves its own panel —
        # it is invisible on the Blues-scaled axis (one axis, never two).
        viz["volume"]["KAISER_INDIGO"] = {
            "lines": family_charge_lines("INDIGO", ["Kaiser"]),
            "breaks": [{"family": c["family"], "month": c["break_month"]}
                       for c in b["changepoints"]
                       if c["entity"] == "INDIGO" and c["family"] == "Kaiser"
                       and c["metric"] == "monthly_charge"],
        }

    # the code migration (book level)
    viz["code_migration"] = {ent: book_code_shares(ent) for ent in ("BXR", "INDIGO")}

    # paid-rate dumbbells (top shifts with volume floor)
    shifts = []
    for ent in ("BXR", "INDIGO"):
        for s in b["code_mix_cpt"][ent]["paid_rate_shifts"]:
            # '—' rows are uncoded charge lines (a CMD report artifact) — footnoted
            # in the dashboard, not charted as if they were a real code.
            floor = 250 if SINCE else 400
            if s["lines"] >= floor and s["code"] != "—":
                shifts.append({**s, "entity": ent})
    shifts.sort(key=lambda d: -abs(d["delta"]))
    viz["rate_shifts"] = shifts[:12]

    # payment lag (BXR claim_line families — its own taxonomy)
    keep = ["CIGNA", "AETNA", "UNITED", "ANTHEM", "BCBS", "MEDICAID"]
    viz["lag"] = {f: {k: b["lag_drift_bxr"][f][k] for k in ("months", "med_lag", "early_med", "late_med", "breaks")}
                  for f in keep if f in b["lag_drift_bxr"]}

    # CARC heatmap: family x code, share of family's positive adjustment $
    carc = b["carc_snapshot_bxr"]
    fams = [f for f in carc if f not in ("(unmapped)",)][:6]
    codes: list[str] = []
    for f in fams:
        for t in carc[f]["top_codes"][:5]:
            if t["code"] not in codes:
                codes.append(t["code"])
    matrix, descs = [], {}
    for f in fams:
        total = max(carc[f]["total_adjustment"], 1e-9)
        by = {t["code"]: t for t in carc[f]["top_codes"]}
        row = []
        for c in codes:
            t = by.get(c)
            row.append(round(t["amount"] / total, 4) if t else 0.0)
            if t and t["desc"]:
                descs[c] = t["desc"]
        matrix.append(row)
    viz["carc"] = {"families": fams, "codes": codes, "share": matrix, "descs": descs,
                   "totals": {f: carc[f]["total_adjustment"] for f in fams}}

    # forecasts (small multiples; only decent backtests)
    viz["forecast"] = {}
    for ent in ("BXR", "INDIGO"):
        for fam, d in b["forecast"][ent].items():
            if d["backtest_mape"] is not None and d["backtest_mape"] <= 0.30:
                viz["forecast"][f"{ent} · {fam}"] = d
    # cap at 4 panels, ordered by mape
    best = sorted(viz["forecast"].items(), key=lambda kv: kv[1]["backtest_mape"])[:4]
    viz["forecast"] = dict(best)

    # anomalies table
    viz["anomalies"] = b["anomalies"][:10]

    # names — full-history clustering; emergence stats scoped to SINCE if set
    if SINCE:
        yr0 = SINCE[:4]
        timeline = {y: v for y, v in n["variant_timeline"].items() if y >= yr0}
        drifty = []
        for c in n["top_drifty"]:
            born = [m for m in c["members"] if m["first_seen"] >= SINCE]
            if born:
                drifty.append({"label": c["label"], "n": len(born), "volume": c["volume"]})
        drifty.sort(key=lambda d: -d["n"])
        drifty = drifty[:10]
        viz["kpis"]["variants_born"] = sum(
            v.get("new VARIANT of known payer", 0) for v in timeline.values())
        viz["kpis"]["new_payers_born"] = sum(
            v.get("new payer", 0) for v in timeline.values())
    else:
        timeline = n["variant_timeline"]
        drifty = [{"label": c["label"], "n": c["n_variants"], "volume": c["volume"]}
                  for c in n["top_drifty"][:10]]
    viz["names"] = {
        "timeline": timeline,
        "taxonomy": n["edit_taxonomy"],
        "drifty": drifty,
        "drifty_is_window": bool(SINCE),
        "conflicts": n.get("n_conflicts_total", len(n["crosswalk_conflicts"])),
        "gaps": n["crosswalk_gaps"],
        "vob_only": n["vob_only_payers"][:5],
    }

    viz["model"] = {
        "importance": drv["permutation_importance"],
        "family_rate": drv["family_predicted_rate"],
        "n": drv["n_rows"],
    }

    path = RESULTS / "viz-data.json"
    path.write_text(json.dumps(viz, indent=0))
    print(f"wrote {path} ({path.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
