"""LIVE — incremental Monday -> vob.indigo_vob sync (scheduled by the Vercel cron
/api/cron/vob-sync, which workflow_dispatches .github/workflows/vob-sync.yml).

Runs headless (GitHub Actions, daily). Keeps vob.indigo_vob current as VOBs are added,
re-VOB'd, admitted, or de-admitted on Monday board 1606316049.

Each run:
  1. Scan the board's metadata (id, updated_at, status60=Facility) — NON-PHI, full pagination.
  2. admitted = facility non-empty.
  3. Diff vs the table (by monday_updated_at watermark):
       new admitted            -> download PDF + extract + upsert
       existing, watermark NULL -> adopt watermark only (initial-load rows; no re-extract)
       board updated_at newer  -> re-download + re-extract + upsert
       de-admitted / off-board -> SOFT-delete (set deactivated_at; guarded by a 10% safety cap)
       re-admitted             -> reactivate (clear deactivated_at)
  4. Refresh vob.member_benefits_latest (matview) when benefit rows changed; write vob.sync_state.

PHI: metadata scan is non-PHI. PDFs (PHI) are downloaded to ephemeral temp files, extracted,
and deleted immediately. Only pseudonymous blind-index tokens + benefit/market attributes are
written. Raw identifiers (patient_name/dob/member_id/group_number) and additional_notes are never
persisted or logged.

Secrets (env in CI; loader.env locally): MONDAY_API_TOKEN, INDEX_HMAC_KEY,
CMD_ROLLUP_WRITER_DATABASE_URL, optional SUPABASE_CA_PATH.
"""
import os, re, json, time, tempfile, datetime
import requests
import psycopg
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

import extract_vob                                   # extract_pdf (same repo dir)
from build_vob_csv import clean, derive_policy_type, derive_funding   # validated mapping
from vob_blind_index import member_bidx, prefix_bidx, group_bidx

BOARD_ID = "1606316049"
SOURCE = "indigo_monday_1606316049"
LOADER_ENV = os.environ.get("VOB_LOADER_ENV", "/Users/aleclowi/vob-data/loader.env")
DELETE_SAFETY_FRAC = 0.10                            # never delete >10% of the table in one run
MONDAY_URL = "https://api.monday.com/v2"
ITEM_CHUNK = 50                                      # ids per items() call — ALWAYS passed as an
                                                     # explicit `limit` too (see asset_urls)

# table columns written (0060 + 0061 employer + 0062 monday_updated_at)
COLS = ["monday_item_id", "facility", "vob_created_at", "monday_updated_at",
        "member_id_bidx", "member_id_prefix_bidx", "group_number_bidx",
        "employer_name", "employer_norm",
        "policy_type", "funding", "insurance_co", "payer_id", "plan_type",
        "ind_deductible", "ind_deductible_met", "family_deductible", "family_deductible_met",
        "ind_oop_max", "ind_oop_met", "family_oop_max", "family_oop_met",
        "coinsurance_combined", "coinsurance_ip", "coinsurance_op", "coinsurance_after_oop",
        "vob_datetime", "schema_version", "extraction_flag"]

# ---------- env ----------
def _loader_env():
    d = {}
    try:
        for line in open(LOADER_ENV):
            i = line.find("=")
            if i > 0:
                d[line[:i]] = line[i+1:].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return d

_LE = _loader_env()
def getenv(name):
    return os.environ.get(name) or _LE.get(name)

TOKEN = getenv("MONDAY_API_TOKEN")

def emp_norm(v):
    v = (v or "").strip()
    return re.sub(r"\s+", " ", v).upper() or None

def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None

# ---------- Monday API ----------
def monday(query, variables=None, tries=5):
    last = None
    for attempt in range(tries):
        try:
            r = requests.post(MONDAY_URL, json={"query": query, "variables": variables or {}},
                              headers={"Authorization": TOKEN, "Content-Type": "application/json",
                                       "API-Version": "2024-01"}, timeout=90)
            if r.status_code == 429:                 # rate/complexity budget
                time.sleep(2 ** attempt); continue
            data = r.json()
            if data.get("errors"):
                # do NOT log the payload (may echo inputs); surface names only
                raise RuntimeError("monday graphql error: " + "; ".join(
                    e.get("message", "?")[:80] for e in data["errors"]))
            return data["data"]
        except (requests.RequestException, RuntimeError) as e:
            last = e; time.sleep(2 ** attempt)
    raise last

