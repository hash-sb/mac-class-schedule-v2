# Mac Course Archive

An unofficial, self-updating archive of Macalester College's public class
schedules (Fall 2008 → the term after next), with a browsable web app hosted
on GitHub Pages.

## How it works

```
scraper/          Python scraper (Playwright + BeautifulSoup)
  parser.py        Pure HTML -> JSON parsing logic (network-free, unit-tested against a real saved page)
  render.py         Loads a term's schedule page in a real headless browser and returns the rendered HTML
  terms.py           Generates Macalester's YYYYTT term codes, Fall 2008 onward
  scheduler.py        Decides whether "now" is a high-frequency (registration/add-drop) window
  registration_windows.json   Known registration/add-drop date ranges, from the registrar's academic calendar
  run.py               Orchestrates: pick terms -> render -> parse -> write data/<code>.json + data/index.json
data/              Generated JSON (one file per term with data, plus index.json). Checked into the repo.
webapp/            Static site (no build step) that reads data/*.json and lets you browse/search
.github/workflows/
  backfill.yml       Manual, one-time: scrapes every term from Fall 2008 to now+1yr
  scrape.yml         Scheduled: keeps recent/near-future terms up to date, more often during registration
  pages.yml          Publishes webapp/ + data/ to GitHub Pages on every push to main
```

### Why a real browser (Playwright) instead of hitting an API directly

The schedule page (`macadmsys.macalester.edu/macssb/customPage/page/classSchedule`)
is an Angular app - the HTML you get from a plain HTTP GET is just the
unpopulated template. The course table is filled in client-side by an
internal XHR call after the page loads. Rather than reverse-engineering that
private Banner API (which could break silently on any Ellucian upgrade),
`render.py` drives a real headless Chromium instance so the site's own
JavaScript does the work, then we just read the finished DOM. `parser.py`
was built and unit-tested against a real saved rendering of the Fall 2026
schedule page (782 sections across 40 subjects, parsed with zero misses) -
see the `sample HTML` you can re-use as a regression fixture if you ever need
to touch the parser.

### Features

- **Browse & search** any term from Fall 2008 onward, or toggle "search every
  term" to search across all of them at once.
- **Filters**: open-seats-only, day-of-week (M/T/W/Th/F, OR logic), time of
  day (morning/afternoon/evening), and department chips — all combinable,
  and all reflected in the URL so a filtered view is a shareable link.
- **Sorting**: by subject (default, grouped view), most/fewest open seats,
  or course number.
- **Course history**: expand any section and click "See every offering of
  this course" to see every term it's been taught, with instructor and
  enrollment for each.
- **Instructor history**: same idea, but "everything this instructor has
  taught" across the whole archive.
- **Schedule builder + calendar export**: add sections to "My schedule"
  (bottom-right), then export as a `.ics` file — you provide the term's
  first day of class and how many weeks it runs (we don't scrape exact term
  date ranges), and it generates weekly recurring calendar events.
- **Recent changes panel**: if a term has been re-scraped and something
  changed (new/removed sections, seat counts shifting during add/drop), a
  banner above the results summarizes what changed since the last scrape.
- **Client-side caching** (IndexedDB): once you've loaded a term, it's
  cached in your browser, so revisiting or using "search every term" again
  doesn't re-download everything.

All of this is plain HTML/CSS/JS with no build step and no external
services beyond the static JSON files - nothing is sent anywhere; "My
schedule" and the term cache live only in your own browser's local storage.

## Data format

`data/index.json`:
```json
{
  "generated_at": "2026-07-20T23:00:00+00:00",
  "terms": [
    { "term_code": "202710", "term_label": "Fall 2026", "course_count": 782, "scraped_at": "..." }
  ]
}
```

