"""AI data audit: Gemini studies column-level statistics, explains each problem and proposes a fix.

Gemini never edits data directly. It picks from a fixed set of operations (OPS); the user chooses which to run;
apply() executes them on a copy, which is saved as a new dataset version (the original stays, with undo).
"""

import hashlib
import json

import numpy as np
import pandas as pd

from ..engine.recipe import to_number
from . import ai
from . import audit as rules
from .fields import FIELDS, admitted, outcome, vmap

OPS = ["fill_missing", "recode_values", "trim_whitespace", "to_number", "drop_columns", "drop_duplicates", "drop_rows", "clip_range", "change_case"]

SYSTEM = (
    "You are a senior data engineer preparing university admissions data for an admit-to-enroll yield model. "
    "You receive column statistics (never raw student records). Find the problems that would hurt the forecast: "
    "outcome or admit-status values the model can't read (the enrolled column must read as 1/0 or Yes/No), inconsistent "
    "category labels, numbers stored as text, impossible values, blank-heavy or constant columns, duplicate student-term "
    "records, mixed term formats. For each problem give a plain-English explanation an enrollment analyst understands, with no statistics terms like variance, dimensionality or bias, "
    "the impact on the forecast, and exactly one fix using an allowed operation with its parameters. Use exact column names "
    "and exact existing values. Never drop the student ID, term or outcome columns. Prefer the least destructive fix. "
    "Every value is stored as text by design and numbers are parsed automatically, so only use to_number when a numeric "
    "column contains non-numeric junk (listed in examples_non_numeric). For inconsistent labels use recode_values that map "
    "each variant to the most common existing spelling (don't re-case a whole column). When outcome_unreadable_values is "
    "not empty, recode those values of the outcome column to 1 (enrolled) or 0 (did not enroll). Blank outcomes are expected: "
    "they mark admits whose term hasn't happened yet, which is exactly what gets forecast, so never fill, recode or drop blank "
    "outcomes and never drop rows because the outcome or term is blank. Severity high = would "
    "distort or block the forecast. Only report real problems you can see in the statistics; return an empty list if the data is clean."
)

ISSUE = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "severity": {"type": "STRING", "enum": ["high", "medium", "low"]},
        "column": {"type": "STRING"},
        "explanation": {"type": "STRING"},
        "impact": {"type": "STRING"},
        "op": {"type": "STRING", "enum": OPS},
        "columns": {"type": "ARRAY", "items": {"type": "STRING"}},
        "strategy": {"type": "STRING", "enum": ["median", "mode", "value"]},
        "value": {"type": "STRING"},
        "pairs": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"from": {"type": "STRING"}, "to": {"type": "STRING"}}, "required": ["from", "to"]}},
        "values": {"type": "ARRAY", "items": {"type": "STRING"}},
        "min": {"type": "NUMBER"},
        "max": {"type": "NUMBER"},
        "case": {"type": "STRING", "enum": ["upper", "lower", "title"]},
    },
    "required": ["title", "severity", "explanation", "impact", "op", "columns"],
}
SCHEMA = {"type": "OBJECT", "properties": {"summary": {"type": "STRING"}, "issues": {"type": "ARRAY", "items": ISSUE}}, "required": ["summary", "issues"]}


def plan_key(version_id: str, mapping: dict) -> str:
    return hashlib.sha256(f"{version_id}:{json.dumps(mapping, sort_keys=True)}".encode()).hexdigest()[:32]


