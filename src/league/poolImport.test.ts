import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { comparePool, parsePoolPage, runPoolImport } from "./poolImport.ts";

// Shaped like MFL's public pool results page (options?L=22689&O=122), trimmed.
const row = (id: string, name: string, cells: string[]) =>
  `<tr class="oddtablerow"><td><a class="franchise_${id} " href="x">${name}</a></td>${cells.map((c, i) => `<td${i === cells.length - 1 ? ' class="points"' : ""}>${c}</td>`).join("")}</tr>`;
const PAGE = `<html><body>
<table class="report"><caption><span>NFL Confidence Pool Summary</span></caption><tbody>
<tr><th>Franchise/Week</th><th><a>1</a></th><th><a>2</a></th><th>Total</th></tr>
${row("0001", "NSFW", ["10", "3", "13"])}${row("0002", "Puka&rsquo;s Brain Worm", ["7", "5", "12"])}
</tbody></table>
<table class="report" id="week2"><caption><span>Week 2 NFL Picks</span></caption><tbody>
<tr><th>Franchise</th><th>NEP @ SEA</th><th>SFO @ LAR</th><th>Total</th></tr>
${row("0001", "NSFW", ["SEA (2)", "SFO (1)", "3"])}${row("0002", "Puka&rsquo;s Brain Worm", ["NEP (1)", "LAR (2)", "5"])}${row("0012", "Giddy Up", ["", "", "0"])}
</tbody></table></body></html>`;

describe("MFL results page", () => {
  test("summary by franchise ID, and each week's picks with MFL codes mapped to ours", () => {
    const p = parsePoolPage(PAGE);
    assert.deepEqual(p.summary.get("0002"), { weeks: [7, 5], total: 12 });
    assert.deepEqual(p.weeks.get(2)!.picks, [
      { team_id: "0001", game_key: "NE@SEA", pick: "SEA", points: 2 }, { team_id: "0001", game_key: "SF@LAR", pick: "SF", points: 1 },
      { team_id: "0002", game_key: "NE@SEA", pick: "NE", points: 1 }, { team_id: "0002", game_key: "SF@LAR", pick: "LAR", points: 2 }]);
    assert.deepEqual([...p.weeks.get(2)!.totals], [["0001", 3], ["0002", 5], ["0012", 0]]);
  });
  test("a page without the pool tables parses to nothing (e.g. a login or error page)", () => {
    const p = parsePoolPage("<html><body><table><caption>Login</caption></table></body></html>");
    assert.equal(p.summary.size + p.weeks.size, 0);
  });
});

describe("comparison with MFL's results", () => {
  const page = parsePoolPage(PAGE);
  test("matching weekly totals and season standings: no mismatches", () => {
    const r = comparePool(2, { week: new Map([["0001", 3], ["0002", 5]]), season: new Map([["0001", 13], ["0002", 12]]) }, page, ["0001", "0002"]);
    assert.deepEqual(r, { checked: true, mismatches: [] });
  });
  test("a difference is listed with both numbers", () => {
    const r = comparePool(2, { week: new Map([["0001", 3], ["0002", 4]]), season: new Map([["0001", 13], ["0002", 11]]) }, page, ["0001", "0002"]);
    assert.deepEqual(r.mismatches, [{ team_id: "0002", what: "week", ours: 4, mfl: 5 }, { team_id: "0002", what: "season", ours: 11, mfl: 12 }]);
  });
  test("no results page: not compared, said so", () => {
    assert.equal(comparePool(2, { week: new Map(), season: new Map() }, null, []).checked, false);
  });
});

describe("runPoolImport", () => {
  const EXPORT = { poolPicks: { franchise: [
    { id: "0001", week: { week: "2", game: [{ matchup: "NEP,SEA", pick: "SEA", rank: "2" }, { matchup: "SFO,LAR", pick: "SFO", rank: "1" }] } },
    { id: "0002", week: { week: "2", game: [{ matchup: "NEP,SEA", pick: "NEP", rank: "1" }, { matchup: "SFO,LAR", pick: "LAR", rank: "2" }] } }] } };
  function world(opts: { exportOk?: boolean; pageOk?: boolean } = {}) {
    const posts: { path: string; body: unknown }[] = [];
    const J = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    const f = (async (u: string, init: RequestInit = {}) => {
      if (u.includes("export?TYPE=pool")) return opts.exportOk === false ? new Response("down", { status: 503 }) : J(EXPORT);
      if (u.includes("O=122")) return opts.pageOk === false ? new Response("down", { status: 503 }) : new Response(PAGE);
      const path = u.replace(/^.*\/rest\/v1\//, "");
      if (init.method === "POST") { posts.push({ path: path.replace(/\?.*$/, ""), body: JSON.parse(String(init.body)) }); return path.startsWith("rpc/replace_week_confidence") ? J(3) : new Response(null, { status: 204 }); }
      if (path.startsWith("confidence_scores")) return J([{ week: 1, team_id: "0001", points: 10 }, { week: 1, team_id: "0002", points: 7 }, { week: 2, team_id: "0001", points: 3 }, { week: 2, team_id: "0002", points: 5 }]);
      if (path.startsWith("teams")) return J([{ id: "0001" }, { id: "0002" }]);
      return J([]);   // pool_imports (no earlier attempt), season_settings (none: payouts skipped)
    }) as unknown as typeof fetch;
    return { f, posts };
  }
  const sb = { url: "https://x.supabase.co", serviceKey: "sb_secret_t" };

  test("export works: the week's picks are replaced (test picks removed), scored, compared, logged ok", async () => {
    const w = world();
    const r = await runPoolImport(sb, 2026, 2, { fetchImpl: w.f, by: "commissioner" });
    assert.deepEqual([r.status, r.source, r.picks, r.teams, r.replacedTest], ["ok", "export", 4, 2, 3]);
    const replace = w.posts.find(p => p.path === "rpc/replace_week_confidence")!.body as { p_week: number; p_rows: unknown[] };
    assert.equal(replace.p_week, 2);
    assert.equal(replace.p_rows.length, 4);
    assert.deepEqual(r.compare, { checked: true, mismatches: [] });
    const log = (w.posts.find(p => p.path === "pool_imports")!.body as { status: string; triggered_by: string; attempts: number }[])[0]!;
    assert.deepEqual([log.status, log.triggered_by, log.attempts], ["ok", "commissioner", 1]);
  });

  test("export down: falls back to the public results page", async () => {
    const r = await runPoolImport(sb, 2026, 2, { fetchImpl: world({ exportOk: false }).f });
    assert.deepEqual([r.status, r.source, r.picks], ["ok", "page", 4]);
  });

  test("both down: nothing replaced, test picks kept, failure logged (the schedule retries)", async () => {
    const w = world({ exportOk: false, pageOk: false });
    const r = await runPoolImport(sb, 2026, 2, { fetchImpl: w.f });
    assert.equal(r.status, "failed");
    assert.match(r.message, /test picks kept/);
    assert.equal(w.posts.find(p => p.path === "rpc/replace_week_confidence"), undefined);
    assert.equal((w.posts.find(p => p.path === "pool_imports")!.body as { status: string }[])[0]!.status, "failed");
  });

  test("a week MFL doesn't have yet fails cleanly", async () => {
    const r = await runPoolImport(sb, 2026, 9, { fetchImpl: world().f });
    assert.equal(r.status, "failed");
    assert.match(r.message, /no week 9 picks/);
  });
});
