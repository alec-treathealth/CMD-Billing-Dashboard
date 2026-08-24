"""
READ-ONLY PAYER-BEHAVIOR ML ANALYSIS — shared layer. NOT wired into any app path.

PHI DISCIPLINE (absolute, same posture as scripts/probe-*.ts):
  - Connects ONLY via CLAIMS_READER_DATABASE_URL (read-only role). No writes are
    possible structurally: SELECTs only, no temp tables, no transactions beyond
    the RLS GUC set_config.
  - Every query projects an explicit, allowlisted column list. NEVER a patient
    name, member id, group number, employer, bidx/bytea column, or claim id.
    Payer names, CPT/rev/CARC codes, facility codes, dates, counts and dollar
    aggregates are business identifiers, not patient identifiers.
  - Everything written to out/ is a payer-level aggregate. Nothing row-grain.

TLS: verify-full against certs/supabase-ca.crt (repo rule: never sslmode in the
URL — here sslmode/sslrootcert are passed as explicit connect kwargs, the psycopg
equivalent of src/ssl.ts's verifyFullSsl()).

Supavisor pooler (port 6543) forbids named prepared statements -> we disable
psycopg's auto-prepare (prepare_threshold = None).
"""
from __future__ import annotations

import csv
import os
import re
from pathlib import Path

import psycopg

REPO = Path(__file__).resolve().parents[2]
# Window controls: PAYER_ML_OUT picks the output dir (default "out"),
# PAYER_ML_SINCE (ISO date) restricts every pull to rows on/after that date.
OUT = Path(__file__).resolve().parent / os.environ.get("PAYER_ML_OUT", "out")
RESULTS = OUT / "results"
SINCE = os.environ.get("PAYER_ML_SINCE") or None

# Canonical tenant UUIDs — src/tenants.ts is the source of truth; keep in sync.
ENTITIES = {
    "BXR": "af504ab6-3dcd-4aa4-a93c-27bc58de4088",
    "INDIGO": "141d459c-f371-4229-9a92-ace198e940bb",
}


def load_env() -> None:
    """Non-overriding .env loader (mirrors scripts/probe-era-coverage.ts)."""
    env_path = REPO / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text().splitlines():
        t = raw.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        key, _, val = t.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        os.environ[key] = val


def connect() -> psycopg.Connection:
    load_env()
    url = os.environ.get("CLAIMS_READER_DATABASE_URL")
    if not url:
        raise SystemExit("CLAIMS_READER_DATABASE_URL not set")
    # Strip any ssl-ish query params so kwargs below are the only TLS authority
    # (same rationale as src/ssl.ts sanitizeConnectionString).
    if "?" in url:
        base, _, q = url.partition("?")
        keep = [
            p
            for p in q.split("&")
            if p.split("=")[0] not in ("sslmode", "ssl", "sslrootcert", "sslcert", "sslkey")
        ]
        url = base + ("?" + "&".join(keep) if keep else "")
    conn = psycopg.connect(
        url,
        sslmode="verify-full",
        sslrootcert=str(REPO / "certs" / "supabase-ca.crt"),
    )
    conn.prepare_threshold = None  # Supavisor: no named prepared statements
    conn.read_only = True
    return conn


def fetch(conn: psycopg.Connection, sql: str, params=(), entity_id: str | None = None):
    """Run one SELECT (optionally inside a tenant-GUC transaction) -> (cols, rows)."""
    with conn.transaction():
        with conn.cursor() as cur:
            if entity_id is not None:
                # GUC name is a fixed literal; only the value is bound.
                cur.execute(
                    "select set_config('app.business_entity_id', %s, true)", (entity_id,)
                )
            cur.execute(sql, params)
            cols = [d.name for d in cur.description]
            rows = cur.fetchall()
    return cols, rows


def write_csv(name: str, cols, rows) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        w.writerows(rows)
    return path


# ── Payer-family heuristic ─────────────────────────────────────────────────────
# Fallback canonicalization for spellings absent from ref.payer_alias_map.
# Ordered: first match wins. Families mirror ref.payer_identity.payer_family
# granularity (12 families) plus the big national carriers.
_FAMILY_RULES: list[tuple[str, str]] = [
    (r"UNITED ?HEALTH|\bUHC\b|\bUMR\b|OPTUM|OXFORD|GOLDEN RULE|ALL SAVERS|\bSUREST\b|\bBIND\b|UNITED HC|UNITEDHC", "UnitedHealth"),
    (r"BLUE ?CROSS|BLUE ?SHIELD|\bBCBS\b|\bBC ?BS\b|ANTHEM|HIGHMARK|CAREFIRST|WELLMARK|PREMERA|REGENCE|HORIZON BLUE|EMPIRE|EXCELLUS|INDEPENDENCE BLUE|\bIBX\b|FLORIDA BLUE|CAREPLUS|BLUECROSS|BLUE ADVANTAGE", "Blues (BCBS/Anthem)"),
    (r"AETNA|MERITAIN|FIRST HEALTH", "Aetna/CVS"),
    (r"CIGNA|EVERNORTH|GREAT ?-?WEST", "Cigna/Evernorth"),
    (r"HUMANA", "Humana"),
    (r"KAISER", "Kaiser"),
    (r"MEDICARE|RAILROAD|CMS\b|NORIDIAN|NOVITAS|PALMETTO|WPS\b|CGS\b|FIRST COAST", "Medicare"),
    (r"MEDICAID|MOLINA|AMERIGROUP|CARESOURCE|AMBETTER|CENTENE|MAGNOLIA|SUPERIOR HEALTH|WELLCARE|HEALTHY BLUE|PEACH STATE|SUNSHINE HEALTH|BUCKEYE|MERIDIAN|ILLINICARE", "Medicaid/MCO"),
    (r"TRICARE|HEALTH NET FEDERAL|HUMANA MILITARY|TRIWEST|CHAMPVA|\bVA\b.*COMMUNITY|VETERAN", "Tricare/VA"),
    (r"\bGEHA\b", "GEHA"),
    (r"MAGELLAN", "Magellan"),
    (r"BEACON|CARELON|VALUE ?OPTIONS", "Carelon/Beacon"),
    (r"COMPSYCH", "ComPsych"),
    (r"MULTIPLAN|\bPHCS\b", "MultiPlan/PHCS"),
    (r"ALLIED BENEFIT", "Allied Benefit"),
    (r"WEB.?TPA|WEBTPA", "WebTPA"),
    (r"HEALTH ?SCOPE|HEALTHSCOPE", "HealthScope"),
    (r"TRUSTMARK", "Trustmark"),
    (r"LUCENT|EMBLEM|GHI\b", "EmblemHealth"),
    (r"HARVARD PILGRIM|POINT32|TUFTS", "Point32Health"),
]
_FAMILY_COMPILED = [(re.compile(pat), fam) for pat, fam in _FAMILY_RULES]

_NORM_RE = re.compile(r"[^A-Z0-9 ]+")
_WS_RE = re.compile(r"\s+")


def norm_name(raw: str) -> str:
    s = _NORM_RE.sub(" ", (raw or "").upper())
    return _WS_RE.sub(" ", s).strip()


def family_of(spelling: str) -> str:
    up = " " + norm_name(spelling) + " "
    for rx, fam in _FAMILY_COMPILED:
        if rx.search(up):
            return fam
    return "Other/Regional"
