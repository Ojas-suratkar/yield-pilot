"""Term statistics for the setup screens: which terms exist, how many admits, which have outcomes."""

import pandas as pd

from ..engine.terms import parse
from .fields import admitted, in_group, outcome, vmap


def term_info(df: pd.DataFrame, mapping: dict, custom: list[str]) -> dict:
    tcol, ocol = mapping.get("term"), mapping.get("outcome")
    if not tcol or tcol not in df:
        return {"terms": [], "past": []}
    d = df
    if mapping.get("admitStatus") in df:
        adm = d[vmap(d[mapping["admitStatus"]], admitted).astype(bool)]
        d = adm if len(adm) else d  # a column with no admit decisions in it shouldn't empty the whole analysis
    stype = mapping.get("studentType") if mapping.get("studentType") in df else None
    info: dict[str, dict] = {}
    for term, part in d.groupby(tcol):
        if not str(term).strip() or parse(term) is None:
            continue
        y = vmap(part[ocol], outcome).astype(float) if ocol in part else pd.Series(dtype=float)
        masks = {g: vmap(part[stype], lambda v, g=g: in_group(v, g)).astype(bool) if stype else pd.Series(True, index=part.index) for g in ("FTF", "TRN")}
        info[term] = {
            "code": term,
            "admits": int(len(part)),
            "known": int(y.notna().sum()),
            "groups": {g: int(m.sum()) for g, m in masks.items()},
            # admits with a known outcome and how many enrolled, per population: the prior-yield cards
            "outcomes": {g: {"known": int(y[m].notna().sum()), "enrolled": int((y[m] == 1).sum())} for g, m in masks.items()} if len(y) else {},
        }
    for t in custom:
        if t not in info and parse(t):
            info[t] = {"code": t, "admits": 0, "known": 0, "groups": {"FTF": 0, "TRN": 0}, "outcomes": {}}
    ordered = sorted(info.values(), key=lambda e: parse(e["code"]).order)
    for e in ordered:
        p = parse(e["code"])
        e.update(year=p.year, season=p.season, has_outcomes=e["known"] >= max(10, e["admits"] * 0.5))
    return {"terms": ordered, "past": [e["code"] for e in ordered if e["has_outcomes"]]}


def recommended_train_terms(target: str, past: list[str], n: int = 2) -> list[str]:
    """The n most recent earlier terms of the same season (Fall learns from Falls); other seasons only if there are none."""
    t = parse(target)
    if t is None:
        return []
    earlier = sorted((p for p in (parse(x) for x in past) if p and p.order < t.order), key=lambda p: p.order)
    like = [p for p in earlier if p.season == t.season]
    return [p.code for p in (like or earlier)[-n:]]


def default_target(info: dict) -> str | None:
    """The newest term that has admits but no outcomes yet; otherwise the newest term."""
    terms = info["terms"]
    upcoming = [e for e in terms if e["admits"] and not e["has_outcomes"]]
    return (upcoming or terms or [{}])[-1].get("code")


def prior_like(target: str, past: list[str]) -> str | None:
    """The most recent past term in the same season as the target: last year's comparison."""
    t = parse(target)
    if t is None:
        return None
    like = [p for p in (parse(x) for x in past) if p and p.order < t.order and p.season == t.season]
    return max(like, key=lambda p: p.order).code if like else None


PS_DIGIT = {"spring": "2", "fall": "4", "summer": "6"}


def make_term(season: str, year: int, existing: list[str]) -> str:
    """A new term in the same style as the data: a PeopleSoft code (2274) when the data uses codes, else "Fall 2027"."""
    codes = [t for t in existing if parse(t) and str(t).isdigit() and len(str(t)) == 4]
    if existing and len(codes) * 2 >= len(existing) and season.lower() in PS_DIGIT and 2000 <= year <= 2099:
        return f"2{year % 100:02d}{PS_DIGIT[season.lower()]}"
    return f"{season.title()} {year}"
