/* Game details for the Confidence Pool's game cards (2026-10-29): each team's record, the betting
   line, the stadium (roof and surface) and the kickoff forecast. INFO ONLY: we pick straight up,
   lines never affect scoring.

   Sources: the ESPN scoreboard (records, odds with provider, venue with an indoor flag, and a short
   forecast for near-term games) plus a static table of NFL and international stadiums (roof type:
   dome / retractable / outdoor, grass vs turf, coordinates; ESPN's scoreboard has no grass flag and
   calls retractable roofs "indoor"). Weather for outdoor and retractable-roof games: ESPN's forecast
   when present (temperature, conditions), with wind and chance of precipitation from Open-Meteo
   (free, no key) at the stadium's coordinates for the kickoff hour; Open-Meteo alone when ESPN has
   none. Everything is written to public.nfl_game_info by server jobs; browsers never call ESPN or
   Open-Meteo for this. */

import { team as canon } from "../ingest/teams.ts";

export type Roof = "dome" | "retractable" | "outdoor";
export interface Stadium { names: string[]; teams?: string[]; roof: Roof; surface: "grass" | "turf"; lat: number; lon: number; city: string; country?: string }

// Coordinates are approximate (a few hundred metres is plenty for a forecast). Sponsors rename
// stadiums: every name ESPN has used is matched loosely, with the home team as a fallback.
export const STADIUMS: Stadium[] = [
  { names: ["State Farm Stadium"], teams: ["ARI"], roof: "retractable", surface: "grass", lat: 33.5276, lon: -112.2626, city: "Glendale" },
  { names: ["Mercedes-Benz Stadium"], teams: ["ATL"], roof: "retractable", surface: "turf", lat: 33.7554, lon: -84.4008, city: "Atlanta" },
  { names: ["M&T Bank Stadium"], teams: ["BAL"], roof: "outdoor", surface: "grass", lat: 39.2780, lon: -76.6227, city: "Baltimore" },
  { names: ["Highmark Stadium", "New Highmark Stadium"], teams: ["BUF"], roof: "outdoor", surface: "turf", lat: 42.7738, lon: -78.7870, city: "Orchard Park" },
  { names: ["Bank of America Stadium"], teams: ["CAR"], roof: "outdoor", surface: "turf", lat: 35.2258, lon: -80.8528, city: "Charlotte" },
  { names: ["Soldier Field"], teams: ["CHI"], roof: "outdoor", surface: "grass", lat: 41.8623, lon: -87.6167, city: "Chicago" },
  { names: ["Paycor Stadium"], teams: ["CIN"], roof: "outdoor", surface: "turf", lat: 39.0955, lon: -84.5161, city: "Cincinnati" },
  { names: ["Huntington Bank Field", "Cleveland Browns Stadium", "FirstEnergy Stadium"], teams: ["CLE"], roof: "outdoor", surface: "grass", lat: 41.5061, lon: -81.6995, city: "Cleveland" },
  { names: ["AT&T Stadium"], teams: ["DAL"], roof: "retractable", surface: "turf", lat: 32.7473, lon: -97.0945, city: "Arlington" },
  { names: ["Empower Field at Mile High"], teams: ["DEN"], roof: "outdoor", surface: "grass", lat: 39.7439, lon: -105.0201, city: "Denver" },
  { names: ["Ford Field"], teams: ["DET"], roof: "dome", surface: "turf", lat: 42.3400, lon: -83.0456, city: "Detroit" },
  { names: ["Lambeau Field"], teams: ["GB"], roof: "outdoor", surface: "grass", lat: 44.5013, lon: -88.0622, city: "Green Bay" },
  { names: ["NRG Stadium"], teams: ["HOU"], roof: "retractable", surface: "turf", lat: 29.6847, lon: -95.4107, city: "Houston" },
  { names: ["Lucas Oil Stadium"], teams: ["IND"], roof: "retractable", surface: "turf", lat: 39.7601, lon: -86.1639, city: "Indianapolis" },
  { names: ["EverBank Stadium", "TIAA Bank Field"], teams: ["JAX"], roof: "outdoor", surface: "grass", lat: 30.3239, lon: -81.6373, city: "Jacksonville" },
  { names: ["GEHA Field at Arrowhead Stadium", "Arrowhead Stadium"], teams: ["KC"], roof: "outdoor", surface: "grass", lat: 39.0489, lon: -94.4839, city: "Kansas City" },
  { names: ["Allegiant Stadium"], teams: ["LV"], roof: "dome", surface: "grass", lat: 36.0909, lon: -115.1833, city: "Las Vegas" },
  { names: ["SoFi Stadium"], teams: ["LAR", "LAC"], roof: "dome", surface: "turf", lat: 33.9535, lon: -118.3392, city: "Inglewood" },
  { names: ["Hard Rock Stadium"], teams: ["MIA"], roof: "outdoor", surface: "grass", lat: 25.9580, lon: -80.2389, city: "Miami Gardens" },
  { names: ["U.S. Bank Stadium"], teams: ["MIN"], roof: "dome", surface: "turf", lat: 44.9737, lon: -93.2575, city: "Minneapolis" },
  { names: ["Gillette Stadium"], teams: ["NE"], roof: "outdoor", surface: "turf", lat: 42.0909, lon: -71.2643, city: "Foxborough" },
  { names: ["Caesars Superdome"], teams: ["NO"], roof: "dome", surface: "turf", lat: 29.9511, lon: -90.0812, city: "New Orleans" },
  { names: ["MetLife Stadium"], teams: ["NYG", "NYJ"], roof: "outdoor", surface: "turf", lat: 40.8135, lon: -74.0745, city: "East Rutherford" },
  { names: ["Lincoln Financial Field"], teams: ["PHI"], roof: "outdoor", surface: "grass", lat: 39.9008, lon: -75.1675, city: "Philadelphia" },
  { names: ["Acrisure Stadium", "Heinz Field"], teams: ["PIT"], roof: "outdoor", surface: "grass", lat: 40.4468, lon: -80.0158, city: "Pittsburgh" },
  { names: ["Levi's Stadium"], teams: ["SF"], roof: "outdoor", surface: "grass", lat: 37.4030, lon: -121.9700, city: "Santa Clara" },
  { names: ["Lumen Field"], teams: ["SEA"], roof: "outdoor", surface: "turf", lat: 47.5952, lon: -122.3316, city: "Seattle" },
  { names: ["Raymond James Stadium"], teams: ["TB"], roof: "outdoor", surface: "grass", lat: 27.9759, lon: -82.5033, city: "Tampa" },
  { names: ["Nissan Stadium"], teams: ["TEN"], roof: "outdoor", surface: "turf", lat: 36.1665, lon: -86.7713, city: "Nashville" },
  { names: ["Northwest Stadium", "FedExField", "Commanders Field"], teams: ["WAS"], roof: "outdoor", surface: "grass", lat: 38.9077, lon: -76.8645, city: "Landover" },
  // International games (neutral sites)
  { names: ["Tottenham Hotspur Stadium"], roof: "outdoor", surface: "turf", lat: 51.6043, lon: -0.0664, city: "London", country: "England" },
  { names: ["Wembley Stadium"], roof: "outdoor", surface: "grass", lat: 51.5560, lon: -0.2796, city: "London", country: "England" },
  { names: ["Allianz Arena"], roof: "outdoor", surface: "grass", lat: 48.2188, lon: 11.6247, city: "Munich", country: "Germany" },
  { names: ["Deutsche Bank Park"], roof: "retractable", surface: "grass", lat: 50.0686, lon: 8.6455, city: "Frankfurt", country: "Germany" },
  { names: ["Olympiastadion", "Olympic Stadium Berlin"], roof: "outdoor", surface: "grass", lat: 52.5147, lon: 13.2395, city: "Berlin", country: "Germany" },
  { names: ["Santiago Bernabéu", "Santiago Bernabeu", "Estadio Santiago Bernabéu"], roof: "retractable", surface: "grass", lat: 40.4531, lon: -3.6883, city: "Madrid", country: "Spain" },
  { names: ["Croke Park"], roof: "outdoor", surface: "grass", lat: 53.3607, lon: -6.2511, city: "Dublin", country: "Ireland" },
  { names: ["Neo Química Arena", "Arena Corinthians"], roof: "outdoor", surface: "grass", lat: -23.5453, lon: -46.4742, city: "São Paulo", country: "Brazil" },
  { names: ["Maracanã", "Estádio do Maracanã"], roof: "outdoor", surface: "grass", lat: -22.9122, lon: -43.2302, city: "Rio de Janeiro", country: "Brazil" },
  { names: ["Estadio Azteca", "Estadio Banorte"], roof: "outdoor", surface: "grass", lat: 19.3029, lon: -99.1505, city: "Mexico City", country: "Mexico" },
  { names: ["Melbourne Cricket Ground", "MCG"], roof: "outdoor", surface: "grass", lat: -37.8200, lon: 144.9834, city: "Melbourne", country: "Australia" }
];
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The stadium: by ESPN's venue name, else (not at a neutral site) by the home team. */
export function findStadium(venueName: string | undefined, home: string, neutral: boolean): Stadium | null {
  const v = norm(venueName ?? "");
  if (v) {
    const hit = STADIUMS.find(s => s.names.some(n => { const k = norm(n); return k === v || (k.length > 5 && (v.includes(k) || k.includes(v))); }));
    if (hit) return hit;
  }
  return neutral ? null : STADIUMS.find(s => (s.teams ?? []).includes(home)) ?? null;
}

