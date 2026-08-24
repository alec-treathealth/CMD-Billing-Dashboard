"""
Payer behavior ML — temporal analysis over the aggregate pulls in out/.

Everything here operates on payer-level aggregates (no PHI). Techniques:
  - ruptures PELT (rbf kernel)      -> change-point detection per payer family
  - Jensen-Shannon divergence + PSI -> payer-mix / code-mix drift measurement
  - statsmodels Holt-Winters        -> per-family demand forecasts (+backtest)
  - robust MAD z-scores             -> anomalous payer-months
  - sklearn HistGradientBoosting +
    permutation importance          -> what drives % paid

CENSORING GUARD: insurance payments accrue to a service month over time, so
recent service months under-report paid$ and pct_paid. Any paid-rate metric is
computed only on service months at least MATURITY_DAYS old ("mature"). Volume
(lines) and charge$ post at charge entry and are trend-safe after dropping the
partial trailing month.

Run:  venv/bin/python scripts/payer-ml/analyze_behavior.py
"""
from __future__ import annotations

import json
import sys
import warnings
from datetime import date, timedelta

import numpy as np
import pandas as pd
import ruptures as rpt
from scipy.spatial.distance import jensenshannon
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance

from _common import OUT, RESULTS, family_of

warnings.filterwarnings("ignore")

MATURITY_DAYS = 120
TOP_FAMILIES = 12


def jsonable(o):
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else round(float(o), 5)
    if isinstance(o, float):
        return None if np.isnan(o) else round(o, 5)
    if isinstance(o, (pd.Timestamp, date)):
        return str(o)[:10]
    return o


def load_payer_month(ent: str) -> pd.DataFrame:
    df = pd.read_csv(OUT / f"exp_payer_month_{ent}.csv", parse_dates=["svc_month"])
    df["family"] = df["payer"].map(family_of)
    return df


def complete_months(df: pd.DataFrame, col="svc_month") -> pd.DataFrame:
    """Drop the partial trailing calendar month."""
    last = df[col].max()
    return df[df[col] < last]


def mature_cutoff(df: pd.DataFrame, col="svc_month") -> pd.Timestamp:
    return df[col].max() - pd.Timedelta(days=MATURITY_DAYS)


# ── 1. Change points ──────────────────────────────────────────────────────────

def detect_breaks(series: pd.Series, min_len=10, pen=4.0):
    """PELT (rbf) change points on a monthly series -> list of break dicts."""
    s = series.dropna()
    if len(s) < min_len:
        return []
    x = s.to_numpy(dtype=float).reshape(-1, 1)
    # z-normalize so `pen` means the same thing across metrics
    sd = x.std()
    if sd == 0:
        return []
    xn = (x - x.mean()) / sd
    algo = rpt.Pelt(model="rbf", min_size=4, jump=1).fit(xn)
    bkps = algo.predict(pen=pen)[:-1]  # last element is len(x), not a break
    out = []
    for b in bkps:
        before = float(np.mean(x[max(0, b - 6):b]))
        after = float(np.mean(x[b:b + 6]))
        out.append({
            "break_month": str(s.index[b])[:10],
            "before_mean": round(before, 4),
            "after_mean": round(after, 4),
            "rel_change": round((after - before) / abs(before), 4) if before else None,
        })
    return out


def changepoints(ent: str, pm: pd.DataFrame) -> list[dict]:
    comp = complete_months(pm)
    mat = pm[pm["svc_month"] <= mature_cutoff(pm)]
    fam_paid = comp.groupby("family")["paid"].sum().nlargest(TOP_FAMILIES)
    results = []
    for fam in fam_paid.index:
        f_comp = comp[comp["family"] == fam].groupby("svc_month").agg(
            lines=("lines", "sum"), charge=("charge", "sum"), paid=("paid", "sum"))
        f_mat = mat[mat["family"] == fam].groupby("svc_month").agg(
            charge=("charge", "sum"), paid=("paid", "sum"))
        f_mat = f_mat[f_mat["charge"] > 0]
        pct_paid = (f_mat["paid"] / f_mat["charge"]).rename("pct_paid")
        for metric, ser in [
            ("monthly_lines", f_comp["lines"]),
            ("monthly_charge", f_comp["charge"]),
            ("mature_pct_paid", pct_paid),
        ]:
            for br in detect_breaks(ser):
                results.append({"entity": ent, "family": fam, "metric": metric, **br})
    return results


