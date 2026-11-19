"""Read term codes from any system: PeopleSoft (2264), Banner (202510), or text ("Fall 2025")."""

import re
from dataclasses import dataclass

SEASONS = {"spring": 1, "summer": 2, "fall": 3, "autumn": 3, "winter": 0}
PS_SEASON = {"2": "spring", "4": "fall", "6": "summer", "8": "summer"}


@dataclass(frozen=True)
class Term:
    code: str
    year: int
    season: str
    order: int  # sortable


def parse(code: str) -> Term | None:
    c = str(code).strip()
    m = re.fullmatch(r"2(\d)(\d)(\d)", c)  # PeopleSoft/CSU: 2 + yy + season
    if m:
        year = 2000 + 10 * int(m[1]) + int(m[2])
        season = PS_SEASON.get(m[3], m[3])
        return Term(c, year, season, year * 10 + SEASONS.get(season, int(m[3]) % 10))
    m = re.fullmatch(r"(19|20)(\d\d)(\d\d)", c)  # Banner: yyyy + 2-digit part of term
    if m:
        year = int(m[1] + m[2])
        return Term(c, year, f"p{m[3]}", year * 100 + int(m[3]))
    m = re.search(r"(spring|summer|fall|autumn|winter)\D*((?:19|20)\d\d)|((?:19|20)\d\d)\D*(spring|summer|fall|autumn|winter)", c, re.I)
    if m:
        season = (m[1] or m[4]).lower()
        year = int(m[2] or m[3])
        season = "fall" if season == "autumn" else season
        return Term(c, year, season, year * 10 + SEASONS[season])
    m = re.fullmatch(r"(19|20)\d\d", c)
    if m:
        return Term(c, int(c), "year", int(c) * 10)
    return None
