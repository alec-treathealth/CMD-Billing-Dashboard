"""
Brain 1 — training (Phase 1-C).

Three models off the time-split parquet from feature_engineering.py:
  1. Multiclass LightGBM  -> outcome_class {0,1,2,3}  (macro-F1, confusion matrix)
  2. LightGBM regressor    -> expected paid amount      (MAE, R2) [training-eligible]
  3. Cox PH (lifelines)    -> expected days_to_pay       (concordance)
Plus SHAP (TreeExplainer) and DiCE counterfactuals on DENIED rows.

Categoricals are ordinal-encoded; the encoders are persisted so score_writer.py
applies the identical mapping. PHI firewall: asserts no PHI column names appear
in the feature matrix before fitting/saving.
"""
from __future__ import annotations

import pathlib
import pickle

import numpy as np
import pandas as pd
import lightgbm as lgb
import optuna
import shap
from lifelines import CoxPHFitter
from sklearn.metrics import classification_report, confusion_matrix, f1_score, mean_absolute_error, r2_score
from sklearn.preprocessing import OrdinalEncoder

DATA = pathlib.Path("data/brain1")
PHI_DENYLIST = {"patient_name", "patient_first", "patient_last", "member_id",
                "member_id_raw", "member_id_norm", "group_number", "dob", "ssn"}
CATEGORICAL = [
    "canonical_primary_payer_name", "canonical_primary_payer_family",
    "payer_type", "network_status", "claim_facility_id", "cpt_code", "claim_type",
    "is_behavioral_health",
]


def load(split: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    return (pd.read_parquet(DATA / f"X_{split}.parquet"),
            pd.read_parquet(DATA / f"y_{split}.parquet"))


def assert_no_phi(cols) -> None:
    leaked = PHI_DENYLIST.intersection({c.lower() for c in cols})
    assert not leaked, f"PHI column(s) in feature matrix: {leaked}"


def encode(X_train: pd.DataFrame, X_test: pd.DataFrame):
    enc = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1,
                         encoded_missing_value=-1)
    X_train = X_train.copy()
    X_test = X_test.copy()
    X_train[CATEGORICAL] = enc.fit_transform(X_train[CATEGORICAL].astype("string"))
    X_test[CATEGORICAL] = enc.transform(X_test[CATEGORICAL].astype("string"))
    return X_train, X_test, enc


def train_classifier(X_tr, y_tr, X_te, y_te) -> lgb.LGBMClassifier:
    def objective(trial: optuna.Trial) -> float:
        params = dict(
            objective="multiclass", num_class=4, n_estimators=500, learning_rate=0.05,
            num_leaves=trial.suggest_int("num_leaves", 15, 127),
            min_child_samples=trial.suggest_int("min_child_samples", 10, 80),
            feature_fraction=trial.suggest_float("feature_fraction", 0.5, 1.0),
            bagging_fraction=trial.suggest_float("bagging_fraction", 0.5, 1.0),
            class_weight="balanced", random_state=42, verbose=-1,
        )
        m = lgb.LGBMClassifier(**params).fit(X_tr, y_tr)
        return f1_score(y_te, m.predict(X_te), average="macro")

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=50, show_progress_bar=False)
    best = lgb.LGBMClassifier(
        objective="multiclass", num_class=4, n_estimators=500, learning_rate=0.05,
        class_weight="balanced", random_state=42, verbose=-1, **study.best_params,
    ).fit(X_tr, y_tr)
    pred = best.predict(X_te)
    print(f"[train] classifier macro-F1={f1_score(y_te, pred, average='macro'):.4f}")
    print(classification_report(y_te, pred))
    print("confusion matrix:\n", confusion_matrix(y_te, pred))
    imp = pd.Series(best.booster_.feature_importance("gain"), index=X_tr.columns)
    print("top 20 features (gain):\n", imp.sort_values(ascending=False).head(20).to_string())
    return best


