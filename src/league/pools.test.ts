import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { confidenceScores, gameResult, mflMatchupKey, survivorStandings, type NflGame } from "./pools.ts";
import { computePayouts, prizeTotal, pot, type SeasonSettings } from "./payouts.ts";
import { team } from "../ingest/teams.ts";

const NOW = Date.parse("2026-12-01T00:00:00Z");
const g = (week: number, away: string, home: string, as: number | null, hs: number | null, kickoff = "2026-09-13T17:00:00Z"): NflGame =>
  ({ week, game_key: `${away}@${home}`, home, away, kickoff, away_score: as, home_score: hs, status: as == null ? "scheduled" : "final" });
const S = { survivor: { start_week: 1, end_week: 17, missed_pick_eliminates: true }, confidence: { start_week: 1, end_week: 2 } };

describe("game results", () => {
  test("winner, tie (null), or pending", () => {
    assert.equal(gameResult(g(1, "NE", "SEA", 10, 13)), "SEA");
    assert.equal(gameResult(g(1, "NE", "SEA", 20, 20)), null);
    assert.equal(gameResult(g(1, "NE", "SEA", null, null)), "pending");
  });
  test("MFL matchup codes map to our game keys", () => {
    assert.equal(mflMatchupKey("NEP,SEA", team), "NE@SEA");
    assert.equal(mflMatchupKey("SFO,LAR", team), "SF@LAR");
  });
});

