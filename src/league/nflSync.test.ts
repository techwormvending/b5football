import { test } from "node:test";
import assert from "node:assert/strict";
import { easternToIso, gamesFromRows, playersFromRows, upsert } from "./nflSync.ts";

test("Eastern kickoff times convert to UTC across daylight saving", () => {
  assert.equal(easternToIso("2026-09-13", "13:00"), "2026-09-13T17:00:00.000Z");   // EDT, UTC-4
  assert.equal(easternToIso("2026-12-27", "20:20"), "2026-12-28T01:20:00.000Z");   // EST, UTC-5
  assert.equal(easternToIso("2026-11-01", "13:00"), "2026-11-01T18:00:00.000Z");   // DST ended 2 AM that day
  assert.equal(easternToIso("2026-09-13", "9:30"), "2026-09-13T13:30:00.000Z");    // London game
  assert.equal(easternToIso("", "13:00"), null);
  assert.equal(easternToIso("2026-09-13", "NA"), null);
});

test("games: regular season only, canonical codes, AWAY@HOME keys, final when scored", () => {
  const g = gamesFromRows([
    { season: "2026", game_type: "REG", week: "1", gameday: "2026-09-10", gametime: "20:35", away_team: "SF", away_score: "27", home_team: "LA", home_score: "7" },
    { season: "2026", game_type: "REG", week: "7", gameday: "2026-10-18", gametime: "13:00", away_team: "PIT", away_score: "NA", home_team: "CIN", home_score: "NA" },
    { season: "2026", game_type: "REG", week: "8", gameday: "2026-10-25", gametime: "13:00", away_team: "WAS", away_score: "", home_team: "NYG", home_score: "" },
    { season: "2026", game_type: "WC", week: "19", gameday: "2027-01-09", gametime: "16:30", away_team: "PIT", away_score: "", home_team: "BAL", home_score: "" },
    { season: "2025", game_type: "REG", week: "1", gameday: "2025-09-04", gametime: "20:20", away_team: "DAL", away_score: "20", home_team: "PHI", home_score: "24" }
  ], 2026);
  assert.deepEqual(g, [
    { season: 2026, week: 1, game_key: "SF@LAR", home: "LAR", away: "SF", kickoff: "2026-09-11T00:35:00.000Z", status: "final", home_score: 7, away_score: 27 },
    { season: 2026, week: 7, game_key: "PIT@CIN", home: "CIN", away: "PIT", kickoff: "2026-10-18T17:00:00.000Z", status: "scheduled", home_score: null, away_score: null },
    { season: 2026, week: 8, game_key: "WAS@NYG", home: "NYG", away: "WAS", kickoff: "2026-10-25T17:00:00.000Z", status: "scheduled", home_score: null, away_score: null }
  ]);
});

test("players: fantasy positions (fullbacks as RB), recent or incoming only, canonical team, ambiguous ESPN IDs dropped, plus 32 defenses", () => {
  const p = playersFromRows([
    { gsis_id: "00-1", espn_id: "111", display_name: "Aaron Rodgers", position: "QB", latest_team: "PIT", last_season: "2026", rookie_season: "2005", draft_year: "2005" },
    { gsis_id: "00-2", espn_id: "222", display_name: "Puka Nacua", position: "WR", latest_team: "LA", last_season: "2025", rookie_season: "2023", draft_year: "2023" },
    { gsis_id: "00-3", espn_id: "", display_name: "Rookie Back", position: "RB", latest_team: "", last_season: "", rookie_season: "2027", draft_year: "2027" },
    { gsis_id: "00-4", espn_id: "444", display_name: "Retired Guy", position: "TE", latest_team: "NE", last_season: "2019", rookie_season: "2010", draft_year: "2010" },
    { gsis_id: "00-5", espn_id: "555", display_name: "Lineman", position: "OT", latest_team: "PIT", last_season: "2026", rookie_season: "2020", draft_year: "2020" },
    { gsis_id: "00-6", espn_id: "666", display_name: "Twin A", position: "K", latest_team: "BAL", last_season: "2026", rookie_season: "2012", draft_year: "" },
    { gsis_id: "00-7", espn_id: "666", display_name: "Twin B", position: "K", latest_team: "XXX", last_season: "2026", rookie_season: "2020", draft_year: "" },
    { gsis_id: "00-8", espn_id: "", display_name: "Kyle Juszczyk", position: "FB", latest_team: "SF", last_season: "2026", rookie_season: "2013", draft_year: "2013" },
    { gsis_id: "", espn_id: "888", display_name: "No ID", position: "QB", latest_team: "PIT", last_season: "2026", rookie_season: "2026", draft_year: "" }
  ], 2026);
  const players = p.filter(x => x.position !== "DEF");
  assert.deepEqual(players, [
    { id: "00-1", espn_id: "111", name: "Aaron Rodgers", position: "QB", nfl_team: "PIT" },
    { id: "00-2", espn_id: "222", name: "Puka Nacua", position: "WR", nfl_team: "LAR" },
    { id: "00-3", espn_id: null, name: "Rookie Back", position: "RB", nfl_team: null },
    { id: "00-6", espn_id: null, name: "Twin A", position: "K", nfl_team: "BAL" },
    { id: "00-7", espn_id: null, name: "Twin B", position: "K", nfl_team: null },
    { id: "00-8", espn_id: null, name: "Kyle Juszczyk", position: "RB", nfl_team: "SF" }
  ]);
  const defs = p.filter(x => x.position === "DEF");
  assert.equal(defs.length, 32);
  assert.deepEqual(defs.find(d => d.nfl_team === "PIT"), { id: "DEF:PIT", espn_id: null, name: "PIT Defense", position: "DEF", nfl_team: "PIT" });
});

test("upsert batches through the Data API as service_role and reports failures", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
  const n = await upsert({ url: "https://x.supabase.co/rest/v1/", serviceKey: "sb_secret_test" }, "nfl_games", [{ a: 1 }, { a: 2 }, { a: 3 }], "season,week,game_key", ok, 2);
  assert.equal(n, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://x.supabase.co/rest/v1/nfl_games?on_conflict=season,week,game_key");
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h.apikey, "sb_secret_test");
  assert.equal(h.Authorization, undefined, "sb_secret_ keys go in apikey only");
  assert.match(h.Prefer!, /merge-duplicates/);
  const bad = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(upsert({ url: "https://x.supabase.co", serviceKey: "eyJx" }, "nfl_players", [{}], "id", bad), /nfl_players: HTTP 403/);
});