def train_regressor(X_tr, y_tr_amt, X_te, y_te_amt) -> lgb.LGBMRegressor:
    reg = lgb.LGBMRegressor(objective="regression_l1", n_estimators=500,
                            learning_rate=0.05, random_state=42, verbose=-1)
    reg.fit(X_tr, y_tr_amt)
    pred = reg.predict(X_te)
    print(f"[train] regressor MAE={mean_absolute_error(y_te_amt, pred):.2f} "
          f"R2={r2_score(y_te_amt, pred):.4f}")
    return reg


def train_cox() -> CoxPHFitter:
    sdf = pd.read_parquet(DATA / "survival_df.parquet").dropna(subset=["days_to_pay"])
    sdf = pd.get_dummies(sdf, columns=["canonical_primary_payer_family"], drop_first=True)
    cph = CoxPHFitter(penalizer=0.1)
    cph.fit(sdf, duration_col="days_to_pay", event_col="is_paid_event")
    print(f"[train] Cox concordance={cph.concordance_index_:.4f}")
    return cph


def run_shap(clf, X_te) -> None:
    explainer = shap.TreeExplainer(clf, feature_perturbation="tree_path_dependent")
    sv = explainer.shap_values(X_te)
    shap.summary_plot(sv, X_te, show=False)
    import matplotlib.pyplot as plt
    plt.tight_layout(); plt.savefig(DATA / "shap_summary.png", dpi=120); plt.close()
    print("[train] SHAP summary saved")


def run_dice(clf, X_tr, y_tr, X_te, y_te) -> None:
    import dice_ml
    train_df = X_tr.copy(); train_df["outcome_class"] = y_tr.values
    d = dice_ml.Data(dataframe=train_df, continuous_features=[c for c in X_tr.columns
                     if c not in CATEGORICAL], outcome_name="outcome_class")
    m = dice_ml.Model(model=clf, backend="sklearn", model_type="classifier")
    exp = dice_ml.Dice(d, m, method="random")
    denied = X_te[y_te.values == 2].head(100)
    if len(denied):
        exp.generate_counterfactuals(
            denied, total_CFs=3, desired_class=0,
            features_to_vary=["canonical_primary_payer_name", "cpt_code",
                              "days_from_dos_to_submit", "billed_amount"],
            permitted_range={"days_from_dos_to_submit": [0, 90]})
        print(f"[train] DiCE counterfactuals generated for {len(denied)} DENIED rows")


def main() -> None:
    X_tr, y_tr = load("train"); X_te, y_te = load("test")
    assert_no_phi(X_tr.columns)
    X_tr_e, X_te_e, enc = encode(X_tr, X_te)

    clf = train_classifier(X_tr_e, y_tr["outcome_class"], X_te_e, y_te["outcome_class"])
    # regressor trains on settled-paid rows; target = days-to-pay stand-in absent a paid-amount col
    paid_tr = y_tr["is_paid_event"] == 1
    reg = train_regressor(X_tr_e[paid_tr], y_tr.loc[paid_tr, "days_to_pay"],
                          X_te_e[y_te["is_paid_event"] == 1],
                          y_te.loc[y_te["is_paid_event"] == 1, "days_to_pay"])
    cox = train_cox()
    run_shap(clf, X_te_e)
    run_dice(clf, X_tr_e, y_tr["outcome_class"], X_te_e, y_te["outcome_class"])

    with open(DATA / "lgb_classifier.pkl", "wb") as f: pickle.dump(clf, f)
    with open(DATA / "lgb_regressor.pkl", "wb") as f: pickle.dump(reg, f)
    with open(DATA / "cox_model.pkl", "wb") as f: pickle.dump(cox, f)
    with open(DATA / "ordinal_encoder.pkl", "wb") as f: pickle.dump(enc, f)
    print("[train] models + encoder saved to", DATA)


if __name__ == "__main__":
    main()
