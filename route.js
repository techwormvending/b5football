/* Hash routes (pure, no DOM; tested in src/workers/week-nav.test.ts and nav.test.ts).
   Sections (nav redesign 2026-11-01): #scores (the Live page), #pools (Confidence Pool | Survivor),
   #messages/board|chat|private (one Messages page), #myteam (Lineup | Roster | Add / Drop | Trades),
   #more (phones). Old links keep working: each returns `redirect` (the new hash), which app.js
   writes in place (history.replaceState):
     #live/7/0005 -> #scores/7/0005; #live/3/0005-0006, #matchup/3/0005-0006 -> #scores/3/0005;
     #board/12 -> #messages/board/12 (#messages/board/key/<source key> opens a thread by its key); #chat/draft/tv -> #messages/chat/draft/tv; #dm/7 -> #messages/private/7;
     #standings -> #schedule; #lineups -> #myteam; #pool -> #confidence.
   Unknown -> home. `known(key)` says whether a page exists. */
(function (root) {
  "use strict";
  function inner(key, known) {
    var mu = /^(?:scores|live|matchup)\/(\d{1,2})\/(\w+)-(\w+)$/.exec(key);
    if (mu) return { page: "live", week: Number(mu[1]), team: mu[2], redirect: "#scores/" + Number(mu[1]) + "/" + mu[2] };
    var lt = /^scores\/(\d{1,2})\/(\w+)$/.exec(key);
    if (lt) return { page: "live", week: Number(lt[1]), team: lt[2] };
    var lw = /^scores\/(\d{1,2})$/.exec(key);
    if (lw) return { page: "live", week: Number(lw[1]) };
    if (key === "scores") return { page: "live", week: null };
    var cr = /^messages\/chat\/([a-z0-9][a-z0-9-]{1,29})(\/tv)?$/.exec(key);
    if (cr) return { page: "chat", week: null, room: cr[1], tv: !!cr[2] };
    if (key === "messages/chat") return { page: "chat", week: null };
    var bk = /^messages\/board\/key\/([a-z0-9][a-z0-9:._-]{0,79})$/.exec(key);   // a thread by its source key
    if (bk) return { page: "board", week: null, threadKey: bk[1] };
    var bt = /^messages\/board\/(\d+)$/.exec(key);
    if (bt) return { page: "board", week: null, thread: Number(bt[1]) };
    if (key === "messages" || key === "messages/board") return { page: "board", week: null };
    var dm = /^messages\/private\/(\d{1,12})$/.exec(key);
    if (dm) return { page: "dm", week: null, conv: Number(dm[1]) };
    if (key === "messages/private") return { page: "dm", week: null };
    var dr = /^draft\/(\d{1,9})(\/tv)?$/.exec(key);   // the Draft Room and its big-screen board
    if (dr) return { page: "draft", week: null, draft: Number(dr[1]), tv: !!dr[2] };
    if (key === "myteam/roster") return { page: "myteam", week: null, tab: "roster" };
    var tm = /^team\/(\w{1,12})$/.exec(key);
    if (tm) return { page: "team", week: null, team: tm[1] };
    var tr = /^trade\/(\w{1,12})$/.exec(key);
    if (tr) return { page: "trade", week: null, team: tr[1] };
    var un = /^unsubscribe\/([0-9a-f-]{36}\.[a-z]+\.[0-9a-f]{32})$/.exec(key);
    if (un) return { page: "unsubscribe", week: null, token: un[1] };
    if (key === "account/email") return { page: "account", week: null, section: "email" };   // emails' "Change this setting" link
    var pt = /^players\/(free-agents|claims|order|results|log|commish)$/.exec(key);
    if (pt) return { page: "players", week: null, tab: pt[1] };
    var pw = /^confidence\/(\d{1,2})$/.exec(key);
    if (pw) return { page: "confidence", week: Number(pw[1]) };
    if (key === "pools") return { page: "confidence", week: null };
    return { page: known(key) ? key : "home", week: null };
  }
  /** Old hashes -> their new homes ("" when the hash is already current). */
  function upgrade(key) {
    if (key === "lineups") return "myteam";
    if (key === "standings") return "schedule";
    if (key === "pool") return "confidence";
    var pw = /^pool\/(\d{1,2})$/.exec(key); if (pw) return "confidence/" + pw[1];
    var lv = /^live(\/.*)?$/.exec(key); if (lv) return "scores" + (lv[1] || "");
    var mu = /^matchup(\/.*)$/.exec(key); if (mu) return "scores" + mu[1];
    var bd = /^board(\/.*)?$/.exec(key); if (bd) return "messages/board" + (bd[1] || "");
    var ch = /^chat(\/.*)?$/.exec(key); if (ch) return "messages/chat" + (ch[1] || "");
    var dm = /^dm(\/.*)?$/.exec(key); if (dm) return "messages/private" + (dm[1] || "");
    return "";
  }
  function parseRoute(hash, known) {
    var raw = String(hash || "#home").replace(/^#/, "") || "home";
    var up = upgrade(raw), key = up || raw;
    var r = inner(key, known);
    if (up && !r.redirect) r.redirect = "#" + key;
    return r;
  }
  root.B5Route = { parse: parseRoute };
})(typeof globalThis !== "undefined" ? globalThis : this);
