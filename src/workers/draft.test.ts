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

test("timer expiry / bots: top available queued player, else best ranked, else by name", () => {
  const pool = [{ id: "z", name: "Zed" }, { id: "a", name: "Abe" }, { id: "q1", name: "Q1" }, { id: "r1", name: "R1" }];
  const queue = [{ player_id: "q2", rank: 1 }, { player_id: "q1", rank: 2 }];
  assert.deepEqual(plain(D.autoPick(queue, [{ player_id: "r1", rank: 1 }], pool, { q2: true })), { player_id: "q1", from: "queue" }, "q2 is gone: the next one in the queue");
  assert.deepEqual(plain(D.autoPick([], [{ player_id: "r2", rank: 2 }, { player_id: "r1", rank: 1 }], pool, {})), { player_id: "r1", from: "rank" });
  assert.deepEqual(plain(D.autoPick([], [], pool, { a: true })), { player_id: "q1", from: "pool" }, "by name: Abe taken, Q1 next");
  assert.equal(D.autoPick([], [], [], {}), null);
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
  const rows = (o: Record<string, unknown>) => plain(P.poolRows(players, { 3: 1 }, { 1: { team_id: "A" } }, o)).map((p: { id: string }) => p.id);
  assert.deepEqual(rows({}), ["3", "2"], "drafted hidden; ranked first, then by name");
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
  assert.deepEqual(plain(R.parse("#draft/7", known)), { page: "draft", week: null, draft: 7, tv: false });
  assert.deepEqual(plain(R.parse("#draft/7/tv", known)), { page: "draft", week: null, draft: 7, tv: true });
  assert.equal(R.parse("#draft/x", known).page, "home");
});

test("draft errors: the draft's own refusals are shown as written; database wording gets a plain message (logged for admins)", () => {
  assert.equal(P.technical("That pick was already made (Round 1, Pick 3)"), false);
  assert.equal(P.technical("Set every odd round's order first (round 3 is missing)"), false);
  assert.equal(P.technical("UPDATE requires a WHERE clause"), true);
  assert.equal(P.technical("permission denied for table drafts"), true);
  assert.equal(P.technical('relation "public.draft_state" does not exist'), true);
});
