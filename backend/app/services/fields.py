"""What each column means: matching an institution's columns to the fields YieldPilot needs."""

import re

import numpy as np
import pandas as pd

FIELDS = [
    {"key": "studentId", "label": "Student ID", "required": True, "match": r"student.?id|emplid|applicant.?id|pidm|banner.?id|^id$|_id$"},
    {"key": "term", "label": "Term", "required": True, "match": r"admit.?term|entry.?term|^term|term$|semester"},
    {"key": "outcome", "label": "Enrollment outcome", "required": True, "match": r"enrol|enrl|matric|yield|outcome|registered"},
    {"key": "admitStatus", "label": "Admit status", "required": False,
     "match": r"^admt$|^admit$|admit.?status|admit.?decision|appl(ication)?.?status|^admitted$|^decision$|decision.?(code|status)$"},
    {"key": "studentType", "label": "Student type", "required": False, "match": r"student.?type|admit.?type|stu.?type|applicant.?type|level|cohort"},
    {"key": "college", "label": "College", "required": False, "match": r"college|school|division"},
    {"key": "major", "label": "Major", "required": False, "match": r"major|program|plan|intended"},
    {"key": "residency", "label": "Residency", "required": False, "match": r"resid|in.?state|domicile|local.?status"},
    {"key": "gpa", "label": "GPA", "required": False, "match": r"gpa"},
    {"key": "aid", "label": "Financial aid offer", "required": False, "match": r"aid_?off|aid_?amt|scholar|grant|award"},
    {"key": "housing", "label": "Housing interest", "required": False, "match": r"housing|dorm|residence.?hall"},
]
NON_FEATURE = {"studentId", "term", "outcome", "admitStatus", "studentType"}
GROUPS = {"FTF": "First-Time Freshman", "TRN": "Transfer"}

YES = re.compile(r"^(1|y|yes|true|t|enrolled|enrl|e|matriculated)$")
NO = re.compile(r"^(0|n|no|false|f|not enrolled|not_enrolled|did not enroll|ne|declined)$|not|decline|withdr")
ADMIT = re.compile(r"^(a|ad|adm|admit|admitted|1|y|yes|true|accepted)$|admit")
TERM_LIKE = re.compile(r"^(fall|spring|summer|winter)\s*\d{4}$|^2\d{3}$|^\d{4}(0[1-9]|[1-9]0)$", re.I)


def vmap(s: pd.Series, fn) -> pd.Series:
    """Apply fn once per distinct value: a column of 300,000 rows usually holds a handful of labels."""
    codes, uniq = pd.factorize(s, use_na_sentinel=False)
    out = np.empty(len(uniq), dtype=object)
    out[:] = [fn(v) for v in uniq]
    return pd.Series(out[codes], index=s.index, name=s.name).infer_objects()


def outcome(v) -> float:
    s = str(v or "").strip().lower()
    if not s:
        return float("nan")
    if YES.match(s):
        return 1.0
    if NO.search(s):
        return 0.0
    return float("nan")


def admitted(v) -> bool:
    s = str(v or "").strip().lower()
    return not s or bool(ADMIT.search(s))


def in_group(v, group: str | None) -> bool:
    if not group:
        return True
    s = str(v or "").lower()
    if group == "TRN":
        return bool(re.search(r"trans|trn|^t$", s))
    return bool(re.search(r"first|fresh|ftf|ftft|fys|^fy|new|^f$", s)) and "trans" not in s


def smart_map(df: pd.DataFrame) -> dict:
    """Best guess by column name, then by values for the essentials, never reusing a column."""
    cols, out, used = list(df.columns), {}, set()
    for f in FIELDS:
        hit = next((c for c in cols if c not in used and re.search(f["match"], c, re.I)), None)
        if hit:
            out[f["key"]], _ = hit, used.add(hit)
    sample = df.head(500)

    def vals(c):
        return sample[c][sample[c] != ""]

    if "outcome" not in out:
        out_col = next((c for c in cols if c not in used and len(vals(c)) > 10 and vals(c).nunique() == 2 and vals(c).map(lambda v: outcome(v) == outcome(v)).all()), None)
        if out_col:
            out["outcome"], _ = out_col, used.add(out_col)
    if "term" not in out:
        t = next((c for c in cols if c not in used and len(vals(c)) > 10 and vals(c).str.match(TERM_LIKE).all() and vals(c).nunique() <= 40), None)
        if t:
            out["term"], _ = t, used.add(t)
    # an admit-status column must actually hold admit decisions (a "days to decision" count does not)
    if out.get("admitStatus") and vals(out["admitStatus"]).map(lambda v: bool(ADMIT.search(str(v).lower()))).mean() < 0.1:
        used.discard(out.pop("admitStatus"))
    if "studentId" not in out:
        sid = next((c for c in cols if c not in used and len(vals(c)) > 10 and vals(c).nunique() >= 0.95 * len(vals(c))), None)
        if sid:
            out["studentId"] = sid
    return out


