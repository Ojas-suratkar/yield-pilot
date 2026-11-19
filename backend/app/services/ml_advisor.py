"""The AI in the ML workspace: complete sets of model settings worth testing, from the data, the latest results and every setting's
allowed range, and (in Smart tuning) a second, refined round after seeing how the first did.

Each set gives a value for every setting, with a short reason, so a person can apply them one by one or all at once. Every value is
checked against the allowed range before anyone sees it (a bad one keeps the current value); the test itself is what decides."""

import json
import logging

from ..engine import recipe
from . import ai

log = logging.getLogger(__name__)

SETTINGS = [k for k in recipe.TUNABLE if k != "random_state"]
SYSTEM = (
    "You are a senior machine learning engineer tuning an XGBoost classifier that predicts which admitted students will enroll at a "
    "university. You propose complete sets of settings worth testing; a test on last year's known outcomes decides. Be concrete and brief."
)
SCHEMA = {
    "type": "OBJECT",
    "properties": {"sets": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "name": {"type": "STRING"}, "why": {"type": "STRING"},
        "values": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "setting": {"type": "STRING"}, "value": {"type": "STRING"}, "reason": {"type": "STRING"}}, "required": ["setting", "value", "reason"]}}},
        "required": ["name", "why", "values"]}}},
    "required": ["sets"],
}
FALLBACK = [
    {"name": "Slower, more trees", "why": "A lower learning rate with more trees usually generalizes better on several years of admits.",
     "changes": {"learning_rate": 0.06, "n_estimators": 2000}},
    {"name": "Shallower trees", "why": "Smaller trees with more evidence per split are less likely to memorize one year's quirks.",
     "changes": {"max_depth": 5, "min_child_weight": 6}},
    {"name": "More regularization", "why": "Stronger penalties and more row sampling make the forecast steadier when patterns shift between years.",
     "changes": {"reg_lambda": 10, "gamma": 2.5, "subsample": 0.8}},
]


def _value(raw):
    try:
        x = float(raw)
        return int(x) if x.is_integer() else x
    except (TypeError, ValueError):
        return str(raw).strip()


def _ranges() -> dict:
    return {k: {"kind": v[0], "min": v[1], "max": v[2], **({"options": recipe.CHOICES[k]} if k in recipe.CHOICES else {})}
            for k, v in recipe.TUNABLE.items() if k in SETTINGS}


def _complete(proposed: dict, reasons: dict, current: dict, base: dict) -> tuple[dict, dict, dict]:
    """Every setting's value (a missing or invalid one keeps the current value), the changes from the base, and the reasons."""
    values, why = {}, {}
    for k in SETTINGS:
        v = proposed.get(k, current.get(k))
        try:
            recipe.clean_params({k: v})  # in range, the right kind
        except ValueError:
            v = current.get(k)
        if v is None:
            v = current.get(k)
        values[k] = int(v) if recipe.TUNABLE[k][0] == "int" and isinstance(v, (int, float)) else v
        if reasons.get(k):
            why[k] = str(reasons[k])[:160]
    return values, recipe.clean_params(values, base), why


def _ask(task: str, facts: dict, current: dict, base: dict, n: int) -> list[dict]:
    out: list[dict] = []
    raw = ai.generate(
        f"{task} Give exactly {n} distinct sets. Each set must give a value for EVERY setting listed below (all {len(SETTINGS)} of them), "
        "within its min and max (whole numbers for int, one of the options for a choice), keeping a setting's current value when it shouldn't "
        "change, with a reason of at most 12 words for each value. Give each set a name of at most 4 words and one plain-language sentence "
        "saying why it might help this data.\n\n"
        f"DATA AND RESULTS SO FAR:\n{json.dumps(facts, default=str)}\n\nCURRENT SETTINGS:\n{json.dumps(current, default=str)}\n\n"
        f"SETTINGS AND THEIR RANGES:\n{json.dumps(_ranges())}",
        system=SYSTEM, schema=SCHEMA, thinking=0, max_tokens=6000, purpose="ml_recommendations",
    )
    seen = {json.dumps(recipe.clean_params(current, base), sort_keys=True)}
    for s in (raw or {}).get("sets", [])[:n]:
        vals = {v.get("setting"): _value(v.get("value")) for v in s.get("values", []) if v.get("setting") in SETTINGS}
        reasons = {v.get("setting"): v.get("reason") for v in s.get("values", []) if v.get("setting") in SETTINGS}
        values, params, why = _complete(vals, reasons, current, base)
        key = json.dumps(params, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": str(s.get("name", "Suggestion"))[:60], "why": str(s.get("why", ""))[:300], "values": values, "params": params,
                    "reasons": why, "source": "ai"})
    return out


def recommend(facts: dict, current: dict, base: dict) -> list[dict]:
    """Three complete sets: {name, why, values (every setting), params (changes from the base), reasons, source}. Falls back to proven
    suggestions if the AI isn't available. `current` is every setting the prediction uses now; `base` the defaults."""
    try:
        out = _ask("Propose sets of settings worth testing for this enrollment model, from cautious to bold.", facts, current, base, 3)
    except Exception as e:  # the AI is unavailable or answered badly: the proven suggestions below still give a useful test
        log.warning("ML recommendations fell back: %s", type(e).__name__)
        out = []
    if not out:
        for f in FALLBACK:
            values, params, _ = _complete({**current, **f["changes"]}, {}, current, base)
            out.append({"name": f["name"], "why": f["why"], "values": values, "params": params,
                        "reasons": {k: "Part of this proven setup" for k in f["changes"]}, "source": "suggested"})
    return out


def refine(facts: dict, current: dict, base: dict, tested: list[dict], objective: str) -> list[dict]:
    """Smart tuning's second round: two sets that build on what scored best for the goal in the first round (none if the AI isn't
    available; the first round's result stands)."""
    label = recipe.OBJECTIVES.get(objective, recipe.OBJECTIVES["roc_auc"])[0]
    try:
        return _ask(f"These settings were just tested on last year's known outcomes; the goal is: {label}. Study the scores and propose "
                    "refined sets likely to beat the best one, building on what worked.", {**facts, "tested_just_now": tested, "goal": label},
                    current, base, 2)
    except Exception as e:
        log.warning("ML refinement skipped: %s", type(e).__name__)
        return []
