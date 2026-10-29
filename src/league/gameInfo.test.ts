import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findStadium, formatRecord, infoFromEvent, mergeWeather, meteoAt, openMeteoUrl, spreadText, type EspnEvent } from "./gameInfo.ts";
import { rowsFromScoreboard, runGameInfo } from "./gameInfoSync.ts";

// Trimmed from ESPN's 2026 week 9 scoreboard (2026-10-29).
const ev = (o: { away: string; home: string; aRec?: string; hRec?: string; odds?: unknown[]; venue?: unknown; neutral?: boolean; weather?: unknown; date?: string }): EspnEvent => ({
  date: o.date ?? "2026-11-01T18:00Z", ...(o.weather ? { weather: o.weather } : {}),
  competitions: [{ neutralSite: !!o.neutral, venue: o.venue as never, odds: (o.odds ?? []) as never,
    competitors: [{ homeAway: "home", team: { abbreviation: o.home }, records: o.hRec ? [{ type: "total", name: "overall", summary: o.hRec }, { type: "home", summary: "1-1" }] : [] },
                  { homeAway: "away", team: { abbreviation: o.away }, records: o.aRec ? [{ type: "total", name: "overall", summary: o.aRec }] : [] }] }]
});
const AT = "2026-10-29T15:00:00.000Z";

describe("records, lines, stadiums", () => {
  test("records as W-L, ties as W-L-T (a zero tie count dropped)", () => {
    assert.equal(formatRecord("5-2"), "5-2");
    assert.equal(formatRecord("4-2-1"), "4-2-1");
    assert.equal(formatRecord("5-2-0"), "5-2");
    assert.equal(formatRecord(""), null);
    const r = infoFromEvent(ev({ away: "NYG", home: "PHI", aRec: "4-2-1", hRec: "2-5" }), 2026, 9, AT)!;
    assert.deepEqual([r.info.away_record, r.info.home_record], ["4-2-1", "2-5"]);
  });
  test("the line in our team codes; no line -> no odds row", () => {
    assert.equal(spreadText("WSH -3"), "WAS -3");
    assert.equal(spreadText("KC -9.5"), "KC -9.5");
    assert.equal(spreadText("EVEN"), "Pick'em");
    const withLine = infoFromEvent(ev({ away: "JAX", home: "BAL", odds: [{ provider: { name: "DraftKings" }, details: "BAL -3", overUnder: 48.5 }] }), 2026, 9, AT)!;
    assert.deepEqual(withLine.odds, { season: 2026, week: 9, game_key: "JAX@BAL", spread: "BAL -3", over_under: 48.5, odds_provider: "DraftKings", odds_at: AT });
    assert.equal(infoFromEvent(ev({ away: "JAX", home: "BAL" }), 2026, 9, AT)!.odds, null, "missing odds");
  });
  test("stadiums: dome, retractable, outdoor; grass vs turf; renamed stadiums and the home-team fallback", () => {
    const venue = (n: string, city: string, country = "USA", indoor = false) => ({ fullName: n, address: { city, country }, indoor });
    const det = infoFromEvent(ev({ away: "GB", home: "DET", venue: venue("Ford Field", "Detroit", "USA", true) }), 2026, 9, AT)!.info;
    assert.deepEqual([det.roof, det.surface, det.intl], ["dome", "turf", null]);
    const ind = infoFromEvent(ev({ away: "DAL", home: "IND", venue: venue("Lucas Oil Stadium", "Indianapolis", "USA", true) }), 2026, 9, AT)!.info;
    assert.equal(ind.roof, "retractable", "ESPN says indoor; the table knows the roof opens");
    const kc = infoFromEvent(ev({ away: "NYJ", home: "KC", venue: venue("Arrowhead Stadium", "Kansas City") }), 2026, 9, AT)!.info;
    assert.deepEqual([kc.roof, kc.surface, kc.lat], ["outdoor", "grass", 39.0489]);
    assert.equal(findStadium("Some New Sponsor Field", "PIT", false)!.names[0], "Acrisure Stadium", "unknown name: the home team's stadium");
    assert.equal(findStadium("Some New Sponsor Field", "PIT", true), null, "neutral site: never guess");
  });
  test("international venue: labelled by city, with its roof and coordinates", () => {
    const r = infoFromEvent(ev({ away: "ATL", home: "CIN", neutral: true, venue: { fullName: "Santiago Bernabéu", address: { city: "Madrid", country: "Spain" }, indoor: true } }), 2026, 9, AT)!.info;
    assert.deepEqual([r.intl, r.roof, r.surface, r.venue_country], ["Madrid", "retractable", "grass", "Spain"]);
    const london = infoFromEvent(ev({ away: "CLE", home: "JAX", neutral: true, venue: { fullName: "Tottenham Hotspur Stadium", address: { city: "London", country: "England" } } }), 2026, 6, AT)!.info;
    assert.deepEqual([london.intl, london.roof], ["London", "outdoor"]);
  });
});