`data/202710.json`:
```json
{
  "term_code": "202710",
  "term_label": "Fall 2026",
  "scraped_at": "...",
  "course_count": 782,
  "courses": [
    {
      "crn": "10721",
      "subject": "AMST",
      "subject_name": "American Studies",
      "course_number": "102",
      "section": "01",
      "title": "Reading Plays: Asian and Asian American Playwrights",
      "meetings": [{ "days": "M W F", "time": "10:50 - 11:50 am", "room": "THEATR 101" }],
      "instructor": "Randy Reyes",
      "open_seats": "1",
      "max_enrollment": "14",
      "crosslistings": ["THDA 112-01 (10720)", "ASIA 194-01 (10722)"],
      "description": "...",
      "distribution_requirements": "Fine arts",
      "gen_ed_requirements": "Internationalism or U.S. Identities and Differences, Writing WA",
      "bookstore_url": "https://..."
    }
  ]
}
```

Terms with zero sections found (not offered that year - e.g. most
Summer II/III terms) simply don't get a file and don't appear in
`index.json`. That's expected, not an error.

### Change log (`data/changes/<code>.jsonl`)

Every time `run.py` re-scrapes a term that already had a saved snapshot, it
diffs the new result against the old one by CRN and appends one JSON line
(if anything changed) to `data/changes/<term_code>.jsonl`:

```json
{"timestamp": "2026-09-10T06:00:00+00:00", "added": ["BIOL 210-02 (12345) Genetics"], "removed": [], "seat_changes": [{"course": "BIOL 100-01 (10010) Intro Biology", "before": "3", "after": "0"}]}
```

The web app reads the most recent line for whichever term you're viewing
and shows it as a "recent changes" banner. Each term's log is capped at the
last 200 entries so it doesn't grow forever over years of runs. This file
simply won't exist for a term until it's been scraped at least twice.

## One-time setup

1. **Create the GitHub repo** and push this project to it (`main` branch).
2. **Enable GitHub Pages**: Settings → Pages → Source → "GitHub Actions".
3. **Run the backfill once**: Actions tab → "Backfill all historical
   schedules" → Run workflow. This scrapes every term from Fall 2008 onward
   (~115 terms). A full run with a real browser, paced politely, can take a
   while and GitHub-hosted runners cap a single job at 6 hours — if it times
   out partway, just re-run it (it top-level commits progress) or use the
   `from_year`/`through_year` inputs to split it into chunks, e.g. one run
   for 2008–2015, another for 2016–2026.
4. From then on, `scrape.yml` runs automatically every 6 hours and keeps
   only the current/near-future terms fresh (the ones that can actually
   change), and `pages.yml` republishes the site whenever `data/` or
   `webapp/` changes.

## Adaptive scrape frequency ("set and forget")

`scrape.yml`'s cron fires every 6 hours. Each time it fires, `scheduler.py`
checks `registration_windows.json`:

- **During an early-registration or add/drop window**: it scrapes every
  time (4×/day) since seat counts and offerings churn fast then.
- **Otherwise**: it only actually scrapes on the first UTC firing of the
  day (~daily), to be polite to Macalester's servers and save CI minutes.

**Maintenance**: `registration_windows.json` is pre-filled with dates
published on the [registrar's academic calendar](https://www.macalester.edu/registrar/academic-calendars/)
through Fall 2030. Once a year, when the registrar publishes the next
academic year, add its Add/Drop and Registration date ranges to that file
(a two-minute edit — no code changes needed). If the file ever goes stale,
nothing breaks; the scraper just falls back to its default daily cadence.

## Running locally (for development/debugging)

```bash
cd scraper
pip install -r requirements.txt
playwright install chromium
python run.py --mode single --term 202710   # scrape just one term
python run.py --mode incremental             # scrape the "active" window of terms
python run.py --mode backfill                # scrape everything, Fall 2008 -> now+1yr
```

To preview the web app locally:
```bash
cd webapp
python3 -m http.server 8000
# then open http://localhost:8000 - it fetches ../data via a relative "data/" path,
# so also symlink or copy the data/ folder into webapp/ for local preview, e.g.:
#   cp -r ../data .
```

## Extending

- **Parser regressions**: `scraper/parser.py` has no network dependency, so
  you can test it against any saved rendering: `python -c "from parser import
  parse_schedule_html; print(len(parse_schedule_html(open('page.html').read())))"`.
- **New search facets** (e.g. filter by day-of-week or credit count): the
  data already carries `meetings` as structured `{days, time, room}` objects,
  so this is a `webapp/app.js` change only, no scraper change needed.
