/* Hash routes (pure, no DOM; tested in src/workers/week-nav.test.ts).
   "#confidence/7" -> { page: "confidence", week: 7 }; "#matchup/3/0005-0006" -> matchup;
   "#lineups" -> myteam (old links); unknown -> home. `known(key)` says whether a page exists. */
(function (root) {
  "use strict";
  function parseRoute(hash, known) {
    var raw = String(hash || "#home").replace(/^#/, "") || "home";
    var key = raw === "lineups" ? "myteam" : raw;
    var mu = /^matchup\/(\d+)\/(\w+)-(\w+)$/.exec(key);
    if (mu) return { page: "matchup", week: Number(mu[1]), away: mu[2], home: mu[3] };
    var pw = /^(confidence|pool)\/(\d{1,2})$/.exec(key);
    if (pw) return { page: "confidence", week: Number(pw[2]) };
    if (key === "pool") return { page: "confidence", week: null };
    return { page: known(key) ? key : "home", week: null };
  }
  root.B5Route = { parse: parseRoute };
})(typeof globalThis !== "undefined" ? globalThis : this);
