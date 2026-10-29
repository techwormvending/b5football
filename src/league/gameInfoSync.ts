/* Refresh public.nfl_game_info (Edge job "game_info", every 3 hours in season via pg_cron
   b5-game-info; the live scorer also refreshes records and lines on every pass).
   For this week and next: the ESPN scoreboard -> records, venue/roof/surface, the betting line;
   then a kickoff forecast for each outdoor or retractable-roof game that hasn't started and kicks
   off within 8 days (ESPN's forecast + Open-Meteo at the stadium; one Open-Meteo call per stadium
   and day). Domes get no forecast ("Indoors"). Lines and forecasts are only overwritten when a new
   one exists, so a game keeps its last line and forecast. Never throws per game: problems are
   returned in `errors`. */

import { infoFromEvent, mergeWeather, meteoAt, openMeteoUrl, type EspnEvent, type InfoRow, type OddsRow } from "./gameInfo.ts";
import { sbBase, sbHeaders, type SbConfig } from "./supabaseRest.ts";

const UA = { "User-Agent": "b5-fantasy-site/0.1 (private league)" };
export const scoreboardUrl = (season: number, week: number) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;

/** Rows from one scoreboard: game info (no weather) and lines. */
export function rowsFromScoreboard(events: EspnEvent[], season: number, week: number, at: string): { info: InfoRow[]; odds: OddsRow[] } {
  const info: InfoRow[] = [], odds: OddsRow[] = [];
  for (const e of events) {
    const r = infoFromEvent(e, season, week, at);
    if (!r) continue;
    info.push(r.info);
    if (r.odds) odds.push(r.odds);
  }
  return { info, odds };
}

export async function upsertGameInfo(sb: SbConfig, f: typeof fetch, rows: { info: InfoRow[]; odds: OddsRow[] }) {
  const post = async (path: string, body: unknown[]) => {
    if (!body.length) return;
    const r = await f(sbBase(sb) + path, { method: "POST", headers: sbHeaders(sb, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  // Separate upserts: each only touches its own columns (a scoreboard without a line keeps the old line).
  await post("nfl_game_info?on_conflict=season,week,game_key", rows.info);
  await post("nfl_game_info?on_conflict=season,week,game_key", rows.odds);
}

export interface GameInfoResult { weeks: number[]; games: number; lines: number; forecasts: number; errors: string[] }

export async function runGameInfo(sb: SbConfig, season: number, o: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<GameInfoResult> {
  const f = o.fetchImpl ?? fetch, now = o.now ?? Date.now(), at = new Date(now).toISOString();
  const res: GameInfoResult = { weeks: [], games: 0, lines: 0, forecasts: 0, errors: [] };
  const gr = await f(sbBase(sb) + `nfl_games?season=eq.${season}&select=week,game_key,kickoff&limit=1000`, { headers: sbHeaders(sb) });
  if (!gr.ok) { res.errors.push(`nfl_games: HTTP ${gr.status}`); return res; }
  const games = (await gr.json()) as { week: number; game_key: string; kickoff: string | null }[];
  const last: Record<number, number> = {};
  for (const g of games) if (g.kickoff) last[g.week] = Math.max(last[g.week] ?? 0, Date.parse(g.kickoff));
  const weeks = Object.keys(last).map(Number).sort((a, b) => a - b);
  const cur = weeks.find(w => last[w]! + 5 * 3600e3 > now);
  if (cur == null) return res;
  res.weeks = weeks.filter(w => w === cur || w === cur + 1);
  const kickoff = new Map(games.map(g => [`${g.week}|${g.game_key}`, g.kickoff]));

  const weatherRows: { season: number; week: number; game_key: string; weather: unknown; weather_at: string }[] = [];
  const meteoCache = new Map<string, unknown>();
  for (const w of res.weeks) {
    let events: EspnEvent[];
    try {
      const r = await f(scoreboardUrl(season, w), { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      events = ((await r.json()) as { events?: EspnEvent[] }).events ?? [];
    } catch (err) { res.errors.push(`scoreboard week ${w}: ${(err as Error).message}`); continue; }
    const rows = rowsFromScoreboard(events, season, w, at);
    try { await upsertGameInfo(sb, f, rows); } catch (err) { res.errors.push((err as Error).message); continue; }
    res.games += rows.info.length; res.lines += rows.odds.length;
    for (const g of rows.info) {
      const k = kickoff.get(`${w}|${g.game_key}`);
      if (!k || g.roof === "dome" || g.lat == null || g.lon == null) continue;
      const t = Date.parse(k);
      if (t <= now || t - now > 8 * 86400e3) continue;   // started (keep the last forecast) or too far out
      const url = openMeteoUrl(g.lat, g.lon, new Date(t).toISOString());
      let meteo: ReturnType<typeof meteoAt> = null;
      try {
        if (!meteoCache.has(url)) {
          const r = await f(url, { headers: UA });
          meteoCache.set(url, r.ok ? await r.json() : null);
        }
        meteo = meteoAt(meteoCache.get(url), new Date(t).toISOString());
      } catch (err) { res.errors.push(`forecast ${g.game_key}: ${(err as Error).message}`); }
      const weather = mergeWeather(g.espn_weather, meteo);
      if (weather) weatherRows.push({ season, week: w, game_key: g.game_key, weather, weather_at: at });
    }
  }
  if (weatherRows.length) {
    const r = await f(sbBase(sb) + "nfl_game_info?on_conflict=season,week,game_key", { method: "POST", headers: sbHeaders(sb, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(weatherRows) });
    if (r.ok) res.forecasts = weatherRows.length; else res.errors.push(`forecasts: HTTP ${r.status}`);
  }
  return res;
}
