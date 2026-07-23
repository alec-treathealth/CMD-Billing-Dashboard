"""Blind-index derivation for VOB matching — byte-for-byte port of the app's
src/collections/blindIndex.ts (+ normalize.ts::normalizeMemberId). VALIDATED 2026-07-22
against the actual TS across a stratified 1,501-member sample: 100% match on member,
prefix, and group tokens in every format-class bucket.

Reads INDEX_HMAC_KEY from a loader env file (default /Users/aleclowi/vob-data/loader.env).
Never logs the key, PHI, or tokens. Tokens are keyed one-way HMAC digests (not PHI)."""
import hmac, hashlib, re, os

# Exact JS String whitespace set (WhiteSpace + LineTerminator), built from code points so the
# source stays ASCII. Matches JS trim()/replace(/\s+/) — NOT Python's \s.
_JS_WS_CP = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
             0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
             0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
JS_WS = "".join(chr(c) for c in _JS_WS_CP)
WS_RE = re.compile("[" + re.escape(JS_WS) + "]+")

def load_key(path=None):
    # CI/cron: prefer the env var (GH Actions secret). Local: fall back to loader.env.
    hexk = os.environ.get("INDEX_HMAC_KEY")
    if not hexk:
        path = path or os.environ.get("VOB_LOADER_ENV", "/Users/aleclowi/vob-data/loader.env")
        for line in open(path):
            if line.startswith("INDEX_HMAC_KEY="):
                hexk = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not hexk:
        raise SystemExit("INDEX_HMAC_KEY not found (env or loader.env)")
    if len(hexk) != 64 or not re.fullmatch(r"[0-9a-fA-F]{64}", hexk):
        raise SystemExit("INDEX_HMAC_KEY must be 32 bytes as 64 hex chars")
    return bytes.fromhex(hexk)

_KEY = load_key()

def _hmac(norm):
    if norm is None or norm == "":
        return None
    return hmac.new(_KEY, norm.encode("utf-8"), hashlib.sha256).hexdigest()

def _trim(s):
    return s.strip(JS_WS)                         # JS String.prototype.trim()

def member_norm(raw):                             # normalizeMemberId(raw).norm
    if raw is None:
        return None
    t = _trim(raw)
    if t == "":
        return None
    n = re.sub(r"^-+", "", WS_RE.sub("", t.upper()))
    return n if n != "" else None

def member_bidx(raw):
    return _hmac(member_norm(raw))

def prefix_bidx(raw):                             # first 3 chars of normalized member id
    n = member_norm(raw)
    return _hmac(n[:3]) if (n and len(n) >= 3) else None

def group_norm(raw):                              # trim/upper/strip-\s ONLY (no dash strip)
    if raw is None:
        return None
    n = WS_RE.sub("", _trim(raw).upper())
    return n if n != "" else None

def group_bidx(raw):
    return _hmac(group_norm(raw))
