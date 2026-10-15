import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { crosswalkFromRows, toCanonical } from "./crosswalk.ts";
import type { GameData } from "./types.ts";

const rows = [
  { gsis_id: "00-0033106", espn_id: "3046779", display_name: "Jared Goff", position: "QB", latest_team: "DET" },
  { gsis_id: "00-0038542", espn_id: "4430027", display_name: "Sam LaPorta", position: "TE", latest_team: "DET" },
  { gsis_id: "00-0099999", espn_id: "NA", display_name: "No Espn", position: "WR", latest_team: "DET" },
  // Same ESPN ID on two different players = ambiguous, so neither is trusted
  { gsis_id: "00-0011111", espn_id: "555", display_name: "Dup One", position: "RB", latest_team: "DET" },
  { gsis_id: "00-0022222", espn_id: "555", display_name: "Dup Two", position: "RB", latest_team: "DET" }
];

describe("crosswalk", () => {
  const cw = crosswalkFromRows(rows);
  test("maps ESPN IDs to nflverse IDs; skips NA and ambiguous IDs", () => {
    assert.equal(cw.fromEspn("3046779")?.gsisId, "00-0033106");
    assert.equal(cw.fromEspn("555"), undefined);
    assert.equal(cw.size, 2);
  });

  test("toCanonical rewrites box scores and events; unmatched players are flagged, never guessed", () => {
    const espn = (id: string, name: string) => ({ provider: "espn", id, name, team: "DET" });
    const g: GameData = {
      provider: "espn", gameId: "401", season: 2026, week: 5, home: "ARI", away: "DET", homeScore: 0, awayScore: 7, status: "final",
      players: [{ player: espn("3046779", "Jared Goff"), passYds: 200 }, { player: espn("777", "Jared Gof"), rushYds: 5 }],
      teams: {},
      events: [{ kind: "td", td: "pass", team: "DET", length: 38, passer: espn("3046779", "Jared Goff"), scorer: espn("4430027", "Sam LaPorta") }],
      warnings: []
    };
    const { game, unmatched } = toCanonical(g, cw);
    assert.deepEqual(game.players[0]!.player, { provider: "nflverse", id: "00-0033106", name: "Jared Goff", team: "DET", position: "QB" });
    const ev = game.events[0]!;
    assert.ok(ev.kind === "td" && ev.scorer?.id === "00-0038542" && ev.passer?.id === "00-0033106");
    // A near-identical name is NOT matched; it keeps its ESPN identity and goes to review
    assert.equal(game.players[1]!.player.provider, "espn");
    assert.deepEqual(unmatched, [{ provider: "espn", providerId: "777", name: "Jared Gof", gameId: "401", week: 5, team: "DET", reason: "no nflverse ID for espn athlete 777" }]);
  });
});
