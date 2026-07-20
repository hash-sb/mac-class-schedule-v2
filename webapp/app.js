(() => {
  "use strict";

  const DATA_DIR = "data";
  const MAX_RENDERED = 400; // cap DOM rows so an all-terms search stays snappy

  const els = {
    eraStrip: document.getElementById("eraStrip"),
    termSelect: document.getElementById("termSelect"),
    searchBox: document.getElementById("searchBox"),
    searchAllToggle: document.getElementById("searchAllToggle"),
    statusLine: document.getElementById("statusLine"),
    results: document.getElementById("results"),
    lastUpdated: document.getElementById("lastUpdated"),
    rowTemplate: document.getElementById("courseRowTemplate"),
  };

  /** @type {{term_code:string, term_label:string, course_count:number, scraped_at:string}[]} */
  let index = [];
  /** term_code -> full payload {..., courses:[...]} */
  const termCache = new Map();
  let currentTermCode = null;

  init();

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
    els.termSelect.addEventListener("change", () => selectTerm(els.termSelect.value));
    els.searchBox.addEventListener("input", debounce(render, 120));
    els.searchAllToggle.addEventListener("change", onToggleSearchAll);

    await selectTerm(index[0].term_code);
  }

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
    render();
  }

  async function ensureTermLoaded(termCode) {
    if (termCache.has(termCode)) return termCache.get(termCode);
    setStatus(`Loading ${labelFor(termCode)}…`);
    const res = await fetch(`${DATA_DIR}/${termCode}.json`);
    const payload = await res.json();
    termCache.set(termCode, payload);
    setStatus("");
    return payload;
  }

  function labelFor(termCode) {
    return index.find((t) => t.term_code === termCode)?.term_label ?? termCode;
  }

  async function onToggleSearchAll(e) {
    if (!e.target.checked) {
      els.results.classList.remove("is-cross-term");
      render();
      return;
    }
    els.results.classList.add("is-cross-term");
    const missing = index.filter((t) => !termCache.has(t.term_code));
    for (let i = 0; i < missing.length; i++) {
      setStatus(`Loading all terms for search… ${i + 1}/${missing.length} (${missing[i].term_label})`);
      await ensureTermLoaded(missing[i].term_code);
    }
    setStatus("");
    render();
  }

  function currentCourses() {
    if (els.searchAllToggle.checked) {
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

  function render() {
    const q = els.searchBox.value.trim().toLowerCase();
    let courses = currentCourses();

    if (q) {
      courses = courses.filter((c) => {
        const haystack = [
          c.subject,
          c.course_number,
          c.section,
          c.crn,
          c.title,
          c.instructor,
          c.subject_name,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    els.results.innerHTML = "";

    if (courses.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = q
        ? `No sections match "${q}".`
        : "This term has no scraped sections yet.";
      els.results.appendChild(empty);
      setStatus("");
      return;
    }

    const truncated = courses.length > MAX_RENDERED;
    const shown = truncated ? courses.slice(0, MAX_RENDERED) : courses;

    // group by subject_name, preserving first-seen order
    const groups = new Map();
    for (const c of shown) {
      const key = c.subject_name || c.subject || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const frag = document.createDocumentFragment();
    for (const [subject, list] of groups) {
      const h = document.createElement("h2");
      h.className = "subject-heading";
      h.textContent = subject;
      frag.appendChild(h);
      for (const c of list) frag.appendChild(buildCourseRow(c));
    }
    els.results.appendChild(frag);

    setStatus(
      truncated
        ? `Showing ${MAX_RENDERED} of ${courses.length} matches — refine your search to see more.`
        : `${courses.length} section${courses.length === 1 ? "" : "s"}.`
    );
  }

  function buildCourseRow(c) {
    const node = els.rowTemplate.content.cloneNode(true);
    const code = `${c.subject} ${c.course_number}-${c.section} (${c.crn})`;
    node.querySelector(".course-code").textContent = code;
    node.querySelector(".course-title").textContent = c.title;
    node.querySelector(".course-meta").textContent = meetingSummary(c);
    node.querySelector(".course-term-tag").textContent = c._term_label;

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

    return node;
  }

  function meetingSummary(c) {
    if (!c.meetings || c.meetings.length === 0) return "TBA";
    return c.meetings.map((m) => [m.days, m.time, m.room].filter(Boolean).join(" ")).join(" / ");
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
})();
