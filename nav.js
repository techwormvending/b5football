/* Site navigation (window.B5Nav), built for clarity over density (2026-11-01):
   - Top bar (tablet/desktop): Home · My Team · Scores · Pools · Messages · League ▾ · [name] ▾
     (or a "Sign in" button). Menus open on click/tap and stay open until clicked away.
   - Phones (< 760 px): a fixed bottom bar, Home · My Team · Scores · Messages · More, and #more
     (big tiles: Pools, the League pages, My Account, role tools, Sign out).
   - Every page gets a big title under the bar and, for grouped pages, big tabs.
   Pure builders (topHtml, bottomHtml, moreHtml, headHtml, sectionOf) are tested in
   src/workers/nav.test.ts; mount() wires them to the page. */
(function (root) {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  /** The League pages; Payouts (dollar amounts) only for league members. */
  function leagueLinks(v) { return LEAGUE_LINKS.filter(function (x) { return x[0] !== "#payouts" || (v && v.member); }); }
  var LEAGUE_LINKS = [["#schedule", "Standings & Schedule"], ["#teams", "Teams"], ["#players", "Players"], ["#payouts", "Payouts"],
    ["#history", "History"], ["#rules", "Rules"], ["#traditions", "Traditions"], ["#draft", "Draft Room"]];
  /** Role tools, in menu order, for the roles a person holds (Treasury also for commissioners: they read the books). */
  function roleLinks(v) {
    var r = (v && v.roles) || [];
    var out = [];
    if (r.indexOf("commissioner") >= 0) out.push(["#commish", "Commissioner"]);
    if (r.indexOf("treasurer") >= 0 || r.indexOf("commissioner") >= 0) out.push(["#treasury", "Treasury"]);
    if (r.indexOf("admin") >= 0) out.push(["#admin", "Admin"]);
    return out;
  }

  // page -> { sec: top-bar item, title, tabs }. Tabs = [[href, label, page(s), badge key]].
  var TABS = {
    myteam: [["#myteam", "Lineup", ["myteam:lineup"]], ["#myteam/roster", "Roster", ["myteam:roster"]], ["#players", "Add / Drop", ["players"]], ["#trades", "Trades", ["trades", "trade"]]],
    pools: [["#confidence", "Confidence Pool", ["confidence"]], ["#survivor", "Survivor", ["survivor"]]],
    messages: [["#messages/board", "Message Board", ["board"], "board"], ["#messages/chat", "Chat", ["chat"], "chat"], ["#messages/private", "Private", ["dm"], "dm"]]
  };
  var PAGES = {
    home: ["home", "Home"], myteam: ["myteam", "My Team"], players: ["myteam", "My Team"], trades: ["myteam", "My Team"], trade: ["myteam", "My Team"],
    live: ["scores", "Scores"], confidence: ["pools", "Pools"], survivor: ["pools", "Pools"],
    board: ["messages", "Messages"], chat: ["messages", "Messages"], dm: ["messages", "Messages"],
    schedule: ["league", "Standings & Schedule"], teams: ["league", "Teams"], team: ["league", "Team"], payouts: ["league", "Payouts"],
    history: ["league", "History"], draft: ["league", "Draft Room"], rules: ["league", "Rules"], traditions: ["league", "Traditions"],
    account: ["user", "My Account"], unsubscribe: ["user", "Email settings"], commish: ["user", "Commissioner"], "commish-payouts": ["user", "Commissioner"],
    treasury: ["user", "Treasury"], admin: ["user", "Admin"], more: ["more", "More"]
  };
  /** The section (top-bar item), page title and tab group for a route. */
  function sectionOf(r) {
    var page = r && r.page || "home", p = PAGES[page] || ["home", "Home"];
    var group = p[0] === "myteam" ? "myteam" : p[0] === "pools" ? "pools" : p[0] === "messages" ? "messages" : null;
    var key = page === "myteam" ? "myteam:" + (r.tab === "roster" ? "roster" : "lineup") : page;
    return { sec: p[0], title: p[1], group: group, key: key };
  }
  var badgeHtml = function (n, id, key) {
    n = Number(n) || 0;
    return '<span class="nav-badge"' + (id ? ' id="' + id + '"' : "") + (key ? ' data-badge="' + key + '"' : "") + (n ? "" : " hidden") + ' aria-label="' + n + ' unread">' + (n > 99 ? "99+" : n) + "</span>";
  };
  var active = function (on) { return on ? ' class="active" aria-current="page"' : ""; };

  /** The top bar's links. v = { signedIn, name, roles }; badges = { messages }. */
  function topHtml(v, s, badges) {
    s = s || { sec: "home" };
    var item = function (href, label, sec, extra) { return '<a href="' + href + '"' + active(s.sec === sec) + ' data-sec="' + sec + '">' + esc(label) + (extra || "") + "</a>"; };
    var menu = function (id, label, links, on, extra) {
      return '<div class="menu" data-menu="' + id + '"><button type="button" class="menu-btn' + (on ? " active" : "") + '" aria-haspopup="true" aria-expanded="false" aria-controls="menu-' + id + '"' + (on ? ' aria-current="page"' : "") + ">" +
        '<span class="menu-label">' + esc(label) + '</span> <span aria-hidden="true">▾</span></button>' +
        '<div class="menu-list" id="menu-' + id + '" hidden>' + links + (extra || "") + "</div></div>";
    };
    var link = function (x) { return '<a href="' + x[0] + '">' + esc(x[1]) + "</a>"; };
    var user = v && v.signedIn
      ? menu("user", v.name || "My Account", link(["#account", "My Account"]) +
          (roleLinks(v).length ? '<p class="menu-h">Officer tools</p>' + roleLinks(v).map(link).join("") : ""), s.sec === "user",
          '<button type="button" class="menu-out" data-nav="signout">Sign out</button>')
      : '<a href="#account" class="nav-signin' + (s.sec === "user" ? " active" : "") + '">Sign in</a>';
    return item("#home", "Home", "home") + item("#myteam", "My Team", "myteam") + item("#scores", "Scores", "scores") +
      item("#pools", "Pools", "pools") + item("#messages", "Messages", "messages", badgeHtml(badges && badges.messages, "msgBadge")) +
      menu("league", "League", leagueLinks(v).map(link).join(""), s.sec === "league") + user;
  }

  var ICONS = { home: "🏠", myteam: "📋", scores: "🏈", messages: "💬", more: "☰" };
  /** The phone bar: five big buttons, icon + word. */
  function bottomHtml(s, badges) {
    s = s || { sec: "home" };
    var b = function (href, label, sec, badge) {
      var on = s.sec === sec || (sec === "more" && (s.sec === "league" || s.sec === "user" || s.sec === "pools"));
      return '<a href="' + href + '"' + active(on) + ' data-sec="' + sec + '"><span class="bb-ic" aria-hidden="true">' + ICONS[sec] + "</span>" +
        '<span class="bb-label">' + esc(label) + "</span>" + (badge || "") + "</a>";
    };
    return b("#home", "Home", "home") + b("#myteam", "My Team", "myteam") + b("#scores", "Scores", "scores") +
      b("#messages", "Messages", "messages", badgeHtml(badges && badges.messages, "msgBadgeBb")) + b("#more", "More", "more");
  }

  /** #more: big tiles. */
  function moreHtml(v) {
    var tile = function (x) { return '<a class="tile" href="' + x[0] + '">' + esc(x[1]) + "</a>"; };
    var acct = v && v.signedIn
      ? '<h2>' + esc(v.name || "My Account") + '</h2><div class="tiles">' + tile(["#account", "My Account"]) + roleLinks(v).map(tile).join("") +
        '<button type="button" class="tile tile-out" data-nav="signout">Sign out</button></div>'
      : '<h2>Account</h2><div class="tiles"><a class="tile tile-signin" href="#account">Sign in</a></div>';
    return '<section class="more"><div class="tiles">' + tile(["#pools", "Pools"]) + "</div>" +
      '<h2>League</h2><div class="tiles">' + leagueLinks(v).map(tile).join("") + "</div>" + acct + "</section>";
  }

  /** The big page title under the bar, plus the page's tabs (with unread counts on Messages). */
  function headHtml(s, badges, viewer) {
    var tabs = s.group ? TABS[s.group] : null;
    var t = tabs ? '<nav class="page-tabs" aria-label="' + esc(s.title) + '">' + tabs.map(function (x) {
      var on = x[2].indexOf(s.key) >= 0;
      return '<a href="' + x[0] + '"' + active(on) + ">" + esc(x[1]) + (x[3] ? badgeHtml(badges && badges[x[3]], null, x[3]) : "") + "</a>";
    }).join("") + "</nav>" : "";
    return '<div class="page-head"><h1 class="page-title">' + esc(s.title) + "</h1>" + t + "</div>";
  }

  // ---- Wiring (browser) -------------------------------------------------------------------
  var st = { viewer: { signedIn: false, name: "", roles: [] }, s: { sec: "home" }, counts: { board: 0, chat: 0, dm: 0 } };
  var total = function () { return st.counts.board + st.counts.chat + st.counts.dm; };
  function draw() {
    var d = root.document; if (!d) return;
    var top = d.getElementById("nav"), bb = d.getElementById("bottomBar");
    var open = top && top.querySelector(".menu-list:not([hidden])");
    var openId = open && open.id;
    if (top) top.innerHTML = topHtml(st.viewer, st.s, { messages: total() });
    if (bb) bb.innerHTML = bottomHtml(st.s, { messages: total() });
    if (openId) { var m = d.getElementById(openId); if (m) setMenu(m.parentNode, true); }
    d.querySelectorAll(".page-tabs [data-badge]").forEach(function (b) {
      var n = st.counts[b.dataset.badge] || 0;
      b.textContent = n > 99 ? "99+" : String(n); b.hidden = !n; b.setAttribute("aria-label", n + " unread");
    });
  }
  function setMenu(menu, on) {
    var b = menu.querySelector(".menu-btn"), l = menu.querySelector(".menu-list");
    if (!b || !l) return;
    l.hidden = !on; b.setAttribute("aria-expanded", on ? "true" : "false");
  }
  function closeMenus(except) {
    var d = root.document;
    d.querySelectorAll(".menu").forEach(function (m) { if (m !== except) setMenu(m, false); });
  }
  /** Route changed: top bar and bottom bar highlight, title and tabs. */
  function route(r) {
    st.s = sectionOf(r);
    closeMenus();
    draw();
    return headHtml(st.s, st.counts, st.viewer);
  }
  /** Who's signed in (account.js calls this whenever it knows). */
  function setViewer(v) { st.viewer = v || { signedIn: false, roles: [] }; draw(); }
  /** One unread source changed (board, chat, dm). */
  function setCount(key, n) { if (st.counts[key] === (Number(n) || 0)) return; st.counts[key] = Number(n) || 0; draw(); }

  function mount() {
    var d = root.document; if (!d) return;
    d.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".menu-btn");
      if (btn) { var m = btn.parentNode, on = btn.getAttribute("aria-expanded") !== "true"; closeMenus(m); setMenu(m, on); return; }
      var out = e.target.closest && e.target.closest("[data-nav='signout']");
      if (out) { e.preventDefault(); closeMenus(); if (root.B5Account && root.B5Account.signOut) root.B5Account.signOut(); return; }
      // A link in a menu, or anywhere outside the open menu, closes it.
      var inMenu = e.target.closest && e.target.closest(".menu");
      if (!inMenu || e.target.closest("a")) closeMenus();
    });
    d.addEventListener("keydown", function (e) { if (e.key === "Escape") { var o = d.querySelector(".menu-list:not([hidden])"); closeMenus(); if (o) { var b = o.parentNode.querySelector(".menu-btn"); if (b) b.focus(); } } });
    // Phones: the bottom bar steps aside while typing, so the keyboard and composer have the room.
    d.addEventListener("focusin", function (e) { if (e.target.matches && e.target.matches("input, textarea, select, [contenteditable]")) d.body.classList.add("typing"); });
    d.addEventListener("focusout", function () { d.body.classList.remove("typing"); });
    draw();
  }

  root.B5Nav = { topHtml: topHtml, bottomHtml: bottomHtml, moreHtml: moreHtml, headHtml: headHtml, sectionOf: sectionOf, roleLinks: roleLinks,
    leagueLinks: leagueLinks, route: route, setViewer: setViewer, setCount: setCount, mount: mount, LEAGUE_LINKS: LEAGUE_LINKS, TABS: TABS };
})(typeof globalThis !== "undefined" ? globalThis : this);
