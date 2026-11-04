/* Draft Room: the shared rules (draftlogic.js) and the page helpers (draft.js). The database applies the
   same rules (rls.test.ts "draft room"); these cover what the page draws and decides before it asks. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2026 } };
vm.runInNewContext(read("draftlogic.js"), ctx);
vm.runInNewContext(read("draft.js"), ctx);
vm.runInNewContext(read("route.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const D = ctx.B5DraftLogic as any, P = ctx.B5Draft as any, R = ctx.B5Route as any;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const TEAMS = ["A", "B", "C", "D"];

test("redraw serpentine: odd rounds have their own order, even rounds are the exact reverse of the round before", () => {
  const orders = { 1: ["C", "A", "D", "B"], 3: ["B", "D", "A", "C"] };
  assert.deepEqual(plain(D.roundOrder(orders, 1)), ["C", "A", "D", "B"]);
  assert.deepEqual(plain(D.roundOrder(orders, 2)), ["B", "D", "A", "C"], "round 2 = round 1 reversed");
  assert.deepEqual(plain(D.roundOrder(orders, 3)), ["B", "D", "A", "C"], "round 3 is a NEW order (here it happens to match)");
  assert.deepEqual(plain(D.roundOrder(orders, 4)), ["C", "A", "D", "B"]);
  assert.equal(D.roundOrder(orders, 5), null, "round 5 isn't drawn yet");
  assert.equal(D.roundOrder(orders, 6), null, "and so neither is its reverse");
  assert.deepEqual(plain(D.missingOrders(orders, 6)), [5]);
  const board = D.board(TEAMS, 4, orders, {});
  assert.deepEqual(plain(board.map((s: { owner: string }) => s.owner)), ["C", "A", "D", "B", "B", "D", "A", "C", "B", "D", "A", "C", "C", "A", "D", "B"]);
  assert.deepEqual(plain(D.position(7, 4)), { round: 2, pick: 3 });
});

test("manual order: all teams, each once", () => {
  assert.equal(D.validateOrder(["A", "B", "C", "D"], TEAMS), null);
  assert.match(D.validateOrder(["A", "B", "C"], TEAMS), /all 4 teams/);
  assert.match(D.validateOrder(["A", "B", "C", "C"], TEAMS), /twice: C/);
  assert.match(D.validateOrder(["A", "B", "C", "Z"], TEAMS), /Unknown team: Z/);
  assert.match(D.validateOrder(null, TEAMS), /Enter the order/);
});

test("traded picks land in the original team's slot of each round's order", () => {
  const orders = { 1: ["C", "A", "D", "B"] };
  const owners = { "1:D": "A", "2:C": "B" };   // A owns D's round-1 pick; B owns C's round-2 pick
  const s3 = D.slot(3, TEAMS, orders, owners);
  assert.deepEqual(plain(s3), { overall: 3, round: 1, pick: 3, original: "D", owner: "A", traded: true });
  assert.deepEqual(plain(D.slot(8, TEAMS, orders, owners)), { overall: 8, round: 2, pick: 4, original: "C", owner: "B", traded: true }, "round 2 reverses: C picks last");
  assert.equal(D.slot(9, TEAMS, orders, owners), null, "round 3's order isn't set: the pick's slot isn't known yet");
});

test("on the clock and picks away: skipped picks count as passed; nothing past an unset order", () => {
  const orders = { 1: ["C", "A", "D", "B"] };
  assert.equal(D.currentOverall([{ overall: 1 }, { overall: 2, skipped: true }], 8), 3);
  assert.equal(D.currentOverall(Array.from({ length: 8 }, (_, i) => ({ overall: i + 1 })), 8), null, "all done");
  assert.equal(D.picksAway(TEAMS, 2, orders, {}, 1, "C"), 0, "on the clock");
  assert.equal(D.picksAway(TEAMS, 2, orders, {}, 1, "D"), 2, "2 picks away");
  assert.equal(D.picksAway(TEAMS, 2, orders, {}, 4, "B"), 0);
  assert.equal(D.picksAway(TEAMS, 2, orders, {}, 4, "D"), 2, "B, B (turn), D");
  assert.equal(D.picksAway(TEAMS, 4, orders, {}, 8, "A"), null, "round 3 not drawn yet");
});

test("timer expiry / bots: top available queued player, else best available by ADP (custom ranks when on), else by name", () => {
  const pool = [{ id: "z", name: "Zed", pos: "WR" }, { id: "a", name: "Abe", pos: "RB" }, { id: "q1", name: "Q1", pos: "WR" }, { id: "r1", name: "R1", pos: "QB" }];
  const queue = [{ player_id: "q2", rank: 1 }, { player_id: "q1", rank: 2 }];
  const adp = { r1: 3.5, z: 1.2, a: 8 };
  assert.deepEqual(plain(D.autoPick(queue, pool, { q2: true }, { adp })), { player_id: "q1", from: "queue" }, "q2 is gone: the next one in the queue");
  assert.deepEqual(plain(D.autoPick([], pool, {}, { adp })), { player_id: "z", from: "rank" }, "lowest ADP");
  assert.deepEqual(plain(D.autoPick([], pool, { z: true }, { adp })), { player_id: "r1", from: "rank" }, "best available ADP once Zed is gone");
  assert.deepEqual(plain(D.autoPick([], pool, {}, { adp, custom: { a: 1 } })), { player_id: "a", from: "rank" }, "custom ranks first");
  assert.deepEqual(plain(D.autoPick([], pool, { z: true, r1: true, a: true }, { adp })), { player_id: "q1", from: "rank" }, "no ADP: by name");
  assert.equal(D.autoPick([], [], {}, {}), null);
});

test("auto-pick sanity rule: no 2nd K or DEF before round 14 unless that's all that's left", () => {
  const pool = [{ id: "k2", name: "Kicker Two", pos: "K" }, { id: "d2", name: "Def Two", pos: "DEF" }, { id: "wr", name: "Wide Out", pos: "WR" }];
  const adp = { k2: 100, d2: 101, wr: 180 };
  assert.equal(D.autoPick([], pool, {}, { adp }, { round: 10, has: { K: 1, DEF: 1 } }).player_id, "wr", "both held back in round 10");
  assert.equal(D.autoPick([], pool, {}, { adp }, { round: 10, has: { K: 0, DEF: 0 } }).player_id, "k2", "a first K is fine");
  assert.equal(D.autoPick([], pool, {}, { adp }, { round: 10, has: { K: 1 } }).player_id, "d2", "a first DEF is fine");
  assert.equal(D.autoPick([], pool, {}, { adp }, { round: 14, has: { K: 1, DEF: 1 } }).player_id, "k2", "round 14 on: allowed");
  assert.deepEqual(plain(D.autoPick([], pool, { wr: true }, { adp }, { round: 3, has: { K: 1, DEF: 1 } })), { player_id: "k2", from: "last" }, "all that's left");
  assert.equal(D.autoPick([{ player_id: "k2", rank: 1 }], pool, {}, { adp }, { round: 3, has: { K: 1 } }).player_id, "k2", "the team's own queue is its choice");
});

test("ADP: pool sort order, best available overall and per position, reach/steal math", () => {
  const players = [{ id: "1", name: "Zed", pos: "WR", nfl: "DET" }, { id: "2", name: "Abe", pos: "QB", nfl: "KC" }, { id: "3", name: "Cal", pos: "RB", nfl: "BUF" }, { id: "4", name: "Dee", pos: "WR", nfl: "ARI" }];
  const ctx = { adp: { 1: 5.5, 2: 30, 3: 2.1 }, custom: null };
  const ids = (l: { id: string }[]) => plain(l).map((p: { id: string }) => p.id);
  assert.deepEqual(ids(D.sortPool(players, "adp", 1, ctx)), ["3", "1", "2", "4"], "by ADP, no ADP last");
  assert.deepEqual(ids(D.sortPool(players, "adp", -1, ctx)), ["2", "1", "3", "4"], "reversed; no ADP still last");
  assert.deepEqual(ids(D.sortPool(players, "name", 1, ctx)), ["2", "3", "4", "1"]);
  assert.deepEqual(ids(D.sortPool(players, "pos", 1, ctx)), ["2", "3", "1", "4"], "QB RB WR (ties by ADP)");
  assert.deepEqual(ids(D.sortPool(players, "team", 1, ctx)), ["4", "3", "1", "2"]);
  const b = D.bestAvailable(players, { 3: true }, ctx);
  assert.deepEqual([b.overall.id, b.byPos.WR.id, b.byPos.QB.id, b.byPos.RB], ["1", "1", "2", undefined]);
  assert.equal(D.value(10, 22), "reach", "12 picks before his ADP");
  assert.equal(D.value(10, 21.9), null);
  assert.equal(D.value(34, 22), "steal", "12 picks after");
  assert.equal(D.value(33, 22), null);
  assert.equal(D.value(5, null), null);
  assert.deepEqual(plain(D.adpMap([{ source: "ffc", player_id: "a", adp: 9, pos_rank: "RB3" }, { source: "mfl", player_id: "a", adp: 7, pos_rank: "RB2" }, { source: "ffc", player_id: "b", adp: 4, pos_rank: "WR1" }])),
    { a: { adp: 7, posRank: "RB2", source: "mfl" }, b: { adp: 4, posRank: "WR1", source: "ffc" } }, "MFL first, FFC fills in");
  assert.equal(D.adpSeason([2025, 2026], 2027), 2026, "2027 draft before 2027 ADP exists: 2026");
  assert.equal(D.adpSeason([2025, 2026, 2027], 2026), 2026);
  assert.equal(D.adpSeason([], 2026), null);
});

test("the clock: server time with an offset; m:ss", () => {
  const now = Date.parse("2027-08-28T23:00:00Z");
  assert.equal(D.secondsLeft("2027-08-28T23:01:30Z", now, 0), 90);
  assert.equal(D.secondsLeft("2027-08-28T23:01:30Z", now, 30000), 60, "our clock is 30 s behind the server");
  assert.equal(D.secondsLeft("2027-08-28T22:59:00Z", now, 0), 0);
  assert.equal(D.clock(179.2), "3:00");
  assert.equal(D.clock(5), "0:05");
});

test("rankings CSV: header or plain list; matched by name (+ position/team), never guessed", () => {
  const players = [{ id: "1", name: "Ja'Marr Chase", pos: "WR", nfl: "CIN" }, { id: "2", name: "Josh Allen", pos: "QB", nfl: "BUF" }, { id: "3", name: "Josh Allen", pos: "DEF", nfl: "JAX" },
    { id: "4", name: "Kenneth Walker III", pos: "RB", nfl: "SEA" }];
  const a = D.parseRankings("Rank,Player,Pos\n1,Ja'Marr Chase,WR1\n2,Josh Allen,QB\n3,Kenneth Walker,RB\n4,Nobody,WR", players);
  assert.deepEqual(plain(a.rows), [{ player_id: "1", rank: 1 }, { player_id: "2", rank: 2 }, { player_id: "4", rank: 3 }]);
  assert.deepEqual(plain(a.missed), ["Nobody"]);
  const b = D.parseRankings("Josh Allen\nJa'Marr Chase", players);
  assert.deepEqual(plain(b.rows), [{ player_id: "1", rank: 2 }], "two Josh Allens and no position: not guessed");
  assert.deepEqual(plain(b.missed), ["Josh Allen"]);
});

test("room helpers: who's on the clock and the next two; pool filters; my picks vs 18; bye weeks", () => {
  const d = { teams: TEAMS, rounds: 2, status: "live", current_overall: 3 };
  const v = P.view(d, { 1: ["C", "A", "D", "B"] }, {}, [{ overall: 1, player_id: "p1" }, { overall: 2, player_id: "p2" }]);
  assert.deepEqual(plain([v.cur, v.slot.owner, v.next.map((s: { owner: string }) => s.owner), v.made, v.total]), [3, "D", ["B", "B"], 2, 8]);
  const players = [{ id: "1", name: "Zed", pos: "WR", nfl: "DET" }, { id: "2", name: "Abe", pos: "QB", nfl: "KC" }, { id: "3", name: "Cal", pos: "WR", nfl: "KC" }];
  const rows = (o: Record<string, unknown>) => plain(P.poolRows(players, P.rankCtx({ ranks: "adp" }, {}, { 3: { adp: 1 } }), { 1: { team_id: "A" } }, o)).map((p: { id: string }) => p.id);
  assert.deepEqual(rows({}), ["3", "2"], "drafted hidden; by ADP first, then by name");
  const custom = P.rankCtx({ ranks: "custom" }, { 2: 1 }, { 3: { adp: 1 } });
  assert.deepEqual(plain(P.poolRows(players, custom, {}, {})).map((p: { id: string }) => p.id), ["2", "3", "1"], "custom ranks on: rank, then ADP");
  assert.equal(P.rankCtx({ ranks: "custom" }, {}, {}).custom, null, "custom on but nothing uploaded: ADP");
  assert.match(P.valueTag({ overall: 10, player_id: "x", adp: 25 }), /Reach/);
  assert.match(P.valueTag({ overall: 40, player_id: "x", adp: 25 }), /Steal/);
  assert.equal(P.valueTag({ overall: 20, player_id: "x", adp: 25 }), "");
  assert.deepEqual(rows({ showDrafted: true }), ["3", "2", "1"]);
  assert.deepEqual(rows({ pos: "WR" }), ["3"]);
  assert.deepEqual(rows({ q: "kc" }), ["3", "2"], "an NFL team code");
  const m = P.myPicks([{ team_id: "A", player_id: "1", round: 1, pick: 2 }, { team_id: "B", player_id: "2" }], "A", { 1: { pos: "WR", name: "Zed" } });
  assert.deepEqual([m.count, m.max, m.byPos.WR.length, m.byPos.QB.length], [1, 18, 1, 0]);
  // Weeks 1-3: MIA has no week-3 game (its bye); everyone else plays every week
  const games = [{ week: 1, home: "KC", away: "DET" }, { week: 1, home: "BUF", away: "MIA" }, { week: 2, home: "KC", away: "BUF" }, { week: 2, home: "DET", away: "MIA" },
    { week: 3, home: "KC", away: "DET" }];
  const byes = P.byeWeeks(games);
  assert.equal(byes.MIA, 3); assert.equal(byes.BUF, 3); assert.equal(byes.KC, undefined, "KC plays every week");
  assert.equal(P.pickedByText({ auto: true }, {}), "auto-pick");
  assert.equal(P.pickedByText({ picked_by: "u1" }, { u1: "Mike" }), "Mike");
});

test("routes: #draft, #draft/<id>, #draft/<id>/tv", () => {
  const known = (k: string) => ["home", "draft"].includes(k);
  assert.deepEqual(plain(R.parse("#draft", known)), { page: "draft", week: null });
  assert.deepEqual(plain(R.parse("#draft/7", known)), { page: "draft", week: null, draft: 7, tv: false, popout: false });
  assert.deepEqual(plain(R.parse("#draft/7/tv", known)), { page: "draft", week: null, draft: 7, tv: true, popout: false });
  assert.deepEqual(plain(R.parse("#draft/7/chat", known)), { page: "draft", week: null, draft: 7, tv: false, popout: true }, "the pop-out chat window");
  assert.equal(R.parse("#draft/x", known).page, "home");
});

test("draft errors: the draft's own refusals are shown as written; database wording gets a plain message (logged for admins)", () => {
  assert.equal(P.technical("That pick was already made (Round 1, Pick 3)"), false);
  assert.equal(P.technical("Set every odd round's order first (round 3 is missing)"), false);
  assert.equal(P.technical("UPDATE requires a WHERE clause"), true);
  assert.equal(P.technical("permission denied for table drafts"), true);
  assert.equal(P.technical('relation "public.draft_state" does not exist'), true);
});

test("board layout helpers: last names, duplicate teams in a round order, Scribe-only video links", () => {
  assert.equal(P.lastName({ name: "Josh Allen", pos: "QB" }), "Allen");
  assert.equal(P.lastName({ name: "Marvin Harrison Jr.", pos: "WR" }), "Harrison");
  assert.equal(P.lastName({ name: "Kenneth Walker III", pos: "RB" }), "Walker");
  assert.equal(P.lastName({ name: "Amon-Ra St. Brown", pos: "WR" }), "St. Brown");
  assert.equal(P.lastName({ name: "Pittsburgh Steelers", pos: "DEF", nfl: "PIT" }), "PIT");
  assert.deepEqual(plain(D.duplicates(["0001", "0002", "0001", "0003", "0002", ""])), { "0001": true, "0002": true });
  assert.deepEqual(plain(D.duplicates(["0001", "0002"])), {});
  assert.ok(P.SCRIBE.test("https://scribehow.com/embed/How_to_Create_a_New_Practice_Draft_on_B5_Football__iD_l2TKMREOYcfUsx13N8w?as=video"));
  for (const bad of ["http://scribehow.com/embed/x", "https://scribehow.com.evil.com/embed/x", "https://evil.com/?https://scribehow.com/embed/x", "https://scribehow.com/embed/x\"onload=\"x", "javascript:alert(1)"])
    assert.ok(!P.SCRIBE.test(bad), bad);
});

test("By Pick board: each round's teams in that round's order (odd drawn, even reversed), TBD until drawn, traded picks by owner", () => {
  const teams = ["A", "B", "C", "D"];
  const g = plain(D.pickGrid(teams, 4, { 1: ["C", "A", "D", "B"], 3: ["B", "D", "A", "C"] }, { "2:A": "D" }));
  const row = (r: number) => g[r - 1].cells.map((c: { owner: string; original: string; traded: boolean; overall: number } | null) => c ? c.owner + (c.traded ? "<" + c.original : "") + "#" + c.overall : "TBD");
  assert.deepEqual(row(1), ["C#1", "A#2", "D#3", "B#4"], "round 1: the draw");
  assert.deepEqual(row(2), ["B#5", "D#6", "D<A#7", "C#8"], "round 2: reversed; A's pick now owned by D (via A)");
  assert.deepEqual(row(3), ["B#9", "D#10", "A#11", "C#12"], "round 3: its own draw");
  assert.deepEqual(row(4), ["C#13", "A#14", "D#15", "B#16"], "round 4: reverse of round 3");
  const tbd = plain(D.pickGrid(teams, 4, { 1: ["C", "A", "D", "B"] }, {}));
  assert.deepEqual([tbd[2].known, tbd[2].cells.every((c: unknown) => c === null), tbd[3].known], [false, true, false], "rounds 3-4 are Order TBD until drawn");
});

test("board view: By Team by default; the viewer's choice in the room; the commissioner's TV setting on the big screen", () => {
  assert.equal(P.viewFor(false, { tv_view: "pick" }, null), "team", "default By Team");
  assert.equal(P.viewFor(false, { tv_view: "team" }, "pick"), "pick", "the viewer's own choice");
  assert.equal(P.viewFor(true, { tv_view: "pick" }, "team"), "pick", "the TV follows the commissioner, not the viewer");
  assert.equal(P.viewFor(true, {}, "pick"), "team");
});