describe("survivor", () => {
  const games = [g(1, "DET", "GB", 27, 20), g(1, "LAC", "KC", 10, 24), g(1, "NE", "SEA", 17, 17),
    g(2, "SF", "ARI", 30, 3), g(2, "TB", "ATL", 14, 21), g(3, "KC", "BAL", 20, 27), g(3, "CIN", "CLE", 30, 10)];
  test("loss or tie eliminates; the last team standing wins", () => {
    const r = survivorStandings({ settings: S, teams: ["A", "B", "C", "D"], now: NOW, games, picks: [
      { week: 1, team_id: "A", nfl_team: "DET" }, { week: 1, team_id: "B", nfl_team: "LAC" }, { week: 1, team_id: "C", nfl_team: "SEA" }, { week: 1, team_id: "D", nfl_team: "KC" },
      { week: 2, team_id: "A", nfl_team: "SF" }, { week: 2, team_id: "D", nfl_team: "TB" }] });
    assert.deepEqual(r.status.map(s => [s.team_id, s.alive, s.eliminated_week, s.reason]), [["A", true, null, null], ["B", false, 1, "loss"], ["C", false, 1, "tie"], ["D", false, 2, "loss"]]);
    assert.deepEqual([r.winners, r.decided, r.decidedWeek], [["A"], true, 2]);
  });
  test("no pick by the week's last kickoff eliminates (unless the setting is off)", () => {
    const picks = [{ week: 1, team_id: "A", nfl_team: "DET" }, { week: 1, team_id: "B", nfl_team: "KC" }, { week: 2, team_id: "A", nfl_team: "SF" }];
    const r = survivorStandings({ settings: S, teams: ["A", "B"], now: NOW, games, picks });
    assert.deepEqual(r.status.find(s => s.team_id === "B"), { team_id: "B", alive: false, eliminated_week: 2, reason: "no pick", winner: false, picks_used: 1 });
    assert.deepEqual(r.winners, ["A"]);
    const lenient = survivorStandings({ settings: { survivor: { ...S.survivor, missed_pick_eliminates: false } }, teams: ["A", "B"], now: NOW, games, picks });
    assert.equal(lenient.status.find(s => s.team_id === "B")!.alive, true);
  });
  test("before the week's last kickoff a missing pick is only pending", () => {
    const r = survivorStandings({ settings: S, teams: ["A", "B"], now: Date.parse("2026-09-01T00:00:00Z"), games,
      picks: [{ week: 1, team_id: "A", nfl_team: "DET" }] });
    assert.equal(r.decided, false);
    assert.ok(r.status.every(s => s.alive));
  });
  test("everyone left eliminated the same week: they split", () => {
    const r = survivorStandings({ settings: S, teams: ["A", "B", "C"], now: NOW, games, picks: [
      { week: 1, team_id: "A", nfl_team: "DET" }, { week: 1, team_id: "B", nfl_team: "KC" }, { week: 1, team_id: "C", nfl_team: "LAC" },
      { week: 2, team_id: "A", nfl_team: "TB" }, { week: 2, team_id: "B", nfl_team: "ARI" }] });
    assert.deepEqual([r.winners.sort(), r.decidedWeek], [["A", "B"], 2]);
    assert.ok(r.status.filter(s => s.winner).every(s => !s.alive));
  });
  test("a pending game stops the standings at that week (projected)", () => {
    const r = survivorStandings({ settings: S, teams: ["A", "B"], now: NOW, games: [...games.filter(x => x.week === 1), g(2, "SF", "ARI", null, null)], picks: [
      { week: 1, team_id: "A", nfl_team: "DET" }, { week: 1, team_id: "B", nfl_team: "KC" }, { week: 2, team_id: "A", nfl_team: "SF" }, { week: 2, team_id: "B", nfl_team: "ARI" }] });
    assert.deepEqual([r.decided, r.status.every(s => s.alive)], [false, true]);
  });
  test("a reused team (e.g. in imported data) is flagged; picks are counted", () => {
    const r = survivorStandings({ settings: S, teams: ["A"], now: NOW, games, picks: [{ week: 1, team_id: "A", nfl_team: "KC" }, { week: 3, team_id: "A", nfl_team: "KC" }] });
    assert.equal(r.flags[0]!.kind, "survivor_reuse");
    assert.equal(r.status[0]!.picks_used, 2);
  });
  test("2026 as imported from MFL: Stealers outlast the Nutcrackers in week 6", () => {
    const real = [g(1, "DET", "X1", 1, 0), g(1, "LAC", "X2", 0, 1), g(1, "PIT", "X3", 1, 0), g(1, "PHI", "X4", 1, 0), g(1, "LAR", "X5", 0, 1),
      g(2, "SF", "Y1", 1, 0), g(2, "TB", "Y2", 0, 1), g(2, "BUF", "Y3", 1, 0), g(3, "KC", "Z1", 1, 0), g(3, "X9", "KC2", 0, 1),
      g(4, "BAL", "Q1", 1, 0), g(4, "MIN", "Q2", 1, 0), g(5, "CIN", "R1", 1, 0), g(5, "HOU", "R2", 1, 0), g(6, "NYJ", "NE", 19, 26), g(6, "ARI", "LA", 18, 16)].map(x => ({ ...x, home: x.home === "LA" ? "LAR" : x.home, game_key: x.game_key.replace("@LA", "@LAR") }));
    const picks = [
      ...["0001", "0003", "0004", "0005", "0006", "0009", "0010", "0011"].map(t => ({ week: 1, team_id: t, nfl_team: "LAC" })),
      { week: 1, team_id: "0012", nfl_team: "LAR" }, { week: 1, team_id: "0007", nfl_team: "PIT" }, { week: 2, team_id: "0007", nfl_team: "TB" },
      ...[[1, "DET"], [2, "SF"], [3, "KC"], [4, "BAL"], [5, "CIN"], [6, "NE"]].map(([w, t]) => ({ week: w as number, team_id: "0002", nfl_team: t as string })),
      ...[[1, "PHI"], [2, "BUF"], [3, "KC"], [4, "MIN"], [5, "HOU"], [6, "LAR"]].map(([w, t]) => ({ week: w as number, team_id: "0008", nfl_team: t as string }))
    ];
    const teams = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0"));
    const r = survivorStandings({ settings: S, teams, now: NOW, games: real, picks });
    assert.deepEqual([r.winners, r.decidedWeek], [["0002"], 6]);
    assert.deepEqual(r.status.find(s => s.team_id === "0008")!.eliminated_week, 6);
  });
});

