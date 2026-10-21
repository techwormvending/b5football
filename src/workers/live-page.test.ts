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

test("done / playing / to go / bye, and the card status: Upcoming -> Live -> Final (unofficial) -> Final (official)", () => {
  const s = (nfl: string) => ({ revealed: true, nfl_team: nfl });
  const p = V.progress([s("KC"), s("DET"), s("MIA"), { revealed: false }, s("PIT"), { revealed: false, bye: true }], games, NOW);
  assert.deepEqual(plain(p), { done: 1, playing: 1, toGo: 2, bye: 2, out: 0, doubtful: 0, questionable: 0 }, "KC final done, DET playing, MIA + hidden to go, PIT + a hidden bye slot on bye");
  assert.equal(V.progressText(p), "1 done · 1 playing · 2 to go · 2 bye");
  const z = { done: 0, playing: 0, toGo: 9, bye: 0 }, fin = { done: 9, playing: 0, toGo: 0, bye: 0 };
  assert.equal(V.cardStatus({ status: "live" }, z, z).text, "Upcoming");
  assert.equal(V.cardStatus({ status: "live" }, p, z).text, "Live");
  assert.equal(V.cardStatus({ status: "live" }, fin, fin).text, "Final (unofficial)");
  assert.equal(V.cardStatus({ status: "pending_review" }, fin, fin).text, "Final (official)");
  assert.equal(V.cardStatus({ status: "final" }, fin, fin).text, "Final (official)");
  assert.equal(V.cardStatus(null, z, z).text, "Upcoming");
});

test("byes never make a matchup Live: before any game starts, starters on bye are just on bye", () => {
  const early = [g("DET@ARI", "2026-10-25T17:00:00Z"), g("BUF@MIA", "2026-10-25T20:25:00Z")];   // nothing kicked off
  const at = Date.parse("2026-10-25T12:00:00Z"), s = (nfl: string) => ({ revealed: true, nfl_team: nfl });
  const a = V.progress([s("PIT"), s("NYJ"), { revealed: false }, { revealed: false, bye: true }], early, at);
  const h = V.progress([{ revealed: false }, { revealed: false }], early, at);
  assert.deepEqual(plain(a), { done: 0, playing: 0, toGo: 1, bye: 3, out: 0, doubtful: 0, questionable: 0 });
  assert.equal(V.cardStatus({ status: "live" }, a, h).text, "Upcoming", "3 byes aren't 3 done");
  const allBye = { done: 0, playing: 0, toGo: 0, bye: 9 };
  assert.equal(V.cardStatus({ status: "live" }, allBye, allBye).text, "Upcoming", "byes alone never start a matchup");
  assert.equal(V.cardStatus({ status: "live" }, { done: 1, playing: 0, toGo: 0, bye: 8 }, allBye).text, "Final (unofficial)", "one starter played, the rest on bye");
  assert.equal(V.playerGame([], "PIT", NOW).state, "pre", "the week's games not loaded yet: not a bye");
});

test("starters on bye: BYE status, counted for the warning, hidden bye slots flagged; bench byes held back while a bye slot is hidden", () => {
  const slots = [{ slot: 0, player_id: "QB1", name: "Q", nfl_team: "PIT", revealed: true }, { slot: 1, player_id: null, revealed: false, bye: true },
    { slot: 2, player_id: "RB2", name: "R2", nfl_team: "ARI", revealed: true }];
  const roster = [{ id: "QB1", name: "Q", pos: "QB", nfl_team: "PIT" }, { id: "RB2", name: "R2", pos: "RB", nfl_team: "ARI" },
    { id: "RB7", name: "R7", pos: "RB", nfl_team: "NYJ" }, { id: "WR9", name: "W9", pos: "WR", nfl_team: "DET" }];
  const v = V.lineupView(slots, roster, { RB2: { points: 8, lines: [] } }, games, NOW);
  assert.equal(v.starters[0].player.game.state, "bye");
  assert.equal(v.byes, 2, "the revealed bye QB and the hidden bye RB");
  assert.equal(v.starters[1].bye, true);
  assert.equal(v.total, 8);
  assert.deepEqual(plain(v.bench.map((p: { id: string }) => p.id)), ["WR9"], "RB7 (bye) could be the hidden bye starter");
  const html = V.cardsHtml({ week: 7, sw: { status: "live" }, games, matchups: [{ away_team: "0001", home_team: "0002", away_score: 8, home_score: 0 }],
    slots: [...slots.map(s => ({ ...s, team_id: "0001" })), { team_id: "0002", slot: 0, player_id: null, revealed: false }] });
  assert.match(html, /⚠ 2 starters on bye/);
  assert.match(html, /0 done · 1 playing · 0 to go · 2 bye/);
});

