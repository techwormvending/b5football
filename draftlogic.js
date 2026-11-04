/* B5 draft rules, pure (window.B5DraftLogic; tested in src/workers/draft.test.ts). The database
   (migration draft_room) applies the same rules and is the authority; the page uses these to draw
   the board, the "next up / 2 picks away" hints and the queue before the server answers.

   B5 "redraw serpentine": ODD rounds (1, 3, 5 ...) get a NEW order (drawn at random or entered by
   the commissioner); EVEN rounds are the exact reverse of the round before. A pick is owned as
   "Round N, originally Team X" (draft_picks, tradable); its slot in the round comes from that round's
   order, so a traded pick lands wherever its original team was drawn. */
(function (root) {
  "use strict";

  /** The order for a round: odd = its own order (or null until set), even = reverse of the round before. */
  function roundOrder(orders, round) {
    if (round % 2 === 1) return orders[round] ? orders[round].slice() : null;
    var prev = orders[round - 1];
    return prev ? prev.slice().reverse() : null;
  }
  /** Odd rounds that still need an order (before the draft: all of them; live: the one coming up). */
  function missingOrders(orders, rounds) {
    var out = [];
    for (var r = 1; r <= rounds; r += 2) if (!orders[r]) out.push(r);
    return out;
  }
  /** null when the order is valid: every team of the draft exactly once. */
  function validateOrder(order, teams) {
    if (!Array.isArray(order)) return "Enter the order.";
    if (order.length !== teams.length) return "The order needs all " + teams.length + " teams (got " + order.length + ").";
    var seen = {};
    for (var i = 0; i < order.length; i++) {
      var t = order[i];
      if (teams.indexOf(t) < 0) return "Unknown team: " + t + ".";
      if (seen[t]) return "A team is in the order twice: " + t + ".";
      seen[t] = true;
    }
    return null;
  }
  /** overall (1-based) -> { round, pick } for n teams. */
  function position(overall, n) { return { round: Math.floor((overall - 1) / n) + 1, pick: ((overall - 1) % n) + 1 }; }
  /** Who owns "Round r, originally T": owners[r + ":" + T], else T itself (not traded). */
  function ownerOf(owners, round, original) { return (owners && owners[round + ":" + original]) || original; }
  /** One slot: { overall, round, pick, original, owner, traded } or null when its round's order isn't set yet. */
  function slot(overall, teams, orders, owners) {
    var p = position(overall, teams.length), order = roundOrder(orders, p.round);
    if (!order) return null;
    var original = order[p.pick - 1], owner = ownerOf(owners, p.round, original);
    return { overall: overall, round: p.round, pick: p.pick, original: original, owner: owner, traded: owner !== original };
  }
  /** The By Pick board: one row per round, columns = picks 1..n of the round. A cell = the slot (the team that
      owns the pick NOW, its original team, the overall pick number), or null while that round's order isn't set
      ("Order TBD"). Odd rounds follow their own draw; even rounds the reverse of the round above. */
  function pickGrid(teams, rounds, orders, owners) {
    var n = teams.length, out = [];
    for (var r = 1; r <= rounds; r++) {
      var cells = [];
      for (var p = 1; p <= n; p++) cells.push(slot((r - 1) * n + p, teams, orders, owners));
      out.push({ round: r, known: !!roundOrder(orders, r), cells: cells });
    }
    return out;
  }
  /** Every slot whose order is known, in pick order. */
  function board(teams, rounds, orders, owners) {
    var out = [];
    for (var o = 1; o <= teams.length * rounds; o++) { var s = slot(o, teams, orders, owners); if (s) out.push(s); }
    return out;
  }
  /** The pick on the clock: the first overall with no selection (a skipped pick counts as passed). */
  function currentOverall(selections, total) {
    var done = {};
    (selections || []).forEach(function (s) { done[s.overall] = true; });
    for (var o = 1; o <= total; o++) if (!done[o]) return o;
    return null;
  }
  /** How many picks until this team picks again (0 = on the clock), or null if not in the known board. */
  function picksAway(teams, rounds, orders, owners, current, team) {
    if (current == null) return null;
    for (var o = current; o <= teams.length * rounds; o++) {
      var s = slot(o, teams, orders, owners);
      if (!s) return null;   // the next order isn't set yet
      if (s.owner === team) return o - current;
    }
    return null;
  }
  // ---- Rankings: custom (commissioner CSV, when the draft uses them), then ADP, then name ----------
  // ctx = { custom: { id: rank } | null, adp: { id: number } }. Unranked players sort after ranked ones.
  var num = function (m, id) { return m && m[id] != null && isFinite(m[id]) ? Number(m[id]) : Infinity; };
  function byRanking(ctx) {
    return function (a, b) {
      return num(ctx.custom, a.id) - num(ctx.custom, b.id) || num(ctx.adp, a.id) - num(ctx.adp, b.id) ||
        String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    };
  }
  var POS_ORDER = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 6 };
  /** Pool sort: by "rank" (custom), "adp" (default), "name", "pos" or "team"; dir 1 or -1. Ties: the ranking. */
  function sortPool(players, by, dir, ctx) {
    var base = byRanking(ctx), d = dir === -1 ? -1 : 1;
    var key = {
      rank: function (a, b) { return num(ctx.custom, a.id) - num(ctx.custom, b.id); },
      adp: function (a, b) { return num(ctx.adp, a.id) - num(ctx.adp, b.id); },
      name: function (a, b) { return String(a.name).localeCompare(String(b.name)); },
      pos: function (a, b) { return (POS_ORDER[a.pos] || 9) - (POS_ORDER[b.pos] || 9); },
      team: function (a, b) { return String(a.nfl || "~").localeCompare(String(b.nfl || "~")); }
    }[by] || function () { return 0; };
    return players.slice().sort(function (a, b) {
      var k = key(a, b);
      if (k !== k || k === Infinity || k === -Infinity) k = 0;   // both unranked
      return (k ? k * d : 0) || base(a, b);
    });
  }
  /** Best available: the top undrafted player overall and per position. taken = { id: truthy }. */
  function bestAvailable(players, taken, ctx) {
    var out = { overall: null, byPos: {} };
    players.filter(function (p) { return !taken[p.id]; }).sort(byRanking(ctx)).forEach(function (p) {
      if (!out.overall) out.overall = p;
      if (!out.byPos[p.pos]) out.byPos[p.pos] = p;
    });
    return out;
  }
  /** "reach" (taken 12+ picks before his ADP), "steal" (12+ picks after), or null. */
  function value(overall, adp) {
    if (adp == null || !isFinite(adp) || overall == null) return null;
    if (adp - overall >= 12) return "reach";
    if (overall - adp >= 12) return "steal";
    return null;
  }
  /** Timer expiry / bots (the database does the same, private.draft_autopick_player): the top available
      player in the team's queue, else the best available by the ranking, except a 2nd K or DEF before
      round 14 (taken only when nothing else is left). opt = { round, has: { K: 1, DEF: 0, ... } }. */
  function autoPick(queue, players, taken, ctx, opt) {
    opt = opt || {};
    var q = (queue || []).slice().sort(function (a, b) { return a.rank - b.rank; });
    for (var i = 0; i < q.length; i++) if (q[i].player_id && !taken[q[i].player_id]) return { player_id: q[i].player_id, from: "queue" };
    var has = opt.has || {}, early = (opt.round || 1) < 14;
    var held = function (p) { return early && (p.pos === "K" || p.pos === "DEF") && has[p.pos] > 0; };
    var free = (players || []).filter(function (p) { return !taken[p.id]; }).sort(byRanking(ctx || {}));
    for (var j = 0; j < free.length; j++) if (!held(free[j])) return { player_id: free[j].id, from: "rank" };
    return free.length ? { player_id: free[0].id, from: "last" } : null;
  }
  /** The ADP map for a draft season: MFL's, else FFC's. rows = player_adp rows of that season. */
  function adpMap(rows) {
    var out = {};
    ["ffc", "mfl"].forEach(function (src) {
      (rows || []).forEach(function (r) { if (r.source === src) out[r.player_id] = { adp: Number(r.adp), posRank: r.pos_rank, source: src }; });
    });
    return out;
  }
  /** The ADP season a draft uses: its own, else the latest before it, else the latest there is. */
  function adpSeason(seasons, season) {
    var s = (seasons || []).map(Number).filter(isFinite).sort(function (a, b) { return b - a; });
    for (var i = 0; i < s.length; i++) if (s[i] <= season) return s[i];
    return s.length ? s[0] : null;
  }
  /** Values that appear more than once: { value: true } (the round order form marks them red). */
  function duplicates(list) {
    var seen = {}, dup = {};
    (list || []).forEach(function (x) { if (x == null || x === "") return; if (seen[x]) dup[x] = true; seen[x] = true; });
    return dup;
  }
  /** "1:23" from seconds. */
  function clock(sec) { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2); }
  /** Seconds left on the server's clock, given our clock's offset from the server's (ms). */
  function secondsLeft(endsAt, now, offsetMs) { return endsAt ? Math.max(0, (Date.parse(endsAt) - (now + (offsetMs || 0))) / 1000) : null; }
  /** Parse a rankings CSV: "rank,player" or "player,rank" with a header, or one player per line (rank = line).
      Players are matched by name (case/punctuation-insensitive, suffixes ignored) and position/team when given. */
  function parseRankings(text, players) {
    var norm = function (s) { return String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z0-9]/g, ""); };
    var byName = {};
    (players || []).forEach(function (p) { (byName[norm(p.name)] = byName[norm(p.name)] || []).push(p); });
    var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return { rows: [], missed: [] };
    var cells = function (l) { return l.split(",").map(function (c) { return c.replace(/^"|"$/g, "").trim(); }); };
    var head = cells(lines[0]).map(function (c) { return c.toLowerCase(); });
    var hasHead = head.some(function (c) { return /^(rank|player|name|pos|position|team|adp|overall)$/.test(c); });
    var col = function (names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) >= 0) return i; return -1; };
    var ri = hasHead ? col(["rank", "overall", "adp"]) : -1, ni = hasHead ? col(["player", "name"]) : 0, pi = hasHead ? col(["pos", "position"]) : -1, ti = hasHead ? col(["team", "nfl"]) : -1;
    var rows = [], missed = [], seen = {};
    lines.slice(hasHead ? 1 : 0).forEach(function (l, i) {
      var c = cells(l), name = c[ni < 0 ? 0 : ni], rank = ri >= 0 ? Number(c[ri]) : i + 1;
      var cands = (byName[norm(name)] || []).filter(function (p) {
        return (pi < 0 || !c[pi] || String(p.pos).toUpperCase() === c[pi].toUpperCase().replace(/\d+$/, "")) && (ti < 0 || !c[ti] || String(p.nfl).toUpperCase() === c[ti].toUpperCase());
      });
      if (cands.length !== 1 || !isFinite(rank)) { missed.push(name); return; }   // never guess between two players
      if (seen[cands[0].id]) return;
      seen[cands[0].id] = true;
      rows.push({ player_id: cands[0].id, rank: rank });
    });
    return { rows: rows, missed: missed };
  }

  root.B5DraftLogic = { roundOrder: roundOrder, missingOrders: missingOrders, validateOrder: validateOrder, position: position, ownerOf: ownerOf,
    slot: slot, board: board, pickGrid: pickGrid, currentOverall: currentOverall, picksAway: picksAway, autoPick: autoPick, clock: clock, secondsLeft: secondsLeft, parseRankings: parseRankings,
    duplicates: duplicates, byRanking: byRanking, sortPool: sortPool, bestAvailable: bestAvailable, value: value, adpMap: adpMap, adpSeason: adpSeason };
})(typeof globalThis !== "undefined" ? globalThis : this);
