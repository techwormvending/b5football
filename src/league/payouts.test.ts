import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computePayouts, pooledPlaces, pot, prizeTotal, splitEven, type SeasonSettings, type TeamWeekScore } from "./payouts.ts";

const TEAMS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0"));   // 0001..0012
// Example amounts (not the league's real ones, which are members-only and live only in the database).
const S2026: SeasonSettings = {
  season: 2026, team_count: 12, buy_in: 100, website_fee: 50, empire_contribution: 70, empire_carry_in: 90, empire_defending_team: null,
  prizes: {
    weekly_high: { amount: 20, first_week: 1, last_week: 17 },
    playoffs: { r1: 30, r1_games: 4, r2: 50, r2_games: 2, champion: 100, weeks: [15, 16, 17] },
    season_points: { amounts: [110, 50, 30], first_week: 1, last_week: 17 },
    guillotine: { amount: 40, start_week: 2 },
    manual: [{ key: "pickem_1", label: "Pick'em 1st", amount: 100 }, { key: "pickem_2", label: "Pick'em 2nd", amount: 40 }, { key: "survivor", label: "Survivor", amount: 50 }]
  }
};
/** A week where team i scores base + i (so 0012 is high, 0001 low), with overrides. */
const week = (w: number, over: Record<string, number> = {}, base = 100): TeamWeekScore[] =>
  TEAMS.map((t, i) => ({ week: w, team_id: t, points: over[t] ?? base + i }));
const run = (scores: TeamWeekScore[], extra: Partial<Parameters<typeof computePayouts>[0]> = {}) =>
  computePayouts({ settings: S2026, teams: TEAMS, scores, weekStatus: new Map(), matchups: [], ...extra });
const of = (r: ReturnType<typeof run>, kind: string, wk?: number) => r.awards.filter(a => a.kind === kind && (wk == null || a.week === wk));

describe("pot", () => {
  test("12 x fee - website fee - Empire contribution = the pot, and the prizes add up to exactly that", () => {
    assert.equal(pot(S2026), 1080);
    assert.equal(prizeTotal(S2026.prizes), 1080);
    assert.deepEqual(run([]).flags, []);
  });
  test("a prize table that doesn't add up is flagged", () => {
    const r = computePayouts({ settings: { ...S2026, prizes: { ...S2026.prizes, guillotine: { amount: 45, start_week: 2 } } }, teams: TEAMS, scores: [], weekStatus: new Map(), matchups: [] });
    assert.equal(r.flags[0]!.kind, "pot_mismatch");
  });
});

describe("ties split evenly, in cents that add up", () => {
  test("2-way 10.00 each; 3-way 6.67 / 6.67 / 6.66", () => {
    assert.deepEqual(splitEven(20, ["0002", "0001"]), [{ team_id: "0001", amount: 10 }, { team_id: "0002", amount: 10 }]);
    assert.deepEqual(splitEven(20, ["0003", "0001", "0002"]).map(s => s.amount), [6.67, 6.67, 6.66]);
  });
});

describe("weekly high score", () => {
  test("one winner per week, projected until the week is final", () => {
    const r = run([...week(1), ...week(2)], { weekStatus: new Map([[1, "final"], [2, "live"]]) });
    assert.deepEqual(of(r, "weekly_high").map(a => [a.week, a.team_id, a.amount, a.status]), [[1, "0012", 20, "final"], [2, "0012", 20, "projected"]]);
  });
  test("2-way and 3-way ties split the weekly prize", () => {
    const r = run([...week(1, { "0005": 111 }), ...week(2, { "0003": 111, "0007": 111 })]);
    assert.deepEqual(of(r, "weekly_high", 1).map(a => [a.team_id, a.amount]), [["0005", 10], ["0012", 10]]);
    assert.deepEqual(of(r, "weekly_high", 2).map(a => [a.team_id, a.amount]), [["0003", 6.67], ["0007", 6.67], ["0012", 6.66]]);
    assert.match(of(r, "weekly_high", 2)[0]!.label, /3-way tie/);
  });
  test("every week 1-17 counts, playoff weeks included; unscored weeks pay nothing yet", () => {
    const r = run([...week(17), ...week(16, {}, 0).map(x => ({ ...x, points: 0 }))]);
    assert.deepEqual(of(r, "weekly_high").map(a => a.week), [17]);
  });
});

