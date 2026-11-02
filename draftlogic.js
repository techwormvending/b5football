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
  /** Timer expiry / bots: the top available player in the queue, else the best available by rank,
      else the first available player by name. taken = { player_id: true }. */
  function autoPick(queue, rankings, pool, taken) {
    var free = function (id) { return id && !taken[id]; };
    var q = (queue || []).slice().sort(function (a, b) { return a.rank - b.rank; });
    for (var i = 0; i < q.length; i++) if (free(q[i].player_id)) return { player_id: q[i].player_id, from: "queue" };
    var r = (rankings || []).slice().sort(function (a, b) { return a.rank - b.rank; });
    for (var j = 0; j < r.length; j++) if (free(r[j].player_id)) return { player_id: r[j].player_id, from: "rank" };
    var p = (pool || []).slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    for (var k = 0; k < p.length; k++) if (free(p[k].id)) return { player_id: p[k].id, from: "pool" };
    return null;
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
    slot: slot, board: board, currentOverall: currentOverall, picksAway: picksAway, autoPick: autoPick, clock: clock, secondsLeft: secondsLeft, parseRankings: parseRankings };
})(typeof globalThis !== "undefined" ? globalThis : this);
