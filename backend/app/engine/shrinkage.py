"""Cycle-level shrinkage, ported from the production admission_yield_lab `cycle_shrinkage.py` (v3 settings).

1. A per-college prior: simple exponential smoothing on each college's observed yield per training cycle,
   forecast `FORECAST_HORIZON` years past the latest cycle. Colleges with fewer than `MIN_HISTORY` cycles use the
   plain mean of their cycle yields (with the usual two training cycles, that is every college).
2. Each scored cohort's base predictions are rescaled toward the prior: ratio = prior / mean(base), clipped to
   [RATIO_FLOOR, RATIO_CEILING], blended with weight ALPHA. Cohorts under MIN_COHORT_SIZE use the all-college
   (cycle-level) ratio instead. Only the cohort's level moves; the order of admits never changes.
"""

import warnings

import numpy as np
import pandas as pd

ALPHA, MIN_COHORT_SIZE, RATIO_FLOOR, RATIO_CEILING, FORECAST_HORIZON, MIN_HISTORY = 0.5, 200, 0.5, 2.0, 2, 5


def _prior(observed: pd.DataFrame) -> tuple[dict[str, dict[int, float]], float]:
    """observed: rows of (year, college, observed yield). Returns {college: {year: forecast}} and the global mean."""
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    global_mean = float(observed["observed"].mean())
    max_year = int(observed["year"].max())
    years = list(range(max_year + 1, max_year + 1 + FORECAST_HORIZON))
    out: dict[str, dict[int, float]] = {}
    for college, sub in observed.groupby("college", dropna=False):
        series = pd.Series(sub.sort_values("year")["observed"].astype(float).values)
        if len(series) < MIN_HISTORY:
            level = float(series.mean()) if len(series) else global_mean
            out[str(college)] = {y: level for y in years}
            continue
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                fc = ExponentialSmoothing(series, trend=None, damped_trend=False, initialization_method="estimated").fit().forecast(steps=FORECAST_HORIZON)
            out[str(college)] = {y: float(fc.iloc[i]) for i, y in enumerate(years)}
        except Exception:
            out[str(college)] = {y: float(series.iloc[-1]) for y in years}
    return out, global_mean


def ratios(train: pd.DataFrame, college: str | None, target_year: int, score_colleges: pd.Series, base_p: np.ndarray) -> tuple[dict[str, float], float]:
    """Per-college rescale ratios for the scored cohort, plus the cycle-level ratio for small or unseen colleges.

    train: training rows with `_year`, `_y` and the college column. score_colleges / base_p: the scored cohort's
    college and raw (calibrated, unshrunk) probability, aligned row for row.
    """
    col = college if college and college in train else None
    tr_col = train[col].astype(str) if col else pd.Series("All", index=train.index)
    observed = (pd.DataFrame({"year": train["_year"].astype(int), "college": tr_col, "y": train["_y"]})
                .groupby(["year", "college"])["y"].mean().rename("observed").reset_index())
    prior, global_mean = _prior(observed)
    priors = {c: f.get(target_year, global_mean) for c, f in prior.items()}

    sc = score_colleges.astype(str) if col else pd.Series("All", index=range(len(base_p)))
    cohort = pd.DataFrame({"college": sc.to_numpy(), "p": base_p}).groupby("college")["p"].agg(["mean", "size"])
    clip = lambda r: float(np.clip(r, RATIO_FLOOR, RATIO_CEILING))  # noqa: E731

    # cycle-level fallback: prior averaged over colleges, base mean weighted by cohort size
    cycle_prior = float(np.nanmean(list(priors.values()))) if priors else float("nan")
    cycle_base = float((cohort["mean"] * cohort["size"]).sum() / cohort["size"].sum()) if len(cohort) else float("nan")
    cycle = clip(cycle_prior / cycle_base) if np.isfinite(cycle_prior) and np.isfinite(cycle_base) and cycle_base > 0 else 1.0

    out = {}
    for c, r in cohort.iterrows():
        mu_prior = priors.get(c, float("nan"))
        if r["size"] >= MIN_COHORT_SIZE:  # big enough for its own ratio (no prior for it: leave unshrunk, as production does)
            out[c] = clip(mu_prior / r["mean"]) if np.isfinite(mu_prior) and r["mean"] > 0 else 1.0
        else:
            out[c] = cycle
    return out, cycle


def apply(p: np.ndarray, colleges: pd.Series | None, by_college: dict[str, float], cycle: float) -> np.ndarray:
    r = colleges.astype(str).map(by_college).fillna(cycle).to_numpy(dtype=float) if colleges is not None else np.full(len(p), cycle)
    return np.clip((1.0 - ALPHA) * p + ALPHA * p * r, 0.0, 1.0)
