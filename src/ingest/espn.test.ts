/* ESPN adapter tests. Fixtures copy the real shapes and quirks seen in 2026
   weeks 1-5 (summary + core plays), trimmed to the fields the adapter reads. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gameFromEspn, espnLiveSource, type EspnPlay, type EspnSummary } from "./espn.ts";
import { gameStatLines } from "./statlines.ts";
import type { Http } from "./http.ts";

// DET (away, team id 8) at ARI (home, team id 22)
const ath = (id: number) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/${id}?lang=en` });
const P = (...ps: [string, number][]) => ps.map(([type, id]) => ({ type, athlete: ath(id) }));
const QB_D = 1, WR_D = 2, RB_D = 3, K_D = 4, DB_D = 5, TE_D = 6, QB_A = 11, WR_A = 12, K_A = 14, LB_A = 15, P_A = 16, RET_D = 7;

function summary(scoring: EspnSummary["scoringPlays"], state = "post"): EspnSummary {
  const ath2 = (id: number, name: string, stats: string[]) => ({ athlete: { id: String(id), displayName: name }, stats });
  return {
    header: { week: 5, season: { year: 2026 }, competitions: [{ id: "401", status: { type: { state } }, competitors: [
      { homeAway: "home", score: "21", team: { id: "22", abbreviation: "ARI" } },
      { homeAway: "away", score: "45", team: { id: "8", abbreviation: "DET" } }
    ] }] },
    boxscore: {
      players: [
        { team: { abbreviation: "DET" }, statistics: [
          { name: "passing", keys: ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt", "passingTouchdowns", "interceptions"], athletes: [ath2(QB_D, "Jared Goff", ["19/30", "271", "9.0", "3", "1"])] },
          { name: "rushing", keys: ["rushingAttempts", "rushingYards"], athletes: [ath2(RB_D, "Jahmyr Gibbs", ["25", "151"]), ath2(QB_D, "Jared Goff", ["2", "-1"])] },
          { name: "receiving", keys: ["receptions", "receivingYards"], athletes: [ath2(WR_D, "Jameson Williams", ["4", "88"]), ath2(TE_D, "Sam LaPorta", ["5", "60"])] },
          { name: "defensive", keys: ["totalTackles"], athletes: [ath2(DB_D, "Brian Branch", ["6"])] },
          { name: "kickReturns", keys: ["kickReturns"], athletes: [ath2(RET_D, "Jacob Saylors", ["3"])] },
          { name: "kicking", keys: ["fieldGoalsMade/fieldGoalAttempts", "fieldGoalPct", "longFieldGoalMade", "extraPointsMade/extraPointAttempts"], athletes: [ath2(K_D, "Jake Bates", ["1/1", "100.0", "46", "5/6"])] }
        ] },
        { team: { abbreviation: "ARI" }, statistics: [
          { name: "passing", keys: ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt", "passingTouchdowns", "interceptions"], athletes: [ath2(QB_A, "Jacoby Brissett", ["25/40", "250", "6.3", "1", "2"])] },
          { name: "receiving", keys: ["receptions", "receivingYards"], athletes: [ath2(WR_A, "Trey McBride", ["8", "90"])] },
          { name: "defensive", keys: ["totalTackles"], athletes: [ath2(LB_A, "Mack Wilson", ["9"])] },
          { name: "punting", keys: ["punts"], athletes: [ath2(P_A, "Blake Gillikin", ["4"])] },
          { name: "kicking", keys: ["fieldGoalsMade/fieldGoalAttempts", "fieldGoalPct", "longFieldGoalMade", "extraPointsMade/extraPointAttempts"], athletes: [ath2(K_A, "Chad Ryland", ["0/0", "0", "0", "2/2"])] }
        ] }
      ],
      teams: [
        { team: { abbreviation: "DET" }, statistics: [{ name: "netPassingYards", displayValue: "249" }, { name: "rushingYards", displayValue: "163" }, { name: "sacksYardsLost", displayValue: "3-22" }, { name: "interceptions", displayValue: "1" }] },
        { team: { abbreviation: "ARI" }, statistics: [{ name: "netPassingYards", displayValue: "231" }, { name: "rushingYards", displayValue: "90" }, { name: "sacksYardsLost", displayValue: "4-19" }, { name: "interceptions", displayValue: "2" }] }
      ]
    },
    scoringPlays: scoring
  };
}
let seq = 0;
const play = (p: Partial<EspnPlay>): EspnPlay => ({ id: String(++seq), sequenceNumber: String(seq * 100), ...p });

describe("gameFromEspn: box score and team stats", () => {
  const g = gameFromEspn(summary([]), []);
  const lines = gameStatLines(g);
  test("header", () => {
    assert.equal(g.home, "ARI"); assert.equal(g.away, "DET"); assert.equal(g.status, "final");
    assert.equal(g.homeScore, 21); assert.equal(g.awayScore, 45); assert.equal(g.gameId, "401");
  });
  test("player box: passing yards, INTs, rushing across categories, receiving, XPs from kicking", () => {
    assert.deepEqual(lines.players.get(`espn:${QB_D}`)!.stats, { passYds: 271, rushYds: -1, interceptionsThrown: 1 });
    assert.deepEqual(lines.players.get(`espn:${WR_D}`)!.stats, { recYds: 88, receptions: 4 });
    assert.deepEqual(lines.players.get(`espn:${K_D}`)!.stats, { extraPoints: 5 });
  });
  test("defense: sacks / INTs from the opponent's team stats, yards allowed from the opponent's offense", () => {
    const det = lines.defenses.get("DET")!;
    assert.equal(det.sacks, 4); assert.equal(det.interceptions, 2);
    assert.equal(det.passYdsAllowed, 231); assert.equal(det.rushYdsAllowed, 90);
    assert.equal(det.opponentPoints, 21);
  });
  test("missing header throws a shape error", () => {
    assert.throws(() => gameFromEspn({}, []), /summary header missing/);
  });
});

describe("gameFromEspn: scoring", () => {
  // Core plays carry a running score that can lag; give them deliberately wrong scores to prove they're ignored.
  const pass = play({ type: { text: "Passing Touchdown" }, statYardage: 38, scoreValue: 6, homeScore: 0, awayScore: 0, participants: P(["passer", QB_D], ["receiver", TE_D], ["scorer", TE_D], ["kicker", K_D], ["patScorer", K_D]), pointAfterAttempt: { text: "Extra Point Good", value: 1 } });
  const bobbled = play({ type: { text: "Fumble Recovery (Own)" }, statYardage: 13, scoreValue: 6, participants: P(["passer", QB_D], ["receiver", WR_D], ["recoverer", WR_D], ["scorer", WR_D], ["patScorer", K_D]) });
  const rush2 = play({ type: { text: "Rushing Touchdown" }, statYardage: 3, scoreValue: 6, participants: P(["rusher", RB_D], ["scorer", RB_D], ["patPasser", QB_D], ["patScorer", WR_D]), pointAfterAttempt: { text: "Two Point Pass", value: 2 } });
  const fg = play({ type: { text: "Field Goal Good" }, statYardage: 46, scoreValue: 3, text: "J.Bates 46 yard field goal is GOOD", participants: P(["kicker", K_D], ["scorer", K_D]) });
  const pick6 = play({ type: { text: "Interception Return Touchdown" }, statYardage: 38, scoreValue: 6, participants: P(["passer", QB_A], ["returner", DB_D], ["scorer", DB_D]), pointAfterAttempt: { text: "Two Point Rush", value: 0 } });
  const koRet = play({ type: { text: "Kickoff Return Touchdown" }, statYardage: 99, scoreValue: 6, participants: P(["kicker", K_A], ["returner", RET_D], ["scorer", RET_D]) });
  const safety = play({ type: { text: "Safety" }, scoreValue: 2, text: "J.Brissett sacked in End Zone, SAFETY", participants: P(["passer", QB_A]) });
  const intBack = play({ type: { text: "Interception Return Touchdown" }, statYardage: 0, scoreValue: 6, participants: P(["passer", QB_A], ["recoverer", WR_A], ["scorer", WR_A]) });
  const blockedPuntTd = play({ type: { text: "Blocked Punt Touchdown" }, statYardage: 5, scoreValue: 6, text: "B.Gillikin punt is BLOCKED by B.Branch, RECOVERED by DET-B.Branch at ARI 5. TOUCHDOWN", participants: P(["punter", P_A], ["blocker", DB_D], ["scorer", DB_D]) });

  const sp = (id: string | undefined, team: string, away: number, home: number, type: string, text = "") => ({ id, team: { abbreviation: team }, awayScore: away, homeScore: home, type: { text: type }, text });
  const scoring = [
    sp(pass.id, "DET", 7, 0, "Passing Touchdown"),
    sp(bobbled.id, "DET", 14, 0, "Fumble Recovery (Own)", "Jameson Williams 13 Yd pass from Jared Goff (Jake Bates Kick)"),
    sp(rush2.id, "DET", 22, 0, "Rushing Touchdown"),
    sp(fg.id, "DET", 25, 0, "Field Goal Good"),
    sp(pick6.id, "DET", 31, 0, "Interception Return Touchdown"),
    sp(koRet.id, "DET", 38, 0, "Kickoff Return Touchdown"),
    sp(safety.id, "DET", 40, 0, "Safety"),
    sp(intBack.id, "ARI", 40, 7, "Interception Return Touchdown"),
    sp(blockedPuntTd.id, "DET", 47, 7, "Blocked Punt Touchdown"),
    sp("999", "ARI", 49, 14, "Passing Touchdown", "X 5 Yd pass from Y (Z Kick)")   // + DET def 2-pt return (DET +2 on same entry)
  ];
  const g = gameFromEspn(summary(scoring), [pass, bobbled, rush2, fg, pick6, koRet, safety, intBack, blockedPuntTd]);
  const lines = gameStatLines(g);
  const st = (id: number) => lines.players.get(`espn:${id}`)!.stats;
  const det = lines.defenses.get("DET")!, ari = lines.defenses.get("ARI")!;

  test("passing TD by participants, length = statYardage", () => {
    assert.deepEqual(st(TE_D).recTdLengths, [38]);
    assert.deepEqual(st(QB_D).passTdLengths, [38, 13]);
  });
  test("a TD pass ESPN labels 'Fumble Recovery (Own)' is still a passing TD when passer + receiver = scorer", () => {
    assert.deepEqual(st(WR_D).recTdLengths, [13]);
    assert.equal(st(WR_D).offFumbleRecoveryTds, undefined);
  });
  test("rushing TD with a successful two-point pass (patPasser / patScorer)", () => {
    assert.deepEqual(st(RB_D).rushTdLengths, [3]);
    assert.equal(st(QB_D).twoPtPasses, 1);
    assert.equal(st(WR_D).twoPtReceptions, 1);
  });
  test("failed two-point attempt (value 0) scores nothing", () => {
    assert.equal(lines.players.get(`espn:${QB_A}`)?.stats.twoPtRushes, undefined);
  });
  test("field goal distance", () => assert.deepEqual(st(K_D).fgMadeLengths, [46]));
  test("pick-six, kick return TD, safety, blocked punt TD credit DET's defense; none are offensive TDs allowed", () => {
    assert.equal(det.intReturnTds, 1);
    assert.equal(det.kickReturnTds, 1);
    assert.equal(st(RET_D).kickReturnTds, 1);
    assert.equal(det.safeties, 1);
    assert.equal(det.blockedPuntTds, 1);
    assert.equal(det.blockedPunts, 1);
    assert.equal(ari.offensiveTdsAllowed, 3, "pass, bobbled pass, rush");
  });
  test("INT fumbled back and returned by the passing team = own-fumble recovery TD, no defensive credit", () => {
    assert.equal(st(WR_A).offFumbleRecoveryTds, 1);
    assert.equal(ari.intReturnTds, undefined);
  });
  test("defensive two-point return: the other team also scored 2 on the same scoring entry", () => {
    assert.equal(det.defTwoPtReturns, 1);
  });
  test("a scoring entry missing from core plays is reported, not dropped silently", () => {
    assert.ok(g.warnings.some(w => w.startsWith("scoring play 999 not in core plays")), g.warnings.join("\n"));
  });
});

describe("gameFromEspn: fumbles and blocked kicks", () => {
  const plays = [
    play({ type: { text: "Fumble Recovery (Opponent)" }, text: "J.Goff pass to S.LaPorta for 7 yards. FUMBLES (M.Wilson), RECOVERED by ARI-M.Wilson at DET 42.", participants: P(["passer", QB_D], ["fumbler", TE_D], ["recoverer", LB_A]) }),
    play({ type: { text: "Fumble Recovery (Own)" }, text: "J.Goff FUMBLES (Aborted) at DET 31, recovered by DET-J.Williams at DET 25.", participants: P(["rusher", QB_D], ["recoverer", WR_D]) }),
    play({ type: { text: "Muffed Punt Recovery (Opponent)" }, text: "B.Gillikin punts 48 yards to DET 22. J.Saylors MUFFS catch, RECOVERED by ARI-M.Wilson at DET 28.", participants: P(["punter", P_A], ["recoverer", LB_A]) }),
    // Short-summary text with no "RECOVERED by": fall back to type + recoverer's team
    play({ type: { text: "Fumble Recovery (Opponent)" }, text: "Jacoby Brissett Pass Complete for 21 Yds to Trey McBride Trey McBride Fumble Brian Branch 0 Yd Fumble Recovery", participants: P(["passer", QB_A], ["fumbler", WR_A], ["recoverer", DB_D]) }),
    // Nullified by penalty: ignored
    play({ type: { text: "Fumble Recovery (Opponent)" }, isPenalty: true, text: "J.Gibbs FUMBLES, RECOVERED by ARI-M.Wilson. PENALTY on ARI, Offside, 5 yards - No Play.", participants: P(["rusher", RB_D]) }),
    // Replay reversal: only the text after REVERSED counts (no fumble in the final ruling)
    play({ type: { text: "Rush" }, text: "J.Gibbs FUMBLES, RECOVERED by ARI-M.Wilson. The Replay Official reviewed the fumble ruling, and the play was REVERSED. J.Gibbs left end for 4 yards.", participants: P(["rusher", RB_D]) }),
    play({ type: { text: "Blocked Field Goal" }, text: "C.Ryland 44 yard field goal is BLOCKED (B.Branch), recovered by ARI-C.Ryland.", participants: P(["kicker", K_A], ["blocker", DB_D]) }),
    play({ type: { text: "Blocked Punt" }, text: "B.Gillikin punt is BLOCKED by B.Branch, recovered by ARI-B.Gillikin.", participants: P(["punter", P_A], ["blocker", DB_D]) }),
    play({ type: { text: "Passing Touchdown" }, text: "J.Goff pass to S.LaPorta for 2 yards, TOUCHDOWN. J.Bates extra point is Blocked (M.Wilson).", participants: P(["passer", QB_D]) })
  ];
  const g = gameFromEspn(summary([]), plays);
  test("opponent recoveries count (incl. muffed punts and the short-text fallback); own, nullified and reversed don't", () => {
    assert.equal(g.teams.ARI!.fumbleRecoveries, 2);
    assert.equal(g.teams.DET!.fumbleRecoveries, 1);
  });
  test("blocked FG and punt credit the team that didn't kick; a blocked PAT doesn't count", () => {
    assert.equal(g.teams.DET!.blockedFgs, 1);
    assert.equal(g.teams.DET!.blockedPunts, 1);
    assert.equal(g.teams.ARI!.blockedFgs, undefined);
    assert.deepEqual(g.warnings, []);
  });
});

// Quirks found running the full 2025 season against nflverse (each was a real mismatch).
describe("gameFromEspn: ESPN quirks from 2025", () => {
  const sp = (id: string | undefined, team: string, away: number, home: number, type: string, text = "") => ({ id, team: { abbreviation: team }, awayScore: away, homeScore: home, type: { text: type }, text });

  test("two-point 'value: 2' on a FAILED try is not a conversion; the defense's 'ATTEMPT SUCCEEDS' isn't the offense's", () => {
    const failed = play({ type: { text: "Rushing Touchdown" }, statYardage: 2, text: "R.White right guard for 2 yards, TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. B.Mayfield pass is incomplete. ATTEMPT FAILS.", participants: P(["rusher", RB_D], ["scorer", RB_D], ["patPasser", QB_D], ["patScorer", WR_D]), pointAfterAttempt: { text: "Two Point Pass", value: 2 } });
    const defRet = play({ type: { text: "Passing Touchdown" }, statYardage: 15, text: "J.Goff pass short right to J.Williams for 15 yards, TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. J.Goff pass to J.Williams is intercepted. ATTEMPT FAILS. DEFENSIVE TWO-POINT ATTEMPT. M.Wilson intercepted the try attempt. ATTEMPT SUCCEEDS.", participants: P(["passer", QB_D], ["receiver", WR_D], ["scorer", WR_D], ["patPasser", QB_D], ["patScorer", WR_D]), pointAfterAttempt: { text: "Two Point Pass", value: 0 } });
    const g = gameFromEspn(summary([sp(failed.id, "DET", 6, 0, "Rushing Touchdown"), sp(defRet.id, "DET", 12, 2, "Passing Touchdown")]), [failed, defRet]);
    const l = gameStatLines(g);
    assert.equal(l.players.get(`espn:${QB_D}`)!.stats.twoPtPasses, undefined);
    assert.equal(l.players.get(`espn:${WR_D}`)!.stats.twoPtReceptions, undefined);
    assert.equal(l.defenses.get("ARI")!.defTwoPtReturns, 1);
  });

  test("a 'scorer' from the other team is ignored (ESPN named the blocked kicker); blocked-kick TD credits the scoring team", () => {
    // DET's FG blocked and returned for an ARI TD; ESPN lists DET's kicker as "kicker" AND "scorer".
    const bfg = play({ type: { text: "Blocked Field Goal" }, statYardage: 61, text: "J.Bates 44 yard field goal is BLOCKED (M.Wilson), RECOVERED by ARI-M.Wilson at ARI 39. M.Wilson for 61 yards, TOUCHDOWN.", participants: P(["kicker", K_D], ["scorer", K_D], ["other", LB_A]) });
    // ARI punt blocked and returned by DET; the listed "kicker" is DET's PAT kicker.
    const bpunt = play({ type: { text: "Blocked Punt Touchdown" }, statYardage: 35, text: "B.Gillikin punt is BLOCKED by B.Branch, RECOVERED by DET-B.Branch at ARI 35. B.Branch for 35 yards, TOUCHDOWN. J.Bates extra point is GOOD.", participants: P(["punter", P_A], ["blocker", DB_D], ["kicker", K_D], ["patScorer", K_D], ["scorer", DB_D]) });
    const g = gameFromEspn(summary([sp(bfg.id, "ARI", 0, 6, "Blocked Field Goal"), sp(bpunt.id, "DET", 7, 6, "Blocked Punt Touchdown")]), [bfg, bpunt]);
    const l = gameStatLines(g);
    assert.equal(l.players.get(`espn:${K_D}`)!.stats.defFumbleRecoveryTds, undefined, "the blocked kicker gets no TD");
    assert.equal(l.defenses.get("ARI")!.blockedFgs, 1);
    assert.equal(l.defenses.get("ARI")!.blockedFgTds, 1);
    assert.equal(l.defenses.get("DET")!.blockedPunts, 1);
    assert.equal(l.defenses.get("DET")!.blockedPuntTds, 1);
    assert.equal(l.defenses.get("DET")!.blockedFgs, undefined);
  });

  test("short-summary blocked kick counts by play type; a missed FG mislabelled 'Blocked Field Goal' doesn't", () => {
    const short = play({ type: { text: "Blocked Field Goal Touchdown" }, text: "Blocked Kick Recovered by Mack Wilson (ARI) Mack Wilson 76 Yd Touchdown Return", participants: P(["kicker", K_D]) });
    const missed = play({ type: { text: "Blocked Field Goal" }, text: "C.Ryland 67 yard field goal is No Good, Center-W.Wagner, Holder-B.Gillikin. J.Saylors at DET -5 to DET 32 for 37 yards.", participants: P(["kicker", K_A]) });
    const g = gameFromEspn(summary([]), [short, missed]);
    assert.equal(g.teams.ARI!.blockedFgs, 1);
    assert.equal(g.teams.DET!.blockedFgs, undefined);
  });

  test("fumble recoveries: label beats garbled roles; official lowercase text beats a wrong label", () => {
    const sackOpp = play({ type: { text: "Sack Opp Fumble Recovery" }, text: "Mack Wilson 3 Yd Fumble Return (Chad Ryland Kick)", participants: P(["passer", QB_D], ["sackedBy", LB_A], ["fumbler", LB_A], ["recoverer", LB_A], ["scorer", LB_A]) });
    const ownTd = play({ type: { text: "Fumble Return Touchdown" }, text: "J.Goff FUMBLES (Aborted) at ARI 2, recovered by DET-J.Gibbs at ARI 7. J.Gibbs for 7 yards, TOUCHDOWN.", participants: P(["rusher", QB_D], ["recoverer", RB_D], ["scorer", RB_D]) });
    const safety = play({ type: { text: "Safety" }, text: "Team Safety", participants: P(["passer", QB_A], ["fumbler", DB_D], ["recoverer", QB_A]) });
    const intFumble = play({ type: { text: "Fumble Return Touchdown" }, text: "Trey McBride 0 Yd Fumble Recovery (Chad Ryland Kick)", participants: P(["passer", QB_A], ["fumbler", DB_D], ["recoverer", WR_A], ["scorer", WR_A]) });
    const g = gameFromEspn(summary([]), [sackOpp, ownTd, safety, intFumble]);
    assert.equal(g.teams.ARI!.fumbleRecoveries, 2, "sack-fumble return (label) + INT fumbled back to ARI (roles disagree on team)");
    assert.equal(g.teams.DET!.fumbleRecoveries, undefined, "own-fumble TD and the garbled safety don't count");
  });

  test("missing scorer role: take the player the summary names, only from this play's participants on the scoring team", () => {
    const ko = play({ type: { text: "Fumble Return Touchdown" }, text: "Jacob Saylors Recovered Kickoff in End Zone for a Touchdown (Jake Bates Kick)", participants: P(["kicker", K_D], ["patScorer", K_D], ["other", LB_A], ["other", RET_D]) });
    const g = gameFromEspn(summary([sp(ko.id, "DET", 7, 0, "Fumble Return Touchdown", "Jacob Saylors Recovered Kickoff in End Zone for a Touchdown (Jake Bates Kick)")]), [ko]);
    assert.equal(gameStatLines(g).players.get(`espn:${RET_D}`)!.stats.defFumbleRecoveryTds, 1);
    assert.deepEqual(g.warnings, []);
  });
});

describe("espnLiveSource", () => {
  const scoreboard = (state: string) => ({ events: [
    { id: "401", competitions: [{ status: { type: { state } }, competitors: [{ homeAway: "home", team: { abbreviation: "ARI" } }, { homeAway: "away", team: { abbreviation: "DET" } }] }] },
    { id: "402", competitions: [{ status: { type: { state: "pre" } }, competitors: [{ homeAway: "home", team: { abbreviation: "GB" } }, { homeAway: "away", team: { abbreviation: "CHI" } }] }] }
  ] });
  function fakeHttp(routes: (url: string, cache: boolean) => unknown): Http & { calls: { url: string; cache: boolean }[] } {
    const calls: { url: string; cache: boolean }[] = [];
    return { calls, async get<T>(url: string, o?: { cache?: boolean }) { calls.push({ url, cache: !!o?.cache }); return routes(url, !!o?.cache) as T; } };
  }

  test("live game re-fetched (not cached); scheduled game makes no detail requests", async () => {
    const http = fakeHttp(url => url.includes("scoreboard") ? scoreboard("in") : url.includes("summary") ? summary([], "in") : { items: [], pageCount: 1 });
    const w = await espnLiveSource({ http }).week(2026, 5);
    assert.equal(w.delayed, false);
    assert.deepEqual(w.games.map(g => [g.gameId, g.status]), [["401", "in_progress"], ["402", "scheduled"]]);
    assert.ok(http.calls.every(c => !c.url.includes("402")));
    assert.ok(http.calls.filter(c => c.url.includes("401")).every(c => c.cache === false));
  });

  test("final games are cached", async () => {
    const http = fakeHttp(url => url.includes("scoreboard") ? scoreboard("post") : url.includes("summary") ? summary([]) : { items: [], pageCount: 1 });
    await espnLiveSource({ http }).week(2026, 5);
    assert.ok(http.calls.filter(c => c.url.includes("401")).every(c => c.cache === true));
  });

  test("ESPN failure or shape change: keep last good numbers, report delayed, never throw", async () => {
    let mode: "ok" | "badGame" | "down" | "shape" = "ok";
    const http = fakeHttp(url => {
      if (url.includes("scoreboard")) { if (mode === "down") throw new Error("HTTP 503"); return scoreboard("in"); }
      if (url.includes("summary")) { if (mode === "badGame") throw new Error("HTTP 500"); return mode === "shape" ? { header: {} } : summary([], "in"); }
      return { items: [], pageCount: 1 };
    });
    const src = espnLiveSource({ http });
    const good = await src.week(2026, 5);
    assert.equal(good.delayed, false);

    mode = "badGame";
    const w1 = await src.week(2026, 5);
    assert.equal(w1.delayed, true);
    assert.match(w1.errors[0]!, /game 401: HTTP 500/);
    assert.equal(w1.games.find(g => g.gameId === "401"), good.games.find(g => g.gameId === "401"), "last good data kept");

    mode = "shape";
    const w2 = await src.week(2026, 5);
    assert.equal(w2.delayed, true);
    assert.match(w2.errors[0]!, /summary header missing/);

    mode = "down";
    const w3 = await src.week(2026, 5);
    assert.equal(w3.delayed, true);
    assert.match(w3.errors[0]!, /scoreboard: HTTP 503/);
    assert.equal(w3.games.length, 1, "last good in-progress game still returned");
  });

  test("core plays: follows pageCount", async () => {
    const http = fakeHttp(url => url.includes("scoreboard") ? scoreboard("post") : url.includes("summary") ? summary([]) : url.includes("page=1") ? { items: [], pageCount: 2 } : { items: [], pageCount: 2 });
    await espnLiveSource({ http }).week(2026, 5);
    assert.equal(http.calls.filter(c => c.url.includes("/plays?")).length, 2);
  });
});
