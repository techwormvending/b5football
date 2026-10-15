/* Supabase Auth for the static site: magic-link sign-in, session storage,
   token refresh, sign-out, and authenticated Data API calls. No dependencies.

   Flow: the visitor enters an email -> POST /auth/v1/otp sends a magic link
   (Supabase custom SMTP via Resend, sender noreply@b5football.win). The link
   returns to this site with tokens in the URL fragment (#access_token=...).
   This script runs BEFORE app.js, saves the session and replaces the fragment
   with a normal route, so the hash router never sees the tokens.

   The league is invite-only: Supabase's "Before User Created" hook rejects
   emails that aren't in public.invites (see supabase/migrations).

   The session is stored the way supabase-js stores it ("sb-<ref>-auth-token"
   in localStorage) so other scripts (keepalive-check.js) can read it. */
(function (root) {
  "use strict";

  function ref(cfg) {
    var m = (cfg && cfg.url || "").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
    return m ? m[1] : null;
  }
  function storageKey(cfg) { return "sb-" + ref(cfg) + "-auth-token"; }

  function getSession(cfg, storage) {
    try {
      var raw = storage && storage.getItem(storageKey(cfg));
      var s = raw ? JSON.parse(raw) : null;
      return s && s.access_token ? s : null;
    } catch (e) { return null; }
  }
  function saveSession(cfg, storage, s) {
    try { storage.setItem(storageKey(cfg), JSON.stringify(s)); } catch (e) { /* private mode: session lasts this page only */ }
  }
  function clearSession(cfg, storage) {
    try { storage.removeItem(storageKey(cfg)); } catch (e) { /* ignore */ }
  }

  /** Decode the JWT payload (no verification; the server verifies every request). */
  function claims(token) {
    try {
      var p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      var json = typeof atob === "function" ? decodeURIComponent(escape(atob(p))) : Buffer.from(p, "base64").toString("utf8");
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  /** Parse the magic-link return fragment. Returns {session} | {error} | null (not an auth fragment). */
  function fromFragment(hash, now) {
    var h = (hash || "").replace(/^#/, "");
    if (!/(^|&)(access_token|error|error_description)=/.test(h)) return null;
    var q = {};
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " "));
    });
    if (q.error || q.error_description) {
      return { error: q.error_description || q.error };
    }
    var expiresIn = Number(q.expires_in) || 3600;
    var c = claims(q.access_token);
    return {
      session: {
        access_token: q.access_token,
        refresh_token: q.refresh_token || "",
        token_type: q.token_type || "bearer",
        expires_in: expiresIn,
        expires_at: Number(q.expires_at) || Math.floor(now / 1000) + expiresIn,
        user: { id: c.sub || "", email: c.email || "" }
      }
    };
  }

  function friendlyError(status, body) {
    var msg = (body && (body.msg || body.message || body.error_description || body.error)) || "";
    if (/invite-only/i.test(msg)) return "That email isn't on the league's invite list. Ask the commissioner.";
    if (status === 429 || /rate limit|only request this/i.test(msg)) return "Too many sign-in emails. Wait a minute, then try again.";
    if (/signups? not allowed/i.test(msg)) return "That email isn't on the league's invite list. Ask the commissioner.";
    return msg ? "Sign-in failed: " + msg : "Sign-in failed (HTTP " + status + "). Try again.";
  }

  /** Email a magic link. Resolves {ok:true} or {ok:false, error}. Never throws. */
  function requestLink(cfg, email, redirectTo, fetchImpl) {
    var e = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return Promise.resolve({ ok: false, error: "Enter a valid email address." });
    var url = cfg.url + "/auth/v1/otp" + (redirectTo ? "?redirect_to=" + encodeURIComponent(redirectTo) : "");
    return fetchImpl(url, {
      method: "POST",
      headers: { apikey: cfg.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: e, create_user: true })
    }).then(function (res) {
      if (res.ok) return { ok: true };
      return res.json().catch(function () { return {}; }).then(function (b) { return { ok: false, error: friendlyError(res.status, b) }; });
    }).catch(function () { return { ok: false, error: "Couldn't reach the sign-in service. Check your connection." }; });
  }

  /** Current session, refreshed if it expires within a minute. Resolves null when signed out. */
  function current(cfg, opts) {
    var s = getSession(cfg, opts.storage);
    if (!s) return Promise.resolve(null);
    if (s.expires_at * 1000 - opts.now > 60000) return Promise.resolve(s);
    if (!s.refresh_token) { clearSession(cfg, opts.storage); return Promise.resolve(null); }
    return opts.fetchImpl(cfg.url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: cfg.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(function (res) {
      if (!res.ok) {
        // 4xx = refresh token revoked/expired: signed out. Network/5xx: keep the session for later.
        if (res.status >= 400 && res.status < 500) clearSession(cfg, opts.storage);
        return res.status >= 500 ? s : null;
      }
      return res.json().then(function (b) {
        var n = {
          access_token: b.access_token, refresh_token: b.refresh_token || s.refresh_token,
          token_type: b.token_type || "bearer", expires_in: b.expires_in || 3600,
          expires_at: b.expires_at || Math.floor(opts.now / 1000) + (b.expires_in || 3600),
          user: { id: (b.user && b.user.id) || s.user.id, email: (b.user && b.user.email) || s.user.email }
        };
        saveSession(cfg, opts.storage, n);
        return n;
      });
    }).catch(function () { return s.expires_at * 1000 > opts.now ? s : null; });
  }

  function signOut(cfg, opts) {
    var s = getSession(cfg, opts.storage);
    clearSession(cfg, opts.storage);
    if (!s) return Promise.resolve();
    return opts.fetchImpl(cfg.url + "/auth/v1/logout", {
      method: "POST",
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + s.access_token }
    }).then(function () {}, function () {});
  }

  /** Data API call as the signed-in user (or anon without a session). Resolves {ok, status, data, error}. */
  function api(cfg, session, path, init, fetchImpl) {
    init = init || {};
    var headers = { apikey: cfg.publishableKey, "Content-Type": "application/json" };
    if (session) headers.Authorization = "Bearer " + session.access_token;
    for (var k in (init.headers || {})) headers[k] = init.headers[k];
    return fetchImpl(cfg.url + "/rest/v1/" + path, { method: init.method || "GET", headers: headers, body: init.body })
      .then(function (res) {
        return res.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
          return res.ok ? { ok: true, status: res.status, data: data }
            : { ok: false, status: res.status, data: null, error: (data && (data.message || data.msg)) || ("HTTP " + res.status) };
        });
      }).catch(function () { return { ok: false, status: 0, data: null, error: "Network error" }; });
  }

  root.B5Auth = {
    storageKey: storageKey, getSession: getSession, saveSession: saveSession, clearSession: clearSession,
    claims: claims, fromFragment: fromFragment, requestLink: requestLink, current: current, signOut: signOut, api: api
  };

  // Browser: consume a magic-link return before app.js routes, both on page load
  // and when the link is opened in a tab that already has the site (hash change only).
  // This listener is registered before app.js's, so it runs first.
  if (typeof window !== "undefined" && window.location && window.B5_SUPABASE) {
    var store = null;
    try { store = window.localStorage; } catch (e) { store = null; }
    var consume = function () {
      var r = fromFragment(window.location.hash, Date.now());
      if (!r) return;
      if (r.session) saveSession(window.B5_SUPABASE, store, r.session);
      root.B5AuthNotice = r.error ? { error: r.error } : { signedIn: true };
      var url = window.location.pathname + window.location.search + "#account";
      if (window.history && window.history.replaceState) window.history.replaceState(null, "", url);
      else window.location.hash = "#account";
    };
    consume();
    window.addEventListener("hashchange", consume);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