describe("guillotine", () => {
  test("from week 2, the lowest team still alive goes each week; the last one left wins", () => {
    const scores: TeamWeekScore[] = [];
    for (let w = 1; w <= 12; w++) scores.push(...week(w));                      // 0001 lowest every week...
    const r = run(scores, { weekStatus: new Map(Array.from({ length: 12 }, (_, i) => [i + 1, "final"])) });
    assert.deepEqual(r.eliminations.map(e => [e.week, e.team_id]).slice(0, 3), [[2, "0001"], [3, "0002"], [4, "0003"]], "...but week 1 eliminates nobody");
    assert.equal(r.eliminations.length, 11);
    assert.deepEqual(of(r, "guillotine").map(a => [a.team_id, a.amount, a.status]), [["0012", 40, "final"]]);
  });
  test("a tie for lowest stops the guillotine and asks the commissioner; his pick continues it", () => {
    const scores = [...week(2), ...week(3, { "0002": 50, "0003": 50 }), ...week(4)];
    const r = run(scores);
    assert.deepEqual(r.eliminations.map(e => e.team_id), ["0001"]);
    assert.deepEqual(r.flags.map(f => [f.kind, f.week, f.teams]), [["guillotine_tie", 3, ["0002", "0003"]]]);
    const r2 = run(scores, { guillotineOverrides: new Map([[3, "0003"]]) });
    assert.deepEqual(r2.eliminations.map(e => [e.week, e.team_id]), [[2, "0001"], [4, "0002"]]);
    assert.deepEqual(r2.flags, []);
  });
});

describe("playoffs", () => {
  const m = (week: number, home: string, away: string, hs: number | null, as: number | null) => ({ week, home_team: home, away_team: away, home_score: hs, away_score: as, is_playoff: true });
  const bracket = [
    m(15, "0001", "0008", 100, 90), m(15, "0004", "0005", 80, 95), m(15, "0003", "0006", 70, 60), m(15, "0002", "0007", 99, 101),
    m(16, "0001", "0005", 120, 110), m(16, "0003", "0007", 88, 90),
    m(16, "0010", "0011", 150, 10),                                                // consolation: not a bracket game
    m(17, "0001", "0007", 130, 125)
  ];
  test("round winners each get paid; the champion collects all three rounds (30 + 50 + 100 = 180)", () => {
    const r = run([], { matchups: bracket, weekStatus: new Map([[15, "final"], [16, "final"], [17, "final"]]) });
    assert.deepEqual(of(r, "playoff_r1").map(a => a.team_id).sort(), ["0001", "0003", "0005", "0007"]);
    assert.deepEqual(of(r, "playoff_r2").map(a => a.team_id).sort(), ["0001", "0007"]);
    assert.deepEqual(of(r, "champion").map(a => [a.team_id, a.amount]), [["0001", 100]]);
    const champTotal = r.awards.filter(a => a.team_id === "0001").reduce((s, a) => s + a.amount, 0);
    assert.equal(champTotal, 180);
    assert.equal(r.awards.reduce((s, a) => s + a.amount, 0), 4 * 30 + 2 * 50 + 100);
  });
  test("a tied playoff game splits that round's money; the better regular-season standing advances", () => {
    const tied = bracket.map(g => g.week === 15 && g.home_team === "0001" ? { ...g, away_score: 100 } : g);
    const g = tied.find(x => x.week === 15 && x.home_team === "0001")!;
    // 0001 ranked above its opponent: 0001 advances (and goes on to win, as in the bracket above).
    const order = ["0001", g.away_team, ...TEAMS.filter(t => t !== "0001" && t !== g.away_team)];
    const r = run([], { matchups: tied, standingsOrder: order });
    assert.deepEqual(of(r, "playoff_r1").filter(a => [g.home_team, g.away_team].includes(a.team_id)).map(a => [a.team_id, a.amount]).sort(),
      [["0001", 15], [g.away_team, 15]].sort(), "30 split 15/15");
    assert.deepEqual(of(r, "champion").map(a => a.team_id), ["0001"], "0001 advanced on the tiebreaker");
    assert.equal(r.awards.reduce((s, a) => s + a.amount, 0), 4 * 30 + 2 * 50 + 100, "splitting never changes the total paid");
    assert.match(r.flags.find(f => f.kind === "playoff_tie")!.message, /Round money split; 0001 advances on the tiebreaker/);
    // The other team ranked higher: it advances instead.
    const flipped = run([], { matchups: tied, standingsOrder: [g.away_team, ...order.filter(t => t !== g.away_team)] });
    assert.equal(of(flipped, "playoff_r2").some(a => a.team_id === "0001"), false);
    // A tied championship: co-champions split the champion's prize; the tiebreaker names the champion (Empire).
    const champTie = tied.map(x => x.week === 17 ? { ...x, home_score: 100, away_score: 100 } : x);
    const c = run([], { matchups: champTie, standingsOrder: order });
    assert.deepEqual(of(c, "champion").map(a => a.amount), [50, 50]);
  });
  test("a tied playoff game with no standings to break it is flagged; the commissioner's winners advance", () => {
    const tied = bracket.map(g => g.week === 15 && g.home_team === "0001" ? { ...g, away_score: 100 } : g);
    const r = run([], { matchups: tied });
    assert.deepEqual(r.flags.map(f => [f.kind, f.week]), [["playoff_tie", 15]]);
    assert.equal(of(r, "champion").length, 0, "0001 can't advance until decided");
    const fixed = run([], { matchups: tied, overrides: ["0001", "0005", "0003", "0007"].map(t => ({ kind: "playoff_r1", week: 15, place: null, team_id: t })) });
    assert.equal(of(fixed, "playoff_r1").length, 0, "the overridden round's auto awards are dropped");
    assert.deepEqual(of(fixed, "champion").map(a => a.team_id), ["0001"]);
  });
});

