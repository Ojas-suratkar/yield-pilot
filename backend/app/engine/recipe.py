"""The YieldPilot engine: one recipe for every institution, a fresh model per institution and forecast.

The recipe is the admission_yield_lab v3 model exactly: XGBoost with v3's hyperparameters (1,200 trees, depth 8),
isotonic calibration over 5 folds, recency weights exp(-0.15 x years back), the two most recent comparable terms,
the lab's encoding (every category, blanks -> most common value), production cycle shrinkage (engine/shrinkage.py)
and the max-F1 decision cut-off on the latest training term. Only the feature selection is YieldPilot's own.

Two details decide whether the numbers match the lab, not just the method:
- Training rows are ordered by the real student ID, as the lab's `ORDER BY EMPLID` does. Calibration folds are cut
  in row order, and ID order roughly follows when students entered the system, so it changes the forecast level
  (Fall 2026 at CSULB: 5,277 in ID order vs 5,820 in random order; actual 5,398).
- The library versions are the lab's (requirements.txt): other XGBoost / scikit-learn versions give other numbers.
"""

import math
import secrets
import hashlib
import json
import math
import os
import threading
import time
from dataclasses import asdict, dataclass, field, replace

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score, roc_curve
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from joblib import parallel_backend
from xgboost import XGBClassifier
from xgboost.callback import TrainingCallback

from ..services.fields import admitted, in_group, outcome, vmap
from . import shrinkage
from .guards import DETAILED, guard
from .terms import parse

