/* League history (window.B5History): champions and runners-up since 2000 (public.league_history) and the
   franchise lineage (public.history_franchises: MFL franchise ID + old name -> today's team). Used by the
   History page and team profiles (titles). A name counts for a current team ONLY when its lineage row is
   'approved'; 'proposed' and 'historical' names show as plain text, never linked or guessed.
   Commissioners edit any season and approve the lineage here (both audited by the database).
   Pure helpers are tested in src/workers/history-page.test.ts. */
(function (root) {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var T = function () { return root.B5Team; };

  // ---- Pure helpers ------------------------------------------------------------------------
  /** The lineage row for a name as of a season (MFL ID + name). */
  function lineageOf(lineage, mfl, name) {
    return (lineage || []).filter(function (f) { return f.mfl_id === mfl && f.name === name; })[0] || null;
  }
  /** Today's team for a historical name, only when approved; else null. */
  function teamOf(lineage, mfl, name) { var f = lineageOf(lineage, mfl, name); return f && f.status === "approved" ? f.team_id : null; }
  /** Grouping key: the approved team, else the name itself (an unmapped franchise stands on its own). */
  function keyOf(lineage, mfl, name) { var t = teamOf(lineage, mfl, name); return t ? "team:" + t : "name:" + String(name).toLowerCase(); }
  /** Counts per franchise for one side ("champion" or "runner_up"): [{ key, team, names, years }], most first. */
  function tally(rows, lineage, side) {
    var by = {};
    (rows || []).forEach(function (r) {
      var name = r[side], mfl = r[side === "champion" ? "champion_mfl" : "runner_up_mfl"];
      if (!name) return;
      var k = keyOf(lineage, mfl, name), e = by[k] || (by[k] = { key: k, team: teamOf(lineage, mfl, name), names: [], years: [] });
      if (e.names.indexOf(name) < 0) e.names.push(name);
      e.years.push(r.season);
    });
    return Object.keys(by).map(function (k) { by[k].years.sort(function (a, b) { return b - a; }); return by[k]; })
      .sort(function (a, b) { return b.years.length - a.years.length || b.years[0] - a.years[0]; });
  }
  /** Back-to-back champions (the Empire pot's rule): the same franchise winning consecutive seasons. */
  function repeats(rows, lineage) {
    var by = {}; (rows || []).forEach(function (r) { by[r.season] = r; });
    var out = [];
    Object.keys(by).map(Number).sort().forEach(function (y) {
      var a = by[y - 1], b = by[y];
      if (a && b && a.champion && b.champion && keyOf(lineage, a.champion_mfl, a.champion) === keyOf(lineage, b.champion_mfl, b.champion))
        out.push({ years: [y - 1, y], team: teamOf(lineage, b.champion_mfl, b.champion), name: b.champion, verified: !!(a.verified && b.verified) });
    });
    return out.reverse();
  }
  /** A current team's title seasons (approved names only), newest first. */
  function titleYears(rows, lineage, teamId) {
    return (rows || []).filter(function (r) { return r.champion && teamOf(lineage, r.champion_mfl, r.champion) === teamId; })
      .map(function (r) { return r.season; }).sort(function (a, b) { return b - a; });
  }
  /** HTML for a team as it was named that season: today's team link when approved (with the old name if it
      differed), else the old name as plain text. */
  function nameHtml(lineage, mfl, name) {
    if (!name) return '<span class="muted">Unknown</span>';
    var t = teamOf(lineage, mfl, name);
    if (!t || !T() || !T().has(t)) return '<span class="hs-old">' + esc(name) + "</span>";
    var cur = T().name(t), same = String(cur).replace(/^the\s+/i, "").toLowerCase() === String(name).replace(/^the\s+/i, "").toLowerCase();
    return T().link(t) + (same ? "" : ' <span class="muted small">as ' + esc(name) + "</span>");
  }
  function groupHtml(e) {
    if (e.team && T() && T().has(e.team)) {
      var other = e.names.filter(function (n) { return String(n).replace(/^the\s+/i, "").toLowerCase() !== String(T().name(e.team)).replace(/^the\s+/i, "").toLowerCase(); });
      return T().link(e.team) + (other.length ? ' <span class="muted small">incl. ' + esc(other.join(", ")) + "</span>" : "");
    }
    return '<span class="hs-old">' + esc(e.names.join(" / ")) + '</span> <span class="muted small">(former team)</span>';
  }

  // ---- Data ----------------------------------------------------------------------------------
  var cache = null;
  function load(force) {
    var cfg = root.B5_SUPABASE, A = root.B5Auth;
    if (!(cfg && cfg.configured && A)) return Promise.resolve({ rows: [], lineage: [] });
    if (cache && !force) return cache;
    var f = function (u, i) { return root.fetch(u, i); };
    cache = Promise.all([
      A.api(cfg, null, "league_history?select=*&order=season.desc", {}, f),
      A.api(cfg, null, "history_franchises?select=*&order=mfl_id,name", {}, f)
    ]).then(function (r) { return { rows: r[0].ok ? r[0].data || [] : [], lineage: r[1].ok ? r[1].data || [] : [] }; });
    return cache;
  }

  // ---- Page ----------------------------------------------------------------------------------
  var st = { el: null, me: null, d: null, msg: null, edit: null };
  function isCommish() { return !!(st.me && st.me.profile && st.me.profile.is_commissioner); }
  function pageHtml() {
    var d = st.d, rows = d.rows, lin = d.lineage;
    var champs = '<div class="card table-wrap"><table class="hs-table"><thead><tr><th>Year</th><th>Champion</th><th>Runner-up</th><th>Final</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var unv = r.champion && !r.verified;
        return '<tr class="' + (r.champion ? "" : "hs-unknown") + '"><td class="yr">' + esc(r.season) + "</td>" +
          '<td class="champ">' + (r.champion ? "🏆 " : "") + nameHtml(lin, r.champion_mfl, r.champion) + (unv ? ' <span class="tag hs-unv" title="Not confirmed from MFL\'s records">unverified</span>' : "") + "</td>" +
          '<td data-label="Runner-up">' + (r.runner_up ? nameHtml(lin, r.runner_up_mfl, r.runner_up) : '<span class="muted">' + (r.champion ? "–" : "Unknown") + "</span>") + "</td>" +
          '<td class="muted small hs-final">' + esc(r.result || "") + (r.note ? '<details class="hs-note"><summary>Note</summary>' + esc(r.note) + (r.source ? "<br>Source: " + esc(r.source) : "") + "</details>" : r.source ? '<div class="hs-src">' + esc(r.source) + "</div>" : "") +
          (isCommish() ? ' <button type="button" class="linkish" data-hs-edit="' + esc(r.season) + '">Edit</button>' : "") + "</td></tr>" +
          (st.edit === r.season ? '<tr><td colspan="4">' + editForm(r) + "</td></tr>" : "");
      }).join("") + "</tbody></table></div>";
    var t = tally(rows, lin, "champion"), ru = tally(rows, lin, "runner_up"), rep = repeats(rows, lin);
    var listTable = function (list, label) {
      return '<div class="card table-wrap"><table><thead><tr><th>Franchise</th><th>' + label + '</th><th>Seasons</th></tr></thead><tbody>' +
        list.map(function (e) { return "<tr><td>" + groupHtml(e) + '</td><td class="yr">' + esc(e.years.length) + '</td><td class="muted small">' + esc(e.years.join(", ")) + "</td></tr>"; }).join("") + "</tbody></table></div>";
    };
    var empire = '<div class="card"><p class="muted small">The Empire pot goes to a team that wins the title two seasons in a row.</p>' +
      (rep.length ? '<ul class="checks">' + rep.map(function (x) { return "<li>👑 " + (x.team && T().has(x.team) ? T().link(x.team) : '<span class="hs-old">' + esc(x.name) + "</span>") + " · " + esc(x.years.join(" & ")) + (x.verified ? "" : ' <span class="tag hs-unv">unverified</span>') + "</li>"; }).join("") + "</ul>" : '<p class="muted">No back-to-back champions yet.</p>') + "</div>";
    return '<section class="hs">' + (st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "") +
      "<h2>Champions</h2>" + champs +
      '<p class="muted small">Older team names show as they were; they count toward a current team once the commissioner confirms which franchise they belong to.</p>' +
      "<h2>Empire winners (back-to-back)</h2>" + empire +
      "<h2>Titles</h2>" + listTable(t, "Titles") +
      "<h2>Runner-up appearances</h2>" + listTable(ru, "Runner-up") +
      (isCommish() ? lineageHtml(lin) : "") + "</section>";
  }
  function editForm(r) {
    var v = function (k) { return esc(r[k] == null ? "" : r[k]); };
    return '<form class="acct-form hs-form" data-hs-form="season" data-season="' + esc(r.season) + '"><h3>' + esc(r.season) + "</h3>" +
      '<label>Champion (name that season)<input name="champion" maxlength="60" value="' + v("champion") + '"></label>' +
      '<label>Champion\'s MFL franchise ID<input name="champion_mfl" pattern="[0-9]{4}" maxlength="4" value="' + v("champion_mfl") + '" placeholder="0007"></label>' +
      '<label>Runner-up<input name="runner_up" maxlength="60" value="' + v("runner_up") + '"></label>' +
      '<label>Runner-up\'s MFL franchise ID<input name="runner_up_mfl" pattern="[0-9]{4}" maxlength="4" value="' + v("runner_up_mfl") + '"></label>' +
      '<label>Final (score, week)<input name="result" maxlength="120" value="' + v("result") + '"></label>' +
      '<label>Source<input name="source" maxlength="120" value="' + v("source") + '"></label>' +
      '<label>Note<textarea name="note" maxlength="600" rows="2">' + v("note") + "</textarea></label>" +
      '<label class="acct-check"><input type="checkbox" name="verified"' + (r.verified ? " checked" : "") + "> Verified</label>" +
      '<p class="muted small">Saved changes are in the audit log. A new name (or ID) also needs its franchise in the lineage below to count for a current team.</p>' +
      '<button class="btn" type="submit">Save ' + esc(r.season) + '</button> <button class="btn ghost" type="button" data-hs-edit="">Cancel</button></form>';
  }
  function lineageHtml(lin) {
    var label = { approved: "Approved", proposed: "Proposed", historical: "Former team (no current team)" };
    return "<h2>Franchise lineage</h2><div class=\"card\"><p class=\"muted small\">Old names by MFL franchise ID. Approve a name to count its titles for today's team; until then it shows as the old name.</p>" +
      '<ul class="hs-lin">' + lin.map(function (f) {
        return '<li><form class="hs-linform" data-hs-form="lineage" data-mfl="' + esc(f.mfl_id) + '" data-name="' + esc(f.name) + '"><div><b>' + esc(f.name) + '</b> <span class="muted small">MFL ' + esc(f.mfl_id) + " · " + esc(label[f.status] || f.status) + "</span></div>" +
          (f.evidence ? '<div class="muted small">' + esc(f.evidence) + "</div>" : "") +
          '<div class="hs-linrow"><select name="team" aria-label="Current team for ' + esc(f.name) + '"><option value="">No current team (former team)</option>' + T().ids().map(function (id) { return T().option(id, id === f.team_id); }).join("") + "</select>" +
          '<select name="status" aria-label="Status"><option value="approved"' + (f.status === "approved" ? " selected" : "") + ">Approved</option><option value=\"proposed\"" + (f.status === "proposed" ? " selected" : "") + ">Proposed</option><option value=\"historical\"" + (f.status === "historical" ? " selected" : "") + ">Former team</option></select>" +
          '<button class="btn ghost" type="submit">Save</button></div></form></li>';
      }).join("") + "</ul>" +
      '<details><summary>Add a name</summary><form class="acct-form" data-hs-form="newname"><label>Name<input name="name" maxlength="60" required></label><label>MFL franchise ID<input name="mfl" pattern="[0-9]{4}" maxlength="4" required></label><button class="btn" type="submit">Add</button></form></details></div>';
  }
  function render() { if (st.el) st.el.innerHTML = st.d ? pageHtml() : '<p class="muted">Loading…</p>'; }
  function refresh(msg) { st.msg = msg || null; return load(true).then(function (d) { st.d = d; render(); }); }
  function save(path, method, body, okMsg) {
    var cfg = root.B5_SUPABASE, A = root.B5Auth;
    return A.api(cfg, st.me && st.me.session, path, { method: method, body: JSON.stringify(body), headers: { Prefer: "return=representation" } }, function (u, i) { return root.fetch(u, i); })
      .then(function (r) { return refresh(r.ok && (method === "POST" || (r.data && r.data.length)) ? { ok: okMsg } : { err: r.ok ? "Nothing was saved (commissioners only)." : String(r.error || "Couldn't save.") }); });
  }
  function bind(el) {
    if (el.dataset.hsBound) return;
    el.dataset.hsBound = "1";
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-hs-edit]"); if (!b) return;
      st.edit = b.dataset.hsEdit ? Number(b.dataset.hsEdit) : null; st.msg = null; render();
    });
    el.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-hs-form]"); if (!form) return;
      e.preventDefault();
      var fd = new FormData(form), k = form.dataset.hsForm, nul = function (x) { x = String(x == null ? "" : x).trim(); return x || null; };
      if (k === "season") {
        var s = Number(form.dataset.season);
        st.edit = null;
        save("league_history?season=eq." + s, "PATCH", { champion: nul(fd.get("champion")), champion_mfl: nul(fd.get("champion_mfl")), runner_up: nul(fd.get("runner_up")), runner_up_mfl: nul(fd.get("runner_up_mfl")),
          result: nul(fd.get("result")), source: nul(fd.get("source")), note: nul(fd.get("note")), verified: fd.get("verified") === "on" }, s + " saved.");
      } else if (k === "lineage") {
        var team = nul(fd.get("team")), status = String(fd.get("status"));
        if (status === "approved" && !team) { st.msg = { err: "Pick the current team to approve." }; render(); return; }
        save("history_franchises?mfl_id=eq." + encodeURIComponent(form.dataset.mfl) + "&name=eq." + encodeURIComponent(form.dataset.name), "PATCH", { team_id: team, status: status }, form.dataset.name + " saved.");
      } else if (k === "newname") {
        save("history_franchises", "POST", { name: String(fd.get("name")).trim(), mfl_id: String(fd.get("mfl")).trim(), status: "proposed" }, "Added.");
      }
    });
  }
  function start(el) {
    st.el = el; st.d = null; st.edit = null; render(); bind(el);
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    return Promise.all([who, load(true)]).then(function (r) { st.me = r[0]; st.d = r[1]; if (st.el === el) render(); });
  }

  root.B5History = { load: load, start: start, lineageOf: lineageOf, teamOf: teamOf, tally: tally, repeats: repeats, titleYears: titleYears, nameHtml: nameHtml, groupHtml: groupHtml };
})(typeof globalThis !== "undefined" ? globalThis : this);
