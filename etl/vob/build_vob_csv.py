"""
build_vob_csv.py — assemble the ONE normalized Indigo VOB CSV.

This is the column-based ETL's replacement realization: the Monday board's
benefit columns are empty (recon 2026-07-22), so the benefit data comes from
the already-produced PDF extraction (indigo_vob_full_extract.csv, from
extract_vob.py) and Monday contributes only two things:
  - Facility  (status60)  -> the ADMISSION GATE. Blank Facility means the
    client is awaiting admission or was never admitted -> NO output row.
  - item_id               -> the join / claims key (from the PDF filename).

One row per ADMITTED board item, curated core schema, empty -> null.
Nothing here re-scans PDFs or re-paginates the whole board; it only joins two
existing local inputs. extract_vob.py is NOT modified.

PHI: output is PHI (patient_name, patient_dob, member_id, notes). It is written
to the gitignored data dir only; this script prints coverage/counts only.
"""
import csv, os, sys, argparse
from collections import Counter

# --- curated core output schema (deterministic order) -----------------------
# out_field -> source column in indigo_vob_full_extract.csv ("" = derived)
DIRECT = {
    "patient_name": "patient_name",
    "patient_dob": "patient_dob",
    "member_id": "member_id",
    "group_number": "group_number",
    "relationship_client": "relationship_to_client",
    "employer_name": "employer_name",
    "insurance_co": "insurance_co",
    "payer_id": "payer_id",
    "plan_type": "plan_type",
    "vob_datetime": "vob_datetime",
    "additional_notes": "additional_notes",
    "ind_deductible": "ind_deductible",
    "ind_deductible_met": "ind_deductible_met",
    "family_deductible": "family_deductible",
    "family_deductible_met": "family_deductible_met",
    "ind_oop_max": "ind_oop_max",
    "ind_oop_met": "ind_oop_met",
    "family_oop_max": "family_oop_max",
    "family_oop_met": "family_oop_met",
    "coinsurance_combined": "coinsurance_combined",
    "coinsurance_ip": "coinsurance_ip",
    "coinsurance_op": "coinsurance_op",
    "coinsurance_after_oop": "after_oop_pct",
}
OUT_COLUMNS = (
    ["_monday_item_id", "facility",
     "patient_name", "patient_dob", "member_id", "group_number",
     "relationship_client", "policy_type", "employer_name", "funding",
     "insurance_co", "payer_id", "plan_type", "vob_datetime", "additional_notes",
     "ind_deductible", "ind_deductible_met", "family_deductible", "family_deductible_met",
     "ind_oop_max", "ind_oop_met", "family_oop_max", "family_oop_met",
     "coinsurance_combined", "coinsurance_ip", "coinsurance_op", "coinsurance_after_oop",
     "_schema_version", "_extraction_flag"]
)


def clean(v):
    v = (v or "").strip()
    return "" if v.lower() == "none" else v


def derive_policy_type(row):
    emp = clean(row.get("policy_type_employer"))
    ind = clean(row.get("policy_type_individual"))
    if emp and ind:
        return "Employer;Individual"
    if emp:
        return "Employer"
    if ind:
        return "Individual"
    return ""


def derive_funding(row):
    sf = clean(row.get("self_funded"))
    fi = clean(row.get("fully_insured"))
    if sf and fi:
        return "Self-Funded;Fully Insured"
    if sf:
        return "Self-Funded"
    if fi:
        return "Fully Insured"
    return ""


def load_roster(path):
    """roster CSV rows: item_id, facility, created_at (no header)."""
    fac = {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.reader(f):
            if not r:
                continue
            iid = r[0].strip()
            facility = r[1].strip() if len(r) > 1 else ""
            if iid:
                fac[iid] = facility
    return fac


def item_id_from_source(src):
    b = os.path.basename((src or "").strip())
    return b[:-4] if b.lower().endswith(".pdf") else b


def load_extract(path):
    idx = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            iid = item_id_from_source(row.get("_source_file"))
            if iid:
                idx[iid] = row
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", default="/private/tmp/claude-501/-Users-aleclowi-CMD-Billing-Dashboard/b9c57fff-7031-4372-bf73-7edadffac933/scratchpad/roster_facility.csv")
    ap.add_argument("--extract", default="/Users/aleclowi/indigo_vob_extraction/indigo_vob_full_extract.csv")
    ap.add_argument("--out", default="/Users/aleclowi/vob-data/indigo_vob_curated.csv")
    args = ap.parse_args()

    facility_of = load_roster(args.roster)
    extract = load_extract(args.extract)

    admitted = {iid: fac for iid, fac in facility_of.items() if fac}
    n_board = len(facility_of)
    n_admitted = len(admitted)
    n_blank = n_board - n_admitted

    written = 0
    no_extract = 0
    ver = Counter()
    flagc = Counter()
    fac_dist = Counter()
    cov = Counter()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLUMNS)
        w.writeheader()
        for iid, facility in admitted.items():
            src = extract.get(iid)
            out = {c: "" for c in OUT_COLUMNS}
            out["_monday_item_id"] = iid
            out["facility"] = facility
            if src is None:
                out["_extraction_flag"] = "NO_PDF_EXTRACT"
                no_extract += 1
            else:
                for of, sc in DIRECT.items():
                    out[of] = clean(src.get(sc))
                out["policy_type"] = derive_policy_type(src)
                out["funding"] = derive_funding(src)
                out["_schema_version"] = clean(src.get("_schema_version"))
                out["_extraction_flag"] = clean(src.get("_extraction_error"))
            w.writerow(out)
            written += 1
            ver[out["_schema_version"] or "None"] += 1
            flagc[out["_extraction_flag"] or "(clean)"] += 1
            fac_dist[facility] += 1
            for c in OUT_COLUMNS:
                if out[c].strip():
                    cov[c] += 1

    # ---- verification (coverage/counts only; NO PHI) ----
    print("=" * 60)
    print("BUILD COMPLETE ->", args.out)
    print("=" * 60)
    print(f"board items (roster) : {n_board}")
    print(f"  admitted (facility) : {n_admitted} ({100*n_admitted/n_board:.1f}%)")
    print(f"  blank facility SKIP : {n_blank} ({100*n_blank/n_board:.1f}%)")
    print(f"rows written          : {written}  (== admitted)")
    print(f"  admitted w/o extract: {no_extract}  (NO_PDF_EXTRACT rows)")
    print(f"\nschema_version distribution: {dict(ver)}")
    print(f"extraction flags          : {dict(flagc)}")
    print(f"\nPER-FIELD NON-NULL COVERAGE (of {written} rows):")
    for c in OUT_COLUMNS:
        print(f"  {100*cov[c]/written:3.0f}%  {c}")
    print(f"\nFACILITY distribution (top 25):")
    for lab, ct in fac_dist.most_common(25):
        print(f"  {ct:6d}  {lab}")


if __name__ == "__main__":
    main()
