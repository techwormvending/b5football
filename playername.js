/* PlayerName (window.B5Player): a player's name that opens his NFL team's remaining schedule.

   B5Player.html({ id, name, pos, nfl, status }, { focusable }) is the one way pages render a player
   name that offers the schedule. One pop-up per page, driven by delegated listeners on the document:
   - mouse: opens 300 ms after the pointer rests on a name, closes when it leaves both the name and the
     pop-up (a short grace lets the pointer cross the gap);
   - touch / pen (no hover): a tap on the name opens it (only the name: the rest of the row, e.g. the Add
     button, works as before); a tap outside or the ✕ closes it;
   - keyboard: focusing a name opens it, Esc closes it (focus returns to the name), Tab moves on.
   Names inside a button (lineup rows) are rendered without tabindex: they open by hover and tap only,
   since a focusable element can't sit inside a button.

   Data, loaded once per page on the first open and cached: the season's NFL schedule (nfl_games, week,
   teams, kickoff) and public.points_allowed(season) for the matchup colors. Nothing is fetched per
   hover. Schedule rows are this week through week 17 (our season ends there): BYE highlighted (or
   "Bye: done, week 7" once it's passed), fantasy playoff weeks 15–17 marked, kickoff in ET.
   Matchup color per opponent: by fantasy points that opponent allows to this position per game this
   season, ranked among the 32 teams: top third green (allows the most), bottom third red.

   Pure helpers (remainingSchedule, matchupGrades, place, createController) are exported for tests. */