def scan_board():
    """Return {item_id: (facility, updated_at_dt, created_at_date)} — NON-PHI.
    created_at_date feeds vob_created_at, the matview's latest-per-member recency key;
    it matches the initial load, which sourced vob_created_at from the Monday item created_at."""
    out = {}
    def take(items):
        for it in items:
            fac = ""
            for cv in it.get("column_values", []):
                fac = (cv.get("text") or "").strip()
            cr = parse_ts(it.get("created_at"))
            out[it["id"]] = (fac, parse_ts(it.get("updated_at")), cr.date() if cr else None)
    q0 = ('query { boards(ids:["%s"]) { items_page(limit:500) '
          '{ cursor items { id created_at updated_at column_values(ids:["status60"]) { text } } } } }' % BOARD_ID)
    page = monday(q0)["boards"][0]["items_page"]
    take(page["items"]); cur = page["cursor"]
    qn = ('query($c:String!) { next_items_page(limit:500, cursor:$c) '
          '{ cursor items { id created_at updated_at column_values(ids:["status60"]) { text } } } }')
    while cur:
        np = monday(qn, {"c": cur})["next_items_page"]
        take(np["items"]); cur = np["cursor"]
        if not np["items"]:
            break
    return out

def asset_urls(item_ids):
    """({item_id: public_url}, seen_ids) for the latest file in files4.

    `seen_ids` is every id the API actually returned. The caller needs it to tell a
    genuinely-unattached item apart from one the API silently dropped — see below.

    items(ids:) CARRIES A DEFAULT limit OF 25 (measured 2026-08-03: request 26 -> 25 back,
    request 50 -> 25 back, request 60 -> 25 back; with an explicit limit all are returned).
    Chunks of 50 therefore lost their last 25 ids on EVERY run, and because those items were
    never inserted they stayed "new" and were re-requested — and re-dropped — next run. That
    is the whole of the standing `no_pdf` backlog: 2026-08-01 ran 182 new/changed -> 4 chunks
    -> 100 returned, 2 of them genuinely unattached -> 98 upserted / 84 "no_pdf"; 2026-08-02
    ran 36 -> 25 returned, same 2 unattached -> 23 upserted / 13 "no_pdf". Both reconcile
    exactly. It drained slowly rather than sticking (a smaller backlog eventually fits under
    25), so the symptom read as a high error RATE instead of a truncation.

    Fix: pass the limit explicitly, bound to the chunk size, and return `seen` so a future
    silent truncation is COUNTED (api_missing) instead of being folded into `no_pdf` again.
    assets(ids:) was measured NOT to truncate (60/60 returned), so only items() is capped.

    Signed URLs expire ~1h -> use promptly.
    """
    out = {}
    seen = set()
    qf = ('query($ids:[ID!], $lim:Int!) { items(ids:$ids, limit:$lim) '
          '{ id column_values(ids:["files4"]) { value } } }')
    qa = 'query($ids:[ID!]!) { assets(ids:$ids) { id public_url } }'   # assets(ids:) requires non-null [ID!]!
    for i in range(0, len(item_ids), ITEM_CHUNK):
        chunk = item_ids[i:i+ITEM_CHUNK]
        d = monday(qf, {"ids": chunk, "lim": ITEM_CHUNK})
        asset_of = {}
        for it in d["items"]:
            seen.add(it["id"])
            cv = it.get("column_values") or [{}]
            val = cv[0].get("value")
            if not val:
                continue
            files = (json.loads(val) or {}).get("files", [])
            if files:
                asset_of[it["id"]] = str(files[-1]["assetId"])   # latest attached file
        if not asset_of:
            continue
        ad = monday(qa, {"ids": list(asset_of.values())})
        url_by_asset = {str(a["id"]): a.get("public_url") for a in ad["assets"]}
        for iid, aid in asset_of.items():
            u = url_by_asset.get(aid)
            if u:
                out[iid] = u
    return out, seen

