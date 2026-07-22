"""
Parses the *rendered* HTML of a Macalester class-schedule page
(https://macadmsys.macalester.edu/macssb/customPage/page/classSchedule?term=YYYYTT)
into a list of course-section dicts.

The page is an Angular app - a plain requests.get() will NOT contain the
course data. You must render it first (see scrape_term.py, which uses
Playwright). This module only does the HTML -> JSON parsing and has no
network dependency, so it can be unit-tested against a saved HTML snapshot.
"""
from __future__ import annotations

import re
from bs4 import BeautifulSoup, Tag

CRN_RE = re.compile(r"^\s*([A-Z&]+)\s+(\S+)-(\S+)\s+\((\d+)\)\s*$")


SEATS_NUMBER_RE = re.compile(r"-?\d+")


def _normalize_seats(raw: str) -> str:
    """
    The registrar's raw text for open seats isn't consistent: usually a
    plain number, but sometimes "Closed N" (the N still being the
    meaningful count - e.g. "Closed 1" means 1 open seat, "Closed -1"
    means over-enrolled by 1). Normalize all of that down to a single
    integer string: take the LAST number found in the raw text (handles
    "Closed 1" -> "1", "Closed -1" -> "-1"). Negative numbers are kept
    as-is (they mean the section is over-enrolled by that many seats),
    not clamped to 0 - the sign is meaningful information.
    """
    raw = (raw or "").strip()
    matches = SEATS_NUMBER_RE.findall(raw)
    if not matches:
        return "0"
    n = int(matches[-1])
    return str(n)


