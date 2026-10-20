import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { activeEvents, espnIds, mirrorSlots, runLive, teamTotals } from "./liveRun.ts";
import { handle } from "./edgeHandler.ts";
import type { EspnSummary } from "../ingest/espn.ts";

const NOW = Date.parse("2026-10-18T19:00:00Z");   // Sunday 3 PM ET
const ev = (id: string, state: string, hoursFromNow: number) =>
  ({ id, date: new Date(NOW + hoursFromNow * 3600_000).toISOString(), competitions: [{ status: { type: { state } } }] });

// DET (away) at ARI (home). Goff: 271 pass yds, -1 rush, 1 INT -> 270 total yds = 7, INT -1 => 6.
const ath = (id: number, name: string, stats: string[]) => ({ athlete: { id: String(id), displayName: name }, stats });
const summary = (state: string): EspnSummary => ({
  header: { week: 7, season: { year: 2026 }, competitions: [{ id: "401", status: { type: { state } }, competitors: [
    { homeAway: "home", score: "7", team: { id: "22", abbreviation: "ARI" } }, { homeAway: "away", score: "10", team: { id: "8", abbreviation: "DET" } }] }] },
  boxscore: {
    players: [
      { team: { abbreviation: "DET" }, statistics: [
        { name: "passing", keys: ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt", "passingTouchdowns", "interceptions"], athletes: [ath(1, "Jared Goff", ["19/30", "271", "9.0", "0", "1"])] },
        { name: "rushing", keys: ["rushingAttempts", "rushingYards"], athletes: [ath(1, "Jared Goff", ["2", "-1"]), ath(3, "Unknown Back", ["10", "40"])] }] },
      { team: { abbreviation: "ARI" }, statistics: [] }],
    teams: [
      { team: { abbreviation: "DET" }, statistics: [{ name: "netPassingYards", displayValue: "249" }, { name: "rushingYards", displayValue: "163" }, { name: "sacksYardsLost", displayValue: "3-22" }, { name: "interceptions", displayValue: "1" }] },
      { team: { abbreviation: "ARI" }, statistics: [{ name: "netPassingYards", displayValue: "231" }, { name: "rushingYards", displayValue: "90" }, { name: "sacksYardsLost", displayValue: "4-19" }, { name: "interceptions", displayValue: "2" }] }]
  },
  scoringPlays: []
});

/** Fake ESPN + MFL + Supabase. Records Supabase reads and writes. */
function world(opts: { events: ReturnType<typeof ev>[]; weekStatus?: string; failSummary?: boolean; failWrites?: boolean; mflStarters?: Record<string, string>; captured?: string[]; nonces?: string[] }) {
  const calls: string[] = [];
  const writes: { path: string; method: string; body: unknown }[] = [];
  const nonces = new Set(opts.nonces ?? []);
  const J = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
  const f = (async (u: string, init: RequestInit = {}) => {
    calls.push(decodeURIComponent(u));
    const method = init.method ?? "GET";
    if (u.endsWith("/scoreboard")) return J({ season: { year: 2026, type: 2 }, week: { number: 7 }, events: opts.events });
    if (u.includes("/summary?event=")) return opts.failSummary ? J({}, 500) : J(summary(opts.events[0]!.competitions[0]!.status.type.state));
    if (u.includes("/plays?")) return J({ items: [], pageCount: 1 });
    if (u.includes("TYPE=weeklyResults")) return J({ weeklyResults: { matchup: [{ franchise: Object.entries(opts.mflStarters ?? {}).map(([id, s]) => ({ id, starters: s })) }] } });
    const path = decodeURIComponent(u.replace(/^.*\/rest\/v1\//, ""));
    if (path.startsWith("live_nonces") && method === "DELETE") {
      const n = /nonce=eq\.([^&]+)/.exec(path)![1]!;
      const ok = nonces.delete(n);
      return J(ok ? [{ nonce: n }] : []);
    }
    if (method !== "GET") {
      if (opts.failWrites) return J({ message: "boom" }, 500);
      writes.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(null, { status: 201 });
    }
    if (path.startsWith("live_games")) return J((opts.captured ?? []).map(event_id => ({ event_id })));
    if (path.startsWith("score_weeks")) return J(opts.weekStatus ? [{ status: opts.weekStatus }] : []);
    if (path.startsWith("nfl_players?espn_id")) return J(path.includes('"1"') ? [{ id: "00-GOFF", espn_id: "1", name: "Jared Goff", position: "QB", nfl_team: "DET" }] : []);
    if (path.startsWith("nfl_players?id")) return J([{ id: "00-GOFF", position: "QB" }]);
    if (path.startsWith("mfl_player_map")) return J([{ mfl_id: "m1", player_id: "00-GOFF" }, { mfl_id: "m2", player_id: "DEF:ARI" }]);
    if (path.startsWith("lineup_slots")) return J([{ team_id: "0011", player_id: "00-GOFF" }, { team_id: "0011", player_id: "DEF:ARI" }, { team_id: "0005", player_id: "00-NOPE" }]);
    if (path.startsWith("player_scores")) return J([{ player_id: "00-GOFF", points: 6 }, { player_id: "DEF:ARI", points: 3.5 }]);
    if (path.startsWith("matchups")) return J([{ home_team: "0011", away_team: "0005", is_playoff: false }]);
    return J([]);
  }) as unknown as typeof fetch;
  return { f, calls, writes, deps: { fetch: f, sb: { url: "https://x.supabase.co", serviceKey: "sb_secret_t" }, now: () => NOW } };
}

describe("which games are worth polling", () => {
  test("in progress, or finished within 4.5 h of kickoff; not upcoming, not old", () => {
    const a = activeEvents([ev("in", "in", -1), ev("post", "post", -4), ev("old", "post", -5), ev("soon", "pre", 0.1), ev("later", "pre", 3)], NOW);
    assert.deepEqual(a.inProgress.map(e => e.id), ["in"]);
    assert.deepEqual(a.recentlyFinished.map(e => e.id), ["post"]);
  });
});

describe("runLive", () => {
  test("no game in progress: exactly one request (the scoreboard), even with a kickoff minutes away", async () => {
    const w = world({ events: [ev("401", "pre", 0.05), ev("402", "post", -8)] });
    const r = await runLive(w.deps);
    assert.equal(r.state, "idle");
    assert.equal(w.calls.length, 1);
  });

  test("a finished game whose final live numbers were captured isn't polled again", async () => {
    const w = world({ events: [ev("401", "post", -3.5)], captured: ["401"] });
    const r = await runLive(w.deps);
    assert.equal(r.state, "idle");
    assert.equal(w.calls.length, 2, "scoreboard + one live_games lookup");
    assert.deepEqual(w.writes, []);
  });

  test("a just-finished game is scored once and marked captured", async () => {
    const w = world({ events: [ev("401", "post", -3.5)] });
    const r = await runLive(w.deps);
    assert.equal(r.state, "live");
    assert.deepEqual((w.writes.find(x => x.path.startsWith("live_games"))!.body as { event_id: string }[]).map(x => x.event_id), ["401"]);
  });

  test("never writes over a week nflverse has finalized", async () => {
    const w = world({ events: [ev("401", "in", -1)], weekStatus: "pending_review" });
    const r = await runLive(w.deps);
    assert.equal(r.state, "final-week");
    assert.deepEqual(w.writes, []);
  });

  test("scores live games with our engine, looks up only these athletes, flags unmatched ones, mirrors MFL starters, updates matchup totals", async () => {
    const w = world({ events: [ev("401", "in", -1)], mflStarters: { "0011": "m1,m2,", "0005": "m9," } });
    const r = await runLive({ ...w.deps, mflLeague: "22689" });
    assert.equal(r.state, "live");
    assert.equal(r.delayed, false);
    assert.ok(w.calls.some(c => c.includes('nfl_players?espn_id=in.("1","3")')), "crosswalk fetched for the game's athletes only");
    assert.ok(!w.calls.some(c => /nfl_players\?select/.test(c)), "never the whole players table");
    const ps = w.writes.find(x => x.path.startsWith("player_scores"))!.body as { player_id: string; points: number; source: string }[];
    assert.equal(ps.find(p => p.player_id === "00-GOFF")!.points, 6);
    assert.ok(ps.every(p => p.source === "live"));
    assert.ok(ps.some(p => p.player_id === "DEF:ARI") && ps.some(p => p.player_id === "DEF:DET"));
    assert.ok(!ps.some(p => p.player_id.includes("3")), "the unmatched back is never credited");
    const rq = w.writes.find(x => x.path.startsWith("review_queue"))!.body as { provider: string; provider_id: string }[];
    assert.deepEqual(rq.map(x => [x.provider, x.provider_id]), [["espn", "3"]]);
    const slots = w.writes.find(x => x.path === "lineup_slots" && x.method === "POST")!.body as { team_id: string; slot: number; player_id: string }[];
    assert.deepEqual(slots.map(s => [s.team_id, s.slot, s.player_id]), [["0011", 0, "00-GOFF"], ["0011", 8, "DEF:ARI"]]);
    assert.deepEqual(r.errors, ["MFL starters not mapped: 0005:m9"]);
    const m = w.writes.find(x => x.path.startsWith("matchups"))!.body as { home_score: number; away_score: number }[];
    assert.deepEqual([m[0]!.home_score, m[0]!.away_score], [9.5, 0]);
    const sw = w.writes.find(x => x.path.startsWith("score_weeks"))!.body as { status: string; live_delayed: boolean }[];
    assert.deepEqual([sw[0]!.status, sw[0]!.live_delayed], ["live", false]);
    assert.equal(w.writes.find(x => x.path.startsWith("live_games")), undefined, "an in-progress game isn't marked captured");
  });

  test("a game ESPN fails on is marked delayed and not written (its last good numbers stay)", async () => {
    const w = world({ events: [ev("401", "in", -1)], failSummary: true });
    const r = await runLive(w.deps);
    assert.equal(r.delayed, true);
    assert.equal(r.failedGames, 1);
    assert.equal(w.writes.find(x => x.path.startsWith("player_scores")), undefined);
    assert.equal((w.writes.find(x => x.path.startsWith("score_weeks"))!.body as { live_delayed: boolean }[])[0]!.live_delayed, true);
  });

  test("never throws, even when every database write fails", async () => {
    const w = world({ events: [ev("401", "in", -1)], failWrites: true });
    const r = await runLive(w.deps);
    assert.equal(r.delayed, true);
    assert.match(r.errors.join(" "), /HTTP 500/);
  });
});

describe("edge handler (only the database's scheduler may run it)", () => {
  const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_t" };
  const N = "0b4e7c1a-1111-4222-8333-944445555666";
  const post = (body: unknown) => new Request("https://x.supabase.co/functions/v1/b5-live", { method: "POST", body: JSON.stringify(body) });

  test("a fresh nonce from pg_cron runs one pass; it can't be replayed", async () => {
    const w = world({ events: [ev("401", "pre", 3)], nonces: [N] });
    const r1 = await handle(post({ nonce: N }), env, w.f, () => NOW);
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { state: string }).state, "idle");
    const r2 = await handle(post({ nonce: N }), env, w.f, () => NOW);
    assert.equal(r2.status, 401);
  });

  test("no nonce, a made-up nonce, a GET, or missing config: refused without touching ESPN", async () => {
    const w = world({ events: [ev("401", "in", -1)] });
    assert.equal((await handle(post({}), env, w.f, () => NOW)).status, 401);
    assert.equal((await handle(post({ nonce: N }), env, w.f, () => NOW)).status, 401);
    assert.equal((await handle(post({ nonce: "x'; drop" }), env, w.f, () => NOW)).status, 401);
    assert.equal((await handle(new Request("https://x/f", { method: "GET" }), env, w.f, () => NOW)).status, 405);
    assert.equal((await handle(post({ nonce: N }), {}, w.f, () => NOW)).status, 500);
    assert.ok(!w.calls.some(c => c.includes("espn.com")));
  });
});

test("ESPN athlete IDs are collected from the box score and scoring events", () => {
  const ids = espnIds({ players: [{ player: { provider: "espn", id: "1", name: "a" } }], events: [{ kind: "fg", team: "DET", distance: 40, kicker: { provider: "espn", id: "9", name: "k" } }] } as never);
  assert.deepEqual(ids.sort(), ["1", "9"]);
});

test("team totals: starters' current points, missing = 0", () => {
  const t = teamTotals([{ team_id: "A", player_id: "p1" }, { team_id: "A", player_id: "p2" }, { team_id: "B", player_id: "p3" }], new Map([["p1", 10.1], ["p2", 0.2]]));
  assert.deepEqual([...t], [["A", 10.3], ["B", 0]]);
});

test("mirrored slots follow QB RB RB WR WR WR TE K DEF; unmapped or extra starters are reported", () => {
  const r = mirrorSlots(2026, 7, [{ team: "A", mflIds: ["w1", "q", "w2", "w3", "w4", "x"] }],
    new Map([["w1", "W1"], ["w2", "W2"], ["w3", "W3"], ["w4", "W4"], ["q", "Q"]]), new Map([["W1", "WR"], ["W2", "WR"], ["W3", "WR"], ["W4", "WR"], ["Q", "QB"]]));
  assert.deepEqual(r.rows.map(x => [x.slot, x.player_id]), [[3, "W1"], [0, "Q"], [4, "W2"], [5, "W3"]]);
  assert.deepEqual(r.missing, ["A:w4", "A:x"]);
});