/** ESPN's overall record summary as W-L(-T): "5-2", "4-2-1"; a 0 tie count is dropped. */
export function formatRecord(summary: string | null | undefined): string | null {
  const m = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(String(summary ?? "").trim());
  if (!m) return null;
  return m[3] && m[3] !== "0" ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

// ---- ESPN scoreboard event -> rows ------------------------------------------------------
interface EspnCompetitor { homeAway?: string; team?: { abbreviation?: string }; records?: { type?: string; name?: string; summary?: string }[] }
interface EspnOdds { provider?: { name?: string }; details?: string; overUnder?: number }
interface EspnVenue { fullName?: string; address?: { city?: string; state?: string; country?: string }; indoor?: boolean; grass?: boolean }
export interface EspnEvent {
  date?: string; weather?: { displayValue?: string; temperature?: number; conditionId?: string };
  competitions?: { neutralSite?: boolean; venue?: EspnVenue; odds?: EspnOdds[]; competitors?: EspnCompetitor[]; status?: { type?: { state?: string } } }[];
}
export interface InfoRow {
  season: number; week: number; game_key: string;
  away_record: string | null; home_record: string | null;
  venue_name: string | null; venue_city: string | null; venue_country: string | null; intl: string | null;
  roof: Roof | null; surface: "grass" | "turf" | null; lat: number | null; lon: number | null;
  espn_weather: { temp_f: number | null; condition: string | null } | null;
  updated_at: string;
}
export interface OddsRow { season: number; week: number; game_key: string; spread: string | null; over_under: number | null; odds_provider: string | null; odds_at: string }

const overall = (c?: EspnCompetitor) => formatRecord((c?.records ?? []).find(r => r.type === "total" || r.name === "overall")?.summary);

/** "BAL -3" -> "BAL -3" in our team codes ("WSH -3" -> "WAS -3"); "EVEN"/"PK" -> "Pick'em". */
export function spreadText(details: string | undefined): string | null {
  const d = String(details ?? "").trim();
  if (!d) return null;
  if (/^(even|pk|pick)/i.test(d)) return "Pick'em";
  const m = /^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/.exec(d);
  if (!m) return d;
  try { return `${canon(m[1]!)} ${m[2]}`; } catch { return d; }
}

/** One scoreboard event -> the game-info row (and the odds row when ESPN lists a line). */
export function infoFromEvent(e: EspnEvent, season: number, week: number, at: string): { info: InfoRow; odds: OddsRow | null } | null {
  const c = e.competitions?.[0];
  const h = c?.competitors?.find(x => x.homeAway === "home"), a = c?.competitors?.find(x => x.homeAway === "away");
  let home: string, away: string;
  try { home = canon(h?.team?.abbreviation ?? ""); away = canon(a?.team?.abbreviation ?? ""); } catch { return null; }
  const game_key = `${away}@${home}`, v = c?.venue, neutral = !!c?.neutralSite;
  const st = findStadium(v?.fullName, home, neutral);
  const country = v?.address?.country ?? st?.country ?? null;
  const intl = country && !/^(usa|united states)$/i.test(country) ? (st?.city ?? v?.address?.city ?? country) : null;
  const roof: Roof | null = st?.roof ?? (v?.indoor === true ? "dome" : v?.indoor === false ? "outdoor" : null);
  const surface = st?.surface ?? (v?.grass === true ? "grass" : v?.grass === false ? "turf" : null);
  const w = e.weather;
  const info: InfoRow = {
    season, week, game_key, away_record: overall(a), home_record: overall(h),
    venue_name: v?.fullName ?? null, venue_city: v?.address?.city ?? st?.city ?? null, venue_country: country, intl,
    roof, surface, lat: st?.lat ?? null, lon: st?.lon ?? null,
    espn_weather: w && (w.temperature != null || w.displayValue) ? { temp_f: w.temperature ?? null, condition: w.displayValue ?? null } : null,
    updated_at: at
  };
  const o = (c?.odds ?? []).find(x => x.details || x.overUnder != null);
  const odds: OddsRow | null = o ? { season, week, game_key, spread: spreadText(o.details), over_under: o.overUnder ?? null, odds_provider: o.provider?.name ?? null, odds_at: at } : null;
  return { info, odds };
}

// ---- Weather ----------------------------------------------------------------------------
// WMO weather codes (Open-Meteo) -> words and an icon.
const WMO: Record<number, [string, string]> = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Cloudy", "☁️"], 45: ["Fog", "🌫️"], 48: ["Fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"], 56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"], 66: ["Freezing rain", "🌧️"], 67: ["Heavy freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"],
  80: ["Rain showers", "🌦️"], 81: ["Rain showers", "🌧️"], 82: ["Heavy rain showers", "🌧️"], 85: ["Snow showers", "🌨️"], 86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorms", "⛈️"], 96: ["Thunderstorms with hail", "⛈️"], 99: ["Thunderstorms with hail", "⛈️"]
};
export interface Weather { temp_f: number | null; condition: string | null; icon: string; wind_mph: number | null; precip_pct: number | null; heavy: boolean; source: string }

