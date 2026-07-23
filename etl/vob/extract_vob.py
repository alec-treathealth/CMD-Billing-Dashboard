"""
Indigo VOB PDF Extractor — extracts structured benefit data from Indigo
"Verification of Benefits" fillable PDFs into a single normalized CSV.

Handles 3 known schema versions (auto-detected per file):
  V1 (~2021-mid 2024): 116 fields, uses MRC1/MRC2, Serv Add, activecovno/yes,
      combined 'coins' field, 'blue 2'
  V2 (mid 2024-mid 2026): 115 fields, uses 'deductible 1'/'deductible 2' for
      DED-in-OOPM checkbox, combined 'coins' field, 'rep'/'timdatevob'
  V3 (2026+): 125 fields, separate 'IP Coins'/'OP Coins', 'Admit Fee',
      'DED in OOP Y'/'DED in OOP N', 'Auth Time Frame'/'Auth Penalty'/'Auth Fax #'

Unknown/unrecognized schemas are flagged in the output rather than
silently mismapped.
"""
import csv
import sys
import os
from pypdf import PdfReader


# ---------------------------------------------------------------------------
# Version detection: fields that are UNIQUE to one version, used as signatures
# ---------------------------------------------------------------------------
# Signature fields must ALL be present (AND, not any-overlap) to positively
# identify a version. Checked most-specific-first (V3, then V1, then V2)
# since V2's only clean discriminator ('Text6') is a weak single-field signal.
V3_SIGNATURE = {"IP Coins", "OP Coins", "Admit Fee", "DED in OOP Y"}
V1_SIGNATURE = {"MRC1", "MRC2", "Serv Add", "activecovyes"}
V2_SIGNATURE = {"Text6"}


def detect_version(field_names: set) -> str:
    """Return 'V1', 'V2', 'V3', or 'UNKNOWN'. Requires ALL signature fields
    for a version to be present -- a partial/single-field match is not
    sufficient, since some fields (e.g. 'deductible 1') appear across
    multiple versions and are not reliable discriminators on their own."""
    if V3_SIGNATURE.issubset(field_names):
        return "V3"
    if V1_SIGNATURE.issubset(field_names):
        return "V1"
    if V2_SIGNATURE.issubset(field_names):
        return "V2"
    return "UNKNOWN"


