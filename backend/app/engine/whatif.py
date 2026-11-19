"""Scenarios, recommended actions and per-student explanations, all from a forecast's saved model."""

import re

import numpy as np
import pandas as pd
import xgboost as xgb

from .recipe import build_X, predict, to_number

ACTIONABLE = re.compile(r"aid|scholar|grant|award|visit|tour|email|contact|event|outreach|call|text|sms|days_to_admit|admit_speed|speed|webinar|interview", re.I)
LEVERS = [
    (r"aid|scholar|grant|award", "Scholarship Support", "Increase the average award for high-intent admits.", "Increase scholarship support for high-intent admits"),
    (r"email|open|click|event|contact|call|text|sms|outreach|webinar", "Outreach Intensity", "More email, SMS and event touchpoints.", "Expand counselor and digital outreach"),
    (r"days|speed", "Admit Speed", "Shorten time from application to admission.", "Release admission decisions faster"),
    (r"visit|tour|interview", "Campus Visits", "Invite more admits to visit campus.", "Invite more admits to campus visits"),
]
YES = re.compile(r"^(y|yes|true|1)$", re.I)
ACRONYMS = {"gpa", "sat", "act", "hs", "id", "idx", "wl", "stem", "zip", "efc", "ap", "ib", "eop", "csu", "uc"}


def _meta(f):
    return next(((label, hint, action) for rx, label, hint, action in LEVERS if re.search(rx, f, re.I)), (f, f"Change {f}.", f"Improve {f}"))


# the same names the Features page shows (frontend lib/labels.ts), so a column is called one thing everywhere
KNOWN = [
    (r"^(hs_?)?gpa$|high.?school.?gpa|hs_gpa", "High school GPA"), (r"transfer.?gpa", "Transfer GPA"), (r"test.?score|sat|act", "ACT/SAT score"),
    (r"class.?rank", "Class rank percentile"), (r"aid.?offer|aid_amt|aid$|financial.?aid", "Financial aid offer"), (r"scholar", "Scholarship amount"),
    (r"fafsa", "FAFSA received"), (r"efc|\bsai\b", "Expected family contribution"), (r"campus.?visit|visit", "Visit attendance"), (r"housing", "Housing interest"),
    (r"email", "Email engagement"), (r"event", "Events attended"), (r"orientation|rsvp", "Orientation sign-up"), (r"first.?gen", "First-generation student"),
    (r"distance|miles", "Distance from campus"), (r"resid", "Residency (in-state / out-of-state)"), (r"^major$|intended.?major|major", "Major interest"),
    (r"college", "College"), (r"days.?to.?admit|admit.?speed", "Days to admission"), (r"app.?round|round", "Application round"), (r"app.?date", "Application date"),
    (r"decision.?plan", "Admissions decision plan"), (r"source", "Application source"), (r"race|ipeds|ethnic", "Race / ethnicity"), (r"gender|sex", "Gender"),
    (r"wl|waitlist", "Admitted from waitlist"), (r"credit", "Credits transferred"),
]


def plain(f: str) -> str:
    """PERS_DISTANCE -> Distance from campus, DAYS_TO_APP -> Days to app: column names in words."""
    known = next((name for rx, name in KNOWN if re.search(rx, str(f), re.I)), None)
    if known:
        return known
    words = [w for w in re.split(r"[_\s]+", str(f)) if w]
    return " ".join(w.upper() if w.lower() in ACRONYMS else (w.capitalize() if i == 0 else w.lower()) for i, w in enumerate(words)) or str(f)


def _predict_many(art: dict, frames: list[pd.DataFrame]) -> list[np.ndarray]:
    """Score several what-if versions of the admits in one batch (one pass through the model, not one per scenario)."""
    sizes = [len(f) for f in frames]
    p = predict(art, pd.concat(frames, ignore_index=True))
    return np.split(p, np.cumsum(sizes)[:-1])


def _importance(art: dict) -> dict[str, float]:
    from .recipe import _drivers

    try:
        return {d["feature"]: d["share"] for d in _drivers(art, np.zeros(len(art["raw"])))}
    except Exception:
        return {}


