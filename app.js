/* League HQ — renders every page from window.LEAGUE (league-data.js).
   No build step, no dependencies. Hash routing: #home, #teams, etc. */
(function () {
  const L = window.LEAGUE;
  const view = document.getElementById("view");
  let timer = null;

  // Escape plain-text fields. Announcement bodies are intentionally raw HTML.
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (name) => name.split(/\s+/).filter(w => !/^the$/i.test(w))
    .slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined,
    { month: "short", day: "numeric", year: "numeric" });

  // Team lookups + standings helpers
  const teamById = (id) => L.teams.find(t => t.id === id);
  const rows = (L.standings && L.standings.rows) || [];
  const rec = (id) => { const r = rows.find(x => x[0] === id); return r && { w: r[1], l: r[2], t: r[3], pf: r[4], pa: r[5] }; };
  const standOrder = (id) => { const i = rows.findIndex(x => x[0] === id); return i < 0 ? 99 : i; };
  const logoHtml = (t, cls = "logo") => t.logo
    ? `<img class="${cls}" src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${esc(initials(t.name))}</div>'">`
    : `<div class="${cls}">${esc(initials(t.name))}</div>`;
  const divName = (id) => ((L.divisions || []).find(d => d.id === id) || {}).name || "";

  function standingsTable() {
    if (!rows.length) return "";
    const body = rows.map((r, i) => {
      const t = teamById(r[0]) || { name: r[0] };
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td><div class="st-team">${logoHtml(t, "logo sm")}<span>${esc(t.name)}</span></div></td>
        <td class="muted hide-sm">${esc(divName(t.division))}</td>
        <td class="num"><b>${r[1]}-${r[2]}${r[3] ? "-" + r[3] : ""}</b></td>
        <td class="num">${Number(r[4]).toFixed(1)}</td>
        <td class="num hide-sm">${Number(r[5]).toFixed(1)}</td>
      </tr>`;
    }).join("");
    return `<section><h2>Standings</h2>
      <div class="card table-wrap"><table class="standings">
        <thead><tr><th>#</th><th>Team</th><th class="hide-sm">Div</th><th class="num">W-L</th><th class="num">PF</th><th class="num hide-sm">PA</th></tr></thead>
        <tbody>${body}</tbody></table>
        <p class="muted small">As of ${fmtDate(L.standings.asOf)}</p>
      </div></section>`;
  }

  // ---- Shell ----------------------------------------------------------
  document.title = L.name;
  document.getElementById("brandBadge").textContent = L.shortName;
  document.getElementById("brandSub").textContent = `${L.season} · ${L.format}`;
  document.getElementById("footText").textContent =
    `${L.name}${L.established ? " · Est. " + L.established : ""}`;

  const nav = document.getElementById("nav");
  const toggle = document.querySelector(".nav-toggle");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);
  });

  // ---- Pages ----------------------------------------------------------
  // Schedule helpers. Default week = first week not yet played.
  const sched = L.schedule || { weeks: [] };
  const played = (g) => g[1] != null && g[3] != null;
  const currentWeek = () => (sched.weeks.find(w => !w.games.length || !w.games.every(played)) || sched.weeks[sched.weeks.length - 1] || {}).week;
  let schedWeek = null;

  function gameCard(g) {
    const [aId, aPts, hId, hPts] = g;
    const a = teamById(aId) || { name: aId }, h = teamById(hId) || { name: hId };
    const done = played(g);
    const side = (t, pts, opp) => `
      <div class="g-side${done && pts > opp ? " win" : ""}">
        ${logoHtml(t, "logo sm")}<span class="g-name">${esc(t.name)}</span>
        <span class="g-pts">${done ? Number(pts).toFixed(1) : "–"}</span>
      </div>`;
    const divGame = a.division && a.division === h.division;
    return `<div class="card game">
      ${side(a, aPts, hPts)}${side(h, hPts, aPts)}
      <div class="g-meta muted">${done ? "Final" : "Upcoming"}${divGame ? ` · ${esc(divName(a.division))} division game` : ""}</div>
    </div>`;
  }

  const pages = {
    schedule() {
      if (!sched.weeks.length) return `<section><h2>Schedule</h2><p class="muted">No schedule yet.</p></section>`;
      const cur = currentWeek();
      const wk = schedWeek ?? cur;
      const w = sched.weeks.find(x => x.week === wk) || sched.weeks[0];
      const isPlayoff = w.week > (sched.regularSeasonWeeks || 99);
      const chips = sched.weeks.map(x => `<button class="wk${x.week === w.week ? " active" : ""}${x.week === cur ? " now" : ""}" data-week="${x.week}">${x.week}</button>`).join("");
      const body = w.games.length
        ? `<div class="grid games">${w.games.map(gameCard).join("")}</div>`
        : `<div class="card muted">${isPlayoff ? "Playoffs. Matchups are set after week " + esc(sched.regularSeasonWeeks) + "." : "No games this week."}</div>`;
      return `<section>
          <h2>Schedule</h2>
          <div class="weeks" role="tablist" aria-label="Week">${chips}</div>
          <h3 class="wk-title">Week ${esc(w.week)}${isPlayoff ? " · Playoffs" : ""}${w.week === cur ? ` <span class="tag">This week</span>` : ""}</h3>
          ${body}
          <p class="muted small">Schedule as of ${fmtDate(sched.asOf)}</p>
        </section>`;
    },

    home() {
      const posts = L.announcements.map(a => `
        <article class="card">
          <div class="post-meta"><span class="tag">${esc(a.tag || "News")}</span>${fmtDate(a.date)}</div>
          <h3>${esc(a.title)}</h3>
          <div class="post-body">${a.body}</div>
          ${a.image ? `<img class="post-img" src="${esc(a.image)}" alt="">` : ""}
        </article>`).join("");
      return `
        <div class="hero">
          <div class="hero-title">
            <div class="eyebrow">${esc(L.season)} Season · ${esc(L.format)}${L.established ? " · Since " + esc(L.established) : ""}</div>
            <h1>${esc(L.name)}</h1>
            <p class="muted">Lineups, schedule, standings, history and rules for the B5 FFL.</p>
            <div class="quick">
              <a class="btn" href="#myteam">My Team</a>
              <a class="btn ghost" href="#schedule">Schedule</a>
              <a class="btn ghost" href="#rules">Rules</a>
            </div>
          </div>
          <div class="scoreboard">
            <div class="label">Countdown · ${esc(L.nextEvent.label)}</div>
            <div class="clock" id="clock"></div>
          </div>
        </div>
        <div class="home-cols">
          <section><h2>Announcements</h2><div class="feed">${posts}</div></section>
          ${standingsTable()}
        </div>`;
    },

    teams() {
      const rosters = (L.rosters && L.rosters.teams) || {};
      const acq = (d) => /^Waiv/.test(d) ? d.replace("Waiv", "Waivers") : d ? "Pick " + d : "";
      const rosterHtml = (id) => {
        const ps = rosters[id];
        if (!ps || !ps.length) return "";
        return `<details class="roster">
          <summary>Roster (${ps.length})</summary>
          <ul>${ps.map(([name, pos, nfl, how]) => `
            <li><span class="pos pos-${esc(pos)}">${esc(pos)}</span>
              <span class="pname">${esc(name)}</span>
              <span class="muted nfl" title="${esc(acq(how))}">${esc(nfl)}</span></li>`).join("")}
          </ul></details>`;
      };
      const card = t => {
        const r = rec(t.id);
        return `
        <div class="card team-card">
          <div class="team">
            ${logoHtml(t)}
            <div>
              <h3>${esc(t.name)}</h3>
              <div class="muted">${esc(t.manager)}${r ? ` · ${r.w}-${r.l}${r.t ? "-" + r.t : ""}` : ""}</div>
              ${t.titles ? `<div class="rings" title="${t.titles} title(s)">${"🏆".repeat(t.titles)}</div>` : ""}
            </div>
          </div>
          ${rosterHtml(t.id)}
        </div>`;
      };
      const divs = (L.divisions && L.divisions.length) ? L.divisions : [{ id: null, name: "The " + L.teams.length }];
      return divs.map(d => {
        const ts = L.teams.filter(t => d.id === null || t.division === d.id)
          .sort((a, b) => standOrder(a.id) - standOrder(b.id));
        return `<section><h2>${esc(d.id === null ? d.name : d.name + " Division")}</h2>
          <div class="grid teams-grid">${ts.map(card).join("")}</div></section>`;
      }).join("") + (L.rosters ? `<p class="muted small">Rosters as of ${fmtDate(L.rosters.asOf)} (week ${esc(L.rosters.week)})</p>` : "");
    },

    history() {
      const rows = L.champions.map(c => `
        <tr>
          <td class="yr">${esc(c.year)}</td>
          <td class="champ">🏆 ${esc(c.champion)}</td>
          <td>${esc(c.runnerUp)}</td>
          <td>${esc(c.lastPlace)}</td>
          <td class="muted">${esc(c.note)}</td>
        </tr>`).join("");
      // Title leaderboard computed from the champions list
      const counts = {};
      L.champions.forEach(c => { if (c.champion && c.champion !== "TBD") counts[c.champion] = (counts[c.champion] || 0) + 1; });
      const board = Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([n, k]) => `<tr><td class="champ">${esc(n)}</td><td class="yr">${k}</td></tr>`).join("");
      return `
        <section><h2>Champions</h2>
          <div class="card table-wrap"><table>
            <thead><tr><th>Year</th><th>Champion</th><th>Runner-up</th><th>Last place</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>
        </section>
        ${board ? `<section><h2>Title Count</h2><div class="card table-wrap"><table>
            <thead><tr><th>Team</th><th>Titles</th></tr></thead><tbody>${board}</tbody></table></div></section>` : ""}`;
    },

    rules() {
      const groups = L.scoring.map(g => `
        <div class="card">
          <h3>${esc(g.group)}</h3>
          <table><tbody>${g.items.map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</tbody></table>
        </div>`).join("");
      return `
        <section><h2>Scoring</h2><div class="grid">${groups}</div></section>
        <section><h2>Roster</h2><div class="card">${esc(L.roster)}</div></section>
        <section><h2>Bylaws</h2><div class="card"><ul class="checks">
          ${L.bylaws.map(b => `<li>${esc(b)}</li>`).join("")}</ul></div></section>`;
    },

    traditions() {
      return `<section><h2>Traditions</h2><div class="grid">
        ${L.traditions.map(t => `<div class="card"><h3>${esc(t.title)}</h3><p>${esc(t.body)}</p></div>`).join("")}
      </div></section>`;
    },

    // Rendered by myteam.js (team, roster, lineups)
    myteam() { return `<div id="mtRoot"></div>`; },

    // Rendered by account.js (sign-in, commissioner screen)
    account() { return `<div id="acctRoot"></div>`; },
    commish() { return `<div id="acctRoot"></div>`; }
  };

  // ---- Countdown ------------------------------------------------------
  function startClock() {
    const el = document.getElementById("clock");
    if (!el) return;
    const target = new Date(L.nextEvent.date).getTime();
    const tick = () => {
      let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const parts = [["Days", Math.floor(s / 86400)], ["Hrs", Math.floor(s % 86400 / 3600)],
                     ["Min", Math.floor(s % 3600 / 60)], ["Sec", s % 60]];
      el.innerHTML = parts.map(([l, n]) => `<div><b>${String(n).padStart(2, "0")}</b><span>${l}</span></div>`).join("");
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  // ---- Router ---------------------------------------------------------
  function route() {
    const raw = (location.hash || "#home").slice(1);
    const key = raw === "lineups" ? "myteam" : raw;   // old links
    const page = pages[key] ? key : "home";
    clearInterval(timer);
    view.innerHTML = pages[page]();
    document.querySelectorAll(".nav a[href^='#']").forEach(a =>
      a.classList.toggle("active", a.getAttribute("href") === "#" + page));
    nav.classList.remove("open");
    if (page === "home") startClock();
    if (page === "myteam" && window.B5MyTeam) window.B5MyTeam.start(document.getElementById("mtRoot"));
    if ((page === "account" || page === "commish") && window.B5Account) window.B5Account.start(page, document.getElementById("acctRoot"));
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  // Week picker on the schedule page
  view.addEventListener("click", (e) => {
    const b = e.target.closest("[data-week]");
    if (!b) return;
    schedWeek = Number(b.dataset.week);
    view.innerHTML = pages.schedule();
    const active = view.querySelector(".wk.active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
  });
  route();
})();
