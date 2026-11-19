"""Turn any admissions file (messy CSV, TSV, Excel, Parquet) into a clean, versioned, pseudonymized table.

Everything is read as text so nothing is silently coerced; typing happens later, per model.
"""

import csv
import hashlib
import hmac
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

SUPPORTED = {"csv", "tsv", "txt", "xlsx", "xls", "parquet"}
NULLS = {"", "na", "n/a", "#n/a", "null", "none", "nan", "nat", "-", "--", "?", "(blank)", "missing"}
ENCODINGS = ("utf-8-sig", "cp1252", "latin-1")

_norm = lambda s: re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")  # noqa: E731

# Direct identifiers are never stored. Protected and restricted fields (race, FAFSA) are kept in the
# data but excluded from models by the engine's guards.
PII_NAMES = re.compile(
    r"^((student|applicant|preferred|legal|full|first|last|middle|given|family|maiden|sur)_?)*name$"
    r"|e_?mail|phone|mobile|cell_?num|ssn|social_?sec|birth|^dob$|street|address|addr_?line|passport|driver_?lic"
)
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
SSN = re.compile(r"^\d{3}-\d{2}-\d{4}$")
PHONE = re.compile(r"^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$")
# behavioural metrics that merely mention a contact channel (email opens, call counts, engagement scores) are not PII
METRIC_NAMES = re.compile(r"open|click|engag|score|count|rate|sent|calls|attempt|response|bounce|_n$|^n_|num_")
ID_NAMES = re.compile(r"(^|_)(emplid|student_?id|stu_?id|sid|applicant_?id|person_?id|banner_?id|pidm|campus_?id|id)$")
BOOL = {"y", "n", "yes", "no", "true", "false", "t", "f", "0", "1"}


