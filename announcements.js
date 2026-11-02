/* Home-page announcements (window.B5Announcements; pure helpers tested in src/workers/nav.test.ts).
   They live in public.announcements (2026-11-01): each stores its author and the role it was posted
   as (Admin / Commissioner / Treasurer, a role the author holds); the tag and badge come from that
   choice. Pinned ones stay first (newest first among them), then newest first. */
(function (root) {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var ROLES = ["admin", "commissioner", "treasurer"];
  var ROLE_NAMES = { admin: "Admin", commissioner: "Commissioner", treasurer: "Treasurer" };
  var TAGS = { admin: "Admin", commissioner: "Commish", treasurer: "Treasurer" };

  /** Pinned first, then newest first. */
  function order(list) {
    return (list || []).map(function (a, i) { var o = {}; for (var k in a) o[k] = a[k]; o.i = i; return o; })
      .sort(function (x, y) { return (!!y.pinned - !!x.pinned) || String(y.published_at).localeCompare(String(x.published_at)) || x.i - y.i; });
  }
  /** The "Post as" choices: the roles a person holds, in the fixed order; the first is the default. */
  function postAsChoices(roles) { return ROLES.filter(function (r) { return (roles || []).indexOf(r) >= 0; }); }
  /** The tag from the role it was posted as (never hardcoded). */
  function tagFor(postedAs) { return TAGS[postedAs] || "News"; }
  /** "Adam · <Mac Daddies link>" with the team logo and a role badge. T = window.B5Team. */
  function bylineHtml(a, T) {
    var team = a.author_team && T && T.has(a.author_team) ? a.author_team : null;
    return '<span class="post-by">' + (team ? T.logo(team) : "") + "<span>" + esc(a.author_name || "League officer") +
      (team ? " · " + T.link(team, { logo: false }) : "") + "</span>" +
      (a.posted_as ? ' <span class="tag role-' + esc(a.posted_as) + '">' + esc(ROLE_NAMES[a.posted_as] || a.posted_as) + "</span>" : "") + "</span>";
  }
  root.B5Announcements = { order: order, postAsChoices: postAsChoices, tagFor: tagFor, bylineHtml: bylineHtml, ROLE_NAMES: ROLE_NAMES };
})(typeof globalThis !== "undefined" ? globalThis : this);