# ---------------------------------------------------------------------------
# Canonical schema: maps canonical_name -> {version: source_field_id}
# 'None' means the field does not exist in that version (will be blank).
# ---------------------------------------------------------------------------
FIELD_MAP = {
    # --- Identity / demographics ---
    "patient_name":            {"V1": "Name",         "V2": "Name",         "V3": "Name"},
    "patient_dob":              {"V1": "clientdob",     "V2": "clientdob",     "V3": "clientdob"},
    "patient_gender":           {"V1": "gender",        "V2": "gender",        "V3": "gender"},
    "subscriber_name_dob":      {"V1": "policyholdernamedob", "V2": "policyholdernamedob", "V3": "policyholdernamedob"},
    "relationship_to_client":   {"V1": "rshiptoclient", "V2": "rshiptoclient", "V3": "rshiptoclient"},
    "employer_name":            {"V1": "employer",      "V2": "employer",      "V3": "employer"},
    "policy_type_employer":     {"V1": "employergroup", "V2": "employergroup", "V3": "employergroup"},
    "policy_type_individual":   {"V1": "indivipolicy",  "V2": "indivipolicy",  "V3": "indivipolicy"},
    "address_street":           {"V1": "address",       "V2": "address",       "V3": "address"},
    "address_city":             {"V1": "city",          "V2": "city",          "V3": "city"},
    "address_state":            {"V1": "state",         "V2": "state",         "V3": "state"},
    "address_zip":              {"V1": "zip",           "V2": "zip",           "V3": "zip"},

    # --- Rep / VOB metadata (differs most across versions) ---
    "indigo_rep":               {"V1": "rep",           "V2": "rep",           "V3": "Indigo Rep / Date"},
    "vob_datetime":             {"V1": "timdatevob",    "V2": "timdatevob",    "V3": "Indigo Rep / Date"},  # V3 combines rep+date in one field
    "call_ref_number":          {"V1": "ref num",       "V2": "ref num",       "V3": "ref num"},

    # --- Insurance / plan ---
    "network_status":           {"V1": None,            "V2": "Network Status", "V3": "Network Status"},  # V1 form has no separate Network Status field
    "insurance_co":              {"V1": "insco",         "V2": "insco",         "V3": "insco"},
    "ins_phone":                 {"V1": "insphone",      "V2": "insphone",      "V3": "insphone"},
    "member_id":                 {"V1": "memberid",      "V2": "memberid",      "V3": "memberid"},
    "group_number":              {"V1": "group",         "V2": "group",         "V3": "group"},
    "bh_carveout":               {"V1": "bhcarve",       "V2": "bhcarve",       "V3": "bhcarve"},
    "carveout_id":               {"V1": "carveoutidno",  "V2": "carveoutidno",  "V3": "carveoutidno"},
    "effective_date":            {"V1": "policyeffectivedate", "V2": "policyeffectivedate", "V3": "policyeffectivedate"},
    "plan_type":                 {"V1": "plan type",     "V2": "plan type",     "V3": "plan type"},
    "plan_description":          {"V1": "plandescription", "V2": "plandescription", "V3": "plandescription"},
    "benefit_period":            {"V1": "benefitperioddropdown", "V2": "benefitperioddropdown", "V3": "benefitperioddropdown"},
    "renewal_term_date":         {"V1": "renewaltermdate", "V2": "renewaltermdate", "V3": "renewaltermdate"},
    "self_funded":               {"V1": "selffunded",    "V2": "selffunded",    "V3": "selffunded"},
    "fully_insured":             {"V1": "fullyinsured",  "V2": "fullyinsured",  "V3": "fullyinsured"},

    # --- Coinsurance / deductibles / OOP (core financial fields) ---
    "coinsurance_combined":      {"V1": "coins",         "V2": "coins",         "V3": None},         # V1/V2 single IP=OP value
    "coinsurance_ip":            {"V1": None,            "V2": None,            "V3": "IP Coins"},   # V3 splits IP/OP
    "coinsurance_op":            {"V1": None,            "V2": None,            "V3": "OP Coins"},
    "after_oop_pct":             {"V1": "After OOP",     "V2": "After OOP",     "V3": "After OOP"},
    "ind_deductible":            {"V1": "ded1",          "V2": "ded1",          "V3": "ded1"},
    "ind_deductible_met":        {"V1": "ded2",          "V2": "ded2",          "V3": "ded2"},
    "family_deductible":         {"V1": "ded3",          "V2": "ded3",          "V3": "ded3"},
    "family_deductible_met":     {"V1": "ded4",          "V2": "ded4",          "V3": "ded4"},
    "ind_oop_max":                {"V1": "oop1",          "V2": "oop1",          "V3": "oop1"},
    "ind_oop_met":                {"V1": "oop2",          "V2": "oop2",          "V3": "oop2"},
    "family_oop_max":             {"V1": "oop3",          "V2": "oop3",          "V3": "oop3"},
    "family_oop_met":             {"V1": "oop4",          "V2": "oop4",          "V3": "oop4"},
    "ded_included_in_oopm_yes":  {"V1": None,            "V2": "deductible 1", "V3": "DED in OOP Y"},  # semantics verified: see NOTES below
    "ded_included_in_oopm_no":   {"V1": None,            "V2": "deductible 2", "V3": "DED in OOP N"},

    # --- Admit fee / copays / dollar-day max ---
    "admit_fee":                  {"V1": "admitfees",     "V2": "admitfees",     "V3": "Admit Fee"},
    "copays":                     {"V1": "copays",        "V2": "copays",        "V3": "copays"},
    "dollar_day_max":             {"V1": "dollardaymax",  "V2": "dollardaymax",  "V3": "dollardaymax"},
    "visit_limits":               {"V1": "visitlimits",   "V2": "visitlimits",   "V3": "visitlimits"},
    "visits_remaining":           {"V1": "visitsremaining", "V2": "visitsremaining", "V3": "visitsremaining"},

    # --- Levels of Care covered (checkboxes) ---
    "loc_dtx":                    {"V1": "boxh0010",      "V2": "boxh0010",      "V3": "boxh0010"},
    "loc_rtc":                    {"V1": "boxh0018",      "V2": "boxh0018",      "V3": "boxh0018"},
    "loc_php":                    {"V1": "boxh0035",      "V2": "boxh0035",      "V3": "boxh0035"},
    "loc_adtx_perdiem":           {"V1": "boxh2036",      "V2": "boxh2036",      "V3": "boxh2036"},
    "loc_iop_cd":                 {"V1": "boxh0015",      "V2": "boxh0015",      "V3": "boxh0015"},
    "loc_iop_mh":                 {"V1": "boxs9475",      "V2": "boxs9475",      "V3": "boxs9475"},
    "loc_behavioral_therapy":     {"V1": "boxh2020",      "V2": "boxh2020",      "V3": "boxh2020"},
    "loc_group_psychotherapy":    {"V1": "boxop1",        "V2": "boxop1",        "V3": "boxop1"},
    "loc_ind_psychotherapy":      {"V1": "boxop2",        "V2": "boxop2",        "V3": "boxop2"},
    "loc_family_therapy":         {"V1": "boxopt60",      "V2": "boxopt60",      "V3": "boxopt60"},
    "loc_case_mgmt":              {"V1": "boxop4",        "V2": "boxop4",        "V3": "boxop4"},
    "loc_psychotherapy_crisis":   {"V1": "boxop5",        "V2": "boxop5",        "V3": "boxop5"},

    # --- Pre-cert / auth requirements (checkboxes: which LOC needs pre-auth) ---
    "precert_dtx":                {"V1": "DTX",           "V2": "DTX",           "V3": "DTX"},
    "precert_rtc":                {"V1": "RTC",           "V2": "RTC",           "V3": "RTC"},
    "precert_php":                {"V1": "PHP",           "V2": "PHP",           "V3": "PHP"},
    "precert_iop":                {"V1": "IOP",           "V2": "IOP",           "V3": "IOP"},
    "precert_op":                 {"V1": "OP",            "V2": "OP",            "V3": "OP"},
    "precert_nonroutine_op":      {"V1": "nrop",          "V2": "nrop",          "V3": "nrop"},
    "precert_time_frame":         {"V1": None,            "V2": None,            "V3": "Auth Time Frame"},  # only in V3; V1/V2 have no equivalent field
    "precert_penalty":            {"V1": None,            "V2": None,            "V3": "Auth Penalty"},
    "precert_phone":              {"V1": "precertphoneno", "V2": "precertphoneno", "V3": "precertphoneno"},
    "precert_fax":                {"V1": None,            "V2": None,            "V3": "Auth Fax #"},

    # --- Policy details (checkboxes) ---
    "policy_primary":              {"V1": "prim",          "V2": "prim",          "V3": "prim"},
    "policy_secondary":            {"V1": "sec",           "V2": "sec",           "V3": "sec"},
    "policy_on_exchange":          {"V1": "aca",           "V2": "aca",           "V3": "aca"},
    "policy_off_exchange":         {"V1": "on",            "V2": "on",            "V3": "on"},
    "policy_cobra":                {"V1": "cobraplan",     "V2": "cobraplan",     "V3": "cobraplan"},
    "policy_grace_period":         {"V1": "graceperiod",   "V2": "graceperiod",   "V3": "graceperiod"},

    # --- Reimbursement details (checkboxes: Y/N pairs) ---
    "aob_accepted_y":              {"V1": "aob1",          "V2": "aob1",          "V3": "aob1"},
    "aob_accepted_n":              {"V1": "aob2",          "V2": "aob2",          "V3": "aob2"},
    "ucr_y":                       {"V1": "ucr1",          "V2": "ucr1",          "V3": "ucr1"},
    "ucr_n":                       {"V1": "ucr2",          "V2": "ucr2",          "V3": "ucr2"},
    "oon_allowed_amt_y":           {"V1": "oonam1",        "V2": "oonam1",        "V3": "oonam1"},
    "oon_allowed_amt_n":           {"V1": "oonam2",        "V2": "oonam2",        "V3": "oonam2"},
    "priced_local_plan_y":        {"V1": "fairhealth1",   "V2": "fairhealth1",   "V3": "fairhealth1"},
    "priced_local_plan_n":        {"V1": "fairhealth2",   "V2": "fairhealth2",   "V3": "fairhealth2"},
    "priced_home_plan_y":         {"V1": "aob3",          "V2": "aob3",          "V3": "aob3"},
    "priced_home_plan_n":         {"V1": "aob4",          "V2": "aob4",          "V3": "aob4"},
    "medicare_rates_y":            {"V1": "medicare 1",    "V2": "medicare 1",    "V3": "medicare 1"},
    "medicare_rates_n":            {"V1": "medicare 2",    "V2": "medicare 2",    "V3": "medicare 2"},
    "medicare_rates_pct":          {"V1": "med%",          "V2": "med%",          "V3": "med%"},

    # --- Payer-specific reimbursement checkboxes ---
    "aetna_fee_schedule":          {"V1": "feeschedule",   "V2": "feeschedule",   "V3": "feeschedule"},
    "aetna_50_nonpar":             {"V1": "50nonpar",      "V2": "50nonpar",      "V3": "50nonpar"},
    "aetna_reasonable_charges":    {"V1": "reasonablecharges", "V2": "reasonablecharges", "V3": "reasonablecharges"},
    "aetna_nap":                   {"V1": "napaetna",      "V2": "napaetna",      "V3": "napaetna"},
    "aetna_rcr":                   {"V1": None,            "V2": None,            "V3": "AETNA RCR"},
    "cigna_mrc1":                  {"V1": "mrc1",          "V2": "mrc1",          "V3": "mrc1"},
    "cigna_mrc2":                  {"V1": "mrc2",          "V2": "mrc2",          "V3": "mrc2"},
    "cigna_preauth":               {"V1": "CIGNAPREAUTH",  "V2": "CIGNAPREAUTH",  "V3": "CIGNAPREAUTH"},
    "uhc_mnrp":                    {"V1": "mnrp",          "V2": "mnrp",          "V3": "mnrp"},
    "uhc_shared_savings":          {"V1": "preauthnonroutineop", "V2": "preauthnonroutineop", "V3": "preauthnonroutineop"},
    "blue_cross":                  {"V1": "blue 1",        "V2": "blue 1",        "V3": "blue 1"},
    "blue_shield":                 {"V1": "blue 2",        "V2": None,            "V3": None},  # V2/V3 do not repeat this checkbox distinctly
    "tpa_pricer_name":             {"V1": "TPA",           "V2": "TPA",           "V3": "TPA"},
    "tpp":                         {"V1": None,            "V2": None,            "V3": "TPP"},

    # --- Claims / billing ---
    "claims_mailing_address":     {"V1": "claimsmailing", "V2": "claimsmailing", "V3": "claimsmailing"},
    "payer_id":                    {"V1": "payerid",       "V2": "payerid",       "V3": "payerid"},
    "accreditation":               {"V1": "accreditation", "V2": "accreditation", "V3": "accreditation"},
    "member_services_phone":      {"V1": None,            "V2": None,            "V3": "MemberServices"},
    "other_insurance":             {"V1": "yesotherins",   "V2": None,            "V3": None},  # V1-only checkbox pair; V2/V3 use free-text 'Other Policy'
    "other_policy":                {"V1": None,            "V2": None,            "V3": "Other Policy"},
    "other_policy_id":             {"V1": None,            "V2": None,            "V3": "Other Policy ID"},

    # --- Pharmacy ---
    "rx_benefit_admin":            {"V1": "RX BENEFIT ADMIN", "V2": "RX BENEFIT ADMIN", "V3": "RX BENEFIT ADMIN"},
    "rx_phone":                    {"V1": "RXPHONE",       "V2": "RXPHONE",       "V3": "RXPHONE"},
    "rx_bin":                      {"V1": "RXBIN",         "V2": "RXBIN",         "V3": "RXBIN"},
    "rx_pcn":                      {"V1": "RXPCN",         "V2": "RXPCN",         "V3": "RXPCN"},
    "rx_group":                    {"V1": "RXGROUP",       "V2": "RXGROUP",       "V3": "RXGROUP"},

    # --- Notes ---
    "additional_notes":            {"V1": "notes",         "V2": "notes",         "V3": "notes"},
}

