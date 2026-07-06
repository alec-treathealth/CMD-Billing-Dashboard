#!/usr/bin/env python3
"""
Indigo Totals-By-Payer aggregation (utility session — no DB, no deploy).

Reads the 7 'Totals By Payer <year>.csv' files (row-per-charge projections of
Indigo Seed Data.csv) and, for each file, groups by payer name and sums the
money columns in integer cents, recomputing the two percentage columns.

PHI RULE (absolute): input CSVs contain Patient Full Name and Claim Primary
Member ID. This script NEVER prints data rows, names, or member IDs. Only
aggregate numbers (payer counts, whole-dollar totals) reach stdout. Output
CSVs are payer-level aggregates written under 'Indigo Seed Data/Summed/',
which is covered by the repo's blanket '*.csv' gitignore rule.

Stdlib only (system python3 has no pandas): csv, pathlib, decimal, sys.
"""

import csv
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Indigo Seed Data"
OUT = SRC / "Summed"

# Column header labels (ruling 3). Payer name is taken from the FIRST occurrence
# (col 0); in the 8-col files it is duplicated at col 1 — that duplicate is
# dropped. The two source percentage columns are junk (ruling 4) and ignored.
COL_PAYER = "Charge Primary Payer Name"
COL_CHARGE = "Charge/Debit Amount"
COL_ALLOWED = "Payment Allowed Amount"
COL_INSPAY = "Charge Insurance Payments"
COL_ADJ = "Charge Total Adjustments"

# Verified expectations (ruling 1 & 2) — treated as law. Script FLAGS drift.
# file year-label -> (data row count, whole-dollar charge sum)
EXPECTED = {
    "2019-2020": (29_734, 79_565_454),
    "2021": (26_850, 74_285_681),
    "2022": (45_354, 140_743_203),
    "2023": (69_952, 244_700_504),
    "2024": (112_474, 385_969_476),
    "2025": (127_347, 505_894_111),
    "2026": (81_092, 371_241_646),
}

CENT = Decimal("0.01")


