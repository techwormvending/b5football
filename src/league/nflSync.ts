/* NFL reference data for Supabase: players (public.nfl_players) and the
   schedule with kickoff times (public.nfl_games). Lineup locks depend on these:
   the database's guard_lineup trigger locks each player at his game's kickoff.

   Sources (both nflverse, no MFL):
   - players.csv (nflverse-data release): gsis_id, espn_id, display_name, position, latest_team.
   - games.csv (nflverse/nfldata): season, game_type, week, gameday, gametime (US Eastern), teams, scores.

   Run nightly by scripts/sync-nfl.mts with the service_role key (server job only). */

import { TEAMS, team } from "../ingest/teams.ts";

export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K"] as const;

export interface NflPlayerRow { id: string; espn_id: string | null; name: string; position: string; nfl_team: string | null }
export interface NflGameRow {
  season: number; week: number; game_key: string; home: string; away: string;
  kickoff: string | null; status: "scheduled" | "final";
}

const teamOrNull = (code: string | undefined): string | null => {
  if (!code) return null;
  try { return team(code); } catch { return null; }
};

/** Fantasy-position players active in `season - 1` or later (incl. rookies), plus the 32 team defenses ("DEF:<TEAM>"). */
export function playersFromRows(rows: Record<string, string>[], season: number): NflPlayerRow[] {
  const out: NflPlayerRow[] = [];
  const espnCount = new Map<string, number>();
  for (const r of rows) {
    // Fullbacks are RBs in fantasy (MFL and our scoring both treat them so).
    const position = r.position === "FB" ? "RB" : r.position ?? "";
    if (!r.gsis_id || !(FANTASY_POSITIONS as readonly string[]).includes(position)) continue;
    const recent = Math.max(Number(r.last_season) || 0, Number(r.rookie_season) || 0, Number(r.draft_year) || 0);
    if (recent < season - 1) continue;
    const espn = r.espn_id?.trim() || null;
    if (espn) espnCount.set(espn, (espnCount.get(espn) ?? 0) + 1);
    out.push({ id: r.gsis_id, espn_id: espn, name: r.display_name || r.gsis_id, position, nfl_team: teamOrNull(r.latest_team) });
  }
  // espn_id is unique in the table; an ID claimed by two players is ambiguous, so neither gets it (same rule as the crosswalk).
  for (const p of out) if (p.espn_id && espnCount.get(p.espn_id)! > 1) p.espn_id = null;
  for (const t of TEAMS) out.push({ id: `DEF:${t}`, espn_id: null, name: `${t} Defense`, position: "DEF", nfl_team: t });
  return out;
}

/** US Eastern wall-clock date + time ("2026-09-13", "13:00") -> UTC ISO string (DST-aware). */
export function easternToIso(date: string, time: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? ""), t = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!m || !t) return null;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +t[1]!, +t[2]!);
  // Eastern is UTC-4 (EDT) or UTC-5 (EST). Pick the offset whose result reads back as the same wall time.
  for (const off of [4, 5]) {
    const utc = wall + off * 3600_000;
    const back = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(new Date(utc));
    const v = (k: string) => back.find(p => p.type === k)!.value;
    if (`${v("year")}-${v("month")}-${v("day")}` === date && `${v("hour")}:${v("minute")}` === `${t[1]!.padStart(2, "0")}:${t[2]}`) {
      return new Date(utc).toISOString();
    }
  }
  return null;
}

/** Regular-season games for `season`. Game key "AWAY@HOME" in canonical team codes (matches scores.ts). */
export function gamesFromRows(rows: Record<string, string>[], season: number): NflGameRow[] {
  const out: NflGameRow[] = [];
  for (const r of rows) {
    if (Number(r.season) !== season || r.game_type !== "REG") continue;
    const away = team(r.away_team!), home = team(r.home_team!);
    const done = r.away_score !== "" && r.away_score !== "NA" && r.home_score !== "" && r.home_score !== "NA"
      && r.away_score != null && r.home_score != null;
    out.push({
      season, week: Number(r.week), game_key: `${away}@${home}`, home, away,
      kickoff: easternToIso(r.gameday!, r.gametime!), status: done ? "final" : "scheduled"
    });
  }
  return out;
}

/** Upsert rows into a table through the Data API as service_role, in batches. */
export async function upsert(
  cfg: { url: string; serviceKey: string }, table: string, rows: object[], onConflict: string,
  fetchImpl: typeof fetch = fetch, batch = 500
): Promise<number> {
  const base = cfg.url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const headers: Record<string, string> = {
    apikey: cfg.serviceKey, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal"
  };
  // Legacy service_role keys are JWTs and also go in Authorization; sb_secret_ keys go in apikey only.
  if (cfg.serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${cfg.serviceKey}`;
  for (let i = 0; i < rows.length; i += batch) {
    const res = await fetchImpl(`${base}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST", headers, body: JSON.stringify(rows.slice(i, i + batch))
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return rows.length;
}