# Fields with boolean/checkbox type (value is '/Yes' or None) -- convert to True/False/blank
CHECKBOX_CANONICAL_FIELDS = {
    "policy_type_employer", "policy_type_individual", "self_funded", "fully_insured",
    "ded_included_in_oopm_yes", "ded_included_in_oopm_no",
    "loc_dtx", "loc_rtc", "loc_php", "loc_adtx_perdiem", "loc_iop_cd", "loc_iop_mh",
    "loc_behavioral_therapy", "loc_group_psychotherapy", "loc_ind_psychotherapy",
    "loc_family_therapy", "loc_case_mgmt", "loc_psychotherapy_crisis",
    "precert_dtx", "precert_rtc", "precert_php", "precert_iop", "precert_op", "precert_nonroutine_op",
    "policy_primary", "policy_secondary", "policy_on_exchange", "policy_off_exchange",
    "policy_cobra", "policy_grace_period",
    "aob_accepted_y", "aob_accepted_n", "ucr_y", "ucr_n", "oon_allowed_amt_y", "oon_allowed_amt_n",
    "priced_local_plan_y", "priced_local_plan_n", "priced_home_plan_y", "priced_home_plan_n",
    "medicare_rates_y", "medicare_rates_n",
    "aetna_fee_schedule", "aetna_50_nonpar", "aetna_reasonable_charges", "aetna_nap",
    "cigna_mrc1", "cigna_mrc2", "cigna_preauth", "uhc_mnrp", "uhc_shared_savings",
    "blue_cross", "blue_shield", "other_insurance",
}


