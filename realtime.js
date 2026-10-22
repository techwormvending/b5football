/* Supabase Realtime for the browser without supabase-js: the Phoenix channel protocol over ONE
   WebSocket per page (wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<publishable>&vsn=1.0.0),
   shared by every channel the page joins (free tier: 200 concurrent connections).
   window.B5Realtime.subscribe({
     cfg, topic,                       // "realtime:<name>"
     changes: [{ table, filter? }],    // postgres_changes on public tables (RLS per subscriber)
     private: true,                    // Realtime Authorization (policies on realtime.messages)
     presenceKey, onPresence(list),    // presence: list = [{ key, metas: [...] }]
     onBroadcast(event, payload),      // broadcast messages from others
     getToken, onChange(record, table) })
   -> { close(), joined(), track(meta), send(event, payload) }
   Heartbeat every 25 s; reconnects with backoff (2 s doubling, max 60 s), asking getToken again
   (fresh session) and rejoining every channel (and re-tracking presence).
   Used by live.js (score_weeks), board.js (board tables) and chat.js (chat tables, presence, typing). */
(function (root) {
  "use strict";
  var S = null;   // the shared socket: { cfg, ws, ref, hb, retry, tries, open, channels: [] }
  var nextRef = function () { return String(++S.ref); };
  var send = function (m) { try { S.ws.send(JSON.stringify(m)); } catch (e) { /* reconnects */ } };

  function join(ch, token) {
    var o = ch.o;
    ch.joinRef = nextRef(); ch.joined = false;
    var config = { broadcast: { self: false }, presence: { key: o.presenceKey || "" },
      postgres_changes: (o.changes || []).map(function (c) { var x = { event: "*", schema: "public", table: c.table }; if (c.filter) x.filter = c.filter; return x; }) };
    if (o.private) config.private = true;
    var payload = { config: config };
    if (token) payload.access_token = token;
    send({ topic: o.topic, event: "phx_join", payload: payload, ref: ch.joinRef, join_ref: ch.joinRef });
  }
  function connect() {
    if (!S || !S.channels.length || !root.WebSocket) return;
    // One token for the socket: the signed-in user's (every channel on a page belongs to him).
    var getters = S.channels.map(function (c) { return c.o.getToken; }).filter(Boolean);
    Promise.all(getters.map(function (g) { return Promise.resolve().then(g).catch(function () { return null; }); })).then(function (tokens) {
      if (!S || !S.channels.length) return;
      var token = tokens.filter(Boolean)[0] || null;
      var ws = S.ws = new root.WebSocket(S.cfg.url.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + encodeURIComponent(S.cfg.publishableKey) + "&vsn=1.0.0");
      ws.onopen = function () {
        S.open = true; S.token = token;
        S.channels.forEach(function (ch) { join(ch, token); });
        S.hb = setInterval(function () { send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() }); }, 25000);
      };
      ws.onmessage = function (m) {
        var x; try { x = JSON.parse(m.data); } catch (e) { return; }
        S.channels.forEach(function (ch) { if (ch.o.topic === x.topic) route(ch, x); });
      };
      ws.onclose = function () {
        clearInterval(S.hb); S.open = false;
        S.channels.forEach(function (ch) { ch.joined = false; });
        if (!S.channels.length) return;
        S.retry = setTimeout(connect, Math.min(60000, 2000 * Math.pow(2, S.tries++)));
      };
    });
  }
  function route(ch, x) {
    var o = ch.o, p = x.payload || {};
    if (x.event === "phx_reply" && x.ref === ch.joinRef) {
      if (p.status === "ok") {
        ch.joined = true; S.tries = 0;
        if (ch.meta) send({ topic: o.topic, event: "presence", payload: { type: "presence", event: "track", payload: ch.meta }, ref: nextRef(), join_ref: ch.joinRef });
      } else if (o.onError) o.onError(p.response || p);
    } else if (x.event === "postgres_changes" && p.data && o.onChange) {
      o.onChange(p.data.record || p.data.old_record || null, p.data.table || null, p.data.type || null);
    } else if (x.event === "presence_state") {
      ch.presence = {};
      Object.keys(p).forEach(function (k) { ch.presence[k] = (p[k].metas || []).slice(); });
      presenceChanged(ch);
    } else if (x.event === "presence_diff") {
      Object.keys(p.joins || {}).forEach(function (k) { ch.presence[k] = (ch.presence[k] || []).concat(p.joins[k].metas || []); });
      Object.keys(p.leaves || {}).forEach(function (k) {
        var gone = (p.leaves[k].metas || []).map(function (m) { return m.phx_ref; });
        ch.presence[k] = (ch.presence[k] || []).filter(function (m) { return gone.indexOf(m.phx_ref) < 0; });
        if (!ch.presence[k].length) delete ch.presence[k];
      });
      presenceChanged(ch);
    } else if (x.event === "broadcast" && o.onBroadcast) {
      o.onBroadcast(p.event, p.payload);
    }
  }
  function presenceChanged(ch) {
    if (ch.o.onPresence) ch.o.onPresence(Object.keys(ch.presence).map(function (k) { return { key: k, metas: ch.presence[k] }; }));
  }

  function subscribe(o) {
    if (!S || !S.channels.length) {
      if (S) { clearTimeout(S.retry); clearInterval(S.hb); }
      S = { cfg: o.cfg, ws: null, ref: 0, hb: null, retry: null, tries: 0, open: false, token: null, channels: [] };
    }
    var ch = { o: o, joined: false, joinRef: null, presence: {}, meta: null };
    S.channels.push(ch);
    if (S.channels.length === 1) connect();
    else if (S.open) {
      // A channel added later: join it now (asking for a token if this one needs one).
      Promise.resolve(o.getToken ? o.getToken() : S.token).catch(function () { return S.token; }).then(function (t) { if (S.open && S.channels.indexOf(ch) >= 0) join(ch, t || S.token); });
    }
    var sock = S;
    return {
      close: function () {
        var i = sock.channels.indexOf(ch);
        if (i < 0) return;
        if (sock.open && ch.joinRef) send({ topic: o.topic, event: "phx_leave", payload: {}, ref: nextRef(), join_ref: ch.joinRef });
        sock.channels.splice(i, 1);
        if (!sock.channels.length) {
          clearInterval(sock.hb); clearTimeout(sock.retry);
          if (sock.ws) { sock.ws.onclose = null; try { sock.ws.close(); } catch (e) { /* closed */ } }
          sock.open = false;
        }
      },
      joined: function () { return ch.joined; },
      /** Presence: announce (or update) this page's meta; re-sent after every rejoin. */
      track: function (meta) {
        ch.meta = meta;
        if (ch.joined) send({ topic: o.topic, event: "presence", payload: { type: "presence", event: "track", payload: meta }, ref: nextRef(), join_ref: ch.joinRef });
      },
      /** Broadcast to everyone else on the channel (e.g. typing). */
      send: function (event, payload) {
        if (ch.joined) send({ topic: o.topic, event: "broadcast", payload: { type: "broadcast", event: event, payload: payload }, ref: nextRef(), join_ref: ch.joinRef });
      }
    };
  }
  root.B5Realtime = { subscribe: subscribe };
})(typeof globalThis !== "undefined" ? globalThis : this);
