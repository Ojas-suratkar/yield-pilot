"""Cutting data down to the rows a plan allows, always on the server.

The person chooses which rows: whole terms, a range of rows, some values of a column (a college, an admit type), or simply
the newest terms, the first rows or a random sample. Whatever they choose, the number kept is the plan's at most: when the
choice is still bigger, the server keeps the plan's number of them (newest first, first, or at random). Nothing the browser
sends can raise the limit, every save checks it again (plans.check_data), and a Run refuses data larger than the plan allows."""

import re
from typing import Literal

import pandas as pd
from fastapi import HTTPException
from pydantic import BaseModel, Field

from ..engine.terms import parse

QUICK = ("recent", "first", "sample")
MODES = (*QUICK, "terms", "rows", "values")
_TERMISH = re.compile(r"term|strm|cohort|admit.?year|entry|academic.?period|semester|year", re.I)
_PERSONAL = re.compile(r"name|e-?mail|phone|address|street|ssn|social|birth|dob|zip|postal|(^|_)id$|emplid|student.?id", re.I)
MAX_COLUMNS, MAX_VALUES = 12, 40


class Keep(BaseModel):
    """Which rows to keep. The plan decides how many."""
    mode: Literal["recent", "first", "sample", "terms", "rows", "values"]
    terms: list[str] | None = Field(None, max_length=400)  # "terms": values of the term column
    start: int | None = Field(None, ge=1)  # "rows": from this row (1 is the first) ...
    end: int | None = Field(None, ge=1)  # ... to this row, inclusive
    column: str | None = Field(None, max_length=300)  # "values": this column ...
    values: list[str] | None = Field(None, max_length=400)  # ... has one of these
    then: Literal["recent", "first", "sample"] = "recent"  # the chosen rows are still more than the plan allows: which of them


def keep_of(x: "Keep | str | None") -> Keep | None:
    """Older screens sent just "recent", "first" or "sample"."""
    return Keep(mode=x) if isinstance(x, str) else x


def _one(v) -> str:
    """A value as the text the screen shows (2254.0 read from Excel is 2254; blanks are "")."""
    if v is None or (not isinstance(v, str) and pd.isna(v)):
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _text(s: pd.Series) -> pd.Series:
    return s.map(_one)


def _counts(s: pd.Series) -> dict[str, int]:
    """Rows per value, counted on the raw values first (fast), then merged by the text shown."""
    out: dict[str, int] = {}
    for v, n in s.value_counts(dropna=False).items():
        k = _one(v)
        out[k] = out.get(k, 0) + int(n)
    return out


def term_column(df: pd.DataFrame, preferred: str | None = None) -> str | None:
    """The column that says which term each row belongs to, if one can be found."""
    if preferred and preferred in df.columns:
        return preferred
    for c in df.columns:
        if _TERMISH.search(str(c)):
            vals = _text(df[c].dropna().head(500))
            if len(vals) and sum(parse(v) is not None for v in vals) / len(vals) > 0.8:
                return str(c)
    return None


def _order(df: pd.DataFrame, col: str) -> pd.Series:
    return _text(df[col]).map(lambda v: t.order if (t := parse(v)) else -1)


def _quick(df: pd.DataFrame, limit: int, how: str, term: str | None) -> tuple[pd.DataFrame, str]:
    if len(df) <= limit:
        return df.reset_index(drop=True), ""
    if how == "recent":
        col = term_column(df, term)
        if col:
            keep = _order(df, col).sort_values(ascending=False, kind="stable").index[:limit]
            return df.loc[sorted(keep)].reset_index(drop=True), f"the {limit:,} most recent rows by {col}"
        return df.tail(limit).reset_index(drop=True), f"the last {limit:,} rows"
    if how == "first":
        return df.head(limit).reset_index(drop=True), f"the first {limit:,} rows"
    return df.sample(n=limit, random_state=7).sort_index().reset_index(drop=True), f"a random {limit:,} rows"


def cut(df: pd.DataFrame, limit: int, keep: "Keep | str | None", preferred_term: str | None = None) -> tuple[pd.DataFrame, str]:
    """At most `limit` rows of the ones chosen, and a short phrase saying which were kept."""
    k = keep_of(keep)
    if k is None:
        raise HTTPException(422, "Choose which rows to keep.")
    if k.mode in QUICK:
        out, said = _quick(df, limit, k.mode, preferred_term)
        return out, said or "every row"
    if k.mode == "rows":
        if k.start is None or k.end is None or k.end < k.start:
            raise HTTPException(422, "Choose the first and last row to keep.")
        if k.start > len(df):
            raise HTTPException(422, f"The data has {len(df):,} rows.")
        end = min(k.end, len(df), k.start + limit - 1)  # never more than the plan allows
        return df.iloc[k.start - 1:end].reset_index(drop=True), f"rows {k.start:,} to {end:,}"
    if k.mode == "terms":
        col = term_column(df, preferred_term)
        if not col:
            raise HTTPException(422, "This data has no term column to choose terms from.")
        if not k.terms:
            raise HTTPException(422, "Choose at least one term.")
        chosen = df[_text(df[col]).isin(set(k.terms))]
        what = f"terms {', '.join(sorted(set(k.terms))[:6])}{'…' if len(set(k.terms)) > 6 else ''}"
    else:
        if not k.column or k.column not in df.columns:
            raise HTTPException(422, "Choose a column that's in the data.")
        if not k.values:
            raise HTTPException(422, f"Choose at least one value of {k.column}.")
        chosen = df[_text(df[k.column]).isin(set(k.values))]
        what = f"{k.column} = {', '.join(v or '(blank)' for v in sorted(set(k.values))[:4])}{'…' if len(set(k.values)) > 4 else ''}"
    if chosen.empty:
        raise HTTPException(422, "No rows match that choice.")
    out, said = _quick(chosen, limit, k.then, preferred_term)
    return out, f"{what}: {said} of {len(chosen):,}" if said else f"{what} ({len(out):,} rows)"


def summary(df: pd.DataFrame, preferred_term: str | None = None) -> dict:
    """What the screen needs to offer choices with exact counts: rows per term, and the values of short-list columns."""
    col = term_column(df, preferred_term)
    terms = []
    if col:
        terms = sorted(({"value": v, "rows": n, "order": (t.order if (t := parse(v)) else -1)} for v, n in _counts(df[col]).items()),
                       key=lambda x: (x["order"], x["value"]))
    columns = []
    for c in df.columns:
        if len(columns) >= MAX_COLUMNS:
            break
        if str(c) == col or _PERSONAL.search(str(c)) or not 2 <= df[c].nunique(dropna=False) <= 2 * MAX_VALUES:
            continue
        counts = _counts(df[c])
        if 2 <= len(counts) <= MAX_VALUES and max(len(v) for v in counts) <= 60:
            columns.append({"name": str(c), "values": [{"value": v, "rows": n} for v, n in sorted(counts.items(), key=lambda x: -x[1])]})
    return {"rows": len(df), "term_column": col, "terms": [{k: x[k] for k in ("value", "rows")} for x in terms], "columns": columns}


def over(df: pd.DataFrame, limit: int, upload_id: str | None = None, term: str | None = None) -> HTTPException:
    """Too many rows for the plan: the screen offers to choose which rows to keep (it can't keep more than the plan allows)."""
    return HTTPException(402, {
        "code": "rows_over_plan", "limit": limit, "upload_id": upload_id, **summary(df, term),
        "message": f"This data has {len(df):,} rows and your plan allows {limit:,} per dataset. Choose which rows to keep, or an owner "
                   "can upgrade in Billing.",
    })