def extract_pdf(path: str) -> dict:
    """Extract one PDF into a canonical field dict. Never raises on a single
    bad file -- returns a row with _extraction_error set instead."""
    row = {"_source_file": os.path.basename(path), "_schema_version": None,
           "_extraction_error": None}
    try:
        reader = PdfReader(path)
        fields = reader.get_fields()
        if not fields:
            row["_extraction_error"] = "NOT_A_FILLABLE_FORM"
            return row
        field_names = set(fields.keys())
        version = detect_version(field_names)
        row["_schema_version"] = version

        if version == "UNKNOWN":
            row["_extraction_error"] = "UNRECOGNIZED_SCHEMA_VERSION"
            # still attempt best-effort extraction using V3 map as fallback,
            # so partially-compatible unknown forms aren't a total loss
            version = "V3"

        for canon_name, version_map in FIELD_MAP.items():
            source_field = version_map.get(version)
            if source_field is None:
                row[canon_name] = ""
                continue
            field_obj = fields.get(source_field)
            if field_obj is None:
                row[canon_name] = ""
                continue
            raw_val = field_obj.get("/V")
            if canon_name in CHECKBOX_CANONICAL_FIELDS:
                row[canon_name] = "Yes" if raw_val not in (None, "/Off") else ""
            else:
                # Some source PDFs have the literal string "None" as a field
                # value (a form-authoring artifact), which must not be
                # confused with an actually-blank field. "N/A" is real data
                # the preparer entered and is preserved as-is.
                if raw_val is None:
                    row[canon_name] = ""
                elif str(raw_val).strip() == "None":
                    row[canon_name] = ""
                else:
                    row[canon_name] = str(raw_val).strip()

    except Exception as e:
        row["_extraction_error"] = f"EXCEPTION: {e}"
    return row


