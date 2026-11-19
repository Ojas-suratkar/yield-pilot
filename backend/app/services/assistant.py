"""Ask YieldPilot: Gemini answers questions about an institution's data and forecast.

Retrieval works through tools: Gemini calls functions that run aggregate queries on the current data version and
the forecast (yield by any column, term history, projected enrollment by group). Every group smaller than
MIN_CELL admits is folded into "Other", so no answer can single out a student.
"""

import json
import math

import numpy as np
import pandas as pd

from ..engine.recipe import to_number
from ..engine.terms import parse
from . import ai
from .fields import GROUPS, admitted, in_group, outcome, vmap

MIN_CELL = 10

SYSTEM = (
    "You are YieldPilot, the enrollment analyst for a university admissions and enrollment services office. "
    "You answer questions about the institution's admissions data and its admit-to-enroll yield forecast. "
    "Ground every number in the FACTS or in results from your tools; call tools to look things up instead of guessing, "
    "and say plainly when the data can't answer something. Use enrollment terms: applications, admits, projected enrolled, "
    "yield %, prior-year yield, percentage points (pp), melt, census. Write for a director: lead with the answer, then the "
    "evidence, then one practical implication. Use short paragraphs or a compact list; no tables wider than 4 columns. "
    "Round percentages to one decimal and student counts to whole numbers, never a fraction of a student. Forecasts are projections, not guarantees. Never reveal or guess individual students."
)


CHAT_FORMAT = (
    "\n\nHOW TO ANSWER (the chat panel renders Markdown):\n"
    "- Plain words for an admissions director. No model jargon (AUC, SHAP, calibration, features) unless asked; say 'information' or 'column'.\n"
    "- Start with the answer in one bold sentence. Then at most 4 short bullets with the key numbers. Under 120 words outside tables.\n"
    "- Comparing groups, terms or options: a Markdown table (at most 4 columns, 8 rows) instead of long bullets.\n"
    "- When a picture helps (a trend, or groups side by side), add ONE chart block after the text, exactly like:\n"
    '```chart\n{"type": "bar", "title": "Projected yield by college", "unit": "%", "data": [{"label": "Engineering", "value": 24.5}]}\n```\n'
    "  type is bar or line; at most 10 points; values are plain numbers (percent as 24.5 with unit %).\n"
    "- Follow-ups build on the conversation: resolve 'it', 'that', 'those', 'why' from the earlier turns and don't repeat what was said.\n"
    "- No headings, no preamble ('Great question'), no closing offers. If the data can't answer, say so in one sentence."
)


def term_name(code: str | None) -> str:
    t = parse(code) if code else None
    if not t:
        return code or ""
    return f"{t.season.title()} {t.year}" if t.season in {"fall", "spring", "summer", "winter"} else code


def _num(x):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    return round(float(x), 4) if isinstance(x, (float, np.floating)) else int(x) if isinstance(x, (int, np.integer)) else x


