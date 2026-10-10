// EBO site: theme, copy, plate annotations, table labels for narrow screens, the illustrative swimlanes, film chapters.
(() => {
  const root = document.documentElement;
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.querySelector(".theme")?.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("ebo-theme", root.dataset.theme); } catch {}
  });

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); } catch { return; }
      button.textContent = "Copied"; button.dataset.state = "done";
      setTimeout(() => { button.textContent = "Copy"; delete button.dataset.state; }, 1600);
    });
  }

  // Plate annotations: a marker and its key entry highlight each other.
  const keyed = document.querySelectorAll("[data-key]");
  const activate = (key) => keyed.forEach((el) => el.toggleAttribute("data-active", el.dataset.key === key));
  for (const el of keyed) {
    el.addEventListener("pointerenter", () => activate(el.dataset.key));
    el.addEventListener("pointerleave", () => activate(null));
    el.addEventListener("focus", () => activate(el.dataset.key));
    el.addEventListener("blur", () => activate(null));
  }

  // Ruled tables collapse to stacked rows on narrow screens; each cell keeps its column name.
  for (const table of document.querySelectorAll("table.ruled")) {
    const names = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const row of table.querySelectorAll("tbody tr")) [...row.children].forEach((cell, i) => { if (i > 0) cell.dataset.label = names[i]; });
  }

  // Fig. 2, illustrative only: a seeded sequence of action categories per trial, drawn like the Atlas swimlanes.
  const host = document.getElementById("lanes");
  if (host) {
    const cats = ["inspect", "edit", "read", "check", "shell", "vcs"];
    const weights = [0.34, 0.2, 0.2, 0.12, 0.1, 0.04];
    const trials = [{ name: "trial 1", n: 118, errs: 4 }, { name: "trial 2", n: 146, errs: 2 }, { name: "trial 3", n: 172, errs: 5 }];
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const pick = () => { let r = rand(), i = 0; while (r > weights[i] && i < weights.length - 1) r -= weights[i++]; return cats[i]; };
    const max = 175, step = 4, ns = "http://www.w3.org/2000/svg";
    const attrs = (el, a) => { for (const [k, v] of Object.entries(a)) el.setAttribute(k, v); return el; };
    for (const t of trials) {
      const lane = document.createElement("div");
      lane.className = "lane";
      lane.innerHTML = `<div class="lane-label">${t.name}<small>${t.n} actions</small></div>`;
      const svg = attrs(document.createElementNS(ns, "svg"), { viewBox: `0 0 ${max * step} 38`, preserveAspectRatio: "none", "aria-hidden": "true" });
      let prev = "";
      for (let i = 0; i < t.n; i++) {
        const c = prev && rand() < 0.45 ? prev : pick();
        prev = c;
        svg.append(attrs(document.createElementNS(ns, "rect"), { x: i * step, y: 4, width: step - 1, height: 20, fill: `var(--cat-${c})` }));
      }
      for (let e = 0; e < t.errs; e++) {
        const x = Math.floor(rand() * t.n) * step + (step - 1) / 2;
        const mark = attrs(document.createElementNS(ns, "text"), { x, y: 36, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: "var(--status-critical)" });
        mark.textContent = "×";
        svg.append(mark);
      }
      lane.append(svg);
      host.append(lane);
    }
    const axis = document.querySelector(".trace .axis");
    if (axis) {
      for (let v = 0; v <= 150; v += 50) axis.insertAdjacentHTML("beforeend", `<span style="left:${(v / max) * 100}%">${v}</span>`);
      axis.insertAdjacentHTML("beforeend", `<span class="unit">action #</span>`);
    }
  }

  // Film chapters: seek on click, mark the chapter that is playing.
  const film = document.getElementById("film");
  const chapters = [...document.querySelectorAll(".chapters button")];
  if (film && chapters.length) {
    const starts = chapters.map((b) => Number(b.dataset.t));
    const mark = () => {
      const t = film.currentTime;
      let current = 0;
      starts.forEach((s, i) => { if (t >= s) current = i; });
      chapters.forEach((b, i) => b.setAttribute("aria-current", String(i === current && (t > 0 || !film.paused))));
    };
    chapters.forEach((b) => b.addEventListener("click", () => {
      film.currentTime = Number(b.dataset.t);
      film.play().catch(() => {});
      mark();
    }));
    film.addEventListener("timeupdate", mark);
    film.addEventListener("play", mark);
  }
})();
