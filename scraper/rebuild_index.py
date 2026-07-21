"""
Rebuilds data/index.json from scratch, purely by reading whatever
data/<term_code>.json files already exist on disk. Doesn't scrape anything.

Use this if index.json ever gets out of sync with the actual data files -
e.g. a backfill or scrape run was interrupted before it finished (older
versions of run.py only wrote index.json once, at the very end of a run, so
an interrupted run could leave real per-term files on disk with no matching
index.json entries - this script recovers from that with no re-scraping).

Usage:
    python rebuild_index.py
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TERM_FILE_RE = re.compile(r"^(\d{6})\.json$")


def main():
    terms = []
    skipped = []

    for path in sorted(DATA_DIR.glob("*.json")):
        m = TERM_FILE_RE.match(path.name)
        if not m:
            continue  # not a term file (e.g. this isn't index.json itself, which doesn't match \d{6})
        code = m.group(1)
        try:
            payload = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            skipped.append((path.name, str(e)))
            continue

        course_count = payload.get("course_count", len(payload.get("courses", [])))
        if course_count == 0:
            continue  # not offered / no data - shouldn't be advertised in the index

        terms.append(
            {
                "term_code": payload.get("term_code", code),
                "term_label": payload.get("term_label", code),
                "course_count": course_count,
                "scraped_at": payload.get("scraped_at", datetime.now(timezone.utc).isoformat()),
            }
        )

    terms.sort(key=lambda t: t["term_code"])

    index_path = DATA_DIR / "index.json"
    index_path.write_text(
        json.dumps(
            {"generated_at": datetime.now(timezone.utc).isoformat(), "terms": terms},
            indent=2,
        )
    )

    print(f"Rebuilt index.json with {len(terms)} terms from files on disk.")
    if skipped:
        print(f"Skipped {len(skipped)} unreadable file(s):")
        for name, err in skipped:
            print(f"  {name}: {err}")


if __name__ == "__main__":
    main()