class Context:
    """Everything the assistant may look at for one project: the data version, mapping, setup and forecast."""

    def __init__(self, df: pd.DataFrame, mapping: dict, setup: dict, meta: dict, summary: dict | None = None,
                 art: dict | None = None, students: pd.DataFrame | None = None):
        self.m, self.setup, self.meta, self.summary = mapping, setup, meta, summary
        self.art, self.students = art, students
        d = df
        self.term = mapping.get("term") if mapping.get("term") in df else None
        d = d.assign(_y=vmap(d[mapping["outcome"]], outcome).astype(float)) if mapping.get("outcome") in d else d.assign(_y=np.nan)
        d = d.assign(_adm=vmap(d[mapping["admitStatus"]], admitted).astype(bool)) if mapping.get("admitStatus") in d else d.assign(_adm=True)
        st = mapping.get("studentType") if mapping.get("studentType") in d else None
        for g in GROUPS:
            d[f"_{g}"] = vmap(d[st], lambda v, g=g: in_group(v, g)).astype(bool) if st else True
        self.df = d
        self.id_col = meta.get("id_column")

    # ------------------------------------------------------------------ shared helpers

    def _admits(self, term: str = "", population: str = "") -> pd.DataFrame:
        d = self.df[self.df["_adm"]]
        if term and self.term:
            d = d[d[self.term].astype(str) == str(term)]
        if population.upper() in GROUPS:
            d = d[d[f"_{population.upper()}"]]
        return d

    def _groups(self, d: pd.DataFrame, column: str) -> pd.Series:
        s = d[column]
        x = to_number(s)
        if x.notna().mean() > 0.95 and s.nunique() > 12:
            return pd.qcut(x, 5, duplicates="drop").astype(str).replace("nan", "(blank)")
        return s.replace("", "(blank)")

    def _columns(self) -> list[str]:
        return [c for c in self.df.columns if not c.startswith("_") and c != self.id_col]

    # ------------------------------------------------------------------ tools Gemini can call

    def tools(self):
        ctx = self

        def yield_by(column: str, term: str = "", population: str = "") -> dict:
            """Historical yield for each value of a column: admits, admits with a known outcome, enrolled and yield rate.

            Args:
                column: exact column name from the dataset.
                term: optional term code to limit to (for example "2254"); empty means all terms.
                population: optional "FTF" (first-time freshman) or "TRN" (transfer); empty means all admits.
            """
            if column not in ctx._columns():
                return {"error": f"No column '{column}'.", "columns": ctx._columns()[:80]}
            d = ctx._admits(term, population)
            if d.empty:
                return {"error": "No admits match that term and population."}
            g = pd.DataFrame({"v": ctx._groups(d, column), "y": d["_y"]}).groupby("v")["y"].agg(admits="size", known="count", enrolled="sum")
            small = g[g["admits"] < MIN_CELL]
            g = g[g["admits"] >= MIN_CELL].sort_values("admits", ascending=False)
            rows = [{"value": str(k), "admits": int(r.admits), "known_outcome": int(r.known), "enrolled": int(r.enrolled),
                     "yield": _num(r.enrolled / r.known) if r.known else None} for k, r in g.head(25).iterrows()]
            if len(small):
                rows.append({"value": f"Other ({len(small)} small groups)", "admits": int(small["admits"].sum())})
            return {"column": column, "term": term or "all", "population": GROUPS.get(population.upper(), "All admits"), "groups": rows}

        def term_history(population: str = "") -> dict:
            """Applications, admits, admits with known outcome, enrolled and yield for every term in the data.

            Args:
                population: optional "FTF" or "TRN"; empty means all students.
            """
            if not ctx.term:
                return {"error": "No term column is mapped."}
            d = ctx.df if population.upper() not in GROUPS else ctx.df[ctx.df[f"_{population.upper()}"]]
            out = []
            for code, part in d.groupby(ctx.term):
                if parse(code) is None:
                    continue
                a = part[part["_adm"]]
                known = int(a["_y"].notna().sum())
                out.append({"term": str(code), "name": term_name(str(code)), "applications": int(len(part)), "admits": int(len(a)),
                            "known_outcome": known, "enrolled": int(a["_y"].sum()), "yield": _num(a["_y"].sum() / known) if known else None,
                            "order": parse(code).order})
            return {"population": GROUPS.get(population.upper(), "All"), "terms": [{k: v for k, v in r.items() if k != "order"} for r in sorted(out, key=lambda r: r["order"])]}

        def describe_column(column: str) -> dict:
            """Completeness and distribution of one column: blanks, distinct values, most common values or numeric range.

            Args:
                column: exact column name from the dataset.
            """
            if column not in ctx._columns():
                return {"error": f"No column '{column}'.", "columns": ctx._columns()[:80]}
            s = ctx.df[column]
            out = {"column": column, "rows": int(len(s)), "blank": int((s == "").sum()), "distinct": int(s[s != ""].nunique())}
            x = to_number(s)
            if x.notna().sum() and x.notna().sum() >= 0.95 * (s != "").sum():
                out.update({k: _num(v) for k, v in {"min": x.min(), "p25": x.quantile(0.25), "median": x.median(), "p75": x.quantile(0.75), "max": x.max(), "mean": x.mean()}.items()})
            else:
                vc = s[s != ""].value_counts()
                out["top_values"] = [{"value": str(k), "count": int(c)} for k, c in vc[vc >= MIN_CELL].head(20).items()]
            return out

        def projected_by(column: str) -> dict:
            """For the forecast term: admits, projected enrolled and projected yield for each value of a column,
            with last comparable term's actual yield for the same value.

            Args:
                column: a column used by the model, or the college or major column.
            """
            if ctx.art is None or ctx.students is None:
                return {"error": "There is no forecast yet. Run a prediction first."}
            raw = ctx.art["raw"]
            if column not in raw:
                return {"error": f"'{column}' isn't in the forecast's model inputs.", "available": [c for c in raw.columns if not c.startswith("_")]}
            p = ctx.students.sort_values("row")["probability"].to_numpy()
            g = pd.DataFrame({"v": ctx._groups(raw, column), "p": p}).groupby("v")["p"].agg(admits="size", projected="sum")
            g = g[g["admits"] >= MIN_CELL].sort_values("admits", ascending=False)
            prior_term = (ctx.summary or {}).get("prior", {}) or {}
            prior = {}
            if prior_term.get("term") and column in ctx.df:
                pr = ctx._admits(prior_term["term"], ctx.setup.get("group", ""))
                pr = pr[pr["_y"].notna()]
                if len(pr):
                    pg = pd.DataFrame({"v": ctx._groups(pr, column), "y": pr["_y"]}).groupby("v")["y"].agg(["size", "mean"])
                    prior = {k: _num(r["mean"]) for k, r in pg[pg["size"] >= MIN_CELL].iterrows()}
            return {"column": column, "term": term_name((ctx.summary or {}).get("target_term")), "groups": [
                {"value": str(k), "admits": int(r.admits), "projected_enrolled": _num(r.projected), "projected_yield": _num(r.projected / r.admits),
                 "prior_yield": prior.get(k)} for k, r in g.head(25).iterrows()]}

        return [yield_by, term_history, describe_column, projected_by]

    # ------------------------------------------------------------------ facts given up front

    def facts(self) -> dict:
        prof = self.meta.get("profile") or []
        f = {
            "dataset": {"file": self.meta.get("filename"), "version": self.meta.get("version"), "rows": int(len(self.df)),
                        "columns": [{"name": c["name"], "kind": c["kind"], "blank_pct": c["missing_pct"], "distinct": c["distinct"]}
                                    for c in prof if c["name"] != self.id_col][:120]},
            "field_mapping": self.m,
            "setup": {"forecast_term": self.setup.get("term"), "forecast_term_name": term_name(self.setup.get("term")),
                      "population": GROUPS.get(self.setup.get("group") or "", "All admits"), "training_terms": self.setup.get("train_terms")},
            "data_audit": self.meta.get("audit"),
        }
        if self.summary:
            keep = ["target_term", "applications", "admits", "expected", "range", "yield", "prior", "actual", "backtest", "confidence",
                    "segments", "trend", "drivers", "by_college", "breakdowns", "train_terms", "train_rows", "model", "features", "excluded_features"]
            f["forecast"] = {k: self.summary.get(k) for k in keep if k in self.summary}
        return f


