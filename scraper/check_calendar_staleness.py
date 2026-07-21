"""
Checks whether scraper/registration_windows.json is running low on future
entries. The scheduler needs this file to know when to scrape more
frequently; if nobody extends it once a year when the registrar publishes
the next academic year's calendar, the scraper silently degrades to its
default (daily-only) cadence instead of erroring loudly - which is safe, but
easy to not notice. This script exists to make it noticeable instead.

Usage:
    python check_calendar_staleness.py [--warn-within-days 180]

Prints a human-readable message and, if GITHUB_OUTPUT is set (i.e. running
inside a GitHub Actions step), writes `stale=true`/`stale=false` plus a
`message` output for a workflow to act on (e.g. open a reminder issue).
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import date
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "registration_windows.json"


def furthest_end_date(config_path: Path = CONFIG_PATH) -> date:
    windows = json.loads(config_path.read_text())["windows"]
    return max(date.fromisoformat(w["end"]) for w in windows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warn-within-days", type=int, default=180)
    args = ap.parse_args()

    furthest = furthest_end_date()
    days_left = (furthest - date.today()).days
    stale = days_left < args.warn_within_days

    if stale:
        message = (
            f"scraper/registration_windows.json only has entries through {furthest.isoformat()} "
            f"({days_left} day(s) away). Add the next academic year's registration/add-drop dates "
            "from https://www.macalester.edu/registrar/academic-calendars/ so the scraper keeps "
            "running at its faster cadence during future registration periods."
        )
        print(f"STALE: {message}")
    else:
        message = f"registration_windows.json looks fine - entries go through {furthest.isoformat()} ({days_left} days away)."
        print(f"OK: {message}")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"stale={'true' if stale else 'false'}\n")
            f.write(f"message={message}\n")


if __name__ == "__main__":
    main()