(function (root) {
  "use strict";
  var LAST_WEEK = 17, PLAYOFFS = [15, 16, 17], OPEN_MS = 300, CLOSE_MS = 150;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };
  var TAGS = { IR: "IR", PUP: "PUP", Suspended: "SUSP", Reserve: "RES", Out: "OUT", Doubtful: "D", Questionable: "Q" };
  var BAD = { IR: 1, PUP: 1, Suspended: 1, Reserve: 1, Out: 1 };

  /** The name as markup. p: { id, name, pos, nfl, status }; opts.focusable false inside buttons. */
  function html(p, opts) {
    var focusable = !opts || opts.focusable !== false;
    if (!p || !p.name) return "";
    var nfl = p.nfl || p.nfl_team || "";
    return '<span class="pn" data-pn-id="' + esc(p.id || "") + '" data-pn-name="' + esc(p.name) + '" data-pn-pos="' + esc(p.pos || "") +
      '" data-pn-nfl="' + esc(nfl) + '" data-pn-status="' + esc(p.status || "") + '"' + (focusable ? ' tabindex="0"' : "") +
      ' aria-haspopup="dialog">' + esc(p.name) + "</span>";
  }

  // ---- Pure helpers --------------------------------------------------------------
  var fmt = function (iso) {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  /** The week that's current: the first week whose last kickoff was under 5 h ago (as My Team). */
  function currentWeek(games, now) {
    var last = {};
    games.forEach(function (g) { var t = Date.parse(g.kickoff); if (!(last[g.week] > t)) last[g.week] = t; });
    var weeks = Object.keys(last).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < weeks.length; i++) if (last[weeks[i]] + 5 * 3600e3 > now) return weeks[i];
    return weeks.length ? weeks[weeks.length - 1] + 1 : 1;
  }
  /** His team's weeks from `from` to 17: [{week, bye, opp, home, kickoff, playoff}], plus the bye week if
      it has already passed (byeDone). A week counts as a bye only when that week has games. */
  function remainingSchedule(games, team, from, last) {
    last = last || LAST_WEEK;
    var weeks = {}, mine = {};
    games.forEach(function (g) {
      weeks[g.week] = true;
      if (g.home === team || g.away === team) mine[g.week] = g;
    });
    var rows = [], byeDone = null;
    for (var w = 1; w <= last; w++) {
      if (!weeks[w]) continue;
      var g = mine[w];
      if (w < from) { if (!g) byeDone = w; continue; }
      rows.push(g ? { week: w, bye: false, home: g.home === team, opp: g.home === team ? g.away : g.home, kickoff: g.kickoff, playoff: PLAYOFFS.indexOf(w) >= 0 }
        : { week: w, bye: true, playoff: PLAYOFFS.indexOf(w) >= 0 });
    }
    return { rows: rows, byeDone: byeDone };
  }
  /** pos -> team -> "good" | "ok" | "bad" by points allowed per game, ranked in thirds. */
  function matchupGrades(allowed) {
    var by = {}, out = {};
    (allowed || []).forEach(function (r) { (by[r.pos] = by[r.pos] || []).push(r); });
    Object.keys(by).forEach(function (pos) {
      var list = by[pos].slice().sort(function (a, b) { return Number(b.avg) - Number(a.avg); }), n = list.length;
      out[pos] = {};
      list.forEach(function (r, i) { out[pos][r.team] = n < 3 ? "ok" : i < Math.ceil(n / 3) ? "good" : i >= n - Math.ceil(n / 3) ? "bad" : "ok"; });
    });
    return out;
  }
  /** Where the pop-up goes: below the name, else above, else the side with more room (then it scrolls);
      always inside the viewport with an 8 px margin. Returns {left, top, width, maxHeight, above}. */
  function place(rect, popH, vw, vh) {
    var m = 8, width = Math.min(340, vw - 2 * m);
    var left = Math.max(m, Math.min(rect.left, vw - width - m));
    var below = vh - rect.bottom - m - 4, above = rect.top - m - 4;
    if (popH <= below) return { left: left, top: rect.bottom + 4, width: width, maxHeight: below, above: false };
    if (popH <= above) return { left: left, top: rect.top - 4 - popH, width: width, maxHeight: above, above: true };
    return below >= above ? { left: left, top: rect.bottom + 4, width: width, maxHeight: below, above: false }
      : { left: left, top: m, width: width, maxHeight: above, above: true };
  }
  /** Open/close rules, separate from the DOM (tested). io: { open(el), close(), setTimeout, clearTimeout }. */
  function createController(io) {
    var s = { open: null, timer: null };
    var clear = function () { if (s.timer) { io.clearTimeout(s.timer); s.timer = null; } };
    var show = function (el) { clear(); if (s.open !== el) { s.open = el; io.open(el); } };
    var hide = function () { clear(); if (s.open) { s.open = null; io.close(); } };
    return {
      state: function () { return s.open; },
      hoverName: function (el) { clear(); if (s.open !== el) s.timer = io.setTimeout(function () { s.timer = null; show(el); }, OPEN_MS); },
      leaveName: function () { clear(); if (s.open) s.timer = io.setTimeout(function () { s.timer = null; hide(); }, CLOSE_MS); else clear(); },
      hoverPopup: function () { clear(); },
      leavePopup: function () { clear(); s.timer = io.setTimeout(function () { s.timer = null; hide(); }, CLOSE_MS); },
      tapName: function (el) { if (s.open === el) hide(); else show(el); },
      tapOutside: function () { hide(); },
      focusName: function (el) { show(el); },
      blur: function () { hide(); },
      escape: function () { var el = s.open; hide(); return el; },
      close: hide
    };
  }

  // ---- Data (one load per page) -------------------------------------------------------
  var dataP = null;
  function load() {
    var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth, season = Number(L.season);
    if (dataP) return dataP;
    if (!(cfg && cfg.configured && A)) return Promise.resolve({ games: [], grades: {} });
    var f = function (u, i) { return root.fetch(u, i); };
    dataP = Promise.all([
      A.api(cfg, null, "nfl_games?season=eq." + season + "&select=week,home,away,kickoff&order=kickoff&limit=1000", {}, f),
      A.api(cfg, null, "rpc/points_allowed", { method: "POST", body: JSON.stringify({ p_season: season }) }, f)
    ]).then(function (r) {
      if (!r[0].ok) { dataP = null; throw new Error(r[0].error || "schedule unavailable"); }
      return { games: r[0].data || [], grades: matchupGrades(r[1].ok ? r[1].data : []), cache: {} };
    });
    return dataP;
  }

  // ---- Rendering ----------------------------------------------------------------
  var GRADE = { good: "Good matchup", ok: "Average matchup", bad: "Tough matchup" };
  function bodyHtml(p, d, now) {
    var key = p.nfl + "|" + p.pos;
    var cur = currentWeek(d.games, now);
    if (!d.cache[key]) d.cache[key] = remainingSchedule(d.games, p.nfl, cur);   // cached per team (+ position for colors)
    var s = d.cache[key], grades = (d.grades || {})[p.pos] || {};
    var tag = TAGS[p.status] ? '<span class="pn-tag' + (BAD[p.status] ? " bad" : "") + '">' + esc(TAGS[p.status]) + "</span>" : "";
    var head = '<div class="pn-head"><b>' + esc(p.name) + "</b> " + tag + '<span class="muted small">' + esc([p.pos, p.nfl].filter(Boolean).join(" · ")) + "</span>" +
      '<button type="button" class="pn-x" data-pn-close aria-label="Close">✕</button></div>';
    if (!p.nfl || /^FA$/i.test(p.nfl)) return head + '<p class="muted small">Not on an NFL team.</p>';
    var rows = s.rows.map(function (r) {
      var cls = (r.bye ? " bye" : "") + (r.playoff ? " po" : "") + (r.week === cur ? " now" : "");
      if (r.bye) return '<li class="pn-row' + cls + '"><span class="pn-wk">' + r.week + '</span><b class="pn-bye">BYE</b>' + (r.playoff ? '<span class="pn-po">Playoffs</span>' : "") + "</li>";
      var gr = grades[r.opp];
      return '<li class="pn-row' + cls + '"><span class="pn-wk">' + r.week + "</span>" +
        '<span class="pn-opp">' + (gr ? '<i class="pn-dot ' + gr + '" title="' + esc(GRADE[gr]) + '" aria-label="' + esc(GRADE[gr]) + '"></i>' : "") + esc((r.home ? "vs " : "@ ") + r.opp) + "</span>" +
        '<span class="pn-ko">' + esc(fmt(r.kickoff)) + "</span>" + (r.playoff ? '<span class="pn-po">Playoffs</span>' : "") + "</li>";
    }).join("");
    var legend = Object.keys(grades).length ? '<p class="pn-legend small muted"><i class="pn-dot good"></i>good <i class="pn-dot ok"></i>average <i class="pn-dot bad"></i>tough ' +
      "matchup (fantasy points the opponent allows to " + esc(p.pos) + "s this season)</p>" : "";
    return head + (s.byeDone ? '<p class="small muted pn-byedone">Bye: done, week ' + esc(s.byeDone) + "</p>" : "") +
      (rows ? '<ul class="pn-list">' + rows + "</ul>" : '<p class="muted small">No games left on the schedule.</p>') +
      '<p class="small muted">Weeks ' + esc(cur) + "–" + LAST_WEEK + " · times ET · fantasy playoffs weeks 15–17</p>" + legend;
  }

  // ---- DOM wiring (one pop-up, delegated listeners) ------------------------------------
  var pop = null, anchor = null, lastPointer = "mouse", ctl = null;
  function popup() {
    if (pop) return pop;
    pop = root.document.createElement("div");
    pop.id = "pnPop"; pop.className = "pn-pop"; pop.setAttribute("role", "dialog"); pop.hidden = true;
    root.document.body.appendChild(pop);
    pop.addEventListener("pointerenter", function () { ctl.hoverPopup(); });
    pop.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") ctl.leavePopup(); });
    pop.addEventListener("click", function (e) { if (e.target.closest("[data-pn-close]")) { var el = ctl.escape(); if (el && el.focus && el.tabIndex >= 0) el.focus(); } });
    return pop;
  }
  function info(el) { return { id: el.dataset.pnId, name: el.dataset.pnName, pos: el.dataset.pnPos, nfl: el.dataset.pnNfl, status: el.dataset.pnStatus }; }
  function position() {
    if (!pop || !anchor) return;
    var r = anchor.getBoundingClientRect(), vw = root.innerWidth, vh = root.innerHeight;
    pop.style.width = Math.min(340, vw - 16) + "px"; pop.style.maxHeight = ""; pop.style.left = "0px"; pop.style.top = "0px";
    var at = place(r, pop.offsetHeight, vw, vh);
    pop.style.left = at.left + "px"; pop.style.top = at.top + "px"; pop.style.maxHeight = at.maxHeight + "px";
    pop.classList.toggle("above", at.above);
  }
  function openFor(el) {
    var p = info(el), P = popup();
    if (anchor && anchor !== el) anchor.removeAttribute("aria-describedby");
    anchor = el; el.setAttribute("aria-describedby", "pnPop"); el.setAttribute("aria-expanded", "true");
    P.setAttribute("aria-label", p.name + ": schedule");
    P.innerHTML = '<div class="pn-head"><b>' + esc(p.name) + '</b></div><p class="muted small">Loading schedule…</p>';
    P.hidden = false; position();
    load().then(function (d) { if (anchor === el && !P.hidden) { P.innerHTML = bodyHtml(p, d, Date.now()); position(); } },
      function () { if (anchor === el) { P.innerHTML = '<div class="pn-head"><b>' + esc(p.name) + '</b><button type="button" class="pn-x" data-pn-close aria-label="Close">✕</button></div><p class="small acct-msg err">Couldn\'t load the schedule.</p>'; position(); } });
  }
  function closeIt() {
    if (pop) pop.hidden = true;
    if (anchor) { anchor.removeAttribute("aria-describedby"); anchor.setAttribute("aria-expanded", "false"); }
    anchor = null;
  }
  function wire() {
    var d = root.document;
    if (!d || !d.addEventListener || ctl) return;
    ctl = createController({ open: openFor, close: closeIt, setTimeout: function (fn, ms) { return root.setTimeout(fn, ms); }, clearTimeout: function (t) { root.clearTimeout(t); } });
    var nameOf = function (t) { return t && t.closest ? t.closest(".pn") : null; };
    d.addEventListener("pointerdown", function (e) {
      lastPointer = e.pointerType || "mouse";
      if (lastPointer !== "mouse" && ctl.state() && !nameOf(e.target) && !(pop && pop.contains(e.target))) ctl.tapOutside();
    }, true);
    d.addEventListener("pointerover", function (e) { if (e.pointerType === "mouse") { var el = nameOf(e.target); if (el) ctl.hoverName(el); } });
    d.addEventListener("pointerout", function (e) {
      if (e.pointerType !== "mouse") return;
      var el = nameOf(e.target);
      if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) ctl.leaveName();
    });
    // Touch / pen: the tap opens the pop-up and does nothing else (not the row's own action).
    d.addEventListener("click", function (e) {
      var el = nameOf(e.target);
      if (el && lastPointer !== "mouse") { e.preventDefault(); e.stopPropagation(); ctl.tapName(el); }
    }, true);
    d.addEventListener("focusin", function (e) {
      var el = nameOf(e.target);
      if (el && el.tabIndex >= 0 && lastPointer === "mouse") ctl.focusName(el);
      else if (ctl.state() && !el && !(pop && pop.contains(e.target))) ctl.blur();
    });
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && ctl.state()) { var el = ctl.escape(); if (el && el.focus && el.tabIndex >= 0) el.focus(); lastPointer = "key"; }
      else if (e.key === "Tab" || e.key.length === 1 || /^Arrow/.test(e.key)) lastPointer = "mouse";   // keyboard focus behaves like the mouse case
    });
    root.addEventListener("hashchange", function () { ctl.close(); });
    root.addEventListener("resize", position);
    root.addEventListener("scroll", function () { if (ctl.state() && lastPointer === "mouse") position(); }, true);
  }
  if (root.document && root.document.readyState !== "loading") wire();
  else if (root.document) root.document.addEventListener("DOMContentLoaded", wire);

  root.B5Player = { html: html, remainingSchedule: remainingSchedule, matchupGrades: matchupGrades, place: place, createController: createController,
    currentWeek: currentWeek, bodyHtml: bodyHtml, _reset: function () { dataP = null; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
