/* Survivor (#survivor) and Confidence pool (#confidence) pages.
   Rules and scoring: src/league/pools.ts (standings are computed nightly and during games
   into survivor_status / confidence_scores). The database enforces the pick rules: lock at
   each game's kickoff, no reused Survivor team, unique confidence values, own team only,
   and others' picks stay hidden until their game kicks off.
   2026: MFL is official; picks are mirrored from MFL, read-only (picking opens in 2027).
   The commissioner can enter or fix anyone's pick (audited). All data is escaped. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var season = Number(L.season);
  var teamName = function (id) { var t = (L.teams || []).filter(function (x) { return x.id === id; })[0]; return t ? t.name : id || ""; };
  var NFL = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"];
  var fmtKick = function (iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : ""; };

  // ---- Pure helpers (tested in src/workers/pools-page.test.ts) -----------------------
  /** Game result: winner code, null for a tie, "pending". */
  function result(g) {
    if (!g || g.status !== "final" || g.home_score == null || g.away_score == null) return "pending";
    return g.home_score > g.away_score ? g.home : g.away_score > g.home_score ? g.away : null;
  }
  var started = function (g, now) { return !!(g && g.kickoff && Date.parse(g.kickoff) <= now); };
  /** Teams a Survivor entry can still pick (never reused). */
  function availableTeams(picks, teamId) {
    var used = {};
    picks.forEach(function (p) { if (p.team_id === teamId) used[p.nfl_team] = true; });
    return NFL.filter(function (t) { return !used[t]; });
  }
  /** Ordered confidence list for one team-week: picks first (by points, high to low), then
      unpicked games in kickoff order with the values nobody used. Each row: game, pick, points, locked. */
  function confidenceRows(games, picks, now) {
    var n = games.length, byGame = {};
    picks.forEach(function (p) { byGame[p.game_key] = p; });
    var taken = {};
    picks.forEach(function (p) { taken[p.points] = true; });
    var free = [];
    for (var v = n; v >= 1; v--) if (!taken[v]) free.push(v);
    var sorted = games.slice().sort(function (a, b) { return Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0); });
    var rows = sorted.map(function (g) {
      var p = byGame[g.game_key];
      return { game: g, pick: p ? p.pick : null, points: p ? p.points : free.shift(), locked: started(g, now) };
    });
    return rows.sort(function (a, b) { return b.points - a.points; });
  }
  /** Move row i up (dir -1) or down (+1) past locked rows; swaps points with the next unlocked row. */
  function moveRow(rows, i, dir) {
    if (rows[i].locked) return rows;
    var j = i + dir;
    while (j >= 0 && j < rows.length && rows[j].locked) j += dir;
    if (j < 0 || j >= rows.length) return rows;
    var out = rows.map(function (r) { return Object.assign({}, r); });
    var pts = out[i].points; out[i].points = out[j].points; out[j].points = pts;
    return out.sort(function (a, b) { return b.points - a.points; });
  }

  // ---- Data -------------------------------------------------------------------------
  var st = { me: null, page: null, week: null, data: null, rows: null, editTeam: null, msg: null };
  var session = function () { return st.me && st.me.session; };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var myTeam = function () { return st.me && st.me.teams && st.me.teams[0] ? st.me.teams[0].team_id : null; };

  function load() {
    var q = "?season=eq." + season;
    var reqs = [
      api("season_settings" + q + "&select=pools"),
      api("nfl_games" + q + "&select=week,game_key,home,away,kickoff,home_score,away_score,status&order=kickoff&limit=1000"),
      api("survivor_status" + q + "&select=team_id,alive,eliminated_week,reason,winner,picks_used"),
      api("confidence_scores" + q + "&select=week,team_id,points,correct,decided,games&limit=1000"),
      api("awards" + q + "&kind=in.(survivor,pickem)&select=kind,place,team_id,amount,status,source")
    ];
    if (session()) {
      reqs.push(api("survivor_picks" + q + "&select=week,team_id,nfl_team,source&limit=1000"));
      reqs.push(api("confidence_picks" + q + "&select=week,team_id,game_key,pick,points,source&limit=1000"));
    }
    return Promise.all(reqs).then(function (r) {
      var ok = function (x) { return x && x.ok ? x.data || [] : []; };
      var games = ok(r[1]);
      st.data = { pools: (ok(r[0])[0] || {}).pools || {}, games: games, survivor: ok(r[2]), scores: ok(r[3]), awards: ok(r[4]),
        spicks: ok(r[5]), cpicks: ok(r[6]) };
      if (st.week == null) {
        var cur = root.B5MyTeam && root.B5MyTeam.pickWeek ? root.B5MyTeam.pickWeek(games, Date.now()) : null;
        var lastPlayed = games.filter(function (g) { return g.status === "final"; }).reduce(function (m, g) { return Math.max(m, g.week); }, 1);
        st.week = cur || lastPlayed;
      }
    });
  }
  var open = function () { return !!(st.data && st.data.pools && st.data.pools.picking_open); };
  var noteHtml = function () {
    return open() ? "" : '<p class="muted small">MFL is official for ' + esc(season) + ": picks are mirrored from MFL, read-only here. Picking opens on this site in " + esc(season + 1) + ".</p>";
  };

  // ---- Survivor ----------------------------------------------------------------------
  function survivorHtml() {
    var d = st.data, now = Date.now(), cfgS = (d.pools || {}).survivor || { start_week: 1, end_week: 17 };
    var byTeam = {}; d.survivor.forEach(function (s) { byTeam[s.team_id] = s; });
    var winners = d.survivor.filter(function (s) { return s.winner; });
    var prize = d.awards.filter(function (a) { return a.kind === "survivor"; });
    var head = '<div class="card">' +
      (winners.length || prize.length ? '<p class="acct-msg ok"><b>' + esc((prize.length ? prize : winners).map(function (x) { return teamName(x.team_id); }).join(" & ")) + "</b> " +
        (prize.length ? "won Survivor: " + prize.map(function (a) { return "$" + Number(a.amount).toFixed(0); }).join(" + ") : "won Survivor") + "</p>" : "") +
      '<p class="small">Pick one NFL team to win each week (weeks ' + esc(cfgS.start_week) + "–" + esc(cfgS.end_week) + "), never the same team twice. A loss, a tie or no pick by the week's last kickoff knocks you out. Last team standing wins; if everyone left goes out the same week, they split.</p>" +
      noteHtml() + "</div>";

    var weeks = [];
    for (var w = cfgS.start_week; w <= Math.min(cfgS.end_week, st.week || cfgS.start_week); w++) weeks.push(w);
    var gameOf = function (wk, t) { return d.games.filter(function (g) { return g.week === wk && (g.home === t || g.away === t); })[0]; };
    var order = (L.teams || []).slice().sort(function (a, b) {
      var sa = byTeam[a.id] || {}, sb = byTeam[b.id] || {};
      return (sb.winner ? 2 : sb.alive ? 1 : 0) - (sa.winner ? 2 : sa.alive ? 1 : 0) || (sb.eliminated_week || 99) - (sa.eliminated_week || 99) || a.name.localeCompare(b.name);
    });
    var board = '<div class="card"><h3>Board</h3>' + (session() ? "" : '<p class="muted small"><a href="#account">Sign in</a> to see everyone\'s picks (members only).</p>') +
      '<div class="table-wrap"><table class="pl-table"><thead><tr><th>Team</th><th>Status</th>' + weeks.map(function (wk) { return '<th class="num">' + wk + "</th>"; }).join("") +
      '<th class="num">Left</th></tr></thead><tbody>' + order.map(function (t) {
        var s = byTeam[t.id] || { alive: true };
        var status = s.winner ? '<span class="tag">Winner</span>' : s.alive ? '<span class="pl-alive">Alive</span>' : '<span class="muted">Out wk ' + esc(s.eliminated_week) + (s.reason ? " (" + esc(s.reason) + ")" : "") + "</span>";
        var cells = weeks.map(function (wk) {
          var p = d.spicks.filter(function (x) { return x.week === wk && x.team_id === t.id; })[0];
          if (!p) return '<td class="num muted">' + (s.alive || (s.eliminated_week && wk <= s.eliminated_week) ? "·" : "") + "</td>";
          var r = result(gameOf(wk, p.nfl_team)), cls = r === "pending" ? "" : r === p.nfl_team ? " pl-win" : " pl-loss";
          return '<td class="num' + cls + '" title="' + esc(r === "pending" ? "pending" : r === p.nfl_team ? "won" : r === null ? "tie" : "lost") + (p.source === "commissioner" ? ", set by the commissioner" : "") + '">' + esc(p.nfl_team) + "</td>";
        }).join("");
        var left = session() ? availableTeams(d.spicks, t.id).length : "";
        return "<tr><td>" + esc(t.name) + "</td><td>" + status + "</td>" + cells + '<td class="num">' + esc(left) + "</td></tr>";
      }).join("") + "</tbody></table></div><p class=\"muted small\">Other teams' picks show once their game kicks off. Green won, red lost or tied.</p></div>";

    var mine = myTeam(), pick = "";
    var editTeam = isCommish() ? (st.editTeam || mine || (L.teams[0] || {}).id) : mine;
    var mySt = byTeam[mine] || null;
    if (!isCommish() && mine && open() && (winners.length || (mySt && !mySt.alive))) {
      pick = '<div class="card"><p class="muted">' + (winners.length ? "Survivor is decided for " + esc(season) + "." : "You're out of Survivor (week " + esc(mySt.eliminated_week) + ").") + "</p></div>";
    } else if (editTeam && (open() || isCommish())) {
      var wkGames = d.games.filter(function (g) { return g.week === st.week; });
      var cur = d.spicks.filter(function (x) { return x.week === st.week && x.team_id === editTeam; })[0];
      var avail = availableTeams(d.spicks.filter(function (x) { return !(x.week === st.week && x.team_id === editTeam); }), editTeam);
      var curLocked = cur && started(gameOf(st.week, cur.nfl_team), now);
      pick = '<div class="card"><h3>Week ' + esc(st.week) + " pick" + (editTeam !== mine ? ": " + esc(teamName(editTeam)) : "") + "</h3>" +
        (isCommish() ? '<label class="mt-pick">Team <select data-pl="team">' + (L.teams || []).map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === editTeam ? " selected" : "") + ">" + esc(t.name) + (t.id === mine ? " (your team)" : "") + "</option>"; }).join("") + "</select></label>" : "") +
        (curLocked ? '<p>🔒 ' + esc(cur.nfl_team) + " (game started)</p>" : "") +
        '<div class="pl-games">' + wkGames.map(function (g) {
          var lock = started(g, now) && !(isCommish() && editTeam !== mine);
          var btn = function (t) {
            var usable = avail.indexOf(t) >= 0 || (cur && cur.nfl_team === t);
            return '<button type="button" class="pl-team' + (cur && cur.nfl_team === t ? " on" : "") + '" data-pl="sv" data-nfl="' + esc(t) + '"' + (lock || !usable || curLocked ? " disabled" : "") + ">" + esc(t) + "</button>";
          };
          return '<div class="pl-game">' + btn(g.away) + '<span class="muted small">@</span>' + btn(g.home) + '<span class="muted small pl-kick">' + (started(g, now) ? "🔒 " : "") + esc(fmtKick(g.kickoff)) + "</span></div>";
        }).join("") + "</div>" + msgHtml() + "</div>";
    }
    return '<section class="pl"><h2>Survivor</h2>' + head + pick + board + "</section>";
  }

  // ---- Confidence --------------------------------------------------------------------
  function weekChips() {
    var c = (st.data.pools || {}).confidence || { start_week: 1, end_week: 17 }, out = "";
    for (var w = c.start_week; w <= c.end_week; w++) out += '<button class="wk' + (w === st.week ? " active" : "") + '" data-pl="week" data-week="' + w + '">' + w + "</button>";
    return '<div class="weeks" role="tablist" aria-label="Week">' + out + "</div>";
  }
  function confidenceHtml() {
    var d = st.data, now = Date.now(), w = st.week;
    var games = d.games.filter(function (g) { return g.week === w; }).sort(function (a, b) { return Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0); });
    var head = '<div class="card"><p class="small">Each week pick the winner of every game (straight up) and rank them 1 to N by confidence, each value once. A correct pick earns its points; a miss, a tie or no pick earns 0. Season standings pay Pick\'em 1st and 2nd.</p>' + noteHtml() + "</div>";

    var editor = "";
    var mine = myTeam(), editTeam = isCommish() ? (st.editTeam || mine || (L.teams[0] || {}).id) : mine;
    if (editTeam && (open() || isCommish()) && games.length) {
      if (!st.rows || st.rows.week !== w || st.rows.team !== editTeam) {
        st.rows = { week: w, team: editTeam, list: confidenceRows(games, d.cpicks.filter(function (p) { return p.week === w && p.team_id === editTeam; }), now) };
      }
      var free = isCommish() && editTeam !== mine;
      editor = '<div class="card"><h3>Week ' + esc(w) + " picks" + (editTeam !== mine ? ": " + esc(teamName(editTeam)) : "") + "</h3>" +
        (isCommish() ? '<label class="mt-pick">Team <select data-pl="team">' + (L.teams || []).map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === editTeam ? " selected" : "") + ">" + esc(t.name) + (t.id === mine ? " (your team)" : "") + "</option>"; }).join("") + "</select></label>" : "") +
        '<p class="muted small">Tap a team to pick it. ▲▼ move a game up or down (more or fewer points). Saved as you go; started games stay locked in place.</p>' +
        '<ol class="pl-conf">' + st.rows.list.map(function (r, i) {
          var lock = r.locked && !free;
          var b = function (t) { return '<button type="button" class="pl-team' + (r.pick === t ? " on" : "") + '" data-pl="cpick" data-i="' + i + '" data-nfl="' + esc(t) + '"' + (lock ? " disabled" : "") + ">" + esc(t) + "</button>"; };
          return '<li class="' + (lock ? "locked" : "") + '"><b class="pl-pts">' + esc(r.points) + "</b>" + b(r.game.away) + '<span class="muted small">@</span>' + b(r.game.home) +
            '<span class="pl-move">' + (lock ? "🔒" : '<button type="button" class="linkish" data-pl="up" data-i="' + i + '" aria-label="More points">▲</button><button type="button" class="linkish" data-pl="down" data-i="' + i + '" aria-label="Fewer points">▼</button>') + "</span></li>";
        }).join("") + "</ol>" + msgHtml() + "</div>";
    }

    // Results grid (members see picks once each game kicks off; everyone sees weekly totals)
    var weekScores = {}; d.scores.filter(function (x) { return x.week === w; }).forEach(function (x) { weekScores[x.team_id] = x; });
    var grid = '<div class="card"><h3>Week ' + esc(w) + " results</h3>" + (session() ? "" : '<p class="muted small"><a href="#account">Sign in</a> to see everyone\'s picks (members only).</p>') +
      '<div class="table-wrap"><table class="pl-table pl-grid"><thead><tr><th>Team</th>' + games.map(function (g) {
        var r = result(g);
        return '<th class="num" title="' + esc(fmtKick(g.kickoff)) + '">' + esc(g.away) + "<br>" + esc(g.home) + (r !== "pending" ? '<br><span class="muted small">' + esc(r || "tie") + "</span>" : "") + "</th>";
      }).join("") + '<th class="num">Pts</th></tr></thead><tbody>' + (L.teams || []).slice().sort(function (a, b) {
        return ((weekScores[b.id] || {}).points || 0) - ((weekScores[a.id] || {}).points || 0);
      }).map(function (t) {
        return "<tr><td>" + esc(t.name) + "</td>" + games.map(function (g) {
          var p = d.cpicks.filter(function (x) { return x.week === w && x.team_id === t.id && x.game_key === g.game_key; })[0];
          if (!p) return '<td class="num muted">' + (started(g, now) || !session() ? "–" : "") + "</td>";
          var r = result(g), cls = r === "pending" ? "" : r === p.pick ? " pl-win" : " pl-loss";
          return '<td class="num' + cls + '">' + esc(p.pick) + '<br><span class="small">' + esc(p.points) + "</span></td>";
        }).join("") + '<td class="num"><b>' + esc((weekScores[t.id] || {}).points != null ? weekScores[t.id].points : "–") + "</b></td></tr>";
      }).join("") + "</tbody></table></div></div>";

    var totals = {};
    d.scores.forEach(function (x) { totals[x.team_id] = (totals[x.team_id] || 0) + Number(x.points); });
    var pay = {}; d.awards.filter(function (a) { return a.kind === "pickem"; }).forEach(function (a) { pay[a.team_id] = a; });
    var standings = '<div class="card"><h3>Season standings</h3><ol class="po-rank">' + (L.teams || []).slice().sort(function (a, b) { return (totals[b.id] || 0) - (totals[a.id] || 0); }).map(function (t) {
      var a = pay[t.id];
      return "<li><span>" + esc(t.name) + (a ? ' <span class="muted small">$' + esc(Number(a.amount).toFixed(0)) + " " + (a.status === "final" ? "" : "projected") + "</span>" : "") + "</span><b>" + esc(totals[t.id] || 0) + "</b></li>";
    }).join("") + "</ol></div>";

    return '<section class="pl"><h2>Confidence Pool</h2>' + head + weekChips() + '<div class="po-cols"><div>' + editor + grid + "</div><div>" + standings + "</div></div></section>";
  }

  function msgHtml() { var m = st.msg; st.msg = null; return m ? '<p class="acct-msg ' + (m.err ? "err" : "ok") + '">' + esc(m.err || m.ok) + "</p>" : ""; }
  function render(rootEl) { rootEl.innerHTML = st.page === "survivor" ? survivorHtml() : confidenceHtml(); }

  // ---- Saving ------------------------------------------------------------------------
  var friendly = function (e) { return String(e || "").replace(/^.*?: /, ""); };
  function saveConfidence(rootEl) {
    var r = st.rows, mine = myTeam(), free = isCommish() && r.team !== mine;
    var picks = r.list.filter(function (x) { return x.pick && (free || !x.locked); }).map(function (x) { return { game_key: x.game.game_key, pick: x.pick, points: x.points }; });
    if (!picks.length) { render(rootEl); return; }
    api("rpc/save_confidence", { method: "POST", body: JSON.stringify({ p_season: season, p_week: r.week, p_team: r.team, p_picks: picks }) }).then(function (res) {
      st.msg = res.ok ? { ok: "Saved." } : { err: "Not saved: " + friendly(res.error) };
      return load().then(function () { if (!res.ok) st.rows = null; render(rootEl); });
    });
  }

  function start(page, rootEl) {
    st.page = page;
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Pools</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section><h2>' + (page === "survivor" ? "Survivor" : "Confidence Pool") + '</h2><p class="muted">Loading…</p></section>';
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (me) { st.me = me; if (root.B5Account) root.B5Account.refreshNav(); return load(); })
      .then(function () { render(rootEl); }, function (e) { rootEl.innerHTML = '<section><h2>Pools</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });

    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-pl]"); if (!b || b.tagName === "SELECT") return;
      var k = b.dataset.pl;
      if (k === "week") { st.week = Number(b.dataset.week); st.rows = null; render(rootEl); return; }
      if (k === "sv") {
        var team = isCommish() ? (st.editTeam || myTeam() || L.teams[0].id) : myTeam();
        api("survivor_picks?on_conflict=season,week,team_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ season: season, week: st.week, team_id: team, nfl_team: b.dataset.nfl }]) }).then(function (res) {
          st.msg = res.ok ? { ok: "Week " + st.week + ": " + b.dataset.nfl + " saved." } : { err: "Not saved: " + friendly(res.error) };
          return load().then(function () { render(rootEl); });
        });
        return;
      }
      if (!st.rows) return;
      var i = Number(b.dataset.i);
      if (k === "cpick") { st.rows.list[i].pick = b.dataset.nfl; saveConfidence(rootEl); }
      else if (k === "up" || k === "down") { st.rows.list = moveRow(st.rows.list, i, k === "up" ? -1 : 1); saveConfidence(rootEl); }
    });
    rootEl.addEventListener("change", function (e) {
      var s = e.target.closest("[data-pl='team']"); if (!s) return;
      st.editTeam = s.value; st.rows = null; render(rootEl);
    });
  }

  root.B5Pools = { start: start, result: result, availableTeams: availableTeams, confidenceRows: confidenceRows, moveRow: moveRow };
})(typeof globalThis !== "undefined" ? globalThis : this);
