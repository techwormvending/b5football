/* League HQ — renders every page from window.LEAGUE (league-data.js).
   No build step, no dependencies. Hash routing: #home, #teams, etc. */
(function () {
  const L = window.LEAGUE;
  const view = document.getElementById("view");
  let timer = null;

  // Escape plain-text fields. Announcement bodies are intentionally raw HTML.
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined,
    { month: "short", day: "numeric", year: "numeric" });

  // Team names, logos and links come from teamlink.js (window.B5Team); standings helpers
  const T = window.B5Team;
  const rows = (L.standings && L.standings.rows) || [];
  const rec = (id) => { const r = rows.find(x => x[0] === id); return r && { w: r[1], l: r[2], t: r[3], pf: r[4], pa: r[5] }; };
  const standOrder = (id) => { const i = rows.findIndex(x => x[0] === id); return i < 0 ? 99 : i; };
  const divName = (id) => ((L.divisions || []).find(d => d.id === id) || {}).name || "";

  function standingsTable() {
    if (!rows.length) return "";
    const body = rows.map((r, i) => {
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td><div class="st-team">${T.link(r[0])}</div></td>
        <td class="muted hide-sm">${esc(divName(T.division(r[0])))}</td>
        <td class="num"><b>${r[1]}-${r[2]}${r[3] ? "-" + r[3] : ""}</b></td>
        <td class="num">${Number(r[4]).toFixed(1)}</td>
        <td class="num hide-sm">${Number(r[5]).toFixed(1)}</td>
      </tr>`;
    }).join("");
    return `<section><h2>Standings</h2>
      <div class="card table-wrap"><table class="standings">
        <thead><tr><th>#</th><th>Team</th><th class="hide-sm">Div</th><th class="num">W-L</th><th class="num">PF</th><th class="num hide-sm">PA</th></tr></thead>
        <tbody>${body}</tbody></table>
        <p class="muted small">${L.standings.fromDb ? "Computed by this site. MFL is official for 2026." : "As of " + fmtDate(L.standings.asOf)}</p>
      </div></section>`;
  }

  // ---- Shell ----------------------------------------------------------
  document.title = L.name;
  document.getElementById("brandBadge").textContent = L.shortName;
  document.getElementById("brandSub").textContent = `${L.season} · ${L.format}`;
  document.getElementById("footText").textContent =
    `${L.name}${L.established ? " · Est. " + L.established : ""}`;
  document.getElementById("footYear").textContent = new Date().getFullYear();

  // Top bar, menus, phone bottom bar, page titles and tabs: nav.js (window.B5Nav)
  const NAV = window.B5Nav;
  const head = document.getElementById("pageHead");
  NAV.mount();

  // ---- Pages ----------------------------------------------------------
  // Schedule helpers. Default week = first week not yet played.
  const sched = L.schedule || { weeks: [] };
  const played = (g) => g[1] != null && g[3] != null;
  const currentWeek = () => (sched.weeks.find(w => !w.games.length || !w.games.every(played)) || sched.weeks[sched.weeks.length - 1] || {}).week;
  let schedWeek = null;

  function gameCard(g, week) {
    const [aId, aPts, hId, hPts] = g;
    const done = played(g);
    const side = (id, pts, opp) => `
      <div class="g-side${done && pts > opp ? " win" : ""}">
        <span class="g-name">${T.link(id)}</span>
        <span class="g-pts">${done ? Number(pts).toFixed(1) : "–"}</span>
      </div>`;
    const divGame = T.division(aId) && T.division(aId) === T.division(hId);
    const round = roundName(week);
    // The whole card opens the matchup (a cover link); the team names on top open the teams.
    return `<div class="card game has-cover"><a class="card-cover" href="#scores/${esc(week)}/${esc(aId)}" aria-label="Open the week ${esc(week)} matchup"></a>
      ${side(aId, aPts, hPts)}${side(hId, hPts, aPts)}
      <div class="g-meta muted">${done ? (sched.liveWeeks && sched.liveWeeks.has(week) ? "Live" : "Final") : "Upcoming"}${round ? ` · ${esc(round)}` : divGame ? ` · ${esc(divName(T.division(aId)))} division game` : ""}</div>
    </div>`;
  }

  // Playoffs: LEAGUE.playoffs (8 teams; quarterfinals week 15, semifinals 16, championship 17).
  const PO = L.playoffs || { teams: 0, rounds: [] };
  const roundName = (week) => ((PO.rounds || []).find(r => r.week === week) || {}).name || "";

  // Bracket placeholder until the matchups are set. Seeds 1-8, standard pairing (1v8, 4v5, 3v6, 2v7).
  function bracket(week) {
    const r = PO.rounds || [];
    if (PO.teams !== 8 || r.length !== 3) return `<div class="card muted">Playoffs. Matchups are set after week ${esc(sched.regularSeasonWeeks)}.</div>`;
    const slot = (t) => `<div class="br-team">${esc(t)}</div>`;
    const game = (x, y) => `<div class="br-game">${slot(x)}${slot(y)}</div>`;
    const col = (rd, games) => `<div class="br-col${rd.week === week ? " now" : ""}">
        <div class="br-head">${esc(rd.name)}<span>Week ${esc(rd.week)}</span></div>${games}</div>`;
    return `<div class="card">
        <div class="bracket">
          ${col(r[0], game("Seed 1", "Seed 8") + game("Seed 4", "Seed 5") + game("Seed 3", "Seed 6") + game("Seed 2", "Seed 7"))}
          ${col(r[1], game("Winner 1/8", "Winner 4/5") + game("Winner 3/6", "Winner 2/7"))}
          ${col(r[2], game("Winner SF 1", "Winner SF 2"))}
        </div>
        <p class="muted small">${esc(PO.teams)} teams make the playoffs. Seeding: ${esc(PO.seeding || "TBD")}. Matchups are set after week ${esc(sched.regularSeasonWeeks)}.</p>
      </div>`;
  }

  // ---- Announcements (public.announcements): author, team and the role posted as; pinned first ----
  const AN = window.B5Announcements;
  let anns = null;   // published announcements from the database (null until loaded)
  const dbApi = (sess, path, init) => window.B5Auth.api(window.B5_SUPABASE, sess, path, init || {}, (u, i) => window.fetch(u, i));
  const meNow = () => window.B5Account ? window.B5Account.load().catch(() => null) : Promise.resolve(null);
  function loadAnnouncements() {
    const cfg = window.B5_SUPABASE;
    if (!(cfg && cfg.configured && window.B5Auth)) { anns = []; return; }
    dbApi(null, "announcements?published_at=not.is.null&select=id,title,body_html,image_url,published_at,author_name,author_team,posted_as,pinned,board_thread_id&order=published_at.desc&limit=30").then(r => {
      anns = r.ok ? r.data || [] : [];
      if (curPage === "home") route();
    }, () => { anns = []; });
  }
  const viewerRoles = () => { const v = window.B5Account && window.B5Account.viewer(); return (v && v.roles) || []; };
  // Officers on Home: Pin / Unpin (commissioner or admin), post a new announcement (any officer)
  view.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ann-pin]");
    if (!b || curPage !== "home") return;
    const pin = b.dataset.pin === "1";
    if (!confirm(pin ? "Pin this announcement to the top of the Home page?" : "Unpin this announcement? It goes back in date order.")) return;
    b.disabled = true;
    meNow().then(me => dbApi(me && me.session, "announcements?id=eq." + Number(b.dataset.annPin), { method: "PATCH", body: JSON.stringify({ pinned: pin }), headers: { Prefer: "return=minimal" } }))
      .then(r => { if (!r.ok) { alert("Couldn't change the pin: " + (r.error || "not allowed")); b.disabled = false; return; } loadAnnouncements(); });
  });
  view.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-ann-post]");
    if (!form || curPage !== "home") return;
    e.preventDefault();
    const fd = new FormData(form), btn = form.querySelector("button[type=submit]"), msg = form.querySelector(".acct-msg");
    const said = (t, err) => { msg.textContent = t; msg.className = "acct-msg " + (err ? "err" : "ok"); msg.hidden = false; btn.disabled = false; };
    btn.disabled = true;
    const row = { title: String(fd.get("title") || "").trim(), body_html: String(fd.get("body") || "").trim(), posted_as: fd.get("posted_as"),
      pinned: fd.get("pinned") === "on", published_at: new Date().toISOString() };
    meNow().then(me => {
      const sess = me && me.session;
      return dbApi(sess, "announcements?select=id", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=representation" } }).then(r => {
        if (!r.ok) return said("Couldn't post: " + r.error, true);
        if (fd.get("board") !== "on") { form.reset(); said("Posted."); return loadAnnouncements(); }
        // Also on the Message Board: same author and role badge; replies collect there
        const text = window.B5Board ? window.B5Board.htmlToText(row.body_html) : row.body_html;
        return dbApi(sess, "rpc/board_new_thread", { method: "POST", body: JSON.stringify({ p_title: row.title, p_body: text || row.title, p_images: [], p_source_key: null }) }).then(t => {
          if (!t.ok) return said("Posted, but the Message Board thread failed: " + t.error, true);
          const id = Number(t.data);
          return Promise.all([
            dbApi(sess, "board_threads?id=eq." + id, { method: "PATCH", body: JSON.stringify({ posted_as: row.posted_as }), headers: { Prefer: "return=minimal" } }),
            dbApi(sess, "board_posts?thread_id=eq." + id + "&is_opener=is.true", { method: "PATCH", body: JSON.stringify({ posted_as: row.posted_as }), headers: { Prefer: "return=minimal" } }),
            dbApi(sess, "announcements?id=eq." + r.data[0].id, { method: "PATCH", body: JSON.stringify({ board_thread_id: id }), headers: { Prefer: "return=minimal" } })
          ]).then(() => { form.reset(); said("Posted, and on the Message Board."); loadAnnouncements(); });
        });
      });
    });
  });
  function postFormHtml() {
    const roles = AN.postAsChoices(viewerRoles());
    if (!roles.length) return "";
    const canPin = roles.includes("admin") || roles.includes("commissioner");
    return `<details class="card ann-new"><summary>Post an announcement</summary><form class="acct-form" data-ann-post>
      <label>Title<input name="title" maxlength="120" required></label>
      <label>Message (HTML: &lt;p&gt;, &lt;b&gt;, &lt;a href&gt;)<textarea name="body" rows="6" required></textarea></label>
      <label>Post as<select name="posted_as">${roles.map(r => `<option value="${r}">${esc(AN.ROLE_NAMES[r])}</option>`).join("")}</select></label>
      ${canPin ? `<label class="acct-check"><input type="checkbox" name="pinned"> Pin to the top</label>` : ""}
      <label class="acct-check"><input type="checkbox" name="board" checked> Also post it on the Message Board (replies collect there)</label>
      <button class="btn" type="submit">Post</button><p class="acct-msg" hidden></p></form></details>`;
  }
  function announcementsHtml() {
    if (anns === null) return '<p class="muted">Loading…</p>';
    if (!anns.length) return '<p class="muted">No announcements yet.</p>';
    const roles = viewerRoles(), canPin = roles.includes("commissioner") || roles.includes("admin");
    return AN.order(anns).map(a => `
        <article class="card${a.pinned ? " post-pinned" : ""}">
          <div class="post-meta"><span class="tag">${esc(AN.tagFor(a.posted_as))}</span>${fmtDate(String(a.published_at).slice(0, 10))}${a.pinned ? `<span class="tag post-pin">📌 Pinned</span>` : ""}
            ${canPin ? `<button type="button" class="btn ghost post-pin-btn" data-ann-pin="${esc(a.id)}" data-pin="${a.pinned ? "0" : "1"}">${a.pinned ? "Unpin" : "Pin to top"}</button>` : ""}</div>
          <h3>${esc(a.title)}</h3>
          <div class="post-author">${AN.bylineHtml(a, T)}</div>
          <div class="post-body">${seesMoney() ? a.body_html : hideAmounts(a.body_html)}</div>
          ${a.image_url && /^https:\/\//.test(a.image_url) ? `<img class="post-img" src="${esc(a.image_url)}" alt="">` : ""}
          ${a.board_thread_id ? `<p class="small"><a href="#messages/board/${esc(a.board_thread_id)}">Discuss on the Message Board</a></p>` : ""}
        </article>`).join("");
  }

  // ---- Money is for members (2026-11-01) ---------------------------------------------
  const seesMoney = () => !!(window.B5Account && window.B5Account.seesMoney && window.B5Account.seesMoney());
  // Announcements are commissioner HTML: signed-out viewers get any dollar amount blanked
  const hideAmounts = (html) => String(html).replace(/\$\s?\d[\d,]*(\.\d+)?/g, "(amount for members)");
  const SIGN_IN_MONEY = 'Payouts and fees: <a href="#account">sign in</a> to see the league\'s payout structure.';
  let moneyRule = SIGN_IN_MONEY;
  // The Rules page's money bylaw, from the database for members (no amounts in the repo)
  function loadMoneyRule() {
    if (!seesMoney()) { moneyRule = SIGN_IN_MONEY; return Promise.resolve(); }
    return window.B5Account.load().then(me => window.B5Auth.api(window.B5_SUPABASE, me && me.session, "rpc/season_money",
      { method: "POST", body: JSON.stringify({ p_season: Number(L.season) }) }, (u, i) => window.fetch(u, i))).then(r => {
      const m = r && r.ok && r.data; if (!m) return;
      const usd = (x) => "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 });
      const w = m.prizes && m.prizes.weekly_high;
      moneyRule = esc("Entry fee " + usd(m.buy_in) + " per team." + (w ? " Weekly high score pays " + usd(w.amount) + " every week, weeks " + w.first_week + "–" + w.last_week + " (playoff weeks included)." : "")) +
        ' Full prize list on the <a href="#payouts">Payouts</a> page.';
    }, () => {});
  }

  const pages = {
    // League > Standings & Schedule: the standings, then the week-by-week schedule
    schedule() { return standingsTable() + pages.scheduleWeeks(); },
    // Phones: the More page (big tiles)
    more() { return NAV.moreHtml(window.B5Account ? window.B5Account.viewer() : null); },
    scheduleWeeks() {
      if (!sched.weeks.length) return `<section><h2>Schedule</h2><p class="muted">No schedule yet.</p></section>`;
      const cur = currentWeek();
      const wk = schedWeek ?? cur;
      const w = sched.weeks.find(x => x.week === wk) || sched.weeks[0];
      const isPlayoff = w.week > (sched.regularSeasonWeeks || 99);
      const round = roundName(w.week);
      const chips = sched.weeks.map(x => `<button aria-label="Week ${x.week}${roundName(x.week) ? ", " + esc(roundName(x.week)) : ""}" class="wk${x.week > (sched.regularSeasonWeeks || 99) ? " po" : ""}${x.week === w.week ? " active" : ""}${x.week === cur ? " now" : ""}" data-sched-week="${x.week}">${x.week}</button>`).join("");
      const body = w.games.length
        ? `<div class="grid games">${w.games.map(g => gameCard(g, w.week)).join("")}</div>`
        : isPlayoff ? bracket(w.week) : `<div class="card muted">No games this week.</div>`;
      return `<section>
          <h2>Schedule</h2>
          <div class="weeks" role="tablist" aria-label="Week">${chips}</div>
          <h3 class="wk-title">Week ${esc(w.week)}${isPlayoff ? " · Playoffs" + (round ? ": " + esc(round) : "") : ""}${w.week === cur ? ` <span class="tag">This week</span>` : ""}</h3>
          ${body}
          <p class="muted small">${sched.fromDb ? "Scores computed by this site from nflverse stats. MFL is official for 2026." : "Schedule as of " + fmtDate(sched.asOf)}</p>
        </section>`;
    },

    home() {
      const posts = postFormHtml() + announcementsHtml();
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
      const card = id => {
        const r = rec(id), titles = T.titles(id);
        return `
        <div class="card team-card">
          <div class="team">
            <a href="${esc(T.href(id))}" tabindex="-1" aria-hidden="true">${T.logo(id, "logo")}</a>
            <div>
              <h3>${T.link(id, { logo: false })}</h3>
              <div class="muted"><span data-mgr="${esc(id)}">${esc(T.manager(id))}</span>${r ? ` · ${r.w}-${r.l}${r.t ? "-" + r.t : ""}` : ""}</div>
              ${titles ? `<div class="rings" title="${titles} title(s)">${"🏆".repeat(titles)}</div>` : ""}
            </div>
          </div>
          <div data-roster="${esc(id)}">${rosterHtml(id)}</div>
        </div>`;
      };
      const divs = (L.divisions && L.divisions.length) ? L.divisions : [{ id: null, name: "The " + T.ids().length }];
      return divs.map(d => {
        const ts = T.ids().filter(id => d.id === null || T.division(id) === d.id)
          .sort((a, b) => standOrder(a) - standOrder(b));
        return `<section><h2>${esc(d.id === null ? d.name : d.name + " Division")}</h2>
          <div class="grid teams-grid">${ts.map(card).join("")}</div></section>`;
      }).join("") + (L.rosters ? `<p class="muted small rosters-asof">Rosters as of ${fmtDate(L.rosters.asOf)} (week ${esc(L.rosters.week)})</p>` : "");
    },

    // Champions since 2000, titles, runner-ups and back-to-backs from the database (history.js)
    history() { return '<div id="hsRoot"><p class="muted">Loading…</p></div>'; },

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
          ${L.bylaws.map(b => b && b.money ? `<li data-money-rule>${moneyRule}</li>` : `<li>${esc(b)}</li>`).join("")}</ul></div></section>
        ${L.rulesUpdated ? `<p class="muted small">Rules last updated ${esc(fmtDate(L.rulesUpdated))}.</p>` : ""}`;
    },

    traditions() {
      return `<section><h2>Traditions</h2><div class="grid">
        ${L.traditions.map(t => `<div class="card"><h3>${esc(t.title)}</h3><p>${esc(t.body)}</p></div>`).join("")}
      </div></section>`;
    },

    // Rendered by myteam.js (team, roster, lineups)
    myteam() { return `<div id="mtRoot"></div>`; },

    // Rendered by payouts.js
    payouts() { return `<div id="poRoot"></div>`; },
    // Rendered by pools.js
    survivor() { return `<div id="plRoot"></div>`; },
    confidence() { return `<div id="plRoot"></div>`; },
    "commish-payouts"() { return `<div id="poRoot"></div>`; },

    // Rendered by account.js (sign-in, commissioner screen)
    account() { return `<div id="acctRoot"></div>`; },
    commish() { return `<div id="acctRoot"></div>`; },
    admin() { return `<div id="acctRoot"></div>`; },
    treasury() { return `<div id="trRoot"></div>`; },
    live() { return `<div id="lvRoot"></div>`; },
    board() { return `<div id="bdRoot"></div>`; },
    chat() { return `<div id="chRoot"></div>`; },
    players() { return `<div id="plRoot"></div>`; },
    // Rendered by team.js (team profile), dm.js (direct messages), trades.js (trades)
    team() { return `<div id="tpRoot"></div>`; },
    dm() { return `<div id="dmRoot"></div>`; },
    // Rendered by draft.js (the Draft Room, practice drafts, the big-screen board)
    draft() { return `<div id="drRoot"></div>`; },
    trade() { return `<div id="trRoot"></div>`; },
    trades() { return `<div id="trRoot"></div>`; },
    // Email links: #unsubscribe/<token> (account.js; works without signing in)
    unsubscribe() { return `<div id="acctRoot"></div>`; }
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
  // Route parsing lives in route.js (window.B5Route), tested on its own.
  let curPage = null;

  function route() {
    const r = window.B5Route.parse(location.hash, k => !!pages[k]);
    if (r.redirect && history.replaceState) history.replaceState(null, "", r.redirect);   // old links (#live, #board, #chat, #dm, ...) -> their new homes
    const page = r.page;
    // Unsaved lineup on My Team: ask first; staying puts the address back without reloading the page.
    if (curPage === "myteam" && page !== "myteam" && window.B5MyTeam && window.B5MyTeam.dirty() && !confirm(window.B5MyTeam.LEAVE)) {
      if (history.replaceState) history.replaceState(null, "", "#myteam");
      return;
    }
    if (curPage === "confidence" && window.B5Pools && window.B5Pools.dirty() && !confirm(window.B5Pools.LEAVE)) {
      if (history.replaceState) history.replaceState(null, "", "#confidence");
      return;
    }
    curPage = page;
    clearInterval(timer);
    if (window.B5Live) window.B5Live.stop();   // leaves Realtime and its timers when you leave #live
    if (window.B5Board) window.B5Board.stop();
    if (window.B5Chat) window.B5Chat.stop();
    if (window.B5Players) window.B5Players.stop();
    if (window.B5TeamPage) window.B5TeamPage.stop();
    if (window.B5DM) window.B5DM.stop();
    if (window.B5Trades) window.B5Trades.stop();
    if (window.B5Draft) window.B5Draft.stop();
    document.body.dataset.page = page;   // lets a page restyle the frame (the chat hides the footer)
    // Big page title and the page's tabs under the bar (none on Home: its own heading says it)
    head.innerHTML = page === "home" ? "" : NAV.route(r);
    if (page === "home") NAV.route(r);
    view.innerHTML = pages[page]();
    dedupeTitles(NAV.sectionOf(r));
    if (page === "schedule") centerWeek();
    if (page === "home") startClock();
    if (page === "rules") loadMoneyRule().then(() => { const li = view.querySelector("[data-money-rule]"); if (li && curPage === "rules") li.innerHTML = moneyRule; });
    if (page === "live" && window.B5Live) window.B5Live.start(document.getElementById("lvRoot"), r);
    if (page === "board" && window.B5Board) window.B5Board.start(document.getElementById("bdRoot"), r);
    if (window.B5Board) window.B5Board.badge();   // unread count on the nav item (signed-in members)
    if (page === "chat" && window.B5Chat) window.B5Chat.start(document.getElementById("chRoot"), r);
    else if (window.B5Chat) window.B5Chat.badge();
    if (page === "players" && window.B5Players) window.B5Players.start(document.getElementById("plRoot"), r);
    if (page === "team" && window.B5TeamPage) window.B5TeamPage.start(document.getElementById("tpRoot"), r);
    if ((page === "trade" || page === "trades") && window.B5Trades) window.B5Trades.start(document.getElementById("trRoot"), r);
    if (page === "dm" && window.B5DM) window.B5DM.start(document.getElementById("dmRoot"), r);
    if (page === "draft" && window.B5Draft) window.B5Draft.start(document.getElementById("drRoot"), r);
    if (page === "history" && window.B5History) window.B5History.start(document.getElementById("hsRoot"));
    if (window.B5DM) window.B5DM.badge();   // unread direct messages on the ✉ nav item
    if (page === "teams" && window.B5Payouts) {
      window.B5Payouts.teamWinnings().then(w => {
        view.querySelectorAll("[data-roster]").forEach(el => {
          const x = w[el.dataset.roster]; if (!x || !(x.final + x.projected)) return;
          const p = document.createElement("div"); p.className = "muted small po-won";
          p.textContent = `Won ${window.B5Payouts.money(x.final)}${x.projected ? ` (+${window.B5Payouts.money(x.projected)} projected)` : ""}`;
          el.parentNode.insertBefore(p, el);
        });
      });
    }
    if (page === "teams" && window.B5TeamPage && window.B5Auth && window.B5_SUPABASE && window.B5_SUPABASE.configured) {
      // This week's starting lineup per team (B5 lineups are public), with "Submitted … by …".
      const cfg = window.B5_SUPABASE, api = (sess, path, body) => window.B5Auth.api(cfg, sess, path, body ? { method: "POST", body: JSON.stringify(body) } : {}, (u, i) => fetch(u, i));
      const who = window.B5Account ? window.B5Account.load().catch(() => null) : Promise.resolve(null);
      who.then(me => {
        const sess = me && me.session, season = Number(L.season);
        return api(sess, `nfl_games?season=eq.${season}&select=week,kickoff`).then(g => {
          const week = window.B5TeamPage.currentWeek((g.ok && g.data) || []);
          if (!week) return;
          return Promise.all([api(sess, "rpc/live_lineups", { p_season: season, p_week: week }), api(sess, "rpc/lineup_status", { p_season: season, p_week: week })]).then(([s, st]) => {
            if (curPage !== "teams") return;
            const slots = (s.ok && s.data) || [], status = (st.ok && st.data) || [];
            view.querySelectorAll("[data-roster]").forEach(el => {
              const id = el.dataset.roster, box = document.createElement("details");
              box.className = "roster lu-team"; box.open = true;
              box.innerHTML = `<summary>Week ${esc(week)} lineup</summary>` +
                window.B5TeamPage.lineupHtml(slots.filter(x => x.team_id === id), status.find(x => x.team_id === id), week, season);
              el.parentNode.insertBefore(box, el);
            });
          });
        });
      }).catch(() => {});
    }
    if (page === "teams" && window.B5MyTeam) {
      // Current rosters from the database replace the static snapshot.
      window.B5MyTeam.loadRosters().then(db => {
        if (!db) return;
        const acq = (d) => /^Waiv/.test(d) ? "Waivers" : d ? "Pick " + d : "";
        view.querySelectorAll("[data-roster]").forEach(el => {
          const ps = db[el.dataset.roster] || [];
          el.innerHTML = `<details class="roster"><summary>Roster (${ps.length})</summary><ul>${ps.map(p => `
            <li><span class="pos pos-${esc(p.pos)}">${esc(p.pos)}</span><span class="pname">${esc(p.name)}</span>
              <span class="muted nfl" title="${esc(acq(p.acquired))}">${esc(p.nfl || "FA")}</span></li>`).join("")}</ul></details>`;
        });
        const note = view.querySelector(".rosters-asof");
        if (note) note.textContent = "Rosters are current (synced nightly).";
      });
    }
    if (page === "teams" && window.B5Account && window.B5Account.managerNames) {
      window.B5Account.load().then(() => window.B5Account.managerNames()).then(m => {
        view.querySelectorAll("[data-mgr]").forEach(el => { if (m[el.dataset.mgr]) el.textContent = m[el.dataset.mgr]; });
      }, () => {});
    }
    if ((page === "survivor" || page === "confidence") && window.B5Pools) window.B5Pools.start(page, document.getElementById("plRoot"), r.week);
    if ((page === "payouts" || page === "commish-payouts") && window.B5Payouts) window.B5Payouts.start(page === "payouts" ? "public" : "admin", document.getElementById("poRoot"));
    if (page === "myteam" && window.B5MyTeam) window.B5MyTeam.start(document.getElementById("mtRoot"), { tab: r.tab === "roster" ? "roster" : "lineup" });
    if ((page === "account" || page === "commish" || page === "admin") && window.B5Account) window.B5Account.start(page, document.getElementById("acctRoot"));
    if (page === "treasury" && window.B5Treasury) window.B5Treasury.start(document.getElementById("trRoot"));
    if (page === "unsubscribe" && window.B5Account) window.B5Account.unsubscribe(document.getElementById("acctRoot"), r.token);
    window.scrollTo(0, 0);
  }
  // A page's own first heading that repeats the big title or the open tab ("Live" under Scores,
  // "Messages" under Messages · Private) is hidden; pages render late, so watch for it a while.
  const ALIAS = { live: ["Live"], board: ["Board"], dm: ["Messages"], chat: ["Chat"], players: ["Players"], account: ["Account"] };
  let titleWatch = null;
  function dedupeTitles(s) {
    if (titleWatch) titleWatch.disconnect();
    const tab = head.querySelector(".page-tabs a.active");
    const same = [s.title, tab && tab.firstChild && tab.firstChild.textContent].concat(ALIAS[curPage] || []).filter(Boolean).map(x => x.trim().toLowerCase());
    const run = () => view.querySelectorAll("section > h2:first-child, .bd-head > h2:first-child").forEach(h => {
      const t = h.textContent.trim().toLowerCase();
      if (same.includes(t)) h.classList.add("dup-title");
    });
    run();
    if (window.MutationObserver) { titleWatch = new MutationObserver(run); titleWatch.observe(view, { childList: true, subtree: true }); }
  }
  window.addEventListener("hashchange", route);
  // Week picker on the schedule page (only there: other pages have their own week buttons)
  view.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sched-week]");
    if (!b || curPage !== "schedule") return;
    schedWeek = Number(b.dataset.schedWeek);
    view.innerHTML = pages.schedule();
    centerWeek();
  });
  // Scroll the week strip (not the page) so the selected week is centered.
  function centerWeek() {
    const strip = view.querySelector(".weeks"), active = view.querySelector(".wk.active");
    if (strip && active) strip.scrollLeft = active.offsetLeft - strip.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
  }
  route();
  if (window.B5Account) window.B5Account.presence();   // "on the site" heartbeat (DM emails skip you)

  // ---- League data from the database -------------------------------------
  // Matchups (schedule + our scores) and standings computed by this site replace the
  // static snapshot when the database has them. Public data: works signed out.
  function loadFromDb() {
    const cfg = window.B5_SUPABASE, A = window.B5Auth;
    if (!(cfg && cfg.configured && A)) return;
    const get = (p) => A.api(cfg, null, p, {}, (u, i) => window.fetch(u, i));
    Promise.all([
      get(`matchups?season=eq.${Number(L.season)}&select=week,home_team,away_team,home_score,away_score&order=week`),
      get(`standings?season=eq.${Number(L.season)}&select=team_id,wins,losses,ties,points_for,points_against,rank&order=rank`),
      get(`score_weeks?season=eq.${Number(L.season)}&status=eq.live&select=week`)
    ]).then(([m, s, lw]) => {
      if (lw.ok && lw.data) sched.liveWeeks = new Set(lw.data.map(x => x.week));
      let changed = false;
      if (m.ok && m.data && m.data.length) {
        const byWeek = {};
        m.data.forEach(x => (byWeek[x.week] = byWeek[x.week] || []).push([x.away_team,
          x.away_score == null ? null : Number(x.away_score), x.home_team, x.home_score == null ? null : Number(x.home_score)]));
        sched.weeks.forEach(w => { if (byWeek[w.week]) w.games = byWeek[w.week]; });
        sched.fromDb = true;
        changed = true;
      }
      if (s.ok && s.data && s.data.length) {
        rows.length = 0;
        s.data.forEach(x => rows.push([x.team_id, x.wins, x.losses, x.ties, Number(x.points_for), Number(x.points_against)]));
        if (L.standings) { L.standings.rows = rows; L.standings.fromDb = true; }
        changed = true;
      }
      if (changed && ["home", "schedule", "teams"].includes((location.hash || "#home").slice(1))) route();
    }, () => {});
  }
  loadFromDb();
  loadAnnouncements();
  if (window.B5Account) window.B5Account.load().then(() => { if (curPage === "home") route(); }, () => {});
})();