describe("season points", () => {
  test("1st/2nd/3rd: 110 / 50 / 30", () => {
    const r = run(week(1));
    assert.deepEqual(of(r, "season_points").map(a => [a.place, a.team_id, a.amount]), [[1, "0012", 110], [2, "0011", 50], [3, "0010", 30]]);
  });
  test("ties pool the places they cover: tied for 2nd shares 2nd + 3rd; three tied for 3rd share 3rd", () => {
    const tie2 = pooledPlaces([{ team_id: "A", points: 900 }, { team_id: "B", points: 800 }, { team_id: "C", points: 800 }, { team_id: "D", points: 700 }], [110, 50, 30]);
    assert.deepEqual(tie2.map(g => [g.place, g.shares.map(s => [s.team_id, s.amount])]), [[1, [["A", 110]]], [2, [["B", 40], ["C", 40]]]]);
    const tie3 = pooledPlaces([{ team_id: "A", points: 9 }, { team_id: "B", points: 8 }, { team_id: "C", points: 7 }, { team_id: "D", points: 7 }, { team_id: "E", points: 7 }], [110, 50, 30]);
    assert.deepEqual(tie3[2]!.shares.map(s => s.amount), [10, 10, 10]);
    const tie1 = pooledPlaces([{ team_id: "A", points: 9 }, { team_id: "B", points: 9 }, { team_id: "C", points: 7 }], [110, 50, 30]);
    assert.deepEqual(tie1.map(g => g.shares.map(s => s.amount)), [[80, 80], [30]]);
  });
  test("final only when every week 1-17 is final", () => {
    const all = new Map(Array.from({ length: 17 }, (_, i) => [i + 1, "final"]));
    assert.equal(of(run(week(1), { weekStatus: all }), "season_points")[0]!.status, "final");
    all.set(17, "pending_review");
    assert.equal(of(run(week(1), { weekStatus: all }), "season_points")[0]!.status, "projected");
  });
});