def _stats(df: pd.DataFrame, m: dict, id_col: str | None) -> dict:
    roles = {c: f["key"] for f in FIELDS if (c := m.get(f["key"]))}
    cols = []
    for c in df.columns:
        s = df[c]
        blank = int((s == "").sum())
        distinct = int(s[s != ""].nunique())
        e = {"name": c, "role": roles.get(c), "blank": blank, "blank_pct": round(blank / max(1, len(s)) * 100, 1), "distinct": distinct}
        if c == id_col:
            e["kind"] = "student id (hashed)"
            e["duplicate_ids"] = int(s.duplicated().sum())
        else:
            x = to_number(s)
            present = int((s != "").sum())
            if present and x.notna().sum() >= 0.8 * present:
                e.update(kind="numeric", non_numeric=int(present - x.notna().sum()),
                         examples_non_numeric=s[(s != "") & x.isna()].drop_duplicates().head(5).tolist(),
                         **{k: (round(float(v), 3) if pd.notna(v) else None) for k, v in
                            {"min": x.min(), "p01": x.quantile(0.01), "median": x.median(), "p99": x.quantile(0.99), "max": x.max()}.items()})
            elif distinct <= 200:
                vc = s.value_counts()
                e.update(kind="category", values=[{"value": str(k), "count": int(n)} for k, n in vc.head(30).items()])
            else:
                e.update(kind="free text", examples_length=int(s.str.len().median()))
        cols.append(e)
    out = {"rows": int(len(df)), "columns": cols}
    if m.get("outcome") in df:
        y = vmap(df[m["outcome"]], outcome)
        out["outcome_readable_pct"] = round(float(y.notna().mean() * 100), 1)
        out["outcome_unreadable_values"] = df[m["outcome"]][y.isna() & (df[m["outcome"]] != "")].value_counts().head(10).to_dict()
    if m.get("admitStatus") in df:
        out["admitted_share_pct"] = round(float(vmap(df[m["admitStatus"]], admitted).astype(float).mean() * 100), 1)
    keys = [c for c in (id_col, m.get("term")) if c in df]
    if len(keys) == 2:
        out["duplicate_student_term_rows"] = int(df.duplicated(subset=keys).sum())
    return out


def _fallback(df: pd.DataFrame, m: dict) -> dict:
    """Without Gemini: the rule-based fixes, run through the same approval flow."""
    found = rules.run_audit(df, m)["fixes"]
    issues = [{"title": f["title"], "severity": "medium", "column": "", "explanation": f["detail"], "impact": "Improves forecast accuracy.",
               "op": "rule_fix", "value": f["key"], "columns": []} for f in found]
    return {"summary": "Rule-based checks (the AI review is unavailable right now).", "issues": issues, "source": "rules"}


def plan(df: pd.DataFrame, m: dict, id_col: str | None, checks: list[dict], progress=lambda *a, **k: None) -> dict:
    stats = _stats(df, m, id_col)
    progress(25, f"AI is reviewing your {len(df.columns)} columns")

    def found(text: str) -> None:
        if k := text.count('"title"'):
            progress(25, None, f"{k} {'problem' if k == 1 else 'problems'} found so far")

    res = ai.generate(
        "Review this dataset and return the problems with one fix each.\n\nFIELD MAPPING (role -> column):\n" + json.dumps(m)
        + "\n\nAUTOMATED CHECKS:\n" + json.dumps([{k: c[k] for k in ("title", "value", "status", "detail")} for c in checks])
        + "\n\nCOLUMN STATISTICS:\n" + json.dumps(stats, default=str),
        system=SYSTEM, schema=SCHEMA, thinking=256, max_tokens=5000, on_text=found, purpose="data_review",
    )
    progress(92, "Checking each proposed fix is safe")
    if not isinstance(res, dict) or not isinstance(res.get("issues"), list):
        out = _fallback(df, m)
    else:
        out = {"summary": res.get("summary", ""), "issues": [i for i in res["issues"] if _valid(i, df, m, id_col)], "source": "gemini"}
    for n, i in enumerate(out["issues"]):
        i["id"] = f"fix{n + 1}"
    return out


PROTECTED = ("studentId", "term", "outcome")


def _targets(i: dict) -> list[str]:
    return [c for c in (i.get("columns") or ([i["column"]] if i.get("column") else []))]