RECIPE_VERSION = "2.1.0-lab"
DECAY, FOLDS = 0.15, 5
# the 5 folds train side by side; each gets a whole share of the CPUs (thread count never changes the trees).
# On Cloud Run's 8 vCPUs (4 cores) that is 1 thread per fold: more threads only fight over the cores (measured).
CPUS = max(1, int(os.environ.get("ENGINE_THREADS") or os.cpu_count() or 1))
FOLD_THREADS = max(1, CPUS // FOLDS)
XGB = dict(  # v3's exact hyperparameters (models.ira.xgb_fys_admission_yield_shrunk/3)
    n_estimators=1200, learning_rate=0.1843927295709211, max_depth=8, gamma=1.1001208695184674, min_child_weight=3,
    max_delta_step=7, subsample=0.6649945472892727, colsample_bytree=0.7452548849100877, colsample_bylevel=0.5746243467447928,
    colsample_bynode=0.9472542739010197, reg_lambda=4.0618466705496195, reg_alpha=1.8640118170964297,
    scale_pos_weight=0.6992351712417466, tree_method="hist", eval_metric="logloss",
)
# What the ML workspace may change: (kind, lowest, highest). The rest of the recipe stays fixed.
TUNABLE = {
    "n_estimators": ("int", 50, 3000), "learning_rate": ("float", 0.001, 1), "max_depth": ("int", 1, 16), "min_child_weight": ("float", 0, 100),
    "gamma": ("float", 0, 50), "max_delta_step": ("float", 0, 50), "subsample": ("float", 0.1, 1), "colsample_bytree": ("float", 0.1, 1),
    "colsample_bylevel": ("float", 0.1, 1), "colsample_bynode": ("float", 0.1, 1), "reg_lambda": ("float", 0, 1000), "reg_alpha": ("float", 0, 1000),
    "scale_pos_weight": ("float", 0.01, 100), "max_leaves": ("int", 0, 4096), "grow_policy": ("choice", 0, 0), "recency_decay": ("float", 0, 3), "folds": ("int", 2, 10), "random_state": ("int", 0, 2**31 - 1),
}
CHOICES = {"grow_policy": ["depthwise", "lossguide"]}
ENGINE_ONLY = ("recency_decay", "folds", "random_state")  # used by the recipe itself, not passed to XGBoost
# XGBoost's own defaults for max_leaves (0: no limit) and grow_policy, so passing them changes nothing until they're edited
DEFAULTS = {**{k: XGB[k] for k in TUNABLE if k in XGB}, "max_leaves": 0, "grow_policy": "depthwise", "recency_decay": DECAY, "folds": FOLDS,
            "random_state": None}  # None: a new seed each run


def clean_params(raw: dict | None, base: dict | None = None) -> dict:
    """Only real changes: known settings, within range, different from the base (the lab's defaults, or a workspace's own).
    Raises ValueError with a readable reason."""
    base = base or DEFAULTS
    out = {}
    for k, v in (raw or {}).items():
        if k not in TUNABLE:
            raise ValueError(f"Unknown setting: {k}.")
        if v is None or v == "":
            continue
        kind, lo, hi = TUNABLE[k]
        if kind == "choice":
            if v not in CHOICES[k]:
                raise ValueError(f"{k} must be one of: {', '.join(CHOICES[k])}.")
            if v != base.get(k, DEFAULTS[k]):
                out[k] = v
            continue
        try:
            x = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{k} must be a number.")
        if not math.isfinite(x) or x < lo or x > hi:
            raise ValueError(f"{k} must be between {lo:g} and {hi:g}.")
        if kind == "int":
            if x != int(x):
                raise ValueError(f"{k} must be a whole number.")
            x = int(x)
        if x != base.get(k, DEFAULTS[k]):
            out[k] = x
    return out


def base_of(workspace: dict | None) -> dict:
    """Every setting's default: the lab's, with the workspace's own defaults on top."""
    return {**DEFAULTS, **(workspace or {})}


# what "best" means when settings are compared: (label, higher is better)
OBJECTIVES = {
    "roc_auc": ("Rank who enrolls best (ROC AUC)", True),
    "pr_auc": ("Find enrollers among many admits (PR AUC)", True),
    "f1": ("Balance precision and recall (F1 score)", True),
    "brier": ("Most trustworthy probabilities (Brier score)", False),
    "error_pct": ("Closest enrolled count (count error)", False),
}
# what Expert search can explore, and on which scale it spreads trials ("log": evenly in ratio, for settings that act multiplicatively)
SEARCHABLE = {
    "n_estimators": ("lin", 300, 2500), "learning_rate": ("log", 0.02, 0.3), "max_depth": ("lin", 3, 10), "min_child_weight": ("log", 1, 10),
    "gamma": ("lin", 0, 5), "max_delta_step": ("lin", 0, 5), "subsample": ("lin", 0.6, 1), "colsample_bytree": ("lin", 0.5, 1),
    "reg_lambda": ("log", 0.5, 20), "reg_alpha": ("lin", 0, 5), "scale_pos_weight": ("log", 0.5, 2),
}


def search(space: dict[str, list[float]], n: int, seed: int, fixed: dict) -> list[dict]:
    """`n` settings spread evenly across the chosen ranges (a Latin hypercube: each setting's range is cut into n slices and every
    slice is tried once), on top of `fixed` (every other setting). Absolute values, within the allowed ranges."""
    rng = np.random.default_rng(seed)
    cols = {}
    for k, (lo, hi) in space.items():
        kind, mn, mx = TUNABLE[k]
        lo, hi = max(mn, min(lo, hi)), min(mx, max(lo, hi))
        u = (rng.permutation(n) + rng.uniform(size=n)) / n
        log = SEARCHABLE.get(k, ("lin",))[0] == "log" and lo > 0
        x = np.exp(np.log(lo) + u * (np.log(hi) - np.log(lo))) if log else lo + u * (hi - lo)
        cols[k] = [int(round(v)) if kind == "int" else round(float(v), 4) for v in x]
    return [{**fixed, **{k: cols[k][i] for k in cols}} for i in range(n)]


# random search around a starting point: (how, low, high) for the settings that matter most
_SEARCH = {"learning_rate": ("log", 0.5, 2.0), "max_depth": ("int", -2, 2), "subsample": ("add", -0.15, 0.15), "colsample_bytree": ("add", -0.15, 0.15),
           "min_child_weight": ("log", 0.5, 2.0), "reg_lambda": ("log", 0.33, 3.0), "gamma": ("log", 0.33, 3.0)}


def holdout(df: pd.DataFrame, spec: "Spec") -> "Spec | None":
    """The same prediction one year back: learn from the terms before the latest training term and forecast that term, whose
    outcomes are known. None when the data has no earlier comparable term."""
    if not spec.term or spec.term not in df.columns or not spec.train_terms:
        return None
    terms = {t.code: t for t in (parse(str(v)) for v in df[spec.term].dropna().astype(str).unique()) if t}
    train = sorted([terms[c] for c in spec.train_terms if c in terms], key=lambda t: t.order)
    if not train:
        return None
    target, earlier = train[-1], []
    for t in train:
        prev = next((x for x in terms.values() if x.season == t.season and x.year == t.year - 1), None)
        if prev and prev.order < target.order and prev.code not in [e.code for e in earlier]:
            earlier.append(prev)
    if not earlier:
        return None
    return replace(spec, target_term=target.code, train_terms=[t.code for t in sorted(earlier, key=lambda t: t.order)])


def tune_result(summary: dict, students: pd.DataFrame, seconds: float) -> dict:
    """How one candidate did on the held-out term: the lab's scores, enrolled predicted vs actual, and its ROC curve."""
    ev = summary.get("evaluation") or {}
    roc = []
    if {"probability", "actual"} <= set(students.columns):
        k = students["actual"].notna()
        y, p = students.loc[k, "actual"].astype(int).to_numpy(), students.loc[k, "probability"].astype(float).to_numpy()
        if len(np.unique(y)) == 2:
            fpr, tpr, _ = roc_curve(y, p)
            idx = np.unique(np.linspace(0, len(fpr) - 1, min(len(fpr), 41)).astype(int))
            roc = [{"fpr": round(float(fpr[i]), 4), "tpr": round(float(tpr[i]), 4)} for i in idx]
    keys = ("roc_auc", "pr_auc", "brier", "log_loss", "accuracy", "precision", "recall", "f1", "error_pct")
    return {"metrics": {k: ev.get(k) for k in keys}, "predicted": ev.get("predicted_enrolled"), "actual": ev.get("actual_enrolled"),
            "admits": ev.get("admits"), "family": (summary.get("model_info") or {}).get("family"), "seconds": round(seconds, 1), "roc": roc,
            "values": (summary.get("hyperparameters") or {}).get("values")}


def best(results: list[dict], objective: str = "roc_auc") -> int | None:
    """The candidate to recommend for the goal (ROC AUC unless another was chosen); ties go to the smaller error in enrolled students."""
    _, higher = OBJECTIVES.get(objective, OBJECTIVES["roc_auc"])
    scored = []
    for i, r in enumerate(results):
        m = (r or {}).get("metrics") or {}
        v = m.get(objective)
        if v is None:
            continue
        v = abs(v) if objective == "error_pct" else v
        scored.append((i, round(v if higher else -v, 4), -abs(m.get("error_pct") or 0)))
    return max(scored, key=lambda s: (s[1], s[2]))[0] if scored else None


def neighbours(base: dict, n: int, seed: int) -> list[dict]:
    """`n` random variations around `base` (each changes three of the settings that matter most), within the allowed ranges."""
    rng = np.random.default_rng(seed)
    start, out, seen = resolve(base), [], {json.dumps(clean_params(base), sort_keys=True)}
    for _ in range(n * 6):
        if len(out) >= n:
            break
        v = dict(start)
        for k in rng.choice(list(_SEARCH), size=3, replace=False):
            how, lo, hi = _SEARCH[k]
            kind, mn, mx = TUNABLE[k]
            x = float(v[k])
            x = x * float(np.exp(rng.uniform(np.log(lo), np.log(hi)))) if how == "log" else x + (int(rng.integers(lo, hi + 1)) if how == "int" else float(rng.uniform(lo, hi)))
            x = min(mx, max(mn, x))
            v[k] = int(round(x)) if kind == "int" else round(x, 4)
        params = clean_params({k: v[k] for k in TUNABLE if k != "random_state" and v[k] is not None})
        key = json.dumps(params, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(params)
    return out


def resolve(params: dict | None) -> dict:
    """Every setting a run uses: the defaults with the prediction's changes on top."""
    return {**DEFAULTS, **clean_params(params)}


@dataclass
class Spec:
    term: str
    outcome: str
    target_term: str
    student_id: str | None = None
    admit_status: str | None = None
    student_type: str | None = None
    group: str | None = None
    college: str | None = None
    major: str | None = None
    train_terms: list[str] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    dims: list[str] = field(default_factory=list)  # extra planning breakdowns, e.g. residency, housing
    params: dict = field(default_factory=dict)  # the ML workspace's hyperparameter changes ({}: the recipe's own)

    def hash(self, data_checksum: str) -> str:
        d = asdict(self)
        if not d["params"]:  # unchanged settings hash as they always did
            d.pop("params")
        blob = json.dumps({**d, "data": data_checksum, "recipe": RECIPE_VERSION}, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()


def to_number(s: pd.Series) -> pd.Series:
    """Numbers from text; "$1,200", "45%" and " 3.5 " count. Plain numbers convert directly; only the rest are cleaned."""
    x = pd.to_numeric(s, errors="coerce")
    retry = x.isna() & s.notna() & (s.astype(str) != "")
    if retry.any():
        x = x.astype(float)
        x[retry] = pd.to_numeric(s[retry].astype(str).str.replace(r"[$,%\s]", "", regex=True).replace("", np.nan), errors="coerce")
    return x.astype(float)


def build_X(raw: pd.DataFrame, cat: list[str], num: list[str]) -> pd.DataFrame:
    X = raw[cat].replace("", np.nan).astype(object).copy()
    for c in num:
        X[c] = to_number(raw[c])
    X["_year"] = raw["_year"].astype(float)
    return X


def _numeric_share(s: pd.Series) -> float:
    """Share of filled-in values that read as numbers (checked once per distinct value)."""
    vc = s[s != ""].value_counts()
    if not len(vc):
        return 0.0
    ok = to_number(pd.Series(vc.index, dtype=object)).notna().to_numpy()
    return float(vc.to_numpy()[ok].sum() / vc.sum())


def _relevance(x: pd.Series, y: pd.Series) -> float:
    if x.dtype.kind in "fi":
        xv = x.fillna(x.median())
        return 0.0 if xv.std() == 0 or y.std() == 0 else abs(float(np.corrcoef(xv, y)[0, 1]))
    g = pd.DataFrame({"x": x.replace("", "(blank)"), "y": y}).groupby("x")["y"].agg(["mean", "size"])
    total = y.var() * len(y)
    return 0.0 if not total else math.sqrt(float(((g["mean"] - y.mean()) ** 2 * g["size"]).sum()) / total)


class _Trees(TrainingCallback):
    """Counts boosting rounds across every fit running at once, for a real progress %. Training is unchanged.

    sklearn's clone deep-copies estimator parameters; returning self keeps one shared counter, and pickling
    leaves an inert counter behind so saved models carry no reference to a request."""

    def __init__(self, tick=None):
        self.tick = tick

    def after_iteration(self, model, epoch, evals_log) -> bool:
        if self.tick:
            self.tick()
        return False

    def __deepcopy__(self, memo):
        return self

    def __reduce__(self):
        return (_Trees, ())


def _pipeline(cat, num, n_rows, positives, trees: _Trees | None = None, hp: dict | None = None, seed: int | None = None):
    hp = hp or DEFAULTS
    folds = int(hp["folds"])
    xgb = {**XGB, **{k: v for k, v in hp.items() if k not in ENGINE_ONLY}}
    pre = ColumnTransformer(  # the lab's preprocessing: blanks -> most common value, every category one-hot; numbers median + standardized
        [
            ("cat", Pipeline([("i", SimpleImputer(strategy="most_frequent")), ("e", OneHotEncoder(handle_unknown="ignore", sparse_output=False))]), cat),
            ("num", Pipeline([("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]), num),
        ],
        remainder="drop",
    )
    small = n_rows < 1500 or positives < 100  # too little data for 1,200 trees: a regularized logistic model instead
    # one thread per fit and the 5 calibration folds side by side: identical trees, several times faster than one fit at a time
    base = LogisticRegression(C=0.5, max_iter=3000) if small else XGBClassifier(
        random_state=secrets.randbelow(2**31) if seed is None else seed, n_jobs=max(1, CPUS // folds), callbacks=[trees or _Trees()], **xgb)
    model = CalibratedClassifierCV(base, method="sigmoid" if small else "isotonic", cv=folds, n_jobs=folds)
    return Pipeline([("pre", pre), ("model", model)]), ("logistic" if small else "xgboost")


def predict(art: dict, raw: pd.DataFrame) -> np.ndarray:
    """Calibrated probability with the forecast's cycle shrinkage applied (production rules)."""
    p = art["model"].predict_proba(build_X(raw, art["cat"], art["num"]))[:, 1]
    colleges = raw[art["college"]] if art.get("college") else None
    return shrinkage.apply(p, colleges, art.get("ratios", {}), art.get("cycle_ratio", 1.0))


def _threshold(y: np.ndarray, p: np.ndarray) -> float:
    """The lab's decision cut-off: the probability that maximizes F1."""
    from sklearn.metrics import precision_recall_curve

    if len(np.unique(y)) < 2:
        return 0.5
    pr, rc, th = precision_recall_curve(y, p)
    f1 = [2 * a * b / (a + b) if (a + b) else 0 for a, b in zip(pr[:-1], rc[:-1])]
    return float(th[int(np.argmax(f1))])


def _scores(y: np.ndarray, p: np.ndarray, cut: float) -> dict:
    """The lab's evaluation metrics for one scored cohort with known outcomes."""
    from sklearn.metrics import accuracy_score, average_precision_score, f1_score, log_loss, precision_score, recall_score

    both = len(np.unique(y)) == 2
    yhat = (p >= cut).astype(int)
    return {
        "roc_auc": round(float(roc_auc_score(y, p)), 4) if both else None,
        "pr_auc": round(float(average_precision_score(y, p)), 4) if both else None,
        "brier": round(float(brier_score_loss(y, p)), 4),
        "log_loss": round(float(log_loss(y, np.clip(p, 1e-6, 1 - 1e-6), labels=[0, 1])), 4),
        "accuracy": round(float(accuracy_score(y, yhat)), 4),
        "precision": round(float(precision_score(y, yhat, zero_division=0)), 4),
        "recall": round(float(recall_score(y, yhat, zero_division=0)), 4),
        "f1": round(float(f1_score(y, yhat, zero_division=0)), 4),
        "threshold": round(cut, 4),
    }


def _band(p: np.ndarray) -> np.ndarray:
    return np.where(p >= 0.7, "high", np.where(p >= 0.4, "medium", "low"))


def _quiet(pct: float, label: str, detail: str = "") -> None:
    pass


def run(df: pd.DataFrame, spec: Spec, progress=_quiet, order: pd.Series | None = None) -> tuple[dict, dict, pd.DataFrame]:
    """progress(pct, label, detail): real progress, 0-100 (training counts finished trees).
    order: the real student ID for each row of df (the stored IDs are pseudonymous); training rows follow it."""
    started = time.time()
    hp = resolve(spec.params)
    seed = secrets.randbelow(2**31) if hp["random_state"] is None else int(hp["random_state"])  # one seed for the whole run, recorded
    folds = int(hp["folds"])
    progress(1, "Preparing your data", f"Reading {len(df):,} rows")
    for col in (spec.term, spec.outcome):
        if not col or col not in df.columns:
            raise ValueError("Map the term and enrollment outcome columns first.")
    target = parse(spec.target_term)
    if target is None:
        raise ValueError(f"'{spec.target_term}' isn't a term we can read.")

    d = df.copy()
    if spec.student_type in d and spec.group:
        d = d[vmap(d[spec.student_type], lambda v: in_group(v, spec.group)).astype(bool)]
    # terms are parsed once per distinct value and kept as codes (comparing term objects row by row is slow)
    terms = {t.code: t for t in (parse(v) for v in d[spec.term].unique()) if t is not None}
    d["_code"] = vmap(d[spec.term], lambda v: (parse(v) or None) and parse(v).code)
    d = d[d["_code"].notna()].copy()
    d["_year"] = d["_code"].map({c: t.year for c, t in terms.items()})
    applications = d.copy()
    if spec.admit_status in d:
        d = d[vmap(d[spec.admit_status], admitted).astype(bool)]
    d["_y"] = vmap(d[spec.outcome], outcome).astype(float)

    known = d[d["_y"].notna()].groupby("_code").size()
    closed = sorted((terms[c] for c, n in known.items() if n >= 30 and terms[c].order < target.order), key=lambda t: t.order)
    like_closed = [t for t in closed if t.season == target.season]
    if spec.train_terms:
        train_terms = [t for t in closed if t.code in set(spec.train_terms)]
    else:
        train_terms = (like_closed or closed)[-2:]  # same season first: Fall learns from the last two Falls
    if not train_terms:
        raise ValueError("No earlier terms with known outcomes to learn from.")
    train = d[d["_code"].isin([t.code for t in train_terms]) & d["_y"].notna()].copy()
    if order is not None:  # the lab's row order: by student ID, as text (ORDER BY EMPLID)
        train = train.iloc[np.argsort(order.reindex(train.index).fillna("").astype(str).to_numpy(), kind="stable")]
    score = d[d["_code"] == target.code].copy()
    if score.empty:
        raise ValueError(f"No admits found for {spec.target_term}.")
    # The forecast term's outcomes are set aside before anything is learned or scored: the model sees its admits and
    # their details, never whether they enrolled. They come back only at the end, for the comparison with the forecast.
    actual_y = score["_y"].copy()
    score["_y"] = np.nan
    progress(2, "Preparing your data", f"{len(train):,} past admits to learn from, {len(score):,} to forecast")

    skip = {spec.term, spec.outcome, spec.student_id, spec.admit_status, spec.student_type}
    candidates = spec.features or [c for c in df.columns if c not in skip]
    excluded, rel, cat, num = [], {}, [], []
    for c in candidates:
        if c in skip or c not in d.columns:
            continue
        why = guard(c)
        if why:
            excluded.append({"feature": c, "reason": why})
            continue
        s = train[c]
        if (s == "").mean() > 0.6 or s.nunique() <= 1 or (_numeric_share(s) < 0.95 and s.nunique() > 0.9 * len(s)):
            continue
        is_num = _numeric_share(s) >= 0.95 and s.nunique() > 2
        if not is_num and s.nunique() > DETAILED:  # never used, even if chosen: slower and no more accurate
            excluded.append({"feature": c, "reason": f"Too detailed (over {DETAILED} different values)"})
            continue
        r = _relevance(to_number(s) if is_num else s, train["_y"])
        if r > 0.85:
            excluded.append({"feature": c, "reason": "Gives away the answer"})
            continue
        if not spec.features and r < 0.02:
            continue
        rel[c] = r
        (num if is_num else cat).append(c)
    keep = sorted(rel, key=lambda c: -rel[c])[:40]
    cat, num = [c for c in cat if c in keep], [c for c in num if c in keep]
    if not keep:
        raise ValueError("None of the selected columns help predict enrollment.")
    progress(3, "Preparing your data", f"Using {len(keep)} columns")

    def weight(part):
        return np.exp(-hp["recency_decay"] * (part["_year"].max() - part["_year"])).to_numpy()

    total, done, lock = folds * int(hp["n_estimators"]), [0], threading.Lock()
    terms = " and ".join(f"{t.season.title()} {t.year}" for t in train_terms)
    studying = f"Studying {len(train):,} admits from {terms}"

    def tick():
        with lock:
            done[0] += 1
            n = done[0]
        if n % 60 == 0 or n == total:
            progress(4 + 88 * n / total, "Learning from past terms", studying)

    trees = _Trees(tick)

    def fit(part):
        pipe, fam = _pipeline(cat, num + ["_year"], len(part), int(part["_y"].sum()), trees, hp, seed)
        with parallel_backend("threading", n_jobs=folds):  # joblib's backend is per thread: set it where the fit runs
            pipe.fit(build_X(part, cat, num), part["_y"].astype(int), model__sample_weight=weight(part))
        for cc in pipe.named_steps["model"].calibrated_classifiers_:
            if isinstance(cc.estimator, XGBClassifier):
                cc.estimator.set_params(n_jobs=-1, callbacks=None)  # predictions use every core; the saved model carries no counter
        return pipe, fam

    college = spec.college if spec.college in d.columns else None

    def shrunk(model, fit_rows: pd.DataFrame, rows: pd.DataFrame, year: int) -> tuple[np.ndarray, np.ndarray, dict, float]:
        raw_p = model.predict_proba(build_X(rows, cat, num))[:, 1]
        by, cyc = shrinkage.ratios(fit_rows, college, year, rows[college] if college else pd.Series(dtype=str), raw_p)
        return shrinkage.apply(raw_p, rows[college] if college else None, by, cyc), raw_p, by, cyc

    progress(4, "Learning from past terms", studying)
    model, family = fit(train)
    backtest = None
    progress(93, "Projecting this term", f"Scoring {len(score):,} admits")
    prob, _, ratios, cycle_ratio = shrunk(model, train, score, target.year)  # the same as predict(art, art["raw"]), scored once
    progress(96, "Projecting this term", "Keeping each college in line with its recent yield")
    cols = sorted(set(cat + num + [c for c in (spec.college, spec.major, *spec.dims) if c in d.columns]))
    art = {"model": model, "cat": cat, "num": num, "college": college, "ratios": ratios, "cycle_ratio": cycle_ratio,
           "raw": score[cols + ["_year"]].reset_index(drop=True), "recipe": RECIPE_VERSION}

    summary = _summary(spec, d, applications, score, train, train_terms, like_closed, target, prob, art, backtest, family, keep, excluded)
    prior_rows = d[(d["_code"] == summary["prior"]["term"]) & d["_y"].notna()] if summary["prior"] else None
    summary["shrinkage"] = {"alpha": shrinkage.ALPHA, "min_cohort": shrinkage.MIN_COHORT_SIZE, "cycle_ratio": round(cycle_ratio, 4),
                            "ratios": {k: round(v, 4) for k, v in ratios.items()}}
    known = actual_y.notna().to_numpy()
    summary["actual"] = ({"enrolled": int(actual_y[known].sum()), "yield": round(float(actual_y[known].mean()), 4), "known": int(known.sum())}
                         if known.mean() > 0.5 else None)
    if known.mean() > 0.5:  # the term already happened: the lab's evaluation against what really happened (the model never saw it)
        progress(98, "Comparing with what happened", f"{int(known.sum()):,} admits with a recorded outcome")
        y_k, p_k = actual_y.to_numpy()[known].astype(int), prob[known]
        val = train[train["_code"] == train_terms[-1].code]  # the lab's cut-off: max F1 on the latest training term
        cut = _threshold(val["_y"].to_numpy().astype(int), model.predict_proba(build_X(val, cat, num))[:, 1])
        summary["evaluation"] = {**_scores(y_k, p_k, cut), "admits": int(known.sum()), "actual_enrolled": int(y_k.sum()),
                                 "predicted_enrolled": round(float(p_k.sum()), 1),
                                 "error_pct": round((p_k.sum() - y_k.sum()) / max(y_k.sum(), 1) * 100, 2),
                                 "calibration": _calibration(p_k, y_k)}
    summary["model_info"] = {
        "family": family, "recipe": RECIPE_VERSION, "trees": int(hp["n_estimators"]), "depth": int(hp["max_depth"]),
        "learning_rate": round(hp["learning_rate"], 3), "folds": folds, "calibration": "isotonic" if family == "xgboost" else "sigmoid",
        "recency_decay": hp["recency_decay"], "train_terms": [t.code for t in train_terms], "train_rows": int(len(train)),
        "train_enrolled": int(train["_y"].sum()), "test_term": target.code, "test_rows": int(len(score)),
        "columns": cat + num, "excluded": excluded, "row_order": "student ID" if order is not None else "as stored",
        "seconds": round(time.time() - started, 1),
    }
    summary["breakdowns"] = [{"field": f, "rows": _breakdown(f, score, prob, prior_rows)}
                             for f in dict.fromkeys(c for c in (spec.college, spec.major, *spec.dims) if c and c in score.columns)]
    students = pd.DataFrame({
        "row": np.arange(len(score)),
        "student": score[spec.student_id].to_numpy() if spec.student_id in score else score.index.astype(str),
        "probability": np.round(prob, 4),
        "band": _band(prob),
        "college": score[spec.college].to_numpy() if spec.college in score else "",
        "major": score[spec.major].to_numpy() if spec.major in score else "",
        "actual": actual_y.to_numpy(),
    })
    # every value this run trained with, kept with the forecast in the database (the ML workspace shows them)
    summary["hyperparameters"] = {"values": {**hp, "random_state": seed}, "changed": sorted(clean_params(spec.params)), "family": family}
    return summary, art, students


def _calibration(p: np.ndarray, y: np.ndarray, bins: int = 10) -> list[dict]:
    """Predicted vs actual enrollment rate by tenth of predicted probability, on the held-out term."""
    edges = np.unique(np.quantile(p, np.linspace(0, 1, bins + 1)))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, len(edges) - 2)
    out = []
    for i in range(len(edges) - 1):
        m = idx == i
        if m.sum():
            out.append({"bin": i + 1, "n": int(m.sum()), "predicted": round(float(p[m].mean()), 4), "actual": round(float(y[m].mean()), 4)})
    return out


def _breakdown(field: str, score: pd.DataFrame, prob: np.ndarray, prior: pd.DataFrame | None, top: int = 15) -> list[dict]:
    """Admits, projected enrolled and yield for each value of a field, next to the prior comparable term."""
    cur = pd.DataFrame({"v": score[field].replace("", "Unknown").to_numpy(), "p": prob}).groupby("v")["p"].agg(["size", "sum"])
    pr = prior.assign(v=prior[field].replace("", "Unknown")).groupby("v")["_y"].agg(["size", "sum"]) if prior is not None and len(prior) else None
    big = cur[cur["size"] >= 10].sort_values("size", ascending=False)
    keep, rest = big.head(top), cur.drop(big.head(top).index)
    rows = []
    for k, r in keep.iterrows():
        pa, pe = (int(pr.loc[k, "size"]), int(pr.loc[k, "sum"])) if pr is not None and k in pr.index else (None, None)
        rows.append({"value": str(k), "admits": int(r["size"]), "expected": round(float(r["sum"]), 1), "yield": round(float(r["sum"] / r["size"]), 4),
                     "prior_admits": pa, "prior_enrolled": pe, "prior_yield": round(pe / pa, 4) if pa else None})
    if len(rest):
        rows.append({"value": f"Other ({len(rest)})", "admits": int(rest["size"].sum()), "expected": round(float(rest["sum"].sum()), 1),
                     "yield": round(float(rest["sum"].sum() / rest["size"].sum()), 4), "prior_admits": None, "prior_enrolled": None, "prior_yield": None})
    return rows


def _drivers(art: dict, prob: np.ndarray) -> list[dict]:
    pipe = art["model"]
    names = pipe.named_steps["pre"].get_feature_names_out()
    imps = []
    for cc in pipe.named_steps["model"].calibrated_classifiers_:
        est = cc.estimator
        imps.append(est.feature_importances_ if hasattr(est, "feature_importances_") else np.abs(est.coef_[0]))
    imp = np.mean(imps, axis=0)
    feats = sorted(art["cat"] + art["num"] + ["_year"], key=len, reverse=True)
    by: dict[str, float] = {}
    for name, v in zip(names, imp):
        raw = name.split("__", 1)[1]
        col = next((f for f in feats if raw == f or raw.startswith(f + "_")), raw)
        if col != "_year":
            by[col] = by.get(col, 0.0) + float(v)
    total = sum(by.values()) or 1.0
    out = []
    for k, v in sorted(by.items(), key=lambda kv: -kv[1])[:10]:
        direction = "mixed"
        if k in art["num"]:
            x = to_number(art["raw"][k])
            if x.notna().sum() > 10 and x.std() > 0:
                direction = "up" if np.corrcoef(x.fillna(x.median()), prob)[0, 1] >= 0 else "down"
        out.append({"feature": k, "share": round(v / total, 4), "direction": direction})
    return out


def _summary(spec, d, applications, score, train, train_terms, like_closed, target, prob, art, backtest, family, keep, excluded) -> dict:
    expected = float(prob.sum())
    sd = math.sqrt(float((prob * (1 - prob)).sum()))
    err = 0.08  # planning range: typical year-to-year forecast error, plus admit-level chance
    half = math.sqrt((1.645 * sd) ** 2 + (err * expected) ** 2)
    confidence = "High" if len(train) >= 5000 and len(train_terms) >= 2 else "Medium" if len(train) >= 1000 else "Low"  # how much history it learned from

    apps = int((applications["_code"] == target.code).sum()) if spec.admit_status in d.columns else 0
    prior = None
    if like_closed:
        pt = like_closed[-1]
        pr = d[(d["_code"] == pt.code) & d["_y"].notna()]
        prior = {"term": pt.code, "admits": len(pr), "enrolled": int(pr["_y"].sum()), "yield": round(float(pr["_y"].mean()), 4),
                 "applications": int((applications["_code"] == pt.code).sum()) if spec.admit_status in d.columns else 0}

    trend = []
    for t in like_closed[-5:]:
        part = d[(d["_code"] == t.code) & d["_y"].notna()]
        trend.append({"term": t.code, "actual": round(float(part["_y"].mean()), 4)})
    if trend:
        trend[-1]["projected"] = trend[-1]["actual"]
    trend.append({"term": target.code, "projected": round(expected / len(score), 4)})

    band = _band(prob)
    bins = np.minimum((prob * 10).astype(int), 9)
    distribution = [{"bin": f"{i * 10}–{i * 10 + 10}%", "n": int((bins == i).sum()), "band": str(_band(np.array([i / 10 + 0.05]))[0])} for i in range(10)]
    segments = {b: {"n": int((band == b).sum()), "expected": round(float(prob[band == b].sum()), 1)} for b in ("high", "medium", "low")}

    by_college = []
    if art["college"]:
        c = art["college"]
        g = pd.DataFrame({"c": score[c].replace("", "Unknown").to_numpy(), "p": prob}).groupby("c")["p"].agg(["size", "sum", "mean"])
        prior_rates = d[d["_code"] == prior["term"]].groupby(c)["_y"].mean() if prior else pd.Series(dtype=float)
        for k, r in g[g["size"] >= 10].sort_values("size", ascending=False).head(8).iterrows():
            by_college.append({"college": k, "admits": int(r["size"]), "expected": round(float(r["sum"]), 1), "yield": round(float(r["mean"]), 4),
                               "prior_yield": round(float(prior_rates[k]), 4) if k in prior_rates and not math.isnan(prior_rates[k]) else None})

    funnel = ([{"stage": "Applications", "value": apps}] if apps > len(score) else []) + [
        {"stage": "Admits", "value": len(score)}, {"stage": "Projected enrolled", "value": round(expected, 1)}]
    actual = None
    if score["_y"].notna().mean() > 0.5:
        actual = {"enrolled": int(score["_y"].sum()), "yield": round(float(score["_y"].mean()), 4)}
    return {
        "recipe": RECIPE_VERSION, "model": family, "target_term": target.code, "group": spec.group,
        "train_terms": [t.code for t in train_terms], "train_rows": len(train), "features": keep, "excluded_features": excluded,
        "applications": apps, "admits": int(len(score)), "expected": round(expected, 1),
        "range": [round(max(0.0, expected - half), 1), round(expected + half, 1)], "yield": round(expected / len(score), 4),
        "prior": prior, "actual": actual, "backtest": backtest, "confidence": confidence,
        "segments": segments, "distribution": distribution, "trend": trend, "funnel": funnel,
        "drivers": _drivers(art, prob), "by_college": by_college, "college_field": art["college"],
    }