def levers(art: dict) -> list[dict]:
    """Every column the model uses becomes a what-if lever, so every forecast has scenarios. Levers the office can act on
    (aid, outreach, visits, decision speed) come first; then 'who is admitted' levers (what if more admits looked like
    this?). Each is applied to this term's admits and scored by the forecast's own model."""
    raw, out, seen = art["raw"], [], set()
    base = None
    imp = _importance(art)
    for f in art["num"] + art["cat"]:
        actionable = bool(ACTIONABLE.search(f))
        name = plain(f)
        label, hint, action = _meta(f) if actionable else (f"Higher {name.lower()}" if f in art["num"] else name, "", "")
        if label in seen:
            continue
        if f in art["num"]:
            x = to_number(raw[f]).dropna()
            if len(x) < 10 or x.nunique() < 2:
                continue
            if set(x.unique()) <= {0, 1}:
                lever = {"kind": "share", "yes": "1"}
                label = label if actionable else f"More admits with {name.lower()}"
            elif (x == x.round()).all() and x.max() <= 20:
                lever = {"kind": "count"}  # e.g. visits, events: +1 for the chosen share of admits
            else:
                lever = {"kind": "pct", "min": -50 if re.search(r"days|speed", f, re.I) else -30, "max": 50, "step": 5}
            if not actionable:
                hint, action = f"What if this term's admits had higher or lower {name.lower()}?", f"Shift the admit pool toward higher {name.lower()}"
        else:
            vc = raw[f][raw[f] != ""].value_counts()
            if len(vc) < 2:
                continue
            yes = next((v for v in vc.index if YES.match(str(v))), None)
            if yes is not None and len(vc) <= 3:
                lever = {"kind": "share", "yes": yes}
                if not actionable:
                    label, hint, action = f"More admits with {name.lower()}", f"What if more admits had {name.lower()} = {yes}?", f"Admit more students with {name.lower()}"
            else:
                # who is admitted: the group (at least 5% of admits) the model expects to enroll most
                if base is None:
                    base = _cached(art, "base", lambda: predict(art, raw))
                g = pd.DataFrame({"v": raw[f].to_numpy(), "p": base}).groupby("v")["p"].agg(["mean", "size"])
                g = g[(g["size"] >= max(10, 0.05 * len(raw))) & (g.index != "")]
                if g.empty:
                    continue
                top = str(g["mean"].idxmax())
                lever = {"kind": "share", "yes": top}
                label = f"More {top} admits" if len(top) > 3 and not top.isdigit() else f"More admits with {name.lower()} {top}"
                hint = f"What if more of this term's admits were {top} ({name.lower()})? Today {g.loc[top, 'size'] / len(raw):.0%} are."
                action = f"Recruit and admit more {top} students ({name.lower()})"
        lever.setdefault("min", 0)
        lever.setdefault("max", 50)
        lever.setdefault("step", 5)
        out.append({"feature": f, "label": label, "hint": hint, "action": action, "actionable": actionable,
                    "importance": round(imp.get(f, 0.0), 4), **lever})
        seen.add(label)
    out.sort(key=lambda lv: (not lv["actionable"], -lv["importance"]))
    return out[:10]


def _apply(raw: pd.DataFrame, lv: dict, pct: float) -> tuple[pd.DataFrame, np.ndarray | None]:
    """The admits with one lever applied. Percent levers change values; share and count levers return the 'everyone
    switched' version plus which admits can switch, and the caller blends in the chosen share of them."""
    f = lv["feature"]
    out = raw.copy()
    if lv["kind"] == "pct":
        x = to_number(raw[f])
        out[f] = (x.fillna(x.median()) * (1 + pct)).round(4).astype(str)
        return out, None
    if lv["kind"] == "count":
        out[f] = (to_number(raw[f]).fillna(0) + 1).astype(int).astype(str)
        return out, np.ones(len(raw), dtype=bool)
    out[f] = lv["yes"]
    return out, (raw[f].astype(str) != str(lv["yes"])).to_numpy()


def _cached(art: dict, key: str, fn):
    """Predictions that never change for a saved model (the base, and each 'everyone switched' version), kept with it."""
    store = art.setdefault("_whatif", {})
    if key not in store:
        store[key] = fn()
    return store[key]