def answer(ctx: Context, question: str, history: list[dict] | None = None) -> str:
    chart = CHARTS.get(question.strip().lower())
    if chart and ctx.summary:
        return explain_chart(chart, ctx.summary, ctx)
    convo = "".join(f"{m.get('role', 'user').upper()}: {str(m.get('text', ''))[:1500]}\n" for m in (history or [])[-10:])
    text = ai.generate(
        f"FACTS:\n{json.dumps(ctx.facts(), default=str)}\n\nCONVERSATION SO FAR:\n{convo or '(none)'}\n\nNEW QUESTION: {question}",
        system=SYSTEM + CHAT_FORMAT, tools=ctx.tools(), thinking=512, max_tokens=1200, purpose="question",
    )
    if text:
        return text
    return _fallback_answer(ctx.summary, question) if ctx.summary else "The assistant is unavailable right now. Please try again in a moment."


def summarize(summary: dict, ctx: Context | None = None) -> str:
    facts = ctx.facts() if ctx else {"forecast": summary}
    text = ai.generate(
        "Write the executive summary of this yield forecast for the enrollment leadership team: 2 short paragraphs. "
        "Paragraph 1: the projected class (enrolled, range, yield) against the prior comparable term, and how confident the model is "
        "(backtest error, AUC). Paragraph 2: where the class is at risk or growing (colleges or groups with the largest changes, the "
        "medium-likelihood admits) and the 2-3 actions most likely to protect yield, grounded in the drivers. "
        "Return only the two paragraphs: no title, no preamble.\n\nFACTS:\n"
        + json.dumps(facts, default=str),
        system=SYSTEM, thinking=0, max_tokens=900, purpose="summary",
    )
    return text or _fallback_summary(summary)


