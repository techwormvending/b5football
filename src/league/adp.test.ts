import { test } from "node:test";
import assert from "node:assert/strict";
import { adpDue, mapFfcAdp, mapMflAdp, parseFfcAdp, parseMflAdp, usePeriod, withPosRanks } from "./adp.ts";
import type { MflPlayerInfo } from "./mflRosters.ts";

const ours = [
  { id: "00-1", name: "Ja'Marr Chase", position: "WR", nfl_team: "CIN" },
  { id: "00-2", name: "Bijan Robinson", position: "RB", nfl_team: "ATL" },
  { id: "00-3", name: "Josh Allen", position: "QB", nfl_team: "BUF" },
  { id: "00-4", name: "Kenneth Walker III", position: "RB", nfl_team: "SEA" },
  { id: "00-5", name: "Mike Williams", position: "WR", nfl_team: "NYJ" },
  { id: "00-6", name: "Mike Williams", position: "WR", nfl_team: "NYJ" },
  { id: "00-7", name: "Brandon Aubrey", position: "K", nfl_team: "DAL" },
  { id: "DEF:PIT", name: "Pittsburgh Steelers", position: "DEF", nfl_team: "PIT" }
];

test("MFL ADP: parsed, RECENT unless it holds too few drafts", () => {
  const j = parseMflAdp({ adp: { totalDrafts: "753", player: [{ id: "16162", averagePick: "2.33" }, { id: "x", averagePick: "nope" }] } });
  assert.deepEqual(j, { drafts: 753, players: [{ id: "16162", adp: 2.33 }] });
  assert.equal(usePeriod(7), "ALL", "mid-season: a handful of recent drafts");
  assert.equal(usePeriod(300), "RECENT");
  assert.throws(() => parseMflAdp({ error: { $t: "Invalid value for PERIOD" } }), /no adp block/);
});

test("MFL ADP -> our IDs through the nflverse crosswalk; defenses by team; IDPs skipped; never by name", () => {
  const players = new Map<string, MflPlayerInfo>([
    ["1", { id: "1", name: "Chase, Ja'Marr", position: "WR", team: "CIN" }],
    ["2", { id: "2", name: "Robinson, Bijan", position: "RB", team: "ATL" }],
    ["3", { id: "3", name: "Allen, Josh", position: "QB", team: "BUF" }],
    ["4", { id: "4", name: "Nobody, Rookie", position: "WR", team: "KC" }],
    ["5", { id: "5", name: "Steelers, Pittsburgh", position: "Def", team: "PIT" }],
    ["6", { id: "6", name: "Parsons, Micah", position: "DE", team: "GBP" }],
    ["7", { id: "7", name: "Aubrey, Brandon", position: "PK", team: "DAL" }]
  ]);
  const idMap = new Map([["1", ["00-1"]], ["2", ["00-2"]], ["3", ["00-3", "00-9"]], ["7", ["00-7"]]]);
  const list = [{ id: "2", adp: 3.1 }, { id: "1", adp: 1.5 }, { id: "3", adp: 20 }, { id: "4", adp: 150 }, { id: "5", adp: 110 }, { id: "6", adp: 90 }, { id: "7", adp: 140 }];
  const { rows, unmatched } = mapMflAdp(list, players, idMap, ours);
  assert.deepEqual(rows, [
    { player_id: "00-1", adp: 1.5, pos_rank: "WR1" }, { player_id: "00-2", adp: 3.1, pos_rank: "RB1" },
    { player_id: "DEF:PIT", adp: 110, pos_rank: "DEF1" }, { player_id: "00-7", adp: 140, pos_rank: "K1" }]);
  assert.deepEqual(unmatched.map(u => [u.provider_id, u.reason.slice(0, 26)]), [["3", "MFL ID maps to several nfl"], ["4", "no nflverse ID for this MF"]], "ambiguous and missing are flagged, the IDP isn't");
});

test("FFC ADP: exactly one match by name and position (suffixes ignored, team breaks ties); defenses by team; otherwise flagged", () => {
  const j = parseFfcAdp({ status: "Success", meta: { total_drafts: 718 }, players: [
    { player_id: 1, name: "Ja'Marr Chase", position: "WR", team: "CIN", adp: 1.5 },
    { player_id: 2, name: "Kenneth Walker", position: "RB", team: "SEA", adp: 30.2 },
    { player_id: 3, name: "Mike Williams", position: "WR", team: "NYJ", adp: 120 },
    { player_id: 4, name: "Pittsburgh Defense", position: "DEF", team: "PIT", adp: 117.3 },
    { player_id: 5, name: "Brandon Aubrey", position: "PK", team: "DAL", adp: 125 },
    { player_id: 6, name: "Josh Allen", position: "QB", team: "JAX", adp: 50 },
    { player_id: 7, name: "Mike Williams", position: "WR", team: "LAC", adp: 130 },
    { player_id: 8, name: "Nobody Atall", position: "TE", team: "KC", adp: 140 }] });
  assert.equal(j.drafts, 718);
  const { rows, unmatched } = mapFfcAdp(j.players, ours);
  assert.deepEqual(rows.map(r => r.player_id + " " + r.pos_rank), ["00-1 WR1", "00-4 RB1", "00-3 QB1", "DEF:PIT DEF1", "00-7 K1"]);
  assert.deepEqual(unmatched.map(u => u.provider_id), ["3", "7", "8"], "two Mike Williamses on the same team, or none on that team: not guessed; nobody by that name: flagged (the only QB Josh Allen matches though his team changed)");
  assert.throws(() => parseFfcAdp({ status: "Error" }), /unexpected/);
});

test("positional ranks follow ADP within each position", () => {
  const pos: Record<string, string> = { a: "RB", b: "WR", c: "RB" };
  assert.deepEqual(withPosRanks([{ player_id: "c", adp: 9 }, { player_id: "a", adp: 2 }, { player_id: "b", adp: 5 }], id => pos[id]!).map(r => r.pos_rank), ["RB1", "WR1", "RB2"]);
});

test("refresh: nightly July 1 to the real draft (at the latest Sept 15), weekly on Mondays otherwise", () => {
  assert.equal(adpDue(new Date("2027-07-01T09:17:00Z"), false), true);
  assert.equal(adpDue(new Date("2027-08-20T09:17:00Z"), false), true, "a Friday in the preseason");
  assert.equal(adpDue(new Date("2027-08-20T09:17:00Z"), true), false, "after the draft: weekly");
  assert.equal(adpDue(new Date("2027-08-23T09:17:00Z"), true), true, "Monday");
  assert.equal(adpDue(new Date("2026-11-03T09:17:00Z"), false), false, "a Tuesday in November");
  assert.equal(adpDue(new Date("2026-11-02T09:17:00Z"), false), true, "a Monday in November");
  assert.equal(adpDue(new Date("2027-09-21T09:17:00Z"), false), false, "after Sept 15 it's weekly even without a draft");
});
