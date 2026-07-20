"""
Orchestrates scraping one or more terms and writing out data/<code>.json plus
a data/index.json manifest that the web app reads.

Usage:
    python run.py --mode backfill              # every term, Fall 2008 -> now+1yr
    python run.py --mode incremental            # just the "active" window of terms
    python run.py --mode single --term 202710   # one specific term (debugging)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from parser import parse_schedule_html
from render import render_term_html
from terms import Term, active_terms, all_terms

DATA_DIR = Path(__file__).parent.parent / "data"
POLITE_DELAY_SECONDS = 3
MAX_ATTEMPTS = 3


def scrape_one(term: Term) -> list[dict]:
    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            html = render_term_html(term.code)
            return parse_schedule_html(html)
        except Exception as e:  # noqa: BLE001 - we want to retry on anything and log it
            last_err = e
            print(f"  attempt {attempt}/{MAX_ATTEMPTS} failed for {term.code}: {e}", file=sys.stderr)
            time.sleep(5 * attempt)
    raise RuntimeError(f"Giving up on {term.code} after {MAX_ATTEMPTS} attempts") from last_err


def write_term_file(term: Term, courses: list[dict]) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{term.code}.json"
    payload = {
        "term_code": term.code,
        "term_label": term.label,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "course_count": len(courses),
        "courses": courses,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return payload


def update_index(term_payloads: dict[str, dict]) -> None:
    """
    Merges freshly-scraped term summaries into the existing index.json so a
    partial/incremental run doesn't wipe out terms it didn't touch this time.
    """
    index_path = DATA_DIR / "index.json"
    existing = {}
    if index_path.exists():
        existing = {t["term_code"]: t for t in json.loads(index_path.read_text())["terms"]}

    for code, payload in term_payloads.items():
        if payload["course_count"] == 0:
            # Term not offered (or nothing found) - don't advertise a data file
            # for it, but do remember we checked, so future incremental runs
            # can decide whether it's worth re-checking (e.g. newly-announced
            # future term) without a human having to notice.
            existing.pop(code, None)
            continue
        existing[code] = {
            "term_code": payload["term_code"],
            "term_label": payload["term_label"],
            "course_count": payload["course_count"],
            "scraped_at": payload["scraped_at"],
        }

    terms_sorted = sorted(existing.values(), key=lambda t: t["term_code"])
    index_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "terms": terms_sorted,
            },
            indent=2,
        )
    )


def run(terms: list[Term]) -> None:
    payloads = {}
    for i, term in enumerate(terms, 1):
        print(f"[{i}/{len(terms)}] scraping {term.label} ({term.code})...")
        try:
            courses = scrape_one(term)
        except RuntimeError as e:
            print(f"  SKIPPING {term.code}: {e}", file=sys.stderr)
            continue
        payload = write_term_file(term, courses)
        payloads[term.code] = payload
        print(f"  -> {payload['course_count']} sections")
        time.sleep(POLITE_DELAY_SECONDS)
    update_index(payloads)
    print(f"Done. {len(payloads)} terms written/updated.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["backfill", "incremental", "single"], default="incremental")
    ap.add_argument("--term", help="term code for --mode single, e.g. 202710")
    ap.add_argument("--through-year", type=int, default=None, help="override end year for backfill")
    ap.add_argument("--from-year", type=int, default=None, help="start year for a chunked backfill")
    args = ap.parse_args()

    if args.mode == "backfill":
        run(all_terms(through_calendar_year=args.through_year, from_calendar_year=args.from_year))
    elif args.mode == "incremental":
        run(active_terms())
    elif args.mode == "single":
        if not args.term:
            ap.error("--mode single requires --term")
        season_by_suffix = {"10": "Fall", "20": "January", "30": "Spring", "40": "Summer I", "50": "Summer II", "60": "Summer III"}
        suffix = args.term[-2:]
        yyyy = int(args.term[:4])
        season = season_by_suffix[suffix]
        cal_year = yyyy - 1 if season == "Fall" else yyyy
        run([Term(code=args.term, season=season, calendar_year=cal_year)])


if __name__ == "__main__":
    main()
