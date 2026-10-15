/* Commissioner warning banner: shows when the Cloudflare keep-alive heartbeat
   (which stops the free Supabase database from pausing) is missing or more
   than 3 days old.

   Only the commissioner ever sees it. The database function
   public.keepalive_status() returns data only to the commissioner (null for
   everyone else; logged-out visitors can't call it). It needs a signed-in
   Supabase session, so it activates once site login exists: it reads the
   session supabase-js stores under "sb-<project ref>-auth-token". */
(function (root) {
  var STALE_MS = 3 * 24 * 3600 * 1000;
  var PRIMARY = "cloudflare-cron";

  function fmt(ms) {
    return new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
  }

  /** The banner text, or null when nothing is wrong (or the viewer isn't the commissioner). */
  function warning(status, now) {
    if (!status) return null;
    var list = status.heartbeats || [];
    var hb = null;
    for (var i = 0; i < list.length; i++) if (list[i].name === PRIMARY) hb = list[i];
    var tail = " The free Supabase database pauses after about 7 days without activity. Check the b5-keepalive Worker in Cloudflare (workers/keepalive).";
    if (!hb) return "Keep-alive warning: the Cloudflare keep-alive has never checked in." + tail;
    var at = Date.parse(hb.at);
    if (!(now - at > STALE_MS)) return null;
    var days = Math.floor((now - at) / (24 * 3600 * 1000));
    return "Keep-alive warning: the Cloudflare keep-alive last checked in " + days + " days ago (" + fmt(at) + ")." + tail;
  }

  /** Access token of the signed-in Supabase session, if any (and not expired). */
  function sessionToken(cfg, storage, now) {
    try {
      var ref = (cfg.url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];
      if (!ref || !storage) return null;
      var raw = storage.getItem("sb-" + ref + "-auth-token");
      if (!raw) return null;
      var s = JSON.parse(raw);
      var sess = s && s.currentSession ? s.currentSession : s;
      if (!sess || !sess.access_token) return null;
      if (sess.expires_at && sess.expires_at * 1000 <= now) return null;
      return sess.access_token;
    } catch (e) {
      return null;
    }
  }

  /** Ask the database; resolves to the banner text or null. Never throws. */
  function check(cfg, opts) {
    var now = opts.now;
    if (!cfg || !cfg.configured) return Promise.resolve(null);
    var token = sessionToken(cfg, opts.storage, now);
    if (!token) return Promise.resolve(null);
    return opts.fetchImpl(cfg.url + "/rest/v1/rpc/keepalive_status", {
      method: "POST",
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}"
    }).then(function (res) {
      return res.ok ? res.json().then(function (st) { return warning(st, now); }) : null;
    }).catch(function () { return null; });
  }

  function render(doc, msg) {
    if (!msg || doc.getElementById("keepalive-banner")) return;
    var el = doc.createElement("div");
    el.id = "keepalive-banner";
    el.className = "commish-banner";
    el.setAttribute("role", "alert");
    el.textContent = msg;
    doc.body.insertBefore(el, doc.body.firstChild);
  }

  root.B5Keepalive = { warning: warning, sessionToken: sessionToken, check: check, render: render, STALE_MS: STALE_MS };

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    var store = null;
    try { store = window.localStorage; } catch (e) { store = null; }
    check(window.B5_SUPABASE, { fetchImpl: window.fetch.bind(window), storage: store, now: Date.now() })
      .then(function (m) { if (m) render(document, m); });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
