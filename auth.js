/* Supabase Auth for the static site: email + password, 6-digit email codes, session storage,
   token refresh, sign-out, and authenticated Data API calls. No dependencies.

   Sign-in (2026-11-02; links broke in Safari and Apple Mail's in-app browser, so no more links):
   - Email + password: POST /auth/v1/token?grant_type=password.
   - "Email me a sign-in code": POST /auth/v1/otp sends a 6-digit code (the email templates show
     {{ .Token }}, see supabase/templates), typed on the same page: POST /auth/v1/verify (type email).
   - "Forgot password?": POST /auth/v1/recover emails a code; verify (type recovery) signs in, then
     PUT /auth/v1/user sets the new password. Setting a password from an old session may need a fresh
     code (Supabase's "secure password change": GET /auth/v1/reauthenticate emails one, sent as nonce).
   Sessions use refresh tokens, so a personal device stays signed in. Old magic-link fragments
   (#access_token=...) are still consumed before app.js routes, for links already in inboxes.

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

  // ---- Passwords and 6-digit codes (2026-11-02) -------------------------------------------------
  var post = function (cfg, path, body, fetchImpl, session, method) {
    var h = { apikey: cfg.publishableKey, "Content-Type": "application/json" };
    if (session) h.Authorization = "Bearer " + session.access_token;
    return fetchImpl(cfg.url + "/auth/v1/" + path, { method: method || "POST", headers: h, body: body == null ? undefined : JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { status: res.status, ok: res.ok, body: b }; }); },
            function () { return { status: 0, ok: false, body: { msg: "network" } }; });
  };
  /** Plain words for Auth errors. */
  function authError(r) {
    var b = r.body || {}, code = String(b.error_code || b.code || ""), msg = String(b.msg || b.message || b.error_description || b.error || "");
    if (r.status === 0) return "Couldn't reach the sign-in service. Check your connection.";
    if (r.status === 429 || /rate limit|over_.*_limit|too many/i.test(code + " " + msg)) return "Too many tries. Wait a few minutes, then try again.";
    if (/invite-only|signups? not allowed|signup_disabled/i.test(code + " " + msg)) return "That email isn't on the league's invite list. Ask the commissioner.";
    if (/invalid_credentials|invalid login credentials/i.test(code + " " + msg)) return "That password isn't right. Try again, or use \"Email me a sign-in code\".";
    if (/otp_expired|expired/i.test(code + " " + msg)) return "That code expired or isn't right. Send a new one.";
    if (/invalid.*(otp|token)|token.*invalid/i.test(code + " " + msg)) return "That code isn't right. Check the email, or send a new one.";
    if (/same_password|should be different/i.test(code + " " + msg)) return "That's already your password.";
    if (/weak_password|password should/i.test(code + " " + msg)) return "Pick a longer, less common password (at least 8 characters).";
    if (/reauthentication/i.test(code + " " + msg)) return "We need a fresh code to change your password.";
    if (/email_not_confirmed/i.test(code + " " + msg)) return "Use \"Email me a sign-in code\" the first time.";
    return msg ? "Sign-in problem: " + msg : "Sign-in failed (HTTP " + r.status + "). Try again.";
  }
  var normEmail = function (e) { return String(e || "").trim().toLowerCase(); };
  var validEmail = function (e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); };
  /** A session object from an Auth token response. */
  function sessionFrom(b, now) {
    var expiresIn = Number(b.expires_in) || 3600;
    return { access_token: b.access_token, refresh_token: b.refresh_token || "", token_type: b.token_type || "bearer", expires_in: expiresIn,
      expires_at: Number(b.expires_at) || Math.floor(now / 1000) + expiresIn, user: { id: (b.user && b.user.id) || "", email: (b.user && b.user.email) || "" } };
  }
  var signedIn = function (cfg, opts) { return function (r) {
    if (!r.ok || !r.body.access_token) return { ok: false, error: authError(r), code: r.body && (r.body.error_code || r.body.code) };
    var sess = sessionFrom(r.body, opts.now);
    saveSession(cfg, opts.storage, sess);
    return { ok: true, session: sess };
  }; };

  // Too many wrong passwords from this browser: a short pause (the server also rate-limits by IP).
  var LOCK_TRIES = 5, LOCK_MS = 5 * 60 * 1000;
  var lockKey = function (email) { return "b5-signin-fail:" + normEmail(email); };
  /** { locked, until, tries } for this email in this browser. */
  function lockState(storage, email, now) {
    try {
      var x = JSON.parse(storage.getItem(lockKey(email)) || "null");
      if (!x) return { locked: false, tries: 0 };
      if (x.until && x.until > now) return { locked: true, until: x.until, tries: x.tries };
      return { locked: false, tries: x.until ? 0 : x.tries };
    } catch (e) { return { locked: false, tries: 0 }; }
  }
  function noteFailure(storage, email, now) {
    var st = lockState(storage, email, now), tries = st.tries + 1;
    try { storage.setItem(lockKey(email), JSON.stringify({ tries: tries, until: tries >= LOCK_TRIES ? now + LOCK_MS : null })); } catch (e) { /* storage blocked */ }
    return tries >= LOCK_TRIES;
  }
  function clearFailures(storage, email) { try { storage.removeItem(lockKey(email)); } catch (e) { /* ignore */ } }

  /** Email + password. opts = { storage, fetchImpl, now }. */
  function signInPassword(cfg, email, password, opts) {
    var e = normEmail(email);
    if (!validEmail(e)) return Promise.resolve({ ok: false, error: "Enter a valid email address." });
    if (!password) return Promise.resolve({ ok: false, error: "Enter your password." });
    var lock = lockState(opts.storage, e, opts.now);
    if (lock.locked) return Promise.resolve({ ok: false, locked: true, error: "Too many wrong passwords. Wait " + Math.ceil((lock.until - opts.now) / 60000) + " minutes, or use \"Email me a sign-in code\"." });
    return post(cfg, "token?grant_type=password", { email: e, password: String(password) }, opts.fetchImpl).then(function (r) {
      var out = signedIn(cfg, opts)(r);
      if (out.ok) clearFailures(opts.storage, e);
      else if (r.status === 400 && noteFailure(opts.storage, e, opts.now)) out.error = "Too many wrong passwords. Wait 5 minutes, or use \"Email me a sign-in code\".";
      return out;
    });
  }
  /** Email a 6-digit sign-in code (invited emails get an account on the first one: the invite-only hook decides). */
  function sendCode(cfg, email, fetchImpl) {
    var e = normEmail(email);
    if (!validEmail(e)) return Promise.resolve({ ok: false, error: "Enter a valid email address." });
    return post(cfg, "otp", { email: e, create_user: true }, fetchImpl).then(function (r) { return r.ok ? { ok: true } : { ok: false, error: authError(r) }; });
  }
  /** Type the code: type "email" (sign-in / first sign-in of an invitee) or "recovery" (forgot password). */
  function verifyCode(cfg, email, code, type, opts) {
    var e = normEmail(email), c = String(code || "").replace(/\D/g, "");
    if (c.length < 6) return Promise.resolve({ ok: false, error: "Enter the 6-digit code from the email." });
    return post(cfg, "verify", { type: type || "email", email: e, token: c }, opts.fetchImpl).then(signedIn(cfg, opts));
  }
  /** Forgot password: email a reset code. */
  function sendResetCode(cfg, email, fetchImpl) {
    var e = normEmail(email);
    if (!validEmail(e)) return Promise.resolve({ ok: false, error: "Enter a valid email address." });
    return post(cfg, "recover", { email: e }, fetchImpl).then(function (r) { return r.ok ? { ok: true } : { ok: false, error: authError(r) }; });
  }
  // The most common passwords (blocked in addition to the 8-character minimum; no other rules).
  var COMMON = ("password password1 password12 password123 password1234 passw0rd p@ssw0rd 12345678 123456789 1234567890 11111111 00000000 87654321 " +
    "12341234 11223344 1q2w3e4r 1qaz2wsx qwertyui qwerty12 qwerty123 qwertyuiop asdfghjk asdfasdf zxcvbnm1 abcd1234 abc12345 abcdefgh " +
    "iloveyou iloveyou1 sunshine princess football football1 baseball basketball superman batman123 trustno1 letmein1 welcome1 welcome123 " +
    "monkey12 dragon12 master12 shadow12 starwars whatever freedom1 michael1 jennifer computer internet charlie1 steelers steelers1 " +
    "pittsburgh 696969 changeme changeme1 admin123 administrator default1 secret12 test1234 testtest guest123 qazwsxedc").split(" ");
  /** null when the password is fine: at least 8 characters and not one of the most common. */
  function passwordProblem(pw, email) {
    var p = String(pw || "");
    if (p.length < 8) return "Use at least 8 characters.";
    var low = p.toLowerCase();
    if (COMMON.indexOf(low) >= 0) return "That's one of the most common passwords. Pick something else.";
    var local = normEmail(email).split("@")[0];
    if (local && local.length >= 4 && low === local) return "Don't use your email name as your password.";
    if (/^(.)\1+$/.test(p)) return "Pick something less guessable.";
    return null;
  }
  /** Set or change the signed-in user's password. nonce = the code from reauthenticate (old sessions). */
  function setPassword(cfg, session, password, nonce, opts) {
    var bad = passwordProblem(password, session && session.user && session.user.email);
    if (bad) return Promise.resolve({ ok: false, error: bad });
    var body = { password: String(password) };
    if (nonce) body.nonce = String(nonce).replace(/\D/g, "");
    return post(cfg, "user", body, opts.fetchImpl, session, "PUT").then(function (r) {
      if (r.ok) return { ok: true };
      var code = String((r.body && (r.body.error_code || r.body.code)) || "") + " " + String((r.body && (r.body.msg || r.body.message)) || "");
      return { ok: false, error: authError(r), reauth: /reauthentication_needed|reauthenticat/i.test(code) };
    });
  }
  /** Email a fresh code to confirm a password change (Supabase "secure password change"). */
  function reauthenticate(cfg, session, fetchImpl) {
    return post(cfg, "reauthenticate", null, fetchImpl, session, "GET").then(function (r) { return r.ok ? { ok: true } : { ok: false, error: authError(r) }; });
  }

  root.B5Auth = {
    storageKey: storageKey, getSession: getSession, saveSession: saveSession, clearSession: clearSession,
    claims: claims, fromFragment: fromFragment, requestLink: requestLink, current: current, signOut: signOut, api: api,
    signInPassword: signInPassword, sendCode: sendCode, verifyCode: verifyCode, sendResetCode: sendResetCode, setPassword: setPassword,
    reauthenticate: reauthenticate, passwordProblem: passwordProblem, authError: authError, lockState: lockState, sessionFrom: sessionFrom
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
      // Signed in: land on My Team. A failed link goes to #account, which explains and offers a new one.
      var url = window.location.pathname + window.location.search + (r.error ? "#account" : "#myteam");
      if (window.history && window.history.replaceState) window.history.replaceState(null, "", url);
      else window.location.hash = r.error ? "#account" : "#myteam";
    };
    consume();
    window.addEventListener("hashchange", consume);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
