import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareLineups, parseWeeklyLineups, runLineupImport } from "./lineupImport.ts";

// Shaped like MFL's public weeklyResults export (trimmed to 2 teams; the import is told teamCount 2).
const fr = (id: string, score: string | null, starters: [string, string][]) => ({
  id, ...(score == null ? {} : { score }), starters: starters.map(s => s[0]).join(",") + ",",
  player: [...starters.map(([pid, pts]) => ({ id: pid, status: "starter", score: pts })), { id: "9999", status: "nonstarter", score: "40" }]
});
const RESULTS = (score2: string | null = "15.5") => ({ weeklyResults: { week: "6", matchup: [{ franchise: [
  fr("0001", "20.0", [["m-qb", "12.0"], ["m-def", "8.0"]]),
  fr("0002", score2, [["m-wr", "15.5"]])] }] } });
const MAP: Record<string, [string, string]> = { "m-qb": ["QB-1", "QB"], "m-def": ["DEF:PIT", "DEF"], "m-wr": ["WR-1", "WR"] };

describe("weeklyResults parsing and comparison", () => {
  test("each franchise's starters in MFL's order, its score, and its starters' points (bench ignored)", () => {
    const { lineups, unposted } = parseWeeklyLineups(RESULTS());
    assert.deepEqual(unposted, []);
    assert.deepEqual(lineups.map(l => [l.team, l.score, l.mflIds, [...l.players]]), [
      ["0001", 20, ["m-qb", "m-def"], [["m-qb", 12], ["m-def", 8]]], ["0002", 15.5, ["m-wr"], [["m-wr", 15.5]]]]);
  });
  test("a week MFL hasn't posted (no score) is reported, not imported", () => {
    assert.deepEqual(parseWeeklyLineups(RESULTS(null)).unposted, ["0002"]);
  });
  test("our totals vs MFL's: only differences are listed", () => {
    const { lineups } = parseWeeklyLineups(RESULTS());
    assert.deepEqual(compareLineups(lineups, { "0001": 20, "0002": 15.5 }).mismatches, []);
    assert.deepEqual(compareLineups(lineups, { "0001": 19, "0002": 15.5 }).mismatches, [{ team_id: "0001", ours: 19, mfl: 20 }]);
  });
});

describe("runLineupImport: the Tuesday swap happens only after a successful import", () => {
  function world(opts: { mfl?: "down" | "unposted" | "ok"; unmapped?: boolean; ourTotals?: Record<string, number> } = {}) {
    const posts: { path: string; body: unknown }[] = [];
    const J = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    const f = (async (u: string, init: RequestInit = {}) => {
      if (u.includes("TYPE=weeklyResults")) {
        assert.match(u, /L=22689&W=6/);
        return opts.mfl === "down" ? new Response("down", { status: 503 }) : J(RESULTS(opts.mfl === "unposted" ? null : "15.5"));
      }
      const path = decodeURIComponent(u.replace(/^.*\/rest\/v1\//, ""));
      if (init.method === "POST") {
        posts.push({ path: path.replace(/\?.*$/, ""), body: JSON.parse(String(init.body)) });
        if (path.startsWith("rpc/replace_week_lineups")) return J({ archived_test: 2, totals: opts.ourTotals ?? { "0001": 20, "0002": 15.5 } });
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("lineup_imports")) return J([{ attempts: 1 }]);
      if (path.startsWith("mfl_player_map")) return J(Object.entries(MAP).filter(([m]) => !(opts.unmapped && m === "m-wr")).map(([m, [p]]) => ({ mfl_id: m, player_id: p })));
      if (path.startsWith("nfl_players")) return J(Object.values(MAP).map(([id, position]) => ({ id, position })));
      if (path.startsWith("player_scores")) return J([{ player_id: "QB-1", points: 11 }, { player_id: "DEF:PIT", points: 8 }]);
      throw new Error("unexpected " + u);
    }) as typeof fetch;
    return { f, posts };
  }
  const SB = { url: "https://x.supabase.co", serviceKey: "k" };
  const run = (w: ReturnType<typeof world>) => runLineupImport(SB, 2026, 6, { fetchImpl: w.f, now: Date.parse("2026-10-20T10:00:00Z"), teamCount: 2, by: "schedule" });

  test("success: the official lineups replace the test ones, then the comparison is logged", async () => {
    const w = world();
    const r = await run(w);
    assert.equal(r.status, "ok");
    const swap = w.posts.find(p => p.path === "rpc/replace_week_lineups")!.body as { p_rows: unknown[] };
    assert.deepEqual(swap.p_rows, [{ team_id: "0001", slot: 0, player_id: "QB-1" }, { team_id: "0001", slot: 8, player_id: "DEF:PIT" }, { team_id: "0002", slot: 3, player_id: "WR-1" }]);
    const log = (w.posts.at(-1)!.body as Record<string, unknown>[])[0]!;
    assert.equal(log.status, "ok");
    assert.equal(log.attempts, 2);
    assert.equal(log.archived_test, 2);
    assert.match(String(log.message), /every team matches MFL's scores/);
  });

  for (const [what, opts, re] of [
    ["MFL is down", { mfl: "down" as const }, /weeklyResults: HTTP 503/],
    ["MFL hasn't posted the week", { mfl: "unposted" as const }, /hasn't posted week 6/],
    ["a starter can't be mapped", { unmapped: true }, /unmapped or unplaceable MFL starters: 0002:m-wr/]
  ] as const) {
    test(`failure (${what}): test lineups kept, nothing replaced, logged as failed`, async () => {
      const w = world(opts);
      const r = await run(w);
      assert.equal(r.status, "failed");
      assert.equal(w.posts.some(p => p.path === "rpc/replace_week_lineups"), false, "no swap");
      const log = (w.posts.at(-1)!.body as Record<string, unknown>[])[0]!;
      assert.equal(log.status, "failed");
      assert.match(String(log.message), /test lineups kept/);
      assert.match(String(log.message), re);
    });
  }

  test("a team whose total differs from MFL's is listed with the players that differ", async () => {
    const w = world({ ourTotals: { "0001": 19, "0002": 15.5 } });
    const r = await run(w);
    const c = r.compare as { mismatches: unknown[] };
    assert.deepEqual(c.mismatches, [{ team_id: "0001", ours: 19, mfl: 20, players: [{ player_id: "QB-1", mfl_id: "m-qb", ours: 11, mfl: 12 }] }]);
    assert.match(r.message, /1 team\(s\) differ/);
  });
});
