/* Team profile (#team/<franchiseId>; window.B5TeamPage). Public: header (logo, name, division,
   record, standings rank, season winnings, titles), current roster with this week's lineup status
   (public.live_lineups: starters are revealed at their kickoff, like the Live page), this season's
   schedule and results, and history. Members only: the owners' names, recent transactions, the
   owner contact cards (public.team_contacts: only fields the owner marked "League members"; the
   commissioner sees everything), and the Message / Propose trade buttons.
   Contact links: mailto:, tel: and sms: (tappable on phones), https websites only
   (rel="nofollow noopener ugc", new tab). Nothing here is ever cached in league-data.js. */
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
  var season = Number(L.season), SLOTS = L.lineupSlots || ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
  var st = { el: null, id: null, me: null };

  // ---- Pure helpers (tested in src/workers/team-page.test.ts) ---------------------------------
  /** "4125550123" -> "(412) 555-0123"; anything else -> null. */
  function formatPhone(d) { var m = /^([2-9]\d{2})([2-9]\d{2})(\d{4})$/.exec(String(d || "")); return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : null; }
  function phoneHref(d, kind) { return formatPhone(d) ? (kind === "sms" ? "sms:+1" : "tel:+1") + d : null; }
  /** Only https URLs without spaces/quotes/angle brackets (the database enforces the same). */
  function safeWebsite(u) { return /^https:\/\/[^\s<>"'`]+\.[^\s<>"'`]+$/.test(String(u || "")) ? String(u) : null; }
  function safeEmail(e) { return /^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i.test(String(e || "")) ? String(e) : null; }
  /** One owner's contact card (HTML). */
  function contactCard(c, opts) {
    opts = opts || {};
    var rows = [], ph = formatPhone(c.phone), web = safeWebsite(c.website), em = safeEmail(c.email), hidden = c.hidden || [];
    var note = function (k) { return hidden.indexOf(k) >= 0 ? ' <span class="tag">hidden from members</span>' : ""; };
    if (em) rows.push('<li><span class="tc-k">Email</span><a href="mailto:' + esc(em) + '">' + esc(em) + "</a>" + note("email") + "</li>");
    if (ph) rows.push('<li><span class="tc-k">Cell</span><a href="' + esc(phoneHref(c.phone, "tel")) + '">' + esc(ph) + '</a> · <a href="' + esc(phoneHref(c.phone, "sms")) + '">Text</a>' + note("phone") + "</li>");
    if (web) rows.push('<li><span class="tc-k">Website</span><a href="' + esc(web) + '" target="_blank" rel="nofollow noopener ugc">' + esc(web.replace(/^https:\/\//, "")) + "</a>" + note("website") + "</li>");
    return '<div class="card tc-card"><h3>' + esc(c.display_name || "Owner") + (opts.self ? ' <span class="muted small">(you)</span>' : "") + "</h3>" +
      (rows.length ? '<ul class="tc-list">' + rows.join("") + "</ul>" : '<p class="muted small">No contact info shared.</p>') +
      (opts.message ? '<button class="btn ghost" type="button" data-tp="dm-user" data-user="' + esc(c.user_id) + '">Message</button>' : "") +
      (opts.self ? '<a class="linkish" href="#account">Edit your contact info</a>' : "") + "</div>";
  }
  /** This team's games: [{ week, opp, home, us, them, result }] from LEAGUE.schedule (DB-backed when loaded). */
  function games(sched, id) {
    var out = [];
    ((sched && sched.weeks) || []).forEach(function (w) {
      (w.games || []).forEach(function (g) {
        var a = g[0], ap = g[1], h = g[2], hp = g[3];
        if (a !== id && h !== id) return;
        var home = h === id, us = home ? hp : ap, them = home ? ap : hp, played = ap != null && hp != null;
        out.push({ week: w.week, opp: home ? a : h, home: home, us: played ? us : null, them: played ? them : null,
          result: !played ? "" : us > them ? "W" : us < them ? "L" : "T" });
      });
    });
    return out;
  }
  /** Lineup status per rostered player from live_lineups rows for this team. */
  function lineupStatus(roster, slots) {
    var hidden = slots.filter(function (s) { return !s.player_id; }).length;
    var by = {}; slots.forEach(function (s) { if (s.player_id) by[s.player_id] = SLOTS[s.slot] || "Starter"; });
    return roster.map(function (p) {
      return Object.assign({}, p, { status: by[p.id] ? "Starter · " + by[p.id] : hidden ? "Bench or hidden starter" : slots.length ? "Bench" : "" });
    });
  }

  // ---- Load + render -----------------------------------------------------------------------------
  var api = function (path, sess) { return A.api(cfg, sess || null, path, {}, f); };
  var ok = function (r) { return r && r.ok ? r.data || [] : []; };
  var isMember = function () { return !!(st.me && (st.me.profile && st.me.profile.is_commissioner || (st.me.teams && st.me.teams.length))); };
  var myTeam = function () { return st.me && st.me.teams && st.me.teams[0] ? st.me.teams[0].team_id : null; };

  function currentWeek(gs) {
    var byWeek = {};
    gs.forEach(function (g) { byWeek[g.week] = Math.max(byWeek[g.week] || 0, Date.parse(g.kickoff)); });
    var weeks = Object.keys(byWeek).map(Number).sort(function (a, b) { return a - b; }), now = Date.now();
    for (var i = 0; i < weeks.length; i++) if (byWeek[weeks[i]] + 5 * 3600e3 > now) return weeks[i];
    return weeks[weeks.length - 1] || null;
  }

  function load(id) {
    var sess = st.me && st.me.session, member = isMember();
    return Promise.all([
      api("roster_entries?season=eq." + season + "&team_id=eq." + encodeURIComponent(id) + "&select=player_id,acquired,nfl_players(name,position,nfl_team)", sess),
      api("nfl_games?season=eq." + season + "&select=week,kickoff", sess),
      member ? api("team_managers?team_id=eq." + encodeURIComponent(id) + "&select=user_id,profiles(display_name)", sess) : Promise.resolve(null),
      member ? A.api(cfg, sess, "rpc/team_contacts", { method: "POST", body: JSON.stringify({ p_team: id }) }, f) : Promise.resolve(null),
      member ? api("transactions?season=eq." + season + "&status=in.(processed,reversed)&or=(team_id.eq." + encodeURIComponent(id) + ",partner_team_id.eq." + encodeURIComponent(id) + ")&select=id,team_id,type,status,players_in,players_out,partner_team_id,via,created_at&order=created_at.desc&limit=10", sess) : Promise.resolve(null),
      root.B5Payouts && root.B5Payouts.teamWinnings ? root.B5Payouts.teamWinnings().catch(function () { return {}; }) : Promise.resolve({})
    ]).then(function (r) {
      var d = { roster: ok(r[0]).map(function (x) { var n = x.nfl_players || {}; return { id: x.player_id, name: n.name || x.player_id, pos: n.position || "", nfl: n.nfl_team || "" }; }),
        owners: r[2] ? ok(r[2]).map(function (x) { return { user_id: x.user_id, name: x.profiles && x.profiles.display_name || "" }; }) : null,
        contacts: r[3] ? ok(r[3]) : null, txns: r[4] ? ok(r[4]) : null, winnings: r[5] || {}, week: currentWeek(ok(r[1])), slots: [], names: {} };
      var order = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };
      d.roster.sort(function (a, b) { return (order[a.pos] - order[b.pos]) || a.name.localeCompare(b.name); });
      d.roster.forEach(function (p) { d.names[p.id] = p.name; });
      var need = [];
      (d.txns || []).forEach(function (t) { (t.players_in || []).concat(t.players_out || []).forEach(function (x) { if (!d.names[x] && !/^mfl:/.test(x) && need.indexOf(x) < 0) need.push(x); }); });
      return Promise.all([
        d.week ? A.api(cfg, sess, "rpc/live_lineups", { method: "POST", body: JSON.stringify({ p_season: season, p_week: d.week }) }, f) : Promise.resolve(null),
        need.length ? api("nfl_players?id=in.(" + encodeURIComponent(need.map(function (x) { return '"' + x.replace(/"/g, "") + '"'; }).join(",")) + ")&select=id,name", sess) : Promise.resolve(null)
      ]).then(function (r2) {
        d.slots = ok(r2[0]).filter(function (s) { return s.team_id === id; });
        ok(r2[1]).forEach(function (p) { d.names[p.id] = p.name; });
        return d;
      });
    });
  }

  function render(d) {
    var id = st.id, T = TL();
    var rows = (L.standings && L.standings.rows) || [], i = rows.map(function (r) { return r[0]; }).indexOf(id), rec = i >= 0 ? rows[i] : null;
    var w = d.winnings[id] || { final: 0, projected: 0 }, money = root.B5Payouts ? root.B5Payouts.money : function (x) { return "$" + x; };
    var div = ((L.divisions || []).filter(function (x) { return x.id === T.division(id); })[0] || {}).name;
    var titleYears = (L.champions || []).filter(function (c) { return T.byName(c.champion) === id; }).map(function (c) { return c.year; });
    var titles = Math.max(T.titles(id), titleYears.length);
    var owners = d.owners ? d.owners.map(function (o) { return o.name || "Owner"; }).join(" & ") : (T.manager(id) && !/^(TODO|TBD)/i.test(T.manager(id)) ? T.manager(id) : "");
    var mine = myTeam() === id, member = isMember();
    var buttons = member && !mine ? '<div class="tp-acts"><button class="btn" type="button" data-tp="dm-team">Message</button>' +
      (myTeam() ? '<a class="btn ghost" href="#trade/' + esc(id) + '">Propose trade</a>' : "") + "</div>" : "";
    var head = '<div class="card tp-head">' + T.logo(id, "logo") + '<div class="tp-title"><h2>' + T.link(id, { logo: false }) + "</h2>" +
      '<div class="muted">' + esc(div ? div + " Division" : "") + (owners ? " · " + esc(owners) : "") + "</div>" +
      (titles ? '<div class="rings" title="' + esc(titles) + ' title(s)">' + "🏆".repeat(titles) + "</div>" : "") + "</div>" +
      '<div class="mt-stats">' + (rec ? "<div><b>" + esc(rec[1] + "-" + rec[2] + (rec[3] ? "-" + rec[3] : "")) + "</b><span>Record</span></div><div><b>#" + esc(i + 1) + "</b><span>Standings</span></div>" : "") +
      "<div><b>" + esc(money(w.final)) + "</b><span>Won" + (w.projected ? " (+" + esc(money(w.projected)) + " projected)" : "") + "</span></div></div>" + buttons + "</div>";

    var roster = lineupStatus(d.roster, d.slots);
    var rosterHtml = '<div class="card"><h3>Roster (' + roster.length + ")" + (d.week ? ' <span class="muted small">· week ' + esc(d.week) + " lineup</span>" : "") + "</h3>" +
      (roster.length ? '<ul class="roster-list">' + roster.map(function (p) {
        return '<li><span class="pos pos-' + esc(p.pos) + '">' + esc(p.pos) + '</span><span class="pname">' + esc(p.name) + ' <span class="muted nfl">' + esc(p.nfl) + "</span></span>" +
          (p.status ? '<span class="muted small tp-st' + (/^Starter/.test(p.status) ? " on" : "") + '">' + esc(p.status) + "</span>" : "") + "</li>";
      }).join("") + "</ul>" : '<p class="muted">No roster yet.</p>') +
      (d.slots.some(function (s) { return !s.player_id; }) ? '<p class="muted small">Starters are revealed at their kickoff.</p>' : "") + "</div>";

    var gs = games(L.schedule, id);
    var schedHtml = '<div class="card"><h3>' + esc(season) + " schedule</h3>" + (gs.length ? '<div class="table-wrap"><table><thead><tr><th>Wk</th><th>Opponent</th><th class="num">Score</th><th></th></tr></thead><tbody>' +
      gs.map(function (g) {
        return "<tr><td>" + esc(g.week) + "</td><td>" + (g.home ? "vs " : "@ ") + T.link(g.opp) + '</td><td class="num">' + (g.us != null ? esc(Number(g.us).toFixed(1) + "–" + Number(g.them).toFixed(1)) : '<a href="#live/' + esc(g.week) + "/" + esc(id) + '">Week ' + esc(g.week) + "</a>") +
          '</td><td><b class="tp-r ' + esc(g.result) + '">' + esc(g.result) + "</b></td></tr>";
      }).join("") + "</tbody></table></div>" : '<p class="muted">No schedule yet.</p>') + "</div>";

    var txHtml = '<div class="card"><h3>Recent transactions</h3>' + (!member ? '<p class="muted small">Sign in to see transactions.</p>'
      : d.txns && d.txns.length ? '<ul class="checks tx-log">' + d.txns.map(function (t) {
        return "<li>" + (root.B5Players ? root.B5Players.txnText(t, d.names, true) : esc(t.type)) + ' <span class="muted small">' + esc(new Date(t.created_at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })) + "</span></li>";
      }).join("") + '</ul><a class="linkish" href="#players/log">All transactions</a>' : '<p class="muted">None yet.</p>') + "</div>";

    var histHtml = '<div class="card"><h3>History</h3>' + (titleYears.length ? "<p>🏆 Champions: " + esc(titleYears.join(", ")) + "</p>" : "") +
      '<p class="muted small">Past seasons, records and earlier team names are added with the league history import (2000 on).</p></div>';

    var contactHtml = "";
    if (member && d.contacts) {
      contactHtml = '<section class="tp-contacts"><h3>Owner contacts</h3><div class="grid">' + d.contacts.map(function (c) {
        var self = st.me.session && c.user_id === st.me.session.user.id;
        return contactCard(c, { self: self, message: !self });
      }).join("") + "</div>" + (st.me.profile && st.me.profile.is_commissioner ? '<p class="muted small">As commissioner you see every field, including hidden ones.</p>' : '<p class="muted small">Visible to signed-in league members only.</p>') + "</section>";
    }
    st.el.innerHTML = '<section class="tp">' + head + (st.msg ? '<p class="acct-msg err">' + esc(st.msg) + "</p>" : "") + contactHtml +
      '<div class="tp-cols"><div>' + rosterHtml + txHtml + "</div><div>" + schedHtml + histHtml + "</div></div></section>";
  }

  function start(rootEl, r) {
    st.el = rootEl; st.id = r && r.team; st.msg = null;
    if (!st.id || !TL().has(st.id)) { rootEl.innerHTML = '<section><h2>Team</h2><div class="card muted">No such team. <a href="#teams">All teams</a></div></section>'; return; }
    rootEl.innerHTML = '<section class="tp"><div class="card tp-head">' + TL().logo(st.id, "logo") + '<div class="tp-title"><h2>' + TL().link(st.id, { logo: false }) + '</h2><p class="muted">Loading…</p></div></div></section>';
    if (!(cfg && cfg.configured && A)) return;
    var el = rootEl, id = st.id;
    (root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null)).then(function (me) {
      st.me = me;
      return load(id);
    }).then(function (d) { if (st.el === el && st.id === id) { st.d = d; render(d); } })
      .catch(function (e) { if (st.el === el) el.insertAdjacentHTML("beforeend", '<p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p>"); });
    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tp]"); if (!b || !root.B5DM) return;
      var to = b.dataset.tp === "dm-team" ? { team: st.id } : { user: b.dataset.user };
      b.disabled = true;
      root.B5DM.open(to).then(function (res) { if (!res.ok) { st.msg = res.error; render(st.d); } });
    });
  }
  function stop() { st.el = null; }

  root.B5TeamPage = { start: start, stop: stop, formatPhone: formatPhone, phoneHref: phoneHref, safeWebsite: safeWebsite, safeEmail: safeEmail,
    contactCard: contactCard, games: games, lineupStatus: lineupStatus };
})(typeof globalThis !== "undefined" ? globalThis : this);
