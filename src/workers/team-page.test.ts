/* Team profile, direct messages and trades: page helpers (team.js, dm.js, trades.js in a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, lineupsFrom: 2027, teams: [{ id: "0011", name: "Mac Daddies" }, { id: "0001", name: "NSFW" }, { id: "0002", name: "Stealers" }] } };
for (const f of ["teamlink.js", "route.js", "team.js", "dm.js", "trades.js"]) vm.runInNewContext(read(f), ctx);
/* eslint-disable @typescript-eslint/no-explicit-any */
const TP = ctx.B5TeamPage as any, DM = ctx.B5DM as any, TR = ctx.B5Trades as any;
const R = ctx.B5Route as { parse(h: string, k: (x: string) => boolean): Record<string, unknown> };
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("routes: #team/<id>, #trade/<id>, #trades, #dm, #dm/<id>", () => {
  assert.deepEqual(plain(R.parse("#team/0011", () => true)), { page: "team", week: null, team: "0011" });
  assert.deepEqual(plain(R.parse("#trade/0002", () => true)), { page: "trade", week: null, team: "0002" });
  assert.deepEqual(plain(R.parse("#dm/42", () => true)), { page: "dm", week: null, conv: 42 });
  assert.equal(R.parse("#trades", k => k === "trades").page, "trades");
  assert.equal(R.parse("#dm", k => k === "dm").page, "dm");
  assert.equal(R.parse("#team/<script>", k => k === "team").page, "home");
  const tok = "00000000-0000-0000-0000-00000000000b.dm." + "a".repeat(32);
  assert.deepEqual(plain(R.parse("#unsubscribe/" + tok, () => true)), { page: "unsubscribe", week: null, token: tok }, "email unsubscribe link");
  assert.equal(R.parse("#unsubscribe/whatever", k => k === "unsubscribe").page, "home");
});

test("contact card: formatted US phone with tel: and sms:, https websites only (nofollow noopener ugc), mailto, escaped", () => {
  assert.equal(TP.formatPhone("4125550123"), "(412) 555-0123");
  assert.equal(TP.formatPhone("1125550123"), null);
  assert.equal(TP.phoneHref("4125550123", "tel"), "tel:+14125550123");
  assert.equal(TP.phoneHref("4125550123", "sms"), "sms:+14125550123");
  assert.equal(TP.safeWebsite("http://x.com"), null);
  assert.equal(TP.safeWebsite("javascript:alert(1)"), null);
  assert.equal(TP.safeWebsite('https://x.com/"onmouseover=1'), null);
  const html = TP.contactCard({ user_id: "u1", display_name: "Mike <b>", email: "mike@example.com", phone: "4125550123", website: "https://mike.example.com/a?b=1&c=2", hidden: [] }, { message: true });
  assert.match(html, /<a href="mailto:mike@example.com">/);
  assert.match(html, /<a href="tel:\+14125550123">\(412\) 555-0123<\/a> · <a href="sms:\+14125550123">Text<\/a>/);
  assert.match(html, /<a href="https:\/\/mike.example.com\/a\?b=1&amp;c=2" target="_blank" rel="nofollow noopener ugc">/);
  assert.match(html, /Mike &lt;b&gt;/);
  assert.match(html, /data-tp="dm-user" data-user="u1">Message/);
  const bad = TP.contactCard({ display_name: "X", website: "javascript:alert(1)", email: "x\"@y", phone: "12" });
  assert.doesNotMatch(bad, /javascript|tel:|mailto/);
  assert.match(bad, /No contact info shared/);
  assert.match(TP.contactCard({ display_name: "C", phone: "4125550123", hidden: ["phone"] }), /hidden from members/, "the commissioner sees what's hidden");
});

test("profile schedule and lineup status", () => {
  const sched = { weeks: [{ week: 1, games: [["0001", 100.5, "0011", 90]] }, { week: 2, games: [["0011", null, "0002", null]] }] };
  assert.deepEqual(plain(TP.games(sched, "0011")), [
    { week: 1, opp: "0001", home: true, us: 90, them: 100.5, result: "L" },
    { week: 2, opp: "0002", home: false, us: null, them: null, result: "" }]);
  const roster = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(TP.lineupStatus(roster, [{ slot: 0, player_id: "a" }]).map((p: any) => p.status), ["Starter · QB", "Bench"]);
  assert.deepEqual(TP.lineupStatus(roster, [{ slot: 0, player_id: "a" }, { slot: 1, player_id: null }]).map((p: any) => p.status), ["Starter · QB", "Bench or hidden starter"]);
  assert.deepEqual(TP.lineupStatus(roster, []).map((p: any) => p.status), ["", ""]);
});