def parse_cents(raw: str) -> int:
    """Parse a money cell to integer cents. Strips $ and commas; parentheses
    OR a leading '-' mean negative. Blank -> 0. Uses Decimal (never float)."""
    s = (raw or "").strip()
    if not s:
        return 0
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1]
    s = s.replace("$", "").replace(",", "").replace(" ", "").strip()
    if s.startswith("-"):
        neg = True
        s = s[1:]
    if not s or s in (".", "-"):
        return 0
    cents = int((Decimal(s) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return -cents if neg else cents


def fmt_money(cents: int) -> str:
    """Integer cents -> plain 2-decimal string (no $, no commas) for clean re-import."""
    d = (Decimal(cents) / 100).quantize(CENT, rounding=ROUND_HALF_UP)
    return f"{d:.2f}"


def fmt_pct(num_cents: int, den_cents: int) -> str:
    """Recomputed percentage as 'XX.XX%'. Zero denominator -> 0.00% (ruling 4)."""
    if den_cents == 0:
        return "0.00%"
    val = (Decimal(num_cents) / Decimal(den_cents) * 100).quantize(CENT, rounding=ROUND_HALF_UP)
    return f"{val}%"


def col_index(header, label, occurrence=0):
    """Index of the Nth occurrence (0-based) of a header label. Raises if absent."""
    seen = -1
    for i, h in enumerate(header):
        if h.strip() == label:
            seen += 1
            if seen == occurrence:
                return i
    raise KeyError(f"header column {label!r} (occurrence {occurrence}) not found")


def process(path: Path, year_label: str):
    """Aggregate one file. Returns (rows_out, data_row_count, total_charge_cents).
    rows_out is a list of [payer, charge, allowed, pct_allowed, inspay, pct_paid, adj]."""
    agg = {}  # payer -> [charge, allowed, inspay, adj]  (all cents)
    data_rows = 0
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        i_payer = col_index(header, COL_PAYER, 0)   # first occurrence = col 0
        i_charge = col_index(header, COL_CHARGE)
        i_allowed = col_index(header, COL_ALLOWED)
        i_inspay = col_index(header, COL_INSPAY)
        i_adj = col_index(header, COL_ADJ)
        width = len(header)
        for row in reader:
            if not row or len(row) < width:
                # skip blank/short trailing lines; count only real data rows
                if not any(c.strip() for c in row):
                    continue
            data_rows += 1
            payer = row[i_payer].strip()
            b = agg.setdefault(payer, [0, 0, 0, 0])
            b[0] += parse_cents(row[i_charge])
            b[1] += parse_cents(row[i_allowed])
            b[2] += parse_cents(row[i_inspay])
            b[3] += parse_cents(row[i_adj])

    return agg, data_rows


def payer_sort(payers):
    """Payers sorted ascending, case-insensitive with a stable tiebreak."""
    return sorted(payers, key=lambda p: (p.casefold(), p))


def money_row(payer, bucket):
    """[charge, allowed, inspay, adj] cents -> the 7-col output row (with recomputed %)."""
    charge, allowed, inspay, adj = bucket
    return [
        payer,
        fmt_money(charge),
        fmt_money(allowed),
        fmt_pct(allowed, charge),
        fmt_money(inspay),
        fmt_pct(inspay, charge),
        fmt_money(adj),
    ]


def main():
    if not SRC.is_dir():
        print(f"ERROR: source folder not found: {SRC}", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)

    out_header = [
        COL_PAYER, COL_CHARGE, COL_ALLOWED, "Payer Percentage Allowed",
        COL_INSPAY, "Payer Percentage Paid", COL_ADJ,
    ]

    print(f"{'file':<28}{'payers':>8}{'rows':>10}{'rows exp':>10}"
          f"{'$ charge':>16}{'$ exp':>16}  status")
    print("-" * 96)

    all_ok = True
    grand_rows = 0
    per_year = {}   # year_label -> agg dict (payer -> cents bucket)
    for year_label, (exp_rows, exp_dollars) in EXPECTED.items():
        src_file = SRC / f"Totals By Payer {year_label}.csv"
        if not src_file.is_file():
            print(f"{src_file.name:<28}  MISSING", file=sys.stderr)
            all_ok = False
            continue
        agg, data_rows = process(src_file, year_label)
        per_year[year_label] = agg
        grand_rows += data_rows

        out_file = OUT / f"Summed Totals By Payer {year_label}.csv"
        with out_file.open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(out_header)
            w.writerows(money_row(p, agg[p]) for p in payer_sort(agg))

        total_charge_cents = sum(b[0] for b in agg.values())
        whole_dollars = total_charge_cents // 100
        rows_ok = data_rows == exp_rows
        dollars_ok = abs(whole_dollars - exp_dollars) <= 1  # tolerate rounding
        ok = rows_ok and dollars_ok
        all_ok = all_ok and ok
        status = "OK" if ok else ("MISMATCH:" +
                                  ("" if rows_ok else " rows") +
                                  ("" if dollars_ok else " dollars"))
        print(f"{('Totals By Payer ' + year_label):<28}{len(agg):>8}"
              f"{data_rows:>10}{exp_rows:>10}{whole_dollars:>16,}{exp_dollars:>16,}  {status}")

    print("-" * 96)
    exp_total = sum(v[0] for v in EXPECTED.values())
    print(f"{'TOTAL rows':<28}{'':>8}{grand_rows:>10}{exp_total:>10}"
          f"  ({'OK' if grand_rows == exp_total else 'MISMATCH'})")
    print(f"\nPer-year CSVs written to: {OUT}")

    # ---- Combined outputs (3 shapes), all from the same cent-level buckets ----
    years = list(per_year.keys())
    all_payers = payer_sort({p for agg in per_year.values() for p in agg})
    ZERO = [0, 0, 0, 0]

    # 1) LONG — one row per payer-per-year, stacked.
    long_file = OUT / "Combined - Long (payer x year).csv"
    with long_file.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Year"] + out_header)
        for year_label in years:
            agg = per_year[year_label]
            for p in payer_sort(agg):
                w.writerow([year_label] + money_row(p, agg[p]))

    # 2) WIDE — one row per payer, six metric columns repeated per year.
    metric_labels = ["Charge/Debit", "Payment Allowed", "% Allowed",
                     "Insurance Payments", "% Paid", "Total Adjustments"]
    wide_file = OUT / "Combined - Wide (year columns).csv"
    with wide_file.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        header = [COL_PAYER]
        for year_label in years:
            header += [f"{m} {year_label}" for m in metric_labels]
        w.writerow(header)
        for p in all_payers:
            row = [p]
            for year_label in years:
                charge, allowed, inspay, adj = per_year[year_label].get(p, ZERO)
                row += [fmt_money(charge), fmt_money(allowed), fmt_pct(allowed, charge),
                        fmt_money(inspay), fmt_pct(inspay, charge), fmt_money(adj)]
            w.writerow(row)

    # 3) GRAND TOTAL — one row per payer summed across ALL years; % recomputed on totals.
    grand = {}
    for agg in per_year.values():
        for p, b in agg.items():
            g = grand.setdefault(p, [0, 0, 0, 0])
            for i in range(4):
                g[i] += b[i]
    grand_file = OUT / "Combined - Grand total per payer (all years).csv"
    with grand_file.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(out_header)
        w.writerows(money_row(p, grand[p]) for p in payer_sort(grand))

    print("Combined CSVs written:")
    for f in (long_file, wide_file, grand_file):
        print(f"  - {f.name}")

    # Cross-check: grand-total charge == sum of every per-year charge.
    grand_charge = sum(b[0] for b in grand.values())
    peryear_charge = sum(b[0] for agg in per_year.values() for b in agg.values())
    tie_ok = grand_charge == peryear_charge
    print(f"\nCombined tie-out: grand charge {grand_charge // 100:,} == "
          f"per-year charge {peryear_charge // 100:,}  ({'OK' if tie_ok else 'MISMATCH'})")
    print(f"Distinct payers across all years: {len(all_payers)}")

    all_ok = all_ok and tie_ok
    if not all_ok:
        print("\n*** VERIFICATION FAILED — files contradict the rulings; STOP and review. ***",
              file=sys.stderr)
        return 1
    print("\nVerification passed (row counts + charge sums match rulings; combined ties out).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
