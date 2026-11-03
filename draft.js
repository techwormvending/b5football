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

  var st = { el: null, id: null, tv: false, me: null, d: null, orders: {}, orderRows: {}, sel: [], owners: {}, players: [], pmap: {}, rank: {}, rankInfo: null, adp: {}, adpInfo: [], adpSeason: null, sort: { by: "adp", dir: 1 }, sortSet: false, tip: null, focus: null, sheet: "peek", unread: 0, latest: null, chatW: null, popped: null, takeover: null, sound: false, popout: false, btab: "round", bround: null, bteam: null, scrolledCur: null,
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
  /** The ranking the room uses: custom ranks when the draft is on them (and some were uploaded), then ADP. */
  function rankCtx(d, rank, adp) {
    var a = {}; Object.keys(adp || {}).forEach(function (id) { a[id] = adp[id].adp; });
    return { custom: d && d.ranks === "custom" && Object.keys(rank || {}).length ? rank : null, adp: a };
  }
  /** Players for the pool list: search, position, drafted hidden (or shown greyed), sorted (default: the ranking). */
  function poolRows(players, ctx, takenBy, opt) {
    var q = String(opt.q || "").trim().toLowerCase();
    var list = players.filter(function (p) {
      if (opt.pos && p.pos !== opt.pos) return false;
      if (!opt.showDrafted && takenBy[p.id]) return false;
      return !q || p.name.toLowerCase().indexOf(q) >= 0 || String(p.nfl || "").toLowerCase() === q;
    });
    var by = opt.sort ? opt.sort.by : ctx.custom ? "rank" : "adp";
    return DL.sortPool(list, by, opt.sort ? opt.sort.dir : 1, ctx);
  }
  /** "Reach" / "Steal" tag for a made pick (its ADP when it was made). */
  function valueTag(s) {
    var v = s && s.player_id ? DL.value(s.overall, s.adp == null ? null : Number(s.adp)) : null;
    return v ? '<span class="dr-val dr-' + v + '" title="ADP ' + esc(Math.round(Number(s.adp) * 10) / 10) + '">' + (v === "reach" ? "📈 Reach" : "💎 Steal") + "</span>" : "";
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
      rpc("server_now"),
      api("adp_pulls?select=season,source,period,drafts,players,pulled_at"),
      api("teams?select=id,board_name")
    ]).then(function (r) {
      var bn = {}; ok(r[7]).forEach(function (t) { bn[t.id] = t.board_name; }); T().setBoardNames(bn);
      st.adpInfo = ok(r[6]);
      st.adpSeason = DL.adpSeason(st.adpInfo.map(function (x) { return x.season; }), season);
      if (r[0]) { st.players = ok(r[0]).map(function (p) { return { id: p.id, name: p.name, pos: p.position, nfl: p.nfl_team }; }); st.pmap = {}; st.players.forEach(function (p) { st.pmap[p.id] = p; }); }
      st.rank = {}; st.rankInfo = null;
      ok(r[1]).forEach(function (x) { st.rank[x.player_id] = Number(x.rank); st.rankInfo = st.rankInfo || { source: x.source, at: x.uploaded_at }; });
      st.byes = byeWeeks(ok(r[2]));
      st.owners = {}; ok(r[3]).forEach(function (x) { if (x.owner_team !== x.original_team) st.owners[x.round + ":" + x.original_team] = x.owner_team; });
      st.names = {}; ok(r[4]).forEach(function (p) { st.names[p.id] = p.display_name; });
      if (r[5] && r[5].ok) st.offset = Date.parse(r[5].data) - Date.now();
      return st.adpSeason == null ? null : api("player_adp?season=eq." + st.adpSeason + "&select=source,player_id,adp,pos_rank&limit=3000");
    }).then(function (r) { st.adp = r ? DL.adpMap(ok(r)) : {}; });
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
  // ---- Docked chat (2026-11-03) --------------------------------------------------------------
  var CHAT_MIN = 300, CHAT_MAX = 600, CHAT_DEFAULT = 380;
  /** The dock's width, kept between 300 and 600 px. */
  function clampChatWidth(w) { w = Math.round(Number(w)); return isFinite(w) ? Math.max(CHAT_MIN, Math.min(CHAT_MAX, w)) : CHAT_DEFAULT; }
  /** "Focus chat": the board shows the current round and the 2 before it. [from, to]. */
  function focusRounds(cur, rounds) { cur = Math.max(1, Math.min(rounds, cur || 1)); return [Math.max(1, cur - 2), cur]; }
  /** The phone sheet after a swipe on its handle (dy < 0 = up): peek <-> full; a short move or a tap toggles. */
  function sheetAfter(state, dy) {
    if (dy == null || Math.abs(dy) < 30) return state === "full" ? "peek" : "full";
    return dy < 0 ? "full" : "peek";
  }
  /** The last n picks made, newest first. */
  function lastPicks(sel, n) {
    return (sel || []).filter(function (x) { return x.player_id; }).sort(function (a, b) { return b.overall - a.overall; }).slice(0, n || 6);
  }
  var store = function (k, v) { try { if (v === undefined) return root.localStorage.getItem(k); root.localStorage.setItem(k, v); } catch (e) { return null; } return null; };
  /** "Allen" from "Josh Allen", "Harrison" from "Marvin Harrison Jr."; defenses by their team code. */
  function lastName(p) {
    if (!p) return "";
    if (p.pos === "DEF") return p.nfl || p.name;
    var w = String(p.name || "").split(/\s+/).filter(function (x) { return x && !/^(jr|sr|ii|iii|iv|v)\.?$/i.test(x); });
    return w.length > 1 ? w.slice(1).join(" ") : w[0] || "";
  }
  var pk = function (r, pick) { return r + "." + ("0" + pick).slice(-2); };
  /** Every board slot in pick order with its selection and player (rounds without an order are left out). */
  function boardSlots(v) {
    var d = st.d, out = [];
    for (var o = 1; o <= v.total; o++) {
      var sl = DL.slot(o, d.teams, st.orders, st.owners);
      if (!sl) continue;
      var x = v.done[o];
      out.push({ slot: sl, sel: x || null, p: x && x.player_id ? st.pmap[x.player_id] || { id: x.player_id, name: x.player_id, pos: "" } : null });
    }
    return out;
  }
  function tipText(b) {
    var x = b.sel, p = b.p, by = x ? pickedByText(x, st.names || {}) : "";
    return p ? p.name + ", " + p.pos + " " + (p.nfl || "") + (by ? " · " + by : "") + (x.adp != null ? " · ADP " + (Math.round(Number(x.adp) * 10) / 10) : "") : "";
  }
  /** The 12-column board: full browser width, equal columns, sticky header, scrolls down through the rounds. */
  function boardHtml(v, big) {
    var d = st.d, cols = st.orders[1] || d.teams, mineT = myTeam(), byCell = {}, running = /^(live|paused|awaiting_order)$/.test(d.status);
    boardSlots(v).forEach(function (b) { byCell[b.slot.round + ":" + b.slot.original] = b; });
    var head = '<tr><th class="dr-rd" scope="col">Rd</th>' + cols.map(function (t) {
      var open = st.tip === "th:" + t;
      return '<th scope="col" class="' + (t === mineT ? "dr-mine" : "") + '"><button type="button" class="dr-thb" data-dr-tip="th:' + esc(t) + '" title="' + esc(T().name(t)) + '" aria-expanded="' + open + '">' + T().boardLabel(t) + "</button>" +
        (open ? '<div class="dr-tip" role="tooltip">' + T().link(t) + "</div>" : "") + "</th>";
    }).join("") + "</tr>";
    var rows = "", span = !big && st.focus === "chat" ? focusRounds(v.slot ? v.slot.round : DL.position(Math.min(v.total, (v.cur || v.total)), d.teams.length).round, d.rounds) : [1, d.rounds];
    for (var r = span[0]; r <= span[1]; r++) {
      var order = DL.roundOrder(st.orders, r);
      rows += '<tr data-dr-round="' + r + '"><th class="dr-rd" scope="row">' + r + "</th>" + cols.map(function (orig) {
        if (!order) return '<td class="dr-cell empty' + (orig === mineT ? " dr-mine" : "") + '"></td>';
        var b = byCell[r + ":" + orig], sl = b.slot, x = b.sel, p = b.p, open = st.tip === "c:" + sl.overall;
        var cls = "dr-cell" + (p ? " pos-band-" + esc(p.pos) : "") + (running && sl.overall === v.cur ? " now" : "") + (x && x.skipped ? " skipped" : "") + (sl.owner === mineT ? " dr-mine" : "");
        var line1 = '<span class="dr-l1"><span class="dr-pk">' + pk(r, sl.pick) + "</span>" + (x ? valueTag(x).replace(/>(📈|💎) (Reach|Steal)</, ">$1<") : "") +
          (p ? '<span class="dr-pp">' + esc(p.pos) + " " + esc(p.nfl || "") + "</span>" : "") + "</span>";
        var line2 = p ? '<b class="dr-pn">' + esc(lastName(p)) + "</b>" : x && x.skipped ? '<span class="dr-pn muted">skipped</span>' :
          sl.traded ? '<span class="dr-pn dr-via">→ ' + esc(T().boardName(sl.owner)) + "</span>" : running && sl.overall === v.cur ? '<span class="dr-pn dr-onclock">On clock</span>' : '<span class="dr-pn"></span>';
        var tip = open ? '<div class="dr-tip" role="tooltip">' + (p ? "<b>" + esc(p.name) + "</b><br>" + esc(p.pos + " " + (p.nfl || "")) + (x.adp != null ? " · ADP " + esc(Math.round(Number(x.adp) * 10) / 10) : "") + "<br>" : "") +
          T().link(sl.owner) + (sl.traded ? ' <span class="muted small">(from ' + esc(T().boardName(sl.original)) + ")</span>" : "") + (x && pickedByText(x, st.names || {}) ? '<br><span class="muted small">by ' + esc(pickedByText(x, st.names || {})) + "</span>" : "") + "</div>" : "";
        return '<td class="' + cls + '" data-dr-cell="' + sl.overall + '"><button type="button" class="dr-cellb" data-dr-tip="c:' + sl.overall + '" title="' + esc(tipText(b) || "Pick " + pk(r, sl.pick)) + '" aria-expanded="' + open + '">' + line1 + line2 + "</button>" + tip + "</td>";
      }).join("") + "</tr>";
    }
    var colgroup = '<colgroup><col class="dr-rdc">' + cols.map(function () { return "<col>"; }).join("") + "</colgroup>";
    return '<div class="dr-board-wrap full' + (big ? " big" : "") + '" data-dr="board"><table class="dr-board">' + colgroup + "<thead>" + head + "</thead><tbody>" + rows + "</tbody></table></div>" +
      (big ? "" : boardSmallHtml(v));
  }
  /** Under 900 px: By Round / By Team / My Team lists instead of 12 columns. */
  function boardSmallHtml(v) {
    var all = boardSlots(v), mine = myTeam(), cur = v.slot ? v.slot.round : 1, running = /^(live|paused|awaiting_order)$/.test(st.d.status);
    var round = st.bround || cur, team = st.bteam || mine || st.d.teams[0];
    var tab = st.btab === "team" || (st.btab === "mine" && mine) ? st.btab : "round";
    var list = tab === "round" ? all.filter(function (b) { return b.slot.round === round; })
      : all.filter(function (b) { return b.slot.owner === (tab === "mine" ? mine : team); });
    var tabs = [["round", "By Round"], ["team", "By Team"]].concat(mine ? [["mine", "My Team"]] : []);
    var picker = tab === "round"
      ? '<div class="weeks dr-rounds">' + Array.from({ length: st.d.rounds }, function (_, i) { var r = i + 1; return '<button type="button" class="wk' + (r === round ? " active" : "") + (r === cur ? " now" : "") + '" data-dr-bround="' + r + '" aria-pressed="' + (r === round) + '">' + r + "</button>"; }).join("") + "</div>"
      : tab === "team" ? '<label class="dr-bteam">Team <select data-dr="bteam">' + st.d.teams.map(function (t) { return T().option(t, t === team); }).join("") + "</select></label>" : "";
    return '<div class="dr-bsmall"><div class="dr-btabs" role="tablist">' + tabs.map(function (t) { return '<button type="button" role="tab" aria-selected="' + (tab === t[0]) + '" class="' + (tab === t[0] ? "active" : "") + '" data-dr-btab="' + t[0] + '">' + t[1] + "</button>"; }).join("") + "</div>" + picker +
      (list.length ? '<ol class="dr-blist">' + list.map(function (b) {
        var x = b.sel, p = b.p;
        return '<li class="' + (running && b.slot.overall === v.cur ? "now" : "") + (p ? " pos-band-" + esc(p.pos) : "") + '"><span class="dr-pk">' + pk(b.slot.round, b.slot.pick) + "</span>" +
          '<span class="dr-bwho">' + (tab === "round" ? T().link(b.slot.owner) : "Round " + esc(b.slot.round)) + (b.slot.traded ? ' <span class="muted small">via ' + esc(T().boardName(b.slot.original)) + "</span>" : "") + "</span>" +
          '<span class="dr-bpl">' + (p ? "<b>" + esc(p.name) + "</b> " + posTag(p.pos) + ' <span class="muted small">' + esc(p.nfl || "") + "</span> " + valueTag(x) : x && x.skipped ? '<span class="muted">skipped</span>' : running && b.slot.overall === v.cur ? '<span class="dr-onclock">on the clock</span>' : '<span class="muted">–</span>') + "</span></li>";
      }).join("") + "</ol>" : '<p class="muted">' + (tab === "round" ? "Round " + esc(round) + "'s order isn't set yet." : "No picks known yet.") + "</p>") + "</div>";
  }
  function canPickNow(v) { return st.d.status === "live" && v.slot && (v.slot.owner === myTeam() || isCommish()); }
  function myCatchUps() { return st.sel.filter(function (s) { return s.skipped && (s.team_id === myTeam() || isCommish()); }); }
  function playersHtml(v) {
    var taken = {}; st.sel.forEach(function (s) { if (s.player_id) taken[s.player_id] = s; });
    var ctx = rankCtx(st.d, st.rank, st.adp), rows = poolRows(st.players, ctx, taken, { q: st.q, pos: st.pos, showDrafted: st.showDrafted, sort: st.sortSet ? st.sort : null });
    var sortBy = st.sortSet ? st.sort.by : ctx.custom ? "rank" : "adp";
    var sortBtn = function (k, label) { return '<button type="button" class="wk' + (sortBy === k ? " active" : "") + '" data-dr-sort="' + k + '" aria-pressed="' + (sortBy === k) + '">' + label + (sortBy === k && st.sortSet && st.sort.dir === -1 ? " ↓" : "") + "</button>"; };
    var queued = {}; st.queue.forEach(function (q) { queued[q.player_id] = true; });
    var can = canPickNow(v), catchUp = myCatchUps()[0];
    var chips = ["", "QB", "RB", "WR", "TE", "K", "DEF"].map(function (p) { return '<button type="button" class="wk' + (st.pos === p ? " active" : "") + '" data-dr-pos="' + p + '">' + (p || "All") + "</button>"; }).join("");
    return '<div class="card dr-pool"><h3>Players</h3>' +
      '<div class="dr-tools"><input type="search" data-dr="search" placeholder="Search name or NFL team" value="' + esc(st.q) + '" aria-label="Search players">' +
      '<label class="acct-check"><input type="checkbox" data-dr="drafted"' + (st.showDrafted ? " checked" : "") + "> Show drafted</label></div>" +
      '<div class="weeks pl-tabs">' + chips + "</div>" +
      '<div class="weeks pl-tabs dr-sorts"><span class="muted small">Sort:</span>' + (ctx.custom ? sortBtn("rank", "Rank") : "") + sortBtn("adp", "ADP") + sortBtn("name", "Name") + sortBtn("pos", "Position") + sortBtn("team", "Team") + "</div>" +
      '<p class="muted small">' + rankText(ctx) + "</p>" + bestHtml(taken, ctx) +
      (catchUp && !can ? '<p class="pl-test small">You have a skipped pick to make (Round ' + esc(catchUp.round) + ", Pick " + esc(catchUp.pick) + "): tap Draft on a player.</p>" : "") +
      '<ol class="dr-list">' + rows.slice(0, st.shown).map(function (p) {
        var t = taken[p.id], bye = st.byes[p.nfl];
        var a = st.adp[p.id];
        return '<li class="' + (t ? "drafted" : "") + '">' + (ctx.custom ? '<span class="dr-rk" title="Custom rank">' + esc(st.rank[p.id] != null ? st.rank[p.id] : "–") + "</span>" : "") +
          '<span class="dr-adp" title="ADP">' + esc(a ? fmtAdp(a.adp) : "–") + '</span><span class="dr-prk">' + esc(a && a.posRank ? a.posRank : p.pos) + "</span>" +
          '<span class="dr-pl">' + pname(p) + '<span class="muted small">' + esc(p.nfl || "FA") + (bye ? " · bye " + esc(bye) : "") + "</span></span>" +
          (t ? '<span class="muted small">' + T().link(t.team_id, { logo: false }) + "</span>"
             : '<span class="dr-acts">' + (myTeam() ? '<button type="button" class="btn ghost" data-dr-queue="' + esc(p.id) + '"' + (queued[p.id] ? " disabled" : "") + ">" + (queued[p.id] ? "Queued" : "+ Queue") + "</button>" : "") +
               (can || catchUp ? '<button type="button" class="btn" data-dr-pick="' + esc(p.id) + '">Draft</button>' : "") + "</span>") + "</li>";
      }).join("") + "</ol>" + (rows.length > st.shown ? '<button type="button" class="btn ghost" data-dr="more">Show more (' + esc(rows.length - st.shown) + ")</button>" : "") + "</div>";
  }
  var fmtAdp = function (x) { return (Math.round(Number(x) * 10) / 10).toFixed(1); };
  var SRC = { mfl: "MFL, 12-team PPR", ffc: "Fantasy Football Calculator, 12-team half-PPR" };
  /** "ADP as of Nov 2, 2026 (MFL, 12-team PPR, 2026)" (+ custom ranks when on). */
  function rankText(ctx) {
    var day = function (iso) { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
    var pulls = st.adpInfo.filter(function (x) { return x.season === st.adpSeason && x.players > 0; }).sort(function (a) { return a.source === "mfl" ? -1 : 1; });
    var main = pulls[0];
    var adp = main ? "ADP as of " + esc(day(main.pulled_at)) + " (" + esc(SRC[main.source] || main.source) + ", " + esc(st.adpSeason) + " drafts" + (st.adpSeason !== st.d.season ? "; " + esc(st.d.season) + " ADP isn't out yet" : "") + ")" : "No ADP yet (players by name).";
    return (ctx.custom && st.rankInfo ? "Custom ranks: " + esc(st.rankInfo.source) + ", as of " + esc(day(st.rankInfo.at)) + ". " : "") + adp;
  }
  /** Best available: overall and per position. */
  function bestHtml(taken, ctx) {
    var b = DL.bestAvailable(st.players, taken, ctx);
    if (!b.overall) return "";
    var one = function (p) { var a = st.adp[p.id]; return pname(p) + (a ? ' <span class="muted small">' + esc(fmtAdp(a.adp)) + "</span>" : ""); };
    return '<div class="dr-best"><b>Best available:</b> ' + one(b.overall) + '<div class="dr-bestpos">' +
      POS.map(function (pos) { var p = b.byPos[pos]; return p ? "<span>" + posTag(pos) + " " + one(p) + "</span>" : ""; }).join("") + "</div></div>";
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
    return '<div class="card dr-commish"><div class="dr-cacts"><b class="dr-ctitle">Commissioner</b>' +
      (d.status === "setup" ? b("start", "Start the draft", "") : "") +
      (d.status === "live" ? b("pause", "Pause") + b("extend30", "+30 s") + b("extend60", "+1 min") : "") +
      (d.status === "paused" ? b("resume", "Resume", "") + b("extend60", "+1 min") : "") +
      (st.sel.length && d.status !== "complete" ? b("undo", "Undo last pick") : "") +
      (d.status === "done" ? b("complete", d.kind === "real" ? "Finalize: fill the rosters" : "Finish the practice draft", "") : "") + "</div>" +
      (orderRound ? '<div class="dr-order"><h4>Round ' + esc(orderRound) + " order" + (needRound ? ' <span class="tag dr-st-awaiting_order">the draft is waiting</span>' : "") + "</h4>" +
        '<p class="muted small">Round ' + esc(orderRound + 1) + ' is the reverse. Draw at random (fair, logged with the time), or enter the order from the hat.</p>' +
        '<div class="dr-cacts">' + b("draw:" + orderRound, "🎩 Draw at random", "") + "</div>" + manualOrderHtml(orderRound) + "</div>" : "") +
      '<details class="dr-more"' + (st.moreOpen ? ' open' : '') + ' data-dr="more-tools"><summary>More commissioner tools</summary>' +
      (redo.length ? '<p class="small">Redo a draw (only before that round\'s first pick): ' + redo.map(function (r) { return '<button type="button" class="linkish" data-dr-c="draw:' + r + '">Round ' + r + "</button>"; }).join(" · ") + "</p>" : "") +
      '<details><summary>Edit a past pick</summary><form class="acct-form" data-dr-form="edit"><label>Pick number (overall)<input name="overall" type="number" min="1" max="' + esc(v.total) + '" required></label>' +
        '<label>New player<input name="player" list="drPlayers" required placeholder="Start typing a name"></label><button class="btn" type="submit">Change the pick</button></form></details>' +
      '<details><summary>Board names (column headers)</summary><form class="acct-form dr-bnames" data-dr-form="bnames"><p class="muted small">Up to 12 characters, so all 12 columns fit. The full name shows on hover or tap.</p>' +
        d.teams.map(function (t) { return "<label>" + T().logo(t) + " " + esc(T().name(t)) + '<input name="bn' + esc(t) + '" maxlength="12" required value="' + esc(T().boardName(t)) + '"></label>'; }).join("") +
        '<button class="btn" type="submit">Save board names</button></form></details>' +
      '<label class="acct-check"><input type="checkbox" data-dr="ranks"' + (d.ranks === "custom" ? " checked" : "") + (Object.keys(st.rank).length ? "" : " disabled") + "> Custom ranks (the uploaded CSV instead of ADP, for sorting and auto-pick)" + (Object.keys(st.rank).length ? "" : ": upload a CSV first") + "</label>" +
      '<details><summary>Rankings (CSV)</summary><form class="acct-form" data-dr-form="rank"><p class="muted small">Columns rank, player (optional pos, team), or one player per line in order. Players are matched by name; anything ambiguous is listed, never guessed. Uploading turns Custom ranks on.</p>' +
        '<label>Source<input name="source" value="Commissioner upload" required></label><label>CSV<textarea name="csv" rows="5"></textarea></label><input type="file" accept=".csv,text/csv" data-dr="csvfile">' +
        '<button class="btn" type="submit">Upload rankings</button></form></details></details>' +
      '<datalist id="drPlayers">' + st.players.slice(0, 1500).map(function (p) { return '<option value="' + esc(p.name + " (" + p.pos + " " + (p.nfl || "FA") + ")") + '">'; }).join("") + "</datalist></div>";
  }
  function manualOrderHtml(round) {
    var cur = st.orders[round] || st.d.teams;
    return '<form class="dr-manual" data-dr-form="order" data-round="' + round + '"><ol class="dr-ogrid" style="--rows:' + Math.ceil(cur.length / 3) + ";--rows2:" + Math.ceil(cur.length / 2) + '">' + cur.map(function (t, i) {
      return '<li><label class="dr-onum" for="dro' + round + "-" + i + '">' + (i + 1) + '.</label><select id="dro' + round + "-" + i + '" name="t' + i + '" aria-label="Pick ' + (i + 1) + '">' + st.d.teams.map(function (x) { return T().option(x, x === t); }).join("") + "</select></li>";
    }).join("") + '</ol><p class="acct-msg err" data-dr="dupmsg" hidden></p><button class="btn ghost" type="submit">Use this order</button></form>';
  }
  /** Red for teams picked twice; "Use this order" only once all are different. */
  function checkOrderForm(form) {
    var sels = [].slice.call(form.querySelectorAll("select")), dup = DL.duplicates(sels.map(function (x) { return x.value; }));
    sels.forEach(function (x) { x.classList.toggle("dup", !!dup[x.value]); x.setAttribute("aria-invalid", dup[x.value] ? "true" : "false"); });
    var n = Object.keys(dup).length, msg = form.querySelector('[data-dr="dupmsg"]');
    form.querySelector('button[type="submit"]').disabled = n > 0;
    if (msg) { msg.hidden = !n; msg.textContent = n ? Object.keys(dup).map(function (t) { return T().name(t); }).join(", ") + (n === 1 ? " is" : " are") + " in the order twice." : ""; }
  }
  function animHtml() {
    var a = st.anim; if (!a || Date.now() > a.until) return "";
    var reveal = Date.now() > a.until - 1200;
    var teams = reveal ? a.teams : a.teams.slice().sort(function () { return Math.random() - 0.5; });
    return '<div class="dr-anim" role="status"><h3>🎩 Drawing names for round ' + esc(a.round) + "…</h3><ol>" + teams.map(function (t) { return "<li>" + T().logo(t) + T().link(t, { logo: false }) + "</li>"; }).join("") + "</ol></div>";
  }
  /** The strip of the last 6 picks under the on-the-clock bar. */
  function lastPicksHtml() {
    var list = lastPicks(st.sel, 6);
    if (!list.length) return "";
    return '<ol class="dr-last" aria-label="Last picks">' + list.map(function (x) {
      var p = st.pmap[x.player_id] || { name: x.player_id, pos: "" };
      return '<li class="pos-band-' + esc(p.pos) + '"><span class="dr-pk">' + esc(pk(x.round, x.pick)) + "</span>" + T().logo(x.team_id) + "<b>" + esc(lastName(p)) + "</b>" + posTag(p.pos) + valueTag(x) + "</li>";
    }).join("") + "</ol>";
  }
  function dockToolsHtml() {
    var b = function (k, label, on) { return '<button type="button" class="dr-dt' + (on ? " on" : "") + '" data-dr-dock="' + k + '" aria-pressed="' + !!on + '">' + label + "</button>"; };
    return '<div class="dr-docktools">' + b("focus-chat", "Focus chat", st.focus === "chat") + b("focus-board", "Focus board", st.focus === "board") +
      b("popout", "Pop out ↗") + b("sound", st.sound ? "🔔" : "🔕", st.sound).replace("<button ", '<button title="' + (st.sound ? "Sound on for picks and mentions" : "Sound off") + '" aria-label="' + (st.sound ? "Sound on" : "Sound off") + '" ') + "</div>";
  }
  function handleHtml() {
    var l = st.latest;
    return '<button type="button" class="dr-handle" data-dr="sheet" aria-expanded="' + (st.sheet === "full") + '" aria-label="' + (st.sheet === "full" ? "Back to the board" : "Open the chat") + '">' +
      '<span class="dr-grip" aria-hidden="true"></span><span class="dr-hl"><b>💬 Chat</b>' + (st.unread ? ' <span class="nav-badge" data-dr="unread">' + (st.unread > 99 ? "99+" : st.unread) + "</span>" : "") +
      (st.sheet === "full" ? ' <span class="muted">▾ Back to the board</span>' : "") + "</span>" +
      '<span class="dr-latest" data-dr="latest">' + (l ? esc(l) : '<span class="muted">Swipe up to chat</span>') + "</span></button>";
  }
  function roomHtml() {
    var v = view(st.d, st.orders, st.owners, st.sel);
    var tabs = [["players", "Players"], ["queue", "Queue"], ["team", "My team"], ["board", "Board"]];
    var dtab = st.tab === "board" ? "players" : st.tab;
    var dtabs = [["players", "Player Pool"], ["queue", "My Queue"], ["team", "My Team"]];
    var w = st.focus === "chat" ? null : st.focus === "board" ? CHAT_MIN : clampChatWidth(st.chatW);
    var dock = st.popped
      ? '<div class="card dr-popped"><p><b>The chat is open in its own window.</b></p><button type="button" class="btn" data-dr-dock="bring-back">Bring it back here</button></div>'
      : '<div class="dr-chatmount" data-dr="chat"></div>';
    return '<section class="dr dr-room" data-tab="' + esc(st.tab) + '" data-dtab="' + esc(dtab) + '" data-focus="' + esc(st.focus || "") + '" data-sheet="' + esc(st.sheet) + '"' + (st.popped ? ' data-popped="1"' : "") +
      (w ? ' style="--chat-w:' + w + 'px"' : "") + ">" +
      '<p class="dr-links"><a href="#draft">← All drafts</a> · <a href="#draft/' + esc(st.id) + '/tv">Big-screen board</a> · <span class="muted">' + esc(st.d.name) + (st.d.kind === "mock" ? " (practice)" : "") + "</span></p>" +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      '<div data-dr="anim">' + animHtml() + "</div>" +
      '<div class="dr-topbar">' + headerHtml(v) + lastPicksHtml() + "</div>" +
      '<div class="dr-layout"><div class="dr-mainz">' + commishHtml(v) +
        '<nav class="dr-tabs" aria-label="Draft room">' + tabs.map(function (t) { return '<button type="button" class="' + (st.tab === t[0] ? "active" : "") + '" data-dr-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("") + "</nav>" +
        '<div class="dr-pane dr-p-board">' + boardHtml(v) + (st.focus === "chat" ? '<p class="muted small">Showing the current round and the 2 before it. <button type="button" class="linkish" data-dr-dock="focus-chat">Show the whole board</button></p>' : "") + "</div>" +
        '<nav class="dr-dtabs" aria-label="Players and teams">' + dtabs.map(function (t) { return '<button type="button" class="' + (dtab === t[0] ? "active" : "") + '" data-dr-tab="' + t[0] + '" aria-pressed="' + (dtab === t[0]) + '">' + t[1] + "</button>"; }).join("") + "</nav>" +
        '<div class="dr-pane dr-p-players">' + playersHtml(v) + '</div><div class="dr-pane dr-p-queue">' + queueHtml(v) + '</div><div class="dr-pane dr-p-team">' + teamHtml() + "</div>" +
      "</div>" +
      '<div class="dr-resize" role="separator" aria-orientation="vertical" aria-label="Resize the chat" tabindex="0" aria-valuemin="' + CHAT_MIN + '" aria-valuemax="' + CHAT_MAX + '" aria-valuenow="' + (w || "") + '"></div>' +
      '<aside class="dr-dock" aria-label="Draft chat">' + handleHtml() + dockToolsHtml() + dock + "</aside></div></section>";
  }
  /** Pop-out chat window (#draft/<id>/chat): just the Draft chat, full window, for a second monitor. */
  function popoutHtml() {
    return '<section class="dr-pop"><p class="dr-links"><b>' + esc(st.d.name) + '</b> · Draft chat <span class="muted">(close this window to bring the chat back to the room)</span></p><div class="dr-chatmount" data-dr="chat"></div></section>';
  }
  function tvHtml() {
    var v = view(st.d, st.orders, st.owners, st.sel), s = v.slot;
    var last = st.sel.filter(function (x) { return x.player_id; }).slice(-5).reverse();
    return '<section class="dr-tv"><div class="dr-tv-top"><div class="dr-tv-now">' + (s ? '<div class="dr-tv-rp">Round ' + esc(s.round) + " · Pick " + esc(s.pick) + "</div><div class=\"dr-tv-team\">" + T().logo(s.owner) + T().link(s.owner, { logo: false }) + "</div>" : '<div class="dr-tv-rp">' + esc(st.d.name) + "</div>") +
      '<div class="dr-tv-clock" data-dr="clock">' + esc(clockText()) + "</div></div>" +
      '<ol class="dr-tv-last">' + last.map(function (x) { var p = st.pmap[x.player_id] || { name: x.player_id, pos: "" }; return "<li>" + esc(x.round + "." + ("0" + x.pick).slice(-2)) + " " + T().logo(x.team_id) + " <b>" + esc(p.name) + "</b> " + posTag(p.pos) + " " + valueTag(x) + "</li>"; }).join("") + "</ol>" +
      "</div>" + '<div data-dr="anim">' + animHtml() + "</div>" +
      '<div class="dr-tv-body">' + boardHtml(v, true) + '<aside class="dr-tv-chat" data-dr="chat" aria-label="Draft chat"></aside></div></section>';
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
      "<h3>Practice drafts</h3><p class=\"muted small\">Try the room before the real draft: humans pick for their own teams, bots draft the empty seats. Practice drafts never touch rosters.</p>" + videoHtml() +
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
      '<fieldset><legend>When a team\'s time runs out</legend><label class="acct-check"><input type="radio" name="expiry" value="autopick"' + (d.expiry === "autopick" ? " checked" : "") + "> Auto-pick (top of their queue, else best available by ADP; no 2nd K or DEF before round 14)</label>" +
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
    // a half-entered round order survives a refresh (Realtime, the clock)
    var kept = {}; if (!st.dropKept) st.el.querySelectorAll('form[data-dr-form="order"] select').forEach(function (x) { var d = x.querySelector('option[selected]'); if (d && x.value !== d.value) kept[x.id] = x.value; });
    st.dropKept = false;
    var v0 = view(st.d, st.orders, st.owners, st.sel);
    // My pick: the pick screen takes over on phones (the chat stays one swipe away), once per pick
    if (!st.tv && !st.popout && canPickNow(v0) && v0.slot && v0.slot.owner === myTeam() && st.takeover !== v0.cur) { st.takeover = v0.cur; st.sheet = "peek"; st.tab = "players"; }
    st.el.innerHTML = st.tv ? tvHtml() : st.popout ? popoutHtml() : roomHtml();
    if (root.document) root.document.body.classList.toggle("dr-sheet-full", !st.tv && !st.popout && st.sheet === "full");
    Object.keys(kept).forEach(function (id) { var x = root.document.getElementById(id); if (x) x.value = kept[id]; });
    var slotEl = st.el.querySelector('[data-dr="chat"]');
    if (chatKeep && slotEl) slotEl.parentNode.replaceChild(chatKeep, slotEl);   // the chat panel keeps its state
    else if (slotEl && root.B5Chat) root.B5Chat.mount(slotEl, chatOpts());
    if (fs != null) { var s = st.el.querySelector('[data-dr="search"]'); if (s) { s.focus(); s.setSelectionRange(fs, fs); } }
    if (root.scrollTo) root.scrollTo(0, y);
    st.el.querySelectorAll('form[data-dr-form="order"]').forEach(checkOrderForm);
    setViewportWidth();
    var sec = st.el.querySelector(".dr-room, .dr-pop"); if (sec) sec.style.setProperty("--dr-top", Math.round(sec.getBoundingClientRect().top + (root.scrollY || 0) + 10) + "px");
    keepRoundInView();
    st.msg = null;
  }
  function chatOpts() {
    var o = { room: "draft", dock: true, teams: st.d.teams, myTeam: myTeam(), sound: function () { return st.sound; }, onMessage: onChatMessage };
    if (st.tv) { o.tv = true; delete o.onMessage; }
    return o;
  }
  // A new Draft chat message: the phone sheet's preview and unread count (updated in place, no re-render)
  function onChatMessage(rec, alert) {
    var who = rec.is_bot ? "B5 Bot" : "";
    st.latest = (who ? who + ": " : "") + String(rec.body || (rec.images && rec.images.length ? "📷 photo" : "")).slice(0, 140);
    var narrow = root.matchMedia && root.matchMedia("(max-width: 1099px)").matches;
    if (narrow && st.sheet !== "full") st.unread++;
    var h = st.el && st.el.querySelector(".dr-handle");
    if (h) h.outerHTML = handleHtml();
    var dk = st.el && st.el.querySelector(".dr-dock");
    if (dk && (alert === "my-turn" || alert === "mention" || alert === "mine")) { dk.classList.remove("flash"); void dk.offsetWidth; dk.classList.add("flash"); }
  }
  function setSheet(state) {
    st.sheet = state;
    if (state === "full") { st.unread = 0; setTimeout(function () { if (st.vvFit) st.vvFit(); }, 0); if (root.B5Chat && root.B5Chat.jumpToLatest) setTimeout(root.B5Chat.jumpToLatest, 50); }
    render();
  }
  function popOut() {
    if (st.popped) return;
    var w = root.open("#draft/" + st.id + "/chat", "b5-draft-chat-" + st.id, "width=440,height=860");
    if (!w) { st.msg = { err: "Your browser blocked the new window. Allow pop-ups for this site and try again." }; render(); return; }
    st.popped = w;
    if (root.B5Chat) root.B5Chat.stop();
    render();
    st.popTimer = setInterval(function () { if (!st.popped || st.popped.closed) { clearInterval(st.popTimer); st.popped = null; if (st.el) render(); } }, 1500);
  }
  // Drag the separator (or use the arrow keys on it) to size the chat between 300 and 600 px
  function bindResize(el) {
    var drag = null;
    el.addEventListener("pointerdown", function (e) {
      var h = e.target.closest(".dr-resize"); if (!h) return;
      var lay = h.closest(".dr-layout"); drag = { right: lay.getBoundingClientRect().right, sec: h.closest(".dr") };
      h.setPointerCapture && h.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (!drag) return;
      st.focus = null; st.chatW = clampChatWidth(drag.right - e.clientX);
      drag.sec.style.setProperty("--chat-w", st.chatW + "px"); drag.sec.dataset.focus = "";
    });
    var end = function () { if (!drag) return; drag = null; store("b5-draft-chat-w", String(st.chatW)); render(); };
    el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
    el.addEventListener("keydown", function (e) {
      if (!e.target.classList || !e.target.classList.contains("dr-resize") || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault(); st.focus = null; st.chatW = clampChatWidth((st.chatW || CHAT_DEFAULT) + (e.key === "ArrowLeft" ? 20 : -20));
      store("b5-draft-chat-w", String(st.chatW)); render(); var h = st.el.querySelector(".dr-resize"); if (h) h.focus();
    });
    // Full-screen chat sheet on a phone: stay inside the visible area, so the composer sits above the keyboard
    if (root.visualViewport && !st.vvBound) {
      st.vvBound = true;
      var vvFit = function () {
        var dk = st.el && st.el.querySelector(".dr-room[data-sheet=full] .dr-dock"), vv = root.visualViewport;
        root.document.querySelectorAll(".dr-dock").forEach(function (x) { if (x !== dk) { x.style.top = ""; x.style.height = ""; x.style.bottom = ""; } });
        if (!dk || !(root.matchMedia && root.matchMedia("(max-width: 1099px)").matches)) return;
        dk.style.top = vv.offsetTop + "px"; dk.style.height = vv.height + "px"; dk.style.bottom = "auto";
      };
      root.visualViewport.addEventListener("resize", vvFit); root.visualViewport.addEventListener("scroll", vvFit); st.vvFit = vvFit;
    }
    // the phone sheet: swipe up/down on the handle (a tap toggles)
    var sw = null;
    el.addEventListener("touchstart", function (e) { if (e.target.closest(".dr-handle")) sw = { y: e.touches[0].clientY }; }, { passive: true });
    el.addEventListener("touchend", function (e) {
      if (!sw) return; var dy = e.changedTouches[0].clientY - sw.y; sw = null;
      if (Math.abs(dy) >= 30) { st.swiped = Date.now(); setSheet(sheetAfter(st.sheet, dy)); }
    });
  }
  // The board breaks out of the page's max width: --dr-vw = the real viewport width (no scrollbar).
  function setViewportWidth() {
    var de = root.document && root.document.documentElement;
    if (de && de.clientWidth) de.style.setProperty("--dr-vw", de.clientWidth + "px");
  }
  // When the rounds don't all fit, scroll the board (not the page) so the current pick's round is in view.
  function keepRoundInView() {
    var wrap = st.el && st.el.querySelector('[data-dr="board"]'), v = st.d && st.d.current_overall;
    if (!wrap || !v || st.scrolledCur === v || wrap.scrollHeight <= wrap.clientHeight + 2) return;
    var cell = wrap.querySelector('[data-dr-cell="' + v + '"]');
    if (!cell) return;
    st.scrolledCur = v;
    // one round above the current one stays visible, under the sticky header
    var head = wrap.querySelector("thead"), top = cell.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - (head ? head.offsetHeight : 0) - cell.offsetHeight;
    wrap.scrollTop = Math.max(0, top);
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
      var t = e.target.closest("button, a");
      if (st.tip && (!t || !t.dataset.drTip) && !e.target.closest(".dr-tip")) { st.tip = null; render(); if (!t) return; }
      if (!t) return;
      var ds = t.dataset;
      if (ds.drTip) { st.tip = st.tip === ds.drTip ? null : ds.drTip; render(); return; }
      if (ds.drBtab) { st.btab = ds.drBtab; render(); return; }
      if (ds.drBround) { st.bround = Number(ds.drBround); render(); return; }
      if (ds.drTab) { st.tab = ds.drTab; render(); return; }
      if (ds.dr === "sheet") { if (!st.swiped || Date.now() - st.swiped > 500) setSheet(sheetAfter(st.sheet, null)); return; }
      if (ds.drDock) {
        var k2 = ds.drDock;
        if (k2 === "focus-chat" || k2 === "focus-board") { var f2 = k2.slice(6); st.focus = st.focus === f2 ? null : f2; render(); }
        else if (k2 === "popout") popOut();
        else if (k2 === "bring-back") { if (st.popped && !st.popped.closed) st.popped.close(); st.popped = null; clearInterval(st.popTimer); render(); }
        else if (k2 === "sound") { st.sound = !st.sound; store("b5-draft-sound", st.sound ? "on" : "off"); render(); }
        return;
      }
      if (ds.drPos != null) { st.pos = ds.drPos; st.shown = 150; render(); return; }
      if (ds.dr === "more") { st.shown += 150; render(); return; }
      if (ds.drSort) {
        var cur = st.sortSet ? st.sort.by : null;
        st.sort = { by: ds.drSort, dir: cur === ds.drSort ? -st.sort.dir : 1 }; st.sortSet = true; st.shown = 150; render(); return;
      }
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
        st.dropKept = true;
        act(rpc("draft_set_order", { p_draft: did, p_round: r, p_teams: null }));
      }
    });
    el.addEventListener("toggle", function (e) {
      if (e.target.dataset && e.target.dataset.dr === "more-tools") st.moreOpen = e.target.open;
      if (e.target.dataset && e.target.dataset.dr === "guide") { try { root.localStorage.setItem(guideKey(), e.target.open ? "open" : "closed"); } catch (x) { /* private mode: just this visit */ } }
    }, true);
    el.addEventListener("input", function (e) {
      if (e.target.dataset.dr === "search") { st.q = e.target.value; st.shown = 150; render(); }
    });
    el.addEventListener("change", function (e) {
      if (e.target.dataset.dr === "drafted") { st.showDrafted = e.target.checked; render(); }
      if (e.target.dataset.dr === "bteam") { st.bteam = e.target.value; render(); }
      if (e.target.form && e.target.form.dataset.drForm === "order") checkOrderForm(e.target.form);
      if (e.target.dataset.dr === "ranks") { st.sortSet = false; act(rpc("draft_settings", { p_draft: st.id, p_settings: { ranks: e.target.checked ? "custom" : "adp" } }), e.target.checked ? "Custom ranks on." : "Back to ADP."); }
      if (e.target.dataset.dr === "csvfile" && e.target.files && e.target.files[0]) {
        var ta = e.target.form.querySelector("textarea"); e.target.files[0].text().then(function (x) { ta.value = x; });
      }
    });
    el.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-dr-form]"); if (!form) return;
      e.preventDefault();
      var fd = new FormData(form), k = form.dataset.drForm;
      if (k === "video") {
        var u = String(fd.get("url") || "").trim();
        if (u && !SCRIBE.test(u)) { st.msg = { err: "Use a Scribe embed link (https://scribehow.com/embed/...)." }; return startLobby(); }
        api("rpc/set_practice_video", { method: "POST", body: JSON.stringify({ p_url: u || null }) }).then(function (r) {
          st.msg = r && r.ok === false ? { err: friendly(r.error) } : { ok: u ? "Video guide saved." : "Video guide hidden." };
          return startLobby();
        });
        return;
      }
      if (k === "bnames") {
        var names = st.d.teams.map(function (t) { return { id: t, b: String(fd.get("bn" + t) || "").trim() }; });
        var bad = names.filter(function (x) { return !x.b || x.b.length > 12; })[0];
        if (bad) { st.msg = { err: "Each board name needs 1 to 12 characters." }; render(); return; }
        var changed = names.filter(function (x) { return x.b !== T().boardName(x.id); });
        act(Promise.all(changed.map(function (x) { return api("teams?id=eq." + encodeURIComponent(x.id), { method: "PATCH", body: JSON.stringify({ board_name: x.b }), headers: { Prefer: "return=minimal" } }); }))
          .then(function (rs) { var f = rs.filter(function (r) { return !r.ok; })[0]; return f || { ok: true }; }), changed.length ? "Board names saved." : "Nothing changed.")
          .then(function () { return loadStatic().then(render); });
      } else if (k === "order") {
        var teams = []; for (var i = 0; i < st.d.teams.length; i++) teams.push(fd.get("t" + i));
        var bad = DL.validateOrder(teams, st.d.teams);
        if (bad) { st.msg = { err: bad }; render(); return; }
        st.dropKept = true;
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
    if (root.document) ["draft-tv", "draft-room", "draft-popout", "dr-sheet-full"].forEach(function (c) { root.document.body.classList.remove(c); });
    clearInterval(st.popTimer);
    if (st.el && root.B5Chat && st.el.querySelector('[data-dr="chat"]')) root.B5Chat.stop();
    st.el = null;
  }
  function startLobby() {
    return Promise.all([api("drafts?select=*&order=kind.desc,created_at.desc"), canGuide() ? api("league_settings?select=practice_video_url") : null]).then(function (r) {
      if (r[1]) st.videoUrl = (ok(r[1])[0] || {}).practice_video_url || null;
      if (st.el && !st.id) st.el.innerHTML = lobbyHtml(ok(r[0]));
    });
  }
  // ---- Video guide: "How to create a practice draft" (commissioners and administrators) --------
  // The URL is a league setting (league_settings.practice_video_url; only Scribe embed links), so it can
  // be swapped without a code change. Open the first time; open/closed remembered per user (this browser).
  var isAdmin = function () { return !!(st.me && st.me.profile && st.me.profile.is_admin); };
  var canGuide = function () { return isCommish() || isAdmin(); };
  var SCRIBE = /^https:\/\/scribehow\.com\/embed\/[A-Za-z0-9_.%-]+(\?[A-Za-z0-9_.%=&-]*)?$/;
  function guideKey() { return "b5-draft-guide:" + (st.me && st.me.session && st.me.session.user ? st.me.session.user.id : "?"); }
  function guideOpen() { try { return root.localStorage.getItem(guideKey()) !== "closed"; } catch (e) { return true; } }
  function videoHtml() {
    if (!canGuide()) return "";
    var url = st.videoUrl && SCRIBE.test(st.videoUrl) ? st.videoUrl : null;
    var change = '<details class="dr-vchange"><summary>Change the video</summary><form class="acct-form" data-dr-form="video"><label>Scribe embed link<input name="url" type="url" value="' + esc(url || "") + '" placeholder="https://scribehow.com/embed/..."></label>' +
      '<p class="muted small">Only https://scribehow.com/embed/ links. Leave it empty to hide the guide.</p><button class="btn" type="submit">Save</button></form></details>';
    if (!url) return '<div class="card dr-video"><p class="muted">No video guide set.</p>' + change + "</div>";
    return '<details class="card dr-video" data-dr="guide"' + (guideOpen() ? " open" : "") + '><summary>▶ How to create a practice draft (video)</summary>' +
      '<div class="dr-vframe"><iframe src="' + esc(url) + '" title="How to create a new practice draft on B5 Football" loading="lazy" allow="fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>' + change + "</details>";
  }
  function start(el, r) {
    stop();
    st.el = el; st.id = r && r.draft ? Number(r.draft) : null; st.tv = !!(r && r.tv); st.popout = !!(r && r.popout); st.d = null;
    st.chatW = clampChatWidth(store("b5-draft-chat-w") || CHAT_DEFAULT); st.sound = store("b5-draft-sound") === "on"; st.focus = null; st.sheet = "peek"; st.unread = 0;
    if (root.document) { root.document.body.classList.toggle("draft-room", !!st.id && !st.tv); root.document.body.classList.toggle("draft-popout", st.popout); } st.ticked = {}; st.seenOrders = {}; st.orderRows = {}; st.anim = null;
    if (root.document) root.document.body.classList.toggle("draft-tv", st.tv);
    if (!(cfg && cfg.configured && A && DL)) { el.innerHTML = '<div class="card">Not set up yet.</div>'; return; }
    el.innerHTML = '<p class="muted">Loading…</p>';
    bind(el);
    if (!el.dataset.drResize) { el.dataset.drResize = "1"; bindResize(el); }
    if (root.addEventListener && !st.rz) { st.rz = true; root.addEventListener("resize", setViewportWidth); }
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

  root.B5Draft = { start: start, stop: stop, clampChatWidth: clampChatWidth, focusRounds: focusRounds, sheetAfter: sheetAfter, lastPicks: lastPicks, technical: technical, errorText: errorText, videoHtml: videoHtml, SCRIBE: SCRIBE, view: view, poolRows: poolRows, rankCtx: rankCtx, valueTag: valueTag, lastName: lastName, myPicks: myPicks, byeWeeks: byeWeeks, pickedByText: pickedByText };
})(typeof globalThis !== "undefined" ? globalThis : this);
