"""
Rebuilds data/index.json AND data/search-index.json from scratch, purely by
reading whatever data/<term_code>.json files already exist on disk. Doesn't
scrape anything.

Use this if the derived files ever get out of sync with the actual data -
e.g. a scrape run was interrupted before it finished, or you're setting up
search-index.json for the first time on a repo that predates it.

Usage:
    python rebuild_index.py
"""
from __future__ import annotations

from pathlib import Path

import indexing

DATA_DIR = Path(__file__).parent.parent / "data"


def main():
    n_terms = indexing.write_index_json(DATA_DIR)
    n_courses = indexing.write_search_index_json(DATA_DIR)
    print(f"Rebuilt index.json with {n_terms} terms and search-index.json with {n_courses} course sections.")


if __name__ == "__main__":
    main()
