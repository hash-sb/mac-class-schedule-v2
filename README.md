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
- **Seat-status badges**: a colored pill on every row showing the actual
  open-seat count (or "Full") at a glance - no hovering or expanding needed,
  since this is the number students care about most.
- **Active-filter chips**: whatever's currently applied (search text, open
  seats, days, time of day, departments, cross-term search) shows as a
  dismissible chip above the results, with a "clear all."
- **Per-term freshness**: the term picker shows when that specific term was
  last scraped, so you can tell whether you're looking at a stale snapshot.
- **Schedule conflict detection**: if two sections you've added overlap in
  time, the schedule tray flags it before you export.
- **CSV export**: alongside the `.ics` calendar export, a plain CSV of your
  added sections for pasting into a doc or spreadsheet.
- **First-visit tip**: a one-time dismissible banner pointing out the
  schedule builder, since it isn't otherwise obvious on first glance.
- **"/" keyboard shortcut** jumps focus to the search box.
- **Fast cross-term search**: instead of fetching 100+ term files one at a
  time, "search every term" fetches a single compact `data/search-index.json`
  (identity/schedule fields only - no long text). Expanding a specific
  section still lazy-loads that one term's full file (cached) for its
  description and other details. Course/instructor history modals also use
  this index, so they're instant rather than requiring every term loaded.
- **Course permalinks**: "Copy link to this course" gives a `?term=&crn=`
  link that auto-expands and scrolls to that exact section on load.
- **Seat-count trend chart**: "Show seat trend" on a section renders a small
  sparkline from that term's change log, if any history has accumulated.
- **Light/dark theme toggle** (sun/moon button, top right), persisted.
- **Installable / offline-capable** (PWA): a manifest + service worker cache
  the app shell so it loads instantly and still works offline after a first
  visit; data files are cached network-first so you get fresh data when
  online and the last-seen data when you don't.
- **Print support**: the schedule tray has a "Print" button that produces a
  clean, chrome-free printout of just your added sections.

All of this is plain HTML/CSS/JS with no build step and no external
services beyond the static JSON files - nothing is sent anywhere; "My
schedule" and the term cache live only in your own browser's local storage.

## Bug fixes (this round)

A batch of real issues found in production, each root-caused rather than
patched over:

- **F5/reload showed stale content** — the service worker's caching strategy
  returned cached content immediately instead of checking the network
  first. Rewritten to network-first everywhere; cache is now purely an
  offline fallback. Cache version bumped so existing installs pick up the
  fix automatically.
- **Open-seat counts were inconsistent** ("Closed 1", negative numbers like
  "-2" for over-enrolled sections) — normalized in both `parser.py` (future
  scrapes) and `app.js` (so already-scraped data displays correctly right
  now): the trailing number is extracted ("Closed 1" → 1, "Closed -1" → -1).
  Negative numbers are preserved as-is (they mean over-enrolled by that many
  seats - real, useful information), not clamped to 0. Seat badges, sorting,
  and the "open seats only" filter all use this consistently now - no more
  "?" or word-based labels.
- **A course spanning noon was misclassified as "evening"** (e.g. a
  10:50am-1:00pm class) — the time parser was blindly copying a single
  trailing "pm" to both the start and end time. Replaced with logic that
  tries every valid AM/PM combination and keeps whichever produces a sane,
  same-day class length.
- **Multiple instructors ran together with no separator** (e.g. "Arjun
  GuneratneTom Robertson") — co-instructors are separated in the source
  markup by a bare `<br>` with no text between them, which a plain
  `get_text()` call silently drops. Fixed by replacing each `<br>` with a
  real delimiter before extracting text.
- **The tip banner wouldn't close, and the active-filter chip row had the
  same latent bug** — both elements declared `display: flex` unconditionally
  in CSS, which overrides the browser's built-in `hidden` attribute
  regardless of specificity. Fixed with a defensive `[hidden] { display:
  none !important; }` rule.
- **Cross-term search silently capped at 400 results** with no way to see
  more — replaced with progressive "Show more" / "Show all" controls (capped
  at 6,000 as an absolute safety ceiling so an unfiltered search can't hang
  the browser).
- **Filters reorganized**: one unified toolbar of consistent-height pill
  controls instead of several stacked rows behind a disclosure; departments
  are now a proper popover instead of an always-expanded scroll box.
- **Year strip only shows years that actually have data** (no more disabled
  placeholder buttons for gaps), and the current year auto-scrolls into view.

## Filter section improvements (this round)

- **Seat-count threshold** replaces the old on/off "open seats only" toggle -
  choose Any / 1+ / 3+ / 5+. Old shared links using the previous boolean
  `seats=1` format still work identically (it parses as threshold=1).
- **Zero-result recovery**: when a filter combination matches nothing, the
  app suggests which single filter to drop and how many results you'd get
  back, ranked by how much it would help - e.g. "Remove day filter (12
  results)".
