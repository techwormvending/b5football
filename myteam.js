/* My Team (#myteam): where a signed-in manager lands. Shows the team, logo,
   record and roster, and the weekly lineup editor once lineups are open
   (LEAGUE.lineupsFrom, the 2027 season). Until then it shows the roster from
   the site's current data and a note that lineups open for 2027.

   Lineups live in Supabase (public.lineup_slots), saved in one call through
   public.save_lineup(). The database enforces the rules (own team only, player
   on the roster, right position, each player locked at his game's kickoff); the
   page only mirrors them so managers see locks before they hit Save.

   Uses auth.js (B5Auth) and account.js (B5Account.load for who is signed in).
   All data is escaped before it goes into HTML. */
(function (root) {
  "use strict";
  var WEEK_GRACE_MS = 5 * 3600 * 1000;   // a week stays current until 5 h after its last kickoff
  var POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var posRank = function (p) { var i = POS_ORDER.indexOf(p); return i < 0 ? 99 : i; };
  var byPos = function (a, b) { return posRank(a.pos) - posRank(b.pos); };   // stable: keeps order within a position

  // ---- Pure helpers (tested in src/workers/myteam.test.ts) -------------------
  function lineupsOpen(L) { return !!(L && L.lineupsFrom && Number(L.season) >= Number(L.lineupsFrom)); }

  /** Record, points and standings place from LEAGUE.standings. Null if the team isn't listed. */
  function recordFor(L, teamId) {
    var rows = (L.standings && L.standings.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r[0] === teamId) return { w: r[1], l: r[2], t: r[3], pf: r[4], pa: r[5], rank: i + 1, of: rows.length };
    }
    return null;
  }

  // The site's 2026 rosters still use MFL's team codes; show the standard ones.
  var NFL_CODES = { GBP: "GB", JAC: "JAX", KCC: "KC", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB" };

  /** The site's current roster for a team (LEAGUE.rosters), grouped QB RB WR TE K DEF. */
  function leagueRoster(L, teamId) {
    var ps = (L.rosters && L.rosters.teams && L.rosters.teams[teamId]) || [];
    return ps.map(function (p) { return { name: p[0], pos: p[1], nfl: NFL_CODES[p[2]] || p[2], acquired: p[3] || "" }; }).sort(byPos);
  }

  /** Current lineup week: the first week whose last kickoff was less than 5 h ago. games: [{week, kickoff}]. */
  function pickWeek(games, now) {
    var last = {};
    games.forEach(function (g) {
      var k = Date.parse(g.kickoff);
      if (!isNaN(k) && (last[g.week] == null || k > last[g.week])) last[g.week] = k;
    });
    var weeks = Object.keys(last).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < weeks.length; i++) if (last[weeks[i]] + WEEK_GRACE_MS > now) return weeks[i];
    return null;
  }

  /** Starters to show: this week's saved slots, else last week's carried over (unsaved). */
  function draftFrom(slots, prevSlots, prevWeek) {
    var d = [null, null, null, null, null, null, null, null, null];
    var src = slots && slots.length ? slots : prevSlots || [];
    src.forEach(function (s) { if (s.slot >= 0 && s.slot < 9) d[s.slot] = s.player_id; });
    return { draft: d, saved: !!(slots && slots.length), carried: !(slots && slots.length) && src.length ? prevWeek : null };
  }

  /** Kickoff (ms) of a team's game in the given week's games, or null (bye). */
  function kickoffFor(weekGames, nflTeam) {
    for (var i = 0; i < weekGames.length; i++) {
      var g = weekGames[i];
      if (g.home === nflTeam || g.away === nflTeam) return Date.parse(g.kickoff);
    }
    return null;
  }

  /** Rows of roster_entries + nfl_players -> { team_id: [{id, name, pos, nfl, acquired}] }, grouped by position. */
  function rostersFromRows(rows) {
    var out = {};
    (rows || []).forEach(function (x) {
      var p = x.nfl_players || {};
      (out[x.team_id] = out[x.team_id] || []).push({ id: x.player_id, name: p.name || x.player_id, pos: p.position, nfl: p.nfl_team, acquired: x.acquired || "" });
    });
    Object.keys(out).forEach(function (k) { out[k].sort(byPos); });
    return out;
  }

  // ---- Page --------------------------------------------------------------------
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var storage = null;
  try { storage = root.localStorage; } catch (e) { storage = null; }
  var f = function (u, i) { return root.fetch(u, i); };   // looked up per call (tests can stub it)
  var st = { me: null, teamId: null, lu: null, msg: null, managers: {}, dbRosters: null };

  // Rosters from the database (public data; works signed out). Resolves null if unavailable.
  var rostersP = null;
  function loadRosters() {
    if (!(cfg && cfg.configured && A)) return Promise.resolve(null);
    if (!rostersP) {
      rostersP = A.api(cfg, null, "roster_entries?season=eq." + Number(L.season) +
        "&select=team_id,player_id,acquired,nfl_players(name,position,nfl_team)&limit=1000", {}, f)
        .then(function (r) { return r.ok && r.data && r.data.length ? rostersFromRows(r.data) : null; }, function () { return null; });
      rostersP.then(function (x) { if (!x) rostersP = null; });   // retry next time
    }
    return rostersP;
  }

  var TL = function () { return root.B5Team; };   // team names, logos and profile links (teamlink.js)
  var teamOf = function (id) { return id && TL().has(id) ? { id: id, division: TL().division(id) } : null; };
  var divName = function (id) { var d = (L.divisions || []).filter(function (x) { return x.id === id; })[0]; return d ? d.name : ""; };
  var fmtDate = function (d) { return d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; };
  var fmtKick = function (ms) { return new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }); };
  var ordinal = function (n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  var acq = function (a) { return /^Waiv/.test(a) ? "Waivers" : a ? "Pick " + a : ""; };
  var msgHtml = function (m) { return m ? '<p class="acct-msg ' + (m.err ? "err" : "ok") + '">' + esc(m.err || m.ok) + "</p>" : ""; };

  // Teams this account manages (the default view). The commissioner can also view any
  // other team (picker), his own team(s) listed first.
  var ownTeams = function () { return st.me ? st.me.teams.map(function (t) { return t.team_id; }) : []; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  function myTeams() {
    var own = ownTeams();
    if (!isCommish()) return own;
    return own.concat(TL().ids().filter(function (id) { return own.indexOf(id) < 0; }));
  }

  function headerHtml(t) {
    var r = recordFor(L, t.id), ids = myTeams();
    var picker = ids.length > 1
      ? '<label class="mt-pick">Team <select data-mt="team">' + ids.map(function (id) {
          return TL().option(id, id === t.id, ownTeams().indexOf(id) >= 0 && isCommish() ? " (your team)" : "");
        }).join("") + "</select></label>" +
        (isCommish() && ownTeams().indexOf(t.id) < 0 ? '<p class="tag mt-viewing">Viewing as commissioner</p>' : "")
      : "";
    var line = r ? r.w + "-" + r.l + (r.t ? "-" + r.t : "") : "";
    return '<div class="card mt-head">' + TL().logo(t.id, "logo") +
      '<div class="mt-title"><h2>' + TL().link(t.id, { logo: false }) + "</h2>" +
      '<div class="muted">' + esc(divName(t.division) ? divName(t.division) + " Division" : "") +
      (st.managers[t.id] ? " · " + esc(st.managers[t.id]) : "") + "</div></div>" + picker +
      (r ? '<div class="mt-stats"><div><b>' + esc(line) + "</b><span>Record</span></div>" +
        "<div><b>" + esc(ordinal(r.rank)) + "</b><span>of " + esc(r.of) + "</span></div>" +
        "<div><b>" + esc(Number(r.pf).toFixed(1)) + "</b><span>PF</span></div>" +
        "<div><b>" + esc(Number(r.pa).toFixed(1)) + "</b><span>PA</span></div></div>" : "") +
      (L.standings && L.standings.asOf ? '<div class="muted small mt-asof">' + "Standings as of " + esc(fmtDate(L.standings.asOf)) + "</div>" : "") +
      (st.won && st.won[t.id] && (st.won[t.id].final + st.won[t.id].projected) && root.B5Payouts ? '<div class="small mt-asof"><a href="#payouts">Season winnings</a>: <b>' + esc(root.B5Payouts.money(st.won[t.id].final)) + "</b>" +
        (st.won[t.id].projected ? " (+" + esc(root.B5Payouts.money(st.won[t.id].projected)) + " projected)" : "") + "</div>" : "") +
      "</div>";
  }

  function rosterHtml(players, note) {
    if (!players.length) return '<div class="card"><h3>Roster</h3><p class="muted">No players on this roster yet.</p></div>';
    return '<div class="card"><h3>Roster (' + players.length + ")</h3>" +
      '<ul class="mt-roster">' + players.map(function (p) {
        return '<li><span class="pos pos-' + esc(p.pos) + '">' + esc(p.pos) + '</span><span class="pname">' + esc(p.name) +
          '</span><span class="muted nfl">' + esc(p.nfl || "FA") + (p.acquired ? " · " + esc(acq(p.acquired)) : "") + "</span></li>";
      }).join("") + "</ul>" + (note ? '<p class="muted small">' + esc(note) + "</p>" : "") + "</div>";
  }

  function closedHtml() {
    return '<div class="card mt-soon"><h3>Lineups open for the ' + esc(L.lineupsFrom) + " season</h3>" +
      "<p>Starting with the " + esc(L.lineupsFrom) + " draft, you'll set your weekly lineup right here, from your phone. " +
      "Each player locks at his own game's kickoff.</p>" +
      '<p class="muted">For the rest of ' + esc(L.season) + ", set your lineup the way you do now.</p></div>";
  }

  // ---- Week lineups with points (2026: mirrored from MFL; read-only) -------------
  // Lineups are members-only (RLS): signed-out visitors get none. Points are public.
  // Resolves { status: "live"|"pending_review"|"final"|null, delayed, teams: { id: [{slot, pos, name, nfl, points}] } }.
  function weekLineups(season, week, teamIds) {
    var session = st.me && st.me.session;
    var get = function (p) { return A.api(cfg, session, p, {}, f); };
    var teams = teamIds.map(function (t) { return '"' + t + '"'; }).join(",");
    return Promise.all([
      session ? A.current(cfg, { storage: storage, fetchImpl: f, now: Date.now() }) : Promise.resolve(null),
      get("score_weeks?season=eq." + season + "&week=eq." + week + "&select=status,live_delayed")
    ]).then(function (r) {
      if (r[0]) { session = r[0]; st.me.session = r[0]; }
      return get("lineup_slots?season=eq." + season + "&week=eq." + week + "&team_id=in.(" + encodeURIComponent(teams) + ")" +
        "&select=team_id,slot,player_id,nfl_players(name,position,nfl_team)&order=slot").then(function (ls) {
        var rows = (ls.ok && ls.data) || [];
        var ids = rows.map(function (x) { return '"' + x.player_id + '"'; }).join(",");
        var pts = ids ? get("player_scores?season=eq." + season + "&week=eq." + week + "&player_id=in.(" + encodeURIComponent(ids) + ")&select=player_id,points,source")
          : Promise.resolve({ ok: true, data: [] });
        return pts.then(function (p) {
          var byId = {};
          ((p.ok && p.data) || []).forEach(function (x) { byId[x.player_id] = Number(x.points); });
          var out = {};
          teamIds.forEach(function (t) { out[t] = []; });
          rows.forEach(function (x) {
            var n = x.nfl_players || {};
            (out[x.team_id] = out[x.team_id] || []).push({ slot: x.slot, pos: (L.lineupSlots || [])[x.slot] || n.position, name: n.name || x.player_id,
              nfl: n.nfl_team || "", points: byId.hasOwnProperty(x.player_id) ? byId[x.player_id] : null });
          });
          var sw = (r[1].ok && r[1].data && r[1].data[0]) || null;
          return { status: sw ? sw.status : null, delayed: !!(sw && sw.live_delayed), teams: out, readable: !!session };
        });
      });
    });
  }

  /** 9 slot rows (empty slots included) with points and a total. */
  function lineupListHtml(players) {
    var bySlot = {};
    players.forEach(function (p) { bySlot[p.slot] = p; });
    var total = 0;
    var items = (L.lineupSlots || []).map(function (pos, i) {
      var p = bySlot[i];
      if (p && p.points != null) total += p.points;
      return '<li><span class="pos pos-' + esc(pos) + '">' + esc(pos) + "</span>" +
        (p ? '<span class="pname">' + esc(p.name) + ' <span class="muted nfl">' + esc(p.nfl) + "</span></span>" +
          '<span class="mu-pts">' + (p.points == null ? "–" : esc(p.points.toFixed(1))) + "</span>"
          : '<span class="pname muted">Empty</span><span class="mu-pts">–</span>') + "</li>";
    }).join("");
    return '<ul class="mu-slots">' + items + '</ul><p class="mu-total"><span>Total</span><b>' + esc((Math.round(total * 100) / 100).toFixed(1)) + "</b></p>";
  }
  var statusText = function (s) {
    return !s || !s.status ? "Not started" : s.status === "live" ? "Live" + (s.delayed ? " (scoring delayed; last good numbers shown)" : "")
      : s.status === "final" ? "Final" : "Final (awaiting commissioner sign-off)";
  };

  function shadowLineupHtml() {
    var w = st.wk;
    if (!w) return "";
    if (w.error) return '<div class="card"><p class="acct-msg err">' + esc(w.error) + "</p></div>";
    var mine = (w.data && w.data.teams[st.teamId]) || [];
    return '<div class="card"><h3>Week ' + esc(w.week) + ' lineup <span class="tag">' + esc(statusText(w.data)) + "</span></h3>" +
      (mine.length ? lineupListHtml(mine) : '<p class="muted">No starters for week ' + esc(w.week) + " yet.</p>") +
      '<p class="muted small">Mirrored from MFL. <b>MFL is official for ' + esc(L.season) + "</b>: set your lineup there. Points are this site\'s, from live ESPN stats, finalized nightly by nflverse." +
      (w.matchup ? ' <a href="#live/' + esc(w.week) + "/" + esc(st.teamId) + '">Open the matchup</a>' : "") + "</p></div>";
  }

  // Week to show on My Team (2026): the current week if it has starters, else the latest week that does.
  function loadShadowWeek(teamId) {
    var season = Number(L.season), session = st.me && st.me.session;
    var get = function (p) { return A.api(cfg, session, p, {}, f); };
    return Promise.all([
      get("nfl_games?season=eq." + season + "&select=week,kickoff&order=kickoff"),
      get("lineup_slots?season=eq." + season + "&team_id=eq." + encodeURIComponent(teamId) + "&select=week&order=week.desc&limit=1")
    ]).then(function (r) {
      var cur = pickWeek((r[0].ok && r[0].data) || [], Date.now());
      var last = r[1].ok && r[1].data && r[1].data[0] ? r[1].data[0].week : null;
      var week = cur != null && last != null && last >= cur ? cur : last != null ? last : cur;
      if (week == null) { st.wk = null; return; }
      return Promise.all([weekLineups(season, week, [teamId]),
        A.api(cfg, null, "matchups?season=eq." + season + "&week=eq." + week + "&or=(home_team.eq." + teamId + ",away_team.eq." + teamId + ")&select=home_team,away_team", {}, f)])
        .then(function (x) {
          var m = x[1].ok && x[1].data && x[1].data[0];
          st.wk = { week: week, data: x[0], matchup: m ? [m.away_team, m.home_team] : null };
        });
    }).catch(function (e) { st.wk = { error: "Couldn't load this week's lineup: " + e.message }; });
  }

  // ---- Team activity (co-owners: lineups and picks belong to the team) -------------
  /** One activity entry as text: who changed what. names: user id -> name; players: id -> name. */
  function activityText(a, names, players) {
    var who = (a.actor && names[a.actor]) || (a.actor ? "An owner" : "Server");
    var d = a.details || {}, wk = a.week != null ? "week " + a.week + " " : "";
    var nm = function (id) { return (players && players[id]) || id; };
    if (a.kind === "lineup") {
      var ins = (d.in || []).map(function (x) { return nm(x.player); }), outs = (d.out || []).map(function (x) { return nm(x.player); });
      var moved = ins.filter(function (x) { return outs.indexOf(x) >= 0; });
      ins = ins.filter(function (x) { return moved.indexOf(x) < 0; }); outs = outs.filter(function (x) { return moved.indexOf(x) < 0; });
      var parts = (ins.length ? ["in: " + ins.join(", ")] : []).concat(outs.length ? ["out: " + outs.join(", ")] : []).concat(moved.length ? ["moved: " + moved.join(", ")] : []);
      return who + " changed the " + wk + "lineup" + (parts.length ? " (" + parts.join("; ") + ")" : "");
    }
    if (a.kind === "survivor") {
      var last = (d.picks || [])[(d.picks || []).length - 1] || {};
      return last.op === "delete" ? who + " removed the " + wk + "Survivor pick" : who + " picked " + last.nfl_team + " in Survivor (" + wk.trim() + ")";
    }
    var n = (d.picks || []).length;
    return who + " updated the " + wk + "Confidence picks (" + n + " change" + (n === 1 ? "" : "s") + ")";
  }
  /** "Lineup last changed by Mike, 2:14 PM" */
  function lastChangedText(meta, names) {
    if (!meta || !meta.changed_at) return "";
    return "Lineup last changed by " + ((meta.changed_by && names[meta.changed_by]) || "an owner") + ", " +
      new Date(meta.changed_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  /** The database's "changed by X at T since you opened it" refusal (another owner saved first). */
  var isConflict = function (msg) { return /since you opened it/.test(String(msg || "")); };

  function loadActivity(teamId) {
    var s = st.me && st.me.session;
    if (!s) return Promise.resolve();
    return Promise.all([
      A.api(cfg, s, "team_activity?team_id=eq." + encodeURIComponent(teamId) + "&select=id,season,week,kind,actor,at,details&order=at.desc&limit=8", {}, f),
      A.api(cfg, s, "team_managers?select=user_id,profiles(display_name)", {}, f)
    ]).then(function (r) {
      st.names = {};
      ((r[1].ok && r[1].data) || []).forEach(function (x) { st.names[x.user_id] = (x.profiles && x.profiles.display_name) || ""; });
      st.activity = r[0].ok ? r[0].data || [] : null;
    });
  }
  function activityHtml() {
    if (!st.activity || !st.activity.length) return "";
    var players = {};
    ((st.lu && st.lu.roster) || []).forEach(function (p) { players[p.id] = p.name; });
    return '<div class="card mt-activity"><h3>Team activity</h3><ul class="checks">' + st.activity.map(function (a) {
      return "<li>" + esc(activityText(a, st.names || {}, players)) + ' <span class="muted small">' + esc(fmtKick(Date.parse(a.at))) + "</span></li>";
    }).join("") + '</ul><p class="muted small">Lineups and picks belong to the team: either owner can change them, and the last save wins.</p></div>';
  }

  // ---- Lineup editor (open seasons) ----------------------------------------------
  function luInfo(p) {
    var lu = st.lu, k = p ? kickoffFor(lu.weekGames, p.nfl) : null;
    if (!p) return { text: "", locked: false, bye: false };
    if (k == null) return { text: "Bye", locked: false, bye: true };
    var g = lu.weekGames.filter(function (x) { return x.home === p.nfl || x.away === p.nfl; })[0];
    var opp = g.home === p.nfl ? "vs " + g.away : "@ " + g.home;
    return { text: opp + " · " + fmtKick(k), locked: Date.now() >= k, bye: false };
  }

  function editorHtml() {
    var lu = st.lu;
    if (lu.error) return '<div class="card"><h3>Lineup</h3><p class="acct-msg err">' + esc(lu.error) + "</p></div>";
    if (lu.week == null) return '<div class="card"><h3>Lineup</h3><p class="muted">No games left on the ' + esc(L.season) + " schedule.</p></div>";
    var slots = L.lineupSlots || ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
    var byId = {};
    lu.roster.forEach(function (p) { byId[p.id] = p; });
    var used = {};
    lu.draft.forEach(function (id) { if (id) used[id] = true; });
    var rows = slots.map(function (pos, i) {
      var cur = byId[lu.draft[i]], gi = luInfo(cur), lockedHere = !!(cur && gi.locked && lu.savedIds[cur.id] === i);
      var opts = lu.roster.filter(function (p) { return p.pos === pos && (p.id === lu.draft[i] || !used[p.id]); }).map(function (p) {
        var g = luInfo(p), sel = p.id === lu.draft[i];
        return '<option value="' + esc(p.id) + '"' + (sel ? " selected" : "") + (g.locked && !sel ? " disabled" : "") + ">" +
          esc(p.name) + " (" + esc(p.nfl || "FA") + ")" + (g.locked ? " 🔒" : g.bye ? " · BYE" : "") + "</option>";
      }).join("");
      return '<div class="lu-row' + (lockedHere ? " locked" : "") + '"><span class="pos pos-' + esc(pos) + '">' + esc(pos) + "</span>" +
        '<div class="lu-pick"><select data-slot="' + i + '"' + (lockedHere ? " disabled" : "") + ' aria-label="' + esc(pos) + " slot " + (i + 1) + '">' +
        '<option value="">Empty</option>' + opts + "</select>" +
        '<span class="muted lu-game">' + (cur ? (lockedHere ? "🔒 " : "") + esc(gi.bye ? "⚠ Bye week" : gi.text) : "") + "</span></div></div>";
    }).join("");
    var empty = lu.draft.filter(function (x) { return !x; }).length;
    var status = lu.saved ? "Saved." : lu.carried ? "Carried over from week " + lu.carried + ". Save to confirm it." : "Not set yet.";
    var first = lu.weekGames.length ? Math.min.apply(null, lu.weekGames.map(function (g) { return Date.parse(g.kickoff); })) : null;
    return '<div class="card lu-edit"><h3>Week ' + esc(lu.week) + " lineup</h3>" +
      (lu.meta && lu.meta.changed_at ? '<p class="small lu-last">' + esc(lastChangedText(lu.meta, st.names || {})) + "</p>" : "") +
      '<p class="muted small lu-status">' + esc(status) + " " +
      esc(first && Date.now() < first ? "First game " + fmtKick(first) + " ET. Each player locks at his own kickoff." : "Players lock at their own kickoff.") + "</p>" +
      rows + '<div class="lu-actions"><button class="btn" data-mt="save" type="button">Save lineup</button>' +
      (empty ? '<span class="muted small">' + empty + " empty slot" + (empty > 1 ? "s" : "") + "</span>" : "") + "</div>" +
      msgHtml(lu.msg) + "</div>";
  }

  function loadLineup(teamId) {
    var s = st.me.session, season = Number(L.season);
    var api = function (p) { return A.api(cfg, s, p, {}, f); };
    return api("nfl_games?season=eq." + season + "&select=week,home,away,kickoff&order=kickoff").then(function (g) {
      if (!g.ok) throw new Error(g.error);
      var games = g.data || [], week = pickWeek(games, Date.now());
      var base = "&season=eq." + season + "&team_id=eq." + encodeURIComponent(teamId);
      return Promise.all([
        api("roster_entries?select=player_id,acquired,nfl_players(name,position,nfl_team)" + base),
        week == null ? Promise.resolve({ ok: true, data: [] }) : api("lineup_slots?select=slot,player_id&week=eq." + week + base),
        week == null || week < 2 ? Promise.resolve({ ok: true, data: [] }) : api("lineup_slots?select=slot,player_id&week=eq." + (week - 1) + base),
        week == null ? Promise.resolve({ ok: true, data: [] }) : api("lineup_meta?select=version,changed_by,changed_at&week=eq." + week + base)
      ]).then(function (r) {
        var bad = r.filter(function (x) { return !x.ok; })[0];
        if (bad) throw new Error(bad.error);
        var d = draftFrom(r[1].data, r[2].data, week - 1), savedIds = {};
        (r[1].data || []).forEach(function (x) { savedIds[x.player_id] = x.slot; });
        st.lu = {
          week: week, weekGames: games.filter(function (x) { return x.week === week; }),
          roster: (r[0].data || []).map(function (x) {
            var p = x.nfl_players || {};
            return { id: x.player_id, name: p.name || x.player_id, pos: p.position, nfl: p.nfl_team, acquired: x.acquired || "" };
          }).sort(byPos),
          draft: d.draft, saved: d.saved, carried: d.carried, savedIds: savedIds, msg: st.lu && st.lu.keepMsg || null,
          // The version this page loaded: saving over someone else's newer change is refused until confirmed.
          meta: (r[3].data || [])[0] || null, version: ((r[3].data || [])[0] || { version: 0 }).version
        };
      });
    }).catch(function (e) { st.lu = { error: "Couldn't load your lineup: " + e.message }; });
  }

  function render(rootEl) {
    var notice = root.B5AuthNotice && root.B5AuthNotice.signedIn ? { ok: "You're signed in." } : null;
    if (notice) root.B5AuthNotice = null;
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>My Team</h2><div class="card"><p>Sign-in isn\'t set up yet.</p></div></section>'; return; }
    if (!st.me) {
      rootEl.innerHTML = '<section><h2>My Team</h2><div class="card"><p>Managers: <a href="#account">sign in</a> to see your team' +
        (lineupsOpen(L) ? " and set your lineup" : "") + ".</p></div></section>";
      return;
    }
    var t = teamOf(st.teamId);
    if (!t && !st.me.profile) {   // the account lookup failed (network, expired session): don't claim "no team"
      rootEl.innerHTML = '<section><h2>My Team</h2>' + msgHtml(notice) + '<div class="card"><p class="acct-msg err">Couldn\'t load your team. Reload the page to try again.</p></div></section>';
      return;
    }
    if (!t) {
      rootEl.innerHTML = '<section><h2>My Team</h2>' + msgHtml(notice) + '<div class="card"><p>You\'re not assigned to a team yet. Ask the commissioner.</p></div></section>';
      return;
    }
    var open = lineupsOpen(L);
    var rosterNote = L.rosters && L.rosters.asOf ? "As of " + fmtDate(L.rosters.asOf) + (L.rosters.week ? " (week " + L.rosters.week + ")" : "") + "." : "";
    rootEl.innerHTML = '<section class="mt">' + msgHtml(notice || st.msg) + headerHtml(t) +
      '<div class="mt-cols"><div>' + (open ? editorHtml() : shadowLineupHtml() + closedHtml()) + activityHtml() + "</div><div>" +
      (open ? rosterHtml(st.lu && st.lu.roster || [], "")
        : st.dbRosters ? rosterHtml(st.dbRosters[t.id] || [], "Current roster (synced nightly).")
        : rosterHtml(leagueRoster(L, t.id), rosterNote)) + "</div></div></section>";
    st.msg = null;
  }

  function show(rootEl) {
    var act = st.me && teamOf(st.teamId) ? loadActivity(st.teamId).catch(function () {}) : Promise.resolve();
    if (!lineupsOpen(L) && st.me && teamOf(st.teamId)) return Promise.all([loadShadowWeek(st.teamId), act]).then(function () { render(rootEl); });
    if (!lineupsOpen(L) || !st.me || !teamOf(st.teamId)) { render(rootEl); return Promise.resolve(); }
    return Promise.all([loadLineup(st.teamId), act]).then(function () { render(rootEl); });
  }

  var bound = null;
  function start(rootEl) {
    rootEl.innerHTML = '<section><h2>My Team</h2><p class="muted">Loading…</p></section>';
    var load = root.B5Account ? root.B5Account.load() : Promise.resolve(null);
    load.then(function (me) {
      st.me = me;
      if (root.B5Account) root.B5Account.refreshNav();
      var ids = myTeams();
      if (ids.indexOf(st.teamId) < 0) st.teamId = me && me.teams.length ? me.teams[0].team_id : ids[0] || null;
      return (me && root.B5Account.managerNames ? root.B5Account.managerNames() : Promise.resolve({}))
        .then(function (m) { st.managers = m; return loadRosters(); })
        .then(function (r) { st.dbRosters = r; return root.B5Payouts ? root.B5Payouts.teamWinnings() : {}; })
        .then(function (w) { st.won = w; return show(rootEl); });
    }, function () { rootEl.innerHTML = '<section><h2>My Team</h2><p class="acct-msg err">Couldn\'t load your account.</p></section>'; });

    if (bound === rootEl) return;
    bound = rootEl;
    rootEl.addEventListener("change", function (e) {
      var pick = e.target.closest("[data-mt='team']");
      if (pick) { st.teamId = pick.value; st.lu = null; st.wk = null; show(rootEl); return; }
      var sel = e.target.closest("select[data-slot]");
      if (sel && st.lu) { st.lu.draft[Number(sel.dataset.slot)] = sel.value || null; st.lu.msg = null; render(rootEl); }
    });
    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-mt='save']");
      if (!b || !st.lu) return;
      b.disabled = true;
      var send = function (s, expected) {
        return A.api(cfg, s, "rpc/save_lineup", { method: "POST", body: JSON.stringify({
          p_season: Number(L.season), p_week: st.lu.week, p_team: st.teamId, p_players: st.lu.draft, p_expected_version: expected
        }) }, f);
      };
      A.current(cfg, { storage: storage, fetchImpl: f, now: Date.now() }).then(function (s) {
        if (!s) throw new Error("You've been signed out. Sign in again.");
        st.me.session = s;
        return send(s, st.lu.version).then(function (r) {
          // The other owner saved after this page loaded: say who and when, and let this owner decide.
          if (r.ok || !isConflict(r.error)) return r;
          if (root.confirm(r.error + ".\n\nSave your lineup anyway? It replaces theirs (the last save wins).")) return send(s, null);
          st.lu.keepMsg = { err: r.error + ". Your changes weren't saved; this is the lineup as it is now." };
          return { ok: true, reloaded: true };
        });
      }).then(function (r) {
        if (!r.ok) throw new Error(r.error);
        if (!r.reloaded) st.lu.keepMsg = { ok: "Lineup saved " + fmtKick(Date.now()) + " ET." };
        return Promise.all([loadLineup(st.teamId), loadActivity(st.teamId)]);
      }).catch(function (err) {
        // The database names players by ID; show names.
        var text = String(err.message || "");
        (st.lu.roster || []).forEach(function (p) { text = text.split(p.id).join(p.name); });
        st.lu.msg = { err: "Not saved: " + text };
      }).then(function () { render(rootEl); });
    });
  }

  root.B5MyTeam = { start: start, activityText: activityText, lastChangedText: lastChangedText, isConflict: isConflict, lineupListHtml: lineupListHtml, statusText: statusText, loadRosters: loadRosters, rostersFromRows: rostersFromRows, lineupsOpen: lineupsOpen, recordFor: recordFor, leagueRoster: leagueRoster, pickWeek: pickWeek, draftFrom: draftFrom, kickoffFor: kickoffFor };
})(typeof globalThis !== "undefined" ? globalThis : this);
