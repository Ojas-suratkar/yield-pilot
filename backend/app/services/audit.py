"""Data suitability audit: checks with a weighted score, plus one-click fixes that create a new data version."""

import re

import pandas as pd

from .fields import FIELDS, outcome, vmap

_norm = lambda s: re.sub(r"[^a-z0-9]", "", str(s).lower())  # noqa: E731


def _features(df: pd.DataFrame, m: dict) -> list[str]:
    skip = {m.get("studentId"), m.get("term"), m.get("outcome")}
    return [c for c in df.columns if c not in skip]


def run_audit(df: pd.DataFrame, m: dict) -> dict:
    n = max(1, len(df))
    checks, fixes = [], []

    status = [{"key": f["key"], "label": f["label"], "column": m.get(f["key"]) if m.get(f["key"]) in df else None, "required": f["required"]} for f in FIELDS]
    missing_req = [f["label"] for f in status if f["required"] and not f["column"]]
    found = sum(1 for f in status if f["column"])
    checks.append({
        "key": "fields", "title": "Required Fields", "value": f"{found} of {len(FIELDS)}", "weight": 25,
        "status": "fail" if missing_req else "pass" if found >= 7 else "warn",
        "score": 30 if missing_req else round(found / len(FIELDS) * 100),
        "detail": f"Missing {', '.join(missing_req)}. Match them in Detected Fields." if missing_req
        else "All the essential fields are present." if found >= 7 else "The essentials are present. GPA, aid or engagement fields would strengthen predictions.",
    })

    tcol, ocol = m.get("term"), m.get("outcome")
    past = 0
    if tcol in df and ocol in df:
        y = vmap(df[ocol], outcome)
        g = pd.DataFrame({"t": df[tcol], "k": y.notna()}).groupby("t")["k"].agg(["size", "sum"])
        past = int(((g["sum"] >= 10) & (g["sum"] >= g["size"] * 0.5)).sum())
    checks.append({
        "key": "history", "title": "Historical Data", "value": f"{past} term{'s' if past != 1 else ''}", "weight": 20,
        "status": "pass" if past >= 2 else "warn" if past == 1 else "fail", "score": min(100, round(past / 3 * 100)),
        "detail": "Enough past terms with known outcomes to learn from." if past >= 2
        else "Only one past term has outcomes; two or more are better." if past == 1 else "No past term has enrollment outcomes yet.",
    })

    feats = _features(df, m)
    blank = (df[feats] == "") if feats else pd.DataFrame()
    pct_cols = blank.mean() if feats else pd.Series(dtype=float)
    missing_pct = float(blank.values.mean() * 100) if feats else 0.0
    fillable = [c for c in feats if 0 < pct_cols[c] <= 0.6]
    unusable = [c for c in feats if pct_cols[c] > 0.6 or df[c].nunique() <= 1]
    checks.append({
        "key": "missing", "title": "Missing Values", "value": f"{missing_pct:.1f}%", "weight": 15,
        "status": "pass" if missing_pct < 5 else "warn" if missing_pct < 20 else "fail", "score": max(0, round(100 - missing_pct * 3)),
        "detail": "Very few blanks." if missing_pct < 5 else f"{len(fillable)} column(s) have blanks that can be filled in.",
    })
    if fillable:
        fixes.append({"key": "fillBlanks", "title": "Fill in blank values",
                      "detail": f"Fills blanks in {len(fillable)} column(s): numbers with the median, text with \"Unknown\"."})
    if unusable:
        more = f" and {len(unusable) - 4} more" if len(unusable) > 4 else ""
        fixes.append({"key": "dropUnusable", "title": "Remove unusable columns",
                      "detail": f"{', '.join(unusable[:4])}{more} {'is' if len(unusable) == 1 else 'are'} mostly blank or the same for everyone."})

    if ocol in df:
        present = df[ocol][df[ocol] != ""]
        known = vmap(present, outcome).notna()
        pct = float(known.mean() * 100) if len(present) else 0.0
        odd = present[~known].unique()[:4].tolist()
    else:
        pct, odd = 0.0, []
    checks.append({
        "key": "outcome", "title": "Outcome Available", "value": f"{pct:.0f}%" if ocol else "Not found", "weight": 20,
        "status": "fail" if not ocol else "pass" if pct >= 95 else "warn" if pct >= 70 else "fail", "score": round(pct) if ocol else 0,
        "detail": "Match the column that says whether each student enrolled." if not ocol
        else f"Some values weren't understood: {', '.join(odd)}. Use Yes/No or 1/0." if odd else "Every filled-in outcome is readable.",
    })

    sid = m.get("studentId")
    dupes = int(df.duplicated(subset=[c for c in (sid, tcol) if c in df]).sum()) if sid in df else 0
    checks.append({
        "key": "duplicates", "title": "Duplicate Records", "value": f"{dupes:,}", "weight": 10,
        "status": "pass" if not dupes else "warn" if dupes < n * 0.01 else "fail", "score": max(0, round(100 - dupes / n * 1000)),
        "detail": f"{dupes:,} student(s) appear more than once in the same term." if dupes else "Each student appears once per term.",
    })
    if dupes:
        fixes.append({"key": "dedupe", "title": "Remove duplicate students", "detail": f"Keeps the first row per student and term; removes {dupes:,} repeat(s)."})

    variants = _variants(df, feats)
    count = sum(len(g) for g in variants.values())
    first = next(iter(variants.items()), None)
    checks.append({
        "key": "consistency", "title": "Cross-Source Consistency", "value": f"{count} to tidy" if count else "All good", "weight": 10,
        "status": "warn" if count else "pass", "score": max(0, 100 - count * 10),
        "detail": f"Some values are written different ways, like {' and '.join(repr(v) for v in first[1][0])} in {first[0]}." if first
        else "Values are written the same way throughout.",
    })
    if count:
        fixes.append({"key": "standardize", "title": "Standardize labels", "detail": f"Merges {count} group(s) of values written different ways to their most common form."})

    score = round(sum(c["score"] * c["weight"] for c in checks) / sum(c["weight"] for c in checks))
    fails = any(c["status"] == "fail" for c in checks)
    return {
        "score": score,
        "status": "Needs attention" if fails or score < 60 else "Ready with small fixes" if fixes else "Ready",
        "checks": checks,
        "fixes": fixes,
        "fields": status,
    }


