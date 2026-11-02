/* Tests for pools.js's pure helpers (classic browser script, loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, teams: [] } };
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../teamlink.js"), "utf8"), ctx);
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../pools.js"), "utf8"), ctx);
type Row = { game: { game_key: string; away: string; home: string }; pick: string | null; points: number | null; locked: boolean };
type Opt = { value: string; label: string; disabled: boolean };
const P = ctx.B5Pools as {
  result(g: unknown): string | null;
  availableTeams(picks: { team_id: string; nfl_team: string }[], team: string): string[];
  confidenceRows(games: unknown[], picks: unknown[], now: number): Row[];
  kickoffOrder(games: unknown[]): { game_key: string }[];
  setPoints(rows: Row[], i: number, v: number | string | null): { rows: Row[]; swapped: { i: number; points: number | null } | null; error: string | null };
  swapText(rows: Row[], sw: { i: number; points: number | null } | null): string;
  unusedValues(rows: Row[], n: number): number[];
  needingPick(rows: Row[]): number;
  fillRemaining(rows: Row[], n: number): Row[];
  optionsFor(rows: Row[], i: number, n: number): Opt[];
  savePayload(rows: Row[]): unknown[];
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

test("confidence: games always in kickoff order (Thursday -> Monday), same kickoff alphabetical by away team; never reordered by points", () => {
  const same = [...games, game("AA@ZZ", "2026-10-18T17:00:00Z"), game("ZZZ@B2", "2026-10-18T17:00:00Z")];
  assert.deepEqual(plain(P.kickoffOrder(same).map(g => g.game_key)), ["G@H", "A@B", "AA@ZZ", "ZZZ@B2", "C@D", "E@F"]);
  const rows = P.confidenceRows(games, [{ game_key: "E@F", pick: "E", points: 4 }, { game_key: "G@H", pick: "G", points: 1 }], NOW);
  assert.deepEqual(plain(rows.map(r => [r.game.game_key, r.pick, r.points, r.locked])),
    [["G@H", "G", 1, true], ["A@B", null, null, true], ["C@D", null, null, false], ["E@F", "E", 4, false]], "blanks stay blank; started games locked");
  const after = P.setPoints(rows, 2, 3).rows;
  assert.deepEqual(plain(after.map(r => r.game.game_key)), ["G@H", "A@B", "C@D", "E@F"], "the order never changes");
});

test("confidence: picking a used value swaps (the other game gets this game's old value, or blank)", () => {
  let rows = P.confidenceRows(games, [{ game_key: "C@D", pick: "D", points: 2 }, { game_key: "E@F", pick: "E", points: 4 }], NOW);
  let r = P.setPoints(rows, 2, 4);   // C@D 2 -> 4: E@F had 4, gets 2
  assert.deepEqual(plain(r.rows.map(x => x.points)), [null, null, 4, 2]);
  assert.equal(P.swapText(r.rows, r.swapped), "Swapped: E vs F is now 2.");
  rows = P.confidenceRows(games, [{ game_key: "E@F", pick: "E", points: 4 }], NOW);
  r = P.setPoints(rows, 2, 4);       // C@D blank -> 4: E@F becomes blank
  assert.deepEqual(plain(r.rows.map(x => x.points)), [null, null, 4, null]);
  assert.equal(P.swapText(r.rows, r.swapped), "Swapped: E vs F is now blank.");
  assert.deepEqual(plain(P.setPoints(r.rows, 2, "").rows.map(x => x.points)), [null, null, null, null], "clearing a value");
});

test("confidence: locked games keep their value; it can't be taken by a swap and the dropdown marks it", () => {
  const rows = P.confidenceRows(games, [{ game_key: "G@H", pick: "G", points: 3 }, { game_key: "C@D", pick: "D", points: 1 }], NOW);
  const r = P.setPoints(rows, 2, 3);
  assert.equal(r.rows, rows, "nothing changes");
  assert.match(String(r.error), /3 is locked on G vs H/);
  assert.match(String(P.setPoints(rows, 0, 2).error), /locked/, "a locked game's own value can't change");
  const opts = P.optionsFor(rows, 3, 4);
  assert.deepEqual(plain(opts.map(o => [o.value, o.label, o.disabled])), [["", "—", false], ["1", "1 — used on C vs D", false], ["2", "2", false], ["3", "3 — locked on G vs H", true], ["4", "4", false]]);
});

test("confidence: unused values, games still needing a pick, fill remaining in kickoff order, blanks save (and score 0)", () => {
  const rows = P.confidenceRows(games, [{ game_key: "C@D", pick: "D", points: 2 }, { game_key: "G@H", pick: "G", points: 4 }], NOW);
  assert.deepEqual(plain(P.unusedValues(rows, 4)), [1, 3]);
  assert.equal(P.needingPick(rows), 1, "E@F (open, no pick); the locked A@B can't be fixed any more");
  const filled = P.fillRemaining(rows, 4);
  assert.deepEqual(plain(filled.map(x => x.points)), [4, null, 2, 1], "the open game without a value gets the lowest unused; locked A@B untouched");
  assert.deepEqual(plain(P.savePayload(P.setPoints(rows, 2, null).rows)), [{ game_key: "G@H", pick: "G", points: 4 }, { game_key: "C@D", pick: "D", points: null }],
    "a winner without a value is saved; empty games aren't sent (the server clears them)");
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
