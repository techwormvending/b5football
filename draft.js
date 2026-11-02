/* Draft Room (window.B5Draft): #draft (the drafts: the real one and practice drafts), #draft/<id>
   (the room), #draft/<id>/tv (big-screen board for the in-person draft). Members only (RLS).
   The database runs the draft (migration draft_room): the clock, every pick's checks, the orders,
   auto-picks and the commissioner's controls. This page shows it live (Realtime on drafts,
   draft_orders and draft_selections; a reconnect re-reads everything) and counts down the server's
   clock (offset from server_now()); when the clock hits zero any open page asks the server to act
   (draft_tick), which only does something if the clock really ran out. Rules shared with the board
   and hints: draftlogic.js (B5DraftLogic). */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth, DL = root.B5DraftLogic;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var f = function (u, i) { return root.fetch(u, i); };
  var T = function () { return root.B5Team; };
  var POS = ["QB", "RB", "WR", "TE", "K", "DEF"];
  var ROSTER_MAX = 18;

  var st = { el: null, id: null, tv: false, me: null, d: null, orders: {}, orderRows: {}, sel: [], owners: {}, players: [], pmap: {}, rank: {}, rankInfo: null,
    queue: [], byes: {}, tab: "players", q: "", pos: "", showDrafted: false, offset: 0, ticked: {}, sub: null, timer: null, msg: null, shown: 150, anim: null, seenOrders: {}, loading: false };
  var session = function () { return st.me && st.me.session; };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  // Each call remembers what it was ("draft_control:start"), for the error message if it fails
  var rpc = function (name, args) {
    var what = name + (args && args.p_action ? ":" + args.p_action : "");
    return api("rpc/" + name, { method: "POST", body: JSON.stringify(args || {}) }).then(function (r) { if (r) r.what = what; return r; });
  };
  var ok = function (r) { return r && r.ok ? r.data || [] : []; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var myTeam = function () { return st.me && st.me.teams && st.me.teams[0] ? st.me.teams[0].team_id : null; };
  var isMember = function () { return !!(st.me && (myTeam() || isCommish())); };
  var friendly = function (e) { return String(e || "").replace(/^.*?: /, ""); };
  // The draft's own refusals are written for people ("That pick was already made"); database or
  // network wording isn't: those get a plain message and are logged for administrators.
  var FRIENDLY = { "draft_control:start": "Couldn't start the draft.", "draft_control:pause": "Couldn't pause the draft.", "draft_control:resume": "Couldn't resume the draft.",
    "draft_control:extend": "Couldn't add time.", "draft_control:complete": "Couldn't finish the draft.", draft_undo: "Couldn't undo the pick.", draft_set_order: "Couldn't set the round's order.",
    draft_pick: "Couldn't make the pick.", draft_edit_pick: "Couldn't change the pick.", draft_create: "Couldn't create the draft.", draft_settings: "Couldn't save the settings.",
    draft_delete: "Couldn't delete the draft.", draft_rankings_upload: "Couldn't upload the rankings." };
  function technical(msg) {
    return /WHERE clause|permission denied for|does not exist|syntax error|violates .*constraint|null value|invalid input|relation "|column "|function |could not|unexpected|internal|HTTP [45]\d\d|Network error|JWT|schema cache|operator/i.test(String(msg || ""));
  }
  /** The message to show for a failed draft action (and log the technical ones). */
  function errorText(r) {
    if (!technical(r.error)) return friendly(r.error);
    rpcLog(r.what, r.error);
    return (FRIENDLY[r.what] || "That didn't work.") + " Try again or contact the admin.";
  }
  function rpcLog(what, msg) { api("rpc/log_client_error", { method: "POST", body: JSON.stringify({ p_where: "draft:" + (what || "?"), p_message: String(msg || "").slice(0, 500) }) }); }

  // ---- Pure helpers (tested in src/workers/draft.test.ts) ------------------------------------------
  /** The room's view of the draft: total, the board slots, who's on the clock, the next two. */
  function view(d, orders, owners, sel) {
    var total = d.teams.length * d.rounds;
    var done = {}; sel.forEach(function (s) { done[s.overall] = s; });
    var cur = d.status === "complete" || d.status === "done" ? null : d.current_overall || DL.currentOverall(sel, total);
    var slot = cur ? DL.slot(cur, d.teams, orders, owners) : null;
    var next = cur ? [cur + 1, cur + 2].map(function (o) { return o <= total ? DL.slot(o, d.teams, orders, owners) : null; }) : [null, null];
    return { total: total, cur: cur, slot: slot, next: next, done: done, made: sel.filter(function (s) { return !s.skipped; }).length };
  }
  /** Players for the pool list: search, position, drafted hidden (or shown greyed), sorted by rank then name. */
  function poolRows(players, rank, takenBy, opt) {
    var q = String(opt.q || "").trim().toLowerCase();
    return players.filter(function (p) {
      if (opt.pos && p.pos !== opt.pos) return false;
      if (!opt.showDrafted && takenBy[p.id]) return false;
      return !q || p.name.toLowerCase().indexOf(q) >= 0 || String(p.nfl || "").toLowerCase() === q;
    }).sort(function (a, b) {
      var ra = rank[a.id] == null ? Infinity : rank[a.id], rb = rank[b.id] == null ? Infinity : rank[b.id];
      return ra - rb || a.name.localeCompare(b.name);
    });
  }
  /** My picks by position, and the roster count vs 18. */
  function myPicks(sel, team, pmap) {
    var by = {}; POS.forEach(function (p) { by[p] = []; });
    var mine = sel.filter(function (s) { return s.team_id === team && s.player_id; });
    mine.forEach(function (s) { var p = pmap[s.player_id] || {}; (by[p.pos] = by[p.pos] || []).push({ s: s, p: p }); });
    return { byPos: by, count: mine.length, max: ROSTER_MAX };
  }
  /** Bye week per NFL team from the season's games (weeks 1..18 without a game). */
  function byeWeeks(games) {
    var weeks = {}, teams = {};
    games.forEach(function (g) { weeks[g.week] = true; [g.home, g.away].forEach(function (t) { (teams[t] = teams[t] || {})[g.week] = true; }); });
    var all = Object.keys(weeks).map(Number), out = {};
    Object.keys(teams).forEach(function (t) { var b = all.filter(function (w) { return !teams[t][w]; }); if (b.length === 1) out[t] = b[0]; });
    return out;
  }
  /** Who picked: "Mike", "auto-pick", "commissioner for X" (names map user -> name). */
  function pickedByText(s, names) { return s.auto ? "auto-pick" : s.picked_by && names[s.picked_by] ? names[s.picked_by] : ""; }

  // ---- Data ---------------------------------------------------------------------------------
  function loadStatic() {
    var season = st.d.season;
    return Promise.all([
      st.players.length ? null : api("nfl_players?position=in.(QB,RB,WR,TE,K,DEF)&select=id,name,position,nfl_team&limit=3000"),
      api("draft_rankings?season=eq." + season + "&select=player_id,rank,source,uploaded_at&limit=3000"),
      api("nfl_games?season=eq." + season + "&select=week,home,away&limit=400"),
      st.d.kind === "real" ? api("draft_picks?season=eq." + season + "&select=round,original_team,owner_team&limit=2000") : null,
      api("profiles?select=id,display_name"),
      rpc("server_now")
    ]).then(function (r) {
      if (r[0]) { st.players = ok(r[0]).map(function (p) { return { id: p.id, name: p.name, pos: p.position, nfl: p.nfl_team }; }); st.pmap = {}; st.players.forEach(function (p) { st.pmap[p.id] = p; }); }
      st.rank = {}; st.rankInfo = null;
      ok(r[1]).forEach(function (x) { st.rank[x.player_id] = Number(x.rank); st.rankInfo = st.rankInfo || { source: x.source, at: x.uploaded_at }; });
      st.byes = byeWeeks(ok(r[2]));
      st.owners = {}; ok(r[3]).forEach(function (x) { if (x.owner_team !== x.original_team) st.owners[x.round + ":" + x.original_team] = x.owner_team; });
      st.names = {}; ok(r[4]).forEach(function (p) { st.names[p.id] = p.display_name; });
      if (r[5] && r[5].ok) st.offset = Date.parse(r[5].data) - Date.now();
    });
  }
  function loadDraft() {
    if (st.loading) { st.again = true; return Promise.resolve(); }
    st.loading = true;
    return Promise.all([
      api("drafts?id=eq." + st.id + "&select=*"),
      api("draft_orders?draft_id=eq." + st.id + "&select=round,teams,method,set_at&order=round"),
      api("draft_selections?draft_id=eq." + st.id + "&select=*&order=overall"),
      myTeam() ? api("draft_queue?draft_id=eq." + st.id + "&team_id=eq." + myTeam() + "&select=player_id,rank&order=rank") : null
    ]).then(function (r) {
      st.loading = false;
      st.d = ok(r[0])[0] || null;
      var prev = st.orderRows;
      st.orders = {}; st.orderRows = {};
      ok(r[1]).forEach(function (o) { st.orders[o.round] = o.teams; st.orderRows[o.round] = o; });
      // A new random draw since we last looked: show the "drawing names" animation
      Object.keys(st.orderRows).forEach(function (k) {
        var o = st.orderRows[k];
        if (o.method === "auto" && st.seenOrders.ready && (!prev[k] || prev[k].set_at !== o.set_at)) st.anim = { round: Number(k), teams: o.teams, until: Date.now() + 3200 };
      });
      st.seenOrders.ready = true;
      st.sel = ok(r[2]);
      if (r[3]) st.queue = ok(r[3]);
      if (st.again) { st.again = false; return loadDraft(); }
    }, function () { st.loading = false; });
  }

  // ---- Rendering ----------------------------------------------------------------------------
  var posTag = function (pos) { return '<span class="pos pos-' + esc(pos) + '">' + esc(pos) + "</span>"; };
  var pname = function (p) { return root.B5Player ? root.B5Player.html({ id: p.id, name: p.name, pos: p.pos, nfl: p.nfl }, { focusable: true }) : esc(p.name); };
  function headerHtml(v) {
    var d = st.d, s = v.slot;
    var statusText = { setup: "Not started", live: "Live", paused: "Paused", awaiting_order: "Waiting for the round's order", done: "All picks made", complete: "Final" }[d.status] || d.status;
    var mine = myTeam();
    var away = mine && v.cur ? DL.picksAway(d.teams, d.rounds, st.orders, st.owners, v.cur, mine) : null;
    var hint = away === 0 ? '<span class="dr-you">You\'re on the clock!</span>' : away === 1 ? '<span class="dr-soon">You\'re next</span>' : away === 2 ? '<span class="dr-soon">You\'re 2 picks away</span>' : away != null ? '<span class="muted">You pick in ' + esc(away) + "</span>" : "";
    var nextHtml = v.next.filter(Boolean).map(function (n, i) { return '<span class="dr-next">' + (i === 0 ? "Next up: " : "Then: ") + T().logo(n.owner) + T().link(n.owner, { logo: false }) + "</span>"; }).join("");
    return '<div class="card dr-head">' +
      '<div class="dr-now">' + (s ? '<span class="dr-rp">Round ' + esc(s.round) + ", Pick " + esc(s.pick) + ' <span class="muted">(#' + esc(v.cur) + " of " + esc(v.total) + ")</span></span>" +
        '<div class="dr-team">' + T().logo(s.owner) + T().link(s.owner, { logo: false, bold: true }) + (s.traded ? ' <span class="tag">from ' + T().link(s.original, { logo: false }) + "</span>" : "") + "</div>"
        : '<span class="dr-rp">' + esc(statusText) + "</span>") + "</div>" +
      '<div class="dr-clock" data-dr="clock" aria-live="off">' + esc(clockText()) + "</div>" +
      '<div class="dr-hints"><span class="tag dr-st dr-st-' + esc(d.status) + '">' + esc(statusText) + "</span>" + hint + nextHtml + "</div></div>";
  }
  function clockText() {
    var d = st.d;
    if (!d) return "";
    if (d.status === "paused") return "⏸ " + DL.clock(d.paused_remaining || 0);
    if (d.status !== "live") return "–:––";
    return DL.clock(DL.secondsLeft(d.clock_ends_at, Date.now(), st.offset));
  }
  function boardHtml(v, big) {
    var d = st.d, cols = st.orders[1] || d.teams, mineT = myTeam();
    var head = "<tr><th>Rd</th>" + cols.map(function (t) { return '<th class="' + (t === mineT ? "dr-mine" : "") + '">' + T().logo(t) + '<span class="dr-th">' + T().link(t, { logo: false }) + "</span></th>"; }).join("") + "</tr>";
    var rows = "";
    for (var r = 1; r <= d.rounds; r++) {
      var order = DL.roundOrder(st.orders, r);
      rows += "<tr><th>" + r + "</th>" + cols.map(function (orig) {
        if (!order) return '<td class="dr-cell empty"></td>';
        var pick = order.indexOf(orig) + 1, overall = (r - 1) * d.teams.length + pick, s = v.done[overall], owner = DL.ownerOf(st.owners, r, orig);
        var p = s && s.player_id ? st.pmap[s.player_id] || { name: s.player_id, pos: "" } : null;
        var cls = "dr-cell" + (p ? " pos-bg-" + esc(p.pos) : "") + (overall === v.cur ? " now" : "") + (s && s.skipped ? " skipped" : "") + (owner === mineT ? " dr-mine" : "");
        return '<td class="' + cls + '" data-dr-cell="' + overall + '"' + (s && pickedByText(s, st.names || {}) ? ' title="by ' + esc(pickedByText(s, st.names || {})) + '"' : "") + '><span class="dr-pk">' + r + "." + ("0" + pick).slice(-2) + "</span>" +
          (owner !== orig ? '<span class="dr-via" title="Traded pick">→ ' + T().link(owner, { logo: false }) + "</span>" : "") +
          (p ? '<b class="dr-pn">' + esc(p.name) + '</b><span class="dr-pp">' + esc(p.pos) + " " + esc(p.nfl || "") + "</span>" : s && s.skipped ? '<span class="muted">skipped</span>' : "") + "</td>";
      }).join("") + "</tr>";
    }
    return '<div class="dr-board-wrap' + (big ? " big" : "") + '"><table class="dr-board"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
  }
  function canPickNow(v) { return st.d.status === "live" && v.slot && (v.slot.owner === myTeam() || isCommish()); }
  function myCatchUps() { return st.sel.filter(function (s) { return s.skipped && (s.team_id === myTeam() || isCommish()); }); }
  function playersHtml(v) {
    var taken = {}; st.sel.forEach(function (s) { if (s.player_id) taken[s.player_id] = s; });
    var rows = poolRows(st.players, st.rank, taken, { q: st.q, pos: st.pos, showDrafted: st.showDrafted });
    var queued = {}; st.queue.forEach(function (q) { queued[q.player_id] = true; });
    var can = canPickNow(v), catchUp = myCatchUps()[0];
    var chips = ["", "QB", "RB", "WR", "TE", "K", "DEF"].map(function (p) { return '<button type="button" class="wk' + (st.pos === p ? " active" : "") + '" data-dr-pos="' + p + '">' + (p || "All") + "</button>"; }).join("");
    return '<div class="card dr-pool"><h3>Players</h3>' +
      '<div class="dr-tools"><input type="search" data-dr="search" placeholder="Search name or NFL team" value="' + esc(st.q) + '" aria-label="Search players">' +
      '<label class="acct-check"><input type="checkbox" data-dr="drafted"' + (st.showDrafted ? " checked" : "") + "> Show drafted</label></div>" +
      '<div class="weeks pl-tabs">' + chips + "</div>" +
      (st.rankInfo ? '<p class="muted small">Rankings: ' + esc(st.rankInfo.source) + ", as of " + esc(new Date(st.rankInfo.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) + "</p>" : '<p class="muted small">No rankings uploaded yet (players by name).</p>') +
      (catchUp && !can ? '<p class="pl-test small">You have a skipped pick to make (Round ' + esc(catchUp.round) + ", Pick " + esc(catchUp.pick) + "): tap Draft on a player.</p>" : "") +
      '<ol class="dr-list">' + rows.slice(0, st.shown).map(function (p) {
        var t = taken[p.id], bye = st.byes[p.nfl];
        return '<li class="' + (t ? "drafted" : "") + '"><span class="dr-rk">' + esc(st.rank[p.id] != null ? st.rank[p.id] : "–") + "</span>" + posTag(p.pos) +
          '<span class="dr-pl">' + pname(p) + '<span class="muted small">' + esc(p.nfl || "FA") + (bye ? " · bye " + bye : "") + "</span></span>" +
          (t ? '<span class="muted small">' + T().link(t.team_id, { logo: false }) + "</span>"
             : '<span class="dr-acts">' + (myTeam() ? '<button type="button" class="btn ghost" data-dr-queue="' + esc(p.id) + '"' + (queued[p.id] ? " disabled" : "") + ">" + (queued[p.id] ? "Queued" : "+ Queue") + "</button>" : "") +
               (can || catchUp ? '<button type="button" class="btn" data-dr-pick="' + esc(p.id) + '">Draft</button>' : "") + "</span>") + "</li>";
      }).join("") + "</ol>" + (rows.length > st.shown ? '<button type="button" class="btn ghost" data-dr="more">Show more (' + esc(rows.length - st.shown) + ")</button>" : "") + "</div>";
  }
  function queueHtml(v) {
    if (!myTeam()) return "";
    var taken = {}; st.sel.forEach(function (s) { if (s.player_id) taken[s.player_id] = true; });
    var list = st.queue.filter(function (q) { return !taken[q.player_id]; });
    var top = list[0] && st.pmap[list[0].player_id];
    var can = canPickNow(v) && v.slot.owner === myTeam();
    return '<div class="card dr-queue"><h3>My queue</h3><p class="muted small">Drag (or ▲▼) to rank. If your time runs out, the draft takes the top available player here.</p>' +
      (can && top ? '<button type="button" class="btn dr-bigpick" data-dr-pick="' + esc(top.id) + '">Draft ' + esc(top.name) + "</button>" : "") +
      (list.length ? '<ol class="dr-qlist">' + list.map(function (q, i) {
        var p = st.pmap[q.player_id] || { id: q.player_id, name: q.player_id, pos: "" };
        return '<li draggable="true" data-dr-q="' + esc(p.id) + '">' + '<span class="dr-grip" aria-hidden="true">☰</span>' + posTag(p.pos) + '<span class="dr-pl">' + pname(p) + "</span>" +
          '<span class="dr-acts"><button type="button" class="btn ghost" data-dr-up="' + i + '" aria-label="Move up">▲</button><button type="button" class="btn ghost" data-dr-down="' + i + '" aria-label="Move down">▼</button>' +
          '<button type="button" class="btn ghost" data-dr-unq="' + esc(p.id) + '" aria-label="Remove">✕</button></span></li>';
      }).join("") + "</ol>" : '<p class="muted">Empty. Add players with "+ Queue".</p>') + "</div>";
  }
  function teamHtml() {
    var t = myTeam(); if (!t) return "";
    var m = myPicks(st.sel, t, st.pmap);
    return '<div class="card dr-myteam"><h3>' + T().link(t, { logo: true }) + ' <span class="muted small">' + esc(m.count) + " / " + esc(m.max) + " players</span></h3>" +
      POS.map(function (p) { var xs = m.byPos[p] || []; return '<div class="dr-mpos">' + posTag(p) + " " + (xs.length ? xs.map(function (x) { return esc(x.p.name) + ' <span class="muted small">' + esc(x.s.round + "." + ("0" + x.s.pick).slice(-2)) + "</span>"; }).join(", ") : '<span class="muted">–</span>') + "</div>"; }).join("") + "</div>";
  }
  function commishHtml(v) {
    if (!isCommish()) return "";
    var d = st.d, b = function (k, label, cls) { return '<button type="button" class="btn ' + (cls || "ghost") + '" data-dr-c="' + k + '">' + label + "</button>"; };
    var needRound = d.status === "awaiting_order" ? DL.position(d.current_overall, d.teams.length).round : null;
    var missing = DL.missingOrders(st.orders, d.rounds);
    var orderRound = needRound || (d.status === "setup" ? missing[0] || 1 : null);
    var picked = {}; st.sel.forEach(function (s) { picked[s.round] = true; });
    var redo = Object.keys(st.orders).map(Number).filter(function (r) { return !picked[r]; });
    return '<div class="card dr-commish"><h3>Commissioner</h3><div class="dr-cacts">' +
      (d.status === "setup" ? b("start", "Start the draft", "") : "") +
      (d.status === "live" ? b("pause", "Pause") + b("extend30", "+30 s") + b("extend60", "+1 min") : "") +
      (d.status === "paused" ? b("resume", "Resume", "") + b("extend60", "+1 min") : "") +
      (st.sel.length && d.status !== "complete" ? b("undo", "Undo last pick") : "") +
      (d.status === "done" ? b("complete", d.kind === "real" ? "Finalize: fill the rosters" : "Finish the practice draft", "") : "") + "</div>" +
      (orderRound ? '<div class="dr-order"><h4>Round ' + esc(orderRound) + " order" + (needRound ? ' <span class="tag dr-st-awaiting_order">the draft is waiting</span>' : "") + "</h4>" +
        '<p class="muted small">Round ' + esc(orderRound + 1) + ' is the reverse. Draw at random (fair, logged with the time), or enter the order from the hat.</p>' +
        '<div class="dr-cacts">' + b("draw:" + orderRound, "🎩 Draw at random", "") + "</div>" + manualOrderHtml(orderRound) + "</div>" : "") +
      (redo.length ? '<p class="small">Redo a draw (only before that round\'s first pick): ' + redo.map(function (r) { return '<button type="button" class="linkish" data-dr-c="draw:' + r + '">Round ' + r + "</button>"; }).join(" · ") + "</p>" : "") +
      '<details><summary>Edit a past pick</summary><form class="acct-form" data-dr-form="edit"><label>Pick number (overall)<input name="overall" type="number" min="1" max="' + esc(v.total) + '" required></label>' +
        '<label>New player<input name="player" list="drPlayers" required placeholder="Start typing a name"></label><button class="btn" type="submit">Change the pick</button></form></details>' +
      '<details><summary>Rankings (CSV)</summary><form class="acct-form" data-dr-form="rank"><p class="muted small">Columns rank, player (optional pos, team), or one player per line in order. Players are matched by name; anything ambiguous is listed, never guessed.</p>' +
        '<label>Source<input name="source" value="Commissioner upload" required></label><label>CSV<textarea name="csv" rows="5"></textarea></label><input type="file" accept=".csv,text/csv" data-dr="csvfile">' +
        '<button class="btn" type="submit">Upload rankings</button></form></details>' +
      '<datalist id="drPlayers">' + st.players.slice(0, 1500).map(function (p) { return '<option value="' + esc(p.name + " (" + p.pos + " " + (p.nfl || "FA") + ")") + '">'; }).join("") + "</datalist></div>";
  }
  function manualOrderHtml(round) {
    var cur = st.orders[round] || st.d.teams;
    return '<form class="dr-manual" data-dr-form="order" data-round="' + round + '"><ol>' + cur.map(function (t, i) {
      return '<li><select name="t' + i + '" aria-label="Pick ' + (i + 1) + '">' + st.d.teams.map(function (x) { return T().option(x, x === t); }).join("") + "</select></li>";
    }).join("") + '</ol><button class="btn ghost" type="submit">Use this order</button></form>';
  }
  function animHtml() {
    var a = st.anim; if (!a || Date.now() > a.until) return "";
    var reveal = Date.now() > a.until - 1200;
    var teams = reveal ? a.teams : a.teams.slice().sort(function () { return Math.random() - 0.5; });
    return '<div class="dr-anim" role="status"><h3>🎩 Drawing names for round ' + esc(a.round) + "…</h3><ol>" + teams.map(function (t) { return "<li>" + T().logo(t) + T().link(t, { logo: false }) + "</li>"; }).join("") + "</ol></div>";
  }
  function roomHtml() {
    var v = view(st.d, st.orders, st.owners, st.sel);
    var tabs = [["players", "Players"], ["queue", "Queue"], ["team", "My team"], ["board", "Board"], ["chat", "Chat"]];
    return '<section class="dr" data-tab="' + esc(st.tab) + '">' + '<p><a href="#draft">← All drafts</a> · <a href="#draft/' + esc(st.id) + '/tv">Big-screen board</a></p>' +
      "<h2>" + esc(st.d.name) + (st.d.kind === "mock" ? ' <span class="tag">Practice</span>' : "") + "</h2>" +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      '<div data-dr="anim">' + animHtml() + "</div>" + headerHtml(v) + commishHtml(v) +
      '<nav class="dr-tabs" aria-label="Draft room">' + tabs.map(function (t) { return '<button type="button" class="' + (st.tab === t[0] ? "active" : "") + '" data-dr-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("") + "</nav>" +
      '<div class="dr-pane dr-p-board">' + boardHtml(v) + "</div>" +
      '<div class="dr-cols"><div class="dr-pane dr-p-players">' + playersHtml(v) + '</div><div class="dr-side"><div class="dr-pane dr-p-queue">' + queueHtml(v) + '</div><div class="dr-pane dr-p-team">' + teamHtml() + "</div></div>" +
      '<div class="dr-pane dr-p-chat"><div class="card"><div data-dr="chat"></div></div></div></div></section>';
  }
  function tvHtml() {
    var v = view(st.d, st.orders, st.owners, st.sel), s = v.slot;
    var last = st.sel.filter(function (x) { return x.player_id; }).slice(-5).reverse();
    return '<section class="dr-tv"><div class="dr-tv-top"><div class="dr-tv-now">' + (s ? '<div class="dr-tv-rp">Round ' + esc(s.round) + " · Pick " + esc(s.pick) + "</div><div class=\"dr-tv-team\">" + T().logo(s.owner) + T().link(s.owner, { logo: false }) + "</div>" : '<div class="dr-tv-rp">' + esc(st.d.name) + "</div>") +
      '<div class="dr-tv-clock" data-dr="clock">' + esc(clockText()) + "</div></div>" +
      '<ol class="dr-tv-last">' + last.map(function (x) { var p = st.pmap[x.player_id] || { name: x.player_id, pos: "" }; return "<li>" + esc(x.round + "." + ("0" + x.pick).slice(-2)) + " " + T().logo(x.team_id) + " <b>" + esc(p.name) + "</b> " + posTag(p.pos) + "</li>"; }).join("") + "</ol></div>" +
      '<div data-dr="anim">' + animHtml() + "</div>" + boardHtml(v, true) + '<div class="dr-tv-chat" data-dr="chat"></div></section>';
  }
  function lobbyHtml(list) {
    var real = list.filter(function (d) { return d.kind === "real"; }), mocks = list.filter(function (d) { return d.kind === "mock"; });
    var row = function (d) {
      var settings = d.status === "setup" && isCommish() ? settingsForm(d) : "";
      return '<li class="card"><a class="dr-open" href="#draft/' + esc(d.id) + '"><b>' + esc(d.name) + "</b></a> " + (d.kind === "mock" ? '<span class="tag">Practice</span> ' : "") +
        '<span class="tag dr-st-' + esc(d.status) + '">' + esc(d.status.replace("_", " ")) + "</span>" +
        '<p class="muted small">' + esc(d.rounds) + " rounds · " + esc(DL.clock(d.timer_seconds)) + " a pick · orders " + (d.order_mode === "live" ? "drawn live at each odd round" : "all set before the draft") +
        " · when time runs out: " + (d.expiry === "autopick" ? "auto-pick" : "skip, pick later") + (d.starts_at ? " · starts " + esc(new Date(d.starts_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + " ET" : "") + "</p>" +
        settings + (isCommish() && (d.kind === "mock" || d.status === "setup") ? '<button type="button" class="btn ghost danger" data-dr-del="' + esc(d.id) + '">Delete</button>' : "") + "</li>";
    };
    var season = Number(L.season) + 1;
    return '<section class="dr-lobby"><h2>Draft Room</h2>' + (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      "<h3>The " + esc(season) + " draft</h3>" + (real.length ? '<ul class="dr-dlist">' + real.map(row).join("") + "</ul>" : '<p class="muted">Not set up yet.</p>' +
        (isCommish() ? '<button type="button" class="btn" data-dr-new="real">Set up the ' + esc(season) + " draft</button>" : "")) +
      "<h3>Practice drafts</h3><p class=\"muted small\">Try the room before the real draft: humans pick for their own teams, bots draft the empty seats. Practice drafts never touch rosters.</p>" +
      (mocks.length ? '<ul class="dr-dlist">' + mocks.map(row).join("") + "</ul>" : '<p class="muted">None yet.</p>') +
      (isCommish() ? '<details class="card"><summary>New practice draft</summary>' + newMockForm() + "</details>" : "") + "</section>";
  }
  function settingsForm(d) {
    var teams = d.teams;
    return '<details><summary>Settings</summary><form class="acct-form" data-dr-form="settings" data-id="' + esc(d.id) + '">' +
      '<label>Rounds<input name="rounds" type="number" min="1" max="40" value="' + esc(d.rounds) + '"></label>' +
      '<label>Time per pick (seconds)<input name="timer_seconds" type="number" min="10" max="3600" value="' + esc(d.timer_seconds) + '"></label>' +
      '<fieldset><legend>When are odd-round orders set?</legend><label class="acct-check"><input type="radio" name="order_mode" value="live"' + (d.order_mode === "live" ? " checked" : "") + "> Live at the start of each odd round (the draft waits for the draw)</label>" +
      '<label class="acct-check"><input type="radio" name="order_mode" value="before"' + (d.order_mode === "before" ? " checked" : "") + "> All before the draft (the board is known)</label></fieldset>" +
      '<fieldset><legend>When a team\'s time runs out</legend><label class="acct-check"><input type="radio" name="expiry" value="autopick"' + (d.expiry === "autopick" ? " checked" : "") + "> Auto-pick (top of their queue, else best available by rank)</label>" +
      '<label class="acct-check"><input type="radio" name="expiry" value="skip"' + (d.expiry === "skip" ? " checked" : "") + "> Skip; the team picks late</label></fieldset>" +
      '<label>Start time (ET; owners get a reminder an hour before)<input name="starts_at" type="datetime-local" value="' + esc(d.starts_at ? toLocalInput(d.starts_at) : "") + '"></label>' +
      (d.kind === "mock" ? '<fieldset><legend>Bots draft these seats</legend>' + teams.map(function (t) { return '<label class="acct-check"><input type="checkbox" name="bot" value="' + esc(t) + '"' + (d.bots.indexOf(t) >= 0 ? " checked" : "") + "> " + T().link(t, { logo: false }) + "</label>"; }).join("") + "</fieldset>" : "") +
      '<button class="btn" type="submit">Save settings</button></form></details>';
  }
  function newMockForm() {
    var ids = T().ids(), mine = myTeam();
    return '<form class="acct-form" data-dr-form="mock"><label>Name<input name="name" value="Practice draft" required maxlength="80"></label>' +
      '<label>Rounds<input name="rounds" type="number" min="1" max="40" value="18"></label><label>Time per pick (seconds)<input name="timer_seconds" type="number" min="10" max="3600" value="60"></label>' +
      '<fieldset><legend>Bots draft these seats (uncheck the teams whose owners will join)</legend>' + ids.map(function (t) { return '<label class="acct-check"><input type="checkbox" name="bot" value="' + esc(t) + '"' + (t === mine ? "" : " checked") + "> " + T().link(t, { logo: false }) + "</label>"; }).join("") + "</fieldset>" +
      '<button class="btn" type="submit">Create the practice draft</button></form>';
  }
  function toLocalInput(iso) {
    var d = new Date(iso), p = function (n) { return ("0" + n).slice(-2); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function render() {
    if (!st.el) return;
    if (!st.me || !isMember()) {
      st.el.innerHTML = '<section><div class="card bd-gate"><p><b>' + (st.me ? "The Draft Room is for league members." : "Sign in to join the draft.") + "</b></p>" + (st.me ? "" : '<a class="btn" href="#account">Sign in</a>') + "</div></section>";
      return;
    }
    if (!st.id) return;
    if (!st.d) { st.el.innerHTML = '<div class="card muted">That draft doesn\'t exist (or was deleted). <a href="#draft">All drafts</a></div>'; return; }
    var y = root.scrollY, focus = root.document.activeElement, fs = focus && focus.dataset && focus.dataset.dr === "search" ? focus.selectionStart : null;
    var chatEl = st.el.querySelector('[data-dr="chat"]'), chatKeep = chatEl && chatEl.firstChild ? chatEl : null;
    st.el.innerHTML = st.tv ? tvHtml() : roomHtml();
    var slotEl = st.el.querySelector('[data-dr="chat"]');
    if (chatKeep && slotEl) slotEl.parentNode.replaceChild(chatKeep, slotEl);   // the chat panel keeps its state
    else if (slotEl && root.B5Chat) root.B5Chat.mount(slotEl, st.tv ? { room: "draft", tv: true } : { room: "draft", panel: true });
    if (fs != null) { var s = st.el.querySelector('[data-dr="search"]'); if (s) { s.focus(); s.setSelectionRange(fs, fs); } }
    if (root.scrollTo) root.scrollTo(0, y);
    st.msg = null;
  }
  function paintClock() {
    if (!st.el || !st.d) return;
    st.el.querySelectorAll('[data-dr="clock"]').forEach(function (c) {
      c.textContent = clockText();
      var left = DL.secondsLeft(st.d.clock_ends_at, Date.now(), st.offset);
      c.classList.toggle("hurry", st.d.status === "live" && left != null && left <= 30);
    });
    var a = st.el.querySelector('[data-dr="anim"]');
    if (a && (st.anim || a.firstChild)) { a.innerHTML = animHtml(); if (st.anim && Date.now() > st.anim.until) st.anim = null; }
    // The clock ran out: ask the server to act (it checks the clock itself)
    var d = st.d;
    if (d.status === "live" && d.clock_ends_at && DL.secondsLeft(d.clock_ends_at, Date.now(), st.offset) <= 0) {
      var key = d.current_overall + ":" + d.clock_ends_at;
      if (!st.ticked[key] || Date.now() - st.ticked[key] > 4000) { st.ticked[key] = Date.now(); rpc("draft_tick", { p_draft: d.id }).then(function () { refresh(); }); }
    }
  }
  var refreshT = null;
  function refresh() {
    clearTimeout(refreshT);
    refreshT = setTimeout(function () { if (st.id) loadDraft().then(render); }, 150);
  }

  // ---- Actions --------------------------------------------------------------------------------
  function act(p, okMsg) {
    return p.then(function (r) {
      st.msg = r && r.ok === false ? { err: errorText(r) } : okMsg ? { ok: okMsg } : null;
      return st.id ? loadDraft().then(render) : startLobby();
    });
  }
  function saveQueue(list) {
    st.queue = list.map(function (q, i) { return { player_id: q.player_id, rank: i + 1 }; });
    render();
    var rows = st.queue.map(function (q) { return { draft_id: st.id, team_id: myTeam(), player_id: q.player_id, rank: q.rank }; });
    return api("draft_queue?draft_id=eq." + st.id + "&team_id=eq." + myTeam(), { method: "DELETE" }).then(function () {
      return rows.length ? api("draft_queue", { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "return=minimal" } }) : null;
    });
  }
  function playerFromLabel(label) {
    var m = /^(.*) \((\w+) (\w+)\)$/.exec(String(label || "").trim());
    var hit = st.players.filter(function (p) { return m ? p.name === m[1] && p.pos === m[2] && (p.nfl || "FA") === m[3] : p.name.toLowerCase() === String(label).trim().toLowerCase(); });
    return hit.length === 1 ? hit[0] : null;
  }
  function bind(el) {
    if (el.dataset.drBound) return;
    el.dataset.drBound = "1";
    el.addEventListener("click", function (e) {
      var t = e.target.closest("button, a"); if (!t) return;
      var ds = t.dataset;
      if (ds.drTab) { st.tab = ds.drTab; render(); return; }
      if (ds.drPos != null) { st.pos = ds.drPos; st.shown = 150; render(); return; }
      if (ds.dr === "more") { st.shown += 150; render(); return; }
      if (ds.drPick) {
        var v = view(st.d, st.orders, st.owners, st.sel), catchUp = canPickNow(v) ? null : myCatchUps()[0];
        var p = st.pmap[ds.drPick] || { name: ds.drPick };
        var forTeam = catchUp ? catchUp.team_id : v.slot && v.slot.owner;
        if (isCommish() && forTeam !== myTeam() && !root.confirm("Draft " + p.name + " for " + T().name(forTeam) + "?")) return;
        t.disabled = true;
        act(rpc("draft_pick", { p_draft: st.id, p_player: ds.drPick, p_overall: catchUp ? catchUp.overall : v.cur }), p.name + " drafted.");
        return;
      }
      if (ds.drQueue) { saveQueue(st.queue.concat([{ player_id: ds.drQueue }])); return; }
      if (ds.drUnq) { saveQueue(st.queue.filter(function (q) { return q.player_id !== ds.drUnq; })); return; }
      if (ds.drUp != null || ds.drDown != null) {
        var i = Number(ds.drUp != null ? ds.drUp : ds.drDown), j = i + (ds.drUp != null ? -1 : 1), list = st.queue.slice();
        if (j < 0 || j >= list.length) return;
        var x = list[i]; list[i] = list[j]; list[j] = x; saveQueue(list); return;
      }
      if (ds.drNew === "real") { act(rpc("draft_create", { p_season: Number(L.season) + 1, p_kind: "real", p_name: (Number(L.season) + 1) + " Draft", p_settings: {} }), "Draft created. Set the details, then start it on draft day."); return; }
      if (ds.drDel) { if (root.confirm("Delete this draft? Its picks are gone for good.")) act(rpc("draft_delete", { p_draft: Number(ds.drDel) }), "Deleted."); return; }
      var c = ds.drC; if (!c) return;
      var did = st.id;
      if (c === "start") act(rpc("draft_control", { p_draft: did, p_action: "start" }));
      else if (c === "pause" || c === "resume") act(rpc("draft_control", { p_draft: did, p_action: c }));
      else if (c === "extend30" || c === "extend60") act(rpc("draft_control", { p_draft: did, p_action: "extend", p_seconds: c === "extend30" ? 30 : 60 }));
      else if (c === "complete") { if (root.confirm(st.d.kind === "real" ? "Finalize the draft? The picks become the rosters." : "Finish the practice draft?")) act(rpc("draft_control", { p_draft: did, p_action: "complete" }), "Done."); }
      else if (c === "undo") {
        var n = Number(root.prompt("Undo how many of the last picks?", "1"));
        if (n >= 1 && root.confirm("Undo the last " + n + " pick" + (n === 1 ? "" : "s") + "? That team goes back on the clock.")) act(rpc("draft_undo", { p_draft: did, p_count: n }), "Undone.");
      } else if (c.indexOf("draw:") === 0) {
        var r = Number(c.slice(5));
        if (st.orders[r] && !root.confirm("Redo round " + r + "'s order? The new draw is logged.")) return;
        act(rpc("draft_set_order", { p_draft: did, p_round: r, p_teams: null }));
      }
    });
    el.addEventListener("input", function (e) {
      if (e.target.dataset.dr === "search") { st.q = e.target.value; st.shown = 150; render(); }
    });
    el.addEventListener("change", function (e) {
      if (e.target.dataset.dr === "drafted") { st.showDrafted = e.target.checked; render(); }
      if (e.target.dataset.dr === "csvfile" && e.target.files && e.target.files[0]) {
        var ta = e.target.form.querySelector("textarea"); e.target.files[0].text().then(function (x) { ta.value = x; });
      }
    });
    el.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-dr-form]"); if (!form) return;
      e.preventDefault();
      var fd = new FormData(form), k = form.dataset.drForm;
      if (k === "order") {
        var teams = []; for (var i = 0; i < st.d.teams.length; i++) teams.push(fd.get("t" + i));
        var bad = DL.validateOrder(teams, st.d.teams);
        if (bad) { st.msg = { err: bad }; render(); return; }
        act(rpc("draft_set_order", { p_draft: st.id, p_round: Number(form.dataset.round), p_teams: teams }), "Round " + form.dataset.round + " order set.");
      } else if (k === "edit") {
        var p = playerFromLabel(fd.get("player"));
        if (!p) { st.msg = { err: "Pick the player from the list." }; render(); return; }
        if (root.confirm("Change pick #" + fd.get("overall") + " to " + p.name + "?")) act(rpc("draft_edit_pick", { p_draft: st.id, p_overall: Number(fd.get("overall")), p_player: p.id }), "Pick changed.");
      } else if (k === "rank") {
        var parsed = DL.parseRankings(fd.get("csv"), st.players);
        if (!parsed.rows.length) { st.msg = { err: "No players matched." }; render(); return; }
        act(rpc("draft_rankings_upload", { p_season: st.d.season, p_rows: parsed.rows, p_source: String(fd.get("source")) }),
          parsed.rows.length + " players ranked." + (parsed.missed.length ? " Not matched (fix and re-upload): " + parsed.missed.slice(0, 12).join(", ") + (parsed.missed.length > 12 ? "…" : "") : ""))
          .then(function () { return loadStatic().then(render); });
      } else if (k === "mock" || k === "settings") {
        var s = { rounds: Number(fd.get("rounds")), timer_seconds: Number(fd.get("timer_seconds")), bots: fd.getAll("bot") };
        if (k === "mock") act(rpc("draft_create", { p_season: Number(L.season), p_kind: "mock", p_name: String(fd.get("name")), p_settings: s }), "Practice draft created.");
        else {
          s.order_mode = fd.get("order_mode"); s.expiry = fd.get("expiry");
          s.starts_at = fd.get("starts_at") ? new Date(String(fd.get("starts_at"))).toISOString() : null;
          act(rpc("draft_settings", { p_draft: Number(form.dataset.id), p_settings: s }), "Settings saved.");
        }
      }
    });
    // Queue: drag to rank (desktop); ▲▼ on phones
    var dragId = null;
    el.addEventListener("dragstart", function (e) { var li = e.target.closest("[data-dr-q]"); if (li) { dragId = li.dataset.drQ; e.dataTransfer.effectAllowed = "move"; } });
    el.addEventListener("dragover", function (e) { if (dragId && e.target.closest("[data-dr-q]")) e.preventDefault(); });
    el.addEventListener("drop", function (e) {
      var li = e.target.closest("[data-dr-q]"); if (!dragId || !li) return;
      e.preventDefault();
      var list = st.queue.slice(), from = list.map(function (q) { return q.player_id; }).indexOf(dragId), to = list.map(function (q) { return q.player_id; }).indexOf(li.dataset.drQ);
      dragId = null;
      if (from < 0 || to < 0 || from === to) return;
      var x = list.splice(from, 1)[0]; list.splice(to, 0, x); saveQueue(list);
    });
  }

  // ---- Lifecycle ------------------------------------------------------------------------------
  function stop() {
    clearInterval(st.timer); st.timer = null;
    if (st.sub) { st.sub.close(); st.sub = null; }
    if (root.document) root.document.body.classList.remove("draft-tv");
    if (st.el && root.B5Chat && st.el.querySelector('[data-dr="chat"]')) root.B5Chat.stop();
    st.el = null;
  }
  function startLobby() {
    return api("drafts?select=*&order=kind.desc,created_at.desc").then(function (r) { if (st.el && !st.id) st.el.innerHTML = lobbyHtml(ok(r)); });
  }
  function start(el, r) {
    stop();
    st.el = el; st.id = r && r.draft ? Number(r.draft) : null; st.tv = !!(r && r.tv); st.d = null; st.ticked = {}; st.seenOrders = {}; st.orderRows = {}; st.anim = null;
    if (root.document) root.document.body.classList.toggle("draft-tv", st.tv);
    if (!(cfg && cfg.configured && A && DL)) { el.innerHTML = '<div class="card">Not set up yet.</div>'; return; }
    el.innerHTML = '<p class="muted">Loading…</p>';
    bind(el);
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (me) {
      st.me = me;
      if (st.el !== el) return;
      if (!isMember()) { render(); return; }
      if (!st.id) return startLobby();
      return loadDraft().then(function () { return st.d ? loadStatic() : null; }).then(function () {
        if (st.el !== el) return;
        render();
        if (!st.d) return;
        st.timer = setInterval(paintClock, 250);
        if (root.B5Realtime) st.sub = root.B5Realtime.subscribe({ cfg: cfg, topic: "realtime:b5-draft-" + st.id,
          changes: [{ table: "drafts", filter: "id=eq." + st.id }, { table: "draft_selections", filter: "draft_id=eq." + st.id }, { table: "draft_orders", filter: "draft_id=eq." + st.id }],
          getToken: function () { return root.B5Account.load().then(function (m) { return m && m.session ? m.session.access_token : null; }); },
          onChange: function () { refresh(); },
          onJoin: function () { refresh(); } });   // (re)joined: catch up on anything missed while disconnected
      });
    });
  }

  root.B5Draft = { start: start, stop: stop, technical: technical, errorText: errorText, view: view, poolRows: poolRows, myPicks: myPicks, byeWeeks: byeWeeks, pickedByText: pickedByText };
})(typeof globalThis !== "undefined" ? globalThis : this);
