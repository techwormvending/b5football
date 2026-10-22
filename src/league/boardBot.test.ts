import { test } from "node:test";
import assert from "node:assert/strict";
import { planBotPosts, weeklyRecap, type Award } from "./boardBot.ts";

const name = (id: string) => ({ A: "Stealers", B: "NSFW", C: "Mac Daddies", D: "H.N.I.C" } as Record<string, string>)[id] ?? id;
const scores = [{ week: 7, team_id: "A", points: 142.5 }, { week: 7, team_id: "B", points: 101.3 }, { week: 7, team_id: "C", points: 100.9 }, { week: 7, team_id: "D", points: 70.1 }];
const matchups = [{ week: 7, home_team: "A", away_team: "D", home_score: 142.5, away_score: 70.1 }, { week: 7, home_team: "C", away_team: "B", home_score: 100.9, away_score: 101.3 }];
const awards: Award[] = [{ kind: "weekly_high", week: 7, place: null, label: "Week 7 high score", team_id: "A", amount: 35, status: "final" }];
const chops = [{ week: 7, team_id: "D", points: 70.1 }];

test("weekly recap: high score with its prize, guillotine chop, biggest blowout, closest game", () => {
  const r = weeklyRecap({ season: 2026, week: 7, scores, matchups, awards, chops, name })!;
  assert.equal(r.key, "recap:2026:7");
  assert.equal(r.title, "Week 7 recap");
  assert.equal(r.body, [
    "🏆 **High score:** Stealers, 142.5 ($35)",
    "🪓 **Guillotine:** H.N.I.C chopped (70.1)",
    "💥 **Biggest blowout:** Stealers 142.5 – H.N.I.C 70.1 (by 72.4)",
    "😬 **Closest game:** NSFW 101.3 – Mac Daddies 100.9 (by 0.4)"].join("\n"));
});

test("a tied high score names everyone and the split", () => {
  const tied = [{ week: 3, team_id: "A", points: 120 }, { week: 3, team_id: "B", points: 120 }];
  const r = weeklyRecap({ season: 2026, week: 3, scores: tied, matchups: [], chops: [], name,
    awards: [{ kind: "weekly_high", week: 3, place: null, label: "x", team_id: "A", amount: 17.5, status: "final" }] })!;
  assert.equal(r.body, "🏆 **High score:** Stealers and NSFW, 120.0 ($17.50 each)");
  assert.equal(weeklyRecap({ season: 2026, week: 9, scores: [], matchups: [], awards: [], chops: [], name }), null, "nothing scored yet");
});

test("plan: first run only records what exists; then new final weeks and awards post once; switched-off types are recorded, not posted", () => {
  const all = { season: 2026, scores, matchups, chops, name, finalWeeks: [7],
    awards: [...awards, { kind: "season_points", week: null, place: 1, label: "Most points: 1st", team_id: "A", amount: 1075, status: "final" },
      { kind: "champion", week: 17, place: null, label: "Champion", team_id: "B", amount: 240, status: "projected" }] as Award[] };
  const first = planBotPosts({ ...all, settings: { auto_recap: true, auto_awards: true }, seen: new Set() });
  assert.deepEqual(first.posts, []);
  assert.deepEqual(first.keys.map(k => [k.key, k.posted]), [["recap:2026:7", false], ["award:2026:season_points::1:A", false]],
    "weekly highs are in the recap; projected awards wait");
  const seen = new Set(first.keys.map(k => k.key));
  const later = planBotPosts({ ...all, finalWeeks: [7, 8], scores: [...scores, { week: 8, team_id: "C", points: 99 }],
    awards: [...all.awards, { kind: "survivor", week: null, place: null, label: "Survivor", team_id: "A", amount: 240, status: "final" }],
    settings: { auto_recap: true, auto_awards: false }, seen });
  assert.deepEqual(later.posts.map(p => p.title), ["Week 8 recap"]);
  assert.deepEqual(later.keys.map(k => [k.key, k.posted]), [["recap:2026:8", true], ["award:2026:survivor:::A", false]]);
  const again = planBotPosts({ ...all, finalWeeks: [7, 8], settings: { auto_recap: true, auto_awards: true }, seen: new Set([...seen, ...later.keys.map(k => k.key)]) });
  assert.deepEqual(again.posts, [], "never twice");
});

test("an award post", () => {
  const r = planBotPosts({ season: 2026, scores: [], matchups: [], chops: [], name, finalWeeks: [], seen: new Set(["x"]), settings: { auto_recap: true, auto_awards: true },
    awards: [{ kind: "playoff_r1", week: 15, place: null, label: "Playoffs round 1 win", team_id: "C", amount: 60, status: "final" }] });
  assert.deepEqual(r.posts, [{ key: "award:2026:playoff_r1:15::C", title: "💰 Playoffs round 1 win: Mac Daddies", body: "**Mac Daddies** wins **Playoffs round 1 win**: $60. It's final." }]);
});