test("injury warnings: out (incl. IR/PUP/suspended/reserve), doubtful and questionable starters who haven't finished; hidden starters count; byes outrank", () => {
  const s = (nfl: string, injury: string | null) => ({ revealed: true, nfl_team: nfl, injury });
  const p = V.progress([s("MIA", "Out"), s("MIA", "IR"), s("DET", "Doubtful"), s("MIA", "Questionable"), { revealed: false, injury: "Questionable" },
    s("KC", "Out"), s("PIT", "Out"), { revealed: false, bye: true, injury: "IR" }, s("MIA", null)], games, NOW);
  assert.deepEqual(plain(p), { done: 1, playing: 1, toGo: 5, bye: 2, out: 2, doubtful: 1, questionable: 2 },
    "KC is final (moot), PIT and the hidden IR player are on bye (bye wins)");
  const html = V.cardsHtml({ week: 7, sw: { status: "live" }, games, matchups: [{ away_team: "0001", home_team: "0002", away_score: 0, home_score: 0 }],
    slots: [{ team_id: "0001", slot: 0, player_id: "Q", nfl_team: "MIA", revealed: true, injury: "Out" }, { team_id: "0001", slot: 1, player_id: null, revealed: false, injury: "Doubtful" },
      { team_id: "0001", slot: 2, player_id: "W", nfl_team: "PIT", revealed: true, injury: null }, { team_id: "0002", slot: 0, player_id: null, revealed: false, injury: "Questionable" }] });
  assert.match(html, /⚠ 1 starter on bye · 1 out · 1 doubtful/);
  assert.match(html, /<span class="lv-warn q">1 questionable<\/span>/);
});

test("lineup: injury status from the week's report (bench too), falling back to the slot's status", () => {
  const slots = [{ slot: 0, player_id: "QB1", name: "Q", nfl_team: "MIA", revealed: true, injury: "Out" }, { slot: 1, player_id: null, revealed: false, injury: "Doubtful" }];
  const roster = [{ id: "QB1", name: "Q", pos: "QB", nfl_team: "MIA" }, { id: "RB7", name: "R7", pos: "RB", nfl_team: "KC" }];
  const v = V.lineupView(slots, roster, {}, games, NOW, { RB7: { player_id: "RB7", status: "Questionable", injury: "Ankle", practice: "Limited Participation in Practice" } });
  assert.deepEqual(plain(v.starters[0].player.injury), { status: "Out" });
  assert.equal(v.starters[1].injury, "Doubtful");
  assert.equal(v.bench[0].injury.injury, "Ankle");
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

test("one page: week links stay on Live; #live/<week>/<franchiseId> selects that matchup; old matchup links redirect", () => {
  const known = (k: string) => ["home", "live", "schedule"].includes(k);
  const html = V.weekChipsHtml(7);
  const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(\d+)<\/a>/g)];
  assert.equal(links.length, 17);
  for (const [, href, label] of links) assert.deepEqual({ ...R.parse(href!, known) }, { page: "live", week: Number(label) });
  assert.doesNotMatch(read("live.js"), /data-sched-week|data-week=/, "the Schedule's week handler can't grab these");
  assert.deepEqual({ ...R.parse("#live", known) }, { page: "live", week: null });
  assert.deepEqual({ ...R.parse("#live/7/0002", known) }, { page: "live", week: 7, team: "0002" });
  assert.deepEqual({ ...R.parse("#live/7/0001-0002", known) }, { page: "live", week: 7, team: "0001", redirect: "#live/7/0001" });
  assert.deepEqual({ ...R.parse("#matchup/3/0005-0006", known) }, { page: "live", week: 3, team: "0005", redirect: "#live/3/0005" });
  assert.match(read("app.js"), /r\.redirect && history\.replaceState/, "the router rewrites old links in place");
});

test("selected matchup: the deep-linked team's (either side), else the signed-in manager's, else the first card", () => {
  const ms = [{ away_team: "0007", home_team: "0005" }, { away_team: "0001", home_team: "0011" }, { away_team: "0004", home_team: "0002" }];
  const pick = (team: string | null, mine: string[] = []) => { const m = V.pickMatchup(ms, team, mine); return m && m.away_team + "-" + m.home_team; };
  assert.equal(pick("0011"), "0001-0011", "home side deep link");
  assert.equal(pick("0004"), "0004-0002");
  assert.equal(pick(null, ["0002"]), "0004-0002", "signed in: my team's matchup");
  assert.equal(pick("0007", ["0002"]), "0007-0005", "a deep link beats my team");
  assert.equal(pick(null), "0001-0011", "signed out: the first card (cards are ordered by away team)");
  assert.equal(pick("9999"), "0001-0011", "unknown team: the first card");
  assert.equal(V.pickMatchup([], "0001", []), null);
});

test("cards: one per matchup, each a deep link to itself, the selected one highlighted, leader marked", () => {
  const d = { week: 7, sw: { status: "live", updated_at: new Date().toISOString(), live_delayed: false }, games,
    matchups: [{ away_team: "0001", home_team: "0002", away_score: 40.5, home_score: 38 }, { away_team: "0003", home_team: "0004", away_score: 0, home_score: 0 }],
    slots: [{ team_id: "0001", slot: 0, player_id: "QB1", nfl_team: "DET", revealed: true }, { team_id: "0002", slot: 0, player_id: null, revealed: false }] };
  const html = V.cardsHtml(d, "0004");
  assert.match(html, /href="#live\/7\/0001" data-lv-team="0001">/);
  assert.match(html, /class="card lv-card lv-upcoming sel" href="#live\/7\/0003" data-lv-team="0003" aria-current="true">/);
  assert.match(html, /lv-row lead"><div class="logo sm">N<\/div><div class="lv-name"><b>NSFW/);
  assert.match(html, /0 done · 1 playing · 0 to go · 0 bye/);
  assert.match(html, /<span class="tag lv-st">Live<\/span>/);
  assert.match(V.cardsHtml(d, null, ["0002"]), /lv-live sel"/, "signed in as 0002's manager: that card is selected");
  assert.match(read("live.js"), /Unofficial — MFL is official for/);
});

