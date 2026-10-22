/* Tests for pools.js's pure helpers (classic browser script, loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, teams: [] } };
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../teamlink.js"), "utf8"), ctx);
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../pools.js"), "utf8"), ctx);
type Row = { game: { game_key: string }; pick: string | null; points: number; locked: boolean };
const P = ctx.B5Pools as {
  result(g: unknown): string | null;
  availableTeams(picks: { team_id: string; nfl_team: string }[], team: string): string[];
  confidenceRows(games: unknown[], picks: unknown[], now: number): Row[];
  moveRow(rows: Row[], i: number, dir: number): Row[];
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const NOW = Date.parse("2026-10-18T18:00:00Z");
const game = (key: string, kickoff: string) => { const [away, home] = key.split("@"); return { game_key: key, away, home, kickoff, status: "scheduled", home_score: null, away_score: null }; };
const games = [game("A@B", "2026-10-18T17:00:00Z"), game("C@D", "2026-10-18T20:05:00Z"), game("E@F", "2026-10-19T00:20:00Z"), game("G@H", "2026-10-16T00:15:00Z")];

test("survivor: a used team isn't available again; 32 to start", () => {
  assert.equal(P.availableTeams([], "0001").length, 32);
  const left = P.availableTeams([{ team_id: "0001", nfl_team: "KC" }, { team_id: "0002", nfl_team: "DET" }], "0001");
  assert.equal(left.length, 31);
  assert.ok(!left.includes("KC") && left.includes("DET"));
});

test("confidence: saved picks keep their points; unpicked games get the unused values by kickoff; started games are locked", () => {
  const rows = P.confidenceRows(games, [{ game_key: "C@D", pick: "D", points: 4 }], NOW);
  assert.deepEqual(plain(rows.map(r => [r.game.game_key, r.pick, r.points, r.locked])),
    [["C@D", "D", 4, false], ["G@H", null, 3, true], ["A@B", null, 2, true], ["E@F", null, 1, false]]);
});

test("moving a game swaps points with the next unlocked game, skipping locked ones; locked games don't move", () => {
  const rows = P.confidenceRows(games, [{ game_key: "C@D", pick: "D", points: 4 }], NOW);
  const moved = P.moveRow(rows, 3, -1);   // E@F (1 pt) up: G@H and A@B are locked, so it swaps with C@D
  assert.deepEqual(plain(moved.map(r => [r.game.game_key, r.points])), [["E@F", 4], ["G@H", 3], ["A@B", 2], ["C@D", 1]]);
  assert.equal(P.moveRow(rows, 1, -1), rows, "a locked game stays put");
  assert.equal(P.moveRow(rows, 0, -1), rows, "nothing above the top");
});

test("results: winner, tie (null) or pending", () => {
  assert.equal(P.result({ status: "final", home: "B", away: "A", home_score: 20, away_score: 17 }), "B");
  assert.equal(P.result({ status: "final", home: "B", away: "A", home_score: 20, away_score: 20 }), null);
  assert.equal(P.result({ status: "in_progress", home: "B", away: "A", home_score: 7, away_score: 0 }), "pending");
});

test("test picks are scored on the page from final results (never stored or paid)", () => {
  const T = (ctx.B5Pools as { testScore(p: unknown[], g: unknown[]): number }).testScore;
  const games = [{ game_key: "A@B", home: "B", away: "A", status: "final", home_score: 20, away_score: 10 }, { game_key: "C@D", home: "D", away: "C", status: "final", home_score: 7, away_score: 7 },
    { game_key: "E@F", home: "F", away: "E", status: "scheduled", home_score: null, away_score: null }];
  assert.equal(T([{ game_key: "A@B", pick: "B", points: 3 }, { game_key: "C@D", pick: "C", points: 2 }, { game_key: "E@F", pick: "E", points: 1 }], games), 3);
});