CHARTS = {
    "explain the yield trend chart": "trend", "explain yield by college": "college", "explain the admissions funnel": "funnel",
    "explain the probability distribution": "dist", "explain the top drivers": "drivers", "explain admits by likelihood": "segments",
    "explain the model accuracy check": "calibration", "explain yield by major": "major", "explain where yield is changing": "changes",
}
CHART_DATA = {"trend": "trend", "college": "by_college", "funnel": "funnel", "dist": "distribution", "drivers": "drivers",
              "segments": "segments", "calibration": "backtest", "major": "breakdowns", "changes": "breakdowns"}


def explain_chart(key: str, s: dict, ctx: Context | None = None) -> str:
    title = next(q for q, k in CHARTS.items() if k == key).removeprefix("explain ").removeprefix("the ")
    text = ai.generate(
        f"Explain the '{title}' view of the {term_name(s['target_term'])} yield forecast to an enrollment director: what it shows, "
        f"the 2-3 most important takeaways with exact numbers, and one practical action.\n\n"
        f"CHART DATA:\n{json.dumps(s.get(CHART_DATA[key]), default=str)}\n\nFORECAST:\n"
        + json.dumps({k: s.get(k) for k in ("admits", "expected", "range", "yield", "prior", "backtest", "confidence")}, default=str),
        system=SYSTEM + CHAT_FORMAT, thinking=0, max_tokens=700, purpose="chart_explanation",
    )
    return text or _fallback_chart(key, s)


# ---------------------------------------------------------------------- deterministic fallbacks


def _pct(x):
    return f"{x * 100:.1f}%"


def _pp(x: float) -> str:
    return f"{'+' if x >= 0 else '−'}{abs(x * 100):.1f} pp"


def _fallback_summary(s: dict) -> str:
    out = [f"For {term_name(s['target_term'])}, YieldPilot projects {s['expected']:,.0f} enrolled from {s['admits']:,} admits, "
           f"a projected yield of {_pct(s['yield'])} (expected range {s['range'][0]:,.0f}–{s['range'][1]:,.0f})."]
    if s.get("prior"):
        out.append(f"That is {_pp(s['yield'] - s['prior']['yield'])} against {term_name(s['prior']['term'])}, when {_pct(s['prior']['yield'])} of admits enrolled.")
    if s.get("drivers"):
        out.append("The strongest predictors are " + ", ".join(d["feature"] for d in s["drivers"][:3]) + ".")
    if s.get("backtest"):
        out.append(f"Model confidence is {s['confidence'].lower()}: on {term_name(s['backtest']['term'])} the projection was within "
                   f"{abs(s['backtest']['error_pct']):.1f}% of actual enrollment.")
    out.append(f"{s['segments']['medium']['n']:,} admits are in the medium-likelihood segment, where outreach is most likely to change outcomes.")
    return " ".join(out)


