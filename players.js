/* Players (#players, #players/<tab>): free agents, add/drop, waiver claims, waiver order, processed
   waivers, transactions log, and the commissioner's waiver tools. Members only (the free-agent list,
   claims and transactions are members-only in the database).
   The rules live in the database (migration waivers; settings in season_settings.waivers): each
   player locks at his own NFL kickoff until the week's last game ends; Monday 10 PM ET everyone goes
   on waivers; Wednesday 5 PM ET claims process (worst-to-first by total points, up to 8 rounds);
   then first-come-first-served until each player's kickoff; dropped players are claims-only for 24
   hours; 18-man rosters. This page only shows statuses the database computes (public.free_agents)
   and calls its functions (roster_move, waiver_claim, waiver_reorder, waiver_update, run_waivers_now,
   undo_waiver_run, reverse_drop).
   2026: MFL is official ("live": false): a preview, with MFL's transactions imported nightly. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var season = Number(L.season), POS = ["QB", "RB", "WR", "TE", "K", "DEF"];
  var TL = function () { return root.B5Team; };   // team names and profile links (teamlink.js)
  var tlink = function (id) { return TL().link(id, { logo: false }); };
  var when = function (iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : ""; };
  var whenDate = function (iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; };

  // ---- Pure helpers (tested in src/workers/players-page.test.ts) -------------------------------
  /** What a free agent's row offers: "add" (FCFS), "claim" (claims only, with why/until) or nothing. */
  function action(p) {
    if (p.status === "fcfs") return { kind: "add", label: "Add", note: "Free agent" };
    if (p.status === "claims") return { kind: "claim", label: "Claim", note: (p.reason || "Claims only") + (p.until && !/process/.test(p.reason || "") ? " · until " + when(p.until) : "") };
    return { kind: null, label: "", note: p.reason || "Closed" };
  }
  /** Search by name or NFL team, filter by position. */
  function filterPlayers(list, q, pos) {
    var s = String(q || "").trim().toLowerCase();
    return list.filter(function (p) { return (!pos || p.pos === pos) && (!s || p.name.toLowerCase().indexOf(s) >= 0 || String(p.nfl_team || "").toLowerCase() === s); });
  }
  /** Move item `from` to `to` (drag-to-rank). */
  function moveItem(list, from, to) {
    var out = list.slice(), x = out.splice(from, 1)[0];
    out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
    return out;
  }
  /** A transaction as a line: "Mac Daddies added Joe Burrow, dropped Bo Nix (waiver claim)". html: team names as TeamLinks. */
  function txnText(t, names, html) {
    var tn = function (id) { return html ? tlink(id) : TL().name(id); }, tx = function (x) { return html ? esc(x) : x; };
    var nm = function (id) { return names[id] || (/^mfl:/.test(id) ? "MFL player " + id.slice(4) : id); };
    var parts = [];
    if (t.type === "trade") return tn(t.team_id) + tx(" traded " + (t.players_out || []).map(nm).join(", ") + " to ") + tn(t.partner_team_id) + tx(" for " + (t.players_in || []).map(nm).join(", ") + (t.via === "mfl" ? " (on MFL)" : ""));
    if ((t.players_in || []).length) parts.push("added " + t.players_in.map(nm).join(", "));
    if ((t.players_out || []).length) parts.push("dropped " + t.players_out.map(nm).join(", "));
    var via = { waiver: "waiver claim", commissioner: "by the commissioner", mfl: "on MFL", trade: "part of a trade", free_agent: "" }[t.via] || "";
    return tn(t.team_id) + tx(" " + parts.join(", ") + (via ? " (" + via + ")" : "") + (t.status === "reversed" ? " — reversed" : ""));
  }
  /** The weekly calendar in words, from the season's settings. */
  function calendarText(w) {
    var day = function (d) { return ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][d]; };
    var t = function (hm) { var h = Number(hm.split(":")[0]), m = hm.split(":")[1]; return ((h + 11) % 12 + 1) + ":" + m + " " + (h < 12 ? "AM" : "PM"); };
    var s = w.waiversStart || { isodow: 1, time: "22:00" }, p = w.process || { isodow: 3, time: "17:00" };
    return "Each player locks at his own NFL kickoff until the week's last game ends. " + day(s.isodow) + " " + t(s.time) + " ET every free agent goes on waivers; " +
      "claims process " + day(p.isodow) + " " + t(p.time) + " ET (worst-to-first by total points, up to " + (w.rounds || 8) + " rounds); then first-come-first-served until each player's kickoff. " +
      "Dropped players are claims-only for " + (w.dropLockHours || 24) + " hours. Rosters max " + (w.rosterMax || 18) + ".";
  }

  // ---- State / data --------------------------------------------------------------------------
  var st = { me: null, el: null, tab: "free-agents", fa: [], q: "", pos: "", shown: 50, roster: [], claims: [], order: [], runs: [], done: [], txns: [], names: {}, people: {},
    settings: {}, live: false, pick: null, msg: null, busy: false, drag: null };
  var session = function () { return st.me && st.me.session; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var myTeam = function () { return st.me && st.me.teams && st.me.teams[0] ? st.me.teams[0].team_id : null; };
  var isMember = function () { return !!(st.me && (isCommish() || myTeam())); };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var ok = function (x) { return x && x.ok ? x.data || [] : []; };
  var rpc = function (name, body) { return api("rpc/" + name, { method: "POST", body: JSON.stringify(body) }); };
  var inList = function (ids) { return encodeURIComponent(ids.map(function (i) { return '"' + String(i).replace(/"/g, "") + '"'; }).join(",")); };

  function load() {
    var mine = myTeam();
    return Promise.all([
      api("season_settings?season=eq." + season + "&select=waivers"),
      rpc("free_agents", { p_season: season }),
      mine ? api("roster_entries?season=eq." + season + "&team_id=eq." + mine + "&select=player_id,nfl_players(name,position,nfl_team)") : Promise.resolve({ ok: true, data: [] }),
      api("waiver_claims?season=eq." + season + "&select=*&order=status,rank,id&limit=500"),
      rpc("waiver_order", { p_season: season }),
      api("waiver_runs?season=eq." + season + "&select=*&order=ran_at.desc&limit=10"),
      api("transactions?season=eq." + season + "&status=in.(processed,reversed)&select=id,team_id,type,status,players_in,players_out,partner_team_id,via,created_at,created_by,note&order=created_at.desc&limit=150"),
      api("team_managers?select=user_id,team_id,profiles(display_name)")
    ]).then(function (r) {
      st.settings = Object.assign({ live: false }, ((ok(r[0])[0] || {}).waivers) || {});
      st.fa = ok(r[1]); st.live = st.fa.length ? !!st.fa[0].live : !!st.settings.live;
      st.roster = ok(r[2]).map(function (x) { var n = x.nfl_players || {}; return { id: x.player_id, name: n.name || x.player_id, pos: n.position, nfl: n.nfl_team }; });
      st.claims = ok(r[3]); st.order = ok(r[4]); st.runs = ok(r[5]); st.txns = ok(r[6]);
      st.people = {}; ok(r[7]).forEach(function (x) { st.people[x.user_id] = (x.profiles && x.profiles.display_name) || TL().name(x.team_id); });
      // Names for every player the claims and transactions mention.
      st.names = {};
      st.fa.forEach(function (p) { st.names[p.player_id] = p.name; });
      st.roster.forEach(function (p) { st.names[p.id] = p.name; });
      var need = [];
      st.claims.forEach(function (c) { [c.add_player, c.drop_player].forEach(function (id) { if (id && !st.names[id]) need.push(id); }); });
      st.txns.forEach(function (t) { (t.players_in || []).concat(t.players_out || []).forEach(function (id) { if (id && !st.names[id] && !/^mfl:/.test(id)) need.push(id); }); });
      need = need.filter(function (x, i) { return need.indexOf(x) === i; });
      var chunks = [];
      for (var i = 0; i < need.length; i += 100) chunks.push(need.slice(i, i + 100));
      return Promise.all(chunks.map(function (c) { return api("nfl_players?id=in.(" + inList(c) + ")&select=id,name"); })).then(function (rs) {
        rs.forEach(function (x) { ok(x).forEach(function (p) { st.names[p.id] = p.name; }); });
      });
    });
  }

  // ---- Render --------------------------------------------------------------------------------
  var TABS = [["free-agents", "Free agents"], ["claims", "My claims"], ["order", "Waiver order"], ["results", "Results"], ["log", "Transactions"], ["trades", "Trades", "#trades"]];
  function tabsHtml() {
    var list = TABS.concat(isCommish() ? [["commish", "Commish"]] : []);
    return '<div class="weeks pl-tabs" role="tablist">' + list.map(function (t) {
      return '<a class="wk' + (st.tab === t[0] ? " active" : "") + '" href="' + (t[2] || "#players/" + t[0]) + '">' + esc(t[1]) + "</a>";
    }).join("") + "</div>";
  }
  function bannerHtml() {
    return (!st.live ? '<p class="pl-test"><b>MFL is official for ' + esc(season) + '.</b> Add/drops and waiver claims happen on MFL; the transactions here are imported from MFL nightly. This page is a preview: claims open on this site in ' + esc(season + 1) + ".</p>" : "") +
      '<p class="muted small">' + esc(calendarText(st.settings)) + "</p>" +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "");
  }
  function dropSelect(required) {
    return '<label class="pl-drop">' + (required ? "Drop (your roster is full)" : "Drop (optional)") + '<select name="drop"' + (required ? " required" : "") + '><option value="">' + (required ? "Pick a player to drop" : "Nobody") + "</option>" +
      st.roster.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + " (" + esc(p.pos) + ", " + esc(p.nfl || "FA") + ")</option>"; }).join("") + "</select></label>";
  }
  function faHtml() {
    var list = filterPlayers(st.fa, st.q, st.pos), full = st.roster.length >= (st.settings.rosterMax || 18), can = st.live && myTeam();
    var rows = list.slice(0, st.shown).map(function (p) {
      var a = action(p), open = st.pick === p.player_id;
      var btn = can && a.kind ? '<button type="button" class="btn' + (a.kind === "claim" ? " ghost" : "") + '" data-pl="pick" data-id="' + esc(p.player_id) + '">' + esc(a.label) + "</button>" : "";
      return '<li class="fa-row"><span class="pos pos-' + esc(p.pos) + '">' + esc(p.pos) + '</span><div class="fa-main"><b>' + esc(p.name) + '</b><span class="muted small">' + esc(p.nfl_team || "FA") + " · " + esc(Number(p.points).toFixed(1)) + " pts · " +
        '<span class="fa-' + esc(p.status) + '">' + esc(a.note) + "</span></span></div>" + btn +
        (open ? '<form class="fa-confirm" data-pl-move="' + esc(a.kind) + '" data-id="' + esc(p.player_id) + '">' + dropSelect(full) +
          '<button class="btn" type="submit">' + (a.kind === "add" ? "Add " : "Claim ") + esc(p.name) + '</button><button class="btn ghost" type="button" data-pl="unpick">Cancel</button></form>' : "") + "</li>";
    }).join("");
    return '<div class="card"><div class="fa-tools"><input type="search" placeholder="Search players or NFL team" value="' + esc(st.q) + '" data-pl="q" aria-label="Search">' +
      '<div class="fa-pos">' + [""].concat(POS).map(function (p) { return '<button type="button" class="wk' + (st.pos === p ? " active" : "") + '" data-pl="pos" data-pos="' + p + '">' + (p || "All") + "</button>"; }).join("") + "</div></div>" +
      (rows ? '<ul class="fa-list">' + rows + "</ul>" : '<p class="muted">No players match.</p>') +
      (list.length > st.shown ? '<button type="button" class="btn ghost" data-pl="more">Show more (' + (list.length - st.shown) + " more)</button>" : "") + "</div>" +
      (can && st.roster.length ? '<div class="card"><h3>Drop a player</h3><p class="muted small">Drop-only moves are fine. A player whose game has kicked off can\'t be dropped until the week\'s last game ends.</p><ul class="fa-list">' +
        st.roster.map(function (p) { return '<li class="fa-row"><span class="pos pos-' + esc(p.pos) + '">' + esc(p.pos) + '</span><div class="fa-main"><b>' + esc(p.name) + '</b><span class="muted small">' + esc(p.nfl || "") + '</span></div><button type="button" class="btn ghost" data-pl="drop" data-id="' + esc(p.id) + '">Drop</button></li>'; }).join("") + "</ul></div>" : "");
  }
  function claimsHtml() {
    var mine = st.claims.filter(function (c) { return c.team_id === myTeam() && c.status === "pending"; });
    if (!myTeam()) return '<div class="card muted">Claims are made by a team\'s owners.</div>';
    var who = function (c) { var by = c.updated_by || c.created_by; return by ? (c.updated_by ? "reordered by " : "added by ") + (st.people[by] || "an owner") : ""; };
    return '<div class="card"><h3>Pending claims (' + mine.length + ")</h3>" +
      (mine.length ? '<p class="muted small">Drag ☰ (or use ▲ ▼) to rank them; they process ' + esc(when(nextProcess())) + ". Either owner can change them.</p><ol class=\"cl-list\" data-pl-list>" + mine.map(function (c, i) {
        return '<li class="cl-row" data-id="' + c.id + '"><span class="cl-handle" data-pl-handle aria-label="Drag to reorder">☰</span><div class="fa-main"><b>' + (i + 1) + ". " + esc(st.names[c.add_player] || c.add_player) + "</b>" +
          '<span class="muted small">' + (c.drop_player ? "drop " + esc(st.names[c.drop_player] || c.drop_player) : "no drop") + " · " + esc(who(c)) + "</span></div>" +
          '<div class="cl-btns"><button type="button" data-pl="up" data-i="' + i + '" aria-label="Move up">▲</button><button type="button" data-pl="down" data-i="' + i + '" aria-label="Move down">▼</button>' +
          '<button type="button" data-pl="cancel" data-id="' + c.id + '" aria-label="Cancel claim">✕</button></div></li>';
      }).join("") + "</ol>" : '<p class="muted">No pending claims. Use Claim on a player who\'s on waivers or locked.</p>') + "</div>";
  }
  var nextProcess = function () {
    var p = st.settings.process || { isodow: 3, time: "17:00" };
    var now = new Date(), et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    var d = (p.isodow % 7) - et.getDay(); if (d < 0) d += 7;
    var hm = p.time.split(":"), target = new Date(et); target.setDate(et.getDate() + d); target.setHours(Number(hm[0]), Number(hm[1]), 0, 0);
    if (target <= et) target.setDate(target.getDate() + 7);
    return new Date(now.getTime() + (target - et)).toISOString();
  };
  function orderHtml() {
    return '<div class="card"><h3>Waiver order</h3><p class="muted small">Fewest total points first; ties: head-to-head, then win %, then division win %. The same order every round; recalculated at each run.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th class="num">Points</th><th class="num">Record</th></tr></thead><tbody>' +
      st.order.map(function (o) { return "<tr" + (o.team_id === myTeam() ? ' class="me"' : "") + "><td>" + esc(o.place) + "</td><td>" + tlink(o.team_id) + '</td><td class="num">' + esc(Number(o.points_for).toFixed(1)) + '</td><td class="num">' + esc(o.wins + "-" + o.losses + (o.ties ? "-" + o.ties : "")) + "</td></tr>"; }).join("") +
      "</tbody></table></div></div>";
  }
  function resultsHtml() {
    var runs = st.runs.filter(function (r) { return r.status === "done"; });
    if (!runs.length) return '<div class="card muted">No waiver runs yet.</div>';
    return runs.map(function (r) {
      var rankOf = { won: 0, lost: 1, skipped: 2 };
      var cs = st.claims.filter(function (c) { return c.run_id === r.id; }).sort(function (a, b) { return (rankOf[a.status] || 3) - (rankOf[b.status] || 3) || TL().name(a.team_id).localeCompare(TL().name(b.team_id)); });
      return '<div class="card"><h3>Waivers ' + esc(whenDate(r.ran_at)) + (r.kind === "forced" ? ' <span class="tag">run by the commissioner</span>' : "") + "</h3>" +
        '<ul class="checks">' + cs.map(function (c) {
          return "<li><b>" + tlink(c.team_id) + "</b>: " + esc(st.names[c.add_player] || c.add_player) + (c.drop_player ? " (drop " + esc(st.names[c.drop_player] || c.drop_player) + ")" : "") +
            ' — <span class="cl-' + esc(c.status) + '">' + esc(c.status) + "</span>" + (c.result ? ' <span class="muted small">' + esc(c.result) + "</span>" : "") + "</li>";
        }).join("") + "</ul></div>";
    }).join("");
  }
  function logHtml() {
    if (!st.txns.length) return '<div class="card muted">No transactions yet.</div>';
    return '<div class="card"><ul class="checks tx-log">' + st.txns.map(function (t) {
      var canReverse = isCommish() && t.status === "processed" && (t.players_out || []).length && t.type !== "trade" && t.via !== "mfl";
      return "<li>" + txnText(t, st.names, true) + ' <span class="muted small">' + esc(whenDate(t.created_at)) + (t.created_by && st.people[t.created_by] ? " · " + esc(st.people[t.created_by]) : "") + "</span>" +
        (canReverse ? ' <button class="linkish" type="button" data-pl="reverse" data-id="' + t.id + '">Reverse drop</button>' : "") + "</li>";
    }).join("") + "</ul></div>";
  }
  function commishHtml() {
    var pending = st.claims.filter(function (c) { return c.status === "pending"; });
    return '<div class="card"><h3>Pending claims, all teams (' + pending.length + ")</h3>" +
      (pending.length ? '<ul class="checks">' + pending.map(function (c) { return "<li><b>" + tlink(c.team_id) + "</b> #" + c.rank + ": " + esc(st.names[c.add_player] || c.add_player) + (c.drop_player ? " (drop " + esc(st.names[c.drop_player] || c.drop_player) + ")" : "") + "</li>"; }).join("") + "</ul>" : '<p class="muted">None.</p>') +
      (st.live ? '<button type="button" class="btn" data-pl="run">Process waivers now</button>' : '<p class="muted small">Processing opens with live claims (' + esc(season + 1) + "); MFL runs " + esc(season) + "'s waivers.</p>") + "</div>" +
      '<div class="card"><h3>Waiver runs</h3>' + (st.runs.length ? '<ul class="checks">' + st.runs.map(function (r) {
        return "<li>" + esc(whenDate(r.ran_at)) + " · " + esc(r.kind) + " · " + esc(r.won) + " won · " + esc(r.status) + (r.status === "done" ? ' <button class="linkish" type="button" data-pl="undo" data-id="' + r.id + '">Undo this run</button>' : "") + "</li>";
      }).join("") + "</ul>" : '<p class="muted">None yet.</p>') +
      '<p class="muted small">Reverse a drop from the Transactions tab (only when reported within ' + esc(st.settings.reverseDropMinutes || 30) + " minutes of the drop). Every action here is in the audit log.</p></div>";
  }
  function render() {
    if (!st.el) return;
    if (!isMember()) {
      st.el.innerHTML = '<section><h2>Players</h2><div class="card bd-gate"><p><b>' + (st.me ? "For league members." : "Sign in to see free agents and waivers.") + "</b></p>" + (st.me ? "" : '<a class="btn" href="#account">Sign in</a>') + "</div></section>";
      return;
    }
    var body = { "free-agents": faHtml, claims: claimsHtml, order: orderHtml, results: resultsHtml, log: logHtml, commish: isCommish() ? commishHtml : faHtml }[st.tab] || faHtml;
    st.el.innerHTML = '<section class="pl-page"><h2>Players</h2>' + tabsHtml() + bannerHtml() + body() + "</section>";
  }

  // ---- Actions -------------------------------------------------------------------------------
  var friendly = function (e) { return String(e || "").replace(/^.*?: /, function (m) { return /HTTP/.test(m) ? "" : m; }); };
  function after(p, okMsg) {
    st.busy = true;
    return p.then(function (r) {
      st.busy = false;
      st.msg = r && r.ok === false ? { err: friendly(r.error) } : { ok: okMsg };
      st.pick = null;
      return load();
    }).then(render, function () { render(); });
  }
  function saveOrder(ids) {
    return after(rpc("waiver_reorder", { p_season: season, p_team: myTeam(), p_ids: ids }), "Claim order saved.");
  }
  function act(b) {
    var k = b.dataset.pl, id = b.dataset.id;
    if (k === "pick") { st.pick = id; render(); return; }
    if (k === "unpick") { st.pick = null; render(); return; }
    if (k === "pos") { st.pos = b.dataset.pos; st.shown = 50; render(); return; }
    if (k === "more") { st.shown += 50; render(); return; }
    if (k === "drop" && root.confirm("Drop " + (st.names[id] || id) + "?")) { after(rpc("roster_move", { p_season: season, p_team: myTeam(), p_add: null, p_drop: id }), "Dropped " + (st.names[id] || id) + "."); return; }
    var mine = st.claims.filter(function (c) { return c.team_id === myTeam() && c.status === "pending"; });
    if (k === "up" || k === "down") {
      var i = Number(b.dataset.i), j = i + (k === "up" ? -1 : 1);
      if (j < 0 || j >= mine.length) return;
      saveOrder(moveItem(mine, i, j).map(function (c) { return c.id; }));
      return;
    }
    if (k === "cancel" && root.confirm("Cancel this claim?")) { after(rpc("waiver_update", { p_claim: Number(id), p_cancel: true }), "Claim cancelled."); return; }
    if (k === "run" && root.confirm("Process waivers now? Every pending claim is decided in waiver order.")) { after(rpc("run_waivers_now", { p_season: season }), "Waivers processed."); return; }
    if (k === "undo" && root.confirm("Undo this waiver run? Rosters go back and its claims become pending again.")) { after(rpc("undo_waiver_run", { p_run: Number(id) }), "Run undone."); return; }
    if (k === "reverse") {
      var rep = root.prompt("When did the manager report this drop? (ET, e.g. 2:15 PM today; leave as is for now)", "now");
      if (rep == null) return;
      var at = /^now$/i.test(rep.trim()) ? new Date() : parseEt(rep);
      if (!at) { st.msg = { err: "Couldn't read that time." }; render(); return; }
      after(rpc("reverse_drop", { p_transaction: Number(id), p_reported_at: at.toISOString() }), "Drop reversed.");
    }
  }
  // "2:15 PM" (today, ET) -> Date
  function parseEt(s) {
    var m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(s).trim()); if (!m) return null;
    var h = Number(m[1]) % 12 + (/pm/i.test(m[3]) ? 12 : 0);
    var now = new Date(), et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    var t = new Date(et); t.setHours(h, Number(m[2]), 0, 0);
    return new Date(now.getTime() + (t - et));
  }

  // Drag to rank (pointer events: mouse and touch).
  function startDrag(e) {
    var row = e.target.closest(".cl-row"), list = row && row.parentNode;
    if (!row) return;
    e.preventDefault();
    var rows = [].slice.call(list.children), from = rows.indexOf(row);
    st.drag = { row: row, list: list, from: from, to: from };
    row.classList.add("dragging");
    var move = function (ev) {
      var y = ev.clientY, items = [].slice.call(list.children), to = items.length - 1;
      for (var i = 0; i < items.length; i++) { var r = items[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { to = i; break; } }
      st.drag.to = to;
      items.forEach(function (x, i) { x.classList.toggle("drop-before", i === to && to !== st.drag.from); });
    };
    var up = function () {
      root.removeEventListener("pointermove", move); root.removeEventListener("pointerup", up);
      var d = st.drag; st.drag = null; row.classList.remove("dragging");
      if (!d || d.to === d.from) { render(); return; }
      var mine = st.claims.filter(function (c) { return c.team_id === myTeam() && c.status === "pending"; });
      var to = d.to > d.from ? d.to - 1 : d.to;
      saveOrder(moveItem(mine, d.from, to).map(function (c) { return c.id; }));
    };
    root.addEventListener("pointermove", move); root.addEventListener("pointerup", up);
  }

  function start(rootEl, r) {
    st.el = rootEl; st.tab = (r && r.tab) || "free-agents"; st.msg = null; st.pick = null;
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Players</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section><h2>Players</h2><p class="muted">Loading…</p></section>';
    var el = rootEl;
    (root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null)).then(function (me) {
      st.me = me;
      if (st.el !== el) return;
      if (!isMember()) { render(); return; }
      return load().then(function () { if (st.el === el) render(); });
    }).catch(function (e) { if (st.el === el) el.innerHTML = '<section><h2>Players</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });
    rootEl.addEventListener("click", function (e) { var b = e.target.closest("[data-pl]"); if (b && b.tagName !== "INPUT" && !st.busy) act(b); });
    rootEl.addEventListener("pointerdown", function (e) { if (e.target.closest("[data-pl-handle]")) startDrag(e); });
    rootEl.addEventListener("input", function (e) { if (e.target.matches("[data-pl=q]")) { st.q = e.target.value; st.shown = 50; var pos = e.target.selectionStart; render(); var i = st.el.querySelector("[data-pl=q]"); if (i) { i.focus(); i.setSelectionRange(pos, pos); } } });
    rootEl.addEventListener("submit", function (e) {
      var fm = e.target.closest("[data-pl-move]"); if (!fm) return;
      e.preventDefault();
      var add = fm.dataset.id, drop = fm.drop.value || null, nm = st.names[add] || add;
      if (fm.dataset.plMove === "add") after(rpc("roster_move", { p_season: season, p_team: myTeam(), p_add: add, p_drop: drop }), "Added " + nm + ".");
      else after(rpc("waiver_claim", { p_season: season, p_team: myTeam(), p_add: add, p_drop: drop }), "Claim for " + nm + " saved. Rank it on My claims.");
    });
  }
  function stop() { st.el = null; }

  root.B5Players = { start: start, stop: stop, action: action, filterPlayers: filterPlayers, moveItem: moveItem, txnText: txnText, calendarText: calendarText };
})(typeof globalThis !== "undefined" ? globalThis : this);
