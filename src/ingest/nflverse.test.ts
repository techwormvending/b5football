/* nflverse adapter tests. Plays are trimmed copies of real 2025 rows (only the
   columns the adapter reads), including every special case the first
   cross-check missed. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gamesFromPbp } from "./nflverse.ts";
import { gameStatLines } from "./statlines.ts";

type Row = Record<string, string>;
const base: Row = { game_id: "2025_03_LA_PHI", season: "2025", week: "3", season_type: "REG", home_team: "PHI", away_team: "LA", home_score: "33", away_score: "26" };
const play = (r: Row): Row => ({ ...base, ...r });

const scoringFor = (rows: Row[]) => {
  const [g] = gamesFromPbp(rows);
  return { g: g!, lines: gameStatLines(g!) };
};

describe("gamesFromPbp", () => {
  test("passing TD: length, passer, receiver, box score; counts as offensive TD allowed", () => {
    const { g, lines } = scoringFor([play({
      play_type: "pass", posteam: "PHI", defteam: "LA", yards_gained: "42", passing_yards: "42", receiving_yards: "42",
      complete_pass: "1", touchdown: "1", pass_touchdown: "1", td_team: "PHI",
      passer_player_id: "QB1", passer_player_name: "J.Hurts", receiver_player_id: "WR1", receiver_player_name: "A.Brown", td_player_id: "WR1", td_player_name: "A.Brown"
    })]);
    assert.deepEqual(lines.players.get("nflverse:QB1")!.stats, { passYds: 42, passTdLengths: [42] });
    assert.deepEqual(lines.players.get("nflverse:WR1")!.stats, { recYds: 42, receptions: 1, recTdLengths: [42] });
    assert.equal(lines.defenses.get("LAR")!.offensiveTdsAllowed, 1);
    assert.equal(g.teams.PHI!.netPassYds, 42);
    assert.equal(g.away, "LAR", "nflverse LA is normalized to LAR");
  });

  test("blocked field goal returned for a TD (nflverse return_touchdown = 0)", () => {
    const { g, lines } = scoringFor([play({
      play_type: "field_goal", posteam: "LA", defteam: "PHI", field_goal_result: "blocked", kick_distance: "44",
      touchdown: "1", return_touchdown: "0", td_team: "PHI", td_player_id: "D1", td_player_name: "J.Davis", return_yards: "61"
    })]);
    assert.deepEqual(g.events, [{ kind: "td", td: "blockedFgReturn", team: "PHI", length: 61, scorer: { provider: "nflverse", id: "D1", name: "J.Davis", team: "PHI" } }]);
    assert.equal(lines.defenses.get("PHI")!.blockedFgs, 1);
    assert.equal(lines.defenses.get("PHI")!.blockedFgTds, 1);
  });

  test("blocked punt recovered for a TD", () => {
    const { lines } = scoringFor([play({
      play_type: "punt", posteam: "LA", defteam: "PHI", punt_blocked: "1",
      touchdown: "1", return_touchdown: "0", td_team: "PHI", td_player_id: "D2", td_player_name: "S.Brown"
    })]);
    const d = lines.defenses.get("PHI")!;
    assert.equal(d.blockedPunts, 1);
    assert.equal(d.blockedPuntTds, 1);
    assert.equal(d.puntReturnTds, undefined);
  });

  test("kicking team recovers its kickoff in the end zone (posteam is the RECEIVING team on kickoffs)", () => {
    const { lines } = scoringFor([play({
      play_type: "kickoff", posteam: "LA", defteam: "PHI",
      touchdown: "1", return_touchdown: "0", td_team: "PHI", td_player_id: "RB9", td_player_name: "G.Holani"
    })]);
    assert.equal(lines.defenses.get("PHI")!.defFumbleRecoveryTds, 1);
    assert.equal(lines.players.get("nflverse:RB9")!.stats.defFumbleRecoveryTds, 1);
  });

  test("normal kickoff return TD credits the receiving team", () => {
    const { lines } = scoringFor([play({
      play_type: "kickoff", posteam: "LA", defteam: "PHI", touchdown: "1", return_touchdown: "1", td_team: "LA", td_player_id: "R1", td_player_name: "X.Returner"
    })]);
    assert.equal(lines.defenses.get("LAR")!.kickReturnTds, 1);
    assert.equal(lines.players.get("nflverse:R1")!.stats.kickReturnTds, 1);
  });

  test("interception, fumbled back, offense scores = own-fumble recovery TD, no defensive credit for the offense", () => {
    const { lines } = scoringFor([play({
      play_type: "pass", posteam: "PHI", defteam: "LA", interception: "1", fumble_lost: "1",
      fumbled_1_team: "LA", fumble_recovery_1_team: "PHI",
      touchdown: "1", return_touchdown: "1", td_team: "PHI", td_player_id: "WR7", td_player_name: "T.Lockett",
      passer_player_id: "QB1", passer_player_name: "J.Hurts"
    })]);
    assert.equal(lines.players.get("nflverse:WR7")!.stats.offFumbleRecoveryTds, 1);
    assert.equal(lines.players.get("nflverse:QB1")!.stats.interceptionsThrown, 1);
    const phi = lines.defenses.get("PHI")!, la = lines.defenses.get("LAR")!;
    assert.equal(phi.intReturnTds, undefined);
    assert.equal(la.interceptions, 1);
    assert.equal(phi.fumbleRecoveries, 1, "PHI recovered LA's fumble");
    assert.equal(la.offensiveTdsAllowed, 0);
  });

  test("fumble chain: each fumble recovered by the other team counts", () => {
    // INT by LA; LA fumbles, PHI recovers; PHI fumbles, LA recovers
    const { lines } = scoringFor([play({
      play_type: "pass", posteam: "PHI", defteam: "LA", interception: "1", fumble_lost: "1",
      fumbled_1_team: "LA", fumble_recovery_1_team: "PHI", fumbled_2_team: "PHI", fumble_recovery_2_team: "LA"
    })]);
    assert.equal(lines.defenses.get("LAR")!.fumbleRecoveries, 1);
    assert.equal(lines.defenses.get("PHI")!.fumbleRecoveries, 1);
  });

  test("fumble chain longer than nflverse's two slots: the lost fumble is still credited", () => {
    // Darnold fumbles and recovers; fumbles again, CAR recovers; CAR fumbles and recovers.
    const [g] = gamesFromPbp([{
      game_id: "2025_17_SEA_CAR", season: "2025", week: "17", season_type: "REG", home_team: "CAR", away_team: "SEA", home_score: "10", away_score: "27",
      play_type: "pass", posteam: "SEA", defteam: "CAR", sack: "1", yards_gained: "-7", fumble_lost: "1",
      fumbled_1_team: "SEA", fumble_recovery_1_team: "SEA", fumbled_2_team: "CAR", fumble_recovery_2_team: "CAR"
    }]);
    assert.equal(g!.teams.CAR!.fumbleRecoveries, 1);
    assert.equal(g!.teams.CAR!.sacks, 1);
    assert.equal(g!.teams.SEA!.netPassYds, -7, "sack yardage comes off net passing");
  });

  test("fumble out of the end zone (touchback) is lost but not a recovery", () => {
    const [g] = gamesFromPbp([play({ play_type: "pass", posteam: "LA", defteam: "PHI", fumble_lost: "1", fumbled_1_team: "LA" })]);
    assert.equal(g!.teams.PHI!.fumbleRecoveries, undefined);
  });

  test("two-point conversions don't add yards; defensive two-point and safeties", () => {
    const { g, lines } = scoringFor([
      play({ play_type: "pass", posteam: "PHI", defteam: "LA", two_point_attempt: "1", two_point_conv_result: "success", pass_attempt: "1",
        passing_yards: "2", receiving_yards: "2", complete_pass: "1",
        passer_player_id: "QB1", passer_player_name: "J.Hurts", receiver_player_id: "TE1", receiver_player_name: "D.Goedert" }),
      play({ play_type: "run", posteam: "LA", defteam: "PHI", two_point_attempt: "1", two_point_conv_result: "success", rush_attempt: "1",
        rusher_player_id: "RB2", rusher_player_name: "K.Williams" }),
      play({ play_type: "extra_point", posteam: "LA", defteam: "PHI", defensive_two_point_conv: "1" }),
      play({ play_type: "run", posteam: "LA", defteam: "PHI", safety: "1", yards_gained: "-3", rushing_yards: "-3" })
    ]);
    assert.deepEqual(lines.players.get("nflverse:QB1")!.stats, { twoPtPasses: 1 });
    assert.deepEqual(lines.players.get("nflverse:TE1")!.stats, { twoPtReceptions: 1 });
    assert.equal(lines.players.get("nflverse:RB2")!.stats.twoPtRushes, 1);
    assert.equal(lines.defenses.get("PHI")!.defTwoPtReturns, 1);
    assert.equal(lines.defenses.get("PHI")!.safeties, 1);
    assert.equal(g.teams.PHI!.netPassYds, 0);
  });

  test("kicking events", () => {
    const { lines } = scoringFor([
      play({ play_type: "field_goal", posteam: "PHI", defteam: "LA", field_goal_result: "made", kick_distance: "51", kicker_player_id: "K1", kicker_player_name: "J.Elliott" }),
      play({ play_type: "extra_point", posteam: "PHI", defteam: "LA", extra_point_result: "good", kicker_player_id: "K1", kicker_player_name: "J.Elliott" }),
      play({ play_type: "field_goal", posteam: "PHI", defteam: "LA", field_goal_result: "missed", kick_distance: "58", kicker_player_id: "K1", kicker_player_name: "J.Elliott" })
    ]);
    assert.deepEqual(lines.players.get("nflverse:K1")!.stats, { fgMadeLengths: [51], extraPoints: 1 });
  });

  test("missed field goal returned for a TD is flagged as a warning", () => {
    const [g] = gamesFromPbp([play({ play_type: "field_goal", posteam: "LA", defteam: "PHI", field_goal_result: "missed", touchdown: "1", td_team: "PHI", td_player_id: "X" })]);
    assert.match(g!.warnings[0]!, /missed field goal returned/);
  });
});
