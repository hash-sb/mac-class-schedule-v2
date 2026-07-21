(() => {
  "use strict";

  const DATA_DIR = "data";
  const MAX_RENDERED = 400; // cap DOM rows so an all-terms search stays snappy
  const IDB_NAME = "mac-course-archive";
  const IDB_STORE = "terms";
  const SCHEDULE_KEY = "macCourseArchive.schedule.v1";
  const HINT_DISMISSED_KEY = "macCourseArchive.hintDismissed.v1";
  const DAY_TO_ICS = { M: "MO", T: "TU", W: "WE", R: "TH", F: "FR", S: "SA", U: "SU" };

  const els = {
    eraStrip: document.getElementById("eraStrip"),
    termSelect: document.getElementById("termSelect"),
    searchBox: document.getElementById("searchBox"),
    searchAllToggle: document.getElementById("searchAllToggle"),
    openSeatsToggle: document.getElementById("openSeatsToggle"),
    sortSelect: document.getElementById("sortSelect"),
    shareBtn: document.getElementById("shareBtn"),
    dayChecks: document.getElementById("dayChecks"),
    timeOfDaySelect: document.getElementById("timeOfDaySelect"),
    subjectChipBox: document.getElementById("subjectChipBox"),
    clearSubjectsBtn: document.getElementById("clearSubjectsBtn"),
    statusLine: document.getElementById("statusLine"),
    results: document.getElementById("results"),
    lastUpdated: document.getElementById("lastUpdated"),
    rowTemplate: document.getElementById("courseRowTemplate"),
    changesPanel: document.getElementById("changesPanel"),
    changesToggle: document.getElementById("changesToggle"),
    changesSummary: document.getElementById("changesSummary"),
    changesBody: document.getElementById("changesBody"),
    scheduleFab: document.getElementById("scheduleFab"),
    scheduleFabCount: document.getElementById("scheduleFabCount"),
    scheduleDialog: document.getElementById("scheduleDialog"),
    scheduleCloseBtn: document.getElementById("scheduleCloseBtn"),
    scheduleList: document.getElementById("scheduleList"),
    exportIcsBtn: document.getElementById("exportIcsBtn"),
    exportDialog: document.getElementById("exportDialog"),
    exportCloseBtn: document.getElementById("exportCloseBtn"),
    termStartInput: document.getElementById("termStartInput"),
    termWeeksInput: document.getElementById("termWeeksInput"),
    downloadIcsBtn: document.getElementById("downloadIcsBtn"),
    historyDialog: document.getElementById("historyDialog"),
    historyTitle: document.getElementById("historyTitle"),
    historyStatus: document.getElementById("historyStatus"),
    historyList: document.getElementById("historyList"),
    historyCloseBtn: document.getElementById("historyCloseBtn"),
    hintBanner: document.getElementById("hintBanner"),
    hintDismissBtn: document.getElementById("hintDismissBtn"),
    termFreshness: document.getElementById("termFreshness"),
    activeFilters: document.getElementById("activeFilters"),
    loadProgress: document.getElementById("loadProgress"),
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    scheduleConflicts: document.getElementById("scheduleConflicts"),
  };

  /** @type {{term_code:string, term_label:string, course_count:number, scraped_at:string}[]} */
  let index = [];
  /** term_code -> full payload {..., courses:[...]} */
  const termCache = new Map();
  let currentTermCode = null;
  let selectedDays = new Set();
  let selectedSubjects = new Set();
  let mySchedule = loadSchedule();

  init();

  // ---------------------------------------------------------------------
  // IndexedDB caching, so repeat visits (and "search every term") don't
  // re-download every term's JSON from scratch each time.
  // ---------------------------------------------------------------------

  function openIdb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: "term_code" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // caching is a nice-to-have, never block on it
    });
  }

  async function idbGetTerm(termCode) {
    const db = await openIdb();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(termCode);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function idbPutTerm(termCode, payload) {
    const db = await openIdb();
    if (!db) return;
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ term_code: termCode, scraped_at: payload.scraped_at, payload });
  }

  // ---------------------------------------------------------------------
  // Init / URL state
  // ---------------------------------------------------------------------

  async function init() {
    try {
      const res = await fetch(`${DATA_DIR}/index.json`);
      if (!res.ok) throw new Error(`index.json ${res.status}`);
      const payload = await res.json();
      index = payload.terms.sort((a, b) => (a.term_code < b.term_code ? 1 : -1)); // newest first
      if (payload.generated_at) {
        els.lastUpdated.textContent = `Data last refreshed ${new Date(payload.generated_at).toLocaleString()}.`;
      }
    } catch (err) {
      setStatus("Couldn't load data/index.json yet — run the backfill workflow to populate it.");
      return;
    }

    if (index.length === 0) {
      setStatus("No terms scraped yet — run the backfill workflow to populate the archive.");
      return;
    }

    buildTermSelect();
    buildEraStrip();
    wireControls();
    wireDialogs();
    updateScheduleFabCount();
    maybeShowHint();

    // Restore state from the URL so links and back/forward behave like a real page.
    const url = new URL(location.href);
    const urlTerm = url.searchParams.get("term");
    const urlQ = url.searchParams.get("q");
    const urlAll = url.searchParams.get("all") === "1";
    const urlSeats = url.searchParams.get("seats") === "1";
    const urlSort = url.searchParams.get("sort");
    const urlDays = (url.searchParams.get("days") || "").split(",").filter(Boolean);
    const urlTime = url.searchParams.get("time");
    const urlSubj = (url.searchParams.get("subj") || "").split(",").filter(Boolean);

    if (urlQ) els.searchBox.value = urlQ;
    if (urlSeats) els.openSeatsToggle.checked = true;
    if (urlSort && [...els.sortSelect.options].some((o) => o.value === urlSort)) els.sortSelect.value = urlSort;
    if (urlTime && [...els.timeOfDaySelect.options].some((o) => o.value === urlTime)) els.timeOfDaySelect.value = urlTime;
    urlDays.forEach((d) => selectedDays.add(d));
    syncDayCheckboxes();
    urlSubj.forEach((s) => selectedSubjects.add(s));

    const startTerm = index.some((t) => t.term_code === urlTerm) ? urlTerm : index[0].term_code;
    currentTermCode = startTerm;
    els.termSelect.value = startTerm;
    markActiveEra(startTerm);

    if (urlAll) {
      els.searchAllToggle.checked = true;
      els.results.classList.add("is-cross-term");
      await loadAllTerms();
    } else {
      await ensureTermLoaded(startTerm);
    }

    buildSubjectChips();
    updateTermFreshness();
    loadChangesPanel();
    window.addEventListener("popstate", onPopState);
    render();
  }

  function wireControls() {
    els.termSelect.addEventListener("change", () => selectTerm(els.termSelect.value));
    els.searchBox.addEventListener("input", debounce(() => { render(); updateUrl(); }, 120));
    els.searchAllToggle.addEventListener("change", onToggleSearchAll);
    els.openSeatsToggle.addEventListener("change", () => { render(); updateUrl(); });
    els.sortSelect.addEventListener("change", () => { render(); updateUrl(); });
    els.shareBtn.addEventListener("click", copyShareLink);
    els.timeOfDaySelect.addEventListener("change", () => { render(); updateUrl(); });
    els.dayChecks.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      cb.checked ? selectedDays.add(cb.value) : selectedDays.delete(cb.value);
      render();
      updateUrl();
    });
    els.clearSubjectsBtn.addEventListener("click", () => {
      selectedSubjects.clear();
      buildSubjectChips();
      render();
      updateUrl();
    });
    els.hintDismissBtn.addEventListener("click", () => {
      localStorage.setItem(HINT_DISMISSED_KEY, "1");
      els.hintBanner.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
      e.preventDefault();
      els.searchBox.focus();
    });
  }

  function maybeShowHint() {
    if (localStorage.getItem(HINT_DISMISSED_KEY)) return;
    els.hintBanner.hidden = false;
  }

  function timeAgo(isoString) {
    if (!isoString) return "";
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
    return new Date(isoString).toLocaleDateString();
  }

  function updateTermFreshness() {
    const meta = index.find((t) => t.term_code === currentTermCode);
    els.termFreshness.textContent = meta && meta.scraped_at ? `updated ${timeAgo(meta.scraped_at)}` : "";
  }

  function syncDayCheckboxes() {
    els.dayChecks.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = selectedDays.has(cb.value);
    });
  }

  async function onPopState() {
    const url = new URL(location.href);
    const urlTerm = url.searchParams.get("term");
    const urlQ = url.searchParams.get("q") || "";
    const urlAll = url.searchParams.get("all") === "1";
    const urlSeats = url.searchParams.get("seats") === "1";
    const urlSort = url.searchParams.get("sort") || "default";
    const urlDays = (url.searchParams.get("days") || "").split(",").filter(Boolean);
    const urlTime = url.searchParams.get("time") || "any";
    const urlSubj = (url.searchParams.get("subj") || "").split(",").filter(Boolean);

    els.searchBox.value = urlQ;
    els.openSeatsToggle.checked = urlSeats;
    els.sortSelect.value = [...els.sortSelect.options].some((o) => o.value === urlSort) ? urlSort : "default";
    els.timeOfDaySelect.value = [...els.timeOfDaySelect.options].some((o) => o.value === urlTime) ? urlTime : "any";
    selectedDays = new Set(urlDays);
    syncDayCheckboxes();
    selectedSubjects = new Set(urlSubj);

    if (urlTerm && urlTerm !== currentTermCode) {
      currentTermCode = urlTerm;
      els.termSelect.value = urlTerm;
      markActiveEra(urlTerm);
      await ensureTermLoaded(urlTerm);
      updateTermFreshness();
      loadChangesPanel();
    }
    if (urlAll !== els.searchAllToggle.checked) {
      els.searchAllToggle.checked = urlAll;
      els.results.classList.toggle("is-cross-term", urlAll);
      if (urlAll) await loadAllTerms();
    }
    buildSubjectChips();
    render();
  }

  function updateUrl() {
    const url = new URL(location.href);
    url.searchParams.set("term", currentTermCode);
    const q = els.searchBox.value.trim();
    q ? url.searchParams.set("q", q) : url.searchParams.delete("q");
    els.searchAllToggle.checked ? url.searchParams.set("all", "1") : url.searchParams.delete("all");
    els.openSeatsToggle.checked ? url.searchParams.set("seats", "1") : url.searchParams.delete("seats");
    els.sortSelect.value !== "default" ? url.searchParams.set("sort", els.sortSelect.value) : url.searchParams.delete("sort");
    els.timeOfDaySelect.value !== "any" ? url.searchParams.set("time", els.timeOfDaySelect.value) : url.searchParams.delete("time");
    selectedDays.size ? url.searchParams.set("days", [...selectedDays].join(",")) : url.searchParams.delete("days");
    selectedSubjects.size ? url.searchParams.set("subj", [...selectedSubjects].join(",")) : url.searchParams.delete("subj");
    history.replaceState(null, "", url);
  }

  function copyShareLink() {
    updateUrl();
    navigator.clipboard.writeText(location.href).then(() => {
      els.shareBtn.textContent = "Link copied ✓";
      els.shareBtn.classList.add("is-copied");
      setTimeout(() => {
        els.shareBtn.textContent = "Copy link to this view";
        els.shareBtn.classList.remove("is-copied");
      }, 1800);
    });
  }

  // ---------------------------------------------------------------------
  // Term selection / era strip
  // ---------------------------------------------------------------------

  function buildTermSelect() {
    els.termSelect.innerHTML = index
      .map((t) => `<option value="${t.term_code}">${t.term_label} · ${t.course_count} sections</option>`)
      .join("");
  }

  function buildEraStrip() {
    const years = index.map((t) => Number(t.term_label.split(" ").pop()));
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const byYear = new Map();
    for (const t of index) {
      const y = Number(t.term_label.split(" ").pop());
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(t);
    }
    const seasonPriority = ["Fall", "Spring", "January", "Summer I", "Summer II", "Summer III"];

    const frag = document.createDocumentFragment();
    for (let y = minYear; y <= maxYear; y++) {
      const btn = document.createElement("button");
      btn.className = "era-btn";
      btn.type = "button";
      btn.textContent = y;
      const terms = byYear.get(y);
      if (!terms) {
        btn.classList.add("is-empty");
        btn.disabled = true;
        btn.title = "No scraped terms this year";
      } else {
        terms.sort((a, b) => seasonPriority.indexOf(a.term_label.split(" ")[0]) - seasonPriority.indexOf(b.term_label.split(" ")[0]));
        btn.addEventListener("click", () => selectTerm(terms[0].term_code));
      }
      btn.dataset.year = y;
      frag.appendChild(btn);
    }
    els.eraStrip.appendChild(frag);
  }

  function markActiveEra(termCode) {
    const label = index.find((t) => t.term_code === termCode)?.term_label;
    if (!label) return;
    const year = label.split(" ").pop();
    els.eraStrip.querySelectorAll(".era-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.year === year);
    });
  }

  async function selectTerm(termCode) {
    currentTermCode = termCode;
    els.termSelect.value = termCode;
    markActiveEra(termCode);
    els.searchAllToggle.checked = false;
    els.results.classList.remove("is-cross-term");
    await ensureTermLoaded(termCode);
    selectedSubjects.clear();
    buildSubjectChips();
    updateTermFreshness();
    loadChangesPanel();
    render();
    updateUrl();
  }

  async function ensureTermLoaded(termCode) {
    if (termCache.has(termCode)) return termCache.get(termCode);

    const meta = index.find((t) => t.term_code === termCode);
    const cached = await idbGetTerm(termCode);
    if (cached && meta && cached.scraped_at === meta.scraped_at) {
      termCache.set(termCode, cached.payload);
      return cached.payload;
    }

    setStatus(`Loading ${labelFor(termCode)}…`);
    const res = await fetch(`${DATA_DIR}/${termCode}.json`);
    const payload = await res.json();
    termCache.set(termCode, payload);
    idbPutTerm(termCode, payload); // fire-and-forget
    setStatus("");
    return payload;
  }

  function labelFor(termCode) {
    return index.find((t) => t.term_code === termCode)?.term_label ?? termCode;
  }

  async function loadAllTerms() {
    const missing = index.filter((t) => !termCache.has(t.term_code));
    if (missing.length > 0) {
      els.loadProgress.hidden = false;
      els.loadProgress.max = missing.length;
      els.loadProgress.value = 0;
    }
    for (let i = 0; i < missing.length; i++) {
      setStatus(`Loading all terms for search… ${i + 1}/${missing.length} (${missing[i].term_label})`);
      await ensureTermLoaded(missing[i].term_code);
      els.loadProgress.value = i + 1;
    }
    els.loadProgress.hidden = true;
    setStatus("");
  }

  async function onToggleSearchAll(e) {
    els.results.classList.toggle("is-cross-term", e.target.checked);
    if (e.target.checked) await loadAllTerms();
    selectedSubjects.clear();
    buildSubjectChips();
    render();
    updateUrl();
  }

  // ---------------------------------------------------------------------
  // Subject chip filter
  // ---------------------------------------------------------------------

  function buildSubjectChips() {
    const subjects = new Map(); // code -> name
    for (const c of currentCourses()) {
      if (c.subject) subjects.set(c.subject, c.subject_name || c.subject);
    }
    const sorted = [...subjects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    els.subjectChipBox.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const [code, name] of sorted) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "subject-chip" + (selectedSubjects.has(code) ? " is-selected" : "");
      chip.textContent = code;
      chip.title = name;
      chip.addEventListener("click", () => {
        selectedSubjects.has(code) ? selectedSubjects.delete(code) : selectedSubjects.add(code);
        buildSubjectChips();
        render();
        updateUrl();
      });
      frag.appendChild(chip);
    }
    els.subjectChipBox.appendChild(frag);
  }

  // ---------------------------------------------------------------------
  // Filtering helpers: days / time-of-day
  // ---------------------------------------------------------------------

  function dayLettersOf(daysStr) {
    if (!daysStr || /tba/i.test(daysStr)) return [];
    return [...daysStr.toUpperCase().matchAll(/[MTWRFSU]/g)].map((m) => m[0]);
  }

  function parseTimeRange(timeStr) {
    if (!timeStr) return null;
    const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return null;
    let [, h1, m1, mer1, h2, m2, mer2] = m;
    mer1 = mer1 || mer2;
    mer2 = mer2 || mer1;
    if (!mer1 || !mer2) return null;
    const to24 = (h, mer) => {
      h = parseInt(h, 10) % 12;
      if (/pm/i.test(mer)) h += 12;
      return h;
    };
    return {
      startHour: to24(h1, mer1),
      startMin: parseInt(m1, 10),
      endHour: to24(h2, mer2),
      endMin: parseInt(m2, 10),
    };
  }

  function matchesDayFilter(c) {
    if (selectedDays.size === 0) return true;
    return (c.meetings || []).some((m) => dayLettersOf(m.days).some((d) => selectedDays.has(d)));
  }

  function matchesTimeFilter(c) {
    const mode = els.timeOfDaySelect.value;
    if (mode === "any") return true;
    return (c.meetings || []).some((m) => {
      const t = parseTimeRange(m.time);
      if (!t) return false;
      if (mode === "morning") return t.startHour < 12;
      if (mode === "afternoon") return t.startHour >= 12 && t.startHour < 17;
      if (mode === "evening") return t.startHour >= 17;
      return true;
    });
  }

  function matchesSubjectFilter(c) {
    if (selectedSubjects.size === 0) return true;
    return selectedSubjects.has(c.subject);
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function currentCourses() {
    if (els.searchAllToggle && els.searchAllToggle.checked) {
      const all = [];
      for (const t of index) {
        const payload = termCache.get(t.term_code);
        if (!payload) continue;
        for (const c of payload.courses) all.push({ ...c, _term_label: t.term_label, _term_code: t.term_code });
      }
      return all;
    }
    const payload = termCache.get(currentTermCode);
    return payload ? payload.courses.map((c) => ({ ...c, _term_label: payload.term_label, _term_code: payload.term_code })) : [];
  }

  const DAY_DISPLAY = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat", U: "Sun" };

  function renderActiveFilterChips() {
    const chips = []; // {label, onRemove}

    const q = els.searchBox.value.trim();
    if (q) chips.push({ label: `"${q}"`, onRemove: () => { els.searchBox.value = ""; render(); updateUrl(); } });

    if (els.openSeatsToggle.checked) {
      chips.push({ label: "Open seats only", onRemove: () => { els.openSeatsToggle.checked = false; render(); updateUrl(); } });
    }

    if (selectedDays.size) {
      const label = [...selectedDays].map((d) => DAY_DISPLAY[d] || d).join("/");
      chips.push({
        label,
        onRemove: () => { selectedDays.clear(); syncDayCheckboxes(); render(); updateUrl(); },
      });
    }

    if (els.timeOfDaySelect.value !== "any") {
      const opt = els.timeOfDaySelect.selectedOptions[0];
      chips.push({
        label: opt ? opt.textContent : els.timeOfDaySelect.value,
        onRemove: () => { els.timeOfDaySelect.value = "any"; render(); updateUrl(); },
      });
    }

    if (selectedSubjects.size) {
      chips.push({
        label: [...selectedSubjects].join(", "),
        onRemove: () => { selectedSubjects.clear(); buildSubjectChips(); render(); updateUrl(); },
      });
    }

    if (els.searchAllToggle.checked) {
      chips.push({
        label: "Searching every term",
        onRemove: () => { els.searchAllToggle.checked = false; onToggleSearchAll({ target: els.searchAllToggle }); },
      });
    }

    els.activeFilters.innerHTML = "";
    if (chips.length === 0) {
      els.activeFilters.hidden = true;
      return;
    }
    els.activeFilters.hidden = false;
    const frag = document.createDocumentFragment();
    for (const chip of chips) {
      const el = document.createElement("span");
      el.className = "filter-chip";
      const text = document.createElement("span");
      text.textContent = chip.label;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", `Remove filter: ${chip.label}`);
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", chip.onRemove);
      el.append(text, removeBtn);
      frag.appendChild(el);
    }
    if (chips.length > 1) {
      const clearAll = document.createElement("button");
      clearAll.type = "button";
      clearAll.className = "filter-chip clear-all";
      clearAll.textContent = "Clear all ✕";
      clearAll.addEventListener("click", () => {
        els.searchBox.value = "";
        els.openSeatsToggle.checked = false;
        els.timeOfDaySelect.value = "any";
        selectedDays.clear();
        syncDayCheckboxes();
        selectedSubjects.clear();
        buildSubjectChips();
        render();
        updateUrl();
      });
      frag.appendChild(clearAll);
    }
    els.activeFilters.appendChild(frag);
  }

  function render() {
    renderActiveFilterChips();
    const q = els.searchBox.value.trim().toLowerCase();
    let courses = currentCourses();

    if (q) {
      courses = courses.filter((c) => {
        const haystack = [c.subject, c.course_number, c.section, c.crn, c.title, c.instructor, c.subject_name]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    if (els.openSeatsToggle.checked) {
      courses = courses.filter((c) => {
        const n = parseInt(c.open_seats, 10);
        return Number.isFinite(n) && n > 0;
      });
    }

    courses = courses.filter((c) => matchesDayFilter(c) && matchesTimeFilter(c) && matchesSubjectFilter(c));

    const sortMode = els.sortSelect.value;
    if (sortMode === "seats-desc" || sortMode === "seats-asc") {
      const fallback = sortMode === "seats-desc" ? -Infinity : Infinity;
      const dir = sortMode === "seats-desc" ? -1 : 1;
      courses = [...courses].sort((a, b) => {
        const na = Number.isFinite(parseInt(a.open_seats, 10)) ? parseInt(a.open_seats, 10) : fallback;
        const nb = Number.isFinite(parseInt(b.open_seats, 10)) ? parseInt(b.open_seats, 10) : fallback;
        return (na - nb) * dir;
      });
    } else if (sortMode === "course-number") {
      courses = [...courses].sort((a, b) => {
        if (a.subject !== b.subject) return (a.subject || "").localeCompare(b.subject || "");
        const na = parseInt(a.course_number, 10) || 0;
        const nb = parseInt(b.course_number, 10) || 0;
        if (na !== nb) return na - nb;
        return (a.section || "").localeCompare(b.section || "");
      });
    }

    els.results.innerHTML = "";

    if (courses.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = q ? `No sections match "${q}".` : "No sections match the current filters.";
      els.results.appendChild(empty);
      setStatus("");
      return;
    }

    const truncated = courses.length > MAX_RENDERED;
    const shown = truncated ? courses.slice(0, MAX_RENDERED) : courses;

    const frag = document.createDocumentFragment();
    if (sortMode === "default") {
      const groups = new Map();
      for (const c of shown) {
        const key = c.subject_name || c.subject || "Other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      for (const [subject, list] of groups) {
        const h = document.createElement("h2");
        h.className = "subject-heading";
        h.textContent = subject;
        frag.appendChild(h);
        for (const c of list) frag.appendChild(buildCourseRow(c, q));
      }
    } else {
      for (const c of shown) frag.appendChild(buildCourseRow(c, q));
    }
    els.results.appendChild(frag);

    setStatus(
      truncated
        ? `Showing ${MAX_RENDERED} of ${courses.length} matches — refine your search to see more.`
        : `${courses.length} section${courses.length === 1 ? "" : "s"}.`
    );
  }

  function buildCourseRow(c, q) {
    const node = els.rowTemplate.content.cloneNode(true);
    const code = `${c.subject} ${c.course_number}-${c.section} (${c.crn})`;
    const meta = `${meetingSummary(c)} · ${c.instructor || "TBA"}`;
    node.querySelector(".course-code").innerHTML = highlight(code, q);
    node.querySelector(".course-title").innerHTML = highlight(c.title, q);
    node.querySelector(".course-meta").innerHTML = highlight(meta, q);
    node.querySelector(".course-term-tag").textContent = c._term_label;

    const badge = node.querySelector(".seat-badge");
    const seatInfo = seatStatus(c.open_seats);
    badge.classList.add(seatInfo.cls);
    badge.title = seatInfo.label;

    const detail = node.querySelector(".course-detail");
    const summaryBtn = node.querySelector(".course-summary");
    const toggle = node.querySelector(".course-toggle");
    summaryBtn.addEventListener("click", () => {
      const isHidden = detail.hasAttribute("hidden");
      if (isHidden) {
        detail.removeAttribute("hidden");
        toggle.textContent = "−";
      } else {
        detail.setAttribute("hidden", "");
        toggle.textContent = "＋";
      }
    });

    if (c.description) {
      node.querySelector(".course-description").textContent = c.description;
    } else {
      node.querySelector(".course-description").remove();
    }

    const factsList = [
      ["Instructor", c.instructor || "TBA"],
      ["Open seats", c.open_seats || "—"],
      ["Max enrollment", c.max_enrollment || "—"],
    ];
    if (c.crosslistings && c.crosslistings.length) factsList.push(["Cross-listed with", c.crosslistings.join(", ")]);
    if (c.distribution_requirements) factsList.push(["Distribution", c.distribution_requirements]);
    if (c.gen_ed_requirements) factsList.push(["General education", c.gen_ed_requirements]);

    const dl = node.querySelector(".course-facts");
    for (const [term, def] of factsList) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = def;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    if (c.bookstore_url) {
      const dt = document.createElement("dt");
      dt.textContent = "Course materials";
      const dd = document.createElement("dd");
      const a = document.createElement("a");
      a.href = c.bookstore_url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Bookstore listing ↗";
      dd.appendChild(a);
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    const historyBtn = node.querySelector(".course-history-btn");
    historyBtn.addEventListener("click", () => showCourseHistory(c));

    const instructorBtn = node.querySelector(".course-instructor-btn");
    if (!c.instructor || /tba/i.test(c.instructor)) {
      instructorBtn.remove();
    } else {
      instructorBtn.addEventListener("click", () => showInstructorHistory(c.instructor));
    }

    const addBtn = node.querySelector(".add-schedule-btn");
    const key = scheduleKey(c._term_code, c.crn);
    setAddBtnState(addBtn, isInSchedule(key));
    addBtn.addEventListener("click", () => {
      if (isInSchedule(key)) {
        removeFromSchedule(key);
      } else {
        addToSchedule(c);
      }
      setAddBtnState(addBtn, isInSchedule(key));
    });

    return node;
  }

  function meetingSummary(c) {
    if (!c.meetings || c.meetings.length === 0) return "TBA";
    return c.meetings.map((m) => [m.days, m.time, m.room].filter(Boolean).join(" ")).join(" / ");
  }

  function seatStatus(openSeatsRaw) {
    const n = parseInt(openSeatsRaw, 10);
    if (!Number.isFinite(n)) return { cls: "seat-unknown", label: "Seat count unknown" };
    if (n <= 0) return { cls: "seat-full", label: "Full" };
    if (n <= 3) return { cls: "seat-low", label: `${n} seat${n === 1 ? "" : "s"} left` };
    return { cls: "seat-open", label: `${n} seats open` };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlight(text, query) {
    const safe = escapeHtml(text ?? "");
    if (!query) return safe;
    const re = new RegExp(`(${escapeRegExp(escapeHtml(query))})`, "ig");
    return safe.replace(re, "<mark>$1</mark>");
  }

  function setStatus(msg) {
    els.statusLine.textContent = msg;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ---------------------------------------------------------------------
  // Course / instructor history modal
  // ---------------------------------------------------------------------

  async function showCourseHistory(c) {
    els.historyTitle.textContent = `${c.subject} ${c.course_number} — every offering in the archive`;
    els.historyList.innerHTML = "";
    els.historyStatus.textContent = "Loading every term…";
    els.historyDialog.showModal();

    if (!els.searchAllToggle.checked) await loadAllTerms();

    const matches = [];
    for (const t of index) {
      const payload = termCache.get(t.term_code);
      if (!payload) continue;
      for (const course of payload.courses) {
        if (course.subject === c.subject && course.course_number === c.course_number) {
          matches.push({ ...course, _term_label: t.term_label, _term_code: t.term_code });
        }
      }
    }
    matches.sort((a, b) => (a._term_code < b._term_code ? 1 : -1));
    renderHistoryRows(matches, "This course hasn't appeared in any scraped term.");
  }

  async function showInstructorHistory(instructorName) {
    els.historyTitle.textContent = `Everything ${instructorName} has taught`;
    els.historyList.innerHTML = "";
    els.historyStatus.textContent = "Loading every term…";
    els.historyDialog.showModal();

    if (!els.searchAllToggle.checked) await loadAllTerms();

    const needle = instructorName.trim().toLowerCase();
    const matches = [];
    for (const t of index) {
      const payload = termCache.get(t.term_code);
      if (!payload) continue;
      for (const course of payload.courses) {
        if ((course.instructor || "").trim().toLowerCase() === needle) {
          matches.push({ ...course, _term_label: t.term_label, _term_code: t.term_code });
        }
      }
    }
    matches.sort((a, b) => (a._term_code < b._term_code ? 1 : -1));
    renderHistoryRows(matches, "No other sections found for this instructor.");
  }

  function renderHistoryRows(matches, emptyMsg) {
    els.historyStatus.textContent = matches.length ? `${matches.length} section${matches.length === 1 ? "" : "s"}.` : "";
    els.historyList.innerHTML = "";
    if (matches.length === 0) {
      const p = document.createElement("p");
      p.className = "schedule-empty";
      p.textContent = emptyMsg;
      els.historyList.appendChild(p);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of matches) {
      const row = document.createElement("div");
      row.className = "history-row";
      const term = document.createElement("span");
      term.className = "term";
      term.textContent = m._term_label;
      const mid = document.createElement("span");
      mid.textContent = `${m.subject} ${m.course_number}-${m.section}: ${m.title} (${meetingSummary(m)})`;
      const instr = document.createElement("span");
      instr.className = "instructor";
      instr.textContent = m.instructor || "TBA";
      row.append(term, mid, instr);
      frag.appendChild(row);
    }
    els.historyList.appendChild(frag);
  }

  // ---------------------------------------------------------------------
  // Changes panel (recent seat/section changes for the current term)
  // ---------------------------------------------------------------------

  async function loadChangesPanel() {
    els.changesPanel.hidden = true;
    if (els.searchAllToggle.checked) return;
    try {
      const res = await fetch(`${DATA_DIR}/changes/${currentTermCode}.jsonl`);
      if (!res.ok) return;
      const text = (await res.text()).trim();
      if (!text) return;
      const lines = text.split("\n").filter(Boolean);
      const latest = JSON.parse(lines[lines.length - 1]);
      renderChangesPanel(latest);
    } catch {
      // no change log for this term yet - nothing to show, that's fine
    }
  }

  function renderChangesPanel(entry) {
    const total = entry.added.length + entry.removed.length + entry.seat_changes.length;
    if (total === 0) return;
    els.changesPanel.hidden = false;
    const when = new Date(entry.timestamp).toLocaleString();
    els.changesSummary.textContent = `Recent changes (as of last scrape, ${when}): ${entry.added.length} added, ${entry.removed.length} removed, ${entry.seat_changes.length} seat-count change${entry.seat_changes.length === 1 ? "" : "s"}`;

    els.changesBody.innerHTML = "";
    const section = (title, items, cls) => {
      if (!items.length) return;
      const h3 = document.createElement("h3");
      h3.textContent = title;
      els.changesBody.appendChild(h3);
      const ul = document.createElement("ul");
      for (const item of items) {
        const li = document.createElement("li");
        li.className = cls || "";
        li.textContent = typeof item === "string" ? item : `${item.course}: ${item.before ?? "?"} → ${item.after ?? "?"}`;
        ul.appendChild(li);
      }
      els.changesBody.appendChild(ul);
    };
    section("Newly added sections", entry.added, "added");
    section("Removed sections", entry.removed, "removed");
    section("Seat count changes", entry.seat_changes);
  }

  // ---------------------------------------------------------------------
  // Schedule builder + .ics export
  // ---------------------------------------------------------------------

  function loadSchedule() {
    try {
      return JSON.parse(localStorage.getItem(SCHEDULE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveSchedule() {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(mySchedule));
    updateScheduleFabCount();
  }

  function scheduleKey(termCode, crn) {
    return `${termCode}|${crn}`;
  }

  function isInSchedule(key) {
    return mySchedule.some((s) => scheduleKey(s.term_code, s.crn) === key);
  }

  function addToSchedule(c) {
    const key = scheduleKey(c._term_code, c.crn);
    if (isInSchedule(key)) return;
    mySchedule.push({
      term_code: c._term_code,
      term_label: c._term_label,
      crn: c.crn,
      subject: c.subject,
      course_number: c.course_number,
      section: c.section,
      title: c.title,
      instructor: c.instructor,
      meetings: c.meetings,
    });
    saveSchedule();
  }

  function removeFromSchedule(key) {
    mySchedule = mySchedule.filter((s) => scheduleKey(s.term_code, s.crn) !== key);
    saveSchedule();
    renderScheduleTray();
  }

  function setAddBtnState(btn, added) {
    btn.textContent = added ? "✓ In my schedule (click to remove)" : "+ Add to my schedule";
    btn.classList.toggle("is-added", added);
  }

  function updateScheduleFabCount() {
    els.scheduleFabCount.textContent = mySchedule.length;
  }

  function detectConflicts(schedule) {
    const conflicts = []; // {aKey, bKey, message}
    const conflictKeys = new Set();

    for (let i = 0; i < schedule.length; i++) {
      for (let j = i + 1; j < schedule.length; j++) {
        const a = schedule[i];
        const b = schedule[j];
        for (const ma of a.meetings || []) {
          const daysA = dayLettersOf(ma.days);
          const timeA = parseTimeRange(ma.time);
          if (!daysA.length || !timeA) continue;
          for (const mb of b.meetings || []) {
            const daysB = dayLettersOf(mb.days);
            const timeB = parseTimeRange(mb.time);
            if (!daysB.length || !timeB) continue;
            const sharedDay = daysA.find((d) => daysB.includes(d));
            if (!sharedDay) continue;
            const aStart = timeA.startHour * 60 + timeA.startMin;
            const aEnd = timeA.endHour * 60 + timeA.endMin;
            const bStart = timeB.startHour * 60 + timeB.startMin;
            const bEnd = timeB.endHour * 60 + timeB.endMin;
            if (aStart < bEnd && bStart < aEnd) {
              const aKey = scheduleKey(a.term_code, a.crn);
              const bKey = scheduleKey(b.term_code, b.crn);
              conflictKeys.add(aKey);
              conflictKeys.add(bKey);
              conflicts.push({
                aKey,
                bKey,
                message: `${a.subject} ${a.course_number}-${a.section} overlaps ${b.subject} ${b.course_number}-${b.section} on ${DAY_DISPLAY[sharedDay] || sharedDay} (${ma.time} vs ${mb.time})`,
              });
            }
          }
        }
      }
    }
    return { conflicts, conflictKeys };
  }

  function renderScheduleTray() {
    els.scheduleList.innerHTML = "";
    els.scheduleConflicts.innerHTML = "";
    els.scheduleConflicts.hidden = true;

    if (mySchedule.length === 0) {
      const p = document.createElement("p");
      p.className = "schedule-empty";
      p.textContent = "Nothing added yet — expand a course below and click \u201c+ Add to my schedule.\u201d";
      els.scheduleList.appendChild(p);
      els.exportIcsBtn.disabled = true;
      els.exportCsvBtn.disabled = true;
      return;
    }
    els.exportIcsBtn.disabled = false;
    els.exportCsvBtn.disabled = false;

    const { conflicts, conflictKeys } = detectConflicts(mySchedule);
    if (conflicts.length) {
      els.scheduleConflicts.hidden = false;
      const heading = document.createElement("p");
      heading.innerHTML = `<strong>⚠ ${conflicts.length} time conflict${conflicts.length === 1 ? "" : "s"}:</strong>`;
      els.scheduleConflicts.appendChild(heading);
      for (const c of conflicts) {
        const p = document.createElement("p");
        p.textContent = c.message;
        els.scheduleConflicts.appendChild(p);
      }
    }

    const frag = document.createDocumentFragment();
    for (const s of mySchedule) {
      const key = scheduleKey(s.term_code, s.crn);
      const item = document.createElement("div");
      item.className = "schedule-item" + (conflictKeys.has(key) ? " has-conflict" : "");
      const main = document.createElement("div");
      main.className = "schedule-item-main";
      const codeEl = document.createElement("span");
      codeEl.className = "schedule-item-code";
      codeEl.textContent = `${s.subject} ${s.course_number}-${s.section}: ${s.title}`;
      const metaEl = document.createElement("span");
      metaEl.className = "schedule-item-meta";
      metaEl.textContent = `${s.term_label} · ${meetingSummary(s)} · ${s.instructor || "TBA"}`;
      main.append(codeEl, metaEl);
      const removeBtn = document.createElement("button");
      removeBtn.className = "schedule-item-remove";
      removeBtn.setAttribute("aria-label", "Remove");
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => removeFromSchedule(key));
      item.append(main, removeBtn);
      frag.appendChild(item);
    }
    els.scheduleList.appendChild(frag);
  }

  function wireDialogs() {
    els.scheduleFab.addEventListener("click", () => {
      renderScheduleTray();
      els.scheduleDialog.showModal();
    });
    els.scheduleCloseBtn.addEventListener("click", () => els.scheduleDialog.close());
    els.historyCloseBtn.addEventListener("click", () => els.historyDialog.close());
    els.exportCloseBtn.addEventListener("click", () => els.exportDialog.close());

    els.changesToggle.addEventListener("click", () => {
      els.changesBody.hidden = !els.changesBody.hidden;
      els.changesToggle.querySelector(".course-toggle").textContent = els.changesBody.hidden ? "＋" : "−";
    });

    els.exportIcsBtn.addEventListener("click", () => {
      els.scheduleDialog.close();
      els.exportDialog.showModal();
    });

    els.exportCsvBtn.addEventListener("click", () => {
      downloadFile("my-mac-schedule.csv", "text/csv", buildCsv(mySchedule));
    });

    els.downloadIcsBtn.addEventListener("click", () => {
      const startVal = els.termStartInput.value;
      const weeks = parseInt(els.termWeeksInput.value, 10) || 14;
      if (!startVal) {
        els.termStartInput.focus();
        return;
      }
      const ics = buildIcs(mySchedule, startVal, weeks);
      downloadFile("my-mac-schedule.ics", "text/calendar", ics);
      els.exportDialog.close();
    });

    // clicking the ::backdrop area of a <dialog> should close it
    for (const dlg of [els.scheduleDialog, els.exportDialog, els.historyDialog]) {
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) dlg.close();
      });
    }
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function csvEscape(s) {
    const str = String(s ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function buildCsv(schedule) {
    const header = ["Term", "Subject", "Number", "Section", "CRN", "Title", "Instructor", "Meetings"];
    const rows = schedule.map((s) => [
      s.term_label,
      s.subject,
      s.course_number,
      s.section,
      s.crn,
      s.title,
      s.instructor || "TBA",
      meetingSummary(s),
    ]);
    return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }

  function buildIcs(schedule, startDateStr, weeks) {
    const startDate = new Date(`${startDateStr}T00:00:00`);
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mac Course Archive//EN"];

    for (const s of schedule) {
      (s.meetings || []).forEach((m, mi) => {
        const days = dayLettersOf(m.days);
        const time = parseTimeRange(m.time);
        if (days.length === 0 || !time) return; // TBA / unparseable - can't put on a calendar

        // Find the first date on/after startDate whose weekday is one of `days`.
        const jsDayOf = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };
        const wantedJsDays = days.map((d) => jsDayOf[d]);
        let firstDate = new Date(startDate);
        for (let i = 0; i < 7; i++) {
          if (wantedJsDays.includes(firstDate.getDay())) break;
          firstDate.setDate(firstDate.getDate() + 1);
        }

        const dtStart = new Date(firstDate);
        dtStart.setHours(time.startHour, time.startMin, 0, 0);
        const dtEnd = new Date(firstDate);
        dtEnd.setHours(time.endHour, time.endMin, 0, 0);

        const fmt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
        const byDay = days.map((d) => DAY_TO_ICS[d]).join(",");

        lines.push(
          "BEGIN:VEVENT",
          `UID:${s.term_code}-${s.crn}-${mi}@mac-course-archive`,
          `DTSTART:${fmt(dtStart)}`,
          `DTEND:${fmt(dtEnd)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${byDay};COUNT=${weeks}`,
          `SUMMARY:${icsEscape(`${s.subject} ${s.course_number}-${s.section}: ${s.title}`)}`,
          `LOCATION:${icsEscape(m.room || "")}`,
          `DESCRIPTION:${icsEscape(`${s.instructor || "TBA"} · ${s.term_label}`)}`,
          "END:VEVENT"
        );
      });
    }

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  function icsEscape(s) {
    return String(s).replace(/[\\,;]/g, (ch) => "\\" + ch).replace(/\n/g, "\\n");
  }

  function downloadFile(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
})();
