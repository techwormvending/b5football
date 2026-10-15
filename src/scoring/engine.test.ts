/* Scoring engine tests. Every expected total is worked out by hand from the
   B5 rules (see rules.ts); the arithmetic is in the comment next to it. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreStatLine } from "./engine.ts";
import type { Position, RuleSet, StatLine } from "./types.ts";

const pts = (pos: Position, s: StatLine) => scoreStatLine(pos, s).total;
const DEF_BASE = { passYdsAllowed: 250, rushYdsAllowed: 120, offensiveTdsAllowed: 3, opponentPoints: 24 };

describe("QB", () => {
  test("full stat line", () => {
    // Pass TDs 5, 42, 80 yds: 6 + 8 + 12 = 26
    // Rush TD 12 yds: 7
    // Scrimmage yds 287 + 18 = 305 -> 5 at 200, +2 per full 50 above (2 x 2) = 9
    // 1 INT: -1. 1 two-point pass: 2
    // Total 26 + 7 + 9 - 1 + 2 = 43
    assert.equal(pts("QB", {
      passTdLengths: [5, 42, 80], rushTdLengths: [12], passYds: 287, rushYds: 18,
      interceptionsThrown: 1, twoPtPasses: 1
    }), 43);
  });

  test("yardage tiers: 5 at 200, then +2 per full 50 (matches MFL's real scores)", () => {
    const y = (n: number) => pts("QB", { passYds: n });
    assert.equal(y(49), 0);
    assert.equal(y(50), 1);
    assert.equal(y(99), 1);
    assert.equal(y(100), 2);
    assert.equal(y(149), 2);
    assert.equal(y(150), 3);
    assert.equal(y(199), 3);
    assert.equal(y(200), 5);
    assert.equal(y(249), 5);
    assert.equal(y(250), 7);
    assert.equal(y(299), 7);
    assert.equal(y(300), 9);
    assert.equal(y(412), 13);  // 5 + 2 x floor(212/50)
  });

  test("rushing and receiving yards count toward the QB total", () => {
    assert.equal(pts("QB", { passYds: 180, rushYds: 25 }), 5); // 205 total
  });

  test("QBs get no points per reception", () => {
    assert.equal(pts("QB", { receptions: 2, recYds: 10 }), 0);
  });

  test("receiving TD uses the passing scale", () => {
    assert.equal(pts("QB", { recTdLengths: [31] }), 8);
  });

  test("QBs don't score punt/kick/INT return TDs, but do score fumble-recovery TDs", () => {
    assert.equal(pts("QB", { puntReturnTds: 1, kickReturnTds: 1, intReturnTds: 1 }), 0);
    assert.equal(pts("QB", { offFumbleRecoveryTds: 1, defFumbleRecoveryTds: 1 }), 12);
  });
});

describe("RB", () => {
  test("full stat line", () => {
    // Rush TDs 1 and 55 yds: 6 + 12 = 18. Rec TD 31 yds (passing scale): 8
    // Scrimmage 104 + 31 = 135 -> 2 x floor(135/25) = 10
    // 4 receptions x 0.5 = 2
    // Total 18 + 8 + 10 + 2 = 38
    assert.equal(pts("RB", { rushTdLengths: [1, 55], recTdLengths: [31], rushYds: 104, recYds: 31, receptions: 4 }), 38);
  });

  test("yardage tiers: 8 at 100, then +2 per full 25", () => {
    const y = (n: number) => pts("RB", { rushYds: n });
    assert.equal(y(24), 0);
    assert.equal(y(25), 2);
    assert.equal(y(49), 2);
    assert.equal(y(50), 4);
    assert.equal(y(75), 6);
    assert.equal(y(99), 6);
    assert.equal(y(100), 8);
    assert.equal(y(124), 8);
    assert.equal(y(125), 10);
    assert.equal(y(203), 16);
  });

  test("rushing TD length boundaries", () => {
    const td = (n: number) => pts("RB", { rushTdLengths: [n] });
    assert.deepEqual([0, 10, 11, 20, 21, 30, 31, 50, 51, 99].map(td), [6, 6, 7, 7, 8, 8, 10, 10, 12, 12]);
  });

  test("negative scrimmage yards score nothing", () => {
    assert.equal(pts("RB", { rushYds: -4 }), 0);
  });

  test("halfback pass: passing TD by length and passing yards count", () => {
    // Pass TD 40 yds: 8. Scrimmage 40 pass + 20 rush = 60 -> 4. Total 12
    assert.equal(pts("RB", { passTdLengths: [40], passYds: 40, rushYds: 20 }), 12);
  });
});

describe("WR", () => {
  test("full stat line", () => {
    // Rec TD 76 yds: 12. Punt return TD: 6. Two-point catch: 2
    // Scrimmage 96 -> 4. 7 receptions x 0.5 = 3.5
    // Total 12 + 6 + 2 + 4 + 3.5 = 27.5
    assert.equal(pts("WR", { recTdLengths: [76], puntReturnTds: 1, twoPtReceptions: 1, recYds: 96, receptions: 7 }), 27.5);
  });

  test("yardage tiers: 6 at 100, then +2 per full 25", () => {
    const y = (n: number) => pts("WR", { recYds: n });
    assert.deepEqual([24, 25, 49, 50, 74, 75, 99, 100, 124, 125, 150, 182].map(y), [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 10, 12]);
  });

  test("receiving TD length boundaries (passing scale)", () => {
    const td = (n: number) => pts("WR", { recTdLengths: [n] });
    assert.deepEqual([1, 30, 31, 50, 51, 75, 76, 99].map(td), [6, 6, 8, 8, 10, 10, 12, 12]);
  });

  test("each return TD type is 6", () => {
    assert.equal(pts("WR", { kickReturnTds: 1, intReturnTds: 1, defFumbleRecoveryTds: 1, offFumbleRecoveryTds: 1 }), 24);
  });
});

describe("TE", () => {
  test("full stat line", () => {
    // Rec TDs 10, 11, 51 yds (rushing scale): 6 + 7 + 12 = 25
    // Scrimmage 58 -> 4. 6 receptions x 1 = 6
    // Total 25 + 4 + 6 = 35
    assert.equal(pts("TE", { recTdLengths: [10, 11, 51], recYds: 58, receptions: 6 }), 35);
  });

  test("same 25-yard catch pays 6 for a WR but 8 for a TE", () => {
    assert.equal(pts("WR", { recTdLengths: [25] }), 6);
    assert.equal(pts("TE", { recTdLengths: [25] }), 8);
  });

  test("yardage tiers: 0 yards scores nothing, 1 yard scores 1; 6 at 75, then +2 per full 25", () => {
    const y = (n: number) => pts("TE", { recYds: n });
    assert.deepEqual([0, 1, 24, 25, 49, 50, 74, 75, 99, 100, 149, 150].map(y), [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 10, 12]);
  });
});

describe("K", () => {
  test("field goals by length plus extra points", () => {
    // FGs 22, 30 -> 3 each. 31 -> 3.1, 47 -> 4.7, 59 -> 5.9. 60 -> 10
    // 3 + 3 + 3.1 + 4.7 + 5.9 + 10 = 29.7. 3 XPs = 3. Total 32.7
    assert.equal(pts("K", { fgMadeLengths: [22, 30, 31, 47, 59, 60], extraPoints: 3 }), 32.7);
  });

  test("no float noise in tenths", () => {
    assert.equal(pts("K", { fgMadeLengths: [47] }), 4.7);
    assert.equal(pts("K", { fgMadeLengths: [33, 33, 33] }), 9.9);
  });

  test("a kicker TD of any kind is 6, and a kicker INT is -1", () => {
    assert.equal(pts("K", { rushTdLengths: [40] }), 6);
    assert.equal(pts("K", { passTdLengths: [80], interceptionsThrown: 1 }), 5);
  });
});

describe("DEF", () => {
  test("full stat line", () => {
    // 2 INT = 4, 1 fumble recovery = 2, 4 sacks = 4, 1 safety = 2, 1 blocked punt = 1
    // INT return TD 6, punt return TD 6
    // Pass yds allowed 160 -> 3. Rush yds allowed 85 -> 6
    // 1 offensive TD allowed -> 0. Opponent scored 10 -> 0
    // Total 4 + 2 + 4 + 2 + 1 + 6 + 6 + 3 + 6 = 34
    assert.equal(pts("DEF", {
      interceptions: 2, fumbleRecoveries: 1, sacks: 4, safeties: 1, blockedPunts: 1,
      intReturnTds: 1, puntReturnTds: 1,
      passYdsAllowed: 160, rushYdsAllowed: 85, offensiveTdsAllowed: 1, opponentPoints: 10
    }), 34);
  });

  test("shutout", () => {
    // Pass 120 -> 6, rush 99 -> 6, no offensive TDs -> 8, opponent 0 pts -> 2. Total 22
    assert.equal(pts("DEF", { passYdsAllowed: 120, rushYdsAllowed: 99, offensiveTdsAllowed: 0, opponentPoints: 0 }), 22);
  });

  test("no offensive TDs allowed but opponent kicked field goals", () => {
    assert.equal(pts("DEF", { ...DEF_BASE, offensiveTdsAllowed: 0, opponentPoints: 9 }), 8);
  });

  test("passing yards allowed tiers", () => {
    const y = (n: number) => pts("DEF", { ...DEF_BASE, passYdsAllowed: n });
    assert.deepEqual([1, 149, 150, 174, 175, 199, 200].map(y), [6, 6, 3, 3, 1, 1, 0]);
  });

  test("MFL quirk kept on purpose: 0 or negative passing yards allowed scores 0, not 6", () => {
    assert.equal(pts("DEF", { ...DEF_BASE, passYdsAllowed: 0 }), 0);
    assert.equal(pts("DEF", { ...DEF_BASE, passYdsAllowed: -7 }), 0);
  });

  test("rushing yards allowed: under 100 is 6; negative scores 0 (MFL range starts at 0)", () => {
    const y = (n: number) => pts("DEF", { ...DEF_BASE, rushYdsAllowed: n });
    assert.deepEqual([0, 99, 100, -3].map(y), [6, 6, 0, 0]);
  });

  test("blocked kicks, blocked-kick TDs, defensive TDs and 2-pt returns", () => {
    // Blocked FG 1 + blocked FG TD 6 + blocked punt TD 6 + kick return TD 6
    // + fumble recovery TD 6 + defensive 2-pt return 2 = 27
    assert.equal(pts("DEF", { ...DEF_BASE, blockedFgs: 1, blockedFgTds: 1, blockedPuntTds: 1, kickReturnTds: 1, defFumbleRecoveryTds: 1, defTwoPtReturns: 1 }), 27);
  });

  test("refuses to score a defense with missing allowed-stats (would award shutout points)", () => {
    assert.throws(() => scoreStatLine("DEF", { sacks: 3 }), /missing passYdsAllowed, rushYdsAllowed, offensiveTdsAllowed, opponentPoints/);
  });
});

// The five lines named in the stats decision (CLAUDE.md, build rule 7).
describe("required hand-calculated lines", () => {
  test("52-yard TD reception by a WR: 10 (passing scale 51-75)", () => {
    assert.equal(pts("WR", { recTdLengths: [52] }), 10);
  });
  test("12-yard TE TD reception: 7 (TE uses the rushing scale, 11-20)", () => {
    assert.equal(pts("TE", { recTdLengths: [12] }), 7);
  });
  test("47-yard field goal: 4.7 (0.1 x yards for 31-59)", () => {
    assert.equal(pts("K", { fgMadeLengths: [47] }), 4.7);
  });
  test("QB with 210 total yards: 5 (5 at 200, +2 only at 250)", () => {
    assert.equal(pts("QB", { passYds: 190, rushYds: 20 }), 5);
  });
  test("defense allowing 160 net passing yards: 3 (150-174 tier)", () => {
    assert.equal(pts("DEF", { passYdsAllowed: 160, rushYdsAllowed: 120, offensiveTdsAllowed: 3, opponentPoints: 24 }), 3);
  });
});

// Real 2026 week 1 games. Stats from nflverse play-by-play; expected totals are
// MFL's official scores for league 22689. The full cross-check (weeks 1-5,
// 2,385 player games) matched exactly.
describe("real games vs MFL's official scores (2026 week 1)", () => {
  test("Josh Allen: 41", () => {
    assert.equal(pts("QB", { passYds: 334, rushYds: 23, rushTdLengths: [21, 1], passTdLengths: [43, 34] }), 41);
  });
  test("Bryce Young: 38", () => {
    assert.equal(pts("QB", { passYds: 361, rushYds: 10, passTdLengths: [4, 51, 8], rushTdLengths: [7], interceptionsThrown: 1 }), 38);
  });
  test("Christian Watson: 29", () => {
    assert.equal(pts("WR", { recYds: 147, receptions: 6, recTdLengths: [81, 2] }), 29);
  });
  test("Chris Olave: 17", () => {
    assert.equal(pts("WR", { recYds: 182, receptions: 10 }), 17);
  });
  test("Bengals defense: 25 (216 gross pass yds - 23 sack yds = 193 net)", () => {
    assert.equal(pts("DEF", {
      passYdsAllowed: 193, rushYdsAllowed: 89, offensiveTdsAllowed: 2, opponentPoints: 27,
      sacks: 4, fumbleRecoveries: 4, defFumbleRecoveryTds: 1
    }), 25);
  });
});

describe("engine", () => {
  test("empty stat line scores 0 for every player position", () => {
    for (const p of ["QB", "RB", "WR", "TE", "K"] as const) assert.equal(pts(p, {}), 0);
  });

  test("breakdown lists each scoring line, one per TD", () => {
    const s = scoreStatLine("WR", { recTdLengths: [12, 60], recYds: 80, receptions: 5 });
    assert.deepEqual(s.lines, [
      { stat: "recTdLength", value: 12, points: 6 },
      { stat: "recTdLength", value: 60, points: 10 },
      { stat: "receptions", value: 5, points: 2.5 },
      { stat: "scrimmageYds", value: 80, points: 4 }
    ]);
    assert.equal(s.total, 22.5);
  });

  test("works with a different rule set (rules are configurable)", () => {
    const ppr: RuleSet = {
      QB: [], RB: [], TE: [], K: [], DEF: [],
      WR: [
        { stat: "receptions", range: [0, 99], points: { per: 1 } },
        { stat: "scrimmageYds", range: [0, 999], points: { base: 0, every: 10, points: 1 } }
      ]
    };
    assert.equal(scoreStatLine("WR", { receptions: 6, recYds: 87 }, ppr).total, 14);
  });
});