describe("Empire pot", () => {
  const champGames = [
    ...[["0001", "0008"], ["0004", "0005"], ["0003", "0006"], ["0002", "0007"]].map(([h, a]) => ({ week: 15, home_team: h!, away_team: a!, home_score: 100, away_score: 90, is_playoff: true })),
    { week: 16, home_team: "0001", away_team: "0004", home_score: 100, away_score: 90, is_playoff: true },
    { week: 16, home_team: "0003", away_team: "0002", home_score: 100, away_score: 90, is_playoff: true },
    { week: 17, home_team: "0001", away_team: "0003", home_score: 100, away_score: 90, is_playoff: true }
  ];
  const final = new Map([[15, "final"], [16, "final"], [17, "final"]]);
  const withDefending = (t: string | null) => ({ ...S2026, empire_defending_team: t });
  test("balance = carried in + this season's contribution; the defending champion is on Empire watch", () => {
    const r = computePayouts({ settings: withDefending("0001"), teams: TEAMS, scores: [], weekStatus: new Map(), matchups: [] });
    assert.deepEqual(r.empire, { balance: 160, defending: "0001", outcome: "watch", champion: null, next_carry_in: 160 });
  });
  test("the defending champion repeats: he gets the pot", () => {
    const r = computePayouts({ settings: withDefending("0001"), teams: TEAMS, scores: [], weekStatus: final, matchups: champGames });
    assert.equal(r.empire.outcome, "paid");
    assert.deepEqual(of(r, "empire").map(a => [a.team_id, a.amount, a.status]), [["0001", 160, "final"]]);
    assert.equal(r.empire.next_carry_in, 0);
  });
  test("anyone else wins: the pot rolls into next season (and next season adds its contribution)", () => {
    const r = computePayouts({ settings: withDefending("0003"), teams: TEAMS, scores: [], weekStatus: final, matchups: champGames });
    assert.equal(r.empire.outcome, "rolled");
    assert.equal(r.empire.next_carry_in, 160);
    assert.equal(of(r, "empire").length, 0);
  });
  test("nothing pays until the championship week is final", () => {
    const r = computePayouts({ settings: withDefending("0001"), teams: TEAMS, scores: [], weekStatus: new Map([[17, "live"]]), matchups: champGames });
    assert.equal(r.empire.outcome, "watch");
  });
});

describe("overrides and the spreadsheet seed", () => {
  test("an override replaces the whole auto group", () => {
    const r = run(week(1), { overrides: [{ kind: "weekly_high", week: 1, place: null, team_id: "0003" }] });
    assert.equal(of(r, "weekly_high", 1).length, 0);
  });
  test("seeded winners that match raise nothing; a mismatch is flagged with both answers", () => {
    const seeded = { ...S2026, seed: { weekly_high: { "1": "0012", "2": "0005" }, guillotine: { "2": "0001" } } };
    const r = computePayouts({ settings: seeded, teams: TEAMS, scores: [...week(1), ...week(2)], weekStatus: new Map(), matchups: [] });
    assert.deepEqual(r.flags.map(f => f.message), ["Week 2 high score: the spreadsheet says 0005, this site says 0012."]);
  });
});

describe("refreshPayouts (database round trip)", () => {
  test("reads settings, scores, week status, playoff games and overrides; writes auto results in one call", async () => {
    const { refreshPayouts } = await import("./payoutsSync.ts");
    const posted: { path: string; body: { p_awards: { kind: string; team_id: string }[]; p_guillotine: unknown[]; p_flags: unknown[] } }[] = [];
    const J = (d: unknown) => new Response(JSON.stringify(d));
    const f = (async (u: string, init: RequestInit = {}) => {
      const path = u.replace(/^.*\/rest\/v1\//, "");
      if (init.method === "POST") { posted.push({ path, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
      if (path.startsWith("season_settings")) return J([{ ...S2026, buy_in: "100.00", website_fee: "50.00", empire_contribution: "70.00", empire_carry_in: "90.00" }]);
      if (path.startsWith("teams")) return J(TEAMS.map(id => ({ id })));
      if (path.startsWith("team_scores")) return J(week(1).map(x => ({ ...x, points: String(x.points) })));
      if (path.startsWith("score_weeks")) return J([{ week: 1, status: "final" }]);
      return J([]);
    }) as unknown as typeof fetch;
    const r = await refreshPayouts({ url: "https://x.supabase.co", serviceKey: "sb_secret_t" }, 2026, f);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.path, "rpc/replace_auto_payouts");
    assert.deepEqual(posted[0]!.body.p_awards.find(a => a.kind === "weekly_high"), { kind: "weekly_high", week: 1, place: null, label: "Week 1 high score", team_id: "0012", amount: 20, status: "final", note: "111.00 points" });
    assert.deepEqual(r.flags, [], "string amounts from Postgres numerics are handled (no false pot mismatch)");
  });
  test("a season without settings is skipped, not an error", async () => {
    const { refreshPayouts } = await import("./payoutsSync.ts");
    const f = (async () => new Response("[]")) as unknown as typeof fetch;
    assert.equal((await refreshPayouts({ url: "https://x.supabase.co", serviceKey: "k" }, 2030, f)).skipped, "no season settings");
  });
});