def scenario(art: dict, values: dict[str, float], lvs: list[dict] | None = None) -> np.ndarray:
    """Every admit's chance of enrolling with the chosen levers applied, from the forecast's model."""
    raw = art["raw"]
    active = [lv for lv in (lvs or levers(art)) if values.get(lv["feature"])]
    base = _cached(art, "base", lambda: predict(art, raw))
    if not active:
        return base
    pcts = [lv for lv in active if lv["kind"] == "pct"]
    shares = [lv for lv in active if lv["kind"] != "pct"]
    if not pcts:  # only share/count levers: blend cached predictions, no new scoring (instant when sliders move)
        p = base.copy()
        for lv in shares:
            bumped, mask = _cached(art, f"bump:{lv['feature']}", lambda lv=lv: (predict(art, _apply(raw, lv, 0)[0]), _apply(raw, lv, 0)[1]))
            p = np.where(mask, p + values[lv["feature"]] / 100 * (bumped - base), p)
        return np.clip(p, 0.001, 0.999)
    shifted = raw
    for lv in pcts:
        shifted, _ = _apply(shifted, lv, values[lv["feature"]] / 100)
    preds = _predict_many(art, [shifted] + [_apply(shifted, lv, 0)[0] for lv in shares])  # one batch
    p = preds[0]
    for lv, bumped in zip(shares, preds[1:]):
        p = np.where(_apply(shifted, lv, 0)[1], p + values[lv["feature"]] / 100 * (bumped - preds[0]), p)
    return np.clip(p, 0.001, 0.999)


SAMPLE = 8000  # admits used to rank the levers (a fixed sample, scaled to the whole class): seconds instead of minutes


def actions(art: dict) -> dict:
    """Each lever moved 20% on its own, ranked by how many more admits would enroll, plus every helpful one together.
    Ranked on a fixed sample of admits, scored in one batch, and scaled up to the whole class."""
    full = art["raw"]
    raw = full.sample(SAMPLE, random_state=0) if len(full) > SAMPLE else full
    scale = len(full) / len(raw)
    lvs = levers(art)
    steps = [-20 if re.search(r"days|speed", lv["feature"], re.I) else 20 for lv in lvs]
    applied = [_apply(raw, lv, st / 100) for lv, st in zip(lvs, steps)]
    preds = _predict_many(art, [raw] + [a[0] for a in applied])
    base = preds[0]
    out = []
    for lv, st, (_, mask), p in zip(lvs, steps, applied, preds[1:]):
        changed = p if mask is None else np.where(mask, base + (st / 100) * (p - base), base)
        out.append({**lv, "step": st, "lift": round(float(changed.sum() - base.sum()) * scale, 1)})
    out.sort(key=lambda a: -a["lift"])
    good = [a for a in out if a["lift"] > 0]
    combined = 0.0
    if good:  # the helpful levers together, on the same sample
        sub = {**art, "raw": raw, "_whatif": {}}
        combined = float(scenario(sub, {a["feature"]: a["step"] for a in good}, lvs).sum() - base.sum()) * scale
    return {"actions": out, "combined": round(combined, 1), "baseline": round(float(_cached(art, "base", lambda: predict(art, full)).sum()), 1)}


def factors(art: dict, idx: int) -> list[dict]:
    """Which features pushed this admit's probability up or down (TreeSHAP for XGBoost, coefficients for logistic)."""
    row = art["raw"].iloc[[idx]]
    pipe = art["model"]
    X = pipe.named_steps["pre"].transform(build_X(row, art["cat"], art["num"]))
    names = pipe.named_steps["pre"].get_feature_names_out()
    contrib = np.zeros(len(names))
    ccs = pipe.named_steps["model"].calibrated_classifiers_
    for cc in ccs:
        est = cc.estimator
        if hasattr(est, "get_booster"):
            contrib += est.get_booster().predict(xgb.DMatrix(X), pred_contribs=True)[0][:-1]
        else:
            contrib += np.asarray(X)[0] * est.coef_[0]
    contrib /= len(ccs)
    feats = sorted(art["cat"] + art["num"], key=len, reverse=True)
    by: dict[str, float] = {}
    for name, v in zip(names, contrib):
        raw_name = name.split("__", 1)[1]
        col = next((f for f in feats if raw_name == f or raw_name.startswith(f + "_")), None)
        if col:
            by[col] = by.get(col, 0.0) + float(v)
    top = sorted(by.items(), key=lambda kv: -abs(kv[1]))[:6]
    return [{"feature": k, "effect": round(v, 4), "value": str(row.iloc[0][k])} for k, v in top]
