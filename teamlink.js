/* TeamLink (window.B5Team): the ONE place pages read team data, and the one way a team name is
   rendered: logo + name, linking to the team's profile (#team/<franchiseId>).
     B5Team.link(id, opts)    HTML <a class="team-link" href="#team/<id>">[logo]<span>Name</span></a>
                              opts: { logo: false, cls: "logo sm" (logo classes), bold: true, short: true }
     B5Team.logo(id, cls)     HTML logo only (img, or initials when there's no logo / it fails)
     B5Team.option(id, sel, suffix)  HTML <option> for team pickers
     B5Team.linkName(text)    a known team name -> link; anything else (old names before the history
                              import) -> escaped text
     B5Team.name(id)          PLAIN TEXT, never for HTML (confirm dialogs, CSV, status messages,
                              alt/aria text). src/workers/teamlink.test.ts fails a page that reads
                              team data any other way or puts B5Team.name() into markup.
     B5Team.ids(), has(id), division(id), byName(name), href(id), seedRows()
   Loaded before every page script. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {};
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var list = function () { return L.teams || []; };
  var get = function (id) { var t = list().filter(function (x) { return x.id === id; })[0]; return t || null; };
  var initials = function (name) {
    return String(name || "?").split(/\s+/).filter(function (w) { return !/^the$/i.test(w); }).slice(0, 2)
      .map(function (w) { return w[0]; }).join("").toUpperCase();
  };
  var name = function (id) { var t = get(id); return t ? t.name : String(id == null ? "" : id); };
  var href = function (id) { return "#team/" + encodeURIComponent(id); };

  function logo(id, cls) {
    var t = get(id), c = esc(cls || "logo sm"), ini = esc(initials(t ? t.name : id));
    return t && t.logo
      ? '<img class="' + c + '" src="' + esc(t.logo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<div class=&quot;' + c + '&quot;>' + ini + "</div>'\">"
      : '<div class="' + c + '">' + ini + "</div>";
  }
  function link(id, opts) {
    opts = opts || {};
    if (!get(id)) return '<span class="team-link unknown">' + esc(id) + "</span>";
    var n = '<span class="tl-name">' + (opts.bold ? "<b>" + esc(name(id)) + "</b>" : esc(name(id))) + "</span>";
    return '<a class="team-link' + (opts.className ? " " + esc(opts.className) : "") + '" href="' + esc(href(id)) + '">' +
      (opts.logo === false ? "" : logo(id, opts.cls)) + n + "</a>";
  }
  function option(id, selected, suffix) {
    return '<option value="' + esc(id) + '"' + (selected ? " selected" : "") + ">" + esc(name(id) + (suffix || "")) + "</option>";
  }
  function byName(text) {
    var s = String(text || "").trim().toLowerCase(), t = list().filter(function (x) { return x.name.toLowerCase() === s; })[0];
    return t ? t.id : null;
  }
  function linkName(text, opts) { var id = byName(text); return id ? link(id, opts) : esc(text); }

  root.B5Team = {
    ids: function () { return list().map(function (t) { return t.id; }); },
    has: function (id) { return !!get(id); },
    name: name,
    division: function (id) { var t = get(id); return t ? t.division : null; },
    manager: function (id) { var t = get(id); return t ? t.manager || "" : ""; },
    titles: function (id) { var t = get(id); return t ? t.titles || 0 : 0; },
    byName: byName, href: href, logo: logo, link: link, option: option, linkName: linkName, initials: initials,
    /** Raw rows for the commissioner's one-time "add the teams to the database". */
    seedRows: function () { return list().map(function (t) { return { id: t.id, name: t.name, division: t.division, logo: t.logo || null }; }); }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