def _fallback_answer(s: dict, q: str) -> str:
    t = q.lower()
    if any(w in t for w in ("driv", "why", "factor", "influen")):
        return "Projected yield is driven most by " + ", ".join(f"{d['feature']} ({d['share']:.0%})" for d in s["drivers"][:4]) + "."
    if any(w in t for w in ("reliab", "trust", "accura", "confiden")) and s.get("backtest"):
        b = s["backtest"]
        return f"Model confidence is {s['confidence']}. On {term_name(b['term'])} it projected {b['predicted']:,.0f} enrolled vs {b['actual']:,} actual ({b['error_pct']:+.1f}%)."
    if any(w in t for w in ("prior", "last year", "compare")) and s.get("prior"):
        p = s["prior"]
        return f"{term_name(p['term'])} yield was {_pct(p['yield'])}; {term_name(s['target_term'])} is projected at {_pct(s['yield'])} ({_pp(s['yield'] - p['yield'])})."
    if any(w in t for w in ("who", "priorit", "focus", "outreach")):
        m = s["segments"]["medium"]
        return f"Prioritize the {m['n']:,} medium-likelihood admits (40–69%); about {m['expected']:,.0f} of them are projected to enroll."
    return _fallback_summary(s)


def _fallback_chart(key: str, s: dict) -> str:
    if key == "college" and s.get("by_college"):
        by = sorted(s["by_college"], key=lambda c: c["yield"], reverse=True)
        return f"{by[0]['college']} has the highest projected yield at {_pct(by[0]['yield'])}; {by[-1]['college']} the lowest at {_pct(by[-1]['yield'])}."
    if key == "segments":
        g = s["segments"]
        return (f"High (≥ 70%): {g['high']['n']:,} admits, ~{g['high']['expected']:,.0f} enroll. Medium (40–69%): {g['medium']['n']:,} admits, "
                f"~{g['medium']['expected']:,.0f} enroll. Low (< 40%): {g['low']['n']:,} admits, ~{g['low']['expected']:,.0f} enroll.")
    if key == "calibration" and s.get("backtest"):
        b = s["backtest"]
        return f"Tested on {term_name(b['term'])}: projected {b['predicted']:,.0f} vs {b['actual']:,} actual enrolled ({b['error_pct']:+.1f}%)."
    return _fallback_summary(s)


IDEAS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "scenarios": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "title": {"type": "STRING"}, "rationale": {"type": "STRING"},
            "values": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"feature": {"type": "STRING"}, "value": {"type": "NUMBER"}},
                                                  "required": ["feature", "value"]}}},
            "required": ["title", "rationale", "values"]}},
        "plans": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"feature": {"type": "STRING"}, "plan": {"type": "STRING"}},
                                             "required": ["feature", "plan"]}},
    },
    "required": ["scenarios", "plans"],
}


def ideas(summary: dict, levers: list[dict], actions: list[dict]) -> dict | None:
    """Gemini proposes realistic strategies built from the levers in this data; the caller scores each with the model."""
    return ai.generate(
        "You advise an enrollment office. Using only the levers below (each is a column in their data that the office can influence), "
        "propose 3 realistic, distinct strategies an enrollment office could actually run this cycle, from modest to ambitious. "
        "Each strategy sets one to three levers; values must stay within each lever's min and max (units are described by kind: "
        "pct = percent change to the value, share = percent of admits who get it, count = percent of admits who get one more). "
        "Write a short title (max 6 words) and a one-sentence rationale in plain language, no jargon. Then, for each lever, write "
        "a two-sentence plan: what staff should do and which admits to focus on, using the likelihood segments.\n\n"
        f"LEVERS:\n{json.dumps(levers)}\n\nSINGLE-LEVER RESULTS FROM THE MODEL:\n{json.dumps(actions)}\n\n"
        f"FORECAST:\n{json.dumps({k: summary.get(k) for k in ('target_term', 'admits', 'expected', 'yield', 'segments', 'drivers')}, default=str)}",
        system=SYSTEM, schema=IDEAS_SCHEMA, thinking=0, max_tokens=2500, purpose="scenario_ideas",
    )