# ── 2. Payer-mix drift ────────────────────────────────────────────────────────

def mix_drift(ent: str, pm: pd.DataFrame) -> dict:
    comp = complete_months(pm)
    top = comp.groupby("family")["charge"].sum().nlargest(9).index
    comp = comp.assign(fam9=np.where(comp["family"].isin(top), comp["family"], "Other"))
    piv = comp.pivot_table(index="svc_month", columns="fam9", values="charge",
                           aggfunc="sum", fill_value=0.0)
    shares = piv.div(piv.sum(axis=1), axis=0)
    months = [str(m)[:10] for m in shares.index]

    jsd = [None]
    for i in range(1, len(shares)):
        jsd.append(round(float(jensenshannon(shares.iloc[i - 1], shares.iloc[i], base=2)), 5))

    base = shares.iloc[:12].mean()  # first-year baseline
    eps = 1e-6
    psi = []
    for i in range(len(shares)):
        cur = shares.iloc[i] + eps
        b = base + eps
        psi.append(round(float(((cur - b) * np.log(cur / b)).sum()), 5))

    n = len(shares)
    first, last = shares.iloc[: max(6, n // 4)].mean(), shares.iloc[-max(6, n // 4):].mean()
    movers = sorted(
        ({"family": f, "share_early": round(float(first[f]), 4),
          "share_late": round(float(last[f]), 4),
          "delta_pp": round(float(last[f] - first[f]) * 100, 2)}
         for f in shares.columns),
        key=lambda d: -abs(d["delta_pp"]))
    return {
        "months": months,
        "families": list(shares.columns),
        "shares": [[round(float(v), 5) for v in row] for row in shares.to_numpy()],
        "jsd_mom": jsd,
        "psi_vs_first_year": psi,
        "movers": movers,
    }


# ── 3. Code-mix shift ─────────────────────────────────────────────────────────

def code_mix(ent: str, kind: str) -> dict:
    df = pd.read_csv(OUT / f"exp_payer_{kind}_q_{ent}.csv", parse_dates=["svc_quarter"])
    code_col = "cpt" if kind == "cpt" else "rev_code"
    df["family"] = df["payer"].map(family_of)
    # maturity from the RAW data edge (the partial quarter encodes "today"),
    # computed BEFORE dropping it — otherwise the newest mature quarter is
    # thrown away and short windows lose their whole comparison year.
    mat_q = mature_cutoff(df, "svc_quarter")
    df = complete_months(df, "svc_quarter")

    fams = df.groupby("family")["paid"].sum().nlargest(10).index
    out = {"families": {}, "adoption": [], "abandonment": [], "paid_rate_shifts": []}
    for fam in fams:
        f = df[df["family"] == fam]
        piv = f.pivot_table(index="svc_quarter", columns=code_col, values="lines",
                            aggfunc="sum", fill_value=0)
        if len(piv) < 4:
            continue
        shares = piv.div(piv.sum(axis=1), axis=0)
        qs = [str(q)[:10] for q in shares.index]
        jsd = [None] + [
            round(float(jensenshannon(shares.iloc[i - 1], shares.iloc[i], base=2)), 5)
            for i in range(1, len(shares))
        ]
        n = len(shares)
        k = max(2, n // 4)
        early, late = shares.iloc[:k].mean(), shares.iloc[-k:].mean()
        delta = (late - early).sort_values()
        top_codes = piv.sum().nlargest(12).index
        out["families"][fam] = {
            "quarters": qs,
            "jsd_qoq": jsd,
            "rising": [{"code": c, "delta_pp": round(float(delta[c]) * 100, 2),
                        "share_late": round(float(late[c]), 4)}
                       for c in delta.index[::-1][:5] if delta[c] > 0.005],
            "falling": [{"code": c, "delta_pp": round(float(delta[c]) * 100, 2),
                         "share_early": round(float(early[c]), 4)}
                        for c in delta.index[:5] if delta[c] < -0.005],
            "top_codes": list(top_codes),
            "shares_top": {c: [round(float(v), 5) for v in shares[c].reindex(piv.index, fill_value=0)]
                           for c in top_codes if c in shares.columns},
        }
        # adoption / abandonment (volume floor 50 lines lifetime)
        life = f.groupby(code_col).agg(first_q=("svc_quarter", "min"),
                                       last_q=("svc_quarter", "max"),
                                       lines=("lines", "sum"))
        life = life[life["lines"] >= 50]
        span_start, span_end = df["svc_quarter"].min(), df["svc_quarter"].max()
        for c, r in life.iterrows():
            if r["first_q"] > span_start + pd.Timedelta(days=365):
                out["adoption"].append({"family": fam, "code": c,
                                        "first_quarter": str(r["first_q"])[:10],
                                        "lines": int(r["lines"])})
            if r["last_q"] < span_end - pd.Timedelta(days=200):
                out["abandonment"].append({"family": fam, "code": c,
                                           "last_quarter": str(r["last_q"])[:10],
                                           "lines": int(r["lines"])})
        # paid-rate shift per code, mature quarters, by year
        fm = f[(f["svc_quarter"] <= mat_q)]
        fm = fm.assign(yr=fm["svc_quarter"].dt.year)
        g = fm.groupby([code_col, "yr"]).agg(charge=("charge", "sum"), paid=("paid", "sum"),
                                             lines=("lines", "sum")).reset_index()
        g = g[(g["charge"] > 0) & (g["lines"] >= 30)]
        g["rate"] = g["paid"] / g["charge"]
        for c, grp in g.groupby(code_col):
            if len(grp) >= 2:
                grp = grp.sort_values("yr")
                d = float(grp["rate"].iloc[-1] - grp["rate"].iloc[0])
                if abs(d) >= 0.10:
                    out["paid_rate_shifts"].append({
                        "family": fam, "code": c,
                        "year_from": int(grp["yr"].iloc[0]), "rate_from": round(float(grp["rate"].iloc[0]), 3),
                        "year_to": int(grp["yr"].iloc[-1]), "rate_to": round(float(grp["rate"].iloc[-1]), 3),
                        "delta": round(d, 3), "lines": int(grp["lines"].sum()),
                    })
    out["adoption"] = sorted(out["adoption"], key=lambda d: -d["lines"])[:25]
    out["abandonment"] = sorted(out["abandonment"], key=lambda d: -d["lines"])[:25]
    out["paid_rate_shifts"] = sorted(out["paid_rate_shifts"], key=lambda d: -abs(d["delta"]))[:30]
    return out


# ── 4. Payment-lag drift (BXR claim_line) ─────────────────────────────────────

def lag_drift() -> dict:
    df = pd.read_csv(OUT / "cl_lag_payer_month.csv", parse_dates=["pay_month"])
    df = complete_months(df, "pay_month")
    fams = (df.groupby("family")["lines"].sum().nlargest(10)).index
    out = {}
    for fam in fams:
        f = df[df["family"] == fam].set_index("pay_month").sort_index()
        f = f[f["lines"] >= 10]
        if len(f) < 8:
            continue
        breaks = detect_breaks(f["med_lag"], min_len=8)
        n = len(f)
        k = max(3, n // 4)
        out[fam] = {
            "months": [str(m)[:10] for m in f.index],
            "med_lag": [round(float(v), 1) for v in f["med_lag"]],
            "p25": [round(float(v), 1) for v in f["p25_lag"]],
            "p75": [round(float(v), 1) for v in f["p75_lag"]],
            "lines": [int(v) for v in f["lines"]],
            "early_med": round(float(f["med_lag"].iloc[:k].mean()), 1),
            "late_med": round(float(f["med_lag"].iloc[-k:].mean()), 1),
            "breaks": breaks,
        }
    return out


# ── 5. Forecast (demand) + expected paid ──────────────────────────────────────

def forecast(ent: str, pm: pd.DataFrame) -> dict:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    comp = complete_months(pm)
    mat = pm[pm["svc_month"] <= mature_cutoff(pm)]
    fams = comp.groupby("family")["paid"].sum().nlargest(8).index
    out = {}
    for fam in fams:
        s = (comp[comp["family"] == fam].groupby("svc_month")["charge"].sum()
             .asfreq("MS").fillna(0.0))
        if len(s) < 18:
            continue
        seasonal = "add" if len(s) >= 30 else None
        kw = dict(trend="add", seasonal=seasonal)
        if seasonal:
            kw["seasonal_periods"] = 12
        # backtest: hold out last 4 months
        try:
            m_bt = ExponentialSmoothing(s.iloc[:-4], **kw).fit()
            bt = m_bt.forecast(4)
            actual = s.iloc[-4:]
            denom = actual.replace(0, np.nan)
            mape = float((np.abs(bt.to_numpy() - actual.to_numpy()) / denom.to_numpy()).mean()) # noqa
            model = ExponentialSmoothing(s, **kw).fit()
            fc = model.forecast(4)
            resid_sd = float((s - model.fittedvalues).std())
        except Exception:
            continue
        # expected paid = demand forecast x recent mature paid-rate
        fmat = mat[mat["family"] == fam]
        rate = float(fmat["paid"].sum() / fmat["charge"].sum()) if fmat["charge"].sum() > 0 else np.nan
        recent = fmat[fmat["svc_month"] >= fmat["svc_month"].max() - pd.Timedelta(days=365)]
        rate_recent = (float(recent["paid"].sum() / recent["charge"].sum())
                       if recent["charge"].sum() > 0 else rate)
        out[fam] = {
            "months": [str(m)[:10] for m in s.index],
            "charge": [round(float(v), 2) for v in s],
            "forecast_months": [str(m)[:10] for m in fc.index],
            "forecast_charge": [round(max(0.0, float(v)), 2) for v in fc],
            "band80": round(1.2816 * resid_sd, 2),
            "backtest_mape": None if np.isnan(mape) else round(mape, 4),
            "mature_paid_rate_recent": None if np.isnan(rate_recent) else round(rate_recent, 4),
            "expected_paid_next4": None if np.isnan(rate_recent) else round(
                float(sum(max(0.0, v) for v in fc) * rate_recent), 2),
        }
    return out


# ── 6. Anomalous payer-months ─────────────────────────────────────────────────

def anomalies(ent: str, pm: pd.DataFrame) -> list[dict]:
    mat = pm[pm["svc_month"] <= mature_cutoff(pm)]
    fams = mat.groupby("family")["paid"].sum().nlargest(TOP_FAMILIES).index
    out = []
    for fam in fams:
        f = mat[mat["family"] == fam].groupby("svc_month").agg(
            charge=("charge", "sum"), paid=("paid", "sum"))
        f = f[f["charge"] > 0]
        if len(f) < 12:
            continue
        r = (f["paid"] / f["charge"])
        med = r.rolling(7, center=True, min_periods=3).median()
        resid = r - med
        mad = float(np.median(np.abs(resid.dropna() - np.median(resid.dropna()))))
        if mad == 0:
            continue
        z = 0.6745 * resid / mad
        for m, zv in z.items():
            if abs(zv) >= 3.0:
                out.append({"entity": ent, "family": fam, "month": str(m)[:10],
                            "pct_paid": round(float(r[m]), 4),
                            "typical": round(float(med[m]), 4),
                            "z": round(float(zv), 1)})
    return sorted(out, key=lambda d: -abs(d["z"]))[:40]


# ── 7. Denial (CARC) snapshot — BXR ERA, one month of data ────────────────────

def carc_snapshot() -> dict:
    df = pd.read_csv(OUT / "era_carc_payer.csv")
    ref = pd.read_csv(OUT / "ref_carc.csv").set_index("carc_code")["short_description"]
    df["family"] = df["payer"].map(family_of)
    df["carc"] = df["group_code"].astype(str) + "-" + df["carc_code"].astype(str)
    fams = df.groupby("family")["adj_amount"].sum().abs().nlargest(10).index
    out = {}
    for fam in fams:
        f = df[df["family"] == fam]
        total = float(f["adj_amount"].sum())
        g = (f.groupby(["group_code", "carc_code"])
             .agg(amount=("adj_amount", "sum"), lines=("adj_lines", "sum"))
             .reset_index().sort_values("amount", ascending=False))
        top = [{
            "code": f"{r.group_code}-{r.carc_code}",
            "desc": str(ref.get(str(r.carc_code), ref.get(r.carc_code, "")))[:90],
            "amount": round(float(r.amount), 2),
            "lines": int(r.lines),
            "pct_of_adj": round(float(r.amount) / total, 4) if total else None,
        } for r in g.head(8).itertuples()]
        shares = (g["amount"].clip(lower=0) / max(total, 1e-9)) if total > 0 else g["amount"] * 0
        out[fam] = {"total_adjustment": round(total, 2),
                    "hhi": round(float((shares ** 2).sum()), 4),
                    "top_codes": top}
    return out


# ── 8. Claim-status drift ─────────────────────────────────────────────────────

def status_drift(ent: str) -> dict:
    df = pd.read_csv(OUT / f"exp_payer_status_month_{ent}.csv", parse_dates=["svc_month"])
    df["family"] = df["payer"].map(family_of)
    df = complete_months(df)
    piv = df.pivot_table(index=["family", "svc_month"], columns="status_cat",
                         values="lines", aggfunc="sum", fill_value=0)
    piv = piv.div(piv.sum(axis=1), axis=0).reset_index()
    deny_cols = [c for c in piv.columns
                 if isinstance(c, str) and ("DEN" in c.upper() or "REJECT" in c.upper())]
    if not deny_cols:
        return {"note": "no denial-like status categories present", "risers": []}
    piv["deny_share"] = piv[deny_cols].sum(axis=1)
    out = []
    for fam, f in piv.groupby("family"):
        f = f.sort_values("svc_month")
        if len(f) < 10 or f["deny_share"].sum() == 0:
            continue
        n = len(f)
        k = max(3, n // 4)
        early, late = float(f["deny_share"].iloc[:k].mean()), float(f["deny_share"].iloc[-k:].mean())
        out.append({"family": fam, "deny_share_early": round(early, 4),
                    "deny_share_late": round(late, 4),
                    "delta_pp": round((late - early) * 100, 2),
                    "months": [str(m)[:10] for m in f["svc_month"]],
                    "deny_share": [round(float(v), 4) for v in f["deny_share"]]})
    out.sort(key=lambda d: -abs(d["delta_pp"]))
    return {"deny_categories": deny_cols, "risers": out[:12]}


# ── 9. What drives %-paid — gradient boosting + permutation importance ───────

def paid_rate_drivers() -> dict:
    frames = []
    for ent in ("BXR", "INDIGO"):
        d = pd.read_csv(OUT / f"exp_payer_cpt_q_{ent}.csv", parse_dates=["svc_quarter"])
        d["entity"] = ent
        frames.append(d)
    df = pd.concat(frames)
    df["family"] = df["payer"].map(family_of)
    cut = df["svc_quarter"].max() - pd.Timedelta(days=MATURITY_DAYS)
    df = df[(df["svc_quarter"] <= cut) & (df["charge"] > 0) & (df["lines"] >= 20)]
    df["rate"] = (df["paid"] / df["charge"]).clip(0, 1.2)
    top_f = df.groupby("family")["lines"].sum().nlargest(12).index
    top_c = df.groupby("cpt")["lines"].sum().nlargest(25).index
    df["fam_c"] = np.where(df["family"].isin(top_f), df["family"], "OTHER_FAM")
    df["cpt_c"] = np.where(df["cpt"].isin(top_c), df["cpt"], "OTHER_CPT")
    df["t"] = (df["svc_quarter"].dt.year - 2018) * 4 + (df["svc_quarter"].dt.quarter - 1)
    X = df[["fam_c", "cpt_c", "entity", "t"]].copy()
    for c in ("fam_c", "cpt_c", "entity"):
        X[c] = X[c].astype("category")
    y = df["rate"].to_numpy()
    w = df["lines"].to_numpy(dtype=float)

    def fit_score(tr_mask, te_mask):
        m = HistGradientBoostingRegressor(categorical_features="from_dtype",
                                          max_iter=300, learning_rate=0.08,
                                          random_state=11)
        m.fit(X[tr_mask], y[tr_mask], sample_weight=w[tr_mask])
        return m, float(m.score(X[te_mask], y[te_mask], sample_weight=w[te_mask]))

    # (a) random split -> explanatory power: how much of paid-rate variance the
    #     features explain at all.  (b) temporal split (last 3 mature quarters
    #     held out) -> forecastability: does history predict the newest behavior.
    rng = np.random.RandomState(11)
    rand_te = rng.rand(len(df)) < 0.25
    model, r2_rand = fit_score(~rand_te, rand_te)
    tmax = df["t"].max()
    _, r2_temporal = fit_score(df["t"] < tmax - 2, df["t"] >= tmax - 2)

    imp = permutation_importance(model, X[rand_te], y[rand_te], sample_weight=w[rand_te],
                                 n_repeats=8, random_state=11)
    features = [{"feature": f, "importance": round(float(m), 4)}
                for f, m in zip(X.columns, imp.importances_mean)]
    features.sort(key=lambda d: -d["importance"])
    # per-family partial effect: weighted mean predicted rate by family (test rows)
    te_df = X[rand_te].assign(pred=model.predict(X[rand_te]), w=w[rand_te])
    fam_pred = (te_df.groupby("fam_c", observed=True)
                .apply(lambda g: float(np.average(g["pred"], weights=g["w"])), include_groups=False)
                .sort_values())
    return {
        "n_rows": int(len(df)),
        "r2_random_split": round(r2_rand, 3),
        "r2_temporal_split": round(r2_temporal, 3),
        "nonstationarity_note": "temporal << random split means payer behavior in the "
                                "newest quarters is NOT predictable from history at the "
                                "payer x code grain — behavior drifts",
        "permutation_importance": features,
        "family_predicted_rate": {k: round(v, 4) for k, v in fam_pred.items()},
    }


def main() -> int:
    RESULTS.mkdir(parents=True, exist_ok=True)
    res: dict = {"maturity_days": MATURITY_DAYS}

    for ent in ("BXR", "INDIGO"):
        pm = load_payer_month(ent)
        res.setdefault("changepoints", []).extend(changepoints(ent, pm))
        res.setdefault("mix", {})[ent] = mix_drift(ent, pm)
        res.setdefault("code_mix_cpt", {})[ent] = code_mix(ent, "cpt")
        res.setdefault("code_mix_rev", {})[ent] = code_mix(ent, "rev")
        res.setdefault("forecast", {})[ent] = forecast(ent, pm)
        res.setdefault("anomalies", []).extend(anomalies(ent, pm))
        res.setdefault("status_drift", {})[ent] = status_drift(ent)
        print(f"[{ent}] done")

    res["lag_drift_bxr"] = lag_drift()
    res["carc_snapshot_bxr"] = carc_snapshot()
    res["paid_rate_drivers"] = paid_rate_drivers()

    path = RESULTS / "behavior.json"
    path.write_text(json.dumps(jsonable(res), indent=1))
    print(f"wrote {path}")

    # human summary (aggregates only)
    print(f"\nchange points found: {len(res['changepoints'])}")
    for cp in res["changepoints"][:12]:
        print(f"  {cp['entity']:<7}{cp['family']:<24}{cp['metric']:<18}{cp['break_month']}  "
              f"{cp['before_mean']:.2f} -> {cp['after_mean']:.2f}")
    print(f"anomalous payer-months: {len(res['anomalies'])}")
    d = res["paid_rate_drivers"]
    print(f"paid-rate model: n={d['n_rows']}  R2 random {d['r2_random_split']} / temporal {d['r2_temporal_split']}")
    for f in d["permutation_importance"]:
        print(f"  {f['feature']:<10}{f['importance']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