describe("weather", () => {
  const meteo = { hourly: { time: ["2026-11-01T17:00", "2026-11-01T18:00"], temperature_2m: [40, 22.6], precipitation_probability: [10, 70], weather_code: [3, 75], wind_speed_10m: [9, 17.4] } };
  test("Open-Meteo: the kickoff hour at the stadium", () => {
    assert.match(openMeteoUrl(42.7738, -78.787, "2026-11-01T18:00:00.000Z"), /latitude=42.7738&longitude=-78.787&.*temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT&start_date=2026-11-01&end_date=2026-11-01$/);
    assert.deepEqual(meteoAt(meteo, "2026-11-01T18:00:00.000Z"), { temp_f: 23, code: 75, wind_mph: 17, precip_pct: 70 });
    assert.equal(meteoAt(meteo, "2026-11-02T18:00:00.000Z"), null);
  });
  test("ESPN's forecast first, Open-Meteo fills wind and precip; heavy snow flagged", () => {
    const m = meteoAt(meteo, "2026-11-01T18:00:00.000Z");
    assert.deepEqual(mergeWeather({ temp_f: 64, condition: "Thunderstorms" }, m),
      { temp_f: 64, condition: "Thunderstorms", icon: "⛈️", wind_mph: 17, precip_pct: 70, heavy: true, source: "ESPN, Open-Meteo" });
    assert.deepEqual(mergeWeather(null, m), { temp_f: 23, condition: "Heavy snow", icon: "❄️", wind_mph: 17, precip_pct: 70, heavy: true, source: "Open-Meteo" });
    assert.equal(mergeWeather(null, null), null);
  });
  test("the job: lines and stadiums for this week and next; forecasts only for outdoor/retractable games not started; domes none", async () => {
    const NOW = Date.parse("2026-10-29T15:00:00Z");
    const posts: unknown[][] = [], urls: string[] = [];
    const J = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
    const f = (async (u: string, init: RequestInit = {}) => {
      urls.push(u);
      if (u.includes("/rest/v1/nfl_games")) return J([{ week: 8, game_key: "A@B", kickoff: "2026-10-26T00:20:00Z" }, { week: 9, game_key: "NYJ@KC", kickoff: "2026-11-01T18:00:00Z" },
        { week: 9, game_key: "GB@DET", kickoff: "2026-11-01T18:00:00Z" }, { week: 10, game_key: "X@Y", kickoff: "2026-11-08T18:00:00Z" }]);
      if (u.includes("/rest/v1/nfl_game_info")) { posts.push(JSON.parse(String(init.body))); return new Response(null, { status: 201 }); }
      if (u.includes("scoreboard") && u.includes("week=9")) return J({ events: [
        ev({ away: "NYJ", home: "KC", aRec: "2-5", hRec: "5-1", odds: [{ provider: { name: "DraftKings" }, details: "KC -9.5", overUnder: 43.5 }], venue: { fullName: "Arrowhead Stadium", address: { city: "Kansas City", country: "USA" } } }),
        ev({ away: "GB", home: "DET", venue: { fullName: "Ford Field", address: { city: "Detroit", country: "USA" }, indoor: true } })] });
      if (u.includes("scoreboard")) return J({ events: [] });
      if (u.includes("open-meteo")) return J(meteo);
      throw new Error("unexpected " + u);
    }) as typeof fetch;
    const r = await runGameInfo({ url: "https://x.supabase.co", serviceKey: "k" }, 2026, { fetchImpl: f, now: NOW });
    assert.deepEqual([r.weeks, r.games, r.lines, r.forecasts, r.errors], [[9, 10], 2, 1, 1, []]);
    assert.equal(urls.filter(u => u.includes("open-meteo")).length, 1, "only the outdoor game; the dome gets none");
    const wx = posts.at(-1) as { game_key: string; weather: { temp_f: number } }[];
    assert.deepEqual(wx.map(x => [x.game_key, x.weather.temp_f]), [["NYJ@KC", 23]]);
    assert.deepEqual((posts[1] as { spread: string }[]).map(x => x.spread), ["KC -9.5"], "lines upserted on their own (a game without one keeps its old line)");
    assert.equal(rowsFromScoreboard([ev({ away: "XXX", home: "KC" })], 2026, 9, AT).info.length, 0, "unknown team codes are skipped");
  });
});
