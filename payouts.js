/* Payouts (#payouts, public) and the commissioner's payout tools (#commish-payouts).
   Replaces the payout spreadsheet. A LEDGER ONLY: no money moves through the site, and no
   addresses or payment handles are stored. Rules and auto awards: src/league/payouts.ts
   (computed nightly and during live games); this page only reads and displays them, and
   lets the commissioner record fees, payments, manual awards and overrides (all audited).
   All data is escaped before it goes into HTML. */
(function (root) {
  "use strict";
  var L = root.LEAGUE || {}, cfg = root.B5_SUPABASE, A = root.B5Auth;
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var f = function (u, i) { return root.fetch(u, i); };
  var season = Number(L.season);
  var TL = function () { return root.B5Team; };   // team names and profile links (teamlink.js)
  var tlink = function (id) { return TL().link(id, { logo: false }); };
  var cents = function (n) { return Math.round(Number(n || 0) * 100); };
  var money = function (n) {
    var c = cents(n), neg = c < 0; c = Math.abs(c);
    var s = "$" + Math.floor(c / 100).toLocaleString("en-US") + (c % 100 ? "." + String(c % 100).padStart(2, "0") : "");
    return neg ? "-" + s : s;
  };
  var sum = function (rows, fn) { return rows.reduce(function (s, r) { return s + cents(fn ? fn(r) : r.amount); }, 0) / 100; };
  var tag = function (status) { return status === "final" ? '<span class="tag">Final</span>' : '<span class="tag po-proj">Projected</span>'; };
  var groupKey = function (a) { return a.kind + "|" + (a.week == null ? "" : a.week) + "|" + (a.place == null ? "" : a.place); };

  // ---- Pure helpers (tested in src/workers/payouts-page.test.ts) ------------------
  /** Awards as shown: an override replaces the auto awards of its group. */
  function effectiveAwards(awards) {
    var over = {};
    awards.forEach(function (a) { if (a.source === "override") over[groupKey(a)] = true; });
    return awards.filter(function (a) { return a.source !== "auto" || !over[groupKey(a)]; });
  }
  function potOf(s) { return (cents(s.team_count * s.buy_in) - cents(s.website_fee) - cents(s.empire_contribution)) / 100; }
  /** Per-team winnings: { team: { final, projected } } (Empire pot included, it's real money too). */
  function winningsByTeam(awards) {
    var out = {};
    effectiveAwards(awards).forEach(function (a) {
      var w = out[a.team_id] = out[a.team_id] || { final: 0, projected: 0 };
      if (a.status === "final") w.final = (cents(w.final) + cents(a.amount)) / 100;
      else w.projected = (cents(w.projected) + cents(a.amount)) / 100;
    });
    return out;
  }
  /** Ledger per team: winnings (final), paid out, owed = final winnings - paid. */
  function balances(awards, payments, fees) {
    var win = winningsByTeam(awards), out = [];
    TL().ids().forEach(function (id) {
      var paid = sum(payments.filter(function (p) { return p.team_id === id; }));
      var fee = fees.filter(function (x) { return x.team_id === id; })[0] || null;
      var w = win[id] || { final: 0, projected: 0 };
      out.push({ team_id: id, fee_due: fee ? Number(fee.amount_due) : null, fee_paid: fee ? !!fee.paid : null,
        won: w.final, projected: w.projected, paid_out: paid, owed: (cents(w.final) - cents(paid)) / 100 });
    });
    return out;
  }
  function empireState(s, awards) {
    var balance = (cents(s.empire_carry_in) + cents(s.empire_contribution)) / 100;
    var eff = effectiveAwards(awards);
    var paid = eff.filter(function (a) { return a.kind === "empire"; })[0];
    var champ = eff.filter(function (a) { return a.kind === "champion" && a.status === "final"; })[0];
    if (paid) return { balance: balance, outcome: "paid", team: paid.team_id, defending: s.empire_defending_team };
    if (champ) return { balance: balance, outcome: "rolled", team: champ.team_id, defending: s.empire_defending_team, next: balance };
    return { balance: balance, outcome: "watch", team: null, defending: s.empire_defending_team };
  }
  function csv(rows) {
    var cell = function (v) { var s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return rows.map(function (r) { return r.map(cell).join(","); }).join("\n") + "\n";
  }

  // ---- Data -----------------------------------------------------------------------
  var st = { me: null, data: null, msg: null };
  function session() { return st.me && st.me.session; }
  function get(path) { return A.api(cfg, session(), path, {}, f); }
  function load(admin) {
    var q = "?season=eq." + season;
    var reqs = [
      get("season_settings" + q + "&select=*"),
      get("awards" + q + "&select=id,kind,week,place,label,team_id,amount,status,source,note&order=kind,week,place,team_id"),
      get("guillotine" + q + "&select=week,team_id,points,status,source,note&order=week"),
      get("team_scores" + q + "&select=week,team_id,points,status")
    ];
    if (session()) {
      reqs.push(get("team_fees" + q + "&select=team_id,amount_due,paid,paid_at,note&order=team_id"));
      reqs.push(get("payout_payments" + q + "&select=id,team_id,amount,paid_at,note&order=paid_at.desc,id.desc"));
      reqs.push(A.api(cfg, session(), "rpc/payout_league_totals", { method: "POST", body: JSON.stringify({ p_season: season }) }, f));
      if (admin) reqs.push(get("payout_flags" + q + "&select=flags,computed_at"));
    }
    return Promise.all(reqs).then(function (r) {
      var ok = function (x) { return x && x.ok ? x.data || [] : []; };
      st.data = {
        settings: ok(r[0])[0] || null, awards: ok(r[1]), guillotine: ok(r[2]), scores: ok(r[3]),
        fees: ok(r[4]), payments: ok(r[5]), totals: r[6] && r[6].ok ? r[6].data : null,
        flags: r[7] && r[7].ok && r[7].data[0] ? r[7].data[0] : null,
        errors: r.filter(function (x) { return x && !x.ok; }).map(function (x) { return x.error; })
      };
    });
  }

  // ---- Public page ------------------------------------------------------------------
  function prizeRows(s, eff) {
    var p = s.prizes || {}, out = [];
    var who = function (kind, extra) {
      var rows = eff.filter(function (a) { return a.kind === kind && (!extra || extra(a)); });
      if (!rows.length) return '<span class="muted">Not yet</span>';
      return rows.map(function (a) { return tlink(a.team_id) + " " + money(a.amount) + " " + tag(a.status); }).join("<br>");
    };
    if (p.weekly_high) {
      var n = p.weekly_high.last_week - p.weekly_high.first_week + 1;
      var won = eff.filter(function (a) { return a.kind === "weekly_high"; });
      var weeks = {}; won.forEach(function (a) { weeks[a.week] = 1; });
      out.push(["Weekly high score", money(p.weekly_high.amount) + " × " + n + " weeks (" + p.weekly_high.first_week + "–" + p.weekly_high.last_week + ")",
        money(p.weekly_high.amount * n), Object.keys(weeks).length + " of " + n + " weeks decided"]);
    }
    if (p.playoffs) {
      out.push(["Playoffs: round 1 win (wk " + p.playoffs.weeks[0] + ")", money(p.playoffs.r1) + " × " + p.playoffs.r1_games, money(p.playoffs.r1 * p.playoffs.r1_games), who("playoff_r1")]);
      out.push(["Playoffs: round 2 win (wk " + p.playoffs.weeks[1] + ")", money(p.playoffs.r2) + " × " + p.playoffs.r2_games, money(p.playoffs.r2 * p.playoffs.r2_games), who("playoff_r2")]);
      out.push(["Champion (wk " + p.playoffs.weeks[2] + ")", money(p.playoffs.champion) + " (collects every round: " + money(p.playoffs.r1 + p.playoffs.r2 + p.playoffs.champion) + ")", money(p.playoffs.champion), who("champion")]);
    }
    if (p.season_points) {
      ["Most points", "2nd most points", "3rd most points"].forEach(function (lbl, i) {
        if (p.season_points.amounts[i] == null) return;
        out.push([lbl + " (wks " + p.season_points.first_week + "–" + p.season_points.last_week + ")", "", money(p.season_points.amounts[i]),
          who("season_points", function (a) { return a.place === i + 1; })]);
      });
    }
    if (p.guillotine) out.push(["Guillotine (last team standing)", "from week " + p.guillotine.start_week, money(p.guillotine.amount), who("guillotine")]);
    (p.manual || []).forEach(function (m) {
      out.push([m.label, "entered by the commissioner", money(m.amount), who("manual", function (a) { return a.label === m.label; })]);
    });
    return out;
  }

  function publicHtml() {
    var d = st.data, s = d && d.settings;
    if (!s) return '<section><h2>Payouts</h2><div class="card muted">No payout settings for ' + esc(season) + " yet.</div></section>";
    var eff = effectiveAwards(d.awards), potAmt = potOf(s);
    var pot = eff.filter(function (a) { return a.kind !== "empire"; });
    var fin = sum(pot.filter(function (a) { return a.status === "final"; })), proj = sum(pot.filter(function (a) { return a.status !== "final"; }));
    var remaining = (cents(potAmt) - cents(fin) - cents(proj)) / 100;

    var head = '<div class="card po-pot"><div class="po-pot-line">' + esc(s.team_count) + " teams × " + money(s.buy_in) + " = " + money(s.team_count * s.buy_in) +
      " − " + money(s.website_fee) + " website − " + money(s.empire_contribution) + " Empire = <b>" + money(potAmt) + " paid out</b></div>" +
      '<div class="mt-stats"><div><b>' + money(fin) + "</b><span>Awarded</span></div><div><b>" + money(proj) + "</b><span>Projected</span></div><div><b>" +
      money(remaining) + "</b><span>Still to win</span></div></div>" +
      '<p class="muted small">Projected = this week\'s leaders and season-long races; they become final once the week is locked. A ledger only: winnings are paid by the commissioner.</p></div>';

    var prizes = '<div class="card"><h3>Prizes</h3><div class="table-wrap"><table class="po-table"><thead><tr><th>Prize</th><th class="hide-sm">How</th><th class="num">Amount</th><th>Winner(s)</th></tr></thead><tbody>' +
      prizeRows(s, eff).map(function (r) { return "<tr><td>" + esc(r[0]) + '</td><td class="muted hide-sm">' + esc(r[1]) + '</td><td class="num">' + esc(r[2]) + "</td><td>" + r[3] + "</td></tr>"; }).join("") +
      "</tbody></table></div></div>";

    var weekly = eff.filter(function (a) { return a.kind === "weekly_high"; }).sort(function (a, b) { return a.week - b.week; });
    var weeklyHtml = '<div class="card"><h3>Weekly high scores</h3>' + (weekly.length ? '<ul class="po-list">' + weekly.map(function (a) {
      return "<li><b>Wk " + esc(a.week) + "</b><span>" + tlink(a.team_id) + (a.note ? ' <span class="muted small">' + esc(a.note) + "</span>" : "") + "</span><span>" + money(a.amount) + "</span>" + tag(a.status) + "</li>";
    }).join("") + "</ul>" : '<p class="muted">None yet.</p>') + "</div>";

    var out = {}; d.guillotine.forEach(function (g) { out[g.team_id] = g; });
    var alive = TL().ids().filter(function (id) { return !out[id]; });
    var gWin = eff.filter(function (a) { return a.kind === "guillotine"; })[0];
    var guill = '<div class="card"><h3>Guillotine</h3>' +
      (gWin ? '<p class="acct-msg ok">' + tlink(gWin.team_id) + " is the last team standing: " + money(gWin.amount) + " " + tag(gWin.status) + "</p>" : "") +
      '<p class="muted small">Lowest score among teams still alive is eliminated each week from week ' + esc((s.prizes.guillotine || {}).start_week) + ". " + esc(alive.length) + " still alive.</p>" +
      '<ul class="po-list">' + d.guillotine.map(function (g) {
        return "<li><b>Wk " + esc(g.week) + "</b><span>" + tlink(g.team_id) + (g.points != null ? ' <span class="muted small">' + esc(Number(g.points).toFixed(1)) + "</span>" : "") +
          (g.source === "override" ? ' <span class="muted small">(commissioner)</span>' : "") + "</span><span></span>" + tag(g.status) + "</li>";
      }).join("") + "</ul>" +
      (alive.length ? '<p class="small"><b>Alive:</b> ' + alive.map(tlink).join(", ") + "</p>" : "") + "</div>";

    var totals = {};
    d.scores.forEach(function (x) { totals[x.team_id] = (cents(totals[x.team_id] ? totals[x.team_id] : 0) + cents(x.points)) / 100; });
    var ranked = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var pts = '<div class="card"><h3>Season points</h3>' + (ranked.length ? '<ol class="po-rank">' + ranked.map(function (t) {
      return "<li><span>" + tlink(t) + "</span><b>" + esc(totals[t].toFixed(1)) + "</b></li>";
    }).join("") + "</ol>" : '<p class="muted">No scores yet.</p>') + "</div>";

    var e = empireState(s, d.awards);
    var empire = '<div class="card po-empire"><h3>Empire pot</h3><div class="mt-stats"><div><b>' + money(e.balance) + "</b><span>Balance</span></div></div>" +
      "<p>" + (e.outcome === "paid" ? "Paid to " + tlink(e.team) + ", back-to-back champion."
        : e.outcome === "rolled" ? tlink(e.team) + " won, but not back to back: the pot rolls into " + esc(season + 1) + " (+" + money(s.empire_contribution) + ")."
        : e.defending ? "On Empire watch: <b>" + tlink(e.defending) + "</b> (" + esc(season - 1) + " champion). Win again and the pot is theirs."
        : '<span class="muted">The ' + esc(season - 1) + " champion hasn't been entered yet.</span>") + "</p>" +
      '<p class="muted small">Grows ' + money(s.empire_contribution) + " a season from fees; paid to a team that wins the championship two seasons in a row.</p></div>";

    var win = winningsByTeam(d.awards);
    var byTeam = '<div class="card"><h3>Winnings by team</h3><div class="table-wrap"><table class="po-table"><thead><tr><th>Team</th><th class="num">Won</th><th class="num">Projected</th></tr></thead><tbody>' +
      TL().ids().sort(function (a, b) {
        var wa = win[a] || { final: 0, projected: 0 }, wb = win[b] || { final: 0, projected: 0 };
        return (wb.final + wb.projected) - (wa.final + wa.projected);
      }).map(function (id) {
        var w = win[id] || { final: 0, projected: 0 };
        return "<tr><td>" + tlink(id) + '</td><td class="num">' + money(w.final) + '</td><td class="num muted">' + (w.projected ? money(w.projected) : "–") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";

    return '<section class="po"><h2>' + esc(season) + " Payouts</h2>" + head + memberHtml() +
      '<div class="po-cols"><div>' + prizes + weeklyHtml + byTeam + "</div><div>" + guill + empire + pts + "</div></div></section>";
  }

  // Signed-in member: his own ledger row + league totals.
  function memberHtml() {
    var d = st.data;
    if (!st.me || !st.me.teams || !st.me.teams.length) return "";
    var mine = st.me.teams[0].team_id, b = balances(d.awards, d.payments, d.fees).filter(function (x) { return x.team_id === mine; })[0];
    var t = d.totals;
    return '<div class="card po-mine"><h3>' + tlink(mine) + ": your ledger</h3>" +
      "<p>League fee: " + (b.fee_paid == null ? '<span class="muted">not recorded</span>' : b.fee_paid ? "<b>paid</b> (" + money(b.fee_due) + ")" : '<b class="po-owe">unpaid</b> (' + money(b.fee_due) + ")") + "</p>" +
      "<p>Won " + money(b.won) + (b.projected ? " (+" + money(b.projected) + " projected)" : "") + " · paid to you " + money(b.paid_out) + " · <b>owed to you " + money(Math.max(0, b.owed)) + "</b></p>" +
      (t ? '<p class="muted small">League: ' + esc(t.teams_paid) + " of " + esc(t.teams_paid + t.teams_unpaid) + " fees paid (" + money(t.fees_paid) + " of " + money(t.fees_due) + "), " + money(t.paid_out) + " paid out so far.</p>" : "") + "</div>";
  }

  // ---- Commissioner tools -----------------------------------------------------------
  function teamOptions(sel) {
    return TL().ids().map(function (id) { return TL().option(id, id === sel); }).join("");
  }
  function adminHtml() {
    var d = st.data, s = d.settings;
    if (!s) return '<section><h2>Payout tools</h2><div class="card muted">No payout settings for ' + esc(season) + ".</div></section>";
    var m = st.msg ? '<p class="acct-msg ' + (st.msg.err ? "err" : "ok") + '">' + esc(st.msg.err || st.msg.ok) + "</p>" : "";
    st.msg = null;
    var flags = (d.flags && d.flags.flags) || [];
    var flagsHtml = '<div class="card"><h3>Needs your decision</h3>' + (flags.length ? '<ul class="checks">' + flags.map(function (x) {
      return "<li>" + esc(x.message).replace(/\b(\d{4})\b/g, function (id) { return TL().has(id) ? tlink(id) : id; }) + "</li>";
    }).join("") + "</ul>" : '<p class="acct-msg ok">Nothing to decide. Auto awards match the spreadsheet\'s recorded winners.</p>') +
      (d.flags ? '<p class="muted small">Computed ' + esc(new Date(d.flags.computed_at).toLocaleString("en-US", { timeZone: "America/New_York" })) + " ET.</p>" : "") + "</div>";

    var empire = '<div class="card"><h3>Empire watch</h3><form class="acct-form" data-po="empire"><label>' + esc(season - 1) + ' champion (defending)<select name="team"><option value="">Not entered</option>' +
      teamOptions(s.empire_defending_team) + '</select></label><button class="btn ghost" type="submit">Save</button></form>' +
      '<p class="muted small">Until the history import, enter last season\'s champion here. Balance: ' + money(empireState(s, d.awards).balance) + ".</p></div>";

    var feeRows = TL().ids().map(function (id) {
      var fee = d.fees.filter(function (x) { return x.team_id === id; })[0] || {};
      return '<tr><td>' + tlink(id) + '</td><td><form class="po-inline" data-po="fee" data-team="' + esc(id) + '">' +
        '<input name="amount_due" type="number" step="0.01" min="0" value="' + esc(fee.amount_due != null ? fee.amount_due : s.buy_in) + '" aria-label="Fee due">' +
        '<label class="acct-check"><input type="checkbox" name="paid"' + (fee.paid ? " checked" : "") + "> Paid</label>" +
        '<input name="paid_at" type="date" value="' + esc(fee.paid_at || "") + '" aria-label="Paid on">' +
        '<button class="btn ghost" type="submit">Save</button></form></td></tr>';
    }).join("");
    var fees = '<div class="card"><h3>League fees</h3><div class="table-wrap"><table class="po-table"><tbody>' + feeRows + "</tbody></table></div></div>";

    var bal = balances(d.awards, d.payments, d.fees);
    var balHtml = '<div class="card"><h3>Balances</h3><div class="table-wrap"><table class="po-table"><thead><tr><th>Team</th><th>Fee</th><th class="num">Won</th><th class="num hide-sm">Projected</th><th class="num">Paid out</th><th class="num">Owed</th></tr></thead><tbody>' +
      bal.map(function (b) {
        return "<tr><td>" + tlink(b.team_id) + "</td><td>" + (b.fee_paid == null ? '<span class="muted">–</span>' : b.fee_paid ? "Paid" : '<b class="po-owe">Unpaid</b>') + '</td><td class="num">' + money(b.won) +
          '</td><td class="num hide-sm muted">' + (b.projected ? money(b.projected) : "–") + '</td><td class="num">' + money(b.paid_out) + '</td><td class="num"><b>' + money(b.owed) + "</b></td></tr>";
      }).join("") + '</tbody></table></div><button class="btn ghost" type="button" data-po="csv">Download CSV</button></div>';

    var pay = '<div class="card"><h3>Record a payout</h3><form class="acct-form" data-po="payment">' +
      '<label>Team<select name="team" required><option value="">Pick a team</option>' + teamOptions() + "</select></label>" +
      '<label>Amount<input name="amount" type="number" step="0.01" min="0.01" required></label>' +
      '<label>Paid on<input name="paid_at" type="date" required value="' + esc(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })) + '"></label>' +
      '<label>Note<input name="note" maxlength="120" placeholder="e.g. weeks 1-5 high scores"></label>' +
      '<button class="btn" type="submit">Record payout</button><p class="muted small">Ledger only. Don\'t enter payment handles or addresses.</p></form>' +
      (d.payments.length ? '<ul class="po-list">' + d.payments.map(function (p) {
        return "<li><b>" + esc(p.paid_at) + "</b><span>" + tlink(p.team_id) + (p.note ? ' <span class="muted small">' + esc(p.note) + "</span>" : "") + "</span><span>" + money(p.amount) +
          '</span><button class="linkish" type="button" data-po="del-payment" data-id="' + esc(p.id) + '">delete</button></li>';
      }).join("") + "</ul>" : "") + "</div>";

    var manualOpts = (s.prizes.manual || []).map(function (x) { return '<option value="' + esc(x.label) + '" data-amount="' + esc(x.amount) + '">' + esc(x.label) + " (" + money(x.amount) + ")</option>"; }).join("");
    var manualList = d.awards.filter(function (a) { return a.source === "manual"; });
    var manual = '<div class="card"><h3>Manual awards</h3><form class="acct-form" data-po="manual">' +
      '<label>Prize<select name="label" required>' + manualOpts + "</select></label>" +
      '<label>Team(s)<select name="teams" multiple size="4" required>' + teamOptions() + "</select></label>" +
      '<label>Total amount (split evenly if several teams)<input name="amount" type="number" step="0.01" min="0" placeholder="prize amount"></label>' +
      '<button class="btn" type="submit">Add award</button></form>' +
      (manualList.length ? '<ul class="po-list">' + manualList.map(function (a) {
        return "<li><b>" + esc(a.label) + "</b><span>" + tlink(a.team_id) + "</span><span>" + money(a.amount) + '</span><button class="linkish" type="button" data-po="del-award" data-id="' + esc(a.id) + '">delete</button></li>';
      }).join("") + "</ul>" : "") + "</div>";

    var groups = {};
    effectiveAwards(d.awards).filter(function (a) { return a.source !== "manual"; }).forEach(function (a) {
      var k = groupKey(a); (groups[k] = groups[k] || { kind: a.kind, week: a.week, place: a.place, label: a.label, source: a.source, teams: [] }).teams.push(a.team_id);
    });
    var gKeys = Object.keys(groups);
    var over = '<div class="card"><h3>Override an award</h3><form class="acct-form" data-po="override">' +
      '<label>Award<select name="group" required>' + gKeys.map(function (k) {
        var g = groups[k]; return '<option value="' + esc(k) + '" data-label="' + esc(g.label) + '">' + esc(g.label) + ": " + esc(g.teams.map(function (id) { return TL().name(id); }).join(" & ")) + (g.source === "override" ? " (overridden)" : "") + "</option>";   // teamlink-ok: <option> label in the override picker (plain text)
      }).join("") + "</select></label>" +
      '<label>Winner(s)<select name="teams" multiple size="4" required>' + teamOptions() + "</select></label>" +
      '<label>Total amount<input name="amount" type="number" step="0.01" min="0" required></label>' +
      '<label>Reason (required, kept in the audit log)<input name="note" required maxlength="200"></label>' +
      '<button class="btn" type="submit">Override</button> <button class="btn ghost" type="button" data-po="clear-override">Remove override</button></form>' +
      '<p class="muted small">An override replaces the computed winners for that prize and is final. Removing it lets the computed result return on the next refresh.</p></div>';

    var gOver = '<div class="card"><h3>Guillotine decision</h3><form class="acct-form" data-po="guillotine">' +
      '<label>Week<input name="week" type="number" min="1" max="17" required></label>' +
      '<label>Eliminated team<select name="team" required>' + teamOptions() + "</select></label>" +
      '<label>Reason (required)<input name="note" required maxlength="200" placeholder="e.g. tie broken by bench points"></label>' +
      '<button class="btn" type="submit">Eliminate</button></form><p class="muted small">For ties or corrections. Later weeks are recomputed on the next refresh.</p></div>';

    return '<section class="po"><h2>Payout tools</h2><p><a href="#commish">← Commissioner</a> · <a href="#payouts">Public payouts page</a></p>' + m +
      '<div class="po-cols"><div>' + flagsHtml + balHtml + fees + "</div><div>" + pay + manual + over + gOver + empire + "</div></div></section>";
  }

  function exportCsv() {
    var d = st.data, rows = [["Team", "Fee due", "Fee paid", "Won (final)", "Projected", "Paid out", "Owed"]];
    balances(d.awards, d.payments, d.fees).forEach(function (b) { rows.push([TL().name(b.team_id), b.fee_due, b.fee_paid == null ? "" : b.fee_paid ? "yes" : "no", b.won, b.projected, b.paid_out, b.owed]); });
    rows.push([]); rows.push(["Award", "Week", "Place", "Team", "Amount", "Status", "Source", "Note"]);
    effectiveAwards(d.awards).forEach(function (a) { rows.push([a.label, a.week, a.place, TL().name(a.team_id), a.amount, a.status, a.source, a.note]); });
    rows.push([]); rows.push(["Payout", "Team", "Amount", "Paid on", "Note"]);
    d.payments.forEach(function (p) { rows.push(["", TL().name(p.team_id), p.amount, p.paid_at, p.note]); });
    var blob = new Blob([csv(rows)], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "b5-payouts-" + season + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  }

  function startAdmin(rootEl) {
    var api = function (path, method, body, prefer) { return A.api(cfg, session(), path, { method: method, body: body == null ? undefined : JSON.stringify(body), headers: { Prefer: prefer || "return=minimal" } }, f); };
    var redraw = function (r, okMsg) {
      st.msg = r && r.ok === false ? { err: r.error } : okMsg ? { ok: okMsg } : null;
      return load(true).then(function () { rootEl.innerHTML = adminHtml(); });
    };
    rootEl.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-po]"); if (!form) return;
      e.preventDefault();
      var fd = new FormData(form), kind = form.dataset.po;
      var multi = function () { return [].slice.call(form.querySelectorAll("select[name=teams] option:checked")).map(function (o) { return o.value; }); };
      var split = function (total, ids) {
        var c = Math.round(Number(total) * 100), base = Math.floor(c / ids.length), extra = c - base * ids.length;
        return ids.slice().sort().map(function (t, i) { return { team_id: t, amount: (base + (i < extra ? 1 : 0)) / 100 }; });
      };
      if (kind === "fee") {
        api("team_fees?on_conflict=season,team_id", "POST", [{ season: season, team_id: form.dataset.team, amount_due: Number(fd.get("amount_due") || 0),
          paid: fd.get("paid") === "on", paid_at: fd.get("paid_at") || null, updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal")
          .then(function (r) { return redraw(r, "Fee saved for " + TL().name(form.dataset.team) + "."); });
      } else if (kind === "payment") {
        api("payout_payments", "POST", { season: season, team_id: fd.get("team"), amount: Number(fd.get("amount")), paid_at: fd.get("paid_at"), note: String(fd.get("note") || "").trim() || null })
          .then(function (r) { return redraw(r, "Recorded " + money(fd.get("amount")) + " to " + TL().name(fd.get("team")) + "."); });
      } else if (kind === "manual") {
        var opt = form.querySelector("select[name=label] option:checked"), ids = multi();
        var total = fd.get("amount") ? Number(fd.get("amount")) : Number(opt && opt.dataset.amount || 0);
        api("awards", "POST", split(total, ids).map(function (x) {
          return { season: season, kind: "manual", label: fd.get("label"), team_id: x.team_id, amount: x.amount, status: "final", source: "manual" };
        })).then(function (r) { return redraw(r, "Added " + fd.get("label") + "."); });
      } else if (kind === "override") {
        var parts = String(fd.get("group")).split("|"), ids2 = multi();
        var g = { kind: parts[0], week: parts[1] === "" ? null : Number(parts[1]), place: parts[2] === "" ? null : Number(parts[2]) };
        var label = form.querySelector("select[name=group] option:checked").dataset.label;
        var filter = "season=eq." + season + "&kind=eq." + g.kind + "&source=eq.override&week=" + (g.week == null ? "is.null" : "eq." + g.week) + "&place=" + (g.place == null ? "is.null" : "eq." + g.place);
        api("awards?" + filter, "DELETE").then(function (r) {
          if (!r.ok) return r;
          return api("awards", "POST", split(fd.get("amount"), ids2).map(function (x) {
            return { season: season, kind: g.kind, week: g.week, place: g.place, label: label, team_id: x.team_id, amount: x.amount, status: "final", source: "override", note: String(fd.get("note")).trim() };
          }));
        }).then(function (r) { return redraw(r, "Override saved: " + label + "."); });
      } else if (kind === "guillotine") {
        var w = Number(fd.get("week"));
        api("guillotine?season=eq." + season + "&week=eq." + w, "DELETE").then(function (r) {
          if (!r.ok) return r;
          return api("guillotine", "POST", { season: season, week: w, team_id: fd.get("team"), status: "final", source: "override", note: String(fd.get("note")).trim() });
        }).then(function (r) { return redraw(r, "Week " + w + ": " + TL().name(fd.get("team")) + " eliminated."); });
      } else if (kind === "empire") {
        api("season_settings?season=eq." + season, "PATCH", { empire_defending_team: fd.get("team") || null, updated_at: new Date().toISOString() })
          .then(function (r) { return redraw(r, "Empire watch saved."); });
      }
    });
    rootEl.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-po]"); if (!b) return;
      var k = b.dataset.po;
      if (k === "csv") exportCsv();
      else if (k === "del-payment" && root.confirm("Delete this payout record?")) api("payout_payments?id=eq." + Number(b.dataset.id), "DELETE").then(function (r) { return redraw(r, "Payout deleted."); });
      else if (k === "del-award" && root.confirm("Delete this award?")) api("awards?id=eq." + Number(b.dataset.id), "DELETE").then(function (r) { return redraw(r, "Award deleted."); });
      else if (k === "clear-override") {
        var form = b.closest("form"), parts = String(new FormData(form).get("group")).split("|");
        var filter = "season=eq." + season + "&kind=eq." + parts[0] + "&source=eq.override&week=" + (parts[1] === "" ? "is.null" : "eq." + parts[1]) + "&place=" + (parts[2] === "" ? "is.null" : "eq." + parts[2]);
        if (root.confirm("Remove this override?")) api("awards?" + filter, "DELETE").then(function (r) { return redraw(r, "Override removed; the computed result returns on the next refresh."); });
      }
    });
  }

  // ---- Entry points -------------------------------------------------------------------
  function start(page, rootEl) {
    if (!(cfg && cfg.configured && A)) { rootEl.innerHTML = '<section><h2>Payouts</h2><div class="card">Not set up yet.</div></section>'; return; }
    rootEl.innerHTML = '<section><h2>' + (page === "admin" ? "Payout tools" : "Payouts") + '</h2><p class="muted">Loading…</p></section>';
    var who = root.B5Account ? root.B5Account.load().catch(function () { return null; }) : Promise.resolve(null);
    who.then(function (me) {
      st.me = me;
      if (root.B5Account) root.B5Account.refreshNav();
      if (page === "admin") {
        if (!(me && me.profile && me.profile.is_commissioner)) { rootEl.innerHTML = '<section><h2>Payout tools</h2><div class="card">Commissioner only.</div></section>'; return; }
        return load(true).then(function () { rootEl.innerHTML = adminHtml(); startAdmin(rootEl); });
      }
      return load(false).then(function () { rootEl.innerHTML = publicHtml(); });
    }).catch(function (e) { rootEl.innerHTML = '<section><h2>Payouts</h2><p class="acct-msg err">Couldn\'t load payouts: ' + esc(e.message) + "</p></section>"; });
  }

  /** Season winnings per team for the Teams page and My Team (public). */
  var winP = null;
  function teamWinnings() {
    if (!(cfg && cfg.configured && A)) return Promise.resolve({});
    if (!winP) winP = A.api(cfg, null, "awards?season=eq." + season + "&select=kind,week,place,team_id,amount,status,source", {}, f)
      .then(function (r) { return r.ok ? winningsByTeam(r.data || []) : {}; }, function () { return {}; });
    return winP;
  }

  root.B5Payouts = { start: start, teamWinnings: teamWinnings, money: money,
    effectiveAwards: effectiveAwards, winningsByTeam: winningsByTeam, balances: balances, empireState: empireState, potOf: potOf, csv: csv };
})(typeof globalThis !== "undefined" ? globalThis : this);
