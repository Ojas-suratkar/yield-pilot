"""Which columns a model may use. One source of truth for the engine and the Features screen."""

import re

_n = lambda s: re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")  # noqa: E731
PROTECTED = re.compile(r"race|ethnic|ipeds|hispanic|latin|gender|sex$|^sex|religio|disab|citizen|national_?orig|veteran|pronoun|marital|(^|_)age$")
RESTRICTED = re.compile(r"fafsa|isir|(^|_)sai$|efc|pell|(^|_)agi$|parent_?income|family_?income|(^|_)tax")
DETAILED = 100  # a category with more values than this (a full list of majors) slows the forecast without making it more accurate
LEAKAGE = re.compile(r"enroll|matric|census|regist|withdr|deposit|orient|housing_?(dep|assign|contract)|confirm|intent_?to|(^|_)sir($|_)|units_?taken")


def guard(col: str) -> str | None:
    n = _n(col)
    if PROTECTED.search(n):
        return "Protected attribute (used only for fairness checks)"
    if RESTRICTED.search(n):
        return "Restricted financial-aid (FAFSA) data"
    if LEAKAGE.search(n):
        return "Recorded after students decide (would give away the answer)"
    return None