# ---------- extract -> table row (excludes raw PHI + notes + relationship_client) ----------
def build_row(raw, iid, facility, vob_created_at, monday_updated_at):
    return {
        "monday_item_id": iid,
        "facility": facility,
        "vob_created_at": vob_created_at,
        "monday_updated_at": monday_updated_at,
        "member_id_bidx": member_bidx(raw.get("member_id")),
        "member_id_prefix_bidx": prefix_bidx(raw.get("member_id")),
        "group_number_bidx": group_bidx(raw.get("group_number")),
        "employer_name": clean(raw.get("employer_name")),
        "employer_norm": emp_norm(raw.get("employer_name")),
        "policy_type": derive_policy_type(raw),
        "funding": derive_funding(raw),
        "insurance_co": clean(raw.get("insurance_co")),
        "payer_id": clean(raw.get("payer_id")),
        "plan_type": clean(raw.get("plan_type")),
        "ind_deductible": clean(raw.get("ind_deductible")),
        "ind_deductible_met": clean(raw.get("ind_deductible_met")),
        "family_deductible": clean(raw.get("family_deductible")),
        "family_deductible_met": clean(raw.get("family_deductible_met")),
        "ind_oop_max": clean(raw.get("ind_oop_max")),
        "ind_oop_met": clean(raw.get("ind_oop_met")),
        "family_oop_max": clean(raw.get("family_oop_max")),
        "family_oop_met": clean(raw.get("family_oop_met")),
        "coinsurance_combined": clean(raw.get("coinsurance_combined")),
        "coinsurance_ip": clean(raw.get("coinsurance_ip")),
        "coinsurance_op": clean(raw.get("coinsurance_op")),
        "coinsurance_after_oop": clean(raw.get("after_oop_pct")),
        "vob_datetime": clean(raw.get("vob_datetime")),
        "schema_version": clean(raw.get("_schema_version")),
        "extraction_flag": clean(raw.get("_extraction_error")),
    }

def download_and_extract(url):
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tf:
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        tf.write(resp.content); tf.flush()
        return extract_vob.extract_pdf(tf.name)        # temp PDF removed on context exit

# ---------- DB ----------
def conninfo(url, ca):
    u = urlparse(url); q = dict(parse_qsl(u.query)); q.setdefault("sslmode", "require")
    if q.get("sslmode", "").startswith("verify"):
        if ca and os.path.exists(ca):
            q["sslrootcert"] = ca                       # full verification with the Supabase CA
        else:
            q["sslmode"] = "require"                     # CI without CA: encrypt, skip cert verify
    return urlunparse(u._replace(query=urlencode(q))), u

