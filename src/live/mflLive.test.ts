/* TEMPORARY 2026: MFL live scoring -> mirrored starters (until kickoff) and the live comparison. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTeams, mergeMirror, parseLiveScoring } from "./mflLive.ts";

const slot = (team_id: string, slot: number, player_id: string) => ({ season: 2026, week: 7, team_id, slot, player_id });

test("liveScoring export: starters only, MFL's points; single objects and bye-week franchises handled", () => {
  const j = { liveScoring: {
    matchup: { franchise: [
      { id: "0007", score: "12.5", players: { player: [{ id: "15281", status: "starter", score: "8.0" }, { id: "14823", status: "nonstarter", score: "3.0" }, { id: "0528", status: "starter", score: "4.5" }] } },
      { id: "0005", score: "0.0", players: { player: { id: "15757", status: "starter", score: "0.0" } } }] },
    franchise: { id: "0009", score: "1.0", players: { player: [{ id: "1", status: "starter", score: "1.0" }] } } } };
  assert.deepEqual(parseLiveScoring(j), [
    { id: "0007", score: 12.5, starters: [{ mflId: "15281", score: 8 }, { mflId: "0528", score: 4.5 }] },
    { id: "0005", score: 0, starters: [{ mflId: "15757", score: 0 }] },
    { id: "0009", score: 1, starters: [{ mflId: "1", score: 1 }] }]);
  assert.deepEqual(parseLiveScoring({}), []);
});

test("mirrored lineups follow MFL until each player's kickoff; kicked-off starters keep their slots", () => {
  const locked = (p: string) => p.startsWith("L-");
  // No lineup yet: MFL's as is (even players already kicked off).
  assert.deepEqual(mergeMirror([], [slot("A", 0, "L-QB"), slot("A", 3, "WR1")], locked).rows, [slot("A", 0, "L-QB"), slot("A", 3, "WR1")]);
  // Unlocked starters are replaced by MFL's; a locked one stays where he is.
  const existing = [slot("A", 0, "L-QB"), slot("A", 3, "WR1"), slot("A", 4, "WR2")];
  const r = mergeMirror(existing, [slot("A", 0, "QB2"), slot("A", 3, "WR3"), slot("A", 4, "WR2")], locked);
  assert.deepEqual(r.rows, [slot("A", 0, "L-QB"), slot("A", 3, "WR3"), slot("A", 4, "WR2")]);
  assert.deepEqual(r.ignored, ["QB2"], "no QB slot left for QB2 (the QB already playing keeps it): reported");
  // MFL swapping in a player whose game already started (after kickoff): ignored, ours kept.
  const late = mergeMirror([slot("A", 3, "L-WR")], [slot("A", 3, "L-WR9")], locked);
  assert.deepEqual(late.rows, [slot("A", 3, "L-WR")]);
  assert.deepEqual(late.ignored, ["L-WR9"]);
  // A WR whose MFL slot is taken by a locked WR moves to the next free WR slot.
  assert.deepEqual(mergeMirror([slot("A", 3, "L-WR")], [slot("A", 3, "WR5")], locked).rows, [slot("A", 3, "L-WR"), slot("A", 4, "WR5")]);
});

test("comparison: team totals and every starter whose points differ (or who isn't a starter on one side)", () => {
  const rows = compareTeams({
    season: 2026, week: 7, at: "2026-10-25T18:00:00Z",
    franchises: [{ id: "A", score: 20, starters: [{ mflId: "m1", score: 12 }, { mflId: "m2", score: 8 }] },
      { id: "B", score: 10, starters: [{ mflId: "m3", score: 10 }, { mflId: "m9", score: 0 }] }],
    slots: new Map([["A", [slot("A", 0, "p1"), slot("A", 3, "p2")]], ["B", [slot("B", 0, "p3"), slot("B", 1, "p4")]]]),
    map: new Map([["m1", "p1"], ["m2", "p2"], ["m3", "p3"]]),
    ours: new Map([["p1", 12], ["p2", 8], ["p3", 6], ["p4", 1]]),
    names: new Map([["p3", "Third"], ["p4", "Fourth"]]),
    prevSince: new Map([["B", "2026-10-25T17:50:00Z"]])
  });
  assert.deepEqual(rows[0], { season: 2026, week: 7, team_id: "A", our_points: 20, mfl_points: 20, players: [], diff_since: null, checked_at: "2026-10-25T18:00:00Z" });
  assert.equal(rows[1]!.our_points, 7);
  assert.deepEqual(rows[1]!.players, [
    { player_id: "p3", mfl_id: "m3", name: "Third", ours: 6, mfl: 10 },
    { mfl_id: "m9", ours: null, mfl: 0 },
    { player_id: "p4", name: "Fourth", ours: 1, mfl: null }]);
  assert.equal(rows[1]!.diff_since, "2026-10-25T17:50:00Z", "a difference that persists keeps when it first appeared");
});
