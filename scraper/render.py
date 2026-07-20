"""
Renders a Macalester class-schedule page with a real (headless) browser and
returns the fully-populated HTML, ready for parser.parse_schedule_html().

Why a real browser: the page is an Angular app. A plain HTTP GET only returns
the unpopulated template - the course table is filled in client-side via an
XHR call after load. Playwright drives a real Chromium instance so Angular's
own JS does that work for us, and we just read the resulting DOM. This is
slower than hitting a REST endpoint directly, but it's robust to internal API
changes and doesn't require reverse-engineering Banner's internal resource
contract.
"""
from __future__ import annotations

import time

from playwright.sync_api import sync_playwright

BASE_URL = "https://macadmsys.macalester.edu/macssb/customPage/page/classSchedule"


def render_term_html(term_code: str, timeout_ms: int = 45_000) -> str:
    """
    Loads the schedule page for `term_code` (e.g. "202710") and returns the
    rendered HTML once the course table has finished populating (or once it's
    clear the term has no offerings).
    """
    url = f"{BASE_URL}?term={term_code}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 "
                    "MacalesterScheduleArchiveBot/1.0 (contact: set via repo README)"
                )
            )
            page.goto(url, timeout=timeout_ms, wait_until="networkidle")

            # The term dropdown auto-applies from the ?term= query param, then
            # Angular fires the classScheduleClasses XHR. Wait for either at
            # least one rendered course row, or a reasonable settle time that
            # lets a "no classes this term" state finish rendering too.
            try:
                page.wait_for_selector(".TableRowClass[data-id]", timeout=15_000)
            except Exception:
                # No sections rendered within the wait window - term is very
                # likely not offered (or offerings are genuinely empty). Give
                # the app a moment more to finish any in-flight XHR, then
                # proceed; run.py treats "0 parsed courses" as "not offered".
                time.sleep(3)

            # Small extra settle so any trailing DOM writes complete.
            page.wait_for_timeout(1000)
            html = page.content()
            return html
        finally:
            browser.close()


if __name__ == "__main__":
    import sys

    code = sys.argv[1] if len(sys.argv) > 1 else "202710"
    print(render_term_html(code)[:2000])
