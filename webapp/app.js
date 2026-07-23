(() => {
  "use strict";

  const DATA_DIR = "data";
  const MAX_RENDERED = 400; // page size for progressive rendering
  const HARD_RENDER_CEILING = 6000; // absolute cap so an unfiltered cross-term search can't hang the browser
  let renderLimit = MAX_RENDERED;
  let lastRenderSignature = null;
  const IDB_NAME = "mac-course-archive";
  const IDB_STORE = "terms";
  const SCHEDULE_KEY = "macCourseArchive.schedule.v1";
  const HINT_DISMISSED_KEY = "macCourseArchive.hintDismissed.v1";
  const REMEMBER_FILTERS_KEY = "macCourseArchive.rememberFilters.v1";
  const SAVED_FILTERS_KEY = "macCourseArchive.savedFilters.v1";
  const MOBILE_BREAKPOINT = "(max-width: 720px)";
  const DAY_TO_ICS = { M: "MO", T: "TU", W: "WE", R: "TH", F: "FR", S: "SA", U: "SU" };

  const els = {
    eraStrip: document.getElementById("eraStrip"),
    termSelect: document.getElementById("termSelect"),
    searchBox: document.getElementById("searchBox"),
    searchAllToggle: document.getElementById("searchAllToggle"),
    seatsThresholdSelect: document.getElementById("seatsThresholdSelect"),
    mergeCrossListedToggle: document.getElementById("mergeCrossListedToggle"),
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
    themeToggle: document.getElementById("themeToggle"),
    printScheduleBtn: document.getElementById("printScheduleBtn"),
    deptFilter: document.getElementById("deptFilter"),
    deptFilterBtn: document.getElementById("deptFilterBtn"),
    deptFilterPanel: document.getElementById("deptFilterPanel"),
    deptFilterCount: document.getElementById("deptFilterCount"),
    deptFilterScopeLabel: document.getElementById("deptFilterScopeLabel"),
    deptSearchInput: document.getElementById("deptSearchInput"),
    resetFiltersBtn: document.getElementById("resetFiltersBtn"),
    rememberFiltersToggle: document.getElementById("rememberFiltersToggle"),
    filterToolbar: document.getElementById("filterToolbar"),
    mobileFilterTrigger: document.getElementById("mobileFilterTrigger"),
    mobileFilterCount: document.getElementById("mobileFilterCount"),
    mobileFilterDialog: document.getElementById("mobileFilterDialog"),
    mobileFilterCloseBtn: document.getElementById("mobileFilterCloseBtn"),
  };

  const THEME_KEY = "macCourseArchive.theme.v1";

  /** @type {{term_code:string, term_label:string, course_count:number, scraped_at:string}[]} */
  let index = [];
  /** term_code -> full payload {..., courses:[...]} */
  const termCache = new Map();
  let currentTermCode = null;
  let selectedDays = new Set();
  let selectedSubjects = new Set();
  let mySchedule = loadSchedule();
  /** flat, compact array of every course across every term, or null until loaded */
  let searchIndexCache = null;

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
    initTheme();
    // Note: no service worker is registered here. It was retired after
    // repeatedly causing staleness bugs (see sw.js for the full story) -
    // anyone who still has an old version installed gets cleaned up
    // automatically, since browsers keep checking an EXISTING registration
    // for updates on subsequent navigations regardless of whether this page
    // calls register() again. We just don't want to register a fresh one.

    // Restore state from the URL so links and back/forward behave like a real page.
    // Priority for filter values specifically: URL param (if present at all) >
    // remembered filters from a previous visit (if that's turned on) > default.
    const url = new URL(location.href);
    const urlTerm = url.searchParams.get("term");
    const urlQ = url.searchParams.get("q");
    const urlAll = url.searchParams.get("all") === "1";
    const urlSort = url.searchParams.get("sort");
    const urlCrn = url.searchParams.get("crn");

    const rememberEnabled = localStorage.getItem(REMEMBER_FILTERS_KEY) === "1";
    els.rememberFiltersToggle.checked = rememberEnabled;
    let saved = {};
    if (rememberEnabled) {
      try {
        saved = JSON.parse(localStorage.getItem(SAVED_FILTERS_KEY) || "{}");
      } catch {
        saved = {};
      }
    }

    // seats: "seats=N" is the current format; a bare "seats=1" from an older
    // shared link means the same thing as the old boolean "open seats only",
    // and parses identically as a threshold of 1 - no special-casing needed.
    const seatsThreshold = url.searchParams.has("seats")
      ? parseInt(url.searchParams.get("seats"), 10) || 0
      : saved.seats ?? 0;
    els.seatsThresholdSelect.value = String(seatsThreshold);

    const days = url.searchParams.has("days")
      ? url.searchParams.get("days").split(",").filter(Boolean)
      : saved.days ?? [];
    days.forEach((d) => selectedDays.add(d));
    syncDayCheckboxes();

    const timeValue = url.searchParams.has("time") ? url.searchParams.get("time") : saved.time ?? "any";
    if ([...els.timeOfDaySelect.options].some((o) => o.value === timeValue)) els.timeOfDaySelect.value = timeValue;

    const subj = url.searchParams.has("subj")
      ? url.searchParams.get("subj").split(",").filter(Boolean)
      : saved.subj ?? [];
    subj.forEach((s) => selectedSubjects.add(s));

    const mergeCrossListed = url.searchParams.has("merge") ? url.searchParams.get("merge") === "1" : saved.merge ?? false;
    els.mergeCrossListedToggle.checked = mergeCrossListed;

    if (urlQ) els.searchBox.value = urlQ;
    if (urlSort && [...els.sortSelect.options].some((o) => o.value === urlSort)) els.sortSelect.value = urlSort;

    const startTerm = index.some((t) => t.term_code === urlTerm) ? urlTerm : index[0].term_code;
    currentTermCode = startTerm;
    els.termSelect.value = startTerm;
    markActiveEra(startTerm);

    if (urlAll) {
      els.searchAllToggle.checked = true;
      els.results.classList.add("is-cross-term");
      await ensureSearchIndexLoaded();
    } else {
      await ensureTermLoaded(startTerm);
    }
    syncTermSortOptions(urlAll);

    initMobileFilterDialog();

    buildSubjectChips();
    updateTermFreshness();
    loadChangesPanel();
    window.addEventListener("popstate", onPopState);
    render();

    if (urlCrn) {
      // the target row might be past MAX_RENDERED or filtered out - best
      // effort, and we let the person know either way.
      if (!focusCourseByCrn(urlCrn)) {
        setStatus(`Linked course (CRN ${urlCrn}) isn't visible with the current filters.`);
      }
    }
  }

  function wireControls() {
    els.termSelect.addEventListener("change", () => selectTerm(els.termSelect.value));
    els.searchBox.addEventListener("input", debounce(() => { render(); updateUrl(); }, 120));
    els.searchAllToggle.addEventListener("change", onToggleSearchAll);
    els.seatsThresholdSelect.addEventListener("change", () => { render(); updateUrl(); });
    els.mergeCrossListedToggle.addEventListener("change", () => { render(); updateUrl(); });
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
    els.deptFilterBtn.addEventListener("click", () => {
      els.deptFilterPanel.hidden ? openDeptFilterPanel() : closeDeptFilterPanel();
    });
    // Clicks inside the panel (chips, clear button) rebuild the chip DOM
    // synchronously, which would detach the clicked element from the tree
    // before the event finishes bubbling - so rather than checking
    // "contains(e.target)" after that mutation (which would wrongly say
    // "no, that's not inside anymore"), just stop these clicks from ever
    // reaching the document-level outside-click listener at all.
    els.deptFilterPanel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", (e) => {
      if (els.deptFilterPanel.hidden) return;
      if (els.deptFilter.contains(e.target)) return; // click was on the toggle button itself
      closeDeptFilterPanel();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.deptFilterPanel.hidden) closeDeptFilterPanel();
    });
    els.deptSearchInput.addEventListener("input", () => renderSubjectRows(currentSubjectOptions()));
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
    els.themeToggle.addEventListener("click", toggleTheme);
    els.resetFiltersBtn.addEventListener("click", resetAllFilters);
    els.rememberFiltersToggle.addEventListener("change", () => {
      localStorage.setItem(REMEMBER_FILTERS_KEY, els.rememberFiltersToggle.checked ? "1" : "0");
      if (els.rememberFiltersToggle.checked) saveFiltersIfRemembering();
      else localStorage.removeItem(SAVED_FILTERS_KEY);
    });
  }

  function resetAllFilters() {
    els.searchBox.value = "";
    els.seatsThresholdSelect.value = "0";
    els.timeOfDaySelect.value = "any";
    els.sortSelect.value = "default";
    selectedDays.clear();
    syncDayCheckboxes();
    selectedSubjects.clear();
    buildSubjectChips();
    render();
    updateUrl();
  }

  function maybeShowHint() {
    if (localStorage.getItem(HINT_DISMISSED_KEY)) return;
    els.hintBanner.hidden = false;
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const theme = saved || "dark";
    applyTheme(theme);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    els.themeToggle.textContent = theme === "light" ? "🌙" : "☀";
    els.themeToggle.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  }

  /**
   * On narrow screens the filter toolbar doesn't fit comfortably inline, so
   * it's physically moved (not duplicated - one set of DOM nodes, so state
   * and event listeners never fall out of sync) into a dialog opened by a
   * "Filters" button. On wide screens it moves back to its normal inline
   * position. Crossing the breakpoint live (e.g. rotating a tablet) re-homes
   * it immediately via the matchMedia listener.
   */
  function initMobileFilterDialog() {
    const mq = window.matchMedia(MOBILE_BREAKPOINT);
    const inlineAnchor = document.createComment("filter-toolbar-anchor");
    els.filterToolbar.after(inlineAnchor);

    const placeForViewport = (isMobile) => {
      if (isMobile) {
        els.mobileFilterDialog.appendChild(els.filterToolbar);
      } else {
        els.mobileFilterDialog.close();
        inlineAnchor.after(els.filterToolbar);
      }
    };
    placeForViewport(mq.matches);
    mq.addEventListener("change", (e) => placeForViewport(e.matches));

    els.mobileFilterTrigger.addEventListener("click", () => els.mobileFilterDialog.showModal());
    els.mobileFilterCloseBtn.addEventListener("click", () => els.mobileFilterDialog.close());
    els.mobileFilterDialog.addEventListener("click", (e) => {
      if (e.target === els.mobileFilterDialog) els.mobileFilterDialog.close();
    });
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

  function updateDeptFilterCount() {
    els.deptFilterCount.textContent = selectedSubjects.size ? ` ${selectedSubjects.size}` : "";
  }

  function updateMobileFilterCount() {
    let count = 0;
    if ((parseInt(els.seatsThresholdSelect.value, 10) || 0) > 0) count++;
    if (selectedDays.size) count++;
    if (els.timeOfDaySelect.value !== "any") count++;
    if (selectedSubjects.size) count++;
    els.mobileFilterCount.textContent = count ? String(count) : "";
    els.resetFiltersBtn.disabled = count === 0 && !els.searchBox.value.trim();
  }

  function openDeptFilterPanel() {
    els.deptFilterPanel.hidden = false;
    els.deptFilterBtn.setAttribute("aria-expanded", "true");
  }

  function closeDeptFilterPanel() {
    els.deptFilterPanel.hidden = true;
    els.deptFilterBtn.setAttribute("aria-expanded", "false");
  }

  async function onPopState() {
    const url = new URL(location.href);
    const urlTerm = url.searchParams.get("term");
    const urlQ = url.searchParams.get("q") || "";
    const urlAll = url.searchParams.get("all") === "1";
    const urlSeats = url.searchParams.has("seats") ? parseInt(url.searchParams.get("seats"), 10) || 0 : 0;
    const urlSort = url.searchParams.get("sort") || "default";
    const urlDays = (url.searchParams.get("days") || "").split(",").filter(Boolean);
    const urlTime = url.searchParams.get("time") || "any";
    const urlSubj = (url.searchParams.get("subj") || "").split(",").filter(Boolean);
    const urlMerge = url.searchParams.get("merge") === "1";
    const urlCrn = url.searchParams.get("crn");

    els.searchBox.value = urlQ;
    els.seatsThresholdSelect.value = String(urlSeats);
    els.sortSelect.value = [...els.sortSelect.options].some((o) => o.value === urlSort) ? urlSort : "default";
    els.timeOfDaySelect.value = [...els.timeOfDaySelect.options].some((o) => o.value === urlTime) ? urlTime : "any";
    selectedDays = new Set(urlDays);
    syncDayCheckboxes();
    selectedSubjects = new Set(urlSubj);
    els.mergeCrossListedToggle.checked = urlMerge;

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
      if (urlAll) await ensureSearchIndexLoaded();
    }
    syncTermSortOptions(urlAll);
    buildSubjectChips();
    render();
    if (urlCrn) focusCourseByCrn(urlCrn);
  }

  function updateUrl() {
    const url = new URL(location.href);
    url.searchParams.set("term", currentTermCode);
    const q = els.searchBox.value.trim();
    q ? url.searchParams.set("q", q) : url.searchParams.delete("q");
    els.searchAllToggle.checked ? url.searchParams.set("all", "1") : url.searchParams.delete("all");
    const seatsThreshold = parseInt(els.seatsThresholdSelect.value, 10) || 0;
    seatsThreshold > 0 ? url.searchParams.set("seats", String(seatsThreshold)) : url.searchParams.delete("seats");
    els.sortSelect.value !== "default" ? url.searchParams.set("sort", els.sortSelect.value) : url.searchParams.delete("sort");
    els.timeOfDaySelect.value !== "any" ? url.searchParams.set("time", els.timeOfDaySelect.value) : url.searchParams.delete("time");
    selectedDays.size ? url.searchParams.set("days", [...selectedDays].join(",")) : url.searchParams.delete("days");
    selectedSubjects.size ? url.searchParams.set("subj", [...selectedSubjects].join(",")) : url.searchParams.delete("subj");
    els.mergeCrossListedToggle.checked ? url.searchParams.set("merge", "1") : url.searchParams.delete("merge");
    // crn is only ever set by the explicit "copy link to this course" action
    // (see copyCoursePermalink) - any other interaction invalidates it.
    url.searchParams.delete("crn");
    history.replaceState(null, "", url);
    saveFiltersIfRemembering();
  }

  function saveFiltersIfRemembering() {
    if (!els.rememberFiltersToggle.checked) return;
    const seatsThreshold = parseInt(els.seatsThresholdSelect.value, 10) || 0;
    localStorage.setItem(
      SAVED_FILTERS_KEY,
      JSON.stringify({
        seats: seatsThreshold,
        days: [...selectedDays],
        time: els.timeOfDaySelect.value,
        subj: [...selectedSubjects],
        merge: els.mergeCrossListedToggle.checked,
      })
    );
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

  function copyCoursePermalink(btn, c) {
    const url = new URL(location.href);
    url.searchParams.set("term", c._term_code);
    url.searchParams.set("crn", c.crn);
    url.searchParams.delete("all"); // a course permalink means "go look at this one," not cross-term search
    navigator.clipboard.writeText(url.toString()).then(() => {
      const original = btn.textContent;
      btn.textContent = "Link copied ✓";
      setTimeout(() => { btn.textContent = original; }, 1800);
    });
  }

  /** Finds a course row already in the DOM by CRN, expands it, and scrolls it into view. */
  function focusCourseByCrn(crn) {
    const row = [...els.results.querySelectorAll(".course")].find((el) => el.dataset.crn === crn);
    if (!row) return false;
    const summaryBtn = row.querySelector(".course-summary");
    const detail = row.querySelector(".course-detail");
    if (detail.hasAttribute("hidden")) summaryBtn.click();
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
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
    const byYear = new Map();
    for (const t of index) {
      const y = Number(t.term_label.split(" ").pop());
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(t);
    }
    const seasonPriority = ["Fall", "Spring", "January", "Summer I", "Summer II", "Summer III"];
    const years = [...byYear.keys()].sort((a, b) => a - b);

    const frag = document.createDocumentFragment();
    for (const y of years) {
      const terms = byYear.get(y);
      terms.sort((a, b) => seasonPriority.indexOf(a.term_label.split(" ")[0]) - seasonPriority.indexOf(b.term_label.split(" ")[0]));
      const btn = document.createElement("button");
      btn.className = "era-btn";
      btn.type = "button";
      btn.textContent = y;
      btn.dataset.year = y;
      btn.title = terms.map((t) => t.term_label).join(", ");
      btn.addEventListener("click", () => selectTerm(terms[0].term_code));
      frag.appendChild(btn);
    }
    els.eraStrip.appendChild(frag);
  }

  function markActiveEra(termCode) {
    const label = index.find((t) => t.term_code === termCode)?.term_label;
    if (!label) return;
    const year = label.split(" ").pop();
    let activeBtn = null;
    els.eraStrip.querySelectorAll(".era-btn").forEach((b) => {
      const isActive = b.dataset.year === year;
      b.classList.toggle("is-active", isActive);
      if (isActive) activeBtn = b;
    });
    if (activeBtn) activeBtn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
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

  async function ensureSearchIndexLoaded() {
    if (searchIndexCache) return searchIndexCache;
    els.loadProgress.hidden = false;
    els.loadProgress.removeAttribute("max"); // indeterminate - it's one request, not N
    setStatus("Loading the full course index for cross-term search…");
    try {
      const res = await fetch(`${DATA_DIR}/search-index.json`);
      const payload = await res.json();
      searchIndexCache = payload.courses.map((c) => ({ ...c, _term_label: c.term_label, _term_code: c.term_code }));
    } catch {
      searchIndexCache = [];
      setStatus("Couldn't load the cross-term search index.");
    }
    els.loadProgress.hidden = true;
    els.loadProgress.max = 100;
    setStatus("");
    return searchIndexCache;
  }

  function syncTermSortOptions(crossTermActive) {
    document.getElementById("sortTermDesc").hidden = !crossTermActive;
    document.getElementById("sortTermAsc").hidden = !crossTermActive;
    if (!crossTermActive && (els.sortSelect.value === "term-desc" || els.sortSelect.value === "term-asc")) {
      els.sortSelect.value = "default"; // that sort mode no longer makes sense once term is fixed
    }
  }

  async function onToggleSearchAll(e) {
    els.results.classList.toggle("is-cross-term", e.target.checked);
    if (e.target.checked) await ensureSearchIndexLoaded();
    syncTermSortOptions(e.target.checked);
    selectedSubjects.clear();
    buildSubjectChips();
    render();
    updateUrl();
  }

  // ---------------------------------------------------------------------
  // Subject chip filter
  // ---------------------------------------------------------------------

  function currentSubjectOptions() {
    const subjects = new Map(); // code -> {name, count}
    for (const c of currentCourses()) {
      if (!c.subject) continue;
      const entry = subjects.get(c.subject) || { name: c.subject_name || c.subject, count: 0 };
      entry.count++;
      subjects.set(c.subject, entry);
    }
    return [...subjects.entries()]
      .map(([code, { name, count }]) => ({ code, name, count }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  function renderSubjectRows(options) {
    const q = els.deptSearchInput.value.trim().toLowerCase();
    const filtered = q ? options.filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)) : options;

    els.subjectChipBox.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "subject-list-empty";
      empty.textContent = "No departments match.";
      els.subjectChipBox.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const { code, name, count } of filtered) {
      const row = document.createElement("label");
      row.className = "subject-row" + (selectedSubjects.has(code) ? " is-selected" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedSubjects.has(code);
      cb.addEventListener("change", () => {
        selectedSubjects.has(code) ? selectedSubjects.delete(code) : selectedSubjects.add(code);
        renderSubjectRows(options); // refresh selection styling, keep the panel open
        render();
        updateUrl();
      });
      const codeEl = document.createElement("span");
      codeEl.className = "subj-code";
      codeEl.textContent = code;
      const nameEl = document.createElement("span");
      nameEl.className = "subj-name";
      nameEl.textContent = name;
      const countEl = document.createElement("span");
      countEl.className = "subj-count";
      countEl.textContent = count;
      row.append(cb, codeEl, nameEl, countEl);
      frag.appendChild(row);
    }
    els.subjectChipBox.appendChild(frag);
  }

  function buildSubjectChips() {
    els.deptSearchInput.value = "";
    els.deptFilterScopeLabel.textContent = els.searchAllToggle.checked
      ? "Filter by department (all terms)"
      : "Filter by department (this term)";
    renderSubjectRows(currentSubjectOptions());
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
    const [, h1s, m1s, mer1, h2s, m2s, mer2] = m;
    const h1 = parseInt(h1s, 10);
    const min1 = parseInt(m1s, 10);
    const h2 = parseInt(h2s, 10);
    const min2 = parseInt(m2s, 10);

    const to24 = (h, mer) => {
      const hh = h % 12;
      return /pm/i.test(mer) ? hh + 12 : hh;
    };

    // When only ONE meridiem is given (the common case - e.g. "10:50 - 11:50 am"),
    // it's tempting to just copy it to the missing side, but that's wrong for
    // any range that crosses noon (e.g. "10:50 - 1:00 pm" is 10:50 AM - 1:00 PM,
    // NOT 10:50 PM - 1:00 PM). Instead, try every combination of missing
    // meridiems and keep whichever produces a sane same-day interval (end after
    // start, a few hours long at most) - campus classes are never longer than
    // that or overnight, so this reliably picks the right one.
    const candidatesFor = (given) => (given ? [given] : ["am", "pm"]);
    let best = null;
    for (const cand1 of candidatesFor(mer1)) {
      for (const cand2 of candidatesFor(mer2)) {
        const startHour = to24(h1, cand1);
        const endHour = to24(h2, cand2);
        const duration = endHour * 60 + min2 - (startHour * 60 + min1);
        if (duration > 0 && duration <= 8 * 60 && (!best || duration < best.duration)) {
          best = { startHour, startMin: min1, endHour, endMin: min2, duration };
        }
      }
    }
    return best;
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

  /**
   * When "merge cross-listed sections" is on, courses that are cross-listed
   * with each other (the same physical section, offered under multiple
   * department/number combinations) collapse into a single row. We don't
   * need to look anything up elsewhere in the term to do this - each course
   * already carries its own `crosslistings` field listing the other
   * aliases as "SUBJ NUM-SEC (CRN)" strings, which is all we need both to
   * detect the group and to build a combined label for it.
   */
  function crnsFromCrosslistings(crosslistings) {
    const crns = [];
    for (const s of crosslistings || []) {
      const m = s.match(/\((\d+)\)/);
      if (m) crns.push(m[1]);
    }
    return crns;
  }

  function dedupeCrossListed(courses) {
    const seenCrns = new Set();
    const result = [];
    for (const c of courses) {
      if (seenCrns.has(c.crn)) continue; // already folded into an earlier row's merged label
      const linkedCrns = crnsFromCrosslistings(c.crosslistings);
      linkedCrns.forEach((crn) => seenCrns.add(crn));
      seenCrns.add(c.crn);
      const ownDesignation = `${c.subject} ${c.course_number}-${c.section} (${c.crn})`;
      result.push({
        ...c,
        _mergedLabel: linkedCrns.length ? [ownDesignation, ...c.crosslistings].join(" / ") : null,
      });
    }
    return result;
  }

  function queryMatchesCourse(c, q) {
    const haystack = [c.subject, c.course_number, c.section, c.crn, c.title, c.instructor, c.subject_name]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  /**
   * Applies every active filter to `courses`, in one place, so both the real
   * render() and the "what if I removed this filter?" zero-result
   * suggestions (see computeRelaxationSuggestions) share exactly the same
   * logic. Each `skipX` option lets a caller ask "what would match if this
   * one filter weren't applied?" without duplicating the filter logic.
   */
  function applyFilters(courses, opts = {}) {
    const q = els.searchBox.value.trim().toLowerCase();
    let result = courses;
    if (!opts.skipQuery && q) result = result.filter((c) => queryMatchesCourse(c, q));
    if (!opts.skipSeats) {
      const threshold = parseInt(els.seatsThresholdSelect.value, 10) || 0;
      if (threshold > 0) result = result.filter((c) => normalizeSeatCount(c.open_seats) >= threshold);
    }
    if (!opts.skipDays) result = result.filter(matchesDayFilter);
    if (!opts.skipTime) result = result.filter(matchesTimeFilter);
    if (!opts.skipSubjects) result = result.filter(matchesSubjectFilter);
    return result;
  }

  /** When a filter combination yields zero results, suggest which single filter to drop to get some back. */
  function computeRelaxationSuggestions() {
    const base = currentCourses();
    const q = els.searchBox.value.trim();
    const threshold = parseInt(els.seatsThresholdSelect.value, 10) || 0;
    const candidates = [];

    if (q) {
      candidates.push({
        label: `Clear search "${q}"`,
        count: applyFilters(base, { skipQuery: true }).length,
        action: () => { els.searchBox.value = ""; render(); updateUrl(); },
      });
    }
    if (threshold > 0) {
      candidates.push({
        label: "Remove seat filter",
        count: applyFilters(base, { skipSeats: true }).length,
        action: () => { els.seatsThresholdSelect.value = "0"; render(); updateUrl(); },
      });
    }
    if (selectedDays.size) {
      candidates.push({
        label: "Remove day filter",
        count: applyFilters(base, { skipDays: true }).length,
        action: () => { selectedDays.clear(); syncDayCheckboxes(); render(); updateUrl(); },
      });
    }
    if (els.timeOfDaySelect.value !== "any") {
      candidates.push({
        label: "Remove time filter",
        count: applyFilters(base, { skipTime: true }).length,
        action: () => { els.timeOfDaySelect.value = "any"; render(); updateUrl(); },
      });
    }
    if (selectedSubjects.size) {
      candidates.push({
        label: "Remove department filter",
        count: applyFilters(base, { skipSubjects: true }).length,
        action: () => { selectedSubjects.clear(); buildSubjectChips(); render(); updateUrl(); },
      });
    }

    return candidates.filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 2);
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function currentCourses() {
    if (els.searchAllToggle && els.searchAllToggle.checked) {
      return searchIndexCache || [];
    }
    const payload = termCache.get(currentTermCode);
    return payload ? payload.courses.map((c) => ({ ...c, _term_label: payload.term_label, _term_code: payload.term_code })) : [];
  }

  const DAY_DISPLAY = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat", U: "Sun" };

  function renderActiveFilterChips() {
    const chips = []; // {label, onRemove}

    const q = els.searchBox.value.trim();
    if (q) chips.push({ label: `"${q}"`, onRemove: () => { els.searchBox.value = ""; render(); updateUrl(); } });

    const seatsThreshold = parseInt(els.seatsThresholdSelect.value, 10) || 0;
    if (seatsThreshold > 0) {
      chips.push({
        label: `${seatsThreshold}+ seats`,
        onRemove: () => { els.seatsThresholdSelect.value = "0"; render(); updateUrl(); },
      });
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

    if (els.mergeCrossListedToggle.checked) {
      chips.push({
        label: "Merging cross-listed sections",
        onRemove: () => { els.mergeCrossListedToggle.checked = false; render(); updateUrl(); },
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
      clearAll.addEventListener("click", resetAllFilters);
      frag.appendChild(clearAll);
    }
    els.activeFilters.appendChild(frag);
  }

  function currentFilterSignature() {
    return JSON.stringify([
      currentTermCode,
      els.searchAllToggle.checked,
      els.searchBox.value.trim().toLowerCase(),
      els.seatsThresholdSelect.value,
      els.sortSelect.value,
      els.timeOfDaySelect.value,
      [...selectedDays].sort(),
      [...selectedSubjects].sort(),
      els.mergeCrossListedToggle.checked,
    ]);
  }

  function render() {
    renderActiveFilterChips();
    updateDeptFilterCount();
    updateMobileFilterCount();
    const signature = currentFilterSignature();
    if (signature !== lastRenderSignature) {
      renderLimit = MAX_RENDERED; // a real filter/search/term change - start over at the top
      lastRenderSignature = signature;
    }
    let courses = applyFilters(currentCourses());
    const q = els.searchBox.value.trim().toLowerCase();

    const sortMode = els.sortSelect.value;
    if (sortMode === "seats-desc" || sortMode === "seats-asc") {
      const dir = sortMode === "seats-desc" ? -1 : 1;
      courses = [...courses].sort((a, b) => (normalizeSeatCount(a.open_seats) - normalizeSeatCount(b.open_seats)) * dir);
    } else if (sortMode === "course-number") {
      courses = [...courses].sort((a, b) => {
        if (a.subject !== b.subject) return (a.subject || "").localeCompare(b.subject || "");
        const na = parseInt(a.course_number, 10) || 0;
        const nb = parseInt(b.course_number, 10) || 0;
        if (na !== nb) return na - nb;
        return (a.section || "").localeCompare(b.section || "");
      });
    } else if (sortMode === "term-desc" || sortMode === "term-asc") {
      const dir = sortMode === "term-desc" ? -1 : 1;
      courses = [...courses].sort((a, b) => {
        const cmp = a._term_code < b._term_code ? -1 : a._term_code > b._term_code ? 1 : 0;
        return cmp * dir;
      });
    }

    if (els.mergeCrossListedToggle.checked) {
      courses = dedupeCrossListed(courses);
    }

    els.results.innerHTML = "";

    if (courses.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = q ? `No sections match "${q}".` : "No sections match the current filters.";
      els.results.appendChild(empty);

      const suggestions = computeRelaxationSuggestions();
      if (suggestions.length) {
        const box = document.createElement("div");
        box.className = "empty-state-suggestions";
        for (const s of suggestions) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "suggestion-btn";
          btn.textContent = `${s.label} (${s.count} result${s.count === 1 ? "" : "s"})`;
          btn.addEventListener("click", s.action);
          box.appendChild(btn);
        }
        els.results.appendChild(box);
      }
      setStatus("");
      return;
    }

    const truncated = courses.length > renderLimit;
    const shown = truncated ? courses.slice(0, renderLimit) : courses;

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

    if (truncated) {
      const remaining = courses.length - renderLimit;
      const atCeiling = renderLimit >= HARD_RENDER_CEILING;
      const wrap = document.createElement("div");
      wrap.className = "show-more-wrap";
      if (!atCeiling) {
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "primary-btn show-more-btn";
        moreBtn.textContent = `Show ${Math.min(MAX_RENDERED, remaining)} more (${remaining} left)`;
        moreBtn.addEventListener("click", () => {
          renderLimit = Math.min(renderLimit + MAX_RENDERED, HARD_RENDER_CEILING);
          lastRenderSignature = currentFilterSignature(); // this render doesn't count as a "real" filter change
          render();
        });
        wrap.appendChild(moreBtn);
        if (remaining > MAX_RENDERED) {
          const allBtn = document.createElement("button");
          allBtn.type = "button";
          allBtn.className = "link-btn show-all-btn";
          allBtn.textContent = `Show all ${courses.length}`;
          allBtn.addEventListener("click", () => {
            renderLimit = Math.min(courses.length, HARD_RENDER_CEILING);
            lastRenderSignature = currentFilterSignature();
            render();
          });
          wrap.appendChild(allBtn);
        }
      } else {
        const note = document.createElement("p");
        note.className = "show-more-ceiling";
        note.textContent = `Showing the first ${HARD_RENDER_CEILING.toLocaleString()} matches. Narrow your search to see the rest.`;
        wrap.appendChild(note);
      }
      els.results.appendChild(wrap);
    }

    setStatus(
      truncated
        ? `Showing ${Math.min(renderLimit, courses.length).toLocaleString()} of ${courses.length.toLocaleString()} matches.`
        : `${courses.length} section${courses.length === 1 ? "" : "s"}.`
    );
  }

  function buildCourseRow(c, q) {
    const node = els.rowTemplate.content.cloneNode(true);
    const article = node.querySelector(".course");
    article.dataset.crn = c.crn;
    article.dataset.term = c._term_code;

    const code = c._mergedLabel || `${c.subject} ${c.course_number}-${c.section} (${c.crn})`;
    const meta = `${meetingSummary(c)} · ${c.instructor || "TBA"}`;
    node.querySelector(".course-code").innerHTML = highlight(code, q);
    node.querySelector(".course-title").innerHTML = highlight(c.title, q);
    node.querySelector(".course-meta").innerHTML = highlight(meta, q);
    node.querySelector(".course-term-tag").textContent = c._term_label;

    const badge = node.querySelector(".seat-badge");
    const seatInfo = seatStatus(c.open_seats);
    badge.classList.add(seatInfo.cls);
    badge.textContent = seatInfo.short;
    badge.title = seatInfo.label;
    badge.setAttribute("aria-label", seatInfo.label);

    const detail = node.querySelector(".course-detail");
    const descEl = node.querySelector(".course-description");
    const factsEl = node.querySelector(".course-facts");
    renderCourseDescription(descEl, c);
    renderCourseFacts(factsEl, c);

    const summaryBtn = node.querySelector(".course-summary");
    const toggle = node.querySelector(".course-toggle");
    let hydrated = c.description !== undefined; // compact search-index rows omit long text fields
    summaryBtn.addEventListener("click", async () => {
      const isHidden = detail.hasAttribute("hidden");
      if (isHidden) {
        detail.removeAttribute("hidden");
        toggle.textContent = "−";
        if (!hydrated) {
          hydrated = true;
          descEl.textContent = "Loading full details…";
          const full = await hydrateFullCourse(c);
          if (full) {
            Object.assign(c, full);
            renderCourseDescription(descEl, c);
            renderCourseFacts(factsEl, c);
          } else {
            descEl.remove();
          }
        }
      } else {
        detail.setAttribute("hidden", "");
        toggle.textContent = "＋";
      }
    });

    const historyBtn = node.querySelector(".course-history-btn");
    historyBtn.addEventListener("click", () => showCourseHistory(c));

    const instructorBtn = node.querySelector(".course-instructor-btn");
    if (!c.instructor || /tba/i.test(c.instructor)) {
      instructorBtn.remove();
    } else {
      instructorBtn.addEventListener("click", () => showInstructorHistory(c.instructor));
    }

    const trendBtn = node.querySelector(".course-trend-btn");
    const trendBox = node.querySelector(".course-trend");
    trendBtn.addEventListener("click", () => toggleSeatTrend(trendBtn, trendBox, c));

    const permalinkBtn = node.querySelector(".course-permalink-btn");
    permalinkBtn.addEventListener("click", () => copyCoursePermalink(permalinkBtn, c));

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

  function renderCourseDescription(descEl, c) {
    if (c.description) {
      descEl.textContent = c.description;
      descEl.hidden = false;
    } else {
      descEl.hidden = true;
    }
  }

  function renderCourseFacts(dl, c) {
    dl.innerHTML = "";
    const factsList = [
      ["Instructor", c.instructor || "TBA"],
      ["Open seats", String(normalizeSeatCount(c.open_seats))],
      ["Max enrollment", c.max_enrollment || "—"],
    ];
    if (c.crosslistings && c.crosslistings.length) factsList.push(["Cross-listed with", c.crosslistings.join(", ")]);
    if (c.seat_reservations) factsList.push(["Reserved seats", c.seat_reservations]);
    if (c.distribution_requirements) factsList.push(["Distribution", c.distribution_requirements]);
    if (c.gen_ed_requirements) factsList.push(["General education", c.gen_ed_requirements]);

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
  }

  /**
   * Compact search-index rows omit long text fields (description, reqs,
   * bookstore link) to keep cross-term search fast. When someone actually
   * expands such a row, fetch that one term's full file (cached after the
   * first time via IndexedDB) and pull the matching CRN's full record.
   */
  async function hydrateFullCourse(c) {
    try {
      const payload = await ensureTermLoaded(c._term_code);
      return payload.courses.find((course) => course.crn === c.crn) || null;
    } catch {
      return null;
    }
  }

  function meetingSummary(c) {
    if (!c.meetings || c.meetings.length === 0) return "TBA";
    return c.meetings.map((m) => [m.days, m.time, m.room].filter(Boolean).join(" ")).join(" / ");
  }

  /**
   * The registrar's raw open-seats text isn't consistent - usually a plain
   * number, but sometimes "Closed N" (N is still the meaningful count -
   * "Closed 1" means 1 open seat) and sometimes negative when a section is
   * over-enrolled. Extract the LAST number in the raw text and clamp
   * negative results to 0, so every course always shows a clean,
   * consistent, non-negative number - never a raw label or a "?".
   * (parser.py normalizes this at scrape time too, going forward - this
   * mirrors that logic so already-scraped data displays correctly too.)
   */
  function normalizeSeatCount(raw) {
    const s = String(raw ?? "").trim();
    const matches = s.match(/-?\d+/g);
    if (!matches) return 0;
    return parseInt(matches[matches.length - 1], 10);
  }

  function seatStatus(openSeatsRaw) {
    const n = normalizeSeatCount(openSeatsRaw);
    if (n < 0) return { cls: "seat-full", label: `Over-enrolled by ${Math.abs(n)}`, short: String(n) };
    if (n === 0) return { cls: "seat-full", label: "0 seats open", short: "0" };
    if (n <= 3) return { cls: "seat-low", label: `${n} seat${n === 1 ? "" : "s"} left`, short: String(n) };
    return { cls: "seat-open", label: `${n} seats open`, short: String(n) };
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
    els.historyStatus.textContent = "Loading the course index…";
    els.historyDialog.showModal();

    const all = await ensureSearchIndexLoaded();
    const matches = all.filter((course) => course.subject === c.subject && course.course_number === c.course_number);
    matches.sort((a, b) => (a._term_code < b._term_code ? 1 : -1));
    renderHistoryRows(matches, "This course hasn't appeared in any scraped term.");
  }

  async function showInstructorHistory(instructorName) {
    els.historyTitle.textContent = `Everything ${instructorName} has taught`;
    els.historyList.innerHTML = "";
    els.historyStatus.textContent = "Loading the course index…";
    els.historyDialog.showModal();

    const all = await ensureSearchIndexLoaded();
    const needle = instructorName.trim().toLowerCase();
    const matches = all.filter((course) => (course.instructor || "").trim().toLowerCase() === needle);
    matches.sort((a, b) => (a._term_code < b._term_code ? 1 : -1));
    renderHistoryRows(matches, "No other sections found for this instructor.");
  }

  function computeFillInfo(m) {
    const max = parseInt(m.max_enrollment, 10);
    const open = normalizeSeatCount(m.open_seats);
    if (!Number.isFinite(max) || max <= 0) return null;
    const filled = max - open;
    const pct = Math.round((filled / max) * 100);
    return { pct, filled, max, overEnrolled: open < 0 };
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

    // Aggregate fill-rate summary across every offering with usable data -
    // this is the "multi-year enrollment pattern" at a glance: does this
    // course (or this instructor's sections) typically fill up, or usually
    // have room? Based on each term's final snapshot, not a precise
    // registration-week trend (we don't have historical registration
    // calendar dates to align terms against), but still a genuinely useful
    // signal from data we already reliably have.
    const fillInfos = matches.map(computeFillInfo).filter(Boolean);
    if (fillInfos.length > 0) {
      const avgPct = Math.round(fillInfos.reduce((sum, f) => sum + f.pct, 0) / fillInfos.length);
      const summary = document.createElement("p");
      summary.className = "history-summary";
      summary.textContent = `Average fill rate across ${fillInfos.length} offering${fillInfos.length === 1 ? "" : "s"} with enrollment data: ${avgPct}%.`;
      els.historyList.appendChild(summary);
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

      const fill = computeFillInfo(m);
      if (fill) {
        const fillWrap = document.createElement("span");
        fillWrap.className = "history-fill";
        const track = document.createElement("span");
        track.className = "history-fill-track";
        const bar = document.createElement("span");
        bar.className = "history-fill-bar" + (fill.overEnrolled ? " is-over" : "");
        bar.style.width = `${Math.min(100, Math.max(0, fill.pct))}%`;
        track.appendChild(bar);
        const label = document.createElement("span");
        label.className = "history-fill-label";
        label.textContent = fill.overEnrolled ? `${fill.filled}/${fill.max} (over-enrolled)` : `${fill.filled}/${fill.max} (${fill.pct}%)`;
        fillWrap.append(track, label);
        row.appendChild(fillWrap);
      }

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
  // Seat-count trend (built from the same per-term change log)
  // ---------------------------------------------------------------------

  async function toggleSeatTrend(btn, box, c) {
    if (!box.hidden) {
      box.hidden = true;
      btn.textContent = "Show seat trend →";
      return;
    }
    btn.textContent = "Loading trend…";
    try {
      const res = await fetch(`${DATA_DIR}/changes/${c._term_code}.jsonl`);
      if (!res.ok) throw new Error("no change log for this term");
      const text = (await res.text()).trim();
      const lines = text ? text.split("\n").filter(Boolean) : [];
      const prefix = `${c.subject} ${c.course_number}-${c.section} (${c.crn})`;
      const points = [];
      for (const line of lines) {
        const entry = JSON.parse(line);
        for (const sc of entry.seat_changes || []) {
          if (!sc.course.startsWith(prefix)) continue;
          const n = parseInt(sc.after, 10);
          if (Number.isFinite(n)) points.push({ t: entry.timestamp, seats: n });
        }
      }
      box.innerHTML = "";
      if (points.length === 0) {
        box.textContent = "No seat-count history recorded for this section yet.";
      } else {
        box.appendChild(buildSparkline(points));
      }
      box.hidden = false;
      btn.textContent = "Hide seat trend";
    } catch {
      box.hidden = false;
      box.textContent = "No seat-count history available for this section.";
      btn.textContent = "Hide seat trend";
    }
  }

  function buildSparkline(points) {
    const W = 260;
    const H = 48;
    const PAD = 4;
    const seats = points.map((p) => p.seats);
    const min = Math.min(0, ...seats);
    const max = Math.max(1, ...seats);
    const xStep = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
    const y = (v) => H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);
    const coords = points.map((p, i) => [PAD + i * xStep, y(p.seats)]);

    const wrapper = document.createElement("div");
    wrapper.className = "trend-chart";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "trend-svg");

    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", coords.map(([x, y2]) => `${x},${y2}`).join(" "));
    polyline.setAttribute("class", "trend-line");
    svg.appendChild(polyline);

    coords.forEach(([x, y2], i) => {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", y2);
      dot.setAttribute("r", 2.2);
      dot.setAttribute("class", "trend-dot");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${new Date(points[i].t).toLocaleString()}: ${points[i].seats} seat${points[i].seats === 1 ? "" : "s"}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    });

    const caption = document.createElement("p");
    caption.className = "trend-caption";
    caption.textContent = `${points.length} data point${points.length === 1 ? "" : "s"} · range ${min}–${max} seats`;

    wrapper.append(svg, caption);
    return wrapper;
  }



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

    els.printScheduleBtn.addEventListener("click", () => {
      window.print();
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
