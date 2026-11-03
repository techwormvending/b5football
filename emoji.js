/* Emoji for the Message Board, Chat and DMs (window.B5Emoji; standard Unicode emoji only, no images).
   - Every composer (.bd-ta textarea, and the edit boxes) gets a "😊 Emoji" button: a picker with big
     buttons and three tabs: Favorites, NFL Teams (the emoji with the team code under it) and Recently
     used (per user, this browser). Closes on a tap outside or Esc.
   - Typing ":" opens a shortcode autocomplete (:steelers: / :pit: -> ⚙️, :football: -> 🏈 ...);
     shortcodes left in the text convert to the emoji when the message is sent (submit, or Enter in chat).
   - Ravens 🐦‍⬛ is a newer emoji: where the device draws it as two symbols, the picker shows 🐦 and
     inserts "🐦 BAL" instead.
   - isEmojiOnly() lets the pages show emoji-only messages larger.
   Pure helpers (convert, matches, isEmojiOnly, teams) are tested in src/workers/emoji.test.ts. */
(function (root) {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  var FAVORITES = ["🏈", "💪", "🏆", "🥳", "🎉", "🎊", "🥇", "🥈", "🥉", "🔥", "😂", "💀", "👏", "🤘", "🗑️", "⚽", "🎽"];
  // [code, nickname, emoji] for all 32 teams
  var TEAMS = [["ARI", "cardinals", "🐦"], ["ATL", "falcons", "🪶"], ["BAL", "ravens", "🐦‍⬛"], ["BUF", "bills", "🦬"], ["CAR", "panthers", "🐾"], ["CHI", "bears", "🐻"],
    ["CIN", "bengals", "🐯"], ["CLE", "browns", "🟤"], ["DAL", "cowboys", "⭐"], ["DEN", "broncos", "🐴"], ["DET", "lions", "🦁"], ["GB", "packers", "🧀"],
    ["HOU", "texans", "🤘"], ["IND", "colts", "🐎"], ["JAX", "jaguars", "🐆"], ["KC", "chiefs", "🔥"], ["LV", "raiders", "⚔️"], ["LAC", "chargers", "⚡"],
    ["LAR", "rams", "🐏"], ["MIA", "dolphins", "🐬"], ["MIN", "vikings", "🇳🇴"], ["NE", "patriots", "🇺🇸"], ["NO", "saints", "⚜️"], ["NYG", "giants", "👑"],
    ["NYJ", "jets", "✈️"], ["PHI", "eagles", "🦅"], ["PIT", "steelers", "⚙️"], ["SF", "49ers", "⛏️"], ["SEA", "seahawks", "🌊"], ["TB", "buccaneers", "🏴‍☠️"],
    ["TEN", "titans", "🚢"], ["WAS", "commanders", "🎖️"]];
  var EXTRA = { football: "🏈", trophy: "🏆", flex: "💪", party: "🥳", tada: "🎉", confetti: "🎊", gold: "🥇", silver: "🥈", bronze: "🥉", fire: "🔥", joy: "😂",
    skull: "💀", clap: "👏", rock: "🤘", trash: "🗑️", soccer: "⚽", jersey: "🎽", thumbsup: "👍", niners: "⛏️", bucs: "🏴‍☠️" };
  /** Every shortcode -> emoji: team codes and nicknames, plus the extras. */
  var CODES = (function () {
    var m = {};
    TEAMS.forEach(function (t) { m[t[0].toLowerCase()] = t[2]; m[t[1]] = t[2]; });
    Object.keys(EXTRA).forEach(function (k) { m[k] = EXTRA[k]; });
    return m;
  })();
  var RAVENS = "🐦‍⬛";

  /** Replace :shortcode: with its emoji (case-insensitive); unknown ones stay as typed. */
  function convert(text, opt) {
    var ravensOk = !opt || opt.ravens !== false;
    return String(text == null ? "" : text).replace(/:([a-z0-9]{1,20}):/gi, function (all, k) {
      var e = CODES[k.toLowerCase()];
      if (!e) return all;
      return e === RAVENS && !ravensOk ? "🐦 BAL" : e;
    });
  }
  /** Autocomplete for ":pi" -> [{ code: "pit", emoji: "⚙️", label: "PIT" }, ...]: prefix matches, teams first, at most n. */
  function matches(prefix, n) {
    var p = String(prefix || "").toLowerCase(), out = [], seen = {};
    var add = function (code, emoji, label) { if (!seen[code] && code.indexOf(p) === 0) { seen[code] = true; out.push({ code: code, emoji: emoji, label: label }); } };
    TEAMS.forEach(function (t) { add(t[0].toLowerCase(), t[2], t[0]); add(t[1], t[2], t[0]); });
    Object.keys(EXTRA).forEach(function (k) { add(k, EXTRA[k], ""); });
    return out.slice(0, n || 8);
  }
  /** The ":xyz" being typed right before the caret (at the start or after a space), or null. */
  function typing(text, caret) {
    var m = /(^|\s):([a-z0-9]{0,20})$/i.exec(String(text).slice(0, caret));
    return m ? { from: caret - m[2].length - 1, prefix: m[2] } : null;
  }
  /** Only emoji (and spaces), 1-10 of them: shown larger. */
  var PICTO = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[\u{E0020}-\u{E007F}]|\s)+$/u;
  function isEmojiOnly(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t || !PICTO.test(t) || /\d/.test(t)) return false;
    var n = root.Intl && Intl.Segmenter ? Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(t.replace(/\s+/g, ""))).length : Array.from(t.replace(/\s+/g, "")).length;
    return n <= 10;
  }
  /** Does this device draw 🐦‍⬛ as one symbol? (canvas: a ZWJ sequence that isn't supported is about twice as wide) */
  var ravensCache = null;
  function ravensSupported() {
    if (ravensCache != null) return ravensCache;
    try {
      var c = root.document.createElement("canvas").getContext("2d");
      c.font = "32px sans-serif";
      ravensCache = c.measureText(RAVENS).width < c.measureText("🐦").width * 1.5;
    } catch (e) { ravensCache = true; }
    return ravensCache;
  }
  var teamEmoji = function (t) { return t[2] === RAVENS && !ravensSupported() ? "🐦" : t[2]; };
  var insertText = function (t) { return t[2] === RAVENS && !ravensSupported() ? "🐦 BAL" : t[2]; };

  // ---- Recently used (per user, this browser) ---------------------------------------------------
  var recentKey = function () { var v = root.B5Account && root.B5Account.viewer ? root.B5Account.viewer() : null; return "b5-emoji-recent:" + ((v && v.id) || "anon"); };
  function recent() { try { return JSON.parse(root.localStorage.getItem(recentKey()) || "[]").slice(0, 24); } catch (e) { return []; } }
  function remember(e) {
    try { var r = recent().filter(function (x) { return x !== e; }); r.unshift(e); root.localStorage.setItem(recentKey(), JSON.stringify(r.slice(0, 24))); } catch (err) { /* storage blocked */ }
  }

  // ---- The picker ---------------------------------------------------------------------------------
  var pk = { el: null, onPick: null, tab: "fav", anchor: null };
  function pickerHtml() {
    var tabs = [["fav", "Favorites"], ["nfl", "NFL Teams"], ["recent", "Recent"]];
    var body;
    if (pk.tab === "nfl") body = TEAMS.map(function (t) { return '<button type="button" class="em-b em-team" data-em="' + esc(insertText(t)) + '" aria-label="' + esc(t[0] + " " + t[1]) + '"><span class="em-e">' + teamEmoji(t) + '</span><span class="em-l">' + esc(t[0]) + "</span></button>"; }).join("");
    else {
      var list = pk.tab === "recent" ? recent() : FAVORITES;
      body = list.length ? list.map(function (e) { return '<button type="button" class="em-b" data-em="' + esc(e) + '"><span class="em-e">' + esc(e) + "</span></button>"; }).join("") : '<p class="muted">Nothing yet: the emoji you use show up here.</p>';
    }
    return '<div class="em-tabs" role="tablist">' + tabs.map(function (t) { return '<button type="button" role="tab" class="' + (pk.tab === t[0] ? "active" : "") + '" aria-selected="' + (pk.tab === t[0]) + '" data-em-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("") +
      '<button type="button" class="em-close" data-em-close aria-label="Close">✕ Close</button></div><div class="em-grid">' + body + "</div>";
  }
  function place() {
    var el = pk.el, a = pk.anchor; if (!el || !a) return;
    if (root.innerWidth <= 760) { el.style.left = "0px"; el.style.right = "0px"; el.style.top = ""; el.style.bottom = "0px"; el.classList.add("sheet"); return; }
    el.classList.remove("sheet");
    var r = a.getBoundingClientRect(), w = Math.min(420, root.innerWidth - 16), h = el.offsetHeight || 320;
    var left = Math.max(8, Math.min(r.left, root.innerWidth - w - 8));
    var top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(root.innerHeight - h - 8, r.bottom + 8);
    el.style.width = w + "px"; el.style.left = left + "px"; el.style.top = Math.max(8, top) + "px"; el.style.right = ""; el.style.bottom = "";
  }
  /** Open the picker next to `anchor`; onPick(emoji) gets the chosen one. */
  function open(anchor, onPick) {
    close();
    var d = root.document;
    pk.el = d.createElement("div"); pk.el.className = "em-picker"; pk.el.setAttribute("role", "dialog"); pk.el.setAttribute("aria-label", "Emoji");
    pk.onPick = onPick; pk.anchor = anchor;
    pk.el.innerHTML = pickerHtml();
    d.body.appendChild(pk.el);
    place();
    pk.el.addEventListener("click", function (e) {
      e.stopPropagation();   // tabs re-draw the picker: the clicked button is gone before the outside-tap check
      var t = e.target.closest("button"); if (!t) return;
      if (t.dataset.emTab) { pk.tab = t.dataset.emTab; pk.el.innerHTML = pickerHtml(); place(); return; }
      if (t.hasAttribute("data-em-close")) { close(); return; }
      if (t.dataset.em) { var e2 = t.dataset.em, cb = pk.onPick; remember(e2); close(); if (cb) cb(e2); }
    });
  }
  function close() { if (pk.el) { pk.el.remove(); pk.el = null; } }
  var isOpen = function () { return !!pk.el; };

  // ---- Composers: the button, the autocomplete, conversion on send --------------------------------
  var COMPOSER = ".bd-ta textarea, [data-bd-edit] textarea, [data-ch-edit] textarea, [data-dm-edit] textarea";
  function insertAt(ta, text) {
    var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart, e = ta.selectionEnd == null ? s : ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    var p = s + text.length; ta.focus(); try { ta.setSelectionRange(p, p); } catch (err) { /* not focusable */ }
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** One-row composers grow with the text up to about 4 lines, then scroll. */
  function grow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(116, ta.scrollHeight + 2) + "px"; }
  function addButtons(scope) {
    (scope || root.document).querySelectorAll(COMPOSER).forEach(function (ta) {
      var host = ta.closest(".bd-ta") || ta, row = host.parentNode && host.parentNode.classList && host.parentNode.classList.contains("ch-row") ? host.parentNode : null;
      var btn = '<button type="button" class="ch-icon em-open" aria-haspopup="dialog" aria-label="Emoji" title="Emoji">😊</button>';
      if (row) {   // one-row composer (Chat, Draft chat, DMs): an icon button right after the text box
        if (row.querySelector(".em-open")) return;
        host.insertAdjacentHTML("afterend", btn);
        return;
      }
      if (host.nextElementSibling && host.nextElementSibling.classList && host.nextElementSibling.classList.contains("em-bar")) return;
      var bar = root.document.createElement("div");
      bar.className = "em-bar";
      bar.innerHTML = btn;
      host.parentNode.insertBefore(bar, host.nextSibling);
    });
  }
  var ac = { el: null, ta: null, items: [], i: 0, from: 0 };
  function acClose() { if (ac.el) { ac.el.remove(); ac.el = null; } ac.ta = null; }
  function acShow(ta) {
    var t = typing(ta.value, ta.selectionStart);
    if (!t) { acClose(); return; }
    var items = matches(t.prefix, 8);
    if (!items.length) { acClose(); return; }
    ac.ta = ta; ac.items = items; ac.i = 0; ac.from = t.from;
    if (!ac.el) { ac.el = root.document.createElement("ul"); ac.el.className = "em-ac"; ac.el.setAttribute("role", "listbox"); root.document.body.appendChild(ac.el); }
    ac.el.innerHTML = items.map(function (x, i) {
      return '<li><button type="button" role="option" aria-selected="' + (i === 0) + '" class="' + (i === 0 ? "on" : "") + '" data-ac="' + i + '"><span class="em-e">' + x.emoji + "</span> :" + esc(x.code) + ":" + (x.label ? ' <span class="muted">' + esc(x.label) + "</span>" : "") + "</button></li>";
    }).join("");
    var r = ta.getBoundingClientRect(), h = ac.el.offsetHeight;
    ac.el.style.left = Math.max(8, Math.min(r.left, root.innerWidth - 300)) + "px";
    ac.el.style.top = (r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6) + "px";
  }
  function acPick(i) {
    var ta = ac.ta, x = ac.items[i]; if (!ta || !x) return;
    var end = ta.selectionStart, team = TEAMS.filter(function (t) { return t[2] === x.emoji; })[0];
    var text = (team ? insertText(team) : x.emoji) + " ";
    ta.setSelectionRange(ac.from, end);
    acClose(); remember(x.emoji);
    insertAt(ta, text);
  }
  function convertForm(form) {
    if (!form) return;
    form.querySelectorAll("textarea, input[name=title]").forEach(function (t) { var v = convert(t.value, { ravens: ravensSupported() }); if (v !== t.value) t.value = v; });
  }
  function mount() {
    var d = root.document; if (!d || mount.done) return;
    mount.done = true;
    addButtons(d);
    if (root.MutationObserver) new MutationObserver(function () { addButtons(d); }).observe(d.body, { childList: true, subtree: true });
    d.addEventListener("click", function (e) {
      var b = e.target.closest(".em-open");
      if (b) {
        var row = b.closest(".ch-row"), host = row ? row.querySelector(".bd-ta") : b.parentNode.previousElementSibling, ta = host && (host.matches("textarea") ? host : host.querySelector("textarea"));
        if (isOpen() && pk.anchor === b) { close(); return; }
        open(b, function (em) { if (ta) insertAt(ta, em); });
        return;
      }
      // narrow composers: 📷 and 🔗 live behind "+"
      var plus = e.target.closest("[data-plus]");
      if (plus) { var pr = plus.closest(".ch-row"), on = !pr.classList.contains("plus-open"); pr.classList.toggle("plus-open", on); plus.setAttribute("aria-expanded", on); return; }
      root.document.querySelectorAll(".ch-row.plus-open").forEach(function (r) { if (!r.querySelector(".ch-plus").contains(e.target)) { r.classList.remove("plus-open"); r.querySelector(".ch-plus").setAttribute("aria-expanded", "false"); } });
      var a = e.target.closest("[data-ac]"); if (a) { acPick(Number(a.dataset.ac)); return; }
      if (pk.el && !pk.el.contains(e.target)) close();
      if (ac.el && !ac.el.contains(e.target)) acClose();
    });
    d.addEventListener("input", function (e) {
      if (!e.target.matches) return;
      if (e.target.matches(COMPOSER)) acShow(e.target);
      if (e.target.matches(".ch-row textarea")) grow(e.target);
    });
    // Capture: before the pages' own handlers (send on submit, or on Enter in chat and DMs)
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { if (isOpen()) { var a = pk.anchor; close(); if (a) a.focus(); } acClose(); return; }
      if (ac.el && ac.ta === e.target) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); ac.i = (ac.i + (e.key === "ArrowDown" ? 1 : ac.items.length - 1)) % ac.items.length;
          ac.el.querySelectorAll("button").forEach(function (b, i) { b.classList.toggle("on", i === ac.i); b.setAttribute("aria-selected", i === ac.i); }); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); acPick(ac.i); return; }
      }
      if (e.key === "Enter" && e.target.matches && e.target.matches(COMPOSER)) convertForm(e.target.form);
    }, true);
    d.addEventListener("submit", function (e) { convertForm(e.target); }, true);
    root.addEventListener("resize", function () { place(); });
  }
  if (root.document && root.document.readyState !== "loading") setTimeout(mount, 0);
  else if (root.document) root.document.addEventListener("DOMContentLoaded", mount);

  root.B5Emoji = { FAVORITES: FAVORITES, TEAMS: TEAMS, CODES: CODES, convert: convert, matches: matches, typing: typing, isEmojiOnly: isEmojiOnly,
    open: open, close: close, mount: mount, recent: recent, remember: remember, ravensSupported: ravensSupported };
})(typeof globalThis !== "undefined" ? globalThis : this);
