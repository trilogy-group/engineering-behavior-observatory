// Theme toggle, copy button and the illustrative swimlanes. No dependencies.
(() => {
  const root = document.documentElement;
  const dark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.querySelector(".theme")?.addEventListener("click", () => {
    root.dataset.theme = dark() ? "light" : "dark";
    try { localStorage.setItem("ebo-theme", root.dataset.theme); } catch {}
  });

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); } catch { return; }
      button.textContent = "Copied"; button.classList.add("done");
      setTimeout(() => { button.textContent = "Copy"; button.classList.remove("done"); }, 1600);
    });
  }

  // Illustrative only: a seeded sequence of action categories per trial, drawn like the Atlas swimlanes.
  const host = document.getElementById("lanes");
  if (!host) return;
  const cats = ["inspect", "edit", "read", "check", "shell", "vcs"];
  const weights = [0.34, 0.2, 0.2, 0.12, 0.1, 0.04];
  const trials = [{ name: "trial 1", n: 118, errs: 4 }, { name: "trial 2", n: 142, errs: 2 }, { name: "trial 3", n: 170, errs: 5 }];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = () => { let r = rand(), i = 0; while (r > weights[i] && i < weights.length - 1) r -= weights[i++]; return cats[i]; };
  const max = Math.max(...trials.map((t) => t.n));
  const ns = "http://www.w3.org/2000/svg";
  for (const t of trials) {
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.innerHTML = `<div class="lane-label">${t.name}<small>${t.n} actions</small></div>`;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${max * 4} 40`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    let prev = "";
    for (let i = 0; i < t.n; i++) {
      const c = rand() < 0.45 && prev ? prev : pick();
      prev = c;
      const rect = document.createElementNS(ns, "rect");
      Object.entries({ x: i * 4, y: 6, width: 3, height: 20, rx: 0.6, fill: `var(--cat-${c})` }).forEach(([k, v]) => rect.setAttribute(k, v));
      svg.append(rect);
    }
    for (let e = 0; e < t.errs; e++) {
      const x = Math.floor(rand() * t.n) * 4 + 1.5;
      const mark = document.createElementNS(ns, "text");
      Object.entries({ x, y: 39, "text-anchor": "middle", "font-size": 10, "font-weight": 700, fill: "var(--status-critical)" }).forEach(([k, v]) => mark.setAttribute(k, v));
      mark.textContent = "×";
      svg.append(mark);
    }
    lane.append(svg);
    host.append(lane);
  }
})();