def main():
    if not TOKEN:
        raise SystemExit("MONDAY_API_TOKEN not set")
    board = scan_board()
    admitted = {iid: v for iid, v in board.items() if v[0]}
    print(f"board items: {len(board)} | admitted: {len(admitted)}")

    ci, u = conninfo(getenv("CMD_ROLLUP_WRITER_DATABASE_URL"), getenv("SUPABASE_CA_PATH"))
    upserted = deactivated = reactivated = errors = no_pdf = download_fail = api_missing = 0
    note_parts = []

    with psycopg.connect(ci, connect_timeout=30, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            cur.execute("select monday_item_id, monday_updated_at, deactivated_at from vob.indigo_vob")
            rows_db = cur.fetchall()
            db = {r[0]: r[1] for r in rows_db}        # iid -> monday_updated_at (change watermark)
            deact = {r[0]: r[2] for r in rows_db}     # iid -> deactivated_at (None = active)

            to_process, to_touch = [], []
            for iid, (fac, upd, _cr) in admitted.items():
                if iid not in db:
                    to_process.append((iid, fac, upd))          # NEW
                elif db[iid] is None:
                    to_touch.append((iid, upd))                  # initial-load row: adopt watermark
                elif upd and (db[iid] is None or upd > db[iid]):
                    to_process.append((iid, fac, upd))           # CHANGED
            print(f"new/changed: {len(to_process)} | watermark-backfill: {len(to_touch)}")

            # watermark-only backfill (no PDF work)
            if to_touch:
                cur.executemany("update vob.indigo_vob set monday_updated_at=%s where monday_item_id=%s",
                                [(upd, iid) for iid, upd in to_touch])

            # download + extract + upsert new/changed
            if to_process:
                urls, seen = asset_urls([iid for iid, _, _ in to_process])
                ph = "(" + ",".join(["%s"] * len(COLS)) + ")"
                setexpr = ", ".join(f"{c}=excluded.{c}" for c in COLS if c != "monday_item_id")
                sql = (f"insert into vob.indigo_vob ({', '.join(COLS)}) values {ph} "
                       f"on conflict (monday_item_id) do update set {setexpr}, loaded_at=now()")
                batch = []
                for iid, fac, upd in to_process:
                    url = urls.get(iid)
                    if not url:
                        # Split the two causes. seen == the API returned the item, so a missing
                        # URL is a real "no files4 attachment yet" (retried next run, harmless).
                        # NOT seen == the API silently dropped the id; that is the truncation
                        # class that produced the 2026-07/08 backlog and must never hide inside
                        # no_pdf again. Both still retry — only the accounting differs.
                        if iid in seen:
                            no_pdf += 1
                        else:
                            api_missing += 1
                        continue
                    try:
                        raw = download_and_extract(url)          # extract_pdf never raises (a bad PDF returns a
                        row = build_row(raw, iid, fac, board[iid][2], upd)   # row w/ extraction_flag), so this
                        batch.append(tuple(row[c] for c in COLS))           # except is a DOWNLOAD failure only.
                    except Exception:
                        download_fail += 1                       # never log the exception payload (may echo PHI)
                    if len(batch) >= 200:
                        cur.executemany(sql, batch); upserted += len(batch); batch = []
                if batch:
                    cur.executemany(sql, batch); upserted += len(batch)
            errors = no_pdf + download_fail + api_missing
            if errors:
                note_parts.append(
                    f"errors={errors} no_pdf/{download_fail} download_fail/{api_missing} api_missing")
            if api_missing:
                # Loud: this should be 0 now that items() carries an explicit limit. Non-zero means
                # the API dropped ids again (a new cap, or a cap on some other field) and VOBs are
                # being deferred indefinitely — exactly the failure this run-log exists to surface.
                note_parts.append("WARN api_missing>0: items() dropped ids — check the page limit")

            # SOFT-delete de-admitted / off-board (guarded). Mark deactivated_at instead of DELETE so
            # the benefit row is retained (it still enriches the member's historical collections
            # claims, and destroying it loses a record that's costly to rebuild). Only ACTIVE rows are
            # newly-stale; the 10% cap still guards a mass-deactivation from a bad board pull.
            stale = [iid for iid in db if iid not in admitted and deact.get(iid) is None]
            cap = max(50, int(DELETE_SAFETY_FRAC * len(db)))
            if len(stale) > cap:
                note_parts.append(f"soft-delete skipped: {len(stale)} stale > cap {cap}")
            elif stale:
                cur.executemany(
                    "update vob.indigo_vob set deactivated_at=now() where monday_item_id=%s and deactivated_at is null",
                    [(iid,) for iid in stale])
                deactivated = len(stale)

            # REACTIVATE: a previously soft-deleted row that is admitted again → clear the marker. An
            # unchanged re-admit won't appear in to_process (no watermark change), so handle it here.
            readmit = [iid for iid in admitted if deact.get(iid) is not None]
            if readmit:
                cur.executemany(
                    "update vob.indigo_vob set deactivated_at=null where monday_item_id=%s and deactivated_at is not null",
                    [(iid,) for iid in readmit])
                reactivated = len(readmit)

            note = "; ".join(note_parts)
            cur.execute(
                "insert into vob.sync_state "
                "(source,last_run_at,board_items,admitted,upserted,deactivated,reactivated,errors,note) "
                "values (%s, now(), %s,%s,%s,%s,%s,%s,%s) "
                "on conflict (source) do update set last_run_at=now(), board_items=excluded.board_items, "
                "admitted=excluded.admitted, upserted=excluded.upserted, deactivated=excluded.deactivated, "
                "reactivated=excluded.reactivated, errors=excluded.errors, note=excluded.note",
                (SOURCE, len(board), len(admitted), upserted, deactivated, reactivated, errors, note))

            # Append-only run history (0075). sync_state is one row per source, so it can only ever
            # answer "how was the LAST run" — which is exactly why the items() truncation sat
            # unnoticed: a stable errors=84 reads like a steady state, not a defect. This row makes
            # the error split trendable (see the migration's verification block).
            cur.execute(
                "insert into vob.sync_run "
                "(source,board_items,admitted,to_process,upserted,deactivated,reactivated,"
                " no_pdf,download_fail,api_missing,note) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (SOURCE, len(board), len(admitted), len(to_process), upserted, deactivated,
                 reactivated, no_pdf, download_fail, api_missing, note))
        conn.commit()
        # Refresh the materialized latest-per-member set (migration 0063). Strictly, only `upserted`
        # (new/changed benefit data) alters matview CONTENT today — a soft-delete/reactivate touches
        # only deactivated_at, which the matview does not project. We refresh on any of the three so
        # this stays correct if the matview is ever narrowed to `where deactivated_at is null`; the
        # extra refresh is rare (de-admissions are capped) and cheap. Watermark-only backfill
        # (to_touch) never triggers it. SECURITY DEFINER fn; REFRESH ... CONCURRENTLY never blocks readers.
        if upserted or deactivated or reactivated:
            with conn.cursor() as cur:
                cur.execute("select vob.refresh_member_benefits_latest()")
            conn.commit()

    print(f"upserted={upserted} watermark_backfill={len(to_touch)} "
          f"deactivated={deactivated} reactivated={reactivated} "
          f"errors={errors} (no_pdf={no_pdf} download_fail={download_fail} "
          f"api_missing={api_missing}) note={note or '-'}")

if __name__ == "__main__":
    main()