test("this week's lineup: slot order, BYE/injury tags, submitted line; #account/email route", () => {
  const slots = [{ slot: 0, player_id: "a", name: "Joe <B>", nfl_team: "CIN", bye: false, injury: "Questionable" }, { slot: 3, player_id: "b", name: "Bye Guy", nfl_team: "SEA", bye: true }];
  const html = TP.lineupHtml(slots, { submitted_at: "2026-10-25T01:14:00Z", submitted_by: "Mike", starters: 2 }, 7, 2027);
  assert.match(html, /Submitted Sat 9:14 PM by Mike/);
  assert.match(html, /Joe &lt;B&gt;/);
  assert.match(html, /<span class="tag">Questionable<\/span>/);
  assert.match(html, /Bye Guy <span class="muted nfl">SEA<\/span><\/span> <span class="lv-bye">BYE<\/span>/);
  assert.equal((html.match(/<li>/g) || []).length, 9, "all 9 slots");
  assert.equal((html.match(/Empty/g) || []).length, 7);
  assert.equal(TP.submittedText(null, 2027), "Not submitted yet");
  assert.equal(TP.submittedText({ submitted_at: null, starters: 9 }, 2026), "Set from MFL (MFL is official for 2026)");
  assert.equal(TP.submittedText({ submitted_at: "2026-10-25T01:14:00Z", submitted_by: null, starters: 9 }, 2027), "Submitted Sat 9:14 PM", "visitors: when, not who");
  assert.deepEqual(plain(R.parse("#account/email", () => true)), { page: "account", week: null, section: "email" });
});

test("DM conversation partner and title (TeamLinks, escaped names)", () => {
  const me = "me", people = { u2: { name: "Bob <x>", team: "0002" }, u3: { name: "Carol", team: null } };
  assert.deepEqual(plain(DM.partner({ kind: "user", dm_members: [{ user_id: "me" }, { user_id: "u2" }] }, me, ["0011"])), { kind: "user", user: "u2" });
  assert.deepEqual(plain(DM.partner({ kind: "team", teams: ["0002"], created_by: "me" }, me, ["0011"])), { kind: "team", team: "0002" });
  assert.deepEqual(plain(DM.partner({ kind: "team", teams: ["0011"], created_by: "u2" }, me, ["0011"])), { kind: "user", user: "u2", viaTeam: "0011" }, "someone wrote to my team");
  assert.match(DM.titleHtml({ kind: "user", user: "u2" }, people), /^Bob &lt;x&gt; <span class="muted small">· <a class="team-link" href="#team\/0002">/);
  assert.match(DM.titleHtml({ kind: "trade", teams: ["0011", "0002"] }, people), /^Trade: <a class="team-link" href="#team\/0011">.* ↔ <a class="team-link" href="#team\/0002">/);
  assert.deepEqual(DM.sortConvs([{ id: 1, last_message_at: "2026-10-01" }, { id: 2, last_message_at: "2026-10-03" }]).map((c: any) => c.id), [2, 1]);
});

test("trades: roster math, summary with TeamLinks, expired proposals", () => {
  assert.deepEqual(plain(TR.tradeMath({ mySize: 18, theirSize: 18, give: 1, get: 2, drops: 0, max: 18 })), { mine: 19, theirs: 17, needMine: 1, needTheirs: 0 });
  assert.deepEqual(plain(TR.tradeMath({ mySize: 18, theirSize: 18, give: 1, get: 2, drops: 1, max: 18 })), { mine: 18, theirs: 17, needMine: 0, needTheirs: 0 });
  assert.equal(TR.tradeMath({ mySize: 17, theirSize: 18, give: 0, get: 0, drops: 0, max: 18, theirDrops: 0 }).needTheirs, 0);
  const t = { from_team: "0011", to_team: "0002", give_players: ["a"], get_players: ["b"], give_picks: [5], get_picks: [], from_drops: ["c"], to_drops: [] };
  const html = TR.summaryHtml(t, { a: "Joe <Burrow>", b: "Bo Nix", c: "Cut Guy" }, { 5: "2027 round 1 pick" });
  assert.match(html, /^<a class="team-link" href="#team\/0011">.*<\/a> get Bo Nix; <a class="team-link" href="#team\/0002">.*<\/a> get Joe &lt;Burrow&gt;, 2027 round 1 pick\. <a class="team-link" href="#team\/0011">.*<\/a> drop Cut Guy$/);
  const now = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(TR.statusOf({ status: "proposed", expires_at: "2026-10-22T11:00:00Z", to_team: "0002" }, now).key, "expired");
  assert.equal(TR.statusOf({ status: "proposed", expires_at: "2026-10-29T11:00:00Z", to_team: "0002" }, now).text, "Waiting for an answer");
  assert.equal(TR.statusOf({ status: "accepted", expires_at: "2026-10-29T11:00:00Z" }, now).text, "Waiting for the commissioner");
});
