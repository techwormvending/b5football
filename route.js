/* Hash routes (pure, no DOM; tested in src/workers/week-nav.test.ts).
   "#confidence/7" -> { page: "confidence", week: 7 }; "#live/7" -> Live, week 7;
   "#live/3/0005" -> Live, week 3, the matchup with team 0005 selected; old "#live/3/0005-0006"
   and "#matchup/3/0005-0006" links -> the same, with `redirect` (the new hash) for app.js;
   "#lineups" -> myteam (old links); unknown -> home. `known(key)` says whether a page exists. */
(function (root) {
  "use strict";
  function parseRoute(hash, known) {
    var raw = String(hash || "#home").replace(/^#/, "") || "home";
    var key = raw === "lineups" ? "myteam" : raw;
    // Old matchup links (separate detail page, removed 2026-10-21) redirect to the one Live page.
    var mu = /^(?:live|matchup)\/(\d{1,2})\/(\w+)-(\w+)$/.exec(key);
    if (mu) return { page: "live", week: Number(mu[1]), team: mu[2], redirect: "#live/" + Number(mu[1]) + "/" + mu[2] };
    var lt = /^live\/(\d{1,2})\/(\w+)$/.exec(key);
    if (lt) return { page: "live", week: Number(lt[1]), team: lt[2] };
    var cr = /^chat\/([a-z0-9][a-z0-9-]{1,29})(\/tv)?$/.exec(key);
    if (cr) return { page: "chat", week: null, room: cr[1], tv: !!cr[2] };
    var bt = /^board\/(\d+)$/.exec(key);
    if (bt) return { page: "board", week: null, thread: Number(bt[1]) };
    var lw = /^live\/(\d{1,2})$/.exec(key);
    if (lw) return { page: "live", week: Number(lw[1]) };
    var pw = /^(confidence|pool)\/(\d{1,2})$/.exec(key);
    if (pw) return { page: "confidence", week: Number(pw[2]) };
    if (key === "pool") return { page: "confidence", week: null };
    return { page: known(key) ? key : "home", week: null };
  }
  root.B5Route = { parse: parseRoute };
})(typeof globalThis !== "undefined" ? globalThis : this);
