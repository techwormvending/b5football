/* Live Scoring page, one page: #live, #live/<week>, #live/<week>/<franchiseId> (that matchup selected;
   old #live/<week>/<away>-<home> and #matchup/... links redirect here, see route.js).
   Top to bottom: week links (stay on Live), the week's NFL games strip, all matchup cards (totals,
   leader, "X done · Y playing · Z to go · N bye", status, a bye warning), then the selected
   matchup below the cards: both lineups in slot order (QB RB RB WR WR WR TE K DEF), the bench
   (points shown, not counted), tap a player for his points breakdown, the scoring-play feed.
   Clicking a card selects it in place (no page change; the URL becomes its deep link). Default:
   the signed-in manager's matchup, else the first card. A bye is its own status: never done,
   playing or to go, and it never makes a matchup Live.
   Public read, no sign-in. Each starter is revealed at his game's kickoff (public.live_lineups);
   a starter on bye is flagged at once and named after the week's last kickoff; his team's
   managers and the commissioner see their lineup in full.
   Only the Edge Function b5-live talks to ESPN. This page reads the database and subscribes to
   Supabase Realtime on score_weeks (one row per live pass), then re-reads the week and the
   selected matchup and re-fills the page in place. The breakdown lines come from the scoring
   engine (player_scores.lines, src/scoring/explain.ts); nothing is recalculated here. All data is escaped. */
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
  var T = root.B5Team;   // team names, logos and profile links (teamlink.js)
  var fmtKick = function (iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : ""; };
  var fmtTime = function (iso) { return iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : ""; };
  var pts = function (x) { var r = Math.round(Number(x || 0) * 100) / 100; return r.toFixed(Math.round(r * 100) % 10 ? 2 : 1); };
  var num = function (x) { return String(Math.round(Number(x || 0) * 100) / 100); };   // breakdown lines: "→ 10", "→ 4.7"

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
    // No game this week = bye (only once the week's games are known; nothing loaded isn't a bye).
    if (!g) return games.length ? { state: "bye", opp: "", text: "Bye", game: null } : { state: "pre", opp: "", text: "", game: null };
    var opp = g.home === nfl ? "vs " + g.away : "@ " + g.home;
    var text = s === "final" ? "Final" : s === "live" ? (g.status_detail || (g.period ? "Q" + g.period + " " + (g.clock || "") : "Live")) : fmtKick(g.kickoff);
    return { state: s, opp: opp, text: text, game: g };
  }
  /** Injury status (public.player_injuries, from nflverse) -> warning level: reserve lists and Out
      are "out"; Doubtful; Questionable. Tag = the short label shown next to the player. */
  var INJ = { IR: ["out", "IR"], PUP: ["out", "PUP"], Suspended: ["out", "SUSP"], Reserve: ["out", "RES"], Out: ["out", "OUT"], Doubtful: ["doubtful", "D"], Questionable: ["questionable", "Q"] };
  var injuryLevel = function (status) { return INJ[status] ? INJ[status][0] : null; };
  var injuryTag = function (status) { return INJ[status] ? INJ[status][1] : ""; };
  /** Starters done / playing / to go / on bye, plus injury warnings. A bye is its own status: never
      done, playing or to go. A hidden starter (not revealed yet) is to go, or on bye when the database
      flags his slot as a bye. Injury warnings count starters on the week's report who haven't finished
      (a finished game's warning is moot); a bye outranks an injury. */
  function progress(starters, games, now) {
    var p = { done: 0, playing: 0, toGo: 0, bye: 0, out: 0, doubtful: 0, questionable: 0 };
    starters.forEach(function (s) {
      var st = !s.revealed ? (s.bye ? "bye" : "pre") : playerGame(games, s.nfl_team, now).state;
      if (st === "bye") p.bye++; else if (st === "final") p.done++; else if (st === "live") p.playing++; else p.toGo++;
      var lv = injuryLevel(s.injury);
      if (lv && st !== "bye" && st !== "final") p[lv]++;
    });
    return p;
  }
  var progressText = function (p) { return p.done + " done · " + p.playing + " playing · " + p.toGo + " to go · " + p.bye + " bye"; };
  /** Matchup card status: official once nflverse has finalized the week. Otherwise LIVE only when at
      least one starter's game is in progress or finished; byes never start a matchup. */
  function cardStatus(weekRow, a, h) {
    if (weekRow && (weekRow.status === "pending_review" || weekRow.status === "final")) return { key: "official", text: "Final (official)" };
    var started = a.done + a.playing + h.done + h.playing, left = a.playing + a.toGo + h.playing + h.toGo;
    if (!started) return { key: "upcoming", text: "Upcoming" };
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
  function lineupView(slots, roster, scores, games, now, injuries) {
    var inj = function (id, status) { return (injuries && injuries[id]) || (status ? { status: status } : null); };
    var bySlot = {}, starterIds = {}, hidden = 0, hiddenBye = 0;
    slots.forEach(function (s) { bySlot[s.slot] = s; if (s.player_id) starterIds[s.player_id] = true; else if (s.bye) hiddenBye++; else hidden++; });
    var withScore = function (p) {
      var sc = scores[p.id] || null;
      return { id: p.id, name: p.name, pos: p.pos, nfl_team: p.nfl_team, points: sc ? Number(sc.points) : 0, scored: !!sc, lines: sc ? sc.lines || [] : [], game: playerGame(games, p.nfl_team, now), injury: inj(p.id, p.injury) };
    };
    var total = 0, byes = 0;
    var starters = SLOTS.map(function (pos, i) {
      var s = bySlot[i];
      if (!s) return { slot: i, pos: pos, empty: true };
      if (!s.player_id) { if (s.bye) byes++; return { slot: i, pos: pos, hidden: true, bye: !!s.bye, injury: s.injury || null }; }
      var p = withScore({ id: s.player_id, name: s.name, pos: pos, nfl_team: s.nfl_team, injury: s.injury });
      if (p.game.state === "bye") byes++;
      total += p.points;
      return { slot: i, pos: pos, player: p };
    });
    // Bench: rostered players who aren't starters. While some starters are still hidden, a
    // player whose game hasn't started (or who is on bye, for a hidden bye slot) could be one of
    // them, so he isn't listed until that can't be the case.
    var bench = roster.filter(function (r) { return !starterIds[r.id]; }).map(function (r) { var p = withScore(r); p.bench = true; return p; })
      .filter(function (p) { return !(hidden && p.game.state === "pre") && !(hiddenBye && p.game.state === "bye"); });
    var benchTotal = bench.reduce(function (t, p) { return t + p.points; }, 0);
    return { starters: starters, bench: bench, hidden: hidden + hiddenBye, byes: byes, total: Math.round(total * 100) / 100, benchTotal: Math.round(benchTotal * 100) / 100 };
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

  // ---- Realtime (realtime.js): score_weeks for this season; one message per live pass ----
  var rt = { sub: null };
  var rtStop = function () { if (rt.sub) rt.sub.close(); rt.sub = null; };
  var rtJoined = function () { return !!(rt.sub && rt.sub.joined()); };
  function rtStart(onChange) {
    rtStop();
    if (!root.B5Realtime) return;
    rt.sub = root.B5Realtime.subscribe({ cfg: cfg, topic: "realtime:b5-live-" + season,
      changes: [{ table: "score_weeks", filter: "season=eq." + season }],
      // A fresh session on every (re)connect, so a long Sunday never runs on an expired token.
      getToken: function () { return root.B5Account ? root.B5Account.load().then(function (me) { return me && me.session ? me.session.access_token : null; }, function () { return null; }) : null; },
      onChange: function (rec) { onChange(rec); } });
  }

  // ---- Data -------------------------------------------------------------------------
  // st.sel = the selected matchup's team (either side). st.d = the week (cards); st.dd = the
  // selected matchup's detail ({key, roster, scores, events}).
  var st = { me: null, week: null, sel: null, d: null, dd: null, open: {}, el: null, tick: null, poll: null, loading: false, err: null };
  var session = function () { return st.me && st.me.session; };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var ok = function (x) { return x && x.ok ? x.data || [] : []; };
  var inList = function (ids) { return encodeURIComponent(ids.map(function (i) { return '"' + String(i).replace(/"/g, "") + '"'; }).join(",")); };
  var byAway = function (a, b) { return a.away_team < b.away_team ? -1 : 1; };

  /** The matchup to show: the one with `team` in it, else the viewer's own team's, else the first card. */
  function pickMatchup(matchups, team, myTeams) {
    var list = matchups.slice().sort(byAway);
    var has = function (t) { return list.filter(function (m) { return t && (m.away_team === t || m.home_team === t); })[0]; };
    var mine = (myTeams || []).map(has).filter(Boolean)[0];
    return has(team) || mine || list[0] || null;
  }
  var myTeams = function () { return st.me && st.me.teams ? st.me.teams.map(function (t) { return t.team_id; }) : []; };
  var selected = function () { return st.d ? pickMatchup(st.d.matchups, st.sel, myTeams()) : null; };
  var pairKey = function (m) { return m ? m.away_team + "-" + m.home_team : ""; };

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
      return { week: w, sw: ok(r[0])[0] || null, games: ok(r[1]), matchups: ok(r[2]), slots: ok(r[3]) };
    });
  }
  /** The selected matchup's rosters, player scores (with breakdown lines) and scoring plays. */
  function loadDetail(d, m) {
    if (!m) return Promise.resolve(null);
    var q = "?season=eq." + season + "&week=eq." + d.week, teams = [m.away_team, m.home_team];
    var ids = d.slots.filter(function (s) { return s.player_id && teams.indexOf(s.team_id) >= 0; }).map(function (s) { return s.player_id; });
    return api("roster_entries?season=eq." + season + "&team_id=in.(" + inList(teams) + ")&select=team_id,player_id,nfl_players(name,position,nfl_team)").then(function (rr) {
      var roster = ok(rr).map(function (x) { var n = x.nfl_players || {}; return { team: x.team_id, id: x.player_id, name: n.name || x.player_id, pos: n.position || "", nfl_team: n.nfl_team || "" }; });
      var all = ids.concat(roster.map(function (x) { return x.id; }));
      return Promise.all([
        all.length ? api("player_scores" + q + "&player_id=in.(" + inList(all) + ")&select=player_id,points,lines,source") : Promise.resolve({ ok: true, data: [] }),
        all.length ? api("player_injuries" + q + "&player_id=in.(" + inList(all) + ")&select=player_id,status,injury,practice") : Promise.resolve({ ok: true, data: [] }),
        ids.length ? api("score_events" + q + "&player_id=in.(" + inList(ids) + ")&select=player_id,at,status_detail,delta,points,lines&order=at.desc&limit=300") : Promise.resolve({ ok: true, data: [] })
      ]).then(function (x) {
        var scores = {};
        ok(x[0]).forEach(function (s) { scores[s.player_id] = s; });
        var injuries = {};
        ok(x[1]).forEach(function (s) { injuries[s.player_id] = s; });
        return { key: d.week + ":" + pairKey(m), roster: roster, scores: scores, injuries: injuries, events: ok(x[2]) };
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
    return age + (s.stale ? '<span class="lv-delayed" role="status">Live scoring delayed — showing the last good numbers.</span>' : "") +
      (st.err ? '<span class="lv-delayed">' + esc(st.err) + "</span>" : "");
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
  /** "⚠ 2 starters on bye · 1 out · 1 doubtful" (red) and "2 questionable" (gold), or nothing. */
  function warnHtml(p) {
    var parts = [[p.bye, "on bye"], [p.out, "out"], [p.doubtful, "doubtful"]].filter(function (x) { return x[0]; });
    var red = parts.map(function (x, i) { return i ? x[0] + " " + x[1] : x[0] + " starter" + (x[0] === 1 ? "" : "s") + " " + x[1]; }).join(" · ");
    return (red ? '<span class="lv-warn">⚠ ' + esc(red) + "</span>" : "") + (p.questionable ? '<span class="lv-warn q">' + esc(p.questionable + " questionable") + "</span>" : "");
  }
  function cardsHtml(d) {
    var now = Date.now(), sel = pairKey(selected());
    var cards = d.matchups.slice().sort(byAway).map(function (m) {
      var a = m.away_team, h = m.home_team;
      var pa = progress(teamSlots(d, a), d.games, now), ph = progress(teamSlots(d, h), d.games, now);
      var sa = Number(m.away_score || 0), sh = Number(m.home_score || 0), cs = cardStatus(d.sw, pa, ph);
      var lead = cs.key === "upcoming" || sa === sh ? null : sa > sh ? "a" : "h";
      var row = function (id, s, p, isLead) {
        return '<div class="lv-row' + (isLead ? " lead" : "") + '">' + T.logo(id) + '<div class="lv-name">' + T.link(id, { logo: false, bold: true }) + '<span class="muted small">' + esc(progressText(p)) + "</span>" + warnHtml(p) +
          '</div><span class="lv-pts">' + esc(pts(s)) + "</span></div>";
      };
      var isSel = pairKey(m) === sel;
      // The card selects the matchup (a cover link under it); the team names on top open the teams.
      return '<div class="card lv-card has-cover lv-' + cs.key + (isSel ? " sel" : "") + '"' + (isSel ? ' aria-current="true"' : "") + '>' +
        '<a class="card-cover" href="#live/' + esc(d.week) + "/" + esc(a) + '" data-lv-team="' + esc(a) + '" aria-label="Show this matchup"></a>' +
        '<span class="tag lv-st">' + esc(cs.text) + "</span>" + row(a, sa, pa, lead === "a") + row(h, sh, ph, lead === "h") + "</div>";
    }).join("");
    return cards ? '<div class="lv-board">' + cards + "</div>" : '<div class="card muted">No matchups for week ' + esc(d.week) + ".</div>";
  }

  function injuryNote(p) {
    var i = p.injury;
    return i ? '<p class="lv-inj-note">Injury report: <b>' + esc(i.status) + "</b>" + (i.injury ? " (" + esc(i.injury) + ")" : "") + (i.practice ? " · " + esc(i.practice) : "") + "</p>" : "";
  }
  function breakdownHtml(p) {
    var lines = p.lines || [];
    if (!lines.length) return '<div class="lv-bd small">' + injuryNote(p) + '<span class="muted">' + (p.game.state === "bye" ? "On bye this week: no game, no points." : p.scored ? "No scoring lines yet." : p.game.state === "pre" ? "Hasn't played yet." : "No points.") + "</span></div>";
    var sum = lineSum(lines);
    return '<div class="lv-bd">' + injuryNote(p) + '<ul>' + lines.map(function (l) { return "<li><span>" + esc(l.text) + '</span><b>→ ' + esc(num(l.points)) + "</b></li>"; }).join("") +
      '</ul><p class="lv-bd-total"><span>Total</span><b>' + esc(pts(sum)) + "</b></p></div>";
  }
  function playerCell(p, side) {
    if (!p) return '<div class="lv-p ' + side + ' muted">—</div>';
    var g = p.game, live = g.state === "live", bye = g.state === "bye";
    var lv = p.injury && injuryLevel(p.injury.status), warn = !p.bench && (bye || (lv === "out" && g.state !== "final"));
    var tag = lv ? ' <span class="lv-inj ' + lv + '" title="' + esc(p.injury.status + (p.injury.injury ? ": " + p.injury.injury : "")) + '">' + esc(injuryTag(p.injury.status)) + "</span>" : "";
    var shown = bye ? '<span class="lv-bye' + (p.bench ? " bench" : "") + '">BYE</span>' : esc(g.state === "pre" && !p.scored ? "–" : pts(p.points));
    return '<button type="button" class="lv-p ' + side + (live ? " playing" : "") + (warn ? " on-bye" : "") + '" data-lv-player="' + esc(p.id) + '" aria-expanded="' + (st.open[p.id] ? "true" : "false") + '">' +
      '<span class="lv-pn">' + esc(p.name) + tag + '</span><span class="lv-pg small muted">' + esc((p.bench ? p.pos + " · " : "") + (p.nfl_team || "") + (g.opp ? " " + g.opp : "")) + " · " + esc(g.text) + "</span></button>" +
      '<span class="lv-pp ' + side + '">' + shown + "</span>";
  }
  function slotRow(pos, a, h, extra) {
    var cell = function (x, side) {
      if (x && x.hidden && x.bye) return '<div class="lv-p ' + side + ' muted small">🔒 Starter on bye</div><span class="lv-pp ' + side + '"><span class="lv-bye">BYE</span></span>';
      if (x && x.hidden && injuryLevel(x.injury)) return '<div class="lv-p ' + side + ' muted small"><span>🔒 Starter listed <span class="lv-inj ' + injuryLevel(x.injury) + '">' + esc(injuryTag(x.injury)) + '</span></span></div><span class="lv-pp ' + side + '">–</span>';
      if (x && x.hidden) return '<div class="lv-p ' + side + ' muted small">🔒 Revealed at kickoff</div><span class="lv-pp ' + side + '">–</span>';
      if (x && x.empty) return '<div class="lv-p ' + side + ' muted small">Empty</div><span class="lv-pp ' + side + '">–</span>';
      return playerCell(x && x.player !== undefined ? x.player : x, side);
    };
    var open = [a, h].map(function (x) { var p = x && (x.player || (x.id ? x : null)); return p && st.open[p.id] ? breakdownHtml(p) : ""; }).join("");
    return '<li class="lv-slot' + (extra || "") + '">' + cell(a, "a") + '<span class="pos pos-' + esc(pos) + '">' + esc(pos) + "</span>" + cell(h, "h") +
      (open ? '<div class="lv-open">' + open + "</div>" : "") + "</li>";
  }
  function detailHtml(d, m, dt) {
    if (!m) return "";
    if (!dt || dt.key !== d.week + ":" + pairKey(m)) return '<div class="card muted">Loading the matchup…</div>';
    var a = m.away_team, h = m.home_team, now = Date.now();
    var side = function (id) { return lineupView(teamSlots(d, id), dt.roster.filter(function (r) { return r.team === id; }), dt.scores, d.games, now, dt.injuries); };
    var va = side(a), vh = side(h);
    var pa = progress(teamSlots(d, a), d.games, now), ph = progress(teamSlots(d, h), d.games, now), cs = cardStatus(d.sw, pa, ph);
    var lead = cs.key === "upcoming" || va.total === vh.total ? null : va.total > vh.total ? "a" : "h";
    var ht = function (id, v, p, isLead) {
      return '<div class="lv-ht' + (isLead ? " lead" : "") + '">' + T.logo(id) + T.link(id, { logo: false, bold: true }) + '<span class="lv-big">' + esc(pts(v.total)) + '</span><span class="muted small">' + esc(progressText(p)) + "</span>" + warnHtml(p) + "</div>";
    };
    var head = '<div class="card lv-head"><span class="tag lv-st">' + esc(cs.text) + (d.sw && d.sw.status === "pending_review" ? " · awaiting commissioner sign-off" : "") + "</span>" +
      '<div class="lv-vs">' + ht(a, va, pa, lead === "a") + ht(h, vh, ph, lead === "h") + "</div></div>";
    var starters = SLOTS.map(function (pos, i) { return slotRow(pos, va.starters[i], vh.starters[i]); }).join("");
    var nb = Math.max(va.bench.length, vh.bench.length), bench = "";
    for (var i = 0; i < nb; i++) { var x = va.bench[i], y = vh.bench[i]; bench += slotRow("BN", x || null, y || null, " bench"); }
    var lineups = '<div class="card lv-lineups"><ul class="lv-slots">' + starters + '</ul><p class="lv-totals"><span>' + esc(pts(va.total)) + "</span><span>Total</span><span>" + esc(pts(vh.total)) + "</span></p>" +
      '<h3 class="lv-bench-h">Bench <span class="muted small">(points shown, not counted)</span></h3>' +
      (bench ? '<ul class="lv-slots">' + bench + '</ul><p class="lv-totals bench"><span>' + esc(pts(va.benchTotal)) + "</span><span>Bench</span><span>" + esc(pts(vh.benchTotal)) + "</span></p>" : '<p class="muted small">No bench players to show yet.</p>') +
      '<p class="muted small">Tap a player for his points breakdown.</p></div>';
    var names = {};
    dt.roster.forEach(function (r) { names[r.id] = r.name; });
    d.slots.forEach(function (s) { if (s.player_id) names[s.player_id] = s.name; });
    var ids = function (v) { return v.starters.filter(function (s) { return s.player; }).map(function (s) { return s.player.id; }); };
    var plays = feed(dt.events, [{ team: a, ids: ids(va) }, { team: h, ids: ids(vh) }]);
    var feedHtml = '<div class="card"><h3>Scoring plays</h3>' + (plays.length ? '<ul class="lv-feed">' + plays.map(function (e) {
      return '<li class="' + (e.big ? "big" : "") + '"><span class="lv-ft small muted">' + esc(e.detail || "") + (e.detail ? " · " : "") + esc(fmtTime(e.at)) + "</span>" +
        '<span class="lv-fw">' + T.link(e.team, { logo: false }) + " · <b>" + esc(names[e.player_id] || e.player_id) + "</b>" + (e.big ? ' <span class="tag">Big play</span>' : "") + "</span>" +
        '<span class="lv-fd ' + (e.delta < 0 ? "down" : "up") + '">' + (e.delta > 0 ? "+" : "") + esc(num(e.delta)) + "</span>" +
        '<span class="lv-fl small">' + esc(e.lines.map(function (l) { return l.text + " (" + (l.delta > 0 ? "+" : "") + num(l.delta) + ")"; }).join("; ")) + "</span></li>";
    }).join("") + "</ul>" : '<p class="muted small">No scoring plays yet. Plays are recorded as they happen during games (from week 7 of 2026 on).</p>') + "</div>";
    return '<h3 class="lv-detail-h">' + T.link(a, { logo: false }) + " vs " + T.link(h, { logo: false }) + "</h3>" + head + lineups + feedHtml;
  }

  // One page: the shell (title, label, week links) is built once per week; the other parts are
  // re-filled in place, so a Realtime update never reloads the page or the selected matchup.
  function shellHtml() {
    return '<section class="lv"><h2>Live</h2>' + unofficial() + weekChips() +
      '<div class="lv-fresh" data-lv="fresh"></div><div data-lv="strip"></div><div data-lv="cards"><p class="muted">Loading…</p></div>' +
      '<div class="lv-detail" id="lvDetail" data-lv="detail"></div>' +
      '<p class="muted small">Updates by itself during games. Starters are shown from their kickoff on.</p></section>';
  }
  function render() {
    if (!st.el || !st.d) return;
    var part = function (k) { return st.el.querySelector('[data-lv="' + k + '"]'); };
    if (!part("cards")) {
      st.el.innerHTML = shellHtml();
      var strip = st.el.querySelector(".weeks"), act = st.el.querySelector(".wk.active");
      if (strip && act) strip.scrollLeft = act.offsetLeft - strip.offsetLeft - (strip.clientWidth - act.offsetWidth) / 2;
    }
    var y = root.scrollY, d = st.d;
    part("fresh").innerHTML = freshHtml(d);
    var sx = part("strip").firstChild ? part("strip").firstChild.scrollLeft : 0;
    part("strip").innerHTML = nflStrip(d);
    if (part("strip").firstChild) part("strip").firstChild.scrollLeft = sx;
    part("cards").innerHTML = cardsHtml(d);
    part("detail").innerHTML = detailHtml(d, selected(), st.dd);
    if (root.scrollTo && st.rendered) root.scrollTo(0, y);
    st.rendered = true;
  }
  function refresh() {
    if (st.loading) { st.again = true; return; }
    st.loading = true;
    loadWeek().then(function (d) {
      st.d = d; st.err = null;
      return loadDetail(d, selected()).then(function (dd) { if (dd) st.dd = dd; });
    }).catch(function (e) { st.err = "Couldn't refresh: " + e.message; })
      .then(function () {
        st.loading = false; render();
        if (st.again) { st.again = false; refresh(); }
      });
  }
  var detailTop = function (det) {
    var head = root.document.querySelector("header.top");
    return Math.max(0, det.getBoundingClientRect().top + root.scrollY - (head ? head.offsetHeight : 0) - 8);
  };
  /** Select a matchup (card click): highlight it, load it below, keep the URL a deep link. */
  function select(team) {
    st.sel = team; st.open = {};
    var m = selected();
    if (root.history && root.history.replaceState) root.history.replaceState(null, "", "#live/" + st.week + "/" + team);
    render();
    var el = st.el;
    loadDetail(st.d, m).then(function (dd) {
      if (st.el !== el || pairKey(selected()) !== pairKey(m)) return;
      st.dd = dd; render();
      var det = st.el.querySelector("#lvDetail");
      // Phones: the detail is below six cards, so bring it into view (just under the sticky header).
      if (det && root.matchMedia && root.matchMedia("(max-width: 760px)").matches) root.scrollTo({ top: detailTop(det), behavior: "smooth" });
    }, function (e) { st.err = "Couldn't load the matchup: " + e.message; render(); });
  }

  function stop() {
    rtStop(); clearInterval(st.tick); clearInterval(st.poll);
    st.el = null;
  }
  function start(rootEl, r) {
    stop();
    st.el = rootEl; st.sel = r && r.team ? r.team : null; st.d = null; st.dd = null; st.rendered = false; st.open = {}; st.err = null;
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
        st.d = d; render();
        return loadDetail(d, selected()).then(function (dd) {
          if (st.el !== el) return;
          st.dd = dd; render();
          // Realtime: each live pass updates score_weeks; re-read the week and the selected matchup.
          rtStart(function (rec) { if (!rec || Number(rec.week) === st.week) refresh(); });
          // "updated Xs ago" every second; a slow poll as a fallback while games are on and Realtime isn't joined.
          st.tick = setInterval(function () {
            var x = st.el && st.el.querySelector("[data-lv-ago]"), s = st.d && staleness(st.d.sw, st.d.games, Date.now());
            if (x && s && s.ageMs != null) x.textContent = ago(s.ageMs);
            if (s && s.stale && st.el && !st.el.querySelector(".lv-delayed")) render();
          }, 1000);
          st.poll = setInterval(function () { if (!rtJoined() && st.d && staleness(st.d.sw, st.d.games, Date.now()).on && !(root.document && root.document.hidden)) refresh(); }, 60000);
        });
      });
    }).catch(function (e) { if (st.el === el) el.innerHTML = '<section class="lv"><h2>Live</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });

    rootEl.addEventListener("click", function (e) {
      var card = e.target.closest("a.card-cover[data-lv-team]");
      if (card && !(e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); select(card.dataset.lvTeam); return; }
      var b = e.target.closest("[data-lv-player]"); if (!b) return;
      var id = b.dataset.lvPlayer;
      st.open[id] = !st.open[id];
      render();
    });
  }

  root.B5Live = { start: start, stop: stop, gameState: gameState, playerGame: playerGame, progress: progress, progressText: progressText, cardStatus: cardStatus,
    staleness: staleness, ago: ago, lineupView: lineupView, feed: feed, lineSum: lineSum,
    weekChipsHtml: function (w) { st.week = w; return weekChips(); }, pickMatchup: pickMatchup,
    cardsHtml: function (d, team, mine) { st.d = d; st.sel = team || null; st.me = mine ? { teams: mine.map(function (t) { return { team_id: t }; }) } : null; return cardsHtml(d); } };
})(typeof globalThis !== "undefined" ? globalThis : this);
