/* Home-page announcements (window.B5Announcements; pure, tested in src/workers/nav.test.ts).
   They live in league-data.js. One marked `pinned: true` stays first, above newer ones, until a
   commissioner or admin unpins it on the Home page (public.announcement_pins, which can also pin
   another one). Everything else is newest first. */
(function (root) {
  "use strict";
  /** The key used for pins and board cross-posts: "announcement:<date>:<title slug>" (same as account.js). */
  function key(a) { return "announcement:" + a.date + ":" + String(a.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60); }
  /** Pinned first, then newest first; `pins` (key -> pinned) beats the file's flag. Adds isPinned. */
  function order(list, pins) {
    pins = pins || {};
    return (list || []).map(function (a, i) {
      var k = key(a), out = {};
      for (var p in a) out[p] = a[p];
      out.i = i; out.isPinned = Object.prototype.hasOwnProperty.call(pins, k) ? !!pins[k] : !!a.pinned;
      return out;
    }).sort(function (x, y) { return (y.isPinned - x.isPinned) || String(y.date).localeCompare(String(x.date)) || x.i - y.i; });
  }
  root.B5Announcements = { key: key, order: order };
})(typeof globalThis !== "undefined" ? globalThis : this);
