"""
Generates the list of Macalester term codes to scrape.

Coding scheme (given by the registrar's system):
    YYYYTT
    TT: Fall=10, January=20, Spring=30, Summer I=40, Summer II=50, Summer III=60
    YYYY: the ACADEMIC year the term ends in.
          Fall terms use *next* calendar year, e.g. Fall 2026 -> 202710.
          January/Spring/Summer terms use their own calendar year, e.g. Spring 2027 -> 202730.

So "Fall 2008" (the college's earliest offered term we care about) = 200910.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

TERM_CODES = {
    "Fall": "10",
    "January": "20",
    "Spring": "30",
    "Summer I": "40",
    "Summer II": "50",
    "Summer III": "60",
}

# Chronological order for a given *labeled* calendar year (e.g. all the "2008"
# terms): January/Spring/Summer happen first, then Fall of that same labeled
# year (which is actually coded with YYYY+1, but is still named "Fall 2008").
TERM_ORDER = ["January", "Spring", "Summer I", "Summer II", "Summer III", "Fall"]

EARLIEST_FALL_CALENDAR_YEAR = 2008  # "Fall 2008" as the user names it


@dataclass(frozen=True)
class Term:
    code: str          # e.g. "200910"
    season: str        # e.g. "Fall"
    calendar_year: int  # the year the user would say, e.g. 2008 for "Fall 2008"

    @property
    def label(self) -> str:
        return f"{self.season} {self.calendar_year}"


def term_code(season: str, calendar_year: int) -> str:
    yyyy = calendar_year + 1 if season == "Fall" else calendar_year
    return f"{yyyy}{TERM_CODES[season]}"


def make_term(season: str, calendar_year: int) -> Term:
    return Term(code=term_code(season, calendar_year), season=season, calendar_year=calendar_year)


def all_terms(through_calendar_year: int | None = None, from_calendar_year: int | None = None) -> list[Term]:
    """
    All terms from Fall 2008 (or `from_calendar_year`, if later) through
    `through_calendar_year` (inclusive), in chronological order. Defaults to
    (current calendar year + 1) so upcoming Fall terms are always included
    ahead of time ("set and forget"). `from_calendar_year` is handy for
    running the backfill in chunks (e.g. one GitHub Actions run per decade)
    if a single run risks the 6-hour job limit.
    """
    if through_calendar_year is None:
        through_calendar_year = date.today().year + 1
    first_year = max(EARLIEST_FALL_CALENDAR_YEAR, from_calendar_year or EARLIEST_FALL_CALENDAR_YEAR)

    start_code = term_code("Fall", EARLIEST_FALL_CALENDAR_YEAR)  # "200910" - the user's requested start
    terms: list[Term] = []
    for year in range(first_year, through_calendar_year + 1):
        for season in TERM_ORDER:
            t = make_term(season, year)
            if t.code >= start_code:  # zero-padded 6-digit codes sort correctly as strings
                terms.append(t)
    return terms


def active_terms(window_terms_back: int = 1, window_terms_forward: int = 4) -> list[Term]:
    """
    A short list of terms "in play" right now: a couple of recent terms
    (in case seat counts / late data are still settling) plus the next few
    upcoming terms (which may not have data yet, or whose registration is
    currently open). Used by the frequent/incremental scrape job so it
    doesn't have to touch all ~110 terms every run.
    """
    today = date.today()
    # crude current-term estimate good enough for windowing purposes
    all_t = all_terms(through_calendar_year=today.year + 2)
    # naive: terms are chronological already; find index nearest to today
    # using calendar_year and season order as a proxy for month
    season_month_rank = {"January": 0, "Spring": 1, "Summer I": 2, "Summer II": 2.3, "Summer III": 2.6, "Fall": 3}
    today_rank = (today.year, season_month_rank["Fall"] if today.month >= 8 else
                  season_month_rank["Summer I"] if today.month >= 6 else
                  season_month_rank["Spring"] if today.month >= 2 else
                  season_month_rank["January"])

    def rank(t: Term):
        return (t.calendar_year, season_month_rank[t.season])

    all_t_sorted = sorted(all_t, key=rank)
    idx = 0
    for i, t in enumerate(all_t_sorted):
        if rank(t) <= today_rank:
            idx = i
    lo = max(0, idx - window_terms_back)
    hi = min(len(all_t_sorted), idx + window_terms_forward + 1)
    return all_t_sorted[lo:hi]


if __name__ == "__main__":
    for t in all_terms(through_calendar_year=2027):
        print(t.code, t.label)
