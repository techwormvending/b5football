/* Direct messages (#dm, #dm/<conversationId>; window.B5DM). Private 1-to-1 conversations, 1-to-team
   (you and that team's owners) and one per trade (both teams' owners; B5 Bot posts each step).
   Built on the chat pieces: the shared Realtime socket (realtime.js; postgres_changes on dm_messages /
   dm_conversations, RLS per subscriber, so each member only receives his own conversations), Board's
   sanitizer (B5Board.formatBody: escaped text, never HTML) and image pipeline (B5Board.media, checks,
   shrinking, signed links) pointed at the private dm-images bucket. Only participants read
   (database RLS); the commissioner reads a conversation only after a participant reports it, until he
   closes the report. Nav: "✉" with an unread badge (public.dm_unread). */
(function (root) {
  "use strict";
  var cfg = root.B5_SUPABASE, A = root.B5Auth, BUCKET = "dm-images";
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var B = function () { return root.B5Board; }, TL = function () { return root.B5Team; };
  var st = { me: null, el: null, conv: null, convs: [], last: {}, unread: {}, msgs: [], people: {}, signed: {}, menu: null, editing: null,
    compose: { images: [], busy: false, err: null }, msg: null };
  var rt = { sub: null, user: null };
  var myId = function () { return st.me && st.me.session ? st.me.session.user.id : null; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var myTeam = function () { return st.me && st.me.teams && st.me.teams[0] ? st.me.teams[0].team_id : null; };
  var isMember = function () { return !!(st.me && (isCommish() || myTeam())); };
  var session = function () { return st.me && st.me.session; };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var rpc = function (name, body) { return api("rpc/" + name, { method: "POST", body: JSON.stringify(body || {}) }); };
  var ok = function (r) { return r && r.ok ? r.data || [] : []; };
  var time = function (iso) { return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };

  // ---- Pure helpers (tested in src/workers/dm-page.test.ts) ----------------------------------
  /** Who a conversation is with, from my side: { kind, user?, team?, teams? } */
  function partner(c, me, myTeams) {
    if (c.kind === "trade") return { kind: "trade", teams: c.teams || [] };
    if (c.kind === "team") {
      var t = (c.teams || [])[0];
      if (myTeams.indexOf(t) >= 0) return { kind: "user", user: c.created_by, viaTeam: t };   // someone wrote to my team
      return { kind: "team", team: t };
    }
    var other = (c.dm_members || []).map(function (m) { return m.user_id; }).filter(function (u) { return u !== me; })[0];
    return { kind: "user", user: other };
  }
  /** Conversation title (HTML): a person's name with his team's TeamLink, a TeamLink, or both trade teams. */
  function titleHtml(p, people) {
    if (p.kind === "trade") return "Trade: " + p.teams.map(function (t) { return TL().link(t, { logo: false }); }).join(" ↔ ");
    if (p.kind === "team") return TL().link(p.team, { logo: false }) + ' <span class="muted small">(the team\'s owners)</span>';
    var x = people[p.user] || {};
    return esc(x.name || "League member") + (x.team ? ' <span class="muted small">· ' + TL().link(x.team, { logo: false }) + "</span>" : "");
  }
  /** Newest conversations first, by last message. */
  function sortConvs(list) { return list.slice().sort(function (a, b) { return String(b.last_message_at).localeCompare(String(a.last_message_at)); }); }

  // ---- Data ------------------------------------------------------------------------------------
  function loadPeople() {
    return Promise.all([api("profiles?select=id,display_name"), api("team_managers?select=user_id,team_id")]).then(function (r) {
      st.people = {};
      ok(r[0]).forEach(function (p) { st.people[p.id] = { name: p.display_name || "", team: null }; });
      ok(r[1]).forEach(function (m) { (st.people[m.user_id] = st.people[m.user_id] || { name: "" }).team = m.team_id; });
    });
  }
  function loadList() {
    return Promise.all([
      api("dm_conversations?select=id,kind,teams,created_by,last_message_at,reported_at,report_reason,dm_members(user_id)&order=last_message_at.desc&limit=100"),
      api("dm_messages?select=conversation_id,body,images,is_bot,author_id,created_at&order=id.desc&limit=300"),
      rpc("dm_unread")
    ]).then(function (r) {
      st.convs = sortConvs(ok(r[0]));
      st.last = {};
      ok(r[1]).forEach(function (m) { if (!st.last[m.conversation_id]) st.last[m.conversation_id] = m; });
      st.unread = {}; ok(r[2]).forEach(function (x) { st.unread[x.conversation_id] = x.unread; });
    });
  }
  function signFor(msgs) {
    var paths = [];
    msgs.forEach(function (m) { (m.images || []).forEach(function (u) { if (/^storage:/.test(u) && !st.signed[u.slice(8)]) paths.push(u.slice(8)); }); });
    if (!paths.length || !B()) return Promise.resolve();
    return B().media.sign(paths, session(), BUCKET).then(function (map) { Object.keys(map).forEach(function (k) { st.signed[k] = map[k]; }); });
  }
  function loadThread(id) {
    return Promise.all([api("dm_conversations?id=eq." + id + "&select=id,kind,teams,created_by,last_message_at,reported_at,report_reason,dm_members(user_id)"),
      api("dm_messages?conversation_id=eq." + id + "&select=*&order=id.desc&limit=200")]).then(function (r) {
      st.convs = st.convs.filter(function (c) { return c.id !== id; }).concat(ok(r[0]));
      st.msgs = ok(r[1]).reverse();
      return signFor(st.msgs);
    });
  }
  function markRead(id) {
    if (!id || !(st.convs.filter(function (c) { return c.id === id; })[0] || {}).dm_members) return;
    return api("dm_reads?on_conflict=user_id,conversation_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ conversation_id: id, read_at: new Date().toISOString() }) }).then(function () { st.unread[id] = 0; badge(); });
  }

  // ---- Render ----------------------------------------------------------------------------------
  var convOf = function (id) { return st.convs.filter(function (c) { return c.id === id; })[0]; };
  var amParticipant = function (c) {
    var me = myId();
    return !!c && ((c.dm_members || []).some(function (m) { return m.user_id === me; }) || (c.teams || []).indexOf(myTeam()) >= 0 ||
      (st.me && st.me.teams || []).some(function (t) { return (c.teams || []).indexOf(t.team_id) >= 0; }));
  };
  function gate() {
    return '<section><h2>Messages</h2><div class="card bd-gate"><p><b>' + (st.me ? "Direct messages are for league members." : "Sign in to see your messages.") + "</b></p>" +
      (st.me ? "" : '<a class="btn" href="#account">Sign in</a>') + "</div></section>";
  }
  function listHtml() {
    var me = myId(), mine = (st.me.teams || []).map(function (t) { return t.team_id; });
    var rows = st.convs.map(function (c) {
      var p = partner(c, me, mine), last = st.last[c.id], n = st.unread[c.id] || 0;
      var preview = last ? (last.is_bot ? "B5 Bot: " : last.author_id === me ? "You: " : "") + (last.body || "📷 Image") : "No messages yet";
      return '<div class="bd-row has-cover' + (n ? " unread" : "") + '"><a class="card-cover" href="#dm/' + c.id + '" aria-label="Open the conversation"></a>' +
        (p.kind === "user" ? TL().logo((st.people[p.user] || {}).team) : TL().logo(p.team || (p.teams || [])[0])) +
        '<div class="bd-row-main"><b>' + titleHtml(p, st.people) + (c.reported_at ? ' <span class="tag">reported</span>' : "") + "</b>" +
        '<span class="muted small">' + esc(preview.slice(0, 90)) + (last ? " · " + esc(time(last.created_at)) : "") + "</span></div>" +
        (n ? '<span class="nav-badge">' + (n > 99 ? "99+" : n) + "</span>" : "") + "</div>";
    }).join("");
    return '<section class="dm"><h2>Messages</h2><p class="muted small">Private conversations: only the people in them can read them. To start one, open a team (Teams page) and tap Message. ' +
      'Trade proposals start their own conversation. If something crosses the line, open the conversation and tap Report: that shares it with the commissioner.</p>' +
      '<div class="card bd-list">' + (rows || '<p class="muted">No conversations yet.</p>') + "</div></section>";
  }
  function imagesHtml(list) {
    if (!list || !list.length) return "";
    return '<div class="ch-imgs">' + list.map(function (u) {
      var src = /^storage:/.test(u) ? st.signed[u.slice(8)] : /^https:\/\//.test(u) ? u : null;
      return src ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(src) + '" alt="" decoding="async" referrerpolicy="no-referrer"></a>' : "";
    }).join("") + "</div>";
  }
  function byHtml(m) {
    if (m.is_bot) return "B5 Bot";
    var p = st.people[m.author_id] || {}, team = m.author_team || p.team;
    return esc(p.name || "League member") + (team && TL().has(team) ? ' <span class="ch-team">· ' + TL().link(team, { logo: false }) + "</span>" : "");
  }
  function threadHtml() {
    var c = convOf(st.conv);
    if (!c) return '<section class="dm"><p><a href="#dm">← Messages</a></p><div class="card muted">That conversation isn\'t available.</div></section>';
    var me = myId(), mine = (st.me.teams || []).map(function (t) { return t.team_id; }), p = partner(c, me, mine), part = amParticipant(c);
    var reportBox = c.reported_at
      ? '<p class="acct-msg err">🚩 Reported to the commissioner' + (c.report_reason && (isCommish() || part) ? ": " + esc(c.report_reason) : "") + "." +
        (isCommish() ? ' <button class="btn ghost" type="button" data-dm="resolve">Close the report (private again)</button>' : "") + "</p>" : "";
    // @mentions: team names link to their profiles (TeamLink), people are highlighted.
    var labels = TL().ids().map(function (id) { return { label: TL().name(id), me: mine.indexOf(id) >= 0, href: TL().href(id) }; });
    Object.keys(st.people).forEach(function (u) { if (st.people[u].name) labels.push({ label: st.people[u].name, me: u === me }); });
    var ctx = { mentions: labels.sort(function (a, b) { return b.label.length - a.label.length; }) };
    var log = st.msgs.map(function (m) {
      var own = m.author_id === me && !m.is_bot, open = st.menu === m.id, editing = st.editing === m.id;
      var body = editing ? '<form data-dm-edit="' + m.id + '"><textarea name="body" rows="2" maxlength="2000">' + esc(m.body) + '</textarea><div class="ch-tools"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-dm="cancel">Cancel</button></div></form>'
        : (m.body ? '<div class="ch-body">' + (B() ? B().formatBody(m.body, ctx) : esc(m.body)) + "</div>" : "") + imagesHtml(m.images);
      var acts = open && !editing ? '<div class="ch-acts">' + (own ? '<button type="button" data-dm="edit" data-id="' + m.id + '">Edit</button>' : "") +
        (own || (isCommish() && c.reported_at) ? '<button type="button" data-dm="del" data-id="' + m.id + '">Delete</button>' : "") + "</div>" : "";
      return '<div class="ch-msg' + (m.is_bot ? " bot" : "") + (own ? " mine" : "") + '" data-dm-msg="' + m.id + '"><div class="ch-gut">' +
        (m.is_bot ? '<div class="logo sm bd-bot">B5</div>' : TL().logo(m.author_team || (st.people[m.author_id] || {}).team)) + "</div>" +
        '<div class="ch-main"><div class="ch-by"><b>' + byHtml(m) + '</b> <span class="muted">' + esc(time(m.created_at)) + "</span></div>" + body +
        (m.edited_at ? '<span class="muted ch-edited">edited</span>' : "") + acts + "</div></div>";
    }).join("");
    var k = st.compose;
    var compose = part ? '<form class="ch-compose" data-dm-compose><div class="bd-thumbs">' + k.images.map(function (im, i) { return '<span class="bd-thumb"><img src="' + esc(im.preview) + '" alt=""><button type="button" data-dm="unimg" data-i="' + i + '" aria-label="Remove image">×</button></span>'; }).join("") + "</div>" +
      '<div class="ch-row"><label class="ch-icon" aria-label="Add a photo or GIF">📷<input type="file" accept="image/*" data-dm="file" hidden></label>' +
      '<button type="button" class="ch-icon" data-dm="link" aria-label="Add an image link">🔗</button>' +
      '<div class="bd-ta"><textarea name="body" rows="1" maxlength="2000" placeholder="Message" enterkeyhint="send"></textarea></div>' +
      '<button class="btn ch-send" type="submit"' + (k.busy ? " disabled" : "") + ">" + (k.busy ? "…" : "Send") + "</button></div>" +
      (k.err ? '<p class="acct-msg err">' + esc(k.err) + "</p>" : "") + "</form>" : '<p class="muted small">You\'re reading this because it was reported. Only its participants can post.</p>';
    return '<section class="dm"><p class="dm-back"><a href="#dm">← Messages</a></p><div class="dm-head"><h2 class="dm-title">' + titleHtml(p, st.people) + "</h2>" +
      (part && !c.reported_at ? '<button class="linkish" type="button" data-dm="report">Report</button>' : "") + "</div>" + reportBox +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      '<div class="card dm-log ch-log" data-dm-log>' + (log || '<p class="muted ch-empty">No messages yet. Say hi.</p>') + "</div>" + compose + "</section>";
  }
  function render(keepDraft) {
    if (!st.el) return;
    if (!isMember()) { st.el.innerHTML = gate(); return; }
    var ta = st.el.querySelector("[data-dm-compose] textarea"), draft = keepDraft && ta ? ta.value : "";
    st.el.innerHTML = st.conv ? threadHtml() : listHtml();
    var log = st.el.querySelector("[data-dm-log]"); if (log) log.scrollTop = log.scrollHeight;
    var t2 = st.el.querySelector("[data-dm-compose] textarea"); if (t2 && draft) t2.value = draft;
  }

  // ---- Actions ---------------------------------------------------------------------------------
  var friendly = function (e) {
    e = String(e || "");
    return /Slow down/.test(e) ? "Slow down: 20 messages per 10 seconds." : /muted/.test(e) ? e : /Images must/.test(e) ? "Images must be https links or uploads (up to 4)." : /check constraint/.test(e) ? "Write something (or add an image) first." : e;
  };
  function send(form) {
    var k = st.compose, body = form.body.value.trim();
    if (!body && !k.images.length) return;
    k.busy = true; k.err = null; render(true);
    api("dm_messages", { method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ conversation_id: st.conv, body: body, images: k.images.map(function (i) { return i.value; }) }) }).then(function (r) {
      k.busy = false;
      if (!r.ok) { k.err = friendly(r.error); render(true); return; }
      k.images = [];
      var m = ok(r)[0]; if (m && !st.msgs.some(function (x) { return x.id === m.id; })) st.msgs.push(m);
      signFor(st.msgs).then(function () { render(false); markRead(st.conv); });
    });
  }
  function act(b) {
    var k = b.dataset.dm, id = Number(b.dataset.id);
    if (k === "report") {
      var why = root.prompt("Report this conversation to the commissioner? He'll be able to read it until he closes the report. Reason (optional):", "");
      if (why == null) return;
      rpc("dm_report", { p_conv: st.conv, p_reason: why || null }).then(function (r) { st.msg = r.ok ? { ok: "Reported. The commissioner can read this conversation now." } : { err: r.error }; return loadThread(st.conv); }).then(function () { render(true); });
      return;
    }
    if (k === "resolve") { rpc("dm_resolve", { p_conv: st.conv }).then(function (r) { st.msg = r.ok ? null : { err: r.error }; if (r.ok) root.location.hash = "#dm"; else render(true); }); return; }
    if (k === "edit") { st.editing = id; st.menu = null; render(true); return; }
    if (k === "cancel") { st.editing = null; render(true); return; }
    if (k === "del" && root.confirm("Delete this message?")) {
      var m = st.msgs.filter(function (x) { return x.id === id; })[0];
      api("dm_messages?id=eq." + id, { method: "DELETE" }).then(function (r) {
        if (r.ok) { st.msgs = st.msgs.filter(function (x) { return x.id !== id; }); if (m && B()) B().media.remove(m.images, session(), BUCKET); }
        else st.msg = { err: r.error };
        render(true);
      });
      return;
    }
    if (k === "unimg") { st.compose.images.splice(Number(b.dataset.i), 1); render(true); return; }
    if (k === "link") {
      var url = root.prompt("Image or GIF link (https://…):", "");
      if (!url) return;
      var bad = B() && B().checkImageUrl(url.trim());
      if (bad) { st.compose.err = bad; render(true); return; }
      if (st.compose.images.length >= 4) { st.compose.err = "Up to 4 images per message."; render(true); return; }
      st.compose.images.push({ value: url.trim(), preview: url.trim() }); render(true);
    }
  }
  function addFile(file) {
    var k = st.compose;
    if (k.images.length >= 4) { k.err = "Up to 4 images per message."; render(true); return; }
    k.busy = true; k.err = null; render(true);
    B().media.prepare(file).then(function (small) { return B().media.upload(small, session(), BUCKET).then(function (v) { k.images.push({ value: v, preview: root.URL.createObjectURL(small) }); }); })
      .catch(function (e) { k.err = e.message; }).then(function () { k.busy = false; render(true); });
  }

  // ---- Realtime + badge --------------------------------------------------------------------------
  function startRealtime() {
    if (rt.sub) rt.sub.close();
    if (!root.B5Realtime) return;
    rt.user = myId();
    // Not a private channel: postgres_changes apply each subscriber's RLS, so a member only gets his own conversations.
    rt.sub = root.B5Realtime.subscribe({ cfg: cfg, topic: "realtime:b5-dm", changes: [{ table: "dm_messages" }, { table: "dm_conversations" }],
      getToken: function () { return root.B5Account.load().then(function (m) { return m && m.session ? m.session.access_token : null; }); },
      onChange: function (rec, table, type) {
        if (table === "dm_messages" && rec && st.el && st.conv && rec.conversation_id === st.conv) {
          if (type === "DELETE") st.msgs = st.msgs.filter(function (x) { return x.id !== rec.id; });
          else {
            var i = st.msgs.map(function (x) { return x.id; }).indexOf(rec.id);
            if (i >= 0) st.msgs[i] = rec; else st.msgs.push(rec);
          }
          signFor(st.msgs).then(function () { render(true); markRead(st.conv); });
          return;
        }
        if (st.el && !st.conv) loadList().then(function () { render(true); });
        badge();
      } });
  }
  function badge() {
    var el = root.document && root.document.getElementById("dmBadge"), nav = root.document && root.document.getElementById("navDm");
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    return who.then(function (m) {
      st.me = m;
      if (nav) nav.hidden = !isMember();
      if (!isMember()) { if (el) el.hidden = true; if (rt.sub) { rt.sub.close(); rt.sub = null; } return; }
      if (!rt.sub || rt.user !== myId()) startRealtime();
      return rpc("dm_unread").then(function (r) {
        var total = 0;
        ok(r).forEach(function (x) { st.unread[x.conversation_id] = x.unread; if (!(st.el && x.conversation_id === st.conv)) total += x.unread; });
        if (el) { el.textContent = total > 99 ? "99+" : String(total); el.hidden = !total; }
      });
    }).catch(function () {});
  }

  /** Open (or create) a conversation with a person or a team and go there. */
  function open(to) {
    return root.B5Account.load().then(function (m) {
      st.me = m;
      return A.api(cfg, m && m.session, "rpc/dm_open", { method: "POST", body: JSON.stringify({ p_user: to.user || null, p_team: to.team || null }) }, f);
    }).then(function (r) { if (r.ok) root.location.hash = "#dm/" + r.data; return r; });
  }

  function start(rootEl, r) {
    st.el = rootEl; st.conv = r && r.conv ? Number(r.conv) : null; st.msg = null; st.menu = null; st.editing = null; st.compose = { images: [], busy: false, err: null };
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Messages</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section><h2>Messages</h2><p class="muted">Loading…</p></section>';
    var el = rootEl;
    (root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null)).then(function (me) {
      st.me = me;
      if (st.el !== el) return;
      if (!isMember()) { render(); return; }
      return loadPeople().then(function () { return st.conv ? loadThread(st.conv) : loadList(); }).then(function () {
        if (st.el !== el) return;
        render(); if (st.conv) markRead(st.conv); badge();
      });
    }).catch(function (e) { if (st.el === el) el.innerHTML = '<section><h2>Messages</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });
    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-dm]"); if (b && b.tagName !== "INPUT") { act(b); return; }
      var m = e.target.closest("[data-dm-msg]");
      if (m && !e.target.closest("a, button, form")) { var id = Number(m.dataset.dmMsg); st.menu = st.menu === id ? null : id; render(true); }
    });
    rootEl.addEventListener("change", function (e) { if (e.target.matches("[data-dm=file]") && e.target.files[0]) addFile(e.target.files[0]); });
    rootEl.addEventListener("submit", function (e) {
      if (e.target.matches("[data-dm-compose]")) { e.preventDefault(); send(e.target); return; }
      var ed = e.target.closest("[data-dm-edit]");
      if (ed) {
        e.preventDefault();
        var id = Number(ed.dataset.dmEdit);
        api("dm_messages?id=eq." + id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ body: ed.body.value }) }).then(function (r) {
          if (r.ok) { var m = ok(r)[0]; st.msgs = st.msgs.map(function (x) { return x.id === id && m ? m : x; }); st.editing = null; } else st.msg = { err: friendly(r.error) };
          render(true);
        });
      }
    });
    rootEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && e.target.matches("[data-dm-compose] textarea") && !("ontouchstart" in root)) { e.preventDefault(); send(e.target.form); }
    });
  }
  function stop() { st.el = null; st.conv = null; }

  root.B5DM = { start: start, stop: stop, badge: badge, open: open, partner: partner, titleHtml: titleHtml, sortConvs: sortConvs };
})(typeof globalThis !== "undefined" ? globalThis : this);