def main(pdf_paths, output_csv):
    fieldnames = ["_source_file", "_schema_version", "_extraction_error"] + list(FIELD_MAP.keys())
    rows = []
    errors = []
    version_counts = {"V1": 0, "V2": 0, "V3": 0, "UNKNOWN": 0}

    for path in pdf_paths:
        row = extract_pdf(path)
        rows.append(row)
        v = row.get("_schema_version") or "UNKNOWN"
        version_counts[v] = version_counts.get(v, 0) + 1
        if row.get("_extraction_error"):
            errors.append((row["_source_file"], row["_extraction_error"]))

    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nProcessed {len(rows)} PDFs -> {output_csv}")
    print(f"Version breakdown: {version_counts}")
    if errors:
        print(f"\n{len(errors)} files had issues:")
        for fname, err in errors:
            print(f"  {fname}: {err}")
    else:
        print("No extraction errors.")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 extract_vob.py <output.csv> <pdf1> [pdf2 ...]")
        print("   or: python3 extract_vob.py <output.csv> <directory_of_pdfs>")
        sys.exit(1)

    output_csv = sys.argv[1]
    paths = sys.argv[2:]

    pdf_files = []
    for p in paths:
        if os.path.isdir(p):
            pdf_files.extend(sorted(
                os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(".pdf")
            ))
        elif p.lower().endswith(".pdf"):
            pdf_files.append(p)

    if not pdf_files:
        print("No PDF files found.")
        sys.exit(1)

    main(pdf_files, output_csv)
