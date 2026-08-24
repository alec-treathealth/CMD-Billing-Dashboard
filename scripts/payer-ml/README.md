# payer-ml — temporal payer-behavior analysis (read-only, non-PHI outputs)

One-shot analysis suite studying **payer change behavior** over time: change
points, payer/code-mix drift, paid-rate flips, payment-lag shifts, denial (CARC)
mix, character-level payer-name drift, and demand forecasts. Untracked probe
work in the spirit of `scripts/probe-*.ts` — **do not commit `out/`** (it is
gitignored inside).

## PHI posture

- Connects ONLY as `claims_reader` via `CLAIMS_READER_DATABASE_URL` (read-only).
- Every SQL projection is an explicit non-PHI allowlist: payer names, CPT/rev/
  CARC codes, dates, counts, dollar aggregates. Never a patient column, bidx,
  or bytea. Everything in `out/` is a payer-level aggregate.
- TLS verify-full against `certs/supabase-ca.crt` via psycopg connect kwargs
  (the Python equivalent of `src/ssl.ts` — never `sslmode` in the URL).
- `staging.*` reads require the tenancy GUC per transaction:
  `set_config('app.business_entity_id', <uuid>, true)` — claims_reader gets an
  ERROR (not empty rows) without it. `vob.*`/`ref.*` are global reads.
- Supavisor (6543) forbids named prepared statements → `prepare_threshold=None`.

## Pipeline

```bash
# venv with: psycopg[binary] pandas numpy scipy scikit-learn ruptures rapidfuzz statsmodels
python pull_aggregates.py     # 21 aggregate CSVs -> out/           (~25s)
python analyze_behavior.py    # changepoints/drift/forecast/GBM -> out/results/behavior.json
python analyze_names.py       # char-level name clustering -> out/results/names.json
python export_viz_data.py     # distilled chart series -> out/results/viz-data.json
# inject viz-data.json into dashboard_template.html at /*__DATA__*/ -> out/results/dashboard.html
```

## Libraries and what each one is for

| Library | Role |
|---|---|
| ruptures | PELT change-point detection (RBF kernel) on per-payer monthly series |
| scipy | Jensen-Shannon divergence (mix drift), PSI vs first-year baseline |
| scikit-learn | char n-gram TF-IDF + cosine (name clustering); HistGradientBoosting + permutation importance (paid-rate drivers) |
| rapidfuzz | fast edit-distance confirmation of name merges + edit taxonomy |
| statsmodels | Holt-Winters forecasts with 4-month holdout backtests |
| pandas/numpy/psycopg3 | aggregate-only data layer |

## Analysis honesty rules baked in

- **Right-censoring guard**: payments accrue to a service month late, so any
  paid-rate metric uses only service months ≥120 days old (`MATURITY_DAYS`).
- Partial trailing calendar month/quarter dropped from every trend.
- Payer families = `ref.payer_alias_map` crosswalk + token heuristic fallback
  (`_common.family_of`); BXR `staging.claim_line` carries canonical names.
- `collections.cmd_payer_facility_monthly` was deliberately NOT used (it has a
  known two-population seam at 2026-06 — see CLAUDE.md); explorer rows were
  aggregated directly instead.
- '—' CPT rows are uncoded charge lines; excluded from paid-rate flip rankings.
- ERA/CARC panel is a one-month snapshot (pipeline began 2026-07), not a trend.
- Forecast panels show only families whose holdout backtest MAPE ≤ 30%.

Dashboard published as a private artifact (Payer Behavior Lab). Rebuild + a
headless-Chrome screenshot pass before republishing.
