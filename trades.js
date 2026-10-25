/* Trades (window.B5Trades): #trade/<teamId> builds a proposal to that team; #trades lists trades
   (waiting for you, your proposals, awaiting the commissioner, completed). Members only.
   Every rule is in the database (migration profiles_dm_trades; settings season_settings.trades):
   players whose game has started can't move until the week ends, no trades from the deadline
   (week 12's first kickoff), rosters over the max need drops (the proposer picks his at proposal, the
   other team at acceptance), proposals expire after 7 days, accepted trades wait for the
   commissioner (approve / reject with a note; a trade with his own team is flagged and audited).
   Each step posts a B5 Bot notice in the trade's conversation (#dm). 2026: test trades, labelled. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var TL = function () { return root.B5Team; };
  var season = Number(L.season);
  var when = function (iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; };
  var st = { el: null, me: null, mode: "list", other: null, settings: { live: false, rosterMax: 18 }, assets: {}, trades: [], names: {}, people: {},
    pick: { give: [], get: [], givePicks: [], getPicks: [], drops: [], accDrops: {} }, msg: null, busy: false };

  // ---- Pure helpers (tested in src/workers/trades-page.test.ts) ---------------------------------
  /** Roster sizes after a trade and the drops each side still needs. */
  function tradeMath(o) {
    var mine = o.mySize - o.give + o.get - (o.drops || 0), theirs = o.theirSize - o.get + o.give - (o.theirDrops || 0);
    return { mine: mine, theirs: theirs, needMine: Math.max(0, mine - o.max), needTheirs: Math.max(0, theirs - o.max) };
  }
  /** "NSFW get A, B; Stealers get C" (HTML, TeamLinks). */
  function summaryHtml(t, names, pickLabels) {
    var items = function (players, picks) {
      var xs = (players || []).map(function (p) { return esc(names[p] || p); }).concat((picks || []).map(function (p) { return esc(pickLabels[p] || "draft pick"); }));
      return xs.length ? xs.join(", ") : "nothing";
    };
    return TL().link(t.from_team, { logo: false }) + " get " + items(t.get_players, t.get_picks) + "; " + TL().link(t.to_team, { logo: false }) + " get " + items(t.give_players, t.give_picks) +
      ((t.from_drops || []).length ? ". " + TL().link(t.from_team, { logo: false }) + " drop " + items(t.from_drops) : "") +
      ((t.to_drops || []).length ? ". " + TL().link(t.to_team, { logo: false }) + " drop " + items(t.to_drops) : "");
  }
  /** Status shown on a trade (a proposal past its expiry reads "expired" before the hourly job marks it). */
  function statusOf(t, now) {
    if (t.status === "proposed" && Date.parse(t.expires_at) <= now) return { key: "expired", text: "Expired" };
    return { key: t.status, text: { proposed: "Waiting for an answer", accepted: "Waiting for the commissioner", approved: "Approved", rejected: "Rejected by the commissioner",
      declined: "Declined", withdrawn: "Withdrawn", expired: "Expired" }[t.status] || t.status };
  }

  // ---- Data ------------------------------------------------------------------------------------------
  var session = function () { return st.me && st.me.session; };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var rpc = function (name, body) { return api("rpc/" + name, { method: "POST", body: JSON.stringify(body) }); };
  var ok = function (r) { return r && r.ok ? r.data || [] : []; };
  var myTeam = function () { return st.me && st.me.teams && st.me.teams[0] ? st.me.teams[0].team_id : null; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var isMember = function () { return !!(st.me && (isCommish() || myTeam())); };
  var manages = function (team) { return (st.me && st.me.teams || []).some(function (t) { return t.team_id === team; }); };

  function loadSettings() {
    return api("season_settings?season=eq." + season + "&select=trades,waivers").then(function (r) {
      var s = ok(r)[0] || {};
      st.settings = { live: !!(s.trades && s.trades.live), rosterMax: (s.waivers && s.waivers.rosterMax) || 18, deadlineWeek: (s.trades && s.trades.deadlineWeek) || 12 };
    });
  }
  function loadAssets(team) {
    return rpc("trade_assets", { p_season: season, p_team: team }).then(function (r) {
      st.assets[team] = ok(r);
      st.assets[team].forEach(function (a) { if (a.kind === "player") st.names[a.id] = a.name || a.id; else st.pickLabels[a.id] = a.label; });
    });
  }
  function loadTrades() {
    return Promise.all([api("trades?season=eq." + season + "&select=*&order=proposed_at.desc&limit=100"), api("profiles?select=id,display_name")]).then(function (r) {
      st.trades = ok(r[0]);
      st.people = {}; ok(r[1]).forEach(function (p) { st.people[p.id] = p.display_name || ""; });
      var players = [], picks = [];
      st.trades.forEach(function (t) {
        [t.give_players, t.get_players, t.from_drops, t.to_drops].forEach(function (l) { (l || []).forEach(function (p) { if (!st.names[p] && players.indexOf(p) < 0) players.push(p); }); });
        [t.give_picks, t.get_picks].forEach(function (l) { (l || []).forEach(function (p) { if (!st.pickLabels[p] && picks.indexOf(p) < 0) picks.push(p); }); });
      });
      var q = function (ids) { return encodeURIComponent(ids.map(function (x) { return '"' + String(x).replace(/"/g, "") + '"'; }).join(",")); };
      return Promise.all([
        players.length ? api("nfl_players?id=in.(" + q(players) + ")&select=id,name,position") : null,
        picks.length ? api("draft_picks?id=in.(" + picks.join(",") + ")&select=id,season,round,original_team,owner_team") : null
      ]).then(function (r2) {
        ok(r2[0]).forEach(function (p) { st.names[p.id] = p.name + (p.position ? " (" + p.position + ")" : ""); });
        ok(r2[1]).forEach(function (p) { st.pickLabels[p.id] = p.season + " round " + p.round + " pick" + (p.original_team !== p.owner_team ? " (from " + TL().name(p.original_team) + ")" : ""); });
        // Rosters of my teams (for drops when accepting).
        var mine = (st.me.teams || []).map(function (t) { return t.team_id; }).filter(function (id) { return !st.assets[id]; });
        return Promise.all(mine.map(loadAssets));
      });
    });
  }

  // ---- Render ----------------------------------------------------------------------------------------
  var players = function (team) { return (st.assets[team] || []).filter(function (a) { return a.kind === "player"; }); };
  var picksOf = function (team) { return (st.assets[team] || []).filter(function (a) { return a.kind === "pick"; }); };
  function testBanner() {
    return st.settings.live ? "" : '<p class="pl-test"><b>TEST trades: MFL is official for ' + esc(season) + ".</b> Trades here are practice: approving one changes no rosters. Real trades start in " + esc(season + 1) + ".</p>";
  }
  function checkList(list, chosen, kind, side) {
    return list.length ? '<ul class="tr-list">' + list.map(function (a) {
      var locked = a.locked_until && Date.parse(a.locked_until) > Date.now(), on = chosen.indexOf(a.id) >= 0;
      return '<li><label class="' + (locked ? "muted" : "") + '"><input type="checkbox" data-tr-pick="' + esc(side + ":" + kind) + '" value="' + esc(a.id) + '"' + (on ? " checked" : "") + (locked ? " disabled" : "") + ">" +
        (kind === "player" ? '<span class="pos pos-' + esc(a.pos) + '">' + esc(a.pos) + "</span> " + esc(a.name) + ' <span class="muted small">' + esc(a.nfl_team || "") + "</span>" : esc(a.label)) +
        (locked ? ' <span class="small">🔒 until ' + esc(when(a.locked_until)) + "</span>" : "") + "</label></li>";
    }).join("") + "</ul>" : '<p class="muted small">None.</p>';
  }
  function builderHtml() {
    var me = myTeam(), them = st.other, p = st.pick, max = st.settings.rosterMax;
    if (!me) return '<section><h2>Propose a trade</h2><div class="card muted">Trades are made by a team\'s owners.</div></section>';
    if (me === them) return '<section><h2>Propose a trade</h2><div class="card muted">That\'s your own team. <a href="#teams">Pick another team</a>.</div></section>';
    var m = tradeMath({ mySize: players(me).length, theirSize: players(them).length, give: p.give.length, get: p.get.length, drops: p.drops.length, max: max });
    var dropChoices = players(me).filter(function (a) { return p.give.indexOf(a.id) < 0; });
    var after = function (team, out, inn, drops) {
      return players(team).filter(function (a) { return out.indexOf(a.id) < 0 && drops.indexOf(a.id) < 0; }).map(function (a) { return a.name; })
        .concat(players(team === me ? them : me).filter(function (a) { return inn.indexOf(a.id) >= 0; }).map(function (a) { return a.name + " (new)"; }));
    };
    var mineAfter = after(me, p.give, p.get, p.drops), theirsAfter = after(them, p.get, p.give, []);
    var empty = !(p.give.length + p.get.length + p.givePicks.length + p.getPicks.length);
    var blocked = m.needMine > 0;
    return '<section class="tr"><h2>Propose a trade</h2><p>To ' + TL().link(them) + "</p>" + testBanner() +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      '<div class="tr-cols"><div class="card"><h3>You give</h3>' + checkList(players(me), p.give, "player", "give") + "<h4>Draft picks</h4>" + checkList(picksOf(me), p.givePicks, "pick", "give") + "</div>" +
      '<div class="card"><h3>You get</h3>' + checkList(players(them), p.get, "player", "get") + "<h4>Draft picks</h4>" + checkList(picksOf(them), p.getPicks, "pick", "get") + "</div></div>" +
      '<div class="card"><h3>Resulting rosters</h3><div class="tr-cols"><div><b>' + TL().link(me, { logo: false }) + ": " + esc(m.mine) + "/" + esc(max) + "</b>" +
      '<p class="small muted">' + esc(mineAfter.join(", ")) + "</p></div><div><b>" + TL().link(them, { logo: false }) + ": " + esc(m.theirs) + "/" + esc(max) + "</b>" +
      '<p class="small muted">' + esc(theirsAfter.join(", ")) + "</p>" + (m.needTheirs ? '<p class="small">They\'ll need to drop ' + esc(m.needTheirs) + " when they accept.</p>" : "") + "</div></div>" +
      (m.needMine || p.drops.length ? '<h4>Your drops' + (m.needMine ? ' <span class="acct-msg err small">add ' + esc(m.needMine) + " more</span>" : "") + "</h4>" + checkList(dropChoices, p.drops, "player", "drop")
        : '<p class="small muted">Over ' + esc(max) + " players after the trade? Drops are added here.</p>") + "</div>" +
      '<form class="card acct-form" data-tr="propose"><label>Note (optional)<textarea name="note" rows="2" maxlength="500"></textarea></label>' +
      '<button class="btn" type="submit"' + (empty || blocked || st.busy ? " disabled" : "") + ">Send proposal</button>" +
      '<p class="muted small">They have 7 days to answer. Accepted trades go to the commissioner for approval before rosters change. Players whose game has started can\'t be traded until the week\'s last game ends; no trades from week ' + esc(st.settings.deadlineWeek) + "'s first kickoff.</p></form></section>";
  }
  function tradeCard(t) {
    var now = Date.now(), s = statusOf(t, now), toMine = manages(t.to_team), fromMine = manages(t.from_team);
    var acts = "";
    if (s.key === "proposed" && toMine) {
      var size = players(t.to_team).length, m = tradeMath({ mySize: size, theirSize: 0, give: (t.get_players || []).length, get: (t.give_players || []).length, drops: (st.pick.accDrops[t.id] || []).length, max: st.settings.rosterMax });
      var choices = players(t.to_team).filter(function (a) { return (t.get_players || []).indexOf(a.id) < 0; });
      acts = (m.needMine || (st.pick.accDrops[t.id] || []).length ? '<p class="small">You\'d have ' + esc(m.mine) + " players: " + (m.needMine ? "pick " + esc(m.needMine) + " to drop." : "drops chosen.") + "</p>" +
        checkList(choices, st.pick.accDrops[t.id] || [], "player", "acc" + t.id) : "") +
        '<button class="btn" type="button" data-tr="accept" data-id="' + t.id + '"' + (m.needMine ? " disabled" : "") + ">Accept</button> " +
        '<button class="btn ghost" type="button" data-tr="decline" data-id="' + t.id + '">Decline</button>';
    }
    if ((s.key === "proposed" || s.key === "accepted") && fromMine) acts += ' <button class="btn ghost" type="button" data-tr="withdraw" data-id="' + t.id + '">Withdraw</button>';
    if (s.key === "accepted" && isCommish()) acts += ' <button class="btn" type="button" data-tr="approve" data-id="' + t.id + '">Approve</button> <button class="btn ghost" type="button" data-tr="reject" data-id="' + t.id + '">Reject</button>';
    var who = function (u) { return st.people[u] ? esc(st.people[u]) : "an owner"; };
    return '<div class="card tr-card tr-' + esc(s.key) + '"><div class="tr-top"><span class="tag">' + esc(s.text) + "</span>" + (t.test ? ' <span class="tag pl-testtag">TEST</span>' : "") +
      (t.commissioner_party ? ' <span class="tag po-owe" title="The commissioner owns one of these teams">⚠ Commissioner is a party</span>' : "") + "</div>" +
      "<p>" + summaryHtml(t, st.names, st.pickLabels) + ".</p>" + (t.note ? '<p class="small">“' + esc(t.note) + "”</p>" : "") +
      '<p class="muted small">Proposed by ' + who(t.proposed_by) + " (" + TL().link(t.from_team, { logo: false }) + ") " + esc(when(t.proposed_at)) +
      (s.key === "proposed" ? " · expires " + esc(when(t.expires_at)) : "") + (t.decided_at ? " · decided " + esc(when(t.decided_at)) : "") + "</p>" +
      (t.decision_note ? '<p class="small">Commissioner: “' + esc(t.decision_note) + "”</p>" : "") +
      (acts ? '<div class="tr-acts">' + acts + "</div>" : "") +
      (t.conversation_id && (toMine || fromMine) ? '<a class="linkish" href="#dm/' + esc(t.conversation_id) + '">Conversation</a>' : "") + "</div>";
  }
  function listHtml() {
    var now = Date.now(), groups = { you: [], mine: [], commish: [], done: [], other: [] };
    st.trades.forEach(function (t) {
      var s = statusOf(t, now).key;
      if (s === "proposed" && manages(t.to_team)) groups.you.push(t);
      else if (s === "accepted" && isCommish()) groups.commish.push(t);
      else if ((s === "proposed" || s === "accepted") && manages(t.from_team)) groups.mine.push(t);
      else if (s === "approved") groups.done.push(t);
      else groups.other.push(t);
    });
    var sec = function (title, list, empty) { return "<h3>" + esc(title) + "</h3>" + (list.length ? list.map(tradeCard).join("") : '<p class="muted small">' + esc(empty) + "</p>"); };
    return '<section class="tr"><h2>Trades</h2>' + testBanner() +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      '<p class="muted small">To propose one, open a team (Teams page) and tap Propose trade.</p>' +
      (isCommish() ? sec("Waiting for your approval", groups.commish, "Nothing to review.") : "") +
      sec("Waiting for you", groups.you, "No offers.") + sec("Your proposals", groups.mine, "None open.") +
      sec("Completed", groups.done, "No trades yet.") + (groups.other.length ? sec("History", groups.other, "") : "") + "</section>";
  }
  function render() {
    if (!st.el) return;
    if (!isMember()) {
      st.el.innerHTML = '<section><h2>Trades</h2><div class="card bd-gate"><p><b>' + (st.me ? "Trades are for league members." : "Sign in to trade.") + "</b></p>" + (st.me ? "" : '<a class="btn" href="#account">Sign in</a>') + "</div></section>";
      return;
    }
    st.el.innerHTML = st.mode === "build" ? builderHtml() : listHtml();
  }

  // ---- Actions ---------------------------------------------------------------------------------------
  var friendly = function (e) { return String(e || "").replace(/^.*?error: /i, ""); };
  function after(p, okMsg, then) {
    st.busy = true;
    return p.then(function (r) {
      st.busy = false;
      st.msg = r.ok ? { ok: typeof okMsg === "function" ? okMsg(r) : okMsg } : { err: friendly(r.error) };
      if (r.ok && then) return then(r);
      return (st.mode === "list" ? loadTrades() : Promise.resolve()).then(render);
    });
  }
  function toggle(input) {
    var parts = input.dataset.trPick.split(":"), side = parts[0], kind = parts[1], id = input.value, p = st.pick;
    var list = /^acc/.test(side) ? (p.accDrops[side.slice(3)] = p.accDrops[side.slice(3)] || [])
      : side === "drop" ? p.drops : kind === "pick" ? (side === "give" ? p.givePicks : p.getPicks) : (side === "give" ? p.give : p.get);
    var i = list.indexOf(kind === "pick" && !/^acc/.test(side) ? Number(id) : id), v = kind === "pick" && !/^acc/.test(side) ? Number(id) : id;
    if (input.checked && i < 0) list.push(v); else if (!input.checked && i >= 0) list.splice(i, 1);
    if (side === "give") p.drops = p.drops.filter(function (x) { return p.give.indexOf(x) < 0; });
    var y = root.scrollY; render(); root.scrollTo(0, y);
  }
  function act(b) {
    var k = b.dataset.tr, id = Number(b.dataset.id);
    if (k === "accept") after(rpc("trade_respond", { p_trade: id, p_accept: true, p_drops: st.pick.accDrops[id] || [] }), "Accepted. It goes to the commissioner for approval.");
    else if (k === "decline" && root.confirm("Decline this trade?")) after(rpc("trade_respond", { p_trade: id, p_accept: false }), "Declined.");
    else if (k === "withdraw" && root.confirm("Withdraw this trade?")) after(rpc("trade_withdraw", { p_trade: id }), "Withdrawn.");
    else if (k === "approve" || k === "reject") {
      var t = st.trades.filter(function (x) { return x.id === id; })[0] || {};
      var note = root.prompt((k === "approve" ? "Approve" : "Reject") + " this trade? Note for both teams (optional):" + (t.commissioner_party ? "\n\n⚠ You own one of these teams: this decision is flagged and recorded in the audit log." : ""), "");
      if (note == null) return;
      after(rpc("trade_decide", { p_trade: id, p_approve: k === "approve", p_note: note || null }), function (r) { return /another commissioner|flagged/.test(String(r.data)) ? r.data + "." : k === "approve" ? (t.test ? "Approved (test: rosters unchanged)." : "Approved: rosters updated and posted to the Board.") : "Rejected."; });
    }
  }

  function start(rootEl, r) {
    st.el = rootEl; st.mode = r && r.page === "trade" ? "build" : "list"; st.other = r && r.team || null; st.msg = st.flash || null; st.flash = null; st.busy = false;
    st.pick = { give: [], get: [], givePicks: [], getPicks: [], drops: [], accDrops: {} }; st.pickLabels = st.pickLabels || {};
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Trades</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section><h2>Trades</h2><p class="muted">Loading…</p></section>';
    var el = rootEl;
    (root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null)).then(function (me) {
      st.me = me;
      if (st.el !== el) return;
      if (!isMember()) { render(); return; }
      if (st.mode === "build" && !TL().has(st.other)) { el.innerHTML = '<section><h2>Propose a trade</h2><div class="card muted">No such team.</div></section>'; return; }
      var work = st.mode === "build" ? Promise.all([loadSettings(), myTeam() ? loadAssets(myTeam()) : null, loadAssets(st.other)]) : Promise.all([loadSettings(), loadTrades()]);
      return work.then(function () { if (st.el === el) render(); });
    }).catch(function (e) { if (st.el === el) el.innerHTML = '<section><h2>Trades</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });
    rootEl.addEventListener("change", function (e) { if (e.target.matches("[data-tr-pick]")) toggle(e.target); });
    rootEl.addEventListener("click", function (e) { var b = e.target.closest("button[data-tr]"); if (b && !st.busy) act(b); });
    rootEl.addEventListener("submit", function (e) {
      if (!e.target.matches("[data-tr=propose]")) return;
      e.preventDefault();
      var p = st.pick;
      after(rpc("trade_propose", { p_season: season, p_from: myTeam(), p_to: st.other, p_give: p.give, p_get: p.get, p_give_picks: p.givePicks, p_get_picks: p.getPicks, p_drops: p.drops, p_note: e.target.note.value || null }),
        "Proposal sent. They'll see it under Trades and in Messages.", function () { st.flash = st.msg; root.location.hash = "#trades"; });
    });
  }
  function stop() { st.el = null; }

  root.B5Trades = { start: start, stop: stop, tradeMath: tradeMath, summaryHtml: summaryHtml, statusOf: statusOf };
})(typeof globalThis !== "undefined" ? globalThis : this);
