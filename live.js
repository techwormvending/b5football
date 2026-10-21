/* Live Scoring page (#live, #live/<week>, #live/<week>/<away>-<home>; old #matchup/... links land here).
   Scoreboard: every matchup of the week with live totals, who's leading and how many starters are
   done / playing / to go; the week's NFL games strip. Matchup detail: both lineups in slot order
   (QB RB RB WR WR WR TE K DEF), then the bench (points shown, not counted); tap a player for the
   points breakdown; the scoring-play feed (big plays highlighted).
   Public read, no sign-in. Each starter is revealed at his game's kickoff (public.live_lineups);
   his team's managers and the commissioner see their lineup in full.
   Only the Edge Function b5-live talks to ESPN. This page reads the database and subscribes to
   Supabase Realtime on score_weeks (one row per live pass), then re-reads the week. The
   breakdown lines come from the scoring engine (player_scores.lines, src/scoring/explain.ts);
   nothing is recalculated here. All data is escaped. */
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
  var SLOTS = L.lineupSlots || ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
  var STALE_MS = 3 * 60000, WINDOW_MS = 4.5 * 3600000, BIG = 6;
  var teamById = function (id) { return (L.teams || []).filter(function (t) { return t.id === id; })[0] || { id: id, name: id }; };
  var fmtKick = function (iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : ""; };
  var fmtTime = function (iso) { return iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : ""; };
  var pts = function (x) { var r = Math.round(Number(x || 0) * 100) / 100; return r.toFixed(Math.round(r * 100) % 10 ? 2 : 1); };
  var num = function (x) { return String(Math.round(Number(x || 0) * 100) / 100); };   // breakdown lines: "→ 10", "→ 4.7"
  var initials = function (n) { return String(n || "").split(/\s+/).filter(function (w) { return w && !/^the$/i.test(w); }).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase(); };
  var logo = function (t) {
    return t.logo ? '<img class="logo sm" src="' + esc(t.logo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<div class=&quot;logo sm&quot;>' + esc(initials(t.name)) + '</div>\'">'
      : '<div class="logo sm">' + esc(initials(t.name)) + "</div>";
  };

  // ---- Pure helpers (tested in src/workers/live-page.test.ts) ------------------------
  /** One NFL game's state: "pre" (not kicked off), "live", "final". */
  function gameState(g, now) {
    if (!g) return "bye";
    if (g.status === "final") return "final";
    if (g.status === "in_progress" || (g.kickoff && Date.parse(g.kickoff) <= now)) return "live";
    return "pre";
  }
  /** The game a team plays this week, by NFL team code. */
  function gameFor(games, nfl) {
    for (var i = 0; i < games.length; i++) if (nfl && (games[i].home === nfl || games[i].away === nfl)) return games[i];
    return null;
  }
  /** A player's game line: state, opponent ("vs ARI" / "@ ARI") and status (clock, kickoff time, Final, Bye). */
  function playerGame(games, nfl, now) {
    var g = gameFor(games, nfl), s = gameState(g, now);
    if (!g) return { state: "bye", opp: "", text: "Bye", game: null };
    var opp = g.home === nfl ? "vs " + g.away : "@ " + g.home;
    var text = s === "final" ? "Final" : s === "live" ? (g.status_detail || (g.period ? "Q" + g.period + " " + (g.clock || "") : "Live")) : fmtKick(g.kickoff);
    return { state: s, opp: opp, text: text, game: g };
  }
  /** Starters done / playing / to go. Hidden starters (not yet revealed) are still to go; a bye counts as done. */
  function progress(starters, games, now) {
    var p = { done: 0, playing: 0, toGo: 0 };
    starters.forEach(function (s) {
      if (!s.revealed) { p.toGo++; return; }
      var st = playerGame(games, s.nfl_team, now).state;
      if (st === "final" || st === "bye") p.done++; else if (st === "live") p.playing++; else p.toGo++;
    });
    return p;
  }
  var progressText = function (p) { return p.done + " done · " + p.playing + " playing · " + p.toGo + " to go"; };
  /** Matchup card status: official once nflverse has finalized the week; otherwise from the starters. */
  function cardStatus(weekRow, a, h) {
    if (weekRow && (weekRow.status === "pending_review" || weekRow.status === "final")) return { key: "official", text: "Final (official)" };
    var any = a.done + a.playing + h.done + h.playing, left = a.playing + a.toGo + h.playing + h.toGo;
    if (!any) return { key: "upcoming", text: "Upcoming" };
    if (!left) return { key: "final", text: "Final (unofficial)" };
    return { key: "live", text: "Live" };
  }
  /** Is live scoring stale? A game is on (in progress, or kicked off < 4.5 h ago and not final) and
      the last live pass is over 3 minutes old, or the scorer flagged itself delayed. */
  function staleness(weekRow, games, now) {
    var on = games.some(function (g) { return g.status === "in_progress" || (g.status !== "final" && g.kickoff && Date.parse(g.kickoff) <= now && now - Date.parse(g.kickoff) < WINDOW_MS); });
    var at = weekRow && weekRow.updated_at ? Date.parse(weekRow.updated_at) : null;
    var official = weekRow && weekRow.status !== "live";
    var stale = on && !official && (at == null || now - at > STALE_MS);
    return { on: on, stale: stale || !!(on && !official && weekRow && weekRow.live_delayed), ageMs: at == null ? null : Math.max(0, now - at) };
  }
  function ago(ms) {
    if (ms == null) return "";
    var s = Math.round(ms / 1000);
    return s < 60 ? "updated " + s + "s ago" : s < 3600 ? "updated " + Math.floor(s / 60) + " min ago" : "updated " + fmtKick(new Date(Date.now() - ms).toISOString());
  }
  /** One team's lineup for the detail page: 9 slots (empty / hidden / player), the bench and the
      total (starters only; the bench never counts). Players: {id, name, pos, nfl_team, points, lines}. */
  function lineupView(slots, roster, scores, games, now) {
    var bySlot = {}, starterIds = {}, hidden = 0;
    slots.forEach(function (s) { bySlot[s.slot] = s; if (s.player_id) starterIds[s.player_id] = true; else hidden++; });
    var withScore = function (p) {
      var sc = scores[p.id] || null;
      return { id: p.id, name: p.name, pos: p.pos, nfl_team: p.nfl_team, points: sc ? Number(sc.points) : 0, scored: !!sc, lines: sc ? sc.lines || [] : [], game: playerGame(games, p.nfl_team, now) };
    };
    var total = 0;
    var starters = SLOTS.map(function (pos, i) {
      var s = bySlot[i];
      if (!s) return { slot: i, pos: pos, empty: true };
      if (!s.player_id) return { slot: i, pos: pos, hidden: true };
      var p = withScore({ id: s.player_id, name: s.name, pos: pos, nfl_team: s.nfl_team });
      total += p.points;
      return { slot: i, pos: pos, player: p };
    });
    // Bench: rostered players who aren't starters. While some starters are still hidden, a
    // player whose game hasn't started could be one of them, so he's listed only from kickoff.
    var bench = roster.filter(function (r) { return !starterIds[r.id]; }).map(function (r) { var p = withScore(r); p.bench = true; return p; })
      .filter(function (p) { return !hidden || p.game.state !== "pre"; });
    var benchTotal = bench.reduce(function (t, p) { return t + p.points; }, 0);
    return { starters: starters, bench: bench, hidden: hidden, total: Math.round(total * 100) / 100, benchTotal: Math.round(benchTotal * 100) / 100 };
  }
  /** Scoring plays for a matchup: events of either team's starters, newest first, with a big-play flag. */
  function feed(events, teams) {
    var who = {};
    teams.forEach(function (t) { t.ids.forEach(function (id) { who[id] = t.team; }); });
    return events.filter(function (e) { return who[e.player_id]; }).map(function (e) {
      return { team: who[e.player_id], player_id: e.player_id, at: e.at, detail: e.status_detail, delta: Number(e.delta), points: Number(e.points), lines: e.lines || [], big: Number(e.delta) >= BIG };
    }).sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
  }
  var lineSum = function (lines) { return Math.round((lines || []).reduce(function (t, l) { return t + Number(l.points); }, 0) * 100) / 100; };

  // ---- Realtime: Supabase's Phoenix channel protocol over a WebSocket (no supabase-js) ----
  var rt = { ws: null, hb: null, retry: null, tries: 0, joined: false, onChange: null, token: null };
  function rtStop() {
    clearInterval(rt.hb); clearTimeout(rt.retry);
    if (rt.ws) { rt.ws.onclose = null; try { rt.ws.close(); } catch (e) { /* closed */ } }
    rt.ws = null; rt.joined = false; rt.onChange = null;
  }
  function rtStart(onChange, token) {
    rtStop();
    rt.onChange = onChange; rt.token = token;
    if (!root.WebSocket || !cfg || !cfg.url) return;
    var ref = 0, topic = "realtime:b5-live-" + season;
    var send = function (m) { try { rt.ws.send(JSON.stringify(m)); } catch (e) { /* reconnects */ } };
    var ws = rt.ws = new root.WebSocket(cfg.url.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + encodeURIComponent(cfg.publishableKey) + "&vsn=1.0.0");
    ws.onopen = function () {
      var payload = { config: { broadcast: { self: false }, presence: { key: "" },
        postgres_changes: [{ event: "*", schema: "public", table: "score_weeks", filter: "season=eq." + season }] } };
      if (rt.token) payload.access_token = rt.token;
      send({ topic: topic, event: "phx_join", payload: payload, ref: String(++ref), join_ref: "1" });
      rt.hb = setInterval(function () { send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) }); }, 25000);
    };
    ws.onmessage = function (m) {
      var x; try { x = JSON.parse(m.data); } catch (e) { return; }
      if (x.event === "phx_reply" && x.topic === topic && x.payload && x.payload.status === "ok") { rt.joined = true; rt.tries = 0; }
      if (x.event === "postgres_changes" && x.payload && x.payload.data && rt.onChange) rt.onChange(x.payload.data.record || null);
    };
    ws.onclose = function () {
      clearInterval(rt.hb); rt.joined = false;
      var cb = rt.onChange; if (!cb) return;
      rt.retry = setTimeout(function () { rtStart(cb, rt.token); }, Math.min(60000, 2000 * Math.pow(2, rt.tries++)));
    };
  }

  // ---- Data -------------------------------------------------------------------------
  var st = { me: null, week: null, pair: null, data: null, open: {}, el: null, tick: null, poll: null, loading: false, err: null };
  var session = function () { return st.me && st.me.session; };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var ok = function (x) { return x && x.ok ? x.data || [] : []; };
  var inList = function (ids) { return encodeURIComponent(ids.map(function (i) { return '"' + String(i).replace(/"/g, "") + '"'; }).join(",")); };

  function pickWeek() {
    return api("nfl_games?season=eq." + season + "&select=week,kickoff&order=kickoff&limit=1000").then(function (r) {
      var g = ok(r), M = root.B5MyTeam;
      return (M && M.pickWeek ? M.pickWeek(g, Date.now()) : null) || g.reduce(function (m, x) { return Math.max(m, x.week); }, 1);
    });
  }
  function loadWeek() {
    var w = st.week, q = "?season=eq." + season + "&week=eq." + w;
    return Promise.all([
      api("score_weeks" + q + "&select=status,live_delayed,updated_at"),
      api("nfl_games" + q + "&select=game_key,home,away,kickoff,status,home_score,away_score,period,clock,status_detail&order=kickoff"),
      api("matchups" + q + "&select=home_team,away_team,home_score,away_score,is_playoff"),
      api("rpc/live_lineups", { method: "POST", body: JSON.stringify({ p_season: season, p_week: w }) })
    ]).then(function (r) {
      if (!r[1].ok && !r[2].ok) throw new Error(r[2].error || "couldn't load the week");
      var d = { week: w, sw: ok(r[0])[0] || null, games: ok(r[1]), matchups: ok(r[2]), slots: ok(r[3]), detail: null };
      if (!st.pair) return d;
      var teams = [st.pair.away, st.pair.home];
      var ids = d.slots.filter(function (s) { return s.player_id && teams.indexOf(s.team_id) >= 0; }).map(function (s) { return s.player_id; });
      return api("roster_entries?season=eq." + season + "&team_id=in.(" + inList(teams) + ")&select=team_id,player_id,nfl_players(name,position,nfl_team)").then(function (rr) {
        var roster = ok(rr).map(function (x) { var n = x.nfl_players || {}; return { team: x.team_id, id: x.player_id, name: n.name || x.player_id, pos: n.position || "", nfl_team: n.nfl_team || "" }; });
        var all = ids.concat(roster.map(function (x) { return x.id; }));
        return Promise.all([
          all.length ? api("player_scores" + q + "&player_id=in.(" + inList(all) + ")&select=player_id,points,lines,source") : Promise.resolve({ ok: true, data: [] }),
          ids.length ? api("score_events" + q + "&player_id=in.(" + inList(ids) + ")&select=player_id,at,status_detail,delta,points,lines&order=at.desc&limit=300") : Promise.resolve({ ok: true, data: [] })
        ]).then(function (x) {
          var scores = {};
          ok(x[0]).forEach(function (s) { scores[s.player_id] = s; });
          d.detail = { roster: roster, scores: scores, events: ok(x[1]) };
          return d;
        });
      });
    });
  }

  // ---- Render ------------------------------------------------------------------------
  var unofficial = function () { return season < Number(L.lineupsFrom || 0) ? '<p class="lv-unofficial"><b>Unofficial — MFL is official for ' + esc(season) + ".</b></p>" : ""; };
  function weekChips() {
    var n = (L.schedule && L.schedule.weeks && L.schedule.weeks.length) || 17, out = "";
    // Links, not buttons: the week lives in the URL (#live/7), so it never leaves this page.
    for (var w = 1; w <= n; w++) out += '<a class="wk' + (w === st.week ? " active" : "") + '" href="#live/' + w + '" aria-label="Week ' + w + '">' + w + "</a>";
    return '<div class="weeks" aria-label="Week">' + out + "</div>";
  }
  function freshHtml(d) {
    var s = staleness(d.sw, d.games, Date.now());
    var age = d.sw && d.sw.status === "live" && s.ageMs != null ? '<span class="lv-ago" data-lv-ago>' + esc(ago(s.ageMs)) + "</span>" : "";
    return '<div class="lv-fresh">' + age + (s.stale ? '<span class="lv-delayed" role="status">Live scoring delayed — showing the last good numbers.</span>' : "") + "</div>";
  }
  function nflStrip(d) {
    if (!d.games.length) return "";
    var now = Date.now();
    return '<div class="lv-strip" aria-label="NFL games">' + d.games.map(function (g) {
      var s = gameState(g, now), sc = s !== "pre" && g.home_score != null;
      var side = function (t, x) { return '<span class="lv-g-team">' + esc(t) + (sc ? " <b>" + esc(x) + "</b>" : "") + "</span>"; };
      return '<div class="lv-g lv-' + s + '">' + side(g.away, g.away_score) + side(g.home, g.home_score) +
        '<span class="lv-g-st">' + esc(s === "final" ? "Final" : s === "live" ? (g.status_detail || "Live") : fmtKick(g.kickoff)) + "</span></div>";
    }).join("") + "</div>";
  }
  var teamSlots = function (d, team) { return d.slots.filter(function (s) { return s.team_id === team; }); };
  function scoreboardHtml(d) {
    var now = Date.now();
    var cards = d.matchups.slice().sort(function (a, b) { return a.away_team < b.away_team ? -1 : 1; }).map(function (m) {
      var a = teamById(m.away_team), h = teamById(m.home_team);
      var pa = progress(teamSlots(d, a.id), d.games, now), ph = progress(teamSlots(d, h.id), d.games, now);
      var sa = Number(m.away_score || 0), sh = Number(m.home_score || 0), cs = cardStatus(d.sw, pa, ph);
      var lead = cs.key === "upcoming" || sa === sh ? null : sa > sh ? "a" : "h";
      var row = function (t, s, p, isLead) {
        return '<div class="lv-row' + (isLead ? " lead" : "") + '">' + logo(t) + '<div class="lv-name"><b>' + esc(t.name) + "</b><span class=\"muted small\">" + esc(progressText(p)) + '</span></div><span class="lv-pts">' + esc(pts(s)) + "</span></div>";
      };
      return '<a class="card lv-card lv-' + cs.key + '" href="#live/' + esc(d.week) + "/" + esc(a.id) + "-" + esc(h.id) + '"><span class="tag lv-st">' + esc(cs.text) + "</span>" +
        row(a, sa, pa, lead === "a") + row(h, sh, ph, lead === "h") + "</a>";
    }).join("");
    return '<section class="lv"><h2>Live</h2>' + unofficial() + weekChips() + freshHtml(d) + nflStrip(d) +
      (cards ? '<div class="lv-board">' + cards + "</div>" : '<div class="card muted">No matchups for week ' + esc(d.week) + ".</div>") +
      '<p class="muted small">Updates by itself during games. Starters are shown from their kickoff on.</p></section>';
  }

  function breakdownHtml(p) {
    var lines = p.lines || [];
    if (!lines.length) return '<div class="lv-bd muted small">' + (p.scored ? "No scoring lines yet." : p.game.state === "pre" ? "Hasn't played yet." : "No points.") + "</div>";
    var sum = lineSum(lines);
    return '<div class="lv-bd"><ul>' + lines.map(function (l) { return "<li><span>" + esc(l.text) + '</span><b>→ ' + esc(num(l.points)) + "</b></li>"; }).join("") +
      '</ul><p class="lv-bd-total"><span>Total</span><b>' + esc(pts(sum)) + "</b></p></div>";
  }
  function playerCell(p, side) {
    if (!p) return '<div class="lv-p ' + side + ' muted">—</div>';
    var g = p.game, live = g.state === "live";
    return '<button type="button" class="lv-p ' + side + (live ? " playing" : "") + '" data-lv-player="' + esc(p.id) + '" aria-expanded="' + (st.open[p.id] ? "true" : "false") + '">' +
      '<span class="lv-pn">' + esc(p.name) + '</span><span class="lv-pg small muted">' + esc((p.bench ? p.pos + " · " : "") + (p.nfl_team || "") + (g.opp ? " " + g.opp : "")) + " · " + esc(g.text) + "</span></button>" +
      '<span class="lv-pp ' + side + '">' + esc(g.state === "pre" && !p.scored ? "–" : pts(p.points)) + "</span>";
  }
  function slotRow(pos, a, h, extra) {
    var cell = function (x, side) {
      if (x && x.hidden) return '<div class="lv-p ' + side + ' muted small">🔒 Revealed at kickoff</div><span class="lv-pp ' + side + '">–</span>';
      if (x && x.empty) return '<div class="lv-p ' + side + ' muted small">Empty</div><span class="lv-pp ' + side + '">–</span>';
      return playerCell(x && x.player !== undefined ? x.player : x, side);
    };
    var open = [a, h].map(function (x) { var p = x && (x.player || (x.id ? x : null)); return p && st.open[p.id] ? breakdownHtml(p) : ""; }).join("");
    return '<li class="lv-slot' + (extra || "") + '">' + cell(a, "a") + '<span class="pos pos-' + esc(pos) + '">' + esc(pos) + "</span>" + cell(h, "h") +
      (open ? '<div class="lv-open">' + open + "</div>" : "") + "</li>";
  }
  function detailHtml(d) {
    var a = teamById(st.pair.away), h = teamById(st.pair.home), now = Date.now(), dt = d.detail;
    var m = d.matchups.filter(function (x) { return x.away_team === a.id && x.home_team === h.id; })[0];
    var back = '<p><a href="#live/' + esc(d.week) + '">← Week ' + esc(d.week) + " scoreboard</a></p>";
    if (!m) return '<section class="lv"><h2>Matchup</h2>' + back + '<div class="card muted">That matchup isn\'t on the week ' + esc(d.week) + " schedule.</div></section>";
    var side = function (t) { return lineupView(teamSlots(d, t.id), dt.roster.filter(function (r) { return r.team === t.id; }), dt.scores, d.games, now); };
    var va = side(a), vh = side(h);
    var pa = progress(teamSlots(d, a.id), d.games, now), ph = progress(teamSlots(d, h.id), d.games, now), cs = cardStatus(d.sw, pa, ph);
    var lead = cs.key === "upcoming" || va.total === vh.total ? null : va.total > vh.total ? "a" : "h";
    var head = '<div class="card lv-head"><span class="tag lv-st">' + esc(cs.text) + (d.sw && d.sw.status === "pending_review" ? " · awaiting commissioner sign-off" : "") + "</span>" +
      '<div class="lv-vs"><div class="lv-ht' + (lead === "a" ? " lead" : "") + '">' + logo(a) + "<b>" + esc(a.name) + '</b><span class="lv-big">' + esc(pts(va.total)) + '</span><span class="muted small">' + esc(progressText(pa)) + "</span></div>" +
      '<div class="lv-ht' + (lead === "h" ? " lead" : "") + '">' + logo(h) + "<b>" + esc(h.name) + '</b><span class="lv-big">' + esc(pts(vh.total)) + '</span><span class="muted small">' + esc(progressText(ph)) + "</span></div></div></div>";
    var starters = SLOTS.map(function (pos, i) { return slotRow(pos, va.starters[i], vh.starters[i]); }).join("");
    var nb = Math.max(va.bench.length, vh.bench.length), bench = "";
    for (var i = 0; i < nb; i++) { var x = va.bench[i], y = vh.bench[i]; bench += slotRow("BN", x || null, y || null, " bench"); }
    var hiddenNote = va.hidden || vh.hidden ? '<p class="muted small">Players yet to play join the bench list at kickoff (until then they could be a hidden starter).</p>' : "";
    var lineups = '<div class="card lv-lineups"><ul class="lv-slots">' + starters + '</ul><p class="lv-totals"><span>' + esc(pts(va.total)) + "</span><span>Total</span><span>" + esc(pts(vh.total)) + "</span></p>" +
      '<h3 class="lv-bench-h">Bench <span class="muted small">(points shown, not counted)</span></h3>' +
      (bench ? '<ul class="lv-slots">' + bench + '</ul><p class="lv-totals bench"><span>' + esc(pts(va.benchTotal)) + "</span><span>Bench</span><span>" + esc(pts(vh.benchTotal)) + "</span></p>" : '<p class="muted small">No bench players to show yet.</p>') +
      hiddenNote + '<p class="muted small">Tap a player for his points breakdown.</p></div>';
    var names = {};
    dt.roster.forEach(function (r) { names[r.id] = r.name; });
    d.slots.forEach(function (s) { if (s.player_id) names[s.player_id] = s.name; });
    var ids = function (v) { return v.starters.filter(function (s) { return s.player; }).map(function (s) { return s.player.id; }); };
    var plays = feed(dt.events, [{ team: a.id, ids: ids(va) }, { team: h.id, ids: ids(vh) }]);
    var feedHtml = '<div class="card"><h3>Scoring plays</h3>' + (plays.length ? '<ul class="lv-feed">' + plays.map(function (e) {
      var t = teamById(e.team);
      return '<li class="' + (e.big ? "big" : "") + '"><span class="lv-ft small muted">' + esc(e.detail || "") + (e.detail ? " · " : "") + esc(fmtTime(e.at)) + "</span>" +
        '<span class="lv-fw">' + esc(t.name) + " · <b>" + esc(names[e.player_id] || e.player_id) + "</b>" + (e.big ? ' <span class="tag">Big play</span>' : "") + "</span>" +
        '<span class="lv-fd ' + (e.delta < 0 ? "down" : "up") + '">' + (e.delta > 0 ? "+" : "") + esc(num(e.delta)) + "</span>" +
        '<span class="lv-fl small">' + esc(e.lines.map(function (l) { return l.text + " (" + (l.delta > 0 ? "+" : "") + num(l.delta) + ")"; }).join("; ")) + "</span></li>";
    }).join("") + "</ul>" : '<p class="muted small">No scoring plays yet. Plays are recorded as they happen during games (from week 7 of 2026 on).</p>') + "</div>";
    return '<section class="lv lv-detail"><h2>Week ' + esc(d.week) + "</h2>" + unofficial() + back + freshHtml(d) + head + lineups + feedHtml + "</section>";
  }

  function render() {
    if (!st.el || !st.data) return;
    var y = root.scrollY;
    st.el.innerHTML = st.pair ? detailHtml(st.data) : scoreboardHtml(st.data);
    if (st.err) st.el.querySelector(".lv-fresh").insertAdjacentHTML("beforeend", '<span class="lv-delayed">' + esc(st.err) + "</span>");
    var strip = st.el.querySelector(".weeks"), act = st.el.querySelector(".wk.active");
    if (strip && act) strip.scrollLeft = act.offsetLeft - strip.offsetLeft - (strip.clientWidth - act.offsetWidth) / 2;
    if (root.scrollTo && st.rendered) root.scrollTo(0, y);
    st.rendered = true;
  }
  function refresh() {
    if (st.loading) { st.again = true; return; }
    st.loading = true;
    loadWeek().then(function (d) { st.data = d; st.err = null; }, function (e) { st.err = "Couldn't refresh: " + e.message; })
      .then(function () {
        st.loading = false; render();
        if (st.again) { st.again = false; refresh(); }
      });
  }

  function stop() {
    rtStop(); clearInterval(st.tick); clearInterval(st.poll);
    st.el = null;
  }
  function start(rootEl, r) {
    stop();
    st.el = rootEl; st.pair = r && r.away ? { away: r.away, home: r.home } : null; st.data = null; st.rendered = false; st.open = {};
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Live</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section class="lv"><h2>Live</h2><p class="muted">Loading…</p></section>';
    var el = rootEl;
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (me) {
      st.me = me;
      return r && r.week ? Number(r.week) : pickWeek();
    }).then(function (w) {
      if (st.el !== el) return;
      st.week = w;
      return loadWeek().then(function (d) {
        if (st.el !== el) return;
        st.data = d; render();
        // Realtime: each live pass updates score_weeks; re-read when this week's row changes.
        rtStart(function (rec) { if (!rec || Number(rec.week) === st.week) refresh(); }, session() ? session().access_token : null);
        // "updated Xs ago" every second; a slow poll as a fallback while games are on and Realtime isn't joined.
        st.tick = setInterval(function () {
          var x = st.el && st.el.querySelector("[data-lv-ago]"), s = st.data && staleness(st.data.sw, st.data.games, Date.now());
          if (x && s && s.ageMs != null) x.textContent = ago(s.ageMs);
          if (s && s.stale && st.el && !st.el.querySelector(".lv-delayed")) render();
        }, 1000);
        st.poll = setInterval(function () { if (!rt.joined && st.data && staleness(st.data.sw, st.data.games, Date.now()).on && !(root.document && root.document.hidden)) refresh(); }, 60000);
      });
    }).catch(function (e) { if (st.el === el) el.innerHTML = '<section class="lv"><h2>Live</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });

    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-lv-player]"); if (!b) return;
      var id = b.dataset.lvPlayer;
      st.open[id] = !st.open[id];
      render();
    });
  }

  root.B5Live = { start: start, stop: stop, gameState: gameState, playerGame: playerGame, progress: progress, progressText: progressText, cardStatus: cardStatus,
    staleness: staleness, ago: ago, lineupView: lineupView, feed: feed, lineSum: lineSum,
    weekChipsHtml: function (w) { st.week = w; return weekChips(); }, scoreboardHtml: scoreboardHtml };
})(typeof globalThis !== "undefined" ? globalThis : this);