@dataclass
class Ingested:
    data: pd.DataFrame
    idmap: pd.DataFrame | None
    id_column: str | None
    dropped: list[dict] = field(default_factory=list)
    profile: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def checksum(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sniff_kind(path: str, filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    head = open(path, "rb").read(8)
    if head.startswith(b"PK"):
        return "xlsx"
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        return "xls"
    if head.startswith(b"PAR1"):
        return "parquet"
    if ext not in SUPPORTED:
        raise ValueError("Unsupported file type. Use CSV, TSV, Excel or Parquet.")
    return "csv" if ext in {"csv", "tsv", "txt"} else ext


def _read_text(path: str) -> pd.DataFrame:
    raw = open(path, "rb").read(1 << 20)
    encoding = next((e for e in ENCODINGS if _decodes(raw, e)), "latin-1")
    sample = raw.decode(encoding, errors="replace")
    try:
        sep = csv.Sniffer().sniff("\n".join(sample.splitlines()[:50]), delimiters=",;\t|").delimiter
    except csv.Error:
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
    return pd.read_csv(path, sep=sep, dtype=str, keep_default_na=False, encoding=encoding, on_bad_lines="skip", low_memory=False)


def _decodes(raw: bytes, encoding: str) -> bool:
    try:
        raw.decode(encoding)
        return True
    except UnicodeDecodeError:
        return False


def read_any(path: str, kind: str) -> pd.DataFrame:
    if kind == "csv":
        return _read_text(path)
    if kind in {"xlsx", "xls"}:
        sheets = pd.read_excel(path, sheet_name=None, dtype=str, keep_default_na=False)
        return max(sheets.values(), key=len)  # the largest sheet holds the data
    df = pd.read_parquet(path)
    return df.astype("string").fillna("").astype(str)


def _clean_headers(cols) -> list[str]:
    out, seen = [], {}
    for i, c in enumerate(cols):
        name = str(c).strip()
        if not name or name.lower().startswith("unnamed:"):
            name = f"column_{i + 1}"
        n = seen.get(name, 0)
        seen[name] = n + 1
        out.append(name if n == 0 else f"{name}_{n + 1}")
    return out


def _tidy(c: pd.Series) -> pd.Series:
    """Trim spaces and blank out null markers, once per distinct value (columns repeat a few values many times)."""
    codes, uniq = pd.factorize(c, use_na_sentinel=False)
    u = pd.Series(uniq, dtype=object).astype(str).str.strip()
    u = u.mask(u.str.lower().isin(NULLS), "")
    return pd.Series(u.to_numpy(dtype=object)[codes], index=c.index)


def _share(values: pd.Series, pattern: re.Pattern) -> float:
    s = values[values != ""].head(500)
    return float(s.str.match(pattern).mean()) if len(s) else 0.0


def _kind(s: pd.Series, n: int, is_id: bool) -> str:
    if is_id:
        return "identifier"
    vals = s[s != ""]
    if vals.empty:
        return "text"
    lowered = pd.Series(vals.unique()).str.lower().unique()
    if set(lowered[:20]) <= BOOL and len(lowered) <= 2:
        return "boolean"
    sample = vals.head(2000)
    if pd.to_numeric(sample.str.replace(",", "", regex=False), errors="coerce").notna().mean() >= 0.95:
        return "numeric"
    if sample.str.contains(r"\d{1,4}[-/]\d{1,2}[-/]\d{1,4}", regex=True).mean() >= 0.9:
        return "date"
    distinct = vals.nunique()
    return "categorical" if distinct <= max(50, n * 0.05) else "text"


def ingest(path: str, filename: str, tenant_key: str) -> Ingested:
    return ingest_frame(read_any(path, sniff_kind(path, filename)), tenant_key)


def ingest_frame(df: pd.DataFrame, tenant_key: str) -> Ingested:
    df = df.copy()
    df.columns = _clean_headers(df.columns)
    df = df.apply(_tidy)
    df = df.loc[(df != "").any(axis=1), (df != "").any(axis=0)].reset_index(drop=True)
    if df.empty:
        raise ValueError("This file has no data. Check that the first row holds the column names.")

    warnings: list[str] = []
    dropped: list[dict] = []
    for col in list(df.columns):
        name = _norm(col)
        reason = None
        present = df[col][df[col] != ""]
        numeric = len(present) > 0 and pd.to_numeric(present.head(5000), errors="coerce").notna().mean() >= 0.95
        if PII_NAMES.search(name) and not ID_NAMES.search(name) and not (METRIC_NAMES.search(name) and numeric):
            reason = "personal contact or identity details"
        elif _share(df[col], EMAIL) > 0.5:
            reason = "email addresses"
        elif _share(df[col], SSN) > 0.5:
            reason = "social security numbers"
        elif _share(df[col], PHONE) > 0.5 and not ID_NAMES.search(name):
            reason = "phone numbers"
        if reason:
            dropped.append({"column": col, "reason": reason})
            df = df.drop(columns=col)

    # Student IDs are replaced with keyed tokens; the mapping is stored separately for authorized exports.
    id_col = next((c for c in df.columns if ID_NAMES.search(_norm(c))), None)
    idmap = None
    if id_col:
        key = tenant_key.encode()
        originals = df[id_col]
        tokens = originals.map(lambda v: hmac.new(key, v.encode(), hashlib.sha256).hexdigest()[:20] if v else "")
        idmap = pd.DataFrame({"token": tokens, "value": originals}).drop_duplicates()
        df[id_col] = tokens
    else:
        warnings.append("No student ID column was found; rows can't be tracked across files.")

    n = len(df)
    dupes = int(df.duplicated().sum())
    if dupes:
        warnings.append(f"{dupes:,} duplicate rows.")
    if n < 50:
        warnings.append("Very few rows; forecasts will be unreliable.")

    profile = []
    for col in df.columns:
        s = df[col]
        missing = float((s == "").mean())
        if missing > 0.6:
            warnings.append(f"'{col}' is mostly blank.")
        kind = _kind(s, n, col == id_col)
        profile.append(
            {
                "name": col,
                "kind": kind,
                "missing_pct": round(missing * 100, 1),
                "distinct": int(s[s != ""].nunique()),
                "sample": [] if kind == "identifier" else s[s != ""].drop_duplicates().head(3).tolist(),
            }
        )
    return Ingested(df, idmap, id_col, dropped, profile, warnings)


def to_parquet(df: pd.DataFrame, path: str | Path) -> None:
    df.to_parquet(path, index=False, compression="zstd")


def safe_filename(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).name)[:120]
    return base or "upload"


__all__ = ["Ingested", "SUPPORTED", "checksum", "ingest", "ingest_frame", "safe_filename", "to_parquet"]