MAP_SYSTEM = (
    "You review a file uploaded to a university admit-to-enroll yield forecasting tool. First decide what the file is: "
    "admissions records (one row per applicant or admit, with an entry term and whether they enrolled) or something else "
    "(course enrollments, finance, HR, survey, marketing list, unrelated). Then map its columns to the fields the model needs, "
    "using column names and sample values. "
    "term = the entry/admit term of the application. outcome = whether the admitted student enrolled (yes/no, 1/0, enrolled flag, "
    "census enrollment). admitStatus = admission decision (admitted, denied, waitlisted). studentType = first-time freshman vs transfer. "
    "studentId = the per-student identifier. college = the academic college or school. major = the intended program or plan. "
    "residency = where the student is from relative to the campus: values like LOCAL / NON-LOCAL, in-state / out-of-state, "
    "resident / non-resident, international (column names like LOCAL_STATUS, RESIDENCY, STATE_RES, DOMICILE). gpa = high-school or "
    "transfer GPA. aid = a financial-aid offer amount. housing = interest in campus housing. "
    "Check every field against every column; return null only for a field that is truly not present. Never use one column for two fields."
)
MAP_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "is_admissions_data": {"type": "BOOLEAN"},
        "dataset_type": {"type": "STRING"},
        "summary": {"type": "STRING"},
        "fields": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "field": {"type": "STRING", "enum": [f["key"] for f in FIELDS]}, "column": {"type": "STRING", "nullable": True}}, "required": ["field"]}},
    },
    "required": ["is_admissions_data", "dataset_type", "summary", "fields"],
}


def ai_map(df: pd.DataFrame, id_col: str | None, progress=None) -> tuple[dict, bool, dict]:
    """The rule-based guess, reviewed by Gemini from column names and sample values.
    Returns (mapping, used_ai, fit): fit says whether this is admissions data a yield model can learn from.
    progress(done, total): Gemini answers one entry per field, so the entries streamed so far are real progress."""
    from . import ai

    guess = smart_map(df)
    if id_col:
        guess["studentId"] = id_col
    cols = []
    for c in df.columns:
        s = df[c][df[c] != ""]
        cols.append({"name": c, "distinct": int(s.nunique()), "samples": [] if c == id_col else s.value_counts().head(8).index.tolist()})
    res = ai.generate(  # Gemini's fast model: about a second, same matches as the larger model (measured)
        "FIELDS:\n" + "\n".join(f"{f['key']}: {f['label']}" for f in FIELDS) + f"\n\nRULE-BASED GUESS:\n{guess}\n\nCOLUMNS:\n{cols}",
        system=MAP_SYSTEM, schema=MAP_SCHEMA, thinking=0, max_tokens=1500, fast=True, purpose="column_matching",
        on_text=(lambda text: progress(min(text.count('"field"'), len(FIELDS)), len(FIELDS))) if progress else None,
    )
    if not isinstance(res, dict):
        return guess, False, assess(df, guess, None)
    out, used = {}, set()
    for e in res.get("fields", []):
        c = e.get("column")
        if e.get("field") in {f["key"] for f in FIELDS} and c in df.columns and c not in used:
            out[e["field"]], _ = c, used.add(c)
    if id_col:
        out["studentId"] = id_col
    if out.get("admitStatus"):
        s = df[out["admitStatus"]].head(2000)
        if s[s != ""].map(lambda v: bool(ADMIT.search(str(v).lower()))).mean() < 0.1:
            out.pop("admitStatus")
    for k in ("term", "outcome"):  # keep the rule guess for essentials the model left empty
        if k not in out and guess.get(k) and guess[k] not in used:
            out[k] = guess[k]
    return out, True, assess(df, out, res)


def assess(df: pd.DataFrame, m: dict, ai: dict | None) -> dict:
    """Can a yield model learn from this file? The checks that matter, plus Gemini's read of what the file is."""
    problems = []
    if not m.get("term"):
        problems.append("No entry or admit term column was found.")
    if not m.get("outcome"):
        problems.append("No enrollment outcome column (whether each admit enrolled) was found.")
    if len(df) < 200:
        problems.append(f"Only {len(df):,} rows. A yield forecast needs at least a few hundred admits across past terms.")
    if m.get("term") and df[m["term"]].replace("", pd.NA).dropna().nunique() < 2:
        problems.append("Only one term is present; the model needs past terms with known outcomes to learn from.")
    relevant = bool(ai.get("is_admissions_data", True)) if ai else True
    return {"ok": relevant and not problems, "relevant": relevant, "kind": (ai or {}).get("dataset_type", ""),
            "summary": (ai or {}).get("summary", ""), "problems": problems}
