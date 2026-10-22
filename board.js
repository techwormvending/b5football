/* Message Board (#board, #board/<threadId>). League members only: the database refuses everyone
   else (RLS on every board table, see migration board); signed-out visitors get "Sign in to view
   the board". Threads (title + first post) and replies, newest activity first, pinned on top.
   Text only, with light formatting rendered here from escaped text: **bold**, *italic*,
   [text](https://...), bare https links, @mentions, line breaks. Never raw HTML.
   Images: up to 4 per post, an https link or an upload to the private Storage bucket board-images
   (images/GIFs, 5 MB; photos are shrunk in the browser first; shown through 1-hour signed URLs).
   Reactions 👍 😂 🔥 💀 🗑️ (one of each per person), edit/delete your own posts ("edited"), unread
   highlighting and the nav badge (public.board_unread), live updates over Supabase Realtime.
   The commissioner pins, locks and deletes any post (audited by the database). */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var EMOJI = ["👍", "😂", "🔥", "💀", "🗑️"];
  var TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"], MAX_BYTES = 5 * 1024 * 1024, MAX_IMAGES = 4;
  var teamById = function (id) { return (L.teams || []).filter(function (t) { return t.id === id; })[0] || null; };
  var initials = function (n) { return String(n || "").split(/\s+/).filter(function (w) { return w && !/^the$/i.test(w); }).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase(); };
  var logo = function (t, bot) {
    if (bot) return '<div class="logo sm bd-bot" aria-hidden="true">B5</div>';
    return t && t.logo ? '<img class="logo sm" src="' + esc(t.logo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<div class=&quot;logo sm&quot;>' + esc(initials(t.name)) + '</div>\'">'
      : '<div class="logo sm">' + esc(initials(t ? t.name : "?")) + "</div>";
  };

  // ---- Pure helpers (tested in src/workers/board-page.test.ts) ------------------------------
  var reEsc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
  /** Escaped text with **bold**, *italic* and @mentions. ctx.mentions: [{ label, me }] (longest first). */
  function inline(s, ctx) {
    var h = esc(s);
    // One pass over every name (longest first), so "@Mac" never matches inside "@Mac Daddies".
    var ms = ((ctx && ctx.mentions) || []).filter(function (m) { return m.label; });
    if (ms.length) {
      var byLabel = {};
      ms.forEach(function (m) { var k = esc(m.label).toLowerCase(); byLabel[k] = byLabel[k] || m.me; });
      var alt = ms.map(function (m) { return reEsc(esc(m.label)); }).join("|");
      h = h.replace(new RegExp("(^|[^\\w@&;])@(" + alt + ")(?![\\w])", "gi"), function (_, pre, name) {
        return pre + '<span class="mention' + (byLabel[name.toLowerCase()] ? " me" : "") + '">@' + name + "</span>";
      });
    }
    return h.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>");
  }
  function linkHtml(url, text) {
    var internal = url.charAt(0) === "#";
    return '<a href="' + esc(url) + '"' + (internal ? "" : ' target="_blank" rel="noopener noreferrer nofollow ugc"') + ">" + esc(text) + "</a>";
  }
  /** A post body -> safe HTML. Only http(s) and in-site (#...) links; everything else is escaped. */
  function formatBody(raw, ctx) {
    var text = String(raw == null ? "" : raw);
    var re = /\[([^\]\n]{1,200})\]\(((?:https?:\/\/|#)[^\s()<>"']{1,1000})\)|(https?:\/\/[^\s<>"']*[^\s<>"'.,!?;:)\]])/g;
    var out = "", last = 0, m;
    while ((m = re.exec(text))) {
      out += inline(text.slice(last, m.index), ctx) + (m[2] ? linkHtml(m[2], m[1]) : linkHtml(m[3], m[3]));
      last = re.lastIndex;
    }
    return (out + inline(text.slice(last), ctx)).replace(/\r?\n/g, "<br>");
  }
  /** Upload check before sending (the bucket enforces the same limits). */
  function checkUpload(file) {
    if (!file) return "No file chosen.";
    if (TYPES.indexOf(file.type) < 0) return "Images only: PNG, JPEG, GIF or WebP.";
    if (file.size > MAX_BYTES) return "That image is over 5 MB.";
    return null;
  }
  /** A pasted image link: https only, no spaces or quotes. */
  function checkImageUrl(u) {
    var s = String(u || "").trim();
    if (!/^https:\/\//i.test(s)) return "Image links must start with https://";
    if (s.length > 1000 || /[\s"'<>\\]/.test(s)) return "That doesn't look like an image link.";
    return null;
  }
  /** Size for a phone-friendly upload: longest side at most `max` px. */
  function fitSize(w, h, max) {
    var k = Math.min(1, max / Math.max(w, h));
    return { w: Math.round(w * k), h: Math.round(h * k) };
  }
  /** Managers matching what follows "@" (team or display name). */
  function mentionMatches(q, people) {
    var s = String(q || "").toLowerCase();
    return people.filter(function (p) { return !s || p.team.toLowerCase().indexOf(s) >= 0 || (p.name && p.name.toLowerCase().indexOf(s) >= 0); }).slice(0, 6);
  }
  /** Unread: someone else's activity after your last read (or the week before your first visit). */
  function isUnread(t, readAt, baseline, me) {
    if (t.last_author_id === me) return false;
    var since = Math.max(readAt ? Date.parse(readAt) : -Infinity, baseline - 7 * 86400000);
    return Date.parse(t.last_activity_at) > since;
  }
  /** Home-page announcement HTML -> board text (links kept as [text](url), tags dropped). */
  function htmlToText(html) {
    var ent = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
    return String(html || "")
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, function (_, u, t) { return "[" + t.replace(/<[^>]*>/g, "") + "](" + u + ")"; })
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*/gi, "\n\n").replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, function (e) { return ent[e]; })
      .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  var ago = function (iso) {
    var s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago"
      : new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  // ---- State and data -------------------------------------------------------------------------
  var st = { me: null, el: null, thread: null, list: null, view: null, people: [], names: {}, signed: {}, reads: {}, baseline: Date.now(),
    open: false, editing: null, msg: null, composers: {}, timer: null };
  var session = function () { return st.me && st.me.session; };
  var myId = function () { return session() ? session().user.id : null; };
  var isCommish = function () { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); };
  var isMember = function () { return !!(st.me && (isCommish() || (st.me.teams && st.me.teams.length))); };
  var api = function (path, init) { return A.api(cfg, session(), path, init || {}, f); };
  var ok = function (x) { return x && x.ok ? x.data || [] : []; };
  var inList = function (ids) { return encodeURIComponent(ids.map(function (i) { return '"' + String(i).replace(/"/g, "") + '"'; }).join(",")); };
  var friendly = function (e) {
    e = String(e || "");
    return /Slow down/.test(e) ? "Slow down: 10 posts a minute." : /locked/.test(e) ? "This thread is locked." : /has replies/.test(e) ? "This thread has replies: edit your post instead."
      : /Images must/.test(e) ? "Images must be https links or uploads (up to 4)." : /check constraint/.test(e) ? "Write something (or add an image) first." : e;
  };

  function loadPeople() {
    return api("team_managers?select=team_id,user_id,profiles(display_name)").then(function (r) {
      st.names = {}; st.people = [];
      ok(r).forEach(function (x) {
        var t = teamById(x.team_id), name = x.profiles && x.profiles.display_name || "";
        if (!st.names[x.user_id]) st.names[x.user_id] = name || (t ? t.name : "");
        st.people.push({ user: x.user_id, team: t ? t.name : x.team_id, team_id: x.team_id, name: name });
      });
    });
  }
  var authorName = function (uid, team, bot) {
    if (bot) return "B5 Bot";
    var t = teamById(team), n = st.names[uid];
    return n && t && n !== t.name ? n + " · " + t.name : n || (t ? t.name : "Former member");
  };
  var mentionCtx = function () {
    var me = myId(), list = [];
    st.people.forEach(function (p) {
      list.push({ label: p.team, me: p.user === me });
      if (p.name) list.push({ label: p.name, me: p.user === me });
    });
    return { mentions: list.sort(function (a, b) { return b.label.length - a.label.length; }) };
  };

  function loadList() {
    return Promise.all([
      api("board_threads?select=id,title,author_id,author_team,is_bot,pinned,locked,created_at,edited_at,last_activity_at,last_author_id,reply_count&order=pinned.desc,last_activity_at.desc&limit=100"),
      api("board_reads?select=thread_id,read_at"),
      api("board_visits", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: "{}" }).then(function () { return api("board_visits?select=first_at"); })
    ]).then(function (r) {
      if (!r[0].ok) throw new Error(r[0].error);
      st.list = r[0].data || [];
      st.reads = {}; ok(r[1]).forEach(function (x) { st.reads[x.thread_id] = x.read_at; });
      var v = ok(r[2])[0]; st.baseline = v ? Date.parse(v.first_at) : Date.now();
    });
  }
  function signUrls(paths, sess) {
    sess = sess || session();
    var need = paths.filter(function (p) { return !st.signed[p]; });
    if (!need.length) return Promise.resolve();
    return f(cfg.url + "/storage/v1/object/sign/board-images", { method: "POST",
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + sess.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600, paths: need }) })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { (list || []).forEach(function (x) { if (x.signedURL && x.path) st.signed[x.path] = cfg.url + "/storage/v1" + x.signedURL; }); }, function () {});
  }
  function loadThread(id) {
    return Promise.all([
      api("board_threads?id=eq." + id + "&select=*"),
      api("board_posts?thread_id=eq." + id + "&select=*&order=created_at&limit=500")
    ]).then(function (r) {
      var t = ok(r[0])[0];
      if (!t) { st.view = { missing: true }; return; }
      var posts = ok(r[1]);
      var paths = [];
      posts.forEach(function (p) { (p.images || []).forEach(function (u) { if (/^storage:/.test(u)) paths.push(u.slice(8)); }); });
      return Promise.all([
        posts.length ? api("board_reactions?post_id=in.(" + posts.map(function (p) { return p.id; }).join(",") + ")&select=post_id,user_id,emoji") : Promise.resolve({ ok: true, data: [] }),
        signUrls(paths)
      ]).then(function (x) {
        st.view = { thread: t, posts: posts, reactions: ok(x[0]) };
        // Mark it read (also clears it from the badge).
        api("board_reads?on_conflict=user_id,thread_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ thread_id: t.id, read_at: new Date().toISOString() }) }).then(function () { badge(true); });
      });
    });
  }

  // ---- Render ---------------------------------------------------------------------------------
  function imagesHtml(list) {
    if (!list || !list.length) return "";
    return '<div class="bd-imgs">' + list.map(function (u) {
      var src = /^storage:/.test(u) ? st.signed[u.slice(8)] : /^https:\/\//.test(u) ? u : null;
      return src ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></a>' : "";
    }).join("") + "</div>";
  }
  function composerHtml(key, opts) {
    var c = st.composers[key] || (st.composers[key] = { images: [], busy: false, err: null });
    return '<form class="card bd-compose" data-bd-compose="' + esc(key) + '">' +
      (opts.title ? '<label class="bd-lbl">Title<input name="title" maxlength="120" required placeholder="What\'s it about?"></label>' : "") +
      '<div class="bd-ta"><textarea name="body" rows="' + (opts.title ? 5 : 3) + '" maxlength="10000" placeholder="' + esc(opts.placeholder || "Say something…") + '"></textarea>' +
      '<ul class="bd-ac" hidden></ul></div>' +
      '<div class="bd-thumbs">' + c.images.map(function (im, i) {
        return '<span class="bd-thumb"><img src="' + esc(im.preview) + '" alt=""><button type="button" data-bd="unimg" data-i="' + i + '" aria-label="Remove image">×</button></span>';
      }).join("") + "</div>" +
      '<div class="bd-tools"><label class="btn ghost bd-file">📷 Photo/GIF<input type="file" accept="image/*" data-bd="file" hidden></label>' +
      '<button type="button" class="btn ghost" data-bd="link">🔗 Image link</button>' +
      '<button class="btn" type="submit"' + (c.busy ? " disabled" : "") + ">" + (c.busy ? "Posting…" : opts.title ? "Post thread" : "Reply") + "</button></div>" +
      '<p class="muted small bd-hint">**bold** · *italic* · [text](https://…) · @ to mention · images up to 5 MB</p>' +
      (c.err ? '<p class="acct-msg err">' + esc(c.err) + "</p>" : "") + "</form>";
  }
  function listHtml() {
    var me = myId(), ctx = mentionCtx();
    var rows = (st.list || []).map(function (t) {
      var unread = isUnread(t, st.reads[t.id], st.baseline, me);
      return '<a class="bd-row' + (unread ? " unread" : "") + (t.pinned ? " pinned" : "") + '" href="#board/' + esc(t.id) + '">' + logo(teamById(t.author_team), t.is_bot) +
        '<div class="bd-row-main"><b>' + (t.pinned ? "📌 " : "") + (t.locked ? "🔒 " : "") + inline(t.title, ctx) + "</b>" +
        '<span class="muted small">' + esc(authorName(t.author_id, t.author_team, t.is_bot)) + " · " + esc(t.reply_count) + (t.reply_count === 1 ? " reply" : " replies") + " · " + esc(ago(t.last_activity_at)) + "</span></div>" +
        (unread ? '<span class="bd-dot" aria-label="New"></span>' : "") + "</a>";
    }).join("");
    return '<section class="bd"><div class="bd-head"><h2>Board</h2><button class="btn" data-bd="new">' + (st.open ? "Cancel" : "New thread") + "</button></div>" +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      (st.open ? composerHtml("new", { title: true }) : "") +
      (rows ? '<div class="card bd-list">' + rows + "</div>" : '<div class="card muted">No threads yet. Start one.</div>') + "</section>";
  }
  function postHtml(p, t, reacts, ctx) {
    var me = myId(), mine = p.author_id === me && !p.is_bot;
    var byEmoji = {};
    reacts.filter(function (r) { return r.post_id === p.id; }).forEach(function (r) { (byEmoji[r.emoji] = byEmoji[r.emoji] || []).push(r.user_id); });
    var bar = EMOJI.map(function (e) {
      var who = byEmoji[e] || [], minee = who.indexOf(me) >= 0;
      return '<button type="button" class="bd-react' + (minee ? " mine" : "") + '" data-bd="react" data-post="' + esc(p.id) + '" data-emoji="' + esc(e) + '" aria-pressed="' + minee + '"' +
        (who.length ? ' title="' + esc(who.map(function (u) { return st.names[u] || "?"; }).join(", ")) + '"' : "") + ">" + e + (who.length ? " <b>" + who.length + "</b>" : "") + "</button>";
    }).join("");
    var editing = st.editing === p.id;
    var body = editing
      ? '<form data-bd-edit="' + esc(p.id) + '"><textarea name="body" rows="4" maxlength="10000">' + esc(p.body) + '</textarea><div class="bd-tools"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-bd="cancel-edit">Cancel</button></div></form>'
      : '<div class="bd-body">' + formatBody(p.body, ctx) + "</div>" + imagesHtml(p.images);
    var actions = (mine && !editing ? '<button type="button" class="bd-act" data-bd="edit" data-post="' + esc(p.id) + '">Edit</button>' : "") +
      ((mine && !p.is_opener) || (isCommish() && !p.is_opener) ? '<button type="button" class="bd-act" data-bd="del" data-post="' + esc(p.id) + '">Delete</button>' : "");
    return '<article class="card bd-post' + (p.is_bot ? " bot" : "") + '" id="post-' + esc(p.id) + '">' +
      '<div class="bd-by">' + logo(teamById(p.author_team), p.is_bot) + '<div><b>' + esc(authorName(p.author_id, p.author_team, p.is_bot)) + '</b><span class="muted small">' + esc(ago(p.created_at)) +
      (p.edited_at ? " · edited" : "") + "</span></div></div>" + body +
      '<div class="bd-foot"><div class="bd-reacts">' + bar + '</div><div class="bd-acts">' + actions + "</div></div></article>";
  }
  function threadHtml() {
    var v = st.view, back = '<p><a href="#board">← All threads</a></p>';
    if (!v || v.missing) return '<section class="bd"><h2>Board</h2>' + back + '<div class="card muted">That thread is gone.</div></section>';
    var t = v.thread, ctx = mentionCtx(), me = myId();
    var ctl = (isCommish() ? '<button class="btn ghost" data-bd="pin">' + (t.pinned ? "Unpin" : "Pin") + '</button><button class="btn ghost" data-bd="lock">' + (t.locked ? "Unlock" : "Lock") + "</button>" : "") +
      ((t.author_id === me && !t.is_bot) ? '<button class="btn ghost" data-bd="retitle">Edit title</button>' : "") +
      (isCommish() || (t.author_id === me && !t.reply_count) ? '<button class="btn ghost danger" data-bd="del-thread">Delete thread</button>' : "");
    var reply = t.locked && !isCommish() ? '<div class="card muted">🔒 This thread is locked.</div>' : composerHtml("reply:" + t.id, { placeholder: "Reply…" });
    return '<section class="bd">' + back + '<h2 class="bd-title">' + (t.pinned ? "📌 " : "") + (t.locked ? "🔒 " : "") + inline(t.title, ctx) + (t.edited_at ? ' <span class="muted small">edited</span>' : "") + "</h2>" +
      (ctl ? '<div class="bd-ctl">' + ctl + "</div>" : "") +
      (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      v.posts.map(function (p) { return postHtml(p, t, v.reactions, ctx); }).join("") + reply + "</section>";
  }
  function gateHtml() {
    return !st.me ? '<section class="bd"><h2>Board</h2><div class="card bd-gate"><p><b>Sign in to view the board.</b></p><p class="muted">The message board is for the league\'s managers only.</p><a class="btn" href="#account">Sign in</a></div></section>'
      : '<section class="bd"><h2>Board</h2><div class="card bd-gate"><p><b>The board is for league members.</b></p><p class="muted">Your account isn\'t on a team yet. Ask the commissioner.</p></div></section>';
  }
  function render() {
    if (!st.el) return;
    // Keep what someone is typing across live re-renders.
    var drafts = {};
    st.el.querySelectorAll("[data-bd-compose]").forEach(function (fm) {
      drafts[fm.dataset.bdCompose] = { title: fm.title ? fm.title.value : "", body: fm.body.value, focus: root.document.activeElement === fm.body };
    });
    var editDraft = st.el.querySelector("[data-bd-edit] textarea");
    var ed = editDraft ? editDraft.value : null;
    st.el.innerHTML = !isMember() ? gateHtml() : st.thread ? threadHtml() : listHtml();
    Object.keys(drafts).forEach(function (k) {
      var fm = st.el.querySelector('[data-bd-compose="' + k + '"]'); if (!fm) return;
      if (fm.title) fm.title.value = drafts[k].title; fm.body.value = drafts[k].body;
      if (drafts[k].focus) fm.body.focus();
    });
    if (ed != null) { var e2 = st.el.querySelector("[data-bd-edit] textarea"); if (e2) e2.value = ed; }
  }
  function reload() {
    var el = st.el;
    var p = st.thread ? loadThread(st.thread) : loadList();
    return p.then(function () { if (st.el === el) render(); }, function (e) { st.msg = { err: "Couldn't load: " + e.message }; if (st.el === el) render(); });
  }
  var soon = function () { clearTimeout(st.timer); st.timer = setTimeout(function () { if (st.el) reload(); }, 400); };

  // ---- Posting --------------------------------------------------------------------------------
  function shrink(file) {
    // Photos: longest side 1600 px, JPEG ~85% (a 4 MB phone photo becomes ~300 KB). GIFs stay animated.
    if (file.type === "image/gif" || !root.createImageBitmap || !root.document) return Promise.resolve(file);
    return root.createImageBitmap(file).then(function (bmp) {
      var s = fitSize(bmp.width, bmp.height, 1600);
      if (s.w === bmp.width && file.size < 1500000) return file;
      var c = root.document.createElement("canvas"); c.width = s.w; c.height = s.h;
      c.getContext("2d").drawImage(bmp, 0, 0, s.w, s.h);
      return new Promise(function (res) { c.toBlob(function (b) { res(b ? new root.File([b], "photo.jpg", { type: "image/jpeg" }) : file); }, "image/jpeg", 0.85); });
    }, function () { return file; });
  }
  function upload(file, sess) {
    sess = sess || session();
    var ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[file.type];
    var path = sess.user.id + "/" + root.crypto.randomUUID() + "." + ext;
    return f(cfg.url + "/storage/v1/object/board-images/" + path, { method: "POST",
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + sess.access_token, "Content-Type": file.type, "x-upsert": "false" }, body: file })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(/size/i.test(t) ? "That image is over 5 MB." : /mime|type/i.test(t) ? "Images only." : "Upload failed (" + r.status + ")."); }); return "storage:" + path; });
  }
  function addFile(key, file) {
    var c = st.composers[key];
    var bad = checkUpload(file) || (c.images.length >= MAX_IMAGES ? "Up to 4 images per post." : null);
    if (bad) { c.err = bad; render(); return; }
    c.busy = true; c.err = null; render();
    shrink(file).then(function (small) { var e2 = checkUpload(small); if (e2) throw new Error(e2); return upload(small).then(function (v) { c.images.push({ value: v, preview: root.URL.createObjectURL(small) }); }); })
      .catch(function (e) { c.err = e.message; }).then(function () { c.busy = false; render(); });
  }
  function submit(key, fm) {
    var c = st.composers[key];
    var body = fm.body.value.trim(), images = c.images.map(function (i) { return i.value; });
    if (!body && !images.length) { c.err = "Write something (or add an image) first."; render(); return; }
    c.busy = true; c.err = null; render();
    var req = key === "new"
      ? api("rpc/board_new_thread", { method: "POST", body: JSON.stringify({ p_title: fm.title.value.trim(), p_body: body, p_images: images }) })
      : api("board_posts", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ thread_id: Number(key.split(":")[1]), body: body, images: images }) });
    req.then(function (r) {
      c.busy = false;
      if (!r.ok) { c.err = friendly(r.error); render(); return; }
      st.composers[key] = { images: [], busy: false, err: null };
      st.el.querySelectorAll('[data-bd-compose="' + key + '"] textarea, [data-bd-compose="' + key + '"] input[name=title]').forEach(function (x) { x.value = ""; });
      if (key === "new") { st.open = false; root.location.hash = "#board/" + r.data; return; }
      reload();
    });
  }
  function act(b) {
    var k = b.dataset.bd, t = st.view && st.view.thread, post = Number(b.dataset.post);
    var done = function (r, okMsg) { st.msg = r.ok ? (okMsg ? { ok: okMsg } : null) : { err: friendly(r.error) }; reload(); };
    if (k === "new") { st.open = !st.open; render(); return; }
    if (k === "react") {
      var mine = b.classList.contains("mine");
      api(mine ? "board_reactions?post_id=eq." + post + "&user_id=eq." + myId() + "&emoji=eq." + encodeURIComponent(b.dataset.emoji) : "board_reactions",
        mine ? { method: "DELETE" } : { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ post_id: post, emoji: b.dataset.emoji }) }).then(function (r) { done(r); });
      return;
    }
    if (k === "edit") { st.editing = post; render(); return; }
    if (k === "cancel-edit") { st.editing = null; render(); return; }
    if (k === "del" && root.confirm("Delete this post?")) {
      var p = st.view.posts.filter(function (x) { return x.id === post; })[0];
      api("board_posts?id=eq." + post, { method: "DELETE" }).then(function (r) { if (r.ok && p) removeUploads(p.images); done(r, "Post deleted."); });
    }
    if (k === "del-thread" && root.confirm("Delete this whole thread?")) {
      api("board_threads?id=eq." + t.id, { method: "DELETE", headers: { Prefer: "return=representation" } }).then(function (r) {
        if (r.ok && r.data && r.data.length) { st.view.posts.forEach(function (x) { removeUploads(x.images); }); root.location.hash = "#board"; }
        else done(r.ok ? { ok: false, error: "Not deleted." } : r);
      });
    }
    if (k === "pin" || k === "lock") {
      var patch = k === "pin" ? { pinned: !t.pinned } : { locked: !t.locked };
      api("board_threads?id=eq." + t.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) }).then(function (r) { done(r); });
    }
    if (k === "retitle") {
      var title = root.prompt("Thread title", t.title);
      if (title && title.trim() && title.trim() !== t.title) api("board_threads?id=eq." + t.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ title: title.trim() }) }).then(function (r) { done(r); });
    }
    if (k === "link") {
      var key = b.closest("[data-bd-compose]").dataset.bdCompose, c = st.composers[key];
      var u = root.prompt("Paste a direct image or GIF link (https://…)");
      if (!u) return;
      var bad = checkImageUrl(u) || (c.images.length >= MAX_IMAGES ? "Up to 4 images per post." : null);
      if (bad) c.err = bad; else c.images.push({ value: u.trim(), preview: u.trim() });
      render();
    }
    if (k === "unimg") { var c2 = st.composers[b.closest("[data-bd-compose]").dataset.bdCompose]; c2.images.splice(Number(b.dataset.i), 1); render(); }
  }
  function removeUploads(images, sess) {
    sess = sess || session();
    var paths = (images || []).filter(function (u) { return /^storage:/.test(u); }).map(function (u) { return u.slice(8); });
    if (!paths.length) return;
    f(cfg.url + "/storage/v1/object/board-images", { method: "DELETE",
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + sess.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: paths }) }).catch(function () {});
  }

  // @mention autocomplete: after "@", suggest managers by team or name; picking inserts "@Team Name ".
  function autocomplete(ta) {
    var box = ta.parentNode.querySelector(".bd-ac"), upto = ta.value.slice(0, ta.selectionStart);
    var m = /(^|\s)@([^\s@]{0,20}(?: [^\s@]{0,20})?)$/.exec(upto);
    var list = m ? mentionMatches(m[2], st.people) : [];
    if (!m || !list.length) { box.hidden = true; return; }
    box.innerHTML = list.map(function (p) {
      return '<li><button type="button" data-bd-mention="' + esc(p.team) + '">' + logo(teamById(p.team_id)) + "<span><b>" + esc(p.team) + "</b>" + (p.name ? ' <span class="muted small">' + esc(p.name) + "</span>" : "") + "</span></button></li>";
    }).join("");
    box.hidden = false;
    box.dataset.from = String(upto.length - m[2].length - 1);
  }

  // ---- Badge + Realtime (one socket for signed-in members, on every page) ---------------------
  var rt = { sub: null, user: null };
  function badge(force) {
    var el = root.document && root.document.getElementById("boardBadge");
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    return who.then(function (me) {
      st.me = me;
      var member = isMember();
      if (!member) { if (el) el.hidden = true; if (rt.sub) { rt.sub.close(); rt.sub = null; } return; }
      if (!rt.sub || rt.user !== myId()) startRealtime();
      if (!el) return;
      return api("rpc/board_unread", { method: "POST", body: "{}" }).then(function (r) {
        var n = r.ok ? Number(r.data) || 0 : 0;
        el.textContent = n > 9 ? "9+" : String(n); el.hidden = !n;
      });
    }).catch(function () {});
  }
  function startRealtime() {
    if (rt.sub) rt.sub.close();
    if (!root.B5Realtime) return;
    rt.user = myId();
    rt.sub = root.B5Realtime.subscribe({ cfg: cfg, topic: "realtime:b5-board-" + rt.user,
      changes: [{ table: "board_threads" }, { table: "board_posts" }, { table: "board_reactions" }],
      getToken: function () { return root.B5Account.load().then(function (me) { return me && me.session ? me.session.access_token : null; }); },
      onChange: function () {
        clearTimeout(rt.t); rt.t = setTimeout(function () { badge(); }, 800);
        if (st.el) soon();
      } });
  }

  function stop() { st.el = null; clearTimeout(st.timer); }
  function start(rootEl, r) {
    st.el = rootEl; st.thread = r && r.thread ? Number(r.thread) : null; st.view = null; st.msg = null; st.editing = null;
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Board</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section class="bd"><h2>Board</h2><p class="muted">Loading…</p></section>';
    var el = rootEl;
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (me) {
      st.me = me;
      if (st.el !== el) return;
      if (!isMember()) { render(); return; }
      return loadPeople().then(reload);
    });

    rootEl.addEventListener("click", function (e) {
      var mb = e.target.closest("[data-bd-mention]");
      if (mb) {
        var ta = mb.closest(".bd-ta").querySelector("textarea"), box = mb.closest(".bd-ac"), from = Number(box.dataset.from);
        var tail = ta.value.slice(ta.selectionStart);
        ta.value = ta.value.slice(0, from) + "@" + mb.dataset.bdMention + " " + tail;
        var pos = from + mb.dataset.bdMention.length + 2;
        ta.setSelectionRange(pos, pos); ta.focus(); box.hidden = true;
        return;
      }
      var b = e.target.closest("[data-bd]"); if (!b || b.tagName === "INPUT") return;
      act(b);
    });
    rootEl.addEventListener("input", function (e) { if (e.target.matches(".bd-ta textarea")) autocomplete(e.target); });
    rootEl.addEventListener("change", function (e) {
      if (e.target.matches("[data-bd=file]") && e.target.files && e.target.files[0]) addFile(e.target.closest("[data-bd-compose]").dataset.bdCompose, e.target.files[0]);
    });
    rootEl.addEventListener("submit", function (e) {
      var fm = e.target.closest("[data-bd-compose]");
      if (fm) { e.preventDefault(); submit(fm.dataset.bdCompose, fm); return; }
      var ed = e.target.closest("[data-bd-edit]");
      if (ed) {
        e.preventDefault();
        var body = ed.body.value.trim();
        api("board_posts?id=eq." + ed.dataset.bdEdit, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ body: body }) }).then(function (r) {
          st.editing = r.ok ? null : st.editing; st.msg = r.ok ? null : { err: friendly(r.error) }; reload();
        });
      }
    });
  }

  // Shared with chat.js: same bucket, limits, shrinking and signed links.
  var media = {
    prepare: function (file) {
      var bad = checkUpload(file);
      if (bad) return Promise.reject(new Error(bad));
      return shrink(file).then(function (s) { var e = checkUpload(s); if (e) throw new Error(e); return s; });
    },
    upload: upload,
    sign: function (paths, sess) { return signUrls(paths, sess).then(function () { var out = {}; paths.forEach(function (p) { if (st.signed[p]) out[p] = st.signed[p]; }); return out; }); },
    remove: removeUploads
  };
  root.B5Board = { start: start, stop: stop, badge: badge, media: media, formatBody: formatBody, inline: inline, checkUpload: checkUpload, checkImageUrl: checkImageUrl,
    fitSize: fitSize, mentionMatches: mentionMatches, isUnread: isUnread, htmlToText: htmlToText };
})(typeof globalThis !== "undefined" ? globalThis : this);
