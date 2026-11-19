"""Feature profiles for the Features step: meaning, category, range, link to enrolling, and the AI's picks."""

import math
import re

import numpy as np
import pandas as pd

from ..engine.guards import DETAILED, guard
from ..engine.terms import parse
from .fields import NON_FEATURE, outcome, vmap

CATEGORIES = [
    ("Housing", r"housing|dorm|residence.?hall|living.?learning|\bllc\b"),
    ("Financial aid", r"aid|scholar|grant|award|loan|need|tuition|cost|finan|fafsa|pell|efc|\bsai\b"),
    ("Engagement", r"visit|email|open|click|event|tour|contact|orientation|rsvp|inquir|portal|engag|call|text|sms|webinar"),
    ("Academic", r"gpa|test|sat\b|act\b|score|rank|credit|course|major|program|plan|college|school|honors|degree|subject|idx"),
    ("Location & residency", r"resid|state|distance|miles|zip|county|country|region|city|domicile|international|local"),
    ("Demographic", r"race|ethnic|ipeds|gender|sex|age|first.?gen|citizen|veteran|language|birth|urm"),
    ("Application", r"app|decision|admit|round|source|days|date|wl|waitlist|early|submit|deadline"),
]
STRONG = [(0.2, "High"), (0.1, "Medium"), (0.05, "Low"), (0.0, "Very low")]


def _fmt(v: float) -> str:
    """Readable range ends: 12,500 not 1.25e+04; 3.4 not 3.4000001."""
    if abs(v) >= 1000:
        return f"{v:,.0f}"
    return f"{v:.0f}" if float(v).is_integer() else f"{v:.2f}".rstrip("0").rstrip(".")


def category(name: str) -> str:
    return next((c for c, rx in CATEGORIES if re.search(rx, name, re.I)), "Other")


def _num(s: pd.Series) -> pd.Series | None:
    x = pd.to_numeric(s.str.replace(r"[$,%\s]", "", regex=True).replace("", np.nan), errors="coerce")
    present = int((s != "").sum())
    return x if present and x.notna().sum() >= 0.95 * present and s[s != ""].nunique() > 2 else None


def profile_features(df: pd.DataFrame, mapping: dict, admitted_only: pd.Series | None = None, hide_term: str | None = None) -> list[dict]:
    """hide_term: the term being forecast. Only outcomes from earlier terms are used, so suggestions never learn from the
    term they predict, or from anything after it."""
    skip = {mapping.get(k) for k in NON_FEATURE}
    d = df if admitted_only is None else df[admitted_only]
    d = d.sample(6000, random_state=42) if len(d) > 6000 else d
    y = vmap(d[mapping["outcome"]], outcome).astype(float) if mapping.get("outcome") in d else pd.Series(np.nan, index=d.index)
    target = parse(hide_term) if hide_term else None
    if target is not None and mapping.get("term") in d:
        later = vmap(d[mapping["term"]], lambda v: (t := parse(v)) is None or t.order >= target.order).astype(bool)
        y = y.mask(later)
    known = y.notna()
    out = []
    for col in df.columns:
        if col in skip:
            continue
        s = d[col]
        p = {"name": col, "category": category(col), "missing_pct": round(float((s == "").mean() * 100), 1),
             "distinct": int(s[s != ""].nunique()), "relevance": 0.0, "insight": "", "excluded": guard(col)}
        x = _num(s)
        if x is not None:
            v = x.dropna()
            p.update(kind="number", min=float(v.min()) if len(v) else None, max=float(v.max()) if len(v) else None,
                     median=float(v.median()) if len(v) else None)
            if known.sum() > 50 and v.std() > 0:
                try:  # enrollment rate across five equal-size groups: the feature card's mini chart
                    xk = x[known]
                    b = pd.qcut(xk, 5, duplicates="drop")
                    g = pd.DataFrame({"b": b, "x": xk, "y": y[known]}).groupby("b", observed=True).agg(n=("y", "size"), rate=("y", "mean"), lo=("x", "min"), hi=("x", "max"))
                    p["bins"] = [{"label": _fmt(r.lo) if r.lo == r.hi else f"{_fmt(r.lo)}–{_fmt(r.hi)}", "n": int(r.n), "rate": round(float(r.rate), 3)}
                                 for _, r in g.iterrows()]
                except ValueError:
                    pass
            if known.sum() > 20 and v.std() > 0:
                xv = x[known].fillna(x.median())
                r = float(np.corrcoef(xv, y[known])[0, 1]) if xv.std() > 0 else 0.0
                p["relevance"], p["direction"] = abs(r), "up" if r >= 0 else "down"
                p["insight"] = f"Admits with {'higher' if r >= 0 else 'lower'} values enrolled more often." if abs(r) >= 0.03 else "Little link to enrolling in your data."
        else:
            counts = pd.DataFrame({"v": s.replace("", "(blank)"), "y": y}).groupby("v")["y"].agg(["size", "count", "mean"]).sort_values("size", ascending=False)
            p.update(kind="category", top=[{"value": k, "count": int(r["size"]), "rate": round(float(r["mean"]), 3) if r["count"] >= 10 else None} for k, r in counts.head(6).iterrows()])
            if known.sum() > 20:
                base, total = y[known].mean(), y[known].var() * known.sum()
                between = float(((counts["mean"].fillna(base) - base) ** 2 * counts["count"]).sum())
                p["relevance"] = math.sqrt(between / total) if total else 0.0
                rated = counts[(counts["count"] >= 20)]
                if len(rated) >= 2 and p["relevance"] >= 0.03:
                    lo, hi = rated["mean"].idxmin(), rated["mean"].idxmax()
                    p["insight"] = f"Yield ranges from {rated['mean'].min():.0%} ({lo}) to {rated['mean'].max():.0%} ({hi})."
                else:
                    p["insight"] = "Little link to enrolling in your data."
        if not p["excluded"]:
            if p["missing_pct"] > 60:
                p["excluded"] = "Mostly blank"
            elif p["distinct"] <= 1:
                p["excluded"] = "Same value for every student"
            elif p.get("kind") == "category" and p["distinct"] > max(50, len(d) * 0.5):
                p["excluded"] = "Different for almost every student (like an ID)"
            elif p.get("kind") != "number" and p["distinct"] > DETAILED:
                p["excluded"] = f"Too detailed (over {DETAILED} different values): it would slow the forecast without making it more accurate"
            elif p["relevance"] > 0.85:
                p["excluded"] = "Gives away the answer"
        p["relevance"] = round(p["relevance"], 4)
        p["strength"] = next(label for t, label in STRONG if p["relevance"] >= t)
        out.append(p)
    return out


REC_VERSION = 2  # bump when the rule changes: untouched older recommendations are replaced
def recommend(profiles: list[dict]) -> list[str]:
    """Every usable column, as the lab's model uses, strongest first. Columns that are protected, blank, too detailed,
    identifying or give away the answer are never used."""
    ok = sorted((p for p in profiles if not p["excluded"]), key=lambda p: -p["relevance"])
    return [p["name"] for p in ok][:40]
