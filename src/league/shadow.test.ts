import { test } from "node:test";
import assert from "node:assert/strict";
import { compareWeek, playsFor, slotStarters, standingsFrom, type WeekScores } from "./shadow.ts";
import type { MflPlayerInfo } from "./mflRosters.ts";
import type { GameData } from "../ingest/types.ts";

const info = (id: string, name: string, position: string, team: string): [string, MflPlayerInfo] => [id, { id, name, position, team }];
const mflPlayers = new Map<string, MflPlayerInfo>([
  info("1", "Goff, Jared", "QB", "DET"), info("2", "Gibbs, Jahmyr", "RB", "DET"), info("3", "Kicker, Some", "PK", "DET"),
  info("0508", "Lions, Detroit", "Def", "DET"), info("9", "Mystery, Man", "WR", "DET"), info("4", "Bench, Guy", "RB", "DET")
]);
const idMap = new Map([["1", ["00-QB"]], ["2", ["00-RB"]], ["3", ["00-K"]], ["4", ["00-B"]]]);
const scores: WeekScores = {
  players: {
    "nflverse:00-QB": { name: "Jared Goff", position: "QB", points: 21, stats: { passYds: 280, passTdLengths: [52] } },
    "nflverse:00-RB": { name: "Jahmyr Gibbs", position: "RB", points: 15.5, stats: { rushYds: 101, receptions: 3 } },
    "nflverse:00-K": { name: "Some Kicker", position: "K", points: 7.7, stats: { fgMadeLengths: [47], extraPoints: 3 } }
  },
  defenses: { DET: { points: 9, stats: { sacks: 3, interceptions: 1 } } }
};
const games: GameData[] = [{
  provider: "nflverse", gameId: "g", season: 2026, week: 3, home: "DET", away: "CHI", homeScore: 27, awayScore: 10, status: "final",
  players: [], teams: {}, warnings: [],
  events: [
    { kind: "td", td: "pass", team: "DET", length: 52, scorer: { provider: "nflverse", id: "00-WR", name: "A.St. Brown" }, passer: { provider: "nflverse", id: "00-QB", name: "J.Goff" } },
    { kind: "fg", team: "DET", distance: 47, kicker: { provider: "nflverse", id: "00-K", name: "S.Kicker" } },
    { kind: "td", td: "intReturn", team: "DET", length: 30, scorer: { provider: "nflverse", id: "00-LB", name: "LB" } },
    { kind: "safety", team: "CHI" }
  ]
}];

const results = (detScore: string, kScore: string) => ({
  week: "3",
  matchup: [{ franchise: [
    { id: "0011", isHome: "1", score: detScore, starters: "1,2,3,0508,9,", player: [
      { id: "1", status: "starter", score: "21.0" }, { id: "2", status: "starter", score: "15.5" }, { id: "3", status: "starter", score: kScore },
      { id: "0508", status: "starter", score: "9.0" }, { id: "9", status: "starter", score: "0.0" }, { id: "4", status: "nonstarter", score: "30" }] },
    { id: "0003", isHome: "0", score: "0.0", starters: "", player: [] }
  ] }]
});

test("a team whose every starter matches MFL matches; the bench doesn't count; lineup slots are filled by position", () => {
  const c = compareWeek({ season: 2026, week: 3, results: results("53.2", "7.7"), mflPlayers, idMap, scores, games });
  assert.deepEqual(c.matchups, [{ home: "0011", away: "0003" }]);
  const t = c.teams.find(x => x.teamId === "0011")!;
  assert.equal(t.ourScore, 53.2);
  assert.equal(t.matched, true);
  assert.deepEqual(t.slots, ["00-QB", "00-RB", null, null, null, null, null, "00-K", "DEF:DET"]);
  // The unmapped WR scored 0 on MFL, so totals agree, but he's still reported
  assert.deepEqual(t.unmapped, [{ mflId: "9", name: "Man Mystery", reason: "no nflverse ID in the ID map" }]);
  assert.equal(t.diffs.length, 1);
  assert.match(t.diffs[0]!.note!, /not scored/);
});

test("a differing player is reported with our rule lines and the plays behind them", () => {
  const c = compareWeek({ season: 2026, week: 3, results: results("54.2", "8.7"), mflPlayers, idMap, scores, games });
  const t = c.teams.find(x => x.teamId === "0011")!;
  assert.equal(t.matched, false);
  assert.equal(t.mflScore, 54.2);
  const k = t.diffs.find(d => d.playerId === "00-K")!;
  assert.equal(k.mfl, 8.7);
  assert.equal(k.ours, 7.7);
  assert.deepEqual(k.plays, ["CHI@DET: 47-yd FG"]);
  assert.ok(k.lines.some(l => l.stat === "fgLength" && l.value === 47 && l.points === 4.7));
});

test("plays: passer and scorer roles, kicker, and a defense's non-offensive TDs and safeties", () => {
  assert.deepEqual(playsFor("00-QB", games), ["CHI@DET: 52-yd pass TD (threw, to A.St. Brown)"]);
  assert.deepEqual(playsFor("00-WR", games), ["CHI@DET: 52-yd pass TD (caught from J.Goff)"]);
  assert.deepEqual(playsFor("DEF:DET", games), ["CHI@DET: 30-yd intReturn TD"]);
  assert.deepEqual(playsFor("DEF:CHI", games), ["CHI@DET: safety"]);
});

test("a week MFL hasn't posted yet (no scores) compares nothing", () => {
  const r = results("53.2", "7.7");
  for (const f of r.matchup[0]!.franchise) { delete (f as { score?: string }).score; for (const p of f.player) delete (p as { score?: string }).score; }
  const c = compareWeek({ season: 2026, week: 3, results: r, mflPlayers, idMap, scores, games });
  const t = c.teams.find(x => x.teamId === "0011")!;
  assert.equal(t.mflScore, null);
  assert.equal(t.matched, false);
  assert.deepEqual(t.diffs, []);
  assert.equal(t.ourScore, 53.2, "our total still computed (for matchups)");
});

test("slots: position order, extras left out", () => {
  assert.deepEqual(slotStarters([{ playerId: "w1", position: "WR" }, { playerId: "w2", position: "WR" }, { playerId: "w3", position: "WR" }, { playerId: "w4", position: "WR" }, { playerId: null, position: "QB" }]),
    [null, null, null, "w1", "w2", "w3", null, null, null]);
});

test("standings: regular season only, ties count half, ranked by win% then points for", () => {
  const s = standingsFrom([
    { week: 1, home_team: "A", away_team: "B", home_score: 100, away_score: 90 },
    { week: 1, home_team: "C", away_team: "D", home_score: 80, away_score: 80 },
    { week: 2, home_team: "B", away_team: "C", home_score: 120.25, away_score: 70 },
    { week: 2, home_team: "D", away_team: "A", home_score: 95, away_score: 99.5 },
    { week: 3, home_team: "A", away_team: "C", home_score: null, away_score: null },
    { week: 15, home_team: "B", away_team: "D", home_score: 200, away_score: 1 }
  ]);
  assert.deepEqual(s.map(r => [r.rank, r.team_id, r.wins, r.losses, r.ties, r.points_for]), [
    [1, "A", 2, 0, 0, 199.5], [2, "B", 1, 1, 0, 210.25], [3, "D", 0, 1, 1, 175], [4, "C", 0, 1, 1, 150]]);
});
