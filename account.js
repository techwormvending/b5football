/* Account (#account) and commissioner (#commish) screens, plus the nav's
   sign-in state. Uses auth.js (B5Auth) and supabase-config.js (B5_SUPABASE).
   All data is escaped before it goes into HTML.

   The league is invite-only: the commissioner adds an email (optionally to a
   team) here; the database's sign-up hook refuses anyone not invited, and the
   invite's team and role are applied on first sign-in. */
(function () {
  "use strict";
  var cfg = window.B5_SUPABASE, A = window.B5Auth, L = window.LEAGUE || {};
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  var f = function (u, i) { return window.fetch(u, i); };   // looked up per call (tests can stub it)
  var opts = function () { return { storage: storage, fetchImpl: f, now: Date.now() }; };
  var et = function (iso) {
    return iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "";
  };
  var ago = function (iso) {
    var h = (Date.now() - Date.parse(iso)) / 3600000;
    return h < 1 ? Math.max(1, Math.round(h * 60)) + " min ago" : h < 48 ? Math.round(h) + " h ago" : Math.floor(h / 24) + " days ago";
  };
  var ready = function () { return !!(cfg && cfg.configured && A); };

  // ---- Who is signed in --------------------------------------------------
  var me = null;   // { session, profile: {display_name, is_commissioner}, teams: [{team_id, name}] }
  function load() {
    if (!ready()) return Promise.resolve(null);
    return A.current(cfg, opts()).then(function (s) {
      if (!s) { me = null; return null; }
      return Promise.all([
        A.api(cfg, s, "profiles?id=eq." + encodeURIComponent(s.user.id) + "&select=display_name,is_commissioner", {}, f),
        A.api(cfg, s, "team_managers?user_id=eq." + encodeURIComponent(s.user.id) + "&select=team_id,teams(name)", {}, f)
      ]).then(function (r) {
        me = {
          session: s,
          profile: (r[0].ok && r[0].data && r[0].data[0]) || null,
          teams: ((r[1].ok && r[1].data) || []).map(function (t) { return { team_id: t.team_id, name: t.teams ? t.teams.name : t.team_id }; })
        };
        return me;
      });
    });
  }

  function refreshNav() {
    var acct = document.getElementById("navAccount"), com = document.getElementById("navCommish");
    if (acct) acct.textContent = me ? "Account" : "Sign in";
    if (com) com.hidden = !(me && me.profile && me.profile.is_commissioner);
  }

  // ---- #account ------------------------------------------------------------
  function renderAccount(root, msg) {
    var notice = window.B5AuthNotice; window.B5AuthNotice = null;
    var banner = msg || (notice && notice.error ? { err: "That sign-in link didn't work: " + notice.error + ". Request a new one below." } : null);
    var m = banner ? '<p class="acct-msg ' + (banner.err ? "err" : "ok") + '">' + esc(banner.err || banner.ok) + "</p>" : "";
    if (!ready()) { root.innerHTML = '<section><h2>Account</h2><div class="card"><p>Sign-in isn\'t set up yet.</p></div></section>'; return; }
    if (!me) {
      root.innerHTML = '<section><h2>Sign in</h2><form class="card acct-form" data-acct="login">' +
        "<p>Managers sign in with a one-time link sent to their email. The league is invite-only.</p>" +
        '<label>Email<input name="email" type="email" autocomplete="email" inputmode="email" required></label>' +
        '<button class="btn" type="submit">Email me a sign-in link</button>' + m + "</form></section>";
      return;
    }
    var p = me.profile || {};
    var teams = me.teams.length
      ? me.teams.map(function (t) { return esc(t.name); }).join(", ")
      : (p.is_commissioner ? "None" : "Not assigned to a team yet. Ask the commissioner.");
    root.innerHTML = "<section><h2>Account</h2>" +
      (notice && notice.signedIn ? '<p class="acct-msg ok">You\'re signed in.</p>' : "") + m +
      '<div class="card acct-card">' +
      '<p><b>Email</b><br>' + esc(me.session.user.email) + "</p>" +
      '<p><b>Team</b><br>' + teams + "</p>" +
      (p.is_commissioner ? '<p><span class="tag">Commissioner</span> <a href="#commish">Open the commissioner screen</a></p>' : "") +
      '<form class="acct-form" data-acct="name"><label>Display name<input name="display_name" maxlength="40" value="' + esc(p.display_name) + '"></label>' +
      '<button class="btn ghost" type="submit">Save name</button></form>' +
      '<button class="btn ghost" type="button" data-acct="signout">Sign out</button></div></section>';
  }

  function startAccount(root) {
    root.innerHTML = '<section><h2>Account</h2><p class="muted">Loading…</p></section>';
    load().then(function () { refreshNav(); renderAccount(root); }, function () { renderAccount(root, { err: "Couldn't load your account." }); });
    root.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-acct]");
      if (!form) return;
      e.preventDefault();
      var fd = new FormData(form), btn = form.querySelector("button");
      if (btn) btn.disabled = true;
      if (form.dataset.acct === "login") {
        A.requestLink(cfg, fd.get("email"), location.origin + location.pathname, f).then(function (r) {
          renderAccount(root, r.ok ? { ok: "Check your email for a sign-in link from noreply@b5football.win. It works once and expires in an hour." } : { err: r.error });
        });
      } else if (form.dataset.acct === "name") {
        A.api(cfg, me.session, "profiles?id=eq." + encodeURIComponent(me.session.user.id), {
          method: "PATCH", body: JSON.stringify({ display_name: String(fd.get("display_name") || "").trim() }), headers: { Prefer: "return=minimal" }
        }, f).then(function (r) { return load().then(function () { renderAccount(root, r.ok ? { ok: "Name saved." } : { err: r.error }); }); });
      }
    });
    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-acct='signout']");
      if (!b) return;
      A.signOut(cfg, opts()).then(function () { me = null; refreshNav(); renderAccount(root, { ok: "Signed out." }); });
    });
  }

  // ---- #commish ------------------------------------------------------------
  var cm = { teams: [], invites: [], managers: [], keep: null, msg: null };

  function loadCommish() {
    var s = me.session;
    return Promise.all([
      A.api(cfg, s, "teams?select=id,name,division&order=id", {}, f),
      A.api(cfg, s, "invites?select=email,team_id,is_commissioner,invited_at,accepted_at&order=invited_at", {}, f),
      A.api(cfg, s, "team_managers?select=team_id,user_id,profiles(display_name)&order=team_id", {}, f),
      A.api(cfg, s, "rpc/keepalive_status", { method: "POST", body: "{}" }, f)
    ]).then(function (r) {
      cm.teams = r[0].data || []; cm.invites = r[1].data || []; cm.managers = r[2].data || []; cm.keep = r[3].ok ? r[3].data : null;
      var bad = r.filter(function (x) { return !x.ok; });
      if (bad.length) cm.msg = { err: "Some data didn't load: " + bad[0].error };
    });
  }

  function teamName(id) {
    for (var i = 0; i < cm.teams.length; i++) if (cm.teams[i].id === id) return cm.teams[i].name;
    return id || "";
  }

  function renderCommish(root) {
    if (!ready()) { root.innerHTML = '<section><h2>Commissioner</h2><div class="card"><p>Sign-in isn\'t set up yet.</p></div></section>'; return; }
    if (!me) { root.innerHTML = '<section><h2>Commissioner</h2><div class="card"><p><a href="#account">Sign in</a> first.</p></div></section>'; return; }
    if (!(me.profile && me.profile.is_commissioner)) { root.innerHTML = '<section><h2>Commissioner</h2><div class="card"><p>This screen is for the commissioner only.</p></div></section>'; return; }
    var m = cm.msg ? '<p class="acct-msg ' + (cm.msg.err ? "err" : "ok") + '">' + esc(cm.msg.err || cm.msg.ok) + "</p>" : "";
    cm.msg = null;

    var hb = (cm.keep && cm.keep.heartbeats) || [];
    var warn = window.B5Keepalive ? window.B5Keepalive.warning(cm.keep, Date.now()) : null;
    var keep = '<div class="card"><h3>Database keep-alive</h3>' +
      (warn ? '<p class="acct-msg err">' + esc(warn) + "</p>" : '<p class="acct-msg ok">Keep-alive is running.</p>') +
      '<ul class="checks">' + (hb.length ? hb.map(function (h) {
        return "<li>" + esc(h.name === "cloudflare-cron" ? "Cloudflare Worker" : h.name === "nightly" ? "GitHub nightly job (backup)" : h.name) + ": " + esc(ago(h.at)) + " (" + esc(et(h.at)) + ")</li>";
      }).join("") : "<li>No heartbeats yet.</li>") + "</ul></div>";

    var teamOpts = '<option value="">No team</option>' + cm.teams.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + "</option>"; }).join("");
    var seedTeams = cm.teams.length ? "" :
      '<p class="acct-msg err">No teams in the database yet. <button class="btn ghost" type="button" data-cm="seed-teams">Add the ' + esc((L.teams || []).length) + " teams from the site</button></p>";

    var invites = cm.invites.length ? '<div class="table-wrap"><table class="cm-table"><thead><tr><th>Email</th><th>Team</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
      cm.invites.map(function (i) {
        return "<tr><td>" + esc(i.email) + "</td><td>" + esc(teamName(i.team_id)) + "</td><td>" + (i.is_commissioner ? "Commissioner" : "Manager") +
          "</td><td>" + (i.accepted_at ? "Joined " + esc(et(i.accepted_at)) : "Invited " + esc(et(i.invited_at))) + "</td>" +
          '<td class="cm-actions"><button class="btn ghost" type="button" data-cm="send" data-email="' + esc(i.email) + '">Send link</button>' +
          '<button class="btn ghost" type="button" data-cm="remove-invite" data-email="' + esc(i.email) + '">Remove</button></td></tr>';
      }).join("") + "</tbody></table></div>" : '<p class="muted">No invites yet.</p>';

    var mgrs = cm.managers.length ? '<ul class="checks">' + cm.managers.map(function (x) {
      return "<li>" + esc(teamName(x.team_id)) + ": " + esc((x.profiles && x.profiles.display_name) || x.user_id) +
        ' <button class="linkish" type="button" data-cm="unassign" data-team="' + esc(x.team_id) + '" data-user="' + esc(x.user_id) + '">remove from team</button></li>';
    }).join("") + "</ul>" : '<p class="muted">No managers have joined yet.</p>';

    root.innerHTML = "<section><h2>Commissioner</h2>" + m + keep +
      '<div class="card"><h3>Invite a manager</h3>' + seedTeams +
      '<form class="acct-form" data-cm="invite">' +
      '<label>Email<input name="email" type="email" autocomplete="off" required></label>' +
      '<label>Team<select name="team_id">' + teamOpts + "</select></label>" +
      '<label class="acct-check"><input type="checkbox" name="is_commissioner"> Commissioner</label>' +
      '<label class="acct-check"><input type="checkbox" name="send" checked> Email a sign-in link now</label>' +
      '<button class="btn" type="submit">Add invite</button></form>' +
      '<p class="muted small">Only invited emails can create an account. Their team and role are applied when they first sign in. ' +
      "Removing an invite stops new sign-ups; to cut off someone who already joined, also remove them from their team.</p></div>" +
      '<div class="card"><h3>Invites</h3>' + invites + "</div>" +
      '<div class="card"><h3>Team managers</h3>' + mgrs + "</div></section>";
  }

  function startCommish(root) {
    root.innerHTML = '<section><h2>Commissioner</h2><p class="muted">Loading…</p></section>';
    var redraw = function () { return loadCommish().then(function () { renderCommish(root); }); };
    load().then(function () {
      refreshNav();
      if (me && me.profile && me.profile.is_commissioner) return redraw();
      renderCommish(root);
    }, function () { root.innerHTML = '<section><h2>Commissioner</h2><p class="acct-msg err">Couldn\'t load.</p></section>'; });

    var act = function (p) { return p.then(function (r) { cm.msg = r && r.ok === false ? { err: r.error } : (r && r.msgOk ? { ok: r.msgOk } : cm.msg); return redraw(); }); };

    root.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-cm='invite']");
      if (!form) return;
      e.preventDefault();
      var fd = new FormData(form);
      var email = String(fd.get("email") || "").trim().toLowerCase();
      var row = { email: email, team_id: fd.get("team_id") || null, is_commissioner: fd.get("is_commissioner") === "on" };
      act(A.api(cfg, me.session, "invites", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } }, f).then(function (r) {
        if (!r.ok) return { ok: false, error: /duplicate|unique/i.test(r.error) ? email + " is already invited." : /check constraint/i.test(r.error) ? "That doesn't look like a valid email." : r.error };
        if (fd.get("send") !== "on") return { msgOk: "Invited " + email + "." };
        return A.requestLink(cfg, email, location.origin + location.pathname, f).then(function (s) {
          return s.ok ? { msgOk: "Invited " + email + " and emailed a sign-in link." } : { ok: false, error: "Invited " + email + ", but the email failed: " + s.error };
        });
      }));
    });

    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cm]");
      if (!b || b.tagName === "FORM") return;
      var kind = b.dataset.cm;
      if (kind === "send") {
        b.disabled = true;
        act(A.requestLink(cfg, b.dataset.email, location.origin + location.pathname, f).then(function (s) {
          return s.ok ? { msgOk: "Sign-in link sent to " + b.dataset.email + "." } : s;
        }));
      } else if (kind === "remove-invite") {
        if (!window.confirm("Remove the invite for " + b.dataset.email + "?")) return;
        act(A.api(cfg, me.session, "invites?email=eq." + encodeURIComponent(b.dataset.email), { method: "DELETE" }, f)
          .then(function (r) { return r.ok ? { msgOk: "Invite removed." } : r; }));
      } else if (kind === "unassign") {
        if (!window.confirm("Remove this manager from " + teamName(b.dataset.team) + "?")) return;
        act(A.api(cfg, me.session, "team_managers?team_id=eq." + encodeURIComponent(b.dataset.team) + "&user_id=eq." + encodeURIComponent(b.dataset.user), { method: "DELETE" }, f)
          .then(function (r) { return r.ok ? { msgOk: "Manager removed from the team." } : r; }));
      } else if (kind === "seed-teams") {
        var divs = {};
        (L.divisions || []).forEach(function (d) { divs[d.id] = d.name; });
        var rows = (L.teams || []).map(function (t) { return { id: t.id, name: t.name, division: divs[t.division] || t.division, logo_url: t.logo || null }; });
        act(A.api(cfg, me.session, "teams", { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "resolution=merge-duplicates,return=minimal" } }, f)
          .then(function (r) { return r.ok ? { msgOk: "Added " + rows.length + " teams." } : r; }));
      }
    });
  }

  window.B5Account = {
    start: function (page, root) {
      if (page === "account") startAccount(root);
      else if (page === "commish") startCommish(root);
    },
    refreshNav: refreshNav,
    load: load
  };

  // Set the nav for whoever is signed in.
  load().then(refreshNav, refreshNav);
})();
