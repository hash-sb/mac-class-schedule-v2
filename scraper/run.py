"""
Orchestrates scraping one or more terms and writing out data/<code>.json,
data/index.json, and data/search-index.json (the last two are always
rebuilt from whatever term files actually exist on disk - see indexing.py -
so they can never drift out of sync with the real data).

Usage:
    python run.py --mode backfill              # every term, Fall 2008 -> now+1yr
    python run.py --mode incremental            # just the "active" window of terms
    python run.py --mode single --term 202710   # one specific term (debugging)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import indexing
from parser import parse_schedule_html
from render import render_term_html
from terms import Term, active_terms, all_terms

DATA_DIR = Path(__file__).parent.parent / "data"
CHANGES_DIR = DATA_DIR / "changes"
REPO_ROOT = Path(__file__).parent.parent
PROBLEMS_FILE = Path(__file__).parent / ".scrape_problems.json"  # ephemeral - never committed (only data/ is)
MIN_DELAY_SECONDS = 2.0
MAX_DELAY_SECONDS = 6.0  # randomized, rather than a fixed pace, to look less like an obvious bot
MAX_ATTEMPTS = 3
MAX_CHANGE_ENTRIES_PER_TERM = 200  # cap so the log doesn't grow forever over years of runs
BIG_DROP_THRESHOLD = 0.5  # flag (but still save) a term whose section count more than halves run-to-run

PROBLEMS: list[dict] = []


def _flag_problem(term: Term, kind: str, message: str) -> None:
    print(f"  {kind.upper()} for {term.code} ({term.label}): {message}", file=sys.stderr)
    PROBLEMS.append({"term": term.code, "label": term.label, "type": kind, "message": message})


def checkpoint_commit(message: str) -> None:
    """
    Commits and pushes data/ right now, so that if this process gets killed
    a moment later (job timeout, manual cancellation, runner eviction), the
    work done so far is still saved - not just written to the runner's
    ephemeral disk. Safe to call often: it's a no-op if there's nothing new
    to commit, and any failure here is logged but never crashes the scrape.
    """
    try:
        subprocess.run(["git", "config", "user.email", "actions@users.noreply.github.com"], cwd=REPO_ROOT, check=False)
        subprocess.run(["git", "config", "user.name", "scrape-checkpoint-bot"], cwd=REPO_ROOT, check=False)
        subprocess.run(["git", "add", "data/"], cwd=REPO_ROOT, check=True)
        result = subprocess.run(["git", "commit", "-m", message], cwd=REPO_ROOT, capture_output=True, text=True)
        if result.returncode != 0:
            return  # most likely "nothing to commit" - not an error
        subprocess.run(["git", "push"], cwd=REPO_ROOT, check=True)
        print(f"  checkpoint committed: {message}", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"  warning: checkpoint commit/push failed (continuing anyway): {e}", file=sys.stderr)


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


def _course_summary(c: dict) -> str:
    return f"{c['subject']} {c['course_number']}-{c['section']} ({c['crn']}) {c['title']}"


def compute_diff(old_courses: list[dict], new_courses: list[dict]) -> dict:
    """Compares two snapshots of the same term by CRN and reports what changed."""
    old_by_crn = {c["crn"]: c for c in old_courses}
    new_by_crn = {c["crn"]: c for c in new_courses}

    added = [_course_summary(c) for crn, c in new_by_crn.items() if crn not in old_by_crn]
    removed = [_course_summary(c) for crn, c in old_by_crn.items() if crn not in new_by_crn]

    seat_changes = []
    for crn, new_c in new_by_crn.items():
        old_c = old_by_crn.get(crn)
        if old_c and old_c.get("open_seats") != new_c.get("open_seats"):
            seat_changes.append(
                {
                    "course": _course_summary(new_c),
                    "before": old_c.get("open_seats"),
                    "after": new_c.get("open_seats"),
                }
            )

    return {"added": added, "removed": removed, "seat_changes": seat_changes}


def append_change_log(term: Term, diff: dict) -> None:
    if not (diff["added"] or diff["removed"] or diff["seat_changes"]):
        return  # nothing changed - don't bloat the log with no-op entries
    CHANGES_DIR.mkdir(parents=True, exist_ok=True)
    path = CHANGES_DIR / f"{term.code}.jsonl"
    entry = {"timestamp": datetime.now(timezone.utc).isoformat(), **diff}

    lines = []
    if path.exists():
        lines = path.read_text().splitlines()
    lines.append(json.dumps(entry, ensure_ascii=False))
    lines = lines[-MAX_CHANGE_ENTRIES_PER_TERM:]
    path.write_text("\n".join(lines) + "\n")


def write_term_file(term: Term, courses: list[dict]) -> dict | None:
    """
    Writes data/<code>.json, EXCEPT when this looks like a failed scrape
    rather than a genuinely-empty term: if we got 0 sections but the existing
    snapshot on disk had sections, we assume something went wrong this run
    (slow render, transient timeout, site hiccup) and leave the old file
    completely untouched rather than clobbering good data with an empty
    result. Returns None in that case so the caller knows not to touch
    index.json for this term either.

    A less extreme drop (still >0 results, but more than BIG_DROP_THRESHOLD
    smaller than before) is still saved - courses genuinely do get cancelled
    - but it's flagged as a problem to review, since a partial render could
    also produce this shape of result.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{term.code}.json"

    old_payload = None
    if path.exists():
        try:
            old_payload = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"  warning: couldn't read previous {term.code}.json: {e}", file=sys.stderr)

    old_count = old_payload.get("course_count", 0) if old_payload else 0

    if len(courses) == 0 and old_count > 0:
        _flag_problem(
            term,
            "zero_result_failure",
            f"got 0 sections but the existing snapshot has {old_count}. Leaving the existing file "
            "and index entry untouched rather than overwriting good data with an empty result.",
        )
        return None

    if old_count >= 10 and len(courses) < old_count * BIG_DROP_THRESHOLD:
        _flag_problem(
            term,
            "big_drop",
            f"section count dropped from {old_count} to {len(courses)} (more than {int(BIG_DROP_THRESHOLD*100)}%) "
            "in one scrape. Saved anyway (courses can legitimately be cancelled), but worth a manual look.",
        )

    if old_payload:
        diff = compute_diff(old_payload.get("courses", []), courses)
        append_change_log(term, diff)

    payload = {
        "term_code": term.code,
        "term_label": term.label,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "course_count": len(courses),
        "courses": courses,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return payload


def run(terms: list[Term], commit_every: int = 0) -> None:
    written = 0
    for i, term in enumerate(terms, 1):
        print(f"[{i}/{len(terms)}] scraping {term.label} ({term.code})...")
        try:
            courses = scrape_one(term)
        except RuntimeError as e:
            print(f"  SKIPPING {term.code}: {e}", file=sys.stderr)
            continue
        payload = write_term_file(term, courses)
        if payload is None:
            continue  # suspected failure - write_term_file already logged + flagged it

        # index.json is always fully rebuilt from whatever's on disk, not
        # incrementally patched - so it can never drift from the real files,
        # even if this run gets interrupted right after this line.
        indexing.write_index_json(DATA_DIR)
        written += 1
        print(f"  -> {payload['course_count']} sections")

        if commit_every and written % commit_every == 0:
            indexing.write_search_index_json(DATA_DIR)  # rebuilt at each checkpoint, not every term (it's the pricier one)
            checkpoint_commit(f"Scrape checkpoint: {written}/{len(terms)} terms ({term.code})")

        time.sleep(random.uniform(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS))

    indexing.write_search_index_json(DATA_DIR)
    if commit_every:
        checkpoint_commit(f"Scrape checkpoint: final ({written} terms written/updated)")
    print(f"Done. {written} terms written/updated.")

    if PROBLEMS:
        PROBLEMS_FILE.write_text(json.dumps(PROBLEMS, indent=2))
        print(f"{len(PROBLEMS)} problem(s) flagged this run - see {PROBLEMS_FILE.name}", file=sys.stderr)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"had_problems={'true' if PROBLEMS else 'false'}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["backfill", "incremental", "single"], default="incremental")
    ap.add_argument("--term", help="term code for --mode single, e.g. 202710")
    ap.add_argument("--through-year", type=int, default=None, help="override end year for backfill")
    ap.add_argument("--from-year", type=int, default=None, help="start year for a chunked backfill")
    ap.add_argument(
        "--commit-every",
        type=int,
        default=0,
        help="commit+push data/ every N terms scraped (0 = don't; the calling workflow commits once at the end instead). "
        "Recommended for long backfill runs so a timeout/cancellation doesn't lose all progress.",
    )
    args = ap.parse_args()

    if args.mode == "backfill":
        run(all_terms(through_calendar_year=args.through_year, from_calendar_year=args.from_year), commit_every=args.commit_every)
    elif args.mode == "incremental":
        run(active_terms(), commit_every=args.commit_every)
    elif args.mode == "single":
        if not args.term:
            ap.error("--mode single requires --term")
        season_by_suffix = {"10": "Fall", "20": "January", "30": "Spring", "40": "Summer I", "50": "Summer II", "60": "Summer III"}
        suffix = args.term[-2:]
        yyyy = int(args.term[:4])
        season = season_by_suffix[suffix]
        cal_year = yyyy - 1 if season == "Fall" else yyyy
        run([Term(code=args.term, season=season, calendar_year=cal_year)], commit_every=args.commit_every)


if __name__ == "__main__":
    main()
