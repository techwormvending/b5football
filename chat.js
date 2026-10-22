/* Chat (#chat, #chat/<room>, #chat/draft/tv): live rooms for league members, separate from the
   Message Board. The database refuses everyone else (RLS; see migration chat); signed-out visitors
   get "Sign in to chat".
   Rooms: "League" and "Draft" always; the commissioner adds or archives others. Messages arrive
   instantly over Supabase Realtime (one private channel "b5-chat" per page: postgres_changes on the
   chat tables + presence (who's online) + broadcast (typing)). History: the last 100, then 100 more
   when you scroll to the top; newest at the bottom; a jump-to-latest button when you're scrolled up.
   Text with the board's light formatting (B5Board.formatBody: escaped first, never HTML),
   images (the board's bucket, limits and signed links: B5Board.media), reactions, @mentions
   (highlighted when they're you), edit/delete your own; the commissioner deletes, pins, mutes,
   clears and manages rooms (audited by the database).
   Draft room: a pinned header with the pick on the clock and time left (draft_state), B5 Bot
   messages from public.draft_event. Big-screen mode (#chat/draft/tv, or B5Chat.mount(el,
   { room: "draft", tv: true }) beside the draft board): read-only, large type. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var B = function () { return root.B5Board; };
  var EMOJI = ["👍", "😂", "🔥", "💀", "🗑️"], PAGE = 100;
  var TL = function () { return root.B5Team; };   // team names, logos and profile links (teamlink.js)
  var logo = function (team, bot, title) {
    var tt = title ? ' title="' + esc(title) + '"' : "";
    if (bot) return '<div class="logo sm bd-bot"' + tt + ">B5</div>";
    if (!team || !TL().has(team)) return '<div class="logo sm"' + tt + ">?</div>";
    return title ? '<span class="ch-logo"' + tt + ">" + TL().logo(team) + "</span>" : TL().logo(team);
  };
  var time = function (iso) { return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }); };
  var day = function (iso) { return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }); };

  // ---- Pure helpers (tested in src/workers/chat-page.test.ts) --------------------------------
  /** m:ss */
  function fmtClock(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }
  /** The Draft room's pinned header from draft_state. */
  function draftHeader(s, now) {
    if (!s || s.status === "idle" || !s.status) return { status: "idle", title: "Draft room", sub: "Talk draft prep here. During the draft, picks and the clock show up here." };
    if (s.status === "done") return { status: "done", title: "The draft is complete", sub: "" };
    var has = TL() && TL().has(s.team_id), name = has ? TL().name(s.team_id) : s.team_id || "?", where = "Round " + s.round + ", Pick " + s.pick;
    var link = has ? TL().link(s.team_id, { logo: false }) : esc(name);   // titleHtml: the same title with the team's TeamLink
    if (s.status === "paused") return { status: "paused", title: "⏸️ Paused: " + name + " on the clock", titleHtml: "⏸️ Paused: " + link + " on the clock", sub: where + " · " + fmtClock(s.paused_remaining || 0) + " left when it resumes", seconds: s.paused_remaining, team: s.team_id };
    var left = s.clock_ends_at ? (Date.parse(s.clock_ends_at) - now) / 1000 : null;
    return { status: "live", title: "On the clock: " + name, titleHtml: "On the clock: " + link, sub: where + (left != null ? " · " + fmtClock(left) + " left" : ""), seconds: left, team: s.team_id };
  }
  /** "Mike is typing…", "Mike and Bob are typing…", "3 people are typing…" */
  function typingText(names) {
    return !names.length ? "" : names.length === 1 ? names[0] + " is typing…" : names.length === 2 ? names[0] + " and " + names[1] + " are typing…" : names.length + " people are typing…";
  }
  /** Online members from presence (one per user, most recent meta), you first. */
  function onlineList(presence, me) {
    return presence.map(function (p) { var m = p.metas[p.metas.length - 1] || {}; return { user: p.key, name: m.name || "", team: m.team || null }; })
      .filter(function (p) { return p.user; })
      .sort(function (a, b) { return (b.user === me) - (a.user === me) || a.name.localeCompare(b.name); });
  }
  /** Add/replace messages by id, keeping them in id order. */
  function mergeMessages(list, incoming) {
    var byId = {};
    list.concat(incoming).forEach(function (m) { byId[m.id] = m; });
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return a.id - b.id; });
  }
  /** Does this text @mention you (by your team or your name)? */
  function mentionsMe(body, labels) {
    var s = String(body || "").toLowerCase();
    return labels.some(function (l) { return l && s.indexOf("@" + l.toLowerCase()) >= 0; });
  }
  /** Same person, within 5 minutes: show the message without repeating the name. */
  function continues(prev, m) {
    return !!(prev && !m.is_bot && !prev.is_bot && prev.author_id === m.author_id && Date.parse(m.created_at) - Date.parse(prev.created_at) < 300000);
  }

  // ---- State ----------------------------------------------------------------------------------
  var st = { me: null, el: null, room: "league", rooms: [], msgs: [], hasMore: false, loadingOld: false, reactions: {}, signed: {}, people: {},
    online: [], typing: {}, draft: null, unread: {}, editing: null, menu: null, compose: { images: [], busy: false, err: null }, mute: null,
    tv: false, readOnly: false, atBottom: true, newBelow: 0, tick: null, lastTyping: 0, readTimer: null };
  var rt = { sub: null, user: null };
  var session = function () { return st.me && st.me.session; };
  var myId = function () { return session() ? session().user.id : null; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var isMember = function () { return !!(st.me && (isCommish() || (st.me.teams && st.me.teams.length))); };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var ok = function (x) { return x && x.ok ? x.data || [] : []; };
  var friendly = function (e) {
    e = String(e || "");
    return /Slow down/.test(e) ? "Slow down: 20 messages per 10 seconds." : /muted/.test(e) ? e : /closed/.test(e) ? "This room is closed." : /Images must/.test(e) ? "Images must be https links or uploads (up to 4)." : /check constraint/.test(e) ? "Write something (or add an image) first." : e;
  };
  var me = function () { return st.people[myId()] || { name: "", team: null }; };
  /** Author line (HTML): "Mike · <TeamLink>", or the TeamLink alone, or "B5 Bot". */
  var byHtml = function (m) {
    if (m.is_bot) return "B5 Bot";
    var p = st.people[m.author_id], has = m.author_team && TL().has(m.author_team);
    if (p && p.name) return esc(p.name) + (has ? ' <span class="ch-team">· ' + TL().link(m.author_team, { logo: false }) + "</span>" : "");
    return has ? TL().link(m.author_team, { logo: false }) : "Former member";
  };
  var myLabels = function () { var p = me(); return [p.name, p.team && TL().has(p.team) ? TL().name(p.team) : null].filter(Boolean); };
  var mentionCtx = function () {
    var list = [], mine = myId();
    Object.keys(st.people).forEach(function (u) {
      var p = st.people[u];
      if (p.team && TL().has(p.team)) list.push({ label: TL().name(p.team), me: u === mine, href: TL().href(p.team) });
      if (p.name) list.push({ label: p.name, me: u === mine });
    });
    return { mentions: list.sort(function (a, b) { return b.label.length - a.label.length; }) };
  };

  // ---- Data -------------------------------------------------------------------------------------
  function loadPeople() {
    return api("team_managers?select=team_id,user_id,profiles(display_name)").then(function (r) {
      st.people = {};
      ok(r).forEach(function (x) { st.people[x.user_id] = { name: (x.profiles && x.profiles.display_name) || "", team: x.team_id }; });
    });
  }
  function loadRooms() {
    return Promise.all([
      api("chat_rooms?select=id,name,kind,sort,archived,pinned_message_id&order=sort,name"),
      api("draft_state?select=*"),
      api("chat_mutes?user_id=eq." + myId() + "&select=until")
    ]).then(function (r) {
      st.rooms = ok(r[0]).filter(function (x) { return !x.archived || x.id === st.room; });
      st.draft = ok(r[1])[0] || null;
      var m = ok(r[2])[0]; st.mute = m && Date.parse(m.until) > Date.now() ? m.until : null;
    });
  }
  function signFor(list) {
    var paths = [];
    list.forEach(function (m) { (m.images || []).forEach(function (u) { if (/^storage:/.test(u) && !st.signed[u.slice(8)]) paths.push(u.slice(8)); }); });
    if (!paths.length || !B()) return Promise.resolve();
    return B().media.sign(paths, session()).then(function (map) { Object.keys(map).forEach(function (k) { st.signed[k] = map[k]; }); });
  }
  function loadReactions(ids) {
    if (!ids.length) return Promise.resolve();
    return api("chat_reactions?message_id=in.(" + ids.join(",") + ")&select=message_id,user_id,emoji").then(function (r) {
      ids.forEach(function (id) { st.reactions[id] = []; });
      ok(r).forEach(function (x) { (st.reactions[x.message_id] = st.reactions[x.message_id] || []).push(x); });
    });
  }
  function loadHistory(before) {
    var q = "chat_messages?room_id=eq." + encodeURIComponent(st.room) + (before ? "&id=lt." + before : "") + "&select=*&order=id.desc&limit=" + PAGE;
    return api(q).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      var got = (r.data || []).slice().reverse();
      st.hasMore = (r.data || []).length === PAGE;
      st.msgs = before ? mergeMessages(got, st.msgs) : got;
      return Promise.all([signFor(got), loadReactions(got.map(function (m) { return m.id; }))]);
    });
  }
  function markRead() {
    clearTimeout(st.readTimer);
    st.readTimer = setTimeout(function () {
      if (!st.el || st.readOnly || !isMember()) return;
      api("chat_reads?on_conflict=user_id,room_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ room_id: st.room, read_at: new Date().toISOString() }) }).then(function () { badge(); });
    }, 800);
  }

  // ---- Render -----------------------------------------------------------------------------------
  function imagesHtml(list) {
    if (!list || !list.length) return "";
    return '<div class="ch-imgs">' + list.map(function (u) {
      var src = /^storage:/.test(u) ? st.signed[u.slice(8)] : /^https:\/\//.test(u) ? u : null;
      return src ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(src) + '" alt="" decoding="async" referrerpolicy="no-referrer"></a>' : "";
    }).join("") + "</div>";
  }
  function messageHtml(m, prev, ctx, labels) {
    var mine = m.author_id === myId() && !m.is_bot, cont = continues(prev, m), dayBreak = !prev || day(prev.created_at) !== day(m.created_at);
    var reacts = st.reactions[m.id] || [], byEmoji = {};
    reacts.forEach(function (r) { (byEmoji[r.emoji] = byEmoji[r.emoji] || []).push(r.user_id); });
    var chips = EMOJI.filter(function (e) { return byEmoji[e]; }).map(function (e) {
      var mineR = byEmoji[e].indexOf(myId()) >= 0;
      return '<button type="button" class="ch-chip' + (mineR ? " mine" : "") + '" data-ch="react" data-id="' + m.id + '" data-emoji="' + esc(e) + '"' + (st.readOnly ? " disabled" : "") +
        ' title="' + esc(byEmoji[e].map(function (u) { return (st.people[u] || {}).name || "?"; }).join(", ")) + '">' + e + " " + byEmoji[e].length + "</button>";
    }).join("");
    var open = st.menu === m.id && !st.readOnly, editing = st.editing === m.id;
    var body = editing
      ? '<form data-ch-edit="' + m.id + '"><textarea name="body" rows="2" maxlength="2000">' + esc(m.body) + '</textarea><div class="ch-tools"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-ch="cancel-edit">Cancel</button></div></form>'
      : (m.body ? '<div class="ch-body">' + (B() ? B().formatBody(m.body, ctx) : esc(m.body)) + "</div>" : "") + imagesHtml(m.images);
    var acts = open ? '<div class="ch-acts">' + EMOJI.map(function (e) { return '<button type="button" data-ch="react" data-id="' + m.id + '" data-emoji="' + esc(e) + '">' + e + "</button>"; }).join("") +
      (mine ? '<button type="button" data-ch="edit" data-id="' + m.id + '">Edit</button>' : "") +
      (mine || isCommish() ? '<button type="button" data-ch="del" data-id="' + m.id + '">Delete</button>' : "") +
      (isCommish() ? '<button type="button" data-ch="pin" data-id="' + m.id + '">Pin</button>' : "") +
      (isCommish() && !mine && m.author_id ? '<button type="button" data-ch="mute" data-user="' + esc(m.author_id) + '">Mute</button>' : "") + "</div>" : "";
    return (dayBreak ? '<div class="ch-day">' + esc(day(m.created_at)) + "</div>" : "") +
      '<div class="ch-msg' + (cont && !dayBreak ? " cont" : "") + (m.is_bot ? " bot" : "") + (mine ? " mine" : "") + (!mine && mentionsMe(m.body, labels) ? " at-me" : "") + '" data-ch-msg="' + m.id + '">' +
      (cont && !dayBreak ? '<div class="ch-gut"></div>' : '<div class="ch-gut">' + logo(m.author_team, m.is_bot) + "</div>") +
      '<div class="ch-main">' + (cont && !dayBreak ? "" : '<div class="ch-by"><b>' + byHtml(m) + '</b> <span class="muted">' + esc(time(m.created_at)) + "</span></div>") +
      body + (m.edited_at ? '<span class="muted ch-edited">edited</span>' : "") + (chips ? '<div class="ch-chips">' + chips + "</div>" : "") + acts + "</div></div>";
  }
  function logHtml() {
    var ctx = mentionCtx(), labels = myLabels();
    return (st.hasMore ? '<div class="ch-more muted small">Scroll up for older messages</div>' : st.msgs.length ? '<div class="ch-more muted small">Start of the room</div>' : "") +
      st.msgs.map(function (m, i) { return messageHtml(m, st.msgs[i - 1], ctx, labels); }).join("") +
      (!st.msgs.length ? '<p class="muted ch-empty">No messages yet. Say something!</p>' : "");
  }
  function pinHtml() {
    var room = st.rooms.filter(function (r) { return r.id === st.room; })[0] || {};
    var out = "";
    if (room.kind === "draft" || st.room === "draft") {
      var h = draftHeader(st.draft, Date.now());
      out += '<div class="ch-draft ' + esc(h.status) + '">' + (h.team ? logo(h.team) : "") + '<div><b data-ch-clock-title>' + (h.titleHtml || esc(h.title)) + '</b><span data-ch-clock>' + esc(h.sub) + "</span></div>" +
        (h.status === "live" && h.seconds != null && h.seconds <= 30 ? '<span class="tag ch-hurry">Hurry</span>' : "") + "</div>";
    }
    var pm = room.pinned_message_id && st.msgs.filter(function (m) { return m.id === room.pinned_message_id; })[0];
    if (room.pinned_message_id) {
      out += '<div class="ch-pinned">📌 ' + (pm ? "<b>" + byHtml(pm) + ":</b> " + (B() ? B().formatBody(pm.body.slice(0, 200), mentionCtx()) : esc(pm.body)) : "Pinned message") +
        (isCommish() && !st.readOnly ? ' <button type="button" class="linkish" data-ch="unpin">Unpin</button>' : "") + "</div>";
    }
    return out;
  }
  function onlineHtml() {
    var list = st.online;
    if (!list.length) return "";
    return '<div class="ch-online" aria-label="Online now">' + list.slice(0, 14).map(function (p) { return logo(p.team, false, p.name + " (online)"); }).join("") +
      '<span class="muted small">' + list.length + " online</span></div>";
  }
  function roomsHtml() {
    return '<div class="ch-rooms" role="tablist">' + st.rooms.map(function (r) {
      var n = st.unread[r.id] || 0;
      return '<a class="wk' + (r.id === st.room ? " active" : "") + '" href="#chat/' + esc(r.id) + '" role="tab">' + esc(r.name) + (n && r.id !== st.room ? ' <span class="nav-badge">' + (n > 99 ? "99+" : n) + "</span>" : "") + "</a>";
    }).join("") + (isCommish() && !st.tv ? '<button type="button" class="wk ch-room-menu" data-ch="room-menu" aria-label="Room settings">⚙</button>' : "") + "</div>";
  }
  function composeHtml() {
    var c = st.compose;
    if (st.readOnly) return "";
    var room = st.rooms.filter(function (r) { return r.id === st.room; })[0] || {};
    if (room.archived) return '<div class="ch-compose muted small">This room is closed.</div>';
    if (st.mute) return '<div class="ch-compose muted small">You\'re muted until ' + esc(time(st.mute)) + ".</div>";
    return '<form class="ch-compose" data-ch-compose>' +
      '<div class="bd-thumbs">' + c.images.map(function (im, i) { return '<span class="bd-thumb"><img src="' + esc(im.preview) + '" alt=""><button type="button" data-ch="unimg" data-i="' + i + '" aria-label="Remove image">×</button></span>'; }).join("") + "</div>" +
      '<div class="ch-row"><label class="ch-icon" aria-label="Add a photo or GIF">📷<input type="file" accept="image/*" data-ch="file" hidden></label>' +
      '<button type="button" class="ch-icon" data-ch="link" aria-label="Add an image link">🔗</button>' +
      '<div class="bd-ta"><textarea name="body" rows="1" maxlength="2000" placeholder="Message #' + esc(room.name || st.room) + '" enterkeyhint="send"></textarea><ul class="bd-ac" hidden></ul></div>' +
      '<button class="btn ch-send" type="submit"' + (c.busy ? " disabled" : "") + ">" + (c.busy ? "…" : "Send") + "</button></div>" +
      (c.err ? '<p class="acct-msg err">' + esc(c.err) + "</p>" : "") + "</form>";
  }
  function typingHtml() {
    var now = Date.now(), names = Object.keys(st.typing).filter(function (u) { return st.typing[u].until > now && st.typing[u].room === st.room; }).map(function (u) { return st.typing[u].name; });
    return esc(typingText(names));
  }
  function gate() {
    return !st.me ? '<section class="ch-gate"><h2>Chat</h2><div class="card bd-gate"><p><b>Sign in to chat.</b></p><p class="muted">The chat is for the league\'s managers only.</p><a class="btn" href="#account">Sign in</a></div></section>'
      : '<section class="ch-gate"><h2>Chat</h2><div class="card bd-gate"><p><b>The chat is for league members.</b></p><p class="muted">Your account isn\'t on a team yet. Ask the commissioner.</p></div></section>';
  }
  function shell() {
    return '<section class="ch' + (st.tv ? " tv" : "") + '">' +
      '<div class="ch-top" data-ch-part="top"></div>' +
      '<div class="ch-pin" data-ch-part="pin"></div>' +
      '<div class="ch-log" data-ch-part="log" aria-live="polite"></div>' +
      '<button type="button" class="ch-jump" data-ch="jump" hidden>↓ Latest</button>' +
      '<div class="ch-typing muted small" data-ch-part="typing"></div>' +
      '<div data-ch-part="compose"></div></section>';
  }
  function render(parts) {
    if (!st.el) return;
    if (!isMember()) { st.el.innerHTML = gate(); return; }
    var part = function (k) { return st.el.querySelector('[data-ch-part="' + k + '"]'); };
    if (!part("log")) { st.el.innerHTML = shell(); fit(); parts = null; }
    var all = !parts;
    if (all || parts.top) part("top").innerHTML = (st.tv ? "" : roomsHtml()) + onlineHtml();
    if (all || parts.pin) part("pin").innerHTML = pinHtml();
    if (all || parts.log) {
      var log = part("log"), atBottom = st.atBottom, oldH = log.scrollHeight, oldTop = log.scrollTop;
      log.innerHTML = logHtml();
      if (parts && parts.older) log.scrollTop = oldTop + (log.scrollHeight - oldH);     // keep your place after loading older
      else if (atBottom) log.scrollTop = log.scrollHeight;
      else log.scrollTop = oldTop;
    }
    if (all || parts.typing) part("typing").innerHTML = typingHtml();
    if (all || parts.compose) {
      var ta = part("compose").querySelector("textarea"), draft = ta ? ta.value : "", focused = ta && root.document.activeElement === ta;
      part("compose").innerHTML = composeHtml();
      var t2 = part("compose").querySelector("textarea");
      if (t2) { t2.value = draft; if (focused) t2.focus(); }
    }
    // Other parts (who's online, the pinned header) can change the log's height: stay on the newest message.
    var lg = part("log");
    if (st.atBottom && lg && !(parts && parts.older)) lg.scrollTop = lg.scrollHeight;
    if (lg && !lg.dataset.watched && root.ResizeObserver) {
      lg.dataset.watched = "1";
      new root.ResizeObserver(function () { if (st.atBottom) lg.scrollTop = lg.scrollHeight; }).observe(lg);
    }
    var jump = st.el.querySelector(".ch-jump");
    if (jump) { jump.hidden = st.atBottom; jump.textContent = st.newBelow ? "↓ " + st.newBelow + " new" : "↓ Latest"; }
  }
  // The chat fills the screen above the phone keyboard (visualViewport shrinks when it opens).
  function fit() {
    var sec = st.el && st.el.querySelector(".ch");
    if (!sec || st.mounted) return;
    var vv = root.visualViewport, h = vv ? vv.height + vv.offsetTop : root.innerHeight;
    sec.style.height = Math.max(260, h - Math.max(0, sec.getBoundingClientRect().top)) + "px";
    var log = sec.querySelector(".ch-log");
    if (log && st.atBottom) log.scrollTop = log.scrollHeight;
  }

  // ---- Realtime (shared socket; private channel b5-chat) -------------------------------------
  function startRealtime() {
    if (rt.sub) rt.sub.close();
    if (!root.B5Realtime) return;
    rt.user = myId();
    rt.sub = root.B5Realtime.subscribe({ cfg: cfg, topic: "realtime:b5-chat", private: true, presenceKey: rt.user,
      changes: [{ table: "chat_messages" }, { table: "chat_reactions" }, { table: "chat_rooms" }, { table: "draft_state" }],
      getToken: function () { return root.B5Account.load().then(function (m) { return m && m.session ? m.session.access_token : null; }); },
      onChange: onChange,
      onPresence: function (list) { st.online = onlineList(list, myId()); if (st.el && isMember()) render({ top: true }); },
      onBroadcast: function (ev, p) {
        if (ev !== "typing" || !p || p.user === myId()) return;
        st.typing[p.user] = { name: p.name, room: p.room, until: Date.now() + 4000 };
        if (st.el) { render({ typing: true }); setTimeout(function () { if (st.el) render({ typing: true }); }, 4100); }
      } });
    var p = me();
    rt.sub.track({ name: p.name || (st.me && st.me.profile && st.me.profile.display_name) || "", team: p.team || (st.me && st.me.teams && st.me.teams[0] && st.me.teams[0].team_id) || null });
  }
  function onChange(rec, table, type) {
    if (!rec) return;
    if (table === "chat_messages") {
      if (type === "DELETE") {
        st.msgs = st.msgs.filter(function (m) { return m.id !== rec.id; });
        if (st.el) render({ log: true, pin: true });
        return;
      }
      if (rec.author_id && rec.author_id !== myId() && st.typing[rec.author_id]) delete st.typing[rec.author_id];
      if (st.el && rec.room_id === st.room) {
        var isNew = !st.msgs.some(function (m) { return m.id === rec.id; });
        signFor([rec]).then(function () {
          st.msgs = mergeMessages(st.msgs, [rec]);
          if (isNew && !st.atBottom) st.newBelow++;
          render({ log: true, typing: true, pin: true });
          if (st.atBottom) markRead();
        });
      } else if (type === "INSERT" && rec.author_id !== myId()) badge();
    } else if (table === "chat_reactions") {
      var id = rec.message_id;
      if (st.el && st.msgs.some(function (m) { return m.id === id; })) loadReactions([id]).then(function () { render({ log: true }); });
    } else if (table === "chat_rooms") {
      if (st.el) loadRooms().then(function () { render({ top: true, pin: true, compose: true }); });
    } else if (table === "draft_state") {
      st.draft = rec;
      if (st.el) render({ pin: true });
    }
  }

  // ---- Unread badge (nav) -------------------------------------------------------------------------
  function badge() {
    var el = root.document && root.document.getElementById("chatBadge");
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    return who.then(function (m) {
      st.me = m;
      if (!isMember()) { if (el) el.hidden = true; if (rt.sub) { rt.sub.close(); rt.sub = null; } return; }
      var ready = Object.keys(st.people).length ? Promise.resolve() : loadPeople();
      return ready.then(function () {
        if (!rt.sub || rt.user !== myId()) startRealtime();
        return api("rpc/chat_unread", { method: "POST", body: "{}" });
      }).then(function (r) {
        st.unread = {};
        var total = 0;
        ok(r).forEach(function (x) { st.unread[x.room_id] = x.unread; if (!(st.el && x.room_id === st.room)) total += x.unread; });
        if (el) { el.textContent = total > 99 ? "99+" : String(total); el.hidden = !total; }
        if (st.el) render({ top: true });
      });
    }).catch(function () {});
  }

  // ---- Actions ------------------------------------------------------------------------------------
  function sendMessage(fm) {
    var c = st.compose, body = fm.body.value.trim(), images = c.images.map(function (i) { return i.value; });
    if (!body && !images.length) return;
    c.busy = true; c.err = null; render({ compose: true });
    api("chat_messages", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ room_id: st.room, body: body, images: images }) }).then(function (r) {
      c.busy = false;
      if (!r.ok) { c.err = friendly(r.error); render({ compose: true }); return; }
      st.compose = { images: [], busy: false, err: null };
      var ta = st.el.querySelector("[data-ch-compose] textarea"); if (ta) ta.value = "";
      st.atBottom = true;
      st.msgs = mergeMessages(st.msgs, r.data || []);      // shown at once; the Realtime echo is merged by id
      render({ log: true, compose: true });
      var t2 = st.el.querySelector("[data-ch-compose] textarea"); if (t2) t2.focus();
      markRead();
    });
  }
  function act(b) {
    var k = b.dataset.ch, id = Number(b.dataset.id);
    var done = function (r) { if (r && !r.ok) { st.compose.err = friendly(r.error); render({ compose: true }); } };
    if (k === "jump") { st.atBottom = true; st.newBelow = 0; var log = st.el.querySelector(".ch-log"); log.scrollTop = log.scrollHeight; render({ log: true }); markRead(); return; }
    if (k === "react") {
      var mine = (st.reactions[id] || []).some(function (x) { return x.user_id === myId() && x.emoji === b.dataset.emoji; });
      st.menu = null;
      api(mine ? "chat_reactions?message_id=eq." + id + "&user_id=eq." + myId() + "&emoji=eq." + encodeURIComponent(b.dataset.emoji) : "chat_reactions",
        mine ? { method: "DELETE" } : { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ message_id: id, emoji: b.dataset.emoji }) })
        .then(function (r) { done(r); return loadReactions([id]); }).then(function () { render({ log: true }); });
      return;
    }
    if (k === "edit") { st.editing = id; st.menu = null; render({ log: true }); return; }
    if (k === "cancel-edit") { st.editing = null; render({ log: true }); return; }
    if (k === "del" && root.confirm("Delete this message?")) {
      var msg = st.msgs.filter(function (m) { return m.id === id; })[0];
      api("chat_messages?id=eq." + id, { method: "DELETE" }).then(function (r) {
        done(r);
        if (r.ok) { st.msgs = st.msgs.filter(function (m) { return m.id !== id; }); if (msg && B()) B().media.remove(msg.images, session()); render({ log: true }); }
      });
      return;
    }
    if (k === "pin" || k === "unpin") {
      api("chat_rooms?id=eq." + encodeURIComponent(st.room), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pinned_message_id: k === "pin" ? id : null }) })
        .then(function (r) { done(r); st.menu = null; return loadRooms(); }).then(function () { render({ pin: true, log: true }); });
      return;
    }
    if (k === "mute") {
      var who = (st.people[b.dataset.user] || {}).name || "this member";
      var mins = root.prompt("Mute " + who + " for how many minutes? (e.g. 10, 60, 1440)", "10");
      if (!mins || !(Number(mins) > 0)) return;
      var until = new Date(Date.now() + Number(mins) * 60000).toISOString();
      api("chat_mutes?on_conflict=user_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: b.dataset.user, until: until, reason: "Muted from chat" }) })
        .then(function (r) { done(r); st.menu = null; render({ log: true }); });
      return;
    }
    if (k === "room-menu") {
      var choice = root.prompt("Room settings (commissioner)\n1 = new room\n2 = clear this room\n3 = close (archive) this room\n4 = unmute everyone", "1");
      if (choice === "1") {
        var name = root.prompt("New room name"); if (!name) return;
        var rid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "room";
        api("chat_rooms", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: rid, name: name.trim(), sort: 50 }) })
          .then(function (r) { done(r); if (r.ok) root.location.hash = "#chat/" + rid; });
      } else if (choice === "2" && root.confirm("Delete every message in this room? This can't be undone.")) {
        api("rpc/chat_clear_room", { method: "POST", body: JSON.stringify({ p_room: st.room }) }).then(function (r) { done(r); st.msgs = []; render({ log: true }); });
      } else if (choice === "3") {
        api("chat_rooms?id=eq." + encodeURIComponent(st.room), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ archived: true }) })
          .then(function (r) { done(r); if (r.ok) root.location.hash = "#chat/league"; });
      } else if (choice === "4") {
        api("chat_mutes?until=gt." + new Date().toISOString(), { method: "DELETE" }).then(done);
      }
      return;
    }
    if (k === "link") {
      var u = root.prompt("Paste a direct image or GIF link (https://…)");
      if (!u) return;
      var bad = B() ? B().checkImageUrl(u) : null;
      if (!bad && st.compose.images.length >= 4) bad = "Up to 4 images per message.";
      if (bad) st.compose.err = bad; else st.compose.images.push({ value: u.trim(), preview: u.trim() });
      render({ compose: true });
      return;
    }
    if (k === "unimg") { st.compose.images.splice(Number(b.dataset.i), 1); render({ compose: true }); }
  }
  function addFile(file) {
    var c = st.compose;
    if (c.images.length >= 4) { c.err = "Up to 4 images per message."; render({ compose: true }); return; }
    c.busy = true; c.err = null; render({ compose: true });
    B().media.prepare(file).then(function (small) { return B().media.upload(small, session()).then(function (v) { c.images.push({ value: v, preview: root.URL.createObjectURL(small) }); }); })
      .catch(function (e) { c.err = e.message; }).then(function () { c.busy = false; render({ compose: true }); });
  }
  function typing(ta) {
    var now = Date.now();
    if (rt.sub && now - st.lastTyping > 2500 && ta.value.trim()) {
      st.lastTyping = now;
      rt.sub.send("typing", { room: st.room, user: myId(), name: me().name || "Someone" });
    }
    // @mention autocomplete (the board's matcher)
    var box = ta.parentNode.querySelector(".bd-ac"), upto = ta.value.slice(0, ta.selectionStart);
    var m = /(^|\s)@([^\s@]{0,20}(?: [^\s@]{0,20})?)$/.exec(upto);
    var people = Object.keys(st.people).map(function (u) { var p = st.people[u]; return { team: p.team ? TL().name(p.team) : "", team_id: p.team, name: p.name }; });
    var list = m && B() ? B().mentionMatches(m[2], people) : [];
    if (!m || !list.length) { box.hidden = true; return; }
    box.innerHTML = list.map(function (p) { return '<li><button type="button" data-ch-mention="' + esc(p.team) + '">' + logo(p.team_id) + "<span><b>" + esc(p.team) + "</b>" + (p.name ? ' <span class="muted small">' + esc(p.name) + "</span>" : "") + "</span></button></li>"; }).join("");   // teamlink-ok: @mention picker (a button: a link can't nest in it)
    box.hidden = false; box.dataset.from = String(upto.length - m[2].length - 1);
  }

  // ---- Start / stop -----------------------------------------------------------------------------
  function stop() {
    clearInterval(st.tick); clearTimeout(st.readTimer);
    if (root.visualViewport && st.fitHandler) { root.visualViewport.removeEventListener("resize", st.fitHandler); root.visualViewport.removeEventListener("scroll", st.fitHandler); }
    st.el = null;
  }
  /** Mount a chat room in any element (the draft board's side panel later): opts { room, tv, readOnly }. */
  function mount(el, opts) {
    stop();
    opts = opts || {};
    st.el = el; st.room = opts.room || "league"; st.tv = !!opts.tv; st.readOnly = !!(opts.readOnly || opts.tv); st.mounted = !!opts.panel;
    st.msgs = []; st.reactions = {}; st.menu = null; st.editing = null; st.atBottom = true; st.newBelow = 0; st.compose = { images: [], busy: false, err: null };
    if (!(cfg && cfg.configured && A)) { el.innerHTML = '<section><h2>Chat</h2><div class="card">Not set up yet.</div></section>'; return; }
    el.innerHTML = '<section class="ch-gate"><h2>Chat</h2><p class="muted">Loading…</p></section>';
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (m) {
      st.me = m;
      if (st.el !== el) return;
      if (!isMember()) { render(); return; }
      return loadPeople().then(loadRooms).then(function () {
        if (!st.rooms.some(function (r) { return r.id === st.room; })) st.room = "league";
        return loadHistory();
      }).then(function () {
        if (st.el !== el) return;
        render();
        badge(); markRead();
        st.tick = setInterval(function () {
          if (!st.el) return;
          var h = draftHeader(st.draft, Date.now()), c = st.el.querySelector("[data-ch-clock]");
          if (c && h.status === "live") c.textContent = h.sub;
        }, 1000);
        if (root.visualViewport && !st.mounted) {
          st.fitHandler = function () { fit(); };
          root.visualViewport.addEventListener("resize", st.fitHandler);
          root.visualViewport.addEventListener("scroll", st.fitHandler);
        }
      });
    }).catch(function (e) { if (st.el === el) el.innerHTML = '<section class="ch-gate"><h2>Chat</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });

    el.addEventListener("click", function (e) {
      var mb = e.target.closest("[data-ch-mention]");
      if (mb) {
        var ta = mb.closest(".bd-ta").querySelector("textarea"), box = mb.closest(".bd-ac"), from = Number(box.dataset.from), tail = ta.value.slice(ta.selectionStart);
        ta.value = ta.value.slice(0, from) + "@" + mb.dataset.chMention + " " + tail;
        var pos = from + mb.dataset.chMention.length + 2; ta.setSelectionRange(pos, pos); ta.focus(); box.hidden = true;
        return;
      }
      var b = e.target.closest("[data-ch]");
      if (b && b.tagName !== "INPUT") { act(b); return; }
      var msg = e.target.closest("[data-ch-msg]");
      if (msg && !st.readOnly && !e.target.closest("a, form, button")) { var id = Number(msg.dataset.chMsg); st.menu = st.menu === id ? null : id; render({ log: true }); }
    });
    el.addEventListener("scroll", function (e) {
      var log = e.target;
      if (!log.classList || !log.classList.contains("ch-log")) return;
      st.atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      if (st.atBottom && st.newBelow) { st.newBelow = 0; markRead(); }
      var jump = st.el.querySelector(".ch-jump"); if (jump) { jump.hidden = st.atBottom; jump.textContent = st.newBelow ? "↓ " + st.newBelow + " new" : "↓ Latest"; }
      if (log.scrollTop < 80 && st.hasMore && !st.loadingOld && st.msgs.length) {
        st.loadingOld = true;
        loadHistory(st.msgs[0].id).then(function () { st.loadingOld = false; render({ log: true, older: true }); }, function () { st.loadingOld = false; });
      }
    }, true);
    // Images load after the scroll: stay pinned to the newest message if that's where you were.
    el.addEventListener("load", function (e) {
      if (e.target.tagName !== "IMG" || !st.atBottom) return;
      var log = st.el && st.el.querySelector(".ch-log"); if (log) log.scrollTop = log.scrollHeight;
    }, true);
    el.addEventListener("input", function (e) { if (e.target.matches("[data-ch-compose] textarea")) { e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; typing(e.target); } });
    el.addEventListener("keydown", function (e) {
      // Enter sends on a computer; Shift+Enter (and phones' return key) makes a new line.
      if (e.key === "Enter" && !e.shiftKey && e.target.matches("[data-ch-compose] textarea") && !("ontouchstart" in root)) { e.preventDefault(); sendMessage(e.target.form); }
    });
    el.addEventListener("change", function (e) { if (e.target.matches("[data-ch=file]") && e.target.files && e.target.files[0]) addFile(e.target.files[0]); });
    el.addEventListener("submit", function (e) {
      if (e.target.matches("[data-ch-compose]")) { e.preventDefault(); sendMessage(e.target); return; }
      var ed = e.target.closest("[data-ch-edit]");
      if (ed) {
        e.preventDefault();
        api("chat_messages?id=eq." + ed.dataset.chEdit, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ body: ed.body.value.trim() }) }).then(function (r) {
          if (!r.ok) { st.compose.err = friendly(r.error); render({ compose: true }); return; }
          st.editing = null; st.msgs = mergeMessages(st.msgs, r.data || []); render({ log: true });
        });
      }
    });
  }
  function start(rootEl, r) {
    var tv = !!(r && r.tv);
    if (root.document) root.document.body.classList.toggle("chat-tv", tv);
    mount(rootEl, { room: (r && r.room) || "league", tv: tv });
  }

  root.B5Chat = { start: start, stop: function () { stop(); if (root.document) root.document.body.classList.remove("chat-tv"); }, mount: mount, badge: badge,
    fmtClock: fmtClock, draftHeader: draftHeader, typingText: typingText, onlineList: onlineList, mergeMessages: mergeMessages, mentionsMe: mentionsMe, continues: continues };
})(typeof globalThis !== "undefined" ? globalThis : this);