describe("confidence", () => {
  const games = [g(1, "NE", "SEA", 10, 13), g(1, "SF", "LAR", 20, 20), g(1, "DET", "GB", 24, 10),
    g(2, "KC", "BAL", null, null), g(2, "CIN", "CLE", 30, 3)];
  test("correct picks earn their points; wrong, tied games and missing picks earn 0", () => {
    const r = confidenceScores({ settings: S, teams: ["A", "B"], games, picks: [
      { week: 1, team_id: "A", game_key: "NE@SEA", pick: "SEA", points: 3 }, { week: 1, team_id: "A", game_key: "SF@LAR", pick: "SF", points: 2 }, { week: 1, team_id: "A", game_key: "DET@GB", pick: "GB", points: 1 },
      { week: 1, team_id: "B", game_key: "DET@GB", pick: "DET", points: 3 }] });
    const w1 = r.weekly.filter(x => x.week === 1);
    assert.deepEqual(w1.map(x => [x.team_id, x.points, x.correct]), [["A", 3, 1], ["B", 3, 1]]);
    assert.deepEqual(r.flags, []);
  });
  test("pending games count later; the season isn't complete until every game is final", () => {
    const r = confidenceScores({ settings: S, teams: ["A"], games, picks: [{ week: 2, team_id: "A", game_key: "KC@BAL", pick: "KC", points: 2 }, { week: 2, team_id: "A", game_key: "CIN@CLE", pick: "CIN", points: 1 }] });
    assert.deepEqual(r.weekly.find(x => x.week === 2), { week: 2, team_id: "A", points: 1, correct: 1, decided: 1, games: 2 });
    assert.equal(r.complete, false);
  });
  test("duplicate or out-of-range values (e.g. imported) are flagged", () => {
    const r = confidenceScores({ settings: S, teams: ["A"], games, picks: [
      { week: 1, team_id: "A", game_key: "NE@SEA", pick: "SEA", points: 3 }, { week: 1, team_id: "A", game_key: "SF@LAR", pick: "SF", points: 3 }, { week: 1, team_id: "A", game_key: "DET@GB", pick: "DET", points: 4 }] });
    assert.equal(r.flags[0]!.kind, "confidence_values");
  });
});

describe("payout handoff", () => {
  const S26: SeasonSettings = { season: 2026, team_count: 12, buy_in: 360, website_fee: 80, empire_contribution: 120, empire_carry_in: 240, empire_defending_team: null,
    prizes: { weekly_high: { amount: 35, first_week: 1, last_week: 17 }, playoffs: { r1: 60, r1_games: 4, r2: 120, r2_games: 2, champion: 240, weeks: [15, 16, 17] },
      season_points: { amounts: [1075, 740, 390], first_week: 1, last_week: 17 }, guillotine: { amount: 120, start_week: 2 }, survivor: { amount: 240 }, pickem: { amounts: [180, 60] }, manual: [] } };
  const run = (pools: Parameters<typeof computePayouts>[0]["pools"], overrides: Parameters<typeof computePayouts>[0]["overrides"] = []) =>
    computePayouts({ settings: S26, teams: ["0001", "0002", "0003"], scores: [], weekStatus: new Map(), matchups: [], pools, overrides });
  test("the restructured 2026 prizes still add up to the $4,120 pot", () => assert.equal(prizeTotal(S26.prizes), pot(S26)));
  test("Survivor pays its winner $240, or splits it", () => {
    assert.deepEqual(run({ survivor: { winners: ["0002"], decided: true } }).awards.map(a => [a.kind, a.team_id, a.amount, a.status]), [["survivor", "0002", 240, "final"]]);
    assert.deepEqual(run({ survivor: { winners: ["0003", "0001"], decided: true } }).awards.map(a => [a.team_id, a.amount]), [["0001", 120], ["0003", 120]]);
    assert.deepEqual(run({ survivor: { winners: ["0002"], decided: false } }).awards, []);
  });
  test("Pick'em pays 1st $180 and 2nd $60 from the confidence standings; ties split; projected until complete", () => {
    const r = run({ pickem: { totals: [{ team_id: "0001", points: 300 }, { team_id: "0002", points: 280 }, { team_id: "0003", points: 280 }], complete: false } });
    assert.deepEqual(r.awards.map(a => [a.place, a.team_id, a.amount, a.status]), [[1, "0001", 180, "projected"], [2, "0002", 30, "projected"], [2, "0003", 30, "projected"]]);
    const tie1 = run({ pickem: { totals: [{ team_id: "0001", points: 300 }, { team_id: "0002", points: 300 }, { team_id: "0003", points: 10 }], complete: true } });
    assert.deepEqual(tie1.awards.map(a => [a.team_id, a.amount, a.status]), [["0001", 120, "final"], ["0002", 120, "final"]]);
  });
  test("the commissioner's Survivor decision (2026: Stealers, from the spreadsheet) replaces the computed one", () => {
    const r = run({ survivor: { winners: ["0001"], decided: true } }, [{ kind: "survivor", week: null, place: null, team_id: "0002" }]);
    assert.deepEqual(r.awards.filter(a => a.kind === "survivor"), []);
  });
});