/** An icon for free-text conditions (ESPN's "Thunderstorms", "Partly sunny", ...). */
export function iconFor(text: string | null | undefined): string {
  const t = String(text ?? "").toLowerCase();
  return /thunder|t-storm/.test(t) ? "⛈️" : /snow|flurr|sleet|ice/.test(t) ? "🌨️" : /rain|shower|drizzle/.test(t) ? "🌧️" : /fog|haze|mist/.test(t) ? "🌫️"
    : /partly|intermittent|mostly sunny|mostly clear/.test(t) ? "⛅" : /cloud|overcast/.test(t) ? "☁️" : /sun|clear/.test(t) ? "☀️" : "🌡️";
}
/** Heavy rain or snow, from a WMO code or the words. */
export function isHeavy(code: number | null, text: string | null | undefined): boolean {
  if (code != null && [65, 67, 75, 82, 86, 95, 96, 99].includes(code)) return true;
  return /heavy|snow|blizzard|thunder|storm/i.test(String(text ?? "")) && !/light|chance|flurr/i.test(String(text ?? ""));
}

export function openMeteoUrl(lat: number, lon: number, kickoff: string): string {
  const day = kickoff.slice(0, 10);
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT&start_date=${day}&end_date=${day}`;
}
/** The kickoff hour from Open-Meteo's hourly forecast (times in GMT). */
export function meteoAt(json: unknown, kickoff: string): { temp_f: number | null; code: number | null; wind_mph: number | null; precip_pct: number | null } | null {
  const h = (json as { hourly?: { time?: string[]; temperature_2m?: number[]; precipitation_probability?: number[]; weather_code?: number[]; wind_speed_10m?: number[] } }).hourly;
  if (!h?.time?.length) return null;
  const want = kickoff.slice(0, 13);   // "2026-11-01T18"
  const i = h.time.findIndex(t => t.slice(0, 13) === want);
  if (i < 0) return null;
  const n = (x: number | undefined) => (x == null || Number.isNaN(x) ? null : Math.round(x));
  return { temp_f: n(h.temperature_2m?.[i]), code: h.weather_code?.[i] ?? null, wind_mph: n(h.wind_speed_10m?.[i]), precip_pct: n(h.precipitation_probability?.[i]) };
}
/** ESPN's forecast (temperature, words) first; Open-Meteo for the rest, or all of it when ESPN has none. */
export function mergeWeather(espn: InfoRow["espn_weather"], meteo: ReturnType<typeof meteoAt>): Weather | null {
  if (!espn && !meteo) return null;
  const code = meteo?.code ?? null, cond = espn?.condition ?? (code != null ? WMO[code]?.[0] ?? null : null);
  return {
    temp_f: espn?.temp_f ?? meteo?.temp_f ?? null, condition: cond,
    icon: espn?.condition ? iconFor(espn.condition) : code != null ? WMO[code]?.[1] ?? "🌡️" : "🌡️",
    wind_mph: meteo?.wind_mph ?? null, precip_pct: meteo?.precip_pct ?? null,
    heavy: isHeavy(espn?.condition ? null : code, cond),
    source: espn && meteo ? "ESPN, Open-Meteo" : espn ? "ESPN" : "Open-Meteo"
  };
}
