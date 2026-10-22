import { test } from "node:test";
import assert from "node:assert/strict";
import { mapMflId, mapRosters, mflName, mflToGsis, type MflPlayerInfo } from "./mflRosters.ts";

const players = new Map<string, MflPlayerInfo>([
  ["14802", { id: "14802", name: "Taylor, Jonathan", position: "RB", team: "IND" }],
  ["0527", { id: "0527", name: "Panthers, Carolina", position: "Def", team: "CAR" }],
  ["0529", { id: "0529", name: "Saints, New Orleans", position: "Def", team: "NOS" }],
  ["99999", { id: "99999", name: "Rookie, New", position: "WR", team: "SFO" }],
  ["88888", { id: "88888", name: "Twin, Ids", position: "TE", team: "GBP" }],
  ["77777", { id: "77777", name: "Old, Guy", position: "QB", team: "PIT" }]
]);
const idMap = mflToGsis([
  { mfl_id: "14802", gsis_id: "00-0036223" },
  { mfl_id: "88888", gsis_id: "00-1" }, { mfl_id: "88888", gsis_id: "00-2" },
  { mfl_id: "77777", gsis_id: "00-OLD" },
  { mfl_id: "NA", gsis_id: "00-9" }, { mfl_id: "55555", gsis_id: "NA" }
]);
const known = new Set(["00-0036223", "DEF:CAR", "DEF:NO", "00-1", "00-2"]);

test("MFL names read first-last", () => {
  assert.equal(mflName("Taylor, Jonathan"), "Jonathan Taylor");
  assert.equal(mflName("Panthers, Carolina"), "Carolina Panthers");
  assert.equal(mflName("Odd"), "Odd");
});

test("rosters map by ID only: players via the ID map, defenses by team; everything else is flagged, never guessed", () => {
  const r = mapRosters({
    season: 2026, players, idMap, known,
    franchises: [
      { id: "0011", player: [{ id: "14802", drafted: "1.07", status: "ROSTER" }, { id: "0529", drafted: "Waiv" }] },
      { id: "0003", player: { id: "0527" } },   // MFL sends a single player as an object
      { id: "0005", player: [{ id: "99999" }, { id: "88888" }, { id: "77777" }, { id: "12345" }] }
    ]
  });
  assert.deepEqual(r.entries, [
    { season: 2026, team_id: "0011", player_id: "00-0036223", acquired: "1.07" },
    { season: 2026, team_id: "0011", player_id: "DEF:NO", acquired: "Waiv" },
    { season: 2026, team_id: "0003", player_id: "DEF:CAR", acquired: null }
  ]);
  assert.deepEqual([...r.mflIds], [["14802", "00-0036223"], ["0529", "DEF:NO"], ["0527", "DEF:CAR"]]);
  assert.deepEqual(r.unmatched.map(u => [u.franchise, u.mflId, u.name, u.reason]), [
    ["0005", "99999", "New Rookie", "no nflverse ID for this MFL player in the ID map"],
    ["0005", "88888", "Ids Twin", "MFL ID maps to several nflverse IDs (00-1, 00-2)"],
    ["0005", "77777", "Guy Old", "00-OLD is not in nfl_players"],
    ["0005", "12345", "", "no nflverse ID for this MFL player in the ID map"]
  ]);
});

test("an empty franchise is fine", () => {
  const e = mapRosters({ season: 2026, players, idMap, known, franchises: [{ id: "0001" }] });
  assert.deepEqual([e.entries, e.unmatched, e.mflIds.size], [[], [], 0]);
});

test("one MFL ID (transactions import): defense by team code, player by the ID map, never guessed", () => {
  const players = new Map<string, MflPlayerInfo>([["0516", { id: "0516", name: "Chiefs, Kansas City", position: "Def", team: "KCC" }], ["1", { id: "1", name: "A, B", position: "WR", team: "KCC" }]]);
  const idMap = new Map([["1", ["00-1"]], ["2", ["00-2", "00-3"]]]), known = new Set(["DEF:KC", "00-1"]);
  assert.deepEqual(mapMflId("0516", players, idMap, known), { id: "DEF:KC" });
  assert.deepEqual(mapMflId("1", players, idMap, known), { id: "00-1" });
  assert.match((mapMflId("2", players, idMap, known) as { reason: string }).reason, /several/);
  assert.match((mapMflId("3", players, idMap, known) as { reason: string }).reason, /no nflverse ID/);
});