def _variants(df: pd.DataFrame, feats: list[str]) -> dict[str, list[list[str]]]:
    out = {}
    for c in feats:
        vals = df[c][df[c] != ""]
        distinct = vals.unique()
        if not 2 <= len(distinct) <= 60 or pd.to_numeric(pd.Series(distinct), errors="coerce").notna().all():
            continue
        groups: dict[str, list[str]] = {}
        for v in distinct:
            groups.setdefault(_norm(v), []).append(v)
        multi = [g for g in groups.values() if len(g) > 1]
        if multi:
            out[c] = multi
    return out


def apply_fixes(df: pd.DataFrame, m: dict, keys: list[str]) -> pd.DataFrame:
    feats = _features(df, m)
    out = df.copy()
    if "dedupe" in keys and m.get("studentId") in out:
        out = out.drop_duplicates(subset=[c for c in (m.get("studentId"), m.get("term")) if c in out])
    if "standardize" in keys:
        for c, groups in _variants(out, feats).items():
            counts = out[c].value_counts()
            for g in groups:
                best = max(g, key=lambda v: counts.get(v, 0))
                out[c] = out[c].replace({v: best for v in g if v != best})
    if "fillBlanks" in keys:
        for c in feats:
            s = out[c]
            share = (s == "").mean()
            if not 0 < share <= 0.6:
                continue
            nums = pd.to_numeric(s[s != ""].str.replace(",", "", regex=False), errors="coerce")
            fill = (f"{nums.median():g}" if nums.notna().all() else "Unknown") if len(nums) else "Unknown"
            out[c] = s.where(s != "", fill)
    if "dropUnusable" in keys:
        drop = [c for c in feats if c in out and ((out[c] == "").mean() > 0.6 or out[c].nunique() <= 1)]
        out = out.drop(columns=drop)
    return out.reset_index(drop=True)
