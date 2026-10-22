/* Supabase Realtime for the browser without supabase-js: the Phoenix channel protocol over one
   WebSocket (wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<publishable>&vsn=1.0.0).
   window.B5Realtime.subscribe({ cfg, topic, changes: [{ table, filter? }], getToken, onChange })
   joins one channel listening to postgres_changes on those public tables (RLS applies per
   subscriber: signed-in users pass their JWT via getToken). onChange(record, table) runs for each
   change. Heartbeat every 25 s; reconnects with backoff (2 s doubling, max 60 s), asking getToken
   again so an expired session is refreshed. Returns { close(), joined() }.
   Used by live.js (score_weeks) and board.js (board threads, posts, reactions). */
(function (root) {
  "use strict";
  function subscribe(o) {
    var ws = null, hb = null, retry = null, tries = 0, closed = false, joined = false, ref = 0;
    var send = function (m) { try { ws.send(JSON.stringify(m)); } catch (e) { /* reconnects */ } };
    function open(token) {
      if (closed || !root.WebSocket || !o.cfg || !o.cfg.url) return;
      ws = new root.WebSocket(o.cfg.url.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + encodeURIComponent(o.cfg.publishableKey) + "&vsn=1.0.0");
      ws.onopen = function () {
        var payload = { config: { broadcast: { self: false }, presence: { key: "" },
          postgres_changes: o.changes.map(function (c) { var x = { event: "*", schema: "public", table: c.table }; if (c.filter) x.filter = c.filter; return x; }) } };
        if (token) payload.access_token = token;
        send({ topic: o.topic, event: "phx_join", payload: payload, ref: String(++ref), join_ref: "1" });
        hb = setInterval(function () { send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) }); }, 25000);
      };
      ws.onmessage = function (m) {
        var x; try { x = JSON.parse(m.data); } catch (e) { return; }
        if (x.event === "phx_reply" && x.topic === o.topic && x.payload && x.payload.status === "ok") { joined = true; tries = 0; }
        if (x.event === "postgres_changes" && x.payload && x.payload.data && o.onChange) {
          var d = x.payload.data;
          o.onChange(d.record || d.old_record || null, d.table || null);
        }
      };
      ws.onclose = function () {
        clearInterval(hb); joined = false;
        if (closed) return;
        retry = setTimeout(connect, Math.min(60000, 2000 * Math.pow(2, tries++)));
      };
    }
    function connect() {
      Promise.resolve(o.getToken ? o.getToken() : null).then(open, function () { open(null); });
    }
    connect();
    return {
      close: function () {
        closed = true; clearInterval(hb); clearTimeout(retry); joined = false;
        if (ws) { ws.onclose = null; try { ws.close(); } catch (e) { /* closed */ } }
      },
      joined: function () { return joined; }
    };
  }
  root.B5Realtime = { subscribe: subscribe };
})(typeof globalThis !== "undefined" ? globalThis : this);
