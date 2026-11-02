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
  var TL = function () { return root.B5Team; };   // team names and profile links (teamlink.js)
  var tlink = function (id) { return TL().link(id, { logo: false }); };
  var teamList = function () { return TL().ids().map(function (id) { return { id: id }; }); };
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

  // ---- Game cards: records, line, kickoff, stadium, forecast (public.nfl_game_info; info only) ----
  var ET = function (iso, o) { return new Date(iso).toLocaleString("en-US", Object.assign({ timeZone: "America/New_York" }, o)); };
  /** "(5-2)", "(4-2-1)", or "" when unknown. */
  function recordText(rec) { return rec && /^\d+-\d+(-\d+)?$/.test(rec) ? "(" + rec + ")" : ""; }
  /** "KC -3.5 · O/U 47.5", or "Line not posted". */
  function lineText(info) {
    if (!info || (!info.spread && info.over_under == null)) return "Line not posted";
    return [info.spread, info.over_under != null ? "O/U " + Number(info.over_under) : null].filter(Boolean).join(" · ");
  }
  /** "DraftKings via ESPN, as of Thu 11:00 AM ET". */
  function lineSource(info) {
    return info && info.odds_at ? (info.odds_provider ? info.odds_provider + " via ESPN" : "ESPN") + ", as of " + ET(info.odds_at, { weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET" : "";
  }
  /** "Sun 11/1, 1:00 PM ET · London". */
  function kickoffText(g, info) {
    if (!g || !g.kickoff) return "Kickoff TBD";
    return ET(g.kickoff, { weekday: "short", month: "numeric", day: "numeric" }) + ", " + ET(g.kickoff, { hour: "numeric", minute: "2-digit" }) + " ET" + (info && info.intl ? " · " + info.intl : "");
  }
  /** "Dome · turf", "Retractable roof · grass", "Outdoor · grass". */
  function venueText(info) {
    if (!info || !info.roof) return "";
    return { dome: "Dome", retractable: "Retractable roof", outdoor: "Outdoor" }[info.roof] + (info.surface ? " · " + info.surface : "");
  }
  /** What makes the weather matter: wind 15+ mph, heavy rain/snow, 25°F or colder. */
  function weatherAlerts(w) {
    if (!w) return [];
    var out = [];
    if (w.wind_mph != null && w.wind_mph >= 15) out.push("wind " + w.wind_mph + " mph");
    if (w.heavy) out.push(String(w.condition || "heavy rain/snow").toLowerCase());
    if (w.temp_f != null && w.temp_f <= 25) out.push(w.temp_f + "°F");
    return out;
  }
  /** The forecast line: "Indoors" for domes; else icon, temperature, wind, chance of precip. */
  function weatherText(info) {
    if (!info) return "";
    if (info.roof === "dome") return "Indoors";
    var w = info.weather;
    if (!w) return "Forecast not posted yet";
    return [(w.icon || "") + (w.temp_f != null ? " " + w.temp_f + "°F" : "") + (w.condition ? " " + w.condition : ""), w.wind_mph != null ? "wind " + w.wind_mph + " mph" : null,
      w.precip_pct != null ? w.precip_pct + "% precip" : null].filter(Boolean).join(", ").trim() + (info.roof === "retractable" ? " (roof may close)" : "");
  }
  /** Started games: "KC 17 – BUF 14 · 3rd 4:12" (away first), "Final: ..." once over. */
  function scoreText(g) {
    if (!g || g.home_score == null || g.away_score == null) return "";
    var line = g.away + " " + g.away_score + " – " + g.home + " " + g.home_score;
    return g.status === "final" ? "Final: " + line : line + (g.status_detail ? " · " + g.status_detail : "");
  }
  /** One card's second row (kickoff · stadium · weather, or the score once started) with the weather flagged when it matters. */
  function gameMetaHtml(g, info, now) {
    var w = info && info.roof !== "dome" ? info.weather : null, alerts = weatherAlerts(w);
    var bits = [started(g, now) && scoreText(g) ? '<b class="pl-score">' + esc(scoreText(g)) + "</b>" : esc(kickoffText(g, info))];
    if (venueText(info)) bits.push('<span title="' + esc(info.venue_name || "") + '">' + esc(venueText(info)) + "</span>");
    if (info) bits.push('<span class="pl-wx' + (alerts.length ? " alert" : "") + '" title="' + esc(w && info.weather_at ? "Forecast as of " + ET(info.weather_at, { weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET (" + (w.source || "") + ")" : "") + '">' +
      (alerts.length ? "⚠ " : "") + esc(weatherText(info)) + "</span>");
    return '<div class="pl-gmeta small">' + bits.join(" · ") + "</div>";
  }
  function teamLabel(t, rec) { return esc(t) + (rec ? ' <span class="pl-rec">' + esc(recordText(rec)) + "</span>" : ""); }
  /** Footnote: where lines and forecasts come from and when. */
  function sourcesHtml(infos) {
    var line = infos.filter(function (i) { return i.odds_at; }).sort(function (a, b) { return Date.parse(b.odds_at) - Date.parse(a.odds_at); })[0];
    var wx = infos.filter(function (i) { return i.weather_at; }).sort(function (a, b) { return Date.parse(b.weather_at) - Date.parse(a.weather_at); })[0];
    var srcs = {}; infos.forEach(function (i) { if (i.weather && i.weather.source) i.weather.source.split(", ").forEach(function (x) { srcs[x] = 1; }); });
    return '<p class="muted small pl-sources">' + (line ? "Lines: " + esc(lineSource(line)) + ". " : "Lines not posted yet. ") + "Info only: picks are straight up. " +
      (wx ? "Forecast as of " + esc(ET(wx.weather_at, { weekday: "short", hour: "numeric", minute: "2-digit" })) + " ET (" + esc(Object.keys(srcs).join(", ")) + "). " : "") +
      "⚠ = wind 15+ mph, heavy rain or snow, or 25°F and colder.</p>";
  }
  /** Teams a Survivor entry can still pick (never reused). */
  function availableTeams(picks, teamId) {
    var used = {};
    picks.forEach(function (p) { if (p.team_id === teamId) used[p.nfl_team] = true; });
    return NFL.filter(function (t) { return !used[t]; });
  }
  // ---- Confidence editor (2026-11-01): games always in kickoff order, a dropdown per game ----
  /** Kickoff order (Thursday -> Monday), never reordered; same kickoff: alphabetical by away team. */
  function kickoffOrder(games) {
    return (games || []).slice().sort(function (a, b) {
      return (Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0)) || String(a.away).localeCompare(String(b.away));
    });
  }
  var gameName = function (g) { return g.away + " vs " + g.home; };
  /** One row per game in kickoff order: { game, pick, points, locked }; blanks stay blank (null). */
  function confidenceRows(games, picks, now) {
    var byGame = {};
    (picks || []).forEach(function (p) { byGame[p.game_key] = p; });
    return kickoffOrder(games).map(function (g) {
      var p = byGame[g.game_key];
      return { game: g, pick: p && p.pick || null, points: p && p.points != null ? Number(p.points) : null, locked: started(g, now) };
    });
  }
  /** Set row i's confidence to v (null = blank). A value already used on another game SWAPS: that
      game gets row i's previous value (or blank). Locked games never change and their values can't
      be taken. Returns { rows, swapped: { i, points } | null, error }. */
  function setPoints(rows, i, v) {
    v = v === "" || v == null ? null : Number(v);
    if (!rows[i] || rows[i].locked) return { rows: rows, swapped: null, error: "That game has kicked off: it's locked." };
    var j = v == null ? -1 : rows.map(function (r) { return r.points; }).indexOf(v);
    if (j === i) return { rows: rows, swapped: null, error: null };
    if (j >= 0 && rows[j].locked) return { rows: rows, swapped: null, error: v + " is locked on " + gameName(rows[j].game) + "." };
    var out = rows.map(function (r) { return Object.assign({}, r); }), swapped = null;
    if (j >= 0) { out[j].points = out[i].points; swapped = { i: j, points: out[j].points }; }
    out[i].points = v;
    return { rows: out, swapped: swapped, error: null };
  }
  /** "Swapped: KC vs DEN is now 7." (or "... is now blank."). */
  function swapText(rows, sw) { return sw ? "Swapped: " + gameName(rows[sw.i].game) + " is now " + (sw.points == null ? "blank" : sw.points) + "." : ""; }
  /** Values 1..n nobody has used yet. */
  function unusedValues(rows, n) {
    var used = {}; rows.forEach(function (r) { if (r.points != null) used[r.points] = true; });
    var out = []; for (var v = 1; v <= n; v++) if (!used[v]) out.push(v);
    return out;
  }
  /** Open games still missing a winner or a confidence value (they'd score 0). */
  function needingPick(rows) { return rows.filter(function (r) { return !r.locked && (!r.pick || r.points == null); }).length; }
  /** "Fill remaining values": the unused numbers, lowest first, to the open games without one, in kickoff order. */
  function fillRemaining(rows, n) {
    var free = unusedValues(rows, n);
    return rows.map(function (r) { var o = Object.assign({}, r); if (!o.locked && o.points == null && free.length) o.points = free.shift(); return o; });
  }
  /** The dropdown's options for row i: blank, then 1..n; a value used elsewhere is labeled with its
      game ("12 — used on KC vs DEN"); one locked on a started game can't be picked. */
  function optionsFor(rows, i, n) {
    var by = {}; rows.forEach(function (r, k) { if (r.points != null && k !== i) by[r.points] = r; });
    var out = [{ value: "", label: "—", disabled: false }];
    for (var v = 1; v <= n; v++) {
      var r = by[v];
      out.push({ value: String(v), label: r ? v + " — " + (r.locked ? "locked on " : "used on ") + gameName(r.game) : String(v), disabled: !!(r && r.locked) });
    }
    return out;
  }
  /** What a save sends: every row with a winner or a value (blank rows are cleared on the server). */
  function savePayload(rows) {
    return rows.filter(function (r) { return r.pick || r.points != null; }).map(function (r) { return { game_key: r.game.game_key, pick: r.pick, points: r.points }; });
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
      api("nfl_games" + q + "&select=week,game_key,home,away,kickoff,home_score,away_score,status,status_detail&order=kickoff&limit=1000"),
      api("survivor_status" + q + "&select=team_id,alive,eliminated_week,reason,winner,picks_used"),
      api("confidence_scores" + q + "&select=week,team_id,points,correct,decided,games&limit=1000"),
      api("awards" + q + "&kind=in.(survivor,pickem)&select=kind,place,team_id,amount,status,source")
    ];
    if (session()) {
      reqs.push(api("survivor_picks" + q + "&select=week,team_id,nfl_team,source&limit=1000"));
      reqs.push(api("confidence_picks" + q + "&select=week,team_id,game_key,pick,points,source,updated_at,set_by&limit=1000"));
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
      // Records, lines, stadiums and forecasts for the week shown (written by server jobs)
      // Who saved the picks ("Saved 9:14 PM by Mike"): members read profiles
      var savers = {}; st.data.cpicks.forEach(function (p) { if (p.set_by) savers[p.set_by] = true; });
      var ids = Object.keys(savers);
      st.data.names = {};
      var names = ids.length && session() ? api("profiles?id=in.(" + ids.join(",") + ")&select=id,display_name").then(function (x) { ok(x).forEach(function (p) { st.data.names[p.id] = p.display_name || ""; }); }) : Promise.resolve();
      return Promise.all([api("nfl_game_info" + q + "&week=eq." + st.week + "&select=*"), names]).then(function (rr) {
        var r = rr[0];
        st.data.info = {}; ok(r).forEach(function (x) { st.data.info[x.game_key] = x; });
      });
    });
  }
  // season_settings.pools.mode: "test" (2026: Confidence test picks; MFL official) | "official" (site picks are real)
  var mode = function () { return (st.data && st.data.pools && st.data.pools.mode) || "closed"; };
  var open = function () { return st.page === "survivor" ? mode() === "official" : mode() === "test" || mode() === "official"; };
  var noteHtml = function () {
    if (st.page === "confidence" && mode() === "test") {
      return '<p class="pl-test"><b>TEST picks — MFL is official for ' + esc(season) + ".</b> Try picking here for the current week; every Tuesday at 6 AM ET the official MFL picks replace them for the week that just finished.</p>";
    }
    return mode() === "official" ? "" : '<p class="muted small">MFL is official for ' + esc(season) + ": picks are mirrored from MFL, read-only here. Picking opens on this site in " + esc(season + 1) + ".</p>";
  };

  /** Points a set of picks earns from the games' final results (test picks, shown but never stored). */
  function testScore(picks, games) {
    return picks.reduce(function (s, p) {
      var g = games.filter(function (x) { return x.game_key === p.game_key; })[0], r = result(g);
      return s + (r !== "pending" && r !== null && r === p.pick ? Number(p.points) : 0);
    }, 0);
  }

  // The two pools are tabs in the page head (nav.js: Confidence Pool | Survivor).
  var poolTabs = function () { return ""; };

  // ---- Survivor ----------------------------------------------------------------------
  function survivorHtml() {
    var d = st.data, now = Date.now(), cfgS = (d.pools || {}).survivor || { start_week: 1, end_week: 17 };
    var byTeam = {}; d.survivor.forEach(function (s) { byTeam[s.team_id] = s; });
    var winners = d.survivor.filter(function (s) { return s.winner; });
    var prize = d.awards.filter(function (a) { return a.kind === "survivor"; });
    var head = '<div class="card">' +
      (winners.length || prize.length ? '<p class="acct-msg ok"><b>' + (prize.length ? prize : winners).map(function (x) { return tlink(x.team_id); }).join(" & ") + "</b> " +
        (prize.length ? "won Survivor: " + prize.map(function (a) { return "$" + Number(a.amount).toFixed(0); }).join(" + ") : "won Survivor") + "</p>" : "") +
      '<p class="small">Pick one NFL team to win each week (weeks ' + esc(cfgS.start_week) + "–" + esc(cfgS.end_week) + "), never the same team twice. A loss, a tie or no pick by the week's last kickoff knocks you out. Last team standing wins; if everyone left goes out the same week, they split.</p>" +
      noteHtml() + "</div>";

    var weeks = [];
    for (var w = cfgS.start_week; w <= Math.min(cfgS.end_week, st.week || cfgS.start_week); w++) weeks.push(w);
    var gameOf = function (wk, t) { return d.games.filter(function (g) { return g.week === wk && (g.home === t || g.away === t); })[0]; };
    var order = teamList().sort(function (a, b) {
      var sa = byTeam[a.id] || {}, sb = byTeam[b.id] || {};
      return (sb.winner ? 2 : sb.alive ? 1 : 0) - (sa.winner ? 2 : sa.alive ? 1 : 0) || (sb.eliminated_week || 99) - (sa.eliminated_week || 99) || TL().name(a.id).localeCompare(TL().name(b.id));
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
        return "<tr><td>" + tlink(t.id) + "</td><td>" + status + "</td>" + cells + '<td class="num">' + esc(left) + "</td></tr>";
      }).join("") + "</tbody></table></div><p class=\"muted small\">Other teams' picks show once their game kicks off. Green won, red lost or tied.</p></div>";

    var mine = myTeam(), pick = "";
    var editTeam = isCommish() ? (st.editTeam || mine || TL().ids()[0]) : mine;
    var mySt = byTeam[mine] || null;
    if (!isCommish() && mine && open() && (winners.length || (mySt && !mySt.alive))) {
      pick = '<div class="card"><p class="muted">' + (winners.length ? "Survivor is decided for " + esc(season) + "." : "You're out of Survivor (week " + esc(mySt.eliminated_week) + ").") + "</p></div>";
    } else if (editTeam && (open() || isCommish())) {
      var wkGames = d.games.filter(function (g) { return g.week === st.week; });
      var cur = d.spicks.filter(function (x) { return x.week === st.week && x.team_id === editTeam; })[0];
      var avail = availableTeams(d.spicks.filter(function (x) { return !(x.week === st.week && x.team_id === editTeam); }), editTeam);
      var curLocked = cur && started(gameOf(st.week, cur.nfl_team), now);
      pick = '<div class="card"><h3>Week ' + esc(st.week) + " pick" + (editTeam !== mine ? ": " + tlink(editTeam) : "") + "</h3>" +
        (isCommish() ? '<label class="mt-pick">Team <select data-pl="team">' + TL().ids().map(function (id) { return TL().option(id, id === editTeam, id === mine ? " (your team)" : ""); }).join("") + "</select></label>" : "") +
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
    return '<section class="pl"><h2>Survivor</h2>' + poolTabs("survivor") + head + pick + board + "</section>";
  }

  // ---- Confidence --------------------------------------------------------------------
  function weekChips() {
    var c = (st.data.pools || {}).confidence || { start_week: 1, end_week: 17 }, out = "";
    // Links, not buttons: the week lives in the URL (#confidence/7), so it survives a reload and never leaves the pool.
    for (var w = c.start_week; w <= c.end_week; w++) out += '<a class="wk' + (w === st.week ? " active" : "") + '" href="#confidence/' + w + '" aria-label="Week ' + w + '">' + w + "</a>";
    return '<div class="weeks" aria-label="Week">' + out + "</div>";
  }
  function gamesListHtml(games, now) {
    var d = st.data;
    if (!games.length) return "";
    return '<div class="card"><h3>Week ' + esc(st.week) + ' games</h3><ul class="pl-conf pl-glist">' + games.map(function (g) {
      var info = (d.info || {})[g.game_key];
      return '<li class="pl-gcard' + (started(g, now) ? " locked" : "") + '"><div class="pl-gline"><span class="pl-teamtxt">' + teamLabel(g.away, info && info.away_record) + '</span><span class="muted small">@</span>' +
        '<span class="pl-teamtxt">' + teamLabel(g.home, info && info.home_record) + '</span><span class="pl-line" title="' + esc(lineSource(info)) + '">' + esc(lineText(info)) + "</span></div>" + gameMetaHtml(g, info, now) + "</li>";
    }).join("") + "</ul>" + sourcesHtml(games.map(function (g) { return (d.info || {})[g.game_key]; }).filter(Boolean)) + "</div>";
  }
  function confidenceHtml() {
    var d = st.data, now = Date.now(), w = st.week;
    var games = kickoffOrder(d.games.filter(function (g) { return g.week === w; }));
    var head = '<div class="card"><p class="small">Each week pick the winner of every game (straight up) and give each a confidence value from 1 to N, each value once. A correct pick earns its points; a miss, a tie or no pick earns 0. Season standings pay Pick\'em 1st and 2nd.</p>' + noteHtml() + "</div>";

    var editor = "";
    var mine = myTeam(), editTeam = isCommish() ? (st.editTeam || mine || TL().ids()[0]) : mine;
    var officialWeek = d.cpicks.some(function (p) { return p.week === w && p.source === "mfl"; });
    if (officialWeek && session()) {
      editor = '<div class="card"><p class="muted">Week ' + esc(w) + " has the official MFL picks (read-only).</p></div>";
    } else if (editTeam && (open() || isCommish()) && games.length) {
      var free = isCommish() && editTeam !== mine;   // the commissioner fixing another team: nothing is locked for him
      if (!st.rows || st.rows.week !== w || st.rows.team !== editTeam) {
        var saved = d.cpicks.filter(function (p) { return p.week === w && p.team_id === editTeam; });
        var lastP = saved.slice().sort(function (a, b) { return Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0); })[0];
        st.rows = { week: w, team: editTeam, list: confidenceRows(games, saved, free ? 0 : now), dirty: false, notice: null,
          saved: lastP ? { at: lastP.updated_at, by: (d.names || {})[lastP.set_by] || "" } : null };
      }
      var n = games.length, rows = st.rows.list, unused = unusedValues(rows, n), need = needingPick(rows);
      var savedText = st.rows.saved ? "Saved " + fmtKick(st.rows.saved.at) + (st.rows.saved.by ? " by " + st.rows.saved.by : "") : "Not saved yet";
      editor = '<div class="card"><h3>Week ' + esc(w) + " picks" + (editTeam !== mine ? ": " + tlink(editTeam) : "") + "</h3>" +
        (isCommish() ? '<label class="mt-pick">Team <select data-pl="team">' + TL().ids().map(function (id) { return TL().option(id, id === editTeam, id === mine ? " (your team)" : ""); }).join("") + "</select></label>" : "") +
        (mode() === "test" ? '<p class="pl-test small"><b>TEST picks</b> — MFL is official for ' + esc(season) + ".</p>" : "") +
        '<p class="muted small">Games are in kickoff order. Tap the team you think wins, then choose how confident you are (1 to ' + esc(n) + ', each number once). Picking a number another game has swaps the two. A game locks at its kickoff.</p>' +
        '<ol class="pl-conf pl-dd">' + rows.map(function (r, i) {
          var info = (d.info || {})[r.game.game_key];
          var b = function (t, rec) { return '<button type="button" class="pl-team' + (r.pick === t ? " on" : "") + '" data-pl="cpick" data-i="' + i + '" data-nfl="' + esc(t) + '" aria-pressed="' + (r.pick === t) + '"' + (r.locked ? " disabled" : "") + ">" + teamLabel(t, rec) + "</button>"; };
          var sel = '<label class="pl-cf"><span>' + (r.locked ? "🔒 " : "") + 'Confidence</span><select data-pl="points" data-i="' + i + '"' + (r.locked ? " disabled" : "") + ' aria-label="Confidence for ' + esc(gameName(r.game)) + '">' +
            optionsFor(rows, i, n).map(function (o) { return '<option value="' + esc(o.value) + '"' + (String(r.points == null ? "" : r.points) === o.value ? " selected" : "") + (o.disabled ? " disabled" : "") + ">" + esc(o.label) + "</option>"; }).join("") + "</select></label>";
          return '<li class="pl-gcard' + (r.locked ? " locked" : "") + '"><div class="pl-gline">' + b(r.game.away, info && info.away_record) + '<span class="muted small">@</span>' + b(r.game.home, info && info.home_record) +
            '<span class="pl-line" title="' + esc(lineSource(info)) + '">' + esc(lineText(info)) + "</span></div>" + sel + gameMetaHtml(r.game, info, now) + "</li>";
        }).join("") + "</ol>" + sourcesHtml(games.map(function (g) { return (d.info || {})[g.game_key]; }).filter(Boolean)) +
        '<div class="pl-savebar">' + (st.rows.notice ? '<p class="acct-msg ok" role="status">' + esc(st.rows.notice) + "</p>" : "") +
          '<p><b>Unused points:</b> ' + esc(unused.length ? unused.join(", ") : "none") + ' · <b>Games still needing a pick:</b> ' + esc(need) + "</p>" +
          (need ? '<p class="pl-warn small">⚠ A game without a winner or a confidence value scores 0. You can still save.</p>' : "") +
          '<div class="pl-saveacts"><button type="button" class="btn ghost" data-pl="fill"' + (unused.length ? "" : " disabled") + ">Fill remaining values</button>" +
          '<button type="button" class="btn" data-pl="save">Save picks</button></div>' +
          '<p class="muted small">' + esc(st.rows.dirty ? "Unsaved changes" : savedText) + "</p>" + msgHtml() + "</div></div>";
    }
    // No pick list (signed out, or an official MFL week): the same game cards, read-only.
    if (!editor || officialWeek) editor += gamesListHtml(games, now);

    // Results grid (members see picks once each game kicks off; everyone sees weekly totals)
    var weekScores = {}; d.scores.filter(function (x) { return x.week === w; }).forEach(function (x) { weekScores[x.team_id] = x; });
    // Official weeks: the stored score. A team with TEST picks this week: their test total, worked out here (never stored or paid).
    var weekTotal = function (teamId) {
      var mine = d.cpicks.filter(function (p) { return p.week === w && p.team_id === teamId; });
      if (mine.length && mine.every(function (p) { return p.source === "test"; })) {
        return testScore(mine, games) + " (test)";
      }
      return (weekScores[teamId] || {}).points != null ? weekScores[teamId].points : "–";
    };
    var grid = '<div class="card"><h3>Week ' + esc(w) + " results</h3>" + (session() ? "" : '<p class="muted small"><a href="#account">Sign in</a> to see everyone\'s picks (members only).</p>') +
      '<div class="table-wrap"><table class="pl-table pl-grid"><thead><tr><th>Team</th>' + games.map(function (g) {
        var r = result(g);
        return '<th class="num" title="' + esc(fmtKick(g.kickoff)) + '">' + esc(g.away) + "<br>" + esc(g.home) + (r !== "pending" ? '<br><span class="muted small">' + esc(r || "tie") + "</span>" : "") + "</th>";
      }).join("") + '<th class="num">Pts</th></tr></thead><tbody>' + teamList().sort(function (a, b) {
        return ((weekScores[b.id] || {}).points || 0) - ((weekScores[a.id] || {}).points || 0);
      }).map(function (t) {
        return "<tr><td>" + tlink(t.id) + "</td>" + games.map(function (g) {
          var p = d.cpicks.filter(function (x) { return x.week === w && x.team_id === t.id && x.game_key === g.game_key; })[0];
          if (!p) return '<td class="num muted">' + (started(g, now) || !session() ? "–" : "") + "</td>";
          var r = result(g), cls = r === "pending" ? "" : r === p.pick ? " pl-win" : " pl-loss";
          return '<td class="num' + cls + (p.source === "test" ? " pl-testpick" : "") + '"' + (p.source === "test" ? ' title="test pick"' : "") + ">" + esc(p.pick) + '<br><span class="small">' + esc(p.points) + "</span></td>";
        }).join("") + '<td class="num"><b>' + esc(weekTotal(t.id)) + "</b></td></tr>";
      }).join("") + "</tbody></table></div></div>";

    var totals = {};
    d.scores.forEach(function (x) { totals[x.team_id] = (totals[x.team_id] || 0) + Number(x.points); });
    var pay = {}; d.awards.filter(function (a) { return a.kind === "pickem"; }).forEach(function (a) { pay[a.team_id] = a; });
    var standings = '<div class="card"><h3>Season standings</h3><ol class="po-rank">' + teamList().sort(function (a, b) { return (totals[b.id] || 0) - (totals[a.id] || 0); }).map(function (t) {
      var a = pay[t.id];
      return "<li><span>" + tlink(t.id) + (a ? ' <span class="muted small">$' + esc(Number(a.amount).toFixed(0)) + " " + (a.status === "final" ? "" : "projected") + "</span>" : "") + "</span><b>" + esc(totals[t.id] || 0) + "</b></li>";
    }).join("") + "</ol></div>";

    return '<section class="pl"><h2>Confidence Pool</h2>' + poolTabs("confidence") + head + weekChips() + '<div class="po-cols"><div>' + editor + grid + "</div><div>" + standings + "</div></div></section>";
  }

  function msgHtml() { var m = st.msg; st.msg = null; return m ? '<p class="acct-msg ' + (m.err ? "err" : "ok") + '">' + esc(m.err || m.ok) + "</p>" : ""; }
  function render(rootEl) { rootEl.innerHTML = st.page === "survivor" ? survivorHtml() : confidenceHtml(); }

  // ---- Saving ------------------------------------------------------------------------
  var friendly = function (e) { return String(e || "").replace(/^.*?: /, ""); };
  function saveConfidence(rootEl) {
    var r = st.rows;
    api("rpc/save_confidence_week", { method: "POST", body: JSON.stringify({ p_season: season, p_week: r.week, p_team: r.team, p_picks: savePayload(r.list) }) }).then(function (res) {
      if (!res.ok) { st.msg = { err: "Not saved: " + friendly(res.error) }; render(rootEl); return; }
      st.msg = { ok: "Saved." };
      var who = res.data || {};
      return load().then(function () { st.rows = null; render(rootEl); if (st.rows) { st.rows.saved = { at: who.saved_at, by: who.saved_by || "" }; render(rootEl); } });
    });
  }
  var LEAVE = "Your Confidence picks have unsaved changes. Leave without saving?";
  /** True while the pick editor holds changes that aren't saved (app.js asks before leaving). */
  function dirty() { return !!(st.rows && st.rows.dirty && st.el && root.document && root.document.body.contains(st.el)); }
  if (root.addEventListener) root.addEventListener("beforeunload", function (e) { if (dirty()) { e.preventDefault(); e.returnValue = LEAVE; } });

  function start(page, rootEl, week) {
    st.page = page; st.el = rootEl;
    if (week) { st.week = Number(week); st.rows = null; }
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Pools</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section><h2>' + (page === "survivor" ? "Survivor" : "Confidence Pool") + '</h2><p class="muted">Loading…</p></section>';
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (me) { st.me = me; if (root.B5Account) root.B5Account.refreshNav(); return load(); })
      .then(function () { render(rootEl); }, function (e) { rootEl.innerHTML = '<section><h2>Pools</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });

    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-pl]"); if (!b || b.tagName === "SELECT") return;
      var k = b.dataset.pl;
      if (k === "sv") {
        var team = isCommish() ? (st.editTeam || myTeam() || TL().ids()[0]) : myTeam();
        api("survivor_picks?on_conflict=season,week,team_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ season: season, week: st.week, team_id: team, nfl_team: b.dataset.nfl }]) }).then(function (res) {
          st.msg = res.ok ? { ok: "Week " + st.week + ": " + b.dataset.nfl + " saved." } : { err: "Not saved: " + friendly(res.error) };
          return load().then(function () { render(rootEl); });
        });
        return;
      }
      if (!st.rows) return;
      var i = Number(b.dataset.i), row = st.rows.list[i];
      if (k === "cpick" && row && !row.locked) {
        row.pick = row.pick === b.dataset.nfl ? null : b.dataset.nfl;   // tap the picked team again to clear it
        st.rows.dirty = true; st.rows.notice = null; render(rootEl);
      } else if (k === "fill") {
        st.rows.list = fillRemaining(st.rows.list, st.rows.list.length); st.rows.dirty = true; st.rows.notice = "Filled the unused values in kickoff order. Adjust any you like."; render(rootEl);
      } else if (k === "save") saveConfidence(rootEl);
    });
    rootEl.addEventListener("change", function (e) {
      var p = e.target.closest("[data-pl='points']");
      if (p && st.rows) {
        var res = setPoints(st.rows.list, Number(p.dataset.i), p.value);
        if (res.error) { st.msg = { err: res.error }; render(rootEl); return; }
        st.rows.list = res.rows; st.rows.dirty = true; st.rows.notice = swapText(res.rows, res.swapped) || null;
        render(rootEl);
        var again = rootEl.querySelector('[data-pl="points"][data-i="' + p.dataset.i + '"]'); if (again) again.focus();
        return;
      }
      var s = e.target.closest("[data-pl='team']"); if (!s) return;
      if (dirty() && !root.confirm(LEAVE)) { s.value = st.rows.team; return; }
      st.editTeam = s.value; st.rows = null; render(rootEl);
    });
  }

  root.B5Pools = { start: start, testScore: testScore, weekChipsHtml: function (cfgC, week) { st.data = st.data || { pools: { confidence: cfgC } }; st.week = week; return weekChips(); }, result: result, availableTeams: availableTeams, confidenceRows: confidenceRows, kickoffOrder: kickoffOrder, setPoints: setPoints, swapText: swapText, unusedValues: unusedValues, needingPick: needingPick,
    fillRemaining: fillRemaining, optionsFor: optionsFor, savePayload: savePayload, dirty: dirty, LEAVE: LEAVE,
    recordText: recordText, lineText: lineText, lineSource: lineSource, kickoffText: kickoffText, venueText: venueText, weatherText: weatherText, weatherAlerts: weatherAlerts, scoreText: scoreText, gameMetaHtml: gameMetaHtml };
})(typeof globalThis !== "undefined" ? globalThis : this);