- **Department picker**: now a searchable list instead of a scrolling chip
  grid - shows full department names and a live section count per
  department (not just the code), and a text box to jump straight to one
  among 40+ subjects instead of scrolling. The panel header also says
  whether you're filtering "this term" or "all terms" depending on whether
  cross-term search is on.
- **Mobile filter sheet**: below 720px wide, the filter toolbar moves (not
  duplicates - same DOM nodes, so nothing can fall out of sync) into a
  dialog opened by a "Filters" button showing how many are active. Rotating
  a device or resizing across the breakpoint live re-homes it immediately.
- **"Remember these filters next time"** (opt-in, off by default): when
  checked, your day/time/department/seat-threshold picks are saved locally
  and restored on your next visit - unless a shared link's URL explicitly
  specifies its own filters, which always takes priority.
- **Always-visible "Reset filters"** button in the toolbar (previously the
  clear-all only appeared once 2+ filters were already active in the chip
  row below results).

## Data-safety guarantee

`run.py` never lets a bad scrape destroy good data. If a term already has a
saved snapshot with sections in it, and a later scrape of that same term
comes back with **zero** sections, that's treated as a suspected failure
(slow render, timeout, transient site hiccup) rather than "this term
suddenly has no classes" — the existing file and its `index.json` entry are
left completely untouched, and a `SUSPECTED SCRAPE FAILURE` warning is
printed to the workflow log instead. A term only gets marked "not offered"
the first time it's ever scraped and comes back empty (which is the normal,
expected case for most Summer II/III terms).

`index.json` is also updated after **every single term**, not just once at
the end of a run, and long backfill runs checkpoint-commit their own
progress every 5 terms (`--commit-every 5`, wired up in `backfill.yml`). So
even if a run gets cancelled or times out partway through, everything
scraped up to that point is already saved and listed - nothing is lost just
because the run didn't finish.

**If you ever see fewer terms in the web app than `data/*.json` files that
actually exist** (this could only happen from a run made before this fix
existed), no re-scraping is needed - run **Actions → "Rebuild index from
existing data" → Run workflow**. It regenerates `index.json` purely by
reading whatever term files are already on disk.

### Other reliability features

- **Randomized pacing**: delays between term requests are jittered (2-6s),
  not a fixed interval, to look less like an obvious bot.
- **Big-drop detection**: if a term's section count drops by more than half
  in one scrape (but doesn't hit zero), it's still saved - courses do get
  legitimately cancelled - but flagged as a `big_drop` problem for review.
- **Automatic issue on scrape problems**: if any `zero_result_failure` or
  `big_drop` is flagged during a scheduled scrape or backfill run, a GitHub
  Issue is opened automatically (labeled `scrape-problem`) summarizing what
  happened and linking to the run.
- **Calendar staleness reminder**: a monthly workflow
  (`check-calendar-staleness.yml`) checks whether
  `registration_windows.json` is running low on future entries and opens a
  reminder issue (labeled `calendar-maintenance`) if so, rather than the
  scraper silently reverting to its default daily-only cadence with nobody
  noticing.

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

### `data/search-index.json`

A single compact file covering every course section across every term -
just the identity/scheduling fields (subject, number, section, CRN, title,
meetings, instructor, seats), not the long text fields (description,
requirements, bookstore link). This is what powers "search every term" and
the course/instructor history modals without the web app having to fetch
100+ separate term files. It's rebuilt from scratch (via `indexing.py`,
shared by `run.py` and `rebuild_index.py`) every time either of those runs,
so it can't drift out of sync with the real per-term files.

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
