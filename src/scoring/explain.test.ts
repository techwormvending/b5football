/* Points breakdown: the engine's lines, described. The lines must always add up to the points. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { breakdown, breakdownTotal } from "./explain.ts";
import { scoreStatLine } from "./engine.ts";
import { B5_RULES, POSITIONS } from "./rules.ts";
import type { Position, StatLine } from "./types.ts";

const texts = (pos: Position, s: StatLine) => breakdown(pos, s).map(l => `${l.text} → ${l.points}`);

test("readable lines for the rules that scored", () => {
  assert.deepEqual(texts("WR", { recTdLengths: [52], receptions: 6, recYds: 112 }),
    ["52-yd receiving TD (51–75) → 10", "6 receptions × 0.5 → 3", "112 total yards (100+): 6 → 6"]);
  assert.deepEqual(texts("RB", { rushYds: 98, recYds: 39, receptions: 3 }),
    ["3 receptions × 0.5 → 1.5", "137 total yards (100+): 8 + 2 × 1 (per full 25 over 100) → 10"]);
  assert.deepEqual(texts("TE", { recTdLengths: [12], receptions: 1, recYds: 12 }),
    ["12-yd receiving TD (11–20) → 7", "1 reception × 1 → 1", "12 total yards (1–24) → 1"]);
  assert.deepEqual(texts("K", { fgMadeLengths: [47, 25], extraPoints: 2 }),
    ["25-yd field goal (1–30) → 3", "47-yd field goal (31–59): 3.1 + 0.1 × 16 (per yard over 31) → 4.7", "2 extra points × 1 → 2"]);
  assert.deepEqual(texts("QB", { passYds: 190, rushYds: 20, interceptionsThrown: 1 }),
    ["1 INT thrown × -1 → -1", "210 total yards (200+): 5 → 5"]);
  assert.deepEqual(texts("DEF", { passYdsAllowed: 160, rushYdsAllowed: 84, offensiveTdsAllowed: 0, opponentPoints: 0, sacks: 3 }),
    ["3 sacks × 1 → 3", "160 net passing yards allowed (150–174) → 3", "84 rushing yards allowed (0–99) → 6",
      "No offensive TDs allowed → 8", "Opponent held scoreless → 2"]);
});

test("real games: the breakdown adds up to MFL's official totals", () => {
  const games: [Position, StatLine, number][] = [
    ["QB", { passYds: 334, rushYds: 23, rushTdLengths: [21, 1], passTdLengths: [43, 34] }, 41],
    ["QB", { passYds: 361, rushYds: 10, passTdLengths: [4, 51, 8], rushTdLengths: [7], interceptionsThrown: 1 }, 38],
    ["WR", { recYds: 147, receptions: 6, recTdLengths: [81, 2] }, 29],
    ["WR", { recYds: 182, receptions: 10 }, 17],
    ["DEF", { passYdsAllowed: 193, rushYdsAllowed: 89, offensiveTdsAllowed: 2, opponentPoints: 27, sacks: 4, fumbleRecoveries: 4, defFumbleRecoveryTds: 1 }, 25]
  ];
  for (const [pos, s, mfl] of games) assert.equal(breakdownTotal(breakdown(pos, s)), mfl);
});

test("every possible line is described (no raw stat names), and lines always sum to the engine's total", () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const many = (k: number, max: number) => Array.from({ length: rnd(k) }, () => rnd(max) + 1);
  for (let i = 0; i < 3000; i++) {
    const pos = POSITIONS[i % POSITIONS.length]!;
    const s: StatLine = {
      passYds: rnd(420) - 10, rushYds: rnd(200) - 15, recYds: rnd(220) - 5, receptions: rnd(14), interceptionsThrown: rnd(4),
      passTdLengths: many(4, 99), rushTdLengths: many(3, 99), recTdLengths: many(3, 99), fgMadeLengths: many(5, 64),
      twoPtPasses: rnd(2), twoPtRushes: rnd(2), twoPtReceptions: rnd(2), extraPoints: rnd(6),
      puntReturnTds: rnd(2), kickReturnTds: rnd(2), intReturnTds: rnd(2), defFumbleRecoveryTds: rnd(2), offFumbleRecoveryTds: rnd(2),
      interceptions: rnd(4), fumbleRecoveries: rnd(4), sacks: rnd(8), safeties: rnd(2), blockedFgs: rnd(2), blockedFgTds: rnd(2),
      blockedPunts: rnd(2), blockedPuntTds: rnd(2), defTwoPtReturns: rnd(2),
      passYdsAllowed: rnd(400) - 20, rushYdsAllowed: rnd(220) - 20, offensiveTdsAllowed: rnd(4), opponentPoints: rnd(3) ? rnd(40) : 0
    };
    const lines = breakdown(pos, s);
    assert.equal(breakdownTotal(lines), scoreStatLine(pos, s).total, JSON.stringify([pos, s]));
    for (const l of lines) assert.doesNotMatch(l.text, /[a-z][A-Z]/, `undescribed line ${l.text}`);
  }
  // Every rule's stat has a label.
  for (const pos of POSITIONS) for (const r of B5_RULES[pos]) assert.doesNotMatch(breakdown(pos, {})[0]?.text ?? "ok", /[a-z][A-Z]/);
});

test("a commissioner-pinned score gets an override line, so the lines still add up", () => {
  const lines = breakdown("WR", { receptions: 4, recYds: 60 }, 12);
  assert.equal(lines.at(-1)!.stat, "override");
  assert.equal(lines.at(-1)!.points, 8);
  assert.equal(breakdownTotal(lines), 12);
  assert.equal(breakdown("WR", { receptions: 4, recYds: 60 }, 4).length, 2, "no override line when the points match");
});

test("a defense without allowed-stats has no lines (the engine refuses to score it)", () => {
  assert.deepEqual(breakdown("DEF", { sacks: 2 }), []);
});