def _valid(i: dict, df: pd.DataFrame, m: dict, id_col: str | None) -> bool:
    if i.get("op") not in OPS:
        return False
    cols = _targets(i)
    if i["op"] in ("drop_duplicates", "trim_whitespace") and not cols:
        return True
    if not cols or any(c not in df.columns for c in cols):
        return False
    protected = {m.get(k) for k in PROTECTED} | {id_col}
    if i["op"] in ("drop_columns", "fill_missing", "drop_rows") and protected & set(cols):
        return False  # blank outcomes are the admits being forecast; IDs and terms are never edited this way
    if i["op"] == "recode_values" and m.get("outcome") in cols and any(not str(x.get("from", "")).strip() for x in i.get("pairs") or []):
        return False
    if i["op"] in ("fill_missing", "recode_values", "to_number", "clip_range", "change_case") and id_col in cols:
        return False
    if i["op"] == "recode_values" and not i.get("pairs"):
        return False
    return True


def apply(df: pd.DataFrame, m: dict, id_col: str | None, issues: list[dict]) -> tuple[pd.DataFrame, list[str]]:
    out, done = df.copy(), []
    tcol = m.get("term") if m.get("term") in df else None
    for i in issues:
        before = out
        out = _apply_one(out, m, id_col, i)
        if tcol and tcol in out and set(before[tcol].unique()) - set(out[tcol].unique()):
            out = before  # a fix may never wipe out a whole term
            continue
        if not out.equals(before):
            done.append(i["title"])
    return out.reset_index(drop=True), done


def _apply_one(out: pd.DataFrame, m: dict, id_col: str | None, i: dict) -> pd.DataFrame:
    out = out.copy()
    op, cols = i["op"], _targets(i)
    if op == "rule_fix":
        out = rules.apply_fixes(out, m, [i["value"]])
    elif op == "fill_missing":
        for c in cols:
            blank = out[c] == ""
            if not blank.any():
                continue
            if i.get("strategy") == "median":
                x = to_number(out[c])
                fill = "" if x.notna().sum() == 0 else (f"{x.median():g}")
            elif i.get("strategy") == "value":
                fill = str(i.get("value") or "Unknown")
            else:
                vc = out.loc[~blank, c].value_counts()
                fill = vc.index[0] if len(vc) else "Unknown"
            out.loc[blank, c] = fill
    elif op == "recode_values":
        pairs = {str(p["from"]).strip(): str(p["to"]) for p in i["pairs"]}
        lower = {k.lower(): v for k, v in pairs.items()}
        for c in cols:
            s = out[c].str.strip()
            out[c] = s.map(lambda v: pairs.get(v, lower.get(v.lower(), v)))
    elif op == "trim_whitespace":
        for c in cols or list(out.columns):
            out[c] = out[c].str.strip().str.replace(r"\s+", " ", regex=True)
    elif op == "to_number":
        for c in cols:
            x = to_number(out[c])
            out[c] = x.map(lambda v: "" if pd.isna(v) else f"{v:g}")
    elif op == "drop_columns":
        out = out.drop(columns=[c for c in cols if c in out])
    elif op == "drop_duplicates":
        keys = [c for c in (cols or [id_col, m.get("term")]) if c in out]
        if keys:
            out = out.drop_duplicates(subset=keys, keep="last")
    elif op == "drop_rows":
        values = {str(v) for v in i.get("values") or [""]}
        hit = out[cols[0]].isin(values)
        if hit.mean() <= 0.5:  # never let one fix remove most of the data
            out = out[~hit]
    elif op == "clip_range":
        for c in cols:
            x = to_number(out[c])
            y = x.clip(lower=i.get("min"), upper=i.get("max"))
            out[c] = np.where(x.notna(), y.map(lambda v: f"{v:g}" if pd.notna(v) else ""), out[c])
    elif op == "change_case":
        fn = {"upper": str.upper, "lower": str.lower, "title": str.title}[i.get("case") or "title"]
        for c in cols:
            out[c] = out[c].map(fn)
    return out
