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
              <a class="btn" href="#lineups">Set Lineup</a>
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

    lineups() {
      return `<div id="lineups"><section><h2>Lineups</h2><p class="muted">Loading…</p></section></div>`;
    }
  };

  // ---- Lineups ----------------------------------------------------------
  // Talks to the league server (server/server.js). Saved lineups live there.
  const LU_KEY = "b5.lineupAuth";
  const lu = { state: null, auth: null, mine: null, draft: null, msg: null, skew: 0, all: null, lastTeam: null };
  const luStore = {
    get() { try { return JSON.parse(localStorage.getItem(LU_KEY)); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(LU_KEY, JSON.stringify(v)) : localStorage.removeItem(LU_KEY); } catch {} }
  };
  const luNow = () => Date.now() + lu.skew;
  const fmtKick = (ms) => new Date(ms).toLocaleString("en-US",
    { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  const rosterOf = (id) => ((L.rosters && L.rosters.teams[id]) || [])
    .map(([name, pos, nfl, , pid]) => ({ id: pid, name, pos, nfl }));

  async function luApi(path, body) {
    const res = await fetch("/api/lineups" + path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
    return json;
  }

  function gameInfo(p) {
    const g = p && lu.state.games[p.nfl];
    if (!g) return { text: p && p.nfl === "FA" ? "Free agent" : "Bye", locked: false, bye: true };
    return { text: `${g.home ? "vs" : "@"} ${g.opp} · ${fmtKick(g.at)}`, locked: luNow() >= g.at, bye: false };
  }

  function luEditor() {
    if (!lu.auth) {
      const pick = lu.lastTeam || (luStore.get() || {}).team;
      return `<form class="card lu-login" data-lu="login">
        <h3>Set your lineup</h3>
        <label>Team<select name="team" required>
          <option value="">Pick your team</option>
          ${L.teams.map(t => `<option value="${esc(t.id)}"${pick === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select></label>
        <label>PIN<input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
        <label class="lu-check"><input type="checkbox" name="remember"> Remember me on this device</label>
        <button class="btn" type="submit">Unlock</button>
        ${lu.msg ? `<p class="lu-msg ${lu.msg.ok ? "ok" : "err"}">${esc(lu.msg.text)}</p>` : ""}
        <p class="muted small">Don't have a PIN? Ask the commissioner.</p>
      </form>`;
    }
    const t = teamById(lu.auth.team), S = lu.state.slots, ros = rosterOf(t.id);
    const byId = Object.fromEntries(ros.map(p => [p.id, p]));
    const used = new Set(lu.draft.filter(Boolean));
    const rows = S.map((slot, i) => {
      const cur = byId[lu.draft[i]], gi = gameInfo(cur), lockedHere = cur && gi.locked;
      const opts = ros.filter(p => p.pos === slot && (p.id === lu.draft[i] || !used.has(p.id))).map(p => {
        const g = gameInfo(p);
        return `<option value="${esc(p.id)}"${p.id === lu.draft[i] ? " selected" : ""}${g.locked && p.id !== lu.draft[i] ? " disabled" : ""}>${esc(p.name)} (${esc(p.nfl)})${g.locked ? " 🔒" : g.bye ? " · BYE" : ""}</option>`;
      }).join("");
      return `<div class="lu-row${lockedHere ? " locked" : ""}">
        <span class="pos pos-${esc(slot)}">${esc(slot)}</span>
        <div class="lu-pick">
          <select data-slot="${i}"${lockedHere || !lu.state.open ? " disabled" : ""} aria-label="${esc(slot)} slot ${i + 1}">
            <option value="">Empty</option>${opts}
          </select>
          <span class="muted lu-game">${cur ? (lockedHere ? "🔒 " : "") + esc(gi.bye ? "⚠ " + gi.text : gi.text) : ""}</span>
        </div>
      </div>`;
    }).join("");
    const bench = ros.filter(p => !used.has(p.id)).map(p => {
      const g = gameInfo(p);
      return `<li><span class="pos pos-${esc(p.pos)}">${esc(p.pos)}</span><span class="pname">${esc(p.name)}</span><span class="muted nfl">${g.locked ? "🔒 " : ""}${esc(g.bye ? g.text : p.nfl)}</span></li>`;
    }).join("");
    const m = lu.mine;
    const status = m.savedAt ? `Saved ${fmtKick(Date.parse(m.savedAt))}`
      : m.carried ? `Carried over from week ${m.carried}. Save to confirm it.` : "Not set yet.";
    const empty = lu.draft.filter(x => !x).length;
    return `<div class="card lu-edit">
      <div class="lu-head">${logoHtml(t, "logo sm")}<h3>${esc(t.name)}</h3>
        <button class="linkish" data-lu="logout" type="button">Switch team</button></div>
      <p class="muted small lu-status">${esc(status)}${m.role === "commish" ? " · Editing as commissioner" : ""}</p>
      ${rows}
      ${lu.state.open ? `<div class="lu-actions">
        <button class="btn" data-lu="save" type="button">Save lineup</button>
        ${empty ? `<span class="muted small">${empty} empty slot${empty > 1 ? "s" : ""}</span>` : ""}
      </div>` : `<p class="muted">Week ${esc(lu.state.week)} is locked.</p>`}
      ${lu.msg ? `<p class="lu-msg ${lu.msg.ok ? "ok" : "err"}">${esc(lu.msg.text)}</p>` : ""}
      <details class="roster"><summary>Bench (${ros.length - used.size})</summary><ul>${bench}</ul></details>
    </div>`;
  }

  function luLeague() {
    const S = lu.state.slots;
    const cards = L.teams.slice().sort((a, b) => standOrder(a.id) - standOrder(b.id)).map(t => {
      const s = lu.state.teams[t.id];
      const badge = s.submitted ? `<span class="lu-badge ok">✓ Set</span>`
        : s.carried ? `<span class="lu-badge">Carried over</span>` : `<span class="lu-badge no">Not set</span>`;
      const list = S.map((slot, i) => {
        const p = s.starters[i];
        return `<li><span class="pos pos-${esc(slot)}">${esc(slot)}</span>${p === "hidden" ? `<span class="muted pname">Hidden until kickoff</span>`
          : p ? `<span class="pname">${esc(p.name)}</span><span class="muted nfl">${esc(p.nfl)}</span>` : `<span class="muted pname">Empty</span>`}</li>`;
      }).join("");
      return `<div class="card team-card">
        <div class="team">${logoHtml(t, "logo sm")}<div><h3>${esc(t.name)}</h3>${badge}</div></div>
        <details class="roster"><summary>Starters</summary><ul>${list}</ul></details>
      </div>`;
    }).join("");
    return `<section><h2>League</h2>
      <p class="muted small">Other teams' starters show up as each game kicks off.</p>
      <div class="grid teams-grid">${cards}</div></section>`;
  }

  function luCommish() {
    const a = lu.all;
    const table = a ? L.teams.map(t => {
      const x = a.teams[t.id];
      return `<div class="card"><h3>${esc(t.name)}</h3>
        <p class="muted small">${x.savedAt ? "Saved " + esc(fmtKick(Date.parse(x.savedAt))) : x.carried ? "Carried over from week " + esc(x.carried) : "Not set"}</p>
        <ul class="lu-plain">${a.slots.map((slot, i) => `<li><b>${esc(slot)}</b> ${x.starters[i] ? esc(x.starters[i].name + " (" + x.starters[i].nfl + ")") : "<span class='muted'>Empty</span>"}</li>`).join("")}</ul></div>`;
    }).join("") : "";
    return `<section><details class="lu-commish"${a ? " open" : ""}><summary>Commissioner</summary>
      <form class="lu-inline" data-lu="all">
        <input name="pin" type="password" inputmode="numeric" placeholder="Commissioner PIN" aria-label="Commissioner PIN" required>
        <button class="btn ghost" type="submit">Show all lineups</button>
      </form>
      ${a ? `<p class="muted small">Week ${esc(a.week)}. Every team's full lineup.</p><div class="grid">${table}</div>` : ""}
    </details></section>`;
  }

  function luRender() {
    const root = document.getElementById("lineups");
    if (!root || !lu.state) return;
    const st = lu.state, starts = Object.values(st.games).map(g => g.at);
    const first = starts.length ? Math.min(...starts) : null;
    const sub = !st.open ? `Week ${st.week} is locked.`
      : first && luNow() < first ? `First game ${fmtKick(first)} ET. Each player locks at his own kickoff.`
      : `Games are underway. Players lock at their own kickoff.`;
    root.innerHTML = `<section><h2>Week ${esc(st.week)} Lineups</h2>
        <p class="muted">${esc(sub)}</p>
        <div class="lu-cols"><div>${luEditor()}</div><div>${luLeague()}</div></div>
      </section>${luCommish()}`;
  }

  async function luUnlock(team, pin, remember) {
    const mine = await luApi("/mine", { team, pin });
    lu.auth = { team, pin };
    lu.mine = mine;
    lu.draft = mine.starters.slice();
    if (remember !== undefined) luStore.set(remember ? { team, pin } : { team });
  }

  async function luStart() {
    lu.msg = null; lu.all = null;
    try {
      lu.state = await luApi("");
      lu.skew = lu.state.now - Date.now();
      const saved = luStore.get();
      if (!lu.auth && saved && saved.pin) await luUnlock(saved.team, saved.pin).catch(() => luStore.set({ team: saved.team }));
      else if (lu.auth) await luUnlock(lu.auth.team, lu.auth.pin);
      luRender();
    } catch (err) {
      const root = document.getElementById("lineups");
      if (root) root.innerHTML = `<section><h2>Lineups</h2><div class="card">
        <p>Lineups need the league server, and it isn't reachable right now.</p>
        <p class="muted small">${esc(err.message)}. If you're the commissioner, start it with <code>node server/server.js</code>.</p></div></section>`;
    }
  }

  view.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-lu]");
    if (!form) return;
    e.preventDefault();
    const f = new FormData(form);
    try {
      if (form.dataset.lu === "login") {
        lu.lastTeam = f.get("team");
        await luUnlock(f.get("team"), f.get("pin"), f.get("remember") === "on");
        lu.msg = null;
      } else if (form.dataset.lu === "all") {
        lu.all = await luApi("/all", { pin: f.get("pin"), week: lu.state.week });
      }
    } catch (err) { lu.msg = { ok: false, text: err.message }; if (form.dataset.lu === "all") alert(err.message); }
    luRender();
  });

  view.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-slot]");
    if (!sel) return;
    lu.draft[Number(sel.dataset.slot)] = sel.value || null;
    lu.msg = null;
    luRender();
  });

  view.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-lu]");
    if (!b) return;
    if (b.dataset.lu === "logout") {
      lu.auth = lu.mine = lu.draft = null; lu.msg = null;
      const s = luStore.get(); luStore.set(s ? { team: s.team } : null);
      return luRender();
    }
    if (b.dataset.lu === "save") {
      b.disabled = true;
      try {
        const r = await luApi("/save", { ...lu.auth, week: lu.state.week, starters: lu.draft });
        lu.state = await luApi("");
        await luUnlock(lu.auth.team, lu.auth.pin);
        lu.msg = { ok: true, text: `Lineup saved ${fmtKick(Date.parse(r.savedAt))}.` };
      } catch (err) { lu.msg = { ok: false, text: err.message }; }
      luRender();
    }
  });

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
    const key = (location.hash || "#home").slice(1);
    const page = pages[key] ? key : "home";
    clearInterval(timer);
    view.innerHTML = pages[page]();
    document.querySelectorAll(".nav a[href^='#']").forEach(a =>
      a.classList.toggle("active", a.getAttribute("href") === "#" + page));
    nav.classList.remove("open");
    if (page === "home") startClock();
    if (page === "lineups") luStart();
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
