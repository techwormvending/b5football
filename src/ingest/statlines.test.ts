import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gameStatLines } from "./statlines.ts";
import { scoreStatLine } from "../scoring/engine.ts";
import type { GameData, PlayerRef } from "./types.ts";

const P = (id: string, team: string): PlayerRef => ({ provider: "t", id, name: id, team });
const qb = P("qb", "PHI"), wr = P("wr", "PHI"), rb = P("rb", "PHI"), k = P("k", "PHI"), te = P("te", "DAL"), ret = P("ret", "DAL");

function game(over: Partial<GameData>): GameData {
  return {
    provider: "t", gameId: "g", season: 2026, week: 1, home: "PHI", away: "DAL",
    homeScore: 0, awayScore: 0, status: "final", players: [],
    teams: { PHI: { netPassYds: 250, rushYds: 120 }, DAL: { netPassYds: 180, rushYds: 90 } },
    events: [], warnings: [], ...over
  };
}

describe("gameStatLines", () => {
  test("box scores and offensive TDs land on the right players", () => {
    const s = gameStatLines(game({
      players: [{ player: qb, passYds: 300, interceptionsThrown: 1 }, { player: wr, recYds: 110, receptions: 7 }],
      events: [
        { kind: "td", td: "pass", team: "PHI", length: 45, passer: qb, scorer: wr },
        { kind: "td", td: "rush", team: "PHI", length: 3, scorer: rb }
      ]
    }));
    assert.deepEqual(s.players.get("t:qb")!.stats, { passYds: 300, interceptionsThrown: 1, passTdLengths: [45] });
    assert.deepEqual(s.players.get("t:wr")!.stats, { recYds: 110, receptions: 7, recTdLengths: [45] });
    assert.deepEqual(s.players.get("t:rb")!.stats, { rushTdLengths: [3] });
    // Both TDs count against DAL's defense
    assert.equal(s.defenses.get("DAL")!.offensiveTdsAllowed, 2);
    assert.equal(s.defenses.get("PHI")!.offensiveTdsAllowed, 0);
  });

  test("yards allowed come from the opponent's offense; scores give points allowed", () => {
    const s = gameStatLines(game({ homeScore: 27, awayScore: 10 }));
    assert.deepEqual(s.defenses.get("PHI"), { opponentPoints: 10, offensiveTdsAllowed: 0, passYdsAllowed: 180, rushYdsAllowed: 90 });
    assert.deepEqual(s.defenses.get("DAL"), { opponentPoints: 27, offensiveTdsAllowed: 0, passYdsAllowed: 250, rushYdsAllowed: 120 });
  });

  test("unknown yards allowed stay undefined so the engine refuses to score (no free shutout points)", () => {
    const s = gameStatLines(game({ teams: { PHI: {}, DAL: {} } }));
    assert.throws(() => scoreStatLine("DEF", s.defenses.get("PHI")!), /missing passYdsAllowed, rushYdsAllowed/);
  });

  test("special-teams and defensive TDs credit the scoring team's defense and the returner", () => {
    const s = gameStatLines(game({
      events: [
        { kind: "td", td: "kickReturn", team: "DAL", length: 98, scorer: ret },
        { kind: "td", td: "puntReturn", team: "DAL", length: 70, scorer: ret },
        { kind: "td", td: "intReturn", team: "DAL", length: 40 },
        { kind: "td", td: "defFumbleReturn", team: "DAL", length: 20 },
        { kind: "td", td: "blockedFgReturn", team: "DAL", length: 61 },
        { kind: "td", td: "blockedPuntReturn", team: "DAL", length: 35 },
        { kind: "td", td: "otherDefST", team: "DAL", length: 0 }
      ]
    }));
    const d = s.defenses.get("DAL")!;
    assert.equal(d.kickReturnTds, 1);
    assert.equal(d.puntReturnTds, 1);
    assert.equal(d.intReturnTds, 1);
    assert.equal(d.defFumbleRecoveryTds, 2);   // fumble return + other (e.g. kicking team recovers kickoff in end zone)
    assert.equal(d.blockedFgTds, 1);
    assert.equal(d.blockedPuntTds, 1);
    assert.equal(d.offensiveTdsAllowed, 0);
    assert.equal(s.defenses.get("PHI")!.offensiveTdsAllowed, 0, "return TDs are not offensive TDs allowed");
    assert.deepEqual(s.players.get("t:ret")!.stats, { kickReturnTds: 1, puntReturnTds: 1 });
  });

  test("own-fumble recovery TD credits the player but not the team defense", () => {
    const s = gameStatLines(game({ events: [{ kind: "td", td: "offFumbleRecovery", team: "PHI", length: 0, scorer: wr }] }));
    assert.deepEqual(s.players.get("t:wr")!.stats, { offFumbleRecoveryTds: 1 });
    assert.equal(s.defenses.get("PHI")!.defFumbleRecoveryTds, undefined);
    assert.equal(s.defenses.get("DAL")!.offensiveTdsAllowed, 0);
  });

  test("kicking, two-point, defensive two-point and safety events", () => {
    const s = gameStatLines(game({
      teams: { PHI: { netPassYds: 1, rushYds: 1, sacks: 4, blockedPunts: 1 }, DAL: { netPassYds: 1, rushYds: 1 } },
      events: [
        { kind: "fg", team: "PHI", distance: 47, kicker: k },
        { kind: "fg", team: "PHI", distance: 22, kicker: k },
        { kind: "xp", team: "PHI", kicker: k },
        { kind: "twoPt", team: "PHI", method: "pass", passer: qb, receiver: wr },
        { kind: "twoPt", team: "DAL", method: "rush", rusher: te },
        { kind: "defTwoPt", team: "PHI" },
        { kind: "safety", team: "PHI" }
      ]
    }));
    assert.deepEqual(s.players.get("t:k")!.stats, { fgMadeLengths: [47, 22], extraPoints: 1 });
    assert.equal(s.players.get("t:qb")!.stats.twoPtPasses, 1);
    assert.equal(s.players.get("t:wr")!.stats.twoPtReceptions, 1);
    assert.equal(s.players.get("t:te")!.stats.twoPtRushes, 1);
    const d = s.defenses.get("PHI")!;
    assert.equal(d.defTwoPtReturns, 1);
    assert.equal(d.safeties, 1);
    assert.equal(d.sacks, 4);
    assert.equal(d.blockedPunts, 1);
  });

  test("end to end: a DEF line built from GameData scores like MFL", () => {
    // DAL defense: 3 sacks (3) + 1 INT (2) + kick return TD (6); PHI net pass 160 -> 3; rush 85 -> 6;
    // 1 offensive TD allowed (0); PHI scored 10 (0). Total 20.
    const s = gameStatLines(game({
      homeScore: 10, awayScore: 17,
      teams: { PHI: { netPassYds: 160, rushYds: 85 }, DAL: { netPassYds: 200, rushYds: 100, sacks: 3, interceptions: 1 } },
      events: [{ kind: "td", td: "pass", team: "PHI", length: 12 }, { kind: "td", td: "kickReturn", team: "DAL", length: 100 }]
    }));
    assert.equal(scoreStatLine("DEF", s.defenses.get("DAL")!).total, 20);
  });
});
