/* Live page helpers (live.js, a classic browser script loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { breakdown } from "../scoring/explain.ts";
import { scoreStatLine } from "../scoring/engine.ts";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, lineupsFrom: 2027, teams: [{ id: "0001", name: "NSFW" }, { id: "0002", name: "Stealers" }], schedule: { weeks: Array.from({ length: 17 }, (_, i) => ({ week: i + 1 })) } } };
vm.runInNewContext(read("route.js"), ctx);
vm.runInNewContext(read("live.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = ctx.B5Live as any;
const R = ctx.B5Route as { parse(h: string, k: (x: string) => boolean): Record<string, unknown> };
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const NOW = Date.parse("2026-10-25T18:30:00Z");   // Sunday 2:30 PM ET
const g = (key: string, kickoff: string, status = "scheduled", extra: Record<string, unknown> = {}) => {
  const [away, home] = key.split("@"); return { game_key: key, away, home, kickoff, status, home_score: null, away_score: null, ...extra };
};
const games = [
  g("DET@ARI", "2026-10-25T17:00:00Z", "in_progress", { status_detail: "3rd 4:12", home_score: 7, away_score: 10 }),
  g("KC@LV", "2026-10-23T00:15:00Z", "final", { home_score: 13, away_score: 27 }),
  g("BUF@MIA", "2026-10-25T20:25:00Z")
];

test("game status transitions: before kickoff -> live (clock) -> final; a team on bye", () => {
  assert.equal(V.gameState(g("A@B", "2026-10-25T20:25:00Z"), NOW), "pre");
  assert.equal(V.gameState(g("A@B", "2026-10-25T18:25:00Z"), NOW), "live", "kicked off, before the scorer has marked it");
  assert.equal(V.gameState(g("A@B", "2026-10-25T17:00:00Z", "in_progress"), NOW), "live");
  assert.equal(V.gameState(g("A@B", "2026-10-25T17:00:00Z", "final"), NOW), "final");
  assert.deepEqual(plain(V.playerGame(games, "DET", NOW)), { state: "live", opp: "@ ARI", text: "3rd 4:12", game: games[0] });
  assert.equal(V.playerGame(games, "ARI", NOW).opp, "vs DET");
  assert.equal(V.playerGame(games, "LV", NOW).text, "Final");
  assert.match(V.playerGame(games, "MIA", NOW).text, /^Sun 4:25/);
  assert.equal(V.playerGame(games, "PIT", NOW).state, "bye");
});

test("done / playing / to go, and the card status: Upcoming -> Live -> Final (unofficial) -> Final (official)", () => {
  const s = (nfl: string) => ({ revealed: true, nfl_team: nfl });
  const p = V.progress([s("KC"), s("DET"), s("MIA"), { revealed: false }, s("PIT")], games, NOW);
  assert.deepEqual(plain(p), { done: 2, playing: 1, toGo: 2 }, "final + bye done, DET playing, MIA + hidden to go");
  assert.equal(V.progressText(p), "2 done · 1 playing · 2 to go");
  const z = { done: 0, playing: 0, toGo: 9 }, fin = { done: 9, playing: 0, toGo: 0 };
  assert.equal(V.cardStatus({ status: "live" }, z, z).text, "Upcoming");
  assert.equal(V.cardStatus({ status: "live" }, p, z).text, "Live");
  assert.equal(V.cardStatus({ status: "live" }, fin, fin).text, "Final (unofficial)");
  assert.equal(V.cardStatus({ status: "pending_review" }, fin, fin).text, "Final (official)");
  assert.equal(V.cardStatus({ status: "final" }, fin, fin).text, "Final (official)");
  assert.equal(V.cardStatus(null, z, z).text, "Upcoming");
});

test("stale-data notice: only while a game is on, when the last live pass is over 3 minutes old or flagged delayed", () => {
  const at = (minAgo: number, extra = {}) => ({ status: "live", live_delayed: false, updated_at: new Date(NOW - minAgo * 60000).toISOString(), ...extra });
  assert.equal(V.staleness(at(1), games, NOW).stale, false);
  assert.equal(V.staleness(at(4), games, NOW).stale, true);
  assert.equal(V.staleness(at(1, { live_delayed: true }), games, NOW).stale, true);
  assert.equal(V.staleness(null, games, NOW).stale, true, "a game is on and nothing has been scored");
  const quiet = [games[1], games[2]];   // Thursday's game is over, Sunday's later game hasn't started
  assert.equal(V.staleness(at(600), quiet, NOW).stale, false, "no game on: old numbers aren't stale");
  assert.equal(V.staleness(at(10, { status: "final" }), games, NOW).stale, false, "nflverse has the week");
  assert.equal(V.ago(42000), "updated 42s ago");
  assert.equal(V.ago(185000), "updated 3 min ago");
});

test("lineup: 9 slots in order, hidden starters until kickoff, bench shown but never counted", () => {
  const slots = [{ slot: 0, player_id: "QB1", name: "Q", nfl_team: "DET", revealed: true }, { slot: 1, player_id: null, revealed: false },
    { slot: 8, player_id: "DEF:KC", name: "Chiefs", nfl_team: "KC", revealed: true }];
  const roster = [{ id: "QB1", name: "Q", pos: "QB", nfl_team: "DET" }, { id: "RB1", name: "R1", pos: "RB", nfl_team: "MIA" },
    { id: "RB2", name: "R2", pos: "RB", nfl_team: "ARI" }, { id: "DEF:KC", name: "Chiefs", pos: "DEF", nfl_team: "KC" }];
  const scores = { QB1: { points: 12.5, lines: [] }, "DEF:KC": { points: 9, lines: [] }, RB2: { points: 30, lines: [] } };
  const v = V.lineupView(slots, roster, scores, games, NOW);
  assert.deepEqual(plain(v.starters.map((s: { pos: string; hidden?: boolean; player?: { id: string } }) => [s.pos, s.player ? s.player.id : s.hidden ? "hidden" : "empty"])),
    [["QB", "QB1"], ["RB", "hidden"], ["RB", "empty"], ["WR", "empty"], ["WR", "empty"], ["WR", "empty"], ["TE", "empty"], ["K", "empty"], ["DEF", "DEF:KC"]]);
  assert.equal(v.total, 21.5, "starters only: the bench's 30 points don't count");
  assert.deepEqual(plain(v.bench.map((p: { id: string }) => p.id)), ["RB2"], "RB1 (yet to play) could be the hidden starter: listed from kickoff");
  assert.equal(v.benchTotal, 30);
  const full = V.lineupView(slots.filter(s => s.player_id), roster, scores, games, NOW);
  assert.deepEqual(plain(full.bench.map((p: { id: string }) => p.id)), ["RB1", "RB2"], "a fully known lineup: the whole bench");
});

test("the breakdown shown is the engine's lines, and they add up to the player's points", () => {
  const wr = { recTdLengths: [52], receptions: 6, recYds: 112 }, rb = { rushYds: 140, rushTdLengths: [3, 61], receptions: 2, recYds: 9 };
  assert.equal(V.lineSum(breakdown("WR", wr)), scoreStatLine("WR", wr).total);
  assert.equal(V.lineSum(breakdown("RB", rb)), scoreStatLine("RB", rb).total);
  assert.equal(V.lineSum(breakdown("WR", { receptions: 4, recYds: 60 }, 12)), 12, "a pinned score's override line keeps the sum right");
  assert.doesNotMatch(read("live.js"), /scoreStatLine|rulePoints|B5_RULES/, "the page never recalculates points");
});

test("scoring-play feed: the two teams' starters only, newest first, 6+ point plays flagged", () => {
  const ev = [{ player_id: "QB1", at: "2026-10-25T18:01:00Z", delta: 10, points: 14, lines: [] }, { player_id: "X", at: "2026-10-25T18:05:00Z", delta: 6, points: 6, lines: [] },
    { player_id: "RB9", at: "2026-10-25T18:10:00Z", delta: 2, points: 4, lines: [] }];
  const out = V.feed(ev, [{ team: "0001", ids: ["QB1"] }, { team: "0002", ids: ["RB9"] }]);
  assert.deepEqual(plain(out.map((e: { player_id: string; team: string; big: boolean }) => [e.player_id, e.team, e.big])), [["RB9", "0002", false], ["QB1", "0001", true]]);
});

test("every Live week link stays on the Live page; matchup links (old ones too) open the Live detail", () => {
  const known = (k: string) => ["home", "live", "schedule"].includes(k);
  const html = V.weekChipsHtml(7);
  const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(\d+)<\/a>/g)];
  assert.equal(links.length, 17);
  for (const [, href, label] of links) assert.deepEqual({ ...R.parse(href!, known) }, { page: "live", week: Number(label) });
  assert.doesNotMatch(read("live.js"), /data-sched-week|data-week=/, "the Schedule's week handler can't grab these");
  assert.deepEqual({ ...R.parse("#live", known) }, { page: "live", week: null });
  assert.deepEqual({ ...R.parse("#live/7/0001-0002", known) }, { page: "live", week: 7, away: "0001", home: "0002" });
  assert.deepEqual({ ...R.parse("#matchup/3/0005-0006", known) }, { page: "live", week: 3, away: "0005", home: "0006" });
});

test("scoreboard: one card per matchup linking to its detail, leader marked, 2026 labelled unofficial", () => {
  const html = V.scoreboardHtml({ week: 7, sw: { status: "live", updated_at: new Date().toISOString(), live_delayed: false }, games,
    matchups: [{ away_team: "0001", home_team: "0002", away_score: 40.5, home_score: 38 }],
    slots: [{ team_id: "0001", slot: 0, player_id: "QB1", nfl_team: "DET", revealed: true }, { team_id: "0002", slot: 0, player_id: null, revealed: false }] });
  assert.match(html, /Unofficial — MFL is official for 2026/);
  assert.match(html, /href="#live\/7\/0001-0002"/);
  assert.match(html, /lv-row lead"><div class="logo sm">N<\/div><div class="lv-name"><b>NSFW/);
  assert.match(html, /0 done · 1 playing · 0 to go/);
  assert.match(html, /<span class="tag lv-st">Live<\/span>/);
  assert.match(html, /DET <b>10<\/b>/, "the NFL strip shows live scores");
});
