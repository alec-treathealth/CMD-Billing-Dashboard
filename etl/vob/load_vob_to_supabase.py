"""DRAFT — NOT YET RUN. Initial bulk load of the curated Indigo VOB CSV into
vob.indigo_vob (project dbpabchpvipipkzkogta).

Design guarantees:
  * Computes blind-index tokens LOCALLY (vob_blind_index) from raw member_id/group_number,
    then inserts ONLY the pseudonymous tokens + benefit attributes. Raw identifiers
    (patient_name, patient_dob, member_id, group_number) and free-text additional_notes are
    NEVER inserted and NEVER logged. relationship_client / employer_name are also excluded
    (kept out to preserve the table's pseudonymous, benefit-only shape).
  * True upsert on monday_item_id (INSERT ... ON CONFLICT DO UPDATE) — idempotent + re-runnable.
  * Connects as cmd_rollup_writer via CMD_ROLLUP_WRITER_DATABASE_URL (Supavisor pooler:6543).
    Requires migration 0060 applied (grants INSERT+UPDATE+SELECT on vob.indigo_vob).

Prereqs before running (separate GO):
  1. Migration 0060 applied.
  2. loader.env contains CMD_ROLLUP_WRITER_DATABASE_URL (stage from app env) + INDEX_HMAC_KEY.
  3. Reports counts only — no PHI, no tokens.
"""
import csv, re, sys, argparse
import psycopg
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
from vob_blind_index import member_bidx, prefix_bidx, group_bidx

LOADER_ENV = "/Users/aleclowi/vob-data/loader.env"

# curated CSV field -> table column (verbatim benefit text). RAW PHI + notes intentionally absent.
BENEFIT = {
    "policy_type": "policy_type", "funding": "funding", "insurance_co": "insurance_co",
    "payer_id": "payer_id", "plan_type": "plan_type",
    "ind_deductible": "ind_deductible", "ind_deductible_met": "ind_deductible_met",
    "family_deductible": "family_deductible", "family_deductible_met": "family_deductible_met",
    "ind_oop_max": "ind_oop_max", "ind_oop_met": "ind_oop_met",
    "family_oop_max": "family_oop_max", "family_oop_met": "family_oop_met",
    "coinsurance_combined": "coinsurance_combined", "coinsurance_ip": "coinsurance_ip",
    "coinsurance_op": "coinsurance_op", "coinsurance_after_oop": "coinsurance_after_oop",
    "vob_datetime": "vob_datetime",
    "_schema_version": "schema_version", "_extraction_flag": "extraction_flag",
}
# Full ordered insert column list (30 cols; employer added by migration 0061).
COLS = ["monday_item_id", "facility", "vob_created_at",
        "member_id_bidx", "member_id_prefix_bidx", "group_number_bidx",
        "employer_name", "employer_norm"] + list(BENEFIT.values())

# employer_name is now an included market dimension (0061). Still excluded: raw patient identifiers
# (only their blind indexes persist), free-text notes, and relationship_client.
EXCLUDED_FROM_TABLE = {"patient_name", "patient_dob", "member_id", "group_number",
                       "additional_notes", "relationship_client"}

def emp_norm(v):
    v = (v or "").strip()
    return re.sub(r"\s+", " ", v).upper() or None

def env(path):
    d = {}
    for line in open(path):
        i = line.find("=")
        if i > 0:
            d[line[:i]] = line[i + 1:].strip().strip('"').strip("'")
    return d

def conninfo(url, ca=None):
    u = urlparse(url); q = dict(parse_qsl(u.query)); q.setdefault("sslmode", "require")
    # verify-full/verify-ca need a CA bundle; supply SUPABASE_CA_PATH (else libpq looks in
    # ~/.postgresql/root.crt). This preserves full server-cert verification.
    if ca and q.get("sslmode", "").startswith("verify") and "sslrootcert" not in q:
        q["sslrootcert"] = ca
    return urlunparse(u._replace(query=urlencode(q))), u

def nn(v):
    v = (v or "").strip()
    return v or None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="/Users/aleclowi/vob-data/indigo_vob_curated.csv")
    ap.add_argument("--roster", default="/Users/aleclowi/vob-data/roster_facility.csv")
    ap.add_argument("--batch", type=int, default=1000)
    ap.add_argument("--dry-run", action="store_true", help="build rows + print counts, no DB write")
    args = ap.parse_args()

    created = {}
    try:
        for r in csv.reader(open(args.roster)):
            if r and len(r) >= 3:
                created[r[0]] = (r[2].strip() or None)   # monday_item_id -> created_at date
    except FileNotFoundError:
        pass  # vob_created_at stays null

    rows = []
    with_member = 0
    with open(args.csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            iid = nn(row.get("_monday_item_id"))
            if iid is None:
                continue
            m = member_bidx(row.get("member_id"))
            if m:
                with_member += 1
            rec = {
                "monday_item_id": iid,
                "facility": nn(row.get("facility")),
                "vob_created_at": created.get(iid),
                "member_id_bidx": m,
                "member_id_prefix_bidx": prefix_bidx(row.get("member_id")),
                "group_number_bidx": group_bidx(row.get("group_number")),
                "employer_name": nn(row.get("employer_name")),
                "employer_norm": emp_norm(row.get("employer_name")),
            }
            for src, col in BENEFIT.items():
                rec[col] = nn(row.get(src))
            rows.append(tuple(rec[c] for c in COLS))

    print(f"prepared rows: {len(rows)} | with member_id_bidx: {with_member} "
          f"({100*with_member/len(rows):.1f}%) | excluded-from-table cols: {sorted(EXCLUDED_FROM_TABLE)}")
    if args.dry_run:
        print("dry-run: no DB write."); return

    placeholders = "(" + ",".join(["%s"] * len(COLS)) + ")"
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS if c != "monday_item_id")
    sql = (f"insert into vob.indigo_vob ({', '.join(COLS)}) values {placeholders} "
           f"on conflict (monday_item_id) do update set {updates}, loaded_at=now()")

    envd = env(LOADER_ENV)
    ci, u = conninfo(envd["CMD_ROLLUP_WRITER_DATABASE_URL"], envd.get("SUPABASE_CA_PATH"))
    print(f"connecting as writer via {u.hostname}:{u.port} (sslmode=require)")
    done = 0
    # prepare_threshold=None: the Supavisor transaction pooler (6543) multiplexes server
    # connections, so server-side prepared statements collide ("_pg3_0 already exists").
    with psycopg.connect(ci, connect_timeout=30, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), args.batch):
                chunk = rows[i:i + args.batch]
                cur.executemany(sql, chunk)
                done += len(chunk)
            conn.commit()
            # Refresh the materialized latest-per-member set (migration 0063) so the app's market
            # filter + employer type-ahead see this load. SECURITY DEFINER fn → the writer role can
            # refresh without owning the matview; REFRESH ... CONCURRENTLY never blocks readers.
            cur.execute("select vob.refresh_member_benefits_latest()")
            conn.commit()
    print(f"upserted rows: {done} | refreshed vob.member_benefits_latest")

if __name__ == "__main__":
    main()