describe("MFL pool import", () => {
  test("survivor and confidence exports map to our team codes and game keys; blanks skipped; one week only when asked", async () => {
    const { mflPoolRows } = await import("./mflPools.ts");
    const sv = { survivorPool: { franchise: [{ id: "0002", week: [{ week: "1", pick: "DET" }, { week: "6", pick: "NEP" }, { week: "7" }] }, { id: "0001", week: [{ week: "1", pick: "LAC" }, { week: "2", pick: "" }] }] } };
    const pool = { poolPicks: { franchise: { id: "0001", week: [{ week: "1", game: [{ matchup: "NEP,SEA", pick: "NEP", rank: "7" }, { matchup: "SFO,LAR", pick: "LAR", rank: "8" }] }, { week: "2", game: { matchup: "XXX,KCC", pick: "KCC", rank: "1" } }] } } };
    const r = mflPoolRows(2026, sv, pool);
    assert.deepEqual(r.survivor.map(x => [x.team_id, x.week, x.nfl_team]), [["0002", 1, "DET"], ["0002", 6, "NE"], ["0001", 1, "LAC"]]);
    assert.deepEqual(r.confidence.map(x => [x.week, x.game_key, x.pick, x.points]), [[1, "NE@SEA", "NE", 7], [1, "SF@LAR", "LAR", 8]]);
    assert.deepEqual(r.problems, ['unknown matchup "XXX,KCC"']);
    assert.deepEqual(mflPoolRows(2026, sv, pool, 6).survivor.map(x => x.nfl_team), ["NE"]);
  });
});

describe("pools in the payout refresh", () => {
  test("survivor standings and the Survivor prize are written from picks and NFL results", async () => {
    const { refreshPayouts } = await import("./payoutsSync.ts");
    const posts: { path: string; body: unknown }[] = [];
    const J = (d: unknown) => new Response(JSON.stringify(d));
    const settings = { season: 2026, team_count: 2, buy_in: "100", website_fee: "0", empire_contribution: "0", empire_carry_in: "0", empire_defending_team: null,
      prizes: { survivor: { amount: 200 } }, pools: { survivor: { start_week: 1, end_week: 17 } } };
    const f = (async (u: string, init: RequestInit = {}) => {
      const path = u.replace(/^.*\/rest\/v1\//, "");
      if (init.method === "POST") { posts.push({ path: path.replace(/\?.*$/, ""), body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
      if (path.startsWith("season_settings")) return J([settings]);
      if (path.startsWith("teams")) return J([{ id: "0001" }, { id: "0002" }]);
      if (path.startsWith("nfl_games")) return J([{ week: 1, game_key: "DET@GB", home: "GB", away: "DET", kickoff: "2026-09-13T17:00:00Z", home_score: 20, away_score: 27, status: "final" }]);
      if (path.startsWith("survivor_picks")) return J([{ week: 1, team_id: "0001", nfl_team: "GB" }, { week: 1, team_id: "0002", nfl_team: "DET" }]);
      return J([]);
    }) as unknown as typeof fetch;
    const r = await refreshPayouts({ url: "https://x.supabase.co", serviceKey: "k" }, 2026, f, { now: Date.parse("2026-12-01T00:00:00Z") });
    assert.deepEqual(r.survivor, { winners: ["0002"], decided: true, alive: 1 });
    const status = posts.find(p => p.path === "survivor_status")!.body as { team_id: string; alive: boolean; winner: boolean }[];
    assert.deepEqual(status.map(s => [s.team_id, s.alive, s.winner]), [["0001", false, false], ["0002", true, true]]);
    const awards = (posts.find(p => p.path === "rpc/replace_auto_payouts")!.body as { p_awards: { kind: string; team_id: string; amount: number }[] }).p_awards;
    assert.deepEqual(awards.map(a => [a.kind, a.team_id, a.amount]), [["survivor", "0002", 200]]);
  });
});

test("test mode: the standings and Pick'em scoring query excludes TEST picks", async () => {
  const { refreshPayouts } = await import("./payoutsSync.ts");
  const urls: string[] = [];
  const f = (async (u: string, init: RequestInit = {}) => {
    urls.push(decodeURIComponent(u));
    if (init.method === "POST") return new Response(null, { status: 204 });
    if (u.includes("season_settings")) return new Response(JSON.stringify([{ season: 2026, team_count: 1, buy_in: "0", website_fee: "0", empire_contribution: "0", empire_carry_in: "0", empire_defending_team: null,
      prizes: {}, pools: { mode: "test", confidence: { start_week: 1, end_week: 17 } } }]));
    return new Response("[]");
  }) as unknown as typeof fetch;
  await refreshPayouts({ url: "https://x.supabase.co", serviceKey: "k" }, 2026, f);
  assert.ok(urls.some(u => u.includes("confidence_picks?season=eq.2026&source=neq.test")), "test picks never count");
});
