"""
Shared logic for turning whatever data/<code>.json files exist on disk into
the two derived files the web app reads:

  - index.json          one summary row per term (for the term picker)
  - search-index.json   one compact row per COURSE SECTION across every term
                         (for fast cross-term search, without the web app
                         having to fetch 100+ term files one at a time)

Used by both run.py (after a live scrape) and rebuild_index.py (pure
recovery from disk, no scraping) so the two stay in sync by construction.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

TERM_FILE_RE = re.compile(r"^(\d{6})\.json$")

# Fields kept in the compact search index. Deliberately excludes long text
# (description, distribution/gen-ed requirements, bookstore_url) so the file
# stays small enough to fetch in one request even with 100+ terms of data;
# the web app lazy-loads a term's full file for those fields only when a
# course row is actually expanded.
SEARCH_INDEX_FIELDS = [
    "crn",
    "subject",
    "subject_name",
    "course_number",
    "section",
    "title",
    "meetings",
    "instructor",
    "open_seats",
    "max_enrollment",
]


def iter_term_files(data_dir: Path):
    """Yields (code, payload) for every readable data/<code>.json file."""
    for path in sorted(data_dir.glob("*.json")):
        m = TERM_FILE_RE.match(path.name)
        if not m:
            continue
        try:
            payload = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        yield m.group(1), payload


def build_index_terms(data_dir: Path) -> list[dict]:
    """The list that goes in index.json's "terms" array."""
    terms = []
    for code, payload in iter_term_files(data_dir):
        course_count = payload.get("course_count", len(payload.get("courses", [])))
        if course_count == 0:
            continue
        terms.append(
            {
                "term_code": payload.get("term_code", code),
                "term_label": payload.get("term_label", code),
                "course_count": course_count,
                "scraped_at": payload.get("scraped_at", datetime.now(timezone.utc).isoformat()),
            }
        )
    terms.sort(key=lambda t: t["term_code"])
    return terms


def build_search_index(data_dir: Path) -> list[dict]:
    """The flat, compact, cross-term list that goes in search-index.json."""
    rows = []
    for code, payload in iter_term_files(data_dir):
        term_code = payload.get("term_code", code)
        term_label = payload.get("term_label", code)
        for c in payload.get("courses", []):
            row = {k: c.get(k) for k in SEARCH_INDEX_FIELDS}
            row["term_code"] = term_code
            row["term_label"] = term_label
            rows.append(row)
    return rows


def write_index_json(data_dir: Path) -> int:
    terms = build_index_terms(data_dir)
    (data_dir / "index.json").write_text(
        json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(), "terms": terms}, indent=2)
    )
    return len(terms)


def write_search_index_json(data_dir: Path) -> int:
    rows = build_search_index(data_dir)
    (data_dir / "search-index.json").write_text(
        json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(), "courses": rows}, ensure_ascii=False)
    )
    return len(rows)
