"""
Decides how "hard" the scraper should work right now.

The GitHub Actions workflow fires on a fixed cron (every few hours). Rather
than trying to encode variable cron schedules (which cron can't really do),
we keep the cron fixed and frequent, and let this module decide - each time
it fires - whether this is a day/time that warrants a real scrape, or one
that should mostly no-op. This gives us the requested behavior ("scrape more
often during early registration and add/drop") from one simple static cron.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "registration_windows.json"


def in_registration_window(today: date | None = None) -> tuple[bool, str | None]:
    today = today or datetime.now(timezone.utc).date()
    windows = json.loads(CONFIG_PATH.read_text())["windows"]
    for w in windows:
        start = date.fromisoformat(w["start"])
        end = date.fromisoformat(w["end"])
        if start <= today <= end:
            return True, w["label"]
    return False, None


def should_run_full_cycle(now_utc: datetime | None = None) -> tuple[bool, str]:
    """
    Returns (should_run, reason). The workflow runs every 6 hours. We want:
      - every firing (4x/day) to actually scrape while a registration/add-drop
        window is open, since seat counts and offerings churn quickly then.
      - roughly once a day otherwise, to avoid hammering the site and burning
        CI minutes for no reason during the ~48 quiet weeks of the year.
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    active, label = in_registration_window(now_utc.date())
    if active:
        return True, f"registration window active: {label}"
    if now_utc.hour < 6:  # only the first cron firing of the UTC day
        return True, "daily baseline run"
    return False, "outside registration window; not the daily baseline slot"


if __name__ == "__main__":
    run, reason = should_run_full_cycle()
    print(reason, file=sys.stderr)
    # GitHub Actions step-output friendly line
    print(f"run={'true' if run else 'false'}")