def _clean(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip()


def _parse_meetings(col3: Tag) -> list[dict]:
    """A col3 cell can contain one or more meeting patterns separated by <br>."""
    meetings = []
    days_spans = col3.find_all("span", class_="DaysSpan")
    times_spans = col3.find_all("span", class_="TimesSpan")
    rooms_spans = col3.find_all("span", class_="RoomsSpan")
    for d, t, r in zip(days_spans, times_spans, rooms_spans):
        meetings.append(
            {
                "days": _clean(d.get_text()),
                "time": _clean(t.get_text()),
                "room": _clean(r.get_text()),
            }
        )
    return meetings


def _parse_detail_block(detail_div: Tag) -> dict:
    """Parses the hidden '> Details for ...' block (description, distro reqs, etc.)."""
    out = {"description": "", "distribution_requirements": "", "gen_ed_requirements": "", "bookstore_url": ""}
    if detail_div is None:
        return out

    # Description: text directly inside the first <p> that is not inside a RequirementSpan/BookstoreSpan
    first_p = detail_div.find("p", recursive=False)
    if first_p:
        out["description"] = _clean(first_p.get_text())

    req_span = detail_div.find("span", class_="RequirementSpan")
    if req_span:
        labels = req_span.find_all("h3", class_="RequirementLabelSpan")
        texts = req_span.find_all("p", class_="RequirementText")
        for label, text in zip(labels, texts):
            label_txt = _clean(label.get_text()).lower()
            if "distribution" in label_txt:
                out["distribution_requirements"] = _clean(text.get_text())
            elif "general education" in label_txt:
                out["gen_ed_requirements"] = _clean(text.get_text())

    book_span = detail_div.find("span", class_="BookstoreSpan")
    if book_span:
        link = book_span.find("a", class_="BookstoreLink")
        if link and link.get("href"):
            out["bookstore_url"] = link["href"]

    return out


def parse_schedule_html(html: str) -> list[dict]:
    """Main entry point. Returns a list of course-section dicts for one term."""
    soup = BeautifulSoup(html, "lxml")
    courses: list[dict] = []

    # Every subject block is one <span id="pbid-DATA_HTML_TEXT-N" ...> containing
    # an <h2> with the subject name and one or more per-CRN <div class="TableClass"
    # id="TableCRN{crn}">. Detail blocks live in the *separate* sibling series of
    # spans id="pbid-DATA_HTML_TEXT2-N", each containing a <div id="DetailtdCRSE...">.
    # We index all detail divs up front by CRN-independent id, and separately by the
    # nearest preceding CRN table so we can join them reliably by CRN via the id
    # pattern "DetailtdCRSE{SUBJ}{NUM}{SEC}" is NOT unique per CRN when cross-listed,
    # so we instead join by proximity: each DetailLinkCRN{crn} onclick references the
    # exact detail div id it toggles - use that.
    detail_link_to_id = {}
    for link_div in soup.find_all("div", class_="DetailsLinkDiv"):
        onclick = link_div.get("onclick", "")
        m = re.search(r"toggleElement\('([^']+)'\)", onclick)
        if m and link_div.get("id", "").startswith("DetailLinkCRN"):
            crn = link_div["id"].replace("DetailLinkCRN", "")
            detail_link_to_id[crn] = m.group(1)

    detail_divs_by_id = {
        d["id"]: d for d in soup.find_all("div", class_="DetailsLongText") if d.get("id")
    }

    current_subject_code = None
    current_subject_name = None

    # IMPORTANT: the page does NOT nest all of a subject's courses under one
    # container. Angular renders one top-level <span id="pbid-DATA_HTML_TEXT-N">
    # PER COURSE SECTION, in document order. Only the *first* section of each
    # subject also carries that subject's <a id="SUBJ"></a><h2>...</h2> banner
    # inside its span. So we must walk every span in order and carry the
    # "current subject" forward as state, rather than treating h2 as a container.
    spans = soup.find_all("span", id=re.compile(r"^pbid-DATA_HTML_TEXT-\d+$"))

    for span in spans:
        h2 = span.find("h2")
        if h2:
            subj_link = h2.find("a")
            if subj_link:
                current_subject_name = _clean(subj_link.get_text())
            prev_anchor = h2.find_previous_sibling("a")
            if prev_anchor and prev_anchor.get("id"):
                current_subject_code = prev_anchor["id"]

        tbl_div = span.find("div", class_="TableClass", id=re.compile(r"^TableCRN\d+"))
        if tbl_div is None:
            continue  # e.g. a stray "top of page" span with no course table

        crn = tbl_div["id"].replace("TableCRN", "")
        main_row = tbl_div.find("tr", attrs={"data-id": crn})
        if not main_row:
            continue
        tds = main_row.find_all("td", recursive=False)
        if len(tds) < 6:
            continue

        col1_text = _clean(tds[0].get_text())
        m = CRN_RE.match(col1_text)
        if m:
            subj, num, sec, _crn_from_text = m.groups()
        else:
            subj, num, sec = current_subject_code, col1_text, ""

        title = _clean(tds[1].get_text())
        meetings = _parse_meetings(tds[2])
        # Co-instructors are separated only by a bare <br> in the markup
        # (e.g. "Jane Smith<br>John Doe") with no textual delimiter, so a
        # plain get_text() call silently drops the separator and produces
        # "Jane SmithJohn Doe". Replace each <br> with a real delimiter
        # before extracting text so multiple instructors read correctly.
        for br in tds[3].find_all("br"):
            br.replace_with(", ")
        instructor = _clean(tds[3].get_text()).replace("Instructor:", "").strip()
        open_seats = _normalize_seats(_clean(tds[4].get_text()))
        max_enrollment = _clean(tds[5].get_text())

        # crosslistings live in the following SectionText row, if present
        crosslistings: list[str] = []
        next_row = main_row.find_next_sibling("tr")
        if next_row and next_row.find("td", class_="SectionText"):
            p = next_row.find("p", class_="crosslisting")
            if p:
                xl_text = _clean(p.get_text())
                xl_text = re.sub(r"^Cross-listed with\s*", "", xl_text)
                crosslistings = [x.strip() for x in re.split(r",| and ", xl_text) if x.strip()]

        detail_id = detail_link_to_id.get(crn)
        detail = _parse_detail_block(detail_divs_by_id.get(detail_id)) if detail_id else _parse_detail_block(None)

        courses.append(
            {
                "crn": crn,
                "subject": subj or current_subject_code,
                "subject_name": current_subject_name,
                "course_number": num,
                "section": sec,
                "title": title,
                "meetings": meetings,
                "instructor": instructor,
                "open_seats": open_seats,
                "max_enrollment": max_enrollment,
                "crosslistings": crosslistings,
                **detail,
            }
        )

    return courses
