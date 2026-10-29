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

test("game cards: records with ties, missing odds, dome vs outdoor weather, international venue, alerts, live score", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const G = P as any;
  // Records
  assert.equal(G.recordText("5-2"), "(5-2)");
  assert.equal(G.recordText("4-2-1"), "(4-2-1)");
  assert.equal(G.recordText(null), "");
  // Lines: posted, partial, missing
  const line = { spread: "KC -3.5", over_under: 47.5, odds_provider: "DraftKings", odds_at: "2026-10-29T15:00:00Z" };
  assert.equal(G.lineText(line), "KC -3.5 · O/U 47.5");
  assert.equal(G.lineText({ spread: "Pick'em", over_under: null }), "Pick'em");
  assert.equal(G.lineText({ spread: null, over_under: null }), "Line not posted");
  assert.equal(G.lineText(undefined), "Line not posted");
  assert.equal(G.lineSource(line), "DraftKings via ESPN, as of Thu 11:00 AM ET");
  // Kickoff in ET, international label
  const g = { game_key: "ATL@CIN", away: "ATL", home: "CIN", kickoff: "2026-11-01T14:30:00Z", status: "scheduled" };
  assert.equal(G.kickoffText(g, { intl: "Madrid" }), "Sun, 11/1, 9:30 AM ET · Madrid");
  assert.equal(G.kickoffText(g, {}), "Sun, 11/1, 9:30 AM ET");
  // Stadiums and weather
  assert.equal(G.venueText({ roof: "dome", surface: "turf" }), "Dome · turf");
  assert.equal(G.venueText({ roof: "retractable", surface: "grass" }), "Retractable roof · grass");
  assert.equal(G.weatherText({ roof: "dome", weather: { temp_f: 70 } }), "Indoors", "domes never show a forecast");
  const snow = { temp_f: 23, condition: "Heavy snow", icon: "❄️", wind_mph: 17, precip_pct: 70, heavy: true, source: "Open-Meteo" };
  assert.equal(G.weatherText({ roof: "outdoor", weather: snow }), "❄️ 23°F Heavy snow, wind 17 mph, 70% precip");
  assert.equal(G.weatherText({ roof: "retractable", weather: { temp_f: 60, icon: "⛅", condition: "Partly cloudy", wind_mph: 5, precip_pct: 10 } }), "⛅ 60°F Partly cloudy, wind 5 mph, 10% precip (roof may close)");
  assert.equal(G.weatherText({ roof: "outdoor", weather: null }), "Forecast not posted yet");
  assert.deepEqual(JSON.parse(JSON.stringify(G.weatherAlerts(snow))), ["wind 17 mph", "heavy snow", "23°F"]);
  assert.deepEqual(JSON.parse(JSON.stringify(G.weatherAlerts({ temp_f: 26, wind_mph: 14, heavy: false }))), [], "under every threshold");
  const outdoorCard = String(G.gameMetaHtml(g, { roof: "outdoor", surface: "grass", venue_name: "Paycor Stadium", weather: snow, weather_at: "2026-10-29T15:00:00Z" }, Date.parse("2026-10-30T00:00:00Z")));
  assert.match(outdoorCard, /pl-wx alert" title="Forecast as of Thu 11:00 AM ET \(Open-Meteo\)">⚠ ❄️ 23°F Heavy snow/);
  const domeCard = String(G.gameMetaHtml(g, { roof: "dome", surface: "turf", weather: snow }, Date.parse("2026-10-30T00:00:00Z")));
  assert.match(domeCard, /Dome · turf<\/span> · <span class="pl-wx" title="">Indoors<\/span>/);
  // Started games show the score (and keep the stadium and weather)
  const live = { ...g, status: "in_progress", away_score: 17, home_score: 14, status_detail: "3rd 4:12" };
  assert.equal(G.scoreText(live), "ATL 17 – CIN 14 · 3rd 4:12");
  assert.equal(G.scoreText({ ...live, status: "final" }), "Final: ATL 17 – CIN 14");
  assert.match(String(G.gameMetaHtml(live, { roof: "retractable", intl: "Madrid" }, Date.parse("2026-11-01T16:00:00Z"))), /^<div class="pl-gmeta small"><b class="pl-score">ATL 17 – CIN 14 · 3rd 4:12<\/b> · <span title="">Retractable roof<\/span>/);
});
