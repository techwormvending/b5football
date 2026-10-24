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
        A.api(cfg, s, "team_managers?user_id=eq." + encodeURIComponent(s.user.id) + "&select=team_id", {}, f)
      ]).then(function (r) {
        me = {
          session: s,
          profile: (r[0].ok && r[0].data && r[0].data[0]) || null,
          teams: ((r[1].ok && r[1].data) || []).map(function (t) { return { team_id: t.team_id, name: window.B5Team.name(t.team_id) }; })
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
      ? me.teams.map(function (t) { return window.B5Team.link(t.team_id); }).join(", ")
      : (p.is_commissioner ? "None" : "Not assigned to a team yet. Ask the commissioner.");
    root.innerHTML = "<section><h2>Account</h2>" +
      (notice && notice.signedIn ? '<p class="acct-msg ok">You\'re signed in.</p>' : "") + m +
      '<div class="card acct-card">' +
      '<p><b>Email</b><br>' + esc(me.session.user.email) + "</p>" +
      '<p><b>Team</b><br>' + teams + "</p>" +
      (p.is_commissioner ? '<p><span class="tag">Commissioner</span> <a href="#commish">Open the commissioner screen</a></p>' : "") +
      '<form class="acct-form" data-acct="name"><label>Display name<input name="display_name" maxlength="40" required value="' + esc(p.display_name) + '"></label>' +
      '<p class="muted small">Shown to the league as your team\'s manager.</p>' +
      '<button class="btn ghost" type="submit">Save name</button></form>' +
      '<button class="btn ghost" type="button" data-acct="signout">Sign out</button></div>' + contactForm(p) + notifyForm() + "</section>";
  }

  // Owner contact info (owner_contacts: your row only; members see the fields you mark "League members"
  // on your team's profile; the commissioner always sees everything).
  var contact = null;
  function loadContact() {
    contact = null;
    if (!me || !(me.teams.length || (me.profile && me.profile.is_commissioner))) return Promise.resolve();
    return Promise.all([
      A.api(cfg, me.session, "owner_contacts?user_id=eq." + encodeURIComponent(me.session.user.id) + "&select=*", {}, f),
      A.api(cfg, me.session, "notify_settings?user_id=eq." + encodeURIComponent(me.session.user.id) + "&select=*", {}, f)
    ]).then(function (r) {
      contact = (r[0].ok && r[0].data && r[0].data[0]) || {};
      notify = Object.assign({}, NOTIFY_DEFAULTS, (r[1].ok && r[1].data && r[1].data[0]) || {});
    });
  }

  // Email notifications (notify_settings: your row only). Defaults match the database's.
  var NOTIFY_DEFAULTS = { paused: false, dm: true, mentions: false, trades: true, league_trades: false, waivers: true, league_waivers: false, league_moves: false,
    lineup_saved: true, lineup: false, league_lineups: "off", league_lineups_opponent: false, scoring: false, announcements: true };
  var NOTIFY_GROUPS = [
    ["Messages", [["dm", "Direct messages", "5 minutes after a message you haven't read (not while you're on the site); at most one per conversation every 30 minutes"],
      ["mentions", "@mentions in Chat or on the Message Board", ""]]],
    ["Trades", [["trades", "My trades", "proposed, accepted, declined, withdrawn, expired, approved or rejected"], ["league_trades", "All league trades", "completed trades around the league"]]],
    ["Waivers", [["waivers", "My waiver results", "after each Wednesday run: won or lost, and why"], ["league_waivers", "League-wide waiver results", "one email per run"],
      ["league_moves", "League first-come adds/drops", "one digest per hour"]]],
    ["Lineups", [["lineup_saved", "My lineup confirmation", "10 minutes after your team's lineup is saved, by you or your co-owner"],
      ["lineup", "Lineup reminders", "starters on bye or out, about 3 hours before kickoff"]]],
    ["Scores", [["scoring", "Daily scoring update", "after each game day's final scoring: your matchup, every score, the $35 race, guillotine danger"]]],
    ["League", [["announcements", "Commissioner announcements and messages", ""]]]];
  var NOTIFY_BOOLS = [];
  NOTIFY_GROUPS.forEach(function (g) { g[1].forEach(function (t) { NOTIFY_BOOLS.push(t[0]); }); });
  var notify = null;
  function notifyForm() {
    if (!notify) return "";
    var dis = notify.paused ? " disabled" : "";
    var box = function (t) {
      return '<li><label class="acct-check"><input type="checkbox" name="' + t[0] + '"' + (notify[t[0]] ? " checked" : "") + dis + "> " + esc(t[1]) + "</label>" +
        (t[2] ? '<span class="muted small">' + esc(t[2]) + "</span>" : "") + "</li>";
    };
    var others = '<li><label>Other teams\' lineups <select name="league_lineups"' + dis + ">" +
      [["off", "Off"], ["digest", "Digest (recommended): 9 AM ET on game days and 30 minutes before the first kickoff"], ["instant", "Instant: each change (10 minutes after the team's last edit)"]]
        .map(function (o) { return '<option value="' + o[0] + '"' + (notify.league_lineups === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select></label>" +
      '<label class="acct-check"><input type="checkbox" name="league_lineups_opponent"' + (notify.league_lineups_opponent ? " checked" : "") + dis + "> Only my opponent this week</label></li>";
    return '<form class="card acct-form notify-form" id="email-settings" data-acct="notify"><h3>Email notifications</h3>' +
      '<p class="muted small">Sent to ' + esc(me.session.user.email) + " from noreply@b5football.win. Each co-owner has his own settings.</p>" +
      '<label class="acct-check nf-pause"><input type="checkbox" name="paused"' + (notify.paused ? " checked" : "") + "> <b>Pause all email</b></label>" +
      '<div class="nf-groups' + (notify.paused ? " paused" : "") + '">' + NOTIFY_GROUPS.map(function (g) {
        return '<h4 class="nf-h">' + esc(g[0]) + '</h4><ul class="nf-list">' + g[1].map(box).join("") + (g[0] === "Lineups" ? others : "") + "</ul>";
      }).join("") + "</div>" +
      '<button class="btn ghost" type="submit">Save email settings</button>' +
      '<p class="muted small">Every email says which setting sent it and has a "Turn off these emails" link that works without signing in.</p></form>';
  }
  function contactForm() {
    if (!contact) return "";
    var c = contact;
    var vis = function (name, on) {
      return '<select name="' + name + '" aria-label="Who sees it"><option value="1"' + (on !== false ? " selected" : "") + '>League members</option><option value="0"' + (on === false ? " selected" : "") + ">Hidden</option></select>";
    };
    var phone = window.B5TeamPage ? window.B5TeamPage.formatPhone(c.phone) || c.phone || "" : c.phone || "";
    return '<form class="card acct-form contact-form" data-acct="contact"><h3>Contact info</h3>' +
      '<p class="muted small">Shown on your team\'s profile to signed-in league members only (never to visitors). Set a field to Hidden to keep it from members; the commissioner always sees it.</p>' +
      '<div class="cf-row"><label>Email<input name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" value="' + esc(c.email || "") + '"></label>' + vis("email_visible", c.email_visible) + "</div>" +
      '<div class="cf-row"><label>Cell phone (US)<input name="phone" type="tel" autocomplete="tel-national" inputmode="tel" maxlength="20" placeholder="(412) 555-0123" value="' + esc(phone) + '"></label>' + vis("phone_visible", c.phone_visible) + "</div>" +
      '<div class="cf-row"><label>Personal website<input name="website" type="url" inputmode="url" maxlength="300" placeholder="https://…" value="' + esc(c.website || "") + '"></label>' + vis("website_visible", c.website_visible) + "</div>" +
      '<button class="btn ghost" type="submit">Save contact info</button>' +
      (me.teams.length ? ' <a class="linkish" href="' + esc(window.B5Team.href(me.teams[0].team_id)) + '">See your team\'s profile</a>' : "") + "</form>";
  }

  function startAccount(root) {
    root.innerHTML = '<section><h2>Account</h2><p class="muted">Loading…</p></section>';
    load().then(function () { refreshNav(); return loadContact().catch(function () {}); }).then(function () {
      renderAccount(root);
      var box = location.hash === "#account/email" && document.getElementById("email-settings");
      if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
    }, function () { renderAccount(root, { err: "Couldn't load your account." }); });
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
      } else if (form.dataset.acct === "notify") {
        var row = { user_id: me.session.user.id, paused: !!form.paused.checked, league_lineups: form.league_lineups.value, league_lineups_opponent: !!form.league_lineups_opponent.checked };
        NOTIFY_BOOLS.forEach(function (k) { row[k] = !!form[k].checked; });
        A.api(cfg, me.session, "notify_settings?on_conflict=user_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row)
        }, f).then(function (r) {
          if (r.ok && r.data && r.data[0]) notify = Object.assign({}, NOTIFY_DEFAULTS, r.data[0]);
          renderAccount(root, r.ok ? { ok: "Email settings saved." } : { err: r.error || "Couldn't save." });
        });
      } else if (form.dataset.acct === "contact") {
        var web = String(fd.get("website") || "").trim();
        if (web && !/^https:\/\//i.test(web)) { if (btn) btn.disabled = false; renderAccount(root, { err: "Website must start with https://" }); return; }
        A.api(cfg, me.session, "owner_contacts?on_conflict=user_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({ user_id: me.session.user.id, email: String(fd.get("email") || "").trim() || null, phone: String(fd.get("phone") || "").trim() || null, website: web || null,
            email_visible: fd.get("email_visible") === "1", phone_visible: fd.get("phone_visible") === "1", website_visible: fd.get("website_visible") === "1" })
        }, f).then(function (r) {
          if (r.ok && r.data && r.data[0]) contact = r.data[0];
          renderAccount(root, r.ok ? { ok: "Contact info saved." } : { err: String(r.error || "").replace(/^.*?: /, "") || "Couldn't save." });
        });
      }
    });
    root.addEventListener("change", function (e) {
      if (e.target.name !== "paused" || !e.target.closest("[data-acct=notify]")) return;
      var form = e.target.form;
      form.querySelector(".nf-groups").classList.toggle("paused", e.target.checked);
      form.querySelectorAll(".nf-groups input, .nf-groups select").forEach(function (x) { x.disabled = e.target.checked; });
    });
    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-acct='signout']");
      if (!b) return;
      A.signOut(cfg, opts()).then(function () { me = null; refreshNav(); renderAccount(root, { ok: "Signed out." }); });
    });
  }

  // ---- #commish ------------------------------------------------------------
  var cm = { teams: [], invites: [], managers: [], accounts: [], keep: null, shadow: [], msg: null };

  function loadCommish() {
    var s = me.session;
    return Promise.all([
      A.api(cfg, s, "teams?select=id,name,division&order=id", {}, f),
      A.api(cfg, s, "invites?select=email,team_id,is_commissioner,invited_at,accepted_at&order=invited_at", {}, f),
      A.api(cfg, s, "team_managers?select=team_id,user_id,profiles(display_name)&order=team_id", {}, f),
      A.api(cfg, s, "rpc/keepalive_status", { method: "POST", body: "{}" }, f),
      A.api(cfg, s, "profiles?select=id,display_name,is_commissioner&order=display_name", {}, f),
      A.api(cfg, s, "invites?select=email,user_id&user_id=not.is.null", {}, f),
      A.api(cfg, s, "pool_imports?season=eq." + Number(L.season) + "&select=week,status,source,attempts,attempted_at,succeeded_at,picks,teams,replaced_test,message,compare,triggered_by&order=week.desc", {}, f),
      A.api(cfg, s, "shadow_results?season=eq." + Number(L.season) + "&select=week,team_id,mfl_score,our_score,matched,details&order=week,team_id", {}, f),
      A.api(cfg, s, "live_compare?season=eq." + Number(L.season) + "&select=week,team_id,our_points,mfl_points,players,diff_since,checked_at&order=week.desc,team_id&limit=36", {}, f),
      A.api(cfg, s, "board_settings?select=auto_recap,auto_awards", {}, f),
      A.api(cfg, s, "board_threads?source_key=like.announcement:*&select=id,source_key", {}, f),
      A.api(cfg, s, "league_settings?select=max_owners_per_team", {}, f),
      A.api(cfg, s, "email_log?select=at,user_id,kind,status,reason,attempt&order=at.desc&limit=60", {}, f),
      A.api(cfg, s, "nfl_games?season=eq." + Number(L.season) + "&select=week,kickoff", {}, f),
      A.api(cfg, s, "rpc/notify_usage", { method: "POST", body: "{}" }, f),
      A.api(cfg, s, "email_log?status=eq.sent&at=gte." + encodeURIComponent(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()) + "&select=at", {}, f)
    ]).then(function (r) {
      cm.emailLog = (r[12] && r[12].ok && r[12].data) || [];
      cm.week = window.B5TeamPage ? window.B5TeamPage.currentWeek((r[13] && r[13].ok && r[13].data) || []) : null;
      cm.usage = (r[14] && r[14].ok && r[14].data) || [];
      var sentMonth = (r[15] && r[15].ok && r[15].data) || [], today = new Date().toISOString().slice(0, 10);
      cm.emailCounts = { month: sentMonth.length, day: sentMonth.filter(function (x) { return String(x.at).slice(0, 10) === today; }).length };
      cm.maxOwners = (r[11] && r[11].ok && r[11].data && r[11].data[0] && r[11].data[0].max_owners_per_team) || 2;
      cm.board = (r[9] && r[9].ok && r[9].data && r[9].data[0]) || null;
      cm.crossposted = {};
      ((r[10] && r[10].ok && r[10].data) || []).forEach(function (t) { cm.crossposted[t.source_key] = t.id; });
      var lc = (r[8] && r[8].ok && r[8].data) || [];
      cm.live = lc.filter(function (x) { return x.week === (lc[0] || {}).week; });
      cm.poolImports = (r[6] && r[6].ok && r[6].data) || [];
      cm.shadow = (r[7] && r[7].ok && r[7].data) || [];
      cm.teams = r[0].data || []; cm.invites = r[1].data || []; cm.managers = r[2].data || []; cm.keep = r[3].ok ? r[3].data : null;
      // Signed-up accounts, labelled with their invite email (the commissioner's own account included).
      var emails = {};
      (r[5].data || []).forEach(function (i) { emails[i.user_id] = i.email; });
      if (me.session.user.email) emails[me.session.user.id] = me.session.user.email;
      cm.accounts = (r[4].data || []).map(function (p) {
        return { id: p.id, label: (p.display_name || "(no name)") + (emails[p.id] ? " (" + emails[p.id] + ")" : "") + (p.id === me.session.user.id ? " · you" : "") };
      });
      var bad = r.filter(function (x) { return !x.ok; });
      if (bad.length) cm.msg = { err: "Some data didn't load: " + bad[0].error };
      return cm.week ? A.api(cfg, s, "rpc/lineup_status", { method: "POST", body: JSON.stringify({ p_season: Number(L.season), p_week: cm.week }) }, f)
        .then(function (x) { cm.lineups = (x.ok && x.data) || []; }) : null;
    });
  }

  // This week's lineups: submitted or not, "Email lineup to owners", reminders to the rest.
  function lineupsHtml() {
    if (!cm.week || !window.B5TeamPage) return "";
    var missing = (cm.lineups || []).filter(function (x) { return !x.submitted_at; }).length;
    return '<div class="card"><h3>Lineups, week ' + esc(cm.week) + '</h3><ul class="checks cm-lineups">' + (cm.lineups || []).map(function (x) {
      return "<li>" + tlink(x.team_id) + ' <span class="muted small">' + esc(window.B5TeamPage.submittedText(x, Number(L.season))) + "</span> " +
        '<button class="linkish" type="button" data-cm="email-lineup" data-team="' + esc(x.team_id) + '">Email lineup to owners</button></li>';
    }).join("") + "</ul>" +
      '<button class="btn ghost" type="button" data-cm="lineup-reminders"' + (missing ? "" : " disabled") + ">Email reminder to teams that haven't submitted (" + missing + ")</button>" +
      '<p class="muted small">Sent as commissioner messages (owners can turn those off). Both actions are in the audit log.</p></div>';
  }

  var tlink = function (id) { return id ? window.B5Team.link(id, { logo: false }) : ""; };
  function plainTeam(id) {
    if (window.B5Team.has(id)) return window.B5Team.name(id);
    return id || "";
  }

  // Email log (email_log: type, recipient, time, status; never contents). Resend free tier: 100/day, 3,000/month.
  function emailLogHtml() {
    var c = cm.emailCounts || { day: 0, month: 0 }, names = {};
    (cm.accounts || []).forEach(function (a) { names[a.id] = a.label || a.id; });
    var who = function (u) { return u ? names[u] || "account " + String(u).slice(0, 8) : "deleted account"; };
    var kinds = { dm: "Direct message", mentions: "@mention", trades: "Trade", waivers: "Waivers", announcements: "Announcement", lineup: "Lineup reminder" };
    var rows = (cm.emailLog || []).map(function (x) {
      return "<tr><td>" + esc(et(x.at)) + "</td><td>" + esc(kinds[x.kind] || x.kind) + "</td><td>" + esc(who(x.user_id)) + "</td><td>" +
        (x.status === "sent" ? "Sent" : x.status === "failed" ? '<b class="po-owe">Failed</b>' + (x.attempt > 1 ? " (retry)" : "") : '<span class="muted">Skipped</span>') +
        (x.reason ? ' <span class="muted small">' + esc(x.reason) + "</span>" : "") + "</td></tr>";
    }).join("");
    var u = {}; (cm.usage || []).forEach(function (x) { u[x.priority] = x.today; });
    var near = c.day >= 60 ? '<p class="acct-msg err">Near the free-tier daily limit (' + esc(c.day) + " of 95 today). Scoring digests pause at 60, lineup emails at 75, waiver and league emails at 85; DMs, trades and commissioner messages may use up to 95.</p>"
      : c.month >= 2400 ? '<p class="acct-msg err">Near the monthly limit (' + esc(c.month) + " of 2,900). Lower-priority emails pause first.</p>" : "";
    return '<div class="card"><h3>Email notifications</h3>' + near + '<p class="small">Sent today: <b>' + esc(c.day) + "</b> of 95 · this month: <b>" + esc(c.month) + "</b> of 2,900 (Resend's free plan: 100 a day, 3,000 a month).</p>" +
      '<p class="muted small">Today by priority: DMs/trades/commissioner ' + esc(u[1] || 0) + " · waivers/league " + esc(u[2] || 0) + " · lineups " + esc(u[3] || 0) + " · scoring " + esc(u[4] || 0) + ".</p>" +
      (rows ? '<details><summary>Latest ' + (cm.emailLog || []).length + ' (type, recipient, status; never the contents)</summary><div class="table-wrap"><table class="cm-table"><thead><tr><th>When</th><th>Type</th><th>To</th><th>Status</th></tr></thead><tbody>' + rows + "</tbody></table></div></details>"
        : '<p class="muted small">No emails yet.</p>') + "</div>";
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

    var shadow = shadowHtml(cm.shadow);
    var teamOpts = '<option value="">No team</option>' + cm.teams.map(function (t) { return window.B5Team.option(t.id); }).join("");
    var seedTeams = cm.teams.length ? "" :
      '<p class="acct-msg err">No teams in the database yet. <button class="btn ghost" type="button" data-cm="seed-teams">Add the ' + esc(window.B5Team.ids().length) + " teams from the site</button></p>";

    var invites = cm.invites.length ? '<div class="table-wrap"><table class="cm-table"><thead><tr><th>Email</th><th>Team</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
      cm.invites.map(function (i) {
        return "<tr><td>" + esc(i.email) + "</td><td>" + tlink(i.team_id) + "</td><td>" + (i.is_commissioner ? "Commissioner" : "Manager") +
          "</td><td>" + (i.accepted_at ? '<span class="tag">Joined</span> ' + esc(et(i.accepted_at)) : "Invited " + esc(et(i.invited_at)) + '<br><span class="muted small">Not signed in yet</span>') + "</td>" +
          '<td class="cm-actions"><button class="btn ghost" type="button" data-cm="send" data-email="' + esc(i.email) + '">Send link</button>' +
          '<button class="btn ghost" type="button" data-cm="remove-invite" data-email="' + esc(i.email) + '">Remove</button></td></tr>';
      }).join("") + "</tbody></table></div>" : '<p class="muted">No invites yet.</p>';

    var assign = cm.teams.length && cm.accounts.length
      ? '<form class="acct-form cm-assign" data-cm="assign">' +
        '<label>Account<select name="user_id" required><option value="">Pick an account</option>' + cm.accounts.map(function (a) {
          return '<option value="' + esc(a.id) + '">' + esc(a.label) + "</option>";
        }).join("") + "</select></label>" +
        '<label>Team<select name="team_id" required><option value="">Pick a team</option>' + cm.teams.map(function (t) { return window.B5Team.option(t.id); }).join("") + "</select></label>" +
        '<button class="btn" type="submit">Assign team</button>' +
        '<p class="muted small">Works for your own account too. As a team\'s manager you follow the same lineup rules as everyone else; commissioner changes that touch your team are written to the audit log.</p></form>'
      : "";
    // One line per team: "Mac Daddies — Adam & Mike", each owner removable on his own.
    var byTeam = {}, maxOwners = cm.maxOwners || 2;
    cm.managers.forEach(function (x) { (byTeam[x.team_id] = byTeam[x.team_id] || []).push(x); });
    var mgrs = cm.managers.length ? '<ul class="checks">' + Object.keys(byTeam).sort().map(function (team) {
      var list = byTeam[team];
      var names = list.map(function (x) { return (x.profiles && x.profiles.display_name) || "(no name)"; }).join(" & ");
      return "<li><b>" + tlink(team) + "</b> — " + esc(names) + (list.length >= maxOwners ? ' <span class="tag">' + list.length + "/" + maxOwners + " owners</span>" : "") +
        "<ul>" + list.map(function (x) {
          var who = cm.accounts.filter(function (a) { return a.id === x.user_id; })[0];
          return "<li>" + esc(who ? who.label : (x.profiles && x.profiles.display_name) || x.user_id) +
            ' <button class="linkish" type="button" data-cm="unassign" data-team="' + esc(x.team_id) + '" data-user="' + esc(x.user_id) + '">remove from team</button></li>';
        }).join("") + "</ul></li>";
    }).join("") + "</ul>" + '<p class="muted small">Up to ' + esc(maxOwners) + " owners per team, each with his own login; an account owns one team. Removing one owner leaves the other.</p>"
      : '<p class="muted">No managers have joined yet.</p>';

    root.innerHTML = "<section><h2>Commissioner</h2>" + m + poolImportHtml(cm.poolImports || []) + '<div class="card"><h3>Payouts</h3><p>Fees, payouts, manual awards, overrides and CSV export: <a href="#commish-payouts">open the payout tools</a>.</p></div>' + keep + lineupsHtml() + emailLogHtml() + boardHtml() + liveCompareHtml(cm.live || []) + shadow +
      '<div class="card"><h3>Invite a manager</h3>' + seedTeams +
      '<form class="acct-form" data-cm="invite">' +
      '<label>Email<input name="email" type="email" autocomplete="off" required></label>' +
      '<label>Team<select name="team_id">' + teamOpts + "</select></label>" +
      '<label class="acct-check"><input type="checkbox" name="is_commissioner"> Commissioner</label>' +
      '<label class="acct-check"><input type="checkbox" name="send" checked> Email a sign-in link now</label>' +
      '<button class="btn" type="submit">Add invite</button></form>' +
      '<p class="muted small">Only invited emails can create an account. Their team and role are applied when they first sign in. Inviting to a team that already has an owner adds a co-owner (up to ' + esc(cm.maxOwners || 2) + " per team). " +
      "Removing an invite stops new sign-ups; to cut off someone who already joined, also remove them from their team.</p></div>" +
      '<div class="card"><h3>Invites</h3>' + invites + "</div>" +
      '<div class="card"><h3>Team managers</h3>' + mgrs + assign + "</div></section>";
  }

  // Confidence Pool official import (2026 test mode): one row per week, newest first.
  function poolImportHtml(rows) {
    var latest = rows.slice().sort(function (a, b) { return Date.parse(b.attempted_at) - Date.parse(a.attempted_at); })[0];
    var warn = latest && latest.status === "failed"
      ? '<p class="acct-msg err"><b>Import failed</b> for week ' + esc(latest.week) + " (" + esc(et(latest.attempted_at)) + "): " + esc(latest.message) + ". The test picks were kept; it retries every hour today.</p>" : "";
    var list = rows.length ? '<ul class="checks">' + rows.map(function (x) {
      var c = x.compare || {}, mm = c.mismatches || [];
      return "<li><b>Week " + esc(x.week) + "</b>: " + (x.status === "ok" ? '<span class="tag">Imported</span> ' : '<span class="tag cm-bad">Failed</span> ') + esc(et(x.succeeded_at || x.attempted_at)) +
        (x.attempts > 1 ? " (" + esc(x.attempts) + " attempts)" : "") + '<br><span class="muted small">' + esc(x.message || "") + "</span>" +
        (mm.length ? "<ul>" + mm.map(function (z) { return "<li>" + tlink(z.team_id) + " " + esc(z.what) + " total: ours " + esc(z.ours) + ", MFL " + esc(z.mfl) + "</li>"; }).join("") + "</ul>" : "") + "</li>";
    }).join("") + "</ul>" : '<p class="muted">No imports yet.</p>';
    return '<div class="card"><h3>Confidence Pool: official MFL import</h3>' + warn +
      '<p class="muted small">Tuesdays 6:00 AM ET the official MFL picks replace the TEST picks for the week that just finished; then our totals are checked against MFL\'s results.</p>' +
      '<form class="po-inline" data-cm="pool-import"><label>Week <input name="week" type="number" min="1" max="18" placeholder="latest"></label>' +
      '<button class="btn" type="submit">Run import now</button></form>' + list + "</div>";
  }

  // Message board: B5 Bot toggles and announcement cross-posts (home-page announcements live in league-data.js).
  var annKey = function (a) { return "announcement:" + a.date + ":" + String(a.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60); };
  function boardHtml() {
    if (!cm.board) return "";
    var tog = function (k, label) { return '<label class="acct-check"><input type="checkbox" data-cm="board-toggle" data-key="' + k + '"' + (cm.board[k] ? " checked" : "") + "> " + label + "</label>"; };
    var anns = (L.announcements || []).map(function (a) {
      var key = annKey(a), t = cm.crossposted[key];
      return "<li><b>" + esc(a.title) + '</b> <span class="muted small">' + esc(a.date) + "</span> " +
        (t ? '<a href="#board/' + esc(t) + '">On the board</a>' : '<button class="btn ghost" data-cm="crosspost" data-key="' + esc(key) + '">Cross-post to board</button>') + "</li>";
    }).join("");
    return '<div class="card"><h3>Message board</h3><p class="muted small">B5 Bot posts after the nightly job: the weekly recap once a week is final, and payout awards as they become final.</p>' +
      tog("auto_recap", "Weekly results recap (high score, guillotine, biggest blowout, closest game)") + tog("auto_awards", "Payout awards as they become final") +
      (anns ? '<h4>Home-page announcements</h4><ul class="checks">' + anns + "</ul>" : "") + "</div>";
  }

  // Live check during games (2026): our live totals vs MFL's live scoring, per team and starter.
  // MFL's live numbers can trail ours by a few minutes, so a difference that lasts is the one to look at.
  function liveCompareHtml(rows) {
    if (!rows.length) return '<div class="card"><h3>Live scoring vs MFL</h3><p class="muted">No live comparison yet. It runs during games (and every 15 minutes before kickoffs).</p></div>';
    var n = function (x) { return x == null ? "–" : Number(x).toFixed(2).replace(/\.?0+$/, ""); };
    var mins = function (iso) { return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); };
    var diff = rows.filter(function (x) { return x.diff_since; });
    var items = rows.map(function (x) {
      var p = x.players || [];
      return "<li><b>" + tlink(x.team_id) + "</b>: ours " + esc(n(x.our_points)) + ", MFL " + esc(n(x.mfl_points)) +
        (x.diff_since ? ' <span class="tag cm-bad">Differs for ' + esc(mins(x.diff_since)) + " min</span>" : ' <span class="tag">Match</span>') +
        (p.length ? "<ul>" + p.map(function (z) {
          return "<li>" + esc(z.name || z.mfl_id || z.player_id) + ": ours " + esc(n(z.ours)) + ", MFL " + esc(n(z.mfl)) +
            (z.ours == null ? " (MFL starter we can't map)" : z.mfl == null ? " (our starter, not MFL's)" : "") + "</li>";
        }).join("") + "</ul>" : "") + "</li>";
    }).join("");
    return '<div class="card"><h3>Live scoring vs MFL (week ' + esc(rows[0].week) + ")</h3>" +
      '<p class="' + (diff.length ? "acct-msg err" : "acct-msg ok") + '">' + (diff.length ? esc(diff.length) + " of " + esc(rows.length) + " teams differ from MFL's live scoring." : "All " + esc(rows.length) + " teams match MFL's live scoring.") +
      " Checked " + esc(et(rows[0].checked_at)) + ".</p>" +
      '<p class="muted small">MFL is official for ' + esc(L.season) + ". MFL's live numbers can lag ours by a few minutes; a difference that lasts is worth a look.</p>" +
      '<details><summary>Every team</summary><ul class="checks">' + items + "</ul></details></div>";
  }

  // Shadow mode (2026): our engine's team totals vs MFL's, per week, with every difference explained.
  function shadowHtml(rows) {
    if (!rows.length) return '<div class="card"><h3>Shadow scoring vs MFL</h3><p class="muted">No weeks compared yet. The nightly job fills this in.</p></div>';
    var weeks = {};
    rows.forEach(function (r) { (weeks[r.week] = weeks[r.week] || []).push(r); });
    var nums = Object.keys(weeks).map(Number).sort(function (a, b) { return a - b; });
    var streak = 0;
    for (var i = nums.length - 1; i >= 0 && weeks[nums[i]].every(function (r) { return r.matched; }); i--) streak++;
    var fmt = function (n) { return Number(n).toFixed(2).replace(/\.?0+$/, ""); };
    var body = nums.map(function (w) {
      var rs = weeks[w], bad = rs.filter(function (r) { return !r.matched || (r.details && r.details.diffs && r.details.diffs.length); });
      var head = "Week " + w + ": " + rs.filter(function (r) { return r.matched; }).length + "/" + rs.length + " teams match";
      if (!bad.length) return '<li><span class="tag">Exact</span> ' + esc(head) + "</li>";
      return '<li><details><summary><span class="tag cm-bad">Check</span> ' + esc(head) + "</summary>" + bad.map(function (r) {
        var d = r.details || {};
        return "<p><b>" + tlink(r.team_id) + "</b>: ours " + esc(fmt(r.our_score)) + " vs MFL " + esc(fmt(r.mfl_score)) + "</p><ul>" +
          (d.diffs || []).map(function (x) {
            return "<li>" + esc(x.name) + " (" + esc(x.position || "?") + "): ours " + esc(fmt(x.ours)) + " vs MFL " + esc(fmt(x.mfl)) +
              (x.note ? " · " + esc(x.note) : "") +
              (x.lines && x.lines.length ? '<br><span class="muted small">' + esc(x.lines.map(function (l) { return l.stat + " " + l.value + " = " + l.points; }).join(", ")) + "</span>" : "") +
              (x.plays || []).map(function (p) { return '<br><span class="muted small">▸ ' + esc(p) + "</span>"; }).join("") + "</li>";
          }).join("") + "</ul>";
      }).join("") + "</details></li>";
    }).join("");
    return '<div class="card"><h3>Shadow scoring vs MFL</h3>' +
      '<p class="' + (streak >= 3 ? "acct-msg ok" : "muted") + '">' + esc(streak >= 3 ? "Matched MFL exactly for the last " + streak + " weeks: the scoring part of the invite bar is met."
        : streak + " straight exact week" + (streak === 1 ? "" : "s") + " (the invite bar needs 3, or every difference explained).") + "</p>" +
      '<ul class="checks">' + body + "</ul>" +
      '<p class="muted small">Our engine scores MFL\'s starters from nflverse stats; MFL stays official for 2026. A week appears once MFL posts its scores.</p></div>';
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
      var pf = e.target.closest("[data-cm='pool-import']");
      if (pf) {
        e.preventDefault();
        var wk = new FormData(pf).get("week");
        act(A.api(cfg, me.session, "rpc/run_pool_import", { method: "POST", body: JSON.stringify(wk ? { p_week: Number(wk) } : {}) }, f).then(function (r) {
          if (!r.ok) return r;
          setTimeout(function () { if (location.hash === "#commish") redraw(); }, 20000);   // results land in about 10-20 s
          return { msgOk: (r.data || "Import requested") + ". Results appear here in a few seconds." };
        }));
        return;
      }
      var af = e.target.closest("[data-cm='assign']");
      if (af) {
        e.preventDefault();
        var ad = new FormData(af), row = { team_id: ad.get("team_id"), user_id: ad.get("user_id") };
        act(A.api(cfg, me.session, "team_managers", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } }, f).then(function (r) {
          if (!r.ok) return { ok: false, error: /duplicate|unique/i.test(r.error) ? "That account already manages " + plainTeam(row.team_id) + "." : r.error };
          return { msgOk: "Assigned to " + plainTeam(row.team_id) + "." };
        }).then(function (r) { return load().then(function () { refreshNav(); return r; }); }));
        return;
      }
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

    root.addEventListener("change", function (e) {
      var t = e.target.closest("[data-cm='board-toggle']");
      if (!t) return;
      var patch = {}; patch[t.dataset.key] = t.checked; patch.updated_at = new Date().toISOString();
      act(A.api(cfg, me.session, "board_settings?id=eq.true", { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } }, f)
        .then(function (r) { return r.ok ? { msgOk: "Saved." } : r; }));
    });

    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cm]");
      if (!b || b.tagName === "FORM" || b.dataset.cm === "board-toggle") return;
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
        if (!window.confirm("Remove this manager from " + plainTeam(b.dataset.team) + "?")) return;
        act(A.api(cfg, me.session, "team_managers?team_id=eq." + encodeURIComponent(b.dataset.team) + "&user_id=eq." + encodeURIComponent(b.dataset.user), { method: "DELETE" }, f)
          .then(function (r) { return r.ok ? { msgOk: "Manager removed from the team." } : r; }));
      } else if (kind === "crosspost") {
        var a = (L.announcements || []).filter(function (x) { return annKey(x) === b.dataset.key; })[0];
        if (!a) return;
        b.disabled = true;
        var text = window.B5Board ? window.B5Board.htmlToText(a.body) : "";
        var imgs = a.image && /^https:\/\//.test(a.image) ? [a.image] : [];
        act(A.api(cfg, me.session, "rpc/board_new_thread", { method: "POST", body: JSON.stringify({ p_title: a.title, p_body: text || a.title, p_images: imgs, p_source_key: b.dataset.key }) }, f)
          .then(function (r) { return r.ok ? { msgOk: "Posted to the board." } : r; }));
      } else if (kind === "email-lineup") {
        b.disabled = true;
        act(A.api(cfg, me.session, "rpc/commish_email_lineup", { method: "POST", body: JSON.stringify({ p_season: Number(L.season), p_week: cm.week, p_team: b.dataset.team }) }, f)
          .then(function (r) { return r.ok ? { msgOk: "Lineup email queued for " + r.data + " owner(s) of " + plainTeam(b.dataset.team) + "." } : r; }));
      } else if (kind === "lineup-reminders") {
        if (!window.confirm("Email a reminder to every team that hasn't submitted its week " + cm.week + " lineup?")) return;
        b.disabled = true;
        act(A.api(cfg, me.session, "rpc/commish_lineup_reminders", { method: "POST", body: JSON.stringify({ p_season: Number(L.season), p_week: cm.week }) }, f)
          .then(function (r) { return r.ok ? { msgOk: "Reminder queued: " + r.data + " email(s)." } : r; }));
      } else if (kind === "seed-teams") {
        var divs = {};
        (L.divisions || []).forEach(function (d) { divs[d.id] = d.name; });
        var rows = window.B5Team.seedRows().map(function (t) { return { id: t.id, name: t.name, division: divs[t.division] || t.division, logo_url: t.logo }; });   // teamlink-ok: commissioner's one-time seeding of the teams table
        act(A.api(cfg, me.session, "teams", { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "resolution=merge-duplicates,return=minimal" } }, f)
          .then(function (r) { return r.ok ? { msgOk: "Added " + rows.length + " teams." } : r; }));
      }
    });
  }

  // { team_id: "Name, Name" } for signed-in league members (RLS hides managers from everyone else).
  function managerNames() {
    if (!me) return Promise.resolve({});
    return A.api(cfg, me.session, "team_managers?select=team_id,profiles(display_name)", {}, f).then(function (r) {
      var out = {};
      (r.ok && r.data || []).forEach(function (x) {
        var n = x.profiles && x.profiles.display_name;
        if (n) out[x.team_id] = out[x.team_id] ? out[x.team_id] + " & " + n : n;   // co-owners: "Adam & Mike"
      });
      return out;
    }, function () { return {}; });
  }

  /** #unsubscribe/<token>: turns one email type off from the email's link, without signing in. */
  function unsubscribe(root, token) {
    root.innerHTML = '<section><h2>Email notifications</h2><div class="card"><p class="muted">One moment…</p></div></section>';
    if (!ready()) return;
    var labels = { dm: "direct message", mentions: "@mention", trades: "trade", waivers: "waiver result", announcements: "announcement", lineup: "lineup reminder" };
    A.api(cfg, null, "rpc/notify_unsubscribe", { method: "POST", body: JSON.stringify({ p_token: token }) }, f).then(function (r) {
      root.innerHTML = '<section><h2>Email notifications</h2><div class="card">' + (r.ok
        ? "<p><b>Done.</b> You won't get " + esc(labels[r.data] || "these") + " emails from B5 anymore.</p><p class=\"muted\">Change any email setting under <a href=\"#account/email\">Account</a> (sign in first).</p>"
        : '<p class="acct-msg err">That link didn\'t work. It may be incomplete.</p><p class="muted">Sign in and use <a href="#account">Account</a> &gt; Email notifications instead.</p>') + "</div></section>";
    });
  }

  // "Active on the site" for email notifications: a heartbeat every minute while a page is visible
  // (public.notify_seen). DM and @mention emails skip you while you're here.
  var seenTimer = null;
  function presence() {
    if (seenTimer || !ready()) return;
    var beat = function () {
      if (document.visibilityState !== "visible") return;
      load().then(function (m) { if (m && m.session && (m.teams.length || (m.profile && m.profile.is_commissioner))) A.api(cfg, m.session, "rpc/notify_seen", { method: "POST", body: "{}" }, f); }, function () {});
    };
    seenTimer = setInterval(beat, 60000);
    document.addEventListener("visibilitychange", beat);
    beat();
  }

  window.B5Account = {
    start: function (page, root) {
      if (page === "account") startAccount(root);
      else if (page === "commish") startCommish(root);
    },
    unsubscribe: unsubscribe,
    presence: presence,
    refreshNav: refreshNav,
    managerNames: managerNames,
    load: load
  };

  // Set the nav for whoever is signed in.
  load().then(refreshNav, refreshNav);
})();
