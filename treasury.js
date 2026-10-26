/* Treasury (#treasury): the league's books. A LEDGER: no money moves through the site.
   Treasurers record league fees paid (fee_payments), winnings paid out (payout_payments), the Empire
   pot ledger (empire_ledger), see balances owed (public.treasury_balances), export everything as CSV
   and see owners' payment preferences (payment_prefs: the owner and treasurers only).
   Commissioners read it; they keep the books only while no treasurer exists, and they confirm or
   reject a bookkeeper's entry for his own team (public.confirm_payment). Awards are decided
   elsewhere (automatic, or the commissioner's payout tools); this page never changes them.
   Every rule is enforced by the database; the page mirrors it. All data is escaped. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var season = Number(L.season);
  var f = function (u, i) { return root.fetch(u, i); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };
  var TL = function () { return root.B5Team; };
  var tlink = function (id) { return id ? TL().link(id, { logo: false }) : '<span class="muted">League</span>'; };
  var money = function (n) { return root.B5Payouts ? root.B5Payouts.money(n) : "$" + Number(n || 0).toFixed(2); };
  var today = function () { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); };
  var METHODS = ["Venmo", "PayPal", "Zelle", "Check", "Cash", "In person", "Other"];
  var EMPIRE_KINDS = { carry_in: "Carried in", contribution: "Season contribution", payout: "Paid to a repeat champion", rollover: "Rolled over", adjustment: "Adjustment" };

  // ---- Pure helpers (tested in src/workers/treasury-page.test.ts) --------------------
  /** Whether this viewer may confirm a pending entry: a commissioner who didn't record it and doesn't own that team. */
  function canConfirm(entry, viewer) {
    return !!(viewer && viewer.commissioner && entry.status === "pending" && entry.created_by !== viewer.id && (viewer.teams || []).indexOf(entry.team_id) < 0);
  }
  /** The Empire pot: confirmed entries summed (payouts and rollovers are negative amounts). */
  function empireBalance(rows) { return (rows || []).filter(function (r) { return r.status !== "pending"; }).reduce(function (s, r) { return s + Math.round(Number(r.amount) * 100); }, 0) / 100; }
  /** Who keeps the books, in words, for the page header. */
  function roleText(info) {
    if (!info) return "";
    if (info.is_treasurer) return "You keep the books as treasurer.";
    if (info.keeps_books) return "No treasurer is assigned, so commissioners keep the books.";
    return info.treasurers ? "Read-only: the treasurer keeps the books." : "Read-only.";
  }
  /** The whole ledger as CSV rows. */
  function ledgerRows(d, name) {
    var rows = [["Balances", season], ["Team", "Fee due", "Fee paid", "Won (final)", "Projected", "Paid out", "Owed", "Pending entries"]];
    d.balances.forEach(function (b) { rows.push([name(b.team_id), b.fee_due, b.fee_paid, b.won, b.projected, b.paid_out, b.owed, b.pending]); });
    rows.push([]); rows.push(["League fees paid", "Team", "Amount", "Paid on", "Method", "Status", "Note"]);
    d.fees.forEach(function (x) { rows.push(["", name(x.team_id), x.amount, x.paid_at, x.method, x.status, x.note]); });
    rows.push([]); rows.push(["Winnings paid out", "Team", "Amount", "Paid on", "Method", "Status", "Note"]);
    d.payouts.forEach(function (x) { rows.push(["", name(x.team_id), x.amount, x.paid_at, x.method, x.status, x.note]); });
    rows.push([]); rows.push(["Empire pot", "Season", "Kind", "Team", "Amount", "Date", "Status", "Note"]);
    d.empire.forEach(function (x) { rows.push(["", x.season, EMPIRE_KINDS[x.kind] || x.kind, x.team_id ? name(x.team_id) : "", x.amount, x.entry_date, x.status, x.note]); });
    return rows;
  }
  function csv(rows) {
    var cell = function (v) { var s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return rows.map(function (r) { return r.map(cell).join(","); }).join("\n") + "\n";
  }

  // ---- Data -----------------------------------------------------------------------
  var st = { me: null, d: null, msg: null, el: null };
  var api = function (path, init) { return A.api(cfg, st.me.session, path, init || {}, f); };
  var rpc = function (name, body) { return api("rpc/" + name, { method: "POST", body: JSON.stringify(body || {}) }); };
  var ok = function (x) { return x && x.ok ? x.data || [] : []; };
  function load() {
    var q = "?season=eq." + season;
    return Promise.all([
      rpc("treasury_info"),
      rpc("treasury_balances", { p_season: season }),
      api("fee_payments" + q + "&select=*&order=paid_at.desc,id.desc"),
      api("payout_payments" + q + "&select=*&order=paid_at.desc,id.desc"),
      api("empire_ledger?select=*&order=entry_date,id"),
      api("payment_prefs?select=*"),
      api("team_managers?select=user_id,team_id,profiles(display_name)"),
      api("season_settings" + q + "&select=buy_in")
    ]).then(function (r) {
      var people = {};
      ok(r[6]).forEach(function (x) { people[x.user_id] = { team: x.team_id, name: (x.profiles && x.profiles.display_name) || "" }; });
      st.d = { info: r[0].ok ? r[0].data : null, balances: ok(r[1]), fees: ok(r[2]), payouts: ok(r[3]), empire: ok(r[4]), prefs: ok(r[5]), people: people,
        buyIn: (ok(r[7])[0] || {}).buy_in || 360 };
    });
  }

  // ---- Render ------------------------------------------------------------------------
  var teamSelect = function (name) { return '<select name="' + name + '" required><option value="">Pick a team</option>' + TL().ids().map(function (id) { return TL().option(id); }).join("") + "</select>"; };
  var methodSelect = '<select name="method"><option value="">Method</option>' + METHODS.map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") + "</select>";
  function viewer() {
    var p = st.me.profile || {};
    return { id: st.me.session.user.id, commissioner: !!p.is_commissioner, teams: (st.me.teams || []).map(function (t) { return t.team_id; }) };
  }
  function who(uid) { var p = st.d.people[uid]; return p ? (p.name || TL().name(p.team)) : "an officer"; }
  function entryList(rows, table, books) {
    if (!rows.length) return '<p class="muted small">None yet.</p>';
    var v = viewer();
    return '<ul class="po-list tr-ledger">' + rows.map(function (x) {
      var own = v.teams.indexOf(x.team_id) >= 0;
      var actions = x.status === "pending"
        ? (canConfirm(x, v) ? '<button class="btn" type="button" data-tr="confirm" data-table="' + table + '" data-id="' + x.id + '">Confirm</button> <button class="btn ghost" type="button" data-tr="reject" data-table="' + table + '" data-id="' + x.id + '">Reject</button>'
          : x.created_by === v.id ? '<button class="linkish" type="button" data-tr="delete" data-table="' + table + '" data-id="' + x.id + '">withdraw</button>' : "")
        : books && !own ? '<button class="linkish" type="button" data-tr="delete" data-table="' + table + '" data-id="' + x.id + '">delete</button>' : "";
      return "<li><b>" + esc(x.paid_at || x.entry_date) + "</b><span>" + tlink(x.team_id) + (x.kind ? " " + esc(EMPIRE_KINDS[x.kind] || x.kind) : "") +
        (x.method ? ' <span class="muted small">' + esc(x.method) + "</span>" : "") + (x.note ? ' <span class="muted small">' + esc(x.note) + "</span>" : "") +
        (x.status === "pending" ? ' <span class="tag cm-bad">Waiting for a commissioner</span>' : "") + "</span><span>" + money(x.amount) + "</span>" + (actions ? "<span>" + actions + "</span>" : "") + "</li>";
    }).join("") + "</ul>";
  }
  function render() {
    var el = st.el, d = st.d, info = d.info || {}, books = !!info.keeps_books;
    var m = st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '" role="status">' + esc(st.msg.err || st.msg.ok) + "</p>" : "";
    st.msg = null;
    var pending = d.fees.filter(function (x) { return x.status === "pending"; }).map(function (x) { return Object.assign({ _t: "fee_payments", _l: "Fee" }, x); })
      .concat(d.payouts.filter(function (x) { return x.status === "pending"; }).map(function (x) { return Object.assign({ _t: "payout_payments", _l: "Payout" }, x); }))
      .concat(d.empire.filter(function (x) { return x.status === "pending"; }).map(function (x) { return Object.assign({ _t: "empire_ledger", _l: "Empire pot" }, x); }));
    var pendHtml = pending.length ? '<div class="card"><h3>Waiting for a commissioner</h3><p class="muted small">A bookkeeper\'s entry for his own team counts only once a commissioner who doesn\'t own that team confirms it.</p>' +
      '<ul class="po-list">' + pending.map(function (x) {
        var v = viewer();
        return "<li><b>" + esc(x._l) + "</b><span>" + tlink(x.team_id) + ' <span class="muted small">recorded by ' + esc(who(x.created_by)) + "</span></span><span>" + money(x.amount) + "</span><span>" +
          (canConfirm(x, v) ? '<button class="btn" type="button" data-tr="confirm" data-table="' + x._t + '" data-id="' + x.id + '">Confirm</button> <button class="btn ghost" type="button" data-tr="reject" data-table="' + x._t + '" data-id="' + x.id + '">Reject</button>'
            : '<span class="muted small">' + (v.commissioner ? "another commissioner confirms this one" : "a commissioner confirms it") + "</span>") + "</span></li>";
      }).join("") + "</ul></div>" : "";
    var bal = '<div class="card"><h3>Balances</h3><div class="table-wrap"><table class="po-table"><thead><tr><th>Team</th><th class="num">Fee due</th><th class="num">Fee paid</th><th class="num">Won</th><th class="num hide-sm">Projected</th><th class="num">Paid out</th><th class="num">Owed</th></tr></thead><tbody>' +
      d.balances.map(function (b) {
        var unpaid = Number(b.fee_paid) < Number(b.fee_due);
        return "<tr><td>" + tlink(b.team_id) + (b.pending ? ' <span class="tag cm-bad" title="Entries waiting for a commissioner">' + esc(b.pending) + " pending</span>" : "") + '</td><td class="num">' + money(b.fee_due) +
          '</td><td class="num">' + (unpaid ? '<b class="po-owe">' + money(b.fee_paid) + "</b>" : money(b.fee_paid)) + '</td><td class="num">' + money(b.won) + '</td><td class="num hide-sm muted">' + (Number(b.projected) ? money(b.projected) : "–") +
          '</td><td class="num">' + money(b.paid_out) + '</td><td class="num"><b>' + money(b.owed) + "</b></td></tr>";
      }).join("") + '</tbody></table></div><button class="btn ghost" type="button" data-tr="csv">Download the ledger (CSV)</button>' +
      '<p class="muted small">Won = final awards (overrides applied); Owed = won minus paid out. Awards are decided automatically or by the commissioner, never here.</p></div>';
    var feeForm = books ? '<form class="acct-form" data-tr="fee"><label>Team' + teamSelect("team") + "</label>" +
      '<label>Amount<input name="amount" type="number" step="0.01" min="0.01" required value="' + esc(d.buyIn) + '"></label>' +
      '<label>Paid on<input name="paid_at" type="date" required value="' + today() + '"></label><label>Method' + methodSelect + "</label>" +
      '<label>Note<input name="note" maxlength="200"></label><button class="btn" type="submit">Record fee paid</button></form>' : "";
    var payForm = books ? '<form class="acct-form" data-tr="payout"><label>Team' + teamSelect("team") + "</label>" +
      '<label>Amount<input name="amount" type="number" step="0.01" min="0.01" required></label>' +
      '<label>Paid on<input name="paid_at" type="date" required value="' + today() + '"></label><label>Method' + methodSelect + "</label>" +
      '<label>Note<input name="note" maxlength="200" placeholder="e.g. week 8 high score"></label><button class="btn" type="submit">Record payout</button></form>' : "";
    var eb = empireBalance(d.empire);
    var empForm = books ? '<form class="acct-form" data-tr="empire"><label>Entry<select name="kind">' + Object.keys(EMPIRE_KINDS).map(function (k) { return '<option value="' + k + '">' + esc(EMPIRE_KINDS[k]) + "</option>"; }).join("") + "</select></label>" +
      '<label>Amount (payouts and rollovers out are taken off)<input name="amount" type="number" step="0.01" min="0.01" required></label>' +
      '<label>Team (payouts)<select name="team"><option value="">None</option>' + TL().ids().map(function (id) { return TL().option(id); }).join("") + "</select></label>" +
      '<label>Season<input name="season" type="number" value="' + season + '" required></label><label>Note<input name="note" maxlength="200"></label><button class="btn ghost" type="submit">Add to the Empire ledger</button></form>' : "";
    var prefs = info.is_treasurer ? '<div class="card"><h3>Payment preferences</h3><p class="muted small"><b>Private:</b> only you (treasurer) and each owner see these. Owners edit theirs on their Account page.</p>' +
      (d.prefs.length ? '<div class="table-wrap"><table class="po-table tr-prefs"><thead><tr><th>Owner</th><th>Venmo</th><th>PayPal</th><th>Mail</th><th>In person</th></tr></thead><tbody>' + d.prefs.map(function (x) {
        var p = d.people[x.user_id] || {};
        return "<tr><td>" + esc(p.name || "Owner") + (p.team ? " · " + tlink(p.team) : "") + (x.note ? '<br><span class="muted small">' + esc(x.note) + "</span>" : "") + "</td><td>" + esc(x.venmo || "") + "</td><td>" + esc(x.paypal || "") +
          '</td><td class="tr-addr">' + esc(x.mailing_address || "") + "</td><td>" + (x.in_person ? "Yes" : "") + "</td></tr>";
      }).join("") + "</tbody></table></div>" : '<p class="muted">No owner has entered payment preferences yet.</p>') + "</div>" : "";
    el.innerHTML = '<section class="po tr"><h2>Treasury</h2><p>' + esc(roleText(info)) + ' <a href="#payouts">Payouts page</a>' + (st.me.profile && st.me.profile.is_commissioner ? ' · <a href="#commish-payouts">Commissioner payout tools</a>' : "") + "</p>" + m + pendHtml +
      '<div class="po-cols"><div>' + bal + '<div class="card"><h3>Empire pot: ' + money(eb) + "</h3>" + entryList(d.empire, "empire_ledger", books) + empForm + "</div>" + prefs + "</div><div>" +
      '<div class="card"><h3>Winnings paid out</h3>' + payForm + entryList(d.payouts, "payout_payments", books) + "</div>" +
      '<div class="card"><h3>League fees paid</h3>' + feeForm + entryList(d.fees, "fee_payments", books) + "</div></div></div>" +
      '<p class="muted small">A ledger only: no money moves through the site. Every entry is in the audit log; an entry for your own team waits for a commissioner.</p></section>';
  }

  function start(el) {
    st.el = el;
    el.innerHTML = '<section><h2>Treasury</h2><p class="muted">Loading…</p></section>';
    var acct = root.B5Account;
    (acct ? acct.load() : Promise.resolve(null)).then(function (me) {
      st.me = me;
      if (acct) acct.refreshNav();
      if (!me) { el.innerHTML = '<section><h2>Treasury</h2><div class="card"><p><a href="#account">Sign in</a> first.</p></div></section>'; return; }
      var p = me.profile || {};
      if (!(p.is_treasurer || p.is_commissioner)) { el.innerHTML = '<section><h2>Treasury</h2><div class="card"><p>The Treasury is for the league\'s treasurer and commissioners.</p></div></section>'; return; }
      return load().then(render);
    }).catch(function (e) { el.innerHTML = '<section><h2>Treasury</h2><p class="acct-msg err">Couldn\'t load: ' + esc(e.message) + "</p></section>"; });
    if (el.dataset.trBound) return;
    el.dataset.trBound = "1";
    var after = function (p, okText) {
      return p.then(function (r) { st.msg = r.ok ? { ok: okText } : { err: String(r.error || "Couldn't save.").replace(/^.*?: /, "") }; return load(); }).then(render);
    };
    el.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-tr]");
      if (!form) return;
      e.preventDefault();
      var fd = new FormData(form), k = form.dataset.tr, val = function (n) { return String(fd.get(n) || "").trim() || null; };
      if (k === "fee" || k === "payout") {
        var row = { season: season, team_id: val("team"), amount: Number(fd.get("amount")), paid_at: val("paid_at"), method: val("method"), note: val("note") };
        after(api(k === "fee" ? "fee_payments" : "payout_payments", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } }),
          (k === "fee" ? "Fee payment" : "Payout") + " recorded for " + TL().name(row.team_id) + ".");
      } else if (k === "empire") {
        var kind = val("kind"), amt = Number(fd.get("amount")), out = kind === "payout" || kind === "rollover";
        after(api("empire_ledger", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ season: Number(fd.get("season")), kind: kind, amount: out ? -amt : amt, team_id: val("team"), note: val("note") }) }),
          "Empire ledger updated.");
      }
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tr]");
      if (!b || b.tagName === "FORM") return;
      var k = b.dataset.tr;
      if (k === "csv") {
        var blob = new Blob([csv(ledgerRows(st.d, function (id) { return TL().name(id); }))], { type: "text/csv" });   // teamlink-ok: CSV cells are plain text
        var a = root.document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "b5-ledger-" + season + ".csv";
        root.document.body.appendChild(a); a.click(); a.remove();
      } else if (k === "confirm" || k === "reject") {
        after(rpc("confirm_payment", { p_table: b.dataset.table, p_id: Number(b.dataset.id), p_approve: k === "confirm" }), k === "confirm" ? "Confirmed." : "Rejected and removed.");
      } else if (k === "delete" && root.confirm("Delete this entry? It stays in the audit log.")) {
        after(api(b.dataset.table + "?id=eq." + Number(b.dataset.id), { method: "DELETE", headers: { Prefer: "return=minimal" } }), "Entry deleted.");
      }
    });
  }

  root.B5Treasury = { start: start, canConfirm: canConfirm, empireBalance: empireBalance, roleText: roleText, ledgerRows: ledgerRows, csv: csv };
})(typeof globalThis !== "undefined" ? globalThis : this);
